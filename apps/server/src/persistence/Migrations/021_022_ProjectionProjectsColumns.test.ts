import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import Migration0021 from "./021_ProjectionProjectsArchivedAt.ts";
import Migration0022 from "./022_ProjectionProjectsFaviconPath.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("021 and 022 projection_projects columns", (it) => {
  it.effect("adds nullable columns, keeps existing rows and tolerates a second run", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 20 });

      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json,
          scripts_json, created_at, updated_at, deleted_at
        ) VALUES (
          'project-1', 'Project', '/tmp/project', NULL,
          '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 22 });

      const columns = yield* sql<{
        readonly name: string;
        readonly notnull: number;
      }>`PRAGMA table_info(projection_projects)`;
      for (const name of ["archived_at", "favicon_path"]) {
        const column = columns.find((candidate) => candidate.name === name);
        assert.ok(column, `missing column ${name}`);
        assert.strictEqual(column.notnull, 0);
      }

      yield* Migration0021;
      yield* Migration0022;

      const rows = yield* sql<{
        readonly projectId: string;
        readonly archivedAt: string | null;
        readonly faviconPath: string | null;
      }>`
        SELECT
          project_id AS "projectId",
          archived_at AS "archivedAt",
          favicon_path AS "faviconPath"
        FROM projection_projects
      `;
      assert.deepStrictEqual(
        rows.map((row) => [row.projectId, row.archivedAt, row.faviconPath]),
        [["project-1", null, null]],
      );
    }),
  );
});
