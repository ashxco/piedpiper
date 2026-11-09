import type { ThreadId } from "@piedpiper/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { GitBranchIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { useComposerDraftStore } from "../composerDraftStore";
import { gitStatusQueryOptions, invalidateGitAfterMutation } from "../lib/gitReactQuery";
import { readNativeApi } from "../nativeApi";
import { useStore } from "../store";
import { useProjectById } from "../storeSelectors";
import {
  branchMismatchKey,
  dismissBranchMismatchForSession,
  isBranchMismatchDismissedForSession,
  resolveLocalCheckoutBranchMismatch,
  shouldShowBranchMismatchNotice,
} from "./BranchToolbar.logic";
import { Alert, AlertAction, AlertDescription } from "./ui/alert";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Button } from "./ui/button";
import { toastManager } from "./ui/toast";

interface BranchToolbarMismatchNoticeProps {
  threadId: ThreadId;
  onRestored?: () => void;
}

/** Warns, once the user starts typing, that a local thread's branch is no longer checked out. */
export function BranchToolbarMismatchNotice({
  threadId,
  onRestored,
}: BranchToolbarMismatchNoticeProps) {
  const queryClient = useQueryClient();
  // Select primitives only, so streamed thread updates don't re-render the notice.
  const threadProjectId = useStore(
    (store) => store.threads.find((thread) => thread.id === threadId)?.projectId ?? null,
  );
  const threadBranch = useStore(
    (store) => store.threads.find((thread) => thread.id === threadId)?.branch ?? null,
  );
  const threadWorktreePath = useStore(
    (store) => store.threads.find((thread) => thread.id === threadId)?.worktreePath ?? null,
  );
  const hasServerThread = threadProjectId !== null;
  const project = useProjectById(threadProjectId);
  const gitCwd = hasServerThread && !threadWorktreePath ? (project?.cwd ?? null) : null;
  const { data: gitStatus = null } = useQuery(gitStatusQueryOptions(gitCwd));
  const composerHasContent = useComposerDraftStore((store) => {
    const draft = store.draftsByThreadId[threadId];
    return Boolean(
      draft &&
      (draft.prompt.trim().length > 0 ||
        draft.images.length > 0 ||
        draft.terminalContexts.length > 0),
    );
  });
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const [isRestoring, setIsRestoring] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const mismatch = hasServerThread
    ? resolveLocalCheckoutBranchMismatch({
        effectiveEnvMode: "local",
        activeWorktreePath: threadWorktreePath,
        activeThreadBranch: threadBranch,
        currentGitBranch: gitStatus?.branch ?? null,
      })
    : null;
  const mismatchKey = branchMismatchKey(hasServerThread ? threadId : null, mismatch);
  const showNotice = shouldShowBranchMismatchNotice({
    hasMismatch: mismatch !== null,
    isDismissed:
      (mismatchKey !== null && dismissedKey === mismatchKey) ||
      isBranchMismatchDismissedForSession(mismatchKey),
    composerHasContent,
    wasShownForCurrentMismatch: revealedKey !== null && revealedKey === mismatchKey,
  });

  useEffect(() => {
    setRevealedKey((revealed) => {
      if (showNotice) return mismatchKey;
      // Reset when the mismatch resolves or changes so a recurrence waits for typing again.
      return revealed !== null && revealed !== mismatchKey ? null : revealed;
    });
  }, [mismatchKey, showNotice]);

  const restoreBranch = async () => {
    const api = readNativeApi();
    if (!api || !gitCwd || !mismatch || isRestoring) return;
    setIsRestoring(true);
    const restored = await api.git.checkout({ cwd: gitCwd, branch: mismatch.threadBranch }).then(
      () => true,
      (error: unknown) => {
        toastManager.add({
          type: "error",
          title: "Failed to restore branch.",
          description: error instanceof Error ? error.message : "An error occurred.",
          data: { threadId },
        });
        return false;
      },
    );
    await invalidateGitAfterMutation(queryClient, { cwds: [gitCwd] }).catch(() => undefined);
    setIsRestoring(false);
    if (restored) onRestored?.();
  };

  if (!mismatch || !mismatchKey) return null;

  return (
    <>
      {showNotice ? (
        <div className="mx-auto w-full max-w-(--chat-composer-max-width) pb-2">
          <Alert variant="info" className="py-2">
            <GitBranchIcon />
            <AlertDescription className="min-w-0 flex-row items-baseline gap-1.5 text-xs">
              <span className="shrink-0">Branch changed, was</span>
              <code
                className="min-w-0 truncate font-medium text-foreground"
                title={`This thread last ran on ${mismatch.threadBranch}. Sending will continue on ${mismatch.currentBranch}.`}
              >
                {mismatch.threadBranch}
              </code>
            </AlertDescription>
            <AlertAction className="items-center">
              <Button
                size="xs"
                variant="ghost"
                disabled={isRestoring}
                onClick={() => {
                  if (gitStatus?.hasWorkingTreeChanges) {
                    setConfirmOpen(true);
                    return;
                  }
                  void restoreBranch();
                }}
              >
                {isRestoring ? "Restoring..." : "Restore branch"}
              </Button>
              <button
                type="button"
                aria-label="Dismiss branch change notice"
                className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:text-foreground"
                onClick={() => {
                  dismissBranchMismatchForSession(mismatchKey);
                  setDismissedKey(mismatchKey);
                }}
              >
                <XIcon className="size-3.5" />
              </button>
            </AlertAction>
          </Alert>
        </div>
      ) : null}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Switch to <code className="font-medium">{mismatch.threadBranch}</code>?
            </AlertDialogTitle>
            <AlertDialogDescription>
              You have uncommitted changes. They'll carry over to the other branch, or block the
              switch if they conflict.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              onClick={() => {
                setConfirmOpen(false);
                void restoreBranch();
              }}
            >
              Switch branch
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
