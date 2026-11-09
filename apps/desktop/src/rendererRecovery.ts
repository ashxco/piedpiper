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
  /** True when a reload should be attempted; records the attempt against the rolling window. */
  readonly shouldRecover: (reason: string, nowMs: number) => boolean;
}

/** Bounds renderer reloads so a renderer that dies on boot cannot reload-loop forever. */
export function createRendererRecoveryPolicy(options?: {
  readonly maxAttempts?: number;
  readonly windowMs?: number;
}): RendererRecoveryPolicy {
  const maxAttempts = options?.maxAttempts ?? RENDERER_RECOVERY_MAX_ATTEMPTS;
  const windowMs = options?.windowMs ?? RENDERER_RECOVERY_WINDOW_MS;
  let attemptTimestamps: number[] = [];

  return {
    shouldRecover: (reason, nowMs) => {
      if (!isRecoverableRendererExit(reason)) return false;
      attemptTimestamps = attemptTimestamps.filter((timestamp) => nowMs - timestamp < windowMs);
      if (attemptTimestamps.length >= maxAttempts) return false;
      attemptTimestamps.push(nowMs);
      return true;
    },
  };
}
