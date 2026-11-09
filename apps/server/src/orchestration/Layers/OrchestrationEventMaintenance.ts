import { Cause, Clock, Duration, Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { PersistenceSqlError, toPersistenceSqlError } from "../../persistence/Errors.ts";
import {
  OrchestrationEventMaintenance,
  type OrchestrationEventMaintenanceShape,
} from "../Services/OrchestrationEventMaintenance.ts";
import { ORCHESTRATION_PROJECTOR_NAMES } from "./ProjectionPipeline.ts";

// Reconnect replay reads this tail; older cursors recover from a snapshot.
const RETAINED_EVENT_HISTORY = Duration.days(1);
const PASS_INTERVAL = Duration.hours(6);
const STARTUP_DELAY = Duration.minutes(5);
const FAILED_PASS_RETRY_DELAY = Duration.hours(1);
const PAGE_SIZE = 50;
// A page runs on the event loop, so it rests nine times what it took.
const REST_MULTIPLIER = 9;
const MIN_PAGE_REST_MS = 10;
const MAX_VACUUM_PAGES_PER_PASS = 2048;
const VACUUM_PAGES_BEFORE_REST = 50;
// PRAGMA auto_vacuum value of a file whose free pages can be returned to the OS.
const AUTO_VACUUM_INCREMENTAL = 2;
const ENSURE_REPLAYABLE_OPERATION = "OrchestrationEventMaintenance.ensureReplayableFrom";

interface MaintenanceRow {
  readonly prunedThroughSequence: number;
  readonly pendingPruneThroughSequence: number | null;
  readonly pendingPruneMarkedAt: string | null;
  readonly lastCompletedAt: string | null;
}

/** Events at or below the returned sequence may be gone, so a replay from below it would have gaps. */
export const readPrunedThroughSequence = (sql: SqlClient.SqlClient) =>
  sql<{ readonly prunedThroughSequence: number }>`
    SELECT pruned_through_sequence AS "prunedThroughSequence"
    FROM orchestration_event_maintenance
    WHERE id = 1
  `.pipe(
    Effect.map((rows) => rows[0]?.prunedThroughSequence ?? 0),
    Effect.mapError(toPersistenceSqlError("OrchestrationEventMaintenance.readPrunedThrough:query")),
  );

/** Fails when a replay from this cursor would miss pruned events. */
export const ensureReplayableFrom = (sql: SqlClient.SqlClient, fromSequenceExclusive: number) =>
  readPrunedThroughSequence(sql).pipe(
    Effect.flatMap((prunedThrough) =>
      fromSequenceExclusive < prunedThrough
        ? Effect.fail(
            new PersistenceSqlError({
              operation: ENSURE_REPLAYABLE_OPERATION,
              detail: `Events through sequence ${prunedThrough} were pruned; cannot replay from ${fromSequenceExclusive}.`,
            }),
          )
        : Effect.void,
    ),
  );

/** True for the failure of `ensureReplayableFrom`: the reader must recover from a snapshot. */
export const isPrunedReplayError = (error: unknown): boolean =>
  Schema.is(PersistenceSqlError)(error) && error.operation === ENSURE_REPLAYABLE_OPERATION;

/** Wait before the next pass: keeps the cadence across restarts, without running during startup. */
export function nextPassDelayMillis(lastCompletedAt: string | null, nowMillis: number): number {
  const interval = Duration.toMillis(PASS_INTERVAL);
  const startupDelay = Duration.toMillis(STARTUP_DELAY);
  const lastCompletedMillis = lastCompletedAt === null ? Number.NaN : Date.parse(lastCompletedAt);
  if (Number.isNaN(lastCompletedMillis)) {
    return startupDelay;
  }
  // A timestamp from the future (clock change) still waits no longer than one interval.
  const remaining = Math.min(lastCompletedMillis + interval - nowMillis, interval);
  return Math.max(remaining, startupDelay);
}

const defaultRestAfterPage = (pageMillis: number) =>
  Effect.sleep(Duration.millis(Math.max(pageMillis * REST_MULTIPLIER, MIN_PAGE_REST_MS)));

export const makeOrchestrationEventMaintenance = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const readState = sql<MaintenanceRow>`
    SELECT
      pruned_through_sequence AS "prunedThroughSequence",
      pending_prune_through_sequence AS "pendingPruneThroughSequence",
      pending_prune_marked_at AS "pendingPruneMarkedAt",
      last_completed_at AS "lastCompletedAt"
    FROM orchestration_event_maintenance
    WHERE id = 1
  `.pipe(Effect.map((rows) => rows[0]));

  // A projector without a cursor still has every event to apply, so it counts as zero.
  const readLowestProjectorCursor = sql<{
    readonly projector: string;
    readonly lastAppliedSequence: number;
  }>`
    SELECT projector, last_applied_sequence AS "lastAppliedSequence"
    FROM projection_state
  `.pipe(
    Effect.map((rows) => {
      const cursors = new Map(rows.map((row) => [row.projector, row.lastAppliedSequence]));
      return Math.min(
        ...Object.values(ORCHESTRATION_PROJECTOR_NAMES).map((name) => cursors.get(name) ?? 0),
      );
    }),
  );

  // The newest row of a stream stays: the next append derives its stream_version from it.
  const deletePages = Effect.fn("OrchestrationEventMaintenance.deletePages")(function* (
    throughSequence: number,
    restAfterPage: (pageMillis: number) => Effect.Effect<void>,
  ) {
    let deletedEventCount = 0;
    let cursor = 0;
    while (cursor < throughSequence) {
      const pageStartedAt = yield* Clock.currentTimeMillis;
      const page = yield* sql<{ readonly sequence: number }>`
        SELECT sequence
        FROM orchestration_events
        WHERE sequence > ${cursor} AND sequence <= ${throughSequence}
        ORDER BY sequence ASC
        LIMIT ${PAGE_SIZE}
      `;
      const pageEnd = page.at(-1)?.sequence;
      if (pageEnd === undefined) {
        break;
      }
      const deleted = yield* sql<{ readonly sequence: number }>`
        DELETE FROM orchestration_events
        WHERE sequence > ${cursor}
          AND sequence <= ${pageEnd}
          AND stream_version < (
            SELECT MAX(newer.stream_version)
            FROM orchestration_events AS newer
            WHERE newer.aggregate_kind = orchestration_events.aggregate_kind
              AND newer.stream_id = orchestration_events.stream_id
          )
        RETURNING sequence
      `;
      deletedEventCount += deleted.length;
      cursor = pageEnd;
      yield* restAfterPage((yield* Clock.currentTimeMillis) - pageStartedAt);
      if (page.length < PAGE_SIZE) {
        break;
      }
    }
    return deletedEventCount;
  });

  // node:sqlite steps a columnless statement once, and each step frees one page: go page by page.
  const reclaimFreePages = Effect.fn("OrchestrationEventMaintenance.reclaimFreePages")(
    function* (restAfterPage: (pageMillis: number) => Effect.Effect<void>) {
      const mode = yield* sql<{ readonly auto_vacuum: number }>`PRAGMA auto_vacuum`;
      // The freelist is non-zero on other files too, but they can only reuse the pages.
      if (mode[0]?.auto_vacuum !== AUTO_VACUUM_INCREMENTAL) {
        return;
      }
      let batchStartedAt = yield* Clock.currentTimeMillis;
      for (let page = 1; page <= MAX_VACUUM_PAGES_PER_PASS; page += 1) {
        const free = yield* sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`;
        if ((free[0]?.freelist_count ?? 0) === 0) {
          return;
        }
        yield* sql`PRAGMA incremental_vacuum(1)`;
        if (page % VACUUM_PAGES_BEFORE_REST === 0) {
          yield* restAfterPage((yield* Clock.currentTimeMillis) - batchStartedAt);
          batchStartedAt = yield* Clock.currentTimeMillis;
        }
      }
    },
    // The rows are already gone and pages left over are reused, so this never fails the pass.
    Effect.catch((cause) =>
      Effect.logWarning("orchestration event page reclaim failed", { cause }),
    ),
  );

  const runPass: OrchestrationEventMaintenanceShape["runPass"] = Effect.fn(
    "OrchestrationEventMaintenance.runPass",
  )(
    function* (options) {
      const restAfterPage = options?.restAfterPage ?? defaultRestAfterPage;
      const nowMillis = yield* Clock.currentTimeMillis;
      const now = new Date(nowMillis).toISOString();
      const state = yield* readState;
      if (state === undefined) {
        return { deletedEventCount: 0 };
      }
      const headRows = yield* sql<{ readonly head: number }>`
        SELECT COALESCE(MAX(sequence), 0) AS head FROM orchestration_events
      `;
      const head = headRows[0]?.head ?? 0;

      const markedAtMillis =
        state.pendingPruneMarkedAt === null ? null : Date.parse(state.pendingPruneMarkedAt);
      const markIsDue =
        markedAtMillis !== null &&
        !Number.isNaN(markedAtMillis) &&
        nowMillis - markedAtMillis >= Duration.toMillis(RETAINED_EVENT_HISTORY);

      let deletedEventCount = 0;
      if (markIsDue && state.pendingPruneThroughSequence !== null) {
        const lowestCursor = yield* readLowestProjectorCursor;
        const throughSequence = Math.max(
          Math.min(state.pendingPruneThroughSequence, lowestCursor),
          state.prunedThroughSequence,
        );
        if (throughSequence > state.prunedThroughSequence) {
          // Committed before any delete, so a replay can never see a partial range unannounced.
          yield* sql`
            UPDATE orchestration_event_maintenance
            SET pruned_through_sequence = ${throughSequence}
            WHERE id = 1
          `;
        }
        // Also finishes a pass that a restart cut short, whose boundary is already written.
        deletedEventCount = yield* deletePages(throughSequence, restAfterPage);
      }

      if (state.pendingPruneMarkedAt === null || markIsDue) {
        yield* sql`
          UPDATE orchestration_event_maintenance
          SET pending_prune_through_sequence = ${head}, pending_prune_marked_at = ${now}
          WHERE id = 1
        `;
      }

      // Not tied to this pass's deletes: it also drains what the page cap or a restart left behind.
      yield* reclaimFreePages(restAfterPage);

      yield* sql`
        UPDATE orchestration_event_maintenance
        SET last_completed_at = ${now}
        WHERE id = 1
      `;
      return { deletedEventCount };
    },
    Effect.mapError(toPersistenceSqlError("OrchestrationEventMaintenance.runPass")),
  );

  const runLoop = Effect.gen(function* () {
    while (true) {
      const lastCompletedAt = yield* readState.pipe(
        Effect.map((state) => state?.lastCompletedAt ?? null),
        Effect.orElseSucceed(() => null),
      );
      const delayMillis = nextPassDelayMillis(lastCompletedAt, yield* Clock.currentTimeMillis);
      yield* Effect.sleep(Duration.millis(delayMillis));
      yield* runPass().pipe(
        Effect.tap(({ deletedEventCount }) =>
          deletedEventCount > 0
            ? Effect.logInfo("pruned orchestration events", { deletedEventCount })
            : Effect.void,
        ),
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("orchestration event maintenance pass failed", { cause }).pipe(
                Effect.andThen(Effect.sleep(FAILED_PASS_RETRY_DELAY)),
              ),
        ),
      );
    }
  });

  const start: OrchestrationEventMaintenanceShape["start"] = () =>
    Effect.forkScoped(runLoop).pipe(Effect.asVoid);

  return { runPass, start } satisfies OrchestrationEventMaintenanceShape;
});

export const OrchestrationEventMaintenanceLive = Layer.effect(
  OrchestrationEventMaintenance,
  makeOrchestrationEventMaintenance,
);
