import {
  EventId,
  CheckpointScopeId,
  NodeId,
  ProviderThreadId,
  RunId,
  RunAttemptId,
  type OrchestrationEvent,
  type OrchestrationThread,
  type OrchestrationV2Event,
  type OrchestrationV2Run,
} from "@piedpiper/contracts";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { persistV2Run } from "./RunState.ts";
import { appendV2Event, findV2Run, nextV2RunOrdinal, readV2Entities } from "./ProjectionStore.ts";

/** Keeps the established UI event protocol at the edge of the V2 execution model. */
export const recordV2Transition = Effect.fn("orchestrationV2.recordTransition")(function* (
  event: OrchestrationEvent,
  before: OrchestrationThread | undefined,
  after: OrchestrationThread | undefined,
) {
  const thread =
    after ??
    (event.type === "thread.deleted" && before
      ? { ...before, deletedAt: event.occurredAt }
      : undefined);
  if (!thread || event.aggregateKind !== "thread") return;
  const threadId = thread.id;
  const emit = <E extends OrchestrationV2Event>(
    type: E["type"],
    id: string,
    payload: E["payload"],
  ) =>
    appendV2Event({
      eventId: EventId.makeUnsafe(`${event.eventId}:${type}:${id}`),
      threadId,
      commandId: event.commandId,
      occurredAt: event.occurredAt,
      type,
      payload,
    } as OrchestrationV2Event);
  const providers = yield* readV2Entities(threadId, "provider-thread.updated");
  const existingProvider = providers.find(
    (entry) =>
      entry.type === "provider-thread.updated" &&
      entry.payload.provider === thread.modelSelection.provider,
  );
  const providerThreadId =
    existingProvider?.type === "provider-thread.updated"
      ? existingProvider.payload.id
      : ProviderThreadId.makeUnsafe(
          `provider:${JSON.stringify([threadId, thread.modelSelection.provider])}`,
        );

  const saveRun = (run: OrchestrationV2Run) =>
    persistV2Run(run, {
      eventId: event.eventId,
      threadId,
      commandId: event.commandId,
      occurredAt: event.occurredAt,
    });

  switch (event.type) {
    case "thread.turn-start-requested": {
      const id = RunId.makeUnsafe(`run:${event.eventId}`);
      const run: OrchestrationV2Run = {
        id,
        threadId,
        ordinal: yield* nextV2RunOrdinal(threadId),
        provider: event.payload.modelSelection?.provider ?? thread.modelSelection.provider,
        providerThreadId,
        nativeTurnRef: null,
        userMessageId: event.payload.messageId,
        rootNodeId: NodeId.makeUnsafe(`root:${id}`),
        activeAttemptId: RunAttemptId.makeUnsafe(`attempt:${id}:1`),
        contextHandoffId: null,
        status: "pending",
        requestedAt: event.payload.createdAt,
        startedAt: null,
        completedAt: null,
      };
      yield* saveRun(run);
      yield* emit("run-input.updated", run.id, { id: run.id, request: event.payload });
      const message = thread.messages.find((item) => item.id === run.userMessageId);
      if (message) yield* emit("message.updated", message.id, { threadId, runId: id, message });
      return;
    }
    case "thread.session-set": {
      const session = event.payload.session;
      const previousProvider =
        existingProvider?.type === "provider-thread.updated" ? existingProvider.payload : null;
      yield* emit("provider-thread.updated", providerThreadId, {
        id: providerThreadId,
        threadId,
        provider: thread.modelSelection.provider,
        nativeThreadRef: previousProvider?.nativeThreadRef ?? null,
        resumeCursor: previousProvider?.resumeCursor ?? null,
        status:
          session.status === "running"
            ? "active"
            : session.status === "error"
              ? "error"
              : session.status === "stopped"
                ? "closed"
                : "idle",
        firstRunOrdinal: previousProvider?.firstRunOrdinal ?? null,
        lastRunOrdinal: previousProvider?.lastRunOrdinal ?? null,
        createdAt: previousProvider?.createdAt ?? event.occurredAt,
        updatedAt: event.occurredAt,
      });
      if (session.activeTurnId !== null && session.status === "running") {
        let run =
          (yield* findV2Run(threadId, session.activeTurnId)) ?? (yield* findV2Run(threadId));
        if (run === null) {
          const id = RunId.makeUnsafe(
            `session-run:${JSON.stringify([threadId, session.activeTurnId])}`,
          );
          run = {
            id,
            threadId,
            ordinal: yield* nextV2RunOrdinal(threadId),
            provider: thread.modelSelection.provider,
            providerThreadId,
            nativeTurnRef: session.activeTurnId,
            userMessageId: null,
            rootNodeId: NodeId.makeUnsafe(`root:${id}`),
            activeAttemptId: RunAttemptId.makeUnsafe(`attempt:${id}:1`),
            contextHandoffId: null,
            status: "pending",
            requestedAt: session.updatedAt,
            startedAt: null,
            completedAt: null,
          };
        }
        if (
          run &&
          (run.status === "pending" || run.status === "running" || run.status === "waiting")
        ) {
          yield* saveRun({
            ...run,
            nativeTurnRef: session.activeTurnId,
            status: "running",
            startedAt: run.startedAt ?? session.updatedAt,
          });
        }
      } else if (
        session.status === "stopped" ||
        event.payload.failedTurnStartMessageId !== undefined
      ) {
        const nativeTurn = before?.session?.activeTurnId ?? thread.latestTurn?.turnId;
        const run = nativeTurn
          ? ((yield* findV2Run(threadId, nativeTurn)) ?? (yield* findV2Run(threadId)))
          : yield* findV2Run(threadId);
        if (
          run &&
          (run.status === "running" || run.status === "pending" || run.status === "waiting")
        ) {
          // Runtime error notifications can precede the root terminal event.
          // Only explicit stop or a failed start can settle execution at this boundary.
          yield* saveRun({
            ...run,
            status: session.status === "stopped" ? "interrupted" : "failed",
            completedAt: session.updatedAt,
          });
        }
      }
      break;
    }
    case "thread.message-sent": {
      const message = thread.messages.find((item) => item.id === event.payload.messageId);
      if (!message) return;
      const run = message.turnId === null ? null : yield* findV2Run(threadId, message.turnId);
      const previous = before?.messages.find((item) => item.id === message.id);
      if (previous && message.text.startsWith(previous.text)) {
        yield* emit("message.patched", message.id, {
          threadId,
          runId: run?.id ?? null,
          message: { ...message, text: message.text.slice(previous.text.length) },
          textOffset: previous.text.length,
        });
      } else {
        yield* emit("message.updated", message.id, { threadId, runId: run?.id ?? null, message });
      }
      return;
    }
    case "thread.activity-appended": {
      const activity = event.payload.activity;
      const run = activity.turnId === null ? null : yield* findV2Run(threadId, activity.turnId);
      yield* emit("activity.updated", activity.id, { threadId, runId: run?.id ?? null, activity });
      return;
    }
    case "thread.proposed-plan-upserted": {
      const plan = event.payload.proposedPlan;
      const run = plan.turnId === null ? null : yield* findV2Run(threadId, plan.turnId);
      yield* emit("plan.updated", plan.id, { threadId, runId: run?.id ?? null, plan });
      return;
    }
    case "thread.turn-diff-completed": {
      const run = yield* findV2Run(threadId, event.payload.turnId);
      if (run)
        yield* emit("checkpoint.updated", `checkpoint:${run.id}`, {
          threadId,
          runId: run.id,
          scopeId: CheckpointScopeId.makeUnsafe(`checkpoint:${run.id}`),
          checkpoint: event.payload,
        });
      return;
    }
    case "thread.reverted": {
      const runs = yield* readV2Entities(threadId, "run.updated");
      for (const entry of runs) {
        if (entry.type === "run.updated" && entry.payload.ordinal > event.payload.turnCount) {
          yield* saveRun({ ...entry.payload, status: "rolled_back" });
        }
      }
      break;
    }
    case "thread.created": {
      const sql = yield* SqlClient.SqlClient;
      // A native thread must never be imported from its UI projection on the next boot.
      yield* sql`INSERT INTO orchestration_v2_legacy_imports
        (thread_id, source, imported_at, source_message_count, source_activity_count, source_turn_count)
        VALUES (${threadId}, 'native', ${event.occurredAt}, 0, 0, 0)
        ON CONFLICT (thread_id) DO NOTHING`;
      break;
    }
    case "thread.meta-updated":
    case "thread.runtime-mode-set":
    case "thread.interaction-mode-set":
    case "thread.archived":
    case "thread.unarchived":
    case "thread.deleted":
      break;
    default:
      return;
  }
  yield* emit("thread.updated", threadId, {
    id: threadId,
    projectId: thread.projectId,
    title: thread.title,
    modelSelection: thread.modelSelection,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    systemPrompt: thread.systemPrompt ?? null,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    activeProviderThreadId: providerThreadId,
    parentThreadId: null,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    archivedAt: thread.archivedAt,
    deletedAt: thread.deletedAt,
  });
});
