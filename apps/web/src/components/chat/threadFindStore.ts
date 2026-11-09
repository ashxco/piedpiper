import { type ThreadId } from "@piedpiper/contracts";
import { create } from "zustand";

interface ThreadFindStoreState {
  /** The thread whose find bar is open; only one bar exists at a time. */
  readonly openThreadId: ThreadId | null;
  /** Bumped on every open request, so a repeated shortcut re-focuses the open bar. */
  readonly focusRequestId: number;
}

export const useThreadFindStore = create<ThreadFindStoreState>(() => ({
  openThreadId: null,
  focusRequestId: 0,
}));

/** Opens the find bar for a thread, or re-focuses it when it is already open. */
export function openThreadFind(threadId: ThreadId): void {
  useThreadFindStore.setState((state) => ({
    openThreadId: threadId,
    focusRequestId: state.focusRequestId + 1,
  }));
}

/** Closes the bar; with a thread id, only when that thread's bar is the open one. */
export function closeThreadFind(threadId?: ThreadId): void {
  useThreadFindStore.setState((state) =>
    state.openThreadId === null || (threadId !== undefined && state.openThreadId !== threadId)
      ? state
      : { openThreadId: null },
  );
}
