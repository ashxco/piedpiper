import {
  NodeId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  type OrchestrationV2Node,
  type OrchestrationV2Run,
  type OrchestrationV2ExecutionStatus,
  type ProviderRuntimeEvent,
  type OrchestrationThread,
} from "@piedpiper/contracts";
import { Effect, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  appendV2Event,
  findV2Run,
  nextV2RunOrdinal,
  readV2Entities,
  readV2Entity,
  readV2RunsByStatus,
  V2StoreError,
} from "./ProjectionStore.ts";
import { persistV2Run, v2Event, type V2EventStamp } from "./RunState.ts";

export const ProviderEventDecision = Schema.Struct({ acceptLifecycle: Schema.Boolean });
export type ProviderEventDecision = typeof ProviderEventDecision.Type;

function executionState(state: string | undefined): OrchestrationV2ExecutionStatus {
  if (state === "completed" || state === "failed" || state === "interrupted") return state;
  if (state === "stopped" || state === "cancelled") return "interrupted";
  if (state === "error" || state === "declined") return "failed";
  return "running";
}

function nodeKind(itemType: string): OrchestrationV2Node["kind"] {
  if (itemType === "reasoning") return "reasoning";
  if (itemType === "agentMessage" || itemType === "assistant_message") return "assistant_message";
  if (itemType === "plan") return "plan";
  return "tool_call";
}

/** The caller serializes this transaction with app commands. Only a root's native turn can settle its run. */
export const ingestProviderEventV2 = Effect.fn("orchestrationV2.ingestProviderEvent")(
  function* (event: ProviderRuntimeEvent, projectedThread?: OrchestrationThread) {
    const relevant =
      event.type === "turn.started" ||
      event.type === "turn.completed" ||
      event.type === "turn.aborted" ||
      event.type === "session.exited" ||
      event.type === "session.state.changed" ||
      event.type === "item.started" ||
      event.type === "item.updated" ||
      event.type === "item.completed" ||
      event.type === "task.started" ||
      event.type === "task.progress" ||
      event.type === "task.completed" ||
      event.type === "hook.started" ||
      event.type === "hook.progress" ||
      event.type === "hook.completed" ||
      event.type === "request.opened" ||
      event.type === "request.resolved" ||
      event.type === "user-input.requested" ||
      event.type === "user-input.resolved";
    if (!relevant) return { acceptLifecycle: true };
    const sql = yield* SqlClient.SqlClient;
    const received = yield* sql<{
      decision_json: string;
    }>`SELECT decision_json FROM orchestration_v2_provider_receipts WHERE event_id = ${event.eventId}`;
    if (received[0]) return { acceptLifecycle: false };
    const stamp: V2EventStamp = {
      eventId: event.eventId,
      threadId: event.threadId,
      commandId: null,
      occurredAt: event.createdAt,
    };
    const active =
      (yield* readV2RunsByStatus(event.threadId, ["running", "waiting"])).at(-1) ?? null;
    let run = event.turnId ? yield* findV2Run(event.threadId, event.turnId) : active;
    let acceptLifecycle = true;

    if (event.type === "turn.started") {
      if (active !== null && active.nativeTurnRef !== event.turnId) {
        yield* sql`INSERT INTO orchestration_v2_provider_receipts (event_id, decision_json)
        VALUES (${event.eventId}, '{"acceptLifecycle":false}')`;
        return { acceptLifecycle: false };
      }
      if (run === null) {
        const pending = yield* readV2RunsByStatus(event.threadId, ["pending"]);
        run = pending[0] ?? null;
        if (run === null && active !== null) {
          acceptLifecycle = false;
        } else {
          if (active !== null && run !== null && active.id !== run.id) {
            yield* persistV2Run(
              { ...active, status: "interrupted", completedAt: event.createdAt },
              stamp,
            );
          }
          if (run === null) {
            const id = RunId.makeUnsafe(`run:${event.eventId}`);
            run = {
              id,
              threadId: event.threadId,
              ordinal: yield* nextV2RunOrdinal(event.threadId),
              provider: event.provider,
              providerThreadId: ProviderThreadId.makeUnsafe(
                `provider:${JSON.stringify([event.threadId, event.provider])}`,
              ),
              nativeTurnRef: null,
              userMessageId: null,
              rootNodeId: NodeId.makeUnsafe(`root:${id}`),
              activeAttemptId: RunAttemptId.makeUnsafe(`attempt:${id}:1`),
              contextHandoffId: null,
              status: "pending",
              requestedAt: event.createdAt,
              startedAt: null,
              completedAt: null,
            };
          }
        }
      }
      if (
        run !== null &&
        (run.status === "pending" || run.status === "running" || run.status === "waiting")
      ) {
        yield* persistV2Run(
          {
            ...run,
            nativeTurnRef: event.turnId ?? null,
            status: "running",
            startedAt: run.startedAt ?? event.createdAt,
          },
          stamp,
        );
      } else acceptLifecycle = false;
    } else if (event.type === "turn.completed" || event.type === "turn.aborted") {
      if (run === null && active === null && event.turnId !== undefined) {
        const pending = (yield* readV2RunsByStatus(event.threadId, ["pending"]))[0];
        if (pending) run = { ...pending, nativeTurnRef: event.turnId, status: "running" };
        else if (projectedThread?.session?.status === "starting") {
          const id = RunId.makeUnsafe(`run:${event.eventId}`);
          run = {
            id,
            threadId: event.threadId,
            ordinal: yield* nextV2RunOrdinal(event.threadId),
            provider: event.provider,
            providerThreadId: null,
            nativeTurnRef: event.turnId,
            userMessageId: null,
            rootNodeId: NodeId.makeUnsafe(`root:${id}`),
            activeAttemptId: RunAttemptId.makeUnsafe(`attempt:${id}:1`),
            contextHandoffId: null,
            status: "running",
            requestedAt: projectedThread.session.updatedAt,
            startedAt: null,
            completedAt: null,
          };
        }
      }
      acceptLifecycle =
        run !== null &&
        event.turnId !== undefined &&
        run.nativeTurnRef === event.turnId &&
        run.provider === event.provider &&
        (active === null || active.id === run.id) &&
        (run.status === "running" || run.status === "waiting");
      if (acceptLifecycle && run !== null)
        yield* persistV2Run(
          {
            ...run,
            status:
              event.type === "turn.aborted"
                ? "interrupted"
                : executionState(event.payload.state ?? "completed"),
            completedAt: event.createdAt,
          },
          stamp,
        );
    } else if (event.type === "session.exited" || event.type === "session.state.changed") {
      const stopped =
        event.type === "session.exited" ||
        event.payload.state === "stopped" ||
        event.payload.state === "error";
      if (stopped) {
        const live = yield* readV2RunsByStatus(event.threadId, ["pending", "running", "waiting"]);
        acceptLifecycle =
          live.length === 0 || live.some((entry) => entry.provider === event.provider);
        for (const entry of live) {
          if (entry.provider !== event.provider) continue;
          yield* persistV2Run(
            {
              ...entry,
              status: entry.status === "pending" ? "failed" : "interrupted",
              completedAt: event.createdAt,
            },
            stamp,
          );
        }
        yield* cancelRuntimeRequests(event.threadId, stamp);
      } else if (event.payload.state === "ready" && active !== null) {
        acceptLifecycle = false;
      }
    } else {
      yield* persistChildEvent(event, run, active, stamp);
    }
    yield* sql`INSERT INTO orchestration_v2_provider_receipts (event_id, decision_json)
    VALUES (${event.eventId}, ${JSON.stringify({ acceptLifecycle })})`;
    return { acceptLifecycle };
  },
  Effect.mapError((cause) => new V2StoreError({ operation: "ingest-provider-event", cause })),
);

const cancelRuntimeRequests = Effect.fn("orchestrationV2.cancelRuntimeRequests")(function* (
  threadId: ProviderRuntimeEvent["threadId"],
  stamp: V2EventStamp,
) {
  const requests = yield* readV2Entities(threadId, "runtime-request.updated");
  for (const event of requests) {
    if (event.type !== "runtime-request.updated" || event.payload.status !== "pending") continue;
    yield* appendV2Event(
      v2Event(stamp, "runtime-request.updated", event.payload.id, {
        ...event.payload,
        status: "cancelled",
        canRespond: false,
        resolvedAt: stamp.occurredAt,
      }),
    );
  }
});

const persistChildEvent = Effect.fn("orchestrationV2.persistChildEvent")(function* (
  event: ProviderRuntimeEvent,
  run: OrchestrationV2Run | null,
  active: OrchestrationV2Run | null,
  stamp: V2EventStamp,
) {
  let kind: OrchestrationV2Node["kind"];
  let nativeId: string;
  let status: OrchestrationV2ExecutionStatus;
  switch (event.type) {
    case "item.started":
    case "item.updated":
    case "item.completed":
      if (!event.itemId) return;
      kind = nodeKind(event.payload.itemType);
      nativeId = `item:${event.turnId ?? ""}:${event.itemId}`;
      status =
        event.type === "item.completed"
          ? executionState(event.payload.status ?? "completed")
          : "running";
      break;
    case "task.started":
    case "task.progress":
    case "task.completed":
      kind = "subagent";
      nativeId = `task:${event.payload.taskId}`;
      status = event.type === "task.completed" ? executionState(event.payload.status) : "running";
      break;
    case "hook.started":
    case "hook.progress":
    case "hook.completed":
      kind = "hook";
      nativeId = `hook:${event.payload.hookId}`;
      status =
        event.type === "hook.completed"
          ? executionState(
              event.payload.outcome === "success" ? "completed" : event.payload.outcome,
            )
          : "running";
      break;
    case "request.opened":
    case "request.resolved":
    case "user-input.requested":
    case "user-input.resolved":
      if (!event.requestId) return;
      kind = event.type.startsWith("user-input.") ? "user_input_request" : "approval_request";
      nativeId = `request:${event.requestId}`;
      status = event.type.endsWith("resolved") ? "completed" : "waiting";
      break;
    default:
      return;
  }
  const id = NodeId.makeUnsafe(`node:${JSON.stringify([event.threadId, nativeId])}`);
  const existing = yield* readV2Entity("node.updated", id);
  let previous = existing?.type === "node.updated" ? existing.payload : null;
  if (event.type.endsWith(".started") && previous?.completedAt != null) previous = null;
  const owner = run ?? active;
  const terminal = status === "completed" || status === "failed" || status === "interrupted";
  const node: OrchestrationV2Node = {
    id,
    threadId: event.threadId,
    runId: previous?.runId ?? owner?.id ?? null,
    parentNodeId: previous?.parentNodeId ?? owner?.rootNodeId ?? null,
    rootNodeId: previous?.rootNodeId ?? owner?.rootNodeId ?? id,
    kind,
    status,
    countsForRun: false,
    providerThreadId: previous?.providerThreadId ?? owner?.providerThreadId ?? null,
    nativeTurnRef: previous?.nativeTurnRef ?? event.turnId ?? null,
    nativeItemRef: nativeId,
    checkpointScopeId: null,
    startedAt: previous?.startedAt ?? event.createdAt,
    completedAt: terminal ? event.createdAt : null,
  };
  // A delayed progress frame cannot reopen a child that already finished.
  if (previous?.completedAt !== null && previous?.completedAt !== undefined && !terminal) return;
  yield* appendV2Event(v2Event(stamp, "node.updated", id, node));
  if (kind === "approval_request" || kind === "user_input_request") {
    const requestId = RuntimeRequestId.makeUnsafe(
      `request:${JSON.stringify([event.threadId, event.requestId])}`,
    );
    const old = yield* readV2Entity("runtime-request.updated", requestId);
    yield* appendV2Event(
      v2Event(stamp, "runtime-request.updated", requestId, {
        id: requestId,
        threadId: event.threadId,
        runId: node.runId,
        nodeId: id,
        providerThreadId: node.providerThreadId,
        nativeRequestRef: event.requestId!,
        kind: kind === "approval_request" ? "approval" : "user_input",
        status: terminal ? "resolved" : "pending",
        canRespond: !terminal,
        payload: event.payload,
        createdAt:
          old?.type === "runtime-request.updated" ? old.payload.createdAt : event.createdAt,
        resolvedAt: terminal ? event.createdAt : null,
      }),
    );
  }
});
