import { inferCheckpointTurnCountByTurnId } from "../session-logic";
import type { Thread } from "../types";

const EMPTY_TURN_DIFF_SUMMARIES: Thread["turnDiffSummaries"] = [];

export function useTurnDiffSummaries(activeThread: Thread | undefined) {
  // No hook calls inside, so the compiler only memoizes this when opted in.
  "use memo";
  const turnDiffSummaries = activeThread?.turnDiffSummaries ?? EMPTY_TURN_DIFF_SUMMARIES;
  const inferredCheckpointTurnCountByTurnId = inferCheckpointTurnCountByTurnId(turnDiffSummaries);
  return { turnDiffSummaries, inferredCheckpointTurnCountByTurnId };
}
