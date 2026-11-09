import { type WorkLogEntry } from "../../session-logic";

/** Only thinking blocks carry this tone; the row renders them instead of a tool line. */
export function isThoughtWorkEntry(entry: Pick<WorkLogEntry, "tone">): boolean {
  return entry.tone === "thinking";
}

/** A block a crashed turn left open must not read as live once its turn stopped running. */
export function thoughtWorkRowIsStreaming(
  entry: Pick<WorkLogEntry, "label">,
  turnRunning: boolean,
): boolean {
  return turnRunning && entry.label === "Thinking";
}

/** Far more than one row can show, and it bounds the patterns below on long thoughts. */
const PREVIEW_INPUT_MAX_CHARS = 2_000;

// `[ \t]`, not `\s`, in the line-anchored patterns: `\s` also matches newlines, so `^\s*` backtracks
// catastrophically across a run of blank lines.
const MARKDOWN_NOISE: ReadonlyArray<readonly [RegExp, string]> = [
  [/^[ \t]*(?:```|~~~).*$/gm, " "],
  [/!\[([^\]]*)\]\([^)]*\)/g, "$1"],
  [/\[([^\]]*)\]\([^)]*\)/g, "$1"],
  [/^[ \t]{0,3}#{1,6}[ \t]+/gm, ""],
  [/^[ \t]{0,3}>[ \t]?/gm, ""],
  [/^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+/gm, ""],
  [/^[ \t]*\|?[ \t:|-]*-[ \t:|-]*\|?[ \t]*$/gm, " "],
  [/\|/g, " "],
  [/(\*\*|__|~~|`)/g, ""],
  [/(^|[\s(])[*_](\S(?:.*?\S)?)[*_](?=$|[\s).,:;!?])/g, "$1$2"],
];

/** The block as one line of plain text, for the collapsed row. */
export function thoughtPreviewLine(text: string): string {
  let preview = text.replace(/\n{3,}/g, "\n\n").slice(0, PREVIEW_INPUT_MAX_CHARS);
  for (const [pattern, replacement] of MARKDOWN_NOISE) {
    preview = preview.replace(pattern, replacement);
  }
  return preview.replace(/\s+/g, " ").trim();
}

/** Distance from the end, in px, that still counts as reading the newest text. */
const LIVE_EDGE_PX = 4;

export function isAtThoughtLiveEdge(scroller: {
  readonly scrollHeight: number;
  readonly scrollTop: number;
  readonly clientHeight: number;
}): boolean {
  return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= LIVE_EDGE_PX;
}
