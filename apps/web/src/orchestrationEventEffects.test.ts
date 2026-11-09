import {
  CheckpointRef,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
} from "@piedpiper/contracts";
import { describe, expect, it } from "vitest";

import { deriveOrchestrationBatchEffects, resolveThreadGitCwds } from "./orchestrationEventEffects";

function makeEvent<T extends OrchestrationEvent["type"]>(
  type: T,
  payload: Extract<OrchestrationEvent, { type: T }>["payload"],
  overrides: Partial<Extract<OrchestrationEvent, { type: T }>> = {},
): Extract<OrchestrationEvent, { type: T }> {
  const sequence = overrides.sequence ?? 1;
  return {
    sequence,
    eventId: EventId.makeUnsafe(`event-${sequence}`),
    aggregateKind: "thread",
    aggregateId:
      "threadId" in payload
        ? payload.threadId
        : "projectId" in payload
          ? payload.projectId
          : ProjectId.makeUnsafe("project-1"),
    occurredAt: "2026-02-27T00:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type,
    payload,
    ...overrides,
  } as Extract<OrchestrationEvent, { type: T }>;
}

describe("deriveOrchestrationBatchEffects", () => {
  it("targets draft promotion and terminal cleanup from thread lifecycle events", () => {
    const createdThreadId = ThreadId.makeUnsafe("thread-created");
    const deletedThreadId = ThreadId.makeUnsafe("thread-deleted");
    const archivedThreadId = ThreadId.makeUnsafe("thread-archived");

    const effects = deriveOrchestrationBatchEffects([
      makeEvent("thread.created", {
        threadId: createdThreadId,
        projectId: ProjectId.makeUnsafe("project-1"),
        title: "Created thread",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        runtimeMode: "full-access",
        interactionMode: "default",
        systemPrompt: null,
        branch: null,
        worktreePath: null,
        createdAt: "2026-02-27T00:00:00.000Z",
        updatedAt: "2026-02-27T00:00:00.000Z",
      }),
      makeEvent("thread.deleted", {
        threadId: deletedThreadId,
        deletedAt: "2026-02-27T00:00:01.000Z",
      }),
      makeEvent("thread.archived", {
        threadId: archivedThreadId,
        archivedAt: "2026-02-27T00:00:02.000Z",
        updatedAt: "2026-02-27T00:00:02.000Z",
      }),
    ]);

    expect(effects.clearPromotedDraftThreadIds).toEqual([createdThreadId]);
    expect(effects.clearDeletedThreadIds).toEqual([deletedThreadId]);
    expect(effects.removeTerminalStateThreadIds).toEqual([deletedThreadId, archivedThreadId]);
    expect(effects.needsProviderInvalidation).toBe(false);
  });

  it("keeps only the final lifecycle outcome for a thread within one batch", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");

    const effects = deriveOrchestrationBatchEffects([
      makeEvent("thread.deleted", {
        threadId,
        deletedAt: "2026-02-27T00:00:01.000Z",
      }),
      makeEvent("thread.created", {
        threadId,
        projectId: ProjectId.makeUnsafe("project-1"),
        title: "Recreated thread",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        runtimeMode: "full-access",
        interactionMode: "default",
        systemPrompt: null,
        branch: null,
        worktreePath: null,
        createdAt: "2026-02-27T00:00:02.000Z",
        updatedAt: "2026-02-27T00:00:02.000Z",
      }),
      makeEvent("thread.turn-diff-completed", {
        threadId,
        turnId: TurnId.makeUnsafe("turn-1"),
        checkpointTurnCount: 1,
        checkpointRef: CheckpointRef.makeUnsafe("checkpoint-1"),
        status: "ready",
        files: [],
        assistantMessageId: MessageId.makeUnsafe("assistant-1"),
        completedAt: "2026-02-27T00:00:03.000Z",
      }),
    ]);

    expect(effects.clearPromotedDraftThreadIds).toEqual([threadId]);
    expect(effects.clearDeletedThreadIds).toEqual([]);
    expect(effects.removeTerminalStateThreadIds).toEqual([]);
    expect(effects.needsProviderInvalidation).toBe(true);
  });

  it("does not retain archive cleanup when a thread is unarchived later in the same batch", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");

    const effects = deriveOrchestrationBatchEffects([
      makeEvent("thread.archived", {
        threadId,
        archivedAt: "2026-02-27T00:00:01.000Z",
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
      makeEvent("thread.unarchived", {
        threadId,
        updatedAt: "2026-02-27T00:00:02.000Z",
      }),
    ]);

    expect(effects.clearPromotedDraftThreadIds).toEqual([]);
    expect(effects.clearDeletedThreadIds).toEqual([]);
    expect(effects.removeTerminalStateThreadIds).toEqual([]);
  });

  it("collects threads whose git status changed from turn diffs, reverts and branch updates", () => {
    const diffThreadId = ThreadId.makeUnsafe("thread-diff");
    const revertedThreadId = ThreadId.makeUnsafe("thread-reverted");
    const renamedThreadId = ThreadId.makeUnsafe("thread-renamed");
    const titledThreadId = ThreadId.makeUnsafe("thread-titled");

    const effects = deriveOrchestrationBatchEffects([
      makeEvent("thread.turn-diff-completed", {
        threadId: diffThreadId,
        turnId: TurnId.makeUnsafe("turn-1"),
        checkpointTurnCount: 1,
        checkpointRef: CheckpointRef.makeUnsafe("checkpoint-1"),
        status: "ready",
        files: [],
        assistantMessageId: MessageId.makeUnsafe("assistant-1"),
        completedAt: "2026-02-27T00:00:03.000Z",
      }),
      makeEvent("thread.reverted", {
        threadId: revertedThreadId,
        turnCount: 0,
      }),
      makeEvent("thread.meta-updated", {
        threadId: renamedThreadId,
        branch: "feature/renamed",
        updatedAt: "2026-02-27T00:00:04.000Z",
      }),
      makeEvent("thread.meta-updated", {
        threadId: titledThreadId,
        title: "Only a title",
        updatedAt: "2026-02-27T00:00:05.000Z",
      }),
      makeEvent("thread.turn-diff-completed", {
        threadId: diffThreadId,
        turnId: TurnId.makeUnsafe("turn-2"),
        checkpointTurnCount: 2,
        checkpointRef: CheckpointRef.makeUnsafe("checkpoint-2"),
        status: "ready",
        files: [],
        assistantMessageId: MessageId.makeUnsafe("assistant-2"),
        completedAt: "2026-02-27T00:00:06.000Z",
      }),
    ]);

    expect(effects.gitStatusInvalidationThreadIds).toEqual([diffThreadId, revertedThreadId]);
    expect(effects.gitBranchInvalidationThreadIds).toEqual([renamedThreadId]);
  });

  it("lists a thread with both a turn diff and a branch change only for the branch refresh", () => {
    const threadId = ThreadId.makeUnsafe("thread-both");
    const effects = deriveOrchestrationBatchEffects([
      makeEvent("thread.reverted", { threadId, turnCount: 0 }),
      makeEvent("thread.meta-updated", {
        threadId,
        worktreePath: "/repo-wt",
        updatedAt: "2026-02-27T00:00:04.000Z",
      }),
    ]);

    expect(effects.gitStatusInvalidationThreadIds).toEqual([]);
    expect(effects.gitBranchInvalidationThreadIds).toEqual([threadId]);
  });
});

describe("resolveThreadGitCwds", () => {
  it("uses the worktree path, falls back to the project cwd and dedupes", () => {
    const projectId = ProjectId.makeUnsafe("project-1");
    const cwds = resolveThreadGitCwds(
      [
        ThreadId.makeUnsafe("thread-worktree"),
        ThreadId.makeUnsafe("thread-local"),
        ThreadId.makeUnsafe("thread-local-2"),
        ThreadId.makeUnsafe("thread-missing"),
      ],
      [
        { id: ThreadId.makeUnsafe("thread-worktree"), projectId, worktreePath: "/repo-wt" },
        { id: ThreadId.makeUnsafe("thread-local"), projectId, worktreePath: null },
        { id: ThreadId.makeUnsafe("thread-local-2"), projectId, worktreePath: null },
      ],
      [{ id: projectId, cwd: "/repo" }],
    );
    expect(cwds).toEqual(["/repo-wt", "/repo"]);
  });
});
