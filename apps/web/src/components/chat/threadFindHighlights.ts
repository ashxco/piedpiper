import { useEffect, useRef } from "react";

import {
  computeThreadFindScrollDelta,
  findThreadFindOccurrences,
  foldThreadFindText,
  type ThreadFindPosition,
} from "./threadFind.logic";

export const THREAD_FIND_HIGHLIGHT_NAME = "piedpiper-thread-find";
export const THREAD_FIND_ACTIVE_HIGHLIGHT_NAME = "piedpiper-thread-find-active";
/** Fired on a `data-thread-find-fold` element that hides the active match, so it can open itself. */
export const THREAD_FIND_REVEAL_EVENT = "beforematch";

const ROW_SELECTOR = "[data-timeline-row-id]";
const TEXT_SELECTOR = "[data-thread-find-text]";
const FOLD_SELECTOR = "[data-thread-find-fold]";
// Chrome inside a scope that the count, which only reads message text, does not know about.
const IGNORE_SELECTOR = [
  "button:not([data-markdown-details-summary])",
  "input",
  "[data-thread-find-ignore]",
  '[data-slot="badge"]',
  '[role="toolbar"]',
  '[aria-hidden="true"]',
  ".sr-only",
  ".select-none",
  ".katex",
].join(",");
// Inline wrappers, including Shiki's token spans, must not split a search phrase.
const BLOCK_TAGS = new Set(
  "ADDRESS ARTICLE ASIDE BLOCKQUOTE BR DD DETAILS DIV DL DT FIGCAPTION FIGURE FOOTER H1 H2 H3 H4 H5 H6 HEADER HR LI MAIN NAV OL P PRE SECTION SUMMARY TABLE TBODY TD TH THEAD TR UL".split(
    " ",
  ),
);

const MATCH_VIEW_MARGIN_PX = 96;
/** About one second: virtual rows mount and measure over several frames after a jump. */
const REVEAL_MAX_FRAMES = 60;
const REVEAL_SETTLED_FRAMES = 2;
const REVEAL_MAX_FOLD_ATTEMPTS = 3;

/** One row's matches in reading order, walking the DOM without modifying rendered markdown. */
export function collectThreadFindRowRanges(row: Element, foldedQuery: string): Range[] {
  if (foldedQuery.length === 0) return [];
  const ranges: Range[] = [];
  let text = "";
  let nodes: { node: Node; start: number; end: number }[] = [];
  const flush = () => {
    // Offsets ascend, so the node cursor only moves forward.
    let cursor = 0;
    for (const offset of findThreadFindOccurrences(foldThreadFindText(text), foldedQuery)) {
      while (cursor < nodes.length && nodes[cursor]!.end <= offset) cursor += 1;
      let endCursor = cursor;
      const end = offset + foldedQuery.length;
      while (endCursor < nodes.length && nodes[endCursor]!.end < end) endCursor += 1;
      const startNode = nodes[cursor];
      const endNode = nodes[endCursor];
      if (!startNode || !endNode) continue;
      const range = row.ownerDocument.createRange();
      range.setStart(startNode.node, offset - startNode.start);
      range.setEnd(endNode.node, end - endNode.start);
      ranges.push(range);
    }
    text = "";
    nodes = [];
  };
  const visit = (node: Node, inPre: boolean) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const value = node.nodeValue ?? "";
      const start = text.length;
      text += inPre ? value : value.replace(/[\r\n]/g, " ");
      nodes.push({ node, start, end: text.length });
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node as Element;
    if (element.matches("svg")) return;
    if (element.matches(IGNORE_SELECTOR)) {
      flush();
      return;
    }
    const block = BLOCK_TAGS.has(element.tagName);
    if (block) flush();
    const childInPre = inPre || element.tagName === "PRE";
    for (const child of element.childNodes) visit(child, childInPre);
    if (block) flush();
  };
  for (const scope of row.querySelectorAll(TEXT_SELECTOR)) {
    visit(scope, false);
    flush();
  }
  return ranges;
}

function supportsHighlights(): boolean {
  return (
    typeof CSS !== "undefined" && CSS.highlights !== undefined && typeof Highlight !== "undefined"
  );
}

function clearHighlights(): void {
  CSS.highlights.delete(THREAD_FIND_HIGHLIGHT_NAME);
  CSS.highlights.delete(THREAD_FIND_ACTIVE_HIGHLIGHT_NAME);
}

/** Timers and status chrome tick every second; only searchable text and folds matter. */
function mutationAffectsText(record: MutationRecord): boolean {
  if (record.type === "attributes") return true;
  const target =
    record.target.nodeType === Node.ELEMENT_NODE
      ? (record.target as Element)
      : record.target.parentElement;
  if (target?.closest(TEXT_SELECTOR)) return true;
  const touchesScope = (node: Node) =>
    node.nodeType === Node.ELEMENT_NODE &&
    ((node as Element).matches(TEXT_SELECTOR) ||
      (node as Element).querySelector(TEXT_SELECTOR) !== null);
  return [...record.addedNodes, ...record.removedNodes].some(touchesScope);
}

/** Paints every mounted match with the Custom Highlight API and re-collects as rows change. */
export function useThreadFindHighlights(input: {
  readonly container: HTMLElement | null;
  readonly foldedQuery: string;
  readonly activeRowId: string | null;
  readonly activeOccurrence: number;
}): void {
  const { container, foldedQuery, activeRowId, activeOccurrence } = input;
  const activeRef = useRef({ rowId: activeRowId, occurrence: activeOccurrence });
  const paintRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!supportsHighlights() || !container || foldedQuery.length === 0) return;
    // Only changed or newly mounted rows get walked again; removed rows release their ranges.
    const rangesByRow = new Map<Element, Range[]>();
    const paint = () => {
      const base = new Highlight();
      const current = new Highlight();
      const position = activeRef.current;
      for (const [row, ranges] of rangesByRow) {
        const isActiveRow = row.getAttribute("data-timeline-row-id") === position.rowId;
        const activeIndex = isActiveRow ? Math.min(position.occurrence, ranges.length - 1) : -1;
        ranges.forEach((range, index) => {
          (index === activeIndex ? current : base).add(range);
        });
      }
      CSS.highlights.set(THREAD_FIND_HIGHLIGHT_NAME, base);
      CSS.highlights.set(THREAD_FIND_ACTIVE_HIGHLIGHT_NAME, current);
    };
    const collect = () => {
      const rows = new Set(container.querySelectorAll(ROW_SELECTOR));
      for (const row of rows) {
        if (!rangesByRow.has(row)) {
          rangesByRow.set(row, collectThreadFindRowRanges(row, foldedQuery));
        }
      }
      for (const row of rangesByRow.keys()) {
        if (!rows.has(row)) rangesByRow.delete(row);
      }
      paint();
    };
    paintRef.current = paint;
    let frame: number | null = null;
    const observer = new MutationObserver((records) => {
      let relevant = false;
      for (const record of records) {
        if (!mutationAffectsText(record)) continue;
        relevant = true;
        const target =
          record.target.nodeType === Node.ELEMENT_NODE
            ? (record.target as Element)
            : record.target.parentElement;
        const row = target?.closest(ROW_SELECTOR);
        if (row) rangesByRow.delete(row);
      }
      if (!relevant || frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        collect();
      });
    });
    observer.observe(container, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["data-thread-find-fold", "data-timeline-row-id", "data-thread-find-text"],
    });
    collect();
    return () => {
      observer.disconnect();
      if (frame !== null) window.cancelAnimationFrame(frame);
      paintRef.current = null;
      clearHighlights();
    };
  }, [container, foldedQuery]);

  useEffect(() => {
    activeRef.current = { rowId: activeRowId, occurrence: activeOccurrence };
    paintRef.current?.();
  }, [activeRowId, activeOccurrence]);
}

/** Folds of a row that keep the wanted match out of sight. */
function foldsHidingMatch(row: Element, range: Range | null): Element[] {
  const folds = [...row.querySelectorAll(FOLD_SELECTOR)];
  if (!range) return folds;
  const bottom = range.getBoundingClientRect().bottom;
  return folds.filter(
    (fold) => fold.contains(range.startContainer) && bottom > fold.getBoundingClientRect().bottom,
  );
}

function revealInCodeScroller(range: Range): void {
  const scroller = range.startContainer.parentElement?.closest("pre");
  if (!scroller) return;
  const rect = range.getBoundingClientRect();
  const bounds = scroller.getBoundingClientRect();
  if (rect.left < bounds.left) scroller.scrollLeft += rect.left - bounds.left - 16;
  else if (rect.right > bounds.right) scroller.scrollLeft += rect.right - bounds.right + 16;
}

/**
 * Brings a match into view and keeps it there while virtual rows mount and measure. A user
 * scrolling takes over immediately. Returns a function that stops the loop.
 */
export function revealThreadFindMatch(input: {
  readonly container: HTMLElement;
  readonly scrollContainer: HTMLElement;
  readonly position: ThreadFindPosition;
  readonly foldedQuery: string;
  /** Scrolls a virtualized row into the rendered window; "missing" until a fold has opened. */
  readonly scrollRowIntoWindow: (rowId: string) => unknown;
}): () => void {
  const { container, scrollContainer, position, foldedQuery, scrollRowIntoWindow } = input;
  let frame: number | null = null;
  let framesLeft = REVEAL_MAX_FRAMES;
  let settledFrames = 0;
  let foldAttempts = 0;
  let requestedRow = false;

  const stop = () => {
    if (frame !== null) window.cancelAnimationFrame(frame);
    frame = null;
    scrollContainer.removeEventListener("wheel", stop);
    scrollContainer.removeEventListener("touchstart", stop);
    scrollContainer.removeEventListener("pointerdown", stop);
  };

  /** True when the match is in view with nothing left to do this frame. */
  const step = (): boolean => {
    const row = container.querySelector(`[data-timeline-row-id="${CSS.escape(position.rowId)}"]`);
    if (!row) {
      if (!requestedRow) requestedRow = scrollRowIntoWindow(position.rowId) !== "missing";
      return false;
    }
    const ranges = collectThreadFindRowRanges(row, foldedQuery);
    const range = ranges[position.occurrence] ?? null;
    if (foldAttempts < REVEAL_MAX_FOLD_ATTEMPTS) {
      const folds = foldsHidingMatch(row, range);
      if (folds.length > 0) {
        foldAttempts += 1;
        for (const fold of folds) fold.dispatchEvent(new Event(THREAD_FIND_REVEAL_EVENT));
        return false;
      }
    }
    const target = range ?? ranges.at(-1) ?? null;
    if (target) revealInCodeScroller(target);
    const targetRect = target?.getBoundingClientRect();
    const rect = targetRect && targetRect.height > 0 ? targetRect : row.getBoundingClientRect();
    const delta = computeThreadFindScrollDelta(
      rect,
      scrollContainer.getBoundingClientRect(),
      MATCH_VIEW_MARGIN_PX,
    );
    if (Math.abs(delta) < 1) return true;
    const previousScrollTop = scrollContainer.scrollTop;
    scrollContainer.scrollTop = previousScrollTop + delta;
    // At a scroll limit nothing more can be done.
    return Math.abs(scrollContainer.scrollTop - previousScrollTop) < 1;
  };

  const tick = () => {
    frame = null;
    framesLeft -= 1;
    settledFrames = step() ? settledFrames + 1 : 0;
    if (settledFrames >= REVEAL_SETTLED_FRAMES || framesLeft <= 0) {
      stop();
      return;
    }
    frame = window.requestAnimationFrame(tick);
  };

  scrollContainer.addEventListener("wheel", stop, { passive: true });
  scrollContainer.addEventListener("touchstart", stop, { passive: true });
  scrollContainer.addEventListener("pointerdown", stop);
  tick();
  return stop;
}
