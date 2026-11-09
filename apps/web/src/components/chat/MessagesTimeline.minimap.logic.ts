import { isRestartContinuationMessageId } from "~/lib/restartContinuation";
import { deriveDisplayedUserMessageState } from "~/lib/terminalContext";

import {
  shouldRenderUserMessageAsMarkdown,
  type MessagesTimelineRow,
} from "./MessagesTimeline.logic";

const TIMELINE_MINIMAP_ITEM_SPACING = 8;
export const TIMELINE_MINIMAP_MIN_ITEMS = 2;
const TIMELINE_MINIMAP_MAX_HEIGHT_CSS = "calc(100% - 6rem)";
const TIMELINE_MINIMAP_PERSISTENT_GUTTER = 48;
/** Space kept above a user message the minimap jumps to. */
export const TIMELINE_MINIMAP_JUMP_TOP_OFFSET_PX = 16;
/** The tooltip shows a few lines; bound the work done on long or streaming replies. */
const TIMELINE_MINIMAP_PREVIEW_SOURCE_CHARS = 1_500;

export interface TimelineMinimapItem {
  readonly id: string;
  readonly rowIndex: number;
  readonly userText: string;
  readonly assistantText: string | null;
}

export interface TimelineMinimapPreview {
  readonly userText: string | null;
  readonly assistantText: string | null;
}

export interface TimelineMinimapItemBounds {
  readonly top: number;
  readonly height: number;
}

/** One minimap item per user message, paired with the last assistant reply of that turn. */
export function deriveTimelineMinimapItems(
  rows: ReadonlyArray<MessagesTimelineRow>,
): TimelineMinimapItem[] {
  const items: TimelineMinimapItem[] = [];
  let current: { -readonly [Key in keyof TimelineMinimapItem]: TimelineMinimapItem[Key] } | null =
    null;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row?.kind !== "message") continue;
    if (row.message.role === "user") {
      // A restart continuation shows as a notice, so its reply stays with the prompt before it.
      if (isRestartContinuationMessageId(row.message.id)) continue;
      current = { id: row.id, rowIndex: index, userText: row.message.text, assistantText: null };
      items.push(current);
    } else if (row.message.role === "assistant" && current && row.message.text.trim().length > 0) {
      // An image-only message must not replace the reply text before it.
      current.assistantText = row.message.text;
    }
  }
  return items;
}

function compactPreviewText(text: string | null | undefined): string | null {
  const compact = text?.replace(/\s+/g, " ").trim() ?? "";
  return compact.length > 0 ? compact : null;
}

const FENCE_LINE_PATTERN = /^ {0,3}(`{3,}|~{3,})/;

/** Turns markdown into the plain text a reader would see, for one-line previews. */
export function markdownToPlainTextPreview(
  markdown: string,
  options?: { readonly literalHtml?: boolean },
): string {
  const stripInline = (text: string) =>
    stripInlineMarkdown(options?.literalHtml ? text : stripHtmlMarkup(text));
  // Fenced code bodies stay verbatim; only the text outside fences gets the markdown rules.
  const parts: string[] = [];
  let prose: string[] = [];
  let openFence: string | null = null;
  for (const line of markdown.split("\n")) {
    const fence = FENCE_LINE_PATTERN.exec(line)?.[1] ?? null;
    if (openFence === null) {
      if (fence === null) {
        prose.push(line);
        continue;
      }
      parts.push(stripInline(prose.join("\n")));
      prose = [];
      openFence = fence;
    } else if (fence !== null && fence[0] === openFence[0] && fence.length >= openFence.length) {
      openFence = null;
    } else {
      parts.push(line);
    }
  }
  parts.push(stripInline(prose.join("\n")));
  return parts.join("\n");
}

function stripHtmlMarkup(markdown: string): string {
  return markdown
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
    .replace(/<\/?[a-z][\w-]*(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi, " ");
}

function stripInlineMarkdown(markdown: string): string {
  return markdown
    .replace(/^ {0,3}\[[^\]]+\]:\s+\S.*$/gm, "")
    .replace(/^ {0,3}(?:[-*_][ \t]*){3,}$/gm, "")
    .replace(/^\s*\|?(?:\s*:?-{2,}:?\s*\|)+\s*:?-*:?\s*$/gm, "")
    .replace(/^ {0,3}#{1,6}[ \t]+/gm, "")
    .replace(/^ {0,3}(?:>[ \t]?)+/gm, "")
    .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/gm, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/!\[([^\]]*)\]\[[^\]]*\]/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
    .replace(/(`+)([\s\S]*?)\1/g, "$2")
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/(^|[^\w*])\*(?=\S)([^*]*?\S)\*(?![\w*])/g, "$1$2")
    .replace(/(^|[^\w_])_(?=\S)([^_]*?\S)_(?![\w_])/g, "$1$2")
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1")
    .replace(/(?<!\\)\|/g, " ")
    .replace(/\\([\\`*_{}[\]()#+\-.!|~>])/g, "$1");
}

/** Plain-text preview of a minimap item, with terminal context blocks and markdown removed. */
export function resolveTimelineMinimapPreview(item: TimelineMinimapItem): TimelineMinimapPreview {
  const userText = deriveDisplayedUserMessageState(item.userText).visibleText;
  const userSource = userText.slice(0, TIMELINE_MINIMAP_PREVIEW_SOURCE_CHARS);
  return {
    // A user message shows its raw HTML as text, so a preview must not drop it.
    userText: compactPreviewText(
      shouldRenderUserMessageAsMarkdown(userText)
        ? markdownToPlainTextPreview(userSource, { literalHtml: true })
        : userSource,
    ),
    assistantText:
      item.assistantText === null
        ? null
        : compactPreviewText(
            markdownToPlainTextPreview(
              item.assistantText.slice(0, TIMELINE_MINIMAP_PREVIEW_SOURCE_CHARS),
            ),
          ),
  };
}

export function resolveTimelineMinimapHeightStyle(itemCount: number): string {
  const naturalHeight = Math.max(1, (itemCount - 1) * TIMELINE_MINIMAP_ITEM_SPACING);
  return `min(${naturalHeight}px, ${TIMELINE_MINIMAP_MAX_HEIGHT_CSS})`;
}

export function resolveTimelineMinimapTopPercent(index: number, itemCount: number): number {
  if (itemCount <= 1) return 0;
  return (Math.max(0, Math.min(index, itemCount - 1)) / (itemCount - 1)) * 100;
}

export function resolveTimelineMinimapIndexFromPointer(input: {
  readonly itemCount: number;
  readonly railTop: number;
  readonly railHeight: number;
  readonly pointerY: number;
}): number | null {
  if (input.itemCount <= 0 || input.railHeight <= 0) return null;
  if (input.itemCount === 1) return 0;
  const progress = Math.max(0, Math.min(1, (input.pointerY - input.railTop) / input.railHeight));
  return Math.round(progress * (input.itemCount - 1));
}

/** The rail only shows when the gutter left of the content column (whatever its width) can hold it. */
export function resolveTimelineMinimapHasPersistentGutter(input: {
  readonly containerLeft: number;
  readonly contentLeft: number;
}): boolean {
  const gutter = input.contentLeft - input.containerLeft;
  return Number.isFinite(gutter) && gutter >= TIMELINE_MINIMAP_PERSISTENT_GUTTER;
}

/** Items whose user message intersects the viewport. */
export function resolveTimelineMinimapHighlightedIndices(input: {
  readonly viewportTop: number;
  readonly viewportBottom: number;
  readonly itemBounds: ReadonlyArray<TimelineMinimapItemBounds | null>;
}): number[] {
  const visible: number[] = [];
  for (const [index, bounds] of input.itemBounds.entries()) {
    if (!bounds || !Number.isFinite(bounds.top)) continue;
    const height = Number.isFinite(bounds.height) ? Math.max(1, bounds.height) : 1;
    if (bounds.top < input.viewportBottom && bounds.top + height > input.viewportTop) {
      visible.push(index);
    }
  }
  return visible;
}

/** The reader's turn: the first item in view, else the last one above the viewport. */
export function resolveTimelineMinimapCurrentIndex(input: {
  readonly viewportTop: number;
  readonly viewportBottom: number;
  readonly itemBounds: ReadonlyArray<TimelineMinimapItemBounds | null>;
}): number | null {
  let lastAbove: number | null = null;
  for (const [index, bounds] of input.itemBounds.entries()) {
    if (!bounds || !Number.isFinite(bounds.top)) continue;
    const height = Number.isFinite(bounds.height) ? Math.max(1, bounds.height) : 1;
    if (bounds.top >= input.viewportBottom) continue;
    if (bounds.top + height > input.viewportTop) return index;
    lastAbove = index;
  }
  return lastAbove;
}

/**
 * The turn the chevrons step from. A jump leaves the row above its target ending right on the jump
 * line (rows are flush), so that row must not count as current or Next would re-target the same row.
 */
export function resolveTimelineMinimapNavigationIndex(input: {
  readonly viewportTop: number;
  readonly viewportBottom: number;
  readonly itemBounds: ReadonlyArray<TimelineMinimapItemBounds | null>;
}): number | null {
  return resolveTimelineMinimapCurrentIndex({
    ...input,
    viewportTop: input.viewportTop + TIMELINE_MINIMAP_JUMP_TOP_OFFSET_PX + 1,
  });
}

/** Whether the scroller cannot move further down, so a downward jump would do nothing. */
export function isTimelineMinimapScrollAtEnd(scroller: {
  readonly scrollTop: number;
  readonly clientHeight: number;
  readonly scrollHeight: number;
}): boolean {
  return scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1;
}

/** Where the previous and next turn buttons go; above every item, "next" is the first one. */
export function resolveTimelineMinimapNeighborIndices(
  currentIndex: number | null,
  itemCount: number,
  scrollAtEnd = false,
): { readonly previous: number | null; readonly next: number | null } {
  const next = currentIndex === null ? 0 : currentIndex + 1;
  return {
    previous: currentIndex !== null && currentIndex > 0 ? currentIndex - 1 : null,
    next: !scrollAtEnd && next < itemCount ? next : null,
  };
}

export function areTimelineMinimapIndicesEqual(
  left: ReadonlyArray<number>,
  right: ReadonlyArray<number>,
): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
