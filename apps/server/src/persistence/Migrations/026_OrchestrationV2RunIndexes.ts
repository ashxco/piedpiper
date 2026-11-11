import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_orch_v2_live_runs
    ON orchestration_v2_entities(thread_id, sequence)
    WHERE entity_type = 'run.updated' AND json_extract(event_json, '$.payload.status') IN ('pending', 'running', 'waiting')`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_orch_v2_runs_status
    ON orchestration_v2_entities(thread_id, json_extract(event_json, '$.payload.status'), json_extract(event_json, '$.payload.ordinal'), sequence)
    WHERE entity_type = 'run.updated'`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_orch_v2_runs_ordinal
    ON orchestration_v2_entities(thread_id, json_extract(event_json, '$.payload.ordinal'))
    WHERE entity_type = 'run.updated' AND json_extract(event_json, '$.payload.status') != 'rolled_back'`;
});
