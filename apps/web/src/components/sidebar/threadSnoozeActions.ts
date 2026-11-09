import type { ThreadId } from "@piedpiper/contracts";

import { useStore } from "../../store";
import { type ThreadSnooze, useUiStateStore } from "../../uiStateStore";
import {
  createThreadSnooze,
  effectiveSnoozed,
  resolveSnoozeMenuPick,
  resolveThreadSnoozeBlock,
  snoozeWakeDescription,
  type SnoozePreset,
  type ThreadSnoozeBlock,
} from "../Sidebar.snooze";
import { toastManager } from "../ui/toast";
import { showThreadUndoToast } from "./threadUndo";

/** Whether a thread is hidden in its shelf right now, read straight from the stores. */
export function isThreadSnoozedNow(threadId: ThreadId, nowMs: number = Date.now()): boolean {
  return effectiveSnoozed(
    useStore.getState().sidebarThreadsById[threadId],
    useUiStateStore.getState().snoozedThreadsById[threadId],
    nowMs,
  );
}

/** Moves the route off a thread that was just snoozed; the sidebar owns the router and sort order. */
export interface ThreadSnoozeNavigator {
  /** The thread it left, or null when the route stayed put. */
  readonly leaveSnoozedThreads: (threadIds: readonly ThreadId[]) => ThreadId | null;
  readonly reopenThread: (threadId: ThreadId) => void;
}

let snoozeNavigator: ThreadSnoozeNavigator | null = null;

/** Menus snooze without a router, so the mounted sidebar lends them its navigation. */
export function registerThreadSnoozeNavigator(navigator: ThreadSnoozeNavigator): () => void {
  snoozeNavigator = navigator;
  return () => {
    if (snoozeNavigator === navigator) snoozeNavigator = null;
  };
}

const SNOOZE_BLOCK_TOASTS: Record<ThreadSnoozeBlock, { title: string; description: string }> = {
  "pending-approval": {
    title: "Thread is waiting on you",
    description: "Respond to the pending approval before snoozing it.",
  },
  "queued-turn": {
    title: "Thread is about to start",
    description: "Wait for the turn you just sent to start before snoozing it.",
  },
};

/** Snoozes threads with one Undo that restores each one's earlier snooze and the open thread. */
export function snoozeThreadsWithUndo(
  threadIds: readonly ThreadId[],
  snoozedUntil: string,
  nowMs: number = Date.now(),
): void {
  const summaries = useStore.getState().sidebarThreadsById;
  const threads = threadIds.flatMap((threadId) => summaries[threadId] ?? []);
  if (threads.length === 0) return;
  const uiState = useUiStateStore.getState();
  const snoozed: { readonly threadId: ThreadId; readonly previous: ThreadSnooze | undefined }[] =
    [];
  let block: ThreadSnoozeBlock | null = null;
  for (const thread of threads) {
    const threadBlock = resolveThreadSnoozeBlock(thread, nowMs);
    if (threadBlock !== null) {
      block ??= threadBlock;
      continue;
    }
    snoozed.push({ threadId: thread.id, previous: uiState.snoozedThreadsById[thread.id] });
    uiState.snoozeThread(thread.id, createThreadSnooze(thread, snoozedUntil, nowMs));
  }
  if (block !== null && snoozed.length === 0) {
    toastManager.add({ type: "warning", ...SNOOZE_BLOCK_TOASTS[block] });
    return;
  }
  const leftThreadId =
    snoozeNavigator?.leaveSnoozedThreads(snoozed.map((entry) => entry.threadId)) ?? null;
  const wake = snoozeWakeDescription(snoozedUntil, nowMs);
  showThreadUndoToast({
    title:
      snoozed.length === 1
        ? `Snoozed until ${wake}`
        : `Snoozed ${snoozed.length} threads until ${wake}`,
    ...(snoozed.length === 1 && threads[0] ? { description: threads[0].title } : {}),
    failureTitle: "Failed to undo snooze",
    undo: async () => {
      const store = useUiStateStore.getState();
      for (const { threadId, previous } of snoozed) {
        if (previous) {
          store.snoozeThread(threadId, previous);
        } else {
          store.unsnoozeThread(threadId);
        }
      }
      if (leftThreadId !== null) snoozeNavigator?.reopenThread(leftThreadId);
    },
  });
}

/** Snoozes a thread and offers Undo, restoring whatever snooze it had before. */
export function snoozeThreadWithUndo(
  threadId: ThreadId,
  snoozedUntil: string,
  nowMs: number = Date.now(),
): void {
  snoozeThreadsWithUndo([threadId], snoozedUntil, nowMs);
}

export function wakeSnoozedThread(threadId: ThreadId): void {
  useUiStateStore.getState().unsnoozeThread(threadId);
}

/** Runs a clicked native menu item from `buildThreadSnoozeMenuItems`; false when it is not one. */
export function applyThreadSnoozeMenuPick(
  threadId: ThreadId,
  clicked: string | null,
  presets: ReadonlyArray<SnoozePreset>,
): boolean {
  if (clicked === "wake") {
    wakeSnoozedThread(threadId);
    return true;
  }
  const snoozedUntil = resolveSnoozeMenuPick(clicked, presets);
  if (snoozedUntil === null) return false;
  snoozeThreadWithUndo(threadId, snoozedUntil);
  return true;
}
