import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, PlatformError } from "effect";

import {
  pointsAtLinkedWorktree,
  resolveGitWorktreePath,
  resolveWorktreePiedpiperHome,
} from "./devHome";

const notFound = (path: string) =>
  PlatformError.systemError({
    _tag: "NotFound",
    module: "FileSystem",
    method: "stat",
    pathOrDescriptor: path,
  });

// In-memory `.git` entries: a string is a `.git` file, `"dir"` a `.git` directory.
const fsLayer = (entries: Record<string, string | { readonly dir: true }>) =>
  Layer.mergeAll(
    Path.layer,
    FileSystem.layerNoop({
      stat: (path) => {
        const entry = entries[path];
        if (entry === undefined) {
          return Effect.fail(notFound(path));
        }
        return Effect.succeed({
          type: typeof entry === "string" ? "File" : "Directory",
        } as FileSystem.File.Info);
      },
      readFileString: (path) => {
        const entry = entries[path];
        return typeof entry === "string" ? Effect.succeed(entry) : Effect.fail(notFound(path));
      },
    }),
  );

describe("pointsAtLinkedWorktree", () => {
  it("matches worktree pointers, including bare and custom common dirs", () => {
    assert.isTrue(pointsAtLinkedWorktree("gitdir: /repo/.git/worktrees/x\n"));
    assert.isTrue(pointsAtLinkedWorktree("gitdir: /srv/myrepo.git/worktrees/x\n"));
    assert.isTrue(pointsAtLinkedWorktree("gitdir: /srv/store/worktrees/x/\n"));
    assert.isTrue(pointsAtLinkedWorktree("gitdir: C:\\repo\\.git\\worktrees\\x\r\n"));
    assert.isTrue(pointsAtLinkedWorktree("gitdir: /repo/.git/modules/sub/worktrees/x\n"));
  });

  it("rejects submodules and malformed pointers", () => {
    assert.isFalse(pointsAtLinkedWorktree("gitdir: ../.git/modules/sub\n"));
    assert.isFalse(pointsAtLinkedWorktree("gitdir: ../.git/modules/worktrees/foo\n"));
    assert.isFalse(pointsAtLinkedWorktree("not a gitdir pointer\n"));
    assert.isFalse(pointsAtLinkedWorktree("gitdir:   \n"));
    assert.isFalse(pointsAtLinkedWorktree("gitdir: /my-worktrees-dir/x\n"));
  });
});

describe("resolveGitWorktreePath", () => {
  it.effect("finds a worktree root from a nested directory", () =>
    Effect.gen(function* () {
      assert.equal(yield* resolveGitWorktreePath("/wt/apps/web/src"), "/wt");
    }).pipe(Effect.provide(fsLayer({ "/wt/.git": "gitdir: /repo/.git/worktrees/wt\n" }))),
  );

  it.effect("reports a main checkout as not a linked worktree", () =>
    Effect.gen(function* () {
      assert.isUndefined(yield* resolveGitWorktreePath("/repo/apps/web"));
    }).pipe(Effect.provide(fsLayer({ "/repo/.git": { dir: true } }))),
  );

  it.effect("stops at the nearest repository even inside a worktree", () =>
    Effect.gen(function* () {
      assert.isUndefined(yield* resolveGitWorktreePath("/wt/vendor/lib/src"));
    }).pipe(
      Effect.provide(
        fsLayer({
          "/wt/.git": "gitdir: /repo/.git/worktrees/wt\n",
          "/wt/vendor/lib/.git": "gitdir: ../../.git/modules/lib\n",
        }),
      ),
    ),
  );

  it.effect("reports a directory outside any repository", () =>
    Effect.gen(function* () {
      assert.isUndefined(yield* resolveGitWorktreePath("/tmp/elsewhere"));
    }).pipe(Effect.provide(fsLayer({}))),
  );
});

describe("resolveWorktreePiedpiperHome", () => {
  it.effect("returns the worktree's .piedpiper directory", () =>
    Effect.gen(function* () {
      assert.equal(yield* resolveWorktreePiedpiperHome("/wt/apps"), "/wt/.piedpiper");
      assert.isUndefined(yield* resolveWorktreePiedpiperHome("/tmp"));
    }).pipe(Effect.provide(fsLayer({ "/wt/.git": "gitdir: /repo/.git/worktrees/wt\n" }))),
  );
});
