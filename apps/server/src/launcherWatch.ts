import { Duration, Effect } from "effect";

const DEFAULT_POLL_INTERVAL = Duration.seconds(2);

// Sampled at module load, before config resolution and the bootstrap read, so a
// launcher that dies during startup is still noticed.
const startupParentPid = process.ppid;

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    // EPERM: the process exists but belongs to someone else.
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Completes when the process that launched this backend is gone.
 *
 * A desktop-launched backend reads its bootstrap envelope once and never looks
 * at its launcher again, so when Electron crashes or is killed the backend
 * would keep serving with no desktop able to reach it. An orphan is adopted by
 * init or a subreaper, so any change of parent counts. A backend that already
 * starts under init has no launcher to lose, so it is not watched. Windows keeps
 * the original parent id after the parent exits, so there the launcher's own
 * liveness is polled instead.
 */
export const awaitLauncherLoss = (options?: {
  readonly launcherPid?: number;
  readonly getParentPid?: () => number;
  readonly platform?: NodeJS.Platform;
  readonly interval?: Duration.Input;
  readonly isProcessAlive?: (pid: number) => boolean;
}): Effect.Effect<void> =>
  Effect.gen(function* () {
    const platform = options?.platform ?? process.platform;
    const launcherPid = options?.launcherPid ?? startupParentPid;
    const getParentPid = options?.getParentPid ?? (() => process.ppid);
    const interval = options?.interval ?? DEFAULT_POLL_INTERVAL;
    if (launcherPid <= 1) return yield* Effect.never;
    if (platform === "win32") {
      const isAlive = options?.isProcessAlive ?? isProcessAlive;
      const pollLiveness: Effect.Effect<void> = Effect.suspend(() =>
        isAlive(launcherPid)
          ? Effect.flatMap(Effect.sleep(interval), () => pollLiveness)
          : Effect.logWarning("desktop launcher is gone; shutting down the backend", {
              launcherPid,
            }),
      );
      return yield* pollLiveness;
    }
    const poll: Effect.Effect<void> = Effect.suspend(() => {
      const parentPid = getParentPid();
      return parentPid === launcherPid
        ? Effect.flatMap(Effect.sleep(interval), () => poll)
        : Effect.logWarning("desktop launcher is gone; shutting down the backend", {
            launcherPid,
            parentPid,
          });
    });
    return yield* poll;
  });

// Matches the desktop's SIGTERM -> SIGKILL grace (BACKEND_TERMINATE_GRACE_MS): with the
// launcher gone nobody else will SIGKILL a backend whose finalizers hang.
const DEFAULT_SHUTDOWN_DEADLINE = Duration.seconds(5);

// The desktop launcher reads this process's stdout/stderr. Once it is gone every
// log write fails, and Node turns an unhandled stream error into a crash that
// skips shutdown.
export function ignoreClosedLauncherPipe(error: NodeJS.ErrnoException): void {
  if (error.code !== "EPIPE" && error.code !== "ERR_STREAM_DESTROYED") throw error;
}

/** Arms a one-shot, unref'd timer that force-exits if shutdown outlives `deadline`. */
export const armShutdownDeadline = (options?: {
  readonly deadline?: Duration.Input;
  readonly forceExit?: () => void;
}): Effect.Effect<void> =>
  Effect.sync(() => {
    const forceExit = options?.forceExit ?? (() => process.exit(1));
    const deadlineMs = Duration.toMillis(
      Duration.fromInputUnsafe(options?.deadline ?? DEFAULT_SHUTDOWN_DEADLINE),
    );
    setTimeout(forceExit, deadlineMs).unref();
  });

/**
 * Runs `program` until it finishes or the launcher disappears, whichever comes
 * first. On launcher loss `program` is interrupted so its finalizers run, and the
 * result is an interrupt-only exit: like SIGTERM, that makes `runMain` call
 * `process.exit` instead of waiting for the event loop to drain. A hard deadline
 * force-exits if finalizers hang.
 */
export const untilLauncherLoss = <A, E, R>(
  program: Effect.Effect<A, E, R>,
  options?: Parameters<typeof awaitLauncherLoss>[0] & {
    readonly guardLauncherPipes?: boolean;
    readonly shutdownDeadline?: Duration.Input;
    readonly forceExit?: () => void;
  },
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    if (options?.guardLauncherPipes !== false) {
      yield* Effect.sync(() => {
        process.stdout.on("error", ignoreClosedLauncherPipe);
        process.stderr.on("error", ignoreClosedLauncherPipe);
      });
    }
    const launcherLost = awaitLauncherLoss(options).pipe(
      Effect.andThen(
        armShutdownDeadline({
          ...(options?.shutdownDeadline !== undefined
            ? { deadline: options.shutdownDeadline }
            : {}),
          ...(options?.forceExit !== undefined ? { forceExit: options.forceExit } : {}),
        }),
      ),
      Effect.andThen(Effect.interrupt),
    );
    return yield* Effect.raceFirst(program, launcherLost);
  });
