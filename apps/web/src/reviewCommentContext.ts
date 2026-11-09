import type { DiffLineAnnotation, FileDiffMetadata, SelectedLineRange } from "@pierre/diffs";
import * as Schema from "effect/Schema";

const ReviewCommentSelectionSchema = Schema.Struct({
  start: Schema.Number,
  side: Schema.Literals(["additions", "deletions"]),
  end: Schema.Number,
  endSide: Schema.Literals(["additions", "deletions"]),
});
type ReviewCommentSelection = typeof ReviewCommentSelectionSchema.Type;

export const ReviewCommentContextSchema = Schema.Struct({
  id: Schema.String,
  sectionId: Schema.String,
  sectionTitle: Schema.String,
  filePath: Schema.String,
  startIndex: Schema.Number,
  endIndex: Schema.Number,
  rangeLabel: Schema.String,
  text: Schema.String,
  diff: Schema.String,
  selection: Schema.optional(ReviewCommentSelectionSchema),
});

export interface ReviewCommentContext {
  readonly id: string;
  /** The diff view the lines belong to (a turn, all turns, uncommitted or branch). */
  readonly sectionId: string;
  readonly sectionTitle: string;
  readonly filePath: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly rangeLabel: string;
  readonly text: string;
  readonly diff: string;
  /** Absent on comments parsed back from a sent message. */
  readonly selection?: ReviewCommentSelection | undefined;
}

export const REVIEW_COMMENT_DIFF_MAX_CHARS = 32_000;
const REVIEW_COMMENT_TRUNCATION_MARKER = "… truncated …";

const OPENING_TAG = "<review_comment";
const CLOSING_TAG = "</review_comment>";
const BLOCK_PATTERN = /^<review_comment\b([^>\n]*)>\n([\s\S]*)\n<\/review_comment>$/;
const ATTRIBUTE_PATTERN = /([a-zA-Z][a-zA-Z0-9_-]*)="([^"]*)"/g;
const TRAILING_TERMINAL_BLOCK_PATTERN = /\n*<terminal_context>\n[\s\S]*?\n<\/terminal_context>\s*$/;

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "&#10;");
}

function unescapeAttribute(value: string): string {
  return value
    .replace(/&#10;/g, "\n")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

// Comment and diff text must not be able to open or close a context block, in this format or the terminal one.
function escapeBlockTags(value: string): string {
  return value
    .replace(/&(?=(?:amp;)*lt;\/?(?:review_comment|terminal_context))/gi, "&amp;")
    .replace(/<(?=\/?(?:review_comment|terminal_context))/gi, "&lt;");
}

function unescapeBlockTags(value: string): string {
  return value
    .replace(/&lt;(?=\/?(?:review_comment|terminal_context))/gi, "<")
    .replace(/&amp;(?=(?:amp;)*lt;\/?(?:review_comment|terminal_context))/gi, "&");
}

/** The fence is always longer than any backtick run in the contents, so they cannot close it. */
export function formatReviewCommentFence(language: string, contents: string): string {
  const longestBacktickRun = Math.max(
    0,
    ...Array.from(contents.matchAll(/`+/g), (match) => match[0].length),
  );
  const fence = "`".repeat(Math.max(3, longestBacktickRun + 1));
  return [`${fence}${language}`, contents.replace(/\n+$/, ""), fence].join("\n");
}

export function formatReviewCommentContext(comment: ReviewCommentContext): string {
  return [
    [
      OPENING_TAG,
      ` sectionId="${escapeAttribute(comment.sectionId)}"`,
      ` sectionTitle="${escapeAttribute(comment.sectionTitle)}"`,
      ` filePath="${escapeAttribute(comment.filePath)}"`,
      ` startIndex="${comment.startIndex}"`,
      ` endIndex="${comment.endIndex}"`,
      ` rangeLabel="${escapeAttribute(comment.rangeLabel)}"`,
      ">",
    ].join(""),
    escapeBlockTags(comment.text.trim()),
    formatReviewCommentFence("diff", escapeBlockTags(comment.diff)),
    CLOSING_TAG,
  ].join("\n");
}

/** Adds the comment blocks after the prompt, ahead of any trailing terminal context block. */
export function appendReviewCommentsToPrompt(
  prompt: string,
  comments: ReadonlyArray<ReviewCommentContext>,
): string {
  if (comments.length === 0) return prompt;
  const blocks = comments.map(formatReviewCommentContext).join("\n\n");
  const terminalBlock = TRAILING_TERMINAL_BLOCK_PATTERN.exec(prompt);
  const promptText = (terminalBlock ? prompt.slice(0, terminalBlock.index) : prompt).trim();
  const terminalText = terminalBlock ? terminalBlock[0].trim() : "";
  return [promptText, blocks, terminalText].filter((part) => part.length > 0).join("\n\n");
}

function parseReviewCommentBody(body: string): { text: string; diff: string } | null {
  const closingFence = /(?:^|\n)(`{3,})$/.exec(body);
  if (!closingFence) return null;
  const fence = closingFence[1]!;
  const beforeClosingFence = body.slice(0, closingFence.index);
  const openingLine = `${fence}diff\n`;
  // The contents hold no backtick run this long, so the last match is the real opening fence.
  const openingIndex = beforeClosingFence.lastIndexOf(openingLine);
  if (openingIndex < 0) return null;
  if (openingIndex > 0 && beforeClosingFence[openingIndex - 1] !== "\n") return null;
  return {
    text: unescapeBlockTags(beforeClosingFence.slice(0, openingIndex).trim()),
    diff: unescapeBlockTags(beforeClosingFence.slice(openingIndex + openingLine.length)),
  };
}

function parseReviewCommentBlock(block: string, index: number): ReviewCommentContext | null {
  const match = BLOCK_PATTERN.exec(block);
  if (!match) return null;
  const attributes: Record<string, string> = {};
  for (const attribute of match[1]!.matchAll(ATTRIBUTE_PATTERN)) {
    attributes[attribute[1]!] = unescapeAttribute(attribute[2] ?? "");
  }
  const filePath = attributes.filePath?.trim();
  const sectionId = attributes.sectionId?.trim();
  const startIndex = /^\d+$/.test(attributes.startIndex ?? "") ? Number(attributes.startIndex) : -1;
  const endIndex = /^\d+$/.test(attributes.endIndex ?? "") ? Number(attributes.endIndex) : -1;
  if (!filePath || !sectionId || startIndex < 0 || endIndex < 0) return null;
  const body = parseReviewCommentBody(match[2]!);
  if (!body) return null;
  return {
    id: `review-comment:${index}:${sectionId}:${filePath}:${startIndex}:${endIndex}`,
    sectionId,
    sectionTitle: attributes.sectionTitle?.trim() || "Review",
    filePath,
    startIndex: Math.min(startIndex, endIndex),
    endIndex: Math.max(startIndex, endIndex),
    rangeLabel: attributes.rangeLabel?.trim() || "line",
    text: body.text,
    diff: body.diff,
  };
}

function findLastOpeningTag(text: string): number {
  let index = text.lastIndexOf(OPENING_TAG);
  while (index > 0 && text[index - 1] !== "\n") {
    index = text.lastIndexOf(OPENING_TAG, index - 1);
  }
  return index;
}

/**
 * Splits the comment blocks off the end of a sent message. Remove a trailing terminal block first.
 * Only trailing blocks count, so a prompt that quotes the format mid-text stays plain text.
 */
export function extractTrailingReviewComments(prompt: string): {
  promptText: string;
  comments: ReviewCommentContext[];
} {
  const comments: ReviewCommentContext[] = [];
  let remaining = prompt.trimEnd();
  while (remaining.endsWith(`\n${CLOSING_TAG}`)) {
    const openingIndex = findLastOpeningTag(remaining);
    if (openingIndex < 0) break;
    const comment = parseReviewCommentBlock(remaining.slice(openingIndex), comments.length);
    if (!comment) break;
    comments.unshift(comment);
    remaining = remaining.slice(0, openingIndex).trimEnd();
  }
  return { promptText: comments.length > 0 ? remaining : prompt, comments };
}

export function stripTrailingReviewComments(prompt: string): string {
  return extractTrailingReviewComments(prompt).promptText;
}

interface DiffReviewLine {
  readonly change: "context" | "add" | "delete";
  readonly oldLineNumber: number | null;
  readonly newLineNumber: number | null;
  readonly content: string;
}

function stripLineEnding(value: string): string {
  return value.replace(/\r?\n$/, "");
}

function pushUnchangedRows(
  rows: DiffReviewLine[],
  fileDiff: FileDiffMetadata,
  firstOldLineNumber: number,
  firstNewLineNumber: number,
  count: number,
): void {
  for (let offset = 0; offset < count; offset += 1) {
    const oldLineNumber = firstOldLineNumber + offset;
    const newLineNumber = firstNewLineNumber + offset;
    rows.push({
      change: "context",
      oldLineNumber,
      newLineNumber,
      content: stripLineEnding(
        fileDiff.additionLines[newLineNumber - 1] ??
          fileDiff.deletionLines[oldLineNumber - 1] ??
          "",
      ),
    });
  }
}

// Parsed patches carry only their hunk lines; full-context files also show the lines between hunks.
function buildDiffReviewLines(fileDiff: FileDiffMetadata): DiffReviewLine[] {
  const rows: DiffReviewLine[] = [];
  const includeUnchanged = fileDiff.isPartial === false;
  let nextOldLineNumber = 1;
  let nextNewLineNumber = 1;
  for (const hunk of fileDiff.hunks) {
    if (includeUnchanged) {
      pushUnchangedRows(rows, fileDiff, nextOldLineNumber, nextNewLineNumber, hunk.collapsedBefore);
    }
    nextOldLineNumber += hunk.collapsedBefore + hunk.deletionCount;
    nextNewLineNumber += hunk.collapsedBefore + hunk.additionCount;
    let oldLineNumber = hunk.deletionStart;
    let newLineNumber = hunk.additionStart;
    let deletionLineIndex = hunk.deletionLineIndex;
    let additionLineIndex = hunk.additionLineIndex;
    for (const segment of hunk.hunkContent) {
      if (segment.type === "context") {
        for (let index = 0; index < segment.lines; index += 1) {
          rows.push({
            change: "context",
            oldLineNumber: oldLineNumber++,
            newLineNumber: newLineNumber++,
            content: stripLineEnding(
              fileDiff.additionLines[additionLineIndex] ??
                fileDiff.deletionLines[deletionLineIndex] ??
                "",
            ),
          });
          deletionLineIndex += 1;
          additionLineIndex += 1;
        }
        continue;
      }
      for (let index = 0; index < segment.deletions; index += 1) {
        rows.push({
          change: "delete",
          oldLineNumber: oldLineNumber++,
          newLineNumber: null,
          content: stripLineEnding(fileDiff.deletionLines[deletionLineIndex++] ?? ""),
        });
      }
      for (let index = 0; index < segment.additions; index += 1) {
        rows.push({
          change: "add",
          oldLineNumber: null,
          newLineNumber: newLineNumber++,
          content: stripLineEnding(fileDiff.additionLines[additionLineIndex++] ?? ""),
        });
      }
    }
  }
  if (includeUnchanged) {
    const trailingLineCount = Math.min(
      fileDiff.deletionLines.length - nextOldLineNumber + 1,
      fileDiff.additionLines.length - nextNewLineNumber + 1,
    );
    pushUnchangedRows(rows, fileDiff, nextOldLineNumber, nextNewLineNumber, trailingLineCount);
  }
  return rows;
}

function findRowIndex(
  rows: ReadonlyArray<DiffReviewLine>,
  lineNumber: number,
  side: "additions" | "deletions" | undefined,
): number {
  return rows.findIndex((row) =>
    side === "deletions" ? row.oldLineNumber === lineNumber : row.newLineNumber === lineNumber,
  );
}

function diffChangeMarker(change: DiffReviewLine["change"]): string {
  if (change === "add") return "+";
  if (change === "delete") return "-";
  return " ";
}

function formatRangeLabel(lines: ReadonlyArray<DiffReviewLine>): string {
  const first = lines[0];
  const last = lines.at(-1);
  if (!first || !last) return "line";
  const firstNumber = first.newLineNumber ?? first.oldLineNumber;
  const lastNumber = last.newLineNumber ?? last.oldLineNumber;
  const marker =
    first.change !== "context" && lines.every((line) => line.change === first.change)
      ? diffChangeMarker(first.change)
      : "";
  return firstNumber === lastNumber
    ? `${marker}${firstNumber}`
    : `${marker}${firstNumber} to ${marker}${lastNumber}`;
}

function formatDiffHunkHeader(lines: ReadonlyArray<DiffReviewLine>): string {
  const oldLines = lines.filter((line) => line.oldLineNumber !== null);
  const newLines = lines.filter((line) => line.newLineNumber !== null);
  return `@@ -${oldLines[0]?.oldLineNumber ?? 0},${oldLines.length} +${newLines[0]?.newLineNumber ?? 0},${newLines.length} @@`;
}

function clampDiffText(diff: string): string {
  if (diff.length <= REVIEW_COMMENT_DIFF_MAX_CHARS) return diff;
  const cut = diff.lastIndexOf("\n", REVIEW_COMMENT_DIFF_MAX_CHARS);
  return `${diff.slice(0, Math.max(cut, 0))}\n${REVIEW_COMMENT_TRUNCATION_MARKER}`;
}

/** Null when the range's lines are not in this diff, for example after the patch changed. */
export function buildDiffReviewComment(input: {
  id: string;
  sectionId: string;
  sectionTitle: string;
  filePath: string;
  fileDiff: FileDiffMetadata;
  range: SelectedLineRange;
  text: string;
}): ReviewCommentContext | null {
  const rows = buildDiffReviewLines(input.fileDiff);
  const side = input.range.side ?? "additions";
  const endSide = input.range.endSide ?? side;
  const startRow = findRowIndex(rows, input.range.start, side);
  const endRow = findRowIndex(rows, input.range.end, endSide);
  if (startRow < 0 || endRow < 0) return null;
  const startIndex = Math.min(startRow, endRow);
  const endIndex = Math.max(startRow, endRow);
  const lines = rows.slice(startIndex, endIndex + 1);
  return {
    id: input.id,
    sectionId: input.sectionId,
    sectionTitle: input.sectionTitle,
    filePath: input.filePath,
    startIndex,
    endIndex,
    rangeLabel: formatRangeLabel(lines),
    text: input.text.trim(),
    diff: clampDiffText(
      [
        formatDiffHunkHeader(lines),
        ...lines.map((line) => `${diffChangeMarker(line.change)}${line.content}`),
      ].join("\n"),
    ),
    selection: { start: input.range.start, side, end: input.range.end, endSide },
  };
}

export interface DiffReviewAnnotationEntry {
  readonly id: string;
  readonly kind: "draft" | "comment";
  readonly rangeLabel: string;
  readonly text: string;
}

export interface DiffReviewAnnotationGroup {
  readonly entries: ReadonlyArray<DiffReviewAnnotationEntry>;
}

export interface DiffReviewDraftAnchor {
  readonly id: string;
  readonly filePath: string;
  readonly range: SelectedLineRange;
  readonly rangeLabel: string;
}

/**
 * The comments and open form to show on one file. A comment whose lines left the patch gets no
 * annotation here, and keeps its composer chip.
 */
export function buildDiffReviewAnnotations(input: {
  fileDiff: FileDiffMetadata;
  filePath: string;
  sectionId: string;
  comments: ReadonlyArray<ReviewCommentContext>;
  draft: DiffReviewDraftAnchor | null;
}): DiffLineAnnotation<DiffReviewAnnotationGroup>[] {
  const annotations: DiffLineAnnotation<DiffReviewAnnotationGroup>[] = [];
  const add = (
    side: "additions" | "deletions",
    lineNumber: number,
    entry: DiffReviewAnnotationEntry,
  ) => {
    const index = annotations.findIndex(
      (annotation) => annotation.side === side && annotation.lineNumber === lineNumber,
    );
    if (index < 0) {
      annotations.push({ side, lineNumber, metadata: { entries: [entry] } });
      return;
    }
    const existing = annotations[index]!;
    annotations[index] = {
      ...existing,
      metadata: { entries: [...existing.metadata.entries, entry] },
    };
  };

  const relevant = input.comments.filter(
    (comment) =>
      comment.sectionId === input.sectionId &&
      comment.filePath === input.filePath &&
      comment.selection,
  );
  const rows = relevant.length > 0 ? buildDiffReviewLines(input.fileDiff) : [];
  for (const comment of relevant) {
    const selection = comment.selection!;
    if (
      findRowIndex(rows, selection.start, selection.side) < 0 ||
      findRowIndex(rows, selection.end, selection.endSide) < 0
    ) {
      continue;
    }
    add(selection.endSide, selection.end, {
      id: comment.id,
      kind: "comment",
      rangeLabel: comment.rangeLabel,
      text: comment.text,
    });
  }
  if (input.draft && input.draft.filePath === input.filePath) {
    const { range } = input.draft;
    add(range.endSide ?? range.side ?? "additions", range.end, {
      id: input.draft.id,
      kind: "draft",
      rangeLabel: input.draft.rangeLabel,
      text: "",
    });
  }
  return annotations;
}
