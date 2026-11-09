import type { NativeApi, ThreadId } from "@piedpiper/contracts";
import { useCallback } from "react";

import { canRestartThreadSession } from "../components/CommandPalette.logic";
import {
  isThreadArchiveBlocked,
  resolveNewThreadOnBranchOptions,
} from "../components/Sidebar.logic";
import {
  buildThreadSnoozeMenuItems,
  canSnoozeThread,
  resolveSnoozePresets,
} from "../components/Sidebar.snooze";
import {
  applyThreadSnoozeMenuPick,
  isThreadSnoozedNow,
} from "../components/sidebar/threadSnoozeActions";
import {
  buildThreadActionMenuItems,
  resolveThreadWorkspacePath,
} from "../components/threadActionMenu.logic";
import { openThreadFind } from "../components/chat/threadFindStore";
import { toastManager } from "../components/ui/toast";
import { copyWorkspacePath } from "../filePathClipboard";
import { newCommandId } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import { useStore } from "../store";
import { restartThreadSession } from "../threadSessionRestart";
import {
  isThreadTitleRegenerating,
  runThreadTitleRegeneration,
} from "../threadTitleRegenerationStore";
import { useUiStateStore } from "../uiStateStore";
import { useCopyToClipboard } from "./useCopyToClipboard";
import { useHandleNewThread } from "./useHandleNewThread";
import { useThreadActions } from "./useThreadActions";

/** Callers fire the menu with `void`, so a failed delete must surface here as a toast. */
export async function deleteThreadFromActionMenu(
  threadId: ThreadId,
  confirmAndDeleteThread: (threadId: ThreadId) => Promise<unknown>,
  notifyError: (description: string) => void = (description) =>
    toastManager.add({ type: "error", title: "Failed to delete thread", description }),
): Promise<void> {
  try {
    await confirmAndDeleteThread(threadId);
  } catch (error) {
    notifyError(error instanceof Error ? error.message : "An error occurred.");
  }
}

export async function regenerateThreadTitleFromActionMenu(
  threadId: ThreadId,
  dispatchCommand: NativeApi["orchestration"]["dispatchCommand"],
): Promise<void> {
  // Otherwise an earlier manual rename would drop the regenerated title in the store.
  useStore.getState().clearThreadUserRenamed(threadId);
  await runThreadTitleRegeneration(threadId, () =>
    dispatchCommand({
      type: "thread.title.regenerate",
      commandId: newCommandId(),
      threadId,
      createdAt: new Date().toISOString(),
    }),
  );
}

/**
 * Shows the thread actions menu (sidebar row or chat header title) and runs the chosen action.
 * Rename is handed back through `onStartRename` because each surface edits the title inline.
 */
export function useThreadActionMenu(options: {
  readonly onStartRename: (threadId: ThreadId, title: string) => void;
  /** Touch devices have no mod+f, so the chat header also offers find here. */
  readonly canFindInThread?: boolean;
}) {
  const { onStartRename, canFindInThread = false } = options;
  const { handleNewThread } = useHandleNewThread();
  const { attemptArchiveThread, confirmAndDeleteThread } = useThreadActions();
  const { copyToClipboard: copyThreadIdToClipboard } = useCopyToClipboard<{
    threadId: ThreadId;
  }>({
    onCopy: (ctx) => {
      toastManager.add({ type: "success", title: "Thread ID copied", description: ctx.threadId });
    },
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: "Failed to copy thread ID",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    },
  });
  const { copyToClipboard: copyPathToClipboard } = useCopyToClipboard<{ path: string }>({
    onCopy: (ctx) => {
      toastManager.add({ type: "success", title: "Path copied", description: ctx.path });
    },
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: "Failed to copy path",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    },
  });

  const { copyToClipboard: copyBranchToClipboard } = useCopyToClipboard<{ branch: string }>({
    onCopy: (ctx) => {
      toastManager.add({ type: "success", title: "Branch copied", description: ctx.branch });
    },
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: "Failed to copy branch",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    },
  });

  const openThreadActionMenu = useCallback(
    async (threadId: ThreadId, position: { x: number; y: number }) => {
      const api = readNativeApi();
      if (!api) return;
      const storeState = useStore.getState();
      const thread = storeState.sidebarThreadsById[threadId];
      if (!thread) return;
      const uiState = useUiStateStore.getState();
      const snoozePresets = resolveSnoozePresets(new Date());
      const clicked = await api.contextMenu.show(
        buildThreadActionMenuItems({
          branch: thread.branch,
          pinned: uiState.pinnedThreadIds.includes(threadId),
          canRestartSession: canRestartThreadSession(thread),
          regeneratingTitle: isThreadTitleRegenerating(threadId),
          snoozeItems: buildThreadSnoozeMenuItems({
            presets: snoozePresets,
            snoozed: isThreadSnoozedNow(threadId),
            canSnooze: canSnoozeThread(thread),
          }),
          archiveBlocked: isThreadArchiveBlocked(thread) || thread.archivedAt !== null,
          canFindInThread,
        }),
        position,
      );
      if (applyThreadSnoozeMenuPick(threadId, clicked, snoozePresets)) return;
      switch (clicked) {
        case "new-thread-on-branch":
          void handleNewThread(thread.projectId, resolveNewThreadOnBranchOptions(thread));
          return;
        case "find-in-thread":
          openThreadFind(threadId);
          return;
        case "rename":
          onStartRename(threadId, thread.title);
          return;
        case "regenerate-title":
          await regenerateThreadTitleFromActionMenu(threadId, api.orchestration.dispatchCommand);
          return;
        case "restart-session":
          await restartThreadSession(threadId);
          return;
        case "pin":
        case "unpin":
          useUiStateStore.getState().setThreadPinned(threadId, clicked === "pin");
          return;
        case "mark-unread":
          useUiStateStore.getState().markThreadUnread(threadId, thread.latestTurn?.completedAt);
          return;
        case "copy-path": {
          const projectCwd = useStore
            .getState()
            .projects.find((project) => project.id === thread.projectId)?.cwd;
          const workspacePath = resolveThreadWorkspacePath(thread, projectCwd);
          if (!workspacePath) {
            toastManager.add({
              type: "error",
              title: "Path unavailable",
              description: "This thread does not have a workspace path to copy.",
            });
            return;
          }
          copyWorkspacePath(workspacePath, copyPathToClipboard);
          return;
        }
        case "copy-branch":
          if (thread.branch) copyBranchToClipboard(thread.branch, { branch: thread.branch });
          return;
        case "copy-thread-id":
          copyThreadIdToClipboard(threadId, { threadId });
          return;
        case "archive":
          // Confirmation, the error toast and undo live in attemptArchiveThread.
          await attemptArchiveThread(threadId);
          return;
        case "delete":
          // Confirmation, re-entry guard and navigating away live in confirmAndDeleteThread.
          await deleteThreadFromActionMenu(threadId, confirmAndDeleteThread);
          return;
        default:
          return;
      }
    },
    [
      attemptArchiveThread,
      confirmAndDeleteThread,
      copyBranchToClipboard,
      copyPathToClipboard,
      canFindInThread,
      copyThreadIdToClipboard,
      handleNewThread,
      onStartRename,
    ],
  );

  return { openThreadActionMenu };
}
