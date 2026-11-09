import { useLayoutEffect } from "react";

import { isScrollContainerNearBottom } from "../chat-scroll";

/** Where a thread's timeline was left, so switching back can put the reader in the same spot. */
export interface TimelinePosition {
  /** Topmost visible row, or null when no row was rendered. */
  readonly anchorRowId: string | null;
  /** Distance in px from the scroll container's top edge to the anchor row's top edge. */
  readonly anchorOffsetPx: number;
  /** Raw scrollTop, used to bring a virtualized anchor row back into the DOM. */
  readonly scrollTop: number;
  /** At the end: reopening keeps the default stick-to-bottom behaviour. */
  readonly atEnd: boolean;
  readonly expandedWorkGroupIds: ReadonlyArray<string>;
}

export const TIMELINE_POSITION_CACHE_LIMIT = 100;

const TIMELINE_ROW_SELECTOR = "[data-timeline-row-id]";

/** Small LRU keyed by thread id; Map iteration order is insertion order, so the first key is the oldest. */
export class TimelinePositionCache {
  readonly #limit: number;
  readonly #entries = new Map<string, TimelinePosition>();

  constructor(limit = TIMELINE_POSITION_CACHE_LIMIT) {
    this.#limit = Math.max(1, limit);
  }

  get size(): number {
    return this.#entries.size;
  }

  get(threadId: string): TimelinePosition | undefined {
    const entry = this.#entries.get(threadId);
    if (entry === undefined) return undefined;
    this.#entries.delete(threadId);
    this.#entries.set(threadId, entry);
    return entry;
  }

  set(threadId: string, position: TimelinePosition): void {
    this.#entries.delete(threadId);
    this.#entries.set(threadId, position);
    while (this.#entries.size > this.#limit) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) break;
      this.#entries.delete(oldest.value);
    }
  }

  clear(): void {
    this.#entries.clear();
  }

  setExpandedWorkGroups(threadId: string, expandedWorkGroups: Record<string, boolean>): void {
    const expandedWorkGroupIds = Object.keys(expandedWorkGroups).filter(
      (groupId) => expandedWorkGroups[groupId] === true,
    );
    const existing = this.#entries.get(threadId);
    this.set(threadId, {
      ...(existing ?? {
        anchorRowId: null,
        anchorOffsetPx: 0,
        scrollTop: 0,
        atEnd: true,
      }),
      expandedWorkGroupIds,
    });
  }
}

export const timelinePositionCache = new TimelinePositionCache();

export function expandedWorkGroupsFromPosition(
  position: TimelinePosition | undefined,
): Record<string, boolean> {
  const expanded: Record<string, boolean> = {};
  for (const groupId of position?.expandedWorkGroupIds ?? []) expanded[groupId] = true;
  return expanded;
}

/** Reads the topmost visible timeline row (virtualized or plain) and its offset from the container top. */
export function captureTimelinePosition(
  scrollContainer: HTMLElement,
  expandedWorkGroupIds: ReadonlyArray<string>,
): TimelinePosition {
  const containerTop = scrollContainer.getBoundingClientRect().top;
  let anchorRowId: string | null = null;
  let anchorTop = Number.POSITIVE_INFINITY;
  for (const element of scrollContainer.querySelectorAll<HTMLElement>(TIMELINE_ROW_SELECTOR)) {
    const rect = element.getBoundingClientRect();
    if (rect.height <= 0 || rect.bottom <= containerTop + 1) continue;
    if (rect.top < anchorTop) {
      anchorTop = rect.top;
      anchorRowId = element.dataset.timelineRowId ?? null;
    }
  }
  return {
    anchorRowId,
    anchorOffsetPx: anchorRowId === null ? 0 : anchorTop - containerTop,
    scrollTop: scrollContainer.scrollTop,
    atEnd: isScrollContainerNearBottom(scrollContainer),
    expandedWorkGroupIds,
  };
}

/**
 * How a timeline brings a row to the top of its viewport: "scrolled" when it asked the
 * virtualizer to scroll to it, "not-virtualized" for a plain DOM row, "missing" when the
 * row id is no longer in the timeline.
 */
export type TimelineRowScrollResult = "scrolled" | "not-virtualized" | "missing";
export type TimelineRowScroller = (rowId: string) => TimelineRowScrollResult;

const timelineRowScrollers = new Map<string, TimelineRowScroller>();

/** Registers the mounted timeline's row scroller for a thread; returns the unregister function. */
export function registerTimelineRowScroller(
  threadId: string,
  scroller: TimelineRowScroller,
): () => void {
  timelineRowScrollers.set(threadId, scroller);
  return () => {
    if (timelineRowScrollers.get(threadId) === scroller) timelineRowScrollers.delete(threadId);
  };
}

/**
 * For MessagesTimeline: registers a stable scroller (e.g. useStableCallback) that calls the
 * virtualizer's scrollToIndex for virtualized rows. Child layout effects run before the
 * parent's, so it is in place when ChatView starts a restore.
 */
export function useTimelineRowScroller(threadId: string, scroller: TimelineRowScroller): void {
  useLayoutEffect(() => registerTimelineRowScroller(threadId, scroller), [threadId, scroller]);
}

/** Scrolls a thread's row into the timeline viewport; null when no timeline is registered. */
export function scrollTimelineRowToStart(
  threadId: string,
  rowId: string,
): TimelineRowScrollResult | null {
  return timelineRowScrollers.get(threadId)?.(rowId) ?? null;
}

/**
 * One restore step: brings the anchor row back to its saved offset. Returns the remaining
 * distance in px, or null when the row is not in the DOM yet (a far virtualized row). Such a
 * row is scrolled to through the virtualizer, since row heights above it are only estimates
 * after a remount; without a scroller (or for a row that is gone) the saved scrollTop is used.
 */
export function stepTimelinePositionRestore(
  scrollContainer: HTMLElement,
  position: TimelinePosition,
  scrollRowToStart?: (rowId: string) => TimelineRowScrollResult | null,
): number | null {
  const anchor =
    position.anchorRowId === null
      ? null
      : scrollContainer.querySelector<HTMLElement>(
          `[data-timeline-row-id="${CSS.escape(position.anchorRowId)}"]`,
        );
  if (!anchor) {
    const scrollResult =
      position.anchorRowId === null ? null : (scrollRowToStart?.(position.anchorRowId) ?? null);
    if (scrollResult === "scrolled") return null;
    if (Math.abs(scrollContainer.scrollTop - position.scrollTop) >= 1) {
      scrollContainer.scrollTop = position.scrollTop;
    }
    // A row that no longer exists cannot come back, so the raw offset is final.
    return scrollResult === "missing" ? 0 : null;
  }
  const currentOffset =
    anchor.getBoundingClientRect().top - scrollContainer.getBoundingClientRect().top;
  const delta = currentOffset - position.anchorOffsetPx;
  if (Math.abs(delta) >= 1) scrollContainer.scrollTop += delta;
  return delta;
}
