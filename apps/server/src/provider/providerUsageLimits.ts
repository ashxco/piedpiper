/**
 * Subscription usage windows a provider reports for the signed-in account, shared by the
 * Codex and Claude mappers. The interfaces mirror `usageLimits` on the `ServerProvider`
 * contract, which an older server or client may not carry, so it is read structurally.
 *
 * @module providerUsageLimits
 */
import type { ServerProvider } from "@piedpiper/contracts";

export interface ProviderUsageWindow {
  /** Stable per provider, so a sparse live update lands on the row a full read produced. */
  readonly id: string;
  readonly kind: "session" | "weekly" | "monthly" | "other";
  readonly label: string;
  /** 0-100. */
  readonly usedPercent: number;
  readonly resetsAt?: string;
  readonly windowDurationMins?: number;
}

export interface ProviderUsageLimits {
  readonly checkedAt: string;
  readonly windows: ReadonlyArray<ProviderUsageWindow>;
  /** `unsupported` can never report windows (API key); `probeFailed` failed this time. */
  readonly unavailable?: {
    readonly reason: "unsupported" | "probeFailed";
    readonly message?: string;
  };
}

const WINDOW_KIND_ORDER: Record<ProviderUsageWindow["kind"], number> = {
  session: 0,
  weekly: 1,
  monthly: 2,
  other: 3,
};

export function clampUsagePercent(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
}

export function makeUsageLimits(input: {
  readonly checkedAt: string;
  readonly windows: Iterable<ProviderUsageWindow>;
}): ProviderUsageLimits {
  return {
    checkedAt: input.checkedAt,
    windows: [...input.windows].toSorted(
      (left, right) =>
        WINDOW_KIND_ORDER[left.kind] - WINDOW_KIND_ORDER[right.kind] ||
        left.id.localeCompare(right.id),
    ),
  };
}

export function makeUnavailableUsageLimits(input: {
  readonly checkedAt: string;
  readonly reason: "unsupported" | "probeFailed";
  readonly message?: string;
}): ProviderUsageLimits {
  return {
    checkedAt: input.checkedAt,
    windows: [],
    unavailable: {
      reason: input.reason,
      ...(input.message ? { message: input.message } : {}),
    },
  };
}

/**
 * Folds a sparse live update in by window id. Omitted windows are unchanged, and a window
 * without a reset or duration keeps the last known one. An unsupported account stays so.
 */
export function mergeUsageLimitsUpdate(input: {
  readonly previous: ProviderUsageLimits | undefined;
  readonly windows: ReadonlyArray<ProviderUsageWindow>;
  readonly checkedAt: string;
}): ProviderUsageLimits | undefined {
  const { previous, windows, checkedAt } = input;
  if (windows.length === 0 || previous?.unavailable?.reason === "unsupported") {
    return previous;
  }
  const merged = new Map(previous?.windows.map((window) => [window.id, window] as const));
  for (const window of windows) {
    const existing = merged.get(window.id);
    const resetsAt = window.resetsAt ?? existing?.resetsAt;
    const windowDurationMins = window.windowDurationMins ?? existing?.windowDurationMins;
    merged.set(window.id, {
      ...window,
      usedPercent: clampUsagePercent(window.usedPercent),
      ...(resetsAt !== undefined ? { resetsAt } : {}),
      ...(windowDurationMins !== undefined ? { windowDurationMins } : {}),
    });
  }
  return makeUsageLimits({ checkedAt, windows: merged.values() });
}

/** A read that failed this time keeps the last good windows; `unsupported` replaces them. */
export function resolveUsageLimitsAfterProbe(input: {
  readonly published: ProviderUsageLimits | undefined;
  readonly probed: ProviderUsageLimits | undefined;
}): ProviderUsageLimits | undefined {
  const { published, probed } = input;
  if (probed?.unavailable?.reason === "probeFailed" && published && !published.unavailable) {
    return published;
  }
  return probed;
}

export function readProviderUsageLimits(provider: ServerProvider): ProviderUsageLimits | undefined {
  return (provider as ServerProvider & { readonly usageLimits?: ProviderUsageLimits }).usageLimits;
}

export function withProviderUsageLimits(
  provider: ServerProvider,
  usageLimits: ProviderUsageLimits | undefined,
): ServerProvider {
  if (usageLimits === undefined) {
    return provider;
  }
  const next = { ...provider, usageLimits };
  return next;
}
