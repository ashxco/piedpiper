import type { FileDiffMetadata } from "@pierre/diffs";
import { useState } from "react";
import { shallow } from "zustand/vanilla/shallow";

import { estimateDiffFileHeight } from "../lib/lazyDiffFileMount";
import type { ReviewCommentContext } from "../reviewCommentContext";
import { useStableCallback } from "./useStableCallback";

interface DiffFileLayout {
  fileDiff: FileDiffMetadata;
  split: boolean;
  collapsed: boolean;
  lineHeight: number;
  wordWrap: boolean;
  comments: ReadonlyArray<ReviewCommentContext>;
}

/** Reuses an evicted viewer's height until its contents or layout change. */
export function useDiffFilePlaceholderHeight(layout: DiffFileLayout) {
  const [measurement, setMeasurement] = useState<{
    layout: DiffFileLayout;
    height: number;
  } | null>(null);
  const preserveHeight = useStableCallback((height: number) => {
    setMeasurement({ layout, height });
  });

  return {
    height:
      measurement && shallow(measurement.layout, layout)
        ? measurement.height
        : estimateDiffFileHeight(layout.fileDiff, layout),
    preserveHeight,
  };
}
