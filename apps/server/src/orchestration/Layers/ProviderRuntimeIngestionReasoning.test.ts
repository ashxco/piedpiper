import { EventId, ThreadId, TurnId, type ProviderRuntimeEvent } from "@piedpiper/contracts";
import { describe, expect, it } from "vitest";

import {
  appendReasoningDelta,
  type ClosedReasoningText,
  eventEndsReasoningBlock,
  markReasoningBlockEmitted,
  openReasoningBlock,
  reasoningBlockToActivity,
  reasoningFinalTextTail,
  recordClosedReasoningBlock,
  shouldEmitReasoningBlock,
} from "./ProviderRuntimeIngestionReasoning.ts";

const event = {
  type: "content.delta",
  eventId: EventId.makeUnsafe("evt-1"),
  provider: "claudeAgent",
  createdAt: "2026-04-08T00:00:00.000Z",
  threadId: ThreadId.makeUnsafe("thread-1"),
  turnId: TurnId.makeUnsafe("turn-1"),
  payload: { streamKind: "reasoning_text", delta: "x" },
} as ProviderRuntimeEvent;

const open = () =>
  openReasoningBlock({
    event,
    baseKey: "raw:turn-1",
    stream: "raw",
    turnId: TurnId.makeUnsafe("turn-1"),
  });

describe("reasoning blocks", () => {
  it("emits at once, then only after enough growth and time", () => {
    let block = appendReasoningDelta(open(), "x".repeat(100), undefined);
    expect(shouldEmitReasoningBlock(block, 0)).toBe(true);
    block = markReasoningBlockEmitted(block, 0);

    expect(
      shouldEmitReasoningBlock(appendReasoningDelta(block, "y".repeat(30), undefined), 100),
    ).toBe(false);
    expect(
      shouldEmitReasoningBlock(appendReasoningDelta(block, "y".repeat(10), undefined), 500),
    ).toBe(false);
    expect(
      shouldEmitReasoningBlock(appendReasoningDelta(block, "y".repeat(30), undefined), 500),
    ).toBe(true);
  });

  it("stores a small multiple of the block's length however it is chunked", () => {
    let block = open();
    let stored = 0;
    for (let index = 0; index < 8_000; index += 1) {
      block = appendReasoningDelta(block, "x", undefined);
      if (shouldEmitReasoningBlock(block, index * 1_000)) {
        block = markReasoningBlockEmitted(block, index * 1_000);
        stored += block.text.length;
      }
    }
    expect(stored).toBeLessThan(block.text.length * 6);
  });

  it("never emits blank text", () => {
    expect(shouldEmitReasoningBlock(appendReasoningDelta(open(), " \n", undefined), 0)).toBe(false);
  });

  it("adds a blank line only when the part index changes", () => {
    const first = appendReasoningDelta(open(), "one", 0);
    expect(appendReasoningDelta(first, " two", 0).text).toBe("one two");
    expect(appendReasoningDelta(first, "two", 1).text).toBe("one\n\ntwo");
  });

  it("builds a thinking activity that keeps its id and start time", () => {
    const block = appendReasoningDelta(open(), "text", undefined);
    expect(reasoningBlockToActivity(block, "inProgress")).toMatchObject({
      id: "reasoning:evt-1",
      tone: "thinking",
      kind: "reasoning.block",
      summary: "Thinking",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:00.000Z",
      payload: { stream: "raw", status: "inProgress", detail: "text" },
    });
    expect(reasoningBlockToActivity(block, "completed").summary).toBe("Thought");
    expect(reasoningBlockToActivity(block, "promoted")).toMatchObject({
      id: "reasoning:evt-1",
      summary: "Thought",
      payload: { status: "promoted", detail: "text" },
    });
  });

  it("records a closed block for its item only when it has an item and visible text", () => {
    const empty = new Map<string, ClosedReasoningText>();
    const withItem = { ...open(), providerItemId: "rs-1" };
    expect(recordClosedReasoningBlock(empty, withItem).size).toBe(0);
    expect(recordClosedReasoningBlock(empty, appendReasoningDelta(open(), "a", undefined))).toBe(
      empty,
    );
    const short = appendReasoningDelta(withItem, "a", undefined);
    const full = appendReasoningDelta(withItem, "x".repeat(16_000), undefined);
    const closed = recordClosedReasoningBlock(recordClosedReasoningBlock(empty, short), full);
    expect(closed.get("raw:turn-1")).toEqual({ fullTexts: [full.text], block: null });
    expect(recordClosedReasoningBlock(closed, short).get("raw:turn-1")).toEqual({
      fullTexts: [full.text],
      block: short,
    });
  });

  it("takes the final text after the filled blocks, whatever whitespace joins them", () => {
    expect(reasoningFinalTextTail("whole", [])).toBe("whole");
    expect(reasoningFinalTextTail("aaabbbtail", ["aaa", "bbb"])).toBe("tail");
    expect(reasoningFinalTextTail("aaa\n\nbbb\n\ntail", [" aaa", "bbb "])).toBe("tail");
    expect(reasoningFinalTextTail("aaa", ["aaa"])).toBe("");
    expect(reasoningFinalTextTail("other", ["aaa"])).toBeNull();
  });

  it("treats only the model moving on as ending a block", () => {
    const delta = (streamKind: string) =>
      ({ ...event, payload: { streamKind, delta: "x" } }) as ProviderRuntimeEvent;
    expect(eventEndsReasoningBlock(delta("assistant_text"))).toBe(true);
    expect(eventEndsReasoningBlock(delta("reasoning_text"))).toBe(false);
    expect(eventEndsReasoningBlock(delta("tool_input_text"))).toBe(false);
    const itemStarted = (itemType: string) =>
      ({ ...event, type: "item.started", payload: { itemType } }) as ProviderRuntimeEvent;
    expect(eventEndsReasoningBlock(itemStarted("reasoning"))).toBe(false);
    expect(eventEndsReasoningBlock(itemStarted("command_execution"))).toBe(true);
  });
});
