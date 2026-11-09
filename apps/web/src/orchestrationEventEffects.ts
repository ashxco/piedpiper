import type { OrchestrationEvent, ProjectId, ThreadId } from "@piedpiper/contracts";

export interface OrchestrationBatchEffects {
  clearPromotedDraftThreadIds: ThreadId[];
  clearDeletedThreadIds: ThreadId[];
  removeTerminalStateThreadIds: ThreadId[];
  needsProviderInvalidation: boolean;
  /** Threads whose working tree changed (turn diff, revert), so only their git status is stale. */
  gitStatusInvalidationThreadIds: ThreadId[];
  /** Threads whose branch or worktree changed, so their git status and branch list are stale. */
  gitBranchInvalidationThreadIds: ThreadId[];
}

export function deriveOrchestrationBatchEffects(
  events: readonly OrchestrationEvent[],
): OrchestrationBatchEffects {
  const threadLifecycleEffects = new Map<
    ThreadId,
    {
      clearPromotedDraft: boolean;
      clearDeletedThread: boolean;
      removeTerminalState: boolean;
    }
  >();
  let needsProviderInvalidation = false;
  const gitStatusInvalidationThreadIds = new Set<ThreadId>();
  const gitBranchInvalidationThreadIds = new Set<ThreadId>();

  for (const event of events) {
    switch (event.type) {
      case "thread.turn-diff-completed":
      case "thread.reverted": {
        needsProviderInvalidation = true;
        gitStatusInvalidationThreadIds.add(event.payload.threadId);
        break;
      }

      case "thread.meta-updated": {
        if (event.payload.branch !== undefined || event.payload.worktreePath !== undefined) {
          gitBranchInvalidationThreadIds.add(event.payload.threadId);
        }
        break;
      }

      case "thread.created": {
        threadLifecycleEffects.set(event.payload.threadId, {
          clearPromotedDraft: true,
          clearDeletedThread: false,
          removeTerminalState: false,
        });
        break;
      }

      case "thread.deleted": {
        threadLifecycleEffects.set(event.payload.threadId, {
          clearPromotedDraft: false,
          clearDeletedThread: true,
          removeTerminalState: true,
        });
        break;
      }

      case "thread.archived": {
        threadLifecycleEffects.set(event.payload.threadId, {
          clearPromotedDraft: false,
          clearDeletedThread: false,
          removeTerminalState: true,
        });
        break;
      }

      case "thread.unarchived": {
        threadLifecycleEffects.set(event.payload.threadId, {
          clearPromotedDraft: false,
          clearDeletedThread: false,
          removeTerminalState: false,
        });
        break;
      }

      default: {
        break;
      }
    }
  }

  const clearPromotedDraftThreadIds: ThreadId[] = [];
  const clearDeletedThreadIds: ThreadId[] = [];
  const removeTerminalStateThreadIds: ThreadId[] = [];
  for (const [threadId, effect] of threadLifecycleEffects) {
    if (effect.clearPromotedDraft) {
      clearPromotedDraftThreadIds.push(threadId);
    }
    if (effect.clearDeletedThread) {
      clearDeletedThreadIds.push(threadId);
    }
    if (effect.removeTerminalState) {
      removeTerminalStateThreadIds.push(threadId);
    }
  }

  return {
    clearPromotedDraftThreadIds,
    clearDeletedThreadIds,
    removeTerminalStateThreadIds,
    needsProviderInvalidation,
    // A branch refresh already covers status, so a thread is listed in at most one of the two.
    gitStatusInvalidationThreadIds: [...gitStatusInvalidationThreadIds].filter(
      (threadId) => !gitBranchInvalidationThreadIds.has(threadId),
    ),
    gitBranchInvalidationThreadIds: [...gitBranchInvalidationThreadIds],
  };
}

/** Unique git cwds (worktree, else project root) for the given threads; unknown threads are skipped. */
export function resolveThreadGitCwds(
  threadIds: Iterable<ThreadId>,
  threads: ReadonlyArray<{ id: ThreadId; projectId: ProjectId; worktreePath: string | null }>,
  projects: ReadonlyArray<{ id: ProjectId; cwd: string }>,
): string[] {
  const cwds = new Set<string>();
  for (const threadId of threadIds) {
    const thread = threads.find((candidate) => candidate.id === threadId);
    if (!thread) continue;
    const cwd =
      thread.worktreePath ?? projects.find((project) => project.id === thread.projectId)?.cwd;
    if (cwd) cwds.add(cwd);
  }
  return [...cwds];
}
