import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Null means no user-chosen icon, so the resolver keeps its existing lookup.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_projects)
  `;

  if (columns.some((column) => column.name === "favicon_path")) {
    return;
  }

  yield* sql`
    ALTER TABLE projection_projects
    ADD COLUMN favicon_path TEXT
  `;
});
