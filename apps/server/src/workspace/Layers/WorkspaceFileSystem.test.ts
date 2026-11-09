import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, describe, expect } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";

import { ServerConfig } from "../../config.ts";
import { GitCoreLive } from "../../git/Layers/GitCore.ts";
import { WorkspaceEntries } from "../Services/WorkspaceEntries.ts";
import { WorkspaceFileSystem, WorkspaceFileSystemError } from "../Services/WorkspaceFileSystem.ts";
import { WorkspacePathOutsideRootError } from "../Services/WorkspacePaths.ts";
import { WorkspaceEntriesLive } from "./WorkspaceEntries.ts";
import { makeWorkspaceFileSystem, WorkspaceFileSystemLive } from "./WorkspaceFileSystem.ts";
import { WorkspacePathsLive } from "./WorkspacePaths.ts";

// Probe instead of keying on the platform: some Windows hosts can create symlinks and some POSIX ones cannot.
const symlinksSupported = (() => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "piedpiper-symlink-probe-"));
  try {
    NodeFS.symlinkSync(dir, NodePath.join(dir, "link"), "dir");
    return true;
  } catch {
    return false;
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
})();

const ProjectLayer = WorkspaceFileSystemLive.pipe(
  Layer.provide(WorkspacePathsLive),
  Layer.provide(WorkspaceEntriesLive.pipe(Layer.provide(WorkspacePathsLive))),
);

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(ProjectLayer),
  Layer.provideMerge(WorkspaceEntriesLive.pipe(Layer.provide(WorkspacePathsLive))),
  Layer.provideMerge(WorkspacePathsLive),
  Layer.provideMerge(GitCoreLive),
  Layer.provide(
    ServerConfig.layerTest(process.cwd(), {
      prefix: "piedpiper-workspace-files-test-",
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({
    prefix: "piedpiper-workspace-files-",
  });
});

const writeTextFile = Effect.fn("writeTextFile")(function* (
  cwd: string,
  relativePath: string,
  contents = "",
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolutePath = path.join(cwd, relativePath);
  yield* fileSystem
    .makeDirectory(path.dirname(absolutePath), { recursive: true })
    .pipe(Effect.orDie);
  yield* fileSystem.writeFileString(absolutePath, contents).pipe(Effect.orDie);
});

it.layer(TestLayer)("WorkspaceFileSystemLive", (it) => {
  describe("writeFile", () => {
    it.effect("writes files relative to the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const result = yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "plans/effect-rpc.md",
          contents: "# Plan\n",
        });
        const saved = yield* fileSystem
          .readFileString(path.join(cwd, "plans/effect-rpc.md"))
          .pipe(Effect.orDie);

        expect(result).toEqual({ relativePath: "plans/effect-rpc.md" });
        expect(saved).toBe("# Plan\n");
      }),
    );

    it.effect("invalidates workspace entry search cache after writes", () =>
      Effect.gen(function* () {
        const workspaceEntries = yield* WorkspaceEntries;
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/existing.ts", "export {};\n");

        const beforeWrite = yield* workspaceEntries.search({
          cwd,
          query: "rpc",
          limit: 10,
        });
        expect(beforeWrite).toEqual({
          entries: [],
          truncated: false,
        });

        yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "plans/effect-rpc.md",
          contents: "# Plan\n",
        });

        const afterWrite = yield* workspaceEntries.search({
          cwd,
          query: "rpc",
          limit: 10,
        });
        expect(afterWrite.entries).toEqual(
          expect.arrayContaining([expect.objectContaining({ path: "plans/effect-rpc.md" })]),
        );
        expect(afterWrite.truncated).toBe(false);
      }),
    );

    it.effect("rejects writes outside the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;

        const error = yield* workspaceFileSystem
          .writeFile({
            cwd,
            relativePath: "../escape.md",
            contents: "# nope\n",
          })
          .pipe(Effect.flip);

        expect(error.message).toContain(
          "Workspace file path must be relative to the project root: ../escape.md",
        );

        const escapedPath = path.resolve(cwd, "..", "escape.md");
        const escapedStat = yield* fileSystem
          .stat(escapedPath)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        expect(escapedStat).toBeNull();
      }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "rejects writes through symlinks that resolve outside the workspace root",
      () =>
        Effect.gen(function* () {
          const workspaceFileSystem = yield* WorkspaceFileSystem;
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const cwd = yield* makeTempDir;
          const outsideDir = yield* makeTempDir;
          yield* writeTextFile(outsideDir, "existing.md", "outside\n");
          yield* fileSystem.symlink(outsideDir, path.join(cwd, "linked-dir")).pipe(Effect.orDie);
          yield* fileSystem
            .symlink(path.join(outsideDir, "existing.md"), path.join(cwd, "linked-file.md"))
            .pipe(Effect.orDie);
          yield* fileSystem
            .symlink(path.join(outsideDir, "missing.md"), path.join(cwd, "dangling.md"))
            .pipe(Effect.orDie);

          for (const relativePath of [
            "linked-dir/new.md",
            "linked-dir/nested/new.md",
            "linked-file.md",
          ]) {
            const error = yield* workspaceFileSystem
              .writeFile({ cwd, relativePath, contents: "# nope\n" })
              .pipe(Effect.flip);
            expect(error).toBeInstanceOf(WorkspacePathOutsideRootError);
          }
          const danglingError = yield* workspaceFileSystem
            .writeFile({ cwd, relativePath: "dangling.md", contents: "# nope\n" })
            .pipe(Effect.flip);
          expect(danglingError).toBeInstanceOf(WorkspacePathOutsideRootError);

          const outsideEntries = yield* fileSystem.readDirectory(outsideDir).pipe(Effect.orDie);
          expect(outsideEntries.toSorted()).toEqual(["existing.md"]);
          const outsideContents = yield* fileSystem
            .readFileString(path.join(outsideDir, "existing.md"))
            .pipe(Effect.orDie);
          expect(outsideContents).toBe("outside\n");
          const danglingStat = yield* fileSystem
            .stat(path.join(outsideDir, "missing.md"))
            .pipe(Effect.catch(() => Effect.succeed(null)));
          expect(danglingStat).toBeNull();
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "writes through symlinks that stay inside the workspace root",
      () =>
        Effect.gen(function* () {
          const workspaceFileSystem = yield* WorkspaceFileSystem;
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const parentDir = yield* makeTempDir;
          const cwd = path.join(parentDir, "workspace");
          const cwdAlias = path.join(parentDir, "workspace-alias");
          yield* writeTextFile(cwd, "docs/README.md", "old\n");
          yield* fileSystem
            .symlink(path.join(cwd, "docs"), path.join(cwd, "docs-alias"))
            .pipe(Effect.orDie);
          yield* fileSystem
            .symlink("docs/README.md", path.join(cwd, "README.md"))
            .pipe(Effect.orDie);
          yield* fileSystem.symlink(cwd, cwdAlias).pipe(Effect.orDie);

          const aliasResult = yield* workspaceFileSystem.writeFile({
            cwd,
            relativePath: "docs-alias/plans/plan.md",
            contents: "# Plan\n",
          });
          expect(aliasResult).toEqual({ relativePath: "docs-alias/plans/plan.md" });
          yield* workspaceFileSystem.writeFile({
            cwd,
            relativePath: "README.md",
            contents: "new\n",
          });
          yield* workspaceFileSystem.writeFile({
            cwd: cwdAlias,
            relativePath: "notes.md",
            contents: "notes\n",
          });

          const readText = (relativePath: string) =>
            fileSystem.readFileString(path.join(cwd, relativePath)).pipe(Effect.orDie);
          expect(yield* readText("docs/plans/plan.md")).toBe("# Plan\n");
          expect(yield* readText("docs/README.md")).toBe("new\n");
          expect(yield* fileSystem.readLink(path.join(cwd, "README.md")).pipe(Effect.orDie)).toBe(
            "docs/README.md",
          );
          expect(yield* readText("notes.md")).toBe("notes\n");

          // `..` after a symlinked cwd segment is resolved lexically, like the relative path.
          yield* fileSystem
            .symlink(path.join(cwd, "docs/plans"), path.join(cwd, "plans-alias"))
            .pipe(Effect.orDie);
          yield* workspaceFileSystem.writeFile({
            cwd: `${path.join(cwd, "plans-alias")}${path.sep}..`,
            relativePath: "dotdot.md",
            contents: "dotdot\n",
          });
          expect(yield* readText("dotdot.md")).toBe("dotdot\n");
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "creates the target of a dangling symlink that points inside the workspace root",
      () =>
        Effect.gen(function* () {
          const workspaceFileSystem = yield* WorkspaceFileSystem;
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const cwd = yield* makeTempDir;
          yield* fileSystem.symlink("plans/plan.md", path.join(cwd, "plan.md")).pipe(Effect.orDie);
          yield* fileSystem.symlink("plan.md", path.join(cwd, "plan-chain.md")).pipe(Effect.orDie);

          yield* workspaceFileSystem.writeFile({
            cwd,
            relativePath: "plan-chain.md",
            contents: "# Plan\n",
          });

          expect(
            yield* fileSystem.readFileString(path.join(cwd, "plans/plan.md")).pipe(Effect.orDie),
          ).toBe("# Plan\n");
          expect(yield* fileSystem.readLink(path.join(cwd, "plan.md")).pipe(Effect.orDie)).toBe(
            "plans/plan.md",
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)("reports symlink loops as unresolvable symlinks", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* fileSystem.symlink("loop-b.md", path.join(cwd, "loop-a.md")).pipe(Effect.orDie);
        yield* fileSystem.symlink("loop-a.md", path.join(cwd, "loop-b.md")).pipe(Effect.orDie);

        const error = yield* workspaceFileSystem
          .writeFile({ cwd, relativePath: "loop-a.md", contents: "# nope\n" })
          .pipe(Effect.flip);
        expect(error).toBeInstanceOf(WorkspaceFileSystemError);
        expect(error).toMatchObject({ operation: "workspaceFileSystem.realpathTarget" });
      }),
    );

    it.effect("does not report a file used as a directory as a symlink problem", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "notes.txt", "notes\n");

        const error = yield* workspaceFileSystem
          .writeFile({ cwd, relativePath: "notes.txt/new.md", contents: "# nope\n" })
          .pipe(Effect.flip);
        expect(error).toBeInstanceOf(WorkspaceFileSystemError);
        expect(error).toMatchObject({ operation: "workspaceFileSystem.statTarget" });
      }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "rejects the write when a parent directory is swapped for a symlink after the check",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const cwd = yield* makeTempDir;
          const outsideDir = yield* makeTempDir;
          const racingFileSystem: FileSystem.FileSystem = {
            ...fileSystem,
            makeDirectory: (directory, options) =>
              fileSystem.makeDirectory(directory, options).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    NodeFS.rmSync(directory, { recursive: true });
                    NodeFS.symlinkSync(outsideDir, directory, "dir");
                  }),
                ),
              ),
          };
          const workspaceFileSystem = yield* makeWorkspaceFileSystem.pipe(
            Effect.provideService(FileSystem.FileSystem, racingFileSystem),
          );

          const error = yield* workspaceFileSystem
            .writeFile({ cwd, relativePath: "plans/plan.md", contents: "# nope\n" })
            .pipe(Effect.flip);
          expect(error).toBeInstanceOf(WorkspacePathOutsideRootError);
          expect(yield* fileSystem.readDirectory(outsideDir).pipe(Effect.orDie)).toEqual([]);
        }),
    );
  });
});
