import type { GitStatusResult, ThreadId } from "@piedpiper/contracts";
import { EllipsisIcon, GitPullRequestIcon, TerminalIcon } from "lucide-react";
import {
  memo,
  useState,
  type Dispatch,
  type MouseEvent,
  type MutableRefObject,
  type SetStateAction,
} from "react";

import { useOfficeHoverStore } from "../office-mode/officeHoverStore";
import { resolveThreadRowClassName, resolveThreadStatusPill } from "../Sidebar.logic";
import { useSidebarThreadSummaryById } from "../../storeSelectors";
import { useUiStateStore } from "../../uiStateStore";
import { selectThreadTerminalState, useTerminalStateStore } from "../../terminalStateStore";
import { formatRelativeTime } from "../../timestampFormat";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { SidebarMenuSubButton, SidebarMenuSubItem } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { UnicodeSpinner } from "./UnicodeSpinner";

type ThreadPr = GitStatusResult["pr"];

interface TerminalStatusIndicator {
  label: "Terminal process running";
  colorClass: string;
  pulse: boolean;
}

interface PrStatusIndicator {
  label: "PR open" | "PR closed" | "PR merged";
  colorClass: string;
  tooltip: string;
  url: string;
}

function terminalStatusFromRunningIds(
  runningTerminalIds: string[],
): TerminalStatusIndicator | null {
  if (runningTerminalIds.length === 0) {
    return null;
  }
  return {
    label: "Terminal process running",
    colorClass: "text-teal-600 dark:text-teal-300/90",
    pulse: true,
  };
}

function prStatusIndicator(pr: ThreadPr): PrStatusIndicator | null {
  if (!pr) return null;

  if (pr.state === "open") {
    return {
      label: "PR open",
      colorClass: "text-emerald-600 dark:text-emerald-300/90",
      tooltip: `#${pr.number} PR open: ${pr.title}`,
      url: pr.url,
    };
  }
  if (pr.state === "closed") {
    return {
      label: "PR closed",
      colorClass: "text-zinc-500 dark:text-zinc-400/80",
      tooltip: `#${pr.number} PR closed: ${pr.title}`,
      url: pr.url,
    };
  }
  if (pr.state === "merged") {
    return {
      label: "PR merged",
      colorClass: "text-violet-600 dark:text-violet-300/90",
      tooltip: `#${pr.number} PR merged: ${pr.title}`,
      url: pr.url,
    };
  }
  return null;
}

export interface SidebarThreadRowProps {
  threadId: ThreadId;
  orderedProjectThreadIds: readonly ThreadId[];
  routeThreadId: ThreadId | null;
  selectedThreadIds: ReadonlySet<ThreadId>;
  showThreadJumpHints: boolean;
  jumpLabel: string | null;
  appSettingsConfirmThreadArchive: boolean;
  renamingThreadId: ThreadId | null;
  renamingTitle: string;
  setRenamingTitle: (title: string) => void;
  renamingInputRef: MutableRefObject<HTMLInputElement | null>;
  renamingCommittedRef: MutableRefObject<boolean>;
  confirmingArchiveThreadId: ThreadId | null;
  setConfirmingArchiveThreadId: Dispatch<SetStateAction<ThreadId | null>>;
  confirmArchiveButtonRefs: MutableRefObject<Map<ThreadId, HTMLButtonElement>>;
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
  pr: ThreadPr | null;
}

export const SidebarThreadRow = memo(function SidebarThreadRow(props: SidebarThreadRowProps) {
  const [dotHovered, setDotHovered] = useState(false);
  const thread = useSidebarThreadSummaryById(props.threadId);
  const lastVisitedAt = useUiStateStore((state) => state.threadLastVisitedAtById[props.threadId]);
  const runningTerminalIds = useTerminalStateStore(
    (state) =>
      selectThreadTerminalState(state.terminalStateByThreadId, props.threadId).runningTerminalIds,
  );
  const isOfficeHovered = useOfficeHoverStore((s) => s.hoveredThreadId === props.threadId);

  if (!thread) {
    return null;
  }

  const isActive = props.routeThreadId === thread.id;
  const isSelected = props.selectedThreadIds.has(thread.id);
  const isHighlighted = isActive || isSelected;
  const isThreadRunning =
    thread.session?.status === "running" && thread.session.activeTurnId != null;
  const threadStatus = resolveThreadStatusPill({
    thread: {
      ...thread,
      lastVisitedAt,
    },
  });
  const prStatus = prStatusIndicator(props.pr);
  const terminalStatus = terminalStatusFromRunningIds(runningTerminalIds);
  const isConfirmingArchive = props.confirmingArchiveThreadId === thread.id && !isThreadRunning;
  const threadMetaClassName = isConfirmingArchive
    ? "pointer-events-none opacity-0"
    : !isThreadRunning
      ? "pointer-events-none transition-opacity duration-150 group-hover/menu-sub-item:opacity-0 group-focus-within/menu-sub-item:opacity-0"
      : "pointer-events-none";

  return (
    <SidebarMenuSubItem
      className="w-full"
      data-thread-item
      onMouseLeave={() => {
        props.setConfirmingArchiveThreadId((current) => (current === thread.id ? null : current));
      }}
      onBlurCapture={(event) => {
        const currentTarget = event.currentTarget;
        requestAnimationFrame(() => {
          if (currentTarget.contains(document.activeElement)) {
            return;
          }
          props.setConfirmingArchiveThreadId((current) => (current === thread.id ? null : current));
        });
      }}
    >
      <SidebarMenuSubButton
        render={<div role="button" tabIndex={0} />}
        size="sm"
        isActive={isActive}
        data-testid={`thread-row-${thread.id}`}
        className={`${resolveThreadRowClassName({
          isActive,
          isSelected,
        })} relative isolate ${isOfficeHovered ? "ring-1 ring-inset ring-primary/40 bg-accent" : ""}`}
        onClick={(event) => {
          props.handleThreadClick(event, thread.id, props.orderedProjectThreadIds);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          props.navigateToThread(thread.id);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          if (props.selectedThreadIds.size > 0 && props.selectedThreadIds.has(thread.id)) {
            void props.handleMultiSelectContextMenu({
              x: event.clientX,
              y: event.clientY,
            });
          } else {
            if (props.selectedThreadIds.size > 0) {
              props.clearSelection();
            }
            void props.handleThreadContextMenu(thread.id, {
              x: event.clientX,
              y: event.clientY,
            });
          }
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
                  className={`absolute size-3 animate-ping rounded-full ${threadStatus.dotClass} opacity-40`}
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
                    <GitPullRequestIcon className="size-3" />
                  </button>
                }
              />
              <TooltipPopup side="top">{prStatus.tooltip}</TooltipPopup>
            </Tooltip>
          )}
          {props.renamingThreadId === thread.id ? (
            <input
              ref={(element) => {
                if (element && props.renamingInputRef.current !== element) {
                  props.renamingInputRef.current = element;
                  element.focus();
                  element.select();
                }
              }}
              className="min-w-0 flex-1 truncate text-xs bg-transparent outline-none border border-ring rounded px-0.5"
              value={props.renamingTitle}
              onChange={(event) => props.setRenamingTitle(event.target.value)}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Enter") {
                  event.preventDefault();
                  props.renamingCommittedRef.current = true;
                  void props.commitRename(thread.id, props.renamingTitle, thread.title);
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  props.renamingCommittedRef.current = true;
                  props.cancelRename();
                }
              }}
              onBlur={() => {
                if (!props.renamingCommittedRef.current) {
                  void props.commitRename(thread.id, props.renamingTitle, thread.title);
                }
              }}
              onClick={(event) => event.stopPropagation()}
            />
          ) : (
            <span className="relative min-w-0 flex-1 overflow-hidden">
              <span
                className={`block truncate text-xs transition-all duration-200 ${dotHovered ? "opacity-0 -translate-y-2" : "opacity-100 translate-y-0"}`}
              >
                {thread.title}
              </span>
              <span
                className={`absolute inset-0 flex items-center truncate text-xs transition-all duration-200 ${dotHovered ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2"} ${threadStatus ? threadStatus.colorClass : "text-muted-foreground/50"}`}
              >
                {threadStatus ? threadStatus.label : "Idle"}
              </span>
            </span>
          )}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {terminalStatus && (
            <span
              role="img"
              aria-label={terminalStatus.label}
              title={terminalStatus.label}
              className={`inline-flex items-center justify-center ${terminalStatus.colorClass}`}
            >
              <TerminalIcon className={`size-3 ${terminalStatus.pulse ? "animate-pulse" : ""}`} />
            </span>
          )}
          <div className="flex min-w-12 justify-end">
            {isConfirmingArchive ? (
              <button
                ref={(element) => {
                  if (element) {
                    props.confirmArchiveButtonRefs.current.set(thread.id, element);
                  } else {
                    props.confirmArchiveButtonRefs.current.delete(thread.id);
                  }
                }}
                type="button"
                data-thread-selection-safe
                data-testid={`thread-archive-confirm-${thread.id}`}
                aria-label={`Confirm archive ${thread.title}`}
                className="absolute top-1/2 right-2 inline-flex h-5 -translate-y-1/2 cursor-pointer items-center rounded-full bg-destructive/12 px-2 text-[10px] font-medium text-destructive transition-colors hover:bg-destructive/18 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-destructive/40"
                onPointerDown={(event) => {
                  event.stopPropagation();
                }}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  props.setConfirmingArchiveThreadId((current) =>
                    current === thread.id ? null : current,
                  );
                  void props.attemptArchiveThread(thread.id);
                }}
              >
                Confirm
              </button>
            ) : !isThreadRunning ? (
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
                  {formatRelativeTime(thread.updatedAt ?? thread.createdAt).value}
                </span>
              )}
            </span>
          </div>
        </div>
      </SidebarMenuSubButton>
    </SidebarMenuSubItem>
  );
});
