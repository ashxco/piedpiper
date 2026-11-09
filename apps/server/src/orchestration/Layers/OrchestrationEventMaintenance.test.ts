import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  SqlitePersistenceMemory,
  makeSqlitePersistenceLive,
} from "../../persistence/Layers/Sqlite.ts";
import {
  ensureReplayableFrom,
  isPrunedReplayError,
  makeOrchestrationEventMaintenance,
  nextPassDelayMillis,
  readPrunedThroughSequence,
} from "./OrchestrationEventMaintenance.ts";
import { ORCHESTRATION_PROJECTOR_NAMES } from "./ProjectionPipeline.ts";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const START_MS = Date.parse("2026-01-01T00:00:00.000Z");

const appendEvents = (
  sql: SqlClient.SqlClient,
  streamId: string,
  count: number,
  payloadJson = "{}",
) =>
  Effect.gen(function* () {
    for (let index = 0; index < count; index += 1) {
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
        )
        VALUES (
          ${crypto.randomUUID()}, 'thread', ${streamId},
          COALESCE(
            (SELECT MAX(stream_version) + 1 FROM orchestration_events
             WHERE aggregate_kind = 'thread' AND stream_id = ${streamId}),
            0
          ),
          'thread.meta-updated', '2026-01-01T00:00:00.000Z', NULL, NULL, NULL, 'server', ${payloadJson}, '{}'
        )
      `;
    }
  });

const setAllCursors = (sql: SqlClient.SqlClient, sequence: number) =>
  Effect.forEach(
    Object.values(ORCHESTRATION_PROJECTOR_NAMES),
    (projector) => sql`
      INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
      VALUES (${projector}, ${sequence}, '2026-01-01T00:00:00.000Z')
      ON CONFLICT (projector) DO UPDATE SET last_applied_sequence = excluded.last_applied_sequence
    `,
    { discard: true },
  );

const remainingSequences = (sql: SqlClient.SqlClient) =>
  sql<{ readonly sequence: number }>`
    SELECT sequence FROM orchestration_events ORDER BY sequence
  `.pipe(Effect.map((rows) => rows.map((row) => row.sequence)));

const noRest = { restAfterPage: () => Effect.void };

const setup = Effect.gen(function* () {
  yield* TestClock.setTime(START_MS);
  const sql = yield* SqlClient.SqlClient;
  const maintenance = yield* makeOrchestrationEventMaintenance;
  return { sql, maintenance };
});

const withDatabase = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(SqlitePersistenceMemory));

it.effect("only marks on the first pass, and deletes once the mark is a day old", () =>
  withDatabase(
    Effect.gen(function* () {
      const { sql, maintenance } = yield* setup;
      yield* appendEvents(sql, "thread-1", 5);
      yield* setAllCursors(sql, 5);

      assert.equal((yield* maintenance.runPass(noRest)).deletedEventCount, 0);
      assert.lengthOf(yield* remainingSequences(sql), 5);

      // Events after the mark are newer than the mark, so they must outlive this prune.
      yield* appendEvents(sql, "thread-1", 2);
      yield* setAllCursors(sql, 7);

      yield* TestClock.adjust(DAY_MS - 1);
      assert.equal((yield* maintenance.runPass(noRest)).deletedEventCount, 0);
      assert.equal(yield* readPrunedThroughSequence(sql), 0);

      yield* TestClock.adjust(1);
      assert.equal((yield* maintenance.runPass(noRest)).deletedEventCount, 5);
      assert.equal(yield* readPrunedThroughSequence(sql), 5);
      assert.deepEqual(yield* remainingSequences(sql), [6, 7]);
    }),
  ),
);

it.effect("does not push the mark forward until it has been used", () =>
  withDatabase(
    Effect.gen(function* () {
      const { sql, maintenance } = yield* setup;
      yield* appendEvents(sql, "thread-1", 3);
      yield* maintenance.runPass(noRest);
      yield* appendEvents(sql, "thread-1", 3);
      yield* TestClock.adjust(6 * HOUR_MS);
      yield* maintenance.runPass(noRest);

      const rows = yield* sql<{
        readonly mark: number;
        readonly markedAt: string;
        readonly lastCompletedAt: string;
      }>`
        SELECT
          pending_prune_through_sequence AS mark,
          pending_prune_marked_at AS "markedAt",
          last_completed_at AS "lastCompletedAt"
        FROM orchestration_event_maintenance
      `;
      assert.equal(rows[0]?.mark, 3);
      assert.equal(rows[0]?.markedAt, new Date(START_MS).toISOString());
      assert.equal(rows[0]?.lastCompletedAt, new Date(START_MS + 6 * HOUR_MS).toISOString());
    }),
  ),
);

it.effect("stops at the lowest projector cursor, and a missing projector counts as zero", () =>
  withDatabase(
    Effect.gen(function* () {
      const { sql, maintenance } = yield* setup;
      yield* appendEvents(sql, "thread-1", 6);
      yield* setAllCursors(sql, 6);
      yield* sql`
        UPDATE projection_state SET last_applied_sequence = 2
        WHERE projector = ${ORCHESTRATION_PROJECTOR_NAMES.pendingApprovals}
      `;
      yield* maintenance.runPass(noRest);
      yield* TestClock.adjust(DAY_MS);
      assert.equal((yield* maintenance.runPass(noRest)).deletedEventCount, 2);
      assert.equal(yield* readPrunedThroughSequence(sql), 2);
      assert.deepEqual(yield* remainingSequences(sql), [3, 4, 5, 6]);

      yield* sql`
        DELETE FROM projection_state WHERE projector = ${ORCHESTRATION_PROJECTOR_NAMES.threads}
      `;
      yield* TestClock.adjust(DAY_MS);
      assert.equal((yield* maintenance.runPass(noRest)).deletedEventCount, 0);
      assert.equal(yield* readPrunedThroughSequence(sql), 2);
    }),
  ),
);

it.effect("keeps each stream's newest row, so appends continue its version", () =>
  withDatabase(
    Effect.gen(function* () {
      const { sql, maintenance } = yield* setup;
      yield* appendEvents(sql, "thread-idle", 2);
      yield* appendEvents(sql, "thread-busy", 3);
      yield* setAllCursors(sql, 5);
      yield* maintenance.runPass(noRest);
      yield* TestClock.adjust(DAY_MS);
      assert.equal((yield* maintenance.runPass(noRest)).deletedEventCount, 3);
      assert.deepEqual(yield* remainingSequences(sql), [2, 5]);

      yield* appendEvents(sql, "thread-idle", 1);
      const versions = yield* sql<{ readonly version: number }>`
        SELECT MAX(stream_version) AS version FROM orchestration_events
        WHERE stream_id = 'thread-idle'
      `;
      assert.equal(versions[0]?.version, 2);
    }),
  ),
);

it.effect("keeps command receipts", () =>
  withDatabase(
    Effect.gen(function* () {
      const { sql, maintenance } = yield* setup;
      yield* appendEvents(sql, "thread-1", 3);
      yield* setAllCursors(sql, 3);
      yield* sql`
        INSERT INTO orchestration_command_receipts (
          command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status, error
        )
        VALUES ('cmd-1', 'thread', 'thread-1', '2026-01-01T00:00:00.000Z', 1, 'accepted', NULL)
      `;
      yield* maintenance.runPass(noRest);
      yield* TestClock.adjust(DAY_MS);
      assert.equal((yield* maintenance.runPass(noRest)).deletedEventCount, 2);
      const receipts = yield* sql`SELECT command_id FROM orchestration_command_receipts`;
      assert.lengthOf(receipts, 1);
    }),
  ),
);

it.effect("works in small pages, resting after each, across more than one page", () =>
  withDatabase(
    Effect.gen(function* () {
      const { sql, maintenance } = yield* setup;
      yield* appendEvents(sql, "thread-1", 120);
      yield* setAllCursors(sql, 120);
      yield* maintenance.runPass(noRest);
      yield* TestClock.adjust(DAY_MS);
      const remainingAtRest: Array<number> = [];
      const { deletedEventCount } = yield* maintenance.runPass({
        restAfterPage: () =>
          remainingSequences(sql).pipe(
            Effect.map((rows) => {
              remainingAtRest.push(rows.length);
            }),
            Effect.orDie,
          ),
      });
      // The newest row of the only stream stays.
      assert.equal(deletedEventCount, 119);
      assert.deepEqual(remainingAtRest, [70, 20, 1]);
    }),
  ),
);

it.effect("writes the boundary before deleting, and a new instance finishes a cut-short pass", () =>
  withDatabase(
    Effect.gen(function* () {
      const { sql, maintenance } = yield* setup;
      yield* appendEvents(sql, "thread-1", 120);
      yield* setAllCursors(sql, 120);
      yield* maintenance.runPass(noRest);
      yield* TestClock.adjust(DAY_MS);

      const boundariesAtRest: Array<number> = [];
      const cutShort = yield* maintenance
        .runPass({
          restAfterPage: () =>
            readPrunedThroughSequence(sql).pipe(
              Effect.tap((boundary) => Effect.sync(() => boundariesAtRest.push(boundary))),
              Effect.andThen(Effect.die("restart")),
              Effect.orDie,
            ),
        })
        .pipe(Effect.exit);
      assert.equal(cutShort._tag, "Failure");
      assert.deepEqual(boundariesAtRest, [120]);
      assert.lengthOf(yield* remainingSequences(sql), 70);

      const rebooted = yield* makeOrchestrationEventMaintenance;
      assert.equal((yield* rebooted.runPass(noRest)).deletedEventCount, 69);
      assert.equal(yield* readPrunedThroughSequence(sql), 120);
      assert.deepEqual(yield* remainingSequences(sql), [120]);
    }),
  ),
);

it.effect("never moves the boundary back", () =>
  withDatabase(
    Effect.gen(function* () {
      const { sql, maintenance } = yield* setup;
      yield* appendEvents(sql, "thread-1", 6);
      yield* setAllCursors(sql, 6);
      yield* maintenance.runPass(noRest);
      yield* TestClock.adjust(DAY_MS);
      yield* maintenance.runPass(noRest);
      assert.equal(yield* readPrunedThroughSequence(sql), 6);

      yield* setAllCursors(sql, 1);
      yield* TestClock.adjust(DAY_MS);
      yield* maintenance.runPass(noRest);
      assert.equal(yield* readPrunedThroughSequence(sql), 6);
    }),
  ),
);

it.effect("refuses a replay from below the boundary and allows one from it", () =>
  withDatabase(
    Effect.gen(function* () {
      const { sql, maintenance } = yield* setup;
      yield* appendEvents(sql, "thread-1", 4);
      yield* setAllCursors(sql, 4);
      yield* maintenance.runPass(noRest);
      yield* appendEvents(sql, "thread-1", 1);
      yield* setAllCursors(sql, 5);
      yield* TestClock.adjust(DAY_MS);
      yield* maintenance.runPass(noRest);

      const belowBoundary = yield* Effect.flip(ensureReplayableFrom(sql, 3));
      assert.equal(belowBoundary._tag, "PersistenceSqlError");
      assert.include(belowBoundary.message, "through sequence 4");
      assert.isTrue(isPrunedReplayError(belowBoundary));
      assert.isFalse(isPrunedReplayError(new Error("other")));
      yield* ensureReplayableFrom(sql, 4);
      yield* ensureReplayableFrom(sql, 5);
    }),
  ),
);

const withDatabaseFile = <A, E>(
  effect: (seededPath: string) => Effect.Effect<A, E, SqlClient.SqlClient>,
  seed?: (path: string) => void,
) => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "piedpiper-event-reclaim-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");
  seed?.(dbPath);
  return effect(dbPath).pipe(
    Effect.provide(makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer))),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
};

const readPageCounts = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const free = yield* sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`;
    const total = yield* sql<{ readonly page_count: number }>`PRAGMA page_count`;
    return { free: free[0]?.freelist_count ?? 0, total: total[0]?.page_count ?? 0 };
  });

const pruneLargeEvents = (
  sql: SqlClient.SqlClient,
  maintenance: Effect.Success<typeof makeOrchestrationEventMaintenance>,
) =>
  Effect.gen(function* () {
    yield* appendEvents(sql, "thread-1", 400, JSON.stringify({ padding: "x".repeat(8000) }));
    yield* setAllCursors(sql, 400);
    yield* maintenance.runPass(noRest);
    const before = yield* readPageCounts(sql);
    yield* TestClock.adjust(DAY_MS);
    assert.equal((yield* maintenance.runPass(noRest)).deletedEventCount, 399);
    return { before, after: yield* readPageCounts(sql) };
  });

it.effect("gives every freed page back on a file created with auto_vacuum", () =>
  withDatabaseFile(() =>
    Effect.gen(function* () {
      const { sql, maintenance } = yield* setup;
      const { before, after } = yield* pruneLargeEvents(sql, maintenance);
      assert.equal(after.free, 0);
      assert.isBelow(after.total, before.total - 400);
    }),
  ),
);

it.effect("rests between batches while it reclaims pages", () =>
  withDatabaseFile(() =>
    Effect.gen(function* () {
      const { sql, maintenance } = yield* setup;
      yield* appendEvents(sql, "thread-1", 400, JSON.stringify({ padding: "x".repeat(8000) }));
      yield* setAllCursors(sql, 400);
      yield* maintenance.runPass(noRest);
      yield* TestClock.adjust(DAY_MS);
      let rests = 0;
      yield* maintenance.runPass({
        restAfterPage: () =>
          Effect.sync(() => {
            rests += 1;
          }),
      });
      // Eight delete pages, then at least one rest for each 50 of the 800+ freed pages.
      assert.isAtLeast(rests, 8 + 16);
    }),
  ),
);

it.effect("leaves the free pages of a file without auto_vacuum for reuse", () =>
  withDatabaseFile(
    () =>
      Effect.gen(function* () {
        const { sql, maintenance } = yield* setup;
        const { after } = yield* pruneLargeEvents(sql, maintenance);
        assert.isAbove(after.free, 400);
      }),
    (path) => {
      const seeded = new NodeSqlite.DatabaseSync(path);
      seeded.exec("CREATE TABLE existing_rows(value TEXT)");
      seeded.close();
    },
  ),
);

it("keeps the 6 hour cadence across restarts without running during startup", () => {
  assert.equal(nextPassDelayMillis(null, START_MS), 5 * 60 * 1000);
  assert.equal(nextPassDelayMillis("not a date", START_MS), 5 * 60 * 1000);
  const completedAt = new Date(START_MS).toISOString();
  assert.equal(nextPassDelayMillis(completedAt, START_MS + HOUR_MS), 5 * HOUR_MS);
  assert.equal(nextPassDelayMillis(completedAt, START_MS + 7 * HOUR_MS), 5 * 60 * 1000);
  // A completion stamped in the future waits at most one interval.
  assert.equal(nextPassDelayMillis(completedAt, START_MS - DAY_MS), 6 * HOUR_MS);
});
