import path from "node:path";

import {
  DEFAULT_TERMINAL_ID,
  type TerminalEvent,
  type TerminalMetadataStreamEvent,
  type TerminalSessionSnapshot,
  type TerminalSessionStatus,
  type TerminalSummary,
} from "@piedpiper/contracts";
import { makeKeyedCoalescingWorker } from "@piedpiper/shared/KeyedCoalescingWorker";
import * as KeyedLock from "@piedpiper/shared/KeyedLock";
import {
  Data,
  Deferred,
  Duration,
  Effect,
  Equal,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Scope,
  SynchronizedRef,
} from "effect";

import { ServerConfig } from "../../config";
import {
  increment,
  terminalRestartsTotal,
  terminalSessionsTotal,
} from "../../observability/Metrics";
import { runProcess } from "../../processRunner";
import {
  TerminalCwdError,
  TerminalHistoryError,
  TerminalManager,
  TerminalNotRunningError,
  TerminalResizeError,
  TerminalSessionLookupError,
  TerminalWriteError,
  type TerminalManagerShape,
} from "../Services/Manager";
import {
  PtyAdapter,
  PtySpawnError,
  type PtyAdapterShape,
  type PtyExitEvent,
  type PtyProcess,
} from "../Services/PTY";
import {
  type ShellCandidate,
  defaultShellResolver,
  formatShellCandidate,
  isRetryableShellSpawnError,
  resolveShellCandidates,
} from "./ShellResolver";
import { BoundedTerminalHistory, DEFAULT_HISTORY_BYTE_LIMIT } from "./BoundedTerminalHistory";
import { takePendingProcessEvent } from "./PendingProcessEventQueue";
import {
  type TerminalProcessTableEntry,
  type TerminalSubprocessState,
  indexProcessTable,
  parsePosixProcessGroupTable,
  parsePosixProcessTable,
  parseWindowsProcessTable,
  subprocessSnapshotPollDelayMs,
  terminalSubprocessState,
  windowsChildProcessQuery,
} from "./TerminalProcessTable";
import { neutralizeInheritedHistory, sanitizeTerminalHistoryChunk } from "./TerminalSanitizer";
import {
  legacySafeThreadId,
  encodedHistoryName,
  hashedHistoryThreadPart,
  historyName,
  MAX_HISTORY_FILENAME_BYTES,
  toSafeThreadId,
  toSessionKey,
} from "./TerminalSessionKeys";

const DEFAULT_HISTORY_LINE_LIMIT = 5_000;
const DEFAULT_PERSIST_DEBOUNCE_MS = 250;
const DEFAULT_SUBPROCESS_POLL_INTERVAL_MS = 1_000;
// Discover children started without terminal input or output.
const QUIET_SUBPROCESS_SNAPSHOT_EVERY_TICKS = 30;
// A loaded host can take seconds to list processes and the result is still valid; this only ends a stuck query.
const PROCESS_TABLE_QUERY_TIMEOUT_MS = 15_000;
const DEFAULT_PROCESS_KILL_GRACE_MS = 1_000;
const DEFAULT_MAX_RETAINED_INACTIVE_SESSIONS = 128;
const DEFAULT_OPEN_COLS = 120;
const DEFAULT_OPEN_ROWS = 30;
// The tmux/screen/Zellij keys name the multiplexer pane that launched the server, not this terminal.
const TERMINAL_ENV_BLOCKLIST = new Set([
  "PORT",
  "ELECTRON_RENDERER_PORT",
  "ELECTRON_RUN_AS_NODE",
  "TMUX",
  "TMUX_PANE",
  "STY",
  "WINDOW",
  "ZELLIJ",
  "ZELLIJ_SESSION_NAME",
  "ZELLIJ_PANE_ID",
]);

type TerminalSubprocessChecker = (
  terminalPid: number,
) => Effect.Effect<boolean, TerminalSubprocessCheckError>;

type TerminalProcessTableSource = (
  terminalPids: ReadonlyArray<number>,
) => Effect.Effect<ReadonlyArray<TerminalProcessTableEntry>, Error>;

class TerminalSubprocessCheckError extends Data.TaggedError("TerminalSubprocessCheckError")<{
  readonly message: string;
  readonly cause?: unknown;
  readonly terminalPid?: number;
  readonly command: "powershell" | "ps";
  readonly exitCode?: number | null;
  readonly timedOut?: boolean;
  readonly stdoutTruncated?: boolean;
}> {}

class TerminalProcessSignalError extends Data.TaggedError("TerminalProcessSignalError")<{
  readonly message: string;
  readonly cause?: unknown;
  readonly signal: "SIGTERM" | "SIGKILL";
}> {}

interface TerminalStartInput {
  threadId: string;
  terminalId: string;
  cwd: string;
  cols: number;
  rows: number;
  env?: Record<string, string>;
}

interface TerminalSessionState {
  threadId: string;
  terminalId: string;
  cwd: string;
  status: TerminalSessionStatus;
  pid: number | null;
  history: BoundedTerminalHistory;
  pendingHistoryControlSequence: string;
  pendingProcessEvents: Array<PendingProcessEvent | undefined>;
  pendingProcessEventIndex: number;
  processEventDrainRunning: boolean;
  exitCode: number | null;
  exitSignal: number | null;
  updatedAt: string;
  cols: number;
  rows: number;
  viewers: Map<string, { clientId: number; cols: number; rows: number }>;
  process: PtyProcess | null;
  unsubscribeData: (() => void) | null;
  unsubscribeExit: (() => void) | null;
  hasRunningSubprocess: boolean;
  /** Name of the running child command; never persisted. */
  childCommandLabel: string | null;
  runtimeEnv: Record<string, string> | null;
  /** Bumped on input, output and activity events so the idle poller can tell a terminal is quiet. */
  activityCount: number;
  /** Sequence of the last change to this session's snapshot; event replay compares against it. */
  eventSequence: number;
}

interface TerminalMetadataSubscriber {
  readonly listener: (event: TerminalMetadataStreamEvent) => Effect.Effect<void>;
  /** Holds events published while the snapshot is delivered; null once live. */
  pending: TerminalMetadataStreamEvent[] | null;
}

interface QuietTerminalSession {
  readonly process: PtyProcess | null;
  readonly mark: number;
  readonly idleSnapshots: number;
}

interface PersistHistoryRequest {
  history: BoundedTerminalHistory;
  immediate: boolean;
}

type PendingProcessEvent = { type: "output"; data: string } | { type: "exit"; event: PtyExitEvent };

type DrainProcessEventAction =
  | { type: "idle" }
  | {
      type: "output";
      threadId: string;
      terminalId: string;
      history: BoundedTerminalHistory | null;
      data: string;
      sequence: number;
    }
  | {
      type: "exit";
      process: PtyProcess | null;
      threadId: string;
      terminalId: string;
      exitCode: number | null;
      exitSignal: number | null;
    };

interface TerminalManagerState {
  sessions: Map<string, TerminalSessionState>;
  killFibers: Map<PtyProcess, Fiber.Fiber<void, never>>;
}

const desiredGrid = (
  session: TerminalSessionState,
  input: {
    viewerId?: string | undefined;
    cols?: number | undefined;
    rows?: number | undefined;
  },
  clientId: number,
) => {
  const fallback = { cols: input.cols ?? session.cols, rows: input.rows ?? session.rows };
  if (input.viewerId)
    session.viewers.set(`${clientId}:${input.viewerId}`, { clientId, ...fallback });
  const viewers = [...session.viewers.values()];
  return viewers.length === 0
    ? fallback
    : {
        cols: Math.min(...viewers.map((viewer) => viewer.cols)),
        rows: Math.min(...viewers.map((viewer) => viewer.rows)),
      };
};

function snapshot(session: TerminalSessionState): TerminalSessionSnapshot {
  return {
    threadId: session.threadId,
    terminalId: session.terminalId,
    cwd: session.cwd,
    status: session.status,
    pid: session.pid,
    history: session.history.value(),
    cols: session.cols,
    rows: session.rows,
    exitCode: session.exitCode,
    exitSignal: session.exitSignal,
    updatedAt: session.updatedAt,
    ...(session.childCommandLabel !== null ? { label: session.childCommandLabel } : {}),
    sequence: session.eventSequence,
  };
}

function terminalSummary(session: TerminalSessionState): TerminalSummary {
  return {
    threadId: session.threadId,
    terminalId: session.terminalId,
    status: session.status,
    hasRunningSubprocess: session.hasRunningSubprocess,
    ...(session.childCommandLabel !== null ? { label: session.childCommandLabel } : {}),
  };
}

const resizePtyProcess = (
  session: TerminalSessionState,
  process: PtyProcess,
  cols: number,
  rows: number,
) =>
  Effect.try({
    try: () => process.resize(cols, rows),
    catch: (cause) =>
      new TerminalResizeError({
        threadId: session.threadId,
        terminalId: session.terminalId,
        terminalPid: process.pid,
        cols,
        rows,
        cause,
      }),
  });

function cleanupProcessHandles(session: TerminalSessionState): void {
  session.unsubscribeData?.();
  session.unsubscribeData = null;
  session.unsubscribeExit?.();
  session.unsubscribeExit = null;
}

function enqueueProcessEvent(
  session: TerminalSessionState,
  expectedPid: number,
  event: PendingProcessEvent,
): boolean {
  if (!session.process || session.status !== "running" || session.pid !== expectedPid) {
    return false;
  }

  session.pendingProcessEvents.push(event);
  if (session.processEventDrainRunning) {
    return false;
  }

  session.processEventDrainRunning = true;
  return true;
}

// node-pty and Bun do not replay a past exit to late onExit subscribers, so a queued exit must skip kill escalation.
function hasPendingExitEvent(session: TerminalSessionState): boolean {
  for (let i = session.pendingProcessEventIndex; i < session.pendingProcessEvents.length; i += 1) {
    if (session.pendingProcessEvents[i]?.type === "exit") return true;
  }
  return false;
}

// A failed, timed-out or truncated listing is not authoritative: treating it as empty would
// report every terminal idle, so it fails the tick instead.
export const runProcessTableCommand = Effect.fn("terminal.runProcessTableCommand")(function* (
  command: "powershell" | "ps",
  executable: string,
  args: ReadonlyArray<string>,
  maxBufferBytes: number,
  timeoutMs: number,
  run: typeof runProcess = runProcess,
): Effect.fn.Return<string, TerminalSubprocessCheckError> {
  const result = yield* Effect.tryPromise({
    try: () =>
      run(executable, args, {
        timeoutMs,
        allowNonZeroExit: true,
        maxBufferBytes,
        outputMode: "truncate",
      }),
    catch: (cause) =>
      new TerminalSubprocessCheckError({
        message: `Failed to list terminal subprocesses with ${command}.`,
        cause,
        command,
      }),
  });
  if (result.code !== 0 || result.timedOut || result.stdoutTruncated === true) {
    return yield* new TerminalSubprocessCheckError({
      message: `Failed to list terminal subprocesses with ${command} (${
        result.timedOut
          ? "timed out"
          : result.stdoutTruncated
            ? "output truncated"
            : `exit code ${result.code}`
      }).`,
      command,
      exitCode: result.code,
      timedOut: result.timedOut,
      stdoutTruncated: result.stdoutTruncated === true,
    });
  }
  return result.stdout;
});

const POSIX_PS_ABSOLUTE_PATHS = ["/bin/ps", "/usr/bin/ps"] as const;

const resolvePosixPsCommand = Effect.fn("terminal.resolvePosixPsCommand")(function* (
  fileSystem: FileSystem.FileSystem,
) {
  for (const candidate of POSIX_PS_ABSOLUTE_PATHS) {
    if (yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false))) {
      return candidate;
    }
  }
  return "ps";
});

export function makeDefaultProcessTableSource(
  platform: NodeJS.Platform,
  psCommand: string,
  run: typeof runProcess = runProcess,
): TerminalProcessTableSource {
  if (platform === "win32") {
    return (terminalPids) =>
      terminalPids.length === 0
        ? Effect.succeed([])
        : runProcessTableCommand(
            "powershell",
            "powershell.exe",
            ["-NoProfile", "-NonInteractive", "-Command", windowsChildProcessQuery(terminalPids)],
            262_144,
            PROCESS_TABLE_QUERY_TIMEOUT_MS,
            run,
          ).pipe(Effect.map(parseWindowsProcessTable));
  }
  const listPs = (columns: string) =>
    runProcessTableCommand(
      "ps",
      psCommand,
      ["-eo", columns],
      1_048_576,
      PROCESS_TABLE_QUERY_TIMEOUT_MS,
      run,
    );
  const listWithoutGroups = listPs("pid=,ppid=,comm=").pipe(Effect.map(parsePosixProcessTable));
  const listWithGroups = listPs("pid=,ppid=,pgid=,tpgid=,comm=").pipe(
    Effect.map(parsePosixProcessGroupTable),
  );
  // BusyBox ps has no tpgid column. Stop asking only once the plain listing shows ps itself works.
  let groupColumnsSupported = true;
  return () =>
    !groupColumnsSupported
      ? listWithoutGroups
      : listWithGroups.pipe(
          Effect.catch((error) =>
            error.exitCode === undefined || error.exitCode === null || error.exitCode === 0
              ? Effect.fail(error)
              : listWithoutGroups.pipe(
                  Effect.tap(() =>
                    Effect.sync(() => {
                      groupColumnsSupported = false;
                    }),
                  ),
                ),
          ),
        );
}

function shouldExcludeTerminalEnvKey(key: string): boolean {
  const normalizedKey = key.toUpperCase();
  if (normalizedKey.startsWith("PIEDPIPER_")) {
    return true;
  }
  if (normalizedKey.startsWith("VITE_")) {
    return true;
  }
  return TERMINAL_ENV_BLOCKLIST.has(normalizedKey);
}

// Markers the AppImage runtime injects into the process it launches; they describe the AppImage, not the session.
const APPIMAGE_RUNTIME_ENV_KEYS = ["APPIMAGE", "APPDIR", "ARGV0", "OWD"] as const;
// Search-path variables the AppImage runtime points at its temporary mount; only mount segments are dropped.
const APPIMAGE_PATH_LIKE_ENV_KEYS = [
  "PATH",
  "LD_LIBRARY_PATH",
  "XDG_DATA_DIRS",
  "GSETTINGS_SCHEMA_DIR",
] as const;

function isPathSegmentUnderAppDir(segment: string, appDir: string): boolean {
  return segment === appDir || segment.startsWith(`${appDir}/`);
}

function stripAppImageRuntimeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env.APPIMAGE === undefined && env.APPDIR === undefined) return env;

  const scrubbed: NodeJS.ProcessEnv = { ...env };
  for (const key of APPIMAGE_RUNTIME_ENV_KEYS) {
    delete scrubbed[key];
  }

  const appDir = env.APPDIR?.replace(/\/+$/, "");
  if (appDir) {
    for (const key of APPIMAGE_PATH_LIKE_ENV_KEYS) {
      const value = scrubbed[key];
      if (value === undefined) continue;
      const kept = value
        .split(":")
        .filter((segment) => segment.length > 0 && !isPathSegmentUnderAppDir(segment, appDir));
      if (kept.length > 0) {
        scrubbed[key] = kept.join(":");
      } else {
        // Removing the variable lets consumers fall back to their platform default.
        delete scrubbed[key];
      }
    }
  }

  return scrubbed;
}

// Windows env names are case-insensitive, so reuse an existing differently-cased key there.
function spawnEnvKey(env: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform): string {
  if (platform !== "win32") return name;
  const lowerName = name.toLowerCase();
  return Object.keys(env).find((candidate) => candidate.toLowerCase() === lowerName) ?? name;
}

export function createTerminalSpawnEnv(
  baseEnv: NodeJS.ProcessEnv,
  runtimeEnv?: Record<string, string> | null,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const spawnEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (shouldExcludeTerminalEnvKey(key)) continue;
    spawnEnv[key] = value;
  }
  if (runtimeEnv) {
    for (const [key, value] of Object.entries(runtimeEnv)) {
      if (platform === "win32") {
        // Windows env names are case-insensitive; replace any differently-cased inherited key.
        const existingKey = Object.keys(spawnEnv).find(
          (candidate) => candidate !== key && candidate.toLowerCase() === key.toLowerCase(),
        );
        if (existingKey !== undefined) {
          spawnEnv[existingKey] = value;
          continue;
        }
      }
      spawnEnv[key] = value;
    }
  }
  // fish 4.1+ waits up to 10s at startup for a DA1 reply before any renderer is attached to answer it.
  const fishFeaturesKey = spawnEnvKey(spawnEnv, "fish_features", platform);
  const fishFeatures = spawnEnv[fishFeaturesKey];
  if (!fishFeatures?.includes("query-term")) {
    spawnEnv[fishFeaturesKey] = fishFeatures ? `${fishFeatures},no-query-term` : "no-query-term";
  }
  // xterm.js renders 24-bit colour; GUI launches have no COLORTERM, so CLIs would fall back to 256/16.
  const colorTermKey = spawnEnvKey(spawnEnv, "COLORTERM", platform);
  if (!spawnEnv[colorTermKey]) {
    spawnEnv[colorTermKey] = "truecolor";
  }
  return stripAppImageRuntimeEnv(spawnEnv);
}

function normalizedRuntimeEnv(
  env: Record<string, string> | undefined,
): Record<string, string> | null {
  if (!env) return null;
  const entries = Object.entries(env);
  if (entries.length === 0) return null;
  return Object.fromEntries(entries.toSorted(([left], [right]) => left.localeCompare(right)));
}

interface TerminalManagerOptions {
  logsDir: string;
  historyLineLimit?: number;
  historyByteLimit?: number;
  ptyAdapter: PtyAdapterShape;
  shellResolver?: () => string;
  /** Per-terminal checker; when set it replaces the shared process-table snapshot. */
  subprocessChecker?: TerminalSubprocessChecker;
  /** Process-table source for the shared per-tick snapshot (defaults to ps / CIM). */
  processTableSource?: TerminalProcessTableSource;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  subprocessPollIntervalMs?: number;
  processKillGraceMs?: number;
  maxRetainedInactiveSessions?: number;
}

const makeTerminalManager = Effect.fn("makeTerminalManager")(function* () {
  const { terminalLogsDir } = yield* ServerConfig;
  const ptyAdapter = yield* PtyAdapter;
  return yield* makeTerminalManagerWithOptions({
    logsDir: terminalLogsDir,
    ptyAdapter,
  });
});

export const makeTerminalManagerWithOptions = Effect.fn("makeTerminalManagerWithOptions")(
  function* (options: TerminalManagerOptions) {
    const fileSystem = yield* FileSystem.FileSystem;
    const services = yield* Effect.services();
    const runFork = Effect.runForkWith(services);

    const logsDir = options.logsDir;
    const historyLineLimit = options.historyLineLimit ?? DEFAULT_HISTORY_LINE_LIMIT;
    const historyByteLimit = options.historyByteLimit ?? DEFAULT_HISTORY_BYTE_LIMIT;
    const platform = options.platform ?? process.platform;
    const baseEnv = options.env ?? process.env;
    const shellResolver = options.shellResolver ?? (() => defaultShellResolver(platform, baseEnv));
    const subprocessChecker = options.subprocessChecker;
    const processTableSource: TerminalProcessTableSource | null =
      subprocessChecker !== undefined
        ? null
        : (options.processTableSource ??
          makeDefaultProcessTableSource(
            platform,
            // Resolve `ps` once: a bare name walks every PATH entry on each spawn.
            platform === "win32" ? "ps" : yield* resolvePosixPsCommand(fileSystem),
          ));
    const subprocessPollIntervalMs =
      options.subprocessPollIntervalMs ?? DEFAULT_SUBPROCESS_POLL_INTERVAL_MS;
    const processKillGraceMs = options.processKillGraceMs ?? DEFAULT_PROCESS_KILL_GRACE_MS;
    const maxRetainedInactiveSessions =
      options.maxRetainedInactiveSessions ?? DEFAULT_MAX_RETAINED_INACTIVE_SESSIONS;

    yield* fileSystem.makeDirectory(logsDir, { recursive: true }).pipe(Effect.orDie);

    const managerStateRef = yield* SynchronizedRef.make<TerminalManagerState>({
      sessions: new Map(),
      killFibers: new Map(),
    });
    const threadLocks = yield* KeyedLock.make<string>();
    const terminalEventListeners = new Set<(event: TerminalEvent) => Effect.Effect<void>>();
    const workerScope = yield* Scope.make("sequential");
    yield* Effect.addFinalizer(() => Scope.close(workerScope, Exit.void));

    // Manager-wide and clock-seeded: a client's event buffer outlives sessions and server restarts.
    let eventSequenceCounter = Date.now();
    const nextEventSequence = () => ++eventSequenceCounter;

    // Keys a client must not resume: they stay here until a new session is created for them.
    const closedSessionKeys = new Set<string>();
    const metadataSubscribers = new Set<TerminalMetadataSubscriber>();

    const publishEvent = (event: TerminalEvent) =>
      Effect.gen(function* () {
        for (const listener of terminalEventListeners) {
          yield* listener(event).pipe(Effect.ignoreCause({ log: true }));
        }
      });

    const deliverMetadata = (
      subscriber: TerminalMetadataSubscriber,
      event: TerminalMetadataStreamEvent,
    ) => subscriber.listener(event).pipe(Effect.ignoreCause({ log: true }));

    const publishMetadata = (event: TerminalMetadataStreamEvent) =>
      Effect.gen(function* () {
        for (const subscriber of metadataSubscribers) {
          if (subscriber.pending !== null) {
            subscriber.pending.push(event);
          } else {
            yield* deliverMetadata(subscriber, event);
          }
        }
      });

    const historyPath = (threadId: string, terminalId: string) =>
      path.join(logsDir, historyName(threadId, terminalId));
    const historyPaths = (threadId: string, terminalId: string) => [
      ...new Set([
        historyPath(threadId, terminalId),
        path.join(logsDir, encodedHistoryName(threadId, terminalId)),
        ...(terminalId === DEFAULT_TERMINAL_ID
          ? [path.join(logsDir, `${legacySafeThreadId(threadId)}.log`)]
          : []),
      ]),
    ];
    const historyExists = (filePath: string) => {
      const name = path.basename(filePath);
      return Buffer.byteLength(name) <= MAX_HISTORY_FILENAME_BYTES
        ? fileSystem.exists(filePath)
        : fileSystem.readDirectory(logsDir).pipe(Effect.map((entries) => entries.includes(name)));
    };

    const toTerminalHistoryError =
      (operation: "read" | "truncate" | "migrate", threadId: string, terminalId: string) =>
      (cause: unknown) =>
        new TerminalHistoryError({
          operation,
          threadId,
          terminalId,
          cause,
        });

    const readManagerState = SynchronizedRef.get(managerStateRef);

    const modifyManagerState = <A>(
      f: (state: TerminalManagerState) => readonly [A, TerminalManagerState],
    ) => SynchronizedRef.modify(managerStateRef, f);

    // Reads the session when it runs, so a delayed publish cannot report superseded state.
    const publishSessionMetadata = Effect.fn("terminal.publishSessionMetadata")(function* (
      session: TerminalSessionState,
    ) {
      const { sessions } = yield* readManagerState;
      if (sessions.get(toSessionKey(session.threadId, session.terminalId)) !== session) return;
      yield* publishMetadata({ type: "upsert", terminal: terminalSummary(session) });
    });

    const withThreadLock = <A, E, R>(
      threadId: string,
      effect: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E, R> => threadLocks.withLock(threadId, effect);

    const clearKillFiber = Effect.fn("terminal.clearKillFiber")(function* (
      process: PtyProcess | null,
    ) {
      if (!process) return;
      const fiber: Option.Option<Fiber.Fiber<void, never>> = yield* modifyManagerState<
        Option.Option<Fiber.Fiber<void, never>>
      >((state) => {
        const existing: Option.Option<Fiber.Fiber<void, never>> = Option.fromNullishOr(
          state.killFibers.get(process),
        );
        if (Option.isNone(existing)) {
          return [Option.none<Fiber.Fiber<void, never>>(), state] as const;
        }
        const killFibers = new Map(state.killFibers);
        killFibers.delete(process);
        return [existing, { ...state, killFibers }] as const;
      });
      if (Option.isSome(fiber)) {
        yield* Fiber.interrupt(fiber.value).pipe(Effect.ignore);
      }
    });

    const registerKillFiber = Effect.fn("terminal.registerKillFiber")(function* (
      process: PtyProcess,
      fiber: Fiber.Fiber<void, never>,
    ) {
      yield* modifyManagerState((state) => {
        // The fiber may already have finished (and run its cleanup) before registration.
        if (fiber.pollUnsafe() !== undefined) {
          return [undefined, state] as const;
        }
        const killFibers = new Map(state.killFibers);
        killFibers.set(process, fiber);
        return [undefined, { ...state, killFibers }] as const;
      });
    });

    const runKillEscalation = Effect.fn("terminal.runKillEscalation")(function* (
      process: PtyProcess,
      threadId: string,
      terminalId: string,
    ) {
      // Subscribe before SIGTERM so an immediate exit is not missed; released even on interrupt.
      const exited = Deferred.makeUnsafe<void>();
      const unsubscribeExit = process.onExit(() => {
        Deferred.doneUnsafe(exited, Effect.void);
      });
      yield* Effect.gen(function* () {
        const terminated = yield* Effect.try({
          try: () => process.kill("SIGTERM"),
          catch: (cause) =>
            new TerminalProcessSignalError({
              message: "Failed to send SIGTERM to terminal process.",
              cause,
              signal: "SIGTERM",
            }),
        }).pipe(
          Effect.as(true),
          Effect.catch((error) =>
            Effect.logWarning("failed to kill terminal process", {
              threadId,
              terminalId,
              signal: "SIGTERM",
              error: error.message,
            }).pipe(Effect.as(false)),
          ),
        );
        if (!terminated) {
          return;
        }

        const exitedWithinGrace = yield* Deferred.await(exited).pipe(
          Effect.as(true),
          Effect.timeoutOrElse({
            duration: processKillGraceMs,
            orElse: () => Effect.succeed(false),
          }),
        );
        // Skip SIGKILL once the process has exited: its pid may already be reused.
        if (exitedWithinGrace) {
          return;
        }

        yield* Effect.try({
          try: () => process.kill("SIGKILL"),
          catch: (cause) =>
            new TerminalProcessSignalError({
              message: "Failed to send SIGKILL to terminal process.",
              cause,
              signal: "SIGKILL",
            }),
        }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("failed to force-kill terminal process", {
              threadId,
              terminalId,
              signal: "SIGKILL",
              error: error.message,
            }),
          ),
        );
      }).pipe(Effect.ensuring(Effect.sync(unsubscribeExit)));
    });

    const startKillEscalation = Effect.fn("terminal.startKillEscalation")(function* (
      process: PtyProcess,
      threadId: string,
      terminalId: string,
    ) {
      const fiber = yield* runKillEscalation(process, threadId, terminalId).pipe(
        Effect.ensuring(
          modifyManagerState((state) => {
            if (!state.killFibers.has(process)) {
              return [undefined, state] as const;
            }
            const killFibers = new Map(state.killFibers);
            killFibers.delete(process);
            return [undefined, { ...state, killFibers }] as const;
          }),
        ),
        Effect.forkIn(workerScope),
      );

      yield* registerKillFiber(process, fiber);
    });

    // The worker runs keys serially, so a flush skips the debounce of other keys queued ahead of it.
    const pendingPersistFlushes = new Map<string, number>();
    let wakePersistDebounce: Deferred.Deferred<void> | null = null;
    const persistWorker = yield* makeKeyedCoalescingWorker<
      string,
      PersistHistoryRequest,
      never,
      never
    >({
      merge: (current, next) => ({
        history: next.history,
        immediate: current.immediate || next.immediate,
      }),
      process: Effect.fn("terminal.persistHistoryWorker")(function* (sessionKey, request) {
        const flushWaitingBehind =
          pendingPersistFlushes.size > 0 && !pendingPersistFlushes.has(sessionKey);
        if (!request.immediate && !flushWaitingBehind) {
          const wake = Deferred.makeUnsafe<void>();
          wakePersistDebounce = wake;
          yield* Deferred.await(wake).pipe(
            Effect.timeoutOrElse({
              duration: DEFAULT_PERSIST_DEBOUNCE_MS,
              orElse: () => Effect.void,
            }),
            Effect.ensuring(
              Effect.sync(() => {
                if (wakePersistDebounce === wake) wakePersistDebounce = null;
              }),
            ),
          );
        }

        const [threadId, terminalId] = sessionKey.split("\u0000");
        if (!threadId || !terminalId) {
          return;
        }

        yield* fileSystem
          .writeFileString(historyPath(threadId, terminalId), request.history.value())
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("failed to persist terminal history", {
                threadId,
                terminalId,
                error: error instanceof Error ? error.message : String(error),
              }),
            ),
          );
      }),
    });

    const queuePersist = Effect.fn("terminal.queuePersist")(function* (
      threadId: string,
      terminalId: string,
      history: BoundedTerminalHistory,
    ) {
      yield* persistWorker.enqueue(toSessionKey(threadId, terminalId), {
        history,
        immediate: false,
      });
    });

    const flushPersist = Effect.fn("terminal.flushPersist")(function* (
      threadId: string,
      terminalId: string,
    ) {
      const sessionKey = toSessionKey(threadId, terminalId);
      yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          pendingPersistFlushes.set(sessionKey, (pendingPersistFlushes.get(sessionKey) ?? 0) + 1);
          if (wakePersistDebounce !== null) Deferred.doneUnsafe(wakePersistDebounce, Effect.void);
        }),
        () => persistWorker.drainKey(sessionKey),
        () =>
          Effect.sync(() => {
            const remaining = (pendingPersistFlushes.get(sessionKey) ?? 1) - 1;
            if (remaining > 0) pendingPersistFlushes.set(sessionKey, remaining);
            else pendingPersistFlushes.delete(sessionKey);
          }),
      );
    });

    const persistHistory = Effect.fn("terminal.persistHistory")(function* (
      threadId: string,
      terminalId: string,
      history: BoundedTerminalHistory,
    ) {
      yield* persistWorker.enqueue(toSessionKey(threadId, terminalId), {
        history,
        immediate: true,
      });
      yield* flushPersist(threadId, terminalId);
    });

    // Reads at most the byte limit from the end of the file, so huge history never loads whole.
    const readHistoryTail = Effect.fn("terminal.readHistoryTail")(function* (filePath: string) {
      const file = yield* fileSystem.open(filePath, { flag: "r" });
      const info = yield* file.stat;
      const limit = BigInt(historyByteLimit);
      const offset = info.size > limit ? info.size - limit : 0n;
      yield* file.seek(offset, "start");
      const bytes = new Uint8Array(Number(info.size - offset));
      let length = 0;
      while (length < bytes.length) {
        const read = Number(yield* file.read(bytes.subarray(length)));
        if (read === 0) break;
        length += read;
      }
      let start = 0;
      if (offset > 0n) {
        // A tail read can start inside a UTF-8 code point; skip its continuation bytes.
        while (start < length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start += 1;
      }
      return {
        history: new TextDecoder("utf-8", { ignoreBOM: true }).decode(
          bytes.subarray(start, length),
        ),
        truncated: offset > 0n,
      };
    });

    const capStoredHistory = (raw: string) =>
      new BoundedTerminalHistory(historyLineLimit, raw, historyByteLimit).value();

    const readHistory = Effect.fn("terminal.readHistory")(function* (
      threadId: string,
      terminalId: string,
    ) {
      const nextPath = historyPath(threadId, terminalId);
      for (const sourcePath of historyPaths(threadId, terminalId)) {
        const migrating = sourcePath !== nextPath;
        const operation = migrating ? "migrate" : "read";
        if (
          !(yield* historyExists(sourcePath).pipe(
            Effect.mapError(toTerminalHistoryError(operation, threadId, terminalId)),
          ))
        )
          continue;
        const { history: raw, truncated } = yield* readHistoryTail(sourcePath).pipe(
          Effect.scoped,
          Effect.mapError(toTerminalHistoryError(operation, threadId, terminalId)),
        );
        const capped = capStoredHistory(raw);
        if (migrating || truncated || capped !== raw) {
          const write = migrating
            ? Effect.gen(function* () {
                const temporaryPath = yield* fileSystem.makeTempFileScoped({
                  directory: logsDir,
                  prefix: ".history-",
                });
                yield* fileSystem.writeFileString(temporaryPath, capped);
                yield* fileSystem.rename(temporaryPath, nextPath);
              }).pipe(Effect.scoped)
            : fileSystem.writeFileString(nextPath, capped);
          yield* write.pipe(
            Effect.mapError(
              toTerminalHistoryError(migrating ? "migrate" : "truncate", threadId, terminalId),
            ),
          );
        }
        if (migrating)
          yield* fileSystem.remove(sourcePath, { force: true }).pipe(
            Effect.catch((error) =>
              Effect.logWarning("failed to remove legacy terminal history", {
                threadId,
                terminalId,
                error,
              }),
            ),
          );
        return capped;
      }
      return "";
    });

    const deleteHistory = Effect.fn("terminal.deleteHistory")(function* (
      threadId: string,
      terminalId: string,
    ) {
      for (const filePath of historyPaths(threadId, terminalId)) {
        if (yield* historyExists(filePath).pipe(Effect.orElseSucceed(() => false))) {
          yield* fileSystem.remove(filePath, { force: true }).pipe(
            Effect.catch((error) =>
              Effect.logWarning("failed to delete terminal history", {
                threadId,
                terminalId,
                error,
              }),
            ),
          );
        }
      }
    });

    const deleteAllHistoryForThread = Effect.fn("terminal.deleteAllHistoryForThread")(function* (
      threadId: string,
    ) {
      const threadPrefix = `${toSafeThreadId(threadId)}_`;
      const entries = yield* fileSystem
        .readDirectory(logsDir, { recursive: false })
        .pipe(Effect.catch(() => Effect.succeed([] as Array<string>)));
      yield* Effect.forEach(
        entries.filter(
          (name) =>
            name === `${toSafeThreadId(threadId)}.log` ||
            name === `${legacySafeThreadId(threadId)}.log` ||
            name.startsWith(threadPrefix) ||
            name === `${hashedHistoryThreadPart(threadId)}.log` ||
            name.startsWith(`${hashedHistoryThreadPart(threadId)}_`),
        ),
        (name) =>
          fileSystem.remove(path.join(logsDir, name), { force: true }).pipe(
            Effect.catch((error) =>
              Effect.logWarning("failed to delete terminal histories for thread", {
                threadId,
                error: error instanceof Error ? error.message : String(error),
              }),
            ),
          ),
        { discard: true },
      );
    });

    const assertValidCwd = Effect.fn("terminal.assertValidCwd")(function* (cwd: string) {
      const stats = yield* fileSystem.stat(cwd).pipe(
        Effect.mapError(
          (cause) =>
            new TerminalCwdError({
              cwd,
              reason: cause.reason._tag === "NotFound" ? "notFound" : "statFailed",
              cause,
            }),
        ),
      );
      if (stats.type !== "Directory") {
        return yield* new TerminalCwdError({
          cwd,
          reason: "notDirectory",
        });
      }
    });

    const getSession = Effect.fn("terminal.getSession")(function* (
      threadId: string,
      terminalId: string,
    ): Effect.fn.Return<Option.Option<TerminalSessionState>> {
      return yield* Effect.map(readManagerState, (state) =>
        Option.fromNullishOr(state.sessions.get(toSessionKey(threadId, terminalId))),
      );
    });

    const requireSession = Effect.fn("terminal.requireSession")(function* (
      threadId: string,
      terminalId: string,
    ): Effect.fn.Return<TerminalSessionState, TerminalSessionLookupError> {
      return yield* Effect.flatMap(getSession(threadId, terminalId), (session) =>
        Option.match(session, {
          onNone: () =>
            Effect.fail(
              new TerminalSessionLookupError({
                threadId,
                terminalId,
              }),
            ),
          onSome: Effect.succeed,
        }),
      );
    });

    const sessionsForThread = Effect.fn("terminal.sessionsForThread")(function* (threadId: string) {
      return yield* readManagerState.pipe(
        Effect.map((state) =>
          [...state.sessions.values()].filter((session) => session.threadId === threadId),
        ),
      );
    });

    const evictInactiveSessionsIfNeeded = Effect.fn("terminal.evictInactiveSessionsIfNeeded")(
      function* () {
        const evicted = yield* modifyManagerState<ReadonlyArray<TerminalSessionState>>((state) => {
          const inactiveSessions = [...state.sessions.values()].filter(
            (session) => session.status !== "running",
          );
          if (inactiveSessions.length <= maxRetainedInactiveSessions) {
            return [[], state] as const;
          }

          inactiveSessions.sort(
            (left, right) =>
              left.updatedAt.localeCompare(right.updatedAt) ||
              left.threadId.localeCompare(right.threadId) ||
              left.terminalId.localeCompare(right.terminalId),
          );

          const sessions = new Map(state.sessions);

          const toEvict = inactiveSessions.length - maxRetainedInactiveSessions;
          const evictedSessions = inactiveSessions.slice(0, toEvict);
          for (const session of evictedSessions) {
            const key = toSessionKey(session.threadId, session.terminalId);
            sessions.delete(key);
            closedSessionKeys.add(key);
          }

          return [evictedSessions, { ...state, sessions }] as const;
        });
        for (const session of evicted) {
          yield* publishMetadata({
            type: "remove",
            threadId: session.threadId,
            terminalId: session.terminalId,
          });
        }
      },
    );

    const drainProcessEvents = Effect.fn("terminal.drainProcessEvents")(function* (
      session: TerminalSessionState,
      expectedPid: number,
    ) {
      while (true) {
        const action: DrainProcessEventAction = yield* Effect.sync(() => {
          if (session.pid !== expectedPid || !session.process || session.status !== "running") {
            session.pendingProcessEvents = [];
            session.pendingProcessEventIndex = 0;
            session.processEventDrainRunning = false;
            return { type: "idle" } as const;
          }

          const nextEvent = takePendingProcessEvent(session);
          if (!nextEvent) {
            session.pendingProcessEvents = [];
            session.pendingProcessEventIndex = 0;
            session.processEventDrainRunning = false;
            return { type: "idle" } as const;
          }

          if (nextEvent.type === "output") {
            session.activityCount += 1;
            const sanitized = sanitizeTerminalHistoryChunk(
              session.pendingHistoryControlSequence,
              nextEvent.data,
            );
            session.pendingHistoryControlSequence = sanitized.pendingControlSequence;
            if (sanitized.visibleText.length > 0) {
              session.history.append(sanitized.visibleText);
            }
            session.updatedAt = new Date().toISOString();
            // Set with the history append: a snapshot taken before the publish already holds this chunk.
            session.eventSequence = nextEventSequence();

            return {
              type: "output",
              threadId: session.threadId,
              terminalId: session.terminalId,
              history: sanitized.visibleText.length > 0 ? session.history : null,
              data: nextEvent.data,
              sequence: session.eventSequence,
            } as const;
          }

          const process = session.process;
          cleanupProcessHandles(session);
          session.process = null;
          session.pid = null;
          session.hasRunningSubprocess = false;
          session.childCommandLabel = null;
          session.status = "exited";
          session.pendingHistoryControlSequence = "";
          session.pendingProcessEvents = [];
          session.pendingProcessEventIndex = 0;
          session.processEventDrainRunning = false;
          session.exitCode = Number.isInteger(nextEvent.event.exitCode)
            ? nextEvent.event.exitCode
            : null;
          session.exitSignal = Number.isInteger(nextEvent.event.signal)
            ? nextEvent.event.signal
            : null;
          session.updatedAt = new Date().toISOString();

          return {
            type: "exit",
            process,
            threadId: session.threadId,
            terminalId: session.terminalId,
            exitCode: session.exitCode,
            exitSignal: session.exitSignal,
          } as const;
        });

        if (action.type === "idle") {
          return;
        }

        if (action.type === "output") {
          if (action.history !== null) {
            yield* queuePersist(action.threadId, action.terminalId, action.history);
          }

          yield* publishEvent({
            type: "output",
            threadId: action.threadId,
            terminalId: action.terminalId,
            createdAt: new Date().toISOString(),
            data: action.data,
            sequence: action.sequence,
          });
          continue;
        }

        yield* clearKillFiber(action.process);
        yield* publishEvent({
          type: "exited",
          threadId: action.threadId,
          terminalId: action.terminalId,
          createdAt: new Date().toISOString(),
          exitCode: action.exitCode,
          exitSignal: action.exitSignal,
          sequence: nextEventSequence(),
        });
        yield* publishSessionMetadata(session);
        yield* evictInactiveSessionsIfNeeded();
        return;
      }
    });

    const stopProcess = Effect.fn("terminal.stopProcess")(function* (
      session: TerminalSessionState,
    ) {
      const process = session.process;
      if (!process) return;

      const alreadyExited = yield* modifyManagerState((state) => {
        const exitQueued = hasPendingExitEvent(session);
        cleanupProcessHandles(session);
        session.process = null;
        session.pid = null;
        session.hasRunningSubprocess = false;
        session.childCommandLabel = null;
        session.status = "exited";
        session.pendingHistoryControlSequence = "";
        session.pendingProcessEvents = [];
        session.pendingProcessEventIndex = 0;
        session.processEventDrainRunning = false;
        session.updatedAt = new Date().toISOString();
        return [exitQueued, state] as const;
      });

      yield* clearKillFiber(process);
      if (!alreadyExited) {
        yield* startKillEscalation(process, session.threadId, session.terminalId);
      }
      yield* publishSessionMetadata(session);
      yield* evictInactiveSessionsIfNeeded();
    });

    const trySpawn = Effect.fn("terminal.trySpawn")(function* (
      shellCandidates: ReadonlyArray<ShellCandidate>,
      spawnEnv: NodeJS.ProcessEnv,
      session: TerminalSessionState,
      index = 0,
      lastError: PtySpawnError | null = null,
    ): Effect.fn.Return<{ process: PtyProcess; shellLabel: string }, PtySpawnError> {
      if (index >= shellCandidates.length) {
        const detail = (lastError?.message ?? "Failed to spawn PTY process").replace(/\.+$/, "");
        const tried =
          shellCandidates.length > 0
            ? ` Tried shells: ${shellCandidates.map((candidate) => formatShellCandidate(candidate)).join(", ")}.`
            : "";
        return yield* new PtySpawnError({
          adapter: "terminal-manager",
          message: `${detail}.${tried}`.trim(),
          ...(lastError ? { cause: lastError } : {}),
        });
      }

      const candidate = shellCandidates[index];
      if (!candidate) {
        return yield* (
          lastError ??
            new PtySpawnError({
              adapter: "terminal-manager",
              message: "No shell candidate available for PTY spawn.",
            })
        );
      }

      const attempt = yield* Effect.result(
        options.ptyAdapter.spawn({
          shell: candidate.shell,
          ...(candidate.args ? { args: candidate.args } : {}),
          cwd: session.cwd,
          cols: session.cols,
          rows: session.rows,
          env: spawnEnv,
        }),
      );

      if (attempt._tag === "Success") {
        return {
          process: attempt.success,
          shellLabel: formatShellCandidate(candidate),
        };
      }

      const spawnError = attempt.failure;
      if (!isRetryableShellSpawnError(spawnError)) {
        return yield* spawnError;
      }

      return yield* trySpawn(shellCandidates, spawnEnv, session, index + 1, spawnError);
    });

    const startSession = Effect.fn("terminal.startSession")(function* (
      session: TerminalSessionState,
      input: TerminalStartInput,
      eventType: "started" | "restarted",
    ) {
      yield* stopProcess(session);
      yield* Effect.annotateCurrentSpan({
        "terminal.thread_id": session.threadId,
        "terminal.id": session.terminalId,
        "terminal.event_type": eventType,
        "terminal.cwd": input.cwd,
      });

      yield* modifyManagerState((state) => {
        session.status = "starting";
        session.cwd = input.cwd;
        session.cols = input.cols;
        session.rows = input.rows;
        session.exitCode = null;
        session.exitSignal = null;
        session.hasRunningSubprocess = false;
        session.childCommandLabel = null;
        session.pendingProcessEvents = [];
        session.pendingProcessEventIndex = 0;
        session.processEventDrainRunning = false;
        session.updatedAt = new Date().toISOString();
        // Above every event of the previous process, so a client buffer cannot replay them.
        session.eventSequence = nextEventSequence();
        return [undefined, state] as const;
      });

      let ptyProcess: PtyProcess | null = null;
      let startedShell: string | null = null;

      const startResult = yield* Effect.result(
        increment(terminalSessionsTotal, { lifecycle: eventType }).pipe(
          Effect.andThen(
            Effect.gen(function* () {
              const shellCandidates = resolveShellCandidates(shellResolver, platform, baseEnv);
              const terminalEnv = createTerminalSpawnEnv(baseEnv, session.runtimeEnv, platform);
              const spawnResult = yield* trySpawn(shellCandidates, terminalEnv, session);
              ptyProcess = spawnResult.process;
              startedShell = spawnResult.shellLabel;

              const processPid = ptyProcess.pid;
              const unsubscribeData = ptyProcess.onData((data) => {
                if (!enqueueProcessEvent(session, processPid, { type: "output", data })) {
                  return;
                }
                runFork(drainProcessEvents(session, processPid));
              });
              const unsubscribeExit = ptyProcess.onExit((event) => {
                if (!enqueueProcessEvent(session, processPid, { type: "exit", event })) {
                  return;
                }
                runFork(drainProcessEvents(session, processPid));
              });

              yield* modifyManagerState((state) => {
                session.process = ptyProcess;
                session.pid = processPid;
                session.status = "running";
                session.updatedAt = new Date().toISOString();
                session.unsubscribeData = unsubscribeData;
                session.unsubscribeExit = unsubscribeExit;
                return [undefined, state] as const;
              });

              yield* publishEvent({
                type: eventType,
                threadId: session.threadId,
                terminalId: session.terminalId,
                createdAt: new Date().toISOString(),
                sequence: session.eventSequence,
                snapshot: snapshot(session),
              });
              yield* publishSessionMetadata(session);
            }),
          ),
        ),
      );

      if (startResult._tag === "Success") {
        return;
      }

      {
        const error = startResult.failure;
        if (ptyProcess) {
          yield* startKillEscalation(ptyProcess, session.threadId, session.terminalId);
        }

        yield* modifyManagerState((state) => {
          session.status = "error";
          session.pid = null;
          session.process = null;
          session.unsubscribeData = null;
          session.unsubscribeExit = null;
          session.hasRunningSubprocess = false;
          session.childCommandLabel = null;
          session.pendingProcessEvents = [];
          session.pendingProcessEventIndex = 0;
          session.processEventDrainRunning = false;
          session.updatedAt = new Date().toISOString();
          return [undefined, state] as const;
        });

        yield* publishSessionMetadata(session);
        yield* evictInactiveSessionsIfNeeded();

        const message = error.message;
        yield* publishEvent({
          type: "error",
          threadId: session.threadId,
          terminalId: session.terminalId,
          createdAt: new Date().toISOString(),
          message,
          sequence: nextEventSequence(),
        });
        yield* Effect.logError("failed to start terminal", {
          threadId: session.threadId,
          terminalId: session.terminalId,
          error: message,
          ...(startedShell ? { shell: startedShell } : {}),
        });
      }
    });

    const closeSession = Effect.fn("terminal.closeSession")(function* (
      threadId: string,
      terminalId: string,
      deleteHistoryOnClose: boolean,
    ) {
      const key = toSessionKey(threadId, terminalId);
      const session = yield* getSession(threadId, terminalId);

      if (Option.isSome(session)) {
        yield* stopProcess(session.value);
        yield* persistHistory(threadId, terminalId, session.value.history);
      }

      yield* flushPersist(threadId, terminalId);

      closedSessionKeys.add(key);
      const removed = yield* modifyManagerState((state) => {
        if (!state.sessions.has(key)) {
          return [false, state] as const;
        }
        const sessions = new Map(state.sessions);
        sessions.delete(key);
        return [true, { ...state, sessions }] as const;
      });
      if (removed) {
        yield* publishMetadata({ type: "remove", threadId, terminalId });
      }

      if (deleteHistoryOnClose) {
        yield* deleteHistory(threadId, terminalId);
      }
    });

    // Two unchanged snapshots cover children forked just after the first snapshot.
    // Process identity keeps a restarted shell from inheriting quiet state.
    let quietSessions = new WeakMap<TerminalSessionState, QuietTerminalSession>();
    let skippedQuietTicks = 0;
    const isQuiet = (session: TerminalSessionState) => {
      const quiet = quietSessions.get(session);
      return (
        quiet !== undefined &&
        quiet.idleSnapshots === 2 &&
        quiet.process === session.process &&
        quiet.mark === session.activityCount &&
        !session.hasRunningSubprocess
      );
    };

    // Reports a failed snapshot and the query's duration so polling can back off and pace itself.
    const pollSubprocessActivity = Effect.fn("terminal.pollSubprocessActivity")(function* () {
      const state = yield* readManagerState;
      const runningSessions = [...state.sessions.values()]
        .filter(
          (session): session is TerminalSessionState & { pid: number } =>
            session.status === "running" && Number.isInteger(session.pid),
        )
        .map((session) => ({
          session,
          terminalPid: session.pid,
          process: session.process,
          mark: session.activityCount,
        }));

      if (runningSessions.length === 0) {
        return { snapshotSucceeded: true, queryElapsedMs: 0 };
      }
      if (
        runningSessions.every(({ session }) => isQuiet(session)) &&
        skippedQuietTicks < QUIET_SUBPROCESS_SNAPSHOT_EVERY_TICKS - 1
      ) {
        skippedQuietTicks += 1;
        return { snapshotSucceeded: true, queryElapsedMs: 0 };
      }
      skippedQuietTicks = 0;

      let queryElapsedMs = 0;
      let resolveActivity: (
        session: TerminalSessionState,
        terminalPid: number,
      ) => Effect.Effect<Option.Option<TerminalSubprocessState>>;
      if (processTableSource !== null) {
        const [elapsed, processTable] = yield* processTableSource(
          runningSessions.map(({ terminalPid }) => terminalPid),
        ).pipe(
          Effect.map((entries) => Option.some(indexProcessTable(entries))),
          Effect.catchCause((cause) =>
            Effect.logWarning("failed to snapshot processes for terminal subprocess polling", {
              cause,
            }).pipe(Effect.as(Option.none<ReturnType<typeof indexProcessTable>>())),
          ),
          Effect.timed,
        );
        queryElapsedMs = Duration.toMillis(elapsed);
        if (Option.isNone(processTable)) {
          // Forget quiet state so the failure backoff, not the quiet cadence, paces retries.
          quietSessions = new WeakMap();
          return { snapshotSucceeded: false, queryElapsedMs };
        }
        resolveActivity = (_session, terminalPid) =>
          Effect.succeed(
            Option.some(terminalSubprocessState(processTable.value, terminalPid, platform)),
          );
      } else {
        const checker = subprocessChecker ?? (() => Effect.succeed(false));
        resolveActivity = (session, terminalPid) =>
          checker(terminalPid).pipe(
            Effect.map((hasRunningSubprocess) =>
              Option.some({ hasRunningSubprocess, childCommand: null }),
            ),
            Effect.catch((error) =>
              Effect.logWarning("failed to check terminal subprocess activity", {
                threadId: session.threadId,
                terminalId: session.terminalId,
                terminalPid,
                error: error instanceof Error ? error.message : String(error),
              }).pipe(Effect.as(Option.none<TerminalSubprocessState>())),
            ),
          );
      }

      const checkSubprocessActivity = Effect.fn("terminal.checkSubprocessActivity")(function* (
        candidate: (typeof runningSessions)[number],
      ) {
        const { session, terminalPid, process } = candidate;
        let mark = candidate.mark;
        const previous = quietSessions.get(session);
        quietSessions.delete(session);
        const activity = yield* resolveActivity(session, terminalPid);

        // Drop the result if the shell exited or was replaced while the snapshot ran.
        if (
          Option.isNone(activity) ||
          session.status !== "running" ||
          session.pid !== terminalPid ||
          session.process !== process
        ) {
          return;
        }

        const { hasRunningSubprocess } = activity.value;
        const childCommandLabel = hasRunningSubprocess ? activity.value.childCommand : null;
        const event = yield* modifyManagerState((state) => {
          const liveSession: Option.Option<TerminalSessionState> = Option.fromNullishOr(
            state.sessions.get(toSessionKey(session.threadId, session.terminalId)),
          );
          if (
            Option.isNone(liveSession) ||
            liveSession.value !== session ||
            liveSession.value.status !== "running" ||
            liveSession.value.pid !== terminalPid ||
            liveSession.value.process !== process ||
            (liveSession.value.hasRunningSubprocess === hasRunningSubprocess &&
              liveSession.value.childCommandLabel === childCommandLabel)
          ) {
            return [Option.none(), state] as const;
          }

          const subprocessStateChanged =
            liveSession.value.hasRunningSubprocess !== hasRunningSubprocess;
          liveSession.value.hasRunningSubprocess = hasRunningSubprocess;
          liveSession.value.childCommandLabel = childCommandLabel;
          liveSession.value.updatedAt = new Date().toISOString();
          // Only this poll's own event may advance the mark without waking the poller.
          liveSession.value.activityCount += 1;
          mark += 1;

          return [
            Option.some({
              subprocessStateChanged,
              event: {
                type: "activity" as const,
                threadId: liveSession.value.threadId,
                terminalId: liveSession.value.terminalId,
                createdAt: new Date().toISOString(),
                hasRunningSubprocess,
                ...(childCommandLabel !== null ? { label: childCommandLabel } : {}),
                sequence: nextEventSequence(),
              },
            }),
            state,
          ] as const;
        });

        if (Option.isSome(event)) {
          yield* publishEvent(event.value.event);
          if (event.value.subprocessStateChanged) {
            yield* publishSessionMetadata(session);
          }
        }

        if (
          !hasRunningSubprocess &&
          session.status === "running" &&
          session.pid === terminalPid &&
          session.process === process &&
          session.activityCount === mark
        ) {
          quietSessions.set(session, {
            process,
            mark,
            idleSnapshots: previous?.process === process && previous.mark === mark ? 2 : 1,
          });
        }
      });

      yield* Effect.forEach(runningSessions, checkSubprocessActivity, {
        concurrency: "unbounded",
        discard: true,
      });
      return { snapshotSucceeded: true, queryElapsedMs };
    });

    const hasRunningSessions = readManagerState.pipe(
      Effect.map((state) =>
        [...state.sessions.values()].some((session) => session.status === "running"),
      ),
    );

    let subprocessSnapshotFailureCount = 0;
    yield* Effect.forever(
      hasRunningSessions.pipe(
        Effect.flatMap((active) => {
          if (!active) {
            subprocessSnapshotFailureCount = 0;
            return Effect.sleep(subprocessPollIntervalMs);
          }
          return pollSubprocessActivity().pipe(
            Effect.flatMap(({ snapshotSucceeded, queryElapsedMs }) => {
              subprocessSnapshotFailureCount = snapshotSucceeded
                ? 0
                : Math.min(subprocessSnapshotFailureCount + 1, 30);
              return Effect.sleep(
                subprocessSnapshotPollDelayMs(
                  subprocessPollIntervalMs,
                  subprocessSnapshotFailureCount,
                  queryElapsedMs,
                ),
              );
            }),
          );
        }),
      ),
    ).pipe(Effect.forkIn(workerScope));

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const sessions = yield* modifyManagerState(
          (state) =>
            [
              [...state.sessions.values()],
              {
                ...state,
                sessions: new Map(),
              },
            ] as const,
        );

        const cleanupSession = Effect.fn("terminal.cleanupSession")(function* (
          session: TerminalSessionState,
        ) {
          const exitQueued = hasPendingExitEvent(session);
          cleanupProcessHandles(session);
          if (session.process) {
            yield* clearKillFiber(session.process);
            if (!exitQueued) {
              yield* runKillEscalation(session.process, session.threadId, session.terminalId);
            }
          }
          // Write now: the persist worker is interrupted once this finalizer returns.
          yield* persistHistory(session.threadId, session.terminalId, session.history);
        });

        yield* Effect.forEach(sessions, cleanupSession, {
          concurrency: "unbounded",
          discard: true,
        });
      }).pipe(Effect.ignoreCause({ log: true })),
    );

    const publishGrid = (session: TerminalSessionState) => {
      session.eventSequence = nextEventSequence();
      return publishEvent({
        type: "activity",
        threadId: session.threadId,
        terminalId: session.terminalId,
        createdAt: session.updatedAt,
        sequence: session.eventSequence,
        hasRunningSubprocess: session.hasRunningSubprocess,
        ...(session.childCommandLabel ? { label: session.childCommandLabel } : {}),
        cols: session.cols,
        rows: session.rows,
      });
    };

    // A failed resize must not block attaching to a shell that is still usable.
    const resizeOnAttach = Effect.fn("terminal.resizeOnAttach")(function* (
      session: TerminalSessionState,
      process: PtyProcess,
      cols: number,
      rows: number,
    ) {
      if (session.cols === cols && session.rows === rows) return;
      const resized = yield* resizePtyProcess(session, process, cols, rows).pipe(
        Effect.as(true),
        Effect.catch((error) =>
          Effect.logWarning("failed to resize terminal on open", {
            threadId: session.threadId,
            terminalId: session.terminalId,
            error: error.message,
          }).pipe(Effect.as(false)),
        ),
      );
      if (resized) {
        session.cols = cols;
        session.rows = rows;
        session.updatedAt = new Date().toISOString();
        yield* publishGrid(session);
      }
    });

    const open: TerminalManagerShape["open"] = (input, clientId = 0) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          const terminalId = input.terminalId ?? DEFAULT_TERMINAL_ID;
          const sessionKey = toSessionKey(input.threadId, terminalId);
          const existing = yield* getSession(input.threadId, terminalId);

          // Resuming only reattaches, so a cwd that has since gone must not fail it.
          if (input.resume === true) {
            if (Option.isSome(existing)) {
              const resumed = existing.value;
              const grid = desiredGrid(resumed, input, clientId);
              if (resumed.process) {
                yield* resizeOnAttach(resumed, resumed.process, grid.cols, grid.rows);
              }
              return snapshot(resumed);
            }
            if (closedSessionKeys.has(sessionKey)) {
              return yield* new TerminalSessionLookupError({
                threadId: input.threadId,
                terminalId,
              });
            }
          }

          yield* assertValidCwd(input.cwd);

          if (Option.isNone(existing)) {
            yield* flushPersist(input.threadId, terminalId);
            const history = neutralizeInheritedHistory(
              yield* readHistory(input.threadId, terminalId),
              historyLineLimit,
            );
            const cols = input.cols ?? DEFAULT_OPEN_COLS;
            const rows = input.rows ?? DEFAULT_OPEN_ROWS;
            const session: TerminalSessionState = {
              threadId: input.threadId,
              terminalId,
              cwd: input.cwd,
              status: "starting",
              pid: null,
              history: new BoundedTerminalHistory(historyLineLimit, history, historyByteLimit),
              pendingHistoryControlSequence: "",
              pendingProcessEvents: [],
              pendingProcessEventIndex: 0,
              processEventDrainRunning: false,
              exitCode: null,
              exitSignal: null,
              updatedAt: new Date().toISOString(),
              cols,
              rows,
              viewers: new Map(),
              process: null,
              unsubscribeData: null,
              unsubscribeExit: null,
              hasRunningSubprocess: false,
              childCommandLabel: null,
              runtimeEnv: normalizedRuntimeEnv(input.env),
              activityCount: 0,
              eventSequence: nextEventSequence(),
            };

            desiredGrid(session, input, clientId);
            const createdSession = session;
            closedSessionKeys.delete(sessionKey);
            yield* modifyManagerState((state) => {
              const sessions = new Map(state.sessions);
              sessions.set(sessionKey, createdSession);
              return [undefined, { ...state, sessions }] as const;
            });

            yield* evictInactiveSessionsIfNeeded();
            yield* startSession(
              session,
              {
                threadId: input.threadId,
                terminalId,
                cwd: input.cwd,
                cols,
                rows,
                ...(input.env ? { env: input.env } : {}),
              },
              "started",
            );
            return snapshot(session);
          }

          const liveSession = existing.value;
          const nextRuntimeEnv = normalizedRuntimeEnv(input.env);
          const currentRuntimeEnv = liveSession.runtimeEnv;
          const { cols: targetCols, rows: targetRows } = desiredGrid(liveSession, input, clientId);
          const runtimeEnvChanged = !Equal.equals(currentRuntimeEnv, nextRuntimeEnv);

          if (liveSession.cwd !== input.cwd || runtimeEnvChanged) {
            yield* stopProcess(liveSession);
            liveSession.cwd = input.cwd;
            liveSession.runtimeEnv = nextRuntimeEnv;
            liveSession.history.clear();
            liveSession.pendingHistoryControlSequence = "";
            liveSession.pendingProcessEvents = [];
            liveSession.pendingProcessEventIndex = 0;
            liveSession.processEventDrainRunning = false;
            yield* persistHistory(
              liveSession.threadId,
              liveSession.terminalId,
              liveSession.history,
            );
          } else if (liveSession.status === "exited" || liveSession.status === "error") {
            liveSession.runtimeEnv = nextRuntimeEnv;
            liveSession.history.clear();
            liveSession.pendingHistoryControlSequence = "";
            liveSession.pendingProcessEvents = [];
            liveSession.pendingProcessEventIndex = 0;
            liveSession.processEventDrainRunning = false;
            yield* persistHistory(
              liveSession.threadId,
              liveSession.terminalId,
              liveSession.history,
            );
          }

          if (!liveSession.process) {
            yield* startSession(
              liveSession,
              {
                threadId: input.threadId,
                terminalId,
                cwd: input.cwd,
                cols: targetCols,
                rows: targetRows,
                ...(input.env ? { env: input.env } : {}),
              },
              "started",
            );
            return snapshot(liveSession);
          }

          yield* resizeOnAttach(liveSession, liveSession.process, targetCols, targetRows);

          return snapshot(liveSession);
        }),
      );

    const write: TerminalManagerShape["write"] = Effect.fn("terminal.write")(function* (input) {
      const terminalId = input.terminalId ?? DEFAULT_TERMINAL_ID;
      const session = yield* requireSession(input.threadId, terminalId);
      const process = session.process;
      if (!process || session.status !== "running") {
        if (session.status === "exited") return;
        return yield* new TerminalNotRunningError({
          threadId: input.threadId,
          terminalId,
        });
      }
      session.activityCount += 1;
      yield* Effect.try({
        try: () => process.write(input.data),
        catch: (cause) =>
          new TerminalWriteError({
            threadId: input.threadId,
            terminalId,
            terminalPid: process.pid,
            cause,
          }),
      });
    });

    const resize: TerminalManagerShape["resize"] = (input, clientId = 0) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          const terminalId = input.terminalId ?? DEFAULT_TERMINAL_ID;
          const session = yield* requireSession(input.threadId, terminalId);
          const grid = desiredGrid(session, input, clientId);
          if (!session.process || session.status !== "running")
            return yield* new TerminalNotRunningError({ threadId: input.threadId, terminalId });
          if (session.cols === grid.cols && session.rows === grid.rows) return;
          yield* resizePtyProcess(session, session.process, grid.cols, grid.rows);
          session.cols = grid.cols;
          session.rows = grid.rows;
          session.updatedAt = new Date().toISOString();
          yield* publishGrid(session);
        }),
      );

    const detach: TerminalManagerShape["detach"] = (input, clientId = 0) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          const found = yield* getSession(input.threadId, input.terminalId ?? DEFAULT_TERMINAL_ID);
          if (Option.isNone(found)) return;
          const session = found.value;
          session.viewers.delete(`${clientId}:${input.viewerId}`);
          const grid = desiredGrid(session, {}, clientId);
          if (session.process)
            yield* resizeOnAttach(session, session.process, grid.cols, grid.rows);
        }),
      );
    const detachClient: TerminalManagerShape["detachClient"] = (clientId) =>
      Effect.gen(function* () {
        const state = yield* readManagerState;
        for (const session of state.sessions.values()) {
          yield* withThreadLock(
            session.threadId,
            Effect.gen(function* () {
              for (const [key, viewer] of session.viewers)
                if (viewer.clientId === clientId) session.viewers.delete(key);
              const grid = desiredGrid(session, {}, clientId);
              if (session.process)
                yield* resizeOnAttach(session, session.process, grid.cols, grid.rows);
            }),
          );
        }
      });

    const clear: TerminalManagerShape["clear"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          const terminalId = input.terminalId ?? DEFAULT_TERMINAL_ID;
          const session = yield* requireSession(input.threadId, terminalId);
          session.history.clear();
          session.pendingHistoryControlSequence = "";
          session.pendingProcessEvents = [];
          session.pendingProcessEventIndex = 0;
          session.processEventDrainRunning = false;
          session.updatedAt = new Date().toISOString();
          const sequence = nextEventSequence();
          session.eventSequence = sequence;
          yield* persistHistory(input.threadId, terminalId, session.history);
          yield* publishEvent({
            type: "cleared",
            threadId: input.threadId,
            terminalId,
            createdAt: new Date().toISOString(),
            sequence,
          });
        }),
      );

    const restart: TerminalManagerShape["restart"] = (input, clientId = 0) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          yield* increment(terminalRestartsTotal, { scope: "thread" });
          const terminalId = input.terminalId ?? DEFAULT_TERMINAL_ID;
          yield* assertValidCwd(input.cwd);

          const sessionKey = toSessionKey(input.threadId, terminalId);
          const existingSession = yield* getSession(input.threadId, terminalId);
          let session: TerminalSessionState;
          if (Option.isNone(existingSession)) {
            const cols = input.cols ?? DEFAULT_OPEN_COLS;
            const rows = input.rows ?? DEFAULT_OPEN_ROWS;
            session = {
              threadId: input.threadId,
              terminalId,
              cwd: input.cwd,
              status: "starting",
              pid: null,
              history: new BoundedTerminalHistory(historyLineLimit, "", historyByteLimit),
              pendingHistoryControlSequence: "",
              pendingProcessEvents: [],
              pendingProcessEventIndex: 0,
              processEventDrainRunning: false,
              exitCode: null,
              exitSignal: null,
              updatedAt: new Date().toISOString(),
              cols,
              rows,
              viewers: new Map(),
              process: null,
              unsubscribeData: null,
              unsubscribeExit: null,
              hasRunningSubprocess: false,
              childCommandLabel: null,
              runtimeEnv: normalizedRuntimeEnv(input.env),
              activityCount: 0,
              eventSequence: nextEventSequence(),
            };
            desiredGrid(session, input, clientId);
            const createdSession = session;
            closedSessionKeys.delete(sessionKey);
            yield* modifyManagerState((state) => {
              const sessions = new Map(state.sessions);
              sessions.set(sessionKey, createdSession);
              return [undefined, { ...state, sessions }] as const;
            });
            yield* evictInactiveSessionsIfNeeded();
          } else {
            session = existingSession.value;
            yield* stopProcess(session);
            session.cwd = input.cwd;
            session.runtimeEnv = normalizedRuntimeEnv(input.env);
          }

          const { cols, rows } = desiredGrid(session, input, clientId);

          session.history.clear();
          session.pendingHistoryControlSequence = "";
          session.pendingProcessEvents = [];
          session.pendingProcessEventIndex = 0;
          session.processEventDrainRunning = false;
          yield* persistHistory(input.threadId, terminalId, session.history);
          yield* startSession(
            session,
            {
              threadId: input.threadId,
              terminalId,
              cwd: input.cwd,
              cols,
              rows,
              ...(input.env ? { env: input.env } : {}),
            },
            "restarted",
          );
          return snapshot(session);
        }),
      );

    const subscribeMetadata: TerminalManagerShape["subscribeMetadata"] = Effect.fn(
      "terminal.subscribeMetadata",
    )(function* (listener) {
      // Registered before the snapshot is built, so no change can fall between the two.
      const subscriber: TerminalMetadataSubscriber = { listener, pending: [] };
      metadataSubscribers.add(subscriber);
      const unsubscribe = () => {
        metadataSubscribers.delete(subscriber);
      };
      return yield* Effect.gen(function* () {
        const { sessions } = yield* readManagerState;
        yield* deliverMetadata(subscriber, {
          type: "snapshot",
          terminals: [...sessions.values()]
            .filter((session) => session.status === "running" || session.status === "starting")
            .map(terminalSummary),
        });
        while (subscriber.pending !== null && subscriber.pending.length > 0) {
          const buffered: ReadonlyArray<TerminalMetadataStreamEvent> = subscriber.pending;
          subscriber.pending = [];
          for (const event of buffered) {
            yield* deliverMetadata(subscriber, event);
          }
        }
        subscriber.pending = null;
        return unsubscribe;
      }).pipe(Effect.onInterrupt(() => Effect.sync(unsubscribe)));
    });

    const close: TerminalManagerShape["close"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          if (input.terminalId) {
            yield* closeSession(input.threadId, input.terminalId, input.deleteHistory === true);
            return;
          }

          const threadSessions = yield* sessionsForThread(input.threadId);
          yield* Effect.forEach(
            threadSessions,
            (session) => closeSession(input.threadId, session.terminalId, false),
            { discard: true },
          );

          if (input.deleteHistory) {
            yield* deleteAllHistoryForThread(input.threadId);
          }
        }),
      );

    return {
      open,
      write,
      resize,
      detach,
      detachClient,
      clear,
      restart,
      close,
      subscribe: (listener) =>
        Effect.sync(() => {
          terminalEventListeners.add(listener);
          return () => {
            terminalEventListeners.delete(listener);
          };
        }),
      subscribeMetadata,
    } satisfies TerminalManagerShape;
  },
);

export const TerminalManagerLive = Layer.effect(TerminalManager, makeTerminalManager());
