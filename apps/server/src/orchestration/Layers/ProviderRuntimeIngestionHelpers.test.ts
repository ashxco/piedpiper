import { ThreadId } from "@piedpiper/contracts";
import { describe, expect, it } from "vitest";

import {
  advanceAssistantTextScan,
  assistantTextReadyBoundary,
  EMPTY_ASSISTANT_TEXT_SCAN,
  openTaskIdsInActivities,
  splitBufferedAssistantText,
  settleOpenTasksCommands,
} from "./ProviderRuntimeIngestionHelpers.ts";

const task = (kind: "task.started" | "task.completed", taskId: string, createdAt: string) => ({
  kind,
  createdAt,
  payload: { taskId },
});

describe("openTaskIdsInActivities", () => {
  it("closes a task whose completion sorts first within one timestamp", () => {
    expect(
      openTaskIdsInActivities([
        task("task.completed", "a", "2026-01-01T00:00:00.000Z"),
        task("task.started", "a", "2026-01-01T00:00:00.000Z"),
      ]),
    ).toEqual([]);
  });

  it("keeps a restarted task id open", () => {
    expect(
      openTaskIdsInActivities([
        task("task.started", "a", "2026-01-01T00:00:00.000Z"),
        task("task.completed", "a", "2026-01-01T00:00:01.000Z"),
        task("task.started", "a", "2026-01-01T00:00:02.000Z"),
      ]),
    ).toEqual(["a"]);
  });
});

describe("settleOpenTasksCommands", () => {
  it("closes each open task with no turn, so a later revert keeps the completion", () => {
    let nextCommand = 0;
    const [command, ...rest] = settleOpenTasksCommands({
      threadId: ThreadId.makeUnsafe("thread-1"),
      activities: [task("task.started", "a", "2026-01-01T00:00:00.000Z")],
      createdAt: "2026-01-01T00:00:05.000Z",
      commandId: () => {
        nextCommand += 1;
        return `cmd-${nextCommand}` as never;
      },
    });
    expect(rest).toEqual([]);
    expect(command).toMatchObject({
      type: "thread.activity.append",
      commandId: "cmd-1",
      activity: {
        kind: "task.completed",
        summary: "Task stopped",
        payload: { taskId: "a", status: "stopped" },
        turnId: null,
      },
    });
  });
});

describe("advanceAssistantTextScan", () => {
  const text = [
    "Intro paragraph.",
    "",
    "## Section",
    "Body line.",
    "- first item",
    "- second item",
    "```ts",
    "const a = 1;",
    "",
    "```",
    "1. ordered",
    "2. next",
    "**Bold title**",
    "",
    "trailing partial",
  ].join("\n");

  it("resumes a growing buffer with the same boundary as a full scan", () => {
    for (const step of [1, 3, 7, 16]) {
      let scan = EMPTY_ASSISTANT_TEXT_SCAN;
      for (let end = 0; end <= text.length; end += step) {
        const prefix = text.slice(0, end);
        scan = advanceAssistantTextScan(scan, prefix);
        const boundary = assistantTextReadyBoundary(scan);
        expect(boundary === -1 ? "" : prefix.slice(0, boundary)).toBe(
          splitBufferedAssistantText(prefix).ready,
        );
      }
    }
  });

  it("starts over when the text no longer extends the scanned text", () => {
    const scan = advanceAssistantTextScan(EMPTY_ASSISTANT_TEXT_SCAN, "```\ncode\n");
    const fresh = advanceAssistantTextScan(scan, "Para.\n\nNext");
    expect(assistantTextReadyBoundary(fresh)).toBe("Para.\n\n".length);
  });
});
