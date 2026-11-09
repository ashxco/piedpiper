/**
 * Claude subscription usage from two sources that must land on the same rows:
 * `get_usage` reports every window as 0-100 with ISO resets, while the streamed
 * `rate_limit_event` names one window as a 0-1 fraction with an epoch-seconds reset.
 *
 * @module ClaudeUsageLimits
 */
import type { SDKControlGetUsageResponse, SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";

import {
  clampUsagePercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
  type ProviderUsageLimits,
  type ProviderUsageWindow,
} from "../providerUsageLimits.ts";

export type ClaudeUsageRead = Pick<
  SDKControlGetUsageResponse,
  "rate_limits_available" | "rate_limits"
>;

/** Shorter than the capabilities probe's deadline, so a slow read keeps the init data. */
export const CLAUDE_USAGE_READ_TIMEOUT_MS = 3_000;

const SESSION_MINS = 5 * 60;
const WEEK_MINS = 7 * 24 * 60;
/** The event names the overage-included model bucket by type; `get_usage` names it by model. */
const OVERAGE_INCLUDED_ID = "seven_day_overage_included";

const ACCOUNT_WINDOWS = {
  five_hour: { kind: "session", label: "Session", windowDurationMins: SESSION_MINS },
  seven_day: { kind: "weekly", label: "Weekly", windowDurationMins: WEEK_MINS },
} as const;

function isAccountWindowId(id: string): id is keyof typeof ACCOUNT_WINDOWS {
  return id in ACCOUNT_WINDOWS;
}

function isoFromString(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function isoFromEpochSeconds(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined;
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** `model_scoped` may be absent from older CLIs, so its entries are checked rather than trusted. */
function readModelScoped(rateLimits: NonNullable<ClaudeUsageRead["rate_limits"]>) {
  const entries: unknown = rateLimits.model_scoped;
  if (!Array.isArray(entries)) return [];
  return entries.filter(
    (entry): entry is { display_name: string; utilization: number; resets_at: string | null } =>
      typeof entry?.display_name === "string" &&
      entry.display_name.trim().length > 0 &&
      typeof entry.utilization === "number",
  );
}

/** `undefined` is a read that failed or timed out, which must not read as "no limits". */
export function claudeUsageToLimits(
  usage: ClaudeUsageRead | undefined,
  checkedAt: string,
): ProviderUsageLimits {
  if (!usage) return makeUnavailableUsageLimits({ checkedAt, reason: "probeFailed" });
  if (!usage.rate_limits) {
    return makeUnavailableUsageLimits({
      checkedAt,
      reason: usage.rate_limits_available ? "probeFailed" : "unsupported",
    });
  }
  const windows: ProviderUsageWindow[] = [];
  for (const [id, window] of Object.entries(ACCOUNT_WINDOWS)) {
    const reported = usage.rate_limits[id as keyof typeof ACCOUNT_WINDOWS];
    if (typeof reported?.utilization !== "number") continue;
    const resetsAt = isoFromString(reported.resets_at);
    windows.push({
      id,
      ...window,
      usedPercent: clampUsagePercent(reported.utilization),
      ...(resetsAt ? { resetsAt } : {}),
    });
  }
  // The allowlist behind model_scoped holds one model today; the first entry is the one events name.
  readModelScoped(usage.rate_limits).forEach((entry, index) => {
    const resetsAt = isoFromString(entry.resets_at);
    windows.push({
      id:
        index === 0
          ? OVERAGE_INCLUDED_ID
          : `seven_day_${entry.display_name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`,
      kind: "weekly",
      label: `Weekly · ${entry.display_name.trim()}`,
      windowDurationMins: WEEK_MINS,
      usedPercent: clampUsagePercent(entry.utilization),
      ...(resetsAt ? { resetsAt } : {}),
    });
  });
  return makeUsageLimits({ checkedAt, windows });
}

/**
 * The window a streamed event updates. An overage-included event before a read has named its
 * model is dropped, as guessing a label would draw a row the next read cannot reconcile.
 */
export function claudeRateLimitEventToWindows(
  info: Pick<SDKRateLimitInfo, "rateLimitType" | "utilization" | "resetsAt"> &
    Partial<Pick<SDKRateLimitInfo, "status">>,
  current: ProviderUsageLimits | undefined,
): ReadonlyArray<ProviderUsageWindow> {
  const id = info.rateLimitType;
  if (!id) return [];
  const resetsAt = isoFromEpochSeconds(info.resetsAt);
  const known = current?.windows.find((window) => window.id === id);
  // A rejection often names no utilization, but it does mean the window is used up.
  const usedPercent =
    typeof info.utilization === "number"
      ? clampUsagePercent(info.utilization * 100)
      : info.status === "rejected"
        ? 100
        : undefined;
  if (usedPercent === undefined) {
    return known && resetsAt ? [{ ...known, resetsAt }] : [];
  }
  if (isAccountWindowId(id)) {
    return [{ id, ...ACCOUNT_WINDOWS[id], usedPercent, ...(resetsAt ? { resetsAt } : {}) }];
  }
  if (id !== OVERAGE_INCLUDED_ID) return [];
  return known ? [{ ...known, usedPercent, ...(resetsAt ? { resetsAt } : {}) }] : [];
}

/** For the capabilities probe: a failed or slow read answers `undefined` instead of rejecting. */
export function readClaudeUsage(
  query: {
    readonly usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: (options: {
      skipBehaviors: boolean;
    }) => Promise<ClaudeUsageRead>;
  },
  timeoutMs: number = CLAUDE_USAGE_READ_TIMEOUT_MS,
): Promise<ClaudeUsageRead | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), timeoutMs);
    // skipBehaviors avoids a scan of local transcripts that can outlast the deadline.
    query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }).then(
      (usage) => {
        clearTimeout(timer);
        resolve({
          rate_limits_available: usage.rate_limits_available,
          rate_limits: usage.rate_limits,
        });
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}
