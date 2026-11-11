import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** V2 owns execution state while the existing projection tables continue serving the UI. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS orchestration_v2_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      thread_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      command_id TEXT,
      occurred_at TEXT NOT NULL,
      event_json TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_orch_v2_events_thread
    ON orchestration_v2_events(thread_id, sequence)`;
  yield* sql`CREATE TABLE IF NOT EXISTS orchestration_v2_provider_receipts (
    event_id TEXT PRIMARY KEY,
    decision_json TEXT NOT NULL
  )`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS orchestration_v2_entities (
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      run_id TEXT,
      native_turn_ref TEXT,
      sequence INTEGER NOT NULL,
      event_json TEXT NOT NULL,
      PRIMARY KEY (entity_type, entity_id)
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_orch_v2_entities_thread
    ON orchestration_v2_entities(thread_id, entity_type, sequence)`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_orch_v2_entities_run
    ON orchestration_v2_entities(thread_id, run_id, entity_type)`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_orch_v2_entities_native_turn
    ON orchestration_v2_entities(thread_id, native_turn_ref, entity_type)`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS orchestration_v2_legacy_imports (
      thread_id TEXT PRIMARY KEY,
      source TEXT NOT NULL DEFAULT 'legacy',
      imported_at TEXT NOT NULL,
      source_message_count INTEGER NOT NULL,
      source_activity_count INTEGER NOT NULL,
      source_turn_count INTEGER NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS orchestration_v2_effect_outbox (
      effect_id TEXT PRIMARY KEY,
      command_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      effect_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      available_at TEXT NOT NULL,
      lease_owner TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      last_error TEXT
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_orch_v2_effects_claim
    ON orchestration_v2_effect_outbox(status, available_at)`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_orch_v2_effects_thread
    ON orchestration_v2_effect_outbox(thread_id, status)`;
});
