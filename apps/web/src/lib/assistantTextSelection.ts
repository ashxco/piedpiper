import { chatMarkdownClipboardPayload } from "../markdown-clipboard";

export const ASSISTANT_QUOTE_MAX_CHARS = 8_000;

const ASSISTANT_ROW_SELECTOR = '[data-message-role="assistant"]';
const ASSISTANT_MARKDOWN_SELECTOR = ".chat-markdown";
const TEXT_NODE = 3;

export interface SelectionRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface CapturedAssistantSelection {
  /** Markdown of the selection, kept here because the row can unmount while the button shows. */
  text: string;
  rect: SelectionRect;
}

function selectedTextBoundary(range: Range, node: Node, last: boolean): Text | null {
  if (!range.intersectsNode(node)) return null;
  if (node.nodeType === TEXT_NODE) {
    const text = node as Text;
    const start = node === range.startContainer ? range.startOffset : 0;
    const end = node === range.endContainer ? range.endOffset : text.length;
    return start < end ? text : null;
  }
  for (
    let child = last ? node.lastChild : node.firstChild;
    child !== null;
    child = last ? child.previousSibling : child.nextSibling
  ) {
    const boundary = selectedTextBoundary(range, child, last);
    if (boundary !== null) return boundary;
  }
  return null;
}

/**
 * The selection when it lies within one assistant reply's rendered Markdown. Works on the actually
 * selected text: a triple-click's range ends at offset 0 of whatever block follows, often the next row.
 */
export function captureAssistantTextSelection(
  viewport: HTMLElement,
  selection: Selection | null,
): CapturedAssistantSelection | null {
  if (selection === null || selection.isCollapsed || selection.rangeCount !== 1) return null;
  const range = selection.getRangeAt(0).cloneRange();
  const first = selectedTextBoundary(range, range.commonAncestorContainer, false);
  const last = selectedTextBoundary(range, range.commonAncestorContainer, true);
  if (first === null || last === null) return null;

  const row = first.parentElement?.closest(ASSISTANT_ROW_SELECTOR);
  if (
    !row ||
    !viewport.contains(row) ||
    last.parentElement?.closest(ASSISTANT_ROW_SELECTOR) !== row
  ) {
    return null;
  }
  const markdown = first.parentElement?.closest(ASSISTANT_MARKDOWN_SELECTOR);
  if (!markdown || !markdown.contains(last)) return null;

  range.setStart(first, first === range.startContainer ? range.startOffset : 0);
  range.setEnd(last, last === range.endContainer ? range.endOffset : last.length);
  // The serializer only reads the ranges, and the native selection may overshoot this row.
  const narrowed = { rangeCount: 1, getRangeAt: () => range } as unknown as Selection;
  const text = chatMarkdownClipboardPayload(narrowed)?.text.trim();
  if (!text) return null;

  const rects = range.getClientRects();
  const rect = rects.item(rects.length - 1) ?? range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;
  return { text, rect };
}

/** Prefixes every line, so a fenced code block stays fenced inside the quote. */
export function formatAssistantQuote(text: string): string {
  return text
    .split("\n")
    .map((line) => (line.trim().length === 0 ? ">" : `> ${line}`))
    .join("\n");
}

/** Text to insert at the cursor: the quote set off by blank lines, reusing line breaks already there. */
export function buildAssistantQuoteInsertion(prompt: string, cursor: number, text: string): string {
  const before = prompt.slice(0, cursor);
  const after = prompt.slice(cursor);
  const leading =
    before.length === 0 || before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
  const trailing = after.startsWith("\n\n") ? "" : after.startsWith("\n") ? "\n" : "\n\n";
  return `${leading}${formatAssistantQuote(text)}${trailing}`;
}

/** Below the selection's end, or above it when that would leave the window; always inside the window. */
export function resolveSelectionToolbarPosition(input: {
  rect: SelectionRect;
  toolbar: { width: number; height: number };
  window: { width: number; height: number };
}): { left: number; top: number } {
  const { rect, toolbar, window } = input;
  const margin = 8;
  const below = rect.bottom + 6;
  const top =
    below + toolbar.height + margin > window.height ? rect.top - toolbar.height - 6 : below;
  return {
    left: Math.max(
      margin,
      Math.min(rect.right - toolbar.width, window.width - toolbar.width - margin),
    ),
    top: Math.max(margin, Math.min(top, window.height - toolbar.height - margin)),
  };
}
