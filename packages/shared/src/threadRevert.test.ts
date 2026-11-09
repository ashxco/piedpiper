import { describe, expect, it } from "vitest";
import { retainThreadItemsAfterRevert, retainThreadMessagesAfterRevert } from "./threadRevert";

describe("thread revert retention", () => {
  it("retains linked turns and systems, filling each role from the earliest unlinked messages", () => {
    const messages = [
      { id: "later", role: "user", createdAt: "2" },
      { id: "b", role: "user", createdAt: "1", turnId: null },
      { id: "a", role: "user", createdAt: "1" },
      { id: "system", role: "system", createdAt: "3", turnId: "removed" },
      { id: "linked", role: "user", createdAt: "4", turnId: "kept" },
      { id: "removed", role: "assistant", createdAt: "0", turnId: "removed" },
      { id: "answer", role: "assistant", createdAt: "1", turnId: null },
      { id: "linked-answer", role: "assistant", createdAt: "4", turnId: "kept" },
    ];
    const result = retainThreadMessagesAfterRevert(messages, new Set(["kept"]), 2);
    expect(result.map((message) => message.id)).toEqual([
      "a",
      "system",
      "linked",
      "answer",
      "linked-answer",
    ]);
    expect(result[0]).toBe(messages[2]);
    expect(messages).toHaveLength(8);
  });

  it("retains only system messages when reverting all turns", () => {
    const messages = [
      { id: "user", role: "user", createdAt: "1" },
      { id: "system", role: "system", createdAt: "1" },
    ];
    expect(retainThreadMessagesAfterRevert(messages, new Set(), 0)).toEqual([messages[1]]);
  });

  it("preserves thread-level items and only the retained turn's items", () => {
    const items = [{ turnId: null }, { turnId: "kept" }, { turnId: "removed" }];
    expect(retainThreadItemsAfterRevert(items, new Set(["kept"]))).toEqual(items.slice(0, 2));
  });
});
