/**
 * Pure state for streaming one thinking block into a `reasoning.block` activity.
 *
 * The activity is re-appended under one id as its text grows, and each append
 * stores the whole text in the event log, so emissions space out geometrically:
 * a block's total stored text stays a small multiple of its length.
 */
import {
  EventId,
  type OrchestrationThreadActivity,
  type ProviderRuntimeEvent,
  THREAD_REASONING_ACTIVITY_KIND,
  type ThreadReasoningActivityPayload,
  type TurnId,
} from "@piedpiper/contracts";

const MIN_REASONING_EMIT_INTERVAL_MS = 400;
// Each emission waits for the text to grow by this fraction of what is already out.
const REASONING_EMIT_GROWTH_DIVISOR = 4;
/** A longer block continues in a new activity, which also bounds the rewritten text. */
const MAX_REASONING_BLOCK_CHARS = 16_000;

export type ReasoningStream = ThreadReasoningActivityPayload["stream"];
export type ReasoningStreamKind = "reasoning_text" | "reasoning_summary_text";

export interface ReasoningBlock {
  readonly activityId: EventId;
  readonly baseKey: string;
  readonly stream: ReasoningStream;
  readonly turnId: TurnId;
  readonly createdAt: string;
  readonly sequence: number | undefined;
  readonly providerItemId: string | undefined;
  readonly text: string;
  readonly emittedLength: number;
  readonly lastEmittedAtMillis: number | null;
  readonly partIndex: number | undefined;
}

export function reasoningStreamOf(streamKind: ReasoningStreamKind): ReasoningStream {
  return streamKind === "reasoning_summary_text" ? "summary" : "raw";
}

/** Summary and raw text of one item are different texts, so they never share a block. */
export function reasoningBlockBaseKey(stream: ReasoningStream, itemKey: string): string {
  return `${stream}:${itemKey}`;
}

export function openReasoningBlock(input: {
  readonly event: ProviderRuntimeEvent;
  readonly baseKey: string;
  readonly stream: ReasoningStream;
  readonly turnId: TurnId;
}): ReasoningBlock {
  const { event } = input;
  const sequence = (event as ProviderRuntimeEvent & { sessionSequence?: number }).sessionSequence;
  return {
    // The opening event's id is unique across turns, sessions and restarts.
    activityId: EventId.makeUnsafe(`reasoning:${event.eventId}`),
    baseKey: input.baseKey,
    stream: input.stream,
    turnId: input.turnId,
    createdAt: event.createdAt,
    sequence,
    providerItemId: event.itemId === undefined ? undefined : String(event.itemId),
    text: "",
    emittedLength: 0,
    lastEmittedAtMillis: null,
    partIndex: undefined,
  };
}

/** Appends a delta, with a blank line when the provider moved to the next indexed part. */
export function appendReasoningDelta(
  block: ReasoningBlock,
  delta: string,
  partIndex: number | undefined,
): ReasoningBlock {
  const startsNewPart =
    partIndex !== undefined &&
    block.partIndex !== undefined &&
    block.partIndex !== partIndex &&
    block.text.length > 0;
  return {
    ...block,
    text: `${block.text}${startsNewPart ? "\n\n" : ""}${delta}`,
    partIndex: partIndex ?? block.partIndex,
  };
}

export function hasVisibleReasoningText(block: ReasoningBlock): boolean {
  return block.text.trim().length > 0;
}

export function shouldEmitReasoningBlock(block: ReasoningBlock, atMillis: number): boolean {
  if (!hasVisibleReasoningText(block)) return false;
  if (block.lastEmittedAtMillis === null) return true;
  if (atMillis - block.lastEmittedAtMillis < MIN_REASONING_EMIT_INTERVAL_MS) return false;
  const pending = block.text.length - block.emittedLength;
  return pending > 0 && pending * REASONING_EMIT_GROWTH_DIVISOR >= block.emittedLength;
}

export function markReasoningBlockEmitted(block: ReasoningBlock, atMillis: number): ReasoningBlock {
  return { ...block, emittedLength: block.text.length, lastEmittedAtMillis: atMillis };
}

export function reasoningBlockIsFull(block: ReasoningBlock): boolean {
  return block.text.length >= MAX_REASONING_BLOCK_CHARS;
}

/** What already closed for one item, so later text and the item's final text continue it. */
export interface ClosedReasoningText {
  /** Blocks that hit the size limit, in order; these are done and never reopen. */
  readonly fullTexts: ReadonlyArray<string>;
  /** The latest block under the limit, which grows in place if more of its item arrives. */
  readonly block: ReasoningBlock | null;
}

/** Itemless blocks are not recorded: without an item, later text may be a different thought. */
export function recordClosedReasoningBlock(
  closed: ReadonlyMap<string, ClosedReasoningText>,
  block: ReasoningBlock,
): ReadonlyMap<string, ClosedReasoningText> {
  if (block.providerItemId === undefined || !hasVisibleReasoningText(block)) {
    return closed;
  }
  const fullTexts = closed.get(block.baseKey)?.fullTexts ?? [];
  return new Map(closed).set(
    block.baseKey,
    reasoningBlockIsFull(block)
      ? { fullTexts: [...fullTexts, block.text], block: null }
      : { fullTexts, block },
  );
}

/**
 * The part of an item's final text after the blocks that already filled up, or null when the
 * final text does not begin with them. Providers trim and join parts, so whitespace between
 * blocks does not count.
 */
export function reasoningFinalTextTail(
  finalText: string,
  fullTexts: ReadonlyArray<string>,
): string | null {
  let rest = finalText;
  for (const fullText of fullTexts) {
    const expected = fullText.trim();
    rest = rest.trimStart();
    if (!rest.startsWith(expected)) {
      return null;
    }
    rest = rest.slice(expected.length);
  }
  return fullTexts.length > 0 ? rest.trimStart() : rest;
}

export function reasoningBlockToActivity(
  block: ReasoningBlock,
  status: ThreadReasoningActivityPayload["status"],
): OrchestrationThreadActivity {
  const payload: ThreadReasoningActivityPayload = {
    stream: block.stream,
    status,
    detail: block.text,
    ...(block.providerItemId !== undefined ? { providerItemId: block.providerItemId } : {}),
  };
  return {
    id: block.activityId,
    tone: "thinking",
    kind: THREAD_REASONING_ACTIVITY_KIND,
    summary: status === "inProgress" ? "Thinking" : "Thought",
    payload,
    turnId: block.turnId,
    ...(block.sequence !== undefined ? { sequence: block.sequence } : {}),
    createdAt: block.createdAt,
  };
}

/** Events after which the model has moved on from the thinking block it had open. */
export function eventEndsReasoningBlock(event: ProviderRuntimeEvent): boolean {
  switch (event.type) {
    case "content.delta":
      return event.payload.streamKind === "assistant_text";
    case "item.started":
      return event.payload.itemType !== "reasoning";
    case "request.opened":
    case "user-input.requested":
    case "turn.aborted":
    case "turn.proposed.delta":
    case "turn.proposed.completed":
      return true;
    default:
      return false;
  }
}
