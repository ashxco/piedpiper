import * as Path from "node:path";

import { SERVER_EXIT_CODE_STATE_DIR_OWNED } from "@piedpiper/shared/serverExitCodes";

const BACKEND_RESTART_INITIAL_DELAY_MS = 500;
const BACKEND_RESTART_MAX_DELAY_MS = 10_000;
/** A backend that stays up this long is healthy; earlier exits keep the restart backoff growing. */
const BACKEND_STABLE_UPTIME_MS = 10_000;
/** SIGTERM grace before SIGKILL so the server's provider finalizers get to run. */
export const BACKEND_TERMINATE_GRACE_MS = 5_000;
/** Covers the SIGTERM grace plus the SIGKILL exit wait so quit cannot orphan a hung backend. */
export const BACKEND_QUIT_STOP_TIMEOUT_MS = BACKEND_TERMINATE_GRACE_MS + 2_000;
/** Consecutive starts that never became stable before desktop stops restarting and reports. */
const BACKEND_CRASH_LOOP_MAX_FAILED_STARTS = 3;
const BACKEND_OUTPUT_TAIL_MAX_BYTES = 4 * 1024;

export function calculateBackendRestartDelayMs(attempt: number): number {
  return Math.min(BACKEND_RESTART_INITIAL_DELAY_MS * 2 ** attempt, BACKEND_RESTART_MAX_DELAY_MS);
}

export interface BackendRestartBackoff {
  readonly attempt: () => number;
  /** Returns the delay for the next restart and advances the attempt counter. */
  readonly nextRestartDelayMs: () => number;
  /** Arms the stability timer; the attempt counter resets only once the backend stays up long enough. */
  readonly markSpawned: () => BackendStabilityHandle;
  readonly markExited: () => void;
  /** Forgets earlier failures, e.g. when the user retries after a crash loop. */
  readonly reset: () => void;
}

interface BackendStabilityHandle {
  /** Disarms the stability timer only if it is still the one this spawn armed. */
  readonly cancel: () => void;
}

export function createBackendRestartBackoff(options?: {
  readonly stableUptimeMs?: number;
}): BackendRestartBackoff {
  const stableUptimeMs = options?.stableUptimeMs ?? BACKEND_STABLE_UPTIME_MS;
  let attempt = 0;
  let stableTimer: ReturnType<typeof setTimeout> | null = null;

  const clearStableTimer = (): void => {
    if (stableTimer) {
      clearTimeout(stableTimer);
      stableTimer = null;
    }
  };

  return {
    attempt: () => attempt,
    nextRestartDelayMs: () => {
      const delayMs = calculateBackendRestartDelayMs(attempt);
      attempt += 1;
      return delayMs;
    },
    markSpawned: () => {
      clearStableTimer();
      const timer = setTimeout(() => {
        stableTimer = null;
        attempt = 0;
      }, stableUptimeMs);
      timer.unref();
      stableTimer = timer;
      return {
        cancel: () => {
          if (stableTimer === timer) clearStableTimer();
        },
      };
    },
    markExited: clearStableTimer,
    reset: () => {
      clearStableTimer();
      attempt = 0;
    },
  };
}

/** `attempt` is the backoff's counter before this failure, so it is one less than the failed starts. */
export function isBackendCrashLooping(attempt: number): boolean {
  return attempt + 1 >= BACKEND_CRASH_LOOP_MAX_FAILED_STARTS;
}

/** A backend we just stopped may still hold the state directory, so retry quietly before asking. */
export const BACKEND_STATE_DIR_OWNED_RETRY_WINDOW_MS = 10_000;
export const BACKEND_STATE_DIR_OWNED_RETRY_DELAY_MS = 1_000;

export interface StateDirOwnedRetry {
  /** Records a refusal: the delay before retrying, or null once the window has passed. */
  readonly nextRetryDelayMs: (nowMs: number) => number | null;
  /** Forgets earlier refusals, once another outcome ends the streak or the user retries. */
  readonly reset: () => void;
}

export function createStateDirOwnedRetry(): StateDirOwnedRetry {
  let firstRefusedAtMs: number | null = null;
  return {
    nextRetryDelayMs: (nowMs) => {
      firstRefusedAtMs ??= nowMs;
      return nowMs - firstRefusedAtMs < BACKEND_STATE_DIR_OWNED_RETRY_WINDOW_MS
        ? BACKEND_STATE_DIR_OWNED_RETRY_DELAY_MS
        : null;
    },
    reset: () => {
      firstRefusedAtMs = null;
    },
  };
}

export type BackendExitAction =
  | { readonly kind: "none" }
  | { readonly kind: "retry-state-dir"; readonly delayMs: number }
  | { readonly kind: "ask-state-dir" }
  | { readonly kind: "restart"; readonly reason: string };

/** What an exit of the backend child calls for; a refusal over the data folder is not a crash. */
export function resolveBackendExitAction(input: {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  /** Desktop stopped this child itself, or the app is quitting. */
  readonly expected: boolean;
  readonly restartOrDialogPending: boolean;
  readonly stateDirOwnedRetry: StateDirOwnedRetry;
  readonly nowMs: number;
}): BackendExitAction {
  if (input.expected) {
    // A healthy server holds the lock, so an expected stop is the only way back to a refusal.
    input.stateDirOwnedRetry.reset();
    return { kind: "none" };
  }
  if (input.code === SERVER_EXIT_CODE_STATE_DIR_OWNED) {
    if (input.restartOrDialogPending) return { kind: "none" };
    const delayMs = input.stateDirOwnedRetry.nextRetryDelayMs(input.nowMs);
    return delayMs === null ? { kind: "ask-state-dir" } : { kind: "retry-state-dir", delayMs };
  }
  input.stateDirOwnedRetry.reset();
  return {
    kind: "restart",
    reason: `code=${input.code ?? "null"} signal=${input.signal ?? "null"}`,
  };
}

export interface OutputTail {
  readonly append: (chunk: Buffer | string) => void;
  readonly text: () => string;
  readonly clear: () => void;
}

/** Keeps only the last `maxBytes` of a process's combined output. */
export function createOutputTail(maxBytes = BACKEND_OUTPUT_TAIL_MAX_BYTES): OutputTail {
  let buffer = Buffer.alloc(0);
  return {
    append: (chunk) => {
      const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
      const combined = Buffer.concat([buffer, next]);
      buffer =
        combined.length > maxBytes ? combined.subarray(combined.length - maxBytes) : combined;
    },
    // A cut may split a multi-byte character; drop the replacement char it leaves at the start.
    text: () => buffer.toString("utf8").replace(/^\uFFFD+/, ""),
    clear: () => {
      buffer = Buffer.alloc(0);
    },
  };
}

export function formatBackendFailureDetail(input: {
  readonly reason: string;
  readonly outputTail: string;
  readonly logDir: string | null;
}): string {
  const sections = [`Last exit: ${input.reason}`];
  if (input.logDir) sections.push(`Logs: ${input.logDir}`);
  const tail = input.outputTail.trim();
  sections.push(tail.length > 0 ? `Recent output:\n${tail}` : "No backend output was captured.");
  return sections.join("\n\n");
}

/** The folder the backend locks; mirrors deriveServerPaths, which picks "dev" when given a dev URL. */
export function resolveBackendStateDir(baseDir: string, isDevelopment: boolean): string {
  return Path.join(baseDir, isDevelopment ? "dev" : "userdata");
}

export function formatBackendStateDirOwnedDetail(input: {
  readonly stateDir: string;
  readonly outputTail: string;
  readonly platform?: NodeJS.Platform;
}): string {
  const sections = [
    "Quit the other copy of Pied Piper, or stop any Pied Piper server running in a terminal, then choose Retry.",
    // A crashed app's hidden backend has no window or terminal to stop it from.
    ...(input.platform === "win32"
      ? ["If no other copy is open, end the leftover Pied Piper process in Task Manager."]
      : []),
    `Data folder: ${input.stateDir}`,
  ];
  const tail = input.outputTail
    .split(/\r?\n/)
    .filter((line) => !/^\s+at /.test(line))
    .join("\n")
    .trim();
  if (tail.length > 0) sections.push(`Server output:\n${tail}`);
  return sections.join("\n\n");
}

export interface TerminableChild {
  readonly pid?: number | undefined;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit" | "error", listener: () => void): unknown;
  off(event: "exit" | "error", listener: () => void): unknown;
}

function hasChildExited(child: TerminableChild): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/** A child whose spawn failed has no pid and may never emit 'exit'. */
function hasChildFailedToSpawn(child: TerminableChild): boolean {
  return "pid" in child && child.pid === undefined;
}

export type TerminateChildOutcome = "already-exited" | "exited" | "timeout";

/** SIGTERM, SIGKILL after graceMs, and resolve on exit or after timeoutMs, whichever comes first. */
export function terminateChildAndWaitForExit(
  child: TerminableChild,
  options: { readonly graceMs: number; readonly timeoutMs: number },
): Promise<TerminateChildOutcome> {
  if (hasChildExited(child) || hasChildFailedToSpawn(child)) {
    return Promise.resolve("already-exited");
  }

  return new Promise<TerminateChildOutcome>((resolve) => {
    let settled = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
    let exitTimeoutTimer: ReturnType<typeof setTimeout> | null = null;

    const settle = (outcome: TerminateChildOutcome): void => {
      if (settled) return;
      settled = true;
      child.off("exit", onExit);
      child.off("error", onError);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (exitTimeoutTimer) clearTimeout(exitTimeoutTimer);
      forceKillTimer = null;
      exitTimeoutTimer = null;
      resolve(outcome);
    };

    const forceKill = (): void => {
      if (forceKillTimer) clearTimeout(forceKillTimer);
      forceKillTimer = null;
      if (!hasChildExited(child)) {
        child.kill("SIGKILL");
      }
    };

    function onExit(): void {
      settle("exited");
    }

    // A kill() failure also emits 'error'; only a spawn failure means there is nothing to wait for.
    function onError(): void {
      if (hasChildExited(child) || hasChildFailedToSpawn(child)) settle("exited");
    }

    // Timers are armed before kill() so a synchronous 'exit' still clears them.
    forceKillTimer = setTimeout(forceKill, options.graceMs);
    forceKillTimer.unref();

    exitTimeoutTimer = setTimeout(() => {
      exitTimeoutTimer = null;
      // Stopping the wait must not cancel the escalation, or a short timeout would orphan the child.
      if (forceKillTimer) forceKill();
      settle("timeout");
    }, options.timeoutMs);
    exitTimeoutTimer.unref();

    child.once("exit", onExit);
    child.once("error", onError);
    child.kill("SIGTERM");
  });
}
