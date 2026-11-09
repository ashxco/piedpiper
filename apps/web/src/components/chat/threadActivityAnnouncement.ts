import type { OrchestrationLatestTurnState, TurnId } from "@piedpiper/contracts";

export type ThreadActivityStatus = "working" | "approval" | "input" | "idle";

export interface ThreadActivitySnapshot {
  readonly status: ThreadActivityStatus;
  /** The pending approval or question, when there is one. */
  readonly requestId: string | null;
  readonly turnId: TurnId | null;
  readonly turnState: OrchestrationLatestTurnState | null;
}

export interface ThreadAnnouncementMemory {
  readonly snapshot: ThreadActivitySnapshot;
  /**
   * The turn under way: its id, "unknown" until the thread's latest turn shows
   * it, or null between turns. Its ending is announced once, then it clears.
   */
  readonly activeTurnId: TurnId | "unknown" | null;
  /** The turn whose ending is already known, so a stale turn is never announced as this one's. */
  readonly settledTurnId: TurnId | null;
  /** The turn shown while idle belongs to the last turn, even if it is still settling. */
  readonly idleTurnId: TurnId | null;
}

function turnOutcomeText(state: OrchestrationLatestTurnState | null): string | null {
  switch (state) {
    case "completed":
      return "Done";
    case "error":
      return "Failed";
    case "interrupted":
      return "Stopped";
    default:
      return null;
  }
}

/** Collapses the open thread's state into what a screen reader is told about. */
export function deriveThreadActivityStatus(input: {
  readonly running: boolean;
  readonly pendingApprovalRequestId: string | null;
  readonly pendingUserInputRequestId: string | null;
}): Pick<ThreadActivitySnapshot, "status" | "requestId"> {
  if (input.pendingApprovalRequestId !== null) {
    return { status: "approval", requestId: input.pendingApprovalRequestId };
  }
  if (input.pendingUserInputRequestId !== null) {
    return { status: "input", requestId: input.pendingUserInputRequestId };
  }
  return { status: input.running ? "working" : "idle", requestId: null };
}

/**
 * Decides what a screen reader hears when the open thread's turn changes state.
 * The first snapshot of a thread is a silent baseline, so opening or switching
 * threads never replays what already happened.
 */
export function nextThreadAnnouncement(
  previous: ThreadAnnouncementMemory | null,
  next: ThreadActivitySnapshot,
): { readonly memory: ThreadAnnouncementMemory; readonly announcement: string | null } {
  const idle = next.status === "idle";
  const idleTurnId = idle ? next.turnId : (previous?.idleTurnId ?? null);
  // A turn doing new work; the turn left over from the last one doesn't count.
  const newTurnId =
    !idle && next.turnState === "running" && next.turnId !== idleTurnId ? next.turnId : null;

  if (previous === null) {
    return {
      memory: {
        snapshot: next,
        activeTurnId: idle ? null : (newTurnId ?? "unknown"),
        settledTurnId: turnOutcomeText(next.turnState) === null ? null : next.turnId,
        idleTurnId,
      },
      announcement: null,
    };
  }
  const memory = { ...previous, snapshot: next, idleTurnId };
  const { activeTurnId } = previous;

  if (!idle) {
    // The session can report running before the latest turn switches over, so a
    // turn is tied to its id once it appears, and only another turn taking over is new.
    const turnStarted =
      activeTurnId === null ||
      (newTurnId !== null && activeTurnId !== "unknown" && newTurnId !== activeTurnId);
    const nextActiveTurnId =
      turnStarted || activeTurnId === "unknown" ? (newTurnId ?? "unknown") : activeTurnId;
    const announcement =
      next.status === "approval"
        ? previous.snapshot.status === "approval" && previous.snapshot.requestId === next.requestId
          ? null
          : "Needs approval"
        : next.status === "input"
          ? previous.snapshot.status === "input" && previous.snapshot.requestId === next.requestId
            ? null
            : "Needs your input"
          : turnStarted
            ? "Working"
            : null;
    return { memory: { ...memory, activeTurnId: nextActiveTurnId }, announcement };
  }

  // The session can go idle a moment before the turn settles; the ending waits for the turn.
  const outcome = turnOutcomeText(next.turnState);
  if (activeTurnId === null) {
    // A turn that settled unseen is history too, or the next failed send would claim it.
    const settledTurnId = outcome === null ? previous.settledTurnId : next.turnId;
    return { memory: { ...memory, settledTurnId }, announcement: null };
  }
  if (outcome === null) return { memory, announcement: null };
  // Work stopped without a new turn, e.g. a send that failed; the retry is a new turn.
  if (next.turnId === previous.settledTurnId) {
    return { memory: { ...memory, activeTurnId: null }, announcement: null };
  }
  // The last turn settling while this one waits for its own id is not this turn's ending.
  if (activeTurnId === "unknown" && next.turnId === previous.idleTurnId) {
    return { memory: { ...memory, settledTurnId: next.turnId }, announcement: null };
  }
  return {
    memory: { ...memory, activeTurnId: null, settledTurnId: next.turnId },
    announcement: outcome,
  };
}
