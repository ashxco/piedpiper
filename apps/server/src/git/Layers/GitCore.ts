import {
  Cache,
  Cause,
  Clock,
  Data,
  Duration,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  PlatformError,
  Ref,
  Result,
  Schedule,
  Schema,
  Scope,
  Semaphore,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL_MS,
  GitCommandError,
  type ServerSettings,
} from "@piedpiper/contracts";
import {
  dedupeRemoteBranchesWithLocalMatches,
  flattenTemporaryWorktreeBranchName,
  isTemporaryWorktreeBranch,
  TEMPORARY_WORKTREE_BRANCH_PREFIX,
} from "@piedpiper/shared/git";
import { compactTraceAttributes } from "../../observability/Attributes.ts";
import { gitCommandDuration, gitCommandsTotal, withMetrics } from "../../observability/Metrics.ts";
import {
  GitCore,
  type ExecuteGitProgress,
  type GitCommitOptions,
  type GitCoreShape,
  type GitStatusDetails,
  type ExecuteGitInput,
  type ExecuteGitResult,
} from "../Services/GitCore.ts";
import {
  parseRemoteNames,
  parseRemoteNamesInGitOrder,
  parseRemoteRefWithRemoteNames,
} from "../remoteRefs.ts";
import { makeWorktreeCheckoutCache } from "./WorktreeCheckoutCache.ts";
import { ServerConfig } from "../../config.ts";
import { getServerSettingsOrDefault, ServerSettingsService } from "../../serverSettings.ts";
import {
  GIT_CHECKOUT_PROGRESS_ENV,
  parseGitCheckoutProgressLine,
  stripGitCheckoutProgressLines,
  splitGitOutputLines,
} from "../gitCheckoutProgress.ts";
import { explicitBareRepositoryEnv } from "../gitConfigEnv.ts";
import { readGitDiffPreview } from "../gitDiffPreview.ts";
import { remoteUrlIdentityKey } from "../remoteUrl.ts";
import { removeLinkedWorktree } from "../worktreeRemoval.ts";
import { isPathInsideDirectory, resolveWorktreesDirectory } from "../worktreesDirectory.ts";
import { parseTurnDiffFilesFromNumstat } from "../../checkpointing/Diffs.ts";
import { decodeJsonResult } from "@piedpiper/shared/schemaJson";
import { resolveGitExecutableCached } from "@piedpiper/shared/shell";
import * as KeyedLock from "@piedpiper/shared/KeyedLock";
import {
  GIT_PLAIN_DIFF_ARGS,
  GIT_PROCESS_CONCURRENCY_LIMIT,
  WORKSPACE_GIT_HARDENED_CONFIG_ARGS,
  bypassesGitProcessLimit,
  chunkPathsForGitCheckIgnore,
  commandLabel,
  createGitCommandError,
  deriveLocalBranchNameFromRemoteRef,
  filterBranchesForListQuery,
  gitCommandMutatesRepositoryLayout,
  isMissingGitCwdError,
  isMissingWorktreeStderr,
  isNotGitRepositoryStderr,
  isConfigLockFailure,
  isRefLockFailure,
  isOptionLikeRefName,
  isUpstreamPushTarget,
  isUnbornHeadStderr,
  paginateBranches,
  parseBranchAb,
  parseBranchLine,
  parseDefaultBranchFromRemoteHeadRef,
  parsePorcelainRecordPath,
  parseRemoteFetchUrls,
  parseTrackingBranchByUpstreamRef,
  parseUpstreamRefByFirstSeparator,
  parseUpstreamRefWithRemoteNames,
  quoteGitCommand,
  sanitizeRemoteName,
  splitNullSeparatedPaths,
  toGitCommandError,
  windowsLongPathConfigEnv,
  worktreeDirectoryName,
} from "./GitParsers.ts";

const DEFAULT_TIMEOUT_MS = 30_000;
// Commit/PR context can be read from a subfolder project; diff.relative would hide changes outside it.
const DIFF_NOT_RELATIVE_CONFIG_ARGS = ["-c", "diff.relative=false"] as const;
// Patches handed to text generation stay a/ b/-prefixed with blank context lines and submodule bumps.
const STABLE_PATCH_CONFIG_ARGS = [
  ...DIFF_NOT_RELATIVE_CONFIG_ARGS,
  "-c",
  "diff.suppressBlankEmpty=false",
] as const;
const STABLE_PATCH_RENDER_ARGS = [
  "--src-prefix=a/",
  "--dst-prefix=b/",
  "--submodule=short",
] as const;
// Grace period between SIGTERM and SIGKILL so a hook ignoring SIGTERM cannot block the command timeout.
const GIT_FORCE_KILL_AFTER = "1 second";
// Checking out or deleting a large (dependency-heavy) tree can take minutes; killing git midway
// leaves a half-populated folder and a stale registration. Add matches the 30-minute push bound.
const WORKTREE_ADD_TIMEOUT_MS = 30 * 60_000;
const WORKTREE_REMOVE_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;
// Status-family output scales with the change set; a huge one must not fail a status read or commit.
const STATUS_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const OUTPUT_TRUNCATED_MARKER = "\n\n[truncated]";
const PREPARED_COMMIT_PATCH_MAX_OUTPUT_BYTES = 49_000;
const RANGE_COMMIT_SUMMARY_MAX_OUTPUT_BYTES = 19_000;
const RANGE_DIFF_SUMMARY_MAX_OUTPUT_BYTES = 19_000;
const RANGE_DIFF_PATCH_MAX_OUTPUT_BYTES = 59_000;
const WORKSPACE_FILES_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
// How long a status poll waits on the background fetch before answering from the last fetched refs.
const STATUS_UPSTREAM_REFRESH_WAIT = Duration.seconds(2);
// How long pull/push wait on a background fetch for their remote; a ref-lock loss is retried anyway.
const STATUS_FETCH_JOIN_WAIT = Duration.seconds(20);
// The fetch itself keeps running past the poll; only a hung transport is killed.
const STATUS_UPSTREAM_FETCH_TIMEOUT_MS = 5 * 60_000;
const STATUS_UPSTREAM_FETCH_CONCURRENCY = 4;
const WORKTREE_BASE_FETCH_TIMEOUT_MS = 60_000;
const STATUS_UPSTREAM_REFRESH_FAILURE_BASE_COOLDOWN = Duration.seconds(30);
const STATUS_UPSTREAM_REFRESH_FAILURE_MAX_COOLDOWN = Duration.minutes(15);
const STATUS_UPSTREAM_REFRESH_CACHE_CAPACITY = 2_048;
const STATUS_STATIC_INFO_TTL = Duration.minutes(5);
const STATUS_STATIC_INFO_CACHE_CAPACITY = 2_048;
const STATUS_ARGS = ["status", "--porcelain=2", "--branch", "-z"] as const;
const DEFAULT_BASE_BRANCH_CANDIDATES = ["main", "master"] as const;
const COMMIT_SCRATCH_INDEX_CONFIG_ARGS = [
  "-c",
  "core.splitIndex=false",
  "-c",
  "splitIndex.sharedIndexExpire=never",
] as const;
const WORKSPACE_LS_FILES_ARGS = [
  ...WORKSPACE_GIT_HARDENED_CONFIG_ARGS,
  "ls-files",
  "--cached",
  "--others",
  "--exclude-standard",
  "-z",
] as const;
const WORKSPACE_CHECK_IGNORE_ARGS = [
  ...WORKSPACE_GIT_HARDENED_CONFIG_ARGS,
  "check-ignore",
  "--no-index",
  "-z",
  "--stdin",
] as const;
// Large first pushes outlast the default timeout; still bounded so a stalled transfer or prompt ends.
const PUSH_TIMEOUT_MS = 30 * 60_000;
const CONFIG_LOCK_RETRY_TIMES = 10;
const CONFIG_LOCK_RETRY_DELAY = Duration.millis(50);
// Background fetches have no user; fail fast on credential/askpass prompts (ssh may still read a controlling TTY).
const STATUS_UPSTREAM_REFRESH_ENV = Object.freeze({
  GCM_INTERACTIVE: "never",
  GIT_ASKPASS: "",
  GIT_TERMINAL_PROMPT: "0",
  SSH_ASKPASS: "",
  SSH_ASKPASS_REQUIRE: "never",
} satisfies NodeJS.ProcessEnv);
const NON_REPOSITORY_STATUS_DETAILS = Object.freeze<GitStatusDetails>({
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

type TraceTailState = {
  processedChars: number;
  remainder: string;
};

class StatusRemoteRefreshCacheKey extends Data.Class<{
  gitCommonDir: string;
  remoteName: string;
}> {}

const statusRefreshFailureKey = (gitCommonDir: string, remoteName: string) =>
  `${gitCommonDir}\0${remoteName}`;

/**
 * Backoff after consecutive failed background fetches: 30s doubling up to 15 min, never sooner
 * than the configured fetch interval.
 */
export function statusUpstreamRefreshFailureCooldown(
  consecutiveFailures: number,
  refreshIntervalMs = 0,
): Duration.Duration {
  const exponent = Math.max(0, consecutiveFailures - 1);
  const cooldownMs =
    Duration.toMillis(STATUS_UPSTREAM_REFRESH_FAILURE_BASE_COOLDOWN) * Math.pow(2, exponent);
  return Duration.max(
    Duration.millis(Math.max(0, refreshIntervalMs)),
    Duration.min(Duration.millis(cooldownMs), STATUS_UPSTREAM_REFRESH_FAILURE_MAX_COOLDOWN),
  );
}

/** Repository facts status reads on every poll that change only through rare mutations. */
interface StatusStaticInfo {
  readonly gitCommonDir: string | null;
  readonly indexPath: string | null;
  readonly worktreeRoot: string | null;
  readonly defaultBranch: string | null;
  readonly hasOriginRemote: boolean;
}

interface ExecuteGitOptions {
  stdin?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  timeoutMs?: number | null | undefined;
  allowNonZeroExit?: boolean | undefined;
  fallbackErrorMessage?: string | undefined;
  maxOutputBytes?: number | undefined;
  truncateOutputAtMaxBytes?: boolean | undefined;
  progress?: ExecuteGitProgress | undefined;
}

interface Trace2Monitor {
  readonly env: NodeJS.ProcessEnv;
  readonly flush: Effect.Effect<void, never>;
}

/** Reuses the casing already on disk for each parent segment of a new branch name. */
export function alignBranchParentCasing(
  requestedBranch: string,
  existingBranches: ReadonlyArray<string>,
): string {
  const segments = requestedBranch.split("/");
  for (let depth = 1; depth < segments.length; depth += 1) {
    const prefix = `${segments.slice(0, depth).join("/").toLowerCase()}/`;
    const match = existingBranches.find((branch) => branch.toLowerCase().startsWith(prefix));
    if (match) segments.splice(0, depth, ...match.split("/").slice(0, depth));
  }
  return segments.join("/");
}

/** Git misses a packed `proj/add` when asked for `proj/Add`, whose loose ref would then shadow it. */
export function isBranchNameTakenIgnoringCase(
  name: string,
  existingBranches: ReadonlyArray<string>,
): boolean {
  const lowerName = name.toLowerCase();
  return existingBranches.some((branch) => {
    const lowerBranch = branch.toLowerCase();
    return lowerBranch === lowerName || lowerBranch.startsWith(`${lowerName}/`);
  });
}

const nowUnixNano = (): bigint => BigInt(Date.now()) * 1_000_000n;

const addCurrentSpanEvent = (name: string, attributes: Record<string, unknown>) =>
  Effect.currentSpan.pipe(
    Effect.tap((span) =>
      Effect.sync(() => {
        span.event(name, nowUnixNano(), compactTraceAttributes(attributes));
      }),
    ),
    Effect.catch(() => Effect.void),
  );

// Nested Git processes share the trace file but reuse child IDs in their own sessions.
function trace2ChildKey(record: Record<string, unknown>): string | null {
  const childId = record.child_id;
  if (typeof childId === "number" || typeof childId === "string") {
    return typeof record.sid === "string" ? `${record.sid}\n${childId}` : String(childId);
  }
  const hookName = record.hook_name;
  return typeof hookName === "string" && hookName.trim().length > 0 ? hookName.trim() : null;
}

const Trace2Record = Schema.Record(Schema.String, Schema.Unknown);

// Untraced: runs once per git spawn; errors fail the enclosing runGitCommand span.
const createTrace2Monitor = Effect.fnUntraced(function* (
  input: Pick<ExecuteGitInput, "operation" | "cwd" | "args">,
  progress: ExecuteGitProgress | undefined,
): Effect.fn.Return<
  Trace2Monitor,
  PlatformError.PlatformError,
  Scope.Scope | FileSystem.FileSystem | Path.Path
> {
  if (!progress?.onHookStarted && !progress?.onHookFinished) {
    return {
      env: {},
      flush: Effect.void,
    };
  }

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const traceFilePath = yield* fs.makeTempFileScoped({
    prefix: `piedpiper-git-trace2-${process.pid}-`,
    suffix: ".json",
  });
  const hookStartByChildKey = new Map<string, { hookName: string; startedAtMs: number }>();
  const traceTailState = yield* Ref.make<TraceTailState>({
    processedChars: 0,
    remainder: "",
  });

  // Untraced: runs per trace2 line.
  const handleTraceLine = Effect.fnUntraced(function* (line: string) {
    const trimmedLine = line.trim();
    if (trimmedLine.length === 0) {
      return;
    }

    const traceRecord = decodeJsonResult(Trace2Record)(trimmedLine);
    if (Result.isFailure(traceRecord)) {
      yield* Effect.logDebug(
        `GitCore.trace2: failed to parse trace line for ${quoteGitCommand(input.args)} in ${input.cwd}`,
        traceRecord.failure,
      );
      return;
    }

    const event = traceRecord.success.event;
    const childKey = trace2ChildKey(traceRecord.success);
    if (childKey === null) {
      return;
    }
    const started = hookStartByChildKey.get(childKey);
    const hookNameFromEvent =
      typeof traceRecord.success.hook_name === "string" ? traceRecord.success.hook_name.trim() : "";
    const hookName = hookNameFromEvent.length > 0 ? hookNameFromEvent : (started?.hookName ?? "");
    if (hookName.length === 0) {
      return;
    }

    if (event === "child_start") {
      // child_exit records carry no child_class, so only starts can be filtered by it.
      if (traceRecord.success.child_class !== "hook") {
        return;
      }
      hookStartByChildKey.set(childKey, { hookName, startedAtMs: Date.now() });
      yield* addCurrentSpanEvent("git.hook.started", {
        hookName,
      });
      if (progress.onHookStarted) {
        yield* progress.onHookStarted(hookName);
      }
      return;
    }

    if (event === "child_exit" && started) {
      hookStartByChildKey.delete(childKey);
      const code = traceRecord.success.code;
      const exitCode = typeof code === "number" && Number.isInteger(code) ? code : null;
      const durationMs = Math.max(0, Date.now() - started.startedAtMs);
      yield* addCurrentSpanEvent("git.hook.finished", {
        hookName: started.hookName,
        exitCode,
        durationMs,
      });
      if (progress.onHookFinished) {
        yield* progress.onHookFinished({
          hookName: started.hookName,
          exitCode,
          durationMs,
        });
      }
    }
  });

  const deltaMutex = yield* Semaphore.make(1);
  const readTraceDelta = deltaMutex.withPermit(
    fs.readFileString(traceFilePath).pipe(
      Effect.flatMap((contents) =>
        Effect.uninterruptible(
          Ref.modify(traceTailState, ({ processedChars, remainder }) => {
            if (contents.length <= processedChars) {
              return [[], { processedChars, remainder }];
            }

            const appended = contents.slice(processedChars);
            const combined = remainder + appended;
            const lines = combined.split("\n");
            const nextRemainder = lines.pop() ?? "";

            return [
              lines.map((line) => line.replace(/\r$/, "")),
              {
                processedChars: contents.length,
                remainder: nextRemainder,
              },
            ];
          }).pipe(
            Effect.flatMap((lines) => Effect.forEach(lines, handleTraceLine, { discard: true })),
          ),
        ),
      ),
      Effect.ignore({ log: true }),
    ),
  );
  const traceFileName = path.basename(traceFilePath);
  yield* Stream.runForEach(fs.watch(traceFilePath), (event) => {
    const eventPath = event.path;
    const isTargetTraceEvent =
      eventPath === traceFilePath ||
      eventPath === traceFileName ||
      path.basename(eventPath) === traceFileName;
    if (!isTargetTraceEvent) return Effect.void;
    return readTraceDelta;
  }).pipe(Effect.ignoreCause({ log: true }), Effect.forkScoped);

  const finalizeTrace2Monitor = Effect.fn("finalizeTrace2Monitor")(function* () {
    yield* readTraceDelta;
    const finalLine = yield* Ref.modify(traceTailState, ({ processedChars, remainder }) => [
      remainder.trim(),
      {
        processedChars,
        remainder: "",
      },
    ]);
    if (finalLine.length > 0) {
      yield* handleTraceLine(finalLine);
    }
  });

  yield* Effect.addFinalizer(finalizeTrace2Monitor);

  return {
    env: {
      GIT_TRACE2_EVENT: traceFilePath,
    },
    flush: readTraceDelta,
  };
});

// Untraced: runs twice per git spawn; errors fail the enclosing runGitCommand span.
const collectOutput = Effect.fnUntraced(function* <E>(
  input: Pick<ExecuteGitInput, "operation" | "cwd" | "args">,
  stream: Stream.Stream<Uint8Array, E>,
  maxOutputBytes: number,
  truncateOutputAtMaxBytes: boolean,
  onLine: ((line: string) => Effect.Effect<void, never>) | undefined,
): Effect.fn.Return<{ readonly text: string; readonly truncated: boolean }, GitCommandError> {
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  let lineBuffer = "";
  let truncated = false;

  // Untraced: runs per git spawn/output chunk; errors fail the enclosing runGitCommand span.
  const emitCompleteLines = Effect.fnUntraced(function* (flush: boolean) {
    const { lines, rest } = splitGitOutputLines(lineBuffer);
    lineBuffer = rest;
    if (onLine) {
      for (const line of lines) {
        yield* onLine(line);
      }
    }

    if (flush) {
      const trailing = lineBuffer.replace(/\r$/, "");
      lineBuffer = "";
      if (trailing.length > 0 && onLine) {
        yield* onLine(trailing);
      }
    }
  });

  const processChunk = Effect.fnUntraced(function* (chunk: Uint8Array) {
    if (truncateOutputAtMaxBytes && truncated) {
      return;
    }
    const nextBytes = bytes + chunk.byteLength;
    if (!truncateOutputAtMaxBytes && nextBytes > maxOutputBytes) {
      return yield* new GitCommandError({
        operation: input.operation,
        command: quoteGitCommand(input.args),
        cwd: input.cwd,
        detail: `${quoteGitCommand(input.args)} output exceeded ${maxOutputBytes} bytes and was truncated.`,
      });
    }

    const chunkToDecode =
      truncateOutputAtMaxBytes && nextBytes > maxOutputBytes
        ? chunk.subarray(0, Math.max(0, maxOutputBytes - bytes))
        : chunk;
    bytes += chunkToDecode.byteLength;
    truncated = truncateOutputAtMaxBytes && nextBytes > maxOutputBytes;

    const decoded = decoder.decode(chunkToDecode, { stream: !truncated });
    text += decoded;
    if (onLine) {
      lineBuffer += decoded;
      yield* emitCompleteLines(false);
    }
  });

  yield* Stream.runForEach(stream, processChunk).pipe(
    Effect.mapError(toGitCommandError(input, "output stream failed.")),
  );

  const remainder = truncated ? "" : decoder.decode();
  text += remainder;
  if (onLine) {
    lineBuffer += remainder;
    yield* emitCompleteLines(true);
  }
  return {
    text,
    truncated,
  };
});

const failNonZeroGitResult = (
  operation: string,
  cwd: string,
  args: readonly string[],
  result: ExecuteGitResult,
  fallbackErrorMessage: string | undefined,
): Effect.Effect<never, GitCommandError> => {
  const stderr = result.stderr.trim();
  const detail =
    stderr.length > 0
      ? stderr
      : (fallbackErrorMessage ?? `${commandLabel(args)} failed: code=${result.code ?? "null"}`);
  return Effect.fail(createGitCommandError(operation, cwd, args, detail));
};

export const makeGitCore = Effect.fn("makeGitCore")(function* (options?: {
  executeOverride?: GitCoreShape["execute"];
  /** Host platform override for tests; defaults to `process.platform`. */
  platform?: NodeJS.Platform;
}) {
  const platform = options?.platform ?? process.platform;
  // Pays the one-off synchronous xcrun lookup at startup instead of on the first status poll.
  resolveGitExecutableCached({ env: process.env });
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { worktreesDir, stateDir } = yield* ServerConfig;
  const layerScope = yield* Effect.scope;
  // Optional: GitCore may be built before the settings layer, then the caller's fiber is asked.
  const capturedServerSettings = yield* Effect.serviceOption(ServerSettingsService);
  const readServerSettings: Effect.Effect<ServerSettings> = Option.match(capturedServerSettings, {
    onNone: () => getServerSettingsOrDefault,
    onSome: (service) =>
      getServerSettingsOrDefault.pipe(Effect.provideService(ServerSettingsService, service)),
  });

  let executeRaw: GitCoreShape["execute"];

  if (options?.executeOverride) {
    executeRaw = options.executeOverride;
  } else {
    const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    executeRaw = Effect.fnUntraced(function* (input) {
      const commandInput = {
        ...input,
        args: [...input.args],
      } as const;
      const timeoutMs = input.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : input.timeoutMs;
      const maxOutputBytes = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
      const truncateOutputAtMaxBytes = input.truncateOutputAtMaxBytes ?? false;

      const runGitCommand = Effect.fn("runGitCommand")(function* () {
        const trace2Monitor = yield* createTrace2Monitor(commandInput, input.progress).pipe(
          Effect.provideService(Path.Path, path),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.mapError(toGitCommandError(commandInput, "failed to create trace2 monitor.")),
        );
        const mergedEnv = {
          ...process.env,
          // Read-only commands (status polling) must not take index.lock beside the agent's own git.
          GIT_OPTIONAL_LOCKS: "0",
          // Failures are matched by English text; LANGUAGE (not LC_ALL) leaves hooks' charset alone.
          LANGUAGE: "C",
          ...input.env,
          ...trace2Monitor.env,
        };
        const bareSafeEnv = {
          ...mergedEnv,
          ...explicitBareRepositoryEnv(mergedEnv, platform),
        };
        const env = { ...bareSafeEnv, ...windowsLongPathConfigEnv(platform, bareSafeEnv) };
        const child = yield* commandSpawner
          .spawn(
            ChildProcess.make(resolveGitExecutableCached({ env }), commandInput.args, {
              cwd: commandInput.cwd,
              env,
              forceKillAfter: GIT_FORCE_KILL_AFTER,
            }),
          )
          .pipe(
            Effect.mapError(toGitCommandError(commandInput, "failed to spawn.")),
            // Node's spawn throws synchronously for some errors (e.g. ENOTDIR), which surfaces as a defect.
            Effect.catchDefect((defect) =>
              Effect.fail(toGitCommandError(commandInput, "failed to spawn.")(defect)),
            ),
          );
        // The spawner's forceKillAfter only bounds sending SIGTERM, not the exit wait, so escalate here.
        yield* Effect.addFinalizer(() =>
          child.isRunning.pipe(
            Effect.flatMap((running) =>
              running
                ? child.kill().pipe(
                    Effect.timeoutOrElse({
                      duration: GIT_FORCE_KILL_AFTER,
                      orElse: () => child.kill({ killSignal: "SIGKILL" }),
                    }),
                  )
                : Effect.void,
            ),
            Effect.ignore,
          ),
        );

        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            collectOutput(
              commandInput,
              child.stdout,
              maxOutputBytes,
              truncateOutputAtMaxBytes,
              input.progress?.onStdoutLine,
            ),
            collectOutput(
              commandInput,
              child.stderr,
              maxOutputBytes,
              truncateOutputAtMaxBytes,
              input.progress?.onStderrLine,
            ),
            child.exitCode.pipe(
              Effect.map((value) => Number(value)),
              Effect.mapError(toGitCommandError(commandInput, "failed to report exit code.")),
            ),
            input.stdin === undefined
              ? Effect.void
              : Stream.run(Stream.encodeText(Stream.make(input.stdin)), child.stdin).pipe(
                  Effect.mapError(toGitCommandError(commandInput, "failed to write stdin.")),
                ),
          ],
          { concurrency: "unbounded" },
        ).pipe(Effect.map(([stdout, stderr, exitCode]) => [stdout, stderr, exitCode] as const));
        yield* trace2Monitor.flush;

        if (!input.allowNonZeroExit && exitCode !== 0) {
          const trimmedStderr = stderr.text.trim();
          return yield* new GitCommandError({
            operation: commandInput.operation,
            command: quoteGitCommand(commandInput.args),
            cwd: commandInput.cwd,
            detail:
              trimmedStderr.length > 0
                ? `${quoteGitCommand(commandInput.args)} failed: ${trimmedStderr}`
                : `${quoteGitCommand(commandInput.args)} failed with code ${exitCode}.`,
          });
        }

        return {
          code: exitCode,
          stdout: stdout.text,
          stderr: stderr.text,
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated,
        } satisfies ExecuteGitResult;
      });

      const execution = runGitCommand().pipe(Effect.scoped);
      if (timeoutMs === null) {
        return yield* execution;
      }

      return yield* execution.pipe(
        Effect.timeoutOption(timeoutMs),
        Effect.flatMap((result) =>
          Option.match(result, {
            onNone: () =>
              Effect.fail(
                new GitCommandError({
                  operation: commandInput.operation,
                  command: quoteGitCommand(commandInput.args),
                  cwd: commandInput.cwd,
                  detail: `${quoteGitCommand(commandInput.args)} timed out.`,
                }),
              ),
            onSome: Effect.succeed,
          }),
        ),
      );
    });
  }

  const statusStaticInfoCache = yield* Cache.makeWith({
    capacity: STATUS_STATIC_INFO_CACHE_CAPACITY,
    lookup: (cwd: string) => readStatusStaticInfo(cwd),
    // Failures are not cached so a transient error or a later `git init` is picked up next poll.
    timeToLive: (exit) => (Exit.isSuccess(exit) ? STATUS_STATIC_INFO_TTL : Duration.zero),
  });

  const gitProcessPermits = yield* Semaphore.make(GIT_PROCESS_CONCURRENCY_LIMIT);

  const execute: GitCoreShape["execute"] = (input) => {
    const run = executeRaw(input).pipe(
      withMetrics({
        counter: gitCommandsTotal,
        timer: gitCommandDuration,
        attributes: {
          operation: input.operation,
        },
      }),
      // Outside executeRaw so waiting for a permit never counts toward the command's timeout.
      (execution) =>
        bypassesGitProcessLimit(input.args, input.timeoutMs, DEFAULT_TIMEOUT_MS)
          ? execution
          : gitProcessPermits.withPermit(execution),
      Effect.withSpan(input.operation, {
        kind: "client",
        attributes: {
          "git.operation": input.operation,
          "git.cwd": input.cwd,
          "git.args_count": input.args.length,
        },
      }),
    );
    return gitCommandMutatesRepositoryLayout(input.args)
      ? run.pipe(Effect.ensuring(Cache.invalidateAll(statusStaticInfoCache)))
      : run;
  };

  const checkoutCache = yield* makeWorktreeCheckoutCache({
    cacheDir: path.join(stateDir, "worktree-checkout-cache"),
    execute,
    platform,
  });
  if (checkoutCache && Option.isSome(capturedServerSettings)) {
    yield* capturedServerSettings.value.streamChanges.pipe(
      Stream.map((settings) => settings.fastWorktreeCheckout),
      Stream.changes,
      Stream.runForEach((enabled) => (enabled ? Effect.void : checkoutCache.clear)),
      Effect.forkIn(layerScope),
    );
  }

  const executeGit = (
    operation: string,
    cwd: string,
    args: readonly string[],
    options: ExecuteGitOptions = {},
  ): Effect.Effect<ExecuteGitResult, GitCommandError> =>
    execute({
      operation,
      cwd,
      args,
      ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
      allowNonZeroExit: true,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}),
      ...(options.truncateOutputAtMaxBytes !== undefined
        ? { truncateOutputAtMaxBytes: options.truncateOutputAtMaxBytes }
        : {}),
      ...(options.progress ? { progress: options.progress } : {}),
    }).pipe(
      Effect.flatMap((result) =>
        options.allowNonZeroExit || result.code === 0
          ? Effect.succeed(result)
          : failNonZeroGitResult(operation, cwd, args, result, options.fallbackErrorMessage),
      ),
    );

  // Reruns a fetch once, after any background status fetch, when it lost a ref lock to another git process.
  const executeGitRetryingRefLock = (
    operation: string,
    cwd: string,
    args: readonly string[],
    options: ExecuteGitOptions = {},
  ): Effect.Effect<ExecuteGitResult, GitCommandError> => {
    const run = () => executeGit(operation, cwd, args, { ...options, allowNonZeroExit: true });
    return run().pipe(
      Effect.flatMap((result) =>
        result.code !== 0 && isRefLockFailure(result.stderr)
          ? Effect.suspend(() => awaitStatusFetches(cwd)).pipe(Effect.andThen(run))
          : Effect.succeed(result),
      ),
      Effect.flatMap((result) =>
        result.code === 0
          ? Effect.succeed(result)
          : failNonZeroGitResult(operation, cwd, args, result, options.fallbackErrorMessage),
      ),
    );
  };

  const runGit = (
    operation: string,
    cwd: string,
    args: readonly string[],
    options: ExecuteGitOptions = {},
  ): Effect.Effect<void, GitCommandError> =>
    executeGit(operation, cwd, args, options).pipe(Effect.asVoid);

  const runGitStdout = (
    operation: string,
    cwd: string,
    args: readonly string[],
    allowNonZeroExit = false,
  ): Effect.Effect<string, GitCommandError> =>
    executeGit(operation, cwd, args, { allowNonZeroExit }).pipe(
      Effect.map((result) => result.stdout),
    );

  const runGitStdoutWithOptions = (
    operation: string,
    cwd: string,
    args: readonly string[],
    options: ExecuteGitOptions = {},
  ): Effect.Effect<string, GitCommandError> =>
    executeGit(operation, cwd, args, options).pipe(
      Effect.map((result) =>
        result.stdoutTruncated ? `${result.stdout}${OUTPUT_TRUNCATED_MARKER}` : result.stdout,
      ),
    );

  const refuseOptionLikeRefName = (
    operation: string,
    cwd: string,
    refName: string,
    args: readonly string[],
  ): Effect.Effect<void, GitCommandError> =>
    isOptionLikeRefName(refName)
      ? Effect.fail(createGitCommandError(operation, cwd, args, "Ref names cannot start with '-'."))
      : Effect.void;

  const branchExists = (cwd: string, branch: string): Effect.Effect<boolean, GitCommandError> =>
    executeGit(
      "GitCore.branchExists",
      cwd,
      ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      {
        allowNonZeroExit: true,
        timeoutMs: 5_000,
      },
    ).pipe(Effect.map((result) => result.code === 0));

  const resolveAvailableBranchName = Effect.fn("resolveAvailableBranchName")(function* (
    cwd: string,
    requestedBranch: string,
  ) {
    // On a case-insensitive filesystem `Team/foo` lands in the `team/` directory of an existing
    // `team/bar`, and `git branch` then lists a spelling this name does not match.
    // `lstrip` because `:short` prints `heads/<name>` for a branch that shares a tag's name.
    const existingBranches = yield* runGitStdout("GitCore.resolveAvailableBranchName.refs", cwd, [
      "for-each-ref",
      "--format=%(refname:lstrip=2)",
      "refs/heads",
    ]).pipe(Effect.map((stdout) => stdout.split("\n").filter((line) => line.length > 0)));
    const lowerCaseBranches = new Set(existingBranches.map((branch) => branch.toLowerCase()));
    const isExistingBranch = (name: string) => lowerCaseBranches.has(name.toLowerCase());
    // A branch at a parent path (such as `piedpiper`) blocks every ref nested under it, so no
    // suffix would help; flatten to a sibling name instead.
    const segments = alignBranchParentCasing(requestedBranch, existingBranches).split("/");
    const blockedByParent = segments
      .slice(1)
      .some((_, index) => isExistingBranch(segments.slice(0, index + 1).join("/")));
    const desiredBranch = blockedByParent ? segments.join("-") : segments.join("/");
    if (!isBranchNameTakenIgnoringCase(desiredBranch, existingBranches)) {
      return desiredBranch;
    }

    for (let suffix = 1; suffix <= 100; suffix += 1) {
      const candidate = `${desiredBranch}-${suffix}`;
      if (!isBranchNameTakenIgnoringCase(candidate, existingBranches)) {
        return candidate;
      }
    }

    return yield* createGitCommandError(
      "GitCore.renameBranch",
      cwd,
      ["branch", "-m", "--", desiredBranch],
      `Could not find an available branch name for '${desiredBranch}'.`,
    );
  });

  const resolveCurrentUpstream = Effect.fn("resolveCurrentUpstream")(function* (cwd: string) {
    // `--abbrev-ref` prints `remotes/origin/<name>` when a local `origin/<name>` branch exists.
    const fullUpstreamRef = yield* runGitStdout(
      "GitCore.resolveCurrentUpstream",
      cwd,
      ["rev-parse", "--symbolic-full-name", "@{upstream}"],
      true,
    ).pipe(Effect.map((stdout) => stdout.trim()));

    // An upstream that is a local branch has no remote to push to or fetch from.
    if (!fullUpstreamRef.startsWith("refs/remotes/")) {
      return null;
    }
    const upstreamRef = fullUpstreamRef.slice("refs/remotes/".length);
    if (upstreamRef.length === 0) {
      return null;
    }

    const remoteNames = yield* runGitStdout("GitCore.listRemoteNames", cwd, ["remote"]).pipe(
      Effect.map(parseRemoteNames),
      Effect.catch(() => Effect.succeed<ReadonlyArray<string>>([])),
    );
    return (
      parseUpstreamRefWithRemoteNames(upstreamRef, remoteNames) ??
      parseUpstreamRefByFirstSeparator(upstreamRef)
    );
  });

  // Git reports relative paths from the physical cwd, which can differ from a symlinked one.
  const resolveGitReportedPath = (cwd: string, reported: string): Effect.Effect<string> =>
    path.isAbsolute(reported)
      ? Effect.succeed(reported)
      : fileSystem.realPath(cwd).pipe(
          Effect.orElseSucceed(() => cwd),
          Effect.map((physicalCwd) => path.resolve(physicalCwd, reported)),
        );

  const resolveGitCommonDir = Effect.fn("resolveGitCommonDir")(function* (cwd: string) {
    const gitCommonDir = yield* runGitStdout("GitCore.resolveGitCommonDir", cwd, [
      "rev-parse",
      "--git-common-dir",
    ]).pipe(Effect.map((stdout) => stdout.trim()));
    return yield* resolveGitReportedPath(cwd, gitCommonDir);
  });

  // Pied Piper's own config writes take turns per repository (worktrees share one config).
  const sharedConfigLocks = new Map<string, Semaphore.Semaphore>();
  const withSharedConfigLock = <A, E>(cwd: string, effect: Effect.Effect<A, E>) =>
    resolveGitCommonDir(cwd).pipe(
      Effect.orElseSucceed(() => null),
      Effect.flatMap((gitCommonDir) => {
        if (gitCommonDir === null) return effect;
        let lock = sharedConfigLocks.get(gitCommonDir);
        if (lock === undefined) {
          lock = Semaphore.makeUnsafe(1);
          sharedConfigLocks.set(gitCommonDir, lock);
        }
        return lock.withPermits(1)(effect);
      }),
    );

  // Git never waits for .git/config.lock and other git processes (an agent's) can hold it, so
  // writes that are safe to repeat retry briefly.
  const retryWhileConfigLocked = <A>(effect: Effect.Effect<A, GitCommandError>) =>
    effect.pipe(
      Effect.retry({
        while: (error) => isConfigLockFailure(error.detail),
        times: CONFIG_LOCK_RETRY_TIMES,
        schedule: Schedule.spaced(CONFIG_LOCK_RETRY_DELAY),
      }),
    );

  const runConfigWrite = (operation: string, cwd: string, args: readonly string[]) =>
    withSharedConfigLock(cwd, runGit(operation, cwd, args).pipe(retryWhileConfigLocked));

  let statusRefreshIntervalMs = DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL_MS;

  // Consecutive failed fetches per (gitCommonDir, remote); insertion order doubles as LRU order.
  const statusRefreshFailures = new Map<string, { count: number; retryAt: number }>();
  // In-flight background fetches, so slow fetches are joined rather than restarted or killed.
  const statusFetches = new Map<string, Fiber.Fiber<void, GitCommandError>>();
  const statusFetchRegistration = yield* Semaphore.make(1);
  const statusFetchPermits = yield* Semaphore.make(STATUS_UPSTREAM_FETCH_CONCURRENCY);

  const recordStatusRefreshFailure = Effect.fn("recordStatusRefreshFailure")(function* (
    key: string,
    gitCommonDir: string,
    remoteName: string,
    error: GitCommandError,
  ) {
    const consecutiveFailures = (statusRefreshFailures.get(key)?.count ?? 0) + 1;
    const cooldown = statusUpstreamRefreshFailureCooldown(
      consecutiveFailures,
      statusRefreshIntervalMs,
    );
    const now = yield* Clock.currentTimeMillis;
    statusRefreshFailures.delete(key);
    statusRefreshFailures.set(key, {
      count: consecutiveFailures,
      retryAt: now + Duration.toMillis(cooldown),
    });
    if (statusRefreshFailures.size > STATUS_UPSTREAM_REFRESH_CACHE_CAPACITY) {
      const oldest = statusRefreshFailures.keys().next().value;
      if (oldest !== undefined) statusRefreshFailures.delete(oldest);
    }
    yield* Effect.logWarning("background git fetch failed", {
      gitCommonDir,
      remoteName,
      detail: error.detail,
      consecutiveFailures,
      nextDelayMs: Duration.toMillis(cooldown),
    });
  });

  // Fetch the whole remote (configured refspecs) so every worktree on it shares one refresh.
  const startStatusFetch = (gitCommonDir: string, remoteName: string, key: string) => {
    const fetchCwd =
      path.basename(gitCommonDir) === ".git" ? path.dirname(gitCommonDir) : gitCommonDir;
    // A failing `gc --auto` reruns on every poll and leaves a full-size tmp_pack_* each time.
    return executeGit(
      "GitCore.fetchRemoteForStatus",
      fetchCwd,
      [
        "--git-dir",
        gitCommonDir,
        "fetch",
        "--quiet",
        "--no-tags",
        "--no-auto-gc",
        "--",
        remoteName,
      ],
      {
        env: STATUS_UPSTREAM_REFRESH_ENV,
        fallbackErrorMessage: "Background git fetch exited with a non-zero status.",
        timeoutMs: STATUS_UPSTREAM_FETCH_TIMEOUT_MS,
      },
    ).pipe(
      Effect.asVoid,
      Effect.tap(() => Effect.sync(() => statusRefreshFailures.delete(key))),
      Effect.tapError((error) => recordStatusRefreshFailure(key, gitCommonDir, remoteName, error)),
      (fetch) => statusFetchPermits.withPermit(fetch),
      Effect.onExit(() => Effect.sync(() => statusFetches.delete(key))),
      Effect.forkIn(layerScope, { startImmediately: false }),
    );
  };

  const fetchRemoteForStatus = Effect.fn("fetchRemoteForStatus")(function* (
    gitCommonDir: string,
    remoteName: string,
  ) {
    const key = statusRefreshFailureKey(gitCommonDir, remoteName);
    const failure = statusRefreshFailures.get(key);
    // Backoff also covers fetches that failed after the poll stopped waiting on them.
    if (failure && (yield* Clock.currentTimeMillis) < failure.retryAt) return;
    const fiber = yield* statusFetchRegistration.withPermit(
      Effect.suspend(() => {
        const pending = statusFetches.get(key);
        if (pending) return Effect.succeed(pending);
        return startStatusFetch(gitCommonDir, remoteName, key).pipe(
          Effect.tap((started) => Effect.sync(() => statusFetches.set(key, started))),
        );
      }),
    );
    const result = yield* Fiber.join(fiber).pipe(
      Effect.timeoutOption(STATUS_UPSTREAM_REFRESH_WAIT),
    );
    if (Option.isNone(result)) {
      yield* Effect.logDebug("background git fetch still running; using the last fetched refs", {
        gitCommonDir,
        remoteName,
      });
    }
  });

  // Pull and push briefly wait for a running background fetch so they rarely race it for ref locks.
  const awaitStatusFetches = Effect.fn("awaitStatusFetches")(function* (
    cwd: string,
    remoteName?: string | null,
  ) {
    if (statusFetches.size === 0) return;
    const gitCommonDir = yield* resolveGitCommonDir(cwd).pipe(Effect.orElseSucceed(() => null));
    if (gitCommonDir === null) return;
    const prefix = `${gitCommonDir}\0`;
    const pending = remoteName
      ? [statusFetches.get(statusRefreshFailureKey(gitCommonDir, remoteName))].filter(
          (fiber) => fiber !== undefined,
        )
      : [...statusFetches].flatMap(([key, fiber]) => (key.startsWith(prefix) ? [fiber] : []));
    if (pending.length === 0) return;
    const finished = yield* Fiber.awaitAll(pending).pipe(
      Effect.timeoutOption(STATUS_FETCH_JOIN_WAIT),
    );
    if (Option.isNone(finished)) {
      yield* Effect.logDebug("background git fetch still running; continuing without it", {
        gitCommonDir,
        remoteName: remoteName ?? null,
      });
    }
  });

  const readBranchRemote = (cwd: string, branch: string) =>
    runGitStdout(
      "GitCore.readBranchRemote",
      cwd,
      ["config", "--get", `branch.${branch}.remote`],
      true,
    ).pipe(
      Effect.map((stdout) => stdout.trim() || null),
      Effect.orElseSucceed(() => null),
    );

  const statusRemoteRefreshCache = yield* Cache.makeWith({
    capacity: STATUS_UPSTREAM_REFRESH_CACHE_CAPACITY,
    lookup: (cacheKey: StatusRemoteRefreshCacheKey) =>
      fetchRemoteForStatus(cacheKey.gitCommonDir, cacheKey.remoteName).pipe(
        Effect.as(true as const),
      ),
    // Keep successful refreshes warm and back off repeated failures (offline, rejected credentials).
    timeToLive: (exit, cacheKey) =>
      Exit.isSuccess(exit)
        ? Duration.millis(statusRefreshIntervalMs)
        : statusUpstreamRefreshFailureCooldown(
            statusRefreshFailures.get(
              statusRefreshFailureKey(cacheKey.gitCommonDir, cacheKey.remoteName),
            )?.count ?? 1,
            statusRefreshIntervalMs,
          ),
  });

  const refreshStatusUpstreamIfStale = Effect.fn("refreshStatusUpstreamIfStale")(function* (
    cwd: string,
    knownGitCommonDir: string | null,
  ) {
    const { automaticGitFetchIntervalMs } = yield* readServerSettings;
    // Off: status still reads local refs but never contacts the remote.
    if (automaticGitFetchIntervalMs <= 0) return;
    if (automaticGitFetchIntervalMs !== statusRefreshIntervalMs) {
      statusRefreshIntervalMs = automaticGitFetchIntervalMs;
      yield* Cache.invalidateAll(statusRemoteRefreshCache);
    }
    const headRef = yield* runGitStdout(
      "GitCore.refreshStatusUpstreamIfStale.headRef",
      cwd,
      ["symbolic-ref", "--quiet", "HEAD"],
      true,
    ).pipe(Effect.map((stdout) => stdout.trim()));
    if (headRef.length === 0) return;
    const remoteName = yield* runGitStdout(
      "GitCore.refreshStatusUpstreamIfStale.upstreamRemote",
      cwd,
      ["for-each-ref", "--format=%(upstream:remotename)", headRef],
      true,
    ).pipe(Effect.map((stdout) => stdout.trim()));
    // Empty means no upstream; `.` means the upstream is a local branch.
    if (remoteName.length === 0 || remoteName === ".") return;
    const gitCommonDir = knownGitCommonDir ?? (yield* resolveGitCommonDir(cwd));
    // The fetch logs each failed attempt; a cached failure must not log again on every poll.
    yield* Cache.get(
      statusRemoteRefreshCache,
      new StatusRemoteRefreshCacheKey({ gitCommonDir, remoteName }),
    ).pipe(Effect.ignore);
  });

  const resolveDefaultBranchName = (
    cwd: string,
    remoteName: string,
  ): Effect.Effect<string | null, GitCommandError> =>
    executeGit(
      "GitCore.resolveDefaultBranchName",
      cwd,
      ["symbolic-ref", `refs/remotes/${remoteName}/HEAD`],
      { allowNonZeroExit: true },
    ).pipe(
      Effect.map((result) => {
        if (result.code !== 0) {
          return null;
        }
        return parseDefaultBranchFromRemoteHeadRef(result.stdout, remoteName);
      }),
    );

  const remoteBranchExists = (
    cwd: string,
    remoteName: string,
    branch: string,
  ): Effect.Effect<boolean, GitCommandError> =>
    executeGit(
      "GitCore.remoteBranchExists",
      cwd,
      ["show-ref", "--verify", "--quiet", `refs/remotes/${remoteName}/${branch}`],
      {
        allowNonZeroExit: true,
      },
    ).pipe(Effect.map((result) => result.code === 0));

  const originRemoteExists = (cwd: string): Effect.Effect<boolean, GitCommandError> =>
    executeGit("GitCore.originRemoteExists", cwd, ["remote", "get-url", "origin"], {
      allowNonZeroExit: true,
    }).pipe(Effect.map((result) => result.code === 0));

  // Push and PR creation work with any remote, not only one named origin.
  const anyRemoteExists = (cwd: string): Effect.Effect<boolean, GitCommandError> =>
    executeGit("GitCore.anyRemoteExists", cwd, ["remote"], { allowNonZeroExit: true }).pipe(
      Effect.map((result) => result.code === 0 && parseRemoteNames(result.stdout).length > 0),
    );

  const readStatusStaticInfo = Effect.fn("readStatusStaticInfo")(function* (cwd: string) {
    // Fails alone first so a non-repository folder costs one spawn per poll, not three.
    const repositoryPaths = yield* runGitStdout("GitCore.statusDetails.repositoryPaths", cwd, [
      "rev-parse",
      "--git-common-dir",
      "--git-path",
      "index",
    ]);
    const [defaultRefResult, hasOriginRemote, worktreeRootResult] = yield* Effect.all(
      [
        executeGit(
          "GitCore.statusDetails.defaultRef",
          cwd,
          ["symbolic-ref", "refs/remotes/origin/HEAD"],
          { allowNonZeroExit: true },
        ),
        anyRemoteExists(cwd),
        executeGit("GitCore.statusDetails.worktreeRoot", cwd, ["rev-parse", "--show-toplevel"], {
          allowNonZeroExit: true,
        }),
      ],
      { concurrency: "unbounded" },
    );
    // Only the trailing newline is stripped: whitespace before it belongs to the path.
    const worktreeRoot =
      worktreeRootResult.code === 0 ? worktreeRootResult.stdout.replace(/\r?\n$/, "") : "";
    const [gitCommonDir, indexPath] = repositoryPaths.split(/\r?\n/g).map((line) => line.trim());
    return {
      gitCommonDir: gitCommonDir ? yield* resolveGitReportedPath(cwd, gitCommonDir) : null,
      indexPath: indexPath ? yield* resolveGitReportedPath(cwd, indexPath) : null,
      worktreeRoot: worktreeRoot.length > 0 ? path.normalize(worktreeRoot) : null,
      defaultBranch:
        defaultRefResult.code === 0
          ? parseDefaultBranchFromRemoteHeadRef(defaultRefResult.stdout, "origin")
          : null,
      hasOriginRemote,
    } satisfies StatusStaticInfo;
  });

  const listRemoteNames = (cwd: string): Effect.Effect<ReadonlyArray<string>, GitCommandError> =>
    runGitStdout("GitCore.listRemoteNames", cwd, ["remote"]).pipe(
      Effect.map(parseRemoteNamesInGitOrder),
    );

  const resolvePrimaryRemoteName = Effect.fn("resolvePrimaryRemoteName")(function* (cwd: string) {
    if (yield* originRemoteExists(cwd)) {
      return "origin";
    }
    const remotes = yield* listRemoteNames(cwd);
    const [firstRemote] = remotes;
    if (firstRemote) {
      return firstRemote;
    }
    return yield* createGitCommandError(
      "GitCore.resolvePrimaryRemoteName",
      cwd,
      ["remote"],
      "No git remote is configured for this repository.",
    );
  });

  const resolvePushRemoteName = Effect.fn("resolvePushRemoteName")(function* (
    cwd: string,
    branch: string,
  ) {
    const branchPushRemote = yield* runGitStdout(
      "GitCore.resolvePushRemoteName.branchPushRemote",
      cwd,
      ["config", "--get", `branch.${branch}.pushRemote`],
      true,
    ).pipe(Effect.map((stdout) => stdout.trim()));
    if (branchPushRemote.length > 0) {
      return branchPushRemote;
    }

    const pushDefaultRemote = yield* runGitStdout(
      "GitCore.resolvePushRemoteName.remotePushDefault",
      cwd,
      ["config", "--get", "remote.pushDefault"],
      true,
    ).pipe(Effect.map((stdout) => stdout.trim()));
    if (pushDefaultRemote.length > 0) {
      return pushDefaultRemote;
    }

    return yield* resolvePrimaryRemoteName(cwd).pipe(Effect.catch(() => Effect.succeed(null)));
  });

  // `remote add` writes the url and the fetch refspec under separate locks, so a lock lost
  // between them leaves a remote that fetches nothing.
  const ensureRemoteFetchRefspec = Effect.fn("ensureRemoteFetchRefspec")(function* (
    cwd: string,
    remoteName: string,
  ) {
    const refspecs = yield* runGitStdout(
      "GitCore.ensureRemote.readFetchRefspec",
      cwd,
      ["config", "--get-all", `remote.${remoteName}.fetch`],
      true,
    );
    if (refspecs.trim().length > 0) return;
    yield* runConfigWrite("GitCore.ensureRemote.writeFetchRefspec", cwd, [
      "config",
      `remote.${remoteName}.fetch`,
      `+refs/heads/*:refs/remotes/${remoteName}/*`,
    ]);
  });

  const ensureRemote: GitCoreShape["ensureRemote"] = Effect.fn("ensureRemote")(function* (input) {
    const preferredName = sanitizeRemoteName(input.preferredName);
    const targetRemoteKey = remoteUrlIdentityKey(input.url);
    const listRemoteFetchUrls = runGitStdout("GitCore.ensureRemote.listRemoteUrls", input.cwd, [
      "remote",
      "-v",
    ]).pipe(Effect.map((stdout) => parseRemoteFetchUrls(stdout)));
    const findMatchingRemote = (remoteFetchUrls: Map<string, string>) =>
      Array.from(remoteFetchUrls.entries()).find(
        ([, remoteUrl]) => remoteUrlIdentityKey(remoteUrl) === targetRemoteKey,
      )?.[0];

    const remoteFetchUrls = yield* listRemoteFetchUrls;
    const existing = findMatchingRemote(remoteFetchUrls);
    if (existing !== undefined) return existing;

    let remoteName = preferredName;
    let suffix = 1;
    while (remoteFetchUrls.has(remoteName)) {
      remoteName = `${preferredName}-${suffix}`;
      suffix += 1;
    }

    return yield* runConfigWrite("GitCore.ensureRemote.add", input.cwd, [
      "remote",
      "add",
      "--",
      remoteName,
      input.url,
    ]).pipe(
      Effect.as(remoteName),
      // A parallel launch for the same fork may have added it since the listing above.
      Effect.catch((error) =>
        listRemoteFetchUrls.pipe(
          Effect.flatMap((current) => {
            const added = findMatchingRemote(current);
            if (added === undefined) return Effect.fail(error);
            return added === remoteName
              ? ensureRemoteFetchRefspec(input.cwd, added).pipe(Effect.as(added))
              : Effect.succeed(added);
          }),
        ),
      ),
    );
  });

  // A remote-qualified base wins over a local branch or tag that shares its short name.
  const resolveRemoteBaseRef = Effect.fn("resolveRemoteBaseRef")(function* (
    cwd: string,
    baseRef: string,
  ) {
    if (!baseRef.includes("/") || baseRef.startsWith("refs/")) return null;
    const comparisonRef = `refs/remotes/${baseRef}`;
    const remoteBase = yield* executeGit(
      "GitCore.resolveRemoteBaseRef",
      cwd,
      ["show-ref", "--verify", "--quiet", comparisonRef],
      { allowNonZeroExit: true },
    );
    return remoteBase.code === 0 ? { baseRef, comparisonRef } : null;
  });

  const resolveTrackedRemoteBaseRef = Effect.fn("resolveTrackedRemoteBaseRef")(function* (
    cwd: string,
    branch: string,
  ) {
    const upstream = yield* executeGit(
      "GitCore.resolveTrackedRemoteBaseRef",
      cwd,
      ["rev-parse", "--symbolic-full-name", `${branch}@{upstream}`],
      { allowNonZeroExit: true },
    );
    const comparisonRef = upstream.stdout.trim();
    if (upstream.code !== 0 || !comparisonRef.startsWith("refs/remotes/")) return null;
    return { baseRef: comparisonRef.slice("refs/remotes/".length), comparisonRef };
  });

  const resolveBaseBranchForNoUpstream = Effect.fn("resolveBaseBranchForNoUpstream")(function* (
    cwd: string,
    branch: string,
    options?: { readonly allowRemoteOfCurrent?: boolean },
  ) {
    const configuredBaseBranch = yield* runGitStdout(
      "GitCore.resolveBaseBranchForNoUpstream.config",
      cwd,
      ["config", "--get", `branch.${branch}.gh-merge-base`],
      true,
    ).pipe(Effect.map((stdout) => stdout.trim()));

    const primaryRemoteName = yield* resolvePrimaryRemoteName(cwd).pipe(
      Effect.catch(() => Effect.succeed(null)),
    );
    const remotePrefix =
      primaryRemoteName && primaryRemoteName !== "origin" ? `${primaryRemoteName}/` : null;
    const stripPrimaryRemote = (candidate: string) =>
      candidate.startsWith("origin/")
        ? candidate.slice("origin/".length)
        : remotePrefix && candidate.startsWith(remotePrefix)
          ? candidate.slice(remotePrefix.length)
          : candidate;

    if (configuredBaseBranch.length > 0 && stripPrimaryRemote(configuredBaseBranch) !== branch) {
      const configuredRemoteBase = yield* resolveRemoteBaseRef(cwd, configuredBaseBranch);
      if (configuredRemoteBase !== null) return configuredRemoteBase;
    }

    const defaultBranch =
      primaryRemoteName === null ? null : yield* resolveDefaultBranchName(cwd, primaryRemoteName);
    const candidates = [
      configuredBaseBranch.length > 0 ? configuredBaseBranch : null,
      defaultBranch,
      ...DEFAULT_BASE_BRANCH_CANDIDATES,
    ];

    for (const candidate of candidates) {
      if (!candidate) {
        continue;
      }

      const normalizedCandidate = stripPrimaryRemote(candidate);
      if (normalizedCandidate.length === 0) {
        continue;
      }
      if (normalizedCandidate === branch) {
        if (
          options?.allowRemoteOfCurrent &&
          primaryRemoteName &&
          (yield* remoteBranchExists(cwd, primaryRemoteName, normalizedCandidate))
        ) {
          return {
            baseRef: `${primaryRemoteName}/${normalizedCandidate}`,
            comparisonRef: `refs/remotes/${primaryRemoteName}/${normalizedCandidate}`,
          };
        }
        continue;
      }

      if (primaryRemoteName) {
        // In a fork `main` can track `upstream/main` while `origin/main` sits far behind it.
        const trackedBase = yield* resolveTrackedRemoteBaseRef(cwd, normalizedCandidate);
        if (
          trackedBase !== null &&
          !trackedBase.comparisonRef.startsWith(`refs/remotes/${primaryRemoteName}/`)
        ) {
          return trackedBase;
        }

        if (yield* remoteBranchExists(cwd, primaryRemoteName, normalizedCandidate)) {
          return {
            baseRef: `${primaryRemoteName}/${normalizedCandidate}`,
            comparisonRef: `refs/remotes/${primaryRemoteName}/${normalizedCandidate}`,
          };
        }
      }

      if (yield* branchExists(cwd, normalizedCandidate)) {
        return { baseRef: normalizedCandidate, comparisonRef: `refs/heads/${normalizedCandidate}` };
      }
    }

    return null;
  });

  const computeAheadCountAgainstBase = Effect.fn("computeAheadCountAgainstBase")(function* (
    cwd: string,
    branch: string,
  ) {
    const base = yield* resolveBaseBranchForNoUpstream(cwd, branch);
    if (!base) {
      return 0;
    }

    const result = yield* executeGit(
      "GitCore.computeAheadCountAgainstBase",
      cwd,
      ["rev-list", "--count", "--end-of-options", `${base.comparisonRef}..HEAD`],
      { allowNonZeroExit: true },
    );
    if (result.code !== 0) {
      return 0;
    }

    const parsed = Number.parseInt(result.stdout.trim(), 10);
    return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
  });

  const readBranchRecency = Effect.fn("readBranchRecency")(function* (cwd: string) {
    const branchRecency = yield* executeGit(
      "GitCore.readBranchRecency",
      cwd,
      [
        "for-each-ref",
        "--format=%(refname:short)%09%(committerdate:unix)",
        "refs/heads",
        "refs/remotes",
      ],
      {
        timeoutMs: 15_000,
        allowNonZeroExit: true,
      },
    );

    const branchLastCommit = new Map<string, number>();
    if (branchRecency.code !== 0) {
      return branchLastCommit;
    }

    for (const line of branchRecency.stdout.split("\n")) {
      if (line.length === 0) {
        continue;
      }
      const [name, lastCommitRaw] = line.split("\t");
      if (!name) {
        continue;
      }
      const lastCommit = Number.parseInt(lastCommitRaw ?? "0", 10);
      branchLastCommit.set(name, Number.isFinite(lastCommit) ? lastCommit : 0);
    }

    return branchLastCommit;
  });

  // Spawn errors look the same for a deleted cwd and a missing git binary; only the former is a non-repo.
  const recoverMissingGitCwd = <A, B, R>(
    self: Effect.Effect<A, GitCommandError, R>,
    cwd: string,
    onMissing: () => B,
  ): Effect.Effect<A | B, GitCommandError, R> =>
    self.pipe(
      Effect.catchIf(isMissingGitCwdError, (error) =>
        fileSystem.stat(cwd).pipe(
          Effect.map((info) => info.type === "Directory"),
          Effect.orElseSucceed(() => false),
          Effect.flatMap((isDirectory) =>
            isDirectory ? Effect.fail(error) : Effect.succeed(onMissing()),
          ),
        ),
      ),
    );

  // Unborn HEAD: diff the working tree against the empty tree (its id depends on the hash format).
  const readUnbornNumstat = Effect.fn("readUnbornNumstat")(function* (cwd: string) {
    const emptyTree = yield* executeGit(
      "GitCore.statusDetails.numstat.emptyTree",
      cwd,
      ["hash-object", "-t", "tree", "--stdin"],
      { stdin: "" },
    ).pipe(Effect.map((result) => result.stdout.trim()));
    return yield* runGitStdoutWithOptions(
      "GitCore.statusDetails.numstat.unborn",
      cwd,
      ["diff-index", "-M", "--numstat", "-z", emptyTree, "--"],
      { maxOutputBytes: STATUS_MAX_OUTPUT_BYTES },
    );
  });

  const statusDetails: GitCoreShape["statusDetails"] = Effect.fn("statusDetails")(
    function* (cwd, options) {
      const staticInfo = yield* Cache.get(statusStaticInfoCache, cwd).pipe(
        Effect.map((info): StatusStaticInfo | null => info),
        Effect.catch(() => Effect.succeed(null)),
      );

      if (options?.skipUpstreamRefresh !== true) {
        yield* recoverMissingGitCwd(
          refreshStatusUpstreamIfStale(cwd, staticInfo?.gitCommonDir ?? null),
          cwd,
          () => undefined,
        ).pipe(Effect.ignoreCause({ log: true }));
      }

      // Status can succeed while another process holds the lock, re-running LFS/clean filters every poll.
      if (
        options?.failWhenIndexLocked === true &&
        staticInfo?.indexPath &&
        (yield* fileSystem
          .exists(`${staticInfo.indexPath}.lock`)
          .pipe(Effect.orElseSucceed(() => false)))
      ) {
        return yield* createGitCommandError(
          "GitCore.statusDetails.indexLock",
          cwd,
          STATUS_ARGS,
          "Git index is locked. Status will resume when the index lock is removed.",
        );
      }

      // One HEAD-to-working-tree diff: summing staged and unstaged diffs double-counts re-edited lines.
      // Plumbing: porcelain `git diff` rewrites the index even under GIT_OPTIONAL_LOCKS=0.
      const numstatArgs = ["diff-index", "-M", "--numstat", "-z", "HEAD", "--"];
      // Both reads run together; the numstat outcome is only inspected once status says this is a repo.
      const [statusResult, numstatAttempt] = yield* Effect.all(
        [
          recoverMissingGitCwd(
            executeGit("GitCore.statusDetails.status", cwd, STATUS_ARGS, {
              allowNonZeroExit: true,
              maxOutputBytes: STATUS_MAX_OUTPUT_BYTES,
            }),
            cwd,
            () => null,
          ),
          executeGit("GitCore.statusDetails.numstat", cwd, numstatArgs, {
            allowNonZeroExit: true,
            maxOutputBytes: STATUS_MAX_OUTPUT_BYTES,
          }).pipe(Effect.result),
        ],
        { concurrency: 2 },
      );

      if (statusResult === null) {
        return NON_REPOSITORY_STATUS_DETAILS;
      }

      if (statusResult.code !== 0) {
        const stderr = statusResult.stderr.trim();
        return yield* createGitCommandError(
          "GitCore.statusDetails.status",
          cwd,
          STATUS_ARGS,
          stderr || "git status failed",
        );
      }

      const numstatRead: Effect.Effect<ExecuteGitResult, GitCommandError> = Result.isFailure(
        numstatAttempt,
      )
        ? Effect.fail(numstatAttempt.failure)
        : Effect.succeed(numstatAttempt.success);
      const numstatStdout = yield* numstatRead.pipe(
        Effect.flatMap((result) =>
          result.code === 0
            ? Effect.succeed(result.stdout)
            : isUnbornHeadStderr(result.stderr)
              ? readUnbornNumstat(cwd)
              : Effect.fail(
                  createGitCommandError(
                    "GitCore.statusDetails.numstat",
                    cwd,
                    numstatArgs,
                    result.stderr.trim() || "git diff-index --numstat failed",
                  ),
                ),
        ),
      );
      const statusStdout = statusResult.stdout;
      const defaultBranch = staticInfo?.defaultBranch ?? null;
      const hasOriginRemote = staticInfo?.hasOriginRemote ?? false;

      let branch: string | null = null;
      let upstreamRef: string | null = null;
      let aheadCount = 0;
      let behindCount = 0;
      let hasWorkingTreeChanges = false;
      const changedFilesWithoutNumstat = new Set<string>();

      // -z keeps non-ASCII and special-character paths unquoted.
      const statusRecords = statusStdout.split("\0");
      for (let index = 0; index < statusRecords.length; index += 1) {
        const line = statusRecords[index]!;
        if (line.startsWith("# branch.head ")) {
          const value = line.slice("# branch.head ".length).trim();
          branch = value.startsWith("(") ? null : value;
          continue;
        }
        if (line.startsWith("# branch.upstream ")) {
          const value = line.slice("# branch.upstream ".length).trim();
          upstreamRef = value.length > 0 ? value : null;
          continue;
        }
        if (line.startsWith("# branch.ab ")) {
          const value = line.slice("# branch.ab ".length).trim();
          const parsed = parseBranchAb(value);
          aheadCount = parsed.ahead;
          behindCount = parsed.behind;
          continue;
        }
        if (line.length > 0 && !line.startsWith("#")) {
          hasWorkingTreeChanges = true;
          const pathValue = parsePorcelainRecordPath(line);
          if (pathValue) changedFilesWithoutNumstat.add(pathValue);
          // A rename's original path follows as its own record; listing it keeps the deletion selectable.
          if (line.startsWith("2 ")) {
            index += 1;
            const originalPath = statusRecords[index];
            if (originalPath) changedFilesWithoutNumstat.add(originalPath);
          }
        }
      }

      if (!upstreamRef && branch) {
        aheadCount = yield* computeAheadCountAgainstBase(cwd, branch).pipe(
          Effect.catch(() => Effect.succeed(0)),
        );
        behindCount = 0;
      }

      const fileStatMap = new Map<string, { insertions: number; deletions: number }>();
      for (const entry of parseTurnDiffFilesFromNumstat(numstatStdout)) {
        const existing = fileStatMap.get(entry.path) ?? { insertions: 0, deletions: 0 };
        existing.insertions += entry.additions;
        existing.deletions += entry.deletions;
        fileStatMap.set(entry.path, existing);
      }

      let insertions = 0;
      let deletions = 0;
      const files = Array.from(fileStatMap.entries()).map(([filePath, stat]) => {
        insertions += stat.insertions;
        deletions += stat.deletions;
        return { path: filePath, insertions: stat.insertions, deletions: stat.deletions };
      });

      for (const filePath of changedFilesWithoutNumstat) {
        if (fileStatMap.has(filePath)) continue;
        files.push({ path: filePath, insertions: 0, deletions: 0 });
      }
      files.sort((a, b) => a.path.localeCompare(b.path));

      return {
        isRepo: true,
        hasOriginRemote,
        isDefaultBranch:
          branch !== null &&
          (branch === defaultBranch ||
            (defaultBranch === null && (branch === "main" || branch === "master"))),
        branch,
        upstreamRef,
        defaultBranch,
        hasWorkingTreeChanges,
        workingTree: {
          ...(staticInfo?.worktreeRoot ? { rootPath: staticInfo.worktreeRoot } : {}),
          files,
          insertions,
          deletions,
        },
        hasUpstream: upstreamRef !== null,
        aheadCount,
        behindCount,
      };
    },
  );

  const status: GitCoreShape["status"] = (input) =>
    statusDetails(
      input.cwd,
      input.refreshUpstream === false ? { skipUpstreamRefresh: true } : undefined,
    ).pipe(
      Effect.map((details) => ({
        isRepo: details.isRepo,
        hasOriginRemote: details.hasOriginRemote,
        isDefaultBranch: details.isDefaultBranch,
        branch: details.branch,
        hasWorkingTreeChanges: details.hasWorkingTreeChanges,
        workingTree: details.workingTree,
        hasUpstream: details.hasUpstream,
        aheadCount: details.aheadCount,
        behindCount: details.behindCount,
        pr: null,
      })),
    );

  // Stages into the real index, or into a scratch index when `env` sets GIT_INDEX_FILE.
  const stageCommitChanges = Effect.fn("stageCommitChanges")(function* (
    cwd: string,
    filePaths: readonly string[] | undefined,
    env?: NodeJS.ProcessEnv,
  ) {
    // A copied split index must not rewrite or expire the repository's shared index files.
    const config = [
      ...WORKSPACE_GIT_HARDENED_CONFIG_ARGS,
      ...(env ? COMMIT_SCRATCH_INDEX_CONFIG_ARGS : []),
    ];
    const options = env ? { env } : {};
    if (filePaths && filePaths.length > 0) {
      if (env) {
        const head = yield* executeGit(
          "GitCore.prepareCommitContext.head",
          cwd,
          ["rev-parse", "--verify", "--quiet", "HEAD"],
          { allowNonZeroExit: true },
        );
        // `reset` would clear the repository's merge state even with GIT_INDEX_FILE set.
        yield* runGit(
          "GitCore.prepareCommitContext.readTree",
          cwd,
          [...config, "read-tree", ...(head.code === 0 ? ["HEAD"] : ["--empty"])],
          options,
        );
      } else {
        // Like `git commit --only`, refuse before reset discards the merge or cherry-pick state.
        const [mergeHead, cherryPickHead] = (yield* runGitStdout("GitCore.commit.mergeHead", cwd, [
          "rev-parse",
          "--git-path",
          "MERGE_HEAD",
          "--git-path",
          "CHERRY_PICK_HEAD",
        ]))
          .split(/\r?\n/g)
          .map((line) => line.trim());
        for (const [statePath, operation] of [
          [mergeHead, "merge"],
          [cherryPickHead, "cherry-pick"],
        ] as const) {
          if (!statePath) continue;
          const inProgress = yield* fileSystem
            .exists(yield* resolveGitReportedPath(cwd, statePath))
            .pipe(
              Effect.mapError((cause) =>
                createGitCommandError(
                  "GitCore.commit.mergeHead",
                  cwd,
                  ["commit"],
                  `Could not check whether a ${operation} is in progress.`,
                  cause,
                ),
              ),
            );
          if (inProgress) {
            return yield* createGitCommandError(
              "GitCore.commit",
              cwd,
              ["commit"],
              `Cannot commit selected files during a ${operation}. Commit all files to finish the ${operation}.`,
            );
          }
        }
        // Must not be ignored: a stale index would commit files the user did not select.
        yield* runGit("GitCore.commit.reset", cwd, [...config, "reset", "--quiet"]);
      }
      yield* runGit(
        env ? "GitCore.prepareCommitContext.addSelected" : "GitCore.commit.addSelected",
        cwd,
        // Status paths are repository-relative while cwd can be a subdirectory project.
        [...config, "add", "-A", "--", ...filePaths.map((filePath) => `:(top,literal)${filePath}`)],
        options,
      );
    } else {
      yield* runGit(
        env ? "GitCore.prepareCommitContext.addAll" : "GitCore.commit.addAll",
        cwd,
        [...config, "add", "-A"],
        options,
      );
    }
  });

  const prepareCommitContext: GitCoreShape["prepareCommitContext"] = Effect.fn(
    "prepareCommitContext",
  )(function* (cwd, filePaths, options) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        // Work on a copy of the index so generation never disturbs the user's staging.
        const indexValue = yield* runGitStdout("GitCore.prepareCommitContext.indexPath", cwd, [
          "rev-parse",
          "--git-path",
          "index",
        ]);
        const indexPath = yield* resolveGitReportedPath(cwd, indexValue.trim());
        const directory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "piedpiper-commit-index-",
        });
        const tempIndexPath = path.join(directory, "index");
        const env = { GIT_INDEX_FILE: tempIndexPath } satisfies NodeJS.ProcessEnv;
        if (yield* fileSystem.exists(indexPath)) {
          const { mtime } = yield* fileSystem.stat(indexPath);
          yield* fileSystem.copyFile(indexPath, tempIndexPath);
          // Keep the original mtime so git's racy-clean check still re-reads recently written files.
          const indexTime = Option.getOrElse(mtime, () => new Date(0));
          yield* fileSystem.utimes(tempIndexPath, indexTime, indexTime);
          yield* runGit(
            "GitCore.prepareCommitContext.expandSplitIndex",
            cwd,
            [
              ...WORKSPACE_GIT_HARDENED_CONFIG_ARGS,
              ...COMMIT_SCRATCH_INDEX_CONFIG_ARGS,
              "update-index",
              "--no-split-index",
            ],
            { env },
          );
        } else {
          yield* runGit(
            "GitCore.prepareCommitContext.emptyIndex",
            cwd,
            [
              ...WORKSPACE_GIT_HARDENED_CONFIG_ARGS,
              ...COMMIT_SCRATCH_INDEX_CONFIG_ARGS,
              "read-tree",
              "--empty",
            ],
            { env },
          );
        }
        yield* stageCommitChanges(cwd, filePaths, env);

        const stagedSummary = yield* runGitStdoutWithOptions(
          "GitCore.prepareCommitContext.stagedSummary",
          cwd,
          [
            ...WORKSPACE_GIT_HARDENED_CONFIG_ARGS,
            ...DIFF_NOT_RELATIVE_CONFIG_ARGS,
            "diff",
            "--no-color",
            "--cached",
            "--name-status",
          ],
          { env, maxOutputBytes: STATUS_MAX_OUTPUT_BYTES },
        ).pipe(Effect.map((stdout) => stdout.trim()));
        if (stagedSummary.length === 0) {
          return null;
        }
        if (options?.includePatch === false) {
          return { stagedSummary, stagedPatch: "" };
        }

        const stagedPatch = yield* runGitStdoutWithOptions(
          "GitCore.prepareCommitContext.stagedPatch",
          cwd,
          [
            ...WORKSPACE_GIT_HARDENED_CONFIG_ARGS,
            ...STABLE_PATCH_CONFIG_ARGS,
            "diff",
            ...GIT_PLAIN_DIFF_ARGS,
            ...STABLE_PATCH_RENDER_ARGS,
            "--cached",
            "--patch",
            "--minimal",
          ],
          {
            env,
            maxOutputBytes: PREPARED_COMMIT_PATCH_MAX_OUTPUT_BYTES,
            truncateOutputAtMaxBytes: true,
          },
        );

        return {
          stagedSummary,
          stagedPatch,
        };
      }),
    ).pipe(
      Effect.catchTag("PlatformError", (cause) =>
        Effect.fail(
          createGitCommandError(
            "GitCore.prepareCommitContext",
            cwd,
            ["diff", "--cached"],
            "Failed to prepare the temporary commit index.",
            cause,
          ),
        ),
      ),
    );
  });

  const commit: GitCoreShape["commit"] = Effect.fn("commit")(function* (
    cwd,
    subject,
    body,
    options?: GitCommitOptions,
  ) {
    if (options?.stage !== undefined) {
      yield* stageCommitChanges(cwd, options.stage.filePaths);
    }
    const args = ["commit", "-m", subject];
    const trimmedBody = body.trim();
    if (trimmedBody.length > 0) {
      args.push("-m", trimmedBody);
    }
    const progress =
      options?.progress?.onOutputLine === undefined
        ? options?.progress
        : {
            ...options.progress,
            onStdoutLine: (line: string) =>
              options.progress?.onOutputLine?.({ stream: "stdout", text: line }) ?? Effect.void,
            onStderrLine: (line: string) =>
              options.progress?.onOutputLine?.({ stream: "stderr", text: line }) ?? Effect.void,
          };
    yield* executeGit("GitCore.commit.commit", cwd, args, {
      maxOutputBytes: STATUS_MAX_OUTPUT_BYTES,
      ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(progress ? { progress } : {}),
    }).pipe(Effect.asVoid);
    const commitSha = yield* runGitStdout("GitCore.commit.revParseHead", cwd, [
      "rev-parse",
      "HEAD",
    ]).pipe(Effect.map((stdout) => stdout.trim()));

    return { commitSha };
  });

  // `push -u` exits 0 without the upstream when another writer holds the config lock.
  const recordPushedUpstream = Effect.fn("recordPushedUpstream")(
    function* (cwd: string, branch: string, remoteName: string) {
      const mergeKey = `branch.${branch}.merge`;
      const previousMerge = yield* readConfigValue(cwd, mergeKey);
      yield* runConfigWrite("GitCore.pushCurrentBranch.recordUpstreamMerge", cwd, [
        "config",
        mergeKey,
        `refs/heads/${branch}`,
      ]);
      yield* runConfigWrite("GitCore.pushCurrentBranch.recordUpstreamRemote", cwd, [
        "config",
        `branch.${branch}.remote`,
        remoteName,
      ]).pipe(
        // A new merge ref under the old remote would track the wrong branch, so put it back.
        Effect.tapError(() =>
          runConfigWrite(
            "GitCore.pushCurrentBranch.restoreUpstreamMerge",
            cwd,
            previousMerge === null
              ? ["config", "--unset", mergeKey]
              : ["config", mergeKey, previousMerge],
          ).pipe(Effect.ignore),
        ),
      );
      // Matches what `push -u` sets for a remote upstream.
      const autoSetupRebase = yield* readConfigValue(cwd, "branch.autoSetupRebase");
      if (autoSetupRebase === "always" || autoSetupRebase === "remote") {
        yield* runConfigWrite("GitCore.pushCurrentBranch.recordUpstreamRebase", cwd, [
          "config",
          `branch.${branch}.rebase`,
          "true",
        ]);
      }
      return true;
    },
    Effect.catch((cause) =>
      Effect.logWarning("pushed, but could not record the branch upstream", { cause }).pipe(
        Effect.as(false),
      ),
    ),
  );

  const pushCurrentBranch: GitCoreShape["pushCurrentBranch"] = Effect.fn("pushCurrentBranch")(
    function* (cwd, fallbackBranch) {
      const details = yield* statusDetails(cwd);
      const branch = details.branch ?? fallbackBranch;
      if (!branch) {
        return yield* createGitCommandError(
          "GitCore.pushCurrentBranch",
          cwd,
          ["push"],
          "Cannot push from detached HEAD.",
        );
      }
      yield* awaitStatusFetches(cwd, yield* readBranchRemote(cwd, branch));

      const hasNoLocalDelta = details.aheadCount === 0 && details.behindCount === 0;
      if (hasNoLocalDelta) {
        if (details.hasUpstream) {
          return {
            status: "skipped_up_to_date" as const,
            branch,
            ...(details.upstreamRef ? { upstreamBranch: details.upstreamRef } : {}),
          };
        }

        const comparableBaseBranch = yield* resolveBaseBranchForNoUpstream(cwd, branch).pipe(
          Effect.catch(() => Effect.succeed(null)),
        );
        if (comparableBaseBranch) {
          const publishRemoteName = yield* resolvePushRemoteName(cwd, branch).pipe(
            Effect.catch(() => Effect.succeed(null)),
          );
          if (!publishRemoteName) {
            return {
              status: "skipped_up_to_date" as const,
              branch,
            };
          }

          // The base can contain HEAD while the publish branch is still behind it.
          const publishContainsHead = yield* executeGit(
            "GitCore.pushCurrentBranch.publishContainsHead",
            cwd,
            ["merge-base", "--is-ancestor", "HEAD", `refs/remotes/${publishRemoteName}/${branch}`],
            { allowNonZeroExit: true },
          ).pipe(
            Effect.map((result) => result.code === 0),
            Effect.catch(() => Effect.succeed(false)),
          );
          if (publishContainsHead) {
            return {
              status: "skipped_up_to_date" as const,
              branch,
            };
          }
        }
      }

      if (!details.hasUpstream) {
        const publishRemoteName = yield* resolvePushRemoteName(cwd, branch);
        if (!publishRemoteName) {
          return yield* createGitCommandError(
            "GitCore.pushCurrentBranch",
            cwd,
            ["push"],
            "Cannot push because no git remote is configured for this repository.",
          );
        }
        yield* runGit(
          "GitCore.pushCurrentBranch.pushWithUpstream",
          cwd,
          ["push", "--", publishRemoteName, `HEAD:refs/heads/${branch}`],
          { timeoutMs: PUSH_TIMEOUT_MS },
        );
        return {
          status: "pushed" as const,
          branch,
          upstreamBranch: `${publishRemoteName}/${branch}`,
          setUpstream: yield* recordPushedUpstream(cwd, branch, publishRemoteName),
        };
      }

      // Publishing retargets tracking, so record the base first; base resolution reads gh-merge-base.
      const publishOwnBranch = Effect.fn("publishOwnBranch")(function* (
        publishRemoteName: string,
        baseBranch: string,
      ) {
        const configuredMergeBase = yield* runGitStdout(
          "GitCore.pushCurrentBranch.readMergeBase",
          cwd,
          ["config", "--get", `branch.${branch}.gh-merge-base`],
          true,
        ).pipe(Effect.map((stdout) => stdout.trim()));
        if (configuredMergeBase.length === 0) {
          yield* runConfigWrite("GitCore.pushCurrentBranch.recordMergeBase", cwd, [
            "config",
            `branch.${branch}.gh-merge-base`,
            baseBranch,
          ]);
        }
        yield* runGit(
          "GitCore.pushCurrentBranch.pushOwnBranch",
          cwd,
          ["push", "--", publishRemoteName, `HEAD:refs/heads/${branch}`],
          { timeoutMs: PUSH_TIMEOUT_MS },
        );
        return {
          status: "pushed" as const,
          branch,
          upstreamBranch: `${publishRemoteName}/${branch}`,
          setUpstream: yield* recordPushedUpstream(cwd, branch, publishRemoteName),
        };
      });

      const currentUpstream = yield* resolveCurrentUpstream(cwd).pipe(
        Effect.catch(() => Effect.succeed(null)),
      );
      if (currentUpstream) {
        // Pushing onto a base branch the feature was cut from would write its commits there.
        if (!isUpstreamPushTarget(branch, currentUpstream)) {
          const publishRemoteName =
            (yield* resolvePushRemoteName(cwd, branch).pipe(
              Effect.catch(() => Effect.succeed(null)),
            )) ?? currentUpstream.remoteName;
          return yield* publishOwnBranch(publishRemoteName, currentUpstream.upstreamBranch);
        }
        yield* runGit(
          "GitCore.pushCurrentBranch.pushUpstream",
          cwd,
          [
            "push",
            "--",
            currentUpstream.remoteName,
            `HEAD:refs/heads/${currentUpstream.upstreamBranch}`,
          ],
          { timeoutMs: PUSH_TIMEOUT_MS },
        );
        return {
          status: "pushed" as const,
          branch,
          upstreamBranch: currentUpstream.upstreamRef,
          setUpstream: false,
        };
      }

      // A local upstream (`checkout -b stacked --track base`): a plain push would write into `base`.
      const upstreamRemote = yield* runGitStdout(
        "GitCore.pushCurrentBranch.readUpstreamRemote",
        cwd,
        ["config", "--get", `branch.${branch}.remote`],
        true,
      ).pipe(
        Effect.map((stdout) => stdout.trim()),
        Effect.catch(() => Effect.succeed("")),
      );
      if (upstreamRemote === "." && details.upstreamRef) {
        const publishRemoteName = yield* resolvePushRemoteName(cwd, branch).pipe(
          Effect.catch(() => Effect.succeed(null)),
        );
        if (publishRemoteName) {
          return yield* publishOwnBranch(publishRemoteName, details.upstreamRef);
        }
      }

      yield* runGit("GitCore.pushCurrentBranch.push", cwd, ["push"], {
        timeoutMs: PUSH_TIMEOUT_MS,
      });
      return {
        status: "pushed" as const,
        branch,
        ...(details.upstreamRef ? { upstreamBranch: details.upstreamRef } : {}),
        setUpstream: false,
      };
    },
  );

  const pullCurrentBranch: GitCoreShape["pullCurrentBranch"] = Effect.fn("pullCurrentBranch")(
    function* (cwd) {
      const details = yield* statusDetails(cwd);
      const branch = details.branch;
      if (!branch) {
        return yield* createGitCommandError(
          "GitCore.pullCurrentBranch",
          cwd,
          ["pull", "--ff-only"],
          "Cannot pull from detached HEAD.",
        );
      }
      if (!details.hasUpstream) {
        return yield* createGitCommandError(
          "GitCore.pullCurrentBranch",
          cwd,
          ["pull", "--ff-only"],
          "Current branch has no upstream configured. Push with upstream first.",
        );
      }
      // The status read above can start a fetch that still holds ref locks.
      yield* awaitStatusFetches(cwd, yield* readBranchRemote(cwd, branch));
      const beforeSha = yield* runGitStdout(
        "GitCore.pullCurrentBranch.beforeSha",
        cwd,
        ["rev-parse", "HEAD"],
        true,
      ).pipe(Effect.map((stdout) => stdout.trim()));
      // HEAD before and after decides the result; a large fast-forward's diffstat must not fail a
      // pull git already applied.
      const pullOptions = {
        timeoutMs: 30_000,
        truncateOutputAtMaxBytes: true,
        allowNonZeroExit: true,
      } satisfies ExecuteGitOptions;
      let pullArgs: ReadonlyArray<string> = ["pull", "--ff-only"];
      let pullResult = yield* executeGit(
        "GitCore.pullCurrentBranch.pull",
        cwd,
        pullArgs,
        pullOptions,
      );
      if (pullResult.code !== 0 && isRefLockFailure(pullResult.stderr)) {
        const [remote, mergeRefs, currentBranch, currentSha] = yield* Effect.all(
          [
            readConfigValue(cwd, `branch.${branch}.remote`),
            runGitStdout(
              "GitCore.pullCurrentBranch.mergeRefs",
              cwd,
              ["config", "--get-all", `branch.${branch}.merge`],
              true,
            ).pipe(Effect.map((stdout) => stdout.split(/\r?\n/).filter((line) => line.length > 0))),
            runGitStdout(
              "GitCore.pullCurrentBranch.currentBranch",
              cwd,
              ["symbolic-ref", "--quiet", "--short", "HEAD"],
              true,
            ).pipe(Effect.map((stdout) => stdout.trim())),
            runGitStdout(
              "GitCore.pullCurrentBranch.currentSha",
              cwd,
              ["rev-parse", "HEAD"],
              true,
            ).pipe(Effect.map((stdout) => stdout.trim())),
          ],
          { concurrency: "unbounded" },
        );
        const [mergeRef] = mergeRefs;
        // The full fetch may have lost an unrelated ref's lock; retry only the upstream, and only
        // while HEAD is where the pull started.
        if (
          remote &&
          remote !== "." &&
          mergeRef &&
          mergeRefs.length === 1 &&
          currentBranch === branch &&
          currentSha === beforeSha
        ) {
          pullArgs = ["pull", "--ff-only", "--", remote, mergeRef];
          pullResult = yield* executeGit(
            "GitCore.pullCurrentBranch.pull",
            cwd,
            pullArgs,
            pullOptions,
          );
        }
      }
      if (pullResult.code !== 0) {
        return yield* failNonZeroGitResult(
          "GitCore.pullCurrentBranch.pull",
          cwd,
          pullArgs,
          pullResult,
          "git pull failed",
        );
      }
      const afterSha = yield* runGitStdout(
        "GitCore.pullCurrentBranch.afterSha",
        cwd,
        ["rev-parse", "HEAD"],
        true,
      ).pipe(Effect.map((stdout) => stdout.trim()));

      const refreshed = yield* statusDetails(cwd);
      return {
        status: beforeSha.length > 0 && beforeSha === afterSha ? "skipped_up_to_date" : "pulled",
        branch,
        upstreamBranch: refreshed.upstreamRef,
      };
    },
  );

  const readRangeContext: GitCoreShape["readRangeContext"] = Effect.fn("readRangeContext")(
    function* (cwd, baseBranch) {
      const range = `${baseBranch}..HEAD`;
      const [commitSummary, diffSummary, diffPatch] = yield* Effect.all(
        [
          runGitStdoutWithOptions(
            "GitCore.readRangeContext.log",
            cwd,
            [
              "log",
              "--oneline",
              "--no-color",
              "--no-show-signature",
              "--no-decorate",
              "--end-of-options",
              range,
            ],
            {
              maxOutputBytes: RANGE_COMMIT_SUMMARY_MAX_OUTPUT_BYTES,
              truncateOutputAtMaxBytes: true,
            },
          ),
          runGitStdoutWithOptions(
            "GitCore.readRangeContext.diffStat",
            cwd,
            [
              ...DIFF_NOT_RELATIVE_CONFIG_ARGS,
              "diff",
              "--stat",
              "--no-color",
              "--end-of-options",
              range,
            ],
            {
              maxOutputBytes: RANGE_DIFF_SUMMARY_MAX_OUTPUT_BYTES,
              truncateOutputAtMaxBytes: true,
            },
          ),
          runGitStdoutWithOptions(
            "GitCore.readRangeContext.diffPatch",
            cwd,
            [
              ...STABLE_PATCH_CONFIG_ARGS,
              "diff",
              ...GIT_PLAIN_DIFF_ARGS,
              ...STABLE_PATCH_RENDER_ARGS,
              "--patch",
              "--minimal",
              "--end-of-options",
              range,
            ],
            {
              maxOutputBytes: RANGE_DIFF_PATCH_MAX_OUTPUT_BYTES,
              truncateOutputAtMaxBytes: true,
            },
          ),
        ],
        { concurrency: "unbounded" },
      );

      return {
        commitSummary,
        diffSummary,
        diffPatch,
      };
    },
  );

  const readConfigValue: GitCoreShape["readConfigValue"] = (cwd, key) =>
    runGitStdout("GitCore.readConfigValue", cwd, ["config", "--get", key], true).pipe(
      Effect.map((stdout) => stdout.trim()),
      Effect.map((trimmed) => (trimmed.length > 0 ? trimmed : null)),
    );

  const isInsideWorkTree: GitCoreShape["isInsideWorkTree"] = (cwd) =>
    executeGit("GitCore.isInsideWorkTree", cwd, ["rev-parse", "--is-inside-work-tree"], {
      allowNonZeroExit: true,
      timeoutMs: 5_000,
      maxOutputBytes: 4_096,
    }).pipe(Effect.map((result) => result.code === 0 && result.stdout.trim() === "true"));

  const listWorkspaceFiles: GitCoreShape["listWorkspaceFiles"] = (cwd) =>
    executeGit("GitCore.listWorkspaceFiles", cwd, WORKSPACE_LS_FILES_ARGS, {
      allowNonZeroExit: true,
      timeoutMs: 20_000,
      maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
      truncateOutputAtMaxBytes: true,
    }).pipe(
      Effect.flatMap((result) =>
        result.code === 0
          ? Effect.succeed({
              paths: splitNullSeparatedPaths(result.stdout, result.stdoutTruncated),
              truncated: result.stdoutTruncated,
            })
          : Effect.fail(
              createGitCommandError(
                "GitCore.listWorkspaceFiles",
                cwd,
                WORKSPACE_LS_FILES_ARGS,
                result.stderr.trim().length > 0 ? result.stderr.trim() : "git ls-files failed",
              ),
            ),
      ),
    );

  const filterIgnoredPaths: GitCoreShape["filterIgnoredPaths"] = (cwd, relativePaths) =>
    Effect.gen(function* () {
      if (relativePaths.length === 0) {
        return relativePaths;
      }

      const ignoredPaths = new Set<string>();
      const chunks = chunkPathsForGitCheckIgnore(relativePaths);

      for (const chunk of chunks) {
        const result = yield* executeGit(
          "GitCore.filterIgnoredPaths",
          cwd,
          WORKSPACE_CHECK_IGNORE_ARGS,
          {
            stdin: `${chunk.join("\0")}\0`,
            allowNonZeroExit: true,
            timeoutMs: 20_000,
            maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
            truncateOutputAtMaxBytes: true,
          },
        );

        if (result.code !== 0 && result.code !== 1) {
          return yield* createGitCommandError(
            "GitCore.filterIgnoredPaths",
            cwd,
            WORKSPACE_CHECK_IGNORE_ARGS,
            result.stderr.trim().length > 0 ? result.stderr.trim() : "git check-ignore failed",
          );
        }

        for (const ignoredPath of splitNullSeparatedPaths(result.stdout, result.stdoutTruncated)) {
          ignoredPaths.add(ignoredPath);
        }
      }

      if (ignoredPaths.size === 0) {
        return relativePaths;
      }

      return relativePaths.filter((relativePath) => !ignoredPaths.has(relativePath));
    });

  const listBranches: GitCoreShape["listBranches"] = Effect.fn("listBranches")(function* (input) {
    const branchRecencyPromise = readBranchRecency(input.cwd).pipe(
      Effect.catch(() => Effect.succeed(new Map<string, number>())),
    );
    const localBranchResult = yield* recoverMissingGitCwd(
      executeGit(
        "GitCore.listBranches.branchNoColor",
        input.cwd,
        ["branch", "--no-color", "--no-column"],
        {
          timeoutMs: 10_000,
          allowNonZeroExit: true,
        },
      ),
      input.cwd,
      () =>
        ({
          code: 128,
          stdout: "",
          stderr: "fatal: not a git repository",
          stdoutTruncated: false,
          stderrTruncated: false,
        }) satisfies ExecuteGitResult,
    );

    if (localBranchResult.code !== 0) {
      const stderr = localBranchResult.stderr.trim();
      if (isNotGitRepositoryStderr(stderr)) {
        return {
          branches: [],
          isRepo: false,
          hasOriginRemote: false,
          nextCursor: null,
          totalCount: 0,
        };
      }
      return yield* createGitCommandError(
        "GitCore.listBranches",
        input.cwd,
        ["branch", "--no-color", "--no-column"],
        stderr || "git branch failed",
      );
    }

    const remoteBranchResultEffect = executeGit(
      "GitCore.listBranches.remoteBranches",
      input.cwd,
      ["branch", "--no-color", "--no-column", "--remotes"],
      {
        timeoutMs: 10_000,
        allowNonZeroExit: true,
      },
    ).pipe(
      Effect.catch((error) =>
        Effect.logWarning(
          `GitCore.listBranches: remote branch lookup failed for ${input.cwd}: ${error.message}. Falling back to an empty remote branch list.`,
        ).pipe(Effect.as({ code: 1, stdout: "", stderr: "" })),
      ),
    );

    const remoteNamesResultEffect = executeGit(
      "GitCore.listBranches.remoteNames",
      input.cwd,
      ["remote"],
      {
        timeoutMs: 5_000,
        allowNonZeroExit: true,
      },
    ).pipe(
      Effect.catch((error) =>
        Effect.logWarning(
          `GitCore.listBranches: remote name lookup failed for ${input.cwd}: ${error.message}. Falling back to an empty remote name list.`,
        ).pipe(Effect.as({ code: 1, stdout: "", stderr: "" })),
      ),
    );

    const repositoryPathsResultEffect = executeGit(
      "GitCore.listBranches.repositoryPaths",
      input.cwd,
      ["rev-parse", "--git-common-dir", "--show-toplevel"],
      {
        timeoutMs: 5_000,
        allowNonZeroExit: true,
      },
    ).pipe(Effect.catch(() => Effect.succeed({ code: 1, stdout: "", stderr: "" })));

    const [
      defaultRef,
      worktreeList,
      remoteBranchResult,
      remoteNamesResult,
      branchLastCommit,
      repositoryPathsResult,
    ] = yield* Effect.all(
      [
        executeGit(
          "GitCore.listBranches.defaultRef",
          input.cwd,
          ["symbolic-ref", "refs/remotes/origin/HEAD"],
          {
            timeoutMs: 5_000,
            allowNonZeroExit: true,
          },
        ),
        executeGit(
          "GitCore.listBranches.worktreeList",
          input.cwd,
          ["worktree", "list", "--porcelain"],
          {
            timeoutMs: 5_000,
            allowNonZeroExit: true,
          },
        ),
        remoteBranchResultEffect,
        remoteNamesResultEffect,
        branchRecencyPromise,
        repositoryPathsResultEffect,
      ],
      { concurrency: "unbounded" },
    );

    const remoteNames =
      remoteNamesResult.code === 0 ? parseRemoteNames(remoteNamesResult.stdout) : [];
    if (remoteBranchResult.code !== 0 && remoteBranchResult.stderr.trim().length > 0) {
      yield* Effect.logWarning(
        `GitCore.listBranches: remote branch lookup returned code ${remoteBranchResult.code} for ${input.cwd}: ${remoteBranchResult.stderr.trim()}. Falling back to an empty remote branch list.`,
      );
    }
    if (remoteNamesResult.code !== 0 && remoteNamesResult.stderr.trim().length > 0) {
      yield* Effect.logWarning(
        `GitCore.listBranches: remote name lookup returned code ${remoteNamesResult.code} for ${input.cwd}: ${remoteNamesResult.stderr.trim()}. Falling back to an empty remote name list.`,
      );
    }

    const defaultBranch =
      defaultRef.code === 0
        ? defaultRef.stdout.trim().replace(/^refs\/remotes\/origin\//, "")
        : null;

    const [reportedGitCommonDir = "", reportedToplevel = ""] =
      repositoryPathsResult.stdout.split(/\r?\n/g);
    const gitCommonDir =
      reportedGitCommonDir.trim().length > 0
        ? path.resolve(yield* resolveGitReportedPath(input.cwd, reportedGitCommonDir.trim()))
        : null;
    const worktreeRoot =
      repositoryPathsResult.code === 0 && reportedToplevel.length > 0
        ? path.normalize(reportedToplevel)
        : null;

    const worktreeMap = new Map<string, string>();
    if (worktreeList.code === 0) {
      let currentPath: string | null = null;
      for (const line of worktreeList.stdout.split("\n")) {
        if (line.startsWith("worktree ")) {
          const candidatePath = line.slice("worktree ".length);
          // Without `core.worktree`, git lists a separate git dir as the main checkout.
          const exists =
            candidatePath.length > 0 && path.resolve(candidatePath) === gitCommonDir
              ? false
              : yield* fileSystem.stat(candidatePath).pipe(
                  Effect.map(() => true),
                  Effect.catch(() => Effect.succeed(false)),
                );
          currentPath = exists ? candidatePath : null;
        } else if (line.startsWith("branch refs/heads/") && currentPath) {
          worktreeMap.set(line.slice("branch refs/heads/".length), currentPath);
        } else if (line === "") {
          currentPath = null;
        }
      }
    }

    const localBranches = localBranchResult.stdout
      .split("\n")
      .map(parseBranchLine)
      .filter((branch): branch is { name: string; current: boolean } => branch !== null)
      .map((branch) => ({
        name: branch.name,
        current: branch.current,
        isRemote: false,
        isDefault: branch.name === defaultBranch,
        worktreePath:
          worktreeMap.get(branch.name) ?? (branch.current && worktreeRoot ? worktreeRoot : null),
      }))
      .toSorted((a, b) => {
        const aPriority = a.current ? 0 : a.isDefault ? 1 : 2;
        const bPriority = b.current ? 0 : b.isDefault ? 1 : 2;
        if (aPriority !== bPriority) return aPriority - bPriority;

        const aLastCommit = branchLastCommit.get(a.name) ?? 0;
        const bLastCommit = branchLastCommit.get(b.name) ?? 0;
        if (aLastCommit !== bLastCommit) return bLastCommit - aLastCommit;
        return a.name.localeCompare(b.name);
      });

    const remoteBranches =
      remoteBranchResult.code === 0
        ? remoteBranchResult.stdout
            .split("\n")
            .map(parseBranchLine)
            .filter((branch): branch is { name: string; current: boolean } => branch !== null)
            .map((branch) => {
              const parsedRemoteRef = parseRemoteRefWithRemoteNames(branch.name, remoteNames);
              const remoteBranch: {
                name: string;
                current: boolean;
                isRemote: boolean;
                remoteName?: string;
                isDefault: boolean;
                worktreePath: string | null;
              } = {
                name: branch.name,
                current: false,
                isRemote: true,
                isDefault:
                  defaultBranch !== null &&
                  parsedRemoteRef?.remoteName === "origin" &&
                  parsedRemoteRef.branchName === defaultBranch,
                worktreePath: null,
              };
              if (parsedRemoteRef) {
                remoteBranch.remoteName = parsedRemoteRef.remoteName;
              }
              return remoteBranch;
            })
            .toSorted((a, b) => {
              const aLastCommit = branchLastCommit.get(a.name) ?? 0;
              const bLastCommit = branchLastCommit.get(b.name) ?? 0;
              if (aLastCommit !== bLastCommit) return bLastCommit - aLastCommit;
              return a.name.localeCompare(b.name);
            })
        : [];

    // Before pagination, so origin's default stays on page 1 past a page of local branches.
    const sortedBranches = dedupeRemoteBranchesWithLocalMatches([
      ...localBranches,
      ...remoteBranches,
    ]).toSorted((a, b) => {
      const aPriority = a.current ? 0 : a.isDefault ? 1 : 2;
      const bPriority = b.current ? 0 : b.isDefault ? 1 : 2;
      return aPriority - bPriority;
    });

    const branches = paginateBranches({
      branches: filterBranchesForListQuery(sortedBranches, input.query),
      cursor: input.cursor,
      limit: input.limit,
    });

    return {
      branches: [...branches.branches],
      isRepo: true,
      hasOriginRemote: remoteNames.length > 0,
      nextCursor: branches.nextCursor,
      totalCount: branches.totalCount,
    };
  });

  const worktreeBranchLocks = yield* KeyedLock.make<string>();
  const withWorktreeBranchLock = <A, E, R>(
    branch: string,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> => worktreeBranchLocks.withLock(branch, effect);

  // Git can fail before creating the branch (a bad start point), so only delete one that exists.
  const deleteStrandedWorktreeBranch = (cwd: string, branch: string) =>
    branchExists(cwd, branch).pipe(
      Effect.flatMap((exists) =>
        exists
          ? runGit("GitCore.createWorktree.deleteBranch", cwd, ["branch", "-D", "--", branch])
          : Effect.void,
      ),
    );

  // `git branch -D` refuses a checked-out branch, so the worktree goes first.
  const cleanUpInterruptedWorktree = Effect.fn("cleanUpInterruptedWorktree")(function* (input: {
    readonly cwd: string;
    readonly worktreePath: string | null;
    readonly newBranch: string | null;
  }) {
    if (input.worktreePath !== null) {
      // Twice, because an add killed partway leaves its worktree locked as "initializing".
      const removed = yield* executeGit(
        "GitCore.createWorktree.removeInterrupted",
        input.cwd,
        ["worktree", "remove", "--force", "--force", "--", input.worktreePath],
        { allowNonZeroExit: true, timeoutMs: WORKTREE_REMOVE_TIMEOUT_MS },
      );
      if (removed.code !== 0) {
        // Stopped before it became a worktree Git recognises; the caller knows the path is ours.
        yield* fileSystem
          .remove(input.worktreePath, { recursive: true, force: true })
          .pipe(Effect.ignore);
        yield* runGit("GitCore.createWorktree.pruneInterrupted", input.cwd, ["worktree", "prune"]);
      }
    }
    if (input.newBranch !== null) {
      yield* deleteStrandedWorktreeBranch(input.cwd, input.newBranch);
    }
  });

  // Fetches <remote>/<branch> and resolves its commit.
  const fetchRemoteWorktreeStart = (cwd: string, remoteName: string, remoteBranch: string) =>
    executeGitRetryingRefLock(
      "GitCore.createWorktree.fetchBase",
      cwd,
      ["fetch", "--quiet", "--no-tags", "--no-auto-gc", "--", remoteName, remoteBranch],
      { env: STATUS_UPSTREAM_REFRESH_ENV, timeoutMs: WORKTREE_BASE_FETCH_TIMEOUT_MS },
    ).pipe(
      Effect.andThen(
        runGitStdout("GitCore.createWorktree.resolveRemoteBase", cwd, [
          "rev-parse",
          "--verify",
          "--quiet",
          `refs/remotes/${remoteName}/${remoteBranch}^{commit}`,
        ]),
      ),
      Effect.map((stdout) => ({ commitSha: stdout.trim() })),
      Effect.flatMap((start) =>
        start.commitSha.length > 0
          ? Effect.succeed(start)
          : Effect.fail(
              createGitCommandError(
                "GitCore.createWorktree.resolveRemoteBase",
                cwd,
                ["rev-parse"],
                `refs/remotes/${remoteName}/${remoteBranch} does not exist.`,
              ),
            ),
      ),
    );

  // Best effort: offline or a missing remote branch falls back to the local base with a warning.
  const resolveOriginWorktreeStart = Effect.fn("resolveOriginWorktreeStart")(function* (
    cwd: string,
    baseBranch: string,
  ) {
    if (!(yield* branchExists(cwd, baseBranch).pipe(Effect.orElseSucceed(() => false)))) {
      return null;
    }
    const candidates: Array<{ remoteName: string; remoteBranch: string }> = [];
    // A base that tracks another remote (a fork's main tracking `upstream`) starts from that remote.
    const trackedRemote = yield* readBranchRemote(cwd, baseBranch);
    const trackedMerge = yield* readConfigValue(cwd, `branch.${baseBranch}.merge`).pipe(
      Effect.orElseSucceed(() => null),
    );
    if (trackedRemote && trackedRemote !== "." && trackedMerge?.startsWith("refs/heads/")) {
      candidates.push({
        remoteName: trackedRemote,
        remoteBranch: trackedMerge.slice("refs/heads/".length),
      });
    }
    const primaryRemote = yield* resolvePrimaryRemoteName(cwd).pipe(
      Effect.orElseSucceed(() => null),
    );
    if (primaryRemote !== null && primaryRemote !== trackedRemote) {
      candidates.push({ remoteName: primaryRemote, remoteBranch: baseBranch });
    }
    for (const candidate of candidates) {
      const start = yield* fetchRemoteWorktreeStart(
        cwd,
        candidate.remoteName,
        candidate.remoteBranch,
      ).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("could not start the worktree from the remote branch", {
            ...candidate,
            baseBranch,
            detail: cause.detail,
          }).pipe(Effect.as(null)),
        ),
      );
      if (start !== null) return start;
    }
    return null;
  });

  // `worktree add` leaves submodule folders empty; failures only warn so the thread still starts.
  const checkOutWorktreeSubmodules = Effect.fn("checkOutWorktreeSubmodules")(function* (
    worktreePath: string,
    mode: ServerSettings["worktreeSubmodules"],
  ) {
    if (mode === "none") return;
    const hasSubmodules = yield* fileSystem
      .exists(path.join(worktreePath, ".gitmodules"))
      .pipe(Effect.orElseSucceed(() => false));
    if (!hasSubmodules) return;
    yield* runGit(
      "GitCore.createWorktree.updateSubmodules",
      worktreePath,
      mode === "recursive"
        ? ["submodule", "update", "--init", "--recursive"]
        : ["submodule", "update", "--init"],
      // Cloning scales with remote size; bound it like worktree add and never wait on a prompt.
      { timeoutMs: WORKTREE_ADD_TIMEOUT_MS, env: STATUS_UPSTREAM_REFRESH_ENV },
    ).pipe(
      // The first init writes submodule.<name>.url to the shared config; rerunning it is idempotent.
      retryWhileConfigLocked,
      Effect.catch((cause) =>
        Effect.logWarning("worktree submodule checkout failed; submodules may be incomplete", {
          worktreePath,
          detail: cause.detail,
        }),
      ),
    );
  });

  const createWorktree: GitCoreShape["createWorktree"] = Effect.fn("createWorktree")(
    function* (input, options) {
      for (const refName of [input.branch, input.newBranch ?? ""]) {
        yield* refuseOptionLikeRefName("GitCore.createWorktree", input.cwd, refName, [
          "worktree",
          "add",
        ]);
      }
      let newBranch = input.newBranch;
      // A plain `piedpiper` branch makes every `piedpiper/<hex>` placeholder ref impossible.
      if (
        newBranch &&
        newBranch.includes("/") &&
        isTemporaryWorktreeBranch(newBranch) &&
        (yield* branchExists(input.cwd, TEMPORARY_WORKTREE_BRANCH_PREFIX))
      ) {
        newBranch = flattenTemporaryWorktreeBranchName(newBranch);
      }
      const targetBranch = newBranch ?? input.branch;
      const settings = yield* readServerSettings;
      let worktreePath = input.path;
      if (worktreePath === null) {
        const worktreesRoot = resolveWorktreesDirectory({
          configured: settings.worktreesDirectory,
          defaultDirectory: worktreesDir,
          platform,
        });
        if (!worktreesRoot.ok) {
          return yield* createGitCommandError(
            "GitCore.createWorktree",
            input.cwd,
            ["worktree", "add"],
            worktreesRoot.detail,
          );
        }
        worktreePath = path.join(
          worktreesRoot.directory,
          path.basename(input.cwd),
          worktreeDirectoryName(targetBranch, yield* resolveGitCommonDir(input.cwd)),
        );
        // A location that holds the repo itself (e.g. ~/code for ~/code/app) would nest the
        // worktree inside the main checkout, where `git clean` or the main thread can touch it.
        const realPathOrSelf = (value: string) =>
          fileSystem.realPath(value).pipe(Effect.orElseSucceed(() => value));
        const physicalRoot = yield* realPathOrSelf(worktreesRoot.directory);
        const physicalCwd = yield* realPathOrSelf(input.cwd);
        const physicalWorktreePath = path.join(
          physicalRoot,
          path.relative(worktreesRoot.directory, worktreePath),
        );
        if (isPathInsideDirectory(physicalWorktreePath, physicalCwd, platform)) {
          return yield* createGitCommandError(
            "GitCore.createWorktree",
            input.cwd,
            ["worktree", "add"],
            `New worktrees would be created inside the repository at ${worktreePath}. Choose a folder outside it in Settings > Git > Worktree location.`,
          );
        }
      }
      const originStart =
        newBranch && settings.newWorktreesStartFromOrigin
          ? yield* resolveOriginWorktreeStart(input.cwd, input.branch)
          : null;
      const startPoint = originStart?.commitSha ?? input.branch;
      // Parallel checkout (0 = one worker per core) unless the user chose a count, e.g. 1 on NFS.
      const checkoutWorkers =
        (yield* readConfigValue(input.cwd, "checkout.workers").pipe(
          Effect.orElseSucceed(() => null),
        )) ?? "0";
      const addArgs = newBranch
        ? ["worktree", "add", "-b", newBranch, "--", worktreePath, startPoint]
        : ["worktree", "add", "--", worktreePath, input.branch];
      const args = ["-c", `checkout.workers=${checkoutWorkers}`, ...addArgs];
      const onCheckoutProgress = options?.onCheckoutProgress;
      const stockWorktree = executeGit("GitCore.createWorktree", input.cwd, args, {
        timeoutMs: WORKTREE_ADD_TIMEOUT_MS,
        fallbackErrorMessage: "git worktree add failed",
        ...(onCheckoutProgress
          ? {
              env: GIT_CHECKOUT_PROGRESS_ENV,
              progress: {
                onStderrLine: (line: string) => {
                  const progress = parseGitCheckoutProgressLine(line);
                  return progress === null ? Effect.void : onCheckoutProgress(progress);
                },
              },
            }
          : {}),
      }).pipe(
        // The progress env fills stderr with redraws, which would bury the real `fatal:` line.
        Effect.mapError((error) =>
          onCheckoutProgress
            ? new GitCommandError({ ...error, detail: stripGitCheckoutProgressLines(error.detail) })
            : error,
        ),
      );

      const fastCheckout = settings.fastWorktreeCheckout && checkoutCache !== undefined;
      const cacheGeneration = fastCheckout ? yield* checkoutCache.currentGeneration : 0;
      const addWorktree = fastCheckout
        ? checkoutCache
            .create({
              cwd: input.cwd,
              worktreePath,
              refName: startPoint,
              ...(newBranch ? { newBranch } : {}),
              checkoutWorkers,
            })
            .pipe(Effect.flatMap((cloned) => (cloned ? Effect.void : stockWorktree)))
        : stockWorktree;
      const createdPath = worktreePath;
      const requestedBranch = newBranch;
      const finishWorktree = Effect.gen(function* () {
        if (requestedBranch && originStart) {
          // Records the base so status and push compare against it rather than a guessed default.
          yield* runConfigWrite("GitCore.createWorktree.recordMergeBase", input.cwd, [
            "config",
            `branch.${requestedBranch}.gh-merge-base`,
            input.branch,
          ]).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("could not record the base branch of a new worktree", { cause }),
            ),
          );
        }
        yield* checkOutWorktreeSubmodules(createdPath, settings.worktreeSubmodules);
      });

      const addAndFinishWorktree = (branchCreatedHere: string | null) =>
        Effect.gen(function* () {
          const absolutePath = path.resolve(input.cwd, createdPath);
          // Git refuses a folder with contents, so an interrupt must not delete what was already there.
          const pathOccupiedBefore = yield* fileSystem.readDirectory(absolutePath).pipe(
            Effect.map((entries) => entries.length > 0),
            Effect.catch((error) => Effect.succeed(error.reason._tag !== "NotFound")),
          );
          yield* addWorktree.pipe(
            // `worktree add -b` creates the branch before checking the folder, so a failure strands it.
            Effect.onError((cause) =>
              branchCreatedHere === null || Cause.hasInterruptsOnly(cause)
                ? Effect.void
                : deleteStrandedWorktreeBranch(input.cwd, branchCreatedHere).pipe(
                    Effect.catch((error) =>
                      Effect.logWarning("could not remove the branch of a failed worktree", {
                        cause: error,
                      }),
                    ),
                  ),
            ),
            Effect.andThen(finishWorktree),
            Effect.andThen(() =>
              fastCheckout ? checkoutCache.schedule(createdPath, cacheGeneration) : Effect.void,
            ),
            Effect.onInterrupt(() =>
              cleanUpInterruptedWorktree({
                cwd: input.cwd,
                worktreePath: pathOccupiedBefore ? null : absolutePath,
                newBranch: branchCreatedHere,
              }).pipe(
                Effect.catch((error) =>
                  Effect.logWarning("could not clean up an interrupted worktree", { cause: error }),
                ),
                Effect.uninterruptible,
              ),
            ),
          );
        });

      if (requestedBranch) {
        // Serialised per branch so a concurrent add of the same branch never deletes the winner's branch.
        yield* withWorktreeBranchLock(
          requestedBranch,
          Effect.gen(function* () {
            const existedBefore = yield* branchExists(input.cwd, requestedBranch);
            yield* addAndFinishWorktree(existedBefore ? null : requestedBranch);
          }),
        );
      } else {
        yield* addAndFinishWorktree(null);
      }

      return {
        worktree: {
          path: worktreePath,
          branch: targetBranch,
        },
      };
    },
  );

  const diffPreview: GitCoreShape["diffPreview"] = (input) =>
    readGitDiffPreview(
      {
        execute,
        // The default branch compares with its own remote copy, not only its uncommitted changes.
        resolveBaseBranch: (cwd, branch) =>
          resolveBaseBranchForNoUpstream(cwd, branch, { allowRemoteOfCurrent: true }),
        fileSystem,
        path,
      },
      input,
    );

  const fetchPullRequestBranch: GitCoreShape["fetchPullRequestBranch"] = Effect.fn(
    "fetchPullRequestBranch",
  )(function* (input) {
    const remoteName = yield* resolvePrimaryRemoteName(input.cwd);
    yield* executeGitRetryingRefLock(
      "GitCore.fetchPullRequestBranch",
      input.cwd,
      [
        "fetch",
        "--quiet",
        "--no-tags",
        "--",
        remoteName,
        `+refs/pull/${input.prNumber}/head:refs/heads/${input.branch}`,
      ],
      {
        fallbackErrorMessage: "git fetch pull request branch failed",
      },
    );
  });

  const fetchRemoteBranch: GitCoreShape["fetchRemoteBranch"] = Effect.fn("fetchRemoteBranch")(
    function* (input) {
      yield* executeGitRetryingRefLock("GitCore.fetchRemoteBranch.fetch", input.cwd, [
        "fetch",
        "--quiet",
        "--no-tags",
        "--",
        input.remoteName,
        `+refs/heads/${input.remoteBranch}:refs/remotes/${input.remoteName}/${input.remoteBranch}`,
      ]);

      const localBranchAlreadyExists = yield* branchExists(input.cwd, input.localBranch);
      const targetRef = `${input.remoteName}/${input.remoteBranch}`;
      if (localBranchAlreadyExists) {
        // Repeating a forced reset to the same ref is harmless, so a lost config lock retries.
        return yield* runConfigWrite("GitCore.fetchRemoteBranch.materialize", input.cwd, [
          "branch",
          "--force",
          "--",
          input.localBranch,
          targetRef,
        ]);
      }
      // `git branch` fails outright on a locked config while recording tracking, so the branch is
      // created untracked and tracking is recorded by a write that retries.
      yield* runGit("GitCore.fetchRemoteBranch.materialize", input.cwd, [
        "branch",
        "--no-track",
        "--",
        input.localBranch,
        targetRef,
      ]);
      yield* runConfigWrite("GitCore.fetchRemoteBranch.track", input.cwd, [
        "branch",
        `--set-upstream-to=refs/remotes/${targetRef}`,
        "--",
        input.localBranch,
      ]).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("fetched the branch without tracking its remote", { cause }),
        ),
      );
    },
  );

  const setBranchUpstream: GitCoreShape["setBranchUpstream"] = (input) =>
    runConfigWrite("GitCore.setBranchUpstream", input.cwd, [
      "branch",
      "--set-upstream-to",
      `${input.remoteName}/${input.remoteBranch}`,
      "--",
      input.branch,
    ]);

  const removeWorktree: GitCoreShape["removeWorktree"] = Effect.fn("removeWorktree")(
    function* (input) {
      // Resolve once so git and the Windows deletion act on the same folder (git also matches short names).
      const target = path.resolve(input.cwd, input.path);
      const args = ["worktree", "remove", ...(input.force ? ["--force"] : []), "--", target];
      yield* removeLinkedWorktree({
        operation: "GitCore.removeWorktree",
        cwd: input.cwd,
        worktreePath: target,
        force: input.force === true,
        platform,
        execute,
        run: (runArgs) =>
          executeGit("GitCore.removeWorktree", input.cwd, runArgs, {
            timeoutMs: WORKTREE_REMOVE_TIMEOUT_MS,
            fallbackErrorMessage: "git worktree remove failed",
          }).pipe(Effect.asVoid),
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        // Already deleted outside the app: prune so the stale registration cannot block a re-add.
        Effect.catchIf(
          (error) => Schema.is(GitCommandError)(error) && isMissingWorktreeStderr(error.detail),
          (error) =>
            fileSystem.exists(target).pipe(
              Effect.orElseSucceed(() => true),
              Effect.flatMap((exists) =>
                exists
                  ? Effect.fail(error)
                  : runGit("GitCore.removeWorktree.prune", input.cwd, ["worktree", "prune"]),
              ),
            ),
        ),
        Effect.mapError((error) =>
          createGitCommandError(
            "GitCore.removeWorktree",
            input.cwd,
            args,
            `${commandLabel(args)} failed (cwd: ${input.cwd}): ${error instanceof Error ? error.message : String(error)}`,
            error,
          ),
        ),
      );
    },
  );

  const renameBranch: GitCoreShape["renameBranch"] = Effect.fn("renameBranch")(function* (input) {
    if (input.oldBranch === input.newBranch) {
      return { branch: input.newBranch };
    }
    const targetBranch = yield* resolveAvailableBranchName(input.cwd, input.newBranch);

    yield* executeGit(
      "GitCore.renameBranch",
      input.cwd,
      ["branch", "-m", "--", input.oldBranch, targetBranch],
      {
        timeoutMs: 10_000,
        fallbackErrorMessage: "git branch rename failed",
      },
    );

    return { branch: targetBranch };
  });

  const createBranch: GitCoreShape["createBranch"] = (input) =>
    executeGit("GitCore.createBranch", input.cwd, ["branch", "--", input.branch], {
      timeoutMs: 10_000,
      fallbackErrorMessage: "git branch create failed",
    }).pipe(Effect.asVoid);

  const checkoutBranch: GitCoreShape["checkoutBranch"] = Effect.fn("checkoutBranch")(
    function* (input) {
      const [localInputExists, remoteExists] = yield* Effect.all(
        [
          executeGit(
            "GitCore.checkoutBranch.localInputExists",
            input.cwd,
            ["show-ref", "--verify", "--quiet", `refs/heads/${input.branch}`],
            {
              timeoutMs: 5_000,
              allowNonZeroExit: true,
            },
          ).pipe(Effect.map((result) => result.code === 0)),
          executeGit(
            "GitCore.checkoutBranch.remoteExists",
            input.cwd,
            ["show-ref", "--verify", "--quiet", `refs/remotes/${input.branch}`],
            {
              timeoutMs: 5_000,
              allowNonZeroExit: true,
            },
          ).pipe(Effect.map((result) => result.code === 0)),
        ],
        { concurrency: "unbounded" },
      );

      const localTrackingBranch = remoteExists
        ? yield* executeGit(
            "GitCore.checkoutBranch.localTrackingBranch",
            input.cwd,
            ["for-each-ref", "--format=%(refname:short)\t%(upstream:short)", "refs/heads"],
            {
              timeoutMs: 5_000,
              allowNonZeroExit: true,
            },
          ).pipe(
            Effect.map((result) =>
              result.code === 0
                ? parseTrackingBranchByUpstreamRef(result.stdout, input.branch)
                : null,
            ),
          )
        : null;

      const localTrackedBranchCandidate = deriveLocalBranchNameFromRemoteRef(input.branch);
      const localTrackedBranchTargetExists =
        remoteExists && localTrackedBranchCandidate
          ? yield* executeGit(
              "GitCore.checkoutBranch.localTrackedBranchTargetExists",
              input.cwd,
              ["show-ref", "--verify", "--quiet", `refs/heads/${localTrackedBranchCandidate}`],
              {
                timeoutMs: 5_000,
                allowNonZeroExit: true,
              },
            ).pipe(Effect.map((result) => result.code === 0))
          : false;

      const checkoutArgs = localInputExists
        ? ["checkout", input.branch]
        : remoteExists && !localTrackingBranch && localTrackedBranchTargetExists
          ? ["checkout", input.branch]
          : remoteExists && !localTrackingBranch
            ? ["checkout", "--track", input.branch]
            : remoteExists && localTrackingBranch
              ? ["checkout", localTrackingBranch]
              : ["checkout", input.branch];

      yield* refuseOptionLikeRefName(
        "GitCore.checkoutBranch",
        input.cwd,
        checkoutArgs.at(-1) ?? input.branch,
        checkoutArgs,
      );
      // A trailing `--` keeps a name that is not a ref from becoming a path checkout that discards edits.
      yield* executeGit("GitCore.checkoutBranch.checkout", input.cwd, [...checkoutArgs, "--"], {
        timeoutMs: 10_000,
        fallbackErrorMessage: "git checkout failed",
      });
    },
  );

  const initRepo: GitCoreShape["initRepo"] = (input) =>
    executeGit("GitCore.initRepo", input.cwd, ["init"], {
      timeoutMs: 10_000,
      fallbackErrorMessage: "git init failed",
    }).pipe(Effect.asVoid);

  const listLocalBranchNames: GitCoreShape["listLocalBranchNames"] = (cwd) =>
    runGitStdout("GitCore.listLocalBranchNames", cwd, [
      "branch",
      "--list",
      "--no-column",
      // `refname:short` prints `heads/<name>` when a tag shares the name.
      "--format=%(refname:lstrip=2)",
    ]).pipe(
      Effect.map((stdout) =>
        stdout
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0),
      ),
    );

  return {
    execute,
    status,
    statusDetails,
    prepareCommitContext,
    commit,
    pushCurrentBranch,
    pullCurrentBranch,
    readRangeContext,
    readConfigValue,
    isInsideWorkTree,
    listWorkspaceFiles,
    filterIgnoredPaths,
    listBranches,
    createWorktree,
    diffPreview,
    fetchPullRequestBranch,
    ensureRemote,
    fetchRemoteBranch,
    setBranchUpstream,
    removeWorktree,
    renameBranch,
    createBranch,
    checkoutBranch,
    initRepo,
    listLocalBranchNames,
  } satisfies GitCoreShape;
});

export const GitCoreLive = Layer.effect(GitCore, makeGitCore());
