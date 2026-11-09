import type { FileDiffMetadata, SelectedLineRange } from "@pierre/diffs";

import { shortcutKeyFromEvent } from "../keybindingShortcutKeys";
import { isMacPlatform } from "./utils";

/** Enough to navigate; a one-letter query on a huge diff must not allocate millions of matches. */
export const MAX_DIFF_FIND_MATCHES = 10_000;

/** Marks the panel while it can search, so a thread-wide find on the same chord stands down. */
export const DIFF_FIND_SCOPE_ATTRIBUTE = "data-diff-find-scope";

export type DiffFindSide = "additions" | "deletions";

export interface DiffFindFile {
  /** Identifies one rendered block; a type change has two blocks for one path. */
  fileKey: string;
  file: FileDiffMetadata;
}

export interface DiffFindMatch {
  fileKey: string;
  side: DiffFindSide;
  lineNumber: number;
  /** Which match on this line, counted from its start. */
  occurrence: number;
  isContext: boolean;
  /** Rendered row inside the file, for estimating where a row that is not mounted will land. */
  unifiedRow: number;
  splitRow: number;
  separators: number;
  /** The whole line, which identifies the match when an edit above moves its line number. */
  lineText: string;
}

export interface DiffFindResult {
  matches: DiffFindMatch[];
  truncated: boolean;
}

export function buildDiffFindPattern(query: string): RegExp | null {
  if (query.length === 0) return null;
  return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
}

type DiffFindLine = Omit<DiffFindMatch, "fileKey" | "occurrence" | "lineText"> & { text: string };

/** Render order. Unchanged lines exist in both columns but are visited once, on the new side. */
function forEachDiffFileLine(
  file: FileDiffMetadata,
  visit: (line: DiffFindLine) => boolean,
): boolean {
  // Full-context files show the lines between hunks too; hidden ones are not in a patch at all.
  const showsUnchanged = !file.isPartial;
  let unifiedRow = 0;
  let splitRow = 0;
  let separators = 0;

  const visitUnchangedLine = (additionIndex: number, lineNumber: number) => {
    const keepGoing = visit({
      side: "additions",
      lineNumber,
      isContext: true,
      text: file.additionLines[additionIndex] ?? "",
      unifiedRow,
      splitRow,
      separators,
    });
    unifiedRow += 1;
    splitRow += 1;
    return keepGoing;
  };

  for (const hunk of file.hunks) {
    if (hunk.collapsedBefore > 0) {
      if (showsUnchanged) {
        const firstIndex = hunk.additionLineIndex - hunk.collapsedBefore;
        for (let index = firstIndex; index < hunk.additionLineIndex; index += 1) {
          if (!visitUnchangedLine(index, index + 1)) return false;
        }
      } else {
        separators += 1;
      }
    }

    let additionLine = hunk.additionStart;
    let deletionLine = hunk.deletionStart;
    for (const content of hunk.hunkContent) {
      if (content.type === "context") {
        for (let offset = 0; offset < content.lines; offset += 1) {
          if (!visitUnchangedLine(content.additionLineIndex + offset, additionLine + offset)) {
            return false;
          }
        }
        additionLine += content.lines;
        deletionLine += content.lines;
        continue;
      }
      for (let offset = 0; offset < content.deletions; offset += 1) {
        const keepGoing = visit({
          side: "deletions",
          lineNumber: deletionLine + offset,
          isContext: false,
          text: file.deletionLines[content.deletionLineIndex + offset] ?? "",
          unifiedRow: unifiedRow + offset,
          splitRow: splitRow + offset,
          separators,
        });
        if (!keepGoing) return false;
      }
      for (let offset = 0; offset < content.additions; offset += 1) {
        const keepGoing = visit({
          side: "additions",
          lineNumber: additionLine + offset,
          isContext: false,
          text: file.additionLines[content.additionLineIndex + offset] ?? "",
          unifiedRow: unifiedRow + content.deletions + offset,
          splitRow: splitRow + offset,
          separators,
        });
        if (!keepGoing) return false;
      }
      unifiedRow += content.deletions + content.additions;
      splitRow += Math.max(content.deletions, content.additions);
      additionLine += content.additions;
      deletionLine += content.deletions;
    }
  }

  const lastHunk = file.hunks.at(-1);
  if (showsUnchanged && lastHunk) {
    const firstIndex = lastHunk.additionLineIndex + lastHunk.additionCount;
    for (let index = firstIndex; index < file.additionLines.length; index += 1) {
      if (!visitUnchangedLine(index, index + 1)) return false;
    }
  }
  return true;
}

export function collectDiffFindMatches(
  files: ReadonlyArray<DiffFindFile>,
  query: string,
): DiffFindResult {
  const pattern = buildDiffFindPattern(query);
  const matches: DiffFindMatch[] = [];
  if (!pattern) return { matches, truncated: false };

  for (const { fileKey, file } of files) {
    const finished = forEachDiffFileLine(file, ({ text, ...line }) => {
      let occurrence = 0;
      for (const _match of text.matchAll(pattern)) {
        if (matches.length === MAX_DIFF_FIND_MATCHES) return false;
        matches.push({ ...line, fileKey, occurrence, lineText: text });
        occurrence += 1;
      }
      return true;
    });
    if (!finished) return { matches, truncated: true };
  }
  return { matches, truncated: false };
}

/** Keeps the previous array when nothing in it changed, so the scan's memo holds across renders. */
export function reuseDiffFindFiles(
  previous: ReadonlyArray<DiffFindFile>,
  next: ReadonlyArray<DiffFindFile>,
): ReadonlyArray<DiffFindFile> {
  if (previous.length !== next.length) return next;
  for (const [index, entry] of next.entries()) {
    const held = previous[index];
    if (held?.fileKey !== entry.fileKey || held.file !== entry.file) return next;
  }
  return previous;
}

export function wrapDiffFindIndex(index: number, delta: number, count: number): number {
  if (count === 0) return 0;
  return (((index + delta) % count) + count) % count;
}

/** Stays stable when the patch refreshes, so an unrelated update does not scroll the panel. */
export function buildDiffFindMatchKey(match: DiffFindMatch): string {
  return `${match.fileKey}\u0000${match.side}\u0000${match.lineNumber}\u0000${match.occurrence}`;
}

export function resolveDiffFindLineRange(match: DiffFindMatch): SelectedLineRange {
  return {
    start: match.lineNumber,
    end: match.lineNumber,
    side: match.side,
    endSide: match.side,
  };
}

export function formatDiffFindCount(input: {
  query: string;
  activeIndex: number;
  matchCount: number;
  truncated: boolean;
}): string {
  if (input.query.length === 0) return "";
  if (input.matchCount === 0) return "No results";
  return `${input.activeIndex + 1}/${input.matchCount}${input.truncated ? "+" : ""}`;
}

/** Only has to land close enough for the viewer to mount the row; the row then gives the real spot. */
export function estimateDiffFindMatchOffset(
  match: DiffFindMatch,
  layout: { split: boolean; lineHeight: number; headerHeight: number; separatorHeight: number },
): number {
  const row = layout.split ? match.splitRow : match.unifiedRow;
  return layout.headerHeight + row * layout.lineHeight + match.separators * layout.separatorHeight;
}

/** Where a row the viewer has not mounted will land, relative to the mounted rows' coordinates. */
export function estimateDiffFindRowTop(
  targetRow: number,
  mounted: ReadonlyArray<{ row: number; top: number; bottom: number }>,
): number | null {
  let first = mounted[0];
  let last = mounted[0];
  if (!first || !last) return null;
  for (const entry of mounted) {
    if (entry.row < first.row) first = entry;
    if (entry.row > last.row) last = entry;
  }
  // Wrapped rows are taller than a line, so the mounted ones say what a row measures here.
  const rowHeight = (last.bottom - first.top) / (last.row - first.row + 1);
  return targetRow < first.row
    ? first.top - (first.row - targetRow) * rowHeight
    : last.top + (targetRow - last.row) * rowHeight;
}

/** `data-line-index` holds the row in each layout, as `unified,split`. */
export function parseDiffRowIndex(value: string | undefined, split: boolean): number | null {
  const parts = (value ?? "").split(",");
  const row = Number.parseInt((split ? parts[1] : parts[0]) ?? "", 10);
  return Number.isNaN(row) ? null : row;
}

export function isDiffFindChord(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"> & {
    code?: string;
  },
  platform: string,
): boolean {
  const modifier = isMacPlatform(platform)
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
  return modifier && !event.altKey && !event.shiftKey && shortcutKeyFromEvent(event) === "f";
}

/** The composed path, because a key pressed inside a diff is retargeted at its shadow host. */
export function isDiffFindEvent(event: Pick<Event, "composedPath">): boolean {
  return event.composedPath().some((node) => {
    const element = node as Partial<Pick<Element, "hasAttribute">>;
    return element.hasAttribute?.(DIFF_FIND_SCOPE_ATTRIBUTE) === true;
  });
}
