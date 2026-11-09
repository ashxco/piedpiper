import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { migrationEntries, runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import Migration0024 from "./024_OrchestrationEventMaintenance.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("024_OrchestrationEventMaintenance", (it) => {
  it.effect("creates one seeded row, and a second run keeps its state", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 24 });

      const readRows = sql<{
        readonly id: number;
        readonly prunedThroughSequence: number;
        readonly pendingPruneThroughSequence: number | null;
        readonly pendingPruneMarkedAt: string | null;
        readonly lastCompletedAt: string | null;
      }>`
        SELECT
          id,
          pruned_through_sequence AS "prunedThroughSequence",
          pending_prune_through_sequence AS "pendingPruneThroughSequence",
          pending_prune_marked_at AS "pendingPruneMarkedAt",
          last_completed_at AS "lastCompletedAt"
        FROM orchestration_event_maintenance
      `;
      assert.deepStrictEqual(
        (yield* readRows).map((row) => [
          row.id,
          row.prunedThroughSequence,
          row.pendingPruneThroughSequence,
          row.pendingPruneMarkedAt,
          row.lastCompletedAt,
        ]),
        [[1, 0, null, null, null]],
      );

      yield* sql`
        UPDATE orchestration_event_maintenance
        SET pruned_through_sequence = 42, last_completed_at = '2026-01-01T00:00:00.000Z'
      `;
      yield* Migration0024;

      const rows = yield* readRows;
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0]?.prunedThroughSequence, 42);
      assert.strictEqual(rows[0]?.lastCompletedAt, "2026-01-01T00:00:00.000Z");

      const secondRow = yield* sql`
        INSERT INTO orchestration_event_maintenance (id) VALUES (2)
      `.pipe(Effect.exit);
      assert.strictEqual(secondRow._tag, "Failure");
    }),
  );

  it("numbers migrations sequentially with no gaps", () => {
    assert.deepStrictEqual(
      migrationEntries.map(([id]) => id),
      migrationEntries.map((_, index) => index + 1),
    );
  });
});
