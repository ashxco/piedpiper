import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import type { GitDiffPreviewInput } from "@piedpiper/contracts";
import { Effect, FileSystem, Layer, Path } from "effect";
import { describe, expect } from "vitest";

import { ServerConfig } from "../config.ts";
import { runProcess } from "../processRunner.ts";
import { GitCoreLive } from "./Layers/GitCore.ts";
import { GitCore } from "./Services/GitCore.ts";
import { readGitCommitHistory } from "./gitCommitHistory.ts";
import {
  GIT_DIFF_PREVIEW_UNTRACKED_MAX_FILES,
  readGitDiffPreview,
  trimTruncatedPatchToWholeFile,
} from "./gitDiffPreview.ts";

const TestLayer = Layer.mergeAll(
  NodeServices.layer,
  GitCoreLive.pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "piedpiper-diff-preview-" })),
    Layer.provide(NodeServices.layer),
  ),
);

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.promise(() => runProcess("git", ["-C", cwd, ...args], { timeoutMs: 30_000 })).pipe(
    Effect.map((result) => result.stdout.trim()),
  );

const makeRepo = Effect.fn("makeRepo")(function* (options?: { commit?: boolean }) {
  const fileSystem = yield* FileSystem.FileSystem;
  const root = yield* fileSystem
    .makeTempDirectoryScoped({ prefix: "git-diff-preview-" })
    .pipe(Effect.flatMap((directory) => fileSystem.realPath(directory)));
  yield* git(root, ["init", "--initial-branch=main"]);
  yield* git(root, ["config", "user.email", "test@example.com"]);
  yield* git(root, ["config", "user.name", "Test"]);
  if (options?.commit !== false) {
    writeFileSync(path.join(root, "tracked.txt"), "one\ntwo\n");
    yield* git(root, ["add", "."]);
    yield* git(root, ["commit", "-m", "init"]);
  }
  return root;
});

// Explicit, since a global core.hooksPath would otherwise hide a hook in .git/hooks.
const installPostIndexChangeHook = Effect.fn("installPostIndexChangeHook")(function* (
  root: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const hooksDirectory = yield* fileSystem.makeTempDirectoryScoped({
    prefix: "git-diff-preview-hooks-",
  });
  const marker = path.join(hooksDirectory, "hook-ran");
  writeFileSync(path.join(hooksDirectory, "post-index-change"), `#!/bin/sh\ntouch "${marker}"\n`, {
    mode: 0o755,
  });
  yield* git(root, ["config", "core.hooksPath", hooksDirectory]);
  return marker;
});

const expectHookOnlyFiresForRealIndexWrites = Effect.fn("expectHookOnlyFiresForRealIndexWrites")(
  function* (root: string, marker: string) {
    expect(existsSync(marker)).toBe(false);
    writeFileSync(path.join(root, "real-add.txt"), "real\n");
    yield* git(root, ["add", "real-add.txt"]);
    expect(existsSync(marker)).toBe(true);
  },
);

// Moves the mtime well away from the commit, so git sees a stat-dirty entry with unchanged content.
const makeStatDirty = (filePath: string) => {
  const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  utimesSync(filePath, anHourAgo, anHourAgo);
};

const listSharedIndexes = (root: string) =>
  readdirSync(path.join(root, ".git")).filter((entry) => entry.startsWith("sharedindex."));

const preview = Effect.fn("preview")(function* (
  input: GitDiffPreviewInput,
  resolveBaseBranch: (cwd: string, branch: string) => string | null = (_cwd, branch) =>
    branch === "main" ? null : "main",
) {
  const core = yield* GitCore;
  const fileSystem = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  return yield* readGitDiffPreview(
    {
      execute: core.execute,
      resolveBaseBranch: (cwd, branch) => {
        const baseRef = resolveBaseBranch(cwd, branch);
        return Effect.succeed(baseRef === null ? null : { baseRef, comparisonRef: baseRef });
      },
      fileSystem,
      path: pathService,
    },
    input,
  );
});

it.layer(TestLayer)("readGitDiffPreview", (it) => {
  it.effect("is served by GitCore, resolving the branch base itself", () =>
    Effect.gen(function* () {
      const root = yield* makeRepo();
      yield* git(root, ["checkout", "-b", "feature"]);
      writeFileSync(path.join(root, "feature.txt"), "feature\n");
      yield* git(root, ["add", "."]);
      yield* git(root, ["commit", "-m", "feature"]);

      const result = yield* (yield* GitCore).diffPreview({ cwd: root, scope: "branch" });

      expect(result.baseRef).toBe("main");
      expect(result.diff).toContain("diff --git a/feature.txt b/feature.txt");
    }),
  );

  describe("uncommitted", () => {
    it.effect("includes staged, unstaged and untracked files without touching the index", () =>
      Effect.gen(function* () {
        const root = yield* makeRepo();
        writeFileSync(path.join(root, "tracked.txt"), "one\nchanged\n");
        writeFileSync(path.join(root, "staged.txt"), "staged\n");
        yield* git(root, ["add", "staged.txt"]);
        writeFileSync(path.join(root, "untracked.txt"), "new\n");
        const indexPath = path.join(root, ".git", "index");
        const indexBefore = readFileSync(indexPath);
        const statusBefore = yield* git(root, ["status", "--porcelain"]);
        const mtimeBefore = statSync(indexPath).mtimeMs;

        const result = yield* preview({ cwd: root, scope: "uncommitted" });

        expect(result.diff).toContain("diff --git a/tracked.txt b/tracked.txt");
        expect(result.diff).toContain("diff --git a/staged.txt b/staged.txt");
        expect(result.diff).toContain("diff --git a/untracked.txt b/untracked.txt");
        expect(result.diff).toContain("+new");
        expect(result).toMatchObject({ baseRef: null, truncated: false });
        expect(result.untrackedIncomplete).toBe(false);
        expect(statSync(indexPath).mtimeMs).toBe(mtimeBefore);
        expect(readFileSync(indexPath).equals(indexBefore)).toBe(true);
        expect(yield* git(root, ["status", "--porcelain"])).toBe(statusBefore);
      }),
    );

    it.effect("detects a rename onto an untracked path", () =>
      Effect.gen(function* () {
        const root = yield* makeRepo();
        renameSync(path.join(root, "tracked.txt"), path.join(root, "moved.txt"));

        const result = yield* preview({ cwd: root, scope: "uncommitted" });

        expect(result.diff).toContain("rename from tracked.txt");
        expect(result.diff).toContain("rename to moved.txt");
      }),
    );

    it.effect("returns root-relative paths from a subfolder project", () =>
      Effect.gen(function* () {
        const root = yield* makeRepo();
        const subfolder = path.join(root, "packages", "app");
        mkdirSync(subfolder, { recursive: true });
        writeFileSync(path.join(subfolder, "inner.txt"), "inner\n");
        writeFileSync(path.join(root, "outer.txt"), "outer\n");

        const result = yield* preview({ cwd: subfolder, scope: "uncommitted" });

        expect(result.diff).toContain("b/packages/app/inner.txt");
        expect(result.diff).toContain("b/outer.txt");
      }),
    );

    it.effect("works on an unborn HEAD, with and without an index", () =>
      Effect.gen(function* () {
        const root = yield* makeRepo({ commit: false });
        writeFileSync(path.join(root, "first.txt"), "first\n");

        const withoutIndex = yield* preview({ cwd: root, scope: "uncommitted" });
        expect(withoutIndex.diff).toContain("b/first.txt");

        yield* git(root, ["add", "first.txt"]);
        writeFileSync(path.join(root, "second.txt"), "second\n");
        const withIndex = yield* preview({ cwd: root, scope: "uncommitted" });
        expect(withIndex.diff).toContain("b/first.txt");
        expect(withIndex.diff).toContain("b/second.txt");
      }),
    );

    it.effect("skips nested repositories, including one with no commits", () =>
      Effect.gen(function* () {
        const root = yield* makeRepo();
        const nested = path.join(root, "nested");
        mkdirSync(nested);
        yield* git(nested, ["init"]);
        writeFileSync(path.join(nested, "inner.txt"), "inner\n");
        writeFileSync(path.join(root, "beside.txt"), "beside\n");

        const result = yield* preview({ cwd: root, scope: "uncommitted" });

        expect(result.diff).toContain("b/beside.txt");
        expect(result.diff).not.toContain("nested");
        expect(result.untrackedIncomplete).toBe(false);
      }),
    );

    it.effect("keeps a staged deletion whose file is still on disk", () =>
      Effect.gen(function* () {
        const root = yield* makeRepo();
        yield* git(root, ["rm", "--cached", "tracked.txt"]);

        const result = yield* preview({ cwd: root, scope: "uncommitted" });

        expect(result.diff).toContain("deleted file mode");
      }),
    );

    it.effect("respects a sparse checkout and a split index", () =>
      Effect.gen(function* () {
        const root = yield* makeRepo();
        mkdirSync(path.join(root, "cone"));
        mkdirSync(path.join(root, "outside"));
        writeFileSync(path.join(root, "cone", "kept.txt"), "kept\n");
        writeFileSync(path.join(root, "outside", "gone.txt"), "gone\n");
        yield* git(root, ["add", "."]);
        yield* git(root, ["commit", "-m", "dirs"]);
        yield* git(root, ["sparse-checkout", "set", "cone"]);
        yield* git(root, ["update-index", "--split-index"]);
        mkdirSync(path.join(root, "outside"), { recursive: true });
        writeFileSync(path.join(root, "outside", "untracked.txt"), "out of cone\n");
        writeFileSync(path.join(root, "cone", "kept.txt"), "changed\n");
        const statusBefore = yield* git(root, ["status", "--porcelain"]);

        const result = yield* preview({ cwd: root, scope: "uncommitted" });

        expect(result.diff).toContain("b/cone/kept.txt");
        expect(result.diff).toContain("b/outside/untracked.txt");
        expect(result.diff).not.toContain("gone.txt");
        expect(yield* git(root, ["status", "--porcelain"])).toBe(statusBefore);
      }),
    );

    it.effect("honours ignoreWhitespace", () =>
      Effect.gen(function* () {
        const root = yield* makeRepo();
        writeFileSync(path.join(root, "tracked.txt"), "one  \ntwo\n");

        const included = yield* preview({ cwd: root, scope: "uncommitted" });
        const ignored = yield* preview({
          cwd: root,
          scope: "uncommitted",
          ignoreWhitespace: true,
        });

        expect(included.diff).toContain("tracked.txt");
        expect(ignored.diff).toBe("");
      }),
    );

    it.effect("ignores hostile diff configuration", () =>
      Effect.gen(function* () {
        const root = yield* makeRepo();
        const marker = path.join(root, "external-ran");
        yield* git(root, ["config", "diff.external", `touch ${marker}`]);
        yield* git(root, ["config", "diff.noprefix", "true"]);
        yield* git(root, ["config", "color.diff", "always"]);
        writeFileSync(path.join(root, "tracked.txt"), "changed\n");

        const result = yield* preview({ cwd: root, scope: "uncommitted" });

        expect(result.diff).toContain("diff --git a/tracked.txt b/tracked.txt");
        expect(result.diff).not.toContain("\u001b[");
        expect(() => statSync(marker)).toThrow();
      }),
    );

    it.effect.skipIf(process.platform === "win32")(
      "does not run the post-index-change hook when adding untracked files",
      () =>
        Effect.gen(function* () {
          const root = yield* makeRepo();
          const marker = yield* installPostIndexChangeHook(root);
          writeFileSync(path.join(root, "untracked.txt"), "new\n");

          const result = yield* preview({ cwd: root, scope: "uncommitted" });

          expect(result.diff).toContain("b/untracked.txt");
          yield* expectHookOnlyFiresForRealIndexWrites(root, marker);
        }),
    );

    it.effect.skipIf(process.platform === "win32")(
      "does not run the post-index-change hook when expanding a split index",
      () =>
        Effect.gen(function* () {
          const root = yield* makeRepo();
          yield* git(root, ["update-index", "--split-index"]);
          const marker = yield* installPostIndexChangeHook(root);
          writeFileSync(path.join(root, "tracked.txt"), "changed\n");

          const result = yield* preview({ cwd: root, scope: "uncommitted" });

          expect(result.diff).toContain("b/tracked.txt");
          yield* expectHookOnlyFiresForRealIndexWrites(root, marker);
        }),
    );

    it.effect.skipIf(process.platform === "win32")(
      "does not run the post-index-change hook when starting from no index",
      () =>
        Effect.gen(function* () {
          const root = yield* makeRepo({ commit: false });
          const marker = yield* installPostIndexChangeHook(root);

          const result = yield* preview({ cwd: root, scope: "uncommitted" });

          expect(result.diff).toBe("");
          yield* expectHookOnlyFiresForRealIndexWrites(root, marker);
        }),
    );

    it.effect.skipIf(process.platform === "win32")(
      "does not run the post-index-change hook when the patch refreshes a stat-dirty file",
      () =>
        Effect.gen(function* () {
          const root = yield* makeRepo();
          const marker = yield* installPostIndexChangeHook(root);
          makeStatDirty(path.join(root, "tracked.txt"));

          const result = yield* preview({ cwd: root, scope: "uncommitted" });

          expect(result.diff).toBe("");
          yield* expectHookOnlyFiresForRealIndexWrites(root, marker);
        }),
    );

    it.effect("writes no shared index when the patch refreshes a stat-dirty file", () =>
      Effect.gen(function* () {
        const root = yield* makeRepo();
        yield* git(root, ["config", "core.splitIndex", "true"]);
        yield* git(root, ["update-index", "--split-index"]);
        const sharedIndexes = listSharedIndexes(root);
        expect(sharedIndexes).toHaveLength(1);
        const realIndex = readFileSync(path.join(root, ".git", "index"));
        makeStatDirty(path.join(root, "tracked.txt"));

        const result = yield* preview({ cwd: root, scope: "uncommitted" });

        expect(result.diff).toBe("");
        expect(listSharedIndexes(root)).toEqual(sharedIndexes);
        expect(readFileSync(path.join(root, ".git", "index")).equals(realIndex)).toBe(true);
      }),
    );

    it.effect("cuts a patch over the cap at a file boundary", () =>
      Effect.gen(function* () {
        const root = yield* makeRepo();
        const lineCount = 60_000;
        const contents = `${"x".repeat(79)}\n`.repeat(lineCount);
        for (const name of ["a.txt", "b.txt", "c.txt"]) {
          writeFileSync(path.join(root, name), contents);
        }

        const result = yield* (yield* GitCore).diffPreview({ cwd: root, scope: "uncommitted" });

        expect(result.truncated).toBe(true);
        expect(result.diff.match(/^diff --git /gm)).toEqual(["diff --git ", "diff --git "]);
        expect(result.diff).toContain("b/a.txt");
        expect(result.diff).toContain("b/b.txt");
        expect(result.diff).not.toContain("c.txt");
        // Every line of both kept files is there, so no hunk contradicts its counts.
        expect(result.diff.match(/^\+x/gm)).toHaveLength(lineCount * 2);
        expect(result.diff.endsWith(`${"x".repeat(79)}\n`)).toBe(true);
      }),
    );

    it.effect("returns an empty diff when the only file is over the cap", () =>
      Effect.gen(function* () {
        const root = yield* makeRepo();
        writeFileSync(path.join(root, "huge.txt"), `${"x".repeat(79)}\n`.repeat(200_000));

        const result = yield* (yield* GitCore).diffPreview({ cwd: root, scope: "uncommitted" });

        expect(result.truncated).toBe(true);
        expect(result.diff).toBe("");
      }),
    );

    it.effect("reports incomplete untracked files past the cap and keeps tracked ones", () =>
      Effect.gen(function* () {
        const root = yield* makeRepo();
        writeFileSync(path.join(root, "tracked.txt"), "changed\n");
        const many = path.join(root, "many");
        mkdirSync(many);
        for (let index = 0; index <= GIT_DIFF_PREVIEW_UNTRACKED_MAX_FILES; index += 1) {
          writeFileSync(path.join(many, `${index}.txt`), "");
        }

        const result = yield* preview({ cwd: root, scope: "uncommitted" });

        expect(result.untrackedIncomplete).toBe(true);
        expect(result.diff).toContain("b/tracked.txt");
        expect(result.diff).not.toContain("many/");
        rmSync(many, { recursive: true, force: true });
      }),
    );
  });

  describe("branch", () => {
    it.effect("compares the working tree with the merge base, ignoring base-only commits", () =>
      Effect.gen(function* () {
        const root = yield* makeRepo();
        yield* git(root, ["checkout", "-b", "feature"]);
        writeFileSync(path.join(root, "feature.txt"), "feature\n");
        yield* git(root, ["add", "."]);
        yield* git(root, ["commit", "-m", "feature"]);
        writeFileSync(path.join(root, "dirty.txt"), "dirty\n");
        yield* git(root, ["checkout", "--quiet", "main"]);
        writeFileSync(path.join(root, "main-only.txt"), "main\n");
        yield* git(root, ["add", "main-only.txt"]);
        yield* git(root, ["commit", "-m", "main moves on"]);
        yield* git(root, ["checkout", "--quiet", "feature"]);

        const result = yield* preview({ cwd: root, scope: "branch" });

        expect(result.baseRef).toBe("main");
        expect(result.diff).toContain("b/feature.txt");
        expect(result.diff).toContain("b/dirty.txt");
        expect(result.diff).not.toContain("main-only.txt");
      }),
    );

    it.effect("compares the default branch with its own remote copy", () =>
      Effect.gen(function* () {
        const root = yield* makeRepo();
        const fileSystem = yield* FileSystem.FileSystem;
        const remote = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "git-diff-preview-remote-",
        });
        yield* git(remote, ["init", "--bare", "--initial-branch=main"]);
        yield* git(root, ["remote", "add", "origin", remote]);
        yield* git(root, ["push", "-u", "origin", "main"]);
        writeFileSync(path.join(root, "ahead.txt"), "ahead\n");
        yield* git(root, ["add", "ahead.txt"]);
        yield* git(root, ["commit", "-m", "ahead"]);
        writeFileSync(path.join(root, "dirty.txt"), "dirty\n");

        const result = yield* (yield* GitCore).diffPreview({ cwd: root, scope: "branch" });

        expect(result.baseRef).toBe("origin/main");
        expect(result.diff).toContain("b/ahead.txt");
        expect(result.diff).toContain("b/dirty.txt");
        expect(result.diff).not.toContain("tracked.txt");
      }),
    );

    it.effect("shows uncommitted changes with no base, and on an unborn HEAD", () =>
      Effect.gen(function* () {
        const root = yield* makeRepo();
        writeFileSync(path.join(root, "dirty.txt"), "dirty\n");
        const onDefaultBranch = yield* preview({ cwd: root, scope: "branch" });
        expect(onDefaultBranch.baseRef).toBeNull();
        expect(onDefaultBranch.diff).toContain("b/dirty.txt");

        const unborn = yield* makeRepo({ commit: false });
        writeFileSync(path.join(unborn, "first.txt"), "first\n");
        const onUnbornHead = yield* preview({ cwd: unborn, scope: "branch" });
        expect(onUnbornHead.baseRef).toBeNull();
        expect(onUnbornHead.diff).toContain("b/first.txt");
      }),
    );

    it.effect("shows uncommitted changes when the branch shares no history with its base", () =>
      Effect.gen(function* () {
        const root = yield* makeRepo();
        yield* git(root, ["checkout", "--quiet", "--orphan", "island"]);
        yield* git(root, ["add", "."]);
        yield* git(root, ["commit", "-m", "unrelated"]);
        writeFileSync(path.join(root, "dirty.txt"), "dirty\n");

        const result = yield* preview({ cwd: root, scope: "branch" });

        expect(result.baseRef).toBeNull();
        expect(result.diff).toContain("b/dirty.txt");
        expect(result.diff).not.toContain("tracked.txt");
      }),
    );

    it.effect("uses the default branch as the base for a detached HEAD", () =>
      Effect.gen(function* () {
        const root = yield* makeRepo();
        yield* git(root, ["checkout", "-b", "feature"]);
        writeFileSync(path.join(root, "feature.txt"), "feature\n");
        yield* git(root, ["add", "."]);
        yield* git(root, ["commit", "-m", "feature"]);
        yield* git(root, ["checkout", "--quiet", "--detach"]);
        const branches: string[] = [];

        const result = yield* preview({ cwd: root, scope: "branch" }, (_cwd, branch) => {
          branches.push(branch);
          return "main";
        });

        expect(branches).toEqual(["HEAD"]);
        expect(result.diff).toContain("b/feature.txt");
      }),
    );
  });
});

describe("trimTruncatedPatchToWholeFile", () => {
  it("drops the partial last file", () => {
    expect(
      trimTruncatedPatchToWholeFile("diff --git a/a b/a\n+one\ndiff --git a/b b/b\n@@ -1,2"),
    ).toBe("diff --git a/a b/a\n+one\n");
  });

  it("leaves nothing for a lone partial file, whose hunk counts would contradict its lines", () => {
    expect(trimTruncatedPatchToWholeFile("diff --git a/a b/a\n+one")).toBe("");
  });
});

it.effect("reviews immutable commits, including the root, without including working changes", () =>
  Effect.gen(function* () {
    const root = yield* makeRepo();
    const core = yield* GitCore;
    const initial = yield* git(root, ["rev-parse", "HEAD"]);
    writeFileSync(path.join(root, "tracked.txt"), "committed\n");
    yield* git(root, ["commit", "-am", "Second commit"]);
    const latest = yield* git(root, ["rev-parse", "HEAD"]);
    writeFileSync(path.join(root, "tracked.txt"), "uncommitted-secret\n");
    yield* git(root, ["config", "log.showSignature", "true"]);
    yield* git(root, ["config", "log.decorate", "full"]);
    const history = yield* readGitCommitHistory(core, { cwd: root, limit: 1 });
    expect(history.commits.map((commit) => [commit.sha, commit.subject])).toEqual([
      [latest, "Second commit"],
    ]);
    expect(history.nextCursor).toBe(1);
    const older = yield* readGitCommitHistory(core, { cwd: root, cursor: 1, limit: 1 });
    expect(older.commits[0]?.sha).toBe(initial);
    expect(older.nextCursor).toBeNull();
    const patch = yield* core.diffPreview({ cwd: root, scope: "commit", commit: latest });
    expect(patch.diff).toContain("+committed");
    expect(patch.diff).not.toContain("uncommitted-secret");
    const firstPatch = yield* core.diffPreview({ cwd: root, scope: "commit", commit: initial });
    expect(firstPatch.diff).toContain("+one");
    expect(firstPatch.diff).toContain("--- /dev/null");
  }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);
