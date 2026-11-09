import type { GitStatusResult, ThreadId } from "@piedpiper/contracts";
import type { SidebarThreadSortOrder } from "@piedpiper/contracts/settings";
import { useQuery } from "@tanstack/react-query";
import { AlarmClockIcon, EllipsisIcon, PinIcon, PinOffIcon, TerminalIcon } from "lucide-react";
import { memo, useEffect, useRef, useState, type MouseEvent, type MutableRefObject } from "react";

import { useSidebarRowSubscriptionLease } from "../../hooks/useSidebarRowSubscriptionLease";
import { sidebarProjectRowId } from "../../lib/sidebarTree";
import { useOfficeHoverStore } from "../office-mode/officeHoverStore";
import {
  isEventFromRowDom,
  resolveRunningTerminalToFocus,
  resolveSidebarRowAccessibility,
  resolveSidebarRowKeyAction,
  resolveSidebarThreadPr,
  resolveSidebarThreadTimestamp,
  resolveThreadRowClassName,
  resolveThreadStatusPill,
} from "../Sidebar.logic";
import { sidebarGitStatusQueryOptions } from "./sidebarGitStatusQuery";
import {
  hasUnseenThreadWake,
  sidebarSnoozedShelfRowId,
  snoozeWakeDescription,
  snoozeWakeLabel,
} from "../Sidebar.snooze";
import { useSidebarThreadSummaryById } from "../../storeSelectors";
import { useThreadSelectionStore } from "../../threadSelectionStore";
import { useThreadTitleRegenerationStore } from "../../threadTitleRegenerationStore";
import { useUiStateStore } from "../../uiStateStore";
import { selectThreadTerminalState, useTerminalStateStore } from "../../terminalStateStore";
import { isImeComposingKeyboardEvent } from "../../lib/imeComposition";
import { prStatusIndicator } from "../../lib/openPullRequestLink";
import { discardComposerDraftContent, useThreadHasUnsentDraft } from "../../composerDraftStore";
import {
  THREAD_UNSENT_DRAFT_ROW_CLASS_NAME,
  ThreadUnsentDraftMarker,
} from "../composer/ThreadUnsentDraftMarker";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { SidebarMenuSubButton, SidebarMenuSubItem, useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SidebarRelativeTime } from "./SidebarRelativeTime";
import { synchronizeStatusPulse } from "./statusPulse";
import { formatThreadWorktreeLabel } from "../../worktreeCleanup";
import { ThreadWorktreeIndicator } from "./ThreadWorktreeIndicator";
import { PrStatusIcon } from "./PrStatusIcon";
import { ThreadSnoozeSubmenu } from "./ThreadSnoozeMenu";
import { wakeSnoozedThread } from "./threadSnoozeActions";
import { ThreadTitleCard } from "./ThreadTitleCard";
import { UnicodeSpinner } from "./UnicodeSpinner";
import { cn } from "~/lib/utils";
import { textDirection } from "~/markdown-text-direction";

const SIDEBAR_GIT_STATUS_STALE_TIME_MS = 30_000;
const SIDEBAR_GIT_STATUS_REFETCH_INTERVAL_MS = 60_000;
const SNOOZE_WAKE_LABEL_REFRESH_MS = 60_000;

// Stable identity; structural sharing then skips re-renders for working-tree-only status changes.
const selectRowGitStatus = (status: GitStatusResult) => ({
  branch: status.branch,
  pr: status.pr,
});

/** "Wakes in" time shown in place of a snoozed row's timestamp. */
function SnoozeWakeLabel(props: { snoozedUntil: string }) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), SNOOZE_WAKE_LABEL_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <span title={`Wakes ${snoozeWakeDescription(props.snoozedUntil, nowMs)}`}>
      {snoozeWakeLabel(props.snoozedUntil, nowMs)}
    </span>
  );
}

interface TerminalStatusIndicator {
  label: string;
  colorClass: string;
  pulse: boolean;
}

function terminalStatusFromRunningIds(
  runningTerminalIds: string[],
): TerminalStatusIndicator | null {
  if (runningTerminalIds.length === 0) {
    return null;
  }
  const count = runningTerminalIds.length;
  return {
    label:
      count === 1
        ? "Terminal process running: open terminal"
        : `${count} terminal processes running: open terminal`,
    colorClass: "text-teal-600 dark:text-teal-300/90",
    pulse: true,
  };
}

export interface SidebarThreadRowProps {
  threadId: ThreadId;
  orderedProjectThreadIds: readonly ThreadId[];
  routeThreadId: ThreadId | null;
  showThreadJumpHints: boolean;
  jumpLabel: string | null;
  renamingThreadId: ThreadId | null;
  renamingTitle: string;
  /** Title captured when rename started; an untouched rename must not overwrite a newer title. */
  renamingOriginalTitle?: string;
  setRenamingTitle: (title: string) => void;
  renamingInputRef: MutableRefObject<HTMLInputElement | null>;
  renamingCommittedRef: MutableRefObject<boolean>;
  handleThreadClick: (
    event: MouseEvent,
    threadId: ThreadId,
    orderedProjectThreadIds: readonly ThreadId[],
  ) => void;
  navigateToThread: (threadId: ThreadId) => void;
  handleMultiSelectContextMenu: (position: { x: number; y: number }) => Promise<void>;
  handleThreadContextMenu: (
    threadId: ThreadId,
    position: { x: number; y: number },
  ) => Promise<void>;
  clearSelection: () => void;
  commitRename: (threadId: ThreadId, newTitle: string, originalTitle: string) => Promise<void>;
  cancelRename: () => void;
  attemptArchiveThread: (threadId: ThreadId) => Promise<void>;
  startRenameThread: (threadId: ThreadId) => void;
  attemptDeleteThread: (threadId: ThreadId) => Promise<void>;
  openPrLink: (event: MouseEvent<HTMLElement>, prUrl: string) => void;
  /** Git status falls back to the project checkout for threads without a worktree. */
  projectCwd: string | null;
  /** Shown timestamp follows the list's sort key; defaults to activity time. */
  threadSortOrder?: SidebarThreadSortOrder;
  /** Rendered in the project's snoozed shelf. */
  snoozed?: boolean;
}

export const SidebarThreadRow = memo(function SidebarThreadRow(props: SidebarThreadRowProps) {
  const [dotHovered, setDotHovered] = useState(false);
  const thread = useSidebarThreadSummaryById(props.threadId);
  const lastVisitedAt = useUiStateStore((state) => state.threadLastVisitedAtById[props.threadId]);
  const isPinned = useUiStateStore((state) => state.pinnedThreadIds.includes(props.threadId));
  const setThreadPinned = useUiStateStore((state) => state.setThreadPinned);
  const snooze = useUiStateStore((state) => state.snoozedThreadsById[props.threadId]);
  const isRegeneratingTitle = useThreadTitleRegenerationStore((state) =>
    state.regeneratingThreadIds.has(props.threadId),
  );
  // The ContextMenu key / Shift+F10 can also fire a native contextmenu after keydown opened one.
  const suppressContextMenuUntilRef = useRef(0);
  const rowElementRef = useRef<HTMLDivElement | null>(null);
  const restoreRowFocusAfterRenameRef = useRef(false);
  const isRenaming = props.renamingThreadId === props.threadId;
  useEffect(() => {
    if (isRenaming || !restoreRowFocusAfterRenameRef.current) return;
    restoreRowFocusAfterRenameRef.current = false;
    // The commit awaits the server; focus the user has since moved elsewhere stays there.
    const active = document.activeElement;
    if (active && active !== document.body) return;
    rowElementRef.current?.focus();
  }, [isRenaming]);
  const runningTerminalIds = useTerminalStateStore(
    (state) =>
      selectThreadTerminalState(state.terminalStateByThreadId, props.threadId).runningTerminalIds,
  );
  const isOfficeHovered = useOfficeHoverStore((s) => s.hoveredThreadId === props.threadId);
  // Subscribe to this row's own flag so selecting one thread re-renders only the rows that flip.
  const isSelected = useThreadSelectionStore((s) => s.selectedThreadIds.has(props.threadId));
  // The active thread's composer is on screen, so its draft needs no marker.
  const hasUnsentDraft =
    useThreadHasUnsentDraft(props.threadId) && props.routeThreadId !== props.threadId;
  const { isMobile, open: sidebarOpen } = useSidebar();
  const { leaseLiveStatus, rowRef } = useSidebarRowSubscriptionLease(
    props.routeThreadId === props.threadId,
  );
  const gitBranch = thread?.branch ?? null;
  const gitCwd = thread?.worktreePath ?? props.projectCwd;
  // Rows share one query per cwd; a released row keeps its cached badge without polling.
  const gitStatus = useQuery({
    ...sidebarGitStatusQueryOptions(gitCwd),
    staleTime: SIDEBAR_GIT_STATUS_STALE_TIME_MS,
    refetchInterval: SIDEBAR_GIT_STATUS_REFETCH_INTERVAL_MS,
    select: selectRowGitStatus,
    enabled: gitCwd !== null && gitBranch !== null && leaseLiveStatus && (isMobile || sidebarOpen),
  });
  // Plain bindings so the React Compiler treats these as refs rather than prop mutations.
  const { renamingInputRef, renamingCommittedRef } = props;

  if (!thread) {
    return null;
  }

  const isActive = props.routeThreadId === thread.id;
  const isHighlighted = isActive || isSelected;
  const isThreadRunning =
    thread.session?.status === "running" && thread.session.activeTurnId != null;
  const threadStatus = resolveThreadStatusPill({
    thread: {
      ...thread,
      lastVisitedAt,
    },
  });
  const showWakeMarker =
    !props.snoozed &&
    !isActive &&
    snooze !== undefined &&
    hasUnseenThreadWake(thread, snooze, lastVisitedAt);
  const prStatus = prStatusIndicator(
    resolveSidebarThreadPr({ branch: gitBranch, status: gitStatus.data }),
  );
  const rowAccessibility = resolveSidebarRowAccessibility({
    title: thread.title,
    statusLabel: threadStatus?.label ?? null,
    worktreeLabel: formatThreadWorktreeLabel(thread),
    extraLabels: [
      hasUnsentDraft ? "Unsent draft" : null,
      props.snoozed ? "Snoozed" : null,
      showWakeMarker ? "Snooze ended" : null,
      isRegeneratingTitle ? "Regenerating title" : null,
    ],
    projectDisplayName: null,
    isActive,
  });
  const terminalStatus = terminalStatusFromRunningIds(runningTerminalIds);
  const openRunningTerminal = () => {
    const terminalStore = useTerminalStateStore.getState();
    const terminalState = selectThreadTerminalState(
      terminalStore.terminalStateByThreadId,
      thread.id,
    );
    const terminalId = resolveRunningTerminalToFocus(terminalState);
    if (terminalId !== null) terminalStore.setActiveTerminal(thread.id, terminalId);
    terminalStore.setTerminalOpen(thread.id, true);
    props.navigateToThread(thread.id);
  };
  const openRowMenu = (position: { x: number; y: number }) => {
    const hasSelection = useThreadSelectionStore.getState().hasSelection();
    if (hasSelection && isSelected) {
      void props.handleMultiSelectContextMenu(position);
      return;
    }
    if (hasSelection) {
      props.clearSelection();
    }
    void props.handleThreadContextMenu(thread.id, position);
  };
  const threadMetaClassName = !isThreadRunning
    ? "pointer-events-none transition-opacity duration-150 group-hover/menu-sub-item:opacity-0 group-focus-within/menu-sub-item:opacity-0"
    : "pointer-events-none";

  return (
    <SidebarMenuSubItem ref={rowRef} className="w-full" data-thread-item>
      <SidebarMenuSubButton
        render={<div ref={rowElementRef} role="button" tabIndex={0} />}
        size="sm"
        isActive={isActive}
        data-testid={`thread-row-${thread.id}`}
        data-sidebar-row={thread.id}
        data-sidebar-parent={
          props.snoozed
            ? sidebarSnoozedShelfRowId(sidebarProjectRowId(thread.projectId))
            : sidebarProjectRowId(thread.projectId)
        }
        aria-label={rowAccessibility.label}
        aria-current={rowAccessibility.current}
        aria-busy={isRegeneratingTitle || undefined}
        // cn (tailwind-merge) lets the draft tint's hover color win over the base hover.
        className={cn(
          resolveThreadRowClassName({ isActive, isSelected }),
          "relative isolate",
          isOfficeHovered
            ? "ring-1 ring-inset ring-primary/40 bg-accent"
            : hasUnsentDraft && !isSelected
              ? THREAD_UNSENT_DRAFT_ROW_CLASS_NAME
              : null,
        )}
        onClick={(event) => {
          // A portaled hover card or tooltip bubbles here through the React tree.
          if (!isEventFromRowDom(event)) return;
          props.handleThreadClick(event, thread.id, props.orderedProjectThreadIds);
        }}
        onDoubleClick={(event) => {
          if (!isEventFromRowDom(event)) return;
          // Re-entering would discard an in-progress edit.
          if (props.renamingThreadId === thread.id) return;
          // On mobile the first tap closes the sidebar sheet, so rename stays in the menu.
          if (isMobile) return;
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          if (event.target instanceof Element && event.target.closest("button, a")) return;
          event.preventDefault();
          props.startRenameThread(thread.id);
        }}
        onKeyDown={(event) => {
          // Inner controls and portaled menu items bubble here; these keys are for the row itself.
          if (event.target !== event.currentTarget) return;
          const action = resolveSidebarRowKeyAction(event);
          if (action === null) return;
          event.preventDefault();
          // A held key must not repeat the action, such as the Enter that just ended a rename.
          if (event.repeat) return;
          if (action === "select") {
            props.navigateToThread(thread.id);
            return;
          }
          if (action === "rename") {
            if (!isRenaming) props.startRenameThread(thread.id);
            return;
          }
          suppressContextMenuUntilRef.current = event.timeStamp + 1_000;
          const rect = event.currentTarget.getBoundingClientRect();
          openRowMenu({ x: rect.left + 8, y: rect.bottom });
        }}
        onContextMenu={(event) => {
          if (!isEventFromRowDom(event)) return;
          event.preventDefault();
          if (event.timeStamp < suppressContextMenuUntilRef.current) {
            suppressContextMenuUntilRef.current = 0;
            return;
          }
          openRowMenu({ x: event.clientX, y: event.clientY });
        }}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <span
            className="flex size-3.5 shrink-0 items-center justify-center cursor-default"
            onMouseEnter={() => setDotHovered(true)}
            onMouseLeave={() => setDotHovered(false)}
          >
            {threadStatus?.label === "Working" ? (
              <UnicodeSpinner colorClass="bg-foreground" />
            ) : threadStatus?.pulse ? (
              <span className="relative flex size-3 items-center justify-center">
                <span
                  className={`absolute size-3 rounded-full motion-safe:animate-status-ping motion-reduce:hidden ${threadStatus.dotClass} opacity-40`}
                />
                <span className={`relative size-1.5 rounded-full ${threadStatus.dotClass}`} />
              </span>
            ) : (
              <span
                className={`size-1.5 rounded-full ${
                  threadStatus ? threadStatus.dotClass : "bg-foreground/20"
                }`}
              />
            )}
          </span>
          {prStatus && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label={prStatus.tooltip}
                    className={`inline-flex items-center justify-center ${prStatus.colorClass} cursor-pointer rounded-sm outline-hidden`}
                    onClick={(event) => {
                      props.openPrLink(event, prStatus.url);
                    }}
                  >
                    <PrStatusIcon label={prStatus.label} className="size-3" />
                  </button>
                }
              />
              <TooltipPopup side="top">{prStatus.tooltip}</TooltipPopup>
            </Tooltip>
          )}
          {hasUnsentDraft ? <ThreadUnsentDraftMarker /> : null}
          {isRenaming ? (
            <input
              ref={(element) => {
                if (element && renamingInputRef.current !== element) {
                  renamingInputRef.current = element;
                  element.focus();
                  element.select();
                }
              }}
              dir="auto"
              className="min-w-0 flex-1 truncate text-xs bg-transparent outline-none border border-ring rounded px-0.5"
              value={props.renamingTitle}
              onChange={(event) => props.setRenamingTitle(event.target.value)}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (isImeComposingKeyboardEvent(event.nativeEvent)) return;
                if (event.key === "Enter") {
                  event.preventDefault();
                  renamingCommittedRef.current = true;
                  restoreRowFocusAfterRenameRef.current = true;
                  void props.commitRename(
                    thread.id,
                    props.renamingTitle,
                    props.renamingOriginalTitle ?? thread.title,
                  );
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  renamingCommittedRef.current = true;
                  restoreRowFocusAfterRenameRef.current = true;
                  props.cancelRename();
                }
              }}
              onBlur={() => {
                if (!renamingCommittedRef.current) {
                  void props.commitRename(
                    thread.id,
                    props.renamingTitle,
                    props.renamingOriginalTitle ?? thread.title,
                  );
                }
              }}
              onClick={(event) => event.stopPropagation()}
              onDoubleClick={(event) => event.stopPropagation()}
            />
          ) : (
            <span className="relative min-w-0 flex-1 overflow-hidden">
              <Tooltip>
                <TooltipTrigger
                  delay={500}
                  render={
                    <span
                      data-testid={`thread-title-${thread.id}`}
                      dir={textDirection(thread.title) ?? "auto"}
                      className={`block truncate text-xs transition-all duration-200 ${dotHovered ? "opacity-0 -translate-y-2" : isRegeneratingTitle ? "opacity-60 translate-y-0" : "opacity-100 translate-y-0"}`}
                    />
                  }
                >
                  {thread.title}
                </TooltipTrigger>
                <TooltipPopup side="top" className="max-w-80 whitespace-normal leading-tight">
                  <ThreadTitleCard
                    thread={thread}
                    currentGitBranch={gitStatus.data?.branch ?? null}
                  />
                </TooltipPopup>
              </Tooltip>
              <span
                className={`pointer-events-none absolute inset-0 flex items-center truncate text-xs transition-all duration-200 ${dotHovered ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2"} ${threadStatus ? threadStatus.colorClass : "text-muted-foreground/50"}`}
              >
                {threadStatus ? threadStatus.label : "Idle"}
              </span>
            </span>
          )}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {isPinned && (
            <button
              type="button"
              data-thread-selection-safe
              data-testid={`thread-unpin-${thread.id}`}
              aria-label={`Unpin ${thread.title}`}
              title="Unpin thread"
              className="group/unpin inline-flex cursor-pointer items-center justify-center rounded-sm text-muted-foreground/65 outline-hidden transition-colors hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
              onPointerDown={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setThreadPinned(thread.id, false);
              }}
            >
              <PinIcon
                aria-hidden
                className="size-3 group-hover/unpin:hidden group-focus-visible/unpin:hidden"
              />
              <PinOffIcon
                aria-hidden
                className="hidden size-3 group-hover/unpin:block group-focus-visible/unpin:block"
              />
            </button>
          )}
          {showWakeMarker ? (
            <span
              aria-hidden="true"
              data-testid={`thread-woke-${thread.id}`}
              title="Snooze ended"
              className="inline-flex shrink-0 items-center justify-center text-info"
            >
              <AlarmClockIcon className="size-3" />
            </span>
          ) : null}
          <ThreadWorktreeIndicator
            threadId={thread.id}
            worktreePath={thread.worktreePath}
            branch={thread.branch}
          />
          {terminalStatus && (
            <button
              type="button"
              data-thread-selection-safe
              data-testid={`thread-terminal-${thread.id}`}
              aria-label={terminalStatus.label}
              title={terminalStatus.label}
              className={`inline-flex cursor-pointer items-center justify-center rounded-sm outline-hidden focus-visible:ring-1 focus-visible:ring-ring ${terminalStatus.colorClass}`}
              onPointerDown={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                openRunningTerminal();
              }}
            >
              <TerminalIcon
                className={`size-3 ${terminalStatus.pulse ? "motion-safe:animate-status-pulse" : ""}`}
                onAnimationStart={synchronizeStatusPulse}
              />
            </button>
          )}
          <div className="flex min-w-12 justify-end">
            {!isThreadRunning ? (
              <div
                className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 opacity-0 transition-opacity duration-150 group-hover/menu-sub-item:pointer-events-auto group-hover/menu-sub-item:opacity-100 group-focus-within/menu-sub-item:pointer-events-auto group-focus-within/menu-sub-item:opacity-100"
                onClick={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
                onMouseUp={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
                onPointerUp={(e) => e.stopPropagation()}
              >
                <Menu>
                  <MenuTrigger
                    data-thread-selection-safe
                    data-testid={`thread-menu-${thread.id}`}
                    aria-label={`Thread actions for ${thread.title}`}
                    className="inline-flex size-5 cursor-pointer items-center justify-center text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <EllipsisIcon className="size-3.5" />
                  </MenuTrigger>
                  <MenuPopup align="end" side="bottom" className="min-w-32">
                    <MenuItem
                      className="min-h-7 py-1 sm:text-xs"
                      onClick={() => props.startRenameThread(thread.id)}
                    >
                      Rename
                    </MenuItem>
                    <MenuItem
                      className="min-h-7 py-1 sm:text-xs"
                      onClick={() => setThreadPinned(thread.id, !isPinned)}
                    >
                      {isPinned ? "Unpin" : "Pin"}
                    </MenuItem>
                    {props.snoozed ? (
                      <MenuItem
                        className="min-h-7 py-1 sm:text-xs"
                        onClick={() => wakeSnoozedThread(thread.id)}
                      >
                        Wake now
                      </MenuItem>
                    ) : (
                      <ThreadSnoozeSubmenu threadId={thread.id} thread={thread} />
                    )}
                    {hasUnsentDraft ? (
                      <MenuItem
                        className="min-h-7 py-1 sm:text-xs"
                        onClick={() => discardComposerDraftContent(thread.id)}
                      >
                        Discard draft
                      </MenuItem>
                    ) : null}
                    <MenuItem
                      className="min-h-7 py-1 sm:text-xs"
                      onClick={() => void props.attemptArchiveThread(thread.id)}
                    >
                      Archive
                    </MenuItem>
                    <MenuItem
                      className="min-h-7 py-1 sm:text-xs"
                      variant="destructive"
                      onClick={() => void props.attemptDeleteThread(thread.id)}
                    >
                      Delete
                    </MenuItem>
                  </MenuPopup>
                </Menu>
              </div>
            ) : null}
            <span className={threadMetaClassName}>
              {props.showThreadJumpHints && props.jumpLabel ? (
                <kbd
                  className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[4px] border border-foreground/15 bg-foreground/8 px-1 font-sans text-[10px] font-medium leading-none text-foreground/75"
                  title={props.jumpLabel}
                >
                  {props.jumpLabel}
                </kbd>
              ) : (
                <span
                  className={`text-xs tabular-nums ${
                    isHighlighted ? "text-foreground/55" : "text-foreground/35"
                  }`}
                >
                  {props.snoozed && snooze !== undefined ? (
                    <SnoozeWakeLabel snoozedUntil={snooze.snoozedUntil} />
                  ) : (
                    <SidebarRelativeTime
                      timestamp={resolveSidebarThreadTimestamp(
                        thread,
                        props.threadSortOrder ?? "updated_at",
                      )}
                    />
                  )}
                </span>
              )}
            </span>
          </div>
        </div>
      </SidebarMenuSubButton>
      {/* Stays mounted: assistive tech only announces text changes in an existing live region. */}
      <span role="status" className="sr-only">
        {isRegeneratingTitle ? "Regenerating title" : ""}
      </span>
    </SidebarMenuSubItem>
  );
});
