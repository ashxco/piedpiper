import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import Migration0023 from "./023_ClearAutomaticProjectModelDefaults.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const OPUS_4_6 = { provider: "claudeAgent", model: "claude-opus-4-6" };
const SONNET = { provider: "claudeAgent", model: "claude-sonnet-5-5" };

const insertEvent = (input: {
  readonly eventId: string;
  readonly streamId: string;
  readonly streamVersion: number;
  readonly eventType: string;
  readonly payload: Record<string, unknown>;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const payloadJson = JSON.stringify(input.payload);
    yield* sql`
      INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type,
        occurred_at, command_id, causation_event_id, correlation_id,
        actor_kind, payload_json, metadata_json
      ) VALUES (
        ${input.eventId}, 'project', ${input.streamId}, ${input.streamVersion}, ${input.eventType},
        '2026-01-01T00:00:00.000Z', NULL, NULL, NULL,
        'server', ${payloadJson}, '{}'
      )
    `;
  });

const insertProject = (projectId: string, selection: unknown) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const selectionJson = selection === null ? null : JSON.stringify(selection);
    yield* sql`
      INSERT INTO projection_projects (
        project_id, title, workspace_root, default_model_selection_json,
        scripts_json, created_at, updated_at, deleted_at
      ) VALUES (
        ${projectId}, ${projectId}, ${`/tmp/${projectId}`}, ${selectionJson},
        '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL
      )
    `;
  });

layer("023_ClearAutomaticProjectModelDefaults", (it) => {
  it.effect("clears only defaults stamped at creation that nothing later confirmed", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 22 });

      // Stamped at creation and never touched: cleared.
      yield* insertEvent({
        eventId: "stamped-created",
        streamId: "stamped",
        streamVersion: 0,
        eventType: "project.created",
        payload: { projectId: "stamped", title: "stamped", defaultModelSelection: OPUS_4_6 },
      });
      yield* insertProject("stamped", OPUS_4_6);

      // Stamped, then set by the user through a metadata update: kept.
      yield* insertEvent({
        eventId: "configured-created",
        streamId: "configured",
        streamVersion: 0,
        eventType: "project.created",
        payload: { projectId: "configured", title: "configured", defaultModelSelection: OPUS_4_6 },
      });
      yield* insertEvent({
        eventId: "configured-updated",
        streamId: "configured",
        streamVersion: 1,
        eventType: "project.meta-updated",
        payload: { projectId: "configured", defaultModelSelection: SONNET },
      });
      yield* insertProject("configured", SONNET);

      // A later update of another field is not evidence of a choice: cleared.
      yield* insertEvent({
        eventId: "renamed-created",
        streamId: "renamed",
        streamVersion: 0,
        eventType: "project.created",
        payload: { projectId: "renamed", title: "renamed", defaultModelSelection: OPUS_4_6 },
      });
      yield* insertEvent({
        eventId: "renamed-updated",
        streamId: "renamed",
        streamVersion: 1,
        eventType: "project.meta-updated",
        payload: { projectId: "renamed", title: "new name" },
      });
      yield* insertProject("renamed", OPUS_4_6);

      // Created with no default: unchanged.
      yield* insertEvent({
        eventId: "none-created",
        streamId: "none",
        streamVersion: 0,
        eventType: "project.created",
        payload: { projectId: "none", title: "none", defaultModelSelection: null },
      });
      yield* insertProject("none", null);

      yield* runMigrations({ toMigrationInclusive: 23 });

      const readProjects = sql<{
        readonly projectId: string;
        readonly selectionJson: string | null;
      }>`
        SELECT project_id AS "projectId", default_model_selection_json AS "selectionJson"
        FROM projection_projects
        ORDER BY project_id
      `;
      const readCreatedPayloads = sql<{
        readonly eventId: string;
        readonly payloadJson: string;
      }>`
        SELECT event_id AS "eventId", payload_json AS "payloadJson"
        FROM orchestration_events
        WHERE event_type = 'project.created'
        ORDER BY event_id
      `;

      const projects = yield* readProjects;
      assert.deepStrictEqual(
        projects.map((row) => [row.projectId, row.selectionJson && JSON.parse(row.selectionJson)]),
        [
          ["configured", SONNET],
          ["none", null],
          ["renamed", null],
          ["stamped", null],
        ],
      );

      const payloads = yield* readCreatedPayloads;
      assert.deepStrictEqual(
        payloads.map((row) => [row.eventId, JSON.parse(row.payloadJson).defaultModelSelection]),
        [
          ["configured-created", OPUS_4_6],
          ["none-created", null],
          ["renamed-created", null],
          ["stamped-created", null],
        ],
      );

      // A second run changes nothing.
      yield* Migration0023;
      assert.strictEqual(JSON.stringify(yield* readProjects), JSON.stringify(projects));
      assert.strictEqual(JSON.stringify(yield* readCreatedPayloads), JSON.stringify(payloads));
    }),
  );
});
