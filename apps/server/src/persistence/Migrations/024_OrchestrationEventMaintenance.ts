import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// One row of event-pruning state, kept out of projection_state because no projector owns it:
// - pruned_through_sequence: replay from below this misses events, so the client takes a snapshot.
// - pending_prune_through_sequence, pending_prune_marked_at: the mark phase; null when none is open.
// - last_completed_at: keeps the run cadence across restarts.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS orchestration_event_maintenance (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      pruned_through_sequence INTEGER NOT NULL DEFAULT 0,
      pending_prune_through_sequence INTEGER,
      pending_prune_marked_at TEXT,
      last_completed_at TEXT
    )
  `;

  yield* sql`
    INSERT OR IGNORE INTO orchestration_event_maintenance (id) VALUES (1)
  `;
});
