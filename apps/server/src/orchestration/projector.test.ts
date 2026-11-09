import {
  CommandId,
  EventId,
  ProjectId,
  RuntimeTaskId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
} from "@piedpiper/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { hasLiveBackgroundTask } from "../provider/Layers/ProviderSessionReaper.ts";
import { runtimeEventToActivities } from "./Layers/RuntimeNormalizer.ts";
import { capThreadActivities, createEmptyReadModel, projectEvent } from "./projector.ts";

function makeEvent(input: {
  sequence: number;
  type: OrchestrationEvent["type"];
  occurredAt: string;
  aggregateKind: OrchestrationEvent["aggregateKind"];
  aggregateId: string;
  commandId: string | null;
  payload: unknown;
}): OrchestrationEvent {
  return {
    sequence: input.sequence,
    eventId: EventId.makeUnsafe(`event-${input.sequence}`),
    type: input.type,
    aggregateKind: input.aggregateKind,
    aggregateId:
      input.aggregateKind === "project"
        ? ProjectId.makeUnsafe(input.aggregateId)
        : ThreadId.makeUnsafe(input.aggregateId),
    occurredAt: input.occurredAt,
    commandId: input.commandId === null ? null : CommandId.makeUnsafe(input.commandId),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: input.payload as never,
  } as OrchestrationEvent;
}

const padding = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ id: `tool-${index}`, kind: "tool.completed" }));

describe("capThreadActivities", () => {
  it("keeps the newest goal rows past the activity window, in a window of their own", () => {
    const goals = Array.from({ length: 25 }, (_, index) => ({
      id: `goal-${index}`,
      kind: "goal.updated",
    }));
    const kept = capThreadActivities([...goals, ...padding(600)]).map((activity) => activity.id);
    expect(kept).toContain("goal-24");
    expect(kept).not.toContain("goal-0");
    expect(kept.filter((id) => id.startsWith("goal-"))).toHaveLength(20);
    expect(kept.filter((id) => id.startsWith("tool-"))).toHaveLength(500);
  });

  it("keeps the start of a running task, including a restarted id, but not a finished one", () => {
    const kept = capThreadActivities([
      { id: "running", kind: "task.started", payload: { taskId: "a" } },
      { id: "finished", kind: "task.started", payload: { taskId: "b" } },
      { id: "finished-end", kind: "task.completed", payload: { taskId: "b" } },
      { id: "first-run", kind: "task.started", payload: { taskId: "c" } },
      { id: "first-end", kind: "task.completed", payload: { taskId: "c" } },
      { id: "second-run", kind: "task.started", payload: { taskId: "c" } },
      ...padding(600),
    ]).map((activity) => activity.id);
    expect(kept).toContain("running");
    expect(kept).toContain("second-run");
    expect(kept).not.toContain("finished");
    expect(kept).not.toContain("first-run");
  });

  it("keeps open non-blocking questions and held answers past the activity window", () => {
    const activities = [
      {
        id: "question",
        kind: "user-input.requested",
        payload: { requestId: "open", responseMode: "message" },
      },
      {
        id: "answered-question",
        kind: "user-input.requested",
        payload: { requestId: "r", responseMode: "message" },
      },
      { id: "held", kind: "user-input.resolved", payload: { requestId: "r", held: true } },
      {
        id: "dismissed-question",
        kind: "user-input.requested",
        payload: { requestId: "d", responseMode: "message" },
      },
      {
        id: "dismissed",
        kind: "user-input.resolved",
        payload: { requestId: "d", responseMode: "message" },
      },
      { id: "blocking", kind: "user-input.requested", payload: { requestId: "b" } },
      { id: "answered", kind: "user-input.resolved", payload: { requestId: "b" } },
      ...Array.from({ length: 500 }, (_, index) => ({
        id: `tool-${index}`,
        kind: "tool.completed",
        payload: {},
      })),
    ];
    const ids = capThreadActivities(activities).map((activity) => activity.id);
    expect(ids).toHaveLength(502);
    expect(ids.slice(0, 2)).toEqual(["question", "held"]);
  });

  it("keeps model-switch dividers that fall outside the activity window", () => {
    const activities = [
      { id: "switch-old", kind: "turn.model-switched" },
      ...Array.from({ length: 501 }, (_, index) => ({
        id: `tool-${index}`,
        kind: "tool.completed",
      })),
    ];
    const capped = capThreadActivities(activities);
    expect(capped).toHaveLength(501);
    expect(capped[0]?.id).toBe("switch-old");
    expect(capped[1]?.id).toBe("tool-1");
    expect(capped.at(-1)?.id).toBe("tool-500");
  });

  it("gives thinking blocks their own window so they never evict tool rows", () => {
    const activities = [
      ...Array.from({ length: 500 }, (_, index) => ({
        id: `tool-${index}`,
        kind: "tool.completed",
      })),
      ...Array.from({ length: 250 }, (_, index) => ({
        id: `thought-${index}`,
        kind: "reasoning.block",
      })),
    ];
    const capped = capThreadActivities(activities);
    expect(capped.filter((entry) => entry.kind === "tool.completed")).toHaveLength(500);
    const thoughts = capped.filter((entry) => entry.kind === "reasoning.block");
    expect(thoughts).toHaveLength(200);
    expect(thoughts[0]?.id).toBe("thought-50");
    expect(capThreadActivities(activities.slice(-150))).toHaveLength(150);
  });
});

describe("task progress rows", () => {
  it("keeps task.started and the task's liveness through 600 progress ticks", async () => {
    const createdAt = "2026-02-23T10:00:00.000Z";
    const threadId = ThreadId.makeUnsafe("thread-1");
    const activityEvent = (sequence: number, activity: unknown) =>
      makeEvent({
        sequence,
        type: "thread.activity-appended",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: createdAt,
        commandId: `cmd-activity-${sequence}`,
        payload: { threadId, activity },
      });
    const runtimeBase = {
      provider: "claudeAgent" as const,
      threadId,
      turnId: TurnId.makeUnsafe("turn-1"),
    };
    let state = await Effect.runPromise(
      projectEvent(
        createEmptyReadModel(createdAt),
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: createdAt,
          commandId: "cmd-create",
          payload: {
            threadId,
            projectId: "project-1",
            title: "demo",
            modelSelection: { provider: "claudeAgent", model: "claude-sonnet-4-5" },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );
    const [started] = runtimeEventToActivities({
      ...runtimeBase,
      type: "task.started",
      eventId: EventId.makeUnsafe("evt-started"),
      createdAt,
      payload: { taskId: RuntimeTaskId.makeUnsafe("task-1"), description: "Subagent" },
    });
    state = await Effect.runPromise(projectEvent(state, activityEvent(2, started)));

    let lastTickAt = createdAt;
    for (let tick = 0; tick < 600; tick += 1) {
      lastTickAt = new Date(Date.parse(createdAt) + (tick + 1) * 1000).toISOString();
      const [progress] = runtimeEventToActivities({
        ...runtimeBase,
        type: "task.progress",
        eventId: EventId.makeUnsafe(`evt-tick-${tick}`),
        createdAt: lastTickAt,
        payload: { taskId: RuntimeTaskId.makeUnsafe("task-1"), description: "Subagent" },
      });
      state = await Effect.runPromise(projectEvent(state, activityEvent(tick + 3, progress)));
    }

    const thread = state.threads.get(threadId)!;
    expect(thread.activities.map((activity) => activity.kind)).toEqual([
      "task.started",
      "task.progress",
    ]);
    expect(thread.activities[1]?.createdAt).toBe(lastTickAt);
    expect(
      hasLiveBackgroundTask(
        thread,
        { provider: "claudeAgent", createdAt },
        Date.parse(lastTickAt) + 1000,
      ),
    ).toBe(true);
  });
});

describe("orchestration projector", () => {
  it("applies thread.created events", async () => {
    const now = new Date().toISOString();
    const model = createEmptyReadModel(now);

    const next = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: now,
          commandId: "cmd-thread-create",
          payload: {
            threadId: "thread-1",
            projectId: "project-1",
            title: "demo",
            modelSelection: {
              provider: "codex",
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt: now,
            updatedAt: now,
          },
        }),
      ),
    );

    expect(next.snapshotSequence).toBe(1);
    expect([...next.threads.values()]).toEqual([
      {
        id: "thread-1",
        projectId: "project-1",
        title: "demo",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
      },
    ]);
  });

  it("fails when event payload cannot be decoded by runtime schema", async () => {
    const now = new Date().toISOString();
    const model = createEmptyReadModel(now);

    await expect(
      Effect.runPromise(
        projectEvent(
          model,
          makeEvent({
            sequence: 1,
            type: "thread.created",
            aggregateKind: "thread",
            aggregateId: "thread-1",
            occurredAt: now,
            commandId: "cmd-invalid",
            payload: {
              // missing required threadId
              projectId: "project-1",
              title: "demo",
              modelSelection: {
                provider: "codex",
                model: "gpt-5-codex",
              },
              branch: null,
              worktreePath: null,
              createdAt: now,
              updatedAt: now,
            },
          }),
        ),
      ),
    ).rejects.toBeDefined();
  });

  it("applies thread.archived and thread.unarchived events", async () => {
    const now = new Date().toISOString();
    const later = new Date(Date.parse(now) + 1_000).toISOString();
    const created = await Effect.runPromise(
      projectEvent(
        createEmptyReadModel(now),
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: now,
          commandId: "cmd-thread-create",
          payload: {
            threadId: "thread-1",
            projectId: "project-1",
            title: "demo",
            modelSelection: {
              provider: "codex",
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: now,
            updatedAt: now,
          },
        }),
      ),
    );

    const archived = await Effect.runPromise(
      projectEvent(
        created,
        makeEvent({
          sequence: 2,
          type: "thread.archived",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: later,
          commandId: "cmd-thread-archive",
          payload: {
            threadId: "thread-1",
            archivedAt: later,
            updatedAt: later,
          },
        }),
      ),
    );
    expect([...archived.threads.values()][0]?.archivedAt).toBe(later);

    const unarchived = await Effect.runPromise(
      projectEvent(
        archived,
        makeEvent({
          sequence: 3,
          type: "thread.unarchived",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: later,
          commandId: "cmd-thread-unarchive",
          payload: {
            threadId: "thread-1",
            updatedAt: later,
          },
        }),
      ),
    );
    expect([...unarchived.threads.values()][0]?.archivedAt).toBeNull();
  });

  it("keeps projector forward-compatible for unhandled event types", async () => {
    const now = new Date().toISOString();
    const model = createEmptyReadModel(now);

    const next = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 7,
          type: "thread.turn-start-requested",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: "2026-01-01T00:00:00.000Z",
          commandId: "cmd-unhandled",
          payload: {
            threadId: "thread-1",
            messageId: "message-1",
            runtimeMode: "approval-required",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        }),
      ),
    );

    expect(next.snapshotSequence).toBe(7);
    expect(next.updatedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(next.threads.size).toBe(0);
  });

  it("tracks latest turn id from session lifecycle events", async () => {
    const createdAt = "2026-02-23T08:00:00.000Z";
    const startedAt = "2026-02-23T08:00:05.000Z";
    const model = createEmptyReadModel(createdAt);

    const afterCreate = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: createdAt,
          commandId: "cmd-create",
          payload: {
            threadId: "thread-1",
            projectId: "project-1",
            title: "demo",
            modelSelection: {
              provider: "codex",
              model: "gpt-5.3-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );

    const afterRunning = await Effect.runPromise(
      projectEvent(
        afterCreate,
        makeEvent({
          sequence: 2,
          type: "thread.session-set",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: startedAt,
          commandId: "cmd-running",
          payload: {
            threadId: "thread-1",
            session: {
              threadId: "thread-1",
              status: "running",
              providerName: "codex",
              providerSessionId: "session-1",
              providerThreadId: "provider-thread-1",
              runtimeMode: "approval-required",
              activeTurnId: "turn-1",
              lastError: null,
              updatedAt: startedAt,
            },
          },
        }),
      ),
    );

    const thread = [...afterRunning.threads.values()][0];
    expect(thread?.latestTurn?.turnId).toBe("turn-1");
    expect(thread?.session?.status).toBe("running");
  });

  it("updates canonical thread runtime mode from thread.runtime-mode-set", async () => {
    const createdAt = "2026-02-23T08:00:00.000Z";
    const updatedAt = "2026-02-23T08:00:05.000Z";
    const model = createEmptyReadModel(createdAt);

    const afterCreate = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: createdAt,
          commandId: "cmd-create",
          payload: {
            threadId: "thread-1",
            projectId: "project-1",
            title: "demo",
            modelSelection: {
              provider: "codex",
              model: "gpt-5.3-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );

    const afterUpdate = await Effect.runPromise(
      projectEvent(
        afterCreate,
        makeEvent({
          sequence: 2,
          type: "thread.runtime-mode-set",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: updatedAt,
          commandId: "cmd-runtime-mode-set",
          payload: {
            threadId: "thread-1",
            runtimeMode: "approval-required",
            updatedAt,
          },
        }),
      ),
    );

    expect([...afterUpdate.threads.values()][0]?.runtimeMode).toBe("approval-required");
    expect([...afterUpdate.threads.values()][0]?.updatedAt).toBe(updatedAt);
  });

  it("marks assistant messages completed with non-streaming updates", async () => {
    const createdAt = "2026-02-23T09:00:00.000Z";
    const deltaAt = "2026-02-23T09:00:01.000Z";
    const completeAt = "2026-02-23T09:00:03.500Z";
    const model = createEmptyReadModel(createdAt);

    const afterCreate = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: createdAt,
          commandId: "cmd-create",
          payload: {
            threadId: "thread-1",
            projectId: "project-1",
            title: "demo",
            modelSelection: {
              provider: "codex",
              model: "gpt-5.3-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );

    const afterDelta = await Effect.runPromise(
      projectEvent(
        afterCreate,
        makeEvent({
          sequence: 2,
          type: "thread.message-sent",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: deltaAt,
          commandId: "cmd-delta",
          payload: {
            threadId: "thread-1",
            messageId: "assistant:msg-1",
            role: "assistant",
            text: "hello",
            turnId: "turn-1",
            streaming: true,
            createdAt: deltaAt,
            updatedAt: deltaAt,
          },
        }),
      ),
    );

    const afterComplete = await Effect.runPromise(
      projectEvent(
        afterDelta,
        makeEvent({
          sequence: 3,
          type: "thread.message-sent",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: completeAt,
          commandId: "cmd-complete",
          payload: {
            threadId: "thread-1",
            messageId: "assistant:msg-1",
            role: "assistant",
            text: "",
            turnId: "turn-1",
            streaming: false,
            createdAt: completeAt,
            updatedAt: completeAt,
          },
        }),
      ),
    );

    const message = [...afterComplete.threads.values()][0]?.messages[0];
    expect(message?.id).toBe("assistant:msg-1");
    expect(message?.text).toBe("hello");
    expect(message?.streaming).toBe(false);
    expect(message?.updatedAt).toBe(completeAt);
  });

  it("prunes reverted turn messages from in-memory thread snapshot", async () => {
    const createdAt = "2026-02-23T10:00:00.000Z";
    const model = createEmptyReadModel(createdAt);

    const afterCreate = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: createdAt,
          commandId: "cmd-create",
          payload: {
            threadId: "thread-1",
            projectId: "project-1",
            title: "demo",
            modelSelection: {
              provider: "codex",
              model: "gpt-5.3-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );

    const events: ReadonlyArray<OrchestrationEvent> = [
      makeEvent({
        sequence: 2,
        type: "thread.message-sent",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: "2026-02-23T10:00:01.000Z",
        commandId: "cmd-user-1",
        payload: {
          threadId: "thread-1",
          messageId: "user-msg-1",
          role: "user",
          text: "First edit",
          turnId: null,
          streaming: false,
          createdAt: "2026-02-23T10:00:01.000Z",
          updatedAt: "2026-02-23T10:00:01.000Z",
        },
      }),
      makeEvent({
        sequence: 3,
        type: "thread.message-sent",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: "2026-02-23T10:00:02.000Z",
        commandId: "cmd-assistant-1",
        payload: {
          threadId: "thread-1",
          messageId: "assistant-msg-1",
          role: "assistant",
          text: "Updated README to v2.\n",
          turnId: "turn-1",
          streaming: false,
          createdAt: "2026-02-23T10:00:02.000Z",
          updatedAt: "2026-02-23T10:00:02.000Z",
        },
      }),
      makeEvent({
        sequence: 4,
        type: "thread.turn-diff-completed",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: "2026-02-23T10:00:02.500Z",
        commandId: "cmd-turn-1-complete",
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          checkpointTurnCount: 1,
          checkpointRef: "refs/piedpiper/checkpoints/thread-1/turn/1",
          status: "ready",
          files: [],
          assistantMessageId: "assistant-msg-1",
          completedAt: "2026-02-23T10:00:02.500Z",
        },
      }),
      makeEvent({
        sequence: 5,
        type: "thread.activity-appended",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: "2026-02-23T10:00:02.750Z",
        commandId: "cmd-activity-1",
        payload: {
          threadId: "thread-1",
          activity: {
            id: "activity-1",
            tone: "tool",
            kind: "tool.started",
            summary: "Edit file started",
            payload: { toolKind: "command" },
            turnId: "turn-1",
            createdAt: "2026-02-23T10:00:02.750Z",
          },
        },
      }),
      makeEvent({
        sequence: 6,
        type: "thread.message-sent",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: "2026-02-23T10:00:03.000Z",
        commandId: "cmd-user-2",
        payload: {
          threadId: "thread-1",
          messageId: "user-msg-2",
          role: "user",
          text: "Second edit",
          turnId: null,
          streaming: false,
          createdAt: "2026-02-23T10:00:03.000Z",
          updatedAt: "2026-02-23T10:00:03.000Z",
        },
      }),
      makeEvent({
        sequence: 7,
        type: "thread.message-sent",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: "2026-02-23T10:00:04.000Z",
        commandId: "cmd-assistant-2",
        payload: {
          threadId: "thread-1",
          messageId: "assistant-msg-2",
          role: "assistant",
          text: "Updated README to v3.\n",
          turnId: "turn-2",
          streaming: false,
          createdAt: "2026-02-23T10:00:04.000Z",
          updatedAt: "2026-02-23T10:00:04.000Z",
        },
      }),
      makeEvent({
        sequence: 8,
        type: "thread.turn-diff-completed",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: "2026-02-23T10:00:04.500Z",
        commandId: "cmd-turn-2-complete",
        payload: {
          threadId: "thread-1",
          turnId: "turn-2",
          checkpointTurnCount: 2,
          checkpointRef: "refs/piedpiper/checkpoints/thread-1/turn/2",
          status: "ready",
          files: [],
          assistantMessageId: "assistant-msg-2",
          completedAt: "2026-02-23T10:00:04.500Z",
        },
      }),
      makeEvent({
        sequence: 9,
        type: "thread.activity-appended",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: "2026-02-23T10:00:04.750Z",
        commandId: "cmd-activity-2",
        payload: {
          threadId: "thread-1",
          activity: {
            id: "activity-2",
            tone: "tool",
            kind: "tool.completed",
            summary: "Edit file complete",
            payload: { toolKind: "command" },
            turnId: "turn-2",
            createdAt: "2026-02-23T10:00:04.750Z",
          },
        },
      }),
      makeEvent({
        sequence: 10,
        type: "thread.reverted",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: "2026-02-23T10:00:05.000Z",
        commandId: "cmd-revert",
        payload: {
          threadId: "thread-1",
          turnCount: 1,
        },
      }),
    ];

    const afterRevert = await events.reduce<Promise<ReturnType<typeof createEmptyReadModel>>>(
      (statePromise, event) =>
        statePromise.then((state) => Effect.runPromise(projectEvent(state, event))),
      Promise.resolve(afterCreate),
    );

    const thread = [...afterRevert.threads.values()][0];
    expect(thread?.messages.map((message) => ({ role: message.role, text: message.text }))).toEqual(
      [
        { role: "user", text: "First edit" },
        { role: "assistant", text: "Updated README to v2.\n" },
      ],
    );
    expect(
      thread?.activities.map((activity) => ({ id: activity.id, turnId: activity.turnId })),
    ).toEqual([{ id: "activity-1", turnId: "turn-1" }]);
    expect(thread?.checkpoints.map((checkpoint) => checkpoint.checkpointTurnCount)).toEqual([1]);
    expect(thread?.latestTurn?.turnId).toBe("turn-1");
  });

  it("marks a turn completed when its real checkpoint replaces a missing placeholder", async () => {
    const createdAt = "2026-02-23T10:00:00.000Z";
    const diffEvent = (sequence: number, status: "missing" | "ready", checkpointRef: string) =>
      makeEvent({
        sequence,
        type: "thread.turn-diff-completed",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: `2026-02-23T10:00:0${sequence}.000Z`,
        commandId: `cmd-diff-${sequence}`,
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          checkpointTurnCount: 1,
          checkpointRef,
          status,
          files: [],
          assistantMessageId: "assistant-msg-1",
          completedAt: `2026-02-23T10:00:0${sequence}.000Z`,
        },
      });
    const events = [
      makeEvent({
        sequence: 1,
        type: "thread.created",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: createdAt,
        commandId: "cmd-create",
        payload: {
          threadId: "thread-1",
          projectId: "project-1",
          title: "demo",
          modelSelection: { provider: "codex", model: "gpt-5.3-codex" },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt,
          updatedAt: createdAt,
        },
      }),
      diffEvent(2, "missing", "provider-diff:evt-1"),
      diffEvent(3, "ready", "refs/piedpiper/checkpoints/thread-1/turn/1"),
    ];

    const afterEvents = await events.reduce<Promise<ReturnType<typeof createEmptyReadModel>>>(
      (statePromise, event) =>
        statePromise.then((state) => Effect.runPromise(projectEvent(state, event))),
      Promise.resolve(createEmptyReadModel(createdAt)),
    );

    const thread = [...afterEvents.threads.values()][0];
    expect(thread?.latestTurn?.state).toBe("completed");
    expect(thread?.checkpoints.map((checkpoint) => checkpoint.status)).toEqual(["ready"]);
  });

  it("keeps a turn running through a mid-turn diff, then settles it at the session's time", async () => {
    const createdAt = "2026-02-23T12:00:00.000Z";
    const events = [
      makeEvent({
        sequence: 1,
        type: "thread.created",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: createdAt,
        commandId: "cmd-create",
        payload: {
          threadId: "thread-1",
          projectId: "project-1",
          title: "demo",
          modelSelection: { provider: "codex", model: "gpt-5.3-codex" },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt,
          updatedAt: createdAt,
        },
      }),
      makeEvent({
        sequence: 2,
        type: "thread.session-set",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: "2026-02-23T12:00:01.000Z",
        commandId: "cmd-running",
        payload: {
          threadId: "thread-1",
          session: {
            threadId: "thread-1",
            status: "running",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: "turn-1",
            lastError: null,
            updatedAt: "2026-02-23T12:00:01.000Z",
          },
        },
      }),
      makeEvent({
        sequence: 3,
        type: "thread.turn-diff-completed",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: "2026-02-23T12:00:02.000Z",
        commandId: "cmd-diff",
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          checkpointTurnCount: 1,
          checkpointRef: "provider-diff:evt-1",
          status: "missing",
          files: [],
          assistantMessageId: "assistant-msg-1",
          completedAt: "2026-02-23T12:00:02.000Z",
        },
      }),
    ];
    const running = await events.reduce<Promise<ReturnType<typeof createEmptyReadModel>>>(
      (statePromise, event) =>
        statePromise.then((state) => Effect.runPromise(projectEvent(state, event))),
      Promise.resolve(createEmptyReadModel(createdAt)),
    );
    const runningThread = [...running.threads.values()][0];
    expect(runningThread?.latestTurn?.state).toBe("running");
    expect(runningThread?.latestTurn?.completedAt).toBeNull();
    expect(runningThread?.checkpoints).toHaveLength(1);

    const settled = await Effect.runPromise(
      projectEvent(
        running,
        makeEvent({
          sequence: 4,
          type: "thread.session-set",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: "2026-02-23T12:00:09.000Z",
          commandId: "cmd-failed",
          payload: {
            threadId: "thread-1",
            session: {
              threadId: "thread-1",
              status: "error",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: "boom",
              updatedAt: "2026-02-23T12:00:03.000Z",
            },
          },
        }),
      ),
    );
    const settledThread = [...settled.threads.values()][0];
    expect(settledThread?.latestTurn?.state).toBe("error");
    expect(settledThread?.latestTurn?.completedAt).toBe("2026-02-23T12:00:03.000Z");
  });

  it("settles a running latest turn when its session leaves running", async () => {
    const createdAt = "2026-02-23T11:00:00.000Z";
    const sessionSet = (
      sequence: number,
      status: "running" | "ready" | "stopped" | "error",
      activeTurnId: string | null,
    ) =>
      makeEvent({
        sequence,
        type: "thread.session-set",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: `2026-02-23T11:00:0${sequence}.000Z`,
        commandId: `cmd-session-${sequence}`,
        payload: {
          threadId: "thread-1",
          session: {
            threadId: "thread-1",
            status,
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId,
            lastError: status === "error" ? "boom" : null,
            updatedAt: `2026-02-23T11:00:0${sequence}.000Z`,
          },
        },
      });
    const diffReady = (sequence: number, turnId: string) =>
      makeEvent({
        sequence,
        type: "thread.turn-diff-completed",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: `2026-02-23T11:00:0${sequence}.000Z`,
        commandId: `cmd-diff-${sequence}`,
        payload: {
          threadId: "thread-1",
          turnId,
          checkpointTurnCount: sequence,
          checkpointRef: `refs/piedpiper/checkpoints/thread-1/turn/${sequence}`,
          status: "ready",
          files: [],
          assistantMessageId: null,
          completedAt: `2026-02-23T11:00:0${sequence}.000Z`,
        },
      });
    const created = makeEvent({
      sequence: 1,
      type: "thread.created",
      aggregateKind: "thread",
      aggregateId: "thread-1",
      occurredAt: createdAt,
      commandId: "cmd-create",
      payload: {
        threadId: "thread-1",
        projectId: "project-1",
        title: "demo",
        modelSelection: { provider: "codex", model: "gpt-5.3-codex" },
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt,
        updatedAt: createdAt,
      },
    });
    const run = (events: ReadonlyArray<OrchestrationEvent>) =>
      events
        .reduce<Promise<ReturnType<typeof createEmptyReadModel>>>(
          (statePromise, event) =>
            statePromise.then((state) => Effect.runPromise(projectEvent(state, event))),
          Promise.resolve(createEmptyReadModel(createdAt)),
        )
        .then((model) => [...model.threads.values()][0]?.latestTurn);

    // A session error mid-turn marks the turn failed, and the later checkpoint keeps it failed.
    const errored = await run([
      created,
      sessionSet(2, "running", "turn-1"),
      sessionSet(3, "error", null),
    ]);
    expect(errored?.state).toBe("error");
    expect(errored?.completedAt).toBe("2026-02-23T11:00:03.000Z");
    expect(
      (
        await run([
          created,
          sessionSet(2, "running", "turn-1"),
          sessionSet(3, "error", null),
          diffReady(4, "turn-1"),
        ])
      )?.state,
    ).toBe("error");

    // A stop mid-turn interrupts it.
    expect(
      (await run([created, sessionSet(2, "running", "turn-1"), sessionSet(3, "stopped", null)]))
        ?.state,
    ).toBe("interrupted");

    // A stop after the turn finished (ready) must not relabel it as interrupted.
    expect(
      (
        await run([
          created,
          sessionSet(2, "running", "turn-1"),
          sessionSet(3, "ready", null),
          sessionSet(4, "stopped", null),
          diffReady(5, "turn-1"),
        ])
      )?.state,
    ).toBe("completed");
  });

  it("does not fallback-retain messages tied to removed turn IDs", async () => {
    const createdAt = "2026-02-26T12:00:00.000Z";
    const model = createEmptyReadModel(createdAt);

    const afterCreate = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-revert",
          occurredAt: createdAt,
          commandId: "cmd-create-revert",
          payload: {
            threadId: "thread-revert",
            projectId: "project-1",
            title: "demo",
            modelSelection: {
              provider: "codex",
              model: "gpt-5.3-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );

    const events: ReadonlyArray<OrchestrationEvent> = [
      makeEvent({
        sequence: 2,
        type: "thread.turn-diff-completed",
        aggregateKind: "thread",
        aggregateId: "thread-revert",
        occurredAt: "2026-02-26T12:00:01.000Z",
        commandId: "cmd-turn-1",
        payload: {
          threadId: "thread-revert",
          turnId: "turn-1",
          checkpointTurnCount: 1,
          checkpointRef: "refs/piedpiper/checkpoints/thread-revert/turn/1",
          status: "ready",
          files: [],
          assistantMessageId: "assistant-keep",
          completedAt: "2026-02-26T12:00:01.000Z",
        },
      }),
      makeEvent({
        sequence: 3,
        type: "thread.message-sent",
        aggregateKind: "thread",
        aggregateId: "thread-revert",
        occurredAt: "2026-02-26T12:00:01.100Z",
        commandId: "cmd-assistant-keep",
        payload: {
          threadId: "thread-revert",
          messageId: "assistant-keep",
          role: "assistant",
          text: "kept",
          turnId: "turn-1",
          streaming: false,
          createdAt: "2026-02-26T12:00:01.100Z",
          updatedAt: "2026-02-26T12:00:01.100Z",
        },
      }),
      makeEvent({
        sequence: 4,
        type: "thread.turn-diff-completed",
        aggregateKind: "thread",
        aggregateId: "thread-revert",
        occurredAt: "2026-02-26T12:00:02.000Z",
        commandId: "cmd-turn-2",
        payload: {
          threadId: "thread-revert",
          turnId: "turn-2",
          checkpointTurnCount: 2,
          checkpointRef: "refs/piedpiper/checkpoints/thread-revert/turn/2",
          status: "ready",
          files: [],
          assistantMessageId: "assistant-remove",
          completedAt: "2026-02-26T12:00:02.000Z",
        },
      }),
      makeEvent({
        sequence: 5,
        type: "thread.message-sent",
        aggregateKind: "thread",
        aggregateId: "thread-revert",
        occurredAt: "2026-02-26T12:00:02.050Z",
        commandId: "cmd-user-remove",
        payload: {
          threadId: "thread-revert",
          messageId: "user-remove",
          role: "user",
          text: "removed",
          turnId: "turn-2",
          streaming: false,
          createdAt: "2026-02-26T12:00:02.050Z",
          updatedAt: "2026-02-26T12:00:02.050Z",
        },
      }),
      makeEvent({
        sequence: 6,
        type: "thread.message-sent",
        aggregateKind: "thread",
        aggregateId: "thread-revert",
        occurredAt: "2026-02-26T12:00:02.100Z",
        commandId: "cmd-assistant-remove",
        payload: {
          threadId: "thread-revert",
          messageId: "assistant-remove",
          role: "assistant",
          text: "removed",
          turnId: "turn-2",
          streaming: false,
          createdAt: "2026-02-26T12:00:02.100Z",
          updatedAt: "2026-02-26T12:00:02.100Z",
        },
      }),
      makeEvent({
        sequence: 7,
        type: "thread.reverted",
        aggregateKind: "thread",
        aggregateId: "thread-revert",
        occurredAt: "2026-02-26T12:00:03.000Z",
        commandId: "cmd-revert",
        payload: {
          threadId: "thread-revert",
          turnCount: 1,
        },
      }),
    ];

    const afterRevert = await events.reduce<Promise<ReturnType<typeof createEmptyReadModel>>>(
      (statePromise, event) =>
        statePromise.then((state) => Effect.runPromise(projectEvent(state, event))),
      Promise.resolve(afterCreate),
    );

    const thread = [...afterRevert.threads.values()][0];
    expect(
      thread?.messages.map((message) => ({
        id: message.id,
        role: message.role,
        turnId: message.turnId,
      })),
    ).toEqual([{ id: "assistant-keep", role: "assistant", turnId: "turn-1" }]);
  });

  it("caps message and checkpoint retention for long-lived threads", async () => {
    const createdAt = "2026-03-01T10:00:00.000Z";
    const model = createEmptyReadModel(createdAt);

    const afterCreate = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-capped",
          occurredAt: createdAt,
          commandId: "cmd-create-capped",
          payload: {
            threadId: "thread-capped",
            projectId: "project-1",
            title: "capped",
            modelSelection: {
              provider: "codex",
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );

    const messageEvents: ReadonlyArray<OrchestrationEvent> = Array.from(
      { length: 2_100 },
      (_, index) =>
        makeEvent({
          sequence: index + 2,
          type: "thread.message-sent",
          aggregateKind: "thread",
          aggregateId: "thread-capped",
          occurredAt: `2026-03-01T10:00:${String(index % 60).padStart(2, "0")}.000Z`,
          commandId: `cmd-message-${index}`,
          payload: {
            threadId: "thread-capped",
            messageId: `msg-${index}`,
            role: "assistant",
            text: `message-${index}`,
            turnId: `turn-${index}`,
            streaming: false,
            createdAt: `2026-03-01T10:00:${String(index % 60).padStart(2, "0")}.000Z`,
            updatedAt: `2026-03-01T10:00:${String(index % 60).padStart(2, "0")}.000Z`,
          },
        }),
    );
    const afterMessages = await messageEvents.reduce<
      Promise<ReturnType<typeof createEmptyReadModel>>
    >(
      (statePromise, event) =>
        statePromise.then((state) => Effect.runPromise(projectEvent(state, event))),
      Promise.resolve(afterCreate),
    );

    const checkpointEvents: ReadonlyArray<OrchestrationEvent> = Array.from(
      { length: 600 },
      (_, index) =>
        makeEvent({
          sequence: index + 2_102,
          type: "thread.turn-diff-completed",
          aggregateKind: "thread",
          aggregateId: "thread-capped",
          occurredAt: `2026-03-01T10:30:${String(index % 60).padStart(2, "0")}.000Z`,
          commandId: `cmd-checkpoint-${index}`,
          payload: {
            threadId: "thread-capped",
            turnId: `turn-${index}`,
            checkpointTurnCount: index + 1,
            checkpointRef: `refs/piedpiper/checkpoints/thread-capped/turn/${index + 1}`,
            status: "ready",
            files: [],
            assistantMessageId: `msg-${index}`,
            completedAt: `2026-03-01T10:30:${String(index % 60).padStart(2, "0")}.000Z`,
          },
        }),
    );
    const finalState = await checkpointEvents.reduce<
      Promise<ReturnType<typeof createEmptyReadModel>>
    >(
      (statePromise, event) =>
        statePromise.then((state) => Effect.runPromise(projectEvent(state, event))),
      Promise.resolve(afterMessages),
    );

    const thread = [...finalState.threads.values()][0];
    expect(thread?.messages).toHaveLength(2_000);
    expect(thread?.messages[0]?.id).toBe("msg-100");
    expect(thread?.messages.at(-1)?.id).toBe("msg-2099");
    expect(thread?.checkpoints).toHaveLength(500);
    expect(thread?.checkpoints[0]?.turnId).toBe("turn-100");
    expect(thread?.checkpoints.at(-1)?.turnId).toBe("turn-599");
  });
});
