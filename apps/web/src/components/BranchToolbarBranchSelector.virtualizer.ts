import { useVirtualizer } from "@tanstack/react-virtual";
import type { RefObject } from "react";

// useVirtualizer returns a stable mutable object, so it lives in its own hook that the compiler skips
// and hands the component plain per-render values instead.
export function useBranchListVirtualizer(input: {
  count: number;
  enabled: boolean;
  estimateSize: (index: number) => number;
  scrollElementRef: RefObject<HTMLDivElement | null>;
}) {
  "use no memo";
  const virtualizer = useVirtualizer({
    count: input.count,
    estimateSize: input.estimateSize,
    getScrollElement: () => input.scrollElementRef.current,
    overscan: 12,
    enabled: input.enabled,
    initialRect: {
      height: 224,
      width: 0,
    },
  });
  return {
    virtualRows: virtualizer.getVirtualItems(),
    totalSize: virtualizer.getTotalSize(),
    // Virtualizer methods are instance-bound and stable across renders.
    measure: virtualizer.measure,
    scrollToIndex: virtualizer.scrollToIndex,
  };
}
