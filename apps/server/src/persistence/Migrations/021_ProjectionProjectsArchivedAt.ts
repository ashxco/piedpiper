import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Null means not archived. Archiving keeps threads and messages, unlike deleted_at.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_projects)
  `;

  if (columns.some((column) => column.name === "archived_at")) {
    return;
  }

  yield* sql`
    ALTER TABLE projection_projects
    ADD COLUMN archived_at TEXT
  `;
});
