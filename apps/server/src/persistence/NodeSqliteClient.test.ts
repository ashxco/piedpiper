import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, FileSystem, Path } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { vi } from "vitest";

import * as SqliteClient from "./NodeSqliteClient.ts";

const layer = it.layer(SqliteClient.layerMemory());

layer("NodeSqliteClient", (it) => {
  it.effect("runs prepared queries and returns positional values", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* sql`CREATE TABLE entries(id INTEGER PRIMARY KEY, name TEXT NOT NULL)`;
      yield* sql`INSERT INTO entries(name) VALUES (${"alpha"}), (${"beta"})`;

      const rows = yield* sql<{ readonly id: number; readonly name: string }>`
      SELECT id, name FROM entries ORDER BY id
    `;
      assert.equal(rows.length, 2);
      assert.equal(rows[0]?.name, "alpha");
      assert.equal(rows[1]?.name, "beta");

      const values = yield* sql`SELECT id, name FROM entries ORDER BY id`.values;
      assert.equal(values.length, 2);
      assert.equal(values[0]?.[1], "alpha");
      assert.equal(values[1]?.[1], "beta");
    }),
  );

  it.effect("retries preparing a query after the missing schema becomes available", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const select = sql<{ name: string }>`SELECT name FROM created_after_prepare_failure`;
      const error = yield* select.pipe(Effect.flip);
      assert.equal(error._tag, "SqlError");
      assert.equal(error.reason.operation, "prepare");

      yield* sql`CREATE TABLE created_after_prepare_failure(name TEXT NOT NULL)`;
      yield* sql`INSERT INTO created_after_prepare_failure VALUES ('recovered')`;
      assert.deepEqual(yield* select, [{ name: "recovered" }]);
      assert.deepEqual(yield* select.values, [["recovered"]]);
    }),
  );

  it.effect("classifies constraint failures from node:sqlite errcode", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE unique_names(name TEXT NOT NULL UNIQUE)`;
      yield* sql`INSERT INTO unique_names VALUES ('dup')`;
      const error = yield* sql`INSERT INTO unique_names VALUES ('dup')`.pipe(Effect.flip);
      assert.equal(error._tag, "SqlError");
      assert.equal(error.reason._tag, "ConstraintError");
    }),
  );
});

const largeText = "x".repeat(64 * 1024 + 1);

it.effect("keeps large text and blob parameters off cached statements", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const statements: Array<NodeSqlite.StatementSync> = [];
    const all = NodeSqlite.StatementSync.prototype.all;
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        vi.spyOn(NodeSqlite.StatementSync.prototype, "all").mockImplementation(function (
          this: NodeSqlite.StatementSync,
          ...params
        ) {
          statements.push(this);
          return all.apply(this, params);
        }),
      ),
      (spy) => Effect.sync(() => spy.mockRestore()),
    );

    const small = "small";
    const queries = [
      (value: string | Uint8Array | ArrayBuffer) => sql`SELECT length(${value}) AS size`,
      (value: string | Uint8Array | ArrayBuffer) =>
        sql.unsafe("SELECT length($value) AS size", [{ $value: value }]),
      (value: string | Uint8Array | ArrayBuffer) =>
        sql.unsafe("SELECT length($value) AS callable", [
          Object.assign(() => {}, { $value: value }),
        ]),
    ];
    const cached = new Set<NodeSqlite.StatementSync>();
    const large = new Set<NodeSqlite.StatementSync>();
    const largeBlobs = [new Uint8Array(64 * 1024 + 1), new ArrayBuffer(64 * 1024 + 1)];
    for (const value of [small, largeText, ...largeBlobs, small]) {
      const expected = typeof value === "string" ? value.length : value.byteLength;
      for (const query of queries) {
        assert.deepEqual((yield* query(value)).map(Object.values), [[expected]]);
        assert.deepEqual(yield* query(value).values, [[expected]]);
        for (const statement of statements.splice(0)) {
          (value === small ? cached : large).add(statement);
        }
      }
    }

    // Small parameters keep reusing the one cached statement for each query.
    assert.equal(cached.size, queries.length);
    // Each large execution gets a statement that nothing holds on to afterwards.
    assert.equal(large.size, queries.length * 6);
    for (const statement of large) {
      assert.isFalse(cached.has(statement));
    }
  }).pipe(Effect.scoped, Effect.provide(SqliteClient.layerMemory())),
);

it.effect("reads integers on the values path as the caller asked, cached or not", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const value of ["small", largeText]) {
      const values = sql`SELECT 1 AS id, length(${value}) AS size`.values;
      assert.deepEqual(yield* values.pipe(Effect.provideService(SqlClient.SafeIntegers, true)), [
        [1n, BigInt(value.length)],
      ]);
      assert.deepEqual(yield* values, [[1, value.length]]);
    }
  }).pipe(Effect.provide(SqliteClient.layerMemory())),
);

it.effect("leaves a named parameter behind a getter for the statement to read once", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const throwing = {
      get $value(): string {
        throw new Error("unreadable");
      },
    };
    const error = yield* sql.unsafe("SELECT length($value) AS size", [throwing]).pipe(Effect.flip);
    assert.equal(error.reason.operation, "execute");

    let reads = 0;
    const counting = {
      get $value(): number {
        return ++reads;
      },
    };
    assert.deepEqual(yield* sql.unsafe("SELECT $value AS value", [counting]), [{ value: 1 }]);
    assert.equal(reads, 1);

    // A detached buffer cannot be measured, so it goes to a fresh statement just like a native one.
    const view = new DataView(new ArrayBuffer(8));
    structuredClone(view.buffer, { transfer: [view.buffer] });
    const database = new NodeSqlite.DatabaseSync(":memory:");
    const expected = database
      .prepare("SELECT length(?) AS size")
      .all(view as never)
      .map((row) => ({ ...row }));
    database.close();
    const actual = (yield* sql`SELECT length(${view as never}) AS size`).map((row) => ({
      ...row,
    }));
    assert.deepEqual(actual, expected);
  }).pipe(Effect.provide(SqliteClient.layerMemory())),
);

const withTempDatabase = <A, E, R>(
  use: (filename: string, blocker: NodeSqlite.DatabaseSync) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "piedpiper-sqlite-" });
    const filename = path.join(directory, "state.sqlite");
    const blocker = yield* Effect.acquireRelease(
      Effect.sync(() => new NodeSqlite.DatabaseSync(filename)),
      (database) => Effect.sync(() => database.close()),
    );
    return yield* use(filename, blocker);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.effect(
  "recovers a prepared query immediately after an exclusive database lock is released",
  () =>
    withTempDatabase((filename, blocker) =>
      Effect.gen(function* () {
        blocker.exec("CREATE TABLE entries(value TEXT); INSERT INTO entries VALUES ('retained')");
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          blocker.exec("BEGIN EXCLUSIVE");
          const select = sql`SELECT value FROM entries`;
          const error = yield* select.values.pipe(Effect.flip);
          assert.equal(error._tag, "SqlError");
          assert.equal(error.reason.operation, "prepare");
          assert.equal(error.reason._tag, "LockTimeoutError");
          blocker.exec("ROLLBACK");
          // A memoized failure would make this fail again for the cache TTL.
          assert.deepEqual(yield* select.values, [["retained"]]);
          assert.deepEqual(yield* select, [{ value: "retained" }]);
        }).pipe(Effect.provide(SqliteClient.layer({ filename })));
      }),
    ),
);

it.effect("takes the write lock when a transaction begins", () =>
  withTempDatabase((filename, blocker) =>
    Effect.gen(function* () {
      // In WAL mode readers do not block writers, so only BEGIN IMMEDIATE keeps the blocker out.
      blocker.exec("PRAGMA journal_mode = WAL; CREATE TABLE entries(value TEXT)");
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`SELECT value FROM entries`;
            // Another connection cannot commit between our read and our write.
            assert.throws(
              () => blocker.exec("INSERT INTO entries VALUES ('other')"),
              /database is locked/,
            );
            yield* sql`INSERT INTO entries VALUES (${"ours"})`;
          }),
        );
        blocker.exec("INSERT INTO entries VALUES ('other')");
        assert.deepEqual(yield* sql`SELECT value FROM entries ORDER BY rowid`.values, [
          ["ours"],
          ["other"],
        ]);
      }).pipe(Effect.provide(SqliteClient.layer({ filename })));
    }),
  ),
);

it.effect("reports a transaction blocked by another writer as a lock timeout", () =>
  withTempDatabase((filename, blocker) =>
    Effect.gen(function* () {
      blocker.exec(
        "PRAGMA journal_mode = WAL; CREATE TABLE entries(value TEXT); INSERT INTO entries VALUES ('retained')",
      );
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`PRAGMA busy_timeout = 0`;
        const read = sql.withTransaction(sql`SELECT value FROM entries`.values);
        blocker.exec("BEGIN IMMEDIATE");
        const error = yield* read.pipe(Effect.flip);
        assert.equal(error._tag, "SqlError");
        assert.equal(error.reason._tag, "LockTimeoutError");
        blocker.exec("COMMIT");
        assert.deepEqual(yield* read, [["retained"]]);
      }).pipe(Effect.provide(SqliteClient.layer({ filename })));
    }),
  ),
);

// One fiber op per step, so sweeping the count moves the scheduler's fixed-op yield through every gap.
const burnOps = (count: number): Effect.Effect<void> => {
  let effect: Effect.Effect<void> = Effect.void;
  for (let step = 0; step < count; step += 1) {
    const next = effect;
    effect = Effect.suspend(() => next);
  }
  return effect;
};

it.effect(
  "keeps standalone statements out of another fiber's transaction at every yield offset",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE swept(value INTEGER)`;
      const offsets = 2200;
      for (let offset = 0; offset < offsets; offset += 1) {
        const standalone = yield* Effect.forkChild(
          burnOps(offset).pipe(Effect.andThen(sql`INSERT INTO swept VALUES (${offset})`)),
          { startImmediately: true },
        );
        const rolledBack = yield* Effect.forkChild(
          sql
            .withTransaction(Effect.yieldNow.pipe(Effect.andThen(Effect.fail("rollback"))))
            .pipe(Effect.flip),
          { startImmediately: true },
        );
        yield* Fiber.join(standalone);
        assert.equal(yield* Fiber.join(rolledBack), "rollback");
      }
      const rows = yield* sql<{ readonly total: number }>`SELECT COUNT(*) AS total FROM swept`;
      assert.equal(rows[0]?.total, offsets);
    }).pipe(Effect.provide(SqliteClient.layerMemory())),
);

const holdConnection = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const held = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const holder = yield* Effect.forkChild(
      sql.withTransaction(
        Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
      ),
      { startImmediately: true },
    );
    yield* Deferred.await(held);
    return { holder, release };
  });

it.effect("lets a caller cancel a standalone statement waiting for the connection", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE cancelled(value INTEGER)`;
    const { holder, release } = yield* holdConnection(sql);
    const waiter = yield* Effect.forkChild(sql`INSERT INTO cancelled VALUES (1)`, {
      startImmediately: true,
    });
    yield* Effect.yieldNow;
    // Returns while the connection is still held, so the wait itself was interrupted.
    yield* Fiber.interrupt(waiter);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(holder);
    // The cancelled waiter gave back its place: the connection is free and nothing was written.
    assert.deepEqual(yield* sql`SELECT value FROM cancelled`.values, []);
  }).pipe(Effect.provide(SqliteClient.layerMemory())),
);

it.effect("keeps a masked statement waiting for the connection until it has run", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE masked(value INTEGER)`;
    const { holder, release } = yield* holdConnection(sql);
    const waiter = yield* Effect.forkChild(
      Effect.uninterruptible(sql`INSERT INTO masked VALUES (1)`),
      { startImmediately: true },
    );
    const interrupting = yield* Effect.forkChild(Fiber.interrupt(waiter), {
      startImmediately: true,
    });
    yield* Effect.yieldNow;
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(holder);
    yield* Fiber.join(interrupting);
    assert.deepEqual(yield* sql`SELECT value FROM masked`.values, [[1]]);
  }).pipe(Effect.provide(SqliteClient.layerMemory())),
);

it.effect("finishes masked database cleanup after its caller is interrupted", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE cleanup_writes(value INTEGER PRIMARY KEY)`;
    const entered = yield* Deferred.make<void>();
    const work = yield* Effect.forkChild(
      Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() =>
          Effect.gen(function* () {
            yield* sql`INSERT INTO cleanup_writes VALUES (1)`;
            yield* sql.withTransaction(sql`INSERT INTO cleanup_writes VALUES (2)`);
          }),
        ),
      ),
      { startImmediately: true },
    );
    yield* Deferred.await(entered);
    yield* Fiber.interrupt(work);
    assert.deepEqual(yield* sql`SELECT value FROM cleanup_writes ORDER BY value`.values, [
      [1],
      [2],
    ]);
  }).pipe(Effect.provide(SqliteClient.layerMemory())),
);
