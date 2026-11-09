import type {
  OrchestrationThread,
  ProviderRuntimeEvent,
  ProviderSession,
} from "@piedpiper/contracts";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProjectId,
  ThreadId,
  TurnId,
} from "@piedpiper/contracts";
import { Effect, Exit, Layer, ManagedRuntime, PubSub, Scope, Stream } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationEngineLive } from "../../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ServerConfig } from "../../config.ts";
import {
  ProviderSessionRuntimeRepository,
  type ProviderSessionRuntimeRepositoryShape,
} from "../../persistence/Services/ProviderSessionRuntime.ts";
import { ProviderService, type ProviderServiceShape } from "../Services/ProviderService.ts";
import {
  BACKGROUND_TASK_MAX_SILENCE_MS,
  hasLiveBackgroundTask,
  hasPendingProviderRequest,
  makeProviderSessionReaper,
  resolveProviderSessionIdleSince,
} from "./ProviderSessionReaper.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";

const MINUTE_MS = 60_000;
const threadId = ThreadId.makeUnsafe("thread-1");
const asTurnId = (value: string): TurnId => TurnId.makeUnsafe(value);

function makeSession(overrides: Partial<ProviderSession> = {}): ProviderSession {
  const createdAt = new Date(0).toISOString();
  return {
    provider: "claudeAgent",
    status: "ready",
    runtimeMode: "full-access",
    threadId,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

function makeThread(overrides: Partial<OrchestrationThread> = {}): OrchestrationThread {
  const at = new Date(0).toISOString();
  return {
    id: threadId,
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Thread",
    modelSelection: { provider: "claudeAgent", model: "claude" },
    runtimeMode: "full-access",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: {
      threadId,
      status: "ready",
      providerName: "claudeAgent",
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: null,
      updatedAt: at,
    },
    ...overrides,
  };
}

function requestActivity(
  kind: "approval.requested" | "approval.resolved" | "user-input.requested" | "user-input.resolved",
  requestId: string,
  createdAt: string,
): OrchestrationThread["activities"][number] {
  return {
    id: EventId.makeUnsafe(`${kind}:${requestId}:${createdAt}`),
    tone: "approval",
    kind,
    summary: kind,
    payload: { requestId },
    turnId: null,
    createdAt,
  };
}

describe("resolveProviderSessionIdleSince", () => {
  it("returns the latest activity timestamp for an idle session", () => {
    const sessionUpdatedAt = new Date(5 * MINUTE_MS).toISOString();
    const threadUpdatedAt = new Date(7 * MINUTE_MS).toISOString();
    const idleSince = resolveProviderSessionIdleSince({
      session: makeSession({ updatedAt: sessionUpdatedAt }),
      thread: makeThread({ updatedAt: threadUpdatedAt }),
    });
    expect(idleSince).toBe(7 * MINUTE_MS);
  });

  it("treats a session with a provider-side active turn or running status as busy", () => {
    expect(
      resolveProviderSessionIdleSince({
        session: makeSession({ activeTurnId: asTurnId("turn-1") }),
        thread: makeThread(),
      }),
    ).toBeNull();
    expect(
      resolveProviderSessionIdleSince({
        session: makeSession({ status: "running" }),
        thread: makeThread(),
      }),
    ).toBeNull();
    expect(
      resolveProviderSessionIdleSince({
        session: makeSession({ status: "connecting" }),
        thread: undefined,
      }),
    ).toBeNull();
  });

  it("treats a thread whose orchestration session is running or starting as busy", () => {
    const base = makeThread();
    expect(
      resolveProviderSessionIdleSince({
        session: makeSession(),
        thread: makeThread({
          session: { ...base.session!, status: "running", activeTurnId: asTurnId("turn-1") },
        }),
      }),
    ).toBeNull();
    expect(
      resolveProviderSessionIdleSince({
        session: makeSession(),
        thread: makeThread({ session: { ...base.session!, status: "starting" } }),
      }),
    ).toBeNull();
    expect(
      resolveProviderSessionIdleSince({
        session: makeSession(),
        thread: makeThread({
          session: { ...base.session!, status: "ready", activeTurnId: asTurnId("turn-1") },
        }),
      }),
    ).toBeNull();
  });

  it("treats a pending approval or user-input request as busy until it is resolved", () => {
    const openedAt = new Date(MINUTE_MS).toISOString();
    const pending = makeThread({
      activities: [requestActivity("approval.requested", "req-1", openedAt)],
    });
    expect(resolveProviderSessionIdleSince({ session: makeSession(), thread: pending })).toBeNull();

    const resolved = makeThread({
      activities: [
        requestActivity("approval.requested", "req-1", openedAt),
        requestActivity("approval.resolved", "req-1", openedAt),
      ],
    });
    expect(
      resolveProviderSessionIdleSince({ session: makeSession(), thread: resolved }),
    ).not.toBeNull();

    const pendingUserInput = makeThread({
      activities: [requestActivity("user-input.requested", "req-2", openedAt)],
    });
    expect(
      resolveProviderSessionIdleSince({ session: makeSession(), thread: pendingUserInput }),
    ).toBeNull();
  });

  it("does not count a non-blocking question as pending", () => {
    const openedAt = new Date(5 * MINUTE_MS).toISOString();
    const question = requestActivity("user-input.requested", "req-async", openedAt);
    const thread = makeThread({
      activities: [{ ...question, payload: { requestId: "req-async", responseMode: "message" } }],
    });
    expect(hasPendingProviderRequest(thread, new Date(0).toISOString())).toBe(false);
    expect(resolveProviderSessionIdleSince({ session: makeSession(), thread })).not.toBeNull();
  });

  it("ignores requests opened before the current session started", () => {
    const sessionCreatedAt = new Date(10 * MINUTE_MS).toISOString();
    const staleRequestAt = new Date(2 * MINUTE_MS).toISOString();
    const thread = makeThread({
      activities: [requestActivity("approval.requested", "req-old", staleRequestAt)],
    });
    expect(hasPendingProviderRequest(thread, sessionCreatedAt)).toBe(false);
    expect(
      resolveProviderSessionIdleSince({
        session: makeSession({ createdAt: sessionCreatedAt, updatedAt: sessionCreatedAt }),
        thread,
      }),
    ).toBe(10 * MINUTE_MS);
  });
});

function taskActivity(
  kind: "task.started" | "task.progress" | "task.completed",
  taskId: string,
  createdAt: string,
): OrchestrationThread["activities"][number] {
  return {
    id: EventId.makeUnsafe(`${kind}:${taskId}:${createdAt}`),
    tone: "info",
    kind,
    summary: kind,
    payload: { taskId },
    turnId: null,
    createdAt,
  };
}

describe("hasLiveBackgroundTask", () => {
  const startedAt = new Date(MINUTE_MS).toISOString();
  const nowMs = 60 * MINUTE_MS;

  it("treats a Claude session with an unfinished background task as busy", () => {
    const thread = makeThread({ activities: [taskActivity("task.started", "task-1", startedAt)] });
    expect(hasLiveBackgroundTask(thread, makeSession(), nowMs)).toBe(true);
    expect(
      resolveProviderSessionIdleSince({ session: makeSession(), thread, now: nowMs }),
    ).toBeNull();
  });

  it("frees the session once the task completes", () => {
    const thread = makeThread({
      activities: [
        taskActivity("task.started", "task-1", startedAt),
        taskActivity("task.completed", "task-1", new Date(2 * MINUTE_MS).toISOString()),
      ],
    });
    expect(hasLiveBackgroundTask(thread, makeSession(), nowMs)).toBe(false);
    expect(
      resolveProviderSessionIdleSince({ session: makeSession(), thread, now: nowMs }),
    ).not.toBeNull();
  });

  it("ignores Codex sessions, whose turns are tasks too", () => {
    const thread = makeThread({
      activities: [taskActivity("task.started", "turn-task", startedAt)],
    });
    expect(hasLiveBackgroundTask(thread, makeSession({ provider: "codex" }), nowMs)).toBe(false);
  });

  it("ignores tasks started before the current session", () => {
    const thread = makeThread({ activities: [taskActivity("task.started", "task-1", startedAt)] });
    const session = makeSession({ createdAt: new Date(5 * MINUTE_MS).toISOString() });
    expect(hasLiveBackgroundTask(thread, session, nowMs)).toBe(false);
  });

  it("treats a session whose adapter still tracks a task as busy, even with no task activity", () => {
    const thread = makeThread({ activities: [] });
    expect(
      resolveProviderSessionIdleSince({
        session: makeSession(),
        thread,
        now: nowMs,
        liveBackgroundTaskCount: 1,
      }),
    ).toBeNull();
    expect(
      resolveProviderSessionIdleSince({
        session: makeSession(),
        thread,
        now: nowMs,
        liveBackgroundTaskCount: 0,
      }),
    ).not.toBeNull();
  });

  it("stops counting a task that has been silent past the cap, unless it reports progress", () => {
    const thread = makeThread({ activities: [taskActivity("task.started", "task-1", startedAt)] });
    const lateNow = MINUTE_MS + BACKGROUND_TASK_MAX_SILENCE_MS;
    expect(hasLiveBackgroundTask(thread, makeSession(), lateNow)).toBe(false);

    const progressing = makeThread({
      activities: [
        taskActivity("task.started", "task-1", startedAt),
        taskActivity("task.progress", "task-1", new Date(lateNow - MINUTE_MS).toISOString()),
      ],
    });
    expect(hasLiveBackgroundTask(progressing, makeSession(), lateNow)).toBe(true);
  });
});

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for expectation.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("ProviderSessionReaper", () => {
  let runtime: ManagedRuntime.ManagedRuntime<
    OrchestrationEngineService | ProviderService,
    unknown
  > | null = null;
  let scope: Scope.Closeable | null = null;

  afterEach(async () => {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
  });

  async function createHarness(input: { readonly idleThresholdMs: number }) {
    const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
    const runtimeSessions: Array<ProviderSession> = [];
    const liveBackgroundTaskCounts = new Map<ThreadId, number>();
    const deleteBinding = vi.fn((_: { readonly threadId: ThreadId }) => Effect.void);
    const stopSession = vi.fn((stopInput: { readonly threadId: ThreadId }) =>
      Effect.sync(() => {
        const index = runtimeSessions.findIndex(
          (session) => session.threadId === stopInput.threadId,
        );
        if (index >= 0) runtimeSessions.splice(index, 1);
      }),
    );
    const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;
    const service: ProviderServiceShape = {
      startSession: () => unsupported(),
      sendTurn: () => unsupported(),
      interruptTurn: () => unsupported(),
      respondToRequest: () => unsupported(),
      respondToUserInput: () => unsupported(),
      stopSession: stopSession as ProviderServiceShape["stopSession"],
      listSessions: () => Effect.succeed([...runtimeSessions]),
      getCapabilities: () => Effect.succeed({ sessionModelSwitch: "in-session" }),
      canRollbackConversation: () => Effect.succeed(true),
      rollbackConversation: () => unsupported(),
      compactThread: () => unsupported(),
      runGoalRequest: () => unsupported(),
      countLiveBackgroundTasks: ({ threadId: id }) =>
        Effect.sync(() => liveBackgroundTaskCounts.get(id) ?? 0),
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
      subscribeEvents: () => PubSub.subscribe(runtimeEventPubSub),
      subscribeToolInputPreview: () => PubSub.subscribe(runtimeEventPubSub),
    };

    const orchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(SqlitePersistenceMemory),
    );
    const layer = orchestrationLayer.pipe(
      Layer.provideMerge(Layer.succeed(ProviderService, service)),
      Layer.provideMerge(
        Layer.succeed(ProviderSessionRuntimeRepository, {
          deleteByThreadId: deleteBinding,
        } as unknown as ProviderSessionRuntimeRepositoryShape),
      ),
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), { prefix: "pp-session-reaper-test-" }),
      ),
      Layer.provideMerge(NodeServices.layer),
    );
    runtime = ManagedRuntime.make(layer);
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));

    let nowMs = 60 * MINUTE_MS;
    const reaper = await runtime.runPromise(
      makeProviderSessionReaper({
        idleThresholdMs: input.idleThresholdMs,
        sweepIntervalMs: 60 * 60 * 1000,
        now: () => nowMs,
      }),
    );
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reaper.start().pipe(Scope.provide(scope)));

    const createdAt = new Date(nowMs).toISOString();
    await Effect.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-create"),
        projectId: ProjectId.makeUnsafe("project-1"),
        title: "Project",
        workspaceRoot: process.cwd(),
        defaultModelSelection: { provider: "claudeAgent", model: "claude" },
        createdAt,
      }),
    );

    const createThread = async (id: ThreadId, session: Partial<ProviderSession> = {}) => {
      await Effect.runPromise(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe(`cmd-thread-create-${id}`),
          threadId: id,
          projectId: ProjectId.makeUnsafe("project-1"),
          title: "Thread",
          modelSelection: { provider: "claudeAgent", model: "claude" },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt,
        }),
      );
      await Effect.runPromise(
        engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.makeUnsafe(`cmd-session-set-${id}`),
          threadId: id,
          session: {
            threadId: id,
            status: "ready",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: createdAt,
          },
          createdAt,
        }),
      );
      runtimeSessions.push(
        makeSession({ threadId: id, createdAt, updatedAt: createdAt, ...session }),
      );
    };

    return {
      engine,
      reaper,
      stopSession,
      deleteBinding,
      runtimeSessions,
      liveBackgroundTaskCounts,
      createThread,
      advanceClock: (ms: number) => {
        nowMs += ms;
      },
    };
  }

  it("stops sessions idle for longer than the threshold and leaves busy ones alone", async () => {
    const harness = await createHarness({ idleThresholdMs: 30 * MINUTE_MS });
    const idleThreadId = ThreadId.makeUnsafe("thread-idle");
    const busyThreadId = ThreadId.makeUnsafe("thread-busy");
    await harness.createThread(idleThreadId);
    await harness.createThread(busyThreadId, { activeTurnId: asTurnId("turn-busy") });

    expect(await Effect.runPromise(harness.reaper.sweep)).toBe(0);
    expect(harness.stopSession).not.toHaveBeenCalled();

    harness.advanceClock(31 * MINUTE_MS);
    expect(await Effect.runPromise(harness.reaper.sweep)).toBe(1);
    expect(harness.stopSession.mock.calls.map((call) => call[0]?.threadId)).toEqual([idleThreadId]);

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    expect(readModel.threads.get(idleThreadId)?.session?.status).toBe("stopped");
    expect(readModel.threads.get(busyThreadId)?.session?.status).toBe("ready");

    // The reaped session is gone, so a second sweep has nothing left to do.
    expect(await Effect.runPromise(harness.reaper.sweep)).toBe(0);
  });

  it("does not reap a thread with a pending approval request", async () => {
    const harness = await createHarness({ idleThresholdMs: 30 * MINUTE_MS });
    const pendingThreadId = ThreadId.makeUnsafe("thread-pending-approval");
    await harness.createThread(pendingThreadId);
    const requestedAt = new Date(61 * MINUTE_MS).toISOString();
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.makeUnsafe("cmd-activity-approval"),
        threadId: pendingThreadId,
        activity: requestActivity("approval.requested", "req-pending", requestedAt),
        createdAt: requestedAt,
      }),
    );

    harness.advanceClock(45 * MINUTE_MS);
    expect(await Effect.runPromise(harness.reaper.sweep)).toBe(0);
    expect(harness.stopSession).not.toHaveBeenCalled();
  });

  it("stops the provider session when the thread is archived", async () => {
    const harness = await createHarness({ idleThresholdMs: 30 * MINUTE_MS });
    const archivedThreadId = ThreadId.makeUnsafe("thread-archived");
    await harness.createThread(archivedThreadId);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.archive",
        commandId: CommandId.makeUnsafe("cmd-thread-archive"),
        threadId: archivedThreadId,
      }),
    );

    await waitFor(() => harness.stopSession.mock.calls.length === 1);
    expect(harness.stopSession.mock.calls[0]?.[0]?.threadId).toBe(archivedThreadId);
    await waitFor(async () => {
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      return readModel.threads.get(archivedThreadId)?.session?.status === "stopped";
    });
    // An archived thread can be restored, so its resume binding is kept.
    expect(harness.deleteBinding).not.toHaveBeenCalled();
  });

  it("stops the provider session when the thread is deleted", async () => {
    const harness = await createHarness({ idleThresholdMs: 30 * MINUTE_MS });
    const deletedThreadId = ThreadId.makeUnsafe("thread-deleted");
    await harness.createThread(deletedThreadId);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.delete",
        commandId: CommandId.makeUnsafe("cmd-thread-delete"),
        threadId: deletedThreadId,
      }),
    );

    await waitFor(() => harness.stopSession.mock.calls.length === 1);
    expect(harness.stopSession.mock.calls[0]?.[0]?.threadId).toBe(deletedThreadId);
    expect(harness.runtimeSessions.some((session) => session.threadId === deletedThreadId)).toBe(
      false,
    );
    await waitFor(() => harness.deleteBinding.mock.calls.length === 1);
    expect(harness.deleteBinding.mock.calls[0]?.[0]).toEqual({ threadId: deletedThreadId });
  });

  it("stops the sessions of every thread when their project is deleted", async () => {
    const harness = await createHarness({ idleThresholdMs: 30 * MINUTE_MS });
    const firstThreadId = ThreadId.makeUnsafe("thread-project-a");
    const secondThreadId = ThreadId.makeUnsafe("thread-project-b");
    await harness.createThread(firstThreadId);
    await harness.createThread(secondThreadId, { activeTurnId: asTurnId("turn-in-flight") });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "project.delete",
        commandId: CommandId.makeUnsafe("cmd-project-delete"),
        projectId: ProjectId.makeUnsafe("project-1"),
      }),
    );

    await waitFor(() => harness.stopSession.mock.calls.length === 2);
    expect(harness.stopSession.mock.calls.map((call) => call[0]?.threadId).toSorted()).toEqual(
      [firstThreadId, secondThreadId].toSorted(),
    );
    expect(harness.runtimeSessions).toHaveLength(0);
    await waitFor(() => harness.deleteBinding.mock.calls.length === 2);
  });

  it("re-checks idleness before stopping, so a thread that got busy mid-sweep survives", async () => {
    const harness = await createHarness({ idleThresholdMs: 30 * MINUTE_MS });
    const firstThreadId = ThreadId.makeUnsafe("thread-sweep-first");
    const secondThreadId = ThreadId.makeUnsafe("thread-sweep-second");
    await harness.createThread(firstThreadId);
    await harness.createThread(secondThreadId);
    harness.advanceClock(31 * MINUTE_MS);

    // While the first stop runs, the second thread starts a turn.
    harness.stopSession.mockImplementationOnce((stopInput) =>
      Effect.sync(() => {
        harness.runtimeSessions.splice(
          harness.runtimeSessions.findIndex((session) => session.threadId === stopInput.threadId),
          1,
        );
        // Replace (not mutate) so the sweep's own snapshot still shows it idle.
        const secondIndex = harness.runtimeSessions.findIndex(
          (session) => session.threadId === secondThreadId,
        );
        harness.runtimeSessions[secondIndex] = {
          ...harness.runtimeSessions[secondIndex]!,
          activeTurnId: asTurnId("turn-new"),
        };
      }),
    );

    expect(await Effect.runPromise(harness.reaper.sweep)).toBe(1);
    expect(harness.stopSession.mock.calls.map((call) => call[0]?.threadId)).toEqual([
      firstThreadId,
    ]);
  });

  it("skips stale sessions while a background task started in the session is unfinished", async () => {
    const harness = await createHarness({ idleThresholdMs: 30 * MINUTE_MS });
    const taskThreadId = ThreadId.makeUnsafe("thread-background-task");
    await harness.createThread(taskThreadId);
    const startedAt = new Date(61 * MINUTE_MS).toISOString();
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.makeUnsafe("cmd-activity-task-started"),
        threadId: taskThreadId,
        activity: taskActivity("task.started", "task-bg", startedAt),
        createdAt: startedAt,
      }),
    );

    harness.advanceClock(45 * MINUTE_MS);
    expect(await Effect.runPromise(harness.reaper.sweep)).toBe(0);
    expect(harness.stopSession).not.toHaveBeenCalled();
  });

  it("skips stale sessions while the adapter reports a live background task", async () => {
    const harness = await createHarness({ idleThresholdMs: 30 * MINUTE_MS });
    const taskThreadId = ThreadId.makeUnsafe("thread-adapter-task");
    await harness.createThread(taskThreadId);
    // Its task.started fell out of the read model's activity window; only the adapter knows.
    harness.liveBackgroundTaskCounts.set(taskThreadId, 1);

    harness.advanceClock(45 * MINUTE_MS);
    expect(await Effect.runPromise(harness.reaper.sweep)).toBe(0);
    expect(harness.stopSession).not.toHaveBeenCalled();

    harness.liveBackgroundTaskCounts.set(taskThreadId, 0);
    expect(await Effect.runPromise(harness.reaper.sweep)).toBe(1);
  });

  it.each([
    ["fails", () => Effect.fail(new Error("stop failed"))],
    ["defects", () => Effect.die(new Error("stop defected"))],
  ])("keeps reaping other sessions when one stop attempt %s", async (_label, failure) => {
    const harness = await createHarness({ idleThresholdMs: 30 * MINUTE_MS });
    const failingThreadId = ThreadId.makeUnsafe("thread-stop-failing");
    const healthyThreadId = ThreadId.makeUnsafe("thread-stop-healthy");
    await harness.createThread(failingThreadId);
    await harness.createThread(healthyThreadId);
    harness.advanceClock(31 * MINUTE_MS);
    harness.stopSession.mockImplementationOnce(() => failure() as never);

    expect(await Effect.runPromise(harness.reaper.sweep)).toBe(1);
    expect(harness.stopSession.mock.calls.map((call) => call[0]?.threadId)).toEqual([
      failingThreadId,
      healthyThreadId,
    ]);
    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    expect(readModel.threads.get(healthyThreadId)?.session?.status).toBe("stopped");
  });
});
