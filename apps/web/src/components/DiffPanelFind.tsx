import { DEFAULT_VIRTUAL_FILE_METRICS } from "@pierre/diffs";
import { ChevronDownIcon, ChevronUpIcon, SearchIcon, XIcon } from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
  startTransition,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { useStableCallback } from "../hooks/useStableCallback";
import {
  buildDiffFindMatchKey,
  buildDiffFindPattern,
  collectDiffFindMatches,
  type DiffFindFile,
  type DiffFindMatch,
  estimateDiffFindMatchOffset,
  estimateDiffFindRowTop,
  formatDiffFindCount,
  isDiffFindChord,
  parseDiffRowIndex,
  resolveDiffFindLineRange,
  reuseDiffFindFiles,
  wrapDiffFindIndex,
} from "../lib/diffFind";
import {
  type DiffFindRevealAnchor,
  followDiffFindMatch,
  resolveDiffFindRevealKey,
} from "./DiffPanel.logic";

const MATCH_HIGHLIGHT = "diff-find-match";
const ACTIVE_MATCH_HIGHLIGHT = "diff-find-active";
// The expanded file and the viewer's window each take frames to render.
const REVEAL_MAX_FRAMES = 120;
// Settling first, so typing through a word does not unfold every file its prefixes match.
const REVEAL_WHILE_TYPING_DELAY_MS = 150;

/** Goes in the viewer's own CSS: a ::highlight rule only reaches its own shadow tree. */
export const DIFF_FIND_UNSAFE_CSS = `
::highlight(${MATCH_HIGHLIGHT}) {
  background-color: color-mix(in srgb, var(--warning) 35%, transparent);
}

::highlight(${ACTIVE_MATCH_HIGHLIGHT}) {
  background-color: color-mix(in srgb, var(--warning) 75%, transparent);
}
`;

function findFileBlockElement(viewport: HTMLElement, fileKey: string): HTMLElement | undefined {
  return Array.from(viewport.querySelectorAll<HTMLElement>("[data-diff-file-block]")).find(
    (element) => element.dataset.diffFileBlock === fileKey,
  );
}

function fileShadowRoot(fileElement: Element): ShadowRoot | null {
  return fileElement.querySelector("diffs-container")?.shadowRoot ?? null;
}

function findMatchRow(root: ShadowRoot, match: DiffFindMatch): HTMLElement | null {
  const column =
    root.querySelector(`[data-code][data-${match.side}]`) ??
    root.querySelector("[data-code][data-unified]");
  const rows = column?.querySelectorAll<HTMLElement>(`[data-line="${match.lineNumber}"]`) ?? [];
  const changeType = match.side === "deletions" ? "change-deletion" : "change-addition";
  for (const row of rows) {
    const lineType = row.dataset.lineType ?? "";
    if (match.isContext ? lineType.startsWith("context") : lineType === changeType) return row;
  }
  return null;
}

/** One range per match on the row; syntax tokens split a match across several text nodes. */
function buildRowMatchRanges(row: HTMLElement, pattern: RegExp): Range[] {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  const text = nodes.map((node) => node.data).join("");

  const ranges: Range[] = [];
  let nodeIndex = 0;
  let nodeStart = 0;
  const seek = (offset: number) => {
    while (nodeIndex < nodes.length - 1 && offset > nodeStart + nodes[nodeIndex]!.length) {
      nodeStart += nodes[nodeIndex]!.length;
      nodeIndex += 1;
    }
    return { node: nodes[nodeIndex]!, offset: offset - nodeStart };
  };
  for (const match of text.matchAll(pattern)) {
    const start = seek(match.index);
    const end = seek(match.index + match[0].length);
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    ranges.push(range);
  }
  return ranges;
}

function paintMatches(input: {
  viewport: HTMLElement;
  pattern: RegExp;
  activeMatch: DiffFindMatch | null;
  onShadowRoot: (root: ShadowRoot) => void;
}) {
  const { viewport, pattern, activeMatch } = input;
  const matchRanges: Range[] = [];
  const activeRanges: Range[] = [];
  for (const fileElement of viewport.querySelectorAll<HTMLElement>("[data-diff-file-block]")) {
    const root = fileShadowRoot(fileElement);
    if (!root) continue;
    input.onShadowRoot(root);
    const activeRow =
      activeMatch && activeMatch.fileKey === fileElement.dataset.diffFileBlock
        ? findMatchRow(root, activeMatch)
        : null;
    for (const row of root.querySelectorAll<HTMLElement>("[data-line]")) {
      buildRowMatchRanges(row, pattern).forEach((range, occurrence) => {
        const isActive = row === activeRow && occurrence === activeMatch?.occurrence;
        (isActive ? activeRanges : matchRanges).push(range);
      });
    }
  }
  CSS.highlights.set(MATCH_HIGHLIGHT, new Highlight(...matchRanges));
  CSS.highlights.set(ACTIVE_MATCH_HIGHLIGHT, new Highlight(...activeRanges));
}

/** Where the row should be, by the rows mounted around it; wrapped rows make a line-height sum wrong. */
function estimateMatchRowTop(root: ShadowRoot | null, match: DiffFindMatch, split: boolean) {
  const mounted: { row: number; top: number; bottom: number }[] = [];
  for (const element of root?.querySelectorAll<HTMLElement>("[data-line]") ?? []) {
    const row = parseDiffRowIndex(element.dataset.lineIndex, split);
    if (row === null) continue;
    const rect = element.getBoundingClientRect();
    mounted.push({ row, top: rect.top, bottom: rect.bottom });
  }
  return estimateDiffFindRowTop(split ? match.splitRow : match.unifiedRow, mounted);
}

/** Brings a match on a long unwrapped line into its column's horizontal scroll. */
function revealMatchHorizontally(row: HTMLElement, match: DiffFindMatch, pattern: RegExp) {
  const column = row.closest<HTMLElement>("[data-code]");
  const range = buildRowMatchRanges(row, pattern)[match.occurrence];
  if (!column || !range || column.scrollWidth <= column.clientWidth) return;
  const columnRect = column.getBoundingClientRect();
  const rangeRect = range.getBoundingClientRect();
  // The line numbers stay pinned over the start of the column.
  const gutterRight = column.firstElementChild?.getBoundingClientRect().right ?? columnRect.left;
  if (rangeRect.right > columnRect.right || rangeRect.left < gutterRight) {
    column.scrollLeft += rangeRect.left - columnRect.left - columnRect.width / 2;
  }
}

/** Virtualized rows only exist near the viewport, so aim by estimate until the row is mounted. */
function revealMatch(input: {
  viewport: HTMLElement;
  /** Read on each frame: a refresh can move the match while it is being revealed. */
  readMatch: () => DiffFindMatch | null;
  pattern: RegExp;
  split: boolean;
  lineHeight: number;
}): () => void {
  const { viewport, readMatch, pattern, split, lineHeight } = input;
  let frameId = 0;
  let framesLeft = REVEAL_MAX_FRAMES;
  let framesInView = 0;
  let lastDirection = 0;
  let damping = 1;
  const step = () => {
    const match = readMatch();
    if (!match) return;
    const scroller = viewport.querySelector<HTMLElement>(".diff-render-surface");
    const fileElement = findFileBlockElement(viewport, match.fileKey);
    if (scroller && fileElement) {
      const scrollerRect = scroller.getBoundingClientRect();
      const root = fileShadowRoot(fileElement);
      const row = root ? findMatchRow(root, match) : null;
      if (row) {
        const rowRect = row.getBoundingClientRect();
        const clearOfStickyHeader =
          scrollerRect.top + DEFAULT_VIRTUAL_FILE_METRICS.diffHeaderHeight;
        if (rowRect.top >= clearOfStickyHeader && rowRect.bottom <= scrollerRect.bottom) {
          framesInView += 1;
          // A second look, since files mounting above can still push the row away.
          if (framesInView === 2) {
            revealMatchHorizontally(row, match, pattern);
            return;
          }
        } else {
          framesInView = 0;
          scroller.scrollTop +=
            rowRect.top - scrollerRect.top - (scroller.clientHeight - rowRect.height) / 2;
        }
      } else {
        framesInView = 0;
        const rowTop = estimateMatchRowTop(root, match, split);
        const targetTop =
          rowTop ??
          fileElement.getBoundingClientRect().top +
            estimateDiffFindMatchOffset(match, {
              split,
              lineHeight,
              headerHeight: DEFAULT_VIRTUAL_FILE_METRICS.diffHeaderHeight,
              separatorHeight: DEFAULT_VIRTUAL_FILE_METRICS.hunkSeparatorHeight ?? 32,
            });
        const distance = targetTop - scrollerRect.top - scroller.clientHeight / 2;
        // Unmeasured rows lay out shorter than the estimate, so narrow in after each overshoot.
        const direction = Math.sign(distance);
        if (direction !== 0 && lastDirection !== 0 && direction !== lastDirection) damping /= 2;
        if (direction !== 0) lastDirection = direction;
        scroller.scrollTop += distance * damping;
      }
    }
    framesLeft -= 1;
    if (framesLeft > 0) frameId = window.requestAnimationFrame(step);
  };
  frameId = window.requestAnimationFrame(step);
  return () => window.cancelAnimationFrame(frameId);
}

interface DiffFindState {
  scopeKey: string | null;
  open: boolean;
  query: string;
  activeIndex: number;
  /** Bumped by Enter and the arrows, so a lone match can be jumped back to. */
  revealRequest: number;
  focusRequest: number;
  revealAnchor: DiffFindRevealAnchor | null;
}

function closedFindState(scopeKey: string | null, focusRequest: number): DiffFindState {
  return {
    scopeKey,
    open: false,
    query: "",
    activeIndex: 0,
    revealRequest: 0,
    focusRequest,
    revealAnchor: null,
  };
}

function isEditableEventTarget(event: Event): boolean {
  const target = event.composedPath()[0];
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || target.matches("input, textarea, select"))
  );
}

export function useDiffPanelFind(input: {
  scopeKey: string | null;
  /** False for a patch with no parsed files; the raw text fallback has nothing to navigate. */
  enabled: boolean;
  files: ReadonlyArray<DiffFindFile>;
  split: boolean;
  lineHeight: number;
  panelRef: RefObject<HTMLElement | null>;
  viewportRef: RefObject<HTMLElement | null>;
  /** Must only ever unfold: find can ask again before the unfolded file reaches the viewer. */
  onRevealFile: (fileKey: string) => void;
}) {
  const { scopeKey, enabled, split, lineHeight, panelRef, viewportRef } = input;
  const [state, setState] = useState<DiffFindState>(() => closedFindState(scopeKey, 0));
  if (state.scopeKey !== scopeKey) {
    setState(closedFindState(scopeKey, state.focusRequest));
  }
  const isOpen = enabled && state.open;
  const query = isOpen ? state.query : "";
  // The caller builds a new array each render; scanning every line again for that would be wasted.
  const [heldFiles, setHeldFiles] = useState(input.files);
  const files = reuseDiffFindFiles(heldFiles, input.files);
  if (files !== heldFiles) setHeldFiles(files);
  const { matches, truncated } = useMemo(
    () => collectDiffFindMatches(files, query),
    [files, query],
  );
  // Only while open: a reload with no patch for a moment must not lose the match being followed.
  const [heldMatches, setHeldMatches] = useState({ matches, query });
  if (isOpen && heldMatches.matches !== matches) {
    setHeldMatches({ matches, query });
    if (state.scopeKey === scopeKey && heldMatches.query === query) {
      const followed = followDiffFindMatch(
        heldMatches.matches,
        state.activeIndex,
        matches,
        state.revealAnchor,
      );
      if (followed.index !== state.activeIndex || followed.anchor !== state.revealAnchor) {
        setState((current) => ({
          ...current,
          activeIndex: followed.index,
          revealAnchor: followed.anchor,
        }));
      }
    }
  }
  const activeIndex = Math.min(state.activeIndex, Math.max(0, matches.length - 1));
  const activeMatch = matches[activeIndex] ?? null;
  const activeMatchKey = activeMatch ? buildDiffFindMatchKey(activeMatch) : null;
  const revealKey = resolveDiffFindRevealKey(activeMatchKey, state.revealAnchor);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputHadFocusRef = useRef(false);

  useEffect(() => {
    if (state.focusRequest === 0) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [state.focusRequest]);

  // Held still for the active file's row, which re-renders its viewer when this changes.
  const activeLineRange = useMemo(
    () => (activeMatch ? resolveDiffFindLineRange(activeMatch) : null),
    [activeMatch],
  );

  const readActiveMatch = useStableCallback(() => activeMatch);
  const revealActiveMatch = useStableCallback(() => {
    const viewport = viewportRef.current;
    const pattern = buildDiffFindPattern(query);
    if (!viewport || !activeMatch || !pattern) return undefined;
    input.onRevealFile(activeMatch.fileKey);
    return revealMatch({ viewport, readMatch: readActiveMatch, pattern, split, lineHeight });
  });
  const handledRevealRequestRef = useRef(state.revealRequest);
  useEffect(() => {
    // Before the null check: a step with nothing to reveal must not pass for one on the next match.
    const steppedHere = handledRevealRequestRef.current !== state.revealRequest;
    handledRevealRequestRef.current = state.revealRequest;
    if (revealKey === null) return;
    if (steppedHere) return revealActiveMatch();
    let cancelReveal: (() => void) | undefined;
    const timer = window.setTimeout(() => {
      cancelReveal = revealActiveMatch();
    }, REVEAL_WHILE_TYPING_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
      cancelReveal?.();
    };
  }, [revealKey, revealActiveMatch, state.revealRequest]);

  useEffect(() => {
    const viewport = viewportRef.current;
    const pattern = buildDiffFindPattern(query);
    if (!viewport || !pattern || typeof CSS === "undefined" || !CSS.highlights) return;
    let frameId = 0;
    const schedulePaint = () => {
      if (frameId === 0) frameId = window.requestAnimationFrame(paint);
    };
    // Rows come and go with scrolling, and the highlighter swaps them for tokenized ones.
    const observer = new MutationObserver(schedulePaint);
    const observedRoots = new WeakSet<ShadowRoot>();
    const paint = () => {
      frameId = 0;
      paintMatches({
        viewport,
        pattern,
        activeMatch: readActiveMatch(),
        onShadowRoot: (root) => {
          if (observedRoots.has(root)) return;
          observedRoots.add(root);
          observer.observe(root, { childList: true, subtree: true });
        },
      });
    };
    observer.observe(viewport, { childList: true, subtree: true });
    viewport.addEventListener("scroll", schedulePaint, { capture: true, passive: true });
    schedulePaint();
    return () => {
      window.cancelAnimationFrame(frameId);
      observer.disconnect();
      viewport.removeEventListener("scroll", schedulePaint, { capture: true });
      CSS.highlights.delete(MATCH_HIGHLIGHT);
      CSS.highlights.delete(ACTIVE_MATCH_HIGHLIGHT);
    };
  }, [activeMatchKey, query, readActiveMatch, viewportRef]);

  const close = () => {
    setState((current) => closedFindState(current.scopeKey, current.focusRequest));
    panelRef.current?.focus();
  };
  const step = (delta: number) => {
    setState((current) => ({
      ...current,
      activeIndex: wrapDiffFindIndex(activeIndex, delta, matches.length),
      revealRequest: current.revealRequest + 1,
    }));
  };
  const handlePanelKeyDown = (event: ReactKeyboardEvent) => {
    if (enabled && isDiffFindChord(event, navigator.platform)) {
      event.preventDefault();
      event.stopPropagation();
      setState((current) => ({
        ...current,
        open: true,
        focusRequest: current.focusRequest + 1,
      }));
      return;
    }
    if (event.key === "Escape" && isOpen && !isEditableEventTarget(event.nativeEvent)) {
      event.stopPropagation();
      close();
    }
  };

  return {
    isOpen,
    inputRef,
    inputHadFocusRef,
    query,
    countLabel: formatDiffFindCount({
      query,
      activeIndex,
      matchCount: matches.length,
      truncated,
    }),
    matchCount: matches.length,
    /** The panel keeps this file's viewer mounted, so a reveal only has to wait for its rows. */
    activeFileKey: activeMatch?.fileKey ?? null,
    activeLineRange,
    setQuery: (nextQuery: string) => {
      setState((current) => ({ ...current, query: nextQuery, activeIndex: 0, revealAnchor: null }));
    },
    step,
    close,
    handlePanelKeyDown,
  };
}

const FIND_BAR_BUTTON_CLASS_NAME =
  "inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors enabled:hover:bg-accent enabled:hover:text-foreground disabled:opacity-40";

export function DiffPanelFindBar({
  inputRef,
  inputHadFocusRef,
  ...props
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  /** Owned by the panel, since a refetch of the patch unmounts the bar while the user is typing. */
  inputHadFocusRef: RefObject<boolean>;
  /** Picks the search back up when a refetch of the patch unmounted the bar. */
  initialQuery: string;
  countLabel: string;
  hasMatches: boolean;
  onQueryChange: (query: string) => void;
  onStep: (delta: number) => void;
  onClose: () => void;
}) {
  // Kept here so typing never waits on the panel, which re-renders with every new match set.
  const [value, setValue] = useState(props.initialQuery);

  // Only back into an input that had focus, and never away from where the user has since moved.
  useLayoutEffect(() => {
    const element = inputRef.current;
    if (inputHadFocusRef.current && element && document.activeElement === document.body) {
      element.focus({ preventScroll: true });
      element.setSelectionRange(element.value.length, element.value.length);
    }
    return () => {
      inputHadFocusRef.current = document.activeElement === element;
    };
  }, [inputHadFocusRef, inputRef]);

  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-border/60 px-2 py-1.5">
      <div className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-border bg-secondary px-2.5 py-1">
        <SearchIcon className="size-3.5 shrink-0 text-muted-foreground/50" />
        <input
          ref={inputRef}
          aria-label="Find in diff"
          className="min-w-0 flex-1 bg-transparent text-xs text-foreground placeholder:text-muted-foreground/40 focus:outline-none"
          placeholder="Find in diff..."
          value={value}
          onChange={(event) => {
            const nextValue = event.target.value;
            setValue(nextValue);
            startTransition(() => props.onQueryChange(nextValue));
          }}
          onKeyDown={(event) => {
            // Enter and Escape belong to the IME while it is composing.
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Enter") {
              event.preventDefault();
              props.onStep(event.shiftKey ? -1 : 1);
            } else if (event.key === "Escape") {
              event.stopPropagation();
              props.onClose();
            }
          }}
        />
        <span role="status" className="shrink-0 text-[11px] tabular-nums text-muted-foreground/70">
          {props.countLabel}
        </span>
      </div>
      <button
        type="button"
        className={FIND_BAR_BUTTON_CLASS_NAME}
        aria-label="Previous match"
        title="Previous match"
        disabled={!props.hasMatches}
        onClick={() => props.onStep(-1)}
      >
        <ChevronUpIcon className="size-3.5" />
      </button>
      <button
        type="button"
        className={FIND_BAR_BUTTON_CLASS_NAME}
        aria-label="Next match"
        title="Next match"
        disabled={!props.hasMatches}
        onClick={() => props.onStep(1)}
      >
        <ChevronDownIcon className="size-3.5" />
      </button>
      <button
        type="button"
        className={FIND_BAR_BUTTON_CLASS_NAME}
        aria-label="Close find"
        title="Close"
        onClick={props.onClose}
      >
        <XIcon className="size-3.5" />
      </button>
    </div>
  );
}
