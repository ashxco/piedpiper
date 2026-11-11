import {
  CheckpointScopeId,
  EventId,
  type OrchestrationV2Event,
  type OrchestrationV2Run,
} from "@piedpiper/contracts";
import { Effect } from "effect";

import { appendV2Event } from "./ProjectionStore.ts";

export type V2EventStamp = Pick<
  OrchestrationV2Event,
  "eventId" | "threadId" | "commandId" | "occurredAt"
>;

export function v2Event<T extends OrchestrationV2Event["type"]>(
  stamp: V2EventStamp,
  type: T,
  id: string,
  payload: Extract<OrchestrationV2Event, { type: T }>["payload"],
): Extract<OrchestrationV2Event, { type: T }> {
  return {
    ...stamp,
    eventId: EventId.makeUnsafe(`${stamp.eventId}:${type}:${id}`),
    type,
    payload,
  } as Extract<OrchestrationV2Event, { type: T }>;
}

export const persistV2Run = Effect.fn("orchestrationV2.persistRun")(function* (
  run: OrchestrationV2Run,
  stamp: V2EventStamp,
) {
  yield* appendV2Event(v2Event(stamp, "run.updated", run.id, run));
  yield* appendV2Event(
    v2Event(stamp, "node.updated", run.rootNodeId, {
      id: run.rootNodeId,
      threadId: run.threadId,
      runId: run.id,
      parentNodeId: null,
      rootNodeId: run.rootNodeId,
      kind: "root_turn",
      status: run.status,
      countsForRun: true,
      providerThreadId: run.providerThreadId,
      nativeTurnRef: run.nativeTurnRef,
      nativeItemRef: null,
      checkpointScopeId: CheckpointScopeId.makeUnsafe(`checkpoint:${run.id}`),
      startedAt: run.startedAt,
      completedAt: run.completedAt,
    }),
  );
  if (run.activeAttemptId !== null) {
    yield* appendV2Event(
      v2Event(stamp, "run-attempt.updated", run.activeAttemptId, {
        id: run.activeAttemptId,
        threadId: run.threadId,
        runId: run.id,
        ordinal: 1,
        rootNodeId: run.rootNodeId,
        providerThreadId: run.providerThreadId,
        nativeTurnRef: run.nativeTurnRef,
        reason: "initial",
        status: run.status,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
      }),
    );
  }
});
