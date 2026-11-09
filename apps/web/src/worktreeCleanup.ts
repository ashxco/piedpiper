import { normalizeWorktreePathForComparison } from "@piedpiper/shared/path";

import type { Thread } from "./types";

function normalizeWorktreePath(path: string | null): string | null {
  const trimmed = path?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed;
}

export function getOrphanedWorktreePathForThread(
  threads: readonly Thread[],
  threadId: Thread["id"],
): string | null {
  const targetThread = threads.find((thread) => thread.id === threadId);
  if (!targetThread) {
    return null;
  }

  const targetWorktreePath = normalizeWorktreePath(targetThread.worktreePath);
  if (!targetWorktreePath) {
    return null;
  }

  // Threads can store one worktree as `C:\repo\wt` and `c:/repo/wt/`, and
  // confirming deletion force-removes the checkout for every thread on it.
  const targetKey = normalizeWorktreePathForComparison(targetWorktreePath);
  const isShared = threads.some((thread) => {
    if (thread.id === threadId) {
      return false;
    }
    const otherPath = normalizeWorktreePath(thread.worktreePath);
    return otherPath !== null && normalizeWorktreePathForComparison(otherPath) === targetKey;
  });

  return isShared ? null : targetWorktreePath;
}

export function formatWorktreePathForDisplay(worktreePath: string): string {
  const trimmed = worktreePath.trim();
  if (!trimmed) {
    return worktreePath;
  }

  const normalized = trimmed.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = normalized.split("/");
  const lastPart = parts[parts.length - 1]?.trim() ?? "";
  return lastPart.length > 0 ? lastPart : trimmed;
}

/** Sidebar label for a worktree-backed thread, or null when the thread uses the project checkout. */
export function formatThreadWorktreeLabel(thread: {
  worktreePath: string | null | undefined;
  branch: string | null | undefined;
}): string | null {
  const worktreePath = thread.worktreePath?.trim();
  if (!worktreePath) return null;
  const displayPath = formatWorktreePathForDisplay(worktreePath);
  return thread.branch ? `Worktree: ${displayPath} (${thread.branch})` : `Worktree: ${displayPath}`;
}
