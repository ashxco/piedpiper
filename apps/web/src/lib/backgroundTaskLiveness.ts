import type { OrchestrationThreadActivity, ProviderKind } from "@piedpiper/contracts";

import { compareActivitiesByOrder } from "../session-logic";

/** Mirrors the server's session reaper: a task silent this long is presumed dead. */
export const BACKGROUND_TASK_MAX_SILENCE_MS = 6 * 60 * 60 * 1000;

// Claude runs these inside the session's own machinery; they are not work the user started.
const IGNORED_TASK_TYPES: ReadonlySet<string> = new Set(["plan", "dream"]);

function readPayloadString(payload: unknown, key: "taskId" | "taskType"): string | null {
  if (payload === null || typeof payload !== "object") return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * True while a Claude background task has started, not completed, and reported within the
 * silence bound. Codex maps every turn to a task, so it never counts. The caller gates on the
 * session being ready; a new session's start settles older tasks with task.completed on the server.
 */
export function deriveHasLiveBackgroundTask(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  provider: ProviderKind | null | undefined,
  nowMs: number,
): boolean {
  if (provider !== "claudeAgent") return false;
  const lastSeenByTask = new Map<string, number>();
  // Task rows have no sequence, so a completion in the same millisecond can arrive before its start.
  for (const activity of activities.toSorted(compareActivitiesByOrder)) {
    if (
      activity.kind !== "task.started" &&
      activity.kind !== "task.progress" &&
      activity.kind !== "task.completed"
    ) {
      continue;
    }
    const taskId = readPayloadString(activity.payload, "taskId");
    if (taskId === null) continue;
    if (activity.kind === "task.completed") {
      lastSeenByTask.delete(taskId);
      continue;
    }
    if (
      activity.kind === "task.started" &&
      IGNORED_TASK_TYPES.has(readPayloadString(activity.payload, "taskType") ?? "")
    ) {
      continue;
    }
    const seenAt = Date.parse(activity.createdAt);
    if (Number.isNaN(seenAt)) continue;
    if (activity.kind === "task.started" || lastSeenByTask.has(taskId)) {
      lastSeenByTask.set(taskId, seenAt);
    }
  }
  for (const seenAt of lastSeenByTask.values()) {
    if (nowMs - seenAt < BACKGROUND_TASK_MAX_SILENCE_MS) return true;
  }
  return false;
}
