import { type EditorId, type ResolvedKeybindingsConfig, type ThreadId } from "@piedpiper/contracts";
import { Suspense, lazy, memo } from "react";
import { isElectron } from "../../env";
import { advisorAvatarSrc } from "../../lib/advisorIdentity";
const GitActionsControl = lazy(() => import("../GitActionsControl"));
import {
  ArrowLeftIcon,
  DiffIcon,
  FolderIcon,
  HistoryIcon,
  SquarePenIcon,
  TerminalSquareIcon,
} from "lucide-react";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Toggle } from "../ui/toggle";
import { SidebarTrigger, useSidebar } from "../ui/sidebar";
import { OpenInPicker } from "./OpenInPicker";

export interface ChatHeaderAdvisorContext {
  readonly id: string;
  readonly displayName: string;
  readonly shortName: string;
}

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
  /**
   * When set, the chat is an advisor chat: the header renders only the
   * advisor's avatar + display name on the left and skips the git badge,
   * git button, open-in picker, terminal toggle, and diff toggle entirely.
   * It also exposes the new-chat + history buttons in the top-right.
   */
  advisor?: ChatHeaderAdvisorContext | null;
  /** Starts a new chat with the same advisor (advisor branch only). */
  onNewAdvisorChat?: () => void;
  /** Opens the advisor history right overlay (advisor branch only). */
  onOpenAdvisorHistory?: () => void;
  /** Navigate back to the /advisors page (advisor branch only). */
  onBackToAdvisors?: () => void;
  /** Advisor skill role label (e.g. "Office Hours"). */
  advisorRole?: string | null;
  /** Project name for advisor context badge. */
  advisorProjectName?: string | null;
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
  advisor,
  onNewAdvisorChat,
  onOpenAdvisorHistory,
  onBackToAdvisors,
  advisorRole,
  advisorProjectName,
}: ChatHeaderProps) {
  const { state } = useSidebar();
  const collapsedInElectron = isElectron && state === "collapsed";

  if (advisor) {
    return (
      <div
        className="flex min-w-0 flex-1 items-center gap-2"
        style={collapsedInElectron ? { paddingLeft: 128 } : undefined}
      >
        <SidebarTrigger className="size-7 shrink-0 md:hidden" />
        {onBackToAdvisors && (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label="Back to advisors"
                  onClick={onBackToAdvisors}
                  className="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                />
              }
            >
              <ArrowLeftIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="bottom">Advisors</TooltipPopup>
          </Tooltip>
        )}
        <img
          src={advisorAvatarSrc(advisor.id)}
          alt=""
          draggable={false}
          className="size-7 shrink-0 object-contain"
        />
        <h2
          className="min-w-0 flex-1 shrink truncate text-sm font-medium text-foreground"
          title={advisor.displayName}
        >
          {advisor.shortName}
          {advisorRole && (
            <span className="text-muted-foreground/60">
              <span className="mx-1.5 text-muted-foreground/30">&middot;</span>
              {advisorRole}
            </span>
          )}
          {advisorProjectName && (
            <span className="text-muted-foreground/60">
              <span className="mx-1.5 text-muted-foreground/30">&middot;</span>
              <FolderIcon className="mb-px inline size-3" /> {advisorProjectName}
            </span>
          )}
        </h2>
        <div className="flex shrink-0 items-center gap-1">
          {onNewAdvisorChat && (
            <button
              type="button"
              aria-label={`New chat with ${advisor.displayName}`}
              onClick={onNewAdvisorChat}
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-full bg-white px-4 py-1.5 text-sm font-medium text-black transition-all hover:bg-white/90"
            >
              <SquarePenIcon className="size-3" />
              New Chat
            </button>
          )}
          {onOpenAdvisorHistory && (
            <button
              type="button"
              aria-label={`Show past sessions with ${advisor.displayName}`}
              onClick={onOpenAdvisorHistory}
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-border px-4 py-1.5 text-sm font-medium text-foreground/80 transition-all hover:bg-accent hover:text-foreground"
            >
              <HistoryIcon className="size-3" />
              {advisorRole ? "Past Sessions" : "History"}
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      className="@container/header-actions flex min-w-0 flex-1 items-center gap-2"
      style={collapsedInElectron ? { paddingLeft: 128 } : undefined}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden sm:gap-3">
        <SidebarTrigger className="size-7 shrink-0 md:hidden" />
        <h2
          className="min-w-0 shrink truncate text-sm font-medium text-foreground"
          title={activeThreadTitle}
        >
          {activeThreadTitle}
        </h2>
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
                disabled={!isGitRepo}
              >
                <DiffIcon className="size-3" />
              </Toggle>
            }
          />
          <TooltipPopup side="bottom">
            {!isGitRepo
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
