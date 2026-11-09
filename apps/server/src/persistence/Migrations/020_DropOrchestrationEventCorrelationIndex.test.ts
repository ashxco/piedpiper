import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("020_DropOrchestrationEventCorrelationIndex", (it) => {
  it.effect("drops the unused correlation_id index and keeps the column values", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 19 });

      const before = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND name = 'idx_orch_events_correlation_id'
      `;
      assert.strictEqual(before.length, 1);

      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, command_id, causation_event_id, correlation_id,
          actor_kind, payload_json, metadata_json
        ) VALUES (
          'event-1', 'thread', 'thread-1', 0, 'thread.created',
          '2026-01-01T00:00:00.000Z', 'command-1', NULL, 'correlation-1',
          'client', '{}', '{}'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 20 });

      const after = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND name = 'idx_orch_events_correlation_id'
      `;
      assert.deepStrictEqual(after, []);

      const rows = yield* sql<{ readonly correlationId: string | null }>`
        SELECT correlation_id AS "correlationId" FROM orchestration_events
      `;
      assert.deepStrictEqual(
        rows.map((row) => row.correlationId),
        ["correlation-1"],
      );
    }),
  );
});
