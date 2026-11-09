import {
  DEFAULT_MODEL_BY_PROVIDER,
  EventId,
  MessageId,
  type ModelSelection,
  type OrchestrationCommand,
  type OrchestrationSession,
  type OrchestrationThread,
  ThreadId,
  TurnId,
} from "@piedpiper/contracts";
import { DEFAULT_SERVER_SETTINGS } from "@piedpiper/contracts/settings";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Option, Ref } from "effect";

import { ServerConfig, type ServerConfigShape } from "./config.ts";
import { ServerSettingsService } from "./serverSettings.ts";

import { AnalyticsService } from "./telemetry/Services/AnalyticsService.ts";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "./orchestration/Services/OrchestrationEngine.ts";
import { ProviderService, type ProviderServiceShape } from "./provider/Services/ProviderService.ts";
import {
  type ProviderRuntimeBinding,
  ProviderSessionDirectory,
  type ProviderSessionDirectoryShape,
} from "./provider/Services/ProviderSessionDirectory.ts";
import {
  autoBootstrapWelcome,
  getAutoBootstrapThreadModelSelection,
  launchStartupHeartbeat,
  makeCommandGate,
  ORPHANED_PROVIDER_SESSION_ERROR,
  reconcileProviderSessions,
  settleAndContinueProviderSessions,
  ServerRuntimeStartupError,
} from "./serverRuntimeStartup.ts";

it.effect("enqueueCommand waits for readiness and then drains queued work", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const executionCount = yield* Ref.make(0);
      const commandGate = yield* makeCommandGate;

      const queuedCommandFiber = yield* commandGate
        .enqueueCommand(Ref.updateAndGet(executionCount, (count) => count + 1))
        .pipe(Effect.forkScoped);

      yield* Effect.yieldNow;
      assert.equal(yield* Ref.get(executionCount), 0);

      yield* commandGate.signalCommandReady;

      const result = yield* Fiber.join(queuedCommandFiber);
      assert.equal(result, 1);
      assert.equal(yield* Ref.get(executionCount), 1);
    }),
  ),
);

it.effect("enqueueCommand fails queued work when readiness fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const commandGate = yield* makeCommandGate;
      const failure = yield* Deferred.make<void, never>();

      const queuedCommandFiber = yield* commandGate
        .enqueueCommand(Deferred.await(failure).pipe(Effect.as("should-not-run")))
        .pipe(Effect.forkScoped);

      yield* commandGate.failCommandReady(
        new ServerRuntimeStartupError({
          message: "startup failed",
        }),
      );

      const error = yield* Effect.flip(Fiber.join(queuedCommandFiber));
      assert.equal(error.message, "startup failed");
    }),
  ),
);

it.effect("launchStartupHeartbeat does not block the caller while counts are loading", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const releaseCounts = yield* Deferred.make<void, never>();

      yield* launchStartupHeartbeat.pipe(
        Effect.provideService(ProjectionSnapshotQuery, {
          getSnapshot: () => Effect.die("unused"),
          getCounts: () =>
            Deferred.await(releaseCounts).pipe(
              Effect.as({
                projectCount: 2,
                threadCount: 3,
              }),
            ),
          getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
          getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
          getThreadCheckpointContext: () => Effect.succeed(Option.none()),
          getThreadWorkspaceContext: () => Effect.succeed(Option.none()),
        }),
        Effect.provideService(AnalyticsService, {
          record: () => Effect.void,
          flush: Effect.void,
        }),
      );
    }),
  ),
);

it.effect("startup continues a cut turn after reconcile settled it, reading the marker first", () =>
  Effect.gen(function* () {
    const now = new Date().toISOString();
    const threadId = ThreadId.makeUnsafe("thread-cut");
    const turnId = TurnId.makeUnsafe("turn-cut");
    let thread = {
      id: threadId,
      archivedAt: null,
      deletedAt: null,
      runtimeMode: "full-access",
      interactionMode: "default",
      messages: [],
      activities: [],
      latestTurn: {
        turnId,
        state: "running",
        requestedAt: now,
        startedAt: now,
        completedAt: null,
        assistantMessageId: null,
      },
      session: {
        threadId,
        status: "running",
        providerName: "claudeAgent",
        runtimeMode: "full-access",
        activeTurnId: turnId,
        lastError: null,
        updatedAt: now,
      },
    } as unknown as OrchestrationThread;
    const binding: ProviderRuntimeBinding = {
      threadId,
      provider: "claudeAgent",
      status: "running",
      resumeCursor: { id: "cursor" },
      runtimePayload: { continueAfterRestart: turnId },
    };
    const dispatched: Array<OrchestrationCommand["type"]> = [];

    yield* settleAndContinueProviderSessions.pipe(
      Effect.provideService(ServerSettingsService, {
        getSettings: Effect.succeed({
          ...DEFAULT_SERVER_SETTINGS,
          continueThreadsAfterRestart: true,
        }),
      } as never),
      Effect.provideService(ProviderService, {
        listSessions: () => Effect.succeed([]),
      } as unknown as ProviderServiceShape),
      Effect.provideService(OrchestrationEngineService, {
        getReadModel: () =>
          Effect.succeed({
            snapshotSequence: 1,
            projects: new Map(),
            threads: new Map([[threadId, thread]]),
            updatedAt: now,
          }),
        dispatch: (command: OrchestrationCommand) =>
          Effect.sync(() => {
            dispatched.push(command.type);
            // Settling the cut turn is what would read as "finished" if the take ran after it.
            if (command.type === "thread.session.set") {
              thread = {
                ...thread,
                latestTurn: { ...thread.latestTurn, state: "error" },
              } as OrchestrationThread;
            }
            return { sequence: dispatched.length };
          }),
      } as unknown as OrchestrationEngineShape),
      Effect.provideService(ProviderSessionDirectory, {
        listBindings: () => Effect.succeed([binding]),
        getBinding: () => Effect.succeed(Option.some(binding)),
        upsert: () => Effect.void,
      } as unknown as ProviderSessionDirectoryShape),
    );

    assert.deepEqual(dispatched, ["thread.session.set", "thread.turn.start"]);
  }),
);

it.effect("reconcileProviderSessions settles threads whose provider session did not survive", () =>
  Effect.gen(function* () {
    const now = "2026-01-01T00:00:00.000Z";
    const makeThread = (
      id: string,
      session: Partial<OrchestrationSession> | null,
      deletedAt: string | null = null,
    ) =>
      ({
        id: ThreadId.makeUnsafe(id),
        deletedAt,
        messages: [],
        activities: [],
        session:
          session === null
            ? null
            : {
                threadId: ThreadId.makeUnsafe(id),
                status: "ready",
                providerName: "codex",
                runtimeMode: "full-access",
                activeTurnId: null,
                lastError: null,
                updatedAt: now,
                ...session,
              },
      }) as unknown as OrchestrationThread;
    const threads = [
      // Dispatch always fails for this one; the others must still be settled.
      makeThread("thread-dispatch-fails", { status: "running" }),
      makeThread("thread-orphan-running", {
        status: "running",
        activeTurnId: TurnId.makeUnsafe("turn-1"),
      }),
      makeThread("thread-orphan-ready-with-turn", {
        status: "ready",
        activeTurnId: TurnId.makeUnsafe("turn-2"),
      }),
      makeThread("thread-live", { status: "running" }),
      makeThread("thread-idle", { status: "ready" }),
      makeThread("thread-no-session", null),
      makeThread("thread-deleted", { status: "running" }, now),
    ];
    const dispatched: Array<OrchestrationCommand> = [];
    const upserts: Array<ProviderRuntimeBinding> = [];

    yield* reconcileProviderSessions.pipe(
      Effect.provideService(ProviderService, {
        listSessions: () =>
          Effect.succeed([{ threadId: ThreadId.makeUnsafe("thread-live") }] as never),
      } as unknown as ProviderServiceShape),
      Effect.provideService(OrchestrationEngineService, {
        getReadModel: () =>
          Effect.succeed({
            snapshotSequence: 1,
            projects: new Map(),
            threads: new Map(threads.map((thread) => [thread.id, thread])),
            updatedAt: now,
          }),
        dispatch: (command: OrchestrationCommand) =>
          "threadId" in command && command.threadId === "thread-dispatch-fails"
            ? Effect.die(new Error("dispatch failed"))
            : Effect.sync(() => {
                dispatched.push(command);
                return { sequence: dispatched.length };
              }),
      } as unknown as OrchestrationEngineShape),
      Effect.provideService(ProviderSessionDirectory, {
        getBinding: (threadId: ThreadId) =>
          Effect.succeed(
            threadId === "thread-orphan-running"
              ? Option.some({
                  threadId,
                  provider: "codex",
                  status: "running",
                  resumeCursor: { id: "cursor" },
                } satisfies ProviderRuntimeBinding)
              : Option.none(),
          ),
        upsert: (binding: ProviderRuntimeBinding) =>
          Effect.sync(() => {
            upserts.push(binding);
          }),
      } as unknown as ProviderSessionDirectoryShape),
    );

    assert.deepEqual<unknown>(
      dispatched.map((command) =>
        command.type === "thread.session.set"
          ? {
              threadId: command.threadId,
              status: command.session.status,
              activeTurnId: command.session.activeTurnId,
              lastError: command.session.lastError,
            }
          : command.type,
      ),
      ["thread-orphan-running", "thread-orphan-ready-with-turn"].map((threadId) => ({
        threadId,
        status: "error",
        activeTurnId: null,
        lastError: ORPHANED_PROVIDER_SESSION_ERROR,
      })),
    );
    assert.deepEqual(upserts, [
      {
        threadId: ThreadId.makeUnsafe("thread-orphan-running"),
        provider: "codex",
        status: "stopped",
        resumeCursor: { id: "cursor" },
        runtimePayload: { activeTurnId: null },
      },
    ]);
  }),
);

it.effect(
  "reconcileProviderSessions does not fail when live provider sessions cannot be read",
  () =>
    Effect.gen(function* () {
      let readModelReads = 0;
      let dispatches = 0;
      for (const listSessions of [
        () => Effect.fail(new Error("inventory unavailable")),
        () => Effect.die(new Error("inventory defect")),
      ]) {
        yield* reconcileProviderSessions.pipe(
          Effect.provideService(ProviderService, {
            listSessions,
          } as unknown as ProviderServiceShape),
          Effect.provideService(OrchestrationEngineService, {
            getReadModel: () =>
              Effect.sync(() => {
                readModelReads += 1;
                return { snapshotSequence: 0, projects: new Map(), threads: new Map() };
              }),
            dispatch: () =>
              Effect.sync(() => {
                dispatches += 1;
                return { sequence: dispatches };
              }),
          } as unknown as OrchestrationEngineShape),
          Effect.provideService(ProviderSessionDirectory, {
            getBinding: () => Effect.succeed(Option.none()),
            upsert: () => Effect.void,
          } as unknown as ProviderSessionDirectoryShape),
        );
      }
      assert.equal(readModelReads, 0);
      assert.equal(dispatches, 0);
    }),
);

it.effect("reconcileProviderSessions retries a failed projection once", () =>
  Effect.gen(function* () {
    const now = "2026-01-01T00:00:00.000Z";
    const threadId = ThreadId.makeUnsafe("thread-orphan");
    const thread = {
      id: threadId,
      deletedAt: null,
      messages: [],
      activities: [],
      session: {
        threadId,
        status: "running",
        providerName: "codex",
        runtimeMode: "full-access",
        activeTurnId: null,
        lastError: null,
        updatedAt: now,
      },
    } as unknown as OrchestrationThread;
    let attempts = 0;

    yield* reconcileProviderSessions.pipe(
      Effect.provideService(ProviderService, {
        listSessions: () => Effect.succeed([]),
      } as unknown as ProviderServiceShape),
      Effect.provideService(OrchestrationEngineService, {
        getReadModel: () =>
          Effect.succeed({
            snapshotSequence: 1,
            projects: new Map(),
            threads: new Map([[threadId, thread]]),
            updatedAt: now,
          }),
        dispatch: () =>
          Effect.suspend(() => {
            attempts += 1;
            return attempts === 1
              ? Effect.fail(new Error("transient dispatch failure"))
              : Effect.succeed({ sequence: attempts });
          }),
      } as unknown as OrchestrationEngineShape),
      Effect.provideService(ProviderSessionDirectory, {
        getBinding: () => Effect.succeed(Option.none()),
        upsert: () => Effect.void,
      } as unknown as ProviderSessionDirectoryShape),
    );

    assert.equal(attempts, 2);
  }),
);

it.effect("reconcileProviderSessions completes assistant messages left streaming", () =>
  Effect.gen(function* () {
    const now = "2026-01-01T00:00:00.000Z";
    const makeMessage = (
      id: string,
      role: "user" | "assistant",
      streaming: boolean,
      turnId: string | null,
      updatedAt = now,
    ) => ({
      id: MessageId.makeUnsafe(id),
      role,
      text: "partial",
      turnId: turnId === null ? null : TurnId.makeUnsafe(turnId),
      streaming,
      createdAt: now,
      updatedAt,
    });
    const makeThread = (
      id: string,
      status: OrchestrationSession["status"],
      messages: ReadonlyArray<ReturnType<typeof makeMessage>>,
      deletedAt: string | null = null,
    ) =>
      ({
        id: ThreadId.makeUnsafe(id),
        deletedAt,
        messages,
        activities: [],
        session: {
          threadId: ThreadId.makeUnsafe(id),
          status,
          providerName: "claudeAgent",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
      }) as unknown as OrchestrationThread;
    const threads = [
      makeThread("thread-orphan", "running", [
        makeMessage("msg-user", "user", false, "turn-1"),
        makeMessage("msg-streaming", "assistant", true, "turn-1", "2026-01-01T00:03:00.000Z"),
      ]),
      // Already settled sessions can still carry a streaming message.
      makeThread("thread-settled", "error", [
        makeMessage("msg-settled", "assistant", true, null, "2026-01-01T00:01:00.000Z"),
      ]),
      makeThread("thread-done", "ready", [makeMessage("msg-done", "assistant", false, "turn-3")]),
      makeThread("thread-live", "running", [makeMessage("msg-live", "assistant", true, "turn-4")]),
      makeThread(
        "thread-deleted",
        "ready",
        [makeMessage("msg-deleted", "assistant", true, "turn-5")],
        now,
      ),
    ];
    const dispatched: Array<OrchestrationCommand> = [];

    yield* reconcileProviderSessions.pipe(
      Effect.provideService(ProviderService, {
        listSessions: () =>
          Effect.succeed([{ threadId: ThreadId.makeUnsafe("thread-live") }] as never),
      } as unknown as ProviderServiceShape),
      Effect.provideService(OrchestrationEngineService, {
        getReadModel: () =>
          Effect.succeed({
            snapshotSequence: 1,
            projects: new Map(),
            threads: new Map(threads.map((thread) => [thread.id, thread])),
            updatedAt: now,
          }),
        dispatch: (command: OrchestrationCommand) =>
          Effect.sync(() => {
            dispatched.push(command);
            return { sequence: dispatched.length };
          }),
      } as unknown as OrchestrationEngineShape),
      Effect.provideService(ProviderSessionDirectory, {
        getBinding: () => Effect.succeed(Option.none()),
        upsert: () => Effect.void,
      } as unknown as ProviderSessionDirectoryShape),
    );

    assert.deepEqual<unknown>(
      dispatched
        .filter((command) => command.type === "thread.message.assistant.complete")
        .map((command) => ({
          threadId: command.threadId,
          messageId: command.messageId,
          turnId: command.turnId,
          createdAt: command.createdAt,
        })),
      [
        {
          threadId: "thread-orphan",
          messageId: "msg-streaming",
          turnId: "turn-1",
          createdAt: "2026-01-01T00:03:00.000Z",
        },
        {
          threadId: "thread-settled",
          messageId: "msg-settled",
          turnId: undefined,
          createdAt: "2026-01-01T00:01:00.000Z",
        },
      ],
    );
  }),
);

it.effect("reconcileProviderSessions closes dead approvals and leaves questions open", () =>
  Effect.gen(function* () {
    const now = "2026-01-01T00:00:00.000Z";
    const activity = (kind: string, requestId: string) => ({
      id: EventId.makeUnsafe(`${kind}-${requestId}`),
      tone: "approval",
      kind,
      summary: kind,
      payload: { requestId, requestKind: "command" },
      turnId: null,
      createdAt: now,
    });
    const makeThread = (id: string, activities: ReadonlyArray<ReturnType<typeof activity>>) =>
      ({
        id: ThreadId.makeUnsafe(id),
        deletedAt: null,
        messages: [],
        activities,
        session: null,
      }) as unknown as OrchestrationThread;
    const threads = [
      makeThread("thread-orphan", [
        activity("approval.requested", "approval-open"),
        activity("approval.requested", "approval-done"),
        activity("approval.resolved", "approval-done"),
        activity("user-input.requested", "question-open"),
      ]),
      makeThread("thread-live", [activity("approval.requested", "approval-live")]),
    ];
    const dispatched: Array<OrchestrationCommand> = [];

    yield* reconcileProviderSessions.pipe(
      Effect.provideService(ProviderService, {
        listSessions: () => Effect.succeed([{ threadId: ThreadId.makeUnsafe("thread-live") }]),
      } as unknown as ProviderServiceShape),
      Effect.provideService(OrchestrationEngineService, {
        getReadModel: () =>
          Effect.succeed({
            snapshotSequence: 1,
            projects: new Map(),
            threads: new Map(threads.map((thread) => [thread.id, thread])),
            updatedAt: now,
          }),
        dispatch: (command: OrchestrationCommand) =>
          Effect.sync(() => {
            dispatched.push(command);
            return { sequence: dispatched.length };
          }),
      } as unknown as OrchestrationEngineShape),
      Effect.provideService(ProviderSessionDirectory, {
        getBinding: () => Effect.succeed(Option.none()),
        upsert: () => Effect.void,
      } as unknown as ProviderSessionDirectoryShape),
    );

    assert.deepEqual(
      dispatched.map((command) =>
        command.type === "thread.activity.append"
          ? [command.threadId, command.activity.kind, command.activity.payload]
          : command.type,
      ),
      [
        [
          "thread-orphan",
          "approval.resolved",
          { requestId: "approval-open", requestKind: "command", decision: "cancel" },
        ],
      ],
    );
  }),
);

it.effect(
  "autoBootstrapWelcome creates the first thread with the default runtime mode setting",
  () =>
    Effect.gen(function* () {
      const dispatched: Array<OrchestrationCommand> = [];
      const welcome = yield* autoBootstrapWelcome.pipe(
        Effect.provideService(ServerConfig, {
          cwd: "/tmp/bootstrap-project",
          autoBootstrapProjectFromCwd: true,
        } as unknown as ServerConfigShape),
        Effect.provideService(ProjectionSnapshotQuery, {
          getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
          getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
        } as never),
        Effect.provideService(OrchestrationEngineService, {
          dispatch: (command: OrchestrationCommand) =>
            Effect.sync(() => {
              dispatched.push(command);
              return { sequence: dispatched.length };
            }),
        } as unknown as OrchestrationEngineShape),
        Effect.provide(
          Layer.mergeAll(
            ServerSettingsService.layerTest({ defaultRuntimeMode: "approval-required" }),
            NodeServices.layer,
          ),
        ),
      );

      const threadCreate = dispatched.find((command) => command.type === "thread.create");
      assert.equal(
        threadCreate?.type === "thread.create" && threadCreate.runtimeMode,
        "approval-required",
      );
      assert.equal(
        welcome.bootstrapThreadId,
        threadCreate?.type === "thread.create" ? threadCreate.threadId : undefined,
      );
    }),
);

const runAutoBootstrapWelcome = (
  existingProject: Option.Option<{
    readonly id: string;
    readonly defaultModelSelection: ModelSelection | null;
    readonly archivedAt?: string | null;
  }>,
) =>
  Effect.gen(function* () {
    const dispatched: Array<OrchestrationCommand> = [];
    yield* autoBootstrapWelcome.pipe(
      Effect.provideService(ServerConfig, {
        cwd: "/tmp/bootstrap-project",
        autoBootstrapProjectFromCwd: true,
      } as unknown as ServerConfigShape),
      Effect.provideService(ProjectionSnapshotQuery, {
        getActiveProjectByWorkspaceRoot: () => Effect.succeed(existingProject),
        getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
      } as never),
      Effect.provideService(OrchestrationEngineService, {
        dispatch: (command: OrchestrationCommand) =>
          Effect.sync(() => {
            dispatched.push(command);
            return { sequence: dispatched.length };
          }),
      } as unknown as OrchestrationEngineShape),
      Effect.provide(Layer.mergeAll(ServerSettingsService.layerTest(), NodeServices.layer)),
    );
    return dispatched;
  });

const threadModelSelection = (commands: ReadonlyArray<OrchestrationCommand>) => {
  const threadCreate = commands.find((command) => command.type === "thread.create");
  return threadCreate?.type === "thread.create" ? threadCreate.modelSelection : undefined;
};

it.effect("reconcileProviderSessions settles the tasks a killed Claude session left open", () =>
  Effect.gen(function* () {
    const now = "2026-01-01T00:00:00.000Z";
    const taskStarted = (taskId: string) => ({
      id: EventId.makeUnsafe(`task-${taskId}`),
      tone: "info",
      kind: "task.started",
      summary: "Task started",
      payload: { taskId },
      turnId: null,
      createdAt: now,
    });
    const makeThread = (id: string, providerName: string, liveTaskId: string) =>
      ({
        id: ThreadId.makeUnsafe(id),
        deletedAt: null,
        messages: [],
        activities: [taskStarted(liveTaskId)],
        session: { status: "ready", activeTurnId: null, providerName },
      }) as unknown as OrchestrationThread;
    const threads = [
      makeThread("thread-ready", "claudeAgent", "orphaned"),
      makeThread("thread-live", "claudeAgent", "still-running"),
      makeThread("thread-codex", "codex", "codex-task"),
    ];
    const dispatched: Array<OrchestrationCommand> = [];

    yield* reconcileProviderSessions.pipe(
      Effect.provideService(ProviderService, {
        listSessions: () => Effect.succeed([{ threadId: ThreadId.makeUnsafe("thread-live") }]),
      } as unknown as ProviderServiceShape),
      Effect.provideService(OrchestrationEngineService, {
        getReadModel: () =>
          Effect.succeed({
            snapshotSequence: 1,
            projects: new Map(),
            threads: new Map(threads.map((thread) => [thread.id, thread])),
            updatedAt: now,
          }),
        dispatch: (command: OrchestrationCommand) =>
          Effect.sync(() => {
            dispatched.push(command);
            return { sequence: dispatched.length };
          }),
      } as unknown as OrchestrationEngineShape),
      Effect.provideService(ProviderSessionDirectory, {
        getBinding: () => Effect.succeed(Option.none()),
        upsert: () => Effect.void,
      } as unknown as ProviderSessionDirectoryShape),
    );

    assert.deepEqual(
      dispatched.map((command) =>
        command.type === "thread.activity.append"
          ? [command.threadId, command.activity.kind, command.activity.payload]
          : command.type,
      ),
      [["thread-ready", "task.completed", { taskId: "orphaned", status: "stopped" }]],
    );
  }),
);

it.effect("autoBootstrapWelcome records no model default on a new project", () =>
  Effect.gen(function* () {
    const commands = yield* runAutoBootstrapWelcome(Option.none());
    const projectCreate = commands.find((command) => command.type === "project.create");
    assert.isDefined(projectCreate);
    assert.isFalse(projectCreate !== undefined && "defaultModelSelection" in projectCreate);
    assert.deepEqual(threadModelSelection(commands), {
      provider: "claudeAgent",
      model: DEFAULT_MODEL_BY_PROVIDER.claudeAgent,
    });
  }),
);

it.effect("autoBootstrapWelcome starts the thread on a project's explicit default", () =>
  Effect.gen(function* () {
    const explicit: ModelSelection = { provider: "codex", model: "gpt-explicit" };
    const commands = yield* runAutoBootstrapWelcome(
      Option.some({ id: "project-1", defaultModelSelection: explicit }),
    );
    assert.deepEqual(
      commands.map((command) => command.type),
      ["thread.create"],
    );
    assert.deepEqual(threadModelSelection(commands), explicit);
  }),
);

it.effect("autoBootstrapWelcome unarchives the project it launches in", () =>
  Effect.gen(function* () {
    const commands = yield* runAutoBootstrapWelcome(
      Option.some({
        id: "project-1",
        defaultModelSelection: null,
        archivedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    assert.deepEqual(
      commands.map((command) => command.type),
      ["project.meta.update", "thread.create"],
    );
    const update = commands[0];
    assert.isTrue(
      update?.type === "project.meta.update" &&
        update.projectId === "project-1" &&
        update.archivedAt === null,
    );
  }),
);

it.effect("autoBootstrapWelcome falls back to the current default for a null project default", () =>
  Effect.gen(function* () {
    const commands = yield* runAutoBootstrapWelcome(
      Option.some({ id: "project-1", defaultModelSelection: null }),
    );
    assert.deepEqual(threadModelSelection(commands), getAutoBootstrapThreadModelSelection());
  }),
);
