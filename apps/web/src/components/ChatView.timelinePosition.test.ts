import { afterEach, describe, expect, it, vi } from "vitest";

import {
  captureTimelinePosition,
  expandedWorkGroupsFromPosition,
  registerTimelineRowScroller,
  scrollTimelineRowToStart,
  stepTimelinePositionRestore,
  TIMELINE_POSITION_CACHE_LIMIT,
  TimelinePositionCache,
  type TimelinePosition,
} from "./ChatView.timelinePosition";

function position(scrollTop: number): TimelinePosition {
  return {
    anchorRowId: `row-${scrollTop}`,
    anchorOffsetPx: 12,
    scrollTop,
    atEnd: false,
    expandedWorkGroupIds: [],
  };
}

describe("TimelinePositionCache", () => {
  it("keeps at most the limit and evicts the least recently used thread", () => {
    const cache = new TimelinePositionCache(3);
    cache.set("a", position(1));
    cache.set("b", position(2));
    cache.set("c", position(3));
    expect(cache.get("a")?.scrollTop).toBe(1);

    cache.set("d", position(4));

    expect(cache.size).toBe(3);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")?.scrollTop).toBe(1);
    expect(cache.get("c")?.scrollTop).toBe(3);
    expect(cache.get("d")?.scrollTop).toBe(4);
  });

  it("defaults to about a hundred threads", () => {
    const cache = new TimelinePositionCache();
    for (let index = 0; index < TIMELINE_POSITION_CACHE_LIMIT + 25; index += 1) {
      cache.set(`thread-${index}`, position(index));
    }
    expect(TIMELINE_POSITION_CACHE_LIMIT).toBe(100);
    expect(cache.size).toBe(TIMELINE_POSITION_CACHE_LIMIT);
    expect(cache.get("thread-0")).toBeUndefined();
    expect(cache.get(`thread-${TIMELINE_POSITION_CACHE_LIMIT + 24}`)).toBeDefined();
  });

  it("records expanded work groups without dropping the scroll anchor", () => {
    const cache = new TimelinePositionCache();
    cache.set("a", position(40));
    cache.setExpandedWorkGroups("a", { "work-1": true, "work-2": false, "work-3": true });

    const saved = cache.get("a");
    expect(saved?.anchorRowId).toBe("row-40");
    expect(saved?.expandedWorkGroupIds).toEqual(["work-1", "work-3"]);
    expect(expandedWorkGroupsFromPosition(saved)).toEqual({ "work-1": true, "work-3": true });
  });

  it("treats a thread with only expanded groups as at the end", () => {
    const cache = new TimelinePositionCache();
    cache.setExpandedWorkGroups("fresh", { "work-1": true });
    expect(cache.get("fresh")).toMatchObject({ atEnd: true, anchorRowId: null });
    expect(expandedWorkGroupsFromPosition(undefined)).toEqual({});
  });
});

/** A scroll container whose rows sit at fixed content offsets, so rects follow scrollTop. */
function fakeTimeline(rows: Array<{ id: string; top: number; height: number }>) {
  const container = {
    scrollTop: 0,
    scrollHeight: 5000,
    clientHeight: 400,
    getBoundingClientRect: () => ({ top: 100 }),
    querySelectorAll: () =>
      rows.map((row) => ({
        dataset: { timelineRowId: row.id },
        getBoundingClientRect: () => {
          const top = 100 + row.top - container.scrollTop;
          return { top, bottom: top + row.height, height: row.height };
        },
      })),
    querySelector: (selector: string) =>
      container
        .querySelectorAll()
        .find((row) => selector.includes(`"${row.dataset.timelineRowId}"`)) ?? null,
  };
  return container;
}

describe("timeline position capture and restore", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("captures the topmost visible row and its offset", () => {
    const container = fakeTimeline([
      { id: "a", top: 0, height: 300 },
      { id: "b", top: 300, height: 300 },
      { id: "c", top: 600, height: 300 },
    ]);
    container.scrollTop = 350;

    const captured = captureTimelinePosition(container as unknown as HTMLElement, ["work-1"]);

    expect(captured).toEqual({
      anchorRowId: "b",
      anchorOffsetPx: -50,
      scrollTop: 350,
      atEnd: false,
      expandedWorkGroupIds: ["work-1"],
    });
  });

  it("scrolls the anchor row back to its saved offset, or to the saved scrollTop when unrendered", () => {
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    const container = fakeTimeline([{ id: "b", top: 900, height: 300 }]);
    const saved = {
      anchorRowId: "b",
      anchorOffsetPx: -50,
      scrollTop: 350,
      atEnd: false,
      expandedWorkGroupIds: [],
    };

    expect(stepTimelinePositionRestore(container as unknown as HTMLElement, saved)).toBe(950);
    expect(container.scrollTop).toBe(950);
    expect(stepTimelinePositionRestore(container as unknown as HTMLElement, saved)).toBe(0);

    const missing = { ...saved, anchorRowId: "gone" };
    expect(stepTimelinePositionRestore(container as unknown as HTMLElement, missing)).toBeNull();
    expect(container.scrollTop).toBe(350);
  });

  it("scrolls a far virtualized anchor through the virtualizer instead of the raw scrollTop", () => {
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    const container = fakeTimeline([]);
    const saved = {
      anchorRowId: "far",
      anchorOffsetPx: 0,
      scrollTop: 350,
      atEnd: false,
      expandedWorkGroupIds: [],
    };
    const scroller = vi.fn((_rowId: string) => "scrolled" as const);

    expect(
      stepTimelinePositionRestore(container as unknown as HTMLElement, saved, scroller),
    ).toBeNull();
    expect(scroller).toHaveBeenCalledWith("far");
    expect(container.scrollTop).toBe(0);

    expect(
      stepTimelinePositionRestore(container as unknown as HTMLElement, saved, () => "missing"),
    ).toBe(0);
    expect(container.scrollTop).toBe(350);
  });
});

describe("timeline row scroller registry", () => {
  it("routes to the registered timeline and ignores a stale unregister", () => {
    const first = vi.fn(() => "scrolled" as const);
    const second = vi.fn(() => "not-virtualized" as const);
    const unregisterFirst = registerTimelineRowScroller("thread-a", first);
    const unregisterSecond = registerTimelineRowScroller("thread-a", second);

    unregisterFirst();
    expect(scrollTimelineRowToStart("thread-a", "row-1")).toBe("not-virtualized");
    expect(second).toHaveBeenCalledWith("row-1");
    expect(first).not.toHaveBeenCalled();

    unregisterSecond();
    expect(scrollTimelineRowToStart("thread-a", "row-1")).toBeNull();
  });
});
