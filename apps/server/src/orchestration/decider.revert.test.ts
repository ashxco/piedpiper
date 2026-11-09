import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProjectId,
  ThreadId,
} from "@piedpiper/contracts";
import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const threadId = ThreadId.makeUnsafe("thread-revert");

async function readModelWithThread() {
  const now = new Date().toISOString();
  const withProject = await Effect.runPromise(
    projectEvent(createEmptyReadModel(now), {
      sequence: 1,
      eventId: EventId.makeUnsafe("evt-project-revert"),
      aggregateKind: "project",
      aggregateId: ProjectId.makeUnsafe("project-revert"),
      type: "project.created",
      occurredAt: now,
      commandId: CommandId.makeUnsafe("cmd-project-revert"),
      causationEventId: null,
      correlationId: CommandId.makeUnsafe("cmd-project-revert"),
      metadata: {},
      payload: {
        projectId: ProjectId.makeUnsafe("project-revert"),
        title: "Revert",
        workspaceRoot: "/tmp/revert",
        defaultModelSelection: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
      },
    }),
  );
  return Effect.runPromise(
    projectEvent(withProject, {
      sequence: 2,
      eventId: EventId.makeUnsafe("evt-thread-revert"),
      aggregateKind: "thread",
      aggregateId: threadId,
      type: "thread.created",
      occurredAt: now,
      commandId: CommandId.makeUnsafe("cmd-thread-revert"),
      causationEventId: null,
      correlationId: CommandId.makeUnsafe("cmd-thread-revert"),
      metadata: {},
      payload: {
        threadId,
        projectId: ProjectId.makeUnsafe("project-revert"),
        title: "Thread",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: now,
        updatedAt: now,
      },
    }),
  );
}

async function decideRevert(restoreFiles?: boolean) {
  const readModel = await readModelWithThread();
  const result = await Effect.runPromise(
    decideOrchestrationCommand({
      command: {
        type: "thread.checkpoint.revert",
        commandId: CommandId.makeUnsafe("cmd-revert"),
        threadId,
        turnCount: 1,
        ...(restoreFiles !== undefined ? { restoreFiles } : {}),
        createdAt: new Date().toISOString(),
      },
      readModel,
    }),
  );
  const event = Array.isArray(result) ? result[0] : result;
  expect(event?.type).toBe("thread.checkpoint-revert-requested");
  return event?.payload as { readonly turnCount: number; readonly restoreFiles?: boolean };
}

describe("decider checkpoint revert", () => {
  it("omits restoreFiles for a normal revert, which restores files", async () => {
    const payload = await decideRevert();
    expect(payload.turnCount).toBe(1);
    expect("restoreFiles" in payload).toBe(false);
  });

  it("carries restoreFiles false for a conversation-only rewind", async () => {
    const payload = await decideRevert(false);
    expect(payload.restoreFiles).toBe(false);
  });
});
