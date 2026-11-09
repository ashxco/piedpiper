import type { OrchestrationThreadActivity } from "@piedpiper/contracts";
import { describe, expect, it } from "vitest";

import {
  BACKGROUND_TASK_MAX_SILENCE_MS,
  deriveHasLiveBackgroundTask,
} from "./backgroundTaskLiveness";

const MINUTE_MS = 60_000;
const NOW_MS = Date.parse("2026-11-08T12:00:00.000Z");

function taskActivity(
  kind: "task.started" | "task.progress" | "task.completed",
  taskId: string,
  minutesAgo: number,
  extra: Record<string, unknown> = {},
): OrchestrationThreadActivity {
  return {
    id: `${kind}-${taskId}-${minutesAgo}`,
    kind,
    tone: "info",
    summary: kind,
    payload: { taskId, ...extra },
    turnId: null,
    createdAt: new Date(NOW_MS - minutesAgo * MINUTE_MS).toISOString(),
  } as unknown as OrchestrationThreadActivity;
}

describe("deriveHasLiveBackgroundTask", () => {
  it("opens on task.started and closes on task.completed, whatever its status", () => {
    const started = taskActivity("task.started", "a", 5);
    expect(deriveHasLiveBackgroundTask([started], "claudeAgent", NOW_MS)).toBe(true);
    expect(
      deriveHasLiveBackgroundTask(
        [started, taskActivity("task.completed", "a", 1, { status: "failed" })],
        "claudeAgent",
        NOW_MS,
      ),
    ).toBe(false);
  });

  it("stays live while any one of several tasks is open", () => {
    expect(
      deriveHasLiveBackgroundTask(
        [
          taskActivity("task.started", "a", 5),
          taskActivity("task.started", "b", 4),
          taskActivity("task.completed", "a", 1),
        ],
        "claudeAgent",
        NOW_MS,
      ),
    ).toBe(true);
  });

  it("counts only Claude sessions, since Codex maps every turn to a task", () => {
    const activities = [taskActivity("task.started", "a", 5)];
    expect(deriveHasLiveBackgroundTask(activities, "codex", NOW_MS)).toBe(false);
    expect(deriveHasLiveBackgroundTask(activities, null, NOW_MS)).toBe(false);
    expect(deriveHasLiveBackgroundTask(activities, undefined, NOW_MS)).toBe(false);
  });

  it("ignores plan and dream tasks, including their progress", () => {
    expect(
      deriveHasLiveBackgroundTask(
        [
          taskActivity("task.started", "a", 5, { taskType: "plan" }),
          taskActivity("task.started", "b", 5, { taskType: "dream" }),
          taskActivity("task.progress", "b", 1),
        ],
        "claudeAgent",
        NOW_MS,
      ),
    ).toBe(false);
    expect(
      deriveHasLiveBackgroundTask(
        [taskActivity("task.started", "c", 5, { taskType: "local_bash" })],
        "claudeAgent",
        NOW_MS,
      ),
    ).toBe(true);
  });

  it("presumes a silent task dead past the bound, unless it reported progress", () => {
    const boundMinutes = BACKGROUND_TASK_MAX_SILENCE_MS / MINUTE_MS;
    const started = taskActivity("task.started", "a", boundMinutes);
    expect(deriveHasLiveBackgroundTask([started], "claudeAgent", NOW_MS)).toBe(false);
    expect(
      deriveHasLiveBackgroundTask(
        [started, taskActivity("task.progress", "a", 1)],
        "claudeAgent",
        NOW_MS,
      ),
    ).toBe(true);
  });

  it("does not revive an old session's task settled by a later task.completed", () => {
    expect(
      deriveHasLiveBackgroundTask(
        [
          taskActivity("task.started", "old", 30),
          taskActivity("task.completed", "old", 10, { status: "stopped" }),
          taskActivity("task.progress", "old", 5),
        ],
        "claudeAgent",
        NOW_MS,
      ),
    ).toBe(false);
  });

  it("ignores other activities and task rows without an id", () => {
    expect(
      deriveHasLiveBackgroundTask(
        [
          { ...taskActivity("task.started", "a", 5), payload: {} },
          { ...taskActivity("task.started", "b", 5), kind: "tool.started" },
        ] as OrchestrationThreadActivity[],
        "claudeAgent",
        NOW_MS,
      ),
    ).toBe(false);
  });
});

const same = "2026-11-08T11:59:00.000Z";

const row = (id: string, kind: string, createdAt = same) =>
  ({
    id,
    kind,
    tone: "info",
    summary: kind,
    turnId: null,
    createdAt,
    payload: { taskId: "a" },
  }) as never;

describe("deriveHasLiveBackgroundTask ordering", () => {
  it("settles a task whose completion arrived first within one millisecond", () => {
    expect(
      deriveHasLiveBackgroundTask(
        [row("b", "task.completed"), row("a", "task.started")],
        "claudeAgent",
        NOW_MS,
      ),
    ).toBe(false);
  });

  it("keeps a restarted task id live", () => {
    expect(
      deriveHasLiveBackgroundTask(
        [
          row("1", "task.started", "2026-11-08T11:50:00.000Z"),
          row("2", "task.completed", "2026-11-08T11:51:00.000Z"),
          row("3", "task.started", "2026-11-08T11:52:00.000Z"),
        ],
        "claudeAgent",
        NOW_MS,
      ),
    ).toBe(true);
  });
});
