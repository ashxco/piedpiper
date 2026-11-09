import type { ThreadId } from "@piedpiper/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import {
  buildTemporaryWorktreeBranchName,
  settleWorktreeCreation,
  type WorktreeCreationAbortIntent,
} from "../components/ChatView.logic";
import type { ComposerWorktreeProgressValue } from "../components/chat/ComposerWorktreeProgress";
import { gitCreateWorktreeMutationOptions } from "../lib/gitReactQuery";
import { useStableCallback } from "./useStableCallback";

interface WorktreeCreationHandle {
  readonly controller: AbortController;
  abortIntent: WorktreeCreationAbortIntent | null;
}

interface WorktreeCreationState {
  readonly progress: ComposerWorktreeProgressValue | null;
  readonly canWorkLocally: boolean;
}

/** Creation outlives navigation; progress and abort controls belong to the originating thread. */
export function useComposerWorktreeCreation(threadId: ThreadId) {
  const queryClient = useQueryClient();
  const mutation = useMutation(gitCreateWorktreeMutationOptions({ queryClient }));
  const handles = useRef(new Map<ThreadId, WorktreeCreationHandle>());
  const [creations, setCreations] = useState<Readonly<Record<string, WorktreeCreationState>>>({});

  const prepareWorktree = (input: {
    threadId: ThreadId;
    cwd: string;
    branch: string;
    canWorkLocally: boolean;
  }) => {
    const creation: WorktreeCreationHandle = {
      controller: new AbortController(),
      abortIntent: null,
    };
    handles.current.set(input.threadId, creation);
    setCreations((current) => ({
      ...current,
      [input.threadId]: { progress: null, canWorkLocally: input.canWorkLocally },
    }));
    return settleWorktreeCreation(
      mutation.mutateAsync({
        cwd: input.cwd,
        branch: input.branch,
        newBranch: buildTemporaryWorktreeBranchName(),
        signal: creation.controller.signal,
        onProgress: ({ percent }) => {
          setCreations((current) => {
            const entry = current[input.threadId];
            return !entry || entry.progress?.percent === percent
              ? current
              : { ...current, [input.threadId]: { ...entry, progress: { percent } } };
          });
        },
      }),
      () => creation.abortIntent,
    ).finally(() => {
      handles.current.delete(input.threadId);
      setCreations((current) => {
        const remaining = { ...current };
        delete remaining[input.threadId];
        return remaining;
      });
    });
  };

  const abort = (intent: WorktreeCreationAbortIntent) => {
    const creation = handles.current.get(threadId);
    if (!creation) return;
    creation.abortIntent = intent;
    creation.controller.abort();
  };
  const cancel = useStableCallback(() => abort("cancel"));
  const workLocally = useStableCallback(() => abort("work-locally"));

  return {
    activeCreation: creations[threadId] ?? null,
    createWorktree: mutation.mutateAsync,
    prepareWorktree,
    cancel,
    workLocally,
  };
}
