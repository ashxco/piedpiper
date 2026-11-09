import type { ThreadId } from "@piedpiper/contracts";
import { FolderIcon, GitForkIcon } from "lucide-react";
import { type Ref, useCallback, useImperativeHandle, useRef, useState } from "react";

import { shortcutLabelForCommand } from "../keybindings";
import { newCommandId } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import { useComposerDraftStore } from "../composerDraftStore";
import { useServerKeybindings } from "../rpc/serverState";
import { useStore } from "../store";
import { useProjectById, useThreadById } from "../storeSelectors";
import {
  EnvMode,
  resolveDraftEnvModeAfterBranchChange,
  resolveEffectiveEnvMode,
} from "./BranchToolbar.logic";
import {
  BranchToolbarBranchSelector,
  type BranchToolbarBranchSelectorHandle,
} from "./BranchToolbarBranchSelector";
import { useComposerMultiModelStore } from "./chat/composerMultiModelStore";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";

const envModeItems = [
  { value: "local", label: "Local" },
  { value: "worktree", label: "New worktree" },
] as const;

export type BranchToolbarControl = "workspace" | "branch";

export interface BranchToolbarHandle {
  /** Opens the workspace (local/worktree) select or the branch menu; false when that control is not shown or is disabled. */
  openControl: (control: BranchToolbarControl) => boolean;
}

interface BranchToolbarProps {
  ref?: Ref<BranchToolbarHandle>;
  threadId: ThreadId;
  onEnvModeChange: (mode: EnvMode) => void;
  envLocked: boolean;
  onCheckoutPullRequestRequest?: (reference: string) => void;
  onComposerFocusRequest?: () => void;
}

export default function BranchToolbar({
  ref,
  threadId,
  onEnvModeChange,
  envLocked,
  onCheckoutPullRequestRequest,
  onComposerFocusRequest,
}: BranchToolbarProps) {
  const serverThread = useThreadById(threadId);
  const setThreadBranchAction = useStore((store) => store.setThreadBranch);
  const draftThread = useComposerDraftStore((store) => store.getDraftThread(threadId));
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);

  const activeProjectId = serverThread?.projectId ?? draftThread?.projectId ?? null;
  const activeProject = useProjectById(activeProjectId);
  const activeThreadId = serverThread?.id ?? (draftThread ? threadId : undefined);
  const activeThreadBranch = serverThread?.branch ?? draftThread?.branch ?? null;
  const activeWorktreePath = serverThread?.worktreePath ?? draftThread?.worktreePath ?? null;
  const branchCwd = activeWorktreePath ?? activeProject?.cwd ?? null;
  const hasServerThread = serverThread !== undefined;
  const effectiveEnvMode = resolveEffectiveEnvMode({
    activeWorktreePath,
    hasServerThread,
    draftThreadEnvMode: draftThread?.envMode,
  });

  const keybindings = useServerKeybindings();
  const workspaceShortcutLabel = shortcutLabelForCommand(keybindings, "composer.workspace");
  const branchShortcutLabel = shortcutLabelForCommand(keybindings, "composer.branch");
  const branchSelectorRef = useRef<BranchToolbarBranchSelectorHandle>(null);
  const [isEnvModeSelectOpen, setIsEnvModeSelectOpen] = useState(false);
  const isRendered = Boolean(activeThreadId && activeProject);
  // A started thread is never moved to a new worktree.
  const hasMultiModelSelection = useComposerMultiModelStore(
    (state) => state.selectionsByThreadId[threadId] !== undefined,
  );
  const forceNewWorktree = hasMultiModelSelection && !hasServerThread;
  // Picking a base branch must not run a real checkout in an existing worktree.
  const selectorWorktreePath = forceNewWorktree ? null : activeWorktreePath;
  const isEnvModeSelectShown = isRendered && !envLocked && !activeWorktreePath && !forceNewWorktree;

  useImperativeHandle(ref, () => ({
    openControl: (control) => {
      if (control === "workspace") {
        if (!isEnvModeSelectShown) return false;
        setIsEnvModeSelectOpen(true);
        return true;
      }
      return isRendered ? (branchSelectorRef.current?.open() ?? false) : false;
    },
  }));

  const setThreadBranch = useCallback(
    (branch: string | null, worktreePath: string | null) => {
      if (!activeThreadId) return;
      const api = readNativeApi();
      // If the effective cwd is about to change, stop the running session so the
      // next message creates a new one with the correct cwd. A worktree switch from the toolbar
      // ends Claude background work on purpose (it bypasses the server's live-task restart guard).
      if (serverThread?.session && worktreePath !== activeWorktreePath && api) {
        void api.orchestration
          .dispatchCommand({
            type: "thread.session.stop",
            commandId: newCommandId(),
            threadId: activeThreadId,
            // A worktree switch is not a user Stop, so an armed resume stays.
            keepUsageLimitResume: true,
            createdAt: new Date().toISOString(),
          })
          .catch(() => undefined);
      }
      if (api && hasServerThread) {
        void api.orchestration.dispatchCommand({
          type: "thread.meta.update",
          commandId: newCommandId(),
          threadId: activeThreadId,
          branch,
          worktreePath,
        });
      }
      if (hasServerThread) {
        setThreadBranchAction(activeThreadId, branch, worktreePath);
        return;
      }
      const nextDraftEnvMode = resolveDraftEnvModeAfterBranchChange({
        nextWorktreePath: worktreePath,
        currentWorktreePath: activeWorktreePath,
        effectiveEnvMode,
      });
      setDraftThreadContext(threadId, {
        branch,
        worktreePath,
        envMode: nextDraftEnvMode,
      });
    },
    [
      activeThreadId,
      serverThread?.session,
      activeWorktreePath,
      hasServerThread,
      setThreadBranchAction,
      setDraftThreadContext,
      threadId,
      effectiveEnvMode,
    ],
  );

  if (!activeThreadId || !activeProject) return null;

  return (
    <div className="mx-auto flex w-full max-w-(--chat-max-width) items-center justify-between px-5 pb-5 pt-1">
      {!isEnvModeSelectShown ? (
        <span className="inline-flex items-center gap-1 border border-transparent px-[calc(--spacing(3)-1px)] text-sm font-medium text-muted-foreground/70 sm:text-xs">
          {forceNewWorktree ? (
            <>
              <GitForkIcon className="size-3" />
              New worktree
            </>
          ) : activeWorktreePath ? (
            <>
              <GitForkIcon className="size-3" />
              Worktree
            </>
          ) : (
            <>
              <FolderIcon className="size-3" />
              Local
            </>
          )}
        </span>
      ) : (
        <Select
          value={effectiveEnvMode}
          onValueChange={(value) => onEnvModeChange(value as EnvMode)}
          items={envModeItems}
          open={isEnvModeSelectOpen}
          onOpenChange={setIsEnvModeSelectOpen}
        >
          <SelectTrigger
            variant="ghost"
            size="xs"
            className="font-medium"
            title={
              workspaceShortcutLabel ? `Change workspace (${workspaceShortcutLabel})` : undefined
            }
          >
            {effectiveEnvMode === "worktree" ? (
              <GitForkIcon className="size-3" />
            ) : (
              <FolderIcon className="size-3" />
            )}
            <SelectValue />
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            <SelectItem value="local">
              <span className="inline-flex items-center gap-1.5">
                <FolderIcon className="size-3" />
                Local
              </span>
            </SelectItem>
            <SelectItem value="worktree">
              <span className="inline-flex items-center gap-1.5">
                <GitForkIcon className="size-3" />
                New worktree
              </span>
            </SelectItem>
          </SelectPopup>
        </Select>
      )}

      <BranchToolbarBranchSelector
        ref={branchSelectorRef}
        shortcutLabel={branchShortcutLabel}
        activeProjectCwd={activeProject.cwd}
        activeThreadBranch={activeThreadBranch}
        activeWorktreePath={selectorWorktreePath}
        branchCwd={forceNewWorktree ? activeProject.cwd : branchCwd}
        effectiveEnvMode={forceNewWorktree ? "worktree" : effectiveEnvMode}
        envLocked={envLocked}
        onSetThreadBranch={setThreadBranch}
        {...(onCheckoutPullRequestRequest ? { onCheckoutPullRequestRequest } : {})}
        {...(onComposerFocusRequest ? { onComposerFocusRequest } : {})}
      />
    </div>
  );
}
