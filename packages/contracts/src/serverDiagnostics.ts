import { Schema } from "effect";

import { IsoDateTime, NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas";

// OTLP endpoint check

export const OtlpSignal = Schema.Literals(["traces", "metrics", "logs"]);
export type OtlpSignal = typeof OtlpSignal.Type;

export const OtlpEndpointCheckInput = Schema.Struct({
  signal: OtlpSignal,
  // Receivers are HTTP only; other schemes, such as data:, answer without contacting one.
  url: TrimmedNonEmptyString.check(Schema.isPattern(/^https?:\/\/./i)),
});
export type OtlpEndpointCheckInput = typeof OtlpEndpointCheckInput.Type;

/** What the server saw after sending an empty export to an endpoint. */
export const OtlpEndpointCheckResult = Schema.Union([
  Schema.TaggedStruct("Accepted", { latencyMs: Schema.Number }),
  Schema.TaggedStruct("Rejected", { status: Schema.Number }),
  Schema.TaggedStruct("Unreachable", { timedOut: Schema.Boolean }),
]);
export type OtlpEndpointCheckResult = typeof OtlpEndpointCheckResult.Type;

// Trace summary

const ServerTraceDiagnosticsErrorKind = Schema.Literals([
  "trace-file-not-found",
  "trace-file-read-failed",
]);
export type ServerTraceDiagnosticsErrorKind = typeof ServerTraceDiagnosticsErrorKind.Type;

const ServerTraceDiagnosticsSpanSummary = Schema.Struct({
  name: Schema.String,
  count: NonNegativeInt,
  failureCount: NonNegativeInt,
  totalDurationMs: Schema.Number,
  averageDurationMs: Schema.Number,
  maxDurationMs: Schema.Number,
});
export type ServerTraceDiagnosticsSpanSummary = typeof ServerTraceDiagnosticsSpanSummary.Type;

export const ServerTraceDiagnosticsSpanOccurrence = Schema.Struct({
  name: Schema.String,
  durationMs: Schema.Number,
  endedAt: IsoDateTime,
  traceId: Schema.String,
  spanId: Schema.String,
});
export type ServerTraceDiagnosticsSpanOccurrence = typeof ServerTraceDiagnosticsSpanOccurrence.Type;

export const ServerTraceDiagnosticsFailureSummary = Schema.Struct({
  name: Schema.String,
  cause: Schema.String,
  count: NonNegativeInt,
  lastSeenAt: IsoDateTime,
  traceId: Schema.String,
  spanId: Schema.String,
});
export type ServerTraceDiagnosticsFailureSummary = typeof ServerTraceDiagnosticsFailureSummary.Type;

export const ServerTraceDiagnosticsRecentFailure = Schema.Struct({
  name: Schema.String,
  cause: Schema.String,
  durationMs: Schema.Number,
  endedAt: IsoDateTime,
  traceId: Schema.String,
  spanId: Schema.String,
});
export type ServerTraceDiagnosticsRecentFailure = typeof ServerTraceDiagnosticsRecentFailure.Type;

export const ServerTraceDiagnosticsLogEvent = Schema.Struct({
  spanName: Schema.String,
  level: Schema.String,
  message: Schema.String,
  seenAt: IsoDateTime,
  traceId: Schema.String,
  spanId: Schema.String,
});
export type ServerTraceDiagnosticsLogEvent = typeof ServerTraceDiagnosticsLogEvent.Type;

export const ServerTraceDiagnosticsResult = Schema.Struct({
  traceFilePath: Schema.String,
  scannedFilePaths: Schema.Array(Schema.String),
  readAt: IsoDateTime,
  recordCount: NonNegativeInt,
  parseErrorCount: NonNegativeInt,
  firstSpanAt: Schema.NullOr(IsoDateTime),
  lastSpanAt: Schema.NullOr(IsoDateTime),
  failureCount: NonNegativeInt,
  interruptionCount: NonNegativeInt,
  slowSpanThresholdMs: Schema.Number,
  slowSpanCount: NonNegativeInt,
  logLevelCounts: Schema.Record(Schema.String, NonNegativeInt),
  topSpansByCount: Schema.Array(ServerTraceDiagnosticsSpanSummary),
  slowestSpans: Schema.Array(ServerTraceDiagnosticsSpanOccurrence),
  commonFailures: Schema.Array(ServerTraceDiagnosticsFailureSummary),
  latestFailures: Schema.Array(ServerTraceDiagnosticsRecentFailure),
  latestWarningAndErrorLogs: Schema.Array(ServerTraceDiagnosticsLogEvent),
  /** Some rotated files were read and at least one failed. */
  partialFailure: Schema.Boolean,
  error: Schema.NullOr(
    Schema.Struct({ kind: ServerTraceDiagnosticsErrorKind, message: Schema.String }),
  ),
});
export type ServerTraceDiagnosticsResult = typeof ServerTraceDiagnosticsResult.Type;

// Child processes

export const ServerProcessSignal = Schema.Literals(["SIGINT", "SIGKILL"]);
export type ServerProcessSignal = typeof ServerProcessSignal.Type;

export const ServerProcessDiagnosticsEntry = Schema.Struct({
  pid: PositiveInt,
  ppid: NonNegativeInt,
  status: Schema.String,
  /** Null when the platform does not report it. */
  cpuPercent: Schema.NullOr(Schema.Number),
  rssBytes: NonNegativeInt,
  /** Empty when the platform does not report it. */
  elapsed: Schema.String,
  command: Schema.String,
  depth: NonNegativeInt,
});
export type ServerProcessDiagnosticsEntry = typeof ServerProcessDiagnosticsEntry.Type;

export const ServerProcessDiagnosticsResult = Schema.Struct({
  serverPid: PositiveInt,
  readAt: IsoDateTime,
  processCount: NonNegativeInt,
  totalRssBytes: NonNegativeInt,
  totalCpuPercent: Schema.NullOr(Schema.Number),
  processes: Schema.Array(ServerProcessDiagnosticsEntry),
  /** Windows has no interrupt signal: Node terminates the process for either one. */
  supportsInterrupt: Schema.Boolean,
  /** The list hit a size limit, so some descendants may be missing. */
  truncated: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
});
export type ServerProcessDiagnosticsResult = typeof ServerProcessDiagnosticsResult.Type;

export const ServerSignalProcessInput = Schema.Struct({
  pid: PositiveInt,
  signal: ServerProcessSignal,
  /** The command the caller saw, so a reused pid is refused. */
  expectedCommand: Schema.optional(Schema.String),
});
export type ServerSignalProcessInput = typeof ServerSignalProcessInput.Type;

export const ServerSignalProcessResult = Schema.Struct({
  pid: PositiveInt,
  signal: ServerProcessSignal,
  signaled: Schema.Boolean,
  message: Schema.NullOr(Schema.String),
});
export type ServerSignalProcessResult = typeof ServerSignalProcessResult.Type;
