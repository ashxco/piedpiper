import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
} from "node:fs";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  PlatformError,
  Scope,
  Sink,
  Stream,
} from "effect";
import { TestClock } from "effect/testing";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect, vi } from "vitest";

import {
  alignBranchParentCasing,
  isBranchNameTakenIgnoringCase,
  GitCoreLive,
  makeGitCore,
  statusUpstreamRefreshFailureCooldown,
} from "./GitCore.ts";
import { GitCore, type GitCoreShape } from "../Services/GitCore.ts";
import { GitCommandError, type ServerSettings } from "@piedpiper/contracts";
import type { DeepPartial } from "@piedpiper/shared/Struct";
import { type ProcessRunResult, runProcess } from "../../processRunner.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";

// ── Helpers ──

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "piedpiper-git-core-test-",
});
const GitCoreTestLayer = GitCoreLive.pipe(
  Layer.provide(ServerConfigLayer),
  Layer.provide(NodeServices.layer),
);
const TestLayer = Layer.mergeAll(NodeServices.layer, GitCoreTestLayer);

function makeTmpDir(
  prefix = "git-test-",
): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem | Scope.Scope> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.makeTempDirectoryScoped({ prefix });
  });
}

function writeTextFile(
  filePath: string,
  contents: string,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.writeFileString(filePath, contents);
  });
}

/** Run a raw git command for test setup (not under test). */
function git(
  cwd: string,
  args: ReadonlyArray<string>,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<string, GitCommandError, GitCore> {
  return Effect.gen(function* () {
    const gitCore = yield* GitCore;
    const result = yield* gitCore.execute({
      operation: "GitCore.test.git",
      cwd,
      args,
      ...(env ? { env } : {}),
      timeoutMs: 10_000,
    });
    return result.stdout.trim();
  });
}

function configureRemote(
  cwd: string,
  remoteName: string,
  remotePath: string,
  fetchNamespace: string,
): Effect.Effect<string, GitCommandError, GitCore> {
  return Effect.gen(function* () {
    yield* git(cwd, ["config", `remote.${remoteName}.url`, remotePath]);
    return yield* git(cwd, [
      "config",
      "--replace-all",
      `remote.${remoteName}.fetch`,
      `+refs/heads/*:refs/remotes/${fetchNamespace}/*`,
    ]);
  });
}

function runShellCommand(input: {
  command: string;
  cwd: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}): Effect.Effect<ProcessRunResult, Error> {
  return Effect.promise(() => {
    const shellPath =
      process.platform === "win32"
        ? (process.env.ComSpec ?? "cmd.exe")
        : (process.env.SHELL ?? "/bin/sh");

    const args =
      process.platform === "win32" ? ["/d", "/s", "/c", input.command] : ["-lc", input.command];

    return runProcess(shellPath, args, {
      cwd: input.cwd,
      timeoutMs: input.timeoutMs ?? 30_000,
      allowNonZeroExit: true,
      maxBufferBytes: input.maxOutputBytes ?? 1_000_000,
      outputMode: "truncate",
    });
  });
}

const makeIsolatedGitCore = (executeOverride: GitCoreShape["execute"]) =>
  makeGitCore({ executeOverride }).pipe(
    Effect.provide(Layer.provideMerge(ServerConfigLayer, NodeServices.layer)),
  );

/** Create a repo with an initial commit so branches work. */
function initRepoWithCommit(
  cwd: string,
): Effect.Effect<
  { initialBranch: string },
  GitCommandError | PlatformError.PlatformError,
  GitCore | FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    const core = yield* GitCore;
    yield* core.initRepo({ cwd });
    yield* git(cwd, ["config", "user.email", "test@test.com"]);
    yield* git(cwd, ["config", "user.name", "Test"]);
    yield* writeTextFile(path.join(cwd, "README.md"), "# test\n");
    yield* git(cwd, ["add", "."]);
    yield* git(cwd, ["commit", "-m", "initial commit"]);
    const initialBranch = yield* git(cwd, ["branch", "--show-current"]);
    return { initialBranch };
  });
}

function commitWithDate(
  cwd: string,
  fileName: string,
  fileContents: string,
  dateIsoString: string,
  message: string,
): Effect.Effect<
  void,
  GitCommandError | PlatformError.PlatformError,
  GitCore | FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    yield* writeTextFile(path.join(cwd, fileName), fileContents);
    yield* git(cwd, ["add", fileName]);
    yield* git(cwd, ["commit", "-m", message], {
      ...process.env,
      GIT_AUTHOR_DATE: dateIsoString,
      GIT_COMMITTER_DATE: dateIsoString,
    });
  });
}

function buildLargeText(lineCount = 20_000): string {
  return Array.from({ length: lineCount }, (_, index) => `line ${String(index).padStart(5, "0")}`)
    .join("\n")
    .concat("\n");
}

function splitNullSeparatedPaths(input: string): string[] {
  return input
    .split("\0")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

// ── Tests ──

it.layer(TestLayer)("git integration", (it) => {
  describe("shell process execution", () => {
    it.effect("caps captured output when maxOutputBytes is exceeded", () =>
      Effect.gen(function* () {
        const result = yield* runShellCommand({
          command: `node -e "process.stdout.write('x'.repeat(2000))"`,
          cwd: process.cwd(),
          timeoutMs: 10_000,
          maxOutputBytes: 128,
        });

        expect(result.code).toBe(0);
        expect(result.stdout.length).toBeLessThanOrEqual(128);
        expect(result.stdoutTruncated || result.stderrTruncated).toBe(true);
      }),
    );
  });

  // ── initGitRepo ──

  describe("initGitRepo", () => {
    it.effect("creates a valid git repo", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* (yield* GitCore).initRepo({ cwd: tmp });
        expect(existsSync(path.join(tmp, ".git"))).toBe(true);
      }),
    );

    it.effect("listGitBranches reports isRepo: true after init + commit", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const result = yield* (yield* GitCore).listBranches({ cwd: tmp });
        expect(result.isRepo).toBe(true);
        expect(result.hasOriginRemote).toBe(false);
        expect(result.branches.length).toBeGreaterThanOrEqual(1);
      }),
    );
  });

  describe("workspace helpers", () => {
    it.effect("filterIgnoredPaths chunks large path lists and preserves kept paths", () =>
      Effect.gen(function* () {
        const cwd = "/virtual/repo";
        const relativePaths = Array.from({ length: 340 }, (_, index) => {
          const prefix = index % 3 === 0 ? "ignored" : "kept";
          return `${prefix}/segment-${String(index).padStart(4, "0")}/${"x".repeat(900)}.ts`;
        });
        const expectedPaths = relativePaths.filter(
          (relativePath) => !relativePath.startsWith("ignored/"),
        );

        const seenChunks: string[][] = [];
        const core = yield* makeIsolatedGitCore((input) => {
          if (
            input.args.join(" ") !==
            "-c core.fsmonitor=false -c core.untrackedCache=false check-ignore --no-index -z --stdin"
          ) {
            return Effect.fail(
              new GitCommandError({
                operation: input.operation,
                command: `git ${input.args.join(" ")}`,
                cwd: input.cwd,
                detail: "unexpected git command in chunking test",
              }),
            );
          }

          const chunkPaths = splitNullSeparatedPaths(input.stdin ?? "");
          seenChunks.push(chunkPaths);
          const ignoredPaths = chunkPaths.filter((relativePath) =>
            relativePath.startsWith("ignored/"),
          );

          return Effect.succeed({
            code: ignoredPaths.length > 0 ? 0 : 1,
            stdout: ignoredPaths.length > 0 ? `${ignoredPaths.join("\0")}\0` : "",
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          });
        });

        const result = yield* core.filterIgnoredPaths(cwd, relativePaths);

        expect(seenChunks.length).toBeGreaterThan(1);
        expect(seenChunks.flat()).toEqual(relativePaths);
        expect(result).toEqual(expectedPaths);
      }),
    );

    it.effect("listWorkspaceFiles disables fsmonitor and untracked cache helpers", () =>
      Effect.gen(function* () {
        const core = yield* makeIsolatedGitCore((input) => {
          expect(input.args).toEqual([
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.untrackedCache=false",
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
          ]);
          return Effect.succeed({
            code: 0,
            stdout: "src/index.ts\0README.md\0",
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          });
        });

        const result = yield* core.listWorkspaceFiles("/virtual/repo");
        expect(result.paths).toEqual(["src/index.ts", "README.md"]);
        expect(result.truncated).toBe(false);
      }),
    );

    it.effect.skipIf(process.platform === "win32")(
      "listWorkspaceFiles never runs a repo-configured fsmonitor hook",
      () =>
        Effect.gen(function* () {
          const tmp = yield* makeTmpDir();
          yield* initRepoWithCommit(tmp);
          const fileSystem = yield* FileSystem.FileSystem;
          const helperDir = yield* makeTmpDir("git-fsmonitor-");
          const markerPath = path.join(helperDir, "fsmonitor-ran");
          const hookPath = path.join(helperDir, "fsmonitor.sh");
          yield* writeTextFile(hookPath, `#!/bin/sh\n: > "${markerPath}"\nprintf "/"\n`);
          yield* fileSystem.chmod(hookPath, 0o755);
          yield* git(tmp, ["config", "core.fsmonitor", hookPath]);

          // Sanity check: a plain status honours the hook, so the marker proves the hook runs.
          yield* git(tmp, ["status", "--porcelain"]);
          expect(yield* fileSystem.exists(markerPath)).toBe(true);
          yield* fileSystem.remove(markerPath);

          const result = yield* (yield* GitCore).listWorkspaceFiles(tmp);

          expect(result.paths).toContain("README.md");
          expect(yield* fileSystem.exists(markerPath)).toBe(false);
        }),
    );
  });

  // ── listGitBranches ──

  describe("listGitBranches", () => {
    it.effect("does not report a separate git dir as the current branch's worktree", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const gitDir = path.join(yield* makeTmpDir(), "repo.git");
        yield* git(cwd, ["init", `--separate-git-dir=${gitDir}`]);
        yield* git(cwd, ["config", "user.email", "test@test.com"]);
        yield* git(cwd, ["config", "user.name", "Test"]);
        yield* git(cwd, ["commit", "--allow-empty", "-m", "init"]);

        const result = yield* (yield* GitCore).listBranches({ cwd });
        const worktreePath = result.branches.find((branch) => branch.current)?.worktreePath;

        expect(worktreePath && realpathSync.native(worktreePath)).toBe(realpathSync.native(cwd));
      }),
    );

    it.effect("returns isRepo: false for non-git directory", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const result = yield* (yield* GitCore).listBranches({ cwd: tmp });
        expect(result.isRepo).toBe(false);
        expect(result.hasOriginRemote).toBe(false);
        expect(result.branches).toEqual([]);
      }),
    );

    it.effect("returns isRepo: false for deleted directories", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const fileSystem = yield* FileSystem.FileSystem;
        const deletedDir = path.join(tmp, "deleted-repo");
        yield* fileSystem.makeDirectory(deletedDir, { recursive: true });
        yield* fileSystem.remove(deletedDir, { recursive: true });

        const result = yield* (yield* GitCore).listBranches({ cwd: deletedDir });

        expect(result.isRepo).toBe(false);
        expect(result.hasOriginRemote).toBe(false);
        expect(result.branches).toEqual([]);
      }),
    );

    it.effect("fails loudly when git cannot spawn in an existing directory", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const core = yield* makeIsolatedGitCore((input) =>
          Effect.fail(
            new GitCommandError({
              operation: input.operation,
              command: `git ${input.args.join(" ")}`,
              cwd: input.cwd,
              detail: "spawn git ENOENT - failed to spawn.",
            }),
          ),
        );

        const branchesError = yield* Effect.flip(core.listBranches({ cwd: tmp }));
        expect(branchesError.operation).toBe("GitCore.listBranches.branchNoColor");
        const statusError = yield* Effect.flip(core.statusDetails(tmp));
        expect(statusError.operation).toBe("GitCore.statusDetails.status");
      }),
    );

    it.effect("returns the current branch with current: true", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const result = yield* (yield* GitCore).listBranches({ cwd: tmp });
        const current = result.branches.find((b) => b.current);
        expect(current).toBeDefined();
        expect(current!.current).toBe(true);
      }),
    );

    it.effect("does not include detached HEAD pseudo-refs as branches", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* git(tmp, ["checkout", "--detach", "HEAD"]);

        const result = yield* (yield* GitCore).listBranches({ cwd: tmp });
        expect(result.branches.some((branch) => branch.name.startsWith("("))).toBe(false);
        expect(result.branches.some((branch) => branch.current)).toBe(false);
      }),
    );

    it.effect("keeps current branch first and sorts the remaining branches by recency", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const initialBranch = (yield* (yield* GitCore).listBranches({ cwd: tmp })).branches.find(
          (branch) => branch.current,
        )!.name;

        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "older-branch" });
        yield* (yield* GitCore).checkoutBranch({ cwd: tmp, branch: "older-branch" });
        yield* commitWithDate(
          tmp,
          "older.txt",
          "older branch change\n",
          "Thu, 1 Jan 2037 00:00:00 +0000",
          "older branch change",
        );

        yield* (yield* GitCore).checkoutBranch({ cwd: tmp, branch: initialBranch });
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "newer-branch" });
        yield* (yield* GitCore).checkoutBranch({ cwd: tmp, branch: "newer-branch" });
        yield* commitWithDate(
          tmp,
          "newer.txt",
          "newer branch change\n",
          "Fri, 1 Jan 2038 00:00:00 +0000",
          "newer branch change",
        );

        // Switch away to show current branch is pinned, then remaining branches are recency-sorted.
        yield* (yield* GitCore).checkoutBranch({ cwd: tmp, branch: "older-branch" });

        const result = yield* (yield* GitCore).listBranches({ cwd: tmp });
        expect(result.branches[0]!.name).toBe("older-branch");
        expect(result.branches[1]!.name).toBe("newer-branch");
      }),
    );

    it.effect("keeps default branch right after current branch", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const remote = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const defaultBranch = (yield* (yield* GitCore).listBranches({ cwd: tmp })).branches.find(
          (branch) => branch.current,
        )!.name;

        yield* git(remote, ["init", "--bare"]);
        yield* git(tmp, ["remote", "add", "origin", remote]);
        yield* git(tmp, ["push", "-u", "origin", defaultBranch]);
        yield* git(tmp, ["remote", "set-head", "origin", defaultBranch]);

        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "current-branch" });
        yield* (yield* GitCore).checkoutBranch({ cwd: tmp, branch: "current-branch" });
        yield* commitWithDate(
          tmp,
          "current.txt",
          "current change\n",
          "Thu, 1 Jan 2037 00:00:00 +0000",
          "current change",
        );

        yield* (yield* GitCore).checkoutBranch({ cwd: tmp, branch: defaultBranch });
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "newer-branch" });
        yield* (yield* GitCore).checkoutBranch({ cwd: tmp, branch: "newer-branch" });
        yield* commitWithDate(
          tmp,
          "newer.txt",
          "newer change\n",
          "Fri, 1 Jan 2038 00:00:00 +0000",
          "newer change",
        );

        yield* (yield* GitCore).checkoutBranch({ cwd: tmp, branch: "current-branch" });

        const result = yield* (yield* GitCore).listBranches({ cwd: tmp });
        expect(result.branches[0]!.name).toBe("current-branch");
        expect(result.branches[1]!.name).toBe(defaultBranch);
        expect(result.branches[2]!.name).toBe("newer-branch");
      }),
    );

    it.effect("reports the origin default branch in status details for feature branches", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const remote = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* git(tmp, ["branch", "-m", "trunk"]);
        yield* git(remote, ["init", "--bare"]);
        yield* git(tmp, ["remote", "add", "origin", remote]);
        yield* git(tmp, ["push", "-u", "origin", "trunk"]);
        yield* git(tmp, ["remote", "set-head", "origin", "trunk"]);
        yield* git(tmp, ["checkout", "-b", "feature/default-branch", "--track", "origin/trunk"]);

        const details = yield* (yield* GitCore).statusDetails(tmp);
        expect(details.branch).toBe("feature/default-branch");
        expect(details.upstreamRef).toBe("origin/trunk");
        expect(details.defaultBranch).toBe("trunk");
        expect(details.isDefaultBranch).toBe(false);
      }),
    );

    it.effect("lists multiple branches after creating them", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "feature-a" });
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "feature-b" });

        const result = yield* (yield* GitCore).listBranches({ cwd: tmp });
        const names = result.branches.map((b) => b.name);
        expect(names).toContain("feature-a");
        expect(names).toContain("feature-b");
      }),
    );

    it.effect("paginates branch results and returns paging metadata", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(tmp);
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "feature-a" });
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "feature-b" });
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "feature-c" });

        const firstPage = yield* (yield* GitCore).listBranches({ cwd: tmp, limit: 2 });
        expect(firstPage.totalCount).toBe(4);
        expect(firstPage.nextCursor).toBe(2);
        expect(firstPage.branches.map((branch) => branch.name)).toEqual([
          initialBranch,
          "feature-a",
        ]);

        const secondPage = yield* (yield* GitCore).listBranches({
          cwd: tmp,
          cursor: firstPage.nextCursor ?? 0,
          limit: 2,
        });
        expect(secondPage.totalCount).toBe(4);
        expect(secondPage.nextCursor).toBeNull();
        expect(secondPage.branches.map((branch) => branch.name)).toEqual([
          "feature-b",
          "feature-c",
        ]);
      }),
    );

    it.effect("parses separate branch names when column.ui is always enabled", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(tmp);
        const createdBranchNames = [
          "go-bin",
          "copilot/rewrite-cli-in-go",
          "copilot/rewrite-cli-in-rust",
        ] as const;
        for (const branchName of createdBranchNames) {
          yield* (yield* GitCore).createBranch({ cwd: tmp, branch: branchName });
        }
        yield* git(tmp, ["config", "column.ui", "always"]);

        const rawBranchOutput = yield* git(tmp, ["branch", "--no-color"], {
          ...process.env,
          COLUMNS: "120",
        });
        expect(
          rawBranchOutput
            .split("\n")
            .some(
              (line) =>
                createdBranchNames.filter((branchName) => line.includes(branchName)).length >= 2,
            ),
        ).toBe(true);

        const realGitCore = yield* GitCore;
        const core = yield* makeIsolatedGitCore((input) =>
          realGitCore.execute(
            input.args[0] === "branch"
              ? {
                  ...input,
                  env: { ...input.env, COLUMNS: "120" },
                }
              : input,
          ),
        );

        const result = yield* core.listBranches({ cwd: tmp });
        const localBranchNames = result.branches
          .filter((branch) => !branch.isRemote)
          .map((branch) => branch.name);

        expect(localBranchNames).toHaveLength(4);
        expect(localBranchNames).toEqual(
          expect.arrayContaining([initialBranch, ...createdBranchNames]),
        );
        expect(
          localBranchNames.some(
            (branchName) =>
              createdBranchNames.filter((createdBranch) => branchName.includes(createdBranch))
                .length >= 2,
          ),
        ).toBe(false);
      }),
    );

    it.effect("isDefault is false when no remote exists", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const result = yield* (yield* GitCore).listBranches({ cwd: tmp });
        expect(result.branches.every((b) => b.isDefault === false)).toBe(true);
      }),
    );

    it.effect("marks origin's default ref and keeps it on the first page", () =>
      Effect.gen(function* () {
        const remote = yield* makeTmpDir();
        const tmp = yield* makeTmpDir();
        yield* git(remote, ["init", "--bare", "--initial-branch=trunk"]);
        yield* initRepoWithCommit(tmp);
        yield* git(tmp, ["branch", "-M", "trunk"]);
        yield* git(tmp, ["remote", "add", "origin", remote]);
        yield* git(tmp, ["push", "origin", "trunk"]);
        yield* git(tmp, ["remote", "add", "fork", remote]);
        yield* git(tmp, ["fetch", "fork"]);
        yield* git(tmp, ["remote", "set-head", "origin", "trunk"]);
        yield* git(tmp, ["checkout", "-b", "feature"]);
        yield* git(tmp, ["branch", "-D", "trunk"]);
        for (const name of ["other-a", "other-b", "other-c"]) {
          yield* git(tmp, ["branch", name]);
        }

        const result = yield* (yield* GitCore).listBranches({ cwd: tmp, limit: 2 });

        expect(result.branches.map((branch) => branch.name)).toEqual(["feature", "origin/trunk"]);
        expect(result.branches[1]).toMatchObject({ isRemote: true, isDefault: true });
        const everything = yield* (yield* GitCore).listBranches({ cwd: tmp });
        expect(everything.branches.find((branch) => branch.name === "fork/trunk")?.isDefault).toBe(
          false,
        );
      }),
    );

    it.effect("lists local branches first and remote branches last", () =>
      Effect.gen(function* () {
        const remote = yield* makeTmpDir();
        const tmp = yield* makeTmpDir();

        yield* git(remote, ["init", "--bare"]);
        yield* initRepoWithCommit(tmp);
        const defaultBranch = (yield* (yield* GitCore).listBranches({ cwd: tmp })).branches.find(
          (branch) => branch.current,
        )!.name;

        yield* git(tmp, ["remote", "add", "origin", remote]);
        yield* git(tmp, ["push", "-u", "origin", defaultBranch]);

        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "feature/local-only" });

        const remoteOnlyBranch = "feature/remote-only";
        yield* (yield* GitCore).checkoutBranch({ cwd: tmp, branch: defaultBranch });
        yield* git(tmp, ["checkout", "-b", remoteOnlyBranch]);
        yield* git(tmp, ["push", "-u", "origin", remoteOnlyBranch]);
        yield* git(tmp, ["checkout", defaultBranch]);
        yield* git(tmp, ["branch", "-D", remoteOnlyBranch]);

        const result = yield* (yield* GitCore).listBranches({ cwd: tmp });
        const firstRemoteIndex = result.branches.findIndex((branch) => branch.isRemote);

        expect(result.hasOriginRemote).toBe(true);
        expect(firstRemoteIndex).toBeGreaterThan(0);
        expect(result.branches.slice(0, firstRemoteIndex).every((branch) => !branch.isRemote)).toBe(
          true,
        );
        expect(result.branches.slice(firstRemoteIndex).every((branch) => branch.isRemote)).toBe(
          true,
        );
        expect(
          result.branches.some(
            (branch) => branch.name === "feature/local-only" && !branch.isRemote,
          ),
        ).toBe(true);
        expect(
          result.branches.some(
            (branch) => branch.name === "origin/feature/remote-only" && branch.isRemote,
          ),
        ).toBe(true);
      }),
    );

    it.effect("includes remoteName metadata for remotes with slash in the name", () =>
      Effect.gen(function* () {
        const remote = yield* makeTmpDir();
        const tmp = yield* makeTmpDir();
        const remoteName = "my-org/upstream";

        yield* git(remote, ["init", "--bare"]);
        yield* initRepoWithCommit(tmp);
        const defaultBranch = (yield* (yield* GitCore).listBranches({ cwd: tmp })).branches.find(
          (branch) => branch.current,
        )!.name;

        yield* git(tmp, ["remote", "add", remoteName, remote]);
        yield* git(tmp, ["push", "-u", remoteName, defaultBranch]);

        const remoteOnlyBranch = "feature/remote-with-remote-name";
        yield* git(tmp, ["checkout", "-b", remoteOnlyBranch]);
        yield* git(tmp, ["push", "-u", remoteName, remoteOnlyBranch]);
        yield* git(tmp, ["checkout", defaultBranch]);
        yield* git(tmp, ["branch", "-D", remoteOnlyBranch]);

        const result = yield* (yield* GitCore).listBranches({ cwd: tmp });
        const remoteBranch = result.branches.find(
          (branch) => branch.name === `${remoteName}/${remoteOnlyBranch}`,
        );

        expect(remoteBranch).toBeDefined();
        expect(remoteBranch?.isRemote).toBe(true);
        expect(remoteBranch?.remoteName).toBe(remoteName);
      }),
    );

    it.effect(
      "filters branch queries before pagination and dedupes origin refs with local matches",
      () =>
        Effect.gen(function* () {
          const remote = yield* makeTmpDir();
          const tmp = yield* makeTmpDir();

          yield* git(remote, ["init", "--bare"]);
          const { initialBranch } = yield* initRepoWithCommit(tmp);
          yield* git(tmp, ["remote", "add", "origin", remote]);
          yield* git(tmp, ["push", "-u", "origin", initialBranch]);

          yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "feature/demo" });
          yield* git(tmp, ["push", "-u", "origin", "feature/demo"]);

          yield* git(tmp, ["checkout", "-b", "feature/remote-only"]);
          yield* git(tmp, ["push", "-u", "origin", "feature/remote-only"]);
          yield* git(tmp, ["checkout", initialBranch]);
          yield* git(tmp, ["branch", "-D", "feature/remote-only"]);

          const result = yield* (yield* GitCore).listBranches({
            cwd: tmp,
            query: "feature/",
            limit: 10,
          });

          expect(result.totalCount).toBe(2);
          expect(result.nextCursor).toBeNull();
          expect(result.branches.map((branch) => branch.name)).toEqual([
            "feature/demo",
            "origin/feature/remote-only",
          ]);
        }),
    );
  });

  // ── checkoutGitBranch ──

  describe("checkoutGitBranch", () => {
    it.effect("checks out an existing branch", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "feature" });

        yield* (yield* GitCore).checkoutBranch({ cwd: tmp, branch: "feature" });

        const result = yield* (yield* GitCore).listBranches({ cwd: tmp });
        const current = result.branches.find((b) => b.current);
        expect(current!.name).toBe("feature");
      }),
    );

    it.effect("refreshes upstream behind count after checkout when remote branch advanced", () =>
      Effect.gen(function* () {
        const services = yield* Effect.services();
        const runPromise = Effect.runPromiseWith(services);

        const remote = yield* makeTmpDir();
        const source = yield* makeTmpDir();
        const clone = yield* makeTmpDir();
        yield* git(remote, ["init", "--bare"]);

        yield* initRepoWithCommit(source);
        const defaultBranch = (yield* (yield* GitCore).listBranches({ cwd: source })).branches.find(
          (branch) => branch.current,
        )!.name;
        yield* git(source, ["remote", "add", "origin", remote]);
        yield* git(source, ["push", "-u", "origin", defaultBranch]);

        const featureBranch = "feature-behind";
        yield* (yield* GitCore).createBranch({ cwd: source, branch: featureBranch });
        yield* (yield* GitCore).checkoutBranch({ cwd: source, branch: featureBranch });
        yield* writeTextFile(path.join(source, "feature.txt"), "feature base\n");
        yield* git(source, ["add", "feature.txt"]);
        yield* git(source, ["commit", "-m", "feature base"]);
        yield* git(source, ["push", "-u", "origin", featureBranch]);
        yield* (yield* GitCore).checkoutBranch({ cwd: source, branch: defaultBranch });

        yield* git(clone, ["clone", remote, "."]);
        yield* git(clone, ["config", "user.email", "test@test.com"]);
        yield* git(clone, ["config", "user.name", "Test"]);
        yield* git(clone, ["checkout", "-b", featureBranch, "--track", `origin/${featureBranch}`]);
        yield* writeTextFile(path.join(clone, "feature.txt"), "feature from remote\n");
        yield* git(clone, ["add", "feature.txt"]);
        yield* git(clone, ["commit", "-m", "remote feature update"]);
        yield* git(clone, ["push", "origin", featureBranch]);

        yield* (yield* GitCore).checkoutBranch({ cwd: source, branch: featureBranch });
        const core = yield* GitCore;
        yield* Effect.promise(() =>
          vi.waitFor(
            async () => {
              const details = await runPromise(core.statusDetails(source));
              expect(details.branch).toBe(featureBranch);
              expect(details.aheadCount).toBe(0);
              expect(details.behindCount).toBe(1);
            },
            {
              timeout: 10_000,
              interval: 100,
            },
          ),
        );
      }),
    );

    it.effect("statusDetails remains successful when upstream refresh fails after checkout", () =>
      Effect.gen(function* () {
        const remote = yield* makeTmpDir();
        const source = yield* makeTmpDir();
        yield* git(remote, ["init", "--bare"]);

        yield* initRepoWithCommit(source);
        const defaultBranch = (yield* (yield* GitCore).listBranches({ cwd: source })).branches.find(
          (branch) => branch.current,
        )!.name;
        yield* git(source, ["remote", "add", "origin", remote]);
        yield* git(source, ["push", "-u", "origin", defaultBranch]);

        const featureBranch = "feature-refresh-failure";
        yield* git(source, ["branch", featureBranch]);
        yield* git(source, ["checkout", featureBranch]);
        yield* writeTextFile(path.join(source, "feature.txt"), "feature base\n");
        yield* git(source, ["add", "feature.txt"]);
        yield* git(source, ["commit", "-m", "feature base"]);
        yield* git(source, ["push", "-u", "origin", featureBranch]);
        yield* git(source, ["checkout", defaultBranch]);

        const realGitCore = yield* GitCore;
        let refreshFetchAttempts = 0;
        const core = yield* makeIsolatedGitCore((input) => {
          if (input.args[0] === "--git-dir" && input.args[2] === "fetch") {
            refreshFetchAttempts += 1;
            return Effect.fail(
              new GitCommandError({
                operation: "git.test.refreshFailure",
                command: `git ${input.args.join(" ")}`,
                cwd: input.cwd,
                detail: "simulated fetch timeout",
              }),
            );
          }
          return realGitCore.execute(input);
        });
        yield* core.checkoutBranch({ cwd: source, branch: featureBranch });
        const status = yield* core.statusDetails(source);
        expect(refreshFetchAttempts).toBe(1);
        expect(status.branch).toBe(featureBranch);
        expect(status.upstreamRef).toBe(`origin/${featureBranch}`);
        expect(yield* git(source, ["branch", "--show-current"])).toBe(featureBranch);
      }),
    );

    it.effect("defers upstream refresh until statusDetails is requested", () =>
      Effect.gen(function* () {
        const remote = yield* makeTmpDir();
        const source = yield* makeTmpDir();
        yield* git(remote, ["init", "--bare"]);

        yield* initRepoWithCommit(source);
        const defaultBranch = (yield* (yield* GitCore).listBranches({ cwd: source })).branches.find(
          (branch) => branch.current,
        )!.name;
        yield* git(source, ["remote", "add", "origin", remote]);
        yield* git(source, ["push", "-u", "origin", defaultBranch]);

        const featureBranch = "feature/scoped-fetch";
        yield* git(source, ["checkout", "-b", featureBranch]);
        yield* writeTextFile(path.join(source, "feature.txt"), "feature base\n");
        yield* git(source, ["add", "feature.txt"]);
        yield* git(source, ["commit", "-m", "feature base"]);
        yield* git(source, ["push", "-u", "origin", featureBranch]);
        yield* git(source, ["checkout", defaultBranch]);

        const realGitCore = yield* GitCore;
        let refreshFetchAttempts = 0;
        const core = yield* makeIsolatedGitCore((input) => {
          if (input.args[0] === "--git-dir" && input.args[2] === "fetch") {
            refreshFetchAttempts += 1;
            return Effect.succeed({
              code: 0,
              stdout: "",
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
            });
          }
          return realGitCore.execute(input);
        });
        yield* core.checkoutBranch({ cwd: source, branch: featureBranch });
        yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 50)));
        expect(refreshFetchAttempts).toBe(0);
        const status = yield* core.statusDetails(source);
        expect(status.branch).toBe(featureBranch);
        expect(refreshFetchAttempts).toBe(1);
      }),
    );

    it.effect(
      "shares one remote refresh across worktrees on different branches of the same remote",
      () =>
        Effect.gen(function* () {
          const ok = (stdout = "") =>
            Effect.succeed({
              code: 0,
              stdout,
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
            });

          let fetchCount = 0;
          const core = yield* makeIsolatedGitCore((input) => {
            if (input.args[0] === "symbolic-ref") {
              return ok(input.cwd.endsWith("pr-123") ? "refs/heads/pr-123\n" : "refs/heads/main\n");
            }
            if (
              input.args[0] === "for-each-ref" &&
              input.args[1] === "--format=%(upstream:remotename)"
            ) {
              return ok("origin\n");
            }
            if (input.args[0] === "rev-parse" && input.args[1] === "--git-common-dir") {
              return ok("/repo/.git\n");
            }
            if (input.args[0] === "--git-dir" && input.args[2] === "fetch") {
              fetchCount += 1;
              expect(input.cwd).toBe("/repo");
              expect(input.args.slice(2)).toEqual([
                "fetch",
                "--quiet",
                "--no-tags",
                "--no-auto-gc",
                "--",
                "origin",
              ]);
              return ok();
            }
            if (input.operation === "GitCore.statusDetails.status") {
              return ok("# branch.head main\0# branch.upstream origin/main\0# branch.ab +0 -0\0");
            }
            if (input.operation === "GitCore.statusDetails.numstat") {
              return ok();
            }
            if (input.operation === "GitCore.statusDetails.defaultRef") {
              return ok("refs/remotes/origin/main\n");
            }
            return Effect.fail(
              new GitCommandError({
                operation: input.operation,
                command: `git ${input.args.join(" ")}`,
                cwd: input.cwd,
                detail: "Unexpected git command in shared refresh cache test.",
              }),
            );
          });

          yield* core.statusDetails("/repo/worktrees/main");
          yield* core.statusDetails("/repo/worktrees/pr-123");
          expect(fetchCount).toBe(1);
        }),
    );

    it.effect("fails instead of falling back to porcelain diff when HEAD is not unborn", () =>
      Effect.gen(function* () {
        const result = (code: number, stdout = "", stderr = "") =>
          Effect.succeed({ code, stdout, stderr, stdoutTruncated: false, stderrTruncated: false });
        const operations: string[] = [];
        const core = yield* makeIsolatedGitCore((input) => {
          operations.push(input.operation);
          if (input.operation === "GitCore.statusDetails.status") {
            return result(0, "# branch.head main\0# branch.ab +0 -0\0");
          }
          if (input.operation === "GitCore.statusDetails.numstat") {
            return result(128, "", "fatal: index file smaller than expected\n");
          }
          if (input.operation === "GitCore.statusDetails.defaultRef") {
            return result(1);
          }
          return Effect.fail(
            new GitCommandError({
              operation: input.operation,
              command: `git ${input.args.join(" ")}`,
              cwd: input.cwd,
              detail: "Unexpected git command in staged numstat failure test.",
            }),
          );
        });

        const error = yield* Effect.flip(core.statusDetails("/repo"));

        expect(error.operation).toBe("GitCore.statusDetails.numstat");
        expect(error.detail).toContain("index file smaller than expected");
        expect(operations).not.toContain("GitCore.statusDetails.numstat.unborn");
      }),
    );

    it.effect("backs off failed remote refreshes exponentially across sibling worktrees", () =>
      Effect.gen(function* () {
        const ok = (stdout = "") =>
          Effect.succeed({
            code: 0,
            stdout,
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          });

        let fetchCount = 0;
        let fetchExitCode = 128;
        const core = yield* makeIsolatedGitCore((input) => {
          if (input.args[0] === "symbolic-ref") {
            return ok(input.cwd.endsWith("pr-123") ? "refs/heads/pr-123\n" : "refs/heads/main\n");
          }
          if (
            input.args[0] === "for-each-ref" &&
            input.args[1] === "--format=%(upstream:remotename)"
          ) {
            return ok("origin\n");
          }
          if (input.args[0] === "rev-parse" && input.args[1] === "--git-common-dir") {
            return ok("/repo/.git\n");
          }
          if (input.args[0] === "--git-dir" && input.args[2] === "fetch") {
            fetchCount += 1;
            // A non-zero exit (offline, rejected credentials) counts as a failure.
            return Effect.succeed({
              code: fetchExitCode,
              stdout: "",
              stderr: fetchExitCode === 0 ? "" : "fatal: unable to access remote\n",
              stdoutTruncated: false,
              stderrTruncated: false,
            });
          }
          if (input.operation === "GitCore.statusDetails.status") {
            return ok("# branch.head main\0# branch.upstream origin/main\0# branch.ab +0 -0\0");
          }
          if (input.operation === "GitCore.statusDetails.numstat") {
            return ok();
          }
          if (input.operation === "GitCore.statusDetails.defaultRef") {
            return ok("refs/remotes/origin/main\n");
          }
          return Effect.fail(
            new GitCommandError({
              operation: input.operation,
              command: `git ${input.args.join(" ")}`,
              cwd: input.cwd,
              detail: "Unexpected git command in refresh failure cooldown test.",
            }),
          );
        });

        yield* core.statusDetails("/repo/worktrees/main");
        yield* core.statusDetails("/repo/worktrees/pr-123");
        expect(fetchCount).toBe(1);

        // First failure: 30s; second: 60s.
        yield* TestClock.adjust("29 seconds");
        yield* core.statusDetails("/repo/worktrees/main");
        expect(fetchCount).toBe(1);
        yield* TestClock.adjust("2 seconds");
        yield* core.statusDetails("/repo/worktrees/main");
        expect(fetchCount).toBe(2);
        yield* TestClock.adjust("59 seconds");
        yield* core.statusDetails("/repo/worktrees/main");
        expect(fetchCount).toBe(2);
        yield* TestClock.adjust("2 seconds");
        fetchExitCode = 0;
        yield* core.statusDetails("/repo/worktrees/main");
        expect(fetchCount).toBe(3);

        // Success resets the count, so the next failure backs off 30s again.
        fetchExitCode = 128;
        yield* TestClock.adjust("16 seconds");
        yield* core.statusDetails("/repo/worktrees/main");
        expect(fetchCount).toBe(4);
        yield* TestClock.adjust("31 seconds");
        yield* core.statusDetails("/repo/worktrees/main");
        expect(fetchCount).toBe(5);
      }),
    );

    it("caps the background fetch failure backoff at 15 minutes", () => {
      expect(
        [1, 2, 3, 6, 20].map((count) =>
          Duration.toSeconds(statusUpstreamRefreshFailureCooldown(count)),
        ),
      ).toEqual([30, 60, 120, 900, 900]);
      // Never retries sooner than the configured fetch interval.
      expect(Duration.toSeconds(statusUpstreamRefreshFailureCooldown(1, 3_600_000))).toBe(3_600);
      expect(Duration.toSeconds(statusUpstreamRefreshFailureCooldown(3, 60_000))).toBe(120);
    });

    it.effect("throws when branch does not exist", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const result = yield* Effect.result(
          (yield* GitCore).checkoutBranch({ cwd: tmp, branch: "nonexistent" }),
        );
        expect(result._tag).toBe("Failure");
      }),
    );

    it.effect("does not silently checkout a local branch when a remote ref no longer exists", () =>
      Effect.gen(function* () {
        const remote = yield* makeTmpDir();
        const source = yield* makeTmpDir();
        yield* git(remote, ["init", "--bare"]);

        yield* initRepoWithCommit(source);
        const defaultBranch = (yield* (yield* GitCore).listBranches({ cwd: source })).branches.find(
          (branch) => branch.current,
        )!.name;
        yield* git(source, ["remote", "add", "origin", remote]);
        yield* git(source, ["push", "-u", "origin", defaultBranch]);

        yield* (yield* GitCore).createBranch({ cwd: source, branch: "feature" });

        const checkoutResult = yield* Effect.result(
          (yield* GitCore).checkoutBranch({ cwd: source, branch: "origin/feature" }),
        );
        expect(checkoutResult._tag).toBe("Failure");
        expect(yield* git(source, ["branch", "--show-current"])).toBe(defaultBranch);
      }),
    );

    it.effect("checks out a remote tracking branch when remote name contains slashes", () =>
      Effect.gen(function* () {
        const remote = yield* makeTmpDir();
        const prefixRemote = yield* makeTmpDir();
        const source = yield* makeTmpDir();
        const prefixFetchNamespace = "prefix-my-org";
        const prefixRemoteName = "my-org";
        const remoteName = "my-org/upstream";
        const featureBranch = "feature";
        yield* git(remote, ["init", "--bare"]);
        yield* git(prefixRemote, ["init", "--bare"]);

        yield* initRepoWithCommit(source);
        const defaultBranch = (yield* (yield* GitCore).listBranches({ cwd: source })).branches.find(
          (branch) => branch.current,
        )!.name;
        yield* configureRemote(source, prefixRemoteName, prefixRemote, prefixFetchNamespace);
        yield* configureRemote(source, remoteName, remote, remoteName);
        yield* git(source, ["push", "-u", remoteName, defaultBranch]);

        yield* git(source, ["checkout", "-b", featureBranch]);
        yield* writeTextFile(path.join(source, "feature.txt"), "feature content\n");
        yield* git(source, ["add", "feature.txt"]);
        yield* git(source, ["commit", "-m", "feature commit"]);
        yield* git(source, ["push", "-u", remoteName, featureBranch]);
        yield* git(source, ["checkout", defaultBranch]);
        yield* git(source, ["branch", "-D", featureBranch]);

        yield* (yield* GitCore).checkoutBranch({
          cwd: source,
          branch: `${remoteName}/${featureBranch}`,
        });

        expect(yield* git(source, ["branch", "--show-current"])).toBe("upstream/feature");
        const realGitCore = yield* GitCore;
        let fetchArgs: readonly string[] | null = null;
        const core = yield* makeIsolatedGitCore((input) => {
          if (input.args[0] === "--git-dir" && input.args[2] === "fetch") {
            fetchArgs = [...input.args];
            return Effect.succeed({
              code: 0,
              stdout: "",
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
            });
          }
          return realGitCore.execute(input);
        });

        const status = yield* core.statusDetails(source);
        expect(status.branch).toBe("upstream/feature");
        expect(status.upstreamRef).toBe(`${remoteName}/${featureBranch}`);
        expect(fetchArgs).toEqual([
          "--git-dir",
          path.join(realpathSync(source), ".git"),
          "fetch",
          "--quiet",
          "--no-tags",
          "--no-auto-gc",
          "--",
          remoteName,
        ]);
      }),
    );

    it.effect(
      "falls back to detached checkout when --track would conflict with an existing local branch",
      () =>
        Effect.gen(function* () {
          const remote = yield* makeTmpDir();
          const source = yield* makeTmpDir();
          yield* git(remote, ["init", "--bare"]);

          yield* initRepoWithCommit(source);
          const defaultBranch = (yield* (yield* GitCore).listBranches({
            cwd: source,
          })).branches.find((branch) => branch.current)!.name;
          yield* git(source, ["remote", "add", "origin", remote]);
          yield* git(source, ["push", "-u", "origin", defaultBranch]);

          // Keep local branch but remove tracking so `--track origin/<branch>`
          // would attempt to create an already-existing local branch.
          yield* git(source, ["branch", "--unset-upstream"]);

          yield* (yield* GitCore).checkoutBranch({
            cwd: source,
            branch: `origin/${defaultBranch}`,
          });

          const core = yield* GitCore;
          const status = yield* core.statusDetails(source);
          expect(status.branch).toBeNull();
        }),
    );

    it.effect("throws when checkout would overwrite uncommitted changes", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "other" });

        // Create a conflicting change: modify README on current branch
        yield* writeTextFile(path.join(tmp, "README.md"), "modified\n");
        yield* git(tmp, ["add", "README.md"]);

        // First, checkout other branch cleanly
        yield* git(tmp, ["stash"]);
        yield* (yield* GitCore).checkoutBranch({ cwd: tmp, branch: "other" });
        yield* writeTextFile(path.join(tmp, "README.md"), "other content\n");
        yield* git(tmp, ["add", "."]);
        yield* git(tmp, ["commit", "-m", "other change"]);

        // Go back to default branch
        const defaultBranch = (yield* (yield* GitCore).listBranches({ cwd: tmp })).branches.find(
          (b) => !b.current,
        )!.name;
        yield* (yield* GitCore).checkoutBranch({ cwd: tmp, branch: defaultBranch });

        // Make uncommitted changes to the same file
        yield* writeTextFile(path.join(tmp, "README.md"), "conflicting local\n");

        // Checkout should fail due to uncommitted changes
        const result = yield* Effect.result(
          (yield* GitCore).checkoutBranch({ cwd: tmp, branch: "other" }),
        );
        expect(result._tag).toBe("Failure");
      }),
    );
  });

  // ── createGitBranch ──

  describe("createGitBranch", () => {
    it.effect("creates a new branch visible in listGitBranches", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "new-feature" });

        const result = yield* (yield* GitCore).listBranches({ cwd: tmp });
        expect(result.branches.some((b) => b.name === "new-feature")).toBe(true);
      }),
    );

    it.effect("throws when branch already exists", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "dupe" });
        const result = yield* Effect.result(
          (yield* GitCore).createBranch({ cwd: tmp, branch: "dupe" }),
        );
        expect(result._tag).toBe("Failure");
      }),
    );
  });

  describe("option-like branch names", () => {
    it.effect("never reads a client branch name as a git option", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(tmp);
        const core = yield* GitCore;
        yield* writeTextFile(path.join(tmp, "README.md"), "edited\n");

        expect(
          (yield* Effect.result(core.createBranch({ cwd: tmp, branch: "--force" })))._tag,
        ).toBe("Failure");
        const checkout = yield* Effect.flip(core.checkoutBranch({ cwd: tmp, branch: "--detach" }));
        expect(checkout.detail).toContain("cannot start with '-'");
        const worktree = yield* Effect.flip(
          core.createWorktree({
            cwd: tmp,
            branch: initialBranch,
            newBranch: "--orphan",
            path: null,
          }),
        );
        expect(worktree.detail).toContain("cannot start with '-'");

        expect(yield* git(tmp, ["branch", "--show-current"])).toBe(initialBranch);
        expect(readFileSync(path.join(tmp, "README.md"), "utf8")).toBe("edited\n");
      }),
    );

    it.effect("does not turn a non-branch name into a path checkout", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* writeTextFile(path.join(tmp, "README.md"), "edited\n");

        const result = yield* Effect.result(
          (yield* GitCore).checkoutBranch({ cwd: tmp, branch: "README.md" }),
        );

        expect(result._tag).toBe("Failure");
        expect(readFileSync(path.join(tmp, "README.md"), "utf8")).toBe("edited\n");
      }),
    );

    it.effect("lists local branch names without the heads/ prefix when a tag collides", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* git(tmp, ["branch", "release"]);
        yield* git(tmp, ["tag", "release"]);

        const names = yield* (yield* GitCore).listLocalBranchNames(tmp);

        expect(names).toContain("release");
        expect(names).not.toContain("heads/release");
      }),
    );
  });

  // ── renameGitBranch ──

  describe("renameGitBranch", () => {
    it.effect("renames the current branch", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "feature/old-name" });
        yield* (yield* GitCore).checkoutBranch({ cwd: tmp, branch: "feature/old-name" });

        const renamed = yield* (yield* GitCore).renameBranch({
          cwd: tmp,
          oldBranch: "feature/old-name",
          newBranch: "feature/new-name",
        });

        expect(renamed.branch).toBe("feature/new-name");

        const branches = yield* (yield* GitCore).listBranches({ cwd: tmp });
        expect(branches.branches.some((branch) => branch.name === "feature/old-name")).toBe(false);
        const current = branches.branches.find((branch) => branch.current);
        expect(current?.name).toBe("feature/new-name");
      }),
    );

    it.effect("returns success without git invocation when old/new names match", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const current = (yield* (yield* GitCore).listBranches({ cwd: tmp })).branches.find(
          (b) => b.current,
        )!;

        const renamed = yield* (yield* GitCore).renameBranch({
          cwd: tmp,
          oldBranch: current.name,
          newBranch: current.name,
        });

        expect(renamed.branch).toBe(current.name);
      }),
    );

    it.effect("appends numeric suffix when target branch already exists", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "piedpiper/feat/session" });
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "piedpiper/tmp-working" });
        yield* (yield* GitCore).checkoutBranch({ cwd: tmp, branch: "piedpiper/tmp-working" });

        const renamed = yield* (yield* GitCore).renameBranch({
          cwd: tmp,
          oldBranch: "piedpiper/tmp-working",
          newBranch: "piedpiper/feat/session",
        });

        expect(renamed.branch).toBe("piedpiper/feat/session-1");
        const branches = yield* (yield* GitCore).listBranches({ cwd: tmp });
        expect(branches.branches.some((branch) => branch.name === "piedpiper/feat/session")).toBe(
          true,
        );
        expect(branches.branches.some((branch) => branch.name === "piedpiper/feat/session-1")).toBe(
          true,
        );
        const current = branches.branches.find((branch) => branch.current);
        expect(current?.name).toBe("piedpiper/feat/session-1");
      }),
    );

    it.effect("increments suffix until it finds an available branch name", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "piedpiper/feat/session" });
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "piedpiper/feat/session-1" });
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "piedpiper/tmp-working" });
        yield* (yield* GitCore).checkoutBranch({ cwd: tmp, branch: "piedpiper/tmp-working" });

        const renamed = yield* (yield* GitCore).renameBranch({
          cwd: tmp,
          oldBranch: "piedpiper/tmp-working",
          newBranch: "piedpiper/feat/session",
        });

        expect(renamed.branch).toBe("piedpiper/feat/session-2");
      }),
    );

    it.effect("flattens a generated name blocked by a parent branch", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const core = yield* GitCore;
        yield* core.createBranch({ cwd: tmp, branch: "piedpiper" });
        yield* core.createBranch({ cwd: tmp, branch: "tmp-working" });
        yield* core.checkoutBranch({ cwd: tmp, branch: "tmp-working" });

        const renamed = yield* core.renameBranch({
          cwd: tmp,
          oldBranch: "tmp-working",
          newBranch: "piedpiper/fix-login",
        });

        expect(renamed.branch).toBe("piedpiper-fix-login");
        expect(yield* git(tmp, ["branch", "--show-current"])).toBe("piedpiper-fix-login");
      }),
    );

    it.effect("keeps a custom name's casing and slash, suffixing it when taken", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const core = yield* GitCore;
        yield* core.createBranch({ cwd: tmp, branch: "tmp-working" });
        yield* core.createBranch({ cwd: tmp, branch: "tmp-other" });
        yield* core.checkoutBranch({ cwd: tmp, branch: "tmp-working" });

        const free = yield* core.renameBranch({
          cwd: tmp,
          oldBranch: "tmp-working",
          newBranch: "PROJ-1/Add_Search",
        });
        expect(free.branch).toBe("PROJ-1/Add_Search");

        yield* core.checkoutBranch({ cwd: tmp, branch: "tmp-other" });
        const taken = yield* core.renameBranch({
          cwd: tmp,
          oldBranch: "tmp-other",
          newBranch: "PROJ-1/Add_Search",
        });
        expect(taken.branch).toBe("PROJ-1/Add_Search-1");
        expect(yield* git(tmp, ["branch", "--show-current"])).toBe("PROJ-1/Add_Search-1");
      }),
    );

    it.effect("suffixes a generated name blocked by a nested branch", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const core = yield* GitCore;
        yield* core.createBranch({ cwd: tmp, branch: "fix/child" });
        yield* core.createBranch({ cwd: tmp, branch: "tmp-working" });
        yield* core.checkoutBranch({ cwd: tmp, branch: "tmp-working" });

        const renamed = yield* core.renameBranch({
          cwd: tmp,
          oldBranch: "tmp-working",
          newBranch: "fix",
        });

        expect(renamed.branch).toBe("fix-1");
      }),
    );

    for (const packed of [false, true]) {
      it.effect(
        `suffixes a name that differs only by case from ${packed ? "a packed" : "a loose"} parent of a branch`,
        () =>
          Effect.gen(function* () {
            const tmp = yield* makeTmpDir();
            yield* initRepoWithCommit(tmp);
            const core = yield* GitCore;
            yield* core.createBranch({ cwd: tmp, branch: "team/bar" });
            yield* core.createBranch({ cwd: tmp, branch: "tmp-working" });
            yield* core.checkoutBranch({ cwd: tmp, branch: "tmp-working" });
            if (packed) yield* git(tmp, ["pack-refs", "--all"]);

            const renamed = yield* core.renameBranch({
              cwd: tmp,
              oldBranch: "tmp-working",
              newBranch: "Team",
            });

            expect(renamed.branch).toBe("Team-1");
            expect(yield* git(tmp, ["branch", "--show-current"])).toBe("Team-1");
          }),
      );
    }

    it.effect("does not let a name differing only by case shadow a packed branch", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const core = yield* GitCore;
        yield* core.createBranch({ cwd: tmp, branch: "proj/add" });
        const original = yield* git(tmp, ["rev-parse", "refs/heads/proj/add"]);
        yield* core.createBranch({ cwd: tmp, branch: "tmp-working" });
        yield* core.checkoutBranch({ cwd: tmp, branch: "tmp-working" });
        yield* writeTextFile(path.join(tmp, "work.txt"), "work\n");
        yield* git(tmp, ["add", "work.txt"]);
        yield* git(tmp, ["commit", "-m", "work"]);
        yield* git(tmp, ["pack-refs", "--all"]);

        const renamed = yield* core.renameBranch({
          cwd: tmp,
          oldBranch: "tmp-working",
          newBranch: "proj/Add",
        });

        expect(renamed.branch).toBe("proj/Add-1");
        expect(yield* git(tmp, ["rev-parse", "refs/heads/proj/add"])).toBe(original);
      }),
    );

    it.effect("flattens a name whose parent differs only by case from a packed branch", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const core = yield* GitCore;
        yield* core.createBranch({ cwd: tmp, branch: "team" });
        yield* core.createBranch({ cwd: tmp, branch: "tmp-working" });
        yield* core.checkoutBranch({ cwd: tmp, branch: "tmp-working" });
        yield* git(tmp, ["pack-refs", "--all"]);

        const renamed = yield* core.renameBranch({
          cwd: tmp,
          oldBranch: "tmp-working",
          newBranch: "Team/foo",
        });

        expect(renamed.branch).toBe("Team-foo");
      }),
    );

    it.effect("sees a branch that shares its name with a tag", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const core = yield* GitCore;
        yield* core.createBranch({ cwd: tmp, branch: "release" });
        yield* git(tmp, ["tag", "release"]);
        yield* core.createBranch({ cwd: tmp, branch: "tmp-working" });
        yield* core.checkoutBranch({ cwd: tmp, branch: "tmp-working" });
        yield* git(tmp, ["pack-refs", "--all"]);

        const renamed = yield* core.renameBranch({
          cwd: tmp,
          oldBranch: "tmp-working",
          newBranch: "Release",
        });

        expect(renamed.branch).toBe("Release-1");
      }),
    );

    it.effect("uses '--' separator for branch rename arguments", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "feature/old-name" });
        yield* (yield* GitCore).checkoutBranch({ cwd: tmp, branch: "feature/old-name" });

        const realGitCore = yield* GitCore;
        let renameArgs: ReadonlyArray<string> | null = null;
        const core = yield* makeIsolatedGitCore((input) => {
          if (input.args[0] === "branch" && input.args[1] === "-m") {
            renameArgs = [...input.args];
          }
          return realGitCore.execute(input);
        });

        const renamed = yield* core.renameBranch({
          cwd: tmp,
          oldBranch: "feature/old-name",
          newBranch: "feature/new-name",
        });

        expect(renamed.branch).toBe("feature/new-name");
        expect(renameArgs).toEqual(["branch", "-m", "--", "feature/old-name", "feature/new-name"]);
      }),
    );
  });

  // ── createGitWorktree + removeGitWorktree ──

  describe("createGitWorktree", () => {
    it.effect("creates a worktree with a new branch from the base branch", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);

        const wtPath = path.join(tmp, "worktree-out");
        const currentBranch = (yield* (yield* GitCore).listBranches({ cwd: tmp })).branches.find(
          (b) => b.current,
        )!.name;

        const result = yield* (yield* GitCore).createWorktree({
          cwd: tmp,
          branch: currentBranch,
          newBranch: "wt-branch",
          path: wtPath,
        });

        expect(result.worktree.path).toBe(wtPath);
        expect(result.worktree.branch).toBe("wt-branch");
        expect(existsSync(wtPath)).toBe(true);
        expect(existsSync(path.join(wtPath, "README.md"))).toBe(true);

        // Clean up worktree before tmp dir disposal
        yield* (yield* GitCore).removeWorktree({ cwd: tmp, path: wtPath });
      }),
    );

    it.effect("worktree has the new branch checked out", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);

        const wtPath = path.join(tmp, "wt-check-dir");
        const currentBranch = (yield* (yield* GitCore).listBranches({ cwd: tmp })).branches.find(
          (b) => b.current,
        )!.name;

        yield* (yield* GitCore).createWorktree({
          cwd: tmp,
          branch: currentBranch,
          newBranch: "wt-check",
          path: wtPath,
        });

        // Verify the worktree is on the new branch
        const branchOutput = yield* git(wtPath, ["branch", "--show-current"]);
        expect(branchOutput).toBe("wt-check");

        yield* (yield* GitCore).removeWorktree({ cwd: tmp, path: wtPath });
      }),
    );

    it.effect("creates a worktree for an existing branch when newBranch is omitted", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "feature/existing-worktree" });

        const wtPath = path.join(tmp, "wt-existing");
        const result = yield* (yield* GitCore).createWorktree({
          cwd: tmp,
          branch: "feature/existing-worktree",
          path: wtPath,
        });

        expect(result.worktree.path).toBe(wtPath);
        expect(result.worktree.branch).toBe("feature/existing-worktree");
        const branchOutput = yield* git(wtPath, ["branch", "--show-current"]);
        expect(branchOutput).toBe("feature/existing-worktree");

        yield* (yield* GitCore).removeWorktree({ cwd: tmp, path: wtPath });
      }),
    );

    it.effect("throws when new branch name already exists", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "existing" });

        const wtPath = path.join(tmp, "wt-conflict");
        const currentBranch = (yield* (yield* GitCore).listBranches({ cwd: tmp })).branches.find(
          (b) => b.current,
        )!.name;

        const result = yield* Effect.result(
          (yield* GitCore).createWorktree({
            cwd: tmp,
            branch: currentBranch,
            newBranch: "existing",
            path: wtPath,
          }),
        );
        expect(result._tag).toBe("Failure");
      }),
    );

    it.effect("keeps a pre-existing branch when worktree add refuses to recreate it", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(tmp);
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "existing-kept" });

        const result = yield* Effect.result(
          (yield* GitCore).createWorktree({
            cwd: tmp,
            branch: initialBranch,
            newBranch: "existing-kept",
            path: path.join(tmp, "wt-kept"),
          }),
        );

        expect(result._tag).toBe("Failure");
        expect(yield* git(tmp, ["branch", "--list", "existing-kept"])).toContain("existing-kept");
      }),
    );

    it.effect("lets a worktree checkout that is still working run past five minutes", () =>
      Effect.gen(function* () {
        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        const addStarted = yield* Deferred.make<void>();
        const slowAddSpawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            if (ChildProcess.isStandardCommand(command) && isWorktreeAdd(command.args)) {
              yield* Deferred.succeed(addStarted, undefined);
              yield* Effect.sleep("6 minutes");
            }
            return yield* delegate.spawn(command);
          }),
        );
        const core = yield* makeGitCore().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, slowAddSpawner),
          Effect.provide(ServerConfigLayer),
        );
        const tmp = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(tmp);
        const wtPath = path.join(tmp, "wt-slow");

        const creating = yield* core
          .createWorktree({ cwd: tmp, branch: initialBranch, newBranch: "wt-slow", path: wtPath })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(addStarted);
        yield* TestClock.adjust("6 minutes");
        const result = yield* Fiber.join(creating);

        expect(result.worktree).toEqual({ path: wtPath, branch: "wt-slow" });
        expect(existsSync(path.join(wtPath, "README.md"))).toBe(true);
        yield* core.removeWorktree({ cwd: tmp, path: wtPath, force: true });
      }),
    );

    it.effect("still ends a worktree checkout that stalls past the worktree timeout", () =>
      Effect.gen(function* () {
        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        const addStarted = yield* Deferred.make<void>();
        const stalledAddSpawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            if (ChildProcess.isStandardCommand(command) && isWorktreeAdd(command.args)) {
              yield* Deferred.succeed(addStarted, undefined);
              return yield* Effect.never;
            }
            return yield* delegate.spawn(command);
          }),
        );
        const core = yield* makeGitCore().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, stalledAddSpawner),
          Effect.provide(ServerConfigLayer),
        );
        const tmp = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(tmp);

        const creating = yield* core
          .createWorktree({
            cwd: tmp,
            branch: initialBranch,
            newBranch: "wt-stalled",
            path: path.join(tmp, "wt-stalled"),
          })
          .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(addStarted);
        yield* TestClock.adjust("31 minutes");
        const error = yield* Fiber.join(creating);

        expect(error.detail).toContain("timed out");
      }),
    );

    it.effect("removes the new branch when the worktree cannot be added", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(tmp);
        const occupiedPath = yield* makeTmpDir("git-worktrees-");
        yield* writeTextFile(path.join(occupiedPath, "existing.txt"), "occupied\n");
        const core = yield* GitCore;

        const failed = yield* Effect.result(
          core.createWorktree({
            cwd: tmp,
            branch: initialBranch,
            newBranch: "piedpiper-collide",
            path: occupiedPath,
          }),
        );

        expect(failed._tag).toBe("Failure");
        expect(yield* git(tmp, ["branch", "--list", "piedpiper-collide"])).toBe("");
        const retryPath = path.join(yield* makeTmpDir("git-worktrees-"), "retry");
        yield* core.createWorktree({
          cwd: tmp,
          branch: initialBranch,
          newBranch: "piedpiper-collide",
          path: retryPath,
        });
        expect(yield* git(retryPath, ["branch", "--show-current"])).toBe("piedpiper-collide");
        yield* core.removeWorktree({ cwd: tmp, path: retryPath, force: true });
      }),
    );

    it.effect("keeps the winner's branch when two adds race for the same new branch", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(tmp);
        const root = yield* makeTmpDir("git-worktrees-");
        const core = yield* GitCore;
        const create = (name: string) =>
          Effect.result(
            core.createWorktree({
              cwd: tmp,
              branch: initialBranch,
              newBranch: "piedpiper-race",
              path: path.join(root, name),
            }),
          );

        const results = yield* Effect.all([create("a"), create("b")], { concurrency: 2 });

        const winners = results.filter((result) => result._tag === "Success");
        expect(winners).toHaveLength(1);
        expect(yield* git(tmp, ["branch", "--list", "piedpiper-race"])).toContain("piedpiper-race");
        const winnerPath = path.join(root, results[0]._tag === "Success" ? "a" : "b");
        expect(yield* git(winnerPath, ["branch", "--show-current"])).toBe("piedpiper-race");
      }),
    );

    it.effect("skips branch cleanup when git failed before creating the branch", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const realGitCore = yield* GitCore;
        const operations: string[] = [];
        const core = yield* makeIsolatedGitCore((input) => {
          operations.push(input.operation);
          return realGitCore.execute(input);
        });

        const failed = yield* Effect.result(
          core.createWorktree({
            cwd: tmp,
            branch: "no-such-start-point",
            newBranch: "piedpiper-bad-start",
            path: path.join(yield* makeTmpDir("git-worktrees-"), "bad"),
          }),
        );

        expect(failed._tag).toBe("Failure");
        expect(operations).not.toContain("GitCore.createWorktree.deleteBranch");
        expect(yield* git(tmp, ["branch", "--list", "piedpiper-bad-start"])).toBe("");
      }),
    );

    it.effect(
      "refuses to remove a worktree with untracked files hidden by showUntrackedFiles=no",
      () =>
        Effect.gen(function* () {
          const tmp = yield* makeTmpDir();
          const { initialBranch } = yield* initRepoWithCommit(tmp);
          yield* git(tmp, ["config", "status.showUntrackedFiles", "no"]);
          const wtPath = path.join(yield* makeTmpDir("git-worktrees-"), "hidden-untracked");
          const core = yield* GitCore;
          yield* core.createWorktree({
            cwd: tmp,
            branch: initialBranch,
            newBranch: "hidden-untracked",
            path: wtPath,
          });
          yield* writeTextFile(path.join(wtPath, "notes.txt"), "draft\n");

          const result = yield* Effect.result(core.removeWorktree({ cwd: tmp, path: wtPath }));

          expect(result._tag).toBe("Failure");
          expect(existsSync(path.join(wtPath, "notes.txt"))).toBe(true);
          yield* core.removeWorktree({ cwd: tmp, path: wtPath, force: true });
        }),
    );

    const makeRepoWithManyFiles = Effect.fn("makeRepoWithManyFiles")(function* () {
      const tmp = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(tmp);
      for (let index = 0; index < 40; index += 1) {
        yield* writeTextFile(path.join(tmp, `file-${index}.txt`), `${index}\n`);
      }
      yield* git(tmp, ["add", "."]);
      yield* git(tmp, ["commit", "-m", "many files"]);
      return { tmp, initialBranch };
    });

    it.effect("reports increasing checkout progress for a new worktree", () =>
      Effect.gen(function* () {
        const { tmp, initialBranch } = yield* makeRepoWithManyFiles();
        const wtPath = path.join(yield* makeTmpDir("git-worktrees-"), "progress");
        const percents: number[] = [];
        const core = yield* GitCore;

        yield* core.createWorktree(
          { cwd: tmp, branch: initialBranch, newBranch: "progress", path: wtPath },
          {
            onCheckoutProgress: (progress) =>
              Effect.sync(() => {
                expect(progress.total).toBeGreaterThan(1);
                percents.push(progress.percent);
              }),
          },
        );

        expect(percents.length).toBeGreaterThan(1);
        expect(percents).toEqual(percents.toSorted((a, b) => a - b));
        expect(percents.at(-1)).toBe(100);
        yield* core.removeWorktree({ cwd: tmp, path: wtPath, force: true });
      }),
    );

    const interruptDuringCheckout = Effect.fn("interruptDuringCheckout")(function* (
      input: Parameters<GitCoreShape["createWorktree"]>[0],
    ) {
      const started = yield* Deferred.make<void>();
      const creating = yield* (yield* GitCore)
        .createWorktree(input, {
          // Never returns, so the add cannot finish before the interrupt reaches it.
          onCheckoutProgress: () =>
            Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
        })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(started);
      yield* Fiber.interrupt(creating);
      return yield* Fiber.await(creating);
    });

    it.effect("leaves no worktree and no new branch when interrupted during checkout", () =>
      Effect.gen(function* () {
        const { tmp, initialBranch } = yield* makeRepoWithManyFiles();
        const wtPath = path.join(yield* makeTmpDir("git-worktrees-"), "interrupted");

        const exit = yield* interruptDuringCheckout({
          cwd: tmp,
          branch: initialBranch,
          newBranch: "interrupted",
          path: wtPath,
        });

        expect(Exit.hasInterrupts(exit)).toBe(true);
        expect(existsSync(wtPath)).toBe(false);
        expect(yield* git(tmp, ["branch", "--list", "interrupted"])).toBe("");
        expect(yield* git(tmp, ["worktree", "list", "--porcelain"])).not.toContain("interrupted");
      }),
    );

    it.effect("keeps a branch that existed before an interrupted worktree", () =>
      Effect.gen(function* () {
        const { tmp, initialBranch } = yield* makeRepoWithManyFiles();
        yield* git(tmp, ["branch", "kept", initialBranch]);
        const wtPath = path.join(yield* makeTmpDir("git-worktrees-"), "kept");

        const exit = yield* interruptDuringCheckout({ cwd: tmp, branch: "kept", path: wtPath });

        expect(Exit.hasInterrupts(exit)).toBe(true);
        expect(existsSync(wtPath)).toBe(false);
        expect(yield* git(tmp, ["branch", "--list", "kept"])).toContain("kept");
        expect(yield* git(tmp, ["worktree", "list", "--porcelain"])).not.toContain(wtPath);
      }),
    );

    it.effect("reports a failed add as a failure, keeping the folder's contents", () =>
      Effect.gen(function* () {
        const { tmp, initialBranch } = yield* makeRepoWithManyFiles();
        const occupied = yield* makeTmpDir("git-worktrees-");
        yield* writeTextFile(path.join(occupied, "keep.txt"), "mine\n");

        // Flip fails the test on an interrupt, which a client would show as a silent cancel.
        const error = yield* (yield* GitCore)
          .createWorktree(
            { cwd: tmp, branch: initialBranch, newBranch: "refused", path: occupied },
            { onCheckoutProgress: () => Effect.void },
          )
          .pipe(Effect.flip);

        expect(error._tag).toBe("GitCommandError");
        expect(error.detail).toContain("already exists");
        expect(error.detail).not.toContain("Updating files");
        expect(readFileSync(path.join(occupied, "keep.txt"), "utf8")).toBe("mine\n");
        expect(yield* git(tmp, ["branch", "--list", "refused"])).toBe("");
      }),
    );

    it.effect("keeps a folder's contents when interrupted before git could refuse it", () =>
      Effect.gen(function* () {
        const { tmp, initialBranch } = yield* makeRepoWithManyFiles();
        const occupied = yield* makeTmpDir("git-worktrees-");
        yield* writeTextFile(path.join(occupied, "keep.txt"), "mine\n");
        const realGitCore = yield* GitCore;
        const started = yield* Deferred.make<void>();
        const core = yield* makeGitCoreWithSettings({}, (input) =>
          input.operation === "GitCore.createWorktree"
            ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
            : realGitCore.execute(input),
        );

        const creating = yield* core
          .createWorktree({ cwd: tmp, branch: initialBranch, newBranch: "stopped", path: occupied })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(started);
        yield* Fiber.interrupt(creating);

        expect(Exit.hasInterrupts(yield* Fiber.await(creating))).toBe(true);
        expect(readFileSync(path.join(occupied, "keep.txt"), "utf8")).toBe("mine\n");
        expect(yield* git(tmp, ["branch", "--list", "stopped"])).toBe("");
      }),
    );

    it.effect("an add interrupted while queued leaves the running add of that branch alone", () =>
      Effect.gen(function* () {
        const { tmp, initialBranch } = yield* makeRepoWithManyFiles();
        const root = yield* makeTmpDir("git-worktrees-");
        const realGitCore = yield* GitCore;
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const secondNearLock = yield* Deferred.make<void>();
        let workerReads = 0;
        let addCount = 0;
        const core = yield* makeGitCoreWithSettings({}, (input) => {
          if (input.operation !== "GitCore.createWorktree") {
            // The last git call before the branch lock.
            return realGitCore.execute(input).pipe(
              Effect.tap(() => {
                if (!input.args.includes("checkout.workers")) return Effect.void;
                workerReads += 1;
                return workerReads === 2
                  ? Deferred.succeed(secondNearLock, undefined)
                  : Effect.void;
              }),
            );
          }
          // Counted when it runs: GitCore builds this effect before taking the lock.
          return Effect.suspend(() => {
            addCount += 1;
            return Deferred.succeed(firstStarted, undefined);
          }).pipe(
            Effect.andThen(Deferred.await(releaseFirst)),
            Effect.andThen(realGitCore.execute(input)),
          );
        });
        const create = (name: string) =>
          core
            .createWorktree({
              cwd: tmp,
              branch: initialBranch,
              newBranch: "shared-branch",
              path: path.join(root, name),
            })
            .pipe(Effect.forkChild({ startImmediately: true }));

        const first = yield* create("first");
        yield* Deferred.await(firstStarted);
        const queued = yield* create("queued");
        yield* Deferred.await(secondNearLock);
        // Live time, so the second add settles into its wait on the lock.
        yield* TestClock.withLive(Effect.sleep("50 millis"));
        yield* Fiber.interrupt(queued);
        yield* Deferred.succeed(releaseFirst, undefined);
        const result = yield* Fiber.join(first);

        expect(addCount).toBe(1);
        expect(result.worktree.branch).toBe("shared-branch");
        expect(yield* git(result.worktree.path, ["branch", "--show-current"])).toBe(
          "shared-branch",
        );
        expect(existsSync(path.join(root, "queued"))).toBe(false);
      }),
    );

    it.effect("caps the generated folder name for long branch names", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(tmp);
        const core = yield* GitCore;
        const longBranch = `dependabot/npm_and_yarn/${"very-long-package-name-".repeat(4)}1.2.3`;

        const result = yield* core.createWorktree({
          cwd: tmp,
          branch: initialBranch,
          newBranch: longBranch,
          path: null,
        });

        const folder = path.basename(result.worktree.path);
        expect(folder.length).toBeLessThanOrEqual(40);
        expect(folder).toMatch(/^dependabot-npm_and_yarn-[0-9a-f]{16}$/);
        expect(result.worktree.branch).toBe(longBranch);
        yield* core.removeWorktree({ cwd: tmp, path: result.worktree.path, force: true });
      }),
    );

    it.effect("listGitBranches from worktree cwd reports worktree branch as current", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);

        const wtPath = path.join(tmp, "wt-list-dir");
        const mainBranch = (yield* (yield* GitCore).listBranches({ cwd: tmp })).branches.find(
          (b) => b.current,
        )!.name;

        yield* (yield* GitCore).createWorktree({
          cwd: tmp,
          branch: mainBranch,
          newBranch: "wt-list",
          path: wtPath,
        });

        // listGitBranches from the worktree should show wt-list as current
        const wtBranches = yield* (yield* GitCore).listBranches({ cwd: wtPath });
        expect(wtBranches.isRepo).toBe(true);
        const wtCurrent = wtBranches.branches.find((b) => b.current);
        expect(wtCurrent!.name).toBe("wt-list");

        // Main repo should still show the original branch as current
        const mainBranches = yield* (yield* GitCore).listBranches({ cwd: tmp });
        const mainCurrent = mainBranches.branches.find((b) => b.current);
        expect(mainCurrent!.name).toBe(mainBranch);

        yield* (yield* GitCore).removeWorktree({ cwd: tmp, path: wtPath });
      }),
    );

    it.effect("flattens a placeholder branch when a plain piedpiper branch exists", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(tmp);
        yield* git(tmp, ["branch", "piedpiper"]);
        const wtPath = path.join(tmp, "wt-flat");

        const result = yield* (yield* GitCore).createWorktree({
          cwd: tmp,
          branch: initialBranch,
          newBranch: "piedpiper/0123abcd",
          path: wtPath,
        });

        expect(result.worktree.branch).toBe("piedpiper-0123abcd");
        expect(yield* git(wtPath, ["branch", "--show-current"])).toBe("piedpiper-0123abcd");
      }),
    );

    it.effect("treats a worktree deleted outside the app as removed and prunes it", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(tmp);
        const core = yield* GitCore;
        const wtPath = path.join(tmp, "wt-gone");
        yield* core.createWorktree({
          cwd: tmp,
          branch: initialBranch,
          newBranch: "wt-gone",
          path: wtPath,
        });
        yield* (yield* FileSystem.FileSystem).remove(wtPath, { recursive: true });
        yield* git(tmp, ["worktree", "prune"]);

        yield* core.removeWorktree({ cwd: tmp, path: wtPath });

        expect(yield* git(tmp, ["worktree", "list", "--porcelain"])).not.toContain("wt-gone");
      }),
    );

    it.effect("prunes a stale registration when git cannot remove a deleted worktree", () =>
      Effect.gen(function* () {
        const calls: Array<{ args: ReadonlyArray<string>; timeoutMs?: number | null }> = [];
        const core = yield* makeIsolatedGitCore((input) => {
          calls.push({
            args: input.args,
            ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
          });
          const removing = input.args.includes("remove");
          return Effect.succeed({
            code: removing ? 128 : 0,
            stdout: "",
            stderr: removing ? "fatal: cannot remove working tree: validation failed\n" : "",
            stdoutTruncated: false,
            stderrTruncated: false,
          });
        });

        yield* core.removeWorktree({ cwd: "/repo", path: "/repo-missing-worktree" });

        expect(calls.find((call) => call.args.includes("remove"))?.timeoutMs).toBe(300_000);
        expect(calls.at(-1)?.args).toEqual(["worktree", "prune"]);
      }),
    );

    it.effect("gives worktree add a long timeout", () =>
      Effect.gen(function* () {
        let addTimeout: number | null | undefined;
        const core = yield* makeIsolatedGitCore((input) => {
          if (input.args.includes("worktree")) addTimeout = input.timeoutMs;
          return Effect.succeed({
            code: 0,
            stdout: "",
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          });
        });

        yield* core.createWorktree({ cwd: "/repo", branch: "main", path: "/wt" });

        expect(addTimeout).toBe(30 * 60_000);
      }),
    );

    it.effect("removeGitWorktree cleans up the worktree", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);

        const wtPath = path.join(tmp, "wt-remove-dir");
        const currentBranch = (yield* (yield* GitCore).listBranches({ cwd: tmp })).branches.find(
          (b) => b.current,
        )!.name;

        yield* (yield* GitCore).createWorktree({
          cwd: tmp,
          branch: currentBranch,
          newBranch: "wt-remove",
          path: wtPath,
        });
        expect(existsSync(wtPath)).toBe(true);

        yield* (yield* GitCore).removeWorktree({ cwd: tmp, path: wtPath });
        expect(existsSync(wtPath)).toBe(false);
      }),
    );

    it.effect.each(["win32", "linux"] as const)(
      "force-removes a worktree without deleting what its links point to (%s path)",
      (platform) =>
        Effect.gen(function* () {
          const tmp = yield* makeTmpDir();
          const { initialBranch } = yield* initRepoWithCommit(tmp);
          yield* writeTextFile(path.join(tmp, ".gitignore"), "node_modules\n");
          yield* git(tmp, ["add", ".gitignore"]);
          yield* git(tmp, ["commit", "-m", "ignore node_modules"]);
          const outside = yield* makeTmpDir("git-worktree-link-target-");
          yield* writeTextFile(path.join(outside, "keep.txt"), "keep\n");
          const worktreesDir = yield* makeTmpDir("git-worktrees-");
          const wtPath = path.join(worktreesDir, "linked");
          const core = yield* makeGitCore({ platform }).pipe(Effect.provide(ServerConfigLayer));
          yield* core.createWorktree({
            cwd: tmp,
            branch: initialBranch,
            newBranch: "feature/linked",
            path: wtPath,
          });
          // Junctions on Windows (the way pnpm links packages); symlinks elsewhere.
          mkdirSync(path.join(wtPath, "node_modules"));
          symlinkSync(outside, path.join(wtPath, "node_modules", "dep"), "junction");
          symlinkSync(outside, path.join(wtPath, "shared"), "junction");

          yield* core.removeWorktree({ cwd: tmp, path: wtPath, force: true });

          expect(readdirSync(worktreesDir)).toEqual([]);
          expect(readFileSync(path.join(outside, "keep.txt"), "utf8")).toBe("keep\n");
          expect(yield* git(tmp, ["worktree", "list", "--porcelain"])).not.toContain("linked");
        }),
    );

    it.effect("keeps a dirty worktree and its links when the Windows removal is not forced", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(tmp);
        yield* writeTextFile(path.join(tmp, ".gitignore"), "node_modules\n");
        yield* git(tmp, ["add", ".gitignore"]);
        yield* git(tmp, ["commit", "-m", "ignore node_modules"]);
        const outside = yield* makeTmpDir("git-worktree-link-target-");
        const worktreesDir = yield* makeTmpDir("git-worktrees-");
        const wtPath = path.join(worktreesDir, "linked");
        const core = yield* makeGitCore({ platform: "win32" }).pipe(
          Effect.provide(ServerConfigLayer),
        );
        yield* core.createWorktree({
          cwd: tmp,
          branch: initialBranch,
          newBranch: "feature/linked",
          path: wtPath,
        });
        const link = path.join(wtPath, "node_modules");
        symlinkSync(outside, link, "junction");
        yield* writeTextFile(path.join(wtPath, "notes.txt"), "draft\n");

        const result = yield* Effect.result(core.removeWorktree({ cwd: tmp, path: wtPath }));

        expect(result._tag).toBe("Failure");
        expect(lstatSync(link).isSymbolicLink()).toBe(true);
        expect(readdirSync(worktreesDir)).toEqual(["linked"]);
      }),
    );

    it.effect.skipIf(process.platform === "win32")(
      "removes a worktree on the Windows path from a symlinked subdirectory cwd beside a decoy repo",
      () =>
        Effect.gen(function* () {
          const sandbox = yield* makeTmpDir("git-symlink-remove-");
          yield* initRepoWithCommit(sandbox);
          const repo = path.join(sandbox, "repo");
          const subdir = path.join(repo, "sub", "dir");
          const link = path.join(sandbox, "nest", "link");
          mkdirSync(subdir, { recursive: true });
          mkdirSync(path.dirname(link), { recursive: true });
          symlinkSync(subdir, link);
          const { initialBranch } = yield* initRepoWithCommit(repo);
          const wtPath = path.join(yield* makeTmpDir("git-worktrees-"), "linked");
          const core = yield* makeGitCore({ platform: "win32" }).pipe(
            Effect.provide(ServerConfigLayer),
          );
          yield* core.createWorktree({
            cwd: repo,
            branch: initialBranch,
            newBranch: "feature/symlinked-cwd",
            path: wtPath,
          });

          // Git reports ../../.git from the real subdir; resolving it from the link hits the decoy.
          yield* core.removeWorktree({ cwd: link, path: wtPath, force: true });

          expect(existsSync(wtPath)).toBe(false);
          expect(yield* git(repo, ["worktree", "list", "--porcelain"])).not.toContain(wtPath);
        }),
    );

    it.effect("refuses to remove a locked worktree on the Windows path", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(tmp);
        const worktreesDir = yield* makeTmpDir("git-worktrees-");
        const wtPath = path.join(worktreesDir, "linked");
        const core = yield* makeGitCore({ platform: "win32" }).pipe(
          Effect.provide(ServerConfigLayer),
        );
        yield* core.createWorktree({
          cwd: tmp,
          branch: initialBranch,
          newBranch: "feature/locked",
          path: wtPath,
        });
        yield* git(tmp, ["worktree", "lock", "--reason", "in use", wtPath]);

        const result = yield* Effect.result(
          core.removeWorktree({ cwd: tmp, path: wtPath, force: true }),
        );

        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          expect(result.failure.message).toContain("lock reason: in use");
        }
        expect(existsSync(path.join(wtPath, ".git"))).toBe(true);
      }),
    );

    it.effect("removeGitWorktree force removes a dirty worktree", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);

        const wtPath = path.join(tmp, "wt-dirty-dir");
        const currentBranch = (yield* (yield* GitCore).listBranches({ cwd: tmp })).branches.find(
          (b) => b.current,
        )!.name;

        yield* (yield* GitCore).createWorktree({
          cwd: tmp,
          branch: currentBranch,
          newBranch: "wt-dirty",
          path: wtPath,
        });
        expect(existsSync(wtPath)).toBe(true);

        yield* writeTextFile(path.join(wtPath, "README.md"), "dirty change\n");

        const failedRemove = yield* Effect.result(
          (yield* GitCore).removeWorktree({ cwd: tmp, path: wtPath }),
        );
        expect(failedRemove._tag).toBe("Failure");
        expect(existsSync(wtPath)).toBe(true);

        yield* (yield* GitCore).removeWorktree({ cwd: tmp, path: wtPath, force: true });
        expect(existsSync(wtPath)).toBe(false);
      }),
    );
  });

  // ── Full flow: local branch checkout ──

  describe("full flow: local branch checkout", () => {
    it.effect("init → commit → create branch → checkout → verify current", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "feature-login" });
        yield* (yield* GitCore).checkoutBranch({ cwd: tmp, branch: "feature-login" });

        const result = yield* (yield* GitCore).listBranches({ cwd: tmp });
        const current = result.branches.find((b) => b.current);
        expect(current!.name).toBe("feature-login");
      }),
    );
  });

  // ── Full flow: worktree creation from base branch ──

  describe("full flow: worktree creation", () => {
    it.effect("creates worktree with new branch from current branch", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);

        const currentBranch = (yield* (yield* GitCore).listBranches({ cwd: tmp })).branches.find(
          (b) => b.current,
        )!.name;

        const wtPath = path.join(tmp, "my-worktree");
        const result = yield* (yield* GitCore).createWorktree({
          cwd: tmp,
          branch: currentBranch,
          newBranch: "feature-wt",
          path: wtPath,
        });

        // Worktree exists
        expect(existsSync(result.worktree.path)).toBe(true);

        // Main repo still on original branch
        const mainBranches = yield* (yield* GitCore).listBranches({ cwd: tmp });
        const mainCurrent = mainBranches.branches.find((b) => b.current);
        expect(mainCurrent!.name).toBe(currentBranch);

        // Worktree is on the new branch
        const wtBranch = yield* git(wtPath, ["branch", "--show-current"]);
        expect(wtBranch).toBe("feature-wt");

        yield* (yield* GitCore).removeWorktree({ cwd: tmp, path: wtPath });
      }),
    );
  });

  describe("fetchPullRequestBranch", () => {
    it.effect("fetches a GitHub pull request ref into a local branch without checkout", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(tmp);
        const remoteDir = yield* makeTmpDir("git-remote-");
        yield* git(remoteDir, ["init", "--bare"]);
        yield* git(tmp, ["remote", "add", "origin", remoteDir]);
        yield* git(tmp, ["push", "-u", "origin", initialBranch]);
        yield* git(tmp, ["checkout", "-b", "feature/pr-fetch"]);
        yield* writeTextFile(path.join(tmp, "pr-fetch.txt"), "fetch me\n");
        yield* git(tmp, ["add", "pr-fetch.txt"]);
        yield* git(tmp, ["commit", "-m", "Add PR fetch branch"]);
        yield* git(tmp, ["push", "-u", "origin", "feature/pr-fetch"]);
        yield* git(tmp, ["push", "origin", "HEAD:refs/pull/55/head"]);
        yield* git(tmp, ["checkout", initialBranch]);

        yield* (yield* GitCore).fetchPullRequestBranch({
          cwd: tmp,
          prNumber: 55,
          branch: "feature/pr-fetch",
        });

        const localBranches = yield* git(tmp, ["branch", "--list", "feature/pr-fetch"]);
        expect(localBranches).toContain("feature/pr-fetch");
        const currentBranch = yield* git(tmp, ["branch", "--show-current"]);
        expect(currentBranch).toBe(initialBranch);
      }),
    );
  });

  // ── Full flow: thread switching simulation ──

  describe("full flow: thread switching (checkout toggling)", () => {
    it.effect("checkout a → checkout b → checkout a → current matches", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "branch-a" });
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "branch-b" });

        // Simulate switching to thread A's branch
        yield* (yield* GitCore).checkoutBranch({ cwd: tmp, branch: "branch-a" });
        let branches = yield* (yield* GitCore).listBranches({ cwd: tmp });
        expect(branches.branches.find((b) => b.current)!.name).toBe("branch-a");

        // Simulate switching to thread B's branch
        yield* (yield* GitCore).checkoutBranch({ cwd: tmp, branch: "branch-b" });
        branches = yield* (yield* GitCore).listBranches({ cwd: tmp });
        expect(branches.branches.find((b) => b.current)!.name).toBe("branch-b");

        // Switch back to thread A
        yield* (yield* GitCore).checkoutBranch({ cwd: tmp, branch: "branch-a" });
        branches = yield* (yield* GitCore).listBranches({ cwd: tmp });
        expect(branches.branches.find((b) => b.current)!.name).toBe("branch-a");
      }),
    );
  });

  // ── Full flow: checkout conflict ──

  describe("full flow: checkout conflict", () => {
    it.effect("uncommitted changes prevent checkout to a diverged branch", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "diverged" });

        // Make diverged branch have different file content
        yield* (yield* GitCore).checkoutBranch({ cwd: tmp, branch: "diverged" });
        yield* writeTextFile(path.join(tmp, "README.md"), "diverged content\n");
        yield* git(tmp, ["add", "."]);
        yield* git(tmp, ["commit", "-m", "diverge"]);

        // Actually, let's just get back to the initial branch explicitly
        const allBranches = yield* (yield* GitCore).listBranches({ cwd: tmp });
        const initialBranch = allBranches.branches.find((b) => b.name !== "diverged")!.name;
        yield* (yield* GitCore).checkoutBranch({ cwd: tmp, branch: initialBranch });

        // Make local uncommitted changes to the same file
        yield* writeTextFile(path.join(tmp, "README.md"), "local uncommitted\n");

        // Attempt checkout should fail
        const failedCheckout = yield* Effect.result(
          (yield* GitCore).checkoutBranch({ cwd: tmp, branch: "diverged" }),
        );
        expect(failedCheckout._tag).toBe("Failure");

        // Current branch should still be the initial one
        const result = yield* (yield* GitCore).listBranches({ cwd: tmp });
        expect(result.branches.find((b) => b.current)!.name).toBe(initialBranch);
      }),
    );
  });

  describe("GitCore", () => {
    it.effect("supports branch lifecycle operations through the service API", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const core = yield* GitCore;

        yield* core.initRepo({ cwd: tmp });
        yield* git(tmp, ["config", "user.email", "test@test.com"]);
        yield* git(tmp, ["config", "user.name", "Test"]);
        yield* writeTextFile(path.join(tmp, "README.md"), "# test\n");
        yield* git(tmp, ["add", "."]);
        yield* git(tmp, ["commit", "-m", "initial commit"]);

        yield* core.createBranch({ cwd: tmp, branch: "feature/service-api" });
        yield* core.checkoutBranch({ cwd: tmp, branch: "feature/service-api" });
        const branches = yield* core.listBranches({ cwd: tmp });

        expect(branches.isRepo).toBe(true);
        expect(
          branches.branches.find((branch: { current: boolean; name: string }) => branch.current)
            ?.name,
        ).toBe("feature/service-api");
      }),
    );

    it.effect(
      "reuses an existing remote when the target URL only differs by a trailing slash after .git",
      () =>
        Effect.gen(function* () {
          const tmp = yield* makeTmpDir();
          yield* initRepoWithCommit(tmp);
          const core = yield* GitCore;

          yield* git(tmp, ["remote", "add", "origin", "git@github.com:user/repo.git"]);

          const remoteName = yield* core.ensureRemote({
            cwd: tmp,
            preferredName: "origin",
            url: "git@github.com:user/repo.git/",
          });

          expect(remoteName).toBe("origin");
          expect((yield* git(tmp, ["remote"])).split("\n").filter(Boolean)).toEqual(["origin"]);
        }),
    );

    it.effect("does not read a remote url as an option when adding a remote", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const core = yield* GitCore;

        const remoteName = yield* core.ensureRemote({
          cwd: tmp,
          preferredName: "fork",
          url: "--tags",
        });

        expect(remoteName).toBe("fork");
        expect(yield* git(tmp, ["config", "--get", "remote.fork.url"])).toBe("--tags");
      }),
    );

    it.effect("reuses an existing remote when only ssh and https differ", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const core = yield* GitCore;
        yield* git(tmp, ["remote", "add", "origin", "https://github.com/Acme/App.git"]);

        for (const url of [
          "git@github.com:acme/app.git",
          "ssh://git@github.com/acme/app",
          "ssh://git@github.com:22/acme/app.git",
          "ssh://git@ssh.github.com:443/acme/app.git",
        ]) {
          expect(yield* core.ensureRemote({ cwd: tmp, preferredName: "acme", url })).toBe("origin");
        }

        expect(
          yield* core.ensureRemote({
            cwd: tmp,
            preferredName: "octocat",
            url: "git@github.com:octocat/app.git",
          }),
        ).toBe("octocat");
        expect((yield* git(tmp, ["remote"])).split("\n").filter(Boolean).toSorted()).toEqual([
          "octocat",
          "origin",
        ]);
      }),
    );

    it.effect("does not open a project folder laid out as a bare repository", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const core = yield* GitCore;
        const fileSystem = yield* FileSystem.FileSystem;
        // Plain files a project save or a clone can hold; git discovers them as a bare repository.
        const planted = path.join(tmp, "planted");
        yield* fileSystem.makeDirectory(path.join(planted, "objects", "info"), {
          recursive: true,
        });
        yield* fileSystem.makeDirectory(path.join(planted, "refs", "heads"), { recursive: true });
        yield* writeTextFile(path.join(planted, "HEAD"), "ref: refs/heads/main\n");
        yield* writeTextFile(
          path.join(planted, "config"),
          '[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tworktree = .\n\tfsmonitor = "echo ran >> fsmonitor-runs; false"\n',
        );

        const status = yield* Effect.exit(core.statusDetails(planted));
        expect(Exit.isFailure(status)).toBe(true);
        expect(existsSync(path.join(planted, "fsmonitor-runs"))).toBe(false);

        const branches = yield* core.listBranches({ cwd: planted });
        expect(branches.isRepo).toBe(false);
        expect((yield* core.statusDetails(tmp)).isRepo).toBe(true);
      }),
    );

    describe("unpublished branch ahead count", () => {
      const commitFile = (cwd: string, name: string) =>
        Effect.gen(function* () {
          yield* writeTextFile(path.join(cwd, name), `${name}\n`);
          yield* git(cwd, ["add", name]);
          yield* git(cwd, ["commit", "-m", `add ${name}`]);
        });

      it.effect("compares against the remote base when the local base is stale", () =>
        Effect.gen(function* () {
          const tmp = yield* makeTmpDir();
          const remote = yield* makeTmpDir();
          yield* git(remote, ["init", "--bare"]);
          yield* initRepoWithCommit(tmp);
          yield* git(tmp, ["branch", "-M", "main"]);
          yield* git(tmp, ["remote", "add", "origin", remote]);
          const stale = yield* git(tmp, ["rev-parse", "HEAD"]);
          yield* commitFile(tmp, "one.txt");
          yield* commitFile(tmp, "two.txt");
          yield* git(tmp, ["push", "origin", "main"]);
          yield* git(tmp, ["checkout", "-b", "feature/stale-base"]);
          yield* commitFile(tmp, "feature.txt");
          yield* git(tmp, ["branch", "-f", "main", stale]);

          const details = yield* (yield* GitCore).statusDetails(tmp);
          expect(details.hasUpstream).toBe(false);
          expect(details.aheadCount).toBe(1);
        }),
      );

      it.effect("is not misled by tags sharing a base branch's name", () =>
        Effect.gen(function* () {
          const tmp = yield* makeTmpDir();
          yield* initRepoWithCommit(tmp);
          yield* git(tmp, ["branch", "-M", "main"]);
          yield* git(tmp, ["update-ref", "refs/tags/main", "HEAD"]);
          yield* commitFile(tmp, "base.txt");
          yield* git(tmp, ["checkout", "-b", "feature/tagged-base"]);
          yield* commitFile(tmp, "feature.txt");
          const core = yield* GitCore;

          expect((yield* core.statusDetails(tmp)).aheadCount).toBe(1);

          const remote = yield* makeTmpDir();
          yield* git(remote, ["init", "--bare"]);
          yield* git(tmp, ["remote", "add", "origin", remote]);
          yield* git(tmp, ["push", "origin", "refs/heads/main:refs/heads/main"]);
          yield* git(tmp, ["update-ref", "refs/tags/origin/main", "refs/heads/main~1"]);

          expect((yield* core.statusDetails(tmp)).aheadCount).toBe(1);
        }),
      );

      it.effect("honours a remote-qualified base even when a local branch shadows it", () =>
        Effect.gen(function* () {
          const tmp = yield* makeTmpDir();
          const fork = yield* makeTmpDir();
          const upstream = yield* makeTmpDir();
          yield* git(fork, ["init", "--bare"]);
          yield* git(upstream, ["init", "--bare"]);
          yield* initRepoWithCommit(tmp);
          yield* git(tmp, ["branch", "-M", "main"]);
          yield* git(tmp, ["remote", "add", "origin", fork]);
          yield* git(tmp, ["remote", "add", "upstream", upstream]);
          yield* git(tmp, ["push", "origin", "main"]);
          yield* commitFile(tmp, "upstream.txt");
          yield* git(tmp, ["push", "upstream", "main"]);
          yield* git(tmp, ["checkout", "-b", "feature/qualified"]);
          yield* commitFile(tmp, "feature.txt");
          yield* git(tmp, ["config", "branch.feature/qualified.gh-merge-base", "upstream/main"]);
          const core = yield* GitCore;

          expect((yield* core.statusDetails(tmp)).aheadCount).toBe(1);

          yield* git(tmp, ["update-ref", "refs/heads/upstream/main", "HEAD~2"]);
          expect((yield* core.statusDetails(tmp)).aheadCount).toBe(1);
          yield* git(tmp, ["update-ref", "-d", "refs/heads/upstream/main"]);

          // A base naming this branch's own remote copy, or a missing ref, falls back to the default.
          for (const missing of ["upstream/missing", "origin/feature/qualified"]) {
            yield* git(tmp, ["config", "branch.feature/qualified.gh-merge-base", missing]);
            expect((yield* core.statusDetails(tmp)).aheadCount).toBe(2);
          }
        }),
      );

      it.effect("follows a fork's main that tracks the upstream remote", () =>
        Effect.gen(function* () {
          const tmp = yield* makeTmpDir();
          const fork = yield* makeTmpDir();
          const upstream = yield* makeTmpDir();
          yield* git(fork, ["init", "--bare"]);
          yield* git(upstream, ["init", "--bare"]);
          yield* initRepoWithCommit(tmp);
          yield* git(tmp, ["branch", "-M", "main"]);
          yield* git(tmp, ["remote", "add", "origin", fork]);
          yield* git(tmp, ["remote", "add", "upstream", upstream]);
          yield* git(tmp, ["push", "origin", "main"]);
          yield* commitFile(tmp, "one.txt");
          yield* commitFile(tmp, "two.txt");
          yield* git(tmp, ["push", "-u", "upstream", "main"]);
          yield* git(tmp, ["checkout", "-b", "feature/fork"]);
          yield* commitFile(tmp, "feature.txt");

          expect((yield* (yield* GitCore).statusDetails(tmp)).aheadCount).toBe(1);
        }),
      );

      it.effect("publishes over a behind remote branch and skips one containing HEAD", () =>
        Effect.gen(function* () {
          const tmp = yield* makeTmpDir();
          const remote = yield* makeTmpDir();
          const upstream = yield* makeTmpDir();
          yield* git(remote, ["init", "--bare"]);
          yield* git(upstream, ["init", "--bare"]);
          yield* initRepoWithCommit(tmp);
          yield* git(tmp, ["branch", "-M", "main"]);
          yield* git(tmp, ["remote", "add", "origin", remote]);
          yield* git(tmp, ["remote", "add", "upstream", upstream]);
          yield* git(tmp, ["push", "origin", "main", "main:refs/heads/feature/push"]);
          yield* git(tmp, ["checkout", "--no-track", "-b", "feature/push"]);
          yield* commitFile(tmp, "feature.txt");
          yield* git(tmp, ["push", "upstream", "HEAD:refs/heads/main"]);
          yield* git(tmp, ["config", "branch.feature/push.gh-merge-base", "upstream/main"]);
          const core = yield* GitCore;
          const head = yield* git(tmp, ["rev-parse", "HEAD"]);
          const remoteBranch = () =>
            git(remote, ["--git-dir=.", "rev-parse", "refs/heads/feature/push"]);

          const details = yield* core.statusDetails(tmp);
          expect(details.hasUpstream).toBe(false);
          expect(details.aheadCount).toBe(0);
          expect(yield* remoteBranch()).not.toBe(head);

          const pushed = yield* core.pushCurrentBranch(tmp, null);
          expect(pushed.status).toBe("pushed");
          expect(yield* remoteBranch()).toBe(head);

          yield* git(tmp, ["branch", "--unset-upstream"]);
          const upToDate = yield* core.pushCurrentBranch(tmp, null);
          expect(upToDate.status).toBe("skipped_up_to_date");

          yield* commitFile(tmp, "remote-only.txt");
          yield* git(tmp, ["push", "origin", "HEAD:refs/heads/feature/push"]);
          const published = yield* remoteBranch();
          yield* git(tmp, ["reset", "--hard", head]);
          const behindRemote = yield* core.pushCurrentBranch(tmp, null);
          expect(behindRemote.status).toBe("skipped_up_to_date");
          expect(yield* remoteBranch()).toBe(published);
        }),
      );
    });

    it.effect("pushes to the upstream branch when a remote tag shares its name", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const remote = yield* makeTmpDir();
        yield* git(remote, ["init", "--bare"]);
        yield* initRepoWithCommit(tmp);
        yield* git(tmp, ["remote", "add", "origin", remote]);
        yield* git(tmp, ["checkout", "-b", "feature"]);
        yield* git(tmp, ["push", "-u", "origin", "feature"]);
        yield* git(tmp, ["push", "origin", "HEAD:refs/tags/feature"]);
        yield* writeTextFile(path.join(tmp, "feature.txt"), "feature\n");
        yield* git(tmp, ["add", "feature.txt"]);
        yield* git(tmp, ["commit", "-m", "feature"]);

        const pushed = yield* (yield* GitCore).pushCurrentBranch(tmp, null);

        expect(pushed.status).toBe("pushed");
        expect(yield* git(remote, ["--git-dir=.", "rev-parse", "refs/heads/feature"])).toBe(
          yield* git(tmp, ["rev-parse", "HEAD"]),
        );
      }),
    );

    it.effect("does not read a remote name as an option", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const remote = yield* makeTmpDir();
        yield* git(remote, ["init", "--bare"]);
        yield* initRepoWithCommit(tmp);
        // `git remote add` refuses such a name, but a hand-written config can hold one.
        yield* git(tmp, ["config", "remote.--dry-run.url", remote]);
        yield* git(tmp, ["config", "remote.--dry-run.fetch", "+refs/heads/*:refs/remotes/dry/*"]);
        yield* git(tmp, ["checkout", "-b", "feature/option"]);
        yield* writeTextFile(path.join(tmp, "feature.txt"), "feature\n");
        yield* git(tmp, ["add", "feature.txt"]);
        yield* git(tmp, ["commit", "-m", "feature"]);
        const core = yield* GitCore;

        const pushed = yield* core.pushCurrentBranch(tmp, null);
        expect(pushed.status).toBe("pushed");
        expect(yield* git(remote, ["--git-dir=.", "rev-parse", "refs/heads/feature/option"])).toBe(
          yield* git(tmp, ["rev-parse", "HEAD"]),
        );

        yield* core.fetchRemoteBranch({
          cwd: tmp,
          remoteName: "--dry-run",
          remoteBranch: "feature/option",
          localBranch: "fetched",
        });
        expect(yield* git(tmp, ["rev-parse", "fetched"])).toBe(
          yield* git(tmp, ["rev-parse", "HEAD"]),
        );
      }),
    );

    it.effect("reports status details and dirty state", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const core = yield* GitCore;

        const clean = yield* core.status({ cwd: tmp });
        expect(clean.hasWorkingTreeChanges).toBe(false);
        expect(clean.branch).toBeTruthy();

        yield* writeTextFile(path.join(tmp, "README.md"), "updated\n");
        const dirty = yield* core.statusDetails(tmp);
        expect(dirty.hasWorkingTreeChanges).toBe(true);
      }),
    );

    it.effect("reports staged and unstaged numstat on a repo without commits", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const core = yield* GitCore;
        yield* core.initRepo({ cwd: tmp });
        yield* writeTextFile(path.join(tmp, "staged.txt"), "one\ntwo\n");
        yield* writeTextFile(path.join(tmp, "unstaged.txt"), "three\n");
        yield* git(tmp, ["add", "staged.txt"]);

        const details = yield* core.statusDetails(tmp);

        expect(details.isRepo).toBe(true);
        expect(details.hasWorkingTreeChanges).toBe(true);
        expect(details.workingTree.files).toEqual([
          { path: "staged.txt", insertions: 2, deletions: 0 },
          { path: "unstaged.txt", insertions: 0, deletions: 0 },
        ]);
      }),
    );

    it.effect("statusDetails leaves the index untouched for stat-dirty files", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const fileSystem = yield* FileSystem.FileSystem;
        const old = new Date("2001-01-01T00:00:00Z");
        yield* fileSystem.utimes(path.join(tmp, "README.md"), old, old);
        const indexPath = path.join(tmp, ".git", "index");
        const indexBefore = yield* fileSystem.readFile(indexPath);

        const details = yield* (yield* GitCore).statusDetails(tmp);

        expect(details.workingTree.files).toEqual([]);
        expect(yield* fileSystem.readFile(indexPath)).toEqual(indexBefore);
        expect(yield* fileSystem.exists(`${indexPath}.lock`)).toBe(false);
      }),
    );

    it.effect("reports staged renames inside a shared directory by both paths", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* (yield* FileSystem.FileSystem).makeDirectory(path.join(tmp, "dir"));
        yield* writeTextFile(path.join(tmp, "dir", "a.txt"), "alpha\n");
        yield* git(tmp, ["add", "."]);
        yield* git(tmp, ["commit", "-m", "add dir"]);
        yield* git(tmp, ["mv", "dir/a.txt", "dir/b.txt"]);

        const details = yield* (yield* GitCore).statusDetails(tmp);

        expect(details.workingTree.files.map((file) => file.path)).toEqual([
          "dir/a.txt",
          "dir/b.txt",
        ]);
      }),
    );

    it.effect("counts a staged then re-edited line once", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* writeTextFile(path.join(tmp, "README.md"), "# staged\n");
        yield* git(tmp, ["add", "README.md"]);
        yield* writeTextFile(path.join(tmp, "README.md"), "# re-edited\n");

        const details = yield* (yield* GitCore).statusDetails(tmp);

        expect(details.workingTree.files).toEqual([
          { path: "README.md", insertions: 1, deletions: 1 },
        ]);
        expect(details.workingTree.insertions).toBe(1);
        expect(details.workingTree.deletions).toBe(1);
      }),
    );

    it.effect("fails fast while another process holds the index lock", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const lockPath = path.join(tmp, ".git", "index.lock");
        yield* writeTextFile(lockPath, "");

        const polling = { failWhenIndexLocked: true };
        const error = yield* Effect.flip((yield* GitCore).statusDetails(tmp, polling));
        expect(error.detail).toContain("Git index is locked");
        // Actions that already changed the repository still read status while it is locked.
        const duringLock = yield* (yield* GitCore).statusDetails(tmp);
        expect(duringLock.branch).not.toBeNull();

        yield* (yield* FileSystem.FileSystem).remove(lockPath);
        const details = yield* (yield* GitCore).statusDetails(tmp, polling);
        expect(details.isRepo).toBe(true);
      }),
    );

    it.effect.skipIf(process.platform === "win32")(
      "resolves the index through a symlinked subdirectory, not a decoy repo beside the link",
      () =>
        Effect.gen(function* () {
          const sandbox = yield* makeTmpDir("git-symlink-subdir-");
          yield* initRepoWithCommit(sandbox);
          const repo = path.join(sandbox, "repo");
          const subdir = path.join(repo, "sub", "dir");
          const link = path.join(sandbox, "nest", "link");
          mkdirSync(subdir, { recursive: true });
          mkdirSync(path.dirname(link), { recursive: true });
          symlinkSync(subdir, link);
          yield* initRepoWithCommit(repo);
          // Git reports ../../.git from the real subdir; resolving it from the link hits the decoy.
          yield* writeTextFile(path.join(sandbox, ".git", "index.lock"), "");

          const polling = { failWhenIndexLocked: true };
          const details = yield* (yield* GitCore).statusDetails(link, polling);
          expect(details.isRepo).toBe(true);

          yield* writeTextFile(path.join(repo, ".git", "index.lock"), "");
          const error = yield* Effect.flip((yield* GitCore).statusDetails(link, polling));
          expect(error.detail).toContain("Git index is locked");
        }),
    );

    it.effect("caches default branch and origin lookups until a remote changes", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const realGitCore = yield* GitCore;
        const operations: string[] = [];
        const core = yield* makeIsolatedGitCore((input) => {
          operations.push(input.operation);
          return realGitCore.execute(input);
        });
        const count = (operation: string) =>
          operations.filter((candidate) => candidate === operation).length;

        const first = yield* core.statusDetails(tmp);
        yield* core.statusDetails(tmp);
        expect(first.hasOriginRemote).toBe(false);
        expect(count("GitCore.statusDetails.numstat")).toBe(2);
        expect(count("GitCore.statusDetails.status")).toBe(2);
        expect(count("GitCore.statusDetails.defaultRef")).toBe(1);
        expect(count("GitCore.statusDetails.repositoryPaths")).toBe(1);

        const remote = yield* makeTmpDir();
        yield* core.ensureRemote({ cwd: tmp, preferredName: "origin", url: remote });
        const afterRemote = yield* core.statusDetails(tmp);
        expect(afterRemote.hasOriginRemote).toBe(true);
        expect(count("GitCore.statusDetails.defaultRef")).toBe(2);
      }),
    );

    it.effect("skips the default-ref and origin lookups for a non-repository folder", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const realGitCore = yield* GitCore;
        const operations: string[] = [];
        const core = yield* makeIsolatedGitCore((input) => {
          operations.push(input.operation);
          return realGitCore.execute(input);
        });

        yield* Effect.exit(core.statusDetails(tmp));
        yield* Effect.exit(core.statusDetails(tmp));
        expect(
          operations.filter((op) => op === "GitCore.statusDetails.repositoryPaths"),
        ).toHaveLength(2);
        expect(operations).not.toContain("GitCore.statusDetails.defaultRef");
        expect(operations).not.toContain("GitCore.anyRemoteExists");
      }),
    );

    it.effect("passes larger output caps to status and a truncating cap to pull", () =>
      Effect.gen(function* () {
        const seen = new Map<string, { maxOutputBytes?: number; truncate?: boolean }>();
        const ok = (stdout = "") =>
          Effect.succeed({
            code: 0,
            stdout,
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          });
        const core = yield* makeIsolatedGitCore((input) => {
          seen.set(input.operation, {
            ...(input.maxOutputBytes !== undefined ? { maxOutputBytes: input.maxOutputBytes } : {}),
            ...(input.truncateOutputAtMaxBytes !== undefined
              ? { truncate: input.truncateOutputAtMaxBytes }
              : {}),
          });
          if (input.operation === "GitCore.statusDetails.status") {
            return ok("# branch.head main\0# branch.upstream origin/main\0# branch.ab +0 -1\0");
          }
          if (input.args[0] === "rev-parse" && input.args[1] === "HEAD") {
            return ok("abc\n");
          }
          return ok();
        });

        yield* core.pullCurrentBranch("/repo");

        expect(seen.get("GitCore.statusDetails.status")?.maxOutputBytes).toBe(16 * 1024 * 1024);
        expect(seen.get("GitCore.statusDetails.numstat")?.maxOutputBytes).toBe(16 * 1024 * 1024);
        expect(seen.get("GitCore.pullCurrentBranch.pull")?.truncate).toBe(true);
      }),
    );

    it.effect("returns a non-repo status for deleted directories without failing", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const fileSystem = yield* FileSystem.FileSystem;
        const deletedDir = path.join(tmp, "deleted-repo");
        yield* fileSystem.makeDirectory(deletedDir, { recursive: true });
        yield* fileSystem.remove(deletedDir, { recursive: true });
        const core = yield* GitCore;

        const status = yield* core.statusDetails(deletedDir);

        expect(status).toEqual({
          isRepo: false,
          hasOriginRemote: false,
          isDefaultBranch: false,
          branch: null,
          upstreamRef: null,
          defaultBranch: null,
          hasWorkingTreeChanges: false,
          workingTree: { files: [], insertions: 0, deletions: 0 },
          hasUpstream: false,
          aheadCount: 0,
          behindCount: 0,
        });
      }),
    );

    it.effect.skipIf(process.platform === "win32")(
      "runs background upstream fetches non-interactively and without optional index locks",
      () =>
        Effect.gen(function* () {
          const tmp = yield* makeTmpDir();
          const { initialBranch } = yield* initRepoWithCommit(tmp);
          const fileSystem = yield* FileSystem.FileSystem;
          const helperDir = yield* makeTmpDir("git-ssh-env-");
          const logPath = path.join(helperDir, "ssh-env.txt");
          const wrapperPath = path.join(helperDir, "ssh-wrapper.sh");
          yield* writeTextFile(
            wrapperPath,
            [
              "#!/bin/sh",
              'printf "GCM_INTERACTIVE=%s\\n" "${GCM_INTERACTIVE:-}" > "$PIEDPIPER_TEST_SSH_ENV_LOG"',
              'printf "GIT_ASKPASS=%s\\n" "${GIT_ASKPASS:-}" >> "$PIEDPIPER_TEST_SSH_ENV_LOG"',
              'printf "GIT_OPTIONAL_LOCKS=%s\\n" "${GIT_OPTIONAL_LOCKS:-}" >> "$PIEDPIPER_TEST_SSH_ENV_LOG"',
              'printf "GIT_TERMINAL_PROMPT=%s\\n" "${GIT_TERMINAL_PROMPT:-}" >> "$PIEDPIPER_TEST_SSH_ENV_LOG"',
              'printf "SSH_ASKPASS=%s\\n" "${SSH_ASKPASS:-}" >> "$PIEDPIPER_TEST_SSH_ENV_LOG"',
              'printf "SSH_ASKPASS_REQUIRE=%s\\n" "${SSH_ASKPASS_REQUIRE:-}" >> "$PIEDPIPER_TEST_SSH_ENV_LOG"',
              "exit 1",
              "",
            ].join("\n"),
          );
          yield* fileSystem.chmod(wrapperPath, 0o755);
          yield* git(tmp, ["remote", "add", "origin", "git@example.invalid:example/repo.git"]);
          yield* git(tmp, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
          yield* git(tmp, ["branch", "--set-upstream-to=origin/main", initialBranch]);

          const envKeys = [
            "GCM_INTERACTIVE",
            "GIT_ASKPASS",
            "GIT_OPTIONAL_LOCKS",
            "GIT_SSH",
            "GIT_TERMINAL_PROMPT",
            "SSH_ASKPASS",
            "SSH_ASKPASS_REQUIRE",
            "PIEDPIPER_TEST_SSH_ENV_LOG",
          ] as const;
          const previousEnv = new Map(envKeys.map((key) => [key, process.env[key]]));

          yield* Effect.gen(function* () {
            process.env.GIT_SSH = wrapperPath;
            process.env.GCM_INTERACTIVE = "always";
            process.env.GIT_ASKPASS = "git-askpass";
            process.env.GIT_OPTIONAL_LOCKS = "1";
            process.env.GIT_TERMINAL_PROMPT = "1";
            process.env.SSH_ASKPASS = "ssh-askpass";
            process.env.SSH_ASKPASS_REQUIRE = "force";
            process.env.PIEDPIPER_TEST_SSH_ENV_LOG = logPath;

            const details = yield* (yield* GitCore).statusDetails(tmp);
            expect(details.isRepo).toBe(true);

            expect((yield* fileSystem.readFileString(logPath)).trim().split(/\r?\n/)).toEqual([
              "GCM_INTERACTIVE=never",
              "GIT_ASKPASS=",
              "GIT_OPTIONAL_LOCKS=0",
              "GIT_TERMINAL_PROMPT=0",
              "SSH_ASKPASS=",
              "SSH_ASKPASS_REQUIRE=never",
            ]);
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                for (const key of envKeys) {
                  const previous = previousEnv.get(key);
                  if (previous === undefined) {
                    delete process.env[key];
                  } else {
                    process.env[key] = previous;
                  }
                }
              }),
            ),
          );
        }),
    );

    it.effect.skipIf(process.platform === "win32")(
      "prepareCommitContext and readRangeContext ignore repo-configured diff drivers, colors and diff.relative",
      () =>
        Effect.gen(function* () {
          const tmp = yield* makeTmpDir();
          const { initialBranch } = yield* initRepoWithCommit(tmp);
          // A committed blank line becomes context, which diff.suppressBlankEmpty would print as "".
          yield* writeTextFile(path.join(tmp, "README.md"), "# test\n\nend\n");
          yield* git(tmp, ["commit", "-am", "add blank line"]);
          const fileSystem = yield* FileSystem.FileSystem;
          const helperDir = yield* makeTmpDir("git-ext-diff-");
          const externalDiffPath = path.join(helperDir, "external-diff.sh");
          yield* writeTextFile(externalDiffPath, '#!/bin/sh\nprintf "EXTERNAL-DIFF-RAN\\n"\n');
          yield* fileSystem.chmod(externalDiffPath, 0o755);
          const textconvMarker = path.join(helperDir, "textconv-ran");
          const textconvPath = path.join(helperDir, "textconv.sh");
          yield* writeTextFile(
            textconvPath,
            `#!/bin/sh\n: > "${textconvMarker}"\nprintf "converted\\n"\n`,
          );
          yield* fileSystem.chmod(textconvPath, 0o755);
          yield* git(tmp, ["config", "diff.external", externalDiffPath]);
          yield* git(tmp, ["config", "diff.probe.textconv", textconvPath]);
          yield* git(tmp, ["config", "color.ui", "always"]);
          yield* git(tmp, ["config", "diff.relative", "true"]);
          yield* git(tmp, ["config", "diff.noprefix", "true"]);
          yield* git(tmp, ["config", "diff.suppressBlankEmpty", "true"]);
          yield* writeTextFile(path.join(tmp, ".gitattributes"), "*.doc diff=probe\n");
          const core = yield* GitCore;
          // A subfolder project: diff.relative would hide every change outside it.
          const projectCwd = path.join(tmp, "app");
          mkdirSync(projectCwd);

          yield* writeTextFile(path.join(tmp, "README.md"), "# test\n\nchanged\n");
          yield* writeTextFile(path.join(tmp, "notes.doc"), "source line\n");
          const prepared = yield* core.prepareCommitContext(projectCwd);
          expect(prepared?.stagedSummary).toContain("README.md");
          expect(prepared?.stagedSummary).not.toContain("\u001b[");
          expect(prepared?.stagedPatch).toContain("+changed");
          expect(prepared?.stagedPatch).toContain("+source line");
          expect(prepared?.stagedPatch).not.toContain("EXTERNAL-DIFF-RAN");
          expect(prepared?.stagedPatch).not.toContain("converted");
          expect(prepared?.stagedPatch).not.toContain("\u001b[");
          expect(prepared?.stagedPatch).toContain("diff --git a/README.md b/README.md");
          expect(prepared?.stagedPatch).toContain(" # test\n \n-end\n");

          yield* git(tmp, ["add", "-A"]);
          yield* git(tmp, ["commit", "-m", "change readme"]);
          yield* git(tmp, ["branch", "base", "HEAD~1"]);
          const range = yield* core.readRangeContext(projectCwd, "base");
          expect(range.diffSummary).toContain("README.md");
          expect(range.commitSummary).toContain("change readme");
          for (const output of [range.commitSummary, range.diffSummary]) {
            expect(output).not.toContain("\u001b[");
          }
          expect(range.diffPatch).toContain("+changed");
          expect(range.diffPatch).toContain("+source line");
          expect(range.diffPatch).not.toContain("EXTERNAL-DIFF-RAN");
          expect(range.diffPatch).not.toContain("converted");
          expect(range.diffPatch).not.toContain("\u001b[");
          expect(range.diffPatch).toContain("diff --git a/README.md b/README.md");
          expect(range.diffPatch).toContain(" # test\n \n-end\n");
          expect(yield* fileSystem.exists(textconvMarker)).toBe(false);
          expect(initialBranch.length).toBeGreaterThan(0);
        }),
    );

    it.effect.skipIf(process.platform === "win32")(
      "prepareCommitContext never runs a repo-configured fsmonitor hook while staging",
      () =>
        Effect.gen(function* () {
          const tmp = yield* makeTmpDir();
          yield* initRepoWithCommit(tmp);
          const fileSystem = yield* FileSystem.FileSystem;
          const helperDir = yield* makeTmpDir("git-commit-fsmonitor-");
          const markerPath = path.join(helperDir, "fsmonitor-ran");
          const hookPath = path.join(helperDir, "fsmonitor.sh");
          yield* writeTextFile(hookPath, `#!/bin/sh\n: > "${markerPath}"\nprintf "/"\n`);
          yield* fileSystem.chmod(hookPath, 0o755);
          yield* git(tmp, ["config", "core.fsmonitor", hookPath]);
          const core = yield* GitCore;

          yield* writeTextFile(path.join(tmp, "README.md"), "# test\nchanged\n");
          yield* writeTextFile(path.join(tmp, "other.txt"), "other\n");
          const selected = yield* core.prepareCommitContext(tmp, ["README.md"]);
          expect(selected?.stagedPatch).toContain("+changed");
          expect(selected?.stagedPatch).not.toContain("other.txt");

          const all = yield* core.prepareCommitContext(tmp);
          expect(all?.stagedPatch).toContain("+other");
          expect(yield* fileSystem.exists(markerPath)).toBe(false);
        }),
    );

    it.effect("computes ahead count against base branch when no upstream is configured", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const core = yield* GitCore;

        yield* core.createBranch({ cwd: tmp, branch: "feature/no-upstream-ahead" });
        yield* core.checkoutBranch({ cwd: tmp, branch: "feature/no-upstream-ahead" });
        yield* writeTextFile(path.join(tmp, "feature.txt"), "ahead of base\n");
        yield* git(tmp, ["add", "feature.txt"]);
        yield* git(tmp, ["commit", "-m", "feature commit"]);

        const details = yield* core.statusDetails(tmp);
        expect(details.branch).toBe("feature/no-upstream-ahead");
        expect(details.hasUpstream).toBe(false);
        expect(details.aheadCount).toBe(1);
        expect(details.behindCount).toBe(0);
      }),
    );

    it.effect(
      "computes ahead count against origin/default when local default branch is missing",
      () =>
        Effect.gen(function* () {
          const remote = yield* makeTmpDir();
          const source = yield* makeTmpDir();
          yield* git(remote, ["init", "--bare"]);

          yield* initRepoWithCommit(source);
          const initialBranch = (yield* (yield* GitCore).listBranches({
            cwd: source,
          })).branches.find((branch) => branch.current)!.name;
          yield* git(source, ["remote", "add", "origin", remote]);
          yield* git(source, ["push", "-u", "origin", initialBranch]);
          yield* git(source, ["checkout", "-b", "feature/remote-base-only"]);
          yield* writeTextFile(
            path.join(source, "feature.txt"),
            `ahead of origin/${initialBranch}\n`,
          );
          yield* git(source, ["add", "feature.txt"]);
          yield* git(source, ["commit", "-m", "feature commit"]);
          yield* git(source, ["branch", "-D", initialBranch]);

          const core = yield* GitCore;
          const details = yield* core.statusDetails(source);
          expect(details.branch).toBe("feature/remote-base-only");
          expect(details.hasUpstream).toBe(false);
          expect(details.aheadCount).toBe(1);
          expect(details.behindCount).toBe(0);
        }),
    );

    it.effect(
      "computes ahead count against a non-origin remote-prefixed gh-merge-base candidate",
      () =>
        Effect.gen(function* () {
          const remote = yield* makeTmpDir();
          const source = yield* makeTmpDir();
          const remoteName = "fork-seed";
          yield* git(remote, ["init", "--bare"]);

          yield* initRepoWithCommit(source);
          const initialBranch = (yield* (yield* GitCore).listBranches({
            cwd: source,
          })).branches.find((branch) => branch.current)!.name;
          yield* git(source, ["remote", "add", remoteName, remote]);
          yield* git(source, ["push", "-u", remoteName, initialBranch]);
          yield* git(source, ["checkout", "-b", "feature/non-origin-merge-base"]);
          yield* git(source, [
            "config",
            "branch.feature/non-origin-merge-base.gh-merge-base",
            `${remoteName}/${initialBranch}`,
          ]);
          yield* writeTextFile(
            path.join(source, "feature.txt"),
            `ahead of ${remoteName}/${initialBranch}\n`,
          );
          yield* git(source, ["add", "feature.txt"]);
          yield* git(source, ["commit", "-m", "feature commit"]);
          yield* git(source, ["branch", "-D", initialBranch]);

          const core = yield* GitCore;
          const details = yield* core.statusDetails(source);
          expect(details.branch).toBe("feature/non-origin-merge-base");
          expect(details.hasUpstream).toBe(false);
          expect(details.aheadCount).toBe(1);
          expect(details.behindCount).toBe(0);
        }),
    );

    it.effect("skips push when no upstream is configured and branch is not ahead of base", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const core = yield* GitCore;

        yield* core.createBranch({ cwd: tmp, branch: "feature/no-upstream-no-ahead" });
        yield* core.checkoutBranch({ cwd: tmp, branch: "feature/no-upstream-no-ahead" });

        const pushed = yield* core.pushCurrentBranch(tmp, null);
        expect(pushed.status).toBe("skipped_up_to_date");
        expect(pushed.branch).toBe("feature/no-upstream-no-ahead");
        expect(pushed.setUpstream).toBeUndefined();
      }),
    );

    it.effect("pushes with upstream setup when no comparable base branch exists", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const remote = yield* makeTmpDir();
        yield* git(tmp, ["init", "--initial-branch=trunk"]);
        yield* git(tmp, ["config", "user.email", "test@test.com"]);
        yield* git(tmp, ["config", "user.name", "Test"]);
        yield* writeTextFile(path.join(tmp, "README.md"), "hello\n");
        yield* git(tmp, ["add", "README.md"]);
        yield* git(tmp, ["commit", "-m", "initial"]);
        yield* git(remote, ["init", "--bare"]);
        yield* git(tmp, ["remote", "add", "origin", remote]);
        yield* git(tmp, ["checkout", "-b", "feature/no-base"]);

        const core = yield* GitCore;
        const pushed = yield* core.pushCurrentBranch(tmp, null);
        expect(pushed.status).toBe("pushed");
        expect(pushed.setUpstream).toBe(true);
        expect(pushed.upstreamBranch).toBe("origin/feature/no-base");
        expect(yield* git(tmp, ["rev-parse", "--abbrev-ref", "@{upstream}"])).toBe(
          "origin/feature/no-base",
        );
      }),
    );

    it.effect("pushes with upstream setup to the only configured non-origin remote", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const remote = yield* makeTmpDir();
        yield* git(tmp, ["init", "--initial-branch=main"]);
        yield* git(tmp, ["config", "user.email", "test@test.com"]);
        yield* git(tmp, ["config", "user.name", "Test"]);
        yield* writeTextFile(path.join(tmp, "README.md"), "hello\n");
        yield* git(tmp, ["add", "README.md"]);
        yield* git(tmp, ["commit", "-m", "initial"]);
        yield* git(remote, ["init", "--bare"]);
        yield* git(tmp, ["remote", "add", "fork", remote]);
        yield* git(tmp, ["checkout", "-b", "feature/fork-only"]);

        const core = yield* GitCore;
        const pushed = yield* core.pushCurrentBranch(tmp, null);
        expect(pushed.status).toBe("pushed");
        expect(pushed.setUpstream).toBe(true);
        expect(pushed.upstreamBranch).toBe("fork/feature/fork-only");
        expect(yield* git(tmp, ["rev-parse", "--abbrev-ref", "@{upstream}"])).toBe(
          "fork/feature/fork-only",
        );
      }),
    );

    it.effect(
      "pushes with upstream setup when comparable base exists but remote branch is missing",
      () =>
        Effect.gen(function* () {
          const tmp = yield* makeTmpDir();
          const remote = yield* makeTmpDir();
          yield* git(remote, ["init", "--bare"]);

          yield* initRepoWithCommit(tmp);
          const initialBranch = (yield* (yield* GitCore).listBranches({ cwd: tmp })).branches.find(
            (branch) => branch.current,
          )!.name;
          yield* git(tmp, ["remote", "add", "origin", remote]);
          yield* git(tmp, ["push", "-u", "origin", initialBranch]);

          yield* writeTextFile(path.join(tmp, "default-ahead.txt"), "ahead on default\n");
          yield* git(tmp, ["add", "default-ahead.txt"]);
          yield* git(tmp, ["commit", "-m", "default ahead"]);

          const featureBranch = "feature/publish-no-upstream";
          yield* git(tmp, ["checkout", "-b", featureBranch]);

          const core = yield* GitCore;
          const pushed = yield* core.pushCurrentBranch(tmp, null);
          expect(pushed.status).toBe("pushed");
          expect(pushed.setUpstream).toBe(true);
          expect(pushed.upstreamBranch).toBe(`origin/${featureBranch}`);
          expect(yield* git(tmp, ["rev-parse", "--abbrev-ref", "@{upstream}"])).toBe(
            `origin/${featureBranch}`,
          );
          expect(yield* git(tmp, ["ls-remote", "--heads", "origin", featureBranch])).toContain(
            featureBranch,
          );
        }),
    );

    it.effect("prefers branch pushRemote over origin when setting upstream", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const origin = yield* makeTmpDir();
        const fork = yield* makeTmpDir();
        yield* git(origin, ["init", "--bare"]);
        yield* git(fork, ["init", "--bare"]);

        yield* initRepoWithCommit(tmp);
        const initialBranch = (yield* (yield* GitCore).listBranches({ cwd: tmp })).branches.find(
          (branch) => branch.current,
        )!.name;
        yield* git(tmp, ["remote", "add", "origin", origin]);
        yield* git(tmp, ["remote", "add", "fork", fork]);
        yield* git(tmp, ["push", "-u", "origin", initialBranch]);

        const featureBranch = "feature/push-remote";
        yield* git(tmp, ["checkout", "-b", featureBranch]);
        yield* git(tmp, ["config", `branch.${featureBranch}.pushRemote`, "fork"]);
        yield* writeTextFile(path.join(tmp, "feature.txt"), "push to fork\n");
        yield* git(tmp, ["add", "feature.txt"]);
        yield* git(tmp, ["commit", "-m", "feature commit"]);

        const core = yield* GitCore;
        const pushed = yield* core.pushCurrentBranch(tmp, null);
        expect(pushed.status).toBe("pushed");
        expect(pushed.setUpstream).toBe(true);
        expect(pushed.upstreamBranch).toBe(`fork/${featureBranch}`);
        expect(yield* git(tmp, ["rev-parse", "--abbrev-ref", "@{upstream}"])).toBe(
          `fork/${featureBranch}`,
        );
        expect(yield* git(tmp, ["ls-remote", "--heads", "fork", featureBranch])).toContain(
          featureBranch,
        );
      }),
    );

    it.effect(
      "pushes renamed PR worktree branches to their tracked upstream branch even when push.default is current",
      () =>
        Effect.gen(function* () {
          const tmp = yield* makeTmpDir();
          const fork = yield* makeTmpDir();
          yield* git(fork, ["init", "--bare"]);

          const { initialBranch } = yield* initRepoWithCommit(tmp);
          yield* git(tmp, ["remote", "add", "jasonLaster", fork]);
          yield* git(tmp, ["checkout", "-b", "statemachine"]);
          yield* writeTextFile(path.join(tmp, "fork.txt"), "fork branch\n");
          yield* git(tmp, ["add", "fork.txt"]);
          yield* git(tmp, ["commit", "-m", "fork branch"]);
          yield* git(tmp, ["push", "-u", "jasonLaster", "statemachine"]);
          yield* git(tmp, ["checkout", initialBranch]);
          yield* git(tmp, ["branch", "-D", "statemachine"]);
          yield* git(tmp, [
            "checkout",
            "-b",
            "piedpiper/pr-488/statemachine",
            "--track",
            "jasonLaster/statemachine",
          ]);
          yield* git(tmp, ["config", "push.default", "current"]);
          yield* writeTextFile(path.join(tmp, "fork.txt"), "updated fork branch\n");
          yield* git(tmp, ["add", "fork.txt"]);
          yield* git(tmp, ["commit", "-m", "update reviewed PR branch"]);

          const core = yield* GitCore;
          const pushed = yield* core.pushCurrentBranch(tmp, null);

          expect(pushed.status).toBe("pushed");
          expect(pushed.setUpstream).toBe(false);
          expect(pushed.upstreamBranch).toBe("jasonLaster/statemachine");
          expect(yield* git(tmp, ["rev-parse", "--abbrev-ref", "@{upstream}"])).toBe(
            "jasonLaster/statemachine",
          );
          expect(
            yield* git(tmp, ["ls-remote", "--heads", "jasonLaster", "statemachine"]),
          ).toContain("statemachine");
          expect(
            yield* git(tmp, [
              "ls-remote",
              "--heads",
              "jasonLaster",
              "piedpiper/pr-488/statemachine",
            ]),
          ).toBe("");
        }),
    );

    it.effect("pushes to the tracked upstream when the remote name contains slashes", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const remote = yield* makeTmpDir();
        const prefixRemote = yield* makeTmpDir();
        const prefixFetchNamespace = "prefix-my-org";
        const prefixRemoteName = "my-org";
        const remoteName = "my-org/upstream";
        const featureBranch = "feature/slash-remote-push";
        yield* git(remote, ["init", "--bare"]);
        yield* git(prefixRemote, ["init", "--bare"]);

        const { initialBranch } = yield* initRepoWithCommit(tmp);
        yield* configureRemote(tmp, prefixRemoteName, prefixRemote, prefixFetchNamespace);
        yield* configureRemote(tmp, remoteName, remote, remoteName);
        yield* git(tmp, ["push", "-u", remoteName, initialBranch]);

        yield* git(tmp, ["checkout", "-b", featureBranch]);
        yield* writeTextFile(path.join(tmp, "feature.txt"), "first revision\n");
        yield* git(tmp, ["add", "feature.txt"]);
        yield* git(tmp, ["commit", "-m", "feature base"]);
        yield* git(tmp, ["push", "-u", remoteName, featureBranch]);

        yield* writeTextFile(path.join(tmp, "feature.txt"), "second revision\n");
        yield* git(tmp, ["add", "feature.txt"]);
        yield* git(tmp, ["commit", "-m", "feature update"]);

        const core = yield* GitCore;
        const pushed = yield* core.pushCurrentBranch(tmp, null);
        expect(pushed.status).toBe("pushed");
        expect(pushed.setUpstream).toBe(false);
        expect(pushed.upstreamBranch).toBe(`${remoteName}/${featureBranch}`);
        expect(yield* git(tmp, ["rev-parse", "--abbrev-ref", "@{upstream}"])).toBe(
          `${remoteName}/${featureBranch}`,
        );
        expect(yield* git(tmp, ["ls-remote", "--heads", remoteName, featureBranch])).toContain(
          featureBranch,
        );
      }),
    );

    it.effect("publishes a branch cut from origin/dev under its own name, not onto dev", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const remote = yield* makeTmpDir();
        yield* git(remote, ["init", "--bare"]);
        const { initialBranch } = yield* initRepoWithCommit(tmp);
        yield* git(tmp, ["remote", "add", "origin", remote]);
        yield* git(tmp, ["push", "-u", "origin", initialBranch]);
        yield* git(tmp, ["checkout", "-b", "dev"]);
        yield* git(tmp, ["push", "-u", "origin", "dev"]);
        const devSha = yield* git(tmp, ["rev-parse", "HEAD"]);
        yield* git(tmp, ["checkout", "-b", "feature/x", "origin/dev"]);
        yield* writeTextFile(path.join(tmp, "feature.txt"), "feature\n");
        yield* git(tmp, ["add", "feature.txt"]);
        yield* git(tmp, ["commit", "-m", "Add feature"]);

        const core = yield* GitCore;
        const pushed = yield* core.pushCurrentBranch(tmp, null);

        expect(pushed).toMatchObject({
          status: "pushed",
          branch: "feature/x",
          upstreamBranch: "origin/feature/x",
          setUpstream: true,
        });
        expect(yield* git(remote, ["--git-dir=.", "log", "-1", "--pretty=%s", "feature/x"])).toBe(
          "Add feature",
        );
        expect(yield* git(remote, ["--git-dir=.", "rev-parse", "dev"])).toBe(devSha);
        expect(yield* git(tmp, ["rev-parse", "--abbrev-ref", "@{upstream}"])).toBe(
          "origin/feature/x",
        );
        expect(yield* core.readConfigValue(tmp, "branch.feature/x.gh-merge-base")).toBe("dev");
      }),
    );

    it.effect("publishes a worktree branch cut from origin/main without touching main", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const remote = yield* makeTmpDir();
        yield* git(remote, ["init", "--bare"]);
        yield* initRepoWithCommit(tmp);
        yield* git(tmp, ["branch", "-M", "main"]);
        yield* git(tmp, ["remote", "add", "origin", remote]);
        yield* git(tmp, ["push", "-u", "origin", "main"]);
        const mainSha = yield* git(tmp, ["rev-parse", "HEAD"]);
        yield* git(tmp, ["config", "branch.autoSetupMerge", "always"]);

        const core = yield* GitCore;
        const { worktree } = yield* core.createWorktree({
          cwd: tmp,
          branch: "origin/main",
          newBranch: "feature/worktree-push",
          path: path.join(yield* makeTmpDir(), "wt"),
        });
        expect(yield* git(worktree.path, ["rev-parse", "--abbrev-ref", "@{upstream}"])).toBe(
          "origin/main",
        );
        yield* git(worktree.path, [
          "config",
          "branch.feature/worktree-push.gh-merge-base",
          "release",
        ]);
        yield* writeTextFile(path.join(worktree.path, "wt.txt"), "worktree\n");
        yield* git(worktree.path, ["add", "wt.txt"]);
        yield* git(worktree.path, ["commit", "-m", "Worktree change"]);

        const pushed = yield* core.pushCurrentBranch(worktree.path, null);

        expect(pushed).toMatchObject({
          status: "pushed",
          upstreamBranch: "origin/feature/worktree-push",
          setUpstream: true,
        });
        expect(yield* git(remote, ["--git-dir=.", "rev-parse", "main"])).toBe(mainSha);
        expect(
          yield* git(remote, ["--git-dir=.", "log", "-1", "--pretty=%s", "feature/worktree-push"]),
        ).toBe("Worktree change");
        // An already recorded base is kept.
        expect(yield* core.readConfigValue(tmp, "branch.feature/worktree-push.gh-merge-base")).toBe(
          "release",
        );
      }),
    );

    it.effect("includes command context when worktree removal fails", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const core = yield* GitCore;
        // An existing folder git does not track (a missing one is treated as already removed).
        const missingWorktreePath = path.join(tmp, "missing-worktree");
        mkdirSync(missingWorktreePath);

        const removeResult = yield* Effect.result(
          core.removeWorktree({ cwd: tmp, path: missingWorktreePath }),
        );
        expect(removeResult._tag).toBe("Failure");
        if (removeResult._tag !== "Failure") {
          return;
        }
        const message = removeResult.failure.message;
        expect(message).toContain("git worktree remove");
        expect(message).toContain(`cwd: ${tmp}`);
        expect(message).toContain(missingWorktreePath);
      }),
    );

    it.effect(
      "refreshes upstream before statusDetails so behind count reflects remote updates",
      () =>
        Effect.gen(function* () {
          const remote = yield* makeTmpDir();
          const source = yield* makeTmpDir();
          const clone = yield* makeTmpDir();
          yield* git(remote, ["init", "--bare"]);

          yield* initRepoWithCommit(source);
          const initialBranch = (yield* (yield* GitCore).listBranches({
            cwd: source,
          })).branches.find((branch) => branch.current)!.name;
          yield* git(source, ["remote", "add", "origin", remote]);
          yield* git(source, ["push", "-u", "origin", initialBranch]);

          yield* git(clone, ["clone", remote, "."]);
          yield* git(clone, ["config", "user.email", "test@test.com"]);
          yield* git(clone, ["config", "user.name", "Test"]);
          yield* git(clone, [
            "checkout",
            "-B",
            initialBranch,
            "--track",
            `origin/${initialBranch}`,
          ]);
          yield* writeTextFile(path.join(clone, "CHANGELOG.md"), "remote change\n");
          yield* git(clone, ["add", "CHANGELOG.md"]);
          yield* git(clone, ["commit", "-m", "remote update"]);
          yield* git(clone, ["push", "origin", initialBranch]);

          const core = yield* GitCore;
          const details = yield* core.statusDetails(source);
          expect(details.branch).toBe(initialBranch);
          expect(details.aheadCount).toBe(0);
          expect(details.behindCount).toBe(1);
        }),
    );

    it.effect("does not start git auto-gc from background upstream status fetches", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", initialBranch]);
        yield* git(cwd, ["repack", "-d"]);
        yield* writeTextFile(path.join(cwd, "second.txt"), "second\n");
        yield* git(cwd, ["add", "second.txt"]);
        yield* git(cwd, ["commit", "-m", "second commit"]);
        yield* git(cwd, ["push"]);
        yield* git(cwd, ["repack", "-d"]);
        // Two packs make `git gc --auto` due; without detaching it would run inside the fetch.
        yield* git(cwd, ["config", "gc.autoPackLimit", "1"]);
        yield* git(cwd, ["config", "gc.autoDetach", "false"]);
        yield* git(cwd, ["config", "maintenance.autoDetach", "false"]);
        const packCount = git(cwd, ["count-objects", "-v"]).pipe(
          Effect.map((stdout) => stdout.match(/^packs: (\d+)$/m)?.[1]),
        );
        expect(yield* packCount).toBe("2");

        yield* (yield* GitCore).statusDetails(cwd);

        expect(yield* packCount).toBe("2");
      }),
    );

    it.effect("reports a remote for repos whose only remote is not named origin", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const remote = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* git(remote, ["init", "--bare"]);
        yield* git(tmp, ["remote", "add", "upstream", remote]);
        const core = yield* GitCore;

        expect((yield* core.statusDetails(tmp)).hasOriginRemote).toBe(true);
        expect((yield* core.listBranches({ cwd: tmp })).hasOriginRemote).toBe(true);
      }),
    );

    it.effect("pushes to the real upstream when a local origin/<branch> branch shadows it", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["checkout", "-b", "release"]);
        yield* git(cwd, ["push", "-u", "origin", "release"]);
        yield* git(cwd, ["commit", "--allow-empty", "-m", "unpushed"]);
        yield* git(cwd, ["branch", "origin/release"]);

        const pushed = yield* (yield* GitCore).pushCurrentBranch(cwd, null);

        expect(pushed.status).toBe("pushed");
        expect(pushed.upstreamBranch).toBe("origin/release");
        // Pushed through the tracked upstream, not republished as a branch cut from a base.
        expect(pushed.setUpstream).toBe(false);
        expect(
          yield* git(cwd, ["config", "--get", "branch.release.gh-merge-base"]).pipe(
            Effect.catch(() => Effect.succeed("")),
          ),
        ).toBe("");
        expect(yield* git(remote, ["--git-dir=.", "rev-parse", "release"])).toBe(
          yield* git(cwd, ["rev-parse", "HEAD"]),
        );
      }),
    );

    it.effect("publishes a branch that tracks a local branch instead of pushing into it", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["branch", "base"]);
        const baseSha = yield* git(cwd, ["rev-parse", "base"]);
        yield* git(cwd, ["checkout", "-b", "stacked", "--track", "base"]);
        yield* git(cwd, ["config", "push.default", "upstream"]);
        yield* git(cwd, ["commit", "--allow-empty", "-m", "stacked change"]);

        const pushed = yield* (yield* GitCore).pushCurrentBranch(cwd, null);

        expect(pushed.status).toBe("pushed");
        expect(pushed.upstreamBranch).toBe("origin/stacked");
        expect(pushed.setUpstream).toBe(true);
        expect(yield* git(remote, ["--git-dir=.", "rev-parse", "stacked"])).toBe(
          yield* git(cwd, ["rev-parse", "HEAD"]),
        );
        expect(yield* git(cwd, ["rev-parse", "base"])).toBe(baseSha);
        expect(yield* git(cwd, ["config", "--get", "branch.stacked.gh-merge-base"])).toBe("base");
        expect(yield* git(cwd, ["rev-parse", "--abbrev-ref", "stacked@{upstream}"])).toBe(
          "origin/stacked",
        );
      }),
    );

    it.effect("does not fetch for status when the branch tracks a local branch", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "feature", remote]);
        yield* git(cwd, ["branch", "feature/base"]);
        yield* git(cwd, ["checkout", "-b", "stacked", "--track", "feature/base"]);
        const realGitCore = yield* GitCore;
        const fetches: string[][] = [];
        const core = yield* makeIsolatedGitCore((input) => {
          if (input.args.includes("fetch")) fetches.push([...input.args]);
          return realGitCore.execute(input);
        });

        const status = yield* core.statusDetails(cwd);

        expect(status.upstreamRef).toBe("feature/base");
        expect(fetches).toEqual([]);
      }),
    );

    it.effect.skipIf(process.platform === "win32")(
      "runs git with LANGUAGE=C unless the caller sets it",
      () =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          const core = yield* GitCore;
          const printLanguage = (env?: NodeJS.ProcessEnv) =>
            core
              .execute({
                operation: "GitCore.test.language",
                cwd,
                args: ["-c", 'alias.lang=!printf %s "$LANGUAGE"', "lang"],
                ...(env ? { env } : {}),
              })
              .pipe(Effect.map((result) => result.stdout));

          expect(yield* printLanguage({ LANG: "de_DE.UTF-8" })).toBe("C");
          expect(yield* printLanguage({ LANGUAGE: "fr" })).toBe("fr");
        }),
    );

    it.effect("checks out new worktrees in parallel unless checkout.workers is configured", () =>
      Effect.gen(function* () {
        const run = (configuredWorkers: string | null) =>
          Effect.gen(function* () {
            let addArgs: ReadonlyArray<string> = [];
            const core = yield* makeIsolatedGitCore((input) => {
              if (input.args.includes("worktree")) addArgs = input.args;
              const configured =
                input.args.includes("checkout.workers") && input.args[0] === "config";
              return Effect.succeed({
                code: configured && configuredWorkers === null ? 1 : 0,
                stdout: configured && configuredWorkers !== null ? `${configuredWorkers}\n` : "",
                stderr: "",
                stdoutTruncated: false,
                stderrTruncated: false,
              });
            });
            yield* core.createWorktree({ cwd: "/repo", branch: "main", path: "/wt" });
            return addArgs;
          });

        expect(yield* run(null)).toEqual([
          "-c",
          "checkout.workers=0",
          "worktree",
          "add",
          "--",
          "/wt",
          "main",
        ]);
        expect((yield* run("1")).slice(0, 2)).toEqual(["-c", "checkout.workers=1"]);
      }),
    );

    it.effect("retries a remote branch fetch once after losing a ref lock", () =>
      Effect.gen(function* () {
        let fetchAttempts = 0;
        const core = yield* makeIsolatedGitCore((input) => {
          const isFetch = input.args[0] === "fetch";
          if (isFetch) fetchAttempts += 1;
          const lost = isFetch && fetchAttempts === 1;
          return Effect.succeed({
            code: lost ? 1 : 0,
            stdout: "",
            stderr: lost ? "error: cannot lock ref 'refs/remotes/origin/feature': is at a\n" : "",
            stdoutTruncated: false,
            stderrTruncated: false,
          });
        });

        yield* core.fetchRemoteBranch({
          cwd: "/repo",
          remoteName: "origin",
          remoteBranch: "feature",
          localBranch: "feature",
        });

        expect(fetchAttempts).toBe(2);
      }),
    );

    it.effect("does not retry a remote branch fetch that failed for another reason", () =>
      Effect.gen(function* () {
        let fetchAttempts = 0;
        const core = yield* makeIsolatedGitCore((input) => {
          if (input.args[0] === "fetch") fetchAttempts += 1;
          return Effect.succeed({
            code: input.args[0] === "fetch" ? 128 : 0,
            stdout: "",
            stderr: input.args[0] === "fetch" ? "fatal: couldn't find remote ref feature\n" : "",
            stdoutTruncated: false,
            stderrTruncated: false,
          });
        });

        const error = yield* Effect.flip(
          core.fetchRemoteBranch({
            cwd: "/repo",
            remoteName: "origin",
            remoteBranch: "feature",
            localBranch: "feature",
          }),
        );

        expect(fetchAttempts).toBe(1);
        expect(error.detail).toContain("couldn't find remote ref");
      }),
    );

    const refLockStderr = "error: cannot lock ref 'refs/remotes/origin/other': is at a\n";
    const runRefLockedPull = (options: {
      readonly movedHead?: "branch" | "sha";
      readonly retryAlsoLocked?: boolean;
      readonly mergeRefs?: string;
    }) =>
      Effect.gen(function* () {
        const pulls: string[][] = [];
        let headReads = 0;
        const ok = (stdout = "") =>
          Effect.succeed({
            code: 0,
            stdout,
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          });
        const core = yield* makeIsolatedGitCore((input) => {
          const args = input.args;
          if (input.operation === "GitCore.statusDetails.status") {
            return ok("# branch.head main\0# branch.upstream origin/main\0# branch.ab +0 -1\0");
          }
          if (args[0] === "pull") {
            pulls.push([...args]);
            return pulls.length === 1 || options.retryAlsoLocked
              ? Effect.succeed({
                  code: 1,
                  stdout: "",
                  stderr: refLockStderr,
                  stdoutTruncated: false,
                  stderrTruncated: false,
                })
              : ok();
          }
          if (args[0] === "rev-parse" && args[1] === "HEAD") {
            headReads += 1;
            return ok(options.movedHead === "sha" && headReads > 1 ? "def\n" : "abc\n");
          }
          if (args[0] === "symbolic-ref" && args.includes("--short")) {
            return ok(options.movedHead === "branch" ? "other\n" : "main\n");
          }
          if (args[0] === "config" && args.includes("branch.main.remote")) return ok("origin\n");
          if (args[0] === "config" && args.includes("branch.main.merge")) {
            return ok(options.mergeRefs ?? "refs/heads/main\n");
          }
          return ok();
        });

        const result = yield* Effect.result(core.pullCurrentBranch("/repo"));
        return { pulls, result };
      });

    it.effect("retries a pull that lost a ref lock with only the configured upstream", () =>
      Effect.gen(function* () {
        const { pulls, result } = yield* runRefLockedPull({});

        expect(result._tag).toBe("Success");
        expect(pulls).toEqual([
          ["pull", "--ff-only"],
          ["pull", "--ff-only", "--", "origin", "refs/heads/main"],
        ]);
      }),
    );

    it.effect.each(["branch", "sha"] as const)(
      "does not retry a ref-locked pull after another operation moved the %s",
      (movedHead) =>
        Effect.gen(function* () {
          const { pulls, result } = yield* runRefLockedPull({ movedHead });

          expect(pulls).toEqual([["pull", "--ff-only"]]);
          expect(result._tag).toBe("Failure");
          if (result._tag === "Failure") {
            expect(result.failure).toBeInstanceOf(GitCommandError);
            expect(result.failure.detail).toContain("cannot lock ref");
          }
        }),
    );

    it.effect("does not retry a ref-locked pull with several configured merge refs", () =>
      Effect.gen(function* () {
        const { pulls, result } = yield* runRefLockedPull({
          mergeRefs: "refs/heads/main\nrefs/heads/other\n",
        });

        expect(pulls).toEqual([["pull", "--ff-only"]]);
        expect(result._tag).toBe("Failure");
      }),
    );

    it.effect("reports a pull whose scoped retry is still ref-locked", () =>
      Effect.gen(function* () {
        const { pulls, result } = yield* runRefLockedPull({ retryAlsoLocked: true });

        expect(pulls).toHaveLength(2);
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          expect(result.failure.detail).toContain("cannot lock ref");
        }
      }),
    );

    it.effect("prepares commit context by auto-staging and creates commit", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const core = yield* GitCore;

        yield* writeTextFile(path.join(tmp, "README.md"), "new content\n");
        const context = yield* core.prepareCommitContext(tmp);
        expect(context).not.toBeNull();
        expect(context!.stagedSummary.length).toBeGreaterThan(0);
        expect(context!.stagedPatch.length).toBeGreaterThan(0);

        const created = yield* core.commit(tmp, "Add README update", "- include updated content", {
          stage: {},
        });
        expect(created.commitSha.length).toBeGreaterThan(0);
        expect(yield* git(tmp, ["log", "-1", "--pretty=%s"])).toBe("Add README update");
      }),
    );

    it.effect("prepareCommitContext stages only selected files when filePaths provided", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const core = yield* GitCore;

        yield* writeTextFile(path.join(tmp, "a.txt"), "file a\n");
        yield* writeTextFile(path.join(tmp, "b.txt"), "file b\n");

        const context = yield* core.prepareCommitContext(tmp, ["a.txt"]);
        expect(context).not.toBeNull();
        expect(context!.stagedSummary).toContain("a.txt");
        expect(context!.stagedSummary).not.toContain("b.txt");

        yield* core.commit(tmp, "Add only a.txt", "", { stage: { filePaths: ["a.txt"] } });

        // b.txt should still be untracked after commit
        const statusAfter = yield* git(tmp, ["status", "--porcelain"]);
        expect(statusAfter).toContain("b.txt");
        expect(statusAfter).not.toContain("a.txt");
      }),
    );

    it.effect("lists and commits non-ASCII file names by their real paths", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const core = yield* GitCore;
        yield* writeTextFile(path.join(tmp, "café notes.txt"), "one\ntwo\n");
        yield* writeTextFile(path.join(tmp, "other.txt"), "other\n");

        const details = yield* core.statusDetails(tmp);
        expect(details.workingTree.files.map((file) => file.path)).toEqual([
          "café notes.txt",
          "other.txt",
        ]);
        expect(details.workingTree.rootPath).toBe(realpathSync(tmp));

        yield* core.commit(tmp, "Add café", "", { stage: { filePaths: ["café notes.txt"] } });
        expect(
          yield* git(tmp, ["-c", "core.quotePath=false", "show", "--name-only", "--format="]),
        ).toBe("café notes.txt");
      }),
    );

    it.effect("lists a rename's original path so a selected commit includes the deletion", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const core = yield* GitCore;
        yield* git(tmp, ["mv", "README.md", "GUIDE.md"]);
        yield* writeTextFile(path.join(tmp, "other.txt"), "other\n");

        const details = yield* core.statusDetails(tmp);
        const paths = details.workingTree.files.map((file) => file.path);
        expect(paths).toContain("GUIDE.md");
        expect(paths).toContain("README.md");

        yield* core.commit(tmp, "Rename readme", "", {
          stage: { filePaths: ["GUIDE.md", "README.md"] },
        });
        expect(yield* git(tmp, ["show", "-M", "--name-status", "--format="])).toBe(
          "R100\tREADME.md\tGUIDE.md",
        );
        expect(yield* git(tmp, ["status", "--porcelain"])).toBe("?? other.txt");
      }),
    );

    it.effect("commits selected repository-relative paths from a subdirectory project", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const core = yield* GitCore;
        const project = path.join(tmp, "packages", "app");
        mkdirSync(project, { recursive: true });
        yield* writeTextFile(path.join(project, "index.ts"), "export {};\n");
        yield* writeTextFile(path.join(project, "skip.ts"), "export {};\n");
        yield* git(tmp, ["add", "."]);
        yield* git(tmp, ["commit", "-m", "add app"]);
        yield* writeTextFile(path.join(project, "index.ts"), "export const a = 1;\n");
        yield* writeTextFile(path.join(project, "skip.ts"), "export const b = 1;\n");

        const details = yield* core.statusDetails(project);
        expect(details.workingTree.files.map((file) => file.path)).toContain(
          "packages/app/index.ts",
        );
        const context = yield* core.prepareCommitContext(project, ["packages/app/index.ts"]);
        expect(context!.stagedSummary).toBe("M\tpackages/app/index.ts");

        yield* core.commit(project, "Add index", "", {
          stage: { filePaths: ["packages/app/index.ts"] },
        });
        expect(yield* git(tmp, ["show", "--name-only", "--format="])).toBe("packages/app/index.ts");
      }),
    );

    it.effect("prepareCommitContext leaves the real index and partial staging untouched", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const core = yield* GitCore;

        yield* writeTextFile(path.join(tmp, "staged.txt"), "staged\n");
        yield* writeTextFile(path.join(tmp, "unstaged.txt"), "unstaged\n");
        yield* git(tmp, ["add", "staged.txt"]);

        const all = yield* core.prepareCommitContext(tmp);
        expect(all!.stagedSummary).toContain("staged.txt");
        expect(all!.stagedSummary).toContain("unstaged.txt");
        const selected = yield* core.prepareCommitContext(tmp, ["unstaged.txt"]);
        expect(selected!.stagedSummary).toBe("A\tunstaged.txt");

        expect(yield* git(tmp, ["diff", "--cached", "--name-only"])).toBe("staged.txt");
      }),
    );

    it.effect.each([false, true])(
      "prepareCommitContext preserves partial staging and split-index files (split: %s)",
      (split) =>
        Effect.gen(function* () {
          const tmp = yield* makeTmpDir();
          yield* initRepoWithCommit(tmp);
          if (split) yield* git(tmp, ["config", "core.splitIndex", "true"]);
          yield* writeTextFile(path.join(tmp, "README.md"), "# test\nstaged\n");
          yield* git(tmp, ["add", "README.md"]);
          yield* writeTextFile(path.join(tmp, "README.md"), "# test\nstaged\nunstaged\n");
          yield* writeTextFile(path.join(tmp, "untracked.txt"), "untracked\n");
          yield* writeTextFile(path.join(tmp, ".gitignore"), "ignored.txt\n");
          yield* writeTextFile(path.join(tmp, "ignored.txt"), "ignored\n");
          const gitDir = path.join(tmp, ".git");
          const sharedIndexes = () =>
            readdirSync(gitDir).filter((name) => name.startsWith("sharedindex."));
          const indexBefore = readFileSync(path.join(gitDir, "index"));
          const sharedBefore = sharedIndexes();
          if (split) expect(sharedBefore.length).toBeGreaterThan(0);
          const core = yield* GitCore;

          for (const paths of [undefined, ["README.md"]]) {
            const context = yield* core.prepareCommitContext(tmp, paths);
            expect(context?.stagedPatch ?? "").toContain("unstaged");
            expect(context?.stagedSummary ?? "").not.toContain("ignored.txt");
            expect(readFileSync(path.join(gitDir, "index"))).toEqual(indexBefore);
            expect(sharedIndexes()).toEqual(sharedBefore);
          }
        }),
    );

    it.effect(
      "prepareCommitContext handles an unborn repository without creating a real index",
      () =>
        Effect.gen(function* () {
          const tmp = yield* makeTmpDir();
          const core = yield* GitCore;
          yield* core.initRepo({ cwd: tmp });
          yield* git(tmp, ["config", "user.email", "test@test.com"]);
          yield* git(tmp, ["config", "user.name", "Test"]);
          yield* writeTextFile(path.join(tmp, "initial.txt"), "initial\n");

          for (const paths of [undefined, ["initial.txt"]]) {
            const context = yield* core.prepareCommitContext(tmp, paths);
            expect(context?.stagedSummary ?? "").toContain("initial.txt");
            expect(existsSync(path.join(tmp, ".git", "index"))).toBe(false);
          }
          yield* core.commit(tmp, "Initial", "", { stage: { filePaths: ["initial.txt"] } });
          expect(yield* git(tmp, ["show", "HEAD:initial.txt"])).toBe("initial");
        }),
    );

    it.effect("prepareCommitContext preserves merge metadata for selected and all files", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(tmp);
        yield* git(tmp, ["checkout", "-b", "feature"]);
        yield* writeTextFile(path.join(tmp, "feature.txt"), "feature\n");
        yield* git(tmp, ["add", "."]);
        yield* git(tmp, ["commit", "-m", "Feature"]);
        yield* git(tmp, ["checkout", initialBranch]);
        yield* git(tmp, ["merge", "--no-commit", "--no-ff", "feature"]);
        yield* writeTextFile(path.join(tmp, "README.md"), "# test\nmerge edit\n");
        const names = ["index", "MERGE_HEAD", "MERGE_MSG", "ORIG_HEAD"];
        const read = () => names.map((name) => readFileSync(path.join(tmp, ".git", name)));
        const before = read();
        const core = yield* GitCore;

        for (const paths of [undefined, ["README.md"]]) {
          yield* core.prepareCommitContext(tmp, paths);
          expect(read()).toEqual(before);
        }
      }),
    );

    it.effect(
      "refuses a selected-file commit during a merge without touching the merge state",
      () =>
        Effect.gen(function* () {
          const tmp = yield* makeTmpDir();
          const { initialBranch } = yield* initRepoWithCommit(tmp);
          yield* git(tmp, ["checkout", "-b", "feature"]);
          yield* writeTextFile(path.join(tmp, "feature.txt"), "feature\n");
          yield* git(tmp, ["add", "."]);
          yield* git(tmp, ["commit", "-m", "Feature"]);
          yield* git(tmp, ["checkout", initialBranch]);
          yield* git(tmp, ["merge", "--no-commit", "--no-ff", "feature"]);
          yield* writeTextFile(path.join(tmp, "README.md"), "# test\nmerge edit\n");
          const head = yield* git(tmp, ["rev-parse", "HEAD"]);
          const core = yield* GitCore;

          const error = yield* Effect.flip(
            core.commit(tmp, "Partial", "", { stage: { filePaths: ["README.md"] } }),
          );

          expect(error.detail).toContain("Cannot commit selected files during a merge");
          expect(yield* git(tmp, ["rev-parse", "HEAD"])).toBe(head);
          expect(existsSync(path.join(tmp, ".git", "MERGE_HEAD"))).toBe(true);
          expect(yield* git(tmp, ["diff", "--cached", "--name-only"])).toBe("feature.txt");

          yield* core.commit(tmp, "Merge feature", "", { stage: {} });
          expect(yield* git(tmp, ["rev-list", "--parents", "-n", "1", "HEAD"])).toContain(head);
          expect(
            (yield* git(tmp, ["rev-list", "--parents", "-n", "1", "HEAD"])).split(" "),
          ).toHaveLength(3);
        }),
    );

    it.effect("treats selected file paths literally", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const core = yield* GitCore;

        yield* writeTextFile(path.join(tmp, "selected[1].txt"), "literal\n");
        yield* writeTextFile(path.join(tmp, "selected1.txt"), "pattern match\n");

        const context = yield* core.prepareCommitContext(tmp, ["selected[1].txt"]);
        expect(context!.stagedSummary).toBe("A\tselected[1].txt");

        yield* core.commit(tmp, "Add literal", "", { stage: { filePaths: ["selected[1].txt"] } });
        expect(yield* git(tmp, ["show", "--name-only", "--pretty=format:", "HEAD"])).toBe(
          "selected[1].txt",
        );
        expect(yield* git(tmp, ["status", "--porcelain"])).toContain("?? selected1.txt");
      }),
    );

    it.effect.skipIf(process.platform === "win32")(
      "reports and commits file paths with leading or trailing spaces",
      () =>
        Effect.gen(function* () {
          const tmp = yield* makeTmpDir();
          yield* initRepoWithCommit(tmp);
          const core = yield* GitCore;
          yield* writeTextFile(path.join(tmp, " notes.txt"), "padded\n");
          yield* writeTextFile(path.join(tmp, "draft.md "), "trailing\n");
          yield* writeTextFile(path.join(tmp, "README.md"), "# changed\n");

          const details = yield* core.statusDetails(tmp);
          expect(details.workingTree.files.map((file) => file.path)).toEqual(
            expect.arrayContaining([" notes.txt", "draft.md ", "README.md"]),
          );

          yield* core.commit(tmp, "Add padded", "", {
            stage: { filePaths: [" notes.txt", "draft.md "] },
          });
          const committed = yield* (yield* GitCore).execute({
            operation: "GitCore.test.showCommitted",
            cwd: tmp,
            args: ["show", "-z", "--name-only", "--pretty=format:", "HEAD"],
          });
          expect(committed.stdout.split("\0").filter((entry) => entry.length > 0)).toEqual(
            expect.arrayContaining([" notes.txt", "draft.md "]),
          );
          const after = yield* core.statusDetails(tmp);
          expect(after.workingTree.files).toEqual([
            { path: "README.md", insertions: 1, deletions: 1 },
          ]);
        }),
    );

    it.effect("stops a selected-file commit when another process holds the index lock", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const fileSystem = yield* FileSystem.FileSystem;
        const head = yield* git(tmp, ["rev-parse", "HEAD"]);
        yield* writeTextFile(path.join(tmp, "a.txt"), "a\n");
        yield* writeTextFile(path.join(tmp, "staged.txt"), "staged\n");
        yield* git(tmp, ["add", "staged.txt"]);
        const lockPath = path.join(tmp, ".git", "index.lock");
        yield* fileSystem.writeFileString(lockPath, "");
        const realExecute = (yield* GitCore).execute;
        // The lock is released right after the reset, so later commands would succeed.
        const core = yield* makeIsolatedGitCore((input) =>
          realExecute(input).pipe(
            Effect.ensuring(
              input.args.includes("reset")
                ? fileSystem.remove(lockPath, { force: true }).pipe(Effect.ignore)
                : Effect.void,
            ),
          ),
        );

        const error = yield* core
          .commit(tmp, "Add a", "", { stage: { filePaths: ["a.txt"] } })
          .pipe(Effect.flip);

        expect(error.operation).toBe("GitCore.commit.reset");
        expect(yield* git(tmp, ["rev-parse", "HEAD"])).toBe(head);
        expect(yield* git(tmp, ["diff", "--cached", "--name-only"])).toBe("staged.txt");
      }),
    );

    const commitWithHooks = (hooks: Record<string, string>) =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        // Override any global core.hooksPath so only these hooks run.
        yield* git(tmp, ["config", "core.hooksPath", ".git/hooks"]);
        const fileSystem = yield* FileSystem.FileSystem;
        for (const [name, script] of Object.entries(hooks)) {
          const hookPath = path.join(tmp, ".git", "hooks", name);
          yield* writeTextFile(hookPath, `#!/bin/sh\n${script}\n`);
          yield* fileSystem.chmod(hookPath, 0o755);
        }
        yield* writeTextFile(path.join(tmp, "a.txt"), "a\n");
        const events: string[] = [];
        const exit = yield* (yield* GitCore)
          .commit(tmp, "Add a", "", {
            stage: { filePaths: ["a.txt"] },
            progress: {
              onHookStarted: (hookName) => Effect.sync(() => void events.push(`start ${hookName}`)),
              onHookFinished: ({ hookName, exitCode }) =>
                Effect.sync(() => void events.push(`finish ${hookName} ${exitCode}`)),
            },
          })
          .pipe(Effect.exit);
        return { events, committed: exit._tag === "Success" };
      });

    it.effect.skipIf(process.platform === "win32")(
      "reports each commit hook finishing with its exit code",
      () =>
        Effect.gen(function* () {
          // The pre-commit hook runs git, whose own children reuse child_id 0 in the shared trace.
          const { events, committed } = yield* commitWithHooks({
            "pre-commit": "git -c alias.noop='!false' noop\nexit 0",
            "commit-msg": "exit 0",
          });
          expect(committed).toBe(true);
          expect(events).toEqual([
            "start pre-commit",
            "finish pre-commit 0",
            "start commit-msg",
            "finish commit-msg 0",
          ]);
        }),
    );

    it.effect.skipIf(process.platform === "win32")(
      "reports the exit code of a commit hook that rejects the commit",
      () =>
        Effect.gen(function* () {
          const { events, committed } = yield* commitWithHooks({ "commit-msg": "exit 3" });
          expect(committed).toBe(false);
          expect(events).toEqual(["start commit-msg", "finish commit-msg 3"]);
        }),
    );

    it.effect("prepareCommitContext stages everything when filePaths is undefined", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const core = yield* GitCore;

        yield* writeTextFile(path.join(tmp, "a.txt"), "file a\n");
        yield* writeTextFile(path.join(tmp, "b.txt"), "file b\n");

        const context = yield* core.prepareCommitContext(tmp);
        expect(context).not.toBeNull();
        expect(context!.stagedSummary).toContain("a.txt");
        expect(context!.stagedSummary).toContain("b.txt");
      }),
    );

    it.effect("prepareCommitContext truncates oversized staged patches instead of failing", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const core = yield* GitCore;

        yield* writeTextFile(path.join(tmp, "README.md"), buildLargeText());

        const context = yield* core.prepareCommitContext(tmp);
        expect(context).not.toBeNull();
        expect(context!.stagedSummary).toContain("README.md");
        expect(context!.stagedPatch).toContain("[truncated]");
      }),
    );

    it.effect("readRangeContext truncates oversized diff patches instead of failing", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(tmp);
        const core = yield* GitCore;

        yield* core.createBranch({ cwd: tmp, branch: "feature/large-range-context" });
        yield* core.checkoutBranch({ cwd: tmp, branch: "feature/large-range-context" });
        yield* writeTextFile(path.join(tmp, "large.txt"), buildLargeText());
        yield* git(tmp, ["add", "large.txt"]);
        yield* git(tmp, ["commit", "-m", "Add large range context"]);

        const rangeContext = yield* core.readRangeContext(tmp, initialBranch);
        expect(rangeContext.commitSummary).toContain("Add large range context");
        expect(rangeContext.diffSummary).toContain("large.txt");
        expect(rangeContext.diffPatch).toContain("[truncated]");
      }),
    );

    it.effect("readRangeContext reads a base ref that looks like an option as a revision", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const core = yield* GitCore;
        const output = path.join(yield* makeTmpDir(), "out");

        yield* core.readRangeContext(tmp, `--output=${output}`).pipe(Effect.flip);

        expect(existsSync(`${output}..HEAD`)).toBe(false);
      }),
    );

    it.effect("pushes with upstream setup and then skips when up to date", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const remote = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* git(remote, ["init", "--bare"]);
        yield* git(tmp, ["remote", "add", "origin", remote]);
        yield* (yield* GitCore).createBranch({ cwd: tmp, branch: "feature/core-push" });
        yield* (yield* GitCore).checkoutBranch({ cwd: tmp, branch: "feature/core-push" });

        yield* writeTextFile(path.join(tmp, "feature.txt"), "push me\n");
        const core = yield* GitCore;
        const context = yield* core.prepareCommitContext(tmp);
        expect(context).not.toBeNull();
        yield* core.commit(tmp, "Add feature file", "", { stage: {} });

        const pushed = yield* core.pushCurrentBranch(tmp, null);
        expect(pushed.status).toBe("pushed");
        expect(pushed.setUpstream).toBe(true);
        expect(yield* git(tmp, ["rev-parse", "--abbrev-ref", "@{upstream}"])).toBe(
          "origin/feature/core-push",
        );

        const skipped = yield* core.pushCurrentBranch(tmp, null);
        expect(skipped.status).toBe("skipped_up_to_date");
      }),
    );

    it.effect("allows pushes to run longer than the default command timeout", () =>
      Effect.gen(function* () {
        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        const pushStarted = yield* Deferred.make<void>();
        const delayedPushSpawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            if (ChildProcess.isStandardCommand(command) && command.args[0] === "push") {
              yield* Deferred.succeed(pushStarted, undefined);
              yield* Effect.sleep("31 seconds");
            }
            return yield* delegate.spawn(command);
          }),
        );
        const core = yield* makeGitCore().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, delayedPushSpawner),
          Effect.provide(ServerConfigLayer),
        );
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);

        const pushing = yield* core
          .pushCurrentBranch(cwd, null)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(pushStarted);
        yield* TestClock.adjust("31 seconds");
        const pushed = yield* Fiber.join(pushing);

        expect(pushed.status).toBe("pushed");
        expect(pushed.setUpstream).toBe(true);
      }),
    );

    it.effect("still ends a push that stalls past the push timeout", () =>
      Effect.gen(function* () {
        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        const pushStarted = yield* Deferred.make<void>();
        const stalledPushSpawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            if (ChildProcess.isStandardCommand(command) && command.args[0] === "push") {
              yield* Deferred.succeed(pushStarted, undefined);
              return yield* Effect.never;
            }
            return yield* delegate.spawn(command);
          }),
        );
        const core = yield* makeGitCore().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, stalledPushSpawner),
          Effect.provide(ServerConfigLayer),
        );
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);

        const pushing = yield* core
          .pushCurrentBranch(cwd, null)
          .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(pushStarted);
        yield* TestClock.adjust("31 minutes");
        const error = yield* Fiber.join(pushing);

        expect(error.detail).toContain("timed out");
      }),
    );

    it.effect("pulls behind branch and then reports up-to-date", () =>
      Effect.gen(function* () {
        const remote = yield* makeTmpDir();
        const source = yield* makeTmpDir();
        const clone = yield* makeTmpDir();
        yield* git(remote, ["init", "--bare"]);

        yield* initRepoWithCommit(source);
        const initialBranch = (yield* (yield* GitCore).listBranches({ cwd: source })).branches.find(
          (branch) => branch.current,
        )!.name;
        yield* git(source, ["remote", "add", "origin", remote]);
        yield* git(source, ["push", "-u", "origin", initialBranch]);

        yield* git(clone, ["clone", remote, "."]);
        yield* git(clone, ["config", "user.email", "test@test.com"]);
        yield* git(clone, ["config", "user.name", "Test"]);
        yield* writeTextFile(path.join(clone, "CHANGELOG.md"), "remote change\n");
        yield* git(clone, ["add", "CHANGELOG.md"]);
        yield* git(clone, ["commit", "-m", "remote update"]);
        yield* git(clone, ["push", "origin", initialBranch]);

        const core = yield* GitCore;
        const pulled = yield* core.pullCurrentBranch(source);
        expect(pulled.status).toBe("pulled");
        expect((yield* core.statusDetails(source)).behindCount).toBe(0);

        const skipped = yield* core.pullCurrentBranch(source);
        expect(skipped.status).toBe("skipped_up_to_date");
      }),
    );

    it.effect("top-level pullGitBranch rejects when no upstream exists", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const result = yield* Effect.result((yield* GitCore).pullCurrentBranch(tmp));
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          expect(result.failure.message.toLowerCase()).toContain("no upstream");
        }
      }),
    );

    it.effect("lists branches when recency lookup fails", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const realGitCore = yield* GitCore;
        let didFailRecency = false;
        const core = yield* makeIsolatedGitCore((input) => {
          if (!didFailRecency && input.args[0] === "for-each-ref") {
            didFailRecency = true;
            return Effect.fail(
              new GitCommandError({
                operation: "git.test.listBranchesRecency",
                command: `git ${input.args.join(" ")}`,
                cwd: input.cwd,
                detail: "timeout",
              }),
            );
          }
          return realGitCore.execute(input);
        });

        const result = yield* core.listBranches({ cwd: tmp });

        expect(result.isRepo).toBe(true);
        expect(result.branches.length).toBeGreaterThan(0);
        expect(result.branches[0]?.current).toBe(true);
        expect(didFailRecency).toBe(true);
      }),
    );

    it.effect("falls back to empty remote branch data when remote lookups fail", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const remote = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* git(remote, ["init", "--bare"]);
        yield* git(tmp, ["remote", "add", "origin", remote]);

        const realGitCore = yield* GitCore;
        let didFailRemoteBranches = false;
        let didFailRemoteNames = false;
        const core = yield* makeIsolatedGitCore((input) => {
          if (input.args.join(" ") === "branch --no-color --no-column --remotes") {
            didFailRemoteBranches = true;
            return Effect.fail(
              new GitCommandError({
                operation: "git.test.listBranchesRemoteBranches",
                command: `git ${input.args.join(" ")}`,
                cwd: input.cwd,
                detail: "remote unavailable",
              }),
            );
          }
          if (input.args.join(" ") === "remote") {
            didFailRemoteNames = true;
            return Effect.fail(
              new GitCommandError({
                operation: "git.test.listBranchesRemoteNames",
                command: `git ${input.args.join(" ")}`,
                cwd: input.cwd,
                detail: "remote unavailable",
              }),
            );
          }
          return realGitCore.execute(input);
        });

        const result = yield* core.listBranches({ cwd: tmp });

        expect(result.isRepo).toBe(true);
        expect(result.branches.length).toBeGreaterThan(0);
        expect(result.branches.every((branch) => !branch.isRemote)).toBe(true);
        expect(didFailRemoteBranches).toBe(true);
        expect(didFailRemoteNames).toBe(true);
      }),
    );
  });
});

function isWorktreeAdd(args: readonly string[]): boolean {
  return args.some((arg, index) => arg === "worktree" && args[index + 1] === "add");
}

describe("alignBranchParentCasing", () => {
  it("reuses the casing on disk for each parent segment", () => {
    expect(alignBranchParentCasing("Team/foo", ["team/bar"])).toBe("team/foo");
    expect(alignBranchParentCasing("Team/Sub/foo", ["team/sub/bar"])).toBe("team/sub/foo");
    expect(alignBranchParentCasing("Team/Sub/foo", ["team/other"])).toBe("team/Sub/foo");
  });

  it("leaves a name with no matching parent, and never touches its last segment", () => {
    expect(alignBranchParentCasing("Team/foo", ["other/bar"])).toBe("Team/foo");
    expect(alignBranchParentCasing("Team", ["team/bar"])).toBe("Team");
  });
});

describe("isBranchNameTakenIgnoringCase", () => {
  it("finds the same name in any casing", () => {
    expect(isBranchNameTakenIgnoringCase("proj/Add", ["proj/add"])).toBe(true);
    expect(isBranchNameTakenIgnoringCase("proj/add", ["proj/add"])).toBe(true);
  });

  it("finds a branch nested under the name in any casing", () => {
    expect(isBranchNameTakenIgnoringCase("Team", ["team/bar"])).toBe(true);
    expect(isBranchNameTakenIgnoringCase("team/Sub", ["Team/sub/bar"])).toBe(true);
  });

  it("does not treat a shared word as a clash", () => {
    expect(isBranchNameTakenIgnoringCase("Team", ["teamwork", "team-1"])).toBe(false);
    expect(isBranchNameTakenIgnoringCase("team/foo", ["team/foo-1", "team"])).toBe(false);
    expect(isBranchNameTakenIgnoringCase("Team-1", [])).toBe(false);
  });
});

describe("GitCore execute timeout", () => {
  // Live clock: the command timeout and kill escalation must actually elapse.
  it.live.skipIf(process.platform === "win32")(
    "execute force-kills a git child that ignores SIGTERM once the timeout fires",
    () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const core = yield* GitCore;
        const startedAt = Date.now();
        const error = yield* core
          .execute({
            operation: "GitCore.test.hang",
            cwd: tmp,
            // git forwards SIGTERM to a shell alias and waits for it, so the alias ignoring it hangs git too.
            args: ["-c", "alias.hang=!trap '' TERM; sleep 30", "hang"],
            timeoutMs: 300,
          })
          .pipe(Effect.flip);
        expect(error.detail).toContain("timed out");
        expect(Date.now() - startedAt).toBeLessThan(10_000);
      }).pipe(Effect.scoped, Effect.provide(TestLayer)),
    20_000,
  );
});

describe("GitCore output collection", () => {
  // One byte per chunk splits every multibyte character and CRLF across reads.
  const byteChunks = (text: string) =>
    Stream.fromIterable(Array.from(new TextEncoder().encode(text), (byte) => Uint8Array.of(byte)));
  const makeCoreWithOutput = (output: { stdout: string; stderr: string }) =>
    makeGitCore().pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.succeed(
            ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(1),
              exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
              isRunning: Effect.succeed(false),
              kill: () => Effect.void,
              stdin: Sink.drain,
              stdout: byteChunks(output.stdout),
              stderr: byteChunks(output.stderr),
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            }),
          ),
        ),
      ),
      Effect.provide(Layer.provideMerge(ServerConfigLayer, NodeServices.layer)),
    );

  it.effect("returns the same split UTF-8 output with and without line callbacks", () =>
    Effect.gen(function* () {
      const stdout = "a\\b\0雪\nlast ";
      const stderr = "Receiving é\r\nUpdating 雪\ndone";
      const core = yield* makeCoreWithOutput({ stdout, stderr });
      const input = { operation: "GitCore.test.chunkedOutput", cwd: "/repo", args: ["status"] };
      const expected = {
        code: 0,
        stdout,
        stderr,
        stdoutTruncated: false,
        stderrTruncated: false,
      };

      expect(yield* core.execute(input)).toEqual(expected);

      const stdoutLines: string[] = [];
      const stderrLines: string[] = [];
      const withCallbacks = yield* core.execute({
        ...input,
        progress: {
          onStdoutLine: (line) => Effect.sync(() => void stdoutLines.push(line)),
          onStderrLine: (line) => Effect.sync(() => void stderrLines.push(line)),
        },
      });
      expect(withCallbacks).toEqual(expected);
      expect(stdoutLines).toEqual(["a\\b\0雪", "last "]);
      expect(stderrLines).toEqual(["Receiving é", "Updating 雪", "done"]);
    }),
  );

  it.effect("treats a bare carriage return as a line break for line callbacks", () =>
    Effect.gen(function* () {
      const stderr = "a\rb\nUpdating files:  50% (1/2)\rUpdating files: 100% (2/2), done.\r\nend";
      const core = yield* makeCoreWithOutput({ stdout: "", stderr });
      const lines: string[] = [];
      const result = yield* core.execute({
        operation: "GitCore.test.carriageReturns",
        cwd: "/repo",
        args: ["status"],
        progress: { onStderrLine: (line) => Effect.sync(() => void lines.push(line)) },
      });

      expect(lines).toEqual([
        "a",
        "b",
        "Updating files:  50% (1/2)",
        "Updating files: 100% (2/2), done.",
        "end",
      ]);
      expect(result.stderr).toBe(stderr);
    }),
  );

  it.effect("caps output without line callbacks", () =>
    Effect.gen(function* () {
      const core = yield* makeCoreWithOutput({ stdout: "", stderr: "é雪\rdone" });
      const input = {
        operation: "GitCore.test.cappedOutput",
        cwd: "/repo",
        args: ["status"],
        maxOutputBytes: 3,
      };

      const truncated = yield* core.execute({ ...input, truncateOutputAtMaxBytes: true });
      expect(truncated).toMatchObject({
        code: 0,
        stderr: "é\uFFFD",
        stdoutTruncated: false,
        stderrTruncated: true,
      });

      const error = yield* core.execute(input).pipe(Effect.flip);
      expect(error.detail).toContain("exceeded 3 bytes");
    }),
  );
});

describe("GitCore spawn failures", () => {
  it.effect("maps a synchronous spawn throw to a GitCommandError", () =>
    Effect.gen(function* () {
      const tmp = yield* makeTmpDir();
      // A cwd that is a regular file makes Node's spawn throw ENOTDIR synchronously.
      const filePath = path.join(tmp, "not-a-directory");
      yield* writeTextFile(filePath, "x");

      const error = yield* (yield* GitCore)
        .execute({ operation: "GitCore.test.spawnThrow", cwd: filePath, args: ["status"] })
        .pipe(Effect.flip);

      expect(error).toBeInstanceOf(GitCommandError);
      expect(error.detail).toContain("failed to spawn.");
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});

describe("GitCore process concurrency", () => {
  it.effect("caps concurrent short git commands while push bypasses the cap", () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>();
      let inFlight = 0;
      let maxInFlight = 0;
      const core = yield* makeIsolatedGitCore((input) =>
        Effect.gen(function* () {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          if (input.args[0] !== "push") yield* Deferred.await(release);
          inFlight -= 1;
          return {
            code: 0,
            stdout: "",
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          };
        }),
      );
      const statusCalls = yield* Effect.forEach(
        Array.from({ length: 20 }, (_, index) => index),
        (index) =>
          core
            .execute({ operation: `GitCore.test.status.${index}`, cwd: "/repo", args: ["status"] })
            .pipe(Effect.forkChild),
      );
      yield* Effect.yieldNow;
      expect(maxInFlight).toBe(8);

      // A push neither waits for a permit nor takes one.
      yield* core.execute({
        operation: "GitCore.test.push",
        cwd: "/repo",
        args: ["push", "origin", "HEAD"],
        timeoutMs: null,
      });
      expect(maxInFlight).toBe(9);

      yield* Deferred.succeed(release, undefined);
      yield* Effect.forEach(statusCalls, Fiber.join, { discard: true });
      expect(maxInFlight).toBe(9);
      expect(inFlight).toBe(0);
    }),
  );
});

describe("GitCore process concurrency with real timeouts", () => {
  it.effect("does not count time queued for a permit toward a command's timeout", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      let started = 0;
      const gatedSpawner = ChildProcessSpawner.make((command) =>
        Effect.sync(() => {
          const isPush = ChildProcess.isStandardCommand(command) && command.args[0] === "push";
          started += 1;
          return ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(started),
            exitCode: (isPush ? Effect.void : Deferred.await(gate)).pipe(
              Effect.as(ChildProcessSpawner.ExitCode(0)),
            ),
            isRunning: Effect.succeed(true),
            kill: () => Effect.void,
            stdin: Sink.drain,
            stdout: Stream.empty,
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          });
        }),
      );
      const core = yield* makeGitCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, gatedSpawner),
        Effect.provide(Layer.provideMerge(ServerConfigLayer, NodeServices.layer)),
      );
      const commands = yield* Effect.forEach(
        Array.from({ length: 16 }, (_, index) => index),
        (index) =>
          core
            .execute({
              operation: `GitCore.test.queued.${index}`,
              cwd: "/repo",
              args: ["status"],
              // The first eight hold every permit; the rest queue with a short timeout.
              ...(index < 8 ? {} : { timeoutMs: 1_000 }),
            })
            .pipe(Effect.forkChild),
      );
      yield* Effect.yieldNow;
      yield* TestClock.adjust("2 seconds");
      expect(started).toBe(8);
      for (const fiber of commands) expect(fiber.pollUnsafe()).toBeUndefined();

      // A push with the default timeout bypasses the cap by name.
      const pushed = yield* core.execute({
        operation: "GitCore.test.push",
        cwd: "/repo",
        args: ["push", "origin", "HEAD"],
      });
      expect(pushed.code).toBe(0);
      expect(started).toBe(9);

      yield* Deferred.succeed(gate, undefined);
      const results = yield* Effect.forEach(commands, Fiber.join);
      expect(results.every((result) => result.code === 0)).toBe(true);
      expect(started).toBe(17);
    }),
  );
});

describe("GitCore Windows long paths", () => {
  const readGitConfig = (platform: NodeJS.Platform, key: string) =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir("git-longpath-test-");
      const core = yield* makeGitCore({ platform }).pipe(Effect.provide(ServerConfigLayer));
      const result = yield* core.execute({
        operation: "GitCore.test.readGitConfig",
        cwd,
        args: ["config", "--get", key],
        allowNonZeroExit: true,
        // Entry 2 sits past the count and must stay unread.
        env: {
          GIT_CONFIG_COUNT: "2",
          GIT_CONFIG_KEY_0: "user.name",
          GIT_CONFIG_VALUE_0: "inherited-name",
          GIT_CONFIG_KEY_1: "core.longpaths",
          GIT_CONFIG_VALUE_1: "false",
          GIT_CONFIG_KEY_2: "user.name",
          GIT_CONFIG_VALUE_2: "outside-count",
        },
      });
      return result.stdout.trim();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

  it.effect("enables core.longpaths for every git command on Windows", () =>
    Effect.gen(function* () {
      expect(yield* readGitConfig("win32", "core.longpaths")).toBe("true");
      expect(yield* readGitConfig("win32", "user.name")).toBe("inherited-name");
    }),
  );

  it.effect("leaves git config untouched on other platforms", () =>
    Effect.gen(function* () {
      expect(yield* readGitConfig("linux", "core.longpaths")).toBe("false");
      expect(yield* readGitConfig("linux", "user.name")).toBe("inherited-name");
    }),
  );
});

const makeGitCoreWithSettings = (
  overrides: DeepPartial<ServerSettings>,
  executeOverride?: GitCoreShape["execute"],
) =>
  makeGitCore(executeOverride ? { executeOverride } : undefined).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.provideMerge(ServerConfigLayer, NodeServices.layer),
        ServerSettingsService.layerTest(overrides),
      ),
    ),
  );

const okResult = (stdout = "") =>
  Effect.succeed({ code: 0, stdout, stderr: "", stdoutTruncated: false, stderrTruncated: false });

/** Fake repository whose branch tracks origin; `onFetch` answers the background status fetch. */
const statusFetchFake =
  (onFetch: () => Effect.Effect<void>): GitCoreShape["execute"] =>
  (input) => {
    if (input.args[0] === "symbolic-ref") return okResult("refs/heads/main\n");
    if (input.args[0] === "for-each-ref" && input.args[1] === "--format=%(upstream:remotename)") {
      return okResult("origin\n");
    }
    if (input.args[0] === "rev-parse" && input.args[1] === "--git-common-dir") {
      return okResult("/repo/.git\n");
    }
    if (input.args[0] === "--git-dir" && input.args[2] === "fetch") {
      return onFetch().pipe(Effect.andThen(okResult()));
    }
    if (input.operation === "GitCore.statusDetails.status") {
      return okResult("# branch.head main\0# branch.upstream origin/main\0# branch.ab +0 -0\0");
    }
    if (input.operation === "GitCore.statusDetails.defaultRef") {
      return okResult("refs/remotes/origin/main\n");
    }
    return okResult();
  };

describe("GitCore commit context", () => {
  it.effect("skips the staged patch when the commit message is already written", () =>
    Effect.gen(function* () {
      const tmp = yield* makeTmpDir();
      yield* initRepoWithCommit(tmp);
      yield* writeTextFile(path.join(tmp, "a.txt"), "file a\n");
      const realGitCore = yield* GitCore;
      const operations: string[] = [];
      const core = yield* makeIsolatedGitCore((input) => {
        operations.push(input.operation);
        return realGitCore.execute(input);
      });

      const context = yield* core.prepareCommitContext(tmp, undefined, { includePatch: false });
      expect(context).toEqual({ stagedSummary: "A\ta.txt", stagedPatch: "" });
      expect(operations).not.toContain("GitCore.prepareCommitContext.stagedPatch");

      const withPatch = yield* core.prepareCommitContext(tmp);
      expect(withPatch?.stagedPatch).toContain("+file a");
      expect(operations).toContain("GitCore.prepareCommitContext.stagedPatch");
    }).pipe(Effect.provide(TestLayer)),
  );
});

describe("GitCore diffPreview", () => {
  const commitFile = (cwd: string, name: string) =>
    Effect.gen(function* () {
      yield* writeTextFile(path.join(cwd, name), `${name}\n`);
      yield* git(cwd, ["add", "--", name]);
      yield* git(cwd, ["commit", "-m", name]);
    });

  it.effect("prefers the base recorded on the branch over the default branch", () =>
    Effect.gen(function* () {
      const tmp = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(tmp);
      yield* git(tmp, ["checkout", "-b", "develop"]);
      yield* commitFile(tmp, "develop.txt");
      yield* git(tmp, ["checkout", "-b", "feature"]);
      yield* commitFile(tmp, "feature.txt");
      yield* git(tmp, ["config", "branch.feature.gh-merge-base", "develop"]);
      expect(initialBranch).not.toBe("develop");

      const result = yield* (yield* GitCore).diffPreview({ cwd: tmp, scope: "branch" });

      expect(result.baseRef).toBe("develop");
      expect(result.diff).toContain("b/feature.txt");
      expect(result.diff).not.toContain("develop.txt");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("compares with the remote default when no local default branch exists", () =>
    Effect.gen(function* () {
      const remote = yield* makeTmpDir("git-diff-preview-remote-");
      yield* git(remote, ["init", "--bare"]);
      const tmp = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(tmp);
      yield* git(tmp, ["remote", "add", "origin", remote]);
      yield* git(tmp, ["push", "-u", "origin", initialBranch]);
      yield* git(tmp, ["remote", "set-head", "origin", initialBranch]);
      yield* git(tmp, ["checkout", "-b", "feature"]);
      yield* git(tmp, ["branch", "-D", initialBranch]);
      yield* commitFile(tmp, "feature.txt");

      const result = yield* (yield* GitCore).diffPreview({ cwd: tmp, scope: "branch" });

      expect(result.baseRef).toBe(`origin/${initialBranch}`);
      expect(result.diff).toContain("b/feature.txt");
      expect(result.diff).not.toContain("README.md");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("has no base on a default branch with no remote, and for a detached HEAD uses it", () =>
    Effect.gen(function* () {
      const tmp = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(tmp);
      yield* writeTextFile(path.join(tmp, "dirty.txt"), "dirty\n");
      const core = yield* GitCore;

      const onDefault = yield* core.diffPreview({ cwd: tmp, scope: "branch" });
      expect(onDefault.baseRef).toBeNull();
      expect(onDefault.diff).toContain("b/dirty.txt");

      yield* git(tmp, ["checkout", "-b", "feature"]);
      yield* commitFile(tmp, "feature.txt");
      yield* git(tmp, ["checkout", "--detach"]);
      const detached = yield* core.diffPreview({ cwd: tmp, scope: "branch" });
      expect(detached.baseRef).toBe(initialBranch);
      expect(detached.diff).toContain("b/feature.txt");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("reads a linked worktree from a subfolder without touching its index", () =>
    Effect.gen(function* () {
      const tmp = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(tmp);
      yield* writeTextFile(path.join(tmp, "main-dirty.txt"), "not in the worktree\n");
      const core = yield* GitCore;
      const wtPath = path.join(yield* makeTmpDir("git-worktrees-"), "linked");
      yield* core.createWorktree({
        cwd: tmp,
        branch: initialBranch,
        newBranch: "linked",
        path: wtPath,
      });
      const subfolder = path.join(wtPath, "sub");
      mkdirSync(subfolder);
      yield* writeTextFile(path.join(subfolder, "untracked.txt"), "untracked\n");
      yield* writeTextFile(path.join(subfolder, "staged.txt"), "staged\n");
      yield* git(wtPath, ["add", "--", "sub/staged.txt"]);
      const indexPath = yield* git(wtPath, [
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "index",
      ]);
      const indexBefore = readFileSync(indexPath);
      const statusBefore = yield* git(wtPath, ["status", "--porcelain"]);

      const result = yield* core.diffPreview({ cwd: subfolder, scope: "uncommitted" });

      expect(result.diff).toContain("diff --git a/sub/untracked.txt b/sub/untracked.txt");
      expect(result.diff).toContain("diff --git a/sub/staged.txt b/sub/staged.txt");
      expect(result.diff).not.toContain("main-dirty.txt");
      expect(readFileSync(indexPath).equals(indexBefore)).toBe(true);
      expect(yield* git(wtPath, ["status", "--porcelain"])).toBe(statusBefore);
      yield* core.removeWorktree({ cwd: tmp, path: wtPath, force: true });
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("keeps non-ASCII paths unquoted whatever the repository configures", () =>
    Effect.gen(function* () {
      const tmp = yield* makeTmpDir();
      yield* initRepoWithCommit(tmp);
      yield* git(tmp, ["config", "core.quotePath", "true"]);
      const name = "caf\u00e9 \u65e5\u672c\u8a9e.txt";
      yield* writeTextFile(path.join(tmp, name), "hello\n");

      const result = yield* (yield* GitCore).diffPreview({ cwd: tmp, scope: "uncommitted" });

      expect(result.diff).toContain(`diff --git a/${name} b/${name}`);
      expect(result.diff).not.toContain("\\303");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("fails as a git error outside a repository", () =>
    Effect.gen(function* () {
      const tmp = yield* makeTmpDir();
      const error = yield* (yield* GitCore)
        .diffPreview({ cwd: tmp, scope: "uncommitted" })
        .pipe(Effect.flip);
      expect(error._tag).toBe("GitCommandError");
    }).pipe(Effect.provide(TestLayer)),
  );
});

describe("GitCore worktree settings", () => {
  const allowFileSubmodules = () => {
    // Local-path submodules need protocol.file.allow, also for the clone `submodule update` spawns.
    vi.stubEnv("GIT_CONFIG_COUNT", "1");
    vi.stubEnv("GIT_CONFIG_KEY_0", "protocol.file.allow");
    vi.stubEnv("GIT_CONFIG_VALUE_0", "always");
  };

  const makeRepoWithSubmodule = Effect.gen(function* () {
    const sub = yield* makeTmpDir("git-sub-");
    const repo = yield* makeTmpDir("git-super-");
    yield* initRepoWithCommit(sub);
    const { initialBranch } = yield* initRepoWithCommit(repo);
    yield* git(repo, ["submodule", "add", sub, "libs/sub"]);
    yield* git(repo, ["commit", "-m", "add submodule"]);
    return { repo, initialBranch };
  });

  it.effect("checks out submodules in new worktrees unless the setting turns it off", () =>
    Effect.gen(function* () {
      allowFileSubmodules();
      const { repo, initialBranch } = yield* makeRepoWithSubmodule;

      const recursivePath = path.join(repo, "..", `${path.basename(repo)}-wt-recursive`);
      yield* (yield* GitCore).createWorktree({
        cwd: repo,
        branch: initialBranch,
        newBranch: "wt-recursive",
        path: recursivePath,
      });
      expect(existsSync(path.join(recursivePath, "libs/sub/README.md"))).toBe(true);

      const noneCore = yield* makeGitCoreWithSettings({ worktreeSubmodules: "none" });
      const nonePath = path.join(repo, "..", `${path.basename(repo)}-wt-none`);
      yield* noneCore.createWorktree({
        cwd: repo,
        branch: initialBranch,
        newBranch: "wt-none",
        path: nonePath,
      });
      expect(existsSync(path.join(nonePath, "libs/sub/README.md"))).toBe(false);

      yield* (yield* GitCore).removeWorktree({ cwd: repo, path: recursivePath, force: true });
      yield* (yield* GitCore).removeWorktree({ cwd: repo, path: nonePath, force: true });
    }).pipe(Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())), Effect.provide(TestLayer)),
  );

  it.effect("still creates the worktree when the submodule checkout fails", () =>
    Effect.gen(function* () {
      allowFileSubmodules();
      const { repo, initialBranch } = yield* makeRepoWithSubmodule;
      yield* git(repo, ["config", "submodule.libs/sub.url", path.join(repo, "missing-remote")]);

      const worktreePath = path.join(repo, "..", `${path.basename(repo)}-wt-broken`);
      const result = yield* (yield* GitCore).createWorktree({
        cwd: repo,
        branch: initialBranch,
        newBranch: "wt-broken",
        path: worktreePath,
      });
      expect(result.worktree.path).toBe(worktreePath);
      expect(existsSync(path.join(worktreePath, "README.md"))).toBe(true);
      expect(existsSync(path.join(worktreePath, "libs/sub/README.md"))).toBe(false);
      yield* (yield* GitCore).removeWorktree({ cwd: repo, path: worktreePath, force: true });
    }).pipe(Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())), Effect.provide(TestLayer)),
  );

  it.effect("checks out only top-level submodules when the setting says so", () =>
    Effect.gen(function* () {
      allowFileSubmodules();
      const { repo, initialBranch } = yield* makeRepoWithSubmodule;
      const realGitCore = yield* GitCore;
      const submoduleArgs: string[][] = [];
      const core = yield* makeGitCoreWithSettings({ worktreeSubmodules: "top-level" }, (input) => {
        if (input.operation === "GitCore.createWorktree.updateSubmodules") {
          submoduleArgs.push([...input.args]);
        }
        return realGitCore.execute(input);
      });

      const worktreePath = path.join(repo, "..", `${path.basename(repo)}-wt-top`);
      yield* core.createWorktree({
        cwd: repo,
        branch: initialBranch,
        newBranch: "wt-top",
        path: worktreePath,
      });
      expect(submoduleArgs).toEqual([["submodule", "update", "--init"]]);
      expect(existsSync(path.join(worktreePath, "libs/sub/README.md"))).toBe(true);
      yield* realGitCore.removeWorktree({ cwd: repo, path: worktreePath, force: true });
    }).pipe(Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())), Effect.provide(TestLayer)),
  );

  it.effect("removes the worktree and branch when interrupted during the submodule step", () =>
    Effect.gen(function* () {
      allowFileSubmodules();
      const { repo, initialBranch } = yield* makeRepoWithSubmodule;
      const realGitCore = yield* GitCore;
      const started = yield* Deferred.make<void>();
      const core = yield* makeGitCoreWithSettings({ worktreeSubmodules: "top-level" }, (input) =>
        input.operation === "GitCore.createWorktree.updateSubmodules"
          ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
          : realGitCore.execute(input),
      );
      const worktreePath = path.join(repo, "..", `${path.basename(repo)}-wt-stopped`);

      const creating = yield* core
        .createWorktree({
          cwd: repo,
          branch: initialBranch,
          newBranch: "wt-stopped",
          path: worktreePath,
        })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(started);
      yield* Fiber.interrupt(creating);
      const exit = yield* Fiber.await(creating);

      expect(Exit.hasInterrupts(exit)).toBe(true);
      expect(existsSync(worktreePath)).toBe(false);
      expect(yield* git(repo, ["branch", "--list", "wt-stopped"])).toBe("");
    }).pipe(Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())), Effect.provide(TestLayer)),
  );

  it.effect("refuses a worktree location that would nest worktrees inside the repository", () =>
    Effect.gen(function* () {
      const repo = yield* makeTmpDir("git-nested-");
      const { initialBranch } = yield* initRepoWithCommit(repo);

      const core = yield* makeGitCoreWithSettings({ worktreesDirectory: path.dirname(repo) });
      const error = yield* core
        .createWorktree({ cwd: repo, branch: initialBranch, newBranch: "nested", path: null })
        .pipe(Effect.flip);
      expect(error.detail).toContain("inside the repository");
      expect(error.detail).toContain("Settings > Git > Worktree location");
      expect(existsSync(path.join(repo, "nested"))).toBe(false);
      expect(yield* git(repo, ["branch", "--list", "nested"])).toBe("");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("creates worktrees under the configured location and rejects invalid ones", () =>
    Effect.gen(function* () {
      const repo = yield* makeTmpDir("git-location-");
      const location = yield* makeTmpDir("git-location-root-");
      const { initialBranch } = yield* initRepoWithCommit(repo);

      const core = yield* makeGitCoreWithSettings({ worktreesDirectory: location });
      const result = yield* core.createWorktree({
        cwd: repo,
        branch: initialBranch,
        newBranch: "located",
        path: null,
      });
      expect(path.dirname(result.worktree.path)).toBe(path.join(location, path.basename(repo)));
      expect(path.basename(result.worktree.path)).toMatch(/^located-[a-f0-9]{16}$/);
      expect(existsSync(path.join(result.worktree.path, "README.md"))).toBe(true);
      yield* core.removeWorktree({ cwd: repo, path: result.worktree.path, force: true });

      const invalidCore = yield* makeGitCoreWithSettings({ worktreesDirectory: "relative/dir" });
      const error = yield* invalidCore
        .createWorktree({ cwd: repo, branch: initialBranch, newBranch: "nowhere", path: null })
        .pipe(Effect.flip);
      expect(error.detail).toContain("Settings > Git > Worktree location");
      expect(yield* git(repo, ["branch", "--list", "nowhere"])).toBe("");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("starts new worktrees from the fetched remote branch when enabled", () =>
    Effect.gen(function* () {
      const remote = yield* makeTmpDir("git-origin-remote-");
      const repo = yield* makeTmpDir("git-origin-local-");
      const peer = yield* makeTmpDir("git-origin-peer-");
      yield* git(remote, ["init", "--bare"]);
      const { initialBranch } = yield* initRepoWithCommit(repo);
      yield* git(repo, ["remote", "add", "origin", remote]);
      yield* git(repo, ["push", "-u", "origin", initialBranch]);
      const localSha = yield* git(repo, ["rev-parse", "HEAD"]);

      yield* git(peer, ["clone", remote, "."]);
      yield* git(peer, ["config", "user.email", "peer@test.com"]);
      yield* git(peer, ["config", "user.name", "Peer"]);
      yield* writeTextFile(path.join(peer, "remote.txt"), "remote\n");
      yield* git(peer, ["add", "remote.txt"]);
      yield* git(peer, ["commit", "-m", "remote commit"]);
      yield* git(peer, ["push", "origin", `HEAD:${initialBranch}`]);
      const remoteSha = yield* git(peer, ["rev-parse", "HEAD"]);

      const core = yield* makeGitCoreWithSettings({ newWorktreesStartFromOrigin: true });
      const freshPath = path.join(repo, "..", `${path.basename(repo)}-wt-fresh`);
      yield* core.createWorktree({
        cwd: repo,
        branch: initialBranch,
        newBranch: "feature/fresh",
        path: freshPath,
      });
      expect(yield* git(freshPath, ["rev-parse", "HEAD"])).toBe(remoteSha);
      expect(yield* git(repo, ["config", "branch.feature/fresh.gh-merge-base"])).toBe(
        initialBranch,
      );
      expect(yield* git(repo, ["rev-parse", initialBranch])).toBe(localSha);

      // Offline: falls back to the local base instead of failing the thread.
      yield* git(repo, ["remote", "set-url", "origin", path.join(remote, "missing")]);
      yield* git(repo, ["update-ref", `refs/remotes/origin/${initialBranch}`, localSha]);
      const offlinePath = path.join(repo, "..", `${path.basename(repo)}-wt-offline`);
      yield* core.createWorktree({
        cwd: repo,
        branch: initialBranch,
        newBranch: "feature/offline",
        path: offlinePath,
      });
      expect(yield* git(offlinePath, ["rev-parse", "HEAD"])).toBe(localSha);

      yield* core.removeWorktree({ cwd: repo, path: freshPath, force: true });
      yield* core.removeWorktree({ cwd: repo, path: offlinePath, force: true });
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("starts from the remote the base branch tracks, not the primary remote", () =>
    Effect.gen(function* () {
      const origin = yield* makeTmpDir("git-tracked-origin-");
      const upstream = yield* makeTmpDir("git-tracked-upstream-");
      const repo = yield* makeTmpDir("git-tracked-local-");
      const peer = yield* makeTmpDir("git-tracked-peer-");
      yield* git(origin, ["init", "--bare"]);
      yield* git(upstream, ["init", "--bare"]);
      const { initialBranch } = yield* initRepoWithCommit(repo);
      yield* git(repo, ["remote", "add", "origin", origin]);
      yield* git(repo, ["remote", "add", "upstream", upstream]);
      yield* git(repo, ["push", "origin", initialBranch]);
      yield* git(repo, ["push", "-u", "upstream", initialBranch]);

      yield* git(peer, ["clone", upstream, "."]);
      yield* git(peer, ["config", "user.email", "peer@test.com"]);
      yield* git(peer, ["config", "user.name", "Peer"]);
      yield* writeTextFile(path.join(peer, "upstream.txt"), "upstream\n");
      yield* git(peer, ["add", "upstream.txt"]);
      yield* git(peer, ["commit", "-m", "upstream commit"]);
      yield* git(peer, ["push", "origin", `HEAD:${initialBranch}`]);
      const upstreamSha = yield* git(peer, ["rev-parse", "HEAD"]);

      const core = yield* makeGitCoreWithSettings({ newWorktreesStartFromOrigin: true });
      const worktreePath = path.join(repo, "..", `${path.basename(repo)}-wt-tracked`);
      yield* core.createWorktree({
        cwd: repo,
        branch: initialBranch,
        newBranch: "feature/tracked",
        path: worktreePath,
      });
      expect(yield* git(worktreePath, ["rev-parse", "HEAD"])).toBe(upstreamSha);
      yield* core.removeWorktree({ cwd: repo, path: worktreePath, force: true });
    }).pipe(Effect.provide(TestLayer)),
  );
});

describe("GitCore background fetch", () => {
  it.effect("reads local refs only when a status skips the upstream refresh", () =>
    Effect.gen(function* () {
      let fetchCount = 0;
      const core = yield* makeGitCoreWithSettings(
        { automaticGitFetchIntervalMs: 60_000 },
        statusFetchFake(() => Effect.sync(() => void (fetchCount += 1))),
      );

      const passive = yield* core.statusDetails("/repo", { skipUpstreamRefresh: true });
      expect(passive.upstreamRef).toBe("origin/main");
      yield* core.status({ cwd: "/repo", refreshUpstream: false });
      expect(fetchCount).toBe(0);

      yield* core.statusDetails("/repo");
      expect(fetchCount).toBe(1);
    }),
  );

  it.effect("a passive read does not wait for a normal read's in-flight fetch", () =>
    Effect.gen(function* () {
      let fetchCount = 0;
      const fetchStarted = yield* Deferred.make<void>();
      const releaseFetch = yield* Deferred.make<void>();
      const core = yield* makeGitCoreWithSettings(
        { automaticGitFetchIntervalMs: 60_000 },
        statusFetchFake(() =>
          Effect.gen(function* () {
            fetchCount += 1;
            yield* Deferred.succeed(fetchStarted, undefined);
            yield* Deferred.await(releaseFetch);
          }),
        ),
      );

      const normal = yield* core
        .statusDetails("/repo")
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(fetchStarted);

      // Would hang until the test timeout if a passive read joined the stalled fetch.
      const passive = yield* Effect.all(
        Array.from({ length: 3 }, () => core.statusDetails("/repo", { skipUpstreamRefresh: true })),
        { concurrency: "unbounded" },
      );
      expect(passive.map((details) => details.upstreamRef)).toEqual(
        Array.from({ length: 3 }, () => "origin/main"),
      );
      expect(fetchCount).toBe(1);

      yield* Deferred.succeed(releaseFetch, undefined);
      expect((yield* Fiber.join(normal)).upstreamRef).toBe("origin/main");
      expect(fetchCount).toBe(1);
    }),
  );

  it.effect("follows the configured fetch interval and never fetches when it is off", () =>
    Effect.gen(function* () {
      let fetchCount = 0;
      const countFetch = () => Effect.sync(() => void (fetchCount += 1));

      const offCore = yield* makeGitCoreWithSettings(
        { automaticGitFetchIntervalMs: 0 },
        statusFetchFake(countFetch),
      );
      const status = yield* offCore.statusDetails("/repo");
      expect(status.upstreamRef).toBe("origin/main");
      expect(fetchCount).toBe(0);

      const minuteCore = yield* makeGitCoreWithSettings(
        { automaticGitFetchIntervalMs: 60_000 },
        statusFetchFake(countFetch),
      );
      yield* minuteCore.statusDetails("/repo");
      expect(fetchCount).toBe(1);
      yield* TestClock.adjust("30 seconds");
      yield* minuteCore.statusDetails("/repo");
      expect(fetchCount).toBe(1);
      yield* TestClock.adjust("31 seconds");
      yield* minuteCore.statusDetails("/repo");
      expect(fetchCount).toBe(2);
    }),
  );

  it.effect("waits at least the configured interval after a failed fetch", () =>
    Effect.gen(function* () {
      let fetchCount = 0;
      const succeeding = statusFetchFake(() => Effect.void);
      const core = yield* makeGitCoreWithSettings(
        { automaticGitFetchIntervalMs: 3_600_000 },
        (input) => {
          if (input.args[0] === "--git-dir" && input.args[2] === "fetch") {
            fetchCount += 1;
            return Effect.succeed({
              code: 128,
              stdout: "",
              stderr: "fatal: unable to access remote\n",
              stdoutTruncated: false,
              stderrTruncated: false,
            });
          }
          return succeeding(input);
        },
      );

      yield* core.statusDetails("/repo");
      expect(fetchCount).toBe(1);
      // Past the 15 minute backoff cap, but inside the hour the user configured.
      yield* TestClock.adjust("31 minutes");
      yield* core.statusDetails("/repo");
      expect(fetchCount).toBe(1);
      yield* TestClock.adjust("30 minutes");
      yield* core.statusDetails("/repo");
      expect(fetchCount).toBe(2);
    }),
  );

  it.effect("reruns a ref-locked fetch only after the background status fetch finishes", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      let statusFetchDone = false;
      const branchFetches: boolean[] = [];
      const fake = statusFetchFake(() =>
        Deferred.await(gate).pipe(Effect.andThen(Effect.sync(() => void (statusFetchDone = true)))),
      );
      const core = yield* makeGitCoreWithSettings(
        { automaticGitFetchIntervalMs: 60_000 },
        (input) => {
          if (input.args[0] !== "fetch") return fake(input);
          branchFetches.push(statusFetchDone);
          const lost = branchFetches.length === 1;
          return Effect.succeed({
            code: lost ? 1 : 0,
            stdout: "",
            stderr: lost ? "error: cannot lock ref 'refs/remotes/origin/main': is at a\n" : "",
            stdoutTruncated: false,
            stderrTruncated: false,
          });
        },
      );

      const polling = yield* core.statusDetails("/repo").pipe(Effect.forkChild);
      yield* TestClock.adjust("3 seconds");
      yield* Fiber.join(polling);
      const fetching = yield* core
        .fetchRemoteBranch({
          cwd: "/repo",
          remoteName: "origin",
          remoteBranch: "feature",
          localBranch: "feature",
        })
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("1 second");
      expect(branchFetches).toEqual([false]);

      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(fetching);
      expect(branchFetches).toEqual([false, true]);
    }),
  );

  it.effect("pull waits a bounded time for a stalled background fetch of its remote", () =>
    Effect.gen(function* () {
      const pulls: string[] = [];
      const fake = statusFetchFake(() => Effect.never);
      const core = yield* makeGitCoreWithSettings(
        { automaticGitFetchIntervalMs: 60_000 },
        (input) => {
          if (input.operation === "GitCore.pullCurrentBranch.pull") pulls.push("pull");
          return fake(input);
        },
      );

      const pull = yield* core.pullCurrentBranch("/repo").pipe(Effect.forkChild);
      yield* TestClock.adjust("3 seconds");
      expect(pulls).toEqual([]);
      yield* TestClock.adjust("20 seconds");
      yield* Fiber.join(pull);
      expect(pulls).toEqual(["pull"]);
    }),
  );

  it.effect("pull does not wait on a background fetch of another remote", () =>
    Effect.gen(function* () {
      const pulls: string[] = [];
      const fake = statusFetchFake(() => Effect.never);
      const core = yield* makeGitCoreWithSettings(
        { automaticGitFetchIntervalMs: 60_000 },
        (input) => {
          if (input.operation === "GitCore.pullCurrentBranch.pull") pulls.push("pull");
          if (input.operation === "GitCore.readBranchRemote") return okResult("fork\n");
          return fake(input);
        },
      );

      const pull = yield* core.pullCurrentBranch("/repo").pipe(Effect.forkChild);
      yield* TestClock.adjust("3 seconds");
      yield* Fiber.join(pull);
      expect(pulls).toEqual(["pull"]);
    }),
  );

  // Live clock: the poll's bounded wait on the fetch must actually elapse.
  it.live(
    "answers status without waiting for a slow fetch, which keeps running and is shared",
    () =>
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>();
        let fetchCount = 0;
        let fetchCompleted = false;
        const core = yield* makeGitCoreWithSettings(
          { automaticGitFetchIntervalMs: 1_000 },
          statusFetchFake(() =>
            Effect.sync(() => void (fetchCount += 1)).pipe(
              Effect.andThen(Deferred.await(gate)),
              Effect.andThen(Effect.sync(() => void (fetchCompleted = true))),
            ),
          ),
        );

        const startedAt = Date.now();
        yield* core.statusDetails("/repo");
        expect(Date.now() - startedAt).toBeLessThan(4_000);
        // The cache entry has expired; the next poll joins the running fetch instead of starting one.
        yield* core.statusDetails("/repo");
        expect(fetchCount).toBe(1);
        expect(fetchCompleted).toBe(false);

        yield* Deferred.succeed(gate, undefined);
        yield* Effect.sleep("50 millis");
        expect(fetchCompleted).toBe(true);
      }).pipe(Effect.scoped),
    20_000,
  );

  it.live(
    "pull waits for a running background fetch of the same repository",
    () =>
      Effect.gen(function* () {
        const remote = yield* makeTmpDir("git-pull-wait-remote-");
        const repo = yield* makeTmpDir("git-pull-wait-local-");
        yield* git(remote, ["init", "--bare"]);
        const { initialBranch } = yield* initRepoWithCommit(repo);
        yield* git(repo, ["remote", "add", "origin", remote]);
        yield* git(repo, ["push", "-u", "origin", initialBranch]);

        const realGitCore = yield* GitCore;
        const fetchStarted = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<void>();
        const events: string[] = [];
        const core = yield* makeIsolatedGitCore((input) => {
          if (input.args[0] === "--git-dir" && input.args[2] === "fetch") {
            return Deferred.succeed(fetchStarted, undefined).pipe(
              Effect.andThen(Deferred.await(gate)),
              Effect.andThen(realGitCore.execute(input)),
              Effect.tap(() => Effect.sync(() => events.push("fetch-done"))),
            );
          }
          if (input.operation === "GitCore.pullCurrentBranch.pull") events.push("pull");
          return realGitCore.execute(input);
        });

        const pull = yield* core.pullCurrentBranch(repo).pipe(Effect.forkChild);
        yield* Deferred.await(fetchStarted);
        yield* Effect.sleep("2500 millis");
        expect(events).toEqual([]);
        yield* Deferred.succeed(gate, undefined);
        const result = yield* Fiber.join(pull);
        expect(result.status).toBe("skipped_up_to_date");
        expect(events).toEqual(["fetch-done", "pull"]);
      }).pipe(Effect.scoped, Effect.provide(TestLayer)),
    20_000,
  );
});

describe("GitCore config lock", () => {
  const holdConfigLock = (cwd: string) => writeTextFile(path.join(cwd, ".git", "config.lock"), "");
  const releaseConfigLockAfter = (cwd: string, delay: Duration.Input) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      yield* Effect.sleep(delay);
      yield* fileSystem.remove(path.join(cwd, ".git", "config.lock"));
    }).pipe(Effect.forkScoped);

  const makeRepoWithRemote = Effect.gen(function* () {
    const tmp = yield* makeTmpDir();
    const remote = yield* makeTmpDir();
    yield* git(tmp, ["init", "--initial-branch=main"]);
    yield* git(tmp, ["config", "user.email", "test@test.com"]);
    yield* git(tmp, ["config", "user.name", "Test"]);
    yield* writeTextFile(path.join(tmp, "README.md"), "hello\n");
    yield* git(tmp, ["add", "README.md"]);
    yield* git(tmp, ["commit", "-m", "initial"]);
    yield* git(remote, ["init", "--bare"]);
    yield* git(tmp, ["remote", "add", "origin", remote]);
    return { tmp, remote };
  });

  // Live clock: the retries wait for another process to release .git/config.lock.
  it.live(
    "records the pushed branch's upstream once a briefly held config lock is released",
    () =>
      Effect.gen(function* () {
        const { tmp } = yield* makeRepoWithRemote;
        yield* git(tmp, ["checkout", "-b", "feature/locked"]);
        yield* holdConfigLock(tmp);
        yield* releaseConfigLockAfter(tmp, "150 millis");

        const pushed = yield* (yield* GitCore).pushCurrentBranch(tmp, null);
        expect(pushed).toMatchObject({ status: "pushed", setUpstream: true });
        expect(yield* git(tmp, ["rev-parse", "--abbrev-ref", "@{upstream}"])).toBe(
          "origin/feature/locked",
        );
      }).pipe(Effect.scoped, Effect.provide(TestLayer)),
    20_000,
  );

  it.live(
    "pushes but reports no upstream when the config stays locked",
    () =>
      Effect.gen(function* () {
        const { tmp, remote } = yield* makeRepoWithRemote;
        yield* git(tmp, ["checkout", "-b", "feature/stuck"]);
        yield* holdConfigLock(tmp);

        const pushed = yield* (yield* GitCore).pushCurrentBranch(tmp, null);
        expect(pushed).toMatchObject({ status: "pushed", setUpstream: false });
        expect(
          yield* git(remote, ["--git-dir=.", "rev-parse", "--verify", "refs/heads/feature/stuck"]),
        ).toBe(yield* git(tmp, ["rev-parse", "HEAD"]));
        expect(
          yield* git(tmp, ["config", "--get-regexp", "^branch\\.feature/stuck\\."]).pipe(
            Effect.orElseSucceed(() => ""),
          ),
        ).toBe("");
      }).pipe(Effect.scoped, Effect.provide(TestLayer)),
    20_000,
  );

  it.live(
    "restores the fetch refspec when a lock splits a remote add",
    () =>
      Effect.gen(function* () {
        const { tmp } = yield* makeRepoWithRemote;
        const forkRemote = yield* makeTmpDir();
        yield* git(forkRemote, ["init", "--bare"]);
        const realGitCore = yield* GitCore;
        let addAttempts = 0;
        const core = yield* makeIsolatedGitCore((input) =>
          Effect.suspend(() => {
            if (input.operation !== "GitCore.ensureRemote.add") return realGitCore.execute(input);
            addAttempts += 1;
            if (addAttempts > 1) return realGitCore.execute(input);
            // The url write lands, then the refspec write loses the lock.
            return realGitCore
              .execute({ ...input, args: ["config", "remote.fork.url", forkRemote] })
              .pipe(
                Effect.andThen(
                  Effect.fail(
                    new GitCommandError({
                      operation: input.operation,
                      command: "git remote add",
                      cwd: input.cwd,
                      detail:
                        "git remote add failed: error: could not lock config file .git/config: File exists",
                    }),
                  ),
                ),
              );
          }),
        );

        const remoteName = yield* core.ensureRemote({
          cwd: tmp,
          preferredName: "fork",
          url: forkRemote,
        });
        expect(remoteName).toBe("fork");
        expect(addAttempts).toBe(2);
        expect(yield* git(tmp, ["config", "--get-all", "remote.fork.fetch"])).toBe(
          "+refs/heads/*:refs/remotes/fork/*",
        );
      }).pipe(Effect.scoped, Effect.provide(TestLayer)),
    20_000,
  );

  it.live(
    "keeps the previous upstream when only half of a new upstream could be recorded",
    () =>
      Effect.gen(function* () {
        const { tmp } = yield* makeRepoWithRemote;
        const forkRemote = yield* makeTmpDir();
        yield* git(forkRemote, ["init", "--bare"]);
        yield* git(tmp, ["remote", "add", "fork", forkRemote]);
        yield* git(tmp, ["push", "origin", "main"]);
        yield* git(tmp, ["checkout", "-b", "feature/half", "--track", "origin/main"]);
        yield* git(tmp, ["config", "remote.pushDefault", "fork"]);
        yield* writeTextFile(path.join(tmp, "half.txt"), "half\n");
        yield* git(tmp, ["add", "half.txt"]);
        yield* git(tmp, ["commit", "-m", "half"]);
        const realGitCore = yield* GitCore;
        const core = yield* makeGitCoreWithSettings({ automaticGitFetchIntervalMs: 0 }, (input) =>
          input.operation === "GitCore.pushCurrentBranch.recordUpstreamRemote"
            ? Effect.fail(
                new GitCommandError({
                  operation: input.operation,
                  command: "git config",
                  cwd: input.cwd,
                  detail: "git config failed: error: simulated write failure",
                }),
              )
            : realGitCore.execute(input),
        );

        const pushed = yield* core.pushCurrentBranch(tmp, null);
        expect(pushed).toMatchObject({ status: "pushed", setUpstream: false });
        expect(yield* git(tmp, ["rev-parse", "--abbrev-ref", "@{upstream}"])).toBe("origin/main");
      }).pipe(Effect.scoped, Effect.provide(TestLayer)),
    20_000,
  );

  it.live(
    "adds a remote and records fetched branch tracking after waiting out the lock",
    () =>
      Effect.gen(function* () {
        const { tmp } = yield* makeRepoWithRemote;
        const forkRemote = yield* makeTmpDir();
        yield* git(forkRemote, ["init", "--bare"]);
        yield* git(tmp, ["push", "origin", "main:refs/heads/feature/remote"]);
        const core = yield* GitCore;

        yield* holdConfigLock(tmp);
        yield* releaseConfigLockAfter(tmp, "150 millis");
        const remoteName = yield* core.ensureRemote({
          cwd: tmp,
          preferredName: "fork",
          url: forkRemote,
        });
        expect(remoteName).toBe("fork");
        expect(yield* git(tmp, ["remote", "get-url", "fork"])).toBe(forkRemote);

        yield* holdConfigLock(tmp);
        yield* releaseConfigLockAfter(tmp, "150 millis");
        yield* core.fetchRemoteBranch({
          cwd: tmp,
          remoteName: "origin",
          remoteBranch: "feature/remote",
          localBranch: "feature/local",
        });
        expect(yield* git(tmp, ["rev-parse", "--abbrev-ref", "feature/local@{upstream}"])).toBe(
          "origin/feature/remote",
        );
      }).pipe(Effect.scoped, Effect.provide(TestLayer)),
    20_000,
  );
});
