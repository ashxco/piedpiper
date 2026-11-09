/**
 * Pure helpers for Codex's native `/goal`: parsing what the user typed and
 * reading the `thread/goal/*` protocol into the shared `ProviderGoal` form.
 */
import {
  type ProviderGoal,
  type ProviderGoalStatus,
  THREAD_GOAL_ACTIVITY_KIND,
  ThreadGoalActivityPayload,
} from "@piedpiper/contracts";
import { Schema } from "effect";

export type CodexGoalCommand =
  | { readonly type: "show" }
  | { readonly type: "clear" }
  | { readonly type: "pause" }
  | { readonly type: "resume" }
  | { readonly type: "set"; readonly objective: string };

export const CODEX_GOAL_UNSUPPORTED_MESSAGE =
  "This Codex CLI cannot use /goal. Update Codex and try again.";

/**
 * Parses `/goal` the way the Codex TUI does: a bare `/goal` shows the goal,
 * `clear`, `pause` and `resume` control it, and anything else sets a new objective.
 */
export function parseCodexGoalCommand(text: string): CodexGoalCommand | null {
  const match = /^\/goal(?:\s+([\s\S]*))?$/u.exec(text.trim());
  if (match === null) {
    return null;
  }
  const argument = (match[1] ?? "").trim();
  switch (argument.toLowerCase()) {
    case "":
    case "edit":
      return { type: "show" };
    case "clear":
      return { type: "clear" };
    case "pause":
      return { type: "pause" };
    case "resume":
      return { type: "resume" };
    default:
      return { type: "set", objective: argument };
  }
}

const CODEX_GOAL_STATUSES: Readonly<Record<string, ProviderGoalStatus>> = {
  active: "active",
  paused: "paused",
  blocked: "blocked",
  usageLimited: "usage_limited",
  budgetLimited: "budget_limited",
  complete: "complete",
};

const asNonNegativeInt = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;

/** A `ThreadGoal` from `thread/goal/*`; null for no goal, or one this build cannot read. */
export function codexGoalToProviderGoal(goal: unknown): ProviderGoal | null {
  if (goal === null || typeof goal !== "object") {
    return null;
  }
  const record = goal as Record<string, unknown>;
  const objective = typeof record.objective === "string" ? record.objective.trim() : "";
  const status = typeof record.status === "string" ? CODEX_GOAL_STATUSES[record.status] : undefined;
  if (objective.length === 0 || status === undefined) {
    return null;
  }
  const tokensUsed = asNonNegativeInt(record.tokensUsed);
  const tokenBudget = asNonNegativeInt(record.tokenBudget);
  const timeUsedSeconds = asNonNegativeInt(record.timeUsedSeconds);
  return {
    objective: objective as ProviderGoal["objective"],
    status,
    ...(tokensUsed !== undefined ? { tokensUsed } : {}),
    tokenBudget: tokenBudget ?? null,
    ...(timeUsedSeconds !== undefined ? { timeUsedSeconds } : {}),
  };
}

export function describeProviderGoal(goal: ProviderGoal): string {
  return `Goal ${goal.status.replace("_", " ")}: ${goal.objective}`;
}

const decodeGoalPayload = Schema.decodeUnknownOption(ThreadGoalActivityPayload);

/** The goal from the thread's latest report; a cleared goal reports null. */
export function latestProviderGoal(
  activities: ReadonlyArray<{ readonly kind: string; readonly payload: unknown }>,
): ProviderGoal | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (activity?.kind !== THREAD_GOAL_ACTIVITY_KIND) continue;
    const payload = decodeGoalPayload(activity.payload);
    if (payload._tag === "Some") return payload.value.goal;
  }
  return null;
}
