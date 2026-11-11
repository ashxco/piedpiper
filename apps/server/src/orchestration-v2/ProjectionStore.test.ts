import { assert, it } from "@effect/vitest";
import { EventId, MessageId, ThreadId } from "@piedpiper/contracts";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { appendV2Event, readV2Entity } from "./ProjectionStore.ts";

it.layer(SqlitePersistenceMemory)("V2 streaming persistence", (it) => {
  it.effect("uses dedicated indexes for active run and next ordinal lookups", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const live = yield* sql<{
        detail: string;
      }>`EXPLAIN QUERY PLAN SELECT event_json FROM orchestration_v2_entities INDEXED BY idx_orch_v2_live_runs
      WHERE thread_id = 'thread' AND entity_type = 'run.updated'
        AND json_extract(event_json, '$.payload.status') IN ('pending', 'running', 'waiting')
      ORDER BY sequence DESC LIMIT 1`;
      assert.ok(live.some((row) => row.detail.includes("idx_orch_v2_live_runs")));
      const ordinal = yield* sql<{
        detail: string;
      }>`EXPLAIN QUERY PLAN SELECT MAX(json_extract(event_json, '$.payload.ordinal'))
      FROM orchestration_v2_entities INDEXED BY idx_orch_v2_runs_ordinal WHERE thread_id = 'thread' AND entity_type = 'run.updated'
        AND json_extract(event_json, '$.payload.status') != 'rolled_back'`;
      assert.ok(ordinal.some((row) => row.detail.includes("idx_orch_v2_runs_ordinal")));
    }),
  );

  it.effect(
    "stores deltas with a complete read model and rejects an out-of-order patch atomically",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const threadId = ThreadId.makeUnsafe("streaming-thread");
        const message = {
          id: MessageId.makeUnsafe("streaming-message"),
          role: "assistant" as const,
          text: "",
          turnId: null,
          streaming: true,
          createdAt: "2026-11-11T00:00:00.000Z",
          updatedAt: "2026-11-11T00:00:00.000Z",
        };
        const base = { threadId, commandId: null, occurredAt: message.createdAt };
        yield* sql.withTransaction(
          appendV2Event({
            ...base,
            eventId: EventId.makeUnsafe("initial"),
            type: "message.updated",
            payload: { threadId, runId: null, message },
          }),
        );
        for (let index = 0; index < 80; index++) {
          yield* sql.withTransaction(
            appendV2Event({
              ...base,
              eventId: EventId.makeUnsafe(`patch-${index}`),
              type: "message.patched",
              payload: {
                threadId,
                runId: null,
                textOffset: index * 100,
                message: { ...message, text: "a".repeat(100), streaming: index !== 79 },
              },
            }),
          );
        }
        const saved = yield* readV2Entity("message.updated", message.id);
        assert.ok(saved?.type === "message.updated");
        assert.equal(saved.payload.message.text, "a".repeat(8000));
        assert.equal(saved.payload.message.streaming, false);
        const rows = yield* sql<{
          text_bytes: number;
        }>`SELECT SUM(length(json_extract(event_json, '$.payload.message.text'))) AS text_bytes FROM orchestration_v2_events WHERE thread_id = ${threadId}`;
        assert.equal(rows[0]?.text_bytes, 8000);
        const invalid = yield* sql
          .withTransaction(
            appendV2Event({
              ...base,
              eventId: EventId.makeUnsafe("out-of-order"),
              type: "message.patched",
              payload: {
                threadId,
                runId: null,
                textOffset: 0,
                message: { ...message, text: "invalid" },
              },
            }),
          )
          .pipe(Effect.result);
        assert.equal(invalid._tag, "Failure");
        const invalidRows =
          yield* sql`SELECT event_id FROM orchestration_v2_events WHERE event_id = 'out-of-order'`;
        assert.equal(invalidRows.length, 0);
      }),
  );
});
