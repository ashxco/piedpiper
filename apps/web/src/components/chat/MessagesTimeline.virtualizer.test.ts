import { describe, expect, it } from "vitest";

import { AUTO_SCROLL_BOTTOM_THRESHOLD_PX } from "../../chat-scroll";
import {
  extractTimelineRowRange,
  shouldAdjustTimelineScrollOnItemSizeChange,
} from "./MessagesTimeline.virtualizer";

function instance(scrollOffset: number, totalSize: number) {
  return { scrollRect: { width: 800, height: 500 }, scrollOffset, getTotalSize: () => totalSize };
}

describe("shouldAdjustTimelineScrollOnItemSizeChange", () => {
  it("never adjusts for rows inside the viewport", () => {
    expect(
      shouldAdjustTimelineScrollOnItemSizeChange({ start: 900, end: 1100 }, instance(1000, 5000)),
    ).toBe(false);
  });

  it("adjusts for offscreen rows only when away from the bottom", () => {
    const row = { start: 100, end: 200 };
    expect(shouldAdjustTimelineScrollOnItemSizeChange(row, instance(1000, 5000))).toBe(true);
    expect(
      shouldAdjustTimelineScrollOnItemSizeChange(
        row,
        instance(1000, 1500 + AUTO_SCROLL_BOTTOM_THRESHOLD_PX),
      ),
    ).toBe(false);
  });
});

describe("extractTimelineRowRange", () => {
  const range = { startIndex: 50, endIndex: 52, overscan: 1, count: 120 };

  it("adds the pinned row in sorted order", () => {
    expect(extractTimelineRowRange(range, 0)).toEqual([0, 49, 50, 51, 52, 53]);
    expect(extractTimelineRowRange(range, 100)).toEqual([49, 50, 51, 52, 53, 100]);
  });

  it("does not repeat a pinned row already in range", () => {
    expect(extractTimelineRowRange(range, 51)).toEqual([49, 50, 51, 52, 53]);
  });

  it("ignores a missing or out-of-bounds pinned row", () => {
    const expected = [49, 50, 51, 52, 53];
    expect(extractTimelineRowRange(range, null)).toEqual(expected);
    expect(extractTimelineRowRange(range, -1)).toEqual(expected);
    expect(extractTimelineRowRange(range, 120)).toEqual(expected);
  });
});
