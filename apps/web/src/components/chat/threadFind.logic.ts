import { isRestartContinuationMessageId } from "~/lib/restartContinuation";
import {
  isPathLikeLinkLabel,
  resolveMarkdownFileChipMeta,
  type MarkdownFileChipMeta,
} from "~/markdown-file-chip";
import { isGithubAlertMarkerLine } from "~/markdown-github-alerts";
import { resolveInlineCodeFileHref } from "~/markdown-inline-code";
import { stripAllowedRawHtml } from "~/markdown-raw-html";
import { deriveDisplayedUserMessageState } from "~/lib/terminalContext";
import { proposedPlanTitle, stripDisplayedPlanMarkdown } from "~/proposedPlan";

import { partitionMessageAttachments } from "./MessagesTimeline.attachments";
import {
  shouldPreserveAssistantLineBreaks,
  shouldRenderUserMessageAsMarkdown,
  type MessagesTimelineRow,
} from "./MessagesTimeline.logic";
import {
  formatInlineTerminalContextLabel,
  splitInlineSegmentWhitespace,
} from "./userMessageTerminalContexts";

export interface ThreadFindMatch {
  readonly rowId: string;
  readonly rowIndex: number;
  /** Position among this row's matches, in reading order. */
  readonly occurrence: number;
}

export interface ThreadFindPosition {
  readonly rowId: string;
  readonly occurrence: number;
}

const NON_ASCII = /[^\p{ASCII}]/u;

/** Case and curly-apostrophe folding that keeps every UTF-16 offset, so DOM ranges can reuse them. */
export function foldThreadFindText(text: string): string {
  if (!NON_ASCII.test(text)) return text.toLowerCase();
  let folded = "";
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charAt(index);
    if (unit === "‘" || unit === "’") {
      folded += "'";
      continue;
    }
    const lower = unit.toLowerCase();
    folded += lower.length === 1 ? lower : unit;
  }
  return folded;
}

/** The folded query, or "" when there is nothing to search for. */
export function normalizeThreadFindQuery(query: string): string {
  return query.trim().length === 0 ? "" : foldThreadFindText(query);
}

/** Non-overlapping start offsets of an already folded query. */
export function findThreadFindOccurrences(foldedText: string, foldedQuery: string): number[] {
  if (foldedQuery.length === 0) return [];
  const offsets: number[] = [];
  let offset = foldedText.indexOf(foldedQuery);
  while (offset !== -1) {
    offsets.push(offset);
    offset = foldedText.indexOf(foldedQuery, offset + foldedQuery.length);
  }
  return offsets;
}

const PROTECTED_ESCAPE_BASE = 0xe000;
const PROTECTED_CODE_OPEN = "";
const PROTECTED_CODE_CLOSE = "";

// A file chip's icon splits the DOM collector's text there, so a phrase cannot match across it.
const FILE_CHIP_BOUNDARY = "\ue102";
// Stands in for an image until the link around it is read, since it paints no text of its own.
const PAINTED_IMAGE = "\ue103";

/** What a chip paints; the parent-folder suffix depends on the whole message and is not modelled. */
function fileChipPaintedText(meta: Pick<MarkdownFileChipMeta, "basename" | "position">): string {
  return `${FILE_CHIP_BOUNDARY}${meta.basename}${meta.position}`;
}

interface ProtectedLiteral {
  readonly code: string;
  /** Painted instead of the code when the span renders as a file chip. */
  chip: string | null;
}

const PROTECTED_LITERAL_PATTERN = new RegExp(
  `${PROTECTED_CODE_OPEN}(\\d+)${PROTECTED_CODE_CLOSE}`,
  "g",
);

function restoreEscapes(value: string): string {
  return value.replace(/[-]/g, (character) =>
    String.fromCharCode(character.charCodeAt(0) - PROTECTED_ESCAPE_BASE),
  );
}

/** Hides escapes and code spans, whose characters are literal, from the inline syntax patterns. */
function protectInlineLiterals(line: string, cwd: string | undefined) {
  const literals: ProtectedLiteral[] = [];
  const protectLiteral = (code: string, chip: string | null) => {
    literals.push({ code, chip });
    return `${PROTECTED_CODE_OPEN}${literals.length - 1}${PROTECTED_CODE_CLOSE}`;
  };
  const text = line
    .replace(/\\([!-/:-@[-`{-~])/g, (_, character: string) =>
      String.fromCharCode(PROTECTED_ESCAPE_BASE + character.charCodeAt(0)),
    )
    .replace(/(`+)(.+?)\1(?!`)/g, (_, _fence: string, rawCode: string) => {
      // A backslash stays in a code span, so a Windows path reaches the resolver as written.
      const unescaped = rawCode.replace(/[-]/g, (character) => `\\${restoreEscapes(character)}`);
      const code =
        /^ .* $/.test(unescaped) && unescaped.trim().length > 0
          ? unescaped.slice(1, -1)
          : unescaped;
      const href = resolveInlineCodeFileHref(code, cwd);
      const meta = href ? resolveMarkdownFileChipMeta(href, cwd) : null;
      return protectLiteral(code, meta ? fileChipPaintedText(meta) : null);
    });
  const expand = (value: string, painted: (literal: ProtectedLiteral) => string) =>
    value.replace(PROTECTED_LITERAL_PATTERN, (_, index: string) => {
      const literal = literals[Number(index)];
      return literal ? painted(literal) : "";
    });
  const restore = (value: string) =>
    restoreEscapes(expand(value, (literal) => literal.chip ?? literal.code));
  /** The text of a link label, where a code span stays code. */
  const restoreLinkLabel = (value: string) =>
    restoreEscapes(expand(value, (literal) => literal.code));
  /** Spans in a link label never become chips themselves; only the link can. */
  const markInsideLinkLabel = (value: string) => {
    for (const match of value.matchAll(PROTECTED_LITERAL_PATTERN)) {
      const literal = literals[Number(match[1])];
      if (literal) literal.chip = null;
    }
  };
  return { text, restore, restoreLinkLabel, markInsideLinkLabel, protectLiteral };
}

type InlineLiterals = ReturnType<typeof protectInlineLiterals>;

function stripEmphasis(value: string): string {
  let text = value;
  let previous: string;
  do {
    previous = text;
    text = text
      .replace(/(\*{1,3})(?=[^\s*])(.+?)(?<=[^\s*])\1/g, "$2")
      .replace(/(?<![\p{L}\p{N}_])(_{1,3})(?=[^\s_])(.+?)(?<=[^\s_])\1(?![\p{L}\p{N}_])/gu, "$2");
  } while (text !== previous);
  return text;
}

/** What a link paints: a chip's own label when the link only spells its file's path. */
function linkPaintedText(
  label: string,
  destination: string,
  literals: InlineLiterals,
  cwd: string | undefined,
): string {
  literals.markInsideLinkLabel(label);
  const href = literals.restoreLinkLabel(destination).replace(/^<(.*)>$/, "$1");
  const meta = resolveMarkdownFileChipMeta(href, cwd);
  if (!meta) return label;
  // A linked image renders bare, with no icon to split at and no basename to fall back on.
  if (label.includes(PAINTED_IMAGE)) return label;
  const authored = literals.restoreLinkLabel(stripEmphasis(label));
  return isPathLikeLinkLabel(authored, href, meta)
    ? literals.protectLiteral(fileChipPaintedText(meta), null)
    : `${FILE_CHIP_BOUNDARY}${label}`;
}

function stripInlineSyntax(
  value: string,
  literals: InlineLiterals,
  cwd: string | undefined,
): string {
  const text = value
    .replace(/!\[[^\]]*\]\((?:[^()\s]|\([^)]*\))*(?:\s+"[^"]*")?\)/g, PAINTED_IMAGE)
    .replace(
      /\[([^\]]*)\]\(((?:[^()\s]|\([^)]*\))*)(?:\s+"[^"]*")?\)/g,
      (_, label: string, destination: string) => linkPaintedText(label, destination, literals, cwd),
    )
    .replace(/<((?:https?:|mailto:)[^>\s]+)>/g, "$1")
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, "$1");
  return stripEmphasis(text).replaceAll(PAINTED_IMAGE, "");
}

/** The syntax patterns go quadratic on unclosed openers, so a longer block is searched as written. */
const INLINE_SYNTAX_MAX_LENGTH = 10_000;

const RAW_IMAGE_TAG = /<img(?:[\s/](?:[^"'<>]|"[^"]*"|'[^']*')*)?>/gi;

/** After the literals are protected, so code spans and escapes keep their tags as written. */
function stripPaintedRawHtml(text: string, rawHtml: boolean | undefined): string {
  return rawHtml ? stripAllowedRawHtml(text.replace(RAW_IMAGE_TAG, PAINTED_IMAGE)) : text;
}

function inlineMarkdownText(line: string, rawHtml?: boolean, cwd?: string): string {
  if (line.length > INLINE_SYNTAX_MAX_LENGTH) return line;
  const literals = protectInlineLiterals(line, cwd);
  return literals.restore(
    stripInlineSyntax(stripPaintedRawHtml(literals.text, rawHtml), literals, cwd),
  );
}

function tableRowCells(line: string, rawHtml?: boolean, cwd?: string): string[] {
  const row = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  if (row.length > INLINE_SYNTAX_MAX_LENGTH) return row.split("|").map((cell) => cell.trim());
  const literals = protectInlineLiterals(row, cwd);
  return stripPaintedRawHtml(literals.text, rawHtml)
    .split("|")
    .map((cell) => literals.restore(stripInlineSyntax(cell.trim(), literals, cwd)));
}

const TABLE_DELIMITER_ROW = /^ {0,3}\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const THEMATIC_BREAK = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const ATX_HEADING = /^ {0,3}#{1,6}(?:\s+(.*?))?(?:\s+#+)?\s*$/;
const SETEXT_UNDERLINE = /^ {0,3}(?:=+|-+)\s*$/;
const LIST_ITEM = /^\s*(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/;
const INDENTED_CODE = /^(?: {4}|\t)(.*)$/;
// Stands in for a soft line break, so emphasis can still span lines that render separately.
const PARAGRAPH_LINE_SEPARATOR = "\ue100";

/**
 * The text a Markdown source paints, split where the DOM collector splits (at block boundaries),
 * so a row's count matches its highlights without rendering it. With `lineBreaks`, each line of a
 * paragraph renders on its own and is searched on its own.
 */
export function markdownThreadFindSegments(
  markdown: string,
  options?: {
    readonly lineBreaks?: boolean;
    /** Assistant and plan text renders allowed raw tags; user messages show them as written. */
    readonly rawHtml?: boolean;
    /** Decides which paths render as file chips, as it does for ChatMarkdown. */
    readonly cwd?: string | undefined;
  },
): string[] {
  const rawHtml = options?.rawHtml;
  const cwd = options?.cwd;
  const segments: string[] = [];
  const lines = markdown.split(/\r?\n/);
  let paragraph: string[] = [];
  let fence: { marker: string; isMermaid: boolean; lines: string[] } | null = null;
  let inTable = false;
  let inList = false;
  const flushParagraph = () => {
    if (paragraph.length > 0) {
      if (options?.lineBreaks) {
        const text = inlineMarkdownText(paragraph.join(PARAGRAPH_LINE_SEPARATOR), rawHtml, cwd);
        segments.push(
          ...text
            .split(PARAGRAPH_LINE_SEPARATOR)
            // A line that was only a tag paints nothing.
            .filter((line) => !rawHtml || line.trim().length > 0),
        );
      } else {
        const text = inlineMarkdownText(paragraph.join(" "), rawHtml, cwd);
        if (!rawHtml) segments.push(text);
        else if (text.trim().length > 0) segments.push(text.trim());
      }
    }
    paragraph = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] ?? "").replace(/^(?: {0,3}> ?)+/, "");
    // Paints no text: the alert plugin turns it into the callout's title.
    if (!fence && paragraph.length === 0 && isGithubAlertMarkerLine(lines[index] ?? "")) continue;
    if (fence) {
      const closing = line.trim();
      if (
        closing.length >= fence.marker.length &&
        closing === fence.marker.charAt(0).repeat(closing.length)
      ) {
        // A closed Mermaid fence paints a diagram, not its source.
        if (!fence.isMermaid) segments.push(fence.lines.join("\n"));
        fence = null;
      } else {
        fence.lines.push(line);
      }
      continue;
    }
    const fenceOpen = FENCE_OPEN.exec(line);
    if (fenceOpen) {
      flushParagraph();
      fence = {
        marker: fenceOpen[1] ?? "```",
        isMermaid: (fenceOpen[2] ?? "").trim().split(/\s+/)[0]?.toLowerCase() === "mermaid",
        lines: [],
      };
      continue;
    }
    if (line.trim().length === 0) {
      flushParagraph();
      inTable = false;
      continue;
    }
    if (inTable && line.includes("|")) {
      segments.push(...tableRowCells(line, rawHtml, cwd));
      continue;
    }
    inTable = false;
    const nextLine = lines[index + 1];
    if (
      line.includes("|") &&
      nextLine !== undefined &&
      nextLine.includes("-") &&
      TABLE_DELIMITER_ROW.test(nextLine)
    ) {
      flushParagraph();
      segments.push(...tableRowCells(line, rawHtml, cwd));
      inTable = true;
      index += 1;
      continue;
    }
    if (paragraph.length > 0 && SETEXT_UNDERLINE.test(line)) {
      flushParagraph();
      continue;
    }
    if (THEMATIC_BREAK.test(line)) {
      flushParagraph();
      continue;
    }
    const heading = ATX_HEADING.exec(line);
    if (heading) {
      flushParagraph();
      segments.push(inlineMarkdownText(heading[1] ?? "", rawHtml, cwd));
      continue;
    }
    const listItem = LIST_ITEM.exec(line);
    if (listItem) {
      flushParagraph();
      inList = true;
      paragraph.push((listItem[1] ?? "").trim());
      continue;
    }
    const indentedCode = paragraph.length === 0 && !inList ? INDENTED_CODE.exec(line) : null;
    if (indentedCode) {
      segments.push(indentedCode[1] ?? "");
      continue;
    }
    if (!/^\s/.test(line) && paragraph.length === 0) inList = false;
    paragraph.push(line.trim());
  }
  flushParagraph();
  // An unclosed fence still renders as a code block while it streams.
  if (fence) segments.push(fence.lines.join("\n"));
  return segments
    .flatMap((segment) => segment.split(FILE_CHIP_BOUNDARY))
    .filter((segment) => segment.length > 0);
}

/** Terminal context labels render as chips, outside the search; the text around them is Markdown. */
export function userMessageThreadFindSegments(
  messageText: string,
  options?: { readonly cwd?: string | undefined },
): string[] {
  if (messageText.startsWith("[qa-card]\n")) {
    return messageText
      .slice("[qa-card]\n".length)
      .split("\n")
      .flatMap((line) => line.split("\t"))
      .filter((segment) => segment.length > 0);
  }
  const { visibleText, contexts } = deriveDisplayedUserMessageState(messageText);
  if (visibleText.trim().length === 0) return [];
  const renderAsMarkdown = shouldRenderUserMessageAsMarkdown(visibleText);
  // ChatMarkdown forces line breaks for a user message; plain text only reads its newlines as spaces.
  const textSegments = (text: string): string[] =>
    renderAsMarkdown
      ? markdownThreadFindSegments(splitInlineSegmentWhitespace(text).content, {
          lineBreaks: true,
          cwd: options?.cwd,
        })
      : [text.replace(/[\r\n]/g, " ")];
  const segments: string[] = [];
  let cursor = 0;
  for (const context of contexts) {
    const label = formatInlineTerminalContextLabel(context.header);
    const labelIndex = visibleText.indexOf(label, cursor);
    if (labelIndex === -1) return textSegments(visibleText);
    if (labelIndex > cursor) segments.push(...textSegments(visibleText.slice(cursor, labelIndex)));
    cursor = labelIndex + label.length;
  }
  if (cursor < visibleText.length) segments.push(...textSegments(visibleText.slice(cursor)));
  return segments;
}

function rowThreadFindSegments(
  row: MessagesTimelineRow,
  cwd: string | undefined,
): readonly string[] {
  if (row.kind === "proposed-plan") {
    const { planMarkdown } = row.proposedPlan;
    return [
      proposedPlanTitle(planMarkdown) ?? "Proposed plan",
      ...markdownThreadFindSegments(stripDisplayedPlanMarkdown(planMarkdown), {
        rawHtml: true,
        cwd,
      }),
    ];
  }
  if (row.kind !== "message") return [];
  // The transcript shows a notice instead of this prompt, so find must not match its text.
  if (row.message.role === "user" && isRestartContinuationMessageId(row.message.id)) return [];
  if (row.message.role === "user") return userMessageThreadFindSegments(row.message.text, { cwd });
  if (row.message.role !== "assistant") return [];
  // An image-only reply shows no text, not the empty placeholder.
  if (
    row.message.text.length === 0 &&
    partitionMessageAttachments(row.message.attachments ?? []).images.length > 0
  ) {
    return [];
  }
  const text = row.message.text || (row.message.streaming ? "" : "(empty response)");
  return markdownThreadFindSegments(text, {
    lineBreaks: shouldPreserveAssistantLineBreaks(text),
    rawHtml: true,
    cwd,
  });
}

// Messages and plans keep their identity until they change, so a streaming chunk folds one row.
const foldedSegmentsBySource = new WeakMap<
  object,
  { readonly cwd: string | undefined; readonly segments: readonly string[] }
>();

function foldedRowSegments(row: MessagesTimelineRow, cwd: string | undefined): readonly string[] {
  const source =
    row.kind === "proposed-plan" ? row.proposedPlan : row.kind === "message" ? row.message : null;
  if (!source) return [];
  const cached = foldedSegmentsBySource.get(source);
  if (cached && cached.cwd === cwd) return cached.segments;
  const segments = rowThreadFindSegments(row, cwd).map(foldThreadFindText);
  foldedSegmentsBySource.set(source, { cwd, segments });
  return segments;
}

export function deriveThreadFindMatches(
  rows: ReadonlyArray<MessagesTimelineRow>,
  query: string,
  options?: { readonly cwd?: string | undefined },
): ThreadFindMatch[] {
  const foldedQuery = normalizeThreadFindQuery(query);
  if (foldedQuery.length === 0) return [];
  const matches: ThreadFindMatch[] = [];
  rows.forEach((row, rowIndex) => {
    let occurrence = 0;
    for (const segment of foldedRowSegments(row, options?.cwd)) {
      const count = findThreadFindOccurrences(segment, foldedQuery).length;
      for (let index = 0; index < count; index += 1) {
        matches.push({ rowId: row.id, rowIndex, occurrence });
        occurrence += 1;
      }
    }
  });
  return matches;
}

/** Wraps at both ends; from "no active match" it lands on the first or last match. */
export function stepThreadFindIndex(activeIndex: number, count: number, delta: 1 | -1): number {
  if (count === 0) return -1;
  if (activeIndex < 0) return delta > 0 ? 0 : count - 1;
  return (activeIndex + delta + count) % count;
}

/**
 * Index of the active position in a re-derived list. The position is a row and occurrence, not an
 * index, so matches appearing elsewhere while a reply streams do not move the selection.
 */
export function resolveThreadFindActiveIndex(
  matches: ReadonlyArray<ThreadFindMatch>,
  active: ThreadFindPosition | null,
): number {
  if (!active || matches.length === 0) return -1;
  let lastInRow = -1;
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    if (match?.rowId !== active.rowId) continue;
    if (match.occurrence === active.occurrence) return index;
    lastInRow = index;
  }
  return lastInRow !== -1 ? lastInRow : 0;
}

/** The first match at or below the anchor row, else the last match above it. */
export function pickThreadFindStartIndex(
  matches: ReadonlyArray<ThreadFindMatch>,
  anchorRowIndex: number,
): number {
  if (matches.length === 0) return -1;
  const index = matches.findIndex((match) => match.rowIndex >= anchorRowIndex);
  return index === -1 ? matches.length - 1 : index;
}

/** 0/N when matches exist but none is active, such as ones a streaming reply just added. */
export function formatThreadFindCount(activeIndex: number, count: number): string {
  return count === 0 ? "0/0" : `${Math.max(activeIndex, -1) + 1}/${count}`;
}

/** The collapsed turn fold hiding a search row, or null when the row is already on screen. */
export function findCollapsedFoldIdForRow(
  rows: ReadonlyArray<MessagesTimelineRow>,
  searchRow: MessagesTimelineRow | undefined,
): string | null {
  if (searchRow?.kind !== "message" || !searchRow.message.turnId) return null;
  if (rows.some((row) => row.id === searchRow.id)) return null;
  const { turnId } = searchRow.message;
  const fold = rows.find(
    (row) => row.kind === "turn-fold" && row.turnId === turnId && !row.expanded,
  );
  return fold?.id ?? null;
}

/** Scroll needed to bring a rect inside the viewport's band, or 0 when it is already there. */
export function computeThreadFindScrollDelta(
  rect: { readonly top: number; readonly bottom: number },
  viewport: { readonly top: number; readonly bottom: number },
  margin: number,
): number {
  const available = viewport.bottom - viewport.top - (rect.bottom - rect.top);
  const inset = Math.min(margin, Math.max(0, available / 2));
  if (rect.top < viewport.top + inset) return rect.top - (viewport.top + inset);
  if (rect.bottom > viewport.bottom - inset) return rect.bottom - (viewport.bottom - inset);
  return 0;
}
