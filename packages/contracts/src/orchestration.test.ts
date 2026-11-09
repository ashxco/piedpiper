import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  ChatFileAttachment,
  ClientOrchestrationCommand,
  getProviderAttachmentLimitError,
  OrchestrationCheckpointSummary,
  OrchestrationCommand,
  OrchestrationEvent,
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetTurnDiffFileContentsInput,
  OrchestrationGetTurnDiffFileContentsResult,
  OrchestrationGetTurnDiffInput,
  OrchestrationProject,
  ProjectFaviconPath,
  ProviderGoal,
  RuntimeMode,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_TOTAL_IMAGE_BYTES,
  THREAD_GOAL_ACTIVITY_KIND,
  THREAD_USAGE_LIMIT_ACTIVITY_KIND,
  THREAD_USAGE_LIMIT_RESUME_CANCELLED_ACTIVITY_KIND,
  ThreadGoalActivityPayload,
  ThreadTitleRegenerationSettleCommand,
  ThreadTurnDiffCompletedPayload,
  ThreadUsageLimitActivityPayload,
  UploadChatFileAttachment,
} from "./orchestration";

describe("getProviderAttachmentLimitError", () => {
  const MIB = 1024 * 1024;

  it("allows a batch of many small images", () => {
    expect(
      getProviderAttachmentLimitError(Array.from({ length: 20 }, () => ({ sizeBytes: MIB }))),
    ).toBe(undefined);
  });

  it("rejects more than the per-message image count", () => {
    const attachments = Array.from({ length: PROVIDER_SEND_TURN_MAX_ATTACHMENTS + 1 }, () => ({
      sizeBytes: 1,
    }));
    expect(getProviderAttachmentLimitError(attachments)).toBe(
      `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} images per message.`,
    );
  });

  it("rejects a total image payload over the budget", () => {
    expect(
      getProviderAttachmentLimitError([{ sizeBytes: PROVIDER_SEND_TURN_MAX_TOTAL_IMAGE_BYTES }]),
    ).toBe(undefined);
    expect(
      getProviderAttachmentLimitError([
        { sizeBytes: PROVIDER_SEND_TURN_MAX_TOTAL_IMAGE_BYTES },
        { sizeBytes: 1 },
      ]),
    ).toContain("64 MiB");
  });

  it("names attachments rather than images once a file is in the batch", () => {
    expect(
      getProviderAttachmentLimitError([
        { sizeBytes: PROVIDER_SEND_TURN_MAX_TOTAL_IMAGE_BYTES, type: "image" },
        { sizeBytes: 1, type: "file" },
      ]),
    ).toContain("Attachments can total up to 64 MiB");
    const tooMany = Array.from({ length: PROVIDER_SEND_TURN_MAX_ATTACHMENTS + 1 }, () => ({
      sizeBytes: 1,
      type: "file",
    }));
    expect(getProviderAttachmentLimitError(tooMany)).toContain("attachments per message");
  });
});

describe("diff inputs ignoreWhitespace", () => {
  it("decodes with and without the optional flag", () => {
    const decodeTurn = Schema.decodeUnknownSync(OrchestrationGetTurnDiffInput);
    expect(decodeTurn({ threadId: "thread-1", fromTurnCount: 0, toTurnCount: 1 })).toEqual({
      threadId: "thread-1",
      fromTurnCount: 0,
      toTurnCount: 1,
    });
    expect(
      decodeTurn({ threadId: "thread-1", fromTurnCount: 0, toTurnCount: 1, ignoreWhitespace: true })
        .ignoreWhitespace,
    ).toBe(true);
    const decodeFull = Schema.decodeUnknownSync(OrchestrationGetFullThreadDiffInput);
    expect(decodeFull({ threadId: "thread-1", toTurnCount: 2 })).toEqual({
      threadId: "thread-1",
      toTurnCount: 2,
    });
    expect(
      decodeFull({ threadId: "thread-1", toTurnCount: 2, ignoreWhitespace: false })
        .ignoreWhitespace,
    ).toBe(false);
  });

  it("still rejects an inverted turn range", () => {
    expect(() =>
      Schema.decodeUnknownSync(OrchestrationGetTurnDiffInput)({
        threadId: "thread-1",
        fromTurnCount: 3,
        toTurnCount: 1,
        ignoreWhitespace: true,
      }),
    ).toThrow();
  });
});

describe("RuntimeMode", () => {
  it("accepts the auto mode alongside supervised and full access", () => {
    const decode = Schema.decodeUnknownSync(RuntimeMode);
    expect(decode("auto")).toBe("auto");
    expect(decode("approval-required")).toBe("approval-required");
    expect(decode("full-access")).toBe("full-access");
    expect(() => decode("auto-accept-edits")).toThrow();
  });
});

const encodeEvent = (type: string, payload: unknown) => ({
  sequence: 1,
  eventId: "event-1",
  aggregateKind: "project",
  aggregateId: "project-1",
  occurredAt: "2026-01-01T00:00:00.000Z",
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
  type,
  payload,
});

describe("sweep contract additions", () => {
  const decode = <A, I>(schema: Schema.Codec<A, I>, input: unknown): A =>
    Schema.decodeUnknownSync(schema)(input);
  const project = {
    id: "project-1",
    title: "Project",
    workspaceRoot: "/tmp/project",
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
  };

  it("decodes a project persisted before faviconPath and archivedAt", () => {
    const decoded = decode(OrchestrationProject, project);
    expect(decoded.archivedAt).toBeUndefined();
    expect(decoded.faviconPath).toBeUndefined();
  });

  it("decodes a project carrying faviconPath and archivedAt", () => {
    const decoded = decode(OrchestrationProject, {
      ...project,
      faviconPath: "/Users/me/icons/logo.png",
      archivedAt: "2026-02-01T00:00:00.000Z",
    });
    expect(decoded.faviconPath).toBe("/Users/me/icons/logo.png");
    expect(decoded.archivedAt).toBe("2026-02-01T00:00:00.000Z");
  });

  it("decodes old project events and the new meta-update fields", () => {
    const oldCreated = decode(
      OrchestrationEvent,
      encodeEvent("project.created", {
        projectId: "project-1",
        title: "Project",
        workspaceRoot: "/tmp/project",
        defaultModelSelection: null,
        scripts: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    expect(oldCreated.type).toBe("project.created");

    const unarchived = decode(
      OrchestrationEvent,
      encodeEvent("project.meta-updated", {
        projectId: "project-1",
        archivedAt: null,
        faviconPath: null,
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    expect(unarchived.type === "project.meta-updated" && unarchived.payload.archivedAt).toBeNull();
    expect(unarchived.type === "project.meta-updated" && unarchived.payload.faviconPath).toBeNull();
  });

  it("accepts project.meta.update with archivedAt and faviconPath", () => {
    const decoded = decode(ClientOrchestrationCommand, {
      type: "project.meta.update",
      commandId: "command-1",
      projectId: "project-1",
      archivedAt: "2026-02-01T00:00:00.000Z",
      faviconPath: "assets/logo.svg",
    });
    expect(decoded.type).toBe("project.meta.update");
  });

  it("accepts thread.user-input.dismiss from clients", () => {
    const decoded = decode(ClientOrchestrationCommand, {
      type: "thread.user-input.dismiss",
      commandId: "command-1",
      threadId: "thread-1",
      requestId: "request-1",
      createdAt: "2026-02-01T00:00:00.000Z",
    });
    expect(decoded.type).toBe("thread.user-input.dismiss");
  });

  it("decodes an assistant completion with and without attachments", () => {
    const command = {
      type: "thread.message.assistant.complete",
      commandId: "command-1",
      threadId: "thread-1",
      messageId: "assistant:image:item-1",
      createdAt: "2026-02-01T00:00:00.000Z",
    };
    expect(decode(OrchestrationCommand, command).type).toBe("thread.message.assistant.complete");
    const attachment = {
      type: "image",
      id: "image-1",
      name: "image.png",
      mimeType: "image/png",
      sizeBytes: 10,
    };
    expect(decode(OrchestrationCommand, { ...command, attachments: [attachment] })).toMatchObject({
      attachments: [attachment],
    });
  });

  it("limits a favicon path to image extensions", () => {
    expect(decode(ProjectFaviconPath, "/a/b/Logo.JPEG")).toBe("/a/b/Logo.JPEG");
    expect(() => decode(ProjectFaviconPath, "/etc/passwd")).toThrow();
    expect(() => decode(ProjectFaviconPath, "/a/logo.png.txt")).toThrow();
  });

  it("decodes the title regeneration settled event for each outcome", () => {
    for (const outcome of ["updated", "unchanged", "empty", "failed"]) {
      const decoded = decode(
        OrchestrationEvent,
        encodeEvent("thread.title-regeneration-settled", {
          threadId: "thread-1",
          outcome,
          createdAt: "2026-01-01T00:00:00.000Z",
        }),
      );
      expect(decoded.type).toBe("thread.title-regeneration-settled");
    }
    expect(() =>
      decode(
        OrchestrationEvent,
        encodeEvent("thread.title-regeneration-settled", {
          threadId: "thread-1",
          outcome: "other",
          createdAt: "2026-01-01T00:00:00.000Z",
        }),
      ),
    ).toThrow();
  });

  it("accepts title regeneration settling from the server only", () => {
    const command = {
      type: "thread.title.regeneration.settle",
      commandId: "command-1",
      threadId: "thread-1",
      outcome: "updated",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    expect(decode(OrchestrationCommand, command).type).toBe("thread.title.regeneration.settle");
    expect(() => decode(ClientOrchestrationCommand, command)).toThrow();
  });

  it("decodes a checkpoint summary with and without filesTotal", () => {
    const summary = {
      turnId: "turn-1",
      checkpointTurnCount: 1,
      checkpointRef: "refs/piedpiper/1",
      status: "ready",
      files: [],
      assistantMessageId: null,
      completedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(decode(OrchestrationCheckpointSummary, summary).filesTotal).toBeUndefined();
    expect(decode(OrchestrationCheckpointSummary, { ...summary, filesTotal: 450 }).filesTotal).toBe(
      450,
    );
  });

  it("keeps scaffolded commands decodable before they join the dispatch unions", () => {
    const base = {
      commandId: "command-1",
      threadId: "thread-1",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    expect(
      decode(ThreadTitleRegenerationSettleCommand, {
        ...base,
        type: "thread.title.regeneration.settle",
        outcome: "failed",
        detail: "gh failed",
      }).outcome,
    ).toBe("failed");
  });

  it("limits PDF attachments to application/pdf within the size limit", () => {
    const attachment = {
      type: "file",
      id: "file-1",
      name: "spec.pdf",
      mimeType: "application/pdf",
      sizeBytes: PROVIDER_SEND_TURN_MAX_FILE_BYTES,
    };
    expect(decode(ChatFileAttachment, attachment).name).toBe("spec.pdf");
    expect(() => decode(ChatFileAttachment, { ...attachment, mimeType: "text/plain" })).toThrow();
    expect(() =>
      decode(ChatFileAttachment, {
        ...attachment,
        sizeBytes: PROVIDER_SEND_TURN_MAX_FILE_BYTES + 1,
      }),
    ).toThrow();
    expect(
      decode(UploadChatFileAttachment, {
        type: "file",
        name: "spec.pdf",
        mimeType: "application/pdf",
        sizeBytes: 4,
        dataUrl: "data:application/pdf;base64,JVBERg==",
      }).sizeBytes,
    ).toBe(4);
  });

  it("decodes the usage limit and goal activity payloads", () => {
    expect(THREAD_USAGE_LIMIT_ACTIVITY_KIND).toBe("turn.usage-limit-reached");
    expect(THREAD_USAGE_LIMIT_RESUME_CANCELLED_ACTIVITY_KIND).toBe(
      "turn.usage-limit-resume-cancelled",
    );
    expect(
      decode(ClientOrchestrationCommand, {
        type: "thread.usage-limit-resume.cancel",
        commandId: "cmd-1",
        threadId: "thread-1",
        turnId: "turn-1",
        createdAt: "2026-01-01T00:00:00.000Z",
      }).type,
    ).toBe("thread.usage-limit-resume.cancel");
    expect(decode(ThreadUsageLimitActivityPayload, { resetAt: null }).resetAt).toBeNull();
    expect(THREAD_GOAL_ACTIVITY_KIND).toBe("goal.updated");
    expect(decode(ThreadGoalActivityPayload, { goal: null }).goal).toBeNull();
    expect(
      decode(ThreadGoalActivityPayload, { goal: { objective: "Ship it", status: "active" } }).goal
        ?.objective,
    ).toBe("Ship it");
    expect(() => decode(ProviderGoal, { objective: "Ship it", status: "not-a-status" })).toThrow();
  });
});

describe("getTurnDiffFileContents", () => {
  const range = { threadId: "thread-1", fromTurnCount: 1, toTurnCount: 2 };

  it("keeps a path's surrounding spaces and an optional previous path", () => {
    const decoded = Schema.decodeUnknownSync(OrchestrationGetTurnDiffFileContentsInput)({
      ...range,
      path: " spaced name.txt ",
      previousPath: "old.txt",
    });
    expect(decoded.path).toBe(" spaced name.txt ");
    expect(decoded.previousPath).toBe("old.txt");
    expect(
      Schema.decodeUnknownSync(OrchestrationGetTurnDiffFileContentsInput)({
        ...range,
        path: "a.txt",
      }),
    ).not.toHaveProperty("previousPath");
  });

  it("rejects an inverted turn range", () => {
    expect(() =>
      Schema.decodeUnknownSync(OrchestrationGetTurnDiffFileContentsInput)({
        threadId: "thread-1",
        fromTurnCount: 3,
        toTurnCount: 2,
        path: "a.txt",
      }),
    ).toThrow();
  });

  it("decodes results with absent sides and only the known unavailable reasons", () => {
    const result = {
      ...range,
      path: "a.txt",
      oldContents: null,
      newContents: "new",
      unavailableReason: null,
    };
    expect(Schema.decodeUnknownSync(OrchestrationGetTurnDiffFileContentsResult)(result)).toEqual(
      result,
    );
    expect(
      Schema.decodeUnknownSync(OrchestrationGetTurnDiffFileContentsResult)({
        ...result,
        newContents: null,
        unavailableReason: "too-large",
      }).unavailableReason,
    ).toBe("too-large");
    expect(() =>
      Schema.decodeUnknownSync(OrchestrationGetTurnDiffFileContentsResult)({
        ...result,
        unavailableReason: "missing",
      }),
    ).toThrow();
  });
});

describe("checkpoint line totals", () => {
  const checkpoint = {
    turnId: "turn-1",
    checkpointTurnCount: 1,
    checkpointRef: "refs/piedpiper/checkpoint/1",
    status: "ready",
    files: [],
    assistantMessageId: null,
    completedAt: "2026-01-01T00:00:00.000Z",
  };

  it("keeps the capped totals on summaries and turn-diff events", () => {
    const totals = { filesTotal: 300, additionsTotal: 12, deletionsTotal: 4 };
    expect(
      Schema.decodeUnknownSync(OrchestrationCheckpointSummary)({ ...checkpoint, ...totals }),
    ).toMatchObject(totals);
    expect(
      Schema.decodeUnknownSync(ThreadTurnDiffCompletedPayload)({
        ...checkpoint,
        ...totals,
        threadId: "thread-1",
      }),
    ).toMatchObject(totals);
  });

  it("still decodes checkpoints without totals", () => {
    const decoded = Schema.decodeUnknownSync(OrchestrationCheckpointSummary)(checkpoint);
    expect(decoded.additionsTotal).toBeUndefined();
    expect(decoded.deletionsTotal).toBeUndefined();
  });
});
