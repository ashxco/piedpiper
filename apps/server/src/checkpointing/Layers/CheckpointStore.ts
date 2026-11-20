/**
 * CheckpointStoreLive - Filesystem checkpoint store adapter layer.
 *
 * Implements hidden Git-ref checkpoint capture/restore directly with
 * Effect-native child process execution (`effect/unstable/process`).
 *
 * This layer owns filesystem/Git interactions only; it does not persist
 * checkpoint metadata and does not coordinate provider rollback semantics.
 *
 * @module CheckpointStoreLive
 */
import { randomUUID } from "node:crypto";

import { Effect, Exit, Fiber, Layer, FileSystem, Option, Path, Schedule } from "effect";

import {
  CheckpointInvariantError,
  CheckpointRefUnavailableError,
  CheckpointUnsupportedError,
} from "../Errors.ts";
import { GitCommandError } from "@piedpiper/contracts";
import {
  GitCore,
  type ExecuteGitInput,
  type ExecuteGitResult,
} from "../../git/Services/GitCore.ts";
import {
  GIT_PLAIN_DIFF_ARGS,
  quoteGitCommand,
  splitNullSeparatedPaths,
  WORKSPACE_GIT_HARDENED_CONFIG_ARGS,
} from "../../git/Layers/GitParsers.ts";
import {
  CheckpointStore,
  type CheckpointStoreShape,
  type DiffCheckpointsInput,
} from "../Services/CheckpointStore.ts";
import { CHECKPOINT_DIFF_TRUNCATED_MARKER, CheckpointRef } from "@piedpiper/contracts";

// core.splitIndex governs every index Git writes, so the scratch index could expire the
// sharedindex.* file the real .git/index still references.
const CHECKPOINT_SCRATCH_INDEX_CONFIG_ARGS = [
  "-c",
  "core.splitIndex=false",
  "-c",
  "splitIndex.sharedIndexExpire=never",
] as const;

// Git renames objects and refs into place without fsync by default, so an unclean shutdown can
// leave 0-byte checkpoint refs that break every later ref operation; macOS defaults to
// writeout-only, which does not reach the disk either.
const FULL_FSYNC_ARG = "core.fsyncMethod=fsync";
const BATCH_FSYNC_ARG = "core.fsyncMethod=batch";
const WRITEOUT_ONLY_FSYNC_ARG = "core.fsyncMethod=writeout-only";

// Git expects batch to match fsync only on HFS+/APFS and NTFS/ReFS (other filesystems are an accepted risk); fsync stays first for a Git without batch.
export function checkpointDurableWriteArgs(platform: NodeJS.Platform): ReadonlyArray<string> {
  return [
    "-c",
    "core.fsync=objects,reference",
    "-c",
    FULL_FSYNC_ARG,
    ...(platform === "darwin" || platform === "win32" ? ["-c", BATCH_FSYNC_ARG] : []),
  ];
}
const CHECKPOINT_DURABLE_WRITE_ARGS = checkpointDurableWriteArgs(process.platform);

/** Both methods must go: a surviving batch would win over writeout-only or fail again. */
export function checkpointWriteArgsWithoutFullFsync(
  args: ReadonlyArray<string>,
): ReadonlyArray<string> {
  return args.map((arg) =>
    arg === FULL_FSYNC_ARG || arg === BATCH_FSYNC_ARG ? WRITEOUT_ONLY_FSYNC_ARG : arg,
  );
}

/**
 * On macOS Git's fsync method uses F_FULLFSYNC, which network mounts can reject; writeout-only
 * still calls fsync(2) there. Linux writeout-only only starts writeback, so it never falls back.
 */
export function shouldRetryCheckpointWriteWithoutFullFsync(
  platform: NodeJS.Platform,
  stderr: string,
): boolean {
  if (platform !== "darwin") return false;
  return (
    /fsync error on [^\r\n]+: operation not supported\r?$/im.test(stderr) ||
    /cannot update ref [^\r\n]+: couldn't write '[^\r\n]+\.lock'\r?$/im.test(stderr)
  );
}

// Keep checkpoint diffs parseable regardless of the user's diff.* config.
const CHECKPOINT_DIFF_CONFIG_ARGS = [
  "-c",
  "diff.relative=false",
  "-c",
  "diff.suppressBlankEmpty=false",
  // Quoted non-ASCII names would fail the renderer's parse for the whole turn.
  "-c",
  "core.quotePath=false",
] as const;
const CHECKPOINT_DIFF_RENDER_ARGS = [
  "--src-prefix=a/",
  "--dst-prefix=b/",
  "--submodule=short",
] as const;

// Numstat output is small per file, but a turn touching many files can exceed git's default cap.
const CHECKPOINT_NUMSTAT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
// Patches above this are cut and marked so a lockfile-sized turn still renders in the diff panel.
export const CHECKPOINT_PATCH_MAX_OUTPUT_BYTES = 10_000_000;
export const CHECKPOINT_PATCH_TRUNCATED_MARKER = CHECKPOINT_DIFF_TRUNCATED_MARKER;
const CHECKPOINT_STAGING_LIST_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
// Reflog subjects that only point a ref at an existing commit. Anything else counts as creating
// one, so an unknown subject keeps its commit attributed.
const REF_MOVE_REFLOG_SUBJECT =
  /^(?:$|(?:checkout|reset|branch|clone|fetch)\b|[^:]*\((?:start|finish|abort|reset)\): |(?:merge|pull|rebase|cherry-pick)\b[^()]*: fast-forward$)/i;

/** Whether `git version` output names a Git with `--diff-merges=remerge` (2.36 and later). */
export function gitSupportsRemergeDiff(versionOutput: string): boolean {
  const match = /^git version (\d+)\.(\d+)/.exec(versionOutput);
  if (match === null) return false;
  const major = Number(match[1]);
  return major > 2 || (major === 2 && Number(match[2]) >= 36);
}
const CHECKPOINT_RECOVERY_MAX_CANDIDATES = 64;
const CHECKPOINT_TRANSIENT_RETRY_TIMES = 2;
const CHECKPOINT_TRANSIENT_RETRY_DELAY = "75 millis";
const CHECKPOINT_RECOVERY_TIMEOUT = "5 seconds";
// safecrlf=true refuses LF files under CRLF conversion; capture them as Git's default does.
const CHECKPOINT_STAGE_CONFIG_ARGS = ["-c", "core.safecrlf=false"] as const;
// Probe nested repositories on their own instead of inheriting the server's Git bindings.
const NESTED_REPOSITORY_ENV: NodeJS.ProcessEnv = {
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  GIT_COMMON_DIR: undefined,
  GIT_INDEX_FILE: undefined,
  GIT_OBJECT_DIRECTORY: undefined,
  GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
};

/** Backup for GitCore's windowsLongPathConfigEnv (the main mechanism), which backs off on a malformed GIT_CONFIG_COUNT. */
export function checkpointLongPathsArgs(platform: NodeJS.Platform): ReadonlyArray<string> {
  return platform === "win32" ? ["-c", "core.longpaths=true"] : [];
}
const CHECKPOINT_LONG_PATHS_ARGS = checkpointLongPathsArgs(process.platform);

/** A concurrent Git process holding a lock, or a file deleted mid-scan; a retry usually succeeds. */
export function isTransientCheckpointGitFailure(stderr: string): boolean {
  return (
    /unable to create [^\n]*\.lock['"]?: file exists/i.test(stderr) ||
    /(?:unable to stat|lstat\(|error: open\()[^\n]+: no such file or directory/i.test(stderr)
  );
}

/** Reads the `head=<branch ref>` a checkpoint commit subject records. */
function checkpointHeadBranch(subjectFields: ReadonlyArray<string>): string | undefined {
  return subjectFields.find((field) => field.startsWith("head=refs/heads/"))?.slice("head=".length);
}

/** Converts `git diff --cached --raw -z --diff-filter=A` output into `update-index -z --index-info` input. */
export function rawAdditionsToIndexInfo(raw: string): string {
  const fields = raw.split("\0");
  let indexInfo = "";
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const match = /^:000000 ([0-7]{6}) 0+ ([0-9a-f]+) A$/.exec(fields[index] ?? "");
    const filePath = fields[index + 1];
    if (!match || !filePath) continue;
    indexInfo += `${match[1]} ${match[2]}\t${filePath}\0`;
  }
  return indexInfo;
}

const makeCheckpointStore = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitCore;
  // A rejecting mount fails batch only after hashing the whole change set, so each capture must not pay that again.
  const writeoutOnlyCwds = new Set<string>();

  const resolveHeadCommit = (cwd: string): Effect.Effect<string | null, GitCommandError> =>
    git
      .execute({
        operation: "CheckpointStore.resolveHeadCommit",
        cwd,
        args: ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
        allowNonZeroExit: true,
      })
      .pipe(
        Effect.map((result) => {
          if (result.code !== 0) {
            return null;
          }
          const commit = result.stdout.trim();
          return commit.length > 0 ? commit : null;
        }),
      );

  const hasHeadCommit = (
    cwd: string,
    env?: NodeJS.ProcessEnv,
  ): Effect.Effect<boolean, GitCommandError> =>
    git
      .execute({
        operation: "CheckpointStore.hasHeadCommit",
        cwd,
        args: ["rev-parse", "--verify", "HEAD"],
        allowNonZeroExit: true,
        ...(env !== undefined ? { env } : {}),
      })
      .pipe(Effect.map((result) => result.code === 0));

  const resolveCheckpointCommit = (
    cwd: string,
    checkpointRef: CheckpointRef,
  ): Effect.Effect<string | null, GitCommandError> =>
    git
      .execute({
        operation: "CheckpointStore.resolveCheckpointCommit",
        cwd,
        args: ["rev-parse", "--verify", "--quiet", `${checkpointRef}^{commit}`],
        allowNonZeroExit: true,
      })
      .pipe(
        Effect.map((result) => {
          if (result.code !== 0) {
            return null;
          }
          const commit = result.stdout.trim();
          return commit.length > 0 ? commit : null;
        }),
      );

  // The repository root reads as ignored under a bare `*` rule, so only nested workspaces are probed.
  const isWorkspaceIgnored = Effect.fn("isCheckpointWorkspaceIgnored")(function* (cwd: string) {
    const prefix = yield* git.execute({
      operation: "CheckpointStore.isWorkspaceIgnored",
      cwd,
      args: ["rev-parse", "--show-prefix"],
      allowNonZeroExit: true,
    });
    if (prefix.code !== 0 || prefix.stdout.trim().length === 0) {
      return false;
    }
    const result = yield* git.execute({
      operation: "CheckpointStore.isWorkspaceIgnored",
      cwd,
      // A trailing slash makes blank CRLF/whitespace patterns match the directory itself.
      // Probe the workspace from its parent without that slash.
      args: [
        ...WORKSPACE_GIT_HARDENED_CONFIG_ARGS,
        "check-ignore",
        "-q",
        "--no-index",
        "--",
        `../${prefix.stdout.replace(/\n$/, "").replace(/\/$/, "").split("/").at(-1)}`,
      ],
      allowNonZeroExit: true,
    });
    return result.code === 0;
  });

  // Capture writes only its private scratch index and its own ref, so a retried command is idempotent.
  const executeCaptureGit = (input: ExecuteGitInput) =>
    git.execute(input).pipe(
      Effect.retry({
        times: CHECKPOINT_TRANSIENT_RETRY_TIMES,
        schedule: Schedule.spaced(CHECKPOINT_TRANSIENT_RETRY_DELAY),
        while: (error) => isTransientCheckpointGitFailure(error.detail),
      }),
    );

  const durableWriteError = (input: ExecuteGitInput, result: ExecuteGitResult) => {
    const stderr = result.stderr.trim();
    return new GitCommandError({
      operation: input.operation,
      command: quoteGitCommand(input.args),
      cwd: input.cwd,
      detail:
        stderr.length > 0
          ? `${quoteGitCommand(input.args)} failed: ${stderr}`
          : `${quoteGitCommand(input.args)} failed with code ${result.code}.`,
    });
  };

  // `acceptedExitCode` is a non-zero exit that still means success, like `add --ignore-errors`
  // reporting the files it skipped.
  const executeDurableWrite = Effect.fn("executeDurableCheckpointWrite")(function* (
    input: ExecuteGitInput,
    acceptedExitCode?: number,
  ) {
    const succeeded = (code: number) => code === 0 || code === acceptedExitCode;
    const writeoutOnlyInput = {
      ...input,
      args: checkpointWriteArgsWithoutFullFsync(input.args),
    };
    const runWriteoutOnly =
      acceptedExitCode === undefined
        ? executeCaptureGit(writeoutOnlyInput)
        : executeCaptureGit({ ...writeoutOnlyInput, allowNonZeroExit: true }).pipe(
            Effect.flatMap((result) =>
              succeeded(result.code)
                ? Effect.succeed(result)
                : Effect.fail(durableWriteError(writeoutOnlyInput, result)),
            ),
          );
    if (writeoutOnlyCwds.has(input.cwd)) {
      return yield* runWriteoutOnly;
    }
    const run = git.execute({ ...input, allowNonZeroExit: true });
    let result = yield* run;
    for (
      let attempt = 0;
      attempt < CHECKPOINT_TRANSIENT_RETRY_TIMES &&
      !succeeded(result.code) &&
      isTransientCheckpointGitFailure(result.stderr);
      attempt++
    ) {
      yield* Effect.sleep(CHECKPOINT_TRANSIENT_RETRY_DELAY);
      result = yield* run;
    }
    if (succeeded(result.code)) {
      return result;
    }
    if (shouldRetryCheckpointWriteWithoutFullFsync(process.platform, result.stderr)) {
      const fallback = yield* runWriteoutOnly;
      writeoutOnlyCwds.add(input.cwd);
      return fallback;
    }
    return yield* durableWriteError(input, result);
  });

  const isGitRepository: CheckpointStoreShape["isGitRepository"] = (cwd) =>
    git
      .execute({
        operation: "CheckpointStore.isGitRepository",
        cwd,
        args: ["rev-parse", "--is-inside-work-tree"],
        allowNonZeroExit: true,
      })
      .pipe(
        Effect.map((result) => result.code === 0 && result.stdout.trim() === "true"),
        Effect.catch(() => Effect.succeed(false)),
      );

  const captureCheckpoint: CheckpointStoreShape["captureCheckpoint"] = Effect.fn(
    "captureCheckpoint",
  )(function* (input) {
    const operation = "CheckpointStore.captureCheckpoint";

    yield* Effect.acquireUseRelease(
      fs.makeTempDirectory({ prefix: "piedpiper-fs-checkpoint-" }),
      Effect.fn("captureCheckpoint.withTempDirectory")(function* (tempDir) {
        const tempIndexPath = path.join(tempDir, `index-${randomUUID()}`);
        const commitEnv: NodeJS.ProcessEnv = {
          ...process.env,
          GIT_INDEX_FILE: tempIndexPath,
          GIT_AUTHOR_NAME: "Pied Piper",
          GIT_AUTHOR_EMAIL: "piedpiper@users.noreply.github.com",
          GIT_COMMITTER_NAME: "Pied Piper",
          GIT_COMMITTER_EMAIL: "piedpiper@users.noreply.github.com",
        };

        const headCommit = yield* resolveHeadCommit(input.cwd);

        // Seeds from the real index so add -A re-hashes only files whose stat data changed.
        const reuseRealIndex = Effect.fn("captureCheckpoint.reuseRealIndex")(function* (
          head: string,
        ) {
          const realIndexPath = (yield* git.execute({
            operation,
            cwd: input.cwd,
            args: ["rev-parse", "--path-format=absolute", "--git-path", "index"],
          })).stdout.trim();
          const { mtime } = yield* fs.stat(realIndexPath);
          if (Option.isNone(mtime)) return null;
          // Stay below the source timestamp even if Date rounded up, preserving Git's racy check.
          const indexTime = Math.floor((mtime.value.getTime() - 1) / 1000);
          if (indexTime <= 0) return null;
          yield* fs.copyFile(realIndexPath, tempIndexPath);
          // Keeps stat data only for entries that already match HEAD.
          yield* executeCaptureGit({
            operation,
            cwd: input.cwd,
            args: [
              ...WORKSPACE_GIT_HARDENED_CONFIG_ARGS,
              ...CHECKPOINT_SCRATCH_INDEX_CONFIG_ARGS,
              "read-tree",
              "--reset",
              head,
            ],
            env: commitEnv,
          });
          yield* fs.utimes(tempIndexPath, indexTime, indexTime);
          const entries = yield* git.execute({
            operation,
            cwd: input.cwd,
            args: [...WORKSPACE_GIT_HARDENED_CONFIG_ARGS, "ls-files", "-v", "--", "."],
            env: commitEnv,
            maxOutputBytes: CHECKPOINT_STAGING_LIST_MAX_OUTPUT_BYTES,
          });
          // Assume-unchanged and skip-worktree entries would hide their edits from add -A.
          return /^[a-zS] /m.test(entries.stdout) ? null : indexTime;
        });

        let reusedIndexTime: number | null = null;
        // Each index write stamps the file now, which would let same-second edits look clean.
        const keepReusedIndexRacy = Effect.suspend(() =>
          reusedIndexTime === null
            ? Effect.void
            : fs.utimes(tempIndexPath, reusedIndexTime, reusedIndexTime),
        );
        const seedScratchIndex = Effect.gen(function* () {
          yield* fs.remove(tempIndexPath, { force: true });
          reusedIndexTime = null;
          if (headCommit === null) return;
          reusedIndexTime = yield* reuseRealIndex(headCommit).pipe(
            Effect.orElseSucceed(() => null),
          );
          if (reusedIndexTime !== null) return;
          yield* fs.remove(tempIndexPath, { force: true });
          yield* executeCaptureGit({
            operation,
            cwd: input.cwd,
            args: [
              ...WORKSPACE_GIT_HARDENED_CONFIG_ARGS,
              ...CHECKPOINT_SCRATCH_INDEX_CONFIG_ARGS,
              "read-tree",
              headCommit,
            ],
            env: commitEnv,
          });
        });
        yield* seedScratchIndex;

        const stageFiles = (
          mode: "-A" | "-u",
          exclusions: ReadonlyArray<string>,
          ignoreErrors = false,
        ) =>
          executeDurableWrite(
            {
              operation,
              cwd: input.cwd,
              args: [
                ...WORKSPACE_GIT_HARDENED_CONFIG_ARGS,
                ...CHECKPOINT_SCRATCH_INDEX_CONFIG_ARGS,
                ...CHECKPOINT_DURABLE_WRITE_ARGS,
                ...CHECKPOINT_STAGE_CONFIG_ARGS,
                ...CHECKPOINT_LONG_PATHS_ARGS,
                "add",
                // Unreadable files keep their indexed version and unreadable new files are left out.
                ...(ignoreErrors ? ["--ignore-errors"] : []),
                mode,
                "--",
                ".",
                ...exclusions,
              ],
              env: commitEnv,
            },
            // With --ignore-errors, exit 1 only reports the files it skipped.
            ignoreErrors ? 1 : undefined,
          );

        // add -A rejects a workspace its repository ignores, even when it holds tracked files.
        const stageIgnoredWorkspace = Effect.gen(function* () {
          // The failed add may have staged part of the tree, so start again from HEAD.
          yield* seedScratchIndex;
          // HEAD omits staged-only additions; seed just this workspace's from the real index.
          const additions = yield* executeCaptureGit({
            operation,
            cwd: input.cwd,
            args: [
              ...WORKSPACE_GIT_HARDENED_CONFIG_ARGS,
              "diff",
              "--cached",
              "--raw",
              "-z",
              "--no-abbrev",
              "--no-renames",
              "--no-relative",
              "--ignore-submodules=none",
              ...GIT_PLAIN_DIFF_ARGS,
              "--ita-visible-in-index",
              "--diff-filter=A",
              "--",
              ".",
            ],
            maxOutputBytes: CHECKPOINT_STAGING_LIST_MAX_OUTPUT_BYTES,
          });
          const indexInfo = rawAdditionsToIndexInfo(additions.stdout);
          if (indexInfo.length > 0) {
            yield* executeCaptureGit({
              operation,
              cwd: input.cwd,
              args: [
                ...WORKSPACE_GIT_HARDENED_CONFIG_ARGS,
                ...CHECKPOINT_SCRATCH_INDEX_CONFIG_ARGS,
                "update-index",
                "-z",
                "--index-info",
              ],
              stdin: indexInfo,
              env: commitEnv,
            });
            yield* keepReusedIndexRacy;
          }
          const tracked = yield* executeCaptureGit({
            operation,
            cwd: input.cwd,
            args: [
              ...WORKSPACE_GIT_HARDENED_CONFIG_ARGS,
              ...CHECKPOINT_LONG_PATHS_ARGS,
              "ls-files",
              "--cached",
              "-z",
              "--",
              ".",
            ],
            env: commitEnv,
            maxOutputBytes: 1,
            truncateOutputAtMaxBytes: true,
          });
          if (tracked.stdout.length === 0) {
            return yield* new CheckpointUnsupportedError({
              operation,
              detail: "The workspace directory is ignored by its Git repository.",
            });
          }
          return yield* stageFiles("-u", []);
        });

        // Git cannot stage an embedded repository that has no commit; retry without those.
        const stageWithoutUnbornNestedRepositories = (error: GitCommandError) =>
          Effect.gen(function* () {
            const untracked = yield* executeCaptureGit({
              operation,
              cwd: input.cwd,
              args: [
                ...WORKSPACE_GIT_HARDENED_CONFIG_ARGS,
                ...CHECKPOINT_LONG_PATHS_ARGS,
                "ls-files",
                "--others",
                "--exclude-standard",
                "-z",
                "--",
                ".",
              ],
              env: commitEnv,
              maxOutputBytes: CHECKPOINT_STAGING_LIST_MAX_OUTPUT_BYTES,
              truncateOutputAtMaxBytes: true,
            });
            if (untracked.stdoutTruncated) return yield* error;
            const candidates = splitNullSeparatedPaths(untracked.stdout, false).filter((entry) =>
              entry.endsWith("/"),
            );
            if (candidates.length > CHECKPOINT_RECOVERY_MAX_CANDIDATES) return yield* error;
            const exclusions: Array<string> = [];
            for (const entry of candidates) {
              const nestedCwd = path.join(input.cwd, entry);
              const isRepository = yield* fs
                .exists(path.join(nestedCwd, ".git"))
                .pipe(Effect.mapError(() => error));
              if (isRepository && !(yield* hasHeadCommit(nestedCwd, NESTED_REPOSITORY_ENV))) {
                exclusions.push(`:(exclude,literal)${entry}`);
              }
            }
            return yield* stageFiles("-A", exclusions, true);
          }).pipe(
            Effect.timeoutOrElse({
              duration: CHECKPOINT_RECOVERY_TIMEOUT,
              orElse: () => Effect.fail(error),
            }),
          );

        yield* stageFiles("-A", []).pipe(
          Effect.catchTag("GitCommandError", (error) =>
            Effect.gen(function* () {
              if (yield* isWorkspaceIgnored(input.cwd)) {
                return yield* stageIgnoredWorkspace;
              }
              return yield* stageWithoutUnbornNestedRepositories(error);
            }),
          ),
        );

        const writeTreeResult = yield* executeDurableWrite({
          operation,
          cwd: input.cwd,
          args: [
            ...WORKSPACE_GIT_HARDENED_CONFIG_ARGS,
            ...CHECKPOINT_SCRATCH_INDEX_CONFIG_ARGS,
            ...CHECKPOINT_DURABLE_WRITE_ARGS,
            "write-tree",
          ],
          env: commitEnv,
        });
        const treeOid = writeTreeResult.stdout.trim();
        if (treeOid.length === 0) {
          return yield* new GitCommandError({
            operation,
            command: "git write-tree",
            cwd: input.cwd,
            detail: "git write-tree returned an empty tree oid.",
          });
        }

        const headBranch =
          headCommit === null
            ? null
            : yield* git
                .execute({
                  operation,
                  cwd: input.cwd,
                  args: ["symbolic-ref", "-q", "HEAD"],
                  allowNonZeroExit: true,
                })
                .pipe(
                  Effect.map((result) => {
                    const ref = result.stdout.trim();
                    return result.code === 0 && ref.startsWith("refs/heads/") ? ref : null;
                  }),
                );
        // listAuthoredPaths reads head= back; refnames cannot contain spaces.
        const message = `piedpiper checkpoint ref=${input.checkpointRef}${headBranch ? ` head=${headBranch}` : ""}`;
        // HEAD is the parent so listAuthoredPaths can see how HEAD moved between checkpoints.
        const commitTreeResult = yield* executeDurableWrite({
          operation,
          cwd: input.cwd,
          args: [
            ...CHECKPOINT_DURABLE_WRITE_ARGS,
            "commit-tree",
            treeOid,
            ...(headCommit === null ? [] : ["-p", headCommit]),
            "-m",
            message,
          ],
          env: commitEnv,
        });
        const commitOid = commitTreeResult.stdout.trim();
        if (commitOid.length === 0) {
          return yield* new GitCommandError({
            operation,
            command: "git commit-tree",
            cwd: input.cwd,
            detail: "git commit-tree returned an empty commit oid.",
          });
        }

        yield* executeDurableWrite({
          operation,
          cwd: input.cwd,
          args: [...CHECKPOINT_DURABLE_WRITE_ARGS, "update-ref", input.checkpointRef, commitOid],
        });
      }),
      (tempDir) => fs.remove(tempDir, { recursive: true }),
    ).pipe(
      Effect.catchTags({
        PlatformError: (error) =>
          Effect.fail(
            new CheckpointInvariantError({
              operation: "CheckpointStore.captureCheckpoint",
              detail: "Failed to capture checkpoint.",
              cause: error,
            }),
          ),
      }),
    );
  });

  const hasCheckpointRef: CheckpointStoreShape["hasCheckpointRef"] = (input) =>
    resolveCheckpointCommit(input.cwd, input.checkpointRef).pipe(
      Effect.map((commit) => commit !== null),
    );

  const restoreCheckpoint: CheckpointStoreShape["restoreCheckpoint"] = Effect.fn(
    "restoreCheckpoint",
  )(function* (input) {
    const operation = "CheckpointStore.restoreCheckpoint";

    let commitOid = yield* resolveCheckpointCommit(input.cwd, input.checkpointRef);

    if (!commitOid && input.fallbackToHead === true) {
      commitOid = yield* resolveHeadCommit(input.cwd);
    }

    if (!commitOid) {
      return false;
    }

    // Restoring or cleaning away the last file can remove a nested workspace directory.
    const recreateWorkspace = fs.makeDirectory(input.cwd, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new CheckpointInvariantError({
            operation,
            detail: "Could not recreate the checkpoint workspace.",
            cause,
          }),
      ),
    );
    // Works on an unborn HEAD too, so restored files never stay staged.
    const resetIndex = Effect.gen(function* () {
      yield* recreateWorkspace;
      yield* git.execute({
        operation,
        cwd: input.cwd,
        args: [
          ...WORKSPACE_GIT_HARDENED_CONFIG_ARGS,
          ...CHECKPOINT_LONG_PATHS_ARGS,
          "reset",
          "--quiet",
          "--",
          ".",
        ],
      });
    });
    // Once a mutating command may have run, an interrupt must not leave restored files staged.
    // Interrupting the command stops its child before this finalizer resets the index. The reset
    // runs on its own fiber: the interrupted one would abort git's interruptible process wait.
    let mutationStarted = false;
    yield* Effect.addFinalizer((exit) =>
      mutationStarted && Exit.hasInterrupts(exit)
        ? resetIndex.pipe(Effect.ignore, Effect.forkDetach, Effect.flatMap(Fiber.await))
        : Effect.void,
    );
    const sparseConfig = yield* git.execute({
      operation,
      cwd: input.cwd,
      args: ["config", "--bool", "core.sparseCheckout"],
      allowNonZeroExit: true,
    });
    const sparseCheckout = sparseConfig.stdout.trim() === "true";
    const restore = [
      ...WORKSPACE_GIT_HARDENED_CONFIG_ARGS,
      ...CHECKPOINT_LONG_PATHS_ARGS,
      "restore",
      "--source",
      commitOid,
      "--worktree",
      "--staged",
    ];
    // restore leaves skip-worktree paths alone. Outside a sparse checkout every such bit was set
    // by hand and capture recorded the file, so override them all.
    mutationStarted = true;
    yield* git.execute({
      operation,
      cwd: input.cwd,
      args: [...restore, ...(sparseCheckout ? [] : ["--ignore-skip-worktree-bits"]), "--", "."],
    });
    if (sparseCheckout) {
      // Sparse exclusions stay excluded; only skip-worktree paths the rules select are manual.
      const manual = yield* Effect.gen(function* () {
        const listing = yield* git.execute({
          operation,
          cwd: input.cwd,
          args: [
            ...WORKSPACE_GIT_HARDENED_CONFIG_ARGS,
            "ls-files",
            "--full-name",
            "--sparse",
            "-v",
            "-z",
            "--",
            ".",
          ],
          maxOutputBytes: CHECKPOINT_STAGING_LIST_MAX_OUTPUT_BYTES,
          truncateOutputAtMaxBytes: true,
        });
        // A listing too large to read whole keeps the plain restore's result.
        if (listing.stdoutTruncated) return [];
        const skipped = listing.stdout
          .split("\0")
          .filter((record) => record.startsWith("S ") || record.startsWith("s "))
          .map((record) => record.slice(2))
          // Sparse directory entries are exclusions; stdin cannot carry non-UTF-8 names.
          .filter((entry) => !entry.endsWith("/") && !entry.includes("\uFFFD"));
        if (skipped.length === 0) return [];
        const stdin = skipped.join("\0") + "\0";
        // check-rules echoes a subset of its input, so the input size bounds its output.
        const rules = yield* git.execute({
          operation,
          cwd: input.cwd,
          args: ["sparse-checkout", "check-rules", "-z"],
          stdin,
          maxOutputBytes: Buffer.byteLength(stdin),
        });
        return rules.stdout.split("\0").filter((entry) => entry.length > 0);
      }).pipe(
        // A Git without ls-files --sparse or check-rules keeps the plain restore's result.
        Effect.orElseSucceed((): string[] => []),
      );
      if (manual.length > 0) {
        yield* git.execute({
          operation,
          cwd: input.cwd,
          args: [
            ...restore,
            "--ignore-skip-worktree-bits",
            "--pathspec-from-file=-",
            "--pathspec-file-nul",
          ],
          stdin: manual.map((entry) => `:(top,literal)${entry}\0`).join(""),
        });
      }
    }
    const clean = git.execute({
      operation,
      cwd: input.cwd,
      args: [
        ...WORKSPACE_GIT_HARDENED_CONFIG_ARGS,
        ...CHECKPOINT_LONG_PATHS_ARGS,
        "clean",
        "-fd",
        "--",
        ".",
      ],
      env: { LC_ALL: "C" },
      allowNonZeroExit: true,
    });

    yield* recreateWorkspace;
    let cleaned = yield* clean;
    // Removing a turn-created .gitignore exposes the files it hid, so clean until nothing is left.
    for (
      let pass = 1;
      pass < 4 && cleaned.code === 0 && /^Removing /m.test(cleaned.stdout);
      pass++
    ) {
      yield* recreateWorkspace;
      cleaned = yield* clean;
    }
    if (cleaned.code === 0 && /^Removing /m.test(cleaned.stdout)) {
      yield* recreateWorkspace;
      const remaining = yield* git.execute({
        operation,
        cwd: input.cwd,
        args: [
          ...WORKSPACE_GIT_HARDENED_CONFIG_ARGS,
          ...CHECKPOINT_LONG_PATHS_ARGS,
          "clean",
          "-dn",
          "--",
          ".",
        ],
        env: { LC_ALL: "C" },
      });
      if (/^Would remove /m.test(remaining.stdout)) {
        yield* resetIndex;
        return yield* new GitCommandError({
          operation,
          command: "git clean",
          cwd: input.cwd,
          detail: "Could not clean the checkpoint workspace: untracked files remain.",
        });
      }
    }
    if (cleaned.code !== 0) {
      // Git can remove every child, then fail trying to remove './' itself.
      const emptiedWorkspace =
        /^warning: failed to remove \.\/: [^\n]+$/.test(cleaned.stderr.trim()) &&
        (yield* fs.readDirectory(input.cwd).pipe(
          Effect.map((entries) => entries.length === 0),
          Effect.orElseSucceed(() => false),
        ));
      if (!emptiedWorkspace) {
        yield* resetIndex;
        return yield* new GitCommandError({
          operation,
          command: "git clean",
          cwd: input.cwd,
          detail: cleaned.stderr.trim() || "Could not clean the checkpoint workspace.",
        });
      }
    }
    yield* resetIndex;

    return true;
  }, Effect.scoped);

  const runCheckpointDiff = Effect.fn("runCheckpointDiff")(function* (input: DiffCheckpointsInput) {
    const operation = "CheckpointStore.diffCheckpoints";
    if (input.filePaths?.length === 0) return { stdout: "", truncated: false };

    let fromRevision = `${input.fromCheckpointRef}^{commit}`;
    if (input.fallbackFromToHead === true) {
      const fromCommit =
        (yield* resolveCheckpointCommit(input.cwd, input.fromCheckpointRef)) ??
        (yield* resolveHeadCommit(input.cwd));
      if (!fromCommit) {
        return yield* new CheckpointRefUnavailableError({
          operation,
          checkpointRef: input.fromCheckpointRef,
          side: "from",
        });
      }
      fromRevision = fromCommit;
    }

    const numstat = input.format === "numstat";
    const args = [
      ...CHECKPOINT_DIFF_CONFIG_ARGS,
      "diff",
      ...GIT_PLAIN_DIFF_ARGS,
      ...CHECKPOINT_DIFF_RENDER_ARGS,
      ...(numstat
        ? ["--numstat", "-z"]
        : ["--patch", "--minimal", ...(input.ignoreWhitespace === true ? ["-w"] : [])]),
      fromRevision,
      `${input.toCheckpointRef}^{commit}`,
      "--",
      // Paths are repository-relative, while cwd can be a subdirectory.
      ...(input.filePaths ?? []).map((filePath) => `:(top,literal)${filePath}`),
    ];
    const result = yield* git.execute({
      operation,
      cwd: input.cwd,
      args,
      allowNonZeroExit: true,
      ...(numstat
        ? { maxOutputBytes: CHECKPOINT_NUMSTAT_MAX_OUTPUT_BYTES }
        : {
            maxOutputBytes: input.maxOutputBytes ?? CHECKPOINT_PATCH_MAX_OUTPUT_BYTES,
            truncateOutputAtMaxBytes: true,
          }),
    });

    if (result.code !== 0) {
      // Resolve the refs only on failure, so the common path spawns a single process.
      if (
        input.fallbackFromToHead !== true &&
        (yield* resolveCheckpointCommit(input.cwd, input.fromCheckpointRef)) === null
      ) {
        return yield* new CheckpointRefUnavailableError({
          operation,
          checkpointRef: input.fromCheckpointRef,
          side: "from",
        });
      }
      if ((yield* resolveCheckpointCommit(input.cwd, input.toCheckpointRef)) === null) {
        return yield* new CheckpointRefUnavailableError({
          operation,
          checkpointRef: input.toCheckpointRef,
          side: "to",
        });
      }
      const stderr = result.stderr.trim();
      return yield* new GitCommandError({
        operation,
        command: quoteGitCommand(args),
        cwd: input.cwd,
        detail:
          stderr.length > 0
            ? `${quoteGitCommand(args)} failed: ${stderr}`
            : `${quoteGitCommand(args)} failed with code ${result.code}.`,
      });
    }

    return { stdout: result.stdout, truncated: !numstat && result.stdoutTruncated };
  });

  const diffCheckpoints: CheckpointStoreShape["diffCheckpoints"] = Effect.fn("diffCheckpoints")(
    function* (input) {
      const { stdout, truncated } = yield* runCheckpointDiff(input);
      if (truncated && input.maxOutputBytes === undefined) {
        // A cut mid-character decodes to U+FFFD; drop it rather than show replacement text.
        return `${stdout.replace(/\uFFFD+$/, "")}${CHECKPOINT_PATCH_TRUNCATED_MARKER}`;
      }
      return stdout;
    },
  );

  const diffCheckpointPatch: CheckpointStoreShape["diffCheckpointPatch"] = Effect.fn(
    "diffCheckpointPatch",
  )(function* (input) {
    const { stdout, truncated } = yield* runCheckpointDiff({ ...input, format: "patch" });
    return { patch: truncated ? stdout.replace(/\uFFFD+$/, "") : stdout, truncated };
  });

  // --diff-merges=remerge needs Git 2.36; the answer is cached once a probe succeeds.
  let remergeDiffSupported: boolean | undefined;
  const supportsRemergeDiff = Effect.fn("CheckpointStore.supportsRemergeDiff")(function* (
    cwd: string,
  ) {
    if (remergeDiffSupported === undefined) {
      const version = yield* git
        .execute({ operation: "CheckpointStore.gitVersion", cwd, args: ["version"] })
        .pipe(Effect.option);
      if (Option.isNone(version)) return false;
      remergeDiffSupported = gitSupportsRemergeDiff(version.value.stdout);
    }
    return remergeDiffSupported;
  });

  const listAuthoredPaths: CheckpointStoreShape["listAuthoredPaths"] = Effect.fn(
    "listAuthoredPaths",
  )(function* (input) {
    const operation = "CheckpointStore.listAuthoredPaths";
    const fromRevision = `${input.fromCheckpointRef}^{commit}`;
    const toRevision = `${input.toCheckpointRef}^{commit}`;
    const heads = yield* git.execute({
      operation,
      cwd: input.cwd,
      args: [
        "-c",
        "log.showSignature=false",
        "log",
        "--no-walk=unsorted",
        "--format=%P %ct %s",
        fromRevision,
        toRevision,
        "--",
      ],
    });
    const [fromLine = "", toLine = ""] = heads.stdout.trimEnd().split("\n");
    const fromFields = fromLine.split(" ");
    const toFields = toLine.split(" ");
    const [startHead = "", capturedAt = ""] = fromFields;
    const [endHead = ""] = toFields;
    // Checkpoints captured before HEAD was recorded as their parent have no parent.
    if (startHead === "" || endHead === "" || startHead === endHead) {
      return null;
    }
    const startBranch = checkpointHeadBranch(fromFields);
    const endBranch = checkpointHeadBranch(toFields);

    const listLines = (args: ReadonlyArray<string>, stdin?: string) =>
      git
        .execute({
          operation,
          cwd: input.cwd,
          // log.showSignature prints verification text into the output.
          args: ["-c", "log.showSignature=false", ...args],
          ...(stdin === undefined ? {} : { stdin }),
          maxOutputBytes: CHECKPOINT_NUMSTAT_MAX_OUTPUT_BYTES,
        })
        .pipe(Effect.map((result) => result.stdout.split("\n").filter((line) => line !== "")));
    const listPaths = (args: ReadonlyArray<string>, stdin?: string) =>
      git
        .execute({
          operation,
          cwd: input.cwd,
          args: [
            ...WORKSPACE_GIT_HARDENED_CONFIG_ARGS,
            "-c",
            "diff.relative=false",
            // log.showSignature prints verification text into the path list.
            "-c",
            "log.showSignature=false",
            ...args,
            "--name-only",
            "-z",
            "--no-renames",
            "--ignore-submodules=none",
            ...GIT_PLAIN_DIFF_ARGS,
            "--",
          ],
          ...(stdin === undefined ? {} : { stdin }),
          maxOutputBytes: CHECKPOINT_NUMSTAT_MAX_OUTPUT_BYTES,
        })
        .pipe(Effect.map((result) => result.stdout.split("\0")));

    // Remerge diffs keep merge conflict fixes while leaving out clean upstream changes. Older Git
    // gets dense combined diffs, which miss a conflict resolved to one side's version, so it also
    // keeps every path more than one parent changed since the merge base.
    const remerge = yield* supportsRemergeDiff(input.cwd);
    const listMergeSharedPaths = (args: ReadonlyArray<string>, stdin?: string) =>
      listLines(["rev-list", "--merges", "--parents", ...args], stdin).pipe(
        Effect.flatMap((merges) =>
          Effect.forEach(
            merges,
            Effect.fnUntraced(function* (merge) {
              const parents = merge.split(" ").slice(1);
              const [base] = yield* listLines(["merge-base", "--octopus", ...parents]).pipe(
                // Unrelated histories have no merge base; the combined diff still applies.
                Effect.orElseSucceed((): ReadonlyArray<string> => []),
              );
              if (base === undefined) return [];
              const changed = yield* Effect.forEach(
                parents,
                (parent) => listPaths(["diff", base, parent]),
                { concurrency: "unbounded" },
              );
              const counts = new Map<string, number>();
              for (const filePath of changed.flatMap((paths) => [...new Set(paths)])) {
                if (filePath === "") continue;
                counts.set(filePath, (counts.get(filePath) ?? 0) + 1);
              }
              return [...counts].flatMap(([filePath, count]) => (count > 1 ? [filePath] : []));
            }),
            { concurrency: 4 },
          ),
        ),
        Effect.map((lists) => lists.flat()),
      );
    const listCommitPaths = (args: ReadonlyArray<string>, stdin?: string) =>
      remerge
        ? listPaths(["log", ...args, "--format=", "--diff-merges=remerge"], stdin)
        : Effect.all(
            [
              listPaths(["log", ...args, "--format=", "--cc"], stdin),
              listMergeSharedPaths(args, stdin),
            ],
            { concurrency: "unbounded" },
          ).pipe(Effect.map((lists) => lists.flat()));

    // A commit is an import when a fetch delivered it since the previous checkpoint and no reflog
    // in any worktree shows this repository creating it. --all covers every worktree's HEAD, and
    // with --walk-reflogs --since compares each entry's own time.
    const listImportedCommits = Effect.gen(function* () {
      const entries = (yield* listLines([
        "log",
        "--walk-reflogs",
        "--all",
        `--since=@${capturedAt}`,
        "--format=%H %gD %gs",
      ])).map((line) => {
        const [commit = "", selector = "", ...subject] = line.split(" ");
        return {
          commit,
          fetched: selector.startsWith("refs/remotes/"),
          subject: subject.join(" "),
        };
      });
      // A push records commits this repository already had.
      const fetchedTips = new Set(
        entries
          .filter((entry) => entry.fetched && entry.subject !== "update by push")
          .map((entry) => entry.commit),
      );
      if (fetchedTips.size === 0) return fetchedTips;
      // Fetching another branch can deliver a commit that was made here and pushed.
      const createdHere = new Set(
        entries
          .filter((entry) => !entry.fetched && !REF_MOVE_REFLOG_SUBJECT.test(entry.subject))
          .map((entry) => entry.commit),
      );
      const fetched = yield* listLines(
        ["rev-list", `--since=@${capturedAt}`, "--stdin"],
        `${[...fetchedTips, `^${startHead}`].join("\n")}\n`,
      );
      return new Set(fetched.filter((commit) => !createdHere.has(commit)));
    });

    // Commits HEAD left behind count as discarded work (reset, amend, rebase) unless the
    // turn switched branches and the branch it left still holds them.
    const switchedBranch =
      startBranch !== undefined &&
      endBranch !== undefined &&
      startBranch !== endBranch &&
      (yield* git.execute({
        operation,
        cwd: input.cwd,
        args: ["merge-base", "--is-ancestor", startHead, startBranch],
        allowNonZeroExit: true,
      })).code === 0;
    const [recentCommits, ...pathLists] = yield* Effect.all(
      [
        // Commits dated before the starting checkpoint were brought in, not made during the turn.
        listLines(["rev-list", `--since=@${capturedAt}`, `${startHead}..${endHead}`]),
        listPaths(["diff", startHead, fromRevision]),
        listPaths(["diff", endHead, toRevision]),
        switchedBranch ? Effect.succeed([]) : listCommitPaths([`${endHead}..${startHead}`]),
      ],
      { concurrency: "unbounded" },
    );
    // Without readable reflogs every recent commit stays attributed, as before.
    const importedCommits =
      recentCommits.length === 0
        ? new Set<string>()
        : yield* listImportedCommits.pipe(Effect.orElseSucceed(() => new Set<string>()));
    const ownCommits = recentCommits.filter((commit) => !importedCommits.has(commit));
    const ownCommitPaths =
      ownCommits.length === 0
        ? []
        : yield* listCommitPaths(["--no-walk=unsorted", "--stdin"], `${ownCommits.join("\n")}\n`);
    return new Set(
      [...pathLists.flat(), ...ownCommitPaths].filter((filePath) => filePath.length > 0),
    );
  });

  const deleteCheckpointRefs: CheckpointStoreShape["deleteCheckpointRefs"] = Effect.fn(
    "deleteCheckpointRefs",
  )(function* (input) {
    const operation = "CheckpointStore.deleteCheckpointRefs";

    yield* Effect.forEach(
      input.checkpointRefs,
      (checkpointRef) =>
        git.execute({
          operation,
          cwd: input.cwd,
          args: ["update-ref", "-d", checkpointRef],
          allowNonZeroExit: true,
        }),
      { discard: true },
    );
  });

  return {
    isGitRepository,
    captureCheckpoint,
    hasCheckpointRef,
    restoreCheckpoint,
    diffCheckpoints,
    diffCheckpointPatch,
    listAuthoredPaths,
    deleteCheckpointRefs,
  } satisfies CheckpointStoreShape;
});

export const CheckpointStoreLive = Layer.effect(CheckpointStore, makeCheckpointStore);
