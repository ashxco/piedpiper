import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Project creation never offered a model choice, so a default stamped at creation was automatic
// and no UI clears it. A later metadata event carrying the field is evidence the user set one.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    WITH automatically_seeded_projects AS (
      SELECT created.stream_id AS project_id
      FROM orchestration_events AS created
      WHERE created.aggregate_kind = 'project'
        AND created.event_type = 'project.created'
        AND json_type(created.payload_json, '$.defaultModelSelection') IS NOT NULL
        AND json_type(created.payload_json, '$.defaultModelSelection') <> 'null'
        AND NOT EXISTS (
          SELECT 1
          FROM orchestration_events AS configured
          WHERE configured.aggregate_kind = 'project'
            AND configured.stream_id = created.stream_id
            AND configured.event_type = 'project.meta-updated'
            AND json_type(configured.payload_json, '$.defaultModelSelection') IS NOT NULL
        )
    )
    UPDATE projection_projects
    SET default_model_selection_json = NULL
    WHERE project_id IN (SELECT project_id FROM automatically_seeded_projects)
  `;

  // The event is rewritten too, so replaying it cannot bring the stamped default back.
  yield* sql`
    UPDATE orchestration_events AS created
    SET payload_json = json_set(created.payload_json, '$.defaultModelSelection', json('null'))
    WHERE created.aggregate_kind = 'project'
      AND created.event_type = 'project.created'
      AND json_type(created.payload_json, '$.defaultModelSelection') IS NOT NULL
      AND json_type(created.payload_json, '$.defaultModelSelection') <> 'null'
      AND NOT EXISTS (
        SELECT 1
        FROM orchestration_events AS configured
        WHERE configured.aggregate_kind = 'project'
          AND configured.stream_id = created.stream_id
          AND configured.event_type = 'project.meta-updated'
          AND json_type(configured.payload_json, '$.defaultModelSelection') IS NOT NULL
      )
  `;
});
