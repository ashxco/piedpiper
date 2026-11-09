/**
 * Pure decision for resuming a thread once its usage limit resets. The reactor
 * owns the timers; everything that can refuse a resume is decided here.
 */
import {
  CommandId,
  MessageId,
  THREAD_USAGE_LIMIT_ACTIVITY_KIND,
  THREAD_USAGE_LIMIT_RESUME_CANCELLED_ACTIVITY_KIND,
  ThreadUsageLimitActivityPayload,
  TurnId,
  USAGE_LIMIT_RESUME_MESSAGE_ID_PREFIX,
  type OrchestrationThread,
} from "@piedpiper/contracts";
import { Schema } from "effect";

import { hasPendingProviderRequest } from "../provider/Layers/ProviderSessionReaper.ts";

/** A limit that reset longer ago than this is not worth resuming when first armed. */
export const USAGE_LIMIT_RESUME_MAX_OVERDUE_MS = 24 * 60 * 60 * 1000;

export const USAGE_LIMIT_RESUME_TEXT = "Continue where you left off.";

const decodeUsageLimitPayload = Schema.decodeUnknownOption(ThreadUsageLimitActivityPayload);

export type UsageLimitResumeThread = Pick<
  OrchestrationThread,
  "activities" | "archivedAt" | "deletedAt" | "latestTurn" | "messages" | "session"
>;

export interface LatestUsageLimit {
  readonly turnId: TurnId;
  readonly resetAt: string | null;
  readonly failedAt: string;
}

/** The newest limit a turn stopped on; a row with no turn or a bad payload cannot be resumed. */
export function readLatestUsageLimit(
  activities: UsageLimitResumeThread["activities"],
): LatestUsageLimit | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index]!;
    if (activity.kind !== THREAD_USAGE_LIMIT_ACTIVITY_KIND) continue;
    if (activity.turnId === null) return null;
    const payload = decodeUsageLimitPayload(activity.payload);
    if (payload._tag === "None") return null;
    return {
      turnId: activity.turnId,
      resetAt: payload.value.resetAt,
      failedAt: activity.createdAt,
    };
  }
  return null;
}

/** Stable across restarts, so a resend replaces its message and the engine dedupes its command. */
function usageLimitResumeMessageId(threadId: string, limit: LatestUsageLimit): MessageId {
  return MessageId.makeUnsafe(
    `${USAGE_LIMIT_RESUME_MESSAGE_ID_PREFIX}${threadId}:${limit.turnId}:${Date.parse(limit.resetAt ?? "")}`,
  );
}

export function usageLimitResumeCommandId(messageId: MessageId, attempt?: string): CommandId {
  return CommandId.makeUnsafe(attempt === undefined ? messageId : `${messageId}:${attempt}`);
}

/**
 * - `arming`: a limit was just reported or a setting flipped; overdue limits are refused.
 * - `restart`: `arming` after a server start, which also resends a resume that never started.
 *   Armed state is memory only, so downtime past the overdue window drops it, on purpose: a
 *   day-old "continue" is more likely to surprise the user than to help.
 * - `firing`: an armed limit came due; being late is no reason to refuse any more.
 */
export type UsageLimitResumePhase = "arming" | "restart" | "firing";

export type UsageLimitResumeRefusal =
  | "no-limit"
  | "disabled"
  | "archived"
  | "unknown-reset"
  | "reset-not-after-failure"
  | "cancelled"
  | "stopped"
  | "newer-turn"
  | "newer-message"
  | "already-sent"
  | "busy"
  | "pending-request"
  | "overdue";

export type UsageLimitResumeDecision =
  | { readonly action: "none"; readonly reason: UsageLimitResumeRefusal }
  | { readonly action: "wait"; readonly dueAtMs: number; readonly turnId: TurnId }
  | {
      readonly action: "send";
      readonly messageId: MessageId;
      readonly turnId: TurnId;
      /** True when this message exists already and a restart lost its turn. */
      readonly resend: boolean;
    };

/** Refusals that can clear on their own, so the thread stays armed and is decided again later. */
export const isRetriableUsageLimitRefusal = (reason: UsageLimitResumeRefusal): boolean =>
  reason === "busy" || reason === "pending-request";

const refuse = (reason: UsageLimitResumeRefusal): UsageLimitResumeDecision => ({
  action: "none",
  reason,
});

export function decideUsageLimitResume(input: {
  readonly threadId: string;
  readonly thread: UsageLimitResumeThread;
  readonly enabled: boolean;
  readonly nowMs: number;
  readonly phase: UsageLimitResumePhase;
}): UsageLimitResumeDecision {
  const { thread, nowMs, phase } = input;
  const limit = readLatestUsageLimit(thread.activities);
  if (limit === null) return refuse("no-limit");
  if (!input.enabled) return refuse("disabled");
  if (thread.archivedAt !== null || thread.deletedAt !== null) return refuse("archived");
  if (limit.resetAt === null) return refuse("unknown-reset");

  const resetMs = Date.parse(limit.resetAt);
  const failedMs = Date.parse(limit.failedAt);
  if (!Number.isFinite(resetMs) || !(resetMs > failedMs)) return refuse("reset-not-after-failure");

  const cancelled = thread.activities.some(
    (activity) =>
      activity.kind === THREAD_USAGE_LIMIT_RESUME_CANCELLED_ACTIVITY_KIND &&
      activity.turnId === limit.turnId,
  );
  if (cancelled) return refuse("cancelled");
  if (thread.latestTurn?.turnId !== limit.turnId) return refuse("newer-turn");
  if (thread.latestTurn.state === "interrupted") return refuse("stopped");

  const messageId = usageLimitResumeMessageId(input.threadId, limit);
  const newerMessage = thread.messages.some(
    (message) =>
      message.role === "user" &&
      message.id !== messageId &&
      Date.parse(message.createdAt) > failedMs,
  );
  if (newerMessage) return refuse("newer-message");

  const sent = thread.messages.find((message) => message.id === messageId);
  if (sent !== undefined) {
    const startFailed = thread.activities.some(
      (activity) =>
        activity.kind.startsWith("provider.turn.start.failed") &&
        activity.createdAt >= sent.createdAt,
    );
    if (phase !== "restart" || startFailed) return refuse("already-sent");
  }

  if (phase !== "firing" && nowMs - resetMs > USAGE_LIMIT_RESUME_MAX_OVERDUE_MS) {
    return refuse("overdue");
  }
  const status = thread.session?.status;
  // A restart can leave the lost resume's session "starting"; nothing is running it any more.
  if (status === "running" || (status === "starting" && sent === undefined)) {
    return refuse("busy");
  }
  if (hasPendingProviderRequest(thread, thread.latestTurn.requestedAt)) {
    return refuse("pending-request");
  }
  return resetMs > nowMs
    ? { action: "wait", dueAtMs: resetMs, turnId: limit.turnId }
    : { action: "send", messageId, turnId: limit.turnId, resend: sent !== undefined };
}
