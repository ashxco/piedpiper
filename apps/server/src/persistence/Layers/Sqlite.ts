import { Effect, Layer, FileSystem, Path } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import { ServerConfig } from "../../config.ts";

type RuntimeSqliteLayerConfig = {
  readonly filename: string;
  readonly spanAttributes?: Record<string, unknown>;
};

type Loader = {
  layer: (config: RuntimeSqliteLayerConfig) => Layer.Layer<SqlClient.SqlClient>;
};
const defaultSqliteClientLoaders = {
  bun: () => import("@effect/sql-sqlite-bun/SqliteClient"),
  node: () => import("../NodeSqliteClient.ts"),
} satisfies Record<string, () => Promise<Loader>>;

const makeRuntimeSqliteLayer = Effect.fn("makeRuntimeSqliteLayer")(function* (
  config: RuntimeSqliteLayerConfig,
) {
  const runtime = process.versions.bun !== undefined ? "bun" : "node";
  const loader = defaultSqliteClientLoaders[runtime];
  const clientModule = yield* Effect.promise<Loader>(loader);
  return clientModule.layer(config);
}, Layer.unwrap);

// Size the -wal file is cut back to on the first commit after a WAL reset.
export const WAL_SIZE_LIMIT_BYTES = 32 * 1024 * 1024;
// How long a statement waits for another connection's lock before SQLITE_BUSY.
export const BUSY_TIMEOUT_MS = 5000;

const setup = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // First so the pragmas below also wait instead of failing on a locked file.
    yield* sql.unsafe(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
    // Only an empty file can switch modes; existing databases keep theirs and reuse freed pages.
    const tables = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table'
    `;
    if (tables[0]?.count === 0) {
      yield* sql`PRAGMA auto_vacuum = INCREMENTAL;`;
      // The Bun driver opens in WAL, which already fixed the header; only VACUUM can still change it.
      const mode = yield* sql<{ readonly auto_vacuum: number }>`PRAGMA auto_vacuum`;
      if (mode[0]?.auto_vacuum !== 2) {
        yield* sql.unsafe("VACUUM");
      }
    }
    yield* sql`PRAGMA journal_mode = WAL;`;
    // In WAL mode NORMAL only fsyncs at checkpoints; FULL fsyncs every commit on the main thread.
    yield* sql`PRAGMA synchronous = NORMAL;`;
    // With NORMAL the checkpoint is the only fsync barrier; on macOS plain fsync stops at the drive cache.
    yield* sql`PRAGMA checkpoint_fullfsync = ON;`;
    // Statement journals and sort spills otherwise become synchronous temp-file writes on the event loop.
    yield* sql`PRAGMA temp_store = MEMORY;`;
    // PASSIVE checkpoints never shrink the -wal file, so it otherwise keeps its largest size.
    yield* sql.unsafe(`PRAGMA journal_size_limit = ${WAL_SIZE_LIMIT_BYTES};`);
    yield* sql`PRAGMA foreign_keys = ON;`;
    yield* runMigrations();
  }),
);

export const makeSqlitePersistenceLive = Effect.fn("makeSqlitePersistenceLive")(function* (
  dbPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true });

  return Layer.provideMerge(
    setup,
    makeRuntimeSqliteLayer({
      filename: dbPath,
      spanAttributes: {
        "db.name": path.basename(dbPath),
        "service.name": "piedpiper-server",
      },
    }),
  );
}, Layer.unwrap);

export const SqlitePersistenceMemory = Layer.provideMerge(
  setup,
  makeRuntimeSqliteLayer({ filename: ":memory:" }),
);

export const layerConfig = Layer.unwrap(
  Effect.map(Effect.service(ServerConfig), ({ dbPath }) => makeSqlitePersistenceLive(dbPath)),
);
