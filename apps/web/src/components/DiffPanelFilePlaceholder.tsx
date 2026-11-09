import { type CSSProperties, memo } from "react";

import { DIFF_FILE_PLACEHOLDER_HEADER_HEIGHT } from "../lib/lazyDiffFileMount";

/**
 * Stands in for a viewer until its file nears the viewport. Only the header attributes the panel
 * reads are set, which keeps a click on it folding the file like a click on the real header.
 */
export const DiffPanelFilePlaceholder = memo(function DiffPanelFilePlaceholder({
  filePath,
  fileBlockKey,
  height,
  lineHeight,
  observe,
}: {
  filePath: string;
  fileBlockKey: string;
  height: number;
  lineHeight: number;
  observe: (element: HTMLElement | null) => (() => void) | undefined;
}) {
  return (
    <div
      ref={observe}
      data-diff-file-placeholder={fileBlockKey}
      className="diff-render-file-placeholder"
      style={{ height, "--diff-placeholder-line-height": `${lineHeight}px` } as CSSProperties}
    >
      <div
        data-diffs-header=""
        className="diff-render-file-placeholder-header"
        style={{ height: DIFF_FILE_PLACEHOLDER_HEADER_HEIGHT }}
      >
        <span data-title="" className="min-w-0 truncate">
          {/* Keeps a path left to right under the title's rtl, as the viewer's own header does. */}
          <bdi>{filePath}</bdi>
        </span>
      </div>
    </div>
  );
});
