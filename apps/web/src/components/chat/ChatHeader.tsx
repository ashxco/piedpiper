import { type EditorId, type ResolvedKeybindingsConfig, type ThreadId } from "@piedpiper/contracts";
import {
  Suspense,
  lazy,
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { isElectron } from "../../env";
import { newCommandId } from "../../lib/utils";
import { readNativeApi } from "../../nativeApi";
import { useStore } from "../../store";
import { toastManager } from "../ui/toast";
import { useThreadActionMenu } from "../../hooks/useThreadActionMenu";
const GitActionsControl = lazy(() => import("../GitActionsControl"));
import { ChevronDownIcon, DiffIcon, TerminalSquareIcon } from "lucide-react";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Toggle } from "../ui/toggle";
import { SidebarTrigger, useSidebar } from "../ui/sidebar";
import { useElectronHeaderInsetPx } from "../../hooks/useElectronHeaderInset";
import { isImeComposingKeyboardEvent } from "~/lib/imeComposition";
import { textDirection } from "~/markdown-text-direction";
import { OpenInPicker } from "./OpenInPicker";

interface ChatHeaderProps {
  activeThreadId: ThreadId;
  activeThreadTitle: string;
  activeProjectName: string | undefined;
  isGitRepo: boolean;
  openInCwd: string | null;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  terminalAvailable: boolean;
  terminalOpen: boolean;
  terminalToggleShortcutLabel: string | null;
  diffToggleShortcutLabel: string | null;
  gitCwd: string | null;
  diffOpen: boolean;
  onToggleTerminal: () => void;
  onToggleDiff: () => void;
  /** Local draft threads have no server thread to rename yet. */
  canRename?: boolean;
}

export type HeaderRenameCommit =
  | { readonly kind: "empty" }
  | { readonly kind: "unchanged" }
  | { readonly kind: "rename"; readonly title: string };

export function resolveHeaderRenameCommit(
  draft: string,
  originalTitle: string,
): HeaderRenameCommit {
  const trimmed = draft.trim();
  if (trimmed.length === 0) return { kind: "empty" };
  if (trimmed === originalTitle) return { kind: "unchanged" };
  return { kind: "rename", title: trimmed };
}

async function renameThreadFromHeader(threadId: ThreadId, draft: string, originalTitle: string) {
  const commit = resolveHeaderRenameCommit(draft, originalTitle);
  if (commit.kind === "empty") {
    toastManager.add({ type: "warning", title: "Thread title cannot be empty" });
    return;
  }
  if (commit.kind === "unchanged") return;
  const api = readNativeApi();
  if (!api) return;
  try {
    await api.orchestration.dispatchCommand({
      type: "thread.meta.update",
      commandId: newCommandId(),
      threadId,
      title: commit.title,
    });
    useStore.getState().markThreadUserRenamed(threadId, commit.title);
  } catch (error) {
    toastManager.add({
      type: "error",
      title: "Failed to rename thread",
      description: error instanceof Error ? error.message : "An error occurred.",
    });
  }
}

function ChatHeaderTitle({
  title,
  canRename,
  draft,
  onDraftChange,
  onFinishRename,
  onTitleClick,
  onTitleDoubleClick,
  onTitleBlur,
}: {
  title: string;
  canRename: boolean;
  draft: string | null;
  onDraftChange: (draft: string) => void;
  onFinishRename: (commit: boolean) => void;
  onTitleClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  onTitleDoubleClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  onTitleBlur: () => void;
}) {
  if (draft !== null) {
    return (
      <input
        ref={(element) => {
          if (element && document.activeElement !== element) {
            element.focus();
            element.select();
          }
        }}
        aria-label="Thread title"
        className="min-w-0 flex-1 truncate rounded border border-ring bg-transparent px-0.5 text-sm font-medium text-foreground outline-none"
        value={draft}
        onChange={(event) => onDraftChange(event.target.value)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (isImeComposingKeyboardEvent(event.nativeEvent)) return;
          if (event.key === "Enter") {
            event.preventDefault();
            onFinishRename(true);
          } else if (event.key === "Escape") {
            event.preventDefault();
            onFinishRename(false);
          }
        }}
        onBlur={() => onFinishRename(true)}
      />
    );
  }

  if (!canRename) {
    return (
      <h2
        dir={textDirection(title) ?? "auto"}
        className="min-w-0 shrink truncate text-sm font-medium text-foreground"
        title={title}
      >
        {title}
      </h2>
    );
  }

  // Sized to its content (no flex-1) so the rest of the header stays a window drag area.
  return (
    <button
      type="button"
      title={title}
      aria-label={`Thread actions for ${title}`}
      aria-haspopup="menu"
      className="group/thread-title inline-flex min-w-0 shrink cursor-pointer items-center gap-1 rounded-sm text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
      onClick={onTitleClick}
      onDoubleClick={onTitleDoubleClick}
      onBlur={onTitleBlur}
    >
      <h2
        dir={textDirection(title) ?? "auto"}
        className="min-w-0 truncate text-sm font-medium text-foreground"
      >
        {title}
      </h2>
      <ChevronDownIcon
        aria-hidden
        data-thread-title-chevron
        className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/thread-title:opacity-100 group-focus-visible/thread-title:opacity-100"
      />
    </button>
  );
}

// A click on the title waits this long so a double-click (rename) can cancel the menu. The
// native desktop menu swallows input while open, so it must cover the OS double-click interval.
const TITLE_MENU_OPEN_DELAY_MS = isElectron ? 500 : 250;
const TITLE_CHEVRON_SELECTOR = "[data-thread-title-chevron]";

export type TitleClickAction = "ignore" | "open-now" | "open-delayed";

/**
 * What a click on the header title does: the trailing click of a double-click belongs to
 * rename, while keyboard activation (detail 0) and the chevron open the menu straight away.
 */
export function resolveTitleClickAction(input: {
  readonly detail: number;
  readonly onChevron: boolean;
}): TitleClickAction {
  if (input.detail > 1) return "ignore";
  if (input.detail === 0 || input.onChevron) return "open-now";
  return "open-delayed";
}

/** Keep the toggle usable while the panel is open so a non-git project can still close it. */
export function isDiffToggleDisabled(isGitRepo: boolean, diffOpen: boolean): boolean {
  return !isGitRepo && !diffOpen;
}

export const ChatHeader = memo(function ChatHeader({
  activeThreadId,
  activeThreadTitle,
  activeProjectName,
  isGitRepo,
  openInCwd,
  keybindings,
  availableEditors,
  terminalAvailable,
  terminalOpen,
  terminalToggleShortcutLabel,
  diffToggleShortcutLabel,
  gitCwd,
  diffOpen,
  onToggleTerminal,
  onToggleDiff,
  canRename = true,
}: ChatHeaderProps) {
  const { isMobile } = useSidebar();
  const headerInsetPx = useElectronHeaderInsetPx();
  // Tagged with the thread so switching threads drops an in-progress rename.
  // originalTitle is the title when the rename started, so a title that changes meanwhile is kept.
  const [renaming, setRenaming] = useState<{
    threadId: ThreadId;
    draft: string;
    originalTitle: string;
  } | null>(null);
  // The input unmounts without a reliable blur, so drop the stale rename instead of keeping it.
  if (renaming !== null && renaming.threadId !== activeThreadId) setRenaming(null);
  const renameDraft = renaming?.threadId === activeThreadId ? renaming.draft : null;
  const renameSettledRef = useRef(false);
  const startRename = useCallback((threadId: ThreadId, title: string) => {
    renameSettledRef.current = false;
    setRenaming({ threadId, draft: title, originalTitle: title });
  }, []);
  const finishRename = (commit: boolean) => {
    // Enter/Escape unmount the input, which can also fire blur.
    if (renameSettledRef.current || renameDraft === null || renaming === null) return;
    renameSettledRef.current = true;
    setRenaming(null);
    if (commit) void renameThreadFromHeader(activeThreadId, renameDraft, renaming.originalTitle);
  };
  const { openThreadActionMenu } = useThreadActionMenu({
    onStartRename: startRename,
    canFindInThread: true,
  });
  const titleMenuTimerRef = useRef<number | null>(null);
  const cancelPendingTitleMenu = () => {
    if (titleMenuTimerRef.current === null) return;
    window.clearTimeout(titleMenuTimerRef.current);
    titleMenuTimerRef.current = null;
  };
  // A pending menu must never open for a thread the user already left.
  useEffect(
    () => () => {
      if (titleMenuTimerRef.current === null) return;
      window.clearTimeout(titleMenuTimerRef.current);
      titleMenuTimerRef.current = null;
    },
    [activeThreadId],
  );
  const openMenu = (position: { x: number; y: number }) => {
    cancelPendingTitleMenu();
    void openThreadActionMenu(activeThreadId, position);
  };
  const onTitleClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
    const button = event.currentTarget;
    const action = resolveTitleClickAction({
      detail: event.detail,
      onChevron: (event.target as Element).closest(TITLE_CHEVRON_SELECTOR) !== null,
    });
    if (action === "ignore") return;
    const openBelowTitle = () => {
      const rect = button.getBoundingClientRect();
      openMenu({ x: rect.left, y: rect.bottom + 4 });
    };
    if (action === "open-now") {
      openBelowTitle();
      return;
    }
    cancelPendingTitleMenu();
    titleMenuTimerRef.current = window.setTimeout(() => {
      titleMenuTimerRef.current = null;
      openBelowTitle();
    }, TITLE_MENU_OPEN_DELAY_MS);
  };
  const onTitleDoubleClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    // The chevron is the explicit menu affordance; only the title text renames.
    if ((event.target as Element).closest(TITLE_CHEVRON_SELECTOR) !== null) return;
    cancelPendingTitleMenu();
    startRename(activeThreadId, activeThreadTitle);
  };

  return (
    <div
      className="@container/header-actions flex min-w-0 flex-1 items-center gap-2"
      style={headerInsetPx !== undefined ? { paddingLeft: headerInsetPx } : undefined}
    >
      <div
        className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden sm:gap-3"
        onContextMenu={(event) => {
          if (!canRename || renameDraft !== null) return;
          event.preventDefault();
          openMenu({ x: event.clientX, y: event.clientY });
        }}
      >
        {/* Electron always renders the fixed AppSidebarLayout toggle; only the web sheet needs one. */}
        {!isElectron && isMobile ? <SidebarTrigger className="size-7 shrink-0" /> : null}
        <ChatHeaderTitle
          title={activeThreadTitle}
          canRename={canRename}
          draft={renameDraft}
          onDraftChange={(draft) =>
            setRenaming((current) => (current === null ? current : { ...current, draft }))
          }
          onFinishRename={finishRename}
          onTitleClick={onTitleClick}
          onTitleDoubleClick={onTitleDoubleClick}
          onTitleBlur={cancelPendingTitleMenu}
        />
        {!isGitRepo && activeProjectName && (
          <Badge variant="outline" className="shrink-0 text-[10px] text-amber-700">
            No Git
          </Badge>
        )}
      </div>
      <div className="flex shrink-0 items-center justify-end gap-2 @3xl/header-actions:gap-3">
        {activeProjectName && (
          <Suspense fallback={null}>
            <GitActionsControl gitCwd={gitCwd} activeThreadId={activeThreadId} />
          </Suspense>
        )}
        {activeProjectName && (
          <OpenInPicker
            keybindings={keybindings}
            availableEditors={availableEditors}
            openInCwd={openInCwd}
          />
        )}
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                className="shrink-0"
                pressed={terminalOpen}
                onPressedChange={onToggleTerminal}
                aria-label="Toggle terminal drawer"
                variant="outline"
                size="xs"
                disabled={!terminalAvailable}
              >
                <TerminalSquareIcon className="size-3" />
              </Toggle>
            }
          />
          <TooltipPopup side="bottom">
            {!terminalAvailable
              ? "Terminal is unavailable until this thread has an active project."
              : terminalToggleShortcutLabel
                ? `Toggle terminal drawer (${terminalToggleShortcutLabel})`
                : "Toggle terminal drawer"}
          </TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                className="shrink-0"
                pressed={diffOpen}
                onPressedChange={onToggleDiff}
                aria-label="Toggle diff panel"
                variant="outline"
                size="xs"
                disabled={isDiffToggleDisabled(isGitRepo, diffOpen)}
              >
                <DiffIcon className="size-3" />
              </Toggle>
            }
          />
          <TooltipPopup side="bottom">
            {isDiffToggleDisabled(isGitRepo, diffOpen)
              ? "Diff panel is unavailable because this project is not a git repository."
              : diffToggleShortcutLabel
                ? `Toggle diff panel (${diffToggleShortcutLabel})`
                : "Toggle diff panel"}
          </TooltipPopup>
        </Tooltip>
      </div>
    </div>
  );
});
