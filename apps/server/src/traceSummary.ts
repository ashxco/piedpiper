/**
 * `piedpiper trace summary` - per-span counts, rates and latency percentiles from the local
 * server trace file and its rotated backups. It reads the files directly and starts no server
 * layers, so it works while the server is stalled or stopped.
 */
import { PositiveInt } from "@piedpiper/contracts";
import { Clock, Config, Console, Effect, FileSystem, Option, Schema } from "effect";
import { Command, Flag } from "effect/unstable/cli";

import { deriveServerPaths, traceFileConfig, traceMaxFilesConfig } from "./config";
import { streamTraceFileLines, toRotatedTracePaths } from "./diagnostics/TraceDiagnostics";
import { resolveBaseDir } from "./os-jank";

/** The largest time a `Date` can hold. */
const MAX_DATE_MS = 8.64e15;
const DEFAULT_LIMIT = 25;

// Only the fields the summary needs; other record fields are ignored.
const decodeTraceSpanLine = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      name: Schema.String,
      durationMs: Schema.Finite,
      endTimeUnixNano: Schema.FiniteFromString,
      exit: Schema.optional(Schema.Struct({ _tag: Schema.String })),
    }),
  ),
);

const SINCE_UNIT_MS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** Parses windows like `500ms`, `30m` or `2h` to milliseconds. */
export function parseSinceWindowMs(value: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(value.trim());
  const unitMs = match ? SINCE_UNIT_MS[match[2] ?? ""] : undefined;
  if (!match || unitMs === undefined) return undefined;
  const windowMs = Number(match[1]) * unitMs;
  return Number.isFinite(windowMs) && windowMs > 0 ? windowMs : undefined;
}

/**
 * Groups trace NDJSON by span name. Call `addLine` once per line as the files stream in, then
 * `finish` for the summary. Spans that ended before `sinceMs` are left out. Rates are per minute
 * between the first and last span end, since spans are written when they end.
 */
export function makeTraceSpanSummary(sinceMs = -Infinity) {
  // Exact percentiles: 8 bytes per span is a few MB for the default rotated traces.
  const byName = new Map<string, { durations: number[]; interrupted: number; failures: number }>();
  let spanCount = 0;
  let skippedLineCount = 0;
  let firstEndMs = Infinity;
  let lastEndMs = -Infinity;

  const addLine = (line: string) => {
    if (line.trim().length === 0) return;
    const span = Option.getOrUndefined(decodeTraceSpanLine(line));
    if (span === undefined) {
      skippedLineCount += 1;
      return;
    }
    const endMs = span.endTimeUnixNano / 1_000_000;
    // The report prints end times as dates, so skip ones a Date cannot hold.
    if (Math.abs(endMs) > MAX_DATE_MS) {
      skippedLineCount += 1;
      return;
    }
    if (endMs < sinceMs) return;

    spanCount += 1;
    firstEndMs = Math.min(firstEndMs, endMs);
    lastEndMs = Math.max(lastEndMs, endMs);
    const stats = byName.get(span.name) ?? { durations: [], interrupted: 0, failures: 0 };
    stats.durations.push(span.durationMs);
    if (span.exit?._tag === "Interrupted") stats.interrupted += 1;
    if (span.exit?._tag === "Failure") stats.failures += 1;
    byName.set(span.name, stats);
  };

  const finish = () => {
    const minutes = (lastEndMs - firstEndMs) / 60_000;
    const spans = [...byName]
      .map(([name, { durations, interrupted, failures }]) => {
        const sorted = durations.toSorted((left, right) => left - right);
        // Nearest-rank percentile.
        const percentile = (p: number) => sorted[Math.ceil(p * sorted.length) - 1] ?? 0;
        return {
          name,
          count: sorted.length,
          perMinute: minutes > 0 ? sorted.length / minutes : undefined,
          p50Ms: percentile(0.5),
          p90Ms: percentile(0.9),
          maxMs: sorted[sorted.length - 1] ?? 0,
          interrupted,
          failures,
        };
      })
      .toSorted((left, right) => right.count - left.count || left.name.localeCompare(right.name));

    return { spanCount, skippedLineCount, firstEndMs, lastEndMs, minutes, spans };
  };

  return { addLine, finish };
}

type TraceSpanSummary = ReturnType<ReturnType<typeof makeTraceSpanSummary>["finish"]>;

const formatMs = (ms: number) =>
  ms < 1_000 ? `${Math.round(ms)}ms` : `${(ms / 1_000).toFixed(1)}s`;

const formatPerMinute = (perMinute: number | undefined) => {
  if (perMinute === undefined) return "-";
  return perMinute < 0.1 ? "<0.1" : perMinute.toFixed(1);
};

const formatIso = (ms: number) => new Date(ms).toISOString();

const skippedLinesNote = (count: number) => `Skipped ${count} lines that are not spans.`;

export function formatTraceSummary(summary: TraceSpanSummary, limit: number): string {
  const header = ["span", "count", "/min", "p50", "p90", "max", "interrupted", "failed"];
  const rows = summary.spans
    .slice(0, limit)
    .map((span) => [
      span.name,
      String(span.count),
      formatPerMinute(span.perMinute),
      formatMs(span.p50Ms),
      formatMs(span.p90Ms),
      formatMs(span.maxMs),
      String(span.interrupted),
      String(span.failures),
    ]);
  const table = [header, ...rows];
  const widths = header.map((_, column) =>
    Math.max(...table.map((row) => (row[column] ?? "").length)),
  );
  return [
    `${summary.spanCount} spans ended from ${formatIso(summary.firstEndMs)} to ${formatIso(summary.lastEndMs)} (${summary.minutes.toFixed(1)} min).`,
    ...(summary.skippedLineCount > 0 ? [skippedLinesNote(summary.skippedLineCount)] : []),
    "",
    ...table.map((row) =>
      row
        .map((cell, column) =>
          column === 0 ? cell.padEnd(widths[column] ?? 0) : cell.padStart(widths[column] ?? 0),
        )
        .join("  "),
    ),
    ...(summary.spans.length > limit
      ? ["", `${summary.spans.length - limit} more span names. Use --limit to show more.`]
      : []),
  ].join("\n");
}

const traceSummaryCommand = Command.make("summary", {
  baseDir: Flag.string("base-dir").pipe(
    Flag.withDescription("Base directory path (equivalent to PIEDPIPER_HOME)."),
    Flag.optional,
  ),
  since: Flag.string("since").pipe(
    Flag.withDescription("Only count spans that ended in this window, for example 30m or 2h."),
    Flag.filterMap(
      (value) => Option.fromUndefinedOr(parseSinceWindowMs(value)),
      () => "a number and a unit, for example 30m or 2h",
    ),
    Flag.optional,
  ),
  limit: Flag.integer("limit").pipe(
    Flag.withSchema(PositiveInt),
    Flag.withDescription("Number of span names to show, busiest first."),
    Flag.withDefault(DEFAULT_LIMIT),
  ),
}).pipe(
  Command.withDescription("Summarize the local server trace file: counts, rates, and latency."),
  Command.withHandler(
    Effect.fn("cli.trace.summary")(function* (flags) {
      const fs = yield* FileSystem.FileSystem;
      const envHome = yield* Config.string("PIEDPIPER_HOME").pipe(Config.option);
      const traceFile = yield* traceFileConfig;
      const maxFiles = yield* traceMaxFilesConfig;
      // Dev servers write under `dev/`, which only PIEDPIPER_TRACE_FILE can point at here.
      const traceFilePath = Option.isSome(traceFile)
        ? traceFile.value
        : (yield* deriveServerPaths(
            yield* resolveBaseDir(
              Option.getOrUndefined(Option.orElse(flags.baseDir, () => envHome)),
            ),
            undefined,
          )).serverTracePath;
      const sinceMs = Option.isSome(flags.since)
        ? (yield* Clock.currentTimeMillis) - flags.since.value
        : undefined;
      const summarizer = makeTraceSpanSummary(sinceMs);

      // Streams each file, so only one chunk of text is in memory at a time. Absent backups are
      // normal; one unreadable file is named and does not cost the summary of the others.
      yield* Effect.forEach(
        toRotatedTracePaths(traceFilePath, maxFiles),
        (path) =>
          streamTraceFileLines(fs, path, summarizer.addLine).pipe(
            Effect.catchTag("PlatformError", (error) =>
              error.reason._tag === "NotFound"
                ? Effect.void
                : Console.error(`Could not read ${path}: ${error.reason._tag}.`),
            ),
          ),
        { discard: true },
      );

      const summary = summarizer.finish();
      yield* Console.log(
        summary.spanCount > 0
          ? formatTraceSummary(summary, flags.limit)
          : [
              `No spans found in ${traceFilePath} or its rotated files${sinceMs === undefined ? "" : " in that window"}.`,
              ...(summary.skippedLineCount > 0 ? [skippedLinesNote(summary.skippedLineCount)] : []),
            ].join(" "),
      );
    }),
  ),
);

export const traceCommand = Command.make("trace").pipe(
  Command.withDescription("Inspect the local server trace file."),
  Command.withSubcommands([traceSummaryCommand]),
);
