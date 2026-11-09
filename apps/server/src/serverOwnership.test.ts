// @effect-diagnostics nodeBuiltinImport:off -- the other server has to be a real process holding a real lock.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import { SERVER_EXIT_CODE_STATE_DIR_OWNED } from "@piedpiper/shared/serverExitCodes";
import { Effect, Exit, Layer, Runtime, Scope } from "effect";
import { afterEach, beforeEach, describe } from "vitest";

import {
  acquireServerOwnership,
  formatServerOwnerOrigin,
  ServerAlreadyRunningError,
  ServerOwnershipError,
  SERVER_OWNER_LOCK_FILE,
  SERVER_RUNTIME_RECORD_FILE,
} from "./serverOwnership.ts";

let stateDir = "";
const children: NodeChildProcess.ChildProcess[] = [];

beforeEach(() => {
  stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "piedpiper-ownership-"));
});

afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  NodeFS.rmSync(stateDir, { recursive: true, force: true });
});

const recordPath = () => NodePath.join(stateDir, SERVER_RUNTIME_RECORD_FILE);
const lockPath = () => NodePath.join(stateDir, SERVER_OWNER_LOCK_FILE);

/** Runs a process that holds the same lock, printing `locked` once it does. */
const spawnLockHolder = (path = lockPath()) =>
  Effect.callback<NodeChildProcess.ChildProcess>((resume) => {
    const script = `
      const { DatabaseSync } = require("node:sqlite");
      const database = new DatabaseSync(${JSON.stringify(path)});
      database.exec("BEGIN EXCLUSIVE");
      console.log("locked");
      setInterval(() => {}, 1000);
    `;
    const child = NodeChildProcess.spawn(process.execPath, ["-e", script], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    children.push(child);
    child.stdout.once("data", () => resume(Effect.succeed(child)));
  });

const killAndWait = (child: NodeChildProcess.ChildProcess, signal: NodeJS.Signals) =>
  Effect.callback<void>((resume) => {
    child.once("exit", () => resume(Effect.void));
    child.kill(signal);
  });

describe("acquireServerOwnership", () => {
  it.effect("refuses while another process owns the directory, with the shared exit code", () =>
    Effect.gen(function* () {
      yield* spawnLockHolder();
      const error = yield* acquireServerOwnership({ stateDir }).pipe(Effect.scoped, Effect.flip);
      assert.instanceOf(error, ServerAlreadyRunningError);
      assert.equal(Runtime.getErrorExitCode(error), SERVER_EXIT_CODE_STATE_DIR_OWNED);
      assert.include(error.message, stateDir);
    }),
  );

  it.effect("acquires after the owner is killed with SIGKILL, and never unlinks the lock", () =>
    Effect.gen(function* () {
      const owner = yield* spawnLockHolder();
      yield* acquireServerOwnership({ stateDir }).pipe(Effect.scoped, Effect.flip);
      yield* killAndWait(owner, "SIGKILL");

      yield* acquireServerOwnership({ stateDir }).pipe(Effect.scoped);
      assert.isTrue(NodeFS.existsSync(lockPath()));
    }),
  );

  it.effect("releases on scope close, so repeated acquisitions on one directory succeed", () =>
    Effect.gen(function* () {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        yield* acquireServerOwnership({ stateDir }).pipe(Effect.scoped);
      }
    }),
  );

  it.effect("still acquires when the runtime record cannot be written", () =>
    Effect.gen(function* () {
      NodeFS.mkdirSync(stateDir, { recursive: true });
      NodeFS.writeFileSync(recordPath(), "{}\n", { mode: 0o444 });
      yield* acquireServerOwnership({ stateDir }).pipe(Effect.scoped);
    }),
  );

  it.effect("releases the lock even when the record cannot be removed", () =>
    Effect.gen(function* () {
      NodeFS.mkdirSync(recordPath(), { recursive: true });
      yield* acquireServerOwnership({ stateDir }).pipe(Effect.scoped);
      yield* acquireServerOwnership({ stateDir }).pipe(Effect.scoped);
    }),
  );

  it.effect("refuses a second owner in the same process until the first scope closes", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      yield* acquireServerOwnership({ stateDir }).pipe(Scope.provide(scope));

      const error = yield* acquireServerOwnership({ stateDir }).pipe(Effect.scoped, Effect.flip);
      assert.instanceOf(error, ServerAlreadyRunningError);

      yield* Scope.close(scope, Exit.void);
      yield* acquireServerOwnership({ stateDir }).pipe(Effect.scoped);
    }),
  );

  it.effect("holds the lock for the life of a layer built from it", () =>
    Effect.gen(function* () {
      // Built afresh each time because layers are memoized per object within a fiber.
      const makeLayer = () =>
        Layer.unwrap(
          Effect.gen(function* () {
            yield* acquireServerOwnership({ stateDir });
            return Layer.empty;
          }),
        );
      const scope = yield* Scope.make();
      yield* Layer.buildWithScope(makeLayer(), scope);
      const refused = yield* Layer.build(makeLayer()).pipe(Effect.scoped, Effect.flip);
      assert.instanceOf(refused, ServerAlreadyRunningError);

      yield* Scope.close(scope, Exit.void);
      yield* Layer.build(makeLayer()).pipe(Effect.scoped);
    }),
  );

  it.effect("creates a missing state directory", () =>
    Effect.gen(function* () {
      const nested = NodePath.join(stateDir, "does", "not", "exist");
      yield* acquireServerOwnership({ stateDir: nested }).pipe(Effect.scoped);
      assert.isTrue(NodeFS.existsSync(NodePath.join(nested, SERVER_OWNER_LOCK_FILE)));
    }),
  );

  it.effect("reports a failure other than busy as an ownership error, not a running server", () =>
    Effect.gen(function* () {
      // A directory where the lock file belongs cannot be opened as a database.
      NodeFS.mkdirSync(lockPath());
      const error = yield* acquireServerOwnership({ stateDir }).pipe(Effect.scoped, Effect.flip);
      assert.instanceOf(error, ServerOwnershipError);
      assert.equal(Runtime.getErrorExitCode(error), 1);
    }),
  );

  it.effect(
    "names the live owner from its record, without any token, and removes it on release",
    () =>
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        yield* acquireServerOwnership({ stateDir, host: "127.0.0.1", port: 3773 }).pipe(
          Scope.provide(scope),
        );
        assert.deepEqual(JSON.parse(NodeFS.readFileSync(recordPath(), "utf8")), {
          pid: process.pid,
          origin: "http://127.0.0.1:3773",
        });

        const error = yield* acquireServerOwnership({ stateDir }).pipe(Effect.scoped, Effect.flip);
        assert.instanceOf(error, ServerAlreadyRunningError);
        assert.include(error.message, `pid ${process.pid}, http://127.0.0.1:3773`);

        yield* Scope.close(scope, Exit.void);
        assert.isFalse(NodeFS.existsSync(recordPath()));
      }),
  );

  it.effect("ignores a stale record left by a dead process when refusing", () =>
    Effect.gen(function* () {
      const dead = yield* spawnLockHolder();
      const deadPid = dead.pid as number;
      yield* killAndWait(dead, "SIGKILL");
      NodeFS.writeFileSync(recordPath(), JSON.stringify({ pid: deadPid, origin: "http://old" }));

      yield* spawnLockHolder();
      const error = yield* acquireServerOwnership({ stateDir }).pipe(Effect.scoped, Effect.flip);
      assert.instanceOf(error, ServerAlreadyRunningError);
      assert.notInclude(error.message, "http://old");
    }),
  );

  it.effect(
    "ignores a damaged record when refusing, and replaces it once it owns the directory",
    () =>
      Effect.gen(function* () {
        NodeFS.writeFileSync(recordPath(), "{not json");
        const owner = yield* spawnLockHolder();
        const error = yield* acquireServerOwnership({ stateDir }).pipe(Effect.scoped, Effect.flip);
        assert.instanceOf(error, ServerAlreadyRunningError);
        assert.notInclude(error.message, "pid");

        yield* killAndWait(owner, "SIGKILL");
        const scope = yield* Scope.make();
        yield* acquireServerOwnership({ stateDir }).pipe(Scope.provide(scope));
        assert.equal(JSON.parse(NodeFS.readFileSync(recordPath(), "utf8")).pid, process.pid);
        yield* Scope.close(scope, Exit.void);
      }),
  );
});

const serverRoot = NodePath.resolve(import.meta.dirname, "..");
const bunIsAvailable = NodeChildProcess.spawnSync("bun", ["--version"]).status === 0;

/** Runs bun in apps/server to its exit, collecting everything it prints. */
const runBun = (args: ReadonlyArray<string>) =>
  Effect.callback<{ readonly code: number | null; readonly output: string }>((resume) => {
    const { VITE_DEV_SERVER_URL: _devUrl, ...env } = process.env;
    const child = NodeChildProcess.spawn("bun", args, {
      cwd: serverRoot,
      env: { ...env, PIEDPIPER_TELEMETRY_ENABLED: "false" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    let output = "";
    child.stdout.on("data", (chunk) => (output += String(chunk)));
    child.stderr.on("data", (chunk) => (output += String(chunk)));
    child.once("close", (code) => resume(Effect.succeed({ code, output })));
  });

describe.skipIf(!bunIsAvailable)("server process under Bun", () => {
  it.effect(
    "refuses a real second server with the shared exit code, then re-acquires after SIGKILL",
    () =>
      Effect.gen(function* () {
        const userData = NodePath.join(stateDir, "userdata");
        NodeFS.mkdirSync(userData);
        const owner = yield* spawnLockHolder(NodePath.join(userData, SERVER_OWNER_LOCK_FILE));

        const refused = yield* runBun([
          "src/bin.ts",
          "--base-dir",
          stateDir,
          "--no-browser",
          "--port",
          "39871",
        ]);
        assert.equal(refused.code, SERVER_EXIT_CODE_STATE_DIR_OWNED);
        assert.include(refused.output, "ServerAlreadyRunningError");

        yield* killAndWait(owner, "SIGKILL");
        const script = `
          import { Effect } from "effect";
          import { acquireServerOwnership } from "./src/serverOwnership.ts";
          const acquire = acquireServerOwnership({ stateDir: ${JSON.stringify(userData)} });
          await Effect.runPromise(acquire.pipe(Effect.scoped));
          console.log("acquired on bun " + process.versions.bun);
        `;
        const acquired = yield* runBun(["-e", script]);
        assert.equal(acquired.code, 0, acquired.output);
        assert.include(acquired.output, "acquired on bun");
      }),
    60_000,
  );
});

describe("formatServerOwnerOrigin", () => {
  it("uses localhost for wildcard or missing hosts", () => {
    assert.equal(formatServerOwnerOrigin(undefined, 3773), "http://localhost:3773");
    assert.equal(formatServerOwnerOrigin("0.0.0.0", 3773), "http://localhost:3773");
    assert.equal(formatServerOwnerOrigin("::", 3773), "http://localhost:3773");
  });

  it("keeps a specific host and brackets IPv6", () => {
    assert.equal(formatServerOwnerOrigin("10.0.0.5", 80), "http://10.0.0.5:80");
    assert.equal(formatServerOwnerOrigin("fd00::1", 80), "http://[fd00::1]:80");
  });
});
