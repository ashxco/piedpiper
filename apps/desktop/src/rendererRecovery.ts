export const RENDERER_RECOVERY_RELOAD_DELAY_MS = 500;
const RENDERER_RECOVERY_MAX_ATTEMPTS = 3;
const RENDERER_RECOVERY_WINDOW_MS = 60_000;

const RECOVERABLE_RENDERER_EXIT_REASONS: ReadonlySet<string> = new Set([
  "crashed",
  "oom",
  "abnormal-exit",
  "killed",
]);

export function isRecoverableRendererExit(reason: string): boolean {
  return RECOVERABLE_RENDERER_EXIT_REASONS.has(reason);
}

export interface RendererRecoveryPolicy {
  /**
   * How long to wait before reloading after a renderer exit, or null when the exit is not
   * recoverable. Records the scheduled reload against the rolling window.
   */
  readonly reloadDelayMs: (reason: string, nowMs: number) => number | null;
}

/**
 * Paces renderer reloads so a renderer that dies on boot cannot reload-loop. Past the budget it
 * waits for the oldest attempt to leave the window instead of giving up, so a crash loop backs
 * off but never leaves the window blank.
 */
export function createRendererRecoveryPolicy(options?: {
  readonly maxAttempts?: number;
  readonly windowMs?: number;
  readonly reloadDelayMs?: number;
}): RendererRecoveryPolicy {
  const maxAttempts = options?.maxAttempts ?? RENDERER_RECOVERY_MAX_ATTEMPTS;
  const windowMs = options?.windowMs ?? RENDERER_RECOVERY_WINDOW_MS;
  const minimumDelayMs = options?.reloadDelayMs ?? RENDERER_RECOVERY_RELOAD_DELAY_MS;
  // When each reload runs, which can be later than the exit that scheduled it.
  let attemptTimestamps: number[] = [];

  return {
    reloadDelayMs: (reason, nowMs) => {
      if (!isRecoverableRendererExit(reason)) return null;
      attemptTimestamps = attemptTimestamps.filter((timestamp) => nowMs - timestamp < windowMs);
      const oldestAttempt =
        attemptTimestamps.length >= maxAttempts
          ? attemptTimestamps[attemptTimestamps.length - maxAttempts]
          : undefined;
      const delayMs =
        oldestAttempt === undefined
          ? minimumDelayMs
          : Math.max(minimumDelayMs, oldestAttempt + windowMs - nowMs);
      attemptTimestamps.push(nowMs + delayMs);
      return delayMs;
    },
  };
}
