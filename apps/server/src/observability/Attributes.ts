import { Cause, Exit } from "effect";

export type MetricAttributeValue = string;
export type MetricAttributes = Readonly<Record<string, MetricAttributeValue>>;
export type TraceAttributes = Readonly<Record<string, unknown>>;
export type ObservabilityOutcome = "success" | "failure" | "interrupt";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Every value visited is charged, since repeated references expand once per path and a
// shared graph (deep or wide) can otherwise grow exponentially.
const TRACE_ATTRIBUTE_MAX_NODES = 10_000;

interface NormalizeState {
  // Only the current ancestors, so a value repeated under two keys is not a cycle.
  readonly seen: WeakSet<object>;
  remainingNodes: number;
}

function enterNode(value: object, state: NormalizeState): string | undefined {
  if (state.seen.has(value)) {
    return "[Circular]";
  }
  state.seen.add(value);
  return undefined;
}

function normalizeJsonValue(value: unknown, state: NormalizeState): unknown {
  if (state.remainingNodes <= 0) {
    return "[Truncated]";
  }
  state.remainingNodes--;
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value ?? null;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      ...(value.stack ? { stack: value.stack } : {}),
    };
  }
  if (Array.isArray(value) || value instanceof Set) {
    const marker = enterNode(value, state);
    if (marker) {
      return marker;
    }
    const normalized = normalizeList(value, state);
    state.seen.delete(value);
    return normalized;
  }
  if (value instanceof Map) {
    const marker = enterNode(value, state);
    if (marker) {
      return marker;
    }
    const normalized = normalizeEntries(
      Array.from(value.entries(), ([key, entryValue]) => [String(key), entryValue] as const),
      state,
    );
    state.seen.delete(value);
    return normalized;
  }
  if (!isPlainObject(value)) {
    return String(value);
  }
  const marker = enterNode(value, state);
  if (marker) {
    return marker;
  }
  const normalized = normalizeEntries(Object.entries(value), state);
  state.seen.delete(value);
  return normalized;
}

// Stops at the first entry past the budget so a huge collection costs one marker, not one per entry.
function normalizeList(entries: Iterable<unknown>, state: NormalizeState): unknown[] {
  const normalized: unknown[] = [];
  for (const entry of entries) {
    if (state.remainingNodes <= 0) {
      normalized.push("[Truncated]");
      break;
    }
    normalized.push(normalizeJsonValue(entry, state));
  }
  return normalized;
}

function normalizeEntries(
  entries: Iterable<readonly [string, unknown]>,
  state: NormalizeState,
): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const [key, entryValue] of entries) {
    if (state.remainingNodes <= 0) {
      normalized[key] = "[Truncated]";
      break;
    }
    normalized[key] = normalizeJsonValue(entryValue, state);
  }
  return normalized;
}

export function compactTraceAttributes(
  attributes: Readonly<Record<string, unknown>>,
): TraceAttributes {
  const state: NormalizeState = { seen: new WeakSet(), remainingNodes: TRACE_ATTRIBUTE_MAX_NODES };
  return Object.fromEntries(
    Object.entries(attributes)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, normalizeJsonValue(value, state)]),
  );
}

const TRACE_ATTRIBUTE_MAX_LENGTH = 500;
const TRACE_ATTRIBUTE_TRUNCATED_LENGTH = 200;
const TRACE_ATTRIBUTE_TRUNCATION_SUFFIX = "…[truncated]";
const ALWAYS_TRUNCATED_TRACE_ATTRIBUTES: ReadonlySet<string> = new Set(["db.query.text"]);

function truncateNestedValue(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length <= TRACE_ATTRIBUTE_MAX_LENGTH
      ? value
      : `${value.slice(0, TRACE_ATTRIBUTE_MAX_LENGTH)}${TRACE_ATTRIBUTE_TRUNCATION_SUFFIX}`;
  }
  if (Array.isArray(value)) {
    const truncated = value.map(truncateNestedValue);
    return truncated.some((entry, index) => entry !== value[index]) ? truncated : value;
  }
  if (isPlainObject(value)) {
    let truncated: Record<string, unknown> | undefined;
    for (const [key, entry] of Object.entries(value)) {
      const next = truncateNestedValue(entry);
      if (next === entry) continue;
      truncated ??= { ...value };
      truncated[key] = next;
    }
    return truncated ?? value;
  }
  return value;
}

/**
 * Clamps oversized strings at any depth for the local trace file. OTLP keeps the
 * full values, so this must stay out of compactTraceAttributes. Returns the input
 * when nothing was clamped and never mutates it.
 */
export function truncateTraceAttributes(attributes: TraceAttributes): TraceAttributes {
  let truncated: Record<string, unknown> | undefined;
  for (const [key, value] of Object.entries(attributes)) {
    const next =
      typeof value === "string" && ALWAYS_TRUNCATED_TRACE_ATTRIBUTES.has(key)
        ? value.length <= TRACE_ATTRIBUTE_TRUNCATED_LENGTH
          ? value
          : `${value.slice(0, TRACE_ATTRIBUTE_TRUNCATED_LENGTH)}${TRACE_ATTRIBUTE_TRUNCATION_SUFFIX}`
        : truncateNestedValue(value);
    if (next === value) continue;
    truncated ??= { ...attributes };
    truncated[key] = next;
  }
  return truncated ?? attributes;
}

export function compactMetricAttributes(
  attributes: Readonly<Record<string, unknown>>,
): MetricAttributes {
  return Object.fromEntries(
    Object.entries(attributes).flatMap(([key, value]) => {
      if (value === undefined || value === null) {
        return [];
      }
      if (typeof value === "string") {
        return [[key, value]];
      }
      if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
        return [[key, String(value)]];
      }
      return [];
    }),
  );
}

export function outcomeFromExit(exit: Exit.Exit<unknown, unknown>): ObservabilityOutcome {
  if (Exit.isSuccess(exit)) {
    return "success";
  }
  return Cause.hasInterruptsOnly(exit.cause) ? "interrupt" : "failure";
}

export function normalizeModelMetricLabel(model: string | null | undefined): string | undefined {
  const normalized = model?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized.includes("gpt")) {
    return "gpt";
  }
  if (normalized.includes("claude")) {
    return "claude";
  }
  if (normalized.includes("gemini")) {
    return "gemini";
  }
  return "other";
}
