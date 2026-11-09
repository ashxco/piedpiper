import type { MessageId, ThreadId, TurnId } from "@piedpiper/contracts";
import { describe, expect, it } from "vitest";

import { turnFoldRowId } from "../ChatView.turnFolds";
import {
  buildThreadMessageRevealPosition,
  requestThreadMessageReveal,
  takeThreadMessageReveal,
} from "./threadMessageReveal";

const THREAD_A = "thread-a" as ThreadId;
const THREAD_B = "thread-b" as ThreadId;
const MESSAGE = "message-1" as MessageId;
const TURN = "turn-1" as TurnId;

describe("thread message reveal", () => {
  it("hands a pending reveal only to its thread, and only once", () => {
    const reveal = { threadId: THREAD_A, messageId: MESSAGE, foldedTurnId: null };
    requestThreadMessageReveal(reveal);
    expect(takeThreadMessageReveal(THREAD_B)).toBeNull();
    expect(takeThreadMessageReveal(THREAD_A)).toEqual(reveal);
    expect(takeThreadMessageReveal(THREAD_A)).toBeNull();
  });

  it("keeps only the newest request", () => {
    requestThreadMessageReveal({ threadId: THREAD_A, messageId: MESSAGE, foldedTurnId: null });
    requestThreadMessageReveal({ threadId: THREAD_B, messageId: MESSAGE, foldedTurnId: null });
    expect(takeThreadMessageReveal(THREAD_A)).toBeNull();
    expect(takeThreadMessageReveal(THREAD_B)?.threadId).toBe(THREAD_B);
  });

  it("anchors the message over the saved position and opens its turn's fold", () => {
    const position = buildThreadMessageRevealPosition(
      { threadId: THREAD_A, messageId: MESSAGE, foldedTurnId: TURN },
      {
        anchorRowId: "row-9",
        anchorOffsetPx: 40,
        scrollTop: 900,
        atEnd: false,
        expandedWorkGroupIds: ["group-1"],
      },
    );
    expect(position.anchorRowId).toBe(MESSAGE);
    expect(position.atEnd).toBe(false);
    expect(position.scrollTop).toBe(900);
    expect(position.expandedWorkGroupIds).toEqual(["group-1", turnFoldRowId(TURN)]);
  });

  it("falls back to the end of the thread when nothing is saved", () => {
    const position = buildThreadMessageRevealPosition(
      { threadId: THREAD_A, messageId: MESSAGE, foldedTurnId: null },
      undefined,
    );
    expect(position.scrollTop).toBe(Number.MAX_SAFE_INTEGER);
    expect(position.expandedWorkGroupIds).toEqual([]);
  });
});
