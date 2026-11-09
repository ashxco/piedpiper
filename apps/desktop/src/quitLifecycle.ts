/** Longer than the backend stop budget so a double Cmd-Q cannot cut a normal quit short. */
const QUIT_STALL_THRESHOLD_MS = 10_000;
/** Absolute cap on a quit that is waiting for shutdown; past it the app exits regardless. */
const QUIT_HARD_EXIT_CAP_MS = 15_000;

type QuitPhase = "running" | "waiting" | "allowed";
type QuitRequestOutcome = "begin" | "in-progress" | "stalled" | "allowed";

export interface QuitGuard {
  readonly phase: () => QuitPhase;
  /** Classifies a quit request so only the first one runs shutdown and a stuck one can escape. */
  readonly request: () => QuitRequestOutcome;
  /** Lets the next quit proceed without shutdown work (it already ran, or the updater owns it). */
  readonly allow: () => void;
  /** Returns to "running" when a handed-off quit (e.g. an update install) did not happen. */
  readonly reset: () => void;
}

/** Monotonic so a wall-clock jump cannot misclassify a fresh quit request as stalled. */
function monotonicNowMs(): number {
  return performance.now();
}

export function createQuitGuard(options?: {
  readonly stallThresholdMs?: number;
  readonly now?: () => number;
}): QuitGuard {
  const stallThresholdMs = options?.stallThresholdMs ?? QUIT_STALL_THRESHOLD_MS;
  const now = options?.now ?? monotonicNowMs;
  let phase: QuitPhase = "running";
  let waitingSince = 0;

  return {
    phase: () => phase,
    request: () => {
      if (phase === "allowed") return "allowed";
      if (phase === "waiting") {
        return now() - waitingSince >= stallThresholdMs ? "stalled" : "in-progress";
      }
      phase = "waiting";
      waitingSince = now();
      return "begin";
    },
    allow: () => {
      phase = "allowed";
    },
    reset: () => {
      phase = "running";
      waitingSince = 0;
    },
  };
}

export interface QuitControllerOptions {
  readonly guard: QuitGuard;
  /** Stops the backend and anything else that must finish before the process exits. */
  readonly shutdown: (source: string) => Promise<void>;
  /** Terminates the process immediately. */
  readonly exit: () => void;
  /** Lets an already-allowed quit go ahead (e.g. app.quit()); before-quit then passes it through. */
  readonly proceed: () => void;
  readonly log: (message: string) => void;
  readonly onShutdownError?: (source: string, error: unknown) => void;
  readonly hardExitCapMs?: number;
}

/** Single quit path for before-quit, signals and fatal errors: shut down once, then exit. */
export function createQuitController(options: QuitControllerOptions): (source: string) => void {
  const hardExitCapMs = options.hardExitCapMs ?? QUIT_HARD_EXIT_CAP_MS;
  let exited = false;
  const exitOnce = (): void => {
    if (exited) return;
    exited = true;
    options.exit();
  };

  return (source) => {
    const outcome = options.guard.request();
    if (outcome === "allowed") {
      options.proceed();
      return;
    }
    if (outcome === "in-progress") {
      options.log(`${source}: quit already in progress`);
      return;
    }
    if (outcome === "stalled") {
      options.log(`${source}: shutdown stalled; exiting without it`);
      exitOnce();
      return;
    }

    const hardExitTimer = setTimeout(() => {
      options.log(`${source}: shutdown exceeded ${hardExitCapMs}ms; forcing exit`);
      exitOnce();
    }, hardExitCapMs);
    hardExitTimer.unref?.();

    void Promise.resolve()
      .then(() => options.shutdown(source))
      .catch((error: unknown) => {
        options.onShutdownError?.(source, error);
      })
      .finally(() => {
        clearTimeout(hardExitTimer);
        options.guard.allow();
        exitOnce();
      });
  };
}

export function isEpipeError(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "EPIPE"
  );
}

/** A vanished parent pipe/tty (EPIPE, EIO) or any other stdio failure must never crash main. */
export function ignoreEpipeErrors(stream: NodeJS.EventEmitter): void {
  stream.on("error", () => {});
}
