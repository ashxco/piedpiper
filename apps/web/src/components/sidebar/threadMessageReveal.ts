import type { MessageId, ThreadId, TurnId } from "@piedpiper/contracts";
import { create } from "zustand";

import type { TimelinePosition } from "../ChatView.timelinePosition";
import { turnFoldRowId } from "../ChatView.turnFolds";

const REVEAL_ANCHOR_OFFSET_PX = 12;

export interface ThreadMessageReveal {
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  /** The turn whose fold may hide the message; null when no fold can. */
  readonly foldedTurnId: TurnId | null;
}

interface ThreadMessageRevealState {
  readonly pending: ThreadMessageReveal | null;
  /** Survives the take, so the timeline re-runs once per request, even on the open thread. */
  readonly requestIdByThreadId: Readonly<Record<string, number>>;
}

const useThreadMessageRevealStore = create<ThreadMessageRevealState>(() => ({
  pending: null,
  requestIdByThreadId: {},
}));

/** Asks the timeline to open at this message instead of the thread's saved position. */
export function requestThreadMessageReveal(reveal: ThreadMessageReveal): void {
  useThreadMessageRevealStore.setState((state) => ({
    pending: reveal,
    requestIdByThreadId: {
      ...state.requestIdByThreadId,
      [reveal.threadId]: (state.requestIdByThreadId[reveal.threadId] ?? 0) + 1,
    },
  }));
}

export function useThreadMessageRevealRequestId(threadId: ThreadId | null | undefined): number {
  return useThreadMessageRevealStore((state) =>
    threadId ? (state.requestIdByThreadId[threadId] ?? 0) : 0,
  );
}

/** Hands the pending reveal to the thread it targets, once. */
export function takeThreadMessageReveal(threadId: ThreadId): ThreadMessageReveal | null {
  const { pending } = useThreadMessageRevealStore.getState();
  if (pending?.threadId !== threadId) return null;
  useThreadMessageRevealStore.setState({ pending: null });
  return pending;
}

/**
 * The position that puts the message at the top of the viewport. A message that turns out not to
 * be in the timeline falls back to where the thread would have opened: its saved offset or the end.
 */
export function buildThreadMessageRevealPosition(
  reveal: ThreadMessageReveal,
  saved: TimelinePosition | undefined,
): TimelinePosition {
  const expandedWorkGroupIds = saved?.expandedWorkGroupIds ?? [];
  const foldRowId = reveal.foldedTurnId === null ? null : turnFoldRowId(reveal.foldedTurnId);
  return {
    anchorRowId: reveal.messageId,
    anchorOffsetPx: REVEAL_ANCHOR_OFFSET_PX,
    scrollTop: saved && !saved.atEnd ? saved.scrollTop : Number.MAX_SAFE_INTEGER,
    atEnd: false,
    expandedWorkGroupIds:
      foldRowId === null || expandedWorkGroupIds.includes(foldRowId)
        ? expandedWorkGroupIds
        : [...expandedWorkGroupIds, foldRowId],
  };
}
