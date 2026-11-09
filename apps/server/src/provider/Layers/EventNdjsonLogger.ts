/**
 * Provider event logger helper.
 *
 * Best-effort writer for observability logs. Each record is formatted as a
 * single effect-style text line in a thread-scoped file. Failures are
 * downgraded to warnings so provider runtime behavior is unaffected.
 *
 * Every logger created for the same directory (native, canonical, ...) shares
 * one store, so a thread file has exactly one rotating sink and rotations
 * cannot race. The store bounds each record before serialization, evicts idle
 * thread writers, and periodically prunes the directory by age and total size.
 */
import type { Dirent } from "node:fs";
import fsPromises, { mkdir } from "node:fs/promises";
import path from "node:path";

import type { ThreadId } from "@piedpiper/contracts";
import { makeAsyncRotatingFileSink } from "@piedpiper/shared/logging";
import { Clock, Effect, Exit, Result, Scope } from "effect";
import * as Semaphore from "effect/Semaphore";

import { toSafeThreadAttachmentSegment } from "../../attachmentStore.ts";

const MEBIBYTE = 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_BYTES = 10 * MEBIBYTE;
const DEFAULT_MAX_FILES = 10;
const DEFAULT_BATCH_WINDOW_MS = 200;
const DEFAULT_MAX_TOTAL_BYTES = 500 * MEBIBYTE;
const DEFAULT_MAX_AGE_MS = 14 * DAY_MS;
const DEFAULT_RETENTION_CHECK_INTERVAL_MS = 5 * 60 * 1_000;
const DEFAULT_IDLE_WRITER_MS = 5 * 60 * 1_000;
/** Records within these limits are written verbatim. */
const MAX_RECORD_CHARACTERS = 64 * 1024;
const MAX_RECORD_FIELDS = 1_024;
const MAX_RECORD_DEPTH = 16;
/** Serialized size above which a bounded record is reduced again. */
const MAX_RECORD_BYTES = 256 * 1024;
const GLOBAL_THREAD_SEGMENT = "_global";
const LOG_SCOPE = "provider-observability";
const LOG_FILE_PATTERN = /\.log(?:\.\d+)?$/u;
/** Every line this module writes starts with this header, so retention only touches its own files. */
const LOG_LINE_HEADER_PATTERN =
  /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] (?:NTIVE|CANON): /u;
const LOG_LINE_HEADER_PROBE_BYTES = 64;

export type EventNdjsonStream = "native" | "canonical" | "orchestration";

export interface EventNdjsonLogger {
  readonly filePath: string;
  write: (event: unknown, threadId: ThreadId | null) => Effect.Effect<void>;
  close: () => Effect.Effect<void>;
}

/**
 * Retention only removes files whose first line carries this module's header, but the log
 * directory should still be dedicated to provider event logs.
 */
export interface EventNdjsonLoggerOptions {
  readonly stream: EventNdjsonStream;
  readonly maxBytes?: number;
  readonly maxFiles?: number;
  readonly batchWindowMs?: number;
  /** Cap on the combined size of every log file in the directory. */
  readonly maxTotalBytes?: number;
  /** Log files not modified for longer than this are removed. */
  readonly maxAgeMs?: number;
  readonly retentionCheckIntervalMs?: number;
  /** Thread writers without a write for this long are flushed and released. */
  readonly idleWriterMs?: number;
}

export interface TruncationLimits {
  readonly maxStringCharacters: number;
  readonly maxFields: number;
  readonly maxArrayItems: number;
  readonly maxDepth: number;
}

const DEFAULT_TRUNCATION: TruncationLimits = {
  maxStringCharacters: 4_096,
  maxFields: MAX_RECORD_FIELDS,
  maxArrayItems: 256,
  maxDepth: MAX_RECORD_DEPTH,
};

const COMPACT_TRUNCATION: TruncationLimits = {
  maxStringCharacters: 256,
  maxFields: 128,
  maxArrayItems: 16,
  maxDepth: 8,
};

interface ResolvedStoreOptions {
  readonly maxBytes: number;
  readonly maxFiles: number;
  readonly batchWindowMs: number;
  readonly maxTotalBytes: number;
  readonly maxAgeMs: number;
  readonly retentionCheckIntervalMs: number;
  readonly idleWriterMs: number;
}

interface ThreadWriter {
  readonly filePath: string;
  lastWriteAt: number;
  /** Buffers the line; false when the writer is already closed and the line was not taken. */
  writeLine: (line: string) => Effect.Effect<boolean>;
  close: () => Effect.Effect<void>;
}

interface EventLogStore {
  readonly directory: string;
  write: (threadSegment: string, line: string) => Effect.Effect<void>;
  close: () => Effect.Effect<void>;
}

export interface RetentionFailure {
  readonly filePath: string;
  readonly cause: unknown;
}

function logWarning(message: string, context: Record<string, unknown>): Effect.Effect<void> {
  return Effect.logWarning(message, context).pipe(Effect.annotateLogs({ scope: LOG_SCOPE }));
}

function resolveThreadSegment(raw: string | null | undefined): string {
  const normalized = typeof raw === "string" ? toSafeThreadAttachmentSegment(raw) : null;
  return normalized ?? GLOBAL_THREAD_SEGMENT;
}

function resolveStreamLabel(stream: EventNdjsonStream): string {
  switch (stream) {
    case "native":
      return "NTIVE";
    case "canonical":
    case "orchestration":
    default:
      return "CANON";
  }
}

/** True when the record can be serialized verbatim within the size, field, depth and cycle limits. */
function fitsLogRecord(event: unknown): boolean {
  let remainingCharacters = MAX_RECORD_CHARACTERS;
  let remainingFields = MAX_RECORD_FIELDS;
  const ancestors = new WeakSet<object>();
  const fits = (value: unknown, depth: number): boolean => {
    if (typeof value === "string") {
      remainingCharacters -= value.length;
      return remainingCharacters >= 0;
    }
    if (typeof value !== "object" || value === null) return true;
    if (depth > MAX_RECORD_DEPTH || ancestors.has(value)) return false;
    if (Array.isArray(value) && value.length > remainingFields) return false;
    ancestors.add(value);
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      remainingFields -= 1;
      remainingCharacters -= key.length;
      if (
        remainingFields < 0 ||
        remainingCharacters < 0 ||
        !fits(Reflect.get(value, key), depth + 1)
      ) {
        return false;
      }
    }
    ancestors.delete(value);
    return true;
  };
  try {
    return fits(event, 0);
  } catch {
    return false;
  }
}

/**
 * Builds a bounded copy of a record: long strings are cut, arrays and field
 * counts are capped, deep nesting and cycles are replaced with markers.
 */
export function truncateEventForLogging(
  event: unknown,
  limits: TruncationLimits = DEFAULT_TRUNCATION,
): unknown {
  let remainingFields = limits.maxFields;
  const ancestors = new WeakSet<object>();
  const visit = (value: unknown, depth: number): unknown => {
    if (typeof value === "string") {
      if (value.length <= limits.maxStringCharacters) return value;
      const omitted = value.length - limits.maxStringCharacters;
      return `${value.slice(0, limits.maxStringCharacters)}…[truncated ${omitted} chars]`;
    }
    if (typeof value !== "object" || value === null) return value;
    if (depth >= limits.maxDepth) return "[depth limit]";
    if (ancestors.has(value)) return "[circular]";
    const toJSON = Reflect.get(value, "toJSON");
    if (typeof toJSON === "function") {
      return visit(Reflect.apply(toJSON, value, []), depth + 1);
    }
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        const items: Array<unknown> = [];
        for (const item of value.slice(0, limits.maxArrayItems)) {
          remainingFields -= 1;
          if (remainingFields < 0) {
            items.push("[truncated]");
            break;
          }
          items.push(visit(item, depth + 1));
        }
        if (value.length > limits.maxArrayItems) {
          items.push(`[+${value.length - limits.maxArrayItems} more items]`);
        }
        return items;
      }
      const copy: Record<string, unknown> = {};
      for (const key of Object.keys(value)) {
        remainingFields -= 1;
        if (remainingFields < 0) {
          copy["[truncated]"] = true;
          break;
        }
        copy[key] = visit(Reflect.get(value, key), depth + 1);
      }
      return copy;
    } finally {
      ancestors.delete(value);
    }
  };
  try {
    return visit(event, 0);
  } catch {
    return { truncated: true };
  }
}

/** Returns the record verbatim when it fits, otherwise a bounded copy. */
export function boundEventForLogging(event: unknown): unknown {
  return fitsLogRecord(event) ? event : truncateEventForLogging(event);
}

function serializeEvent(
  event: unknown,
): { ok: true; value: string | undefined } | { ok: false; error: unknown } {
  try {
    return { ok: true, value: JSON.stringify(event) };
  } catch (error) {
    return { ok: false, error };
  }
}

const toLogPayload = Effect.fn("toLogPayload")(function* (
  event: unknown,
): Effect.fn.Return<string | undefined> {
  let serialized = serializeEvent(boundEventForLogging(event));
  if (serialized.ok && serialized.value !== undefined) {
    // Escaping can expand strings past the character budget; reduce again if so.
    if (Buffer.byteLength(serialized.value) > MAX_RECORD_BYTES) {
      serialized = serializeEvent(truncateEventForLogging(event, COMPACT_TRUNCATION));
    }
  }
  if (!serialized.ok) {
    yield* logWarning("failed to serialize provider event log record", {
      error: serialized.error,
    });
    return undefined;
  }
  if (serialized.value !== undefined && Buffer.byteLength(serialized.value) > MAX_RECORD_BYTES) {
    yield* logWarning("dropped oversized provider event log record", {
      bytes: Buffer.byteLength(serialized.value),
    });
    return undefined;
  }
  return serialized.value;
});

async function hasProviderLogHeader(filePath: string): Promise<boolean> {
  const handle = await fsPromises.open(filePath, "r");
  try {
    const probe = Buffer.alloc(LOG_LINE_HEADER_PROBE_BYTES);
    const { bytesRead } = await handle.read(probe, 0, probe.length, 0);
    return LOG_LINE_HEADER_PATTERN.test(probe.toString("utf8", 0, bytesRead));
  } finally {
    await handle.close();
  }
}

export interface LogRetentionResult {
  readonly removed: ReadonlyArray<string>;
  readonly failures: ReadonlyArray<RetentionFailure>;
}

/**
 * Removes log files older than `maxAgeMs`, then the oldest remaining files
 * until the directory total is within `maxTotalBytes`. Files in
 * `activeFilePaths` (currently open sinks, checked again before each removal)
 * and files not written by this module are never removed.
 */
export async function enforceLogRetention(input: {
  readonly directory: string;
  readonly maxTotalBytes: number;
  readonly maxAgeMs: number;
  readonly activeFilePaths: Pick<ReadonlySet<string>, "has">;
  readonly now: number;
}): Promise<LogRetentionResult> {
  const failures: Array<RetentionFailure> = [];
  const removed: Array<string> = [];
  const files: Array<{ filePath: string; mtimeMs: number; size: number }> = [];

  let entries: ReadonlyArray<Dirent>;
  try {
    entries = await fsPromises.readdir(input.directory, { withFileTypes: true });
  } catch (cause) {
    return { removed, failures: [{ filePath: input.directory, cause }] };
  }

  for (const entry of entries) {
    if (!entry.isFile() || !LOG_FILE_PATTERN.test(entry.name)) continue;
    const filePath = path.join(input.directory, entry.name);
    try {
      const stat = await fsPromises.stat(filePath);
      if (!(await hasProviderLogHeader(filePath))) continue;
      files.push({ filePath, mtimeMs: stat.mtimeMs, size: stat.size });
    } catch (cause) {
      failures.push({ filePath, cause });
    }
  }

  let totalBytes = files.reduce((total, file) => total + file.size, 0);
  const remove = async (file: (typeof files)[number]): Promise<boolean> => {
    if (input.activeFilePaths.has(file.filePath)) return false;
    try {
      await fsPromises.rm(file.filePath, { force: true });
      totalBytes -= file.size;
      removed.push(file.filePath);
      return true;
    } catch (cause) {
      failures.push({ filePath: file.filePath, cause });
      return false;
    }
  };

  const retained: typeof files = [];
  for (const file of files) {
    if (input.now - file.mtimeMs <= input.maxAgeMs || !(await remove(file))) retained.push(file);
  }

  for (const file of retained.toSorted(
    (left, right) => left.mtimeMs - right.mtimeMs || left.filePath.localeCompare(right.filePath),
  )) {
    if (totalBytes <= input.maxTotalBytes) break;
    await remove(file);
  }

  return { removed, failures };
}

const makeThreadWriter = Effect.fn("makeThreadWriter")(function* (input: {
  readonly filePath: string;
  readonly maxBytes: number;
  readonly maxFiles: number;
  readonly batchWindowMs: number;
  readonly now: number;
}): Effect.fn.Return<ThreadWriter | undefined> {
  const sinkResult = yield* Effect.result(
    makeAsyncRotatingFileSink({
      filePath: input.filePath,
      maxBytes: input.maxBytes,
      maxFiles: input.maxFiles,
    }),
  );

  if (Result.isFailure(sinkResult)) {
    yield* logWarning("failed to initialize provider thread log file", {
      filePath: input.filePath,
      error: sinkResult.failure,
    });
    return undefined;
  }

  const sink = sinkResult.success;
  const scope = yield* Scope.make();
  // Serializes flushes so a close waits for an in-flight timer flush.
  const flushLock = yield* Semaphore.make(1);
  let pending: Array<string> = [];
  let flushScheduled = false;
  let closed = false;

  const flushPending = Effect.fn("makeThreadWriter.flush")(function* () {
    flushScheduled = false;
    if (pending.length === 0) return;
    const lines = pending;
    pending = [];
    // Group whole lines into chunks of at most maxBytes so rotation stays on line boundaries.
    let index = 0;
    while (index < lines.length) {
      let chunkBytes = Buffer.byteLength(lines[index]!);
      let nextIndex = index + 1;
      while (nextIndex < lines.length) {
        const lineBytes = Buffer.byteLength(lines[nextIndex]!);
        if (chunkBytes + lineBytes > input.maxBytes) break;
        chunkBytes += lineBytes;
        nextIndex += 1;
      }
      const written = yield* Effect.result(sink.write(lines.slice(index, nextIndex).join("")));
      if (Result.isFailure(written)) {
        yield* logWarning("provider event log batch flush failed", {
          filePath: input.filePath,
          error: written.failure,
        });
        return;
      }
      index = nextIndex;
    }
  });
  const flush = () => flushLock.withPermits(1)(flushPending()).pipe(Effect.uninterruptible);

  const writer: ThreadWriter = {
    filePath: input.filePath,
    lastWriteAt: input.now,
    // Not routed through Effect.log, so the server's minimum log level cannot drop lines.
    writeLine: Effect.fn("makeThreadWriter.writeLine")(function* (line: string) {
      if (closed) return false;
      pending.push(line);
      if (!flushScheduled) {
        // A timer per pending batch instead of a poller per open writer.
        flushScheduled = true;
        yield* Effect.sleep(input.batchWindowMs).pipe(
          Effect.andThen(flush()),
          Effect.forkIn(scope),
        );
      }
      return true;
    }),
    close: Effect.fn("makeThreadWriter.close")(function* () {
      if (closed) return;
      // Mark before yielding so no later write lands in this sink.
      closed = true;
      yield* flush();
      yield* Scope.close(scope, Exit.void);
    }),
  };
  return writer;
});

const makeEventLogStore = Effect.fn("makeEventLogStore")(function* (
  directory: string,
  options: ResolvedStoreOptions,
): Effect.fn.Return<EventLogStore> {
  const scope = yield* Scope.make();
  const threadWriters = new Map<string, ThreadWriter>();
  let failedSegments = new Set<string>();
  let closed = false;

  // Asynchronous, so writers can open while it runs; the live writer set is consulted per file.
  const runRetention = Effect.fn("runRetention")(function* (now: number) {
    const result = yield* Effect.promise(() =>
      enforceLogRetention({
        directory,
        maxTotalBytes: options.maxTotalBytes,
        maxAgeMs: options.maxAgeMs,
        activeFilePaths: {
          has: (filePath) => {
            for (const writer of threadWriters.values()) {
              if (writer.filePath === filePath) return true;
            }
            return false;
          },
        },
        now,
      }),
    );
    for (const failure of result.failures) {
      yield* logWarning("provider event log retention failed", { ...failure });
    }
  });

  const prune = Effect.fn("prune")(function* () {
    const now = yield* Clock.currentTimeMillis;
    for (const [segment, writer] of threadWriters) {
      if (now - writer.lastWriteAt < options.idleWriterMs) continue;
      threadWriters.delete(segment);
      yield* writer.close();
    }
    // Let a segment whose file could not be opened try again next cycle.
    failedSegments = new Set();
    yield* runRetention(now);
  });

  yield* runRetention(yield* Clock.currentTimeMillis);

  yield* Effect.sleep(options.retentionCheckIntervalMs).pipe(
    Effect.andThen(prune()),
    Effect.forever,
    Effect.forkIn(scope),
  );

  const resolveThreadWriter = Effect.fn("resolveThreadWriter")(function* (
    threadSegment: string,
  ): Effect.fn.Return<ThreadWriter | undefined> {
    if (failedSegments.has(threadSegment)) {
      return undefined;
    }
    const now = yield* Clock.currentTimeMillis;
    const existing = threadWriters.get(threadSegment);
    if (existing) {
      existing.lastWriteAt = now;
      return existing;
    }

    const writer = yield* makeThreadWriter({
      filePath: path.join(directory, `${threadSegment}.log`),
      maxBytes: options.maxBytes,
      maxFiles: options.maxFiles,
      batchWindowMs: options.batchWindowMs,
      now,
    });
    if (!writer) {
      failedSegments.add(threadSegment);
      return undefined;
    }
    // The store may have closed while this fiber was opening the writer.
    if (closed) {
      yield* writer.close();
      return undefined;
    }
    // Another fiber may have created the writer while this one was yielding.
    const raced = threadWriters.get(threadSegment);
    if (raced) {
      yield* writer.close();
      raced.lastWriteAt = now;
      return raced;
    }
    threadWriters.set(threadSegment, writer);
    return writer;
  });

  const write = Effect.fn("write")(function* (threadSegment: string, line: string) {
    // A writer evicted while this fiber held it refuses the line; retry with a fresh one.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (closed) return;
      const writer = yield* resolveThreadWriter(threadSegment);
      if (!writer) return;
      if (yield* writer.writeLine(line)) return;
      if (threadWriters.get(threadSegment) === writer) threadWriters.delete(threadSegment);
    }
  });

  const close = Effect.fn("close")(function* () {
    if (closed) return;
    closed = true;
    yield* Scope.close(scope, Exit.void);
    for (const writer of threadWriters.values()) {
      yield* writer.close();
    }
    threadWriters.clear();
  });

  return { directory, write, close } satisfies EventLogStore;
});

interface SharedStoreEntry {
  readonly store: EventLogStore;
  refCount: number;
}

// One store per log directory, shared by every logger (stream) writing into it.
const sharedStores = new Map<string, SharedStoreEntry>();

const acquireSharedStore = Effect.fn("acquireSharedStore")(function* (
  directory: string,
  options: ResolvedStoreOptions,
): Effect.fn.Return<SharedStoreEntry> {
  const existing = sharedStores.get(directory);
  if (existing) {
    existing.refCount += 1;
    return existing;
  }
  const store = yield* makeEventLogStore(directory, options);
  const raced = sharedStores.get(directory);
  if (raced) {
    yield* store.close();
    raced.refCount += 1;
    return raced;
  }
  const entry: SharedStoreEntry = { store, refCount: 1 };
  sharedStores.set(directory, entry);
  return entry;
});

const releaseSharedStore = Effect.fn("releaseSharedStore")(function* (
  directory: string,
  entry: SharedStoreEntry,
) {
  entry.refCount -= 1;
  if (entry.refCount > 0) return;
  if (sharedStores.get(directory) === entry) {
    sharedStores.delete(directory);
  }
  yield* entry.store.close();
});

const resolveStoreOptions = Effect.fn("resolveStoreOptions")(function* (
  options: EventNdjsonLoggerOptions,
): Effect.fn.Return<ResolvedStoreOptions> {
  const resolve = Effect.fn("resolveStoreOption")(function* (
    name: keyof ResolvedStoreOptions,
    minimum: number,
    fallback: number,
  ) {
    const value = options[name];
    if (value === undefined) return fallback;
    if (Number.isSafeInteger(value) && value >= minimum) return value;
    yield* logWarning("invalid provider event log option, using default", {
      option: name,
      value,
      default: fallback,
    });
    return fallback;
  });
  return {
    maxBytes: yield* resolve("maxBytes", 1, DEFAULT_MAX_BYTES),
    maxFiles: yield* resolve("maxFiles", 1, DEFAULT_MAX_FILES),
    batchWindowMs: yield* resolve("batchWindowMs", 0, DEFAULT_BATCH_WINDOW_MS),
    maxTotalBytes: yield* resolve("maxTotalBytes", 0, DEFAULT_MAX_TOTAL_BYTES),
    maxAgeMs: yield* resolve("maxAgeMs", 0, DEFAULT_MAX_AGE_MS),
    retentionCheckIntervalMs: yield* resolve(
      "retentionCheckIntervalMs",
      1,
      DEFAULT_RETENTION_CHECK_INTERVAL_MS,
    ),
    idleWriterMs: yield* resolve("idleWriterMs", 1, DEFAULT_IDLE_WRITER_MS),
  };
});

export const makeEventNdjsonLogger = Effect.fn("makeEventNdjsonLogger")(function* (
  filePath: string,
  options: EventNdjsonLoggerOptions,
): Effect.fn.Return<EventNdjsonLogger | undefined> {
  const streamLabel = resolveStreamLabel(options.stream);
  const directory = path.resolve(path.dirname(filePath));

  const directoryReady = yield* Effect.tryPromise(() =>
    mkdir(directory, { recursive: true }).then(
      () => ({ ok: true as const }),
      (error) => ({ ok: false as const, error }),
    ),
  ).pipe(Effect.catch((error) => Effect.succeed({ ok: false as const, error })));
  if (!directoryReady.ok) {
    yield* logWarning("failed to create provider event log directory", {
      filePath,
      error: directoryReady.error,
    });
    return undefined;
  }

  // The first logger opened for a directory decides the store's limits.
  const entry = yield* acquireSharedStore(directory, yield* resolveStoreOptions(options));
  let closed = false;

  const write = Effect.fn("write")(function* (event: unknown, threadId: ThreadId | null) {
    if (closed) return;
    const threadSegment = resolveThreadSegment(threadId);
    const payload = yield* toLogPayload(event);
    if (payload === undefined) {
      return;
    }
    const observedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
    yield* entry.store.write(threadSegment, `[${observedAt}] ${streamLabel}: ${payload}\n`);
  });

  const close = Effect.fn("close")(function* () {
    if (closed) return;
    closed = true;
    yield* releaseSharedStore(directory, entry);
  });

  return {
    filePath,
    write,
    close,
  } satisfies EventNdjsonLogger;
});
