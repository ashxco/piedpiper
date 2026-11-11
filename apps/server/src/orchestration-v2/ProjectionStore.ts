import { OrchestrationV2Event, type ThreadId, type TurnId } from "@piedpiper/contracts";
import { Effect, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const decodeEvent = Schema.decodeUnknownEffect(Schema.fromJsonString(OrchestrationV2Event));
const encodeEvent = Schema.encodeSync(Schema.fromJsonString(OrchestrationV2Event));

export class V2StoreError extends Schema.TaggedErrorClass<V2StoreError>()("V2StoreError", {
  operation: Schema.String,
  cause: Schema.Defect,
}) {}

function eventEntity(event: OrchestrationV2Event) {
  switch (event.type) {
    case "run-input.updated":
      return { id: event.payload.id, runId: event.payload.id, nativeTurnRef: null };
    case "message.patched":
    case "message.updated":
      return {
        id: event.payload.message.id,
        runId: event.payload.runId,
        nativeTurnRef: event.payload.message.turnId,
      };
    case "activity.updated":
      return {
        id: event.payload.activity.id,
        runId: event.payload.runId,
        nativeTurnRef: event.payload.activity.turnId,
      };
    case "checkpoint.updated":
      return {
        id: event.payload.scopeId,
        runId: event.payload.runId,
        nativeTurnRef: event.payload.checkpoint.turnId,
      };
    case "plan.updated":
      return {
        id: event.payload.plan.id,
        runId: event.payload.runId,
        nativeTurnRef: event.payload.plan.turnId,
      };
    case "run.updated":
      return {
        id: event.payload.id,
        runId: event.payload.id,
        nativeTurnRef: event.payload.nativeTurnRef,
      };
    case "node.updated":
    case "run-attempt.updated":
      return {
        id: event.payload.id,
        runId: event.payload.runId,
        nativeTurnRef: event.payload.nativeTurnRef,
      };
    case "runtime-request.updated":
      return { id: event.payload.id, runId: event.payload.runId, nativeTurnRef: null };
    case "context-handoff.updated":
      return { id: event.payload.id, runId: event.payload.targetRunId, nativeTurnRef: null };
    case "thread.updated":
    case "provider-thread.updated":
      return { id: event.payload.id, runId: null, nativeTurnRef: null };
  }
}

/** Called inside the command transaction so event history and current entities advance together. */
export const appendV2Event = Effect.fn("orchestrationV2.append")(
  function* (event: OrchestrationV2Event) {
    const sql = yield* SqlClient.SqlClient;
    const encoded = encodeEvent(event);
    const entity = eventEntity(event);
    const rows = yield* sql<{ sequence: number }>`
    INSERT INTO orchestration_v2_events (event_id, thread_id, event_type, command_id, occurred_at, event_json)
    VALUES (${event.eventId}, ${event.threadId}, ${event.type}, ${event.commandId}, ${event.occurredAt}, ${encoded})
    ON CONFLICT (event_id) DO NOTHING RETURNING sequence
  `;
    const sequence = rows[0]?.sequence;
    if (sequence === undefined) return;
    let projectedEvent = event;
    if (event.type === "message.patched") {
      const previous = yield* readV2Entity("message.updated", entity.id);
      if (
        previous?.type !== "message.updated" ||
        previous.payload.message.text.length !== event.payload.textOffset
      ) {
        return yield* new V2StoreError({
          operation: "apply-message-patch",
          cause: "Message patch does not follow its saved text.",
        });
      }
      projectedEvent = {
        ...event,
        type: "message.updated",
        payload: {
          threadId: event.threadId,
          runId: event.payload.runId,
          message: {
            ...event.payload.message,
            text: previous.payload.message.text + event.payload.message.text,
          },
        },
      };
    }
    const projectedType = projectedEvent.type;
    const projectedJson = projectedEvent === event ? encoded : encodeEvent(projectedEvent);
    yield* sql`
    INSERT INTO orchestration_v2_entities
      (entity_type, entity_id, thread_id, run_id, native_turn_ref, sequence, event_json)
    VALUES (${projectedType}, ${entity.id}, ${event.threadId}, ${entity.runId}, ${entity.nativeTurnRef}, ${sequence}, ${projectedJson})
    ON CONFLICT (entity_type, entity_id) DO UPDATE SET
      run_id = excluded.run_id, native_turn_ref = excluded.native_turn_ref,
      sequence = excluded.sequence, event_json = excluded.event_json
  `;
  },
  Effect.mapError((cause) => new V2StoreError({ operation: "append", cause })),
);

/** Bounded, indexed reads for execution control, independent of conversation-history length. */
export const readV2Entities = Effect.fn("orchestrationV2.readEntities")(
  function* (threadId: ThreadId, type: OrchestrationV2Event["type"]) {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ event_json: string }>`
    SELECT event_json FROM orchestration_v2_entities
    WHERE thread_id = ${threadId} AND entity_type = ${type} ORDER BY sequence
  `;
    return yield* Effect.forEach(rows, (row) => decodeEvent(row.event_json));
  },
  Effect.mapError((cause) => new V2StoreError({ operation: "read", cause })),
);

export const findV2Run = Effect.fn("orchestrationV2.findRun")(
  function* (threadId: ThreadId, nativeTurnRef?: TurnId) {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ event_json: string }>`
    SELECT event_json FROM orchestration_v2_entities ${
      nativeTurnRef === undefined
        ? sql`INDEXED BY idx_orch_v2_live_runs`
        : sql`INDEXED BY idx_orch_v2_entities_native_turn`
    }
    WHERE thread_id = ${threadId} AND entity_type = 'run.updated'
      AND ${
        nativeTurnRef === undefined
          ? sql`json_extract(event_json, '$.payload.status') IN ('pending', 'running', 'waiting')`
          : sql`native_turn_ref = ${nativeTurnRef}`
      }
    ORDER BY sequence DESC LIMIT 1
  `;
    if (rows[0] === undefined) return null;
    const event = yield* decodeEvent(rows[0].event_json);
    return event.type === "run.updated" ? event.payload : null;
  },
  Effect.mapError((cause) => new V2StoreError({ operation: "find-run", cause })),
);

export const nextV2RunOrdinal = Effect.fn("orchestrationV2.nextRunOrdinal")(
  function* (threadId: ThreadId) {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      ordinal: number;
    }>`SELECT COALESCE(MAX(json_extract(event_json, '$.payload.ordinal')), 0) + 1 AS ordinal
    FROM orchestration_v2_entities INDEXED BY idx_orch_v2_runs_ordinal
    WHERE thread_id = ${threadId} AND entity_type = 'run.updated'
      AND json_extract(event_json, '$.payload.status') != 'rolled_back'`;
    return rows[0]?.ordinal ?? 1;
  },
  Effect.mapError((cause) => new V2StoreError({ operation: "next-run-ordinal", cause })),
);

export const readV2Entity = Effect.fn("orchestrationV2.readEntity")(
  function* (type: OrchestrationV2Event["type"], id: string) {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ event_json: string }>`SELECT event_json FROM orchestration_v2_entities
    WHERE entity_type = ${type} AND entity_id = ${id}`;
    return rows[0] === undefined ? null : yield* decodeEvent(rows[0].event_json);
  },
  Effect.mapError((cause) => new V2StoreError({ operation: "read-entity", cause })),
);

export const readV2RunsByStatus = Effect.fn("orchestrationV2.readRunsByStatus")(
  function* (threadId: ThreadId, statuses: ReadonlyArray<string>) {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ event_json: string }>`
    SELECT event_json FROM orchestration_v2_entities INDEXED BY idx_orch_v2_runs_status
    WHERE thread_id = ${threadId} AND entity_type = 'run.updated'
      AND json_extract(event_json, '$.payload.status') IN ${sql.in(statuses)}
    ORDER BY json_extract(event_json, '$.payload.ordinal') ASC, sequence ASC
  `;
    const events = yield* Effect.forEach(rows, (row) => decodeEvent(row.event_json));
    return events.flatMap((event) => (event.type === "run.updated" ? [event.payload] : []));
  },
  Effect.mapError((cause) => new V2StoreError({ operation: "read-runs", cause })),
);
