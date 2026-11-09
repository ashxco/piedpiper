import {
  CheckpointRef,
  DEFAULT_MODEL_BY_PROVIDER,
  EventId,
  MessageId,
  ProjectId,
  ProviderItemId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type ToolInputPreviewEvent,
} from "@piedpiper/contracts";
import { describe, expect, it, vi } from "vitest";

import { LIVE_COMMAND_OUTPUT_FIELD, LIVE_COMMAND_OUTPUT_MAX_CHARS } from "./lib/liveCommandOutput";
import {
  refreshLiveBackgroundTaskSummaries,
  applyOrchestrationEvent,
  applyOrchestrationEvents,
  applyToolInputPreviewBatch,
  clearItemPreview,
  clearThreadPreviews,
  syncServerReadModel,
  useStore,
  type AppState,
} from "./store";
import {
  MAX_THREAD_ACTIVITIES,
  MAX_THREAD_MESSAGES,
  appendThreadActivity,
} from "./lib/storeUpdateHelpers";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE, type Thread } from "./types";

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    codexThreadId: null,
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Thread",
    modelSelection: {
      provider: "codex",
      model: "gpt-5-codex",
    },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    session: null,
    messages: [],
    turnDiffSummaries: [],
    activities: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-02-13T00:00:00.000Z",
    archivedAt: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    ...overrides,
  };
}

function makeState(thread: Thread): AppState {
  const threadIdsByProjectId: AppState["threadIdsByProjectId"] = {
    [thread.projectId]: [thread.id],
  };
  return {
    projects: [
      {
        id: ProjectId.makeUnsafe("project-1"),
        name: "Project",
        cwd: "/tmp/project",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        scripts: [],
      },
    ],
    threads: [thread],
    sidebarThreadsById: {},
    threadIdsByProjectId,
    userRenamedThreadIds: new Set<string>(),
    bootstrapComplete: true,
    toolInputPreviews: {},
  };
}

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

function makeReadModelThread(overrides: Partial<OrchestrationReadModel["threads"][number]>) {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Thread",
    modelSelection: {
      provider: "codex",
      model: "gpt-5.3-codex",
    },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    systemPrompt: null,
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-02-27T00:00:00.000Z",
    updatedAt: "2026-02-27T00:00:00.000Z",
    archivedAt: null,
    deletedAt: null,
    messages: [],
    activities: [],
    proposedPlans: [],
    checkpoints: [],
    session: null,
    ...overrides,
  } satisfies OrchestrationReadModel["threads"][number];
}

function makeReadModel(thread: OrchestrationReadModel["threads"][number]): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    updatedAt: "2026-02-27T00:00:00.000Z",
    projects: [
      {
        id: ProjectId.makeUnsafe("project-1"),
        title: "Project",
        workspaceRoot: "/tmp/project",
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5.3-codex",
        },
        createdAt: "2026-02-27T00:00:00.000Z",
        updatedAt: "2026-02-27T00:00:00.000Z",
        deletedAt: null,
        scripts: [],
      },
    ],
    threads: [thread],
  };
}

function makeReadModelProject(
  overrides: Partial<OrchestrationReadModel["projects"][number]>,
): OrchestrationReadModel["projects"][number] {
  return {
    id: ProjectId.makeUnsafe("project-1"),
    title: "Project",
    workspaceRoot: "/tmp/project",
    defaultModelSelection: {
      provider: "codex",
      model: "gpt-5.3-codex",
    },
    createdAt: "2026-02-27T00:00:00.000Z",
    updatedAt: "2026-02-27T00:00:00.000Z",
    deletedAt: null,
    scripts: [],
    ...overrides,
  };
}

describe("store read model sync", () => {
  it("marks bootstrap complete after snapshot sync", () => {
    const initialState: AppState = {
      ...makeState(makeThread()),
      bootstrapComplete: false,
    };

    const next = syncServerReadModel(initialState, makeReadModel(makeReadModelThread({})));

    expect(next.bootstrapComplete).toBe(true);
  });

  it("preserves claude model slugs without an active session", () => {
    const initialState = makeState(makeThread());
    const readModel = makeReadModel(
      makeReadModelThread({
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-opus-4-6",
        },
      }),
    );

    const next = syncServerReadModel(initialState, readModel);

    expect(next.threads[0]?.modelSelection.model).toBe("claude-opus-4-6");
  });

  it("resolves claude aliases when session provider is claudeAgent", () => {
    const initialState = makeState(makeThread());
    const readModel = makeReadModel(
      makeReadModelThread({
        modelSelection: {
          provider: "claudeAgent",
          model: "sonnet",
        },
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-02-27T00:00:00.000Z",
        },
      }),
    );

    const next = syncServerReadModel(initialState, readModel);

    expect(next.threads[0]?.modelSelection.model).toBe("claude-sonnet-5-5");
  });

  it("preserves project and thread updatedAt timestamps from the read model", () => {
    const initialState = makeState(makeThread());
    const readModel = makeReadModel(
      makeReadModelThread({
        updatedAt: "2026-02-27T00:05:00.000Z",
      }),
    );

    const next = syncServerReadModel(initialState, readModel);

    expect(next.projects[0]?.updatedAt).toBe("2026-02-27T00:00:00.000Z");
    expect(next.threads[0]?.updatedAt).toBe("2026-02-27T00:05:00.000Z");
  });

  it("maps archivedAt from the read model", () => {
    const initialState = makeState(makeThread());
    const archivedAt = "2026-02-28T00:00:00.000Z";
    const next = syncServerReadModel(
      initialState,
      makeReadModel(
        makeReadModelThread({
          archivedAt,
        }),
      ),
    );

    expect(next.threads[0]?.archivedAt).toBe(archivedAt);
  });

  it("replaces projects using snapshot order during recovery", () => {
    const project1 = ProjectId.makeUnsafe("project-1");
    const project2 = ProjectId.makeUnsafe("project-2");
    const project3 = ProjectId.makeUnsafe("project-3");
    const initialState: AppState = {
      projects: [
        {
          id: project2,
          name: "Project 2",
          cwd: "/tmp/project-2",
          defaultModelSelection: {
            provider: "codex",
            model: DEFAULT_MODEL_BY_PROVIDER.codex,
          },
          scripts: [],
        },
        {
          id: project1,
          name: "Project 1",
          cwd: "/tmp/project-1",
          defaultModelSelection: {
            provider: "codex",
            model: DEFAULT_MODEL_BY_PROVIDER.codex,
          },
          scripts: [],
        },
      ],
      threads: [],
      sidebarThreadsById: {},
      threadIdsByProjectId: {},
      userRenamedThreadIds: new Set<string>(),
      bootstrapComplete: true,
      toolInputPreviews: {},
    };
    const readModel: OrchestrationReadModel = {
      snapshotSequence: 2,
      updatedAt: "2026-02-27T00:00:00.000Z",
      projects: [
        makeReadModelProject({
          id: project1,
          title: "Project 1",
          workspaceRoot: "/tmp/project-1",
        }),
        makeReadModelProject({
          id: project2,
          title: "Project 2",
          workspaceRoot: "/tmp/project-2",
        }),
        makeReadModelProject({
          id: project3,
          title: "Project 3",
          workspaceRoot: "/tmp/project-3",
        }),
      ],
      threads: [],
    };

    const next = syncServerReadModel(initialState, readModel);

    expect(next.projects.map((project) => project.id)).toEqual([project1, project2, project3]);
  });
});

describe("incremental orchestration updates", () => {
  it("does not mark bootstrap complete for incremental events", () => {
    const state: AppState = {
      ...makeState(makeThread()),
      bootstrapComplete: false,
    };

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.meta-updated", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        title: "Updated title",
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
    );

    expect(next.bootstrapComplete).toBe(false);
  });

  it("preserves state identity for no-op project and thread deletes", () => {
    const thread = makeThread();
    const state = makeState(thread);

    const nextAfterProjectDelete = applyOrchestrationEvent(
      state,
      makeEvent("project.deleted", {
        projectId: ProjectId.makeUnsafe("project-missing"),
        deletedAt: "2026-02-27T00:00:01.000Z",
      }),
    );
    const nextAfterThreadDelete = applyOrchestrationEvent(
      state,
      makeEvent("thread.deleted", {
        threadId: ThreadId.makeUnsafe("thread-missing"),
        deletedAt: "2026-02-27T00:00:01.000Z",
      }),
    );

    expect(nextAfterProjectDelete).toBe(state);
    expect(nextAfterThreadDelete).toBe(state);
  });

  it("maps a project's faviconPath from project.created, defaulting to null", () => {
    const created = (projectId: string, faviconPath?: string) =>
      makeEvent("project.created", {
        projectId: ProjectId.makeUnsafe(projectId),
        title: projectId,
        workspaceRoot: `/tmp/${projectId}`,
        defaultModelSelection: null,
        scripts: [],
        ...(faviconPath === undefined ? {} : { faviconPath }),
        createdAt: "2026-02-27T00:00:02.000Z",
        updatedAt: "2026-02-27T00:00:02.000Z",
      });
    const withIcon = applyOrchestrationEvent(makeState(makeThread()), created("a", "/icons/a.png"));
    const next = applyOrchestrationEvent(withIcon, created("b"));

    expect(next.projects.find((project) => project.cwd === "/tmp/a")?.faviconPath).toBe(
      "/icons/a.png",
    );
    expect(next.projects.find((project) => project.cwd === "/tmp/b")?.faviconPath).toBeNull();
  });

  it("keeps the capped file totals from thread.turn-diff-completed", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const diffCompleted = (
      turnNumber: number,
      totals: { filesTotal?: number; additionsTotal?: number; deletionsTotal?: number },
    ) =>
      makeEvent("thread.turn-diff-completed", {
        threadId,
        turnId: TurnId.makeUnsafe(`turn-${turnNumber}`),
        checkpointTurnCount: turnNumber,
        checkpointRef: CheckpointRef.makeUnsafe(`checkpoint-${turnNumber}`),
        status: "ready",
        files: [],
        ...totals,
        assistantMessageId: null,
        completedAt: "2026-02-27T00:00:02.000Z",
      });
    const capped = applyOrchestrationEvent(
      makeState(makeThread()),
      diffCompleted(1, { filesTotal: 450, additionsTotal: 900, deletionsTotal: 12 }),
    );
    const next = applyOrchestrationEvent(capped, diffCompleted(2, {}));

    expect(next.threads[0]?.turnDiffSummaries[0]).toMatchObject({
      filesTotal: 450,
      additionsTotal: 900,
      deletionsTotal: 12,
    });
    expect(next.threads[0]?.turnDiffSummaries[1]).not.toHaveProperty("filesTotal");
  });

  it("sets and clears a project's faviconPath from meta updates", () => {
    const metaUpdated = (payload: { faviconPath?: string | null }, updatedAt: string) =>
      makeEvent("project.meta-updated", {
        projectId: ProjectId.makeUnsafe("project-1"),
        updatedAt,
        ...payload,
      } as Extract<OrchestrationEvent, { type: "project.meta-updated" }>["payload"]);

    const chosen = applyOrchestrationEvent(
      makeState(makeThread()),
      metaUpdated({ faviconPath: "assets/logo.svg" }, "2026-02-27T00:00:01.000Z"),
    );
    expect(chosen.projects[0]?.faviconPath).toBe("assets/logo.svg");

    // An update that does not mention it keeps the chosen icon.
    const renamed = applyOrchestrationEvent(chosen, metaUpdated({}, "2026-02-27T00:00:02.000Z"));
    expect(renamed.projects[0]?.faviconPath).toBe("assets/logo.svg");

    const cleared = applyOrchestrationEvent(
      renamed,
      metaUpdated({ faviconPath: null }, "2026-02-27T00:00:03.000Z"),
    );
    expect(cleared.projects[0]?.faviconPath).toBeNull();
  });

  it("sets and clears a project's archivedAt from meta updates, leaving it in state", () => {
    const projectId = ProjectId.makeUnsafe("project-1");
    const metaUpdated = (payload: { archivedAt?: string | null }, updatedAt: string) =>
      makeEvent("project.meta-updated", {
        projectId,
        updatedAt,
        ...payload,
      } as Extract<OrchestrationEvent, { type: "project.meta-updated" }>["payload"]);

    const archived = applyOrchestrationEvent(
      makeState(makeThread()),
      metaUpdated({ archivedAt: "2026-02-27T00:00:01.000Z" }, "2026-02-27T00:00:01.000Z"),
    );
    expect(archived.projects).toHaveLength(1);
    expect(archived.projects[0]?.archivedAt).toBe("2026-02-27T00:00:01.000Z");

    // An update that does not mention it leaves the archive alone.
    const renamed = applyOrchestrationEvent(archived, metaUpdated({}, "2026-02-27T00:00:02.000Z"));
    expect(renamed.projects[0]?.archivedAt).toBe("2026-02-27T00:00:01.000Z");

    const unarchived = applyOrchestrationEvent(
      renamed,
      metaUpdated({ archivedAt: null }, "2026-02-27T00:00:03.000Z"),
    );
    expect(unarchived.projects[0]?.archivedAt).toBeNull();
  });

  it("creates projects as not archived, even when the same folder was archived before", () => {
    const base = makeState(makeThread());
    const state: AppState = {
      ...base,
      projects: base.projects.map((project) =>
        Object.assign({}, project, { archivedAt: "2026-02-27T00:00:01.000Z" }),
      ),
    };
    const next = applyOrchestrationEvent(
      state,
      makeEvent("project.created", {
        projectId: ProjectId.makeUnsafe("project-2"),
        title: "Project",
        workspaceRoot: "/tmp/project",
        defaultModelSelection: null,
        scripts: [],
        createdAt: "2026-02-27T00:00:02.000Z",
        updatedAt: "2026-02-27T00:00:02.000Z",
      }),
    );
    expect(next.projects).toHaveLength(1);
    expect(next.projects[0]?.archivedAt).toBeNull();
  });

  it("applies a regenerated title once the manual rename flag is cleared", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const titleEvent = makeEvent("thread.meta-updated", {
      threadId,
      title: "Regenerated",
      updatedAt: "2026-02-27T00:00:01.000Z",
    });
    const initial = useStore.getState();
    useStore.setState(makeState(makeThread({ title: "Manual" })));
    try {
      useStore.getState().markThreadUserRenamed(threadId);
      useStore.getState().applyOrchestrationEvent(titleEvent);
      expect(useStore.getState().threads[0]?.title).toBe("Manual");

      // A second manual rename shows too, though its own event is dropped with the rest.
      useStore.getState().markThreadUserRenamed(threadId, "Second manual");
      useStore.getState().applyOrchestrationEvent(titleEvent);
      expect(useStore.getState().threads[0]?.title).toBe("Second manual");

      useStore.getState().clearThreadUserRenamed(threadId);
      expect(useStore.getState().userRenamedThreadIds.has(threadId)).toBe(false);
      useStore.getState().applyOrchestrationEvent(titleEvent);
      expect(useStore.getState().threads[0]?.title).toBe("Regenerated");
    } finally {
      useStore.setState(initial, true);
    }
  });

  it("reuses an existing project row when project.created arrives with a new id for the same cwd", () => {
    const originalProjectId = ProjectId.makeUnsafe("project-1");
    const recreatedProjectId = ProjectId.makeUnsafe("project-2");
    const state: AppState = {
      projects: [
        {
          id: originalProjectId,
          name: "Project",
          cwd: "/tmp/project",
          defaultModelSelection: {
            provider: "codex",
            model: DEFAULT_MODEL_BY_PROVIDER.codex,
          },
          scripts: [],
        },
      ],
      threads: [],
      sidebarThreadsById: {},
      threadIdsByProjectId: {},
      userRenamedThreadIds: new Set<string>(),
      bootstrapComplete: true,
      toolInputPreviews: {},
    };

    const next = applyOrchestrationEvent(
      state,
      makeEvent("project.created", {
        projectId: recreatedProjectId,
        title: "Project Recreated",
        workspaceRoot: "/tmp/project",
        defaultModelSelection: {
          provider: "codex",
          model: DEFAULT_MODEL_BY_PROVIDER.codex,
        },
        scripts: [],
        createdAt: "2026-02-27T00:00:01.000Z",
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
    );

    expect(next.projects).toHaveLength(1);
    expect(next.projects[0]?.id).toBe(recreatedProjectId);
    expect(next.projects[0]?.cwd).toBe("/tmp/project");
    expect(next.projects[0]?.name).toBe("Project Recreated");
  });

  it("removes stale project index entries when thread.created recreates a thread under a new project", () => {
    const originalProjectId = ProjectId.makeUnsafe("project-1");
    const recreatedProjectId = ProjectId.makeUnsafe("project-2");
    const threadId = ThreadId.makeUnsafe("thread-1");
    const thread = makeThread({
      id: threadId,
      projectId: originalProjectId,
    });
    const state: AppState = {
      projects: [
        {
          id: originalProjectId,
          name: "Project 1",
          cwd: "/tmp/project-1",
          defaultModelSelection: {
            provider: "codex",
            model: DEFAULT_MODEL_BY_PROVIDER.codex,
          },
          scripts: [],
        },
        {
          id: recreatedProjectId,
          name: "Project 2",
          cwd: "/tmp/project-2",
          defaultModelSelection: {
            provider: "codex",
            model: DEFAULT_MODEL_BY_PROVIDER.codex,
          },
          scripts: [],
        },
      ],
      threads: [thread],
      sidebarThreadsById: {},
      threadIdsByProjectId: {
        [originalProjectId]: [threadId],
      },
      userRenamedThreadIds: new Set<string>(),
      bootstrapComplete: true,
      toolInputPreviews: {},
    };

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.created", {
        threadId,
        projectId: recreatedProjectId,
        title: "Recovered thread",
        modelSelection: {
          provider: "codex",
          model: DEFAULT_MODEL_BY_PROVIDER.codex,
        },
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_INTERACTION_MODE,
        systemPrompt: null,
        branch: null,
        worktreePath: null,
        createdAt: "2026-02-27T00:00:01.000Z",
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
    );

    expect(next.threads).toHaveLength(1);
    expect(next.threads[0]?.projectId).toBe(recreatedProjectId);
    expect(next.threadIdsByProjectId[originalProjectId]).toBeUndefined();
    expect(next.threadIdsByProjectId[recreatedProjectId]).toEqual([threadId]);
  });

  it("updates only the affected thread for message events", () => {
    const thread1 = makeThread({
      id: ThreadId.makeUnsafe("thread-1"),
      messages: [
        {
          id: MessageId.makeUnsafe("message-1"),
          role: "assistant",
          text: "hello",
          turnId: TurnId.makeUnsafe("turn-1"),
          createdAt: "2026-02-27T00:00:00.000Z",
          completedAt: "2026-02-27T00:00:00.000Z",
          streaming: false,
        },
      ],
    });
    const thread2 = makeThread({ id: ThreadId.makeUnsafe("thread-2") });
    const state: AppState = {
      ...makeState(thread1),
      threads: [thread1, thread2],
    };

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.message-sent", {
        threadId: thread1.id,
        messageId: MessageId.makeUnsafe("message-1"),
        role: "assistant",
        text: " world",
        turnId: TurnId.makeUnsafe("turn-1"),
        streaming: true,
        createdAt: "2026-02-27T00:00:01.000Z",
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
    );

    expect(next.threads[0]?.messages[0]?.text).toBe("hello world");
    expect(next.threads[0]?.latestTurn?.state).toBe("running");
    expect(next.threads[1]).toBe(thread2);
  });

  describe("a failed or stopped turn's late messages", () => {
    const turnId = TurnId.makeUnsafe("turn-1");
    const failedAt = "2026-02-27T00:00:05.000Z";
    const settledThread = (state: "error" | "interrupted") =>
      makeThread({
        latestTurn: {
          turnId,
          state,
          requestedAt: "2026-02-27T00:00:00.000Z",
          startedAt: "2026-02-27T00:00:00.000Z",
          completedAt: failedAt,
          assistantMessageId: null,
        },
      });
    const lateMessage = (streaming: boolean, updatedAt: string) =>
      makeEvent("thread.message-sent", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId: MessageId.makeUnsafe("late-message"),
        role: "assistant",
        text: "buffered",
        turnId,
        streaming,
        createdAt: updatedAt,
        updatedAt,
      });

    it("stays error with its original completedAt through a late flush", () => {
      const next = applyOrchestrationEvents(makeState(settledThread("error")), [
        lateMessage(true, "2026-02-27T00:00:06.000Z"),
        lateMessage(false, "2026-02-27T00:00:07.000Z"),
      ]);
      expect(next.threads[0]?.latestTurn?.state).toBe("error");
      expect(next.threads[0]?.latestTurn?.completedAt).toBe(failedAt);
    });

    it("stays interrupted through a lone streaming delta", () => {
      const next = applyOrchestrationEvent(
        makeState(settledThread("interrupted")),
        lateMessage(true, "2026-02-27T00:00:06.000Z"),
      );
      expect(next.threads[0]?.latestTurn?.state).toBe("interrupted");
      expect(next.threads[0]?.latestTurn?.completedAt).toBe(failedAt);
    });
  });

  describe("an assistant message with only an attachment", () => {
    const turnId = TurnId.makeUnsafe("turn-1");
    const replyId = MessageId.makeUnsafe("reply");
    const imageId = MessageId.makeUnsafe("image");
    const imageMessage = makeEvent("thread.message-sent", {
      threadId: ThreadId.makeUnsafe("thread-1"),
      messageId: imageId,
      role: "assistant",
      text: "",
      attachments: [
        { type: "image", id: "image-1", name: "a.png", mimeType: "image/png", sizeBytes: 1 },
      ],
      turnId,
      streaming: false,
      createdAt: "2026-02-27T00:00:02.000Z",
      updatedAt: "2026-02-27T00:00:02.000Z",
    });

    it("leaves the turn's pointer on the reply", () => {
      const thread = makeThread({
        latestTurn: {
          turnId,
          state: "running",
          requestedAt: "2026-02-27T00:00:00.000Z",
          startedAt: "2026-02-27T00:00:00.000Z",
          completedAt: null,
          assistantMessageId: replyId,
        },
        turnDiffSummaries: [
          {
            turnId,
            completedAt: "2026-02-27T00:00:01.000Z",
            assistantMessageId: replyId,
            files: [],
          },
        ],
      });
      const next = applyOrchestrationEvent(makeState(thread), imageMessage);
      expect(next.threads[0]?.latestTurn?.assistantMessageId).toBe(replyId);
      expect(next.threads[0]?.turnDiffSummaries[0]?.assistantMessageId).toBe(replyId);
    });

    it("takes the pointer when the turn has no reply", () => {
      const thread = makeThread({
        latestTurn: {
          turnId,
          state: "running",
          requestedAt: "2026-02-27T00:00:00.000Z",
          startedAt: "2026-02-27T00:00:00.000Z",
          completedAt: null,
          assistantMessageId: null,
        },
      });
      const next = applyOrchestrationEvent(makeState(thread), imageMessage);
      expect(next.threads[0]?.latestTurn?.assistantMessageId).toBe(imageId);
    });

    const nextTurnRunning = {
      turnId: TurnId.makeUnsafe("turn-2"),
      state: "running" as const,
      requestedAt: "2026-02-27T00:00:01.500Z",
      startedAt: "2026-02-27T00:00:01.500Z",
      completedAt: null,
      assistantMessageId: null,
    };

    it("leaves an older turn's summary on the reply", () => {
      const thread = makeThread({
        latestTurn: nextTurnRunning,
        turnDiffSummaries: [
          {
            turnId,
            completedAt: "2026-02-27T00:00:01.000Z",
            assistantMessageId: replyId,
            files: [],
          },
        ],
      });
      const next = applyOrchestrationEvent(makeState(thread), imageMessage);
      expect(next.threads[0]?.turnDiffSummaries[0]?.assistantMessageId).toBe(replyId);
      expect(next.threads[0]?.latestTurn).toBe(thread.latestTurn);
    });

    it("gives an older turn's summary the pointer when it has none", () => {
      const thread = makeThread({
        latestTurn: nextTurnRunning,
        turnDiffSummaries: [{ turnId, completedAt: "2026-02-27T00:00:01.000Z", files: [] }],
      });
      const next = applyOrchestrationEvent(makeState(thread), imageMessage);
      expect(next.threads[0]?.turnDiffSummaries[0]?.assistantMessageId).toBe(imageId);
    });

    it("leaves a settled turn's completion time alone", () => {
      const completedAt = "2026-02-27T00:00:01.000Z";
      const thread = makeThread({
        latestTurn: {
          turnId,
          state: "completed",
          requestedAt: "2026-02-27T00:00:00.000Z",
          startedAt: "2026-02-27T00:00:00.000Z",
          completedAt,
          assistantMessageId: replyId,
        },
      });
      const next = applyOrchestrationEvent(makeState(thread), imageMessage);
      expect(next.threads[0]?.latestTurn?.completedAt).toBe(completedAt);
      expect(next.threads[0]?.latestTurn?.state).toBe("completed");
    });

    it("settles an unsettled turn at the image's time", () => {
      const thread = makeThread({
        latestTurn: {
          turnId,
          state: "running",
          requestedAt: "2026-02-27T00:00:00.000Z",
          startedAt: "2026-02-27T00:00:00.000Z",
          completedAt: null,
          assistantMessageId: replyId,
        },
        session: null,
      });
      const next = applyOrchestrationEvent(makeState(thread), imageMessage);
      expect(next.threads[0]?.latestTurn?.completedAt).toBe("2026-02-27T00:00:02.000Z");
      expect(next.threads[0]?.latestTurn?.state).toBe("completed");
    });
  });

  it("applies replay batches in sequence and updates session state", () => {
    const thread = makeThread({
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-1"),
        state: "running",
        requestedAt: "2026-02-27T00:00:00.000Z",
        startedAt: "2026-02-27T00:00:00.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
    });
    const state = makeState(thread);

    const next = applyOrchestrationEvents(state, [
      makeEvent(
        "thread.session-set",
        {
          threadId: thread.id,
          session: {
            threadId: thread.id,
            status: "running",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: TurnId.makeUnsafe("turn-1"),
            lastError: null,
            updatedAt: "2026-02-27T00:00:02.000Z",
          },
        },
        { sequence: 2 },
      ),
      makeEvent(
        "thread.message-sent",
        {
          threadId: thread.id,
          messageId: MessageId.makeUnsafe("assistant-1"),
          role: "assistant",
          text: "done",
          turnId: TurnId.makeUnsafe("turn-1"),
          streaming: false,
          createdAt: "2026-02-27T00:00:03.000Z",
          updatedAt: "2026-02-27T00:00:03.000Z",
        },
        { sequence: 3 },
      ),
    ]);

    expect(next.threads[0]?.session?.status).toBe("running");
    expect(next.threads[0]?.latestTurn?.state).toBe("running");
    expect(next.threads[0]?.latestTurn?.completedAt).toBeNull();
    expect(next.threads[0]?.latestTurn?.assistantMessageId).toBe("assistant-1");
    expect(next.threads[0]?.messages).toHaveLength(1);
  });

  describe("turn settling", () => {
    const turnId = TurnId.makeUnsafe("turn-1");
    const threadId = ThreadId.makeUnsafe("thread-1");
    const runningTurn: NonNullable<Thread["latestTurn"]> = {
      turnId,
      state: "running",
      requestedAt: "2026-02-27T00:00:00.000Z",
      startedAt: "2026-02-27T00:00:01.000Z",
      completedAt: null,
      assistantMessageId: null,
    };
    const sessionSet = (
      status: "starting" | "running" | "ready" | "interrupted" | "stopped" | "error",
      updatedAt = "2026-02-27T00:00:09.000Z",
    ) =>
      makeEvent("thread.session-set", {
        threadId,
        session: {
          threadId,
          status,
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: status === "running" ? turnId : null,
          lastError: status === "error" ? "boom" : null,
          updatedAt,
        },
      });
    const diffCompleted = (status: "ready" | "missing" | "error") =>
      makeEvent("thread.turn-diff-completed", {
        threadId,
        turnId,
        checkpointTurnCount: 1,
        checkpointRef: CheckpointRef.makeUnsafe("checkpoint-1"),
        status,
        files: [],
        assistantMessageId: null,
        completedAt: "2026-02-27T00:00:05.000Z",
      });
    const messageSent = () =>
      makeEvent("thread.message-sent", {
        threadId,
        messageId: MessageId.makeUnsafe("assistant-1"),
        role: "assistant",
        text: "done",
        turnId,
        streaming: false,
        createdAt: "2026-02-27T00:00:04.000Z",
        updatedAt: "2026-02-27T00:00:04.000Z",
      });
    const runningState = () =>
      applyOrchestrationEvent(
        makeState(makeThread({ latestTurn: runningTurn })),
        sessionSet("running"),
      );

    it.each([
      ["error", "error"],
      ["stopped", "interrupted"],
      ["interrupted", "interrupted"],
      ["ready", "completed"],
    ] as const)("settles a running turn when the session goes %s", (status, expected) => {
      const next = applyOrchestrationEvent(
        runningState(),
        sessionSet(status, "2026-02-27T00:00:10.000Z"),
      );
      expect(next.threads[0]?.latestTurn?.state).toBe(expected);
      expect(next.threads[0]?.latestTurn?.completedAt).toBe("2026-02-27T00:00:10.000Z");
    });

    it("does not settle while the session is starting", () => {
      const next = applyOrchestrationEvent(
        makeState(makeThread({ latestTurn: runningTurn })),
        sessionSet("starting"),
      );
      expect(next.threads[0]?.latestTurn?.state).toBe("running");
      expect(next.threads[0]?.latestTurn?.completedAt).toBeNull();
    });

    it("leaves an already settled turn alone when the session changes", () => {
      const settled = { ...runningTurn, state: "interrupted" as const, completedAt: "t" };
      const next = applyOrchestrationEvent(
        makeState(makeThread({ latestTurn: settled })),
        sessionSet("ready"),
      );
      expect(next.threads[0]?.latestTurn).toEqual(settled);
    });

    it("records a missing diff during a run without settling the turn", () => {
      const next = applyOrchestrationEvent(runningState(), diffCompleted("missing"));
      expect(next.threads[0]?.turnDiffSummaries.map((entry) => entry.status)).toEqual(["missing"]);
      expect(next.threads[0]?.latestTurn?.state).toBe("running");
      expect(next.threads[0]?.latestTurn?.completedAt).toBeNull();
    });

    it("lets a real checkpoint replace a missing placeholder after the session ends", () => {
      const next = applyOrchestrationEvents(runningState(), [
        diffCompleted("missing"),
        sessionSet("ready"),
        diffCompleted("ready"),
      ]);
      expect(next.threads[0]?.turnDiffSummaries.map((entry) => entry.status)).toEqual(["ready"]);
      expect(next.threads[0]?.latestTurn?.state).toBe("completed");
    });

    it("keeps a failed turn failed through a later message and checkpoint", () => {
      const next = applyOrchestrationEvents(runningState(), [
        sessionSet("error"),
        messageSent(),
        diffCompleted("ready"),
      ]);
      expect(next.threads[0]?.latestTurn?.state).toBe("error");
    });

    it("does not reopen an interrupt-requested turn on a final message", () => {
      const next = applyOrchestrationEvents(runningState(), [
        makeEvent("thread.turn-interrupt-requested", {
          threadId,
          turnId,
          createdAt: "2026-02-27T00:00:03.000Z",
        }),
        messageSent(),
        sessionSet("ready"),
      ]);
      expect(next.threads[0]?.latestTurn?.state).toBe("interrupted");
      expect(next.threads[0]?.latestTurn?.completedAt).toBe("2026-02-27T00:00:03.000Z");
    });

    it("settles on the final message once the session no longer runs the turn", () => {
      const next = applyOrchestrationEvent(
        makeState(makeThread({ latestTurn: runningTurn })),
        messageSent(),
      );
      expect(next.threads[0]?.latestTurn?.state).toBe("completed");
      expect(next.threads[0]?.latestTurn?.completedAt).toBe("2026-02-27T00:00:04.000Z");
    });
  });

  it("does not regress latestTurn when an older turn diff completes late", () => {
    const state = makeState(
      makeThread({
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-2"),
          state: "running",
          requestedAt: "2026-02-27T00:00:02.000Z",
          startedAt: "2026-02-27T00:00:03.000Z",
          completedAt: null,
          assistantMessageId: null,
        },
      }),
    );

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.turn-diff-completed", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId: TurnId.makeUnsafe("turn-1"),
        checkpointTurnCount: 1,
        checkpointRef: CheckpointRef.makeUnsafe("checkpoint-1"),
        status: "ready",
        files: [],
        assistantMessageId: MessageId.makeUnsafe("assistant-1"),
        completedAt: "2026-02-27T00:00:04.000Z",
      }),
    );

    expect(next.threads[0]?.turnDiffSummaries).toHaveLength(1);
    expect(next.threads[0]?.latestTurn).toEqual(state.threads[0]?.latestTurn);
  });

  it("keeps an interrupted latest turn interrupted when its checkpoint arrives", () => {
    const turnId = TurnId.makeUnsafe("turn-1");
    const state = makeState(
      makeThread({
        latestTurn: {
          turnId,
          state: "interrupted",
          requestedAt: "2026-02-27T00:00:00.000Z",
          startedAt: "2026-02-27T00:00:01.000Z",
          completedAt: "2026-02-27T00:00:02.000Z",
          assistantMessageId: null,
        },
      }),
    );

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.turn-diff-completed", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId,
        checkpointTurnCount: 1,
        checkpointRef: CheckpointRef.makeUnsafe("checkpoint-1"),
        status: "ready",
        files: [],
        assistantMessageId: MessageId.makeUnsafe("assistant-1"),
        completedAt: "2026-02-27T00:00:04.000Z",
      }),
    );

    expect(next.threads[0]?.turnDiffSummaries).toHaveLength(1);
    expect(next.threads[0]?.latestTurn?.state).toBe("interrupted");
  });

  it("completes the latest turn when a ready checkpoint follows a missing placeholder", () => {
    const turnId = TurnId.makeUnsafe("turn-1");
    const state = makeState(
      makeThread({
        latestTurn: {
          turnId,
          state: "running",
          requestedAt: "2026-02-27T00:00:00.000Z",
          startedAt: "2026-02-27T00:00:01.000Z",
          completedAt: null,
          assistantMessageId: null,
        },
      }),
    );

    const afterPlaceholder = applyOrchestrationEvent(
      state,
      makeEvent("thread.turn-diff-completed", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId,
        checkpointTurnCount: 1,
        checkpointRef: CheckpointRef.makeUnsafe("checkpoint-1"),
        status: "missing",
        files: [],
        assistantMessageId: null,
        completedAt: "2026-02-27T00:00:02.000Z",
      }),
    );
    const next = applyOrchestrationEvent(
      afterPlaceholder,
      makeEvent("thread.turn-diff-completed", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId,
        checkpointTurnCount: 1,
        checkpointRef: CheckpointRef.makeUnsafe("checkpoint-1"),
        status: "ready",
        files: [],
        assistantMessageId: MessageId.makeUnsafe("assistant-1"),
        completedAt: "2026-02-27T00:00:04.000Z",
      }),
    );

    expect(next.threads[0]?.turnDiffSummaries).toHaveLength(1);
    expect(next.threads[0]?.latestTurn?.state).toBe("completed");
  });

  it("rebinds live turn diffs to the authoritative assistant message when it arrives later", () => {
    const turnId = TurnId.makeUnsafe("turn-1");
    const state = makeState(
      makeThread({
        latestTurn: {
          turnId,
          state: "completed",
          requestedAt: "2026-02-27T00:00:00.000Z",
          startedAt: "2026-02-27T00:00:00.000Z",
          completedAt: "2026-02-27T00:00:02.000Z",
          assistantMessageId: MessageId.makeUnsafe("assistant:turn-1"),
        },
        turnDiffSummaries: [
          {
            turnId,
            completedAt: "2026-02-27T00:00:02.000Z",
            status: "ready",
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.makeUnsafe("checkpoint-1"),
            assistantMessageId: MessageId.makeUnsafe("assistant:turn-1"),
            files: [{ path: "src/app.ts", additions: 1, deletions: 0 }],
          },
        ],
      }),
    );

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.message-sent", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId: MessageId.makeUnsafe("assistant-real"),
        role: "assistant",
        text: "final answer",
        turnId,
        streaming: false,
        createdAt: "2026-02-27T00:00:03.000Z",
        updatedAt: "2026-02-27T00:00:03.000Z",
      }),
    );

    expect(next.threads[0]?.turnDiffSummaries[0]?.assistantMessageId).toBe(
      MessageId.makeUnsafe("assistant-real"),
    );
    expect(next.threads[0]?.latestTurn?.assistantMessageId).toBe(
      MessageId.makeUnsafe("assistant-real"),
    );
  });

  it("reverts messages, plans, activities, and checkpoints by retained turns", () => {
    const state = makeState(
      makeThread({
        messages: [
          {
            id: MessageId.makeUnsafe("user-1"),
            role: "user",
            text: "first",
            turnId: TurnId.makeUnsafe("turn-1"),
            createdAt: "2026-02-27T00:00:00.000Z",
            completedAt: "2026-02-27T00:00:00.000Z",
            streaming: false,
          },
          {
            id: MessageId.makeUnsafe("assistant-1"),
            role: "assistant",
            text: "first reply",
            turnId: TurnId.makeUnsafe("turn-1"),
            createdAt: "2026-02-27T00:00:01.000Z",
            completedAt: "2026-02-27T00:00:01.000Z",
            streaming: false,
          },
          {
            id: MessageId.makeUnsafe("user-2"),
            role: "user",
            text: "second",
            turnId: TurnId.makeUnsafe("turn-2"),
            createdAt: "2026-02-27T00:00:02.000Z",
            completedAt: "2026-02-27T00:00:02.000Z",
            streaming: false,
          },
        ],
        proposedPlans: [
          {
            id: "plan-1",
            turnId: TurnId.makeUnsafe("turn-1"),
            planMarkdown: "plan 1",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-02-27T00:00:00.000Z",
            updatedAt: "2026-02-27T00:00:00.000Z",
          },
          {
            id: "plan-2",
            turnId: TurnId.makeUnsafe("turn-2"),
            planMarkdown: "plan 2",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-02-27T00:00:02.000Z",
            updatedAt: "2026-02-27T00:00:02.000Z",
          },
        ],
        activities: [
          {
            id: EventId.makeUnsafe("activity-1"),
            tone: "info",
            kind: "step",
            summary: "one",
            payload: {},
            turnId: TurnId.makeUnsafe("turn-1"),
            createdAt: "2026-02-27T00:00:00.000Z",
          },
          {
            id: EventId.makeUnsafe("activity-2"),
            tone: "info",
            kind: "step",
            summary: "two",
            payload: {},
            turnId: TurnId.makeUnsafe("turn-2"),
            createdAt: "2026-02-27T00:00:02.000Z",
          },
        ],
        turnDiffSummaries: [
          {
            turnId: TurnId.makeUnsafe("turn-1"),
            completedAt: "2026-02-27T00:00:01.000Z",
            status: "ready",
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.makeUnsafe("ref-1"),
            files: [],
          },
          {
            turnId: TurnId.makeUnsafe("turn-2"),
            completedAt: "2026-02-27T00:00:03.000Z",
            status: "ready",
            checkpointTurnCount: 2,
            checkpointRef: CheckpointRef.makeUnsafe("ref-2"),
            files: [],
          },
        ],
      }),
    );

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.reverted", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnCount: 1,
      }),
    );

    expect(next.threads[0]?.messages.map((message) => message.id)).toEqual([
      "user-1",
      "assistant-1",
    ]);
    expect(next.threads[0]?.proposedPlans.map((plan) => plan.id)).toEqual(["plan-1"]);
    expect(next.threads[0]?.activities.map((activity) => activity.id)).toEqual([
      EventId.makeUnsafe("activity-1"),
    ]);
    expect(next.threads[0]?.turnDiffSummaries.map((summary) => summary.turnId)).toEqual([
      TurnId.makeUnsafe("turn-1"),
    ]);
  });

  it("clears pending source proposed plans after revert before a new session-set event", () => {
    const thread = makeThread({
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-2"),
        state: "completed",
        requestedAt: "2026-02-27T00:00:02.000Z",
        startedAt: "2026-02-27T00:00:02.000Z",
        completedAt: "2026-02-27T00:00:03.000Z",
        assistantMessageId: MessageId.makeUnsafe("assistant-2"),
        sourceProposedPlan: {
          threadId: ThreadId.makeUnsafe("thread-source"),
          planId: "plan-2" as never,
        },
      },
      pendingSourceProposedPlan: {
        threadId: ThreadId.makeUnsafe("thread-source"),
        planId: "plan-2" as never,
      },
      turnDiffSummaries: [
        {
          turnId: TurnId.makeUnsafe("turn-1"),
          completedAt: "2026-02-27T00:00:01.000Z",
          status: "ready",
          checkpointTurnCount: 1,
          checkpointRef: CheckpointRef.makeUnsafe("ref-1"),
          files: [],
        },
        {
          turnId: TurnId.makeUnsafe("turn-2"),
          completedAt: "2026-02-27T00:00:03.000Z",
          status: "ready",
          checkpointTurnCount: 2,
          checkpointRef: CheckpointRef.makeUnsafe("ref-2"),
          files: [],
        },
      ],
    });
    const reverted = applyOrchestrationEvent(
      makeState(thread),
      makeEvent("thread.reverted", {
        threadId: thread.id,
        turnCount: 1,
      }),
    );

    expect(reverted.threads[0]?.pendingSourceProposedPlan).toBeUndefined();

    const next = applyOrchestrationEvent(
      reverted,
      makeEvent("thread.session-set", {
        threadId: thread.id,
        session: {
          threadId: thread.id,
          status: "running",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: TurnId.makeUnsafe("turn-3"),
          lastError: null,
          updatedAt: "2026-02-27T00:00:04.000Z",
        },
      }),
    );

    expect(next.threads[0]?.latestTurn).toMatchObject({
      turnId: TurnId.makeUnsafe("turn-3"),
      state: "running",
    });
    expect(next.threads[0]?.latestTurn?.sourceProposedPlan).toBeUndefined();
  });
});

describe("incremental thread updates", () => {
  function makeActivity(
    id: string,
    sequence: number,
    overrides: Partial<Thread["activities"][number]> = {},
  ): Thread["activities"][number] {
    return {
      id: EventId.makeUnsafe(id),
      tone: "info",
      kind: "task.started",
      summary: id,
      payload: {},
      turnId: null,
      sequence,
      createdAt: `2026-02-27T00:00:${String(sequence).padStart(2, "0")}.000Z`,
      ...overrides,
    };
  }

  function approvalRequested(id: string, sequence: number, requestId: string) {
    return makeActivity(id, sequence, {
      tone: "approval",
      kind: "approval.requested",
      payload: { requestId, requestKind: "command" },
    });
  }

  function appendActivity(state: AppState, activity: Thread["activities"][number]): AppState {
    return applyOrchestrationEvent(
      state,
      makeEvent(
        "thread.activity-appended",
        { threadId: ThreadId.makeUnsafe("thread-1"), activity },
        { sequence: activity.sequence ?? 1 },
      ),
    );
  }

  it("appends in-order activities and keeps the array sorted", () => {
    let state = makeState(makeThread());
    state = appendActivity(state, makeActivity("a-1", 1));
    state = appendActivity(state, makeActivity("a-2", 2));
    const beforeAppend = state.threads[0]!.activities;
    state = appendActivity(state, makeActivity("a-3", 3));

    expect(state.threads[0]?.activities.map((activity) => activity.id)).toEqual([
      "a-1",
      "a-2",
      "a-3",
    ]);
    expect(beforeAppend.map((activity) => activity.id)).toEqual(["a-1", "a-2"]);
  });

  it("appends in-order activities without re-sorting and sorts out-of-order ones", () => {
    const indexed = appendThreadActivity([], makeActivity("a-1", 1));
    const toSorted = vi.spyOn(Array.prototype, "toSorted");
    try {
      const inOrder = appendThreadActivity(indexed, makeActivity("a-2", 2));
      expect(toSorted).not.toHaveBeenCalled();
      const outOfOrder = appendThreadActivity(inOrder, makeActivity("a-0", 0));
      expect(toSorted).toHaveBeenCalledTimes(1);
      expect(outOfOrder.map((activity) => activity.id)).toEqual(["a-0", "a-1", "a-2"]);
    } finally {
      toSorted.mockRestore();
    }
  });

  it("dedupes a re-delivery arriving right after an in-order append", () => {
    let state = makeState(makeThread());
    state = appendActivity(state, makeActivity("a-1", 1));
    state = appendActivity(state, makeActivity("a-2", 2));
    state = appendActivity(state, makeActivity("a-3", 3));
    state = appendActivity(state, makeActivity("a-3", 4, { summary: "re-delivered" }));

    const activities = state.threads[0]!.activities;
    expect(activities.map((activity) => activity.id)).toEqual(["a-1", "a-2", "a-3"]);
    expect(activities[2]?.summary).toBe("re-delivered");
  });

  it("re-sorts out-of-order activities and replaces re-delivered ids", () => {
    let state = makeState(makeThread());
    state = appendActivity(state, makeActivity("a-1", 1));
    state = appendActivity(state, makeActivity("a-3", 3));
    state = appendActivity(state, makeActivity("a-2", 2));
    state = appendActivity(state, makeActivity("a-3", 3, { summary: "replaced" }));

    const activities = state.threads[0]!.activities;
    expect(activities.map((activity) => activity.id)).toEqual(["a-1", "a-2", "a-3"]);
    expect(activities[2]?.summary).toBe("replaced");
  });

  it("appends onto snapshot-loaded activity arrays without losing order", () => {
    const thread = makeThread({
      activities: [makeActivity("a-5", 5), makeActivity("a-2", 2)],
    });
    const next = appendActivity(makeState(thread), makeActivity("a-7", 7));

    expect(next.threads[0]?.activities.map((activity) => activity.id)).toEqual([
      "a-2",
      "a-5",
      "a-7",
    ]);
  });

  it("caps appended activities at the retention limit", () => {
    let state = makeState(makeThread());
    for (let index = 1; index <= MAX_THREAD_ACTIVITIES + 2; index += 1) {
      state = appendActivity(state, makeActivity(`a-${index}`, index, { kind: "task.progress" }));
    }
    const activities = state.threads[0]!.activities;
    expect(activities).toHaveLength(MAX_THREAD_ACTIVITIES);
    expect(activities[0]?.id).toBe("a-3");
    expect(activities.at(-1)?.id).toBe(`a-${MAX_THREAD_ACTIVITIES + 2}`);

    // A dropped id can be re-delivered as a fresh in-order append later.
    const readded = appendActivity(
      state,
      makeActivity("a-1", MAX_THREAD_ACTIVITIES + 3, { summary: "again" }),
    );
    expect(readded.threads[0]?.activities.at(-1)?.id).toBe("a-1");
  });

  it("keeps the newest goal row and a running task's start past the retention limit", () => {
    let state = makeState(makeThread());
    state = appendActivity(
      state,
      makeActivity("goal", 1, { kind: "goal.updated" as never, payload: {} }),
    );
    state = appendActivity(
      state,
      makeActivity("task-open", 2, { kind: "task.started", payload: { taskId: "a" } }),
    );
    state = appendActivity(
      state,
      makeActivity("task-done", 3, { kind: "task.started", payload: { taskId: "b" } }),
    );
    state = appendActivity(
      state,
      makeActivity("task-done-end", 4, { kind: "task.completed", payload: { taskId: "b" } }),
    );
    for (let index = 5; index <= MAX_THREAD_ACTIVITIES + 10; index += 1) {
      state = appendActivity(state, makeActivity(`a-${index}`, index, { kind: "task.progress" }));
    }
    const ids = state.threads[0]!.activities.map((activity) => activity.id);
    expect(ids).toContain("goal");
    expect(ids).toContain("task-open");
    expect(ids).not.toContain("task-done");
  });

  it("recomputes sidebar pending flags on activity events and reuses them for message deltas", () => {
    const base = syncServerReadModel(
      makeState(makeThread()),
      makeReadModel(makeReadModelThread({})),
    );
    const withApproval = appendActivity(base, approvalRequested("a-1", 1, "req-1"));
    expect(withApproval.sidebarThreadsById["thread-1"]?.hasPendingApprovals).toBe(true);

    const delta = applyOrchestrationEvent(
      withApproval,
      makeEvent("thread.message-sent", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId: MessageId.makeUnsafe("message-1"),
        role: "assistant",
        text: "chunk",
        turnId: TurnId.makeUnsafe("turn-1"),
        streaming: true,
        createdAt: "2026-02-27T00:00:01.000Z",
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
    );
    expect(delta.sidebarThreadsById["thread-1"]?.hasPendingApprovals).toBe(true);
    expect(delta.sidebarThreadsById["thread-1"]?.updatedAt).toBe(delta.threads[0]?.updatedAt);

    const resolved = appendActivity(
      delta,
      makeActivity("a-2", 2, {
        kind: "approval.resolved",
        payload: { requestId: "req-1", decision: "accept" },
      }),
    );
    expect(resolved.sidebarThreadsById["thread-1"]?.hasPendingApprovals).toBe(false);
  });

  it("reuses the previous pending flags on message deltas instead of re-deriving them", () => {
    const base = syncServerReadModel(
      makeState(makeThread()),
      makeReadModel(makeReadModelThread({})),
    );
    // Sentinel: re-deriving from the (empty) activities would yield false.
    const seeded: AppState = {
      ...base,
      sidebarThreadsById: {
        ...base.sidebarThreadsById,
        "thread-1": { ...base.sidebarThreadsById["thread-1"]!, hasPendingApprovals: true },
      },
    };
    const delta = applyOrchestrationEvent(
      seeded,
      makeEvent("thread.message-sent", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId: MessageId.makeUnsafe("message-1"),
        role: "assistant",
        text: "chunk",
        turnId: TurnId.makeUnsafe("turn-1"),
        streaming: true,
        createdAt: "2026-02-27T00:00:01.000Z",
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
    );
    expect(delta.sidebarThreadsById["thread-1"]?.hasPendingApprovals).toBe(true);
  });

  it("folds latestUserMessageAt on message events without rescanning history", () => {
    const base = syncServerReadModel(
      makeState(makeThread()),
      makeReadModel(makeReadModelThread({})),
    );
    // Sentinel: a rescan of the (empty) history would yield null.
    const sentinel = "2026-02-27T00:00:03.000Z";
    const seeded: AppState = {
      ...base,
      sidebarThreadsById: {
        ...base.sidebarThreadsById,
        "thread-1": { ...base.sidebarThreadsById["thread-1"]!, latestUserMessageAt: sentinel },
      },
    };
    const assistantDelta = applyOrchestrationEvent(
      seeded,
      makeEvent("thread.message-sent", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId: MessageId.makeUnsafe("message-assistant"),
        role: "assistant",
        text: "chunk",
        turnId: TurnId.makeUnsafe("turn-1"),
        streaming: true,
        createdAt: "2026-02-27T00:00:01.000Z",
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
    );
    expect(assistantDelta.sidebarThreadsById["thread-1"]?.latestUserMessageAt).toBe(sentinel);

    const userMessage = applyOrchestrationEvent(
      assistantDelta,
      makeEvent("thread.message-sent", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId: MessageId.makeUnsafe("message-user"),
        role: "user",
        text: "hi",
        turnId: TurnId.makeUnsafe("turn-2"),
        streaming: false,
        createdAt: "2026-02-27T00:00:09.000Z",
        updatedAt: "2026-02-27T00:00:09.000Z",
      }),
    );
    expect(userMessage.sidebarThreadsById["thread-1"]?.latestUserMessageAt).toBe(
      "2026-02-27T00:00:09.000Z",
    );
  });

  it("rescans latestUserMessageAt when the retention cap evicts the oldest message", () => {
    const messages: Thread["messages"] = Array.from(
      { length: MAX_THREAD_MESSAGES },
      (_, index) => ({
        id: MessageId.makeUnsafe(`message-${index}`),
        role: index === 0 ? ("user" as const) : ("assistant" as const),
        text: "x",
        createdAt: `2026-02-27T00:00:${String(index % 60).padStart(2, "0")}.000Z`,
        streaming: false,
      }),
    );
    const state = makeState(makeThread({ messages }));
    const seeded: AppState = {
      ...state,
      sidebarThreadsById: {
        "thread-1": {
          ...syncServerReadModel(state, makeReadModel(makeReadModelThread({}))).sidebarThreadsById[
            "thread-1"
          ]!,
          latestUserMessageAt: messages[0]!.createdAt,
        },
      },
    };

    const next = applyOrchestrationEvent(
      seeded,
      makeEvent("thread.message-sent", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId: MessageId.makeUnsafe("message-new"),
        role: "assistant",
        text: "y",
        turnId: TurnId.makeUnsafe("turn-1"),
        streaming: false,
        createdAt: "2026-02-27T00:01:00.000Z",
        updatedAt: "2026-02-27T00:01:00.000Z",
      }),
    );

    expect(next.threads[0]?.messages[0]?.id).toBe("message-1");
    expect(next.sidebarThreadsById["thread-1"]?.latestUserMessageAt).toBeNull();
  });

  it("tracks latestUserMessageAt when a user message arrives", () => {
    const base = syncServerReadModel(
      makeState(makeThread()),
      makeReadModel(makeReadModelThread({})),
    );
    expect(base.sidebarThreadsById["thread-1"]?.latestUserMessageAt).toBeNull();

    const next = applyOrchestrationEvent(
      base,
      makeEvent("thread.message-sent", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId: MessageId.makeUnsafe("message-user"),
        role: "user",
        text: "hi",
        turnId: TurnId.makeUnsafe("turn-1"),
        streaming: false,
        createdAt: "2026-02-27T00:00:05.000Z",
        updatedAt: "2026-02-27T00:00:05.000Z",
      }),
    );
    expect(next.sidebarThreadsById["thread-1"]?.latestUserMessageAt).toBe(
      "2026-02-27T00:00:05.000Z",
    );
  });

  it("updates a streaming message in place without touching its neighbours", () => {
    const first = {
      id: MessageId.makeUnsafe("message-1"),
      role: "user" as const,
      text: "hi",
      turnId: TurnId.makeUnsafe("turn-1"),
      createdAt: "2026-02-27T00:00:00.000Z",
      completedAt: "2026-02-27T00:00:00.000Z",
      streaming: false,
    };
    const second = {
      id: MessageId.makeUnsafe("message-2"),
      role: "assistant" as const,
      text: "hel",
      turnId: TurnId.makeUnsafe("turn-1"),
      createdAt: "2026-02-27T00:00:01.000Z",
      streaming: true,
    };
    const state = makeState(makeThread({ messages: [first, second] }));

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.message-sent", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId: MessageId.makeUnsafe("message-2"),
        role: "assistant",
        text: "lo",
        turnId: TurnId.makeUnsafe("turn-1"),
        streaming: true,
        createdAt: "2026-02-27T00:00:01.000Z",
        updatedAt: "2026-02-27T00:00:02.000Z",
      }),
    );

    const messages = next.threads[0]!.messages;
    expect(messages).toHaveLength(2);
    expect(messages[0]).toBe(first);
    expect(messages[1]?.text).toBe("hello");
    expect(messages[1]?.streaming).toBe(true);
    expect(messages[1]?.completedAt).toBeUndefined();
  });

  it("keeps turnDiffSummaries identity when a message delta rebinds nothing", () => {
    const summaries: Thread["turnDiffSummaries"] = [
      {
        turnId: TurnId.makeUnsafe("turn-1"),
        completedAt: "2026-02-27T00:00:00.000Z",
        status: "ready",
        assistantMessageId: MessageId.makeUnsafe("message-1"),
        checkpointTurnCount: 1,
        checkpointRef: CheckpointRef.makeUnsafe("ref-1"),
        files: [],
      },
    ];
    const state = makeState(makeThread({ turnDiffSummaries: summaries }));
    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.message-sent", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId: MessageId.makeUnsafe("message-1"),
        role: "assistant",
        text: "x",
        turnId: TurnId.makeUnsafe("turn-1"),
        streaming: true,
        createdAt: "2026-02-27T00:00:01.000Z",
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
    );
    expect(next.threads[0]?.turnDiffSummaries).toBe(summaries);
  });

  it("keeps the latestTurn reference across consecutive streaming deltas", () => {
    const state = makeState(makeThread());
    const delta = (text: string, sequence: number, updatedAt: string) =>
      makeEvent(
        "thread.message-sent",
        {
          threadId: ThreadId.makeUnsafe("thread-1"),
          messageId: MessageId.makeUnsafe("assistant-stream"),
          role: "assistant",
          text,
          turnId: TurnId.makeUnsafe("turn-stream"),
          streaming: true,
          createdAt: "2026-02-27T00:00:01.000Z",
          updatedAt,
        },
        { sequence },
      );

    const first = applyOrchestrationEvent(state, delta("hel", 1, "2026-02-27T00:00:01.000Z"));
    const second = applyOrchestrationEvent(first, delta("lo", 2, "2026-02-27T00:00:02.000Z"));

    const firstLatestTurn = first.threads[0]?.latestTurn;
    expect(firstLatestTurn?.turnId).toBe(TurnId.makeUnsafe("turn-stream"));
    expect(second.threads[0]?.messages.at(-1)?.text).toBe("hello");
    expect(second.threads[0]?.latestTurn).toBe(firstLatestTurn);
  });
});

describe("tool input preview slice", () => {
  function makePreviewEvent(overrides: Partial<ToolInputPreviewEvent> = {}): ToolInputPreviewEvent {
    return {
      threadId: ThreadId.makeUnsafe("thread-1"),
      itemId: ProviderItemId.makeUnsafe("item-1"),
      toolName: "Write",
      fieldName: "content",
      delta: "hello",
      ...overrides,
    };
  }

  it("accumulates deltas across multiple events for the same item", () => {
    const state = makeState(makeThread());

    const next = applyToolInputPreviewBatch(state, [
      makePreviewEvent({ delta: "hel" }),
      makePreviewEvent({ delta: "lo " }),
      makePreviewEvent({ delta: "world" }),
    ]);

    expect(next.toolInputPreviews["thread-1"]?.["item-1"]?.text).toBe("hello world");
    expect(next.toolInputPreviews["thread-1"]?.["item-1"]?.toolName).toBe("Write");
  });

  it("replaces a Bash command preview with its live output", () => {
    const next = applyToolInputPreviewBatch(makeState(makeThread()), [
      makePreviewEvent({ toolName: "Bash", fieldName: "command", delta: "npm " }),
      makePreviewEvent({ toolName: "Bash", fieldName: "command", delta: "test" }),
      makePreviewEvent({
        toolName: "Bash",
        fieldName: LIVE_COMMAND_OUTPUT_FIELD,
        delta: "line 1\n",
      }),
      makePreviewEvent({
        toolName: "Bash",
        fieldName: LIVE_COMMAND_OUTPUT_FIELD,
        delta: "line 2\n",
      }),
    ]);

    const stream = next.toolInputPreviews["thread-1"]?.["item-1"];
    expect(stream?.text).toBe("line 1\nline 2\n");
    expect(stream?.fieldName).toBe(LIVE_COMMAND_OUTPUT_FIELD);
  });

  it("caps live output at the display limit", () => {
    const line = `${"x".repeat(1023)}\n`;
    const next = applyToolInputPreviewBatch(
      makeState(makeThread()),
      Array.from({ length: 100 }, () =>
        makePreviewEvent({ toolName: "Bash", fieldName: LIVE_COMMAND_OUTPUT_FIELD, delta: line }),
      ),
    );

    const text = next.toolInputPreviews["thread-1"]?.["item-1"]?.text ?? "";
    expect(text.length).toBeLessThanOrEqual(LIVE_COMMAND_OUTPUT_MAX_CHARS);
    expect(text.endsWith(line)).toBe(true);
  });

  it("captures filePath when provided", () => {
    const state = makeState(makeThread());
    const next = applyToolInputPreviewBatch(state, [
      makePreviewEvent({ delta: "x", filePath: "src/app.ts" }),
    ]);
    expect(next.toolInputPreviews["thread-1"]?.["item-1"]?.filePath).toBe("src/app.ts");
  });

  it("drops events with an empty itemId", () => {
    const state = makeState(makeThread());
    const next = applyToolInputPreviewBatch(state, [
      {
        threadId: ThreadId.makeUnsafe("thread-1"),
        itemId: "" as ToolInputPreviewEvent["itemId"],
        toolName: "Write",
        fieldName: "content",
        delta: "ignored",
      },
    ]);
    expect(next).toBe(state);
    expect(next.toolInputPreviews).toEqual({});
  });

  it("clearItemPreview removes a single entry and prunes the empty thread bucket", () => {
    const state = applyToolInputPreviewBatch(makeState(makeThread()), [
      makePreviewEvent({ delta: "hi" }),
    ]);
    expect(state.toolInputPreviews["thread-1"]?.["item-1"]).toBeDefined();

    const next = clearItemPreview(state, "thread-1", "item-1");

    expect(next.toolInputPreviews["thread-1"]).toBeUndefined();
  });

  it("clearItemPreview keeps other entries in the same thread bucket", () => {
    const state = applyToolInputPreviewBatch(makeState(makeThread()), [
      makePreviewEvent({ itemId: ProviderItemId.makeUnsafe("item-1"), delta: "a" }),
      makePreviewEvent({ itemId: ProviderItemId.makeUnsafe("item-2"), delta: "b" }),
    ]);

    const next = clearItemPreview(state, "thread-1", "item-1");

    expect(next.toolInputPreviews["thread-1"]?.["item-1"]).toBeUndefined();
    expect(next.toolInputPreviews["thread-1"]?.["item-2"]?.text).toBe("b");
  });

  it("clearThreadPreviews clears the targeted thread without touching others", () => {
    const seeded = applyToolInputPreviewBatch(makeState(makeThread()), [
      makePreviewEvent({ threadId: ThreadId.makeUnsafe("thread-1"), delta: "a" }),
      makePreviewEvent({
        threadId: ThreadId.makeUnsafe("thread-2"),
        itemId: ProviderItemId.makeUnsafe("item-2"),
        delta: "b",
      }),
    ]);

    const next = clearThreadPreviews(seeded, "thread-1");

    expect(next.toolInputPreviews["thread-1"]).toBeUndefined();
    expect(next.toolInputPreviews["thread-2"]?.["item-2"]?.text).toBe("b");
  });

  it("tool.completed clears only the completed item's live preview", () => {
    const seeded = applyToolInputPreviewBatch(makeState(makeThread()), [
      makePreviewEvent({ delta: "hello" }),
      makePreviewEvent({ itemId: ProviderItemId.makeUnsafe("item-2"), delta: "other" }),
    ]);

    const next = applyOrchestrationEvent(
      seeded,
      makeEvent("thread.activity-appended", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        activity: {
          id: EventId.makeUnsafe("activity-tool-complete"),
          tone: "tool",
          kind: "tool.completed",
          summary: "Write completed",
          payload: {
            providerItemId: "item-1",
            itemType: "file_change",
          },
          turnId: null,
          createdAt: "2026-02-27T00:00:01.000Z",
        },
      }),
    );

    expect(next.toolInputPreviews["thread-1"]?.["item-1"]).toBeUndefined();
    expect(next.toolInputPreviews["thread-1"]?.["item-2"]?.text).toBe("other");
    expect(next.threads[0]?.activities.map((activity) => activity.id)).toEqual([
      "activity-tool-complete",
    ]);
  });

  it("ignores preview deltas that arrive after the item's tool completed", () => {
    const seeded = applyToolInputPreviewBatch(makeState(makeThread()), [
      makePreviewEvent({ delta: "hel" }),
    ]);
    const completed = applyOrchestrationEvent(
      seeded,
      makeEvent("thread.activity-appended", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        activity: {
          id: EventId.makeUnsafe("activity-tool-complete"),
          tone: "tool",
          kind: "tool.completed",
          summary: "Write completed",
          payload: { providerItemId: "item-1", itemType: "file_change" },
          turnId: null,
          createdAt: "2026-02-27T00:00:01.000Z",
        },
      }),
    );

    const late = applyToolInputPreviewBatch(completed, [
      makePreviewEvent({ delta: "lo" }),
      makePreviewEvent({ delta: " world" }),
      makePreviewEvent({ itemId: ProviderItemId.makeUnsafe("item-2"), delta: "next" }),
    ]);

    expect(late.toolInputPreviews["thread-1"]?.["item-1"]).toBeUndefined();
    expect(late.toolInputPreviews["thread-1"]?.["item-2"]?.text).toBe("next");
  });

  it("tool.updated keeps the live preview streaming", () => {
    const seeded = applyToolInputPreviewBatch(makeState(makeThread()), [
      makePreviewEvent({ delta: "hello" }),
    ]);

    const next = applyOrchestrationEvent(
      seeded,
      makeEvent("thread.activity-appended", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        activity: {
          id: EventId.makeUnsafe("activity-tool-updated"),
          tone: "tool",
          kind: "tool.updated",
          summary: "Write",
          payload: { providerItemId: "item-1", itemType: "file_change" },
          turnId: null,
          createdAt: "2026-02-27T00:00:01.000Z",
        },
      }),
    );

    expect(next.toolInputPreviews["thread-1"]?.["item-1"]?.text).toBe("hello");
  });

  it("turn-interrupt-requested clears all previews for the thread", () => {
    const seeded = applyToolInputPreviewBatch(makeState(makeThread()), [
      makePreviewEvent({ delta: "a" }),
      makePreviewEvent({
        itemId: ProviderItemId.makeUnsafe("item-2"),
        delta: "b",
      }),
    ]);

    const next = applyOrchestrationEvent(
      seeded,
      makeEvent("thread.turn-interrupt-requested", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId: TurnId.makeUnsafe("turn-1"),
        createdAt: "2026-02-27T00:00:01.000Z",
      }),
    );

    expect(next.toolInputPreviews["thread-1"]).toBeUndefined();
  });

  it("thread.deleted clears the previews for the deleted thread", () => {
    const seeded = applyToolInputPreviewBatch(makeState(makeThread()), [
      makePreviewEvent({ delta: "a" }),
    ]);

    const next = applyOrchestrationEvent(
      seeded,
      makeEvent("thread.deleted", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        deletedAt: "2026-02-27T00:00:01.000Z",
      }),
    );

    expect(next.toolInputPreviews["thread-1"]).toBeUndefined();
  });

  it("thread.reverted clears all previews for the thread", () => {
    const seeded = applyToolInputPreviewBatch(makeState(makeThread()), [
      makePreviewEvent({ delta: "a" }),
    ]);

    const next = applyOrchestrationEvent(
      seeded,
      makeEvent("thread.reverted", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnCount: 0,
      }),
    );

    expect(next.toolInputPreviews["thread-1"]).toBeUndefined();
  });

  it("thread.session-set with stopped status clears all previews for the thread", () => {
    const seeded = applyToolInputPreviewBatch(makeState(makeThread()), [
      makePreviewEvent({ delta: "a" }),
    ]);

    const next = applyOrchestrationEvent(
      seeded,
      makeEvent("thread.session-set", {
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "stopped",
          providerName: "claudeAgent",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-02-27T00:00:01.000Z",
        },
      }),
    );

    expect(next.toolInputPreviews["thread-1"]).toBeUndefined();
  });
});

describe("refreshLiveBackgroundTaskSummaries", () => {
  it("re-derives a thread showing a live task once its silence bound passes", () => {
    const thread = makeThread({ session: null });
    const state = makeState(thread);
    const stale: AppState = {
      ...state,
      sidebarThreadsById: {
        ...state.sidebarThreadsById,
        [thread.id]: { ...state.sidebarThreadsById[thread.id]!, hasLiveBackgroundTask: true },
      },
    };
    const refreshed = refreshLiveBackgroundTaskSummaries(stale);
    expect(refreshed.sidebarThreadsById[thread.id]?.hasLiveBackgroundTask).toBe(false);
    expect(refreshLiveBackgroundTaskSummaries(refreshed)).toBe(refreshed);
  });
});
