// Mirrors codex_protocol's MAX_THREAD_GOAL_OBJECTIVE_CHARS.
const CODEX_GOAL_OBJECTIVE_MAX_CHARS = 4_000;

/** Why Codex would refuse this objective, or null when it fits. Counts code points, as Codex does. */
export function codexGoalObjectiveError(objective: string): string | null {
  const objectiveChars = [...objective].length;
  return objectiveChars > CODEX_GOAL_OBJECTIVE_MAX_CHARS
    ? `The goal objective is ${objectiveChars} characters; Codex supports at most ${CODEX_GOAL_OBJECTIVE_MAX_CHARS}. Shorten it and send /goal again.`
    : null;
}
