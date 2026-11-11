import { Effect, FileSystem, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export class V2DatabaseBackupError extends Schema.TaggedErrorClass<V2DatabaseBackupError>()(
  "V2DatabaseBackupError",
  { databasePath: Schema.String, cause: Schema.Defect },
) {
  override get message() {
    return `Could not back up ${this.databasePath} before the orchestration V2 migration.`;
  }
}

/** VACUUM INTO reads a consistent SQLite snapshot, including committed WAL contents. */
export const backupBeforeV2Migration = Effect.fn("orchestrationV2.backupDatabase")(
  function* (databasePath: string) {
    const sql = yield* SqlClient.SqlClient;
    const fs = yield* FileSystem.FileSystem;
    const tables = yield* sql<{ name: string }>`SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN ('projection_threads', 'orchestration_v2_events')`;
    if (
      !tables.some((table) => table.name === "projection_threads") ||
      tables.some((table) => table.name === "orchestration_v2_events")
    )
      return null;
    const backupPath = `${databasePath}.pre-v2-${Date.now()}-${crypto.randomUUID()}.sqlite`;
    const temporaryPath = `${backupPath}.partial`;
    yield* Effect.gen(function* () {
      yield* sql`VACUUM INTO ${temporaryPath}`;
      yield* fs.rename(temporaryPath, backupPath);
    }).pipe(
      Effect.ensuring(fs.remove(temporaryPath, { force: true }).pipe(Effect.ignore({ log: true }))),
    );
    yield* Effect.logInfo("Saved database backup before orchestration V2 migration", {
      backupPath,
    });
    return backupPath;
  },
  (effect, databasePath) =>
    effect.pipe(Effect.mapError((cause) => new V2DatabaseBackupError({ databasePath, cause }))),
);
