import { type ThreadId } from "@piedpiper/contracts";
import { ChevronDownIcon, ChevronUpIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";

import { useStableCallback } from "~/hooks/useStableCallback";
import { MAX_THREAD_MESSAGES } from "~/lib/storeUpdateHelpers";
import { isTerminalFocused } from "~/lib/terminalFocus";
import { cn } from "~/lib/utils";

import { isExpandedImageOpen } from "../ChatView.expandedImage";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { deriveMessagesTimelineRows, type MessagesTimelineRow } from "./MessagesTimeline.logic";
import {
  deriveThreadFindMatches,
  findCollapsedFoldIdForRow,
  formatThreadFindCount,
  normalizeThreadFindQuery,
  pickThreadFindStartIndex,
  resolveThreadFindActiveIndex,
  stepThreadFindIndex,
  type ThreadFindPosition,
} from "./threadFind.logic";
import { revealThreadFindMatch, useThreadFindHighlights } from "./threadFindHighlights";
import { closeThreadFind, useThreadFindStore } from "./threadFindStore";

interface ThreadFindProps {
  threadId: ThreadId;
  /** The rendered rows, whose fold rows say what a jump has to open. */
  rows: ReadonlyArray<MessagesTimelineRow>;
  /** The timeline without turn folds, so text in a collapsed turn is searched too. */
  searchRowsInput: Parameters<typeof deriveMessagesTimelineRows>[0];
  /** Opens a collapsed turn fold that holds the match being jumped to. */
  onExpandFold: (foldId: string) => void;
  /** The cwd the rows render with, which decides what shows as a file chip. */
  markdownCwd?: string | undefined;
  /** Holds the rendered rows; matches in other rows only exist in the search rows until scrolled to. */
  timelineRoot: HTMLElement | null;
  scrollContainer: HTMLElement | null;
  scrollRowIntoWindow: (rowId: string) => unknown;
  /** Called before a jump, so follow-to-bottom stops first. */
  onNavigate?: (() => void) | undefined;
  /** Called after the bar closes from its own controls, to hand focus back. */
  onClose?: (() => void) | undefined;
}

function firstVisibleRowIndex(
  rows: ReadonlyArray<MessagesTimelineRow>,
  timelineRoot: HTMLElement | null,
  scrollContainer: HTMLElement | null,
): number {
  if (!timelineRoot || !scrollContainer) return 0;
  const viewportTop = scrollContainer.getBoundingClientRect().top;
  for (const element of timelineRoot.querySelectorAll("[data-timeline-row-id]")) {
    if (element.getBoundingClientRect().bottom <= viewportTop) continue;
    const rowId = element.getAttribute("data-timeline-row-id");
    const index = rows.findIndex((row) => row.id === rowId);
    if (index !== -1) return index;
  }
  return 0;
}

/** The find bar of one thread: mounts its search only while open, so closing resets it. */
export function ThreadFind(props: ThreadFindProps) {
  const { threadId } = props;
  const isOpen = useThreadFindStore((state) => state.openThreadId === threadId);
  // A remount per thread means leaving one closes its bar instead of carrying it to the next.
  useEffect(() => () => closeThreadFind(threadId), [threadId]);
  const portalTarget = props.scrollContainer?.parentElement;
  if (!isOpen || !portalTarget) return null;
  return createPortal(<ThreadFindSession {...props} />, portalTarget);
}

function ThreadFindSession({
  threadId,
  rows,
  searchRowsInput,
  onExpandFold,
  markdownCwd,
  timelineRoot,
  scrollContainer,
  scrollRowIntoWindow,
  onNavigate,
  onClose,
}: ThreadFindProps) {
  const focusRequestId = useThreadFindStore((state) => state.focusRequestId);
  const [query, setQuery] = useState("");
  // A new object for every jump, which is what re-runs the reveal effect.
  const [active, setActive] = useState<ThreadFindPosition | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const foldedQuery = normalizeThreadFindQuery(query);
  const searchRows = useMemo(() => deriveMessagesTimelineRows(searchRowsInput), [searchRowsInput]);
  const matches = useMemo(
    () => deriveThreadFindMatches(searchRows, query, { cwd: markdownCwd }),
    [searchRows, query, markdownCwd],
  );
  const activeIndex = resolveThreadFindActiveIndex(matches, active);
  const activeMatch = matches[activeIndex];
  const isTruncated =
    searchRowsInput.timelineEntries.reduce(
      (count, entry) => count + (entry.kind === "message" ? 1 : 0),
      0,
    ) >= MAX_THREAD_MESSAGES;

  useThreadFindHighlights({
    container: timelineRoot,
    foldedQuery,
    activeRowId: activeMatch?.rowId ?? null,
    activeOccurrence: activeMatch?.occurrence ?? 0,
  });

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusRequestId]);

  const reveal = useStableCallback((position: ThreadFindPosition) => {
    if (!timelineRoot || !scrollContainer) return undefined;
    onNavigate?.();
    const foldId = findCollapsedFoldIdForRow(
      rows,
      searchRows.find((row) => row.id === position.rowId),
    );
    if (foldId) onExpandFold(foldId);
    return revealThreadFindMatch({
      container: timelineRoot,
      scrollContainer,
      position,
      foldedQuery,
      scrollRowIntoWindow,
    });
  });
  useEffect(() => {
    if (active) return reveal(active);
    return undefined;
  }, [active, reveal]);

  const jumpToIndex = (nextMatches: ReturnType<typeof deriveThreadFindMatches>, index: number) => {
    const match = nextMatches[index];
    setActive(match ? { rowId: match.rowId, occurrence: match.occurrence } : null);
  };
  const onQueryChange = (nextQuery: string) => {
    setQuery(nextQuery);
    const nextMatches = deriveThreadFindMatches(searchRows, nextQuery, { cwd: markdownCwd });
    const anchorRowIndex =
      activeMatch?.rowIndex ?? firstVisibleRowIndex(searchRows, timelineRoot, scrollContainer);
    jumpToIndex(nextMatches, pickThreadFindStartIndex(nextMatches, anchorRowIndex));
  };
  const step = (delta: 1 | -1) => {
    jumpToIndex(matches, stepThreadFindIndex(activeIndex, matches.length, delta));
  };
  const close = useStableCallback(() => {
    closeThreadFind(threadId);
    onClose?.();
  });

  // With focus elsewhere in the timeline Escape still closes the bar, unless something else owns it.
  useEffect(() => {
    const onWindowKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (event.isComposing || event.keyCode === 229 || isTerminalFocused()) return;
      // The image preview owns Escape; it does not take focus, so the check below cannot see it.
      if (isExpandedImageOpen()) return;
      if (
        event.target instanceof Element &&
        event.target.closest('[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"]')
      ) {
        return;
      }
      event.preventDefault();
      close();
    };
    window.addEventListener("keydown", onWindowKeyDown);
    return () => window.removeEventListener("keydown", onWindowKeyDown);
  }, [close]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // IME composition owns these keys until it commits.
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (isExpandedImageOpen()) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === "Enter" && event.target === inputRef.current) {
      event.preventDefault();
      event.stopPropagation();
      step(event.shiftKey ? -1 : 1);
    }
  };

  const hasQuery = foldedQuery.length > 0;
  const hasNoResults = hasQuery && matches.length === 0;
  return (
    <div
      role="search"
      aria-label="Find in thread"
      data-testid="thread-find-bar"
      onKeyDown={onKeyDown}
      className="absolute top-2 right-3 z-30 w-[min(24rem,calc(100%-1.5rem))] rounded-lg border border-border bg-popover p-1 shadow-md"
    >
      <div className="flex items-center gap-1">
        <Input
          ref={inputRef}
          type="search"
          size="sm"
          unstyled
          nativeInput
          value={query}
          aria-label="Find in thread"
          placeholder="Find in thread"
          spellCheck={false}
          autoComplete="off"
          className="min-w-0 flex-1 text-sm text-foreground"
          onChange={(event) => onQueryChange(event.target.value)}
        />
        <span
          aria-live="polite"
          data-testid="thread-find-count"
          className={cn(
            "min-w-10 shrink-0 text-center text-xs tabular-nums",
            hasNoResults ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {hasQuery ? formatThreadFindCount(activeIndex, matches.length) : ""}
        </span>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label="Previous match"
          disabled={matches.length === 0}
          onClick={() => step(-1)}
        >
          <ChevronUpIcon />
        </Button>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label="Next match"
          disabled={matches.length === 0}
          onClick={() => step(1)}
        >
          <ChevronDownIcon />
        </Button>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label="Close find"
          onClick={close}
        >
          <XIcon />
        </Button>
      </div>
      {isTruncated && (
        <p className="px-2.5 pt-1 pb-0.5 text-[11px] text-muted-foreground">
          Searching the newest {MAX_THREAD_MESSAGES.toLocaleString()} messages.
        </p>
      )}
    </div>
  );
}
