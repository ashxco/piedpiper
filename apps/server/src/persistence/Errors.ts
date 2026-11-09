import { Predicate, Schema, SchemaIssue } from "effect";
import { isSqlError } from "effect/unstable/sql/SqlError";

function summarizeSchemaIssue(issue: SchemaIssue.Issue): string {
  switch (issue._tag) {
    case "Filter":
    case "Encoding":
    case "Pointer":
      return `${issue._tag}(${summarizeSchemaIssue(issue.issue)})`;
    case "Composite":
    case "AnyOf":
      return `${issue._tag}(${issue.issues.map(summarizeSchemaIssue).join(",")})`;
    default:
      return issue._tag;
  }
}

/** Reads the SQLite condition through SQL error wrappers, never the driver message. */
function sqliteCondition(cause: unknown): string | undefined {
  let value = cause;
  for (let depth = 0; depth < 4 && Predicate.isObject(value); depth += 1) {
    if (
      "errcode" in value &&
      typeof value.errcode === "number" &&
      "errstr" in value &&
      typeof value.errstr === "string"
    ) {
      return `SQLITE(${value.errcode}) ${value.errstr}`;
    }
    if (
      "name" in value &&
      value.name === "SQLiteError" &&
      "errno" in value &&
      typeof value.errno === "number" &&
      Number.isInteger(value.errno)
    ) {
      return `SQLITE(${value.errno})`;
    }
    value = "cause" in value ? value.cause : undefined;
  }
  return undefined;
}

// Schema failures contribute only issue tags so rejected payloads never reach diagnostics.
function describeSqlCause(cause: unknown): string | undefined {
  if (Schema.isSchemaError(cause)) return summarizeSchemaIssue(cause.issue);
  return sqliteCondition(cause);
}

// ===============================
// Core Persistence Errors
// ===============================

export class PersistenceSqlError extends Schema.TaggedErrorClass<PersistenceSqlError>()(
  "PersistenceSqlError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `SQL error in ${this.operation}: ${this.detail}`;
  }
}

export class PersistenceDecodeError extends Schema.TaggedErrorClass<PersistenceDecodeError>()(
  "PersistenceDecodeError",
  {
    operation: Schema.String,
    issue: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Decode error in ${this.operation}: ${this.issue}`;
  }
}

export function toPersistenceSqlError(operation: string) {
  return (cause: unknown): PersistenceSqlError =>
    new PersistenceSqlError({
      operation,
      detail: describeSqlCause(cause) ?? `Failed to execute ${operation}`,
      cause,
    });
}

export function toPersistenceDecodeError(operation: string) {
  return (error: Schema.SchemaError): PersistenceDecodeError =>
    new PersistenceDecodeError({
      operation,
      issue: SchemaIssue.makeFormatterDefault()(error.issue),
      cause: error,
    });
}

export function toPersistenceDecodeCauseError(operation: string) {
  return (cause: unknown): PersistenceDecodeError =>
    new PersistenceDecodeError({
      operation,
      issue: `Failed to execute ${operation}`,
      cause,
    });
}

export const isPersistenceError = (u: unknown) =>
  Schema.is(PersistenceSqlError)(u) || Schema.is(PersistenceDecodeError)(u);

const DATABASE_RECOVERY_MESSAGES: Readonly<Record<number, string>> = {
  5: "The Pied Piper database is busy (SQLITE_BUSY). Wait a moment, then retry. If this keeps happening, check for another Pied Piper process using the same data directory.",
  6: "The Pied Piper database is locked (SQLITE_LOCKED). Wait a moment, then retry. If this keeps happening, check the server logs for the process holding the lock.",
  8: "The Pied Piper database is read-only (SQLITE_READONLY). Check that the data directory is writable and its disk is mounted read-write, then retry.",
  10: "Pied Piper could not read or write its database (SQLITE_IOERR). Check free disk space and disk health, then retry. If it still fails, check the server logs.",
  11: "The Pied Piper database appears damaged (SQLITE_CORRUPT). Keep a copy of the data directory and check the server logs before restoring a backup.",
  13: "Pied Piper could not save this change because its database or disk is full (SQLITE_FULL). Free some disk space, then retry. If space is available, check the server logs for a database size limit.",
  14: "Pied Piper could not open a database file (SQLITE_CANTOPEN). Check free disk space and that the data and temporary directories exist and are writable, then retry. If it still fails, check the server logs.",
  26: "Pied Piper could not read its database file (SQLITE_NOTADB). Keep a copy of the data directory and check the configured database path and server logs before restoring a backup.",
};
const DATABASE_FALLBACK_MESSAGE =
  "Pied Piper could not complete this database request. Retry once; if it still fails, check the server logs for the database error.";

function sqliteResultCode(value: object): number | undefined {
  const code = "errcode" in value ? value.errcode : "errno" in value ? value.errno : undefined;
  return typeof code === "number" && Number.isInteger(code) && code > 0 ? code : undefined;
}

/**
 * Recovery steps for a persistence failure, or undefined when `cause` is not one. Never includes
 * driver text; `.message` stays the diagnostic form for logs.
 */
export function userFacingDatabaseErrorMessage(cause: unknown): string | undefined {
  let isDatabaseError = false;
  const seen = new Set<unknown>();
  for (let value = cause; Predicate.isObject(value) && !seen.has(value); ) {
    seen.add(value);
    isDatabaseError ||= isPersistenceError(value) || isSqlError(value);
    if (isDatabaseError) {
      const code = sqliteResultCode(value);
      // Extended result codes keep the primary code in the low byte.
      const message = code === undefined ? undefined : DATABASE_RECOVERY_MESSAGES[code & 0xff];
      if (message !== undefined) return message;
    }
    value = "cause" in value ? value.cause : undefined;
  }
  return isDatabaseError ? DATABASE_FALLBACK_MESSAGE : undefined;
}

// ===============================
// Provider Session Repository Errors
// ===============================

export class ProviderSessionRepositoryValidationError extends Schema.TaggedErrorClass<ProviderSessionRepositoryValidationError>()(
  "ProviderSessionRepositoryValidationError",
  {
    operation: Schema.String,
    issue: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Provider session repository validation failed in ${this.operation}: ${this.issue}`;
  }
}

export class ProviderSessionRepositoryPersistenceError extends Schema.TaggedErrorClass<ProviderSessionRepositoryPersistenceError>()(
  "ProviderSessionRepositoryPersistenceError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Provider session repository persistence error in ${this.operation}: ${this.detail}`;
  }
}

export type OrchestrationEventStoreError = PersistenceSqlError | PersistenceDecodeError;

export type ProviderSessionRepositoryError =
  | ProviderSessionRepositoryValidationError
  | ProviderSessionRepositoryPersistenceError;

export type OrchestrationCommandReceiptRepositoryError =
  | PersistenceSqlError
  | PersistenceDecodeError;

export type ProviderSessionRuntimeRepositoryError = PersistenceSqlError | PersistenceDecodeError;

export type ProjectionRepositoryError = PersistenceSqlError | PersistenceDecodeError;
