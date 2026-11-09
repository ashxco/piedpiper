import type {
  ServerTraceDiagnosticsFailureSummary,
  ServerTraceDiagnosticsLogEvent,
  ServerTraceDiagnosticsRecentFailure,
  ServerTraceDiagnosticsResult,
  ServerTraceDiagnosticsSpanOccurrence,
} from "@piedpiper/contracts";
import { DateTime, Effect, FileSystem, Result, Stream } from "effect";

const DEFAULT_SLOW_SPAN_THRESHOLD_MS = 1_000;
const TOP_LIMIT = 10;
const RECENT_LIMIT = 20;
// Keeps memory bounded when span names or failure causes are dynamic.
const MAX_TRACKED_KEYS = 5_000;
const MAX_CAUSE_LENGTH = 2_000;
// How Cause.pretty renders Effect's end-of-stream signal, which marks a stream that ended normally.
const END_OF_STREAM_LINE =
  /^Error: \{"~effect\/Cause\/Done":"~effect\/Cause\/Done","_tag":"Done".*\}$/;
const STACK_LINE = /^\s+at /;

export interface TraceDiagnosticsOptions {
  readonly traceFilePath: string;
  readonly maxFiles: number;
  readonly slowSpanThresholdMs?: number;
}

/** The trace file and its rotated backups (`.1` is the newest backup), oldest first. */
export function toRotatedTracePaths(
  traceFilePath: string,
  maxFiles: number,
): ReadonlyArray<string> {
  const backupCount = Math.max(0, Math.floor(maxFiles));
  return [
    ...Array.from({ length: backupCount }, (_, index) => `${traceFilePath}.${backupCount - index}`),
    traceFilePath,
  ];
}

/**
 * Feeds a file's lines to `onLine`, one chunk at a time, and fails on any read error. The appended
 * newline keeps a last line without one, which splitLines would otherwise drop uncounted.
 */
export const streamTraceFileLines = (
  fileSystem: FileSystem.FileSystem,
  path: string,
  onLine: (line: string) => void,
) =>
  fileSystem.stream(path).pipe(
    Stream.decodeText,
    Stream.concat(Stream.make("\n")),
    Stream.splitLines,
    Stream.runForEachArray((lines) => Effect.sync(() => lines.forEach((line) => onLine(line)))),
  );

const asRecord = (value: unknown): Readonly<Record<string, unknown>> | null =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;

const asText = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value : null;

function unixNanoToIso(value: unknown): string | null {
  const text = asText(value);
  if (!text) return null;
  try {
    const date = new Date(Number(BigInt(text) / 1_000_000n));
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  } catch {
    return null;
  }
}

/** True only when the end-of-stream signal is all the cause holds, so a real error is never hidden. */
function isEndOfStreamOnlyCause(cause: string | null): boolean {
  if (cause === null) return false;
  const lines = cause.trimEnd().split("\n");
  return (
    END_OF_STREAM_LINE.test(lines[0]!) &&
    lines.every((line) => END_OF_STREAM_LINE.test(line) || STACK_LINE.test(line))
  );
}

/** Keeps `items` sorted by `order` and at most `limit` long, whatever streams in. */
function insertBounded<A>(
  items: A[],
  item: A,
  limit: number,
  order: (left: A, right: A) => number,
): void {
  if (items.length >= limit && order(item, items[items.length - 1]!) >= 0) return;
  items.push(item);
  items.sort(order);
  if (items.length > limit) items.length = limit;
}

const newestFirst = (left: string, right: string) => (left === right ? 0 : left < right ? 1 : -1);

/** Spans that last as long as a client stays connected, so their duration says nothing about work. */
function isConnectionLifetimeSpan(
  name: string,
  attributes: Readonly<Record<string, unknown>> | null,
): boolean {
  return (
    name.startsWith("ws.rpc.subscribe") ||
    (name === "http.server GET" && attributes?.["url.path"] === "/ws")
  );
}

/** Folds trace NDJSON one line at a time, so no file is ever held in memory. */
export function makeTraceDiagnosticsAggregator(
  slowSpanThresholdMs = DEFAULT_SLOW_SPAN_THRESHOLD_MS,
) {
  let parseErrorCount = 0;
  let recordCount = 0;
  let failureCount = 0;
  let interruptionCount = 0;
  let slowSpanCount = 0;
  let firstSpanAt: string | null = null;
  let lastSpanAt: string | null = null;

  const spansByName = new Map<
    string,
    { count: number; failureCount: number; totalDurationMs: number; maxDurationMs: number }
  >();
  const failuresByKey = new Map<string, ServerTraceDiagnosticsFailureSummary>();
  const slowestSpans: ServerTraceDiagnosticsSpanOccurrence[] = [];
  const latestFailures: ServerTraceDiagnosticsRecentFailure[] = [];
  const latestLogs: ServerTraceDiagnosticsLogEvent[] = [];
  const logLevelCounts: Record<string, number> = {};

  const addLine = (line: string): void => {
    if (line.trim().length === 0) return;
    let parsed: Readonly<Record<string, unknown>> | null;
    try {
      parsed = asRecord(JSON.parse(line));
    } catch {
      parsed = null;
    }
    const name = asText(parsed?.name);
    const traceId = asText(parsed?.traceId);
    const spanId = asText(parsed?.spanId);
    const durationMs = parsed?.durationMs;
    const endedAt = unixNanoToIso(parsed?.endTimeUnixNano);
    if (
      !parsed ||
      !name ||
      !traceId ||
      !spanId ||
      typeof durationMs !== "number" ||
      !Number.isFinite(durationMs) ||
      !endedAt
    ) {
      parseErrorCount += 1;
      return;
    }

    recordCount += 1;
    const startedAt = unixNanoToIso(parsed.startTimeUnixNano);
    if (startedAt && (firstSpanAt === null || startedAt < firstSpanAt)) firstSpanAt = startedAt;
    if (lastSpanAt === null || endedAt > lastSpanAt) lastSpanAt = endedAt;

    const exit = asRecord(parsed.exit);
    const isFailure = exit?._tag === "Failure" && !isEndOfStreamOnlyCause(asText(exit.cause));
    if (isFailure) failureCount += 1;
    if (exit?._tag === "Interrupted") interruptionCount += 1;
    const isConnectionLifetime = isConnectionLifetimeSpan(name, asRecord(parsed.attributes));
    if (!isConnectionLifetime && durationMs >= slowSpanThresholdMs) slowSpanCount += 1;

    const span = spansByName.get(name);
    if (span) {
      span.count += 1;
      span.failureCount += isFailure ? 1 : 0;
      span.totalDurationMs += durationMs;
      span.maxDurationMs = Math.max(span.maxDurationMs, durationMs);
    } else if (spansByName.size < MAX_TRACKED_KEYS) {
      spansByName.set(name, {
        count: 1,
        failureCount: isFailure ? 1 : 0,
        totalDurationMs: durationMs,
        maxDurationMs: durationMs,
      });
    }
    if (!isConnectionLifetime) {
      insertBounded(
        slowestSpans,
        { name, durationMs, endedAt, traceId, spanId },
        TOP_LIMIT,
        (left, right) => right.durationMs - left.durationMs,
      );
    }

    if (isFailure) {
      const cause = (asText(exit?.cause)?.trim() ?? "Failure").slice(0, MAX_CAUSE_LENGTH);
      insertBounded(
        latestFailures,
        { name, cause, durationMs, endedAt, traceId, spanId },
        RECENT_LIMIT,
        (left, right) => newestFirst(left.endedAt, right.endedAt),
      );
      const key = `${name}\0${cause}`;
      const existing = failuresByKey.get(key);
      if (existing || failuresByKey.size < MAX_TRACKED_KEYS) {
        const isLatest = !existing || endedAt >= existing.lastSeenAt;
        failuresByKey.set(key, {
          name,
          cause,
          count: (existing?.count ?? 0) + 1,
          lastSeenAt: isLatest ? endedAt : existing.lastSeenAt,
          traceId: isLatest ? traceId : existing.traceId,
          spanId: isLatest ? spanId : existing.spanId,
        });
      }
    }

    if (!Array.isArray(parsed.events)) return;
    for (const rawEvent of parsed.events) {
      const event = asRecord(rawEvent);
      const level = asText(asRecord(event?.attributes)?.["effect.logLevel"]);
      if (!event || !level) continue;
      logLevelCounts[level] = (logLevelCounts[level] ?? 0) + 1;
      if (!/^(warn|warning|error|fatal)$/i.test(level)) continue;
      insertBounded(
        latestLogs,
        {
          spanName: name,
          level,
          message: asText(event.name)?.trim() ?? "Log event",
          seenAt: unixNanoToIso(event.timeUnixNano) ?? endedAt,
          traceId,
          spanId,
        },
        RECENT_LIMIT,
        (left, right) => newestFirst(left.seenAt, right.seenAt),
      );
    }
  };

  const finish = (input: {
    readonly traceFilePath: string;
    readonly scannedFilePaths: ReadonlyArray<string>;
    readonly readAt: string;
    readonly error?: NonNullable<ServerTraceDiagnosticsResult["error"]>;
    readonly partialFailure?: boolean;
  }): ServerTraceDiagnosticsResult => ({
    traceFilePath: input.traceFilePath,
    scannedFilePaths: input.scannedFilePaths,
    readAt: input.readAt,
    recordCount,
    parseErrorCount,
    firstSpanAt,
    lastSpanAt,
    failureCount,
    interruptionCount,
    slowSpanThresholdMs,
    slowSpanCount,
    logLevelCounts,
    topSpansByCount: [...spansByName.entries()]
      .map(([name, span]) => ({
        name,
        count: span.count,
        failureCount: span.failureCount,
        totalDurationMs: span.totalDurationMs,
        averageDurationMs: span.totalDurationMs / span.count,
        maxDurationMs: span.maxDurationMs,
      }))
      .toSorted(
        (left, right) => right.count - left.count || right.maxDurationMs - left.maxDurationMs,
      )
      .slice(0, TOP_LIMIT),
    slowestSpans,
    commonFailures: [...failuresByKey.values()]
      .toSorted(
        (left, right) => right.count - left.count || newestFirst(left.lastSeenAt, right.lastSeenAt),
      )
      .slice(0, TOP_LIMIT),
    latestFailures,
    latestWarningAndErrorLogs: latestLogs,
    partialFailure: input.partialFailure === true,
    error: input.error ?? null,
  });

  return { addLine, finish };
}

/** Summarizes the local trace file and its rotated backups, streaming each one line by line. */
export const readTraceDiagnostics = Effect.fn("diagnostics.readTraces")(function* (
  options: TraceDiagnosticsOptions,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const readAt = DateTime.formatIso(yield* DateTime.now);
  const paths = toRotatedTracePaths(options.traceFilePath, options.maxFiles);
  const aggregator = makeTraceDiagnosticsAggregator(options.slowSpanThresholdMs);

  // Every file feeds one aggregator, so they are read one at a time.
  const outcomes = yield* Effect.forEach(paths, (path) =>
    streamTraceFileLines(fileSystem, path, aggregator.addLine).pipe(
      Effect.as(true),
      // Absent backups are normal: rotation fills them in over time.
      Effect.catchIf(
        (cause) => cause.reason._tag === "NotFound",
        () => Effect.succeed(false),
      ),
      Effect.result,
    ),
  );

  const foundFile = outcomes.some((outcome) => Result.isSuccess(outcome) && outcome.success);
  const failed = outcomes.flatMap((outcome, index) =>
    Result.isFailure(outcome) ? [paths[index]!] : [],
  );
  const base = { traceFilePath: options.traceFilePath, scannedFilePaths: paths, readAt };
  if (failed.length > 0) {
    yield* Effect.logWarning("Failed to read local trace files.", { paths: failed });
    return aggregator.finish({
      ...base,
      partialFailure: foundFile,
      error: {
        kind: "trace-file-read-failed",
        message: `Failed to read ${failed.length} local trace file${failed.length === 1 ? "" : "s"}.`,
      },
    });
  }
  return foundFile
    ? aggregator.finish(base)
    : aggregator.finish({
        ...base,
        error: { kind: "trace-file-not-found", message: "No local trace files were found." },
      });
});
