// @effect-diagnostics nodeBuiltinImport:off -- the lock is a native SQLite handle held for the server's lifetime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { SERVER_EXIT_CODE_STATE_DIR_OWNED } from "@piedpiper/shared/serverExitCodes";
import { Effect, Runtime, Schema } from "effect";

export const SERVER_OWNER_LOCK_FILE = "server-owner.sqlite";
export const SERVER_RUNTIME_RECORD_FILE = "server-runtime.json";

const ServerRuntimeRecord = Schema.Struct({
  pid: Schema.Number,
  origin: Schema.optional(Schema.String),
});
type ServerRuntimeRecord = typeof ServerRuntimeRecord.Type;

export class ServerAlreadyRunningError extends Schema.TaggedErrorClass<ServerAlreadyRunningError>()(
  "ServerAlreadyRunningError",
  {
    stateDir: Schema.String,
    owner: Schema.optional(ServerRuntimeRecord),
  },
) {
  // A distinct exit code lets the desktop shell stop treating this as a crash.
  override readonly [Runtime.errorExitCode] = SERVER_EXIT_CODE_STATE_DIR_OWNED;

  override get message(): string {
    const owner = this.owner
      ? ` (pid ${this.owner.pid}${this.owner.origin ? `, ${this.owner.origin}` : ""})`
      : "";
    return `Another Pied Piper server${owner} already owns ${this.stateDir}. Stop that server or set a different PIEDPIPER_HOME, then retry. No server was stopped. ${SERVER_OWNER_LOCK_FILE} is the ownership lock; do not delete it while a server is running.`;
  }
}

export class ServerOwnershipError extends Schema.TaggedErrorClass<ServerOwnershipError>()(
  "ServerOwnershipError",
  {
    stateDir: Schema.String,
    cause: Schema.Defect,
  },
) {
  override get message(): string {
    return `Could not acquire server ownership of ${this.stateDir}.`;
  }
}

interface LockDatabase {
  exec(sql: string): void;
  close(): void;
}

// Computed so bundlers leave Bun's builtin alone; each runtime only ever loads its own driver.
const BUN_SQLITE_MODULE = "bun:sqlite";

async function openLockDatabase(path: string): Promise<LockDatabase> {
  if (process.versions.bun !== undefined) {
    const { Database } = (await import(
      /* @vite-ignore */ BUN_SQLITE_MODULE
    )) as typeof import("bun:sqlite");
    const database = new Database(path, { create: true });
    return { exec: (sql) => void database.run(sql), close: () => database.close() };
  }
  const { DatabaseSync } = await import("node:sqlite");
  return new DatabaseSync(path);
}

async function lockExclusively(path: string): Promise<LockDatabase> {
  const database = await openLockDatabase(path);
  try {
    database.exec("PRAGMA busy_timeout = 0");
    database.exec("BEGIN EXCLUSIVE");
    return database;
  } catch (cause) {
    database.close();
    throw cause;
  }
}

function isSqliteBusy(cause: unknown): boolean {
  if (typeof cause !== "object" || cause === null) return false;
  // node:sqlite reports `errcode`, bun:sqlite a `code` string; extended codes keep 5 in the low byte.
  if ("errcode" in cause && typeof cause.errcode === "number" && (cause.errcode & 0xff) === 5) {
    return true;
  }
  return "code" in cause && typeof cause.code === "string" && cause.code.startsWith("SQLITE_BUSY");
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    // EPERM: the process exists but belongs to someone else.
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
}

const decodeRecord = Schema.decodeUnknownOption(Schema.fromJsonString(ServerRuntimeRecord));

/** Only improves the refusal message; a missing, damaged or stale record just leaves it generic. */
function readLiveOwnerRecord(recordPath: string): ServerRuntimeRecord | undefined {
  let contents: string;
  try {
    contents = NodeFS.readFileSync(recordPath, "utf8");
  } catch {
    return undefined;
  }
  const decoded = decodeRecord(contents);
  if (decoded._tag === "None" || !isProcessAlive(decoded.value.pid)) return undefined;
  return decoded.value;
}

/** Where a browser reaches this server. Wildcard binds are reached through localhost. */
export function formatServerOwnerOrigin(host: string | undefined, port: number): string {
  const reachable =
    host === undefined || host === "" || host === "0.0.0.0" || host === "::" || host === "[::]"
      ? "localhost"
      : host;
  const bracketed = reachable.includes(":") && !reachable.startsWith("[");
  return `http://${bracketed ? `[${reachable}]` : reachable}:${port}`;
}

/**
 * Holds an exclusive transaction on `<stateDir>/server-owner.sqlite` until the scope closes. The
 * file never holds data and is never unlinked: the OS drops the lock when the process exits, even
 * on SIGKILL, so a crashed owner cannot block the next start. Do not open the file through any
 * other API while the lock is held, since closing another descriptor drops POSIX locks.
 */
export const acquireServerOwnership = Effect.fn("acquireServerOwnership")(function* (input: {
  readonly stateDir: string;
  readonly host?: string | undefined;
  readonly port?: number | undefined;
}) {
  const { stateDir } = input;
  const lockPath = NodePath.join(stateDir, SERVER_OWNER_LOCK_FILE);
  const recordPath = NodePath.join(stateDir, SERVER_RUNTIME_RECORD_FILE);

  yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        NodeFS.mkdirSync(stateDir, { recursive: true });
        return await lockExclusively(lockPath);
      },
      catch: (cause) =>
        isSqliteBusy(cause)
          ? new ServerAlreadyRunningError({
              stateDir,
              owner: readLiveOwnerRecord(recordPath),
            })
          : new ServerOwnershipError({ stateDir, cause }),
    }),
    (database) =>
      Effect.sync(() => {
        // Removed while still holding the lock, so this can never erase the next owner's record.
        // Before the close, so the next owner's record cannot be erased; a failed remove must not
        // keep the lock held.
        try {
          NodeFS.rmSync(recordPath, { force: true });
        } catch {
          // The record only improves a refusal message, and a stale one reads as such.
        }
        database.close();
      }).pipe(Effect.ignore),
  );

  const record: ServerRuntimeRecord = {
    pid: process.pid,
    ...(input.port !== undefined
      ? { origin: formatServerOwnerOrigin(input.host, input.port) }
      : {}),
  };
  // Effect.try: a throw inside Effect.sync is a defect, which Effect.ignore would not catch.
  yield* Effect.try({
    try: () => NodeFS.writeFileSync(recordPath, `${JSON.stringify(record)}\n`, { mode: 0o600 }),
    catch: () => undefined,
  }).pipe(Effect.ignore);
});
