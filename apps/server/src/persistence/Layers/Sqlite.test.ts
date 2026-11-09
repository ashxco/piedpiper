import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  BUSY_TIMEOUT_MS,
  SqlitePersistenceMemory,
  WAL_SIZE_LIMIT_BYTES,
  makeSqlitePersistenceLive,
} from "./Sqlite.ts";

it.layer(SqlitePersistenceMemory)("SqlitePersistence setup", (it) => {
  it.effect(
    "applies busy_timeout, synchronous, checkpoint_fullfsync, temp_store and journal_size_limit",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const busy = yield* sql<{ readonly timeout: number }>`PRAGMA busy_timeout`;
        assert.equal(busy[0]?.timeout, BUSY_TIMEOUT_MS);
        const synchronous = yield* sql<{ readonly synchronous: number }>`PRAGMA synchronous`;
        // 1 is NORMAL.
        assert.equal(synchronous[0]?.synchronous, 1);
        const fullfsync = yield* sql<{
          readonly checkpoint_fullfsync: number;
        }>`PRAGMA checkpoint_fullfsync`;
        assert.equal(fullfsync[0]?.checkpoint_fullfsync, 1);
        const tempStore = yield* sql<{ readonly temp_store: number }>`PRAGMA temp_store`;
        // 2 is MEMORY.
        assert.equal(tempStore[0]?.temp_store, 2);
        const journal = yield* sql<{
          readonly journal_size_limit: number;
        }>`PRAGMA journal_size_limit`;
        assert.equal(journal[0]?.journal_size_limit, WAL_SIZE_LIMIT_BYTES);
        const foreignKeys = yield* sql<{ readonly foreign_keys: number }>`PRAGMA foreign_keys`;
        assert.equal(foreignKeys[0]?.foreign_keys, 1);
      }),
  );
});

it.effect("keeps WAL journal mode for file-backed databases", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "piedpiper-sqlite-setup-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const mode = yield* sql<{ readonly journal_mode: string }>`PRAGMA journal_mode`;
    assert.equal(mode[0]?.journal_mode, "wal");
    const synchronous = yield* sql<{ readonly synchronous: number }>`PRAGMA synchronous`;
    assert.equal(synchronous[0]?.synchronous, 1);
    const fullfsync = yield* sql<{
      readonly checkpoint_fullfsync: number;
    }>`PRAGMA checkpoint_fullfsync`;
    assert.equal(fullfsync[0]?.checkpoint_fullfsync, 1);
  }).pipe(
    Effect.provide(makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer))),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});

it.effect(
  "uses incremental auto_vacuum on a new file but leaves an existing file's mode alone",
  () => {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "piedpiper-sqlite-vacuum-"));
    const newPath = NodePath.join(tempDir, "new.sqlite");
    const existingPath = NodePath.join(tempDir, "existing.sqlite");
    const seeded = new NodeSqlite.DatabaseSync(existingPath);
    seeded.exec("CREATE TABLE existing_rows(value TEXT)");
    seeded.close();
    const readMode = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly auto_vacuum: number }>`PRAGMA auto_vacuum`;
      return rows[0]?.auto_vacuum;
    });
    return Effect.gen(function* () {
      // 2 is INCREMENTAL, 0 is NONE.
      assert.equal(
        yield* readMode.pipe(
          Effect.provide(
            makeSqlitePersistenceLive(newPath).pipe(Layer.provide(NodeServices.layer)),
          ),
        ),
        2,
      );
      assert.equal(
        yield* readMode.pipe(
          Effect.provide(
            makeSqlitePersistenceLive(existingPath).pipe(Layer.provide(NodeServices.layer)),
          ),
        ),
        0,
      );
      // A reopened file keeps the mode it was created with.
      assert.equal(
        yield* readMode.pipe(
          Effect.provide(
            makeSqlitePersistenceLive(newPath).pipe(Layer.provide(NodeServices.layer)),
          ),
        ),
        2,
      );
    }).pipe(
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
    );
  },
);

// The Bun driver sets WAL when it opens the file, before our setup runs.
it.effect("uses incremental auto_vacuum on an empty file that is already in WAL mode", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "piedpiper-sqlite-wal-empty-"));
  const dbPath = NodePath.join(tempDir, "empty-wal.sqlite");
  const seeded = new NodeSqlite.DatabaseSync(dbPath);
  seeded.exec("PRAGMA journal_mode = WAL");
  seeded.close();
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const mode = yield* sql<{ readonly auto_vacuum: number }>`PRAGMA auto_vacuum`;
    assert.equal(mode[0]?.auto_vacuum, 2);
    const journal = yield* sql<{ readonly journal_mode: string }>`PRAGMA journal_mode`;
    assert.equal(journal[0]?.journal_mode, "wal");
  }).pipe(
    Effect.provide(makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer))),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});

// Linux names an open, already-deleted file "<path> (deleted)" in /proc/self/fd; SQLite names temp files "etilqs_*".
const openDeletedTempFiles = () =>
  NodeFS.readdirSync("/proc/self/fd").flatMap((fd) => {
    try {
      const target = NodeFS.readlinkSync(`/proc/self/fd/${fd}`);
      return target.includes("/etilqs_") && target.endsWith(" (deleted)") ? [target] : [];
    } catch {
      return [];
    }
  });

it.effect.skipIf(process.platform !== "linux")(
  "keeps a write transaction's statement journal off the temp directory",
  () => {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "piedpiper-sqlite-temp-"));
    const dbPath = NodePath.join(tempDir, "state.sqlite");
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE journal_probe(id INTEGER PRIMARY KEY, payload TEXT NOT NULL)`;
      for (let id = 0; id < 64; id++) {
        yield* sql`INSERT INTO journal_probe VALUES (${id}, ${"x".repeat(4096)})`;
      }
      const before = new Set(openDeletedTempFiles());
      const opened = yield* sql.withTransaction(
        Effect.gen(function* () {
          // A multi-row update journals every page it changes, well past SQLite's in-memory default.
          yield* sql`UPDATE journal_probe SET payload = payload || 'y'`;
          return openDeletedTempFiles().filter((target) => !before.has(target));
        }),
      );
      assert.deepEqual(opened, []);
    }).pipe(
      Effect.provide(makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer))),
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
    );
  },
);

const lockHolderSource = `
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1]);
db.exec("BEGIN IMMEDIATE");
process.stdout.write("locked\\n");
setTimeout(() => {
  db.exec("COMMIT");
  db.close();
}, Number(process.argv[2]));
`;

// node:sqlite is synchronous, so the busy wait is only observable against another process.
const spawnWriteLockHolder = (dbPath: string, holdMs: number) =>
  Effect.promise(
    () =>
      new Promise<void>((resolve, reject) => {
        const holder = NodeChildProcess.spawn(
          process.execPath,
          ["-e", lockHolderSource, dbPath, String(holdMs)],
          { stdio: ["ignore", "pipe", "ignore"] },
        );
        holder.stdout.once("data", () => resolve());
        holder.on("error", reject);
        holder.on("exit", () =>
          reject(new Error("lock holder exited before acquiring the write lock")),
        );
      }),
  );

it.effect("waits out a concurrent writer instead of failing with SQLITE_BUSY", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "piedpiper-sqlite-busy-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE busy_probe(id INTEGER PRIMARY KEY)`;
    yield* spawnWriteLockHolder(dbPath, 300);
    yield* sql`INSERT INTO busy_probe(id) VALUES (${1})`;
    const rows = yield* sql<{ readonly id: number }>`SELECT id FROM busy_probe`;
    assert.deepEqual([...rows], [{ id: 1 }]);
  }).pipe(
    Effect.provide(makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer))),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});

it.effect("shrinks the WAL file back to the size limit after a large write", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "piedpiper-sqlite-wal-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");
  const walFileSize = () => NodeFS.statSync(`${dbPath}-wal`).size;
  // About 25% more 4 KB rows than the limit holds, in one transaction.
  const rowCount = Math.ceil((WAL_SIZE_LIMIT_BYTES * 1.25) / 4000);
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE wal_probe(payload BLOB)`;
    yield* sql`
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${rowCount})
      INSERT INTO wal_probe(payload) SELECT randomblob(4000) FROM n
    `;
    assert.isAbove(walFileSize(), WAL_SIZE_LIMIT_BYTES);
    // The auto-checkpoint after the large commit copied every frame back, so the next commit
    // restarts the WAL and truncates the file to journal_size_limit.
    yield* sql`INSERT INTO wal_probe(payload) VALUES (x'00')`;
    assert.isAtMost(walFileSize(), WAL_SIZE_LIMIT_BYTES);
  }).pipe(
    Effect.provide(makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer))),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});
