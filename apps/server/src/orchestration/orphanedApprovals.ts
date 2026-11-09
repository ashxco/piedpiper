/**
 * Closes approval requests whose provider process did not survive a restart. Their callback is
 * gone, so the card could only fail. Questions stay open: a restart leaves those answerable.
 */
import { CommandId, EventId, type OrchestrationThread, type ThreadId } from "@piedpiper/contracts";
import { Cause, Effect } from "effect";

import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";

type ThreadActivity = OrchestrationThread["activities"][number];

function payloadRecord(activity: ThreadActivity): Record<string, unknown> | null {
  const payload = activity.payload;
  return payload !== null && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : null;
}

function isStaleApprovalFailureDetail(detail: unknown): boolean {
  if (typeof detail !== "string") {
    return false;
  }
  const normalized = detail.toLowerCase();
  return (
    normalized.includes("stale pending approval request") ||
    normalized.includes("unknown pending approval request") ||
    normalized.includes("unknown pending permission request")
  );
}

/** Newest request row of every approval that has no resolution, matching the web's pending fold. */
export function findOpenApprovalRequests(
  activities: ReadonlyArray<ThreadActivity>,
): ReadonlyArray<{ readonly requestId: string; readonly activity: ThreadActivity }> {
  const closed = new Set<string>();
  const open = new Map<string, ThreadActivity>();
  for (const activity of activities) {
    const payload = payloadRecord(activity);
    const requestId = payload?.requestId;
    if (typeof requestId !== "string") {
      continue;
    }
    if (activity.kind === "approval.requested") {
      open.set(requestId, activity);
    } else if (
      activity.kind === "approval.resolved" ||
      (activity.kind === "provider.approval.respond.failed" &&
        isStaleApprovalFailureDetail(payload?.detail))
    ) {
      closed.add(requestId);
    }
  }
  return Array.from(open, ([requestId, activity]) => ({ requestId, activity })).filter(
    (request) => !closed.has(request.requestId),
  );
}

/**
 * Appends a cancelled `approval.resolved` for each open approval on threads with no live session.
 * Safe to repeat, since closed requests are skipped, and one failed append does not stop the rest.
 */
export const closeOrphanedApprovals = Effect.fn("closeOrphanedApprovals")(function* (input: {
  readonly threads: Iterable<OrchestrationThread>;
  readonly liveThreadIds: ReadonlySet<ThreadId>;
}) {
  const orchestrationEngine = yield* OrchestrationEngineService;
  for (const thread of input.threads) {
    if (thread.deletedAt !== null || input.liveThreadIds.has(thread.id)) {
      continue;
    }
    for (const { requestId, activity } of findOpenApprovalRequests(thread.activities)) {
      const createdAt = new Date().toISOString();
      const payload = payloadRecord(activity);
      yield* orchestrationEngine
        .dispatch({
          type: "thread.activity.append",
          commandId: CommandId.makeUnsafe(`server:orphaned-approval:${crypto.randomUUID()}`),
          threadId: thread.id,
          activity: {
            id: EventId.makeUnsafe(crypto.randomUUID()),
            createdAt,
            tone: "approval",
            kind: "approval.resolved",
            summary: "Approval cancelled by a restart",
            payload: {
              requestId,
              ...(payload?.requestKind !== undefined ? { requestKind: payload.requestKind } : {}),
              ...(payload?.requestType !== undefined ? { requestType: payload.requestType } : {}),
              decision: "cancel",
            },
            turnId: activity.turnId,
            // Rows without a sequence sort before sequenced ones, which would reopen the request.
            ...(activity.sequence !== undefined ? { sequence: activity.sequence + 1 } : {}),
          },
          createdAt,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning("failed to close orphaned approval request", {
                  threadId: thread.id,
                  requestId,
                  cause,
                }),
          ),
        );
    }
  }
});
