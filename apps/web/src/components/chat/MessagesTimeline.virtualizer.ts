import {
  defaultRangeExtractor,
  measureElement as measureVirtualElement,
  type Range,
  type VirtualItem,
  type Virtualizer,
  useVirtualizer,
} from "@tanstack/react-virtual";
import { useCallback, useEffect } from "react";

import { AUTO_SCROLL_BOTTOM_THRESHOLD_PX } from "../../chat-scroll";

export interface TimelineRowVirtualizer {
  virtualItems: ReadonlyArray<VirtualItem>;
  totalSize: number;
  measure: () => void;
  measureElement: (node: Element | null) => void;
  scrollToIndex: (index: number, options?: { align?: "start" | "center" | "end" | "auto" }) => void;
  /** Current layout read straight from the instance, for effects and event handlers. */
  readLayout: () => { totalSize: number; measurements: ReadonlyArray<VirtualItem> };
}

/** Keep rows visible in the viewport anchored; only shift scroll for offscreen rows when away from the bottom. */
export function shouldAdjustTimelineScrollOnItemSizeChange(
  item: Pick<VirtualItem, "start" | "end">,
  instance: Pick<
    Virtualizer<HTMLDivElement, Element>,
    "scrollRect" | "scrollOffset" | "getTotalSize"
  >,
): boolean {
  const viewportHeight = instance.scrollRect?.height ?? 0;
  const scrollOffset = instance.scrollOffset ?? 0;
  const itemIntersectsViewport =
    item.end > scrollOffset && item.start < scrollOffset + viewportHeight;
  if (itemIntersectsViewport) {
    return false;
  }
  const remainingDistance = instance.getTotalSize() - (scrollOffset + viewportHeight);
  return remainingDistance > AUTO_SCROLL_BOTTOM_THRESHOLD_PX;
}

/** The default virtual range plus an always-mounted row, sorted and without duplicates. */
export function extractTimelineRowRange(range: Range, pinnedRowIndex: number | null): number[] {
  const indexes = defaultRangeExtractor(range);
  if (
    pinnedRowIndex === null ||
    pinnedRowIndex < 0 ||
    pinnedRowIndex >= range.count ||
    indexes.includes(pinnedRowIndex)
  ) {
    return indexes;
  }
  return [...indexes, pinnedRowIndex].toSorted((left, right) => left - right);
}

/**
 * TanStack's useVirtualizer is flagged as incompatible by the React Compiler, so it lives in this
 * hook (which the compiler skips) and returns plain per-render values instead of the instance.
 */
export function useTimelineRowVirtualizer(input: {
  count: number;
  scrollContainer: HTMLDivElement | null;
  getItemKey: (index: number) => string;
  estimateSize: (index: number) => number;
  timelineWidthPx: number | null;
  /** Row that stays mounted however far the viewport is from it. */
  pinnedRowIndex?: number | null;
}): TimelineRowVirtualizer {
  const { timelineWidthPx } = input;
  const pinnedRowIndex = input.pinnedRowIndex ?? null;
  const rangeExtractor = useCallback(
    (range: Range) => extractTimelineRowRange(range, pinnedRowIndex),
    [pinnedRowIndex],
  );
  const rowVirtualizer = useVirtualizer({
    count: input.count,
    getScrollElement: () => input.scrollContainer,
    getItemKey: input.getItemKey,
    estimateSize: input.estimateSize,
    measureElement: measureVirtualElement,
    useAnimationFrameWithResizeObserver: true,
    overscan: 8,
    rangeExtractor,
  });
  useEffect(() => {
    if (timelineWidthPx === null) return;
    rowVirtualizer.measure();
  }, [rowVirtualizer, timelineWidthPx]);
  // Not a constructor option in @tanstack/virtual-core 3.13, only an instance field.
  useEffect(() => {
    rowVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) =>
      shouldAdjustTimelineScrollOnItemSizeChange(item, instance);
    return () => {
      rowVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = undefined;
    };
  }, [rowVirtualizer]);

  const readLayout = useCallback(
    () => ({
      totalSize: rowVirtualizer.getTotalSize(),
      measurements: rowVirtualizer.measurementsCache,
    }),
    [rowVirtualizer],
  );

  return {
    virtualItems: rowVirtualizer.getVirtualItems(),
    totalSize: rowVirtualizer.getTotalSize(),
    measure: rowVirtualizer.measure,
    measureElement: rowVirtualizer.measureElement,
    scrollToIndex: rowVirtualizer.scrollToIndex,
    readLayout,
  };
}
