import type { ChangeTypes, FileDiffMetadata } from "@pierre/diffs";

import type { TurnDiffTreeNode } from "../lib/turnDiffTree";

export type DiffFileStatus = "added" | "deleted" | "renamed" | "modified";

export const DIFF_FILE_TREE_DEFAULT_WIDTH = 224;
export const DIFF_FILE_TREE_MIN_WIDTH = 160;
const DIFF_FILE_TREE_MAX_WIDTH = 560;
const DIFF_CONTENT_MIN_WIDTH = 256;

export function resolveDiffFileTreeMaxWidth(bodyWidth: number): number {
  return Math.max(
    DIFF_FILE_TREE_MIN_WIDTH,
    Math.min(DIFF_FILE_TREE_MAX_WIDTH, bodyWidth - DIFF_CONTENT_MIN_WIDTH),
  );
}

export function clampDiffFileTreeWidth(width: number, bodyWidth: number): number {
  return Math.max(
    DIFF_FILE_TREE_MIN_WIDTH,
    Math.min(resolveDiffFileTreeMaxWidth(bodyWidth), width),
  );
}

export interface DiffFileTreeEntry {
  path: string;
  status: DiffFileStatus;
  additions: number;
  deletions: number;
}

export function resolveDiffFileStatus(type: ChangeTypes): DiffFileStatus {
  switch (type) {
    case "new":
      return "added";
    case "deleted":
      return "deleted";
    case "rename-pure":
    case "rename-changed":
      return "renamed";
    default:
      return "modified";
  }
}

/** The parser already removed git's a/ and b/; any left are real folders. Deleted files only carry their previous name. */
export function resolveFileDiffPath(fileDiff: Pick<FileDiffMetadata, "name" | "prevName">): string {
  return fileDiff.name || fileDiff.prevName || "";
}

/**
 * One entry per path, in the diff's order. A type change (file to symlink) arrives as a
 * deletion plus an addition of the same path, which the tree shows as one modified file.
 */
export function buildDiffFileTreeEntries(
  files: ReadonlyArray<Pick<FileDiffMetadata, "name" | "prevName" | "type" | "hunks">>,
): DiffFileTreeEntry[] {
  const entries = new Map<string, DiffFileTreeEntry>();
  for (const file of files) {
    const path = resolveFileDiffPath(file);
    const status = resolveDiffFileStatus(file.type);
    const entry = entries.get(path) ?? { path, status, additions: 0, deletions: 0 };
    if (entry.status !== status) entry.status = "modified";
    for (const hunk of file.hunks) {
      entry.additions += hunk.additionLines;
      entry.deletions += hunk.deletionLines;
    }
    entries.set(path, entry);
  }
  return [...entries.values()];
}

export function collectDiffTreeDirectoryPaths(nodes: ReadonlyArray<TurnDiffTreeNode>): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    if (node.kind !== "directory") continue;
    paths.push(node.path, ...collectDiffTreeDirectoryPaths(node.children));
  }
  return paths;
}

/**
 * The file in view is the last one whose top edge has scrolled to (or past) the viewport top,
 * offset by `threshold` so a header just below the top already counts. Positions are in DOM order.
 */
export function resolveActiveDiffFilePath(
  positions: ReadonlyArray<{ path: string; top: number }>,
  threshold: number,
  scrolledToBottom?: { viewportHeight: number; currentPath: string | null },
): string | null {
  // Files near the end can never reach the top, so at the bottom any header in view qualifies.
  if (scrolledToBottom) {
    const inView = positions.filter(
      (position) => position.top >= -1 && position.top < scrolledToBottom.viewportHeight,
    );
    if (inView.some((position) => position.path === scrolledToBottom.currentPath)) {
      return scrolledToBottom.currentPath;
    }
    const lastInView = inView.at(-1);
    if (lastInView) return lastInView.path;
  }
  let active: string | null = positions[0]?.path ?? null;
  for (const position of positions) {
    if (position.top > threshold) break;
    active = position.path;
  }
  return active;
}
