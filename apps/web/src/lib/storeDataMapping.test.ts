import { describe, expect, it } from "vitest";

import { CheckpointRef, type OrchestrationCheckpointSummary, TurnId } from "@piedpiper/contracts";

import type { Thread } from "../types";
import {
  buildSidebarThreadSummary,
  mapMessageAttachment,
  mapProject,
  mapTurnDiffSummary,
  sidebarThreadSummariesEqual,
} from "./storeDataMapping";

const base = { id: "attachment-1", sizeBytes: 12 };

describe("mapMessageAttachment", () => {
  it("gives image attachments a preview URL", () => {
    const mapped = mapMessageAttachment({
      ...base,
      type: "image",
      name: "shot.png",
      mimeType: "image/png",
    } as Parameters<typeof mapMessageAttachment>[0]);
    expect(mapped.type).toBe("image");
    expect(mapped.previewUrl).toContain("/attachments/attachment-1");
  });

  it("keeps file attachments as files with no preview URL", () => {
    const mapped = mapMessageAttachment({
      ...base,
      type: "file",
      name: "spec.pdf",
      mimeType: "application/pdf",
    } as Parameters<typeof mapMessageAttachment>[0]);
    expect(mapped).toEqual({
      ...base,
      type: "file",
      name: "spec.pdf",
      mimeType: "application/pdf",
    });
  });
});

describe("mapTurnDiffSummary", () => {
  const checkpoint: OrchestrationCheckpointSummary = {
    turnId: TurnId.makeUnsafe("turn-1"),
    checkpointTurnCount: 1,
    checkpointRef: CheckpointRef.makeUnsafe("checkpoint-1"),
    status: "ready",
    files: [],
    assistantMessageId: null,
    completedAt: "2026-02-27T00:00:02.000Z",
  };

  it("copies the capped totals when they are present", () => {
    expect(
      mapTurnDiffSummary({
        ...checkpoint,
        filesTotal: 450,
        additionsTotal: 900,
        deletionsTotal: 12,
      }),
    ).toMatchObject({ filesTotal: 450, additionsTotal: 900, deletionsTotal: 12 });
  });

  it("omits the totals from an uncapped summary", () => {
    const summary = mapTurnDiffSummary(checkpoint);
    expect(summary).not.toHaveProperty("filesTotal");
    expect(summary).not.toHaveProperty("additionsTotal");
    expect(summary).not.toHaveProperty("deletionsTotal");
  });
});

describe("mapProject", () => {
  const project = {
    id: "project-1",
    title: "Project",
    workspaceRoot: "/tmp/project",
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-02-27T00:00:00.000Z",
    updatedAt: "2026-02-27T00:00:00.000Z",
    deletedAt: null,
  } as unknown as Parameters<typeof mapProject>[0];

  it("treats a snapshot without archivedAt as not archived", () => {
    expect(mapProject(project).archivedAt).toBeNull();
  });

  it("carries archivedAt from the snapshot", () => {
    const archivedAt = "2026-02-27T00:00:01.000Z";
    expect(mapProject({ ...project, archivedAt } as typeof project).archivedAt).toBe(archivedAt);
  });

  it("carries faviconPath from the snapshot and defaults it to null", () => {
    expect(mapProject(project).faviconPath).toBeNull();
    expect(
      mapProject({ ...project, faviconPath: "assets/logo.svg" } as typeof project).faviconPath,
    ).toBe("assets/logo.svg");
  });
});

const message = (id: string, createdAt: string) =>
  ({ id, role: "user", text: "x", createdAt, streaming: false }) as never;

describe("buildSidebarThreadSummary hasLiveBackgroundTask", () => {
  const session = { provider: "claudeAgent", status: "ready" } as NonNullable<Thread["session"]>;
  const taskActivity = (kind: "task.started" | "task.completed") =>
    ({
      id: `activity-${kind}`,
      kind,
      payload: { taskId: "task-1", taskType: "local_bash" },
      createdAt: new Date().toISOString(),
    }) as unknown as Thread["activities"][number];
  const makeThread = (overrides: Partial<Thread>) =>
    ({
      id: "thread-1",
      projectId: "project-1",
      title: "Thread",
      session,
      messages: [],
      proposedPlans: [],
      activities: [],
      latestTurn: null,
      ...overrides,
    }) as unknown as Thread;

  it("counts an open message-mode question once the session settles, with the same activities", () => {
    const activities = [
      {
        id: "q",
        kind: "user-input.requested",
        tone: "info",
        summary: "q",
        turnId: null,
        createdAt: "2026-01-01T00:00:01.000Z",
        payload: {
          requestId: "r",
          responseMode: "message",
          questions: [
            { id: "q", header: "H", question: "Q?", options: [{ label: "a", description: "a" }] },
          ],
        },
      },
    ] as unknown as Thread["activities"];
    const running = makeThread({
      activities,
      session: { orchestrationStatus: "running" } as Thread["session"],
    });
    const runningSummary = buildSidebarThreadSummary(running);
    expect(runningSummary.hasPendingUserInput).toBe(false);
    expect(runningSummary.pendingUserInputAt).toBeNull();

    const settled = makeThread({
      activities,
      session: { orchestrationStatus: "ready" } as Thread["session"],
    });
    const settledSummary = buildSidebarThreadSummary(settled, {
      previousThread: running,
      previousSummary: runningSummary,
    });
    expect(settledSummary.hasPendingUserInput).toBe(true);
    expect(settledSummary.pendingUserInputAt).toBe("2026-01-01T00:00:01.000Z");
  });

  it("leaves resends out of the newest manual message", () => {
    const summary = buildSidebarThreadSummary(
      makeThread({
        messages: [
          message("mine", "2026-01-01T00:00:01.000Z"),
          message("message:restart-continuation:1", "2026-01-01T00:00:02.000Z"),
          message("usage-limit-resume:t:1", "2026-01-01T00:00:03.000Z"),
        ],
      }),
    );
    expect(summary.latestUserMessageAt).toBe("2026-01-01T00:00:03.000Z");
    expect(summary.latestManualUserMessageAt).toBe("2026-01-01T00:00:01.000Z");
  });

  it("reuses the flag without rescanning when only messages changed", () => {
    const previousThread = makeThread({});
    const previousSummary = {
      ...buildSidebarThreadSummary(previousThread),
      // No task in the activities, so true can only come from the previous summary.
      hasLiveBackgroundTask: true,
    };
    const next = makeThread({ activities: previousThread.activities });
    expect(
      buildSidebarThreadSummary(next, { previousThread, previousSummary }).hasLiveBackgroundTask,
    ).toBe(true);
  });

  it("flips on task.started and back off on task.completed", () => {
    const idle = makeThread({});
    const idleSummary = buildSidebarThreadSummary(idle);
    expect(idleSummary.hasLiveBackgroundTask).toBe(false);

    const started = makeThread({ activities: [taskActivity("task.started")] });
    const startedSummary = buildSidebarThreadSummary(started, {
      previousThread: idle,
      previousSummary: idleSummary,
    });
    expect(startedSummary.hasLiveBackgroundTask).toBe(true);
    expect(sidebarThreadSummariesEqual(idleSummary, startedSummary)).toBe(false);

    const completed = makeThread({
      activities: [taskActivity("task.started"), taskActivity("task.completed")],
    });
    expect(
      buildSidebarThreadSummary(completed, {
        previousThread: started,
        previousSummary: startedSummary,
      }).hasLiveBackgroundTask,
    ).toBe(false);
  });

  it("recomputes when a session arrives with unchanged activities", () => {
    const activities = [taskActivity("task.started")];
    const previousThread = makeThread({ session: null, activities });
    const previousSummary = buildSidebarThreadSummary(previousThread);
    expect(previousSummary.hasLiveBackgroundTask).toBe(false);
    expect(
      buildSidebarThreadSummary(makeThread({ activities }), { previousThread, previousSummary })
        .hasLiveBackgroundTask,
    ).toBe(true);
  });
});
