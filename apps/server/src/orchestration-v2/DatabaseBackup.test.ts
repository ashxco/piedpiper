import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Sqlite from "node:sqlite";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import { layerMemory } from "../persistence/NodeSqliteClient.ts";
import { backupBeforeV2Migration } from "./DatabaseBackup.ts";

it.layer(Layer.mergeAll(layerMemory(), NodeServices.layer))("V2 database backup", (it) => {
  it.effect("keeps a readable pre-migration snapshot and skips an already upgraded database", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "piedpiper-v2-backup-" });
      const databasePath = path.join(directory, "state.sqlite");
      yield* runMigrations({ toMigrationInclusive: 24 });
      yield* sql`CREATE TABLE backup_proof (content TEXT NOT NULL)`;
      yield* sql`INSERT INTO backup_proof VALUES ('Saved conversation — 日本語')`;
      const backup = yield* backupBeforeV2Migration(databasePath);
      assert.ok(backup);
      yield* runMigrations();
      yield* sql`DELETE FROM backup_proof`;
      const snapshot = new Sqlite.DatabaseSync(backup, { readOnly: true });
      try {
        assert.equal(
          snapshot.prepare("SELECT content FROM backup_proof").get()?.content,
          "Saved conversation — 日本語",
        );
        assert.equal(
          snapshot
            .prepare(
              "SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'orchestration_v2_events'",
            )
            .get()?.count,
          0,
        );
      } finally {
        snapshot.close();
      }
      assert.equal(yield* backupBeforeV2Migration(databasePath), null);
    }).pipe(Effect.scoped),
  );
});
