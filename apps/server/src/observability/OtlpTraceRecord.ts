import { Option, Schema, type Tracer } from "effect";

import { compactTraceAttributes, truncateTraceAttributes } from "./Attributes.ts";
import type { TraceRecord } from "./TraceRecord.ts";

/** A span received over OTLP: a regular trace record plus the sender's resource and scope. */
export interface OtlpTraceRecord extends TraceRecord {
  readonly resourceAttributes: Readonly<Record<string, unknown>>;
  readonly scope: {
    readonly name?: string;
    readonly version?: string;
  };
}

const STATUS_CODE_ERROR = 2;
const NESTED_VALUE_MAX_DEPTH = 16;
const SPAN_KINDS: Readonly<Record<number, Tracer.SpanKind>> = {
  1: "internal",
  2: "server",
  3: "client",
  4: "producer",
  5: "consumer",
};

const KeyValues = Schema.Array(Schema.Struct({ key: Schema.String, value: Schema.Unknown }));
type KeyValues = typeof KeyValues.Type;

// Bounded so the nanosecond math stays within what a Number can round-trip.
const UnixNano = Schema.String.check(Schema.isPattern(/^\d{1,20}$/));

const OtlpSpan = Schema.Struct({
  traceId: Schema.String,
  spanId: Schema.String,
  parentSpanId: Schema.optional(Schema.String),
  name: Schema.String,
  kind: Schema.optional(Schema.Number),
  startTimeUnixNano: UnixNano,
  endTimeUnixNano: UnixNano,
  attributes: Schema.optional(KeyValues),
  events: Schema.optional(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        timeUnixNano: UnixNano,
        attributes: Schema.optional(KeyValues),
      }),
    ),
  ),
  links: Schema.optional(
    Schema.Array(
      Schema.Struct({
        traceId: Schema.String,
        spanId: Schema.String,
        attributes: Schema.optional(KeyValues),
      }),
    ),
  ),
  status: Schema.optional(
    Schema.Struct({
      code: Schema.optional(Schema.Number),
      message: Schema.optional(Schema.String),
    }),
  ),
});

const OtlpTracePayload = Schema.Struct({
  resourceSpans: Schema.Array(
    Schema.Struct({
      resource: Schema.optional(Schema.Struct({ attributes: Schema.optional(KeyValues) })),
      scopeSpans: Schema.Array(
        Schema.Struct({
          scope: Schema.optional(
            Schema.Struct({
              name: Schema.optional(Schema.String),
              version: Schema.optional(Schema.String),
            }),
          ),
          spans: Schema.Array(OtlpSpan),
        }),
      ),
    }),
  ),
});

const decodePayload = Schema.decodeUnknownOption(OtlpTracePayload);

function decodeValue(input: unknown, depth: number): unknown {
  if (typeof input !== "object" || input === null || depth > NESTED_VALUE_MAX_DEPTH) return null;
  const value = input as Readonly<Record<string, unknown>>;
  for (const key of ["stringValue", "boolValue", "intValue", "doubleValue", "bytesValue"]) {
    if (key in value) {
      // A non-scalar here would bypass the depth limit: later attribute passes recurse freely.
      const scalar = value[key];
      return typeof scalar === "string" || typeof scalar === "number" || typeof scalar === "boolean"
        ? scalar
        : null;
    }
  }
  const nested = (value.arrayValue ?? value.kvlistValue) as
    | { readonly values?: unknown }
    | null
    | undefined;
  if (!nested || !Array.isArray(nested.values)) return null;
  if (value.arrayValue) return nested.values.map((entry) => decodeValue(entry, depth + 1));
  return Object.fromEntries(
    nested.values.flatMap((entry: { readonly key?: unknown; readonly value?: unknown } | null) =>
      typeof entry?.key === "string" ? [[entry.key, decodeValue(entry.value, depth + 1)]] : [],
    ),
  );
}

const decodeAttributes = (input: KeyValues | undefined) =>
  truncateTraceAttributes(
    compactTraceAttributes(
      Object.fromEntries((input ?? []).map(({ key, value }) => [key, decodeValue(value, 0)])),
    ),
  );

function decodeExit(status: typeof OtlpSpan.Type.status): TraceRecord["exit"] {
  if (status?.code === STATUS_CODE_ERROR) {
    return { _tag: "Failure", cause: status.message ?? "Unknown error" };
  }
  // The Effect OTLP tracer reports interrupted spans as Ok with this exact message.
  if (status?.message === "Interrupted") {
    return { _tag: "Interrupted", cause: status.message };
  }
  return { _tag: "Success" };
}

/**
 * Decodes an OTLP/JSON trace payload into trace file records. Returns none when the payload
 * does not have the OTLP shape, so one malformed batch is rejected as a whole.
 */
export function decodeOtlpTraceRecords(
  payload: unknown,
): Option.Option<ReadonlyArray<OtlpTraceRecord>> {
  return Option.map(decodePayload(payload), ({ resourceSpans }) =>
    resourceSpans.flatMap(({ resource, scopeSpans }) => {
      const resourceAttributes = decodeAttributes(resource?.attributes);
      return scopeSpans.flatMap(({ scope, spans }) =>
        spans.map(
          (span): OtlpTraceRecord => ({
            type: "effect-span",
            name: span.name,
            traceId: span.traceId,
            spanId: span.spanId,
            ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
            sampled: true,
            kind: SPAN_KINDS[span.kind ?? 1] ?? "internal",
            startTimeUnixNano: span.startTimeUnixNano,
            endTimeUnixNano: span.endTimeUnixNano,
            durationMs: Math.max(
              0,
              Number(BigInt(span.endTimeUnixNano) - BigInt(span.startTimeUnixNano)) / 1_000_000,
            ),
            attributes: decodeAttributes(span.attributes),
            events: (span.events ?? []).map((event) => ({
              name: event.name,
              timeUnixNano: event.timeUnixNano,
              attributes: decodeAttributes(event.attributes),
            })),
            links: (span.links ?? []).map((link) => ({
              traceId: link.traceId,
              spanId: link.spanId,
              attributes: decodeAttributes(link.attributes),
            })),
            exit: decodeExit(span.status),
            resourceAttributes,
            scope: {
              ...(scope?.name ? { name: scope.name } : {}),
              ...(scope?.version ? { version: scope.version } : {}),
            },
          }),
        ),
      );
    }),
  );
}
