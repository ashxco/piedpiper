import { DEFAULT_VIRTUAL_FILE_METRICS, type FileDiffMetadata } from "@pierre/diffs";

/**
 * Up to this many shown files every viewer mounts at once. Each viewer measures itself as it mounts,
 * which forces a layout of everything mounted before it, so the cost of one commit grows with the
 * square of the file count.
 */
export const LAZY_DIFF_FILE_MOUNT_THRESHOLD = 40;

/** Above the viewer's own 1200px margin, so a viewer exists before it is asked for rows. */
export const LAZY_DIFF_FILE_MOUNT_ROOT_MARGIN_PX = 1600;

/** Keep a wider range than we mount, so reversing direction can reuse recent viewers. */
export const LAZY_DIFF_FILE_RETAIN_MARGIN_PX = 3 * LAZY_DIFF_FILE_MOUNT_ROOT_MARGIN_PX;
export const LAZY_DIFF_FILE_EVICTION_DELAY_MS = 250;

export const DIFF_SCROLLER_SELECTOR = ".diff-render-surface";

/**
 * Viewers a frame may add while scrolling. Each one forces a layout as it measures itself, so a drag
 * across the patch stays responsive, and the files it has already passed never get one.
 */
export const LAZY_DIFF_FILE_MOUNTS_PER_FRAME = 4;

export function shouldLazyMountDiffFiles(shownFileCount: number): boolean {
  return shownFileCount > LAZY_DIFF_FILE_MOUNT_THRESHOLD;
}

export const DIFF_FILE_PLACEHOLDER_HEADER_HEIGHT = DEFAULT_VIRTUAL_FILE_METRICS.diffHeaderHeight;

/**
 * The height a viewer gives itself before it has measured a row, for the options the panel passes:
 * hunk separators of the default kind, and unchanged lines shown only by full-context files. Being
 * the same number, a swap moves nothing until the viewer renders rows that wrap, and then it is the
 * viewer's own scroll correction that applies. Saved comment cards are not counted.
 */
export function estimateDiffFileHeight(
  file: Pick<FileDiffMetadata, "hunks" | "isPartial" | "additionLines" | "deletionLines">,
  layout: { split: boolean; collapsed: boolean; lineHeight: number },
): number {
  const {
    diffHeaderHeight,
    spacing,
    paddingTop = 0,
    paddingBottom = spacing,
    hunkSeparatorHeight = 32,
  } = DEFAULT_VIRTUAL_FILE_METRICS;
  if (layout.collapsed) return diffHeaderHeight;
  const { lineHeight, split } = layout;

  let height = diffHeaderHeight + paddingTop;
  for (const [hunkIndex, hunk] of file.hunks.entries()) {
    if (hunk.collapsedBefore > 0) {
      height += file.isPartial
        ? (hunkIndex > 0 ? spacing : 0) + hunkSeparatorHeight + spacing
        : hunk.collapsedBefore * lineHeight;
    }
    height += (split ? hunk.splitLineCount : hunk.unifiedLineCount) * lineHeight;
    height += countNoNewlineRows(hunk, split) * lineHeight;
  }
  if (file.hunks.length > 0) height += paddingBottom;
  return height + countTrailingUnchangedRows(file) * lineHeight;
}

type DiffHunk = FileDiffMetadata["hunks"][number];

/** The "No newline at end of file" row; in split layout both sides share one. */
function countNoNewlineRows(hunk: DiffHunk, split: boolean): number {
  if (!hunk.noEOFCRAdditions && !hunk.noEOFCRDeletions) return 0;
  const last = hunk.hunkContent.at(-1);
  if (!last) return 0;
  if (last.type === "context") return last.lines > 0 ? 1 : 0;
  const onDeletions = last.deletions > 0 && hunk.noEOFCRDeletions;
  const onAdditions = last.additions > 0 && hunk.noEOFCRAdditions;
  if (split) return onDeletions || onAdditions ? 1 : 0;
  return (onDeletions ? 1 : 0) + (onAdditions ? 1 : 0);
}

/** The lines after the last hunk, which only a full-context file has. */
function countTrailingUnchangedRows(
  file: Pick<FileDiffMetadata, "hunks" | "isPartial" | "additionLines" | "deletionLines">,
): number {
  const last = file.hunks.at(-1);
  if (
    !last ||
    file.isPartial ||
    file.additionLines.length === 0 ||
    file.deletionLines.length === 0
  ) {
    return 0;
  }
  return Math.max(
    0,
    Math.min(
      file.additionLines.length - countLinesThroughHunk(last.additionStart, last.additionCount),
      file.deletionLines.length - countLinesThroughHunk(last.deletionStart, last.deletionCount),
    ),
  );
}

/** A side with no lines in the hunk has the line before it as its start, not the first of its own. */
function countLinesThroughHunk(start: number, count: number): number {
  return start - (count === 0 ? 0 : 1) + count;
}

/** The next files to mount: the ones in view first, then outwards from it, then down the patch. */
export function pickDiffFileKeysToMount(
  pending: ReadonlyArray<{ key: string; top: number; bottom: number }>,
  viewport: { top: number; bottom: number },
  limit: number,
): string[] {
  const distanceToViewport = (file: { top: number; bottom: number }) =>
    Math.max(0, viewport.top - file.bottom, file.top - viewport.bottom);
  return pending
    .toSorted(
      (left, right) => distanceToViewport(left) - distanceToViewport(right) || left.top - right.top,
    )
    .slice(0, limit)
    .map((file) => file.key);
}

/** Returns `current` when nothing is new, so a caller can tell that no state has to change. */
export function addMountedDiffFileKeys(
  current: ReadonlySet<string>,
  keys: Iterable<string>,
): ReadonlySet<string> {
  let next: Set<string> | null = null;
  for (const key of keys) {
    if (current.has(key) || next?.has(key)) continue;
    next ??= new Set(current);
    next.add(key);
  }
  return next ?? current;
}

/**
 * Below the threshold every shown file counts as mounted, so a patch that grows past it keeps the
 * viewers it already has. With no files shown the set empties, because the scroller has gone too
 * and a reload starts back at the top, where nothing further down needs a viewer.
 */
export function resolveMountedDiffFileKeys(
  current: ReadonlySet<string>,
  input: { fileKeys: ReadonlyArray<string>; requiredKeys: Iterable<string> },
): ReadonlySet<string> {
  if (shouldLazyMountDiffFiles(input.fileKeys.length)) {
    return addMountedDiffFileKeys(current, input.requiredKeys);
  }
  const all = new Set(input.fileKeys);
  return all.size === current.size && input.fileKeys.every((key) => current.has(key))
    ? current
    : all;
}
