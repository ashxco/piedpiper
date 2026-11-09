import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { classifySqliteError, SqlError } from "effect/unstable/sql/SqlError";

import {
  PersistenceDecodeError,
  toPersistenceSqlError,
  userFacingDatabaseErrorMessage,
} from "./Errors.ts";
import * as NodeSqliteClient from "./NodeSqliteClient.ts";

const decodeRuntimePayload = Schema.decodeUnknownEffect(
  Schema.Struct({
    runtimePayload: Schema.Struct({
      attempt: Schema.Number,
    }),
  }),
);

it.effect("names a real SQLite condition without copying query data", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const payload = "sql-private-sentinel";
    yield* sql`CREATE TABLE error_test (private_column TEXT PRIMARY KEY)`;
    yield* sql`INSERT INTO error_test VALUES (${payload})`;
    const cause = yield* Effect.flip(sql`INSERT INTO error_test VALUES (${payload})`);
    const error = toPersistenceSqlError("OrchestrationCommandReceiptRepository.upsert:query")(
      cause,
    );

    assert.equal(error.detail, "SQLITE(1555) constraint failed");
    assert.equal(error.cause, cause);
    assert.notInclude(error.message, payload);
    assert.notInclude(error.message, "private_column");
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it("reads the condition through a wrapping driver error", () => {
  const driver = Object.assign(new Error("locked"), { errcode: 5, errstr: "database is locked" });
  const error = toPersistenceSqlError("ProjectionThreads.list:query")(
    new Error("Failed to prepare statement", { cause: driver }),
  );

  assert.equal(error.detail, "SQLITE(5) database is locked");
});

it.each([{ errno: 1555, code: "SQLITE_CONSTRAINT_PRIMARYKEY" }, { errno: 1 }])(
  "names Bun SQLite condition $errno through the SQL error wrapper",
  (condition) => {
    const driver = Object.assign(new Error("bun-sql-private-sentinel"), {
      name: "SQLiteError",
      ...condition,
    });
    const cause = new SqlError({ reason: classifySqliteError(driver) });
    const error = toPersistenceSqlError("ProjectionThreads.upsert:query")(cause);

    assert.equal(
      error.message,
      `SQL error in ProjectionThreads.upsert:query: SQLITE(${condition.errno})`,
    );
    assert.equal(error.cause, cause);
  },
);

it.each([
  new Error("unhelpful"),
  Object.assign(new Error("file not found"), { errno: -2, code: "ENOENT" }),
])("falls back to the generic detail for a cause it cannot categorize (%#)", (cause) => {
  const error = toPersistenceSqlError("ProjectionThreads.list:query")(cause);

  assert.equal(error.detail, "Failed to execute ProjectionThreads.list:query");
});

it.effect("summarizes a schema cause by issue tag instead of by rejected value", () =>
  Effect.gen(function* () {
    const rejectedPayload = "sql-mapper-secret-sentinel";
    const cause = yield* Effect.flip(
      decodeRuntimePayload({ runtimePayload: { attempt: rejectedPayload } }),
    );
    const error = toPersistenceSqlError("ProviderSessionRuntimeRepository.list:query")(cause);

    assert.notEqual(error.detail, "Failed to execute ProviderSessionRuntimeRepository.list:query");
    assert.notInclude(error.message, rejectedPayload);
  }),
);

const FALLBACK_MESSAGE =
  "Pied Piper could not complete this database request. Retry once; if it still fails, check the server logs for the database error.";

it.each([
  [5, "SQLITE_BUSY"],
  [6, "SQLITE_LOCKED"],
  [8, "SQLITE_READONLY"],
  [10, "SQLITE_IOERR"],
  [11, "SQLITE_CORRUPT"],
  [13, "SQLITE_FULL"],
  [14, "SQLITE_CANTOPEN"],
  [26, "SQLITE_NOTADB"],
])("gives recovery steps for result code %i", (code, name) => {
  const driver = Object.assign(new Error("driver-private-text"), {
    errcode: code,
    errstr: "driver-private-text",
  });
  const message = userFacingDatabaseErrorMessage(toPersistenceSqlError("op:query")(driver));

  assert.include(message, name);
  assert.notInclude(message, "driver-private-text");
});

it("reads the primary code from an extended result code and from Bun's errno", () => {
  // SQLITE_IOERR_WRITE and SQLITE_BUSY_SNAPSHOT.
  const extended = Object.assign(new Error("x"), { errcode: 778, errstr: "x" });
  assert.include(userFacingDatabaseErrorMessage(toPersistenceSqlError("op")(extended)), "IOERR");
  const bun = Object.assign(new Error("x"), { name: "SQLiteError", errno: 517 });
  assert.include(
    userFacingDatabaseErrorMessage(new SqlError({ reason: classifySqliteError(bun) })),
    "SQLITE_BUSY",
  );
});

it("falls back for other database failures and ignores non-database errors", () => {
  const constraint = Object.assign(new Error("driver-private-text"), {
    errcode: 1555,
    errstr: "constraint failed",
  });
  assert.equal(
    userFacingDatabaseErrorMessage(toPersistenceSqlError("op")(constraint)),
    FALLBACK_MESSAGE,
  );
  assert.equal(
    userFacingDatabaseErrorMessage(new PersistenceDecodeError({ operation: "op", issue: "x" })),
    FALLBACK_MESSAGE,
  );
  assert.equal(
    userFacingDatabaseErrorMessage(toPersistenceSqlError("op")(new Error("no code"))),
    FALLBACK_MESSAGE,
  );

  assert.isUndefined(userFacingDatabaseErrorMessage(new Error("Thread not found")));
  // A code on an unrelated error is not a database failure.
  assert.isUndefined(
    userFacingDatabaseErrorMessage(Object.assign(new Error("x"), { errno: 13, code: "EACCES" })),
  );
  assert.isUndefined(userFacingDatabaseErrorMessage("text"));
});

it("finds a database failure wrapped by another error, surviving a cause cycle", () => {
  const driver = Object.assign(new Error("x"), { errcode: 13, errstr: "x" });
  const wrapper = new Error("Failed to dispatch", { cause: toPersistenceSqlError("op")(driver) });
  assert.include(userFacingDatabaseErrorMessage(wrapper), "SQLITE_FULL");

  const cyclic: Error & { cause?: unknown } = new Error("cycle");
  cyclic.cause = cyclic;
  assert.isUndefined(userFacingDatabaseErrorMessage(cyclic));
});

it.effect("recognizes a real full database and a real read-only database", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "piedpiper-errors-" });
    const filename = path.join(directory, "state.sqlite");

    const seed = new NodeSqlite.DatabaseSync(filename);
    seed.exec("CREATE TABLE entries(value TEXT)");
    seed.close();

    const full = yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const pages = yield* sql<{ readonly page_count: number }>`PRAGMA page_count`;
      yield* sql.unsafe(`PRAGMA max_page_count = ${pages[0]?.page_count ?? 1}`);
      return yield* Effect.flip(sql`INSERT INTO entries VALUES (${"x".repeat(100_000)})`);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename })));
    assert.include(
      userFacingDatabaseErrorMessage(toPersistenceSqlError("op")(full)),
      "SQLITE_FULL",
    );

    const readonly = yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* Effect.flip(sql`INSERT INTO entries VALUES ('x')`);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename, readonly: true })));
    assert.include(
      userFacingDatabaseErrorMessage(toPersistenceSqlError("op")(readonly)),
      "SQLITE_READONLY",
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
