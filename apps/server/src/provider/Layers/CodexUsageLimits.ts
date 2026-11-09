/**
 * Codex usage-limit stops. Codex reports them as OpenAI's own sentence (which on
 * a workspace plan blames credits for a window that simply ran out), once on the
 * `error` notification and again on the failed `turn/completed`. The snapshot
 * naming the exhausted window arrives separately on `account/rateLimits/updated`,
 * often sparse, so the tracker keeps a merged per-thread view of it and replaces
 * both provider sentences with one message naming the window and its reset.
 */
import type { ProviderEvent, ProviderRuntimeEvent } from "@piedpiper/contracts";

import type { CodexAccountSnapshot } from "../codexAccount.ts";
import {
  clampUsagePercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
  type ProviderUsageLimits,
  type ProviderUsageWindow,
} from "../providerUsageLimits.ts";
import { asObject, asString, runtimeEventBase } from "./CodexAdapterHelpers.ts";

export interface CodexRateLimitWindow {
  readonly usedPercent?: number | null;
  readonly resetsAt?: number | null;
  readonly windowDurationMins?: number | null;
}

export interface CodexRateLimitSnapshot {
  readonly limitId?: string | null;
  readonly planType?: string | null;
  readonly rateLimitReachedType?: string | null;
  readonly primary?: CodexRateLimitWindow | null;
  readonly secondary?: CodexRateLimitWindow | null;
}

const SESSION_MINS = 5 * 60;
const WEEK_MINS = 7 * 24 * 60;
const MONTH_MINS = 30 * 24 * 60;

function finiteNumber(field: unknown): number | undefined {
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function readWindow(value: unknown): CodexRateLimitWindow | null | undefined {
  if (value === null) return null;
  const record = asObject(value);
  if (!record) return undefined;
  const usedPercent = finiteNumber(record.usedPercent);
  const resetsAt = finiteNumber(record.resetsAt);
  const windowDurationMins = finiteNumber(record.windowDurationMins);
  return {
    ...(usedPercent !== undefined ? { usedPercent } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    ...(windowDurationMins !== undefined ? { windowDurationMins } : {}),
  };
}

function readNullableString(value: unknown): string | null | undefined {
  return value === null ? null : asString(value);
}

/** Reads the snapshot from an `account/rateLimits/updated` payload (`{ rateLimits }`). */
function readCodexRateLimitSnapshot(payload: unknown): CodexRateLimitSnapshot | undefined {
  const outer = asObject(payload);
  const snapshot = asObject(outer?.rateLimits) ?? outer;
  if (!snapshot) return undefined;
  const result: Record<string, unknown> = {};
  for (const key of ["limitId", "planType", "rateLimitReachedType"] as const) {
    const value = readNullableString(snapshot[key]);
    if (value !== undefined) result[key] = value;
  }
  for (const key of ["primary", "secondary"] as const) {
    const value = readWindow(snapshot[key]);
    if (value !== undefined) result[key] = value;
  }
  return result as CodexRateLimitSnapshot;
}

/** Fields an update omits keep the value seen earlier; model-specific limits never replace the main one. */
export function mergeCodexRateLimits(
  previous: CodexRateLimitSnapshot | undefined,
  update: CodexRateLimitSnapshot,
): CodexRateLimitSnapshot | undefined {
  if (update.limitId && update.limitId !== "codex") return previous;
  if (!previous) return update;
  return {
    ...previous,
    ...(update.limitId !== undefined ? { limitId: update.limitId } : {}),
    ...(update.planType !== undefined ? { planType: update.planType } : {}),
    ...(update.rateLimitReachedType !== undefined
      ? { rateLimitReachedType: update.rateLimitReachedType }
      : {}),
    ...(update.primary !== undefined ? { primary: update.primary } : {}),
    ...(update.secondary !== undefined ? { secondary: update.secondary } : {}),
  };
}

function windowKind(mins: number): "session" | "weekly" | "monthly" {
  if (mins >= MONTH_MINS) return "monthly";
  if (mins >= WEEK_MINS) return "weekly";
  return "session";
}

function isoFromEpochSeconds(value: number | null | undefined): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** `primary` and `secondary` are positions, so without a reported duration the plan decides. */
export function codexRateLimitsToWindows(
  snapshot: CodexRateLimitSnapshot,
): ReadonlyArray<ProviderUsageWindow> {
  const isMonthlyPlan = snapshot.planType === "free" || snapshot.planType === "go";
  const positions = [
    ["primary", snapshot.primary, isMonthlyPlan ? MONTH_MINS : SESSION_MINS],
    ["secondary", snapshot.secondary, WEEK_MINS],
  ] as const;
  const windows: ProviderUsageWindow[] = [];
  for (const [id, window, fallbackMins] of positions) {
    if (typeof window?.usedPercent !== "number") continue;
    const windowDurationMins = window.windowDurationMins ?? fallbackMins;
    const kind = windowKind(windowDurationMins);
    const resetsAt = isoFromEpochSeconds(window.resetsAt);
    windows.push({
      id,
      kind,
      label: kind === "session" ? "Session" : kind === "weekly" ? "Weekly" : "Monthly",
      usedPercent: clampUsagePercent(window.usedPercent),
      windowDurationMins,
      ...(resetsAt ? { resetsAt } : {}),
    });
  }
  return windows;
}

/** Prefers the `codex` bucket: the single-bucket view can name a model-specific limit. */
export function readCodexRateLimitsResponse(response: unknown): CodexRateLimitSnapshot | undefined {
  const record = asObject(response);
  const codexBucket = asObject(record?.rateLimitsByLimitId)?.codex;
  return readCodexRateLimitSnapshot(codexBucket ?? record?.rateLimits);
}

/** Undefined when the account's usage is unknown, such as when it is signed out. */
export function codexAccountUsageLimits(
  account: Pick<CodexAccountSnapshot, "type" | "rateLimits"> | undefined,
  checkedAt: string,
): ProviderUsageLimits | undefined {
  if (account === undefined) {
    return makeUnavailableUsageLimits({
      checkedAt,
      reason: "probeFailed",
      message: "Codex did not answer the usage request.",
    });
  }
  if (account.type === "apiKey") {
    return makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
  }
  const read = account.rateLimits;
  if (account.type !== "chatgpt" || read === undefined) return undefined;
  if ("failure" in read) {
    return makeUnavailableUsageLimits({
      checkedAt: read.readAt,
      reason: "probeFailed",
      message: read.failure,
    });
  }
  const snapshot = readCodexRateLimitsResponse(read.response);
  if (snapshot === undefined) {
    return makeUnavailableUsageLimits({
      checkedAt: read.readAt,
      reason: "probeFailed",
      message: "Codex reported usage in an unexpected format.",
    });
  }
  return makeUsageLimits({ checkedAt: read.readAt, windows: codexRateLimitsToWindows(snapshot) });
}

function formatWait(waitMs: number): string {
  const totalMinutes = Math.ceil(waitMs / 60_000);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return hours === 0 ? `${days}d` : `${days}d ${hours}h`;
  if (hours === 0) return `${totalMinutes}m`;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

function nextStep(rateLimitReachedType: string | null | undefined): string {
  switch (rateLimitReachedType) {
    case "workspace_owner_credits_depleted":
    case "workspace_member_credits_depleted":
      return " The workspace has no credits to continue sooner: ask your workspace owner to add credits, or send the message again once the limit resets.";
    case "workspace_owner_usage_limit_reached":
    case "workspace_member_usage_limit_reached":
      return " The workspace spend limit is reached: ask your workspace owner to raise it, or send the message again once the limit resets.";
    default:
      return " Send the message again once the limit resets.";
  }
}

/** Names the exhausted window that resets last, measured from the stopping event's timestamp. */
export function codexUsageLimitMessage(
  snapshot: CodexRateLimitSnapshot | undefined,
  atIso: string,
): string {
  const atMs = Date.parse(atIso);
  let reset = "";
  if (snapshot && Number.isFinite(atMs) && !(snapshot.limitId && snapshot.limitId !== "codex")) {
    const isMonthlyPlan = snapshot.planType === "free" || snapshot.planType === "go";
    const positions = [
      [snapshot.primary, isMonthlyPlan ? MONTH_MINS : SESSION_MINS],
      [snapshot.secondary, WEEK_MINS],
    ] as const;
    let latestResetMs = Number.NEGATIVE_INFINITY;
    for (const [window, fallbackMins] of positions) {
      if (!window || (window.usedPercent ?? 0) < 100 || !window.resetsAt) continue;
      const resetMs = window.resetsAt * 1000;
      if (resetMs <= atMs || resetMs <= latestResetMs) continue;
      latestResetMs = resetMs;
      const kind = windowKind(window.windowDurationMins ?? fallbackMins);
      reset = ` The ${kind} limit resets in ${formatWait(resetMs - atMs)}.`;
    }
  }
  return `Codex usage limit reached.${reset}${nextStep(snapshot?.rateLimitReachedType)}`;
}

function codexErrorInfoCode(info: unknown): string | undefined {
  if (typeof info === "string") return info;
  const record = asObject(info);
  return record ? Object.keys(record)[0] : undefined;
}

/** Retry exhaustion only names its cause through the last attempt's HTTP status. */
function codexExhaustionHttpStatus(info: unknown): number | undefined {
  const exhausted = asObject(asObject(info)?.responseTooManyFailedAttempts);
  return finiteNumber(exhausted?.httpStatusCode);
}

/** True for a Codex `TurnError` whose `codexErrorInfo` is a usage or rate limit, including 429 retry exhaustion. */
export function isCodexUsageLimitError(error: unknown): boolean {
  const info = asObject(error)?.codexErrorInfo;
  const code = codexErrorInfoCode(info);
  return (
    code === "usageLimitExceeded" ||
    code === "rateLimitExceeded" ||
    codexExhaustionHttpStatus(info) === 429
  );
}

function hasCodexErrorInfo(error: unknown): boolean {
  const info = asObject(error)?.codexErrorInfo;
  return info !== undefined && info !== null;
}

/** When a usage limit lifts: the last exhausted window's reset, null if any of them has none. */
export function codexUsageLimitReset(snapshot: CodexRateLimitSnapshot | undefined): {
  readonly resetAt: string | null;
  readonly limitTypes: ReadonlyArray<string>;
} {
  const reachedType = snapshot?.rateLimitReachedType?.trim();
  const limitTypes = reachedType ? [reachedType] : [];
  const exhausted = snapshot
    ? codexRateLimitsToWindows(snapshot).filter((window) => window.usedPercent >= 100)
    : [];
  let resetAt: string | null = null;
  for (const window of exhausted) {
    if (window.resetsAt === undefined) return { resetAt: null, limitTypes };
    if (resetAt === null || Date.parse(window.resetsAt) > Date.parse(resetAt)) {
      resetAt = window.resetsAt;
    }
  }
  return { resetAt, limitTypes };
}

const SESSION_RESET_METHODS = new Set(["session/connecting", "session/closed", "session/exited"]);

interface NotifiedLimit {
  readonly message: string | undefined;
  readonly conversationId: string | undefined;
}

/** Per-thread rate-limit state that rewrites usage-limit stops in mapped runtime events. */
export function makeCodexUsageLimitTracker() {
  const snapshots = new Map<string, CodexRateLimitSnapshot>();
  // Usage-limit `error` notifications per thread, so a completion that drops `codexErrorInfo` is still rewritten.
  const notifiedLimits = new Map<string, NotifiedLimit>();
  // Native Codex thread of the running main turn; subagent turn/started never reaches the adapter.
  const mainConversations = new Map<string, string>();

  const apply = (
    event: ProviderEvent,
    runtimeEvents: ReadonlyArray<ProviderRuntimeEvent>,
  ): ReadonlyArray<ProviderRuntimeEvent> => {
    const key = String(event.threadId);
    if (SESSION_RESET_METHODS.has(event.method)) {
      snapshots.delete(key);
      notifiedLimits.delete(key);
      mainConversations.delete(key);
      return runtimeEvents;
    }
    const payload = asObject(event.payload);
    const conversationId = asString(payload?.threadId);
    if (event.method === "account/rateLimits/updated") {
      const update = readCodexRateLimitSnapshot(payload);
      const merged = update ? mergeCodexRateLimits(snapshots.get(key), update) : undefined;
      if (merged) snapshots.set(key, merged);
      return runtimeEvents;
    }
    if (event.method === "turn/started") {
      if (conversationId) mainConversations.set(key, conversationId);
      return runtimeEvents;
    }
    if (event.method === "error") {
      if (payload?.willRetry === true || !isCodexUsageLimitError(payload?.error)) {
        return runtimeEvents;
      }
      // A subagent's limit error has no completion of its own to carry the rewrite, so show it as is.
      const mainConversation = mainConversations.get(key);
      if (conversationId && mainConversation && conversationId !== mainConversation) {
        return runtimeEvents;
      }
      notifiedLimits.set(key, {
        message: asString(asObject(payload?.error)?.message)?.trim(),
        conversationId,
      });
      // The failed turn/completed repeats this sentence and is rewritten below.
      return [];
    }
    if (event.method !== "turn/completed") return runtimeEvents;
    const notifiedLimit = notifiedLimits.get(key);
    notifiedLimits.delete(key);
    const notified =
      notifiedLimit !== undefined &&
      (!notifiedLimit.conversationId ||
        !conversationId ||
        notifiedLimit.conversationId === conversationId);
    const notifiedMessage = notified ? notifiedLimit.message : undefined;
    const turn = asObject(payload?.turn);
    if (turn?.status !== "failed") return runtimeEvents;
    // An explicit non-limit cause on the completion wins; a missing one is not evidence against the notification.
    const isUsageLimit =
      isCodexUsageLimitError(turn.error) || (notified && !hasCodexErrorInfo(turn.error));
    if (!isUsageLimit) return runtimeEvents;

    const message = codexUsageLimitMessage(snapshots.get(key), event.createdAt);
    const { resetAt, limitTypes } = codexUsageLimitReset(snapshots.get(key));
    const providerMessage = asString(asObject(turn.error)?.message)?.trim() || notifiedMessage;
    const errorEvent: ProviderRuntimeEvent = {
      ...runtimeEventBase(event, event.threadId),
      type: "runtime.error",
      payload: {
        message,
        class: "provider_error",
        ...(providerMessage ? { detail: providerMessage } : {}),
      },
    };
    return [
      errorEvent,
      ...runtimeEvents.map((runtimeEvent) =>
        runtimeEvent.type === "turn.completed"
          ? {
              ...runtimeEvent,
              payload: {
                ...runtimeEvent.payload,
                errorMessage: message,
                rateLimitResetAt: resetAt,
                ...(limitTypes.length > 0 ? { rateLimitTypes: limitTypes } : {}),
              },
            }
          : runtimeEvent,
      ),
    ];
  };

  return { apply };
}
