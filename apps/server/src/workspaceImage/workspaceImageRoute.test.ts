import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option, Path } from "effect";
import { HttpClient, HttpRouter } from "effect/unstable/http";

import { ServerConfig, type ServerConfigShape } from "../config";
import { isUntracedRequest } from "../http";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery";
import { resolveWorkspaceImageFile, WORKSPACE_IMAGE_ROUTE_PATH } from "./workspaceImageFile";
import { workspaceImageRouteLayer } from "./workspaceImageRoute";

const THREAD_ID = "thread-1";

const fixture = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const base = yield* fileSystem.realPath(
    yield* fileSystem
      .makeTempDirectoryScoped({ prefix: "piedpiper-workspace-image-" })
      .pipe(Effect.provide(NodeHttpServer.layerTest)),
  );
  const workspace = path.join(base, "workspace");
  const worktree = path.join(base, "worktree");
  const outside = path.join(base, "outside");
  for (const directory of [workspace, worktree, outside]) {
    yield* fileSystem.makeDirectory(directory, { recursive: true });
  }
  yield* fileSystem.writeFileString(path.join(workspace, "a.png"), "workspace-png");
  yield* fileSystem.writeFileString(path.join(worktree, "b.png"), "worktree-png");
  yield* fileSystem.writeFileString(path.join(workspace, "icon.svg"), "<svg/>");
  yield* fileSystem.writeFileString(path.join(workspace, ".env"), "SECRET=1");
  yield* fileSystem.writeFileString(path.join(outside, "c.png"), "outside-png");
  yield* fileSystem.writeFileString(path.join(outside, "secret.env"), "SECRET=2");
  yield* fileSystem.symlink(path.join(outside, "c.png"), path.join(workspace, "escape.png"));
  yield* fileSystem.symlink(path.join(workspace, ".env"), path.join(workspace, "env.png"));
  yield* fileSystem.symlink(outside, path.join(workspace, "linked"));
  yield* fileSystem.makeDirectory(path.join(workspace, "folder.png"));
  return { path, base, workspace, worktree, outside };
});

const serve = (input: {
  readonly workspace: string;
  readonly worktree: string | null;
  readonly authToken?: string;
}) =>
  Layer.build(
    HttpRouter.serve(workspaceImageRouteLayer, {
      disableListenLog: true,
      disableLogger: true,
    }).pipe(
      Layer.provide(
        Layer.succeed(ServerConfig, {
          host: "127.0.0.1",
          authToken: input.authToken,
        } as ServerConfigShape),
      ),
      Layer.provide(
        Layer.mock(ProjectionSnapshotQuery)({
          getThreadWorkspaceContext: (threadId) =>
            Effect.succeed(
              threadId === THREAD_ID
                ? Option.some({
                    workspaceRoot: input.workspace,
                    worktreePath: input.worktree,
                  })
                : Option.none(),
            ),
        }),
      ),
    ),
  );

const get = (path: string, threadId = THREAD_ID, token?: string) =>
  HttpClient.get(
    `${WORKSPACE_IMAGE_ROUTE_PATH}?${new URLSearchParams({
      threadId,
      path,
      ...(token ? { token } : {}),
    })}`,
  );

it.layer(NodeServices.layer)("workspace image route", (it) => {
  it.effect("serves an image from the project or the worktree, uncached", () =>
    Effect.gen(function* () {
      const { path, workspace, worktree } = yield* fixture;
      yield* serve({ workspace, worktree });

      const project = yield* get(path.join(workspace, "a.png"));
      assert.equal(project.status, 200);
      assert.equal(yield* project.text, "workspace-png");
      assert.equal(project.headers["cache-control"], "no-store");
      assert.equal(project.headers["x-content-type-options"], "nosniff");

      const tree = yield* get(path.join(worktree, "b.png"));
      assert.equal(tree.status, 200);
      assert.equal(yield* tree.text, "worktree-png");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("sandboxes SVG", () =>
    Effect.gen(function* () {
      const { path, workspace } = yield* fixture;
      yield* serve({ workspace, worktree: null });
      const response = yield* get(path.join(workspace, "icon.svg"));
      assert.equal(response.status, 200);
      assert.include(response.headers["content-security-policy"] ?? "", "sandbox");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("requires the auth token", () =>
    Effect.gen(function* () {
      const { path, workspace } = yield* fixture;
      yield* serve({ workspace, worktree: null, authToken: "secret" });
      const file = path.join(workspace, "a.png");
      assert.equal((yield* get(file)).status, 401);
      assert.equal((yield* get(file, THREAD_ID, "wrong")).status, 401);
      assert.equal((yield* get(file, THREAD_ID, "secret")).status, 200);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("refuses what the workspace does not hold", () =>
    Effect.gen(function* () {
      const { path, workspace, worktree, outside } = yield* fixture;
      yield* serve({ workspace, worktree });
      const refused = [
        ["unknown thread", path.join(workspace, "a.png"), "thread-2"],
        ["outside", path.join(outside, "c.png")],
        ["traversal", `${workspace}/../outside/c.png`],
        ["symlink escape", path.join(workspace, "escape.png")],
        ["symlinked folder", path.join(workspace, "linked", "c.png")],
        ["symlink to a secret", path.join(workspace, "env.png")],
        ["not an image", path.join(workspace, ".env")],
        ["folder", path.join(workspace, "folder.png")],
        ["missing", path.join(workspace, "missing.png")],
        ["relative", "a.png"],
        // Resolves to a real workspace file here, but on Windows it would reach out to a share.
        ["network path", `/${path.join(workspace, "a.png")}`],
      ] as const;
      for (const [name, file, threadId] of refused) {
        const response = yield* get(file, threadId);
        assert.equal(response.status, 404, name);
      }
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects a request missing its parameters", () =>
    Effect.gen(function* () {
      const { workspace } = yield* fixture;
      yield* serve({ workspace, worktree: null });
      assert.equal((yield* HttpClient.get(WORKSPACE_IMAGE_ROUTE_PATH)).status, 400);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("does not treat the root itself or a sibling with its prefix as inside", () =>
    Effect.gen(function* () {
      const { path, base, workspace } = yield* fixture;
      const fileSystem = yield* FileSystem.FileSystem;
      const sibling = `${workspace}-other`;
      yield* fileSystem.makeDirectory(sibling);
      yield* fileSystem.writeFileString(path.join(sibling, "a.png"), "x");
      const roots = [workspace];
      assert.isNull(yield* resolveWorkspaceImageFile({ path: path.join(sibling, "a.png"), roots }));
      const dottedRoot = path.join(base, "root.png");
      yield* fileSystem.makeDirectory(dottedRoot);
      assert.isNull(yield* resolveWorkspaceImageFile({ path: dottedRoot, roots: [dottedRoot] }));
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it("keeps token-bearing requests out of traces through the token query", () => {
    assert.isTrue(isUntracedRequest({ url: `${WORKSPACE_IMAGE_ROUTE_PATH}?token=abc` }));
  });
});
