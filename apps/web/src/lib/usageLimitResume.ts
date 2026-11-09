import {
  THREAD_USAGE_LIMIT_ACTIVITY_KIND,
  THREAD_USAGE_LIMIT_RESUME_CANCELLED_ACTIVITY_KIND,
  USAGE_LIMIT_RESUME_MESSAGE_ID_PREFIX,
  type OrchestrationThreadActivity,
  type TurnId,
} from "@piedpiper/contracts";

import {
  derivePendingApprovals,
  derivePendingUserInputs,
  isBlockingPendingUserInput,
} from "../session-logic";
import type { Thread } from "../types";

export type UsageLimitResumeThread = Pick<
  Thread,
  "activities" | "archivedAt" | "latestTurn" | "messages" | "session"
>;

export interface ArmedUsageLimitResume {
  readonly turnId: TurnId;
  readonly resetAt: string;
}

function readResetAt(activity: OrchestrationThreadActivity): string | null {
  const payload = activity.payload;
  if (payload === null || typeof payload !== "object") return null;
  const resetAt = (payload as { resetAt?: unknown }).resetAt;
  return typeof resetAt === "string" ? resetAt : null;
}

/** True for a message Pied Piper sent itself to resume a thread after its usage limit reset. */
export function isUsageLimitResumeMessageId(messageId: string): boolean {
  return messageId.startsWith(USAGE_LIMIT_RESUME_MESSAGE_ID_PREFIX);
}

/**
 * The resume this thread is waiting for; mirrors the server's decision for a reset still to come.
 * Null once it is due: the server sends within a tick, and a held message should not wait on it.
 */
export function deriveArmedUsageLimitResume(
  thread: UsageLimitResumeThread,
  enabled: boolean,
  nowMs: number,
): ArmedUsageLimitResume | null {
  if (!enabled || thread.archivedAt !== null) return null;
  const limit = thread.activities.findLast(
    (activity) => activity.kind === THREAD_USAGE_LIMIT_ACTIVITY_KIND,
  );
  if (limit === undefined || limit.turnId === null) return null;

  const resetAt = readResetAt(limit);
  const resetMs = resetAt === null ? Number.NaN : Date.parse(resetAt);
  const failedMs = Date.parse(limit.createdAt);
  if (resetAt === null || !(resetMs > nowMs) || !(resetMs > failedMs)) return null;

  const { turnId } = limit;
  if (thread.latestTurn?.turnId !== turnId || thread.latestTurn.state === "interrupted") {
    return null;
  }
  const cancelled = thread.activities.some(
    (activity) =>
      activity.kind === THREAD_USAGE_LIMIT_RESUME_CANCELLED_ACTIVITY_KIND &&
      activity.turnId === turnId,
  );
  if (cancelled) return null;

  const newerMessage = thread.messages.some(
    (message) => message.role === "user" && Date.parse(message.createdAt) > failedMs,
  );
  if (newerMessage) return null;

  const status = thread.session?.orchestrationStatus;
  if (status === "running" || status === "starting") return null;
  if (
    derivePendingApprovals(thread.activities).length > 0 ||
    derivePendingUserInputs(thread.activities).some(isBlockingPendingUserInput)
  ) {
    return null;
  }
  return { turnId, resetAt };
}
