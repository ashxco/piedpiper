import type { ServerProvider, ServerProviderAuthStatus } from "@piedpiper/contracts";

/** Mirrors `usageLimits` on the server's provider snapshot, which older servers do not send. */
export interface ProviderUsageWindow {
  readonly id: string;
  readonly label: string;
  readonly usedPercent: number;
  readonly resetsAt?: string;
}

export interface ProviderUsageLimits {
  readonly checkedAt: string;
  readonly windows: ReadonlyArray<ProviderUsageWindow>;
  readonly unavailable?: {
    readonly reason: "unsupported" | "probeFailed";
    readonly message?: string;
  };
}

export interface ProviderUsageLimitRow {
  readonly id: string;
  readonly label: string;
  /** 0-100, for the bar. */
  readonly usedPercent: number;
  readonly usedLabel: string;
  readonly resetLabel: string | null;
}

export function readProviderUsageLimits(provider: ServerProvider): ProviderUsageLimits | undefined {
  return (provider as ServerProvider & { readonly usageLimits?: ProviderUsageLimits }).usageLimits;
}

function formatResetWait(waitMs: number): string {
  const totalMinutes = Math.ceil(waitMs / 60_000);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return hours === 0 ? `${days}d` : `${days}d ${hours}h`;
  if (hours === 0) return `${totalMinutes}m`;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

/** A reset that has already passed means the figure predates it, so it reads as stale. */
export function deriveProviderUsageLimitRows(
  limits: ProviderUsageLimits | undefined,
  nowMs: number,
): ReadonlyArray<ProviderUsageLimitRow> {
  return (limits?.windows ?? []).map((window) => {
    const usedPercent = Math.max(0, Math.min(100, window.usedPercent));
    const resetMs = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
    return {
      id: window.id,
      label: window.label,
      usedPercent,
      usedLabel: `${Math.round(usedPercent)}% used`,
      resetLabel: Number.isNaN(resetMs)
        ? null
        : resetMs > nowMs
          ? `Resets in ${formatResetWait(resetMs - nowMs)}`
          : "Reset since last check",
    };
  });
}

/** The line shown in place of, or beneath, the rows; null when the rows say it all. */
export function describeProviderUsageLimits(
  limits: ProviderUsageLimits | undefined,
  authStatus?: ServerProviderAuthStatus,
): string | null {
  // A signed-out provider never reports, so "yet" would promise data that is not coming.
  if (!limits) {
    return authStatus === "unauthenticated" ? "Sign in to see usage limits." : "No usage data yet.";
  }
  if (limits.unavailable?.reason === "unsupported") {
    return "This account has no subscription limits to show.";
  }
  if (limits.unavailable) return limits.unavailable.message ?? "Could not read usage limits.";
  return limits.windows.length === 0 ? "No usage limits reported." : null;
}
