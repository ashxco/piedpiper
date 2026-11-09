import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  OrchestrationReadModel,
  ProviderEvent,
  ProviderRuntimeEvent,
  ProviderSession,
} from "@piedpiper/contracts";
import {
  ApprovalRequestId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ProviderItemId,
  type ServerSettings,
  ThreadId,
  TurnId,
} from "@piedpiper/contracts";
import { Clock, Effect, Exit, Layer, ManagedRuntime, PubSub, Scope, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { afterEach, describe, expect, it } from "vitest";

import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import { mapToRuntimeEvents } from "../../provider/Layers/CodexAdapterHelpers.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { ProviderRuntimeIngestionLive } from "./ProviderRuntimeIngestion.ts";
import { splitBufferedAssistantText } from "./ProviderRuntimeIngestionHelpers.ts";
import { withCodexGeneratedImageAttachment } from "../../codex/generatedImages.ts";
import { DEFAULT_THREAD_TITLE } from "../threadTitles.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { ProviderRuntimeIngestionService } from "../Services/ProviderRuntimeIngestion.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";

function makeTestServerSettingsLayer(overrides: Partial<ServerSettings> = {}) {
  return ServerSettingsService.layerTest(overrides);
}

const asProjectId = (value: string): ProjectId => ProjectId.makeUnsafe(value);
const asItemId = (value: string): ProviderItemId => ProviderItemId.makeUnsafe(value);
const asEventId = (value: string): EventId => EventId.makeUnsafe(value);
const asMessageId = (value: string): MessageId => MessageId.makeUnsafe(value);
const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);
const asTurnId = (value: string): TurnId => TurnId.makeUnsafe(value);

type LegacyProviderRuntimeEvent = {
  readonly type: string;
  readonly eventId: EventId;
  readonly provider: ProviderRuntimeEvent["provider"];
  readonly createdAt: string;
  readonly threadId: ThreadId;
  readonly turnId?: string | undefined;
  readonly itemId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly payload?: unknown | undefined;
  readonly [key: string]: unknown;
};

type LegacyTurnCompletedEvent = LegacyProviderRuntimeEvent & {
  readonly type: "turn.completed";
  readonly payload?: undefined;
  readonly status: "completed" | "failed" | "interrupted" | "cancelled";
  readonly errorMessage?: string | undefined;
};

function isLegacyTurnCompletedEvent(
  event: LegacyProviderRuntimeEvent,
): event is LegacyTurnCompletedEvent {
  return (
    event.type === "turn.completed" &&
    event.payload === undefined &&
    typeof event.status === "string"
  );
}

function createProviderServiceHarness() {
  const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
  const runtimeSessions: ProviderSession[] = [];

  const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;
  const service: ProviderServiceShape = {
    startSession: () => unsupported(),
    sendTurn: () => unsupported(),
    interruptTurn: () => unsupported(),
    respondToRequest: () => unsupported(),
    respondToUserInput: () => unsupported(),
    stopSession: () => unsupported(),
    listSessions: () => Effect.succeed([...runtimeSessions]),
    getCapabilities: () => Effect.succeed({ sessionModelSwitch: "in-session" }),
    canRollbackConversation: () => Effect.succeed(true),
    rollbackConversation: () => unsupported(),
    compactThread: () => unsupported(),
    runGoalRequest: () => unsupported(),
    streamEvents: Stream.fromPubSub(runtimeEventPubSub),
    subscribeEvents: () => PubSub.subscribe(runtimeEventPubSub),
    subscribeToolInputPreview: () => PubSub.subscribe(runtimeEventPubSub),
  };

  const setSession = (session: ProviderSession): void => {
    const existingIndex = runtimeSessions.findIndex((entry) => entry.threadId === session.threadId);
    if (existingIndex >= 0) {
      runtimeSessions[existingIndex] = session;
      return;
    }
    runtimeSessions.push(session);
  };

  const normalizeLegacyEvent = (event: LegacyProviderRuntimeEvent): ProviderRuntimeEvent => {
    if (isLegacyTurnCompletedEvent(event)) {
      const normalized: Extract<ProviderRuntimeEvent, { type: "turn.completed" }> = {
        ...(event as Omit<Extract<ProviderRuntimeEvent, { type: "turn.completed" }>, "payload">),
        payload: {
          state: event.status,
          ...(typeof event.errorMessage === "string" ? { errorMessage: event.errorMessage } : {}),
        },
      };
      return normalized;
    }

    return event as ProviderRuntimeEvent;
  };

  const emit = (event: LegacyProviderRuntimeEvent): void => {
    Effect.runSync(PubSub.publish(runtimeEventPubSub, normalizeLegacyEvent(event)));
  };

  return {
    service,
    emit,
    setSession,
  };
}

async function waitForThread(
  engine: OrchestrationEngineShape,
  predicate: (thread: ProviderRuntimeTestThread) => boolean,
  timeoutMs = 2000,
  threadId: ThreadId = asThreadId("thread-1"),
) {
  const deadline = Date.now() + timeoutMs;
  const poll = async (): Promise<ProviderRuntimeTestThread> => {
    const readModel = await Effect.runPromise(engine.getReadModel());
    const thread = readModel.threads.get(threadId);
    if (thread && predicate(thread)) {
      return thread;
    }
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for thread state");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    return poll();
  };
  return poll();
}

type ProviderRuntimeTestReadModel = OrchestrationReadModel;
type ProviderRuntimeTestThread = ProviderRuntimeTestReadModel["threads"][number];
type ProviderRuntimeTestMessage = ProviderRuntimeTestThread["messages"][number];
type ProviderRuntimeTestProposedPlan = ProviderRuntimeTestThread["proposedPlans"][number];
type ProviderRuntimeTestActivity = ProviderRuntimeTestThread["activities"][number];
type ProviderRuntimeTestCheckpoint = ProviderRuntimeTestThread["checkpoints"][number];

const taskCompletions = (activities: ReadonlyArray<ProviderRuntimeTestActivity>) =>
  activities
    .filter((activity) => activity.kind === "task.completed")
    .map((activity) => activity.payload as { taskId: string; status: string });

const payloadOf = (activity: ProviderRuntimeTestActivity | undefined) =>
  activity?.payload as { detail: string; status: string; stream: string } | undefined;

describe("ProviderRuntimeIngestion", () => {
  let runtime: ManagedRuntime.ManagedRuntime<
    | OrchestrationEngineService
    | ProviderRuntimeIngestionService
    | SqlClient.SqlClient
    | ServerSettingsService,
    unknown
  > | null = null;
  let scope: Scope.Closeable | null = null;
  const tempDirs: string[] = [];

  function makeTempDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  async function createHarness(options?: {
    serverSettings?: Partial<ServerSettings>;
    threadTitle?: string;
  }) {
    const workspaceRoot = makeTempDir("piedpiper-provider-project-");
    // Repository detection asks git itself, so a bare `.git` directory is not enough.
    execFileSync("git", ["init", "-q"], { cwd: workspaceRoot });
    const provider = createProviderServiceHarness();
    const orchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(SqlitePersistenceMemory),
    );
    // Real clock plus an offset the test can advance, so delivery pacing can be driven without sleeping.
    let clockOffsetMs = 0;
    const realClock = Effect.runSync(Effect.service(Clock.Clock));
    const shiftedClock: Clock.Clock = {
      currentTimeMillisUnsafe: () => realClock.currentTimeMillisUnsafe() + clockOffsetMs,
      currentTimeMillis: Effect.sync(() => realClock.currentTimeMillisUnsafe() + clockOffsetMs),
      currentTimeNanosUnsafe: () =>
        realClock.currentTimeNanosUnsafe() + BigInt(clockOffsetMs) * 1_000_000n,
      currentTimeNanos: Effect.sync(
        () => realClock.currentTimeNanosUnsafe() + BigInt(clockOffsetMs) * 1_000_000n,
      ),
      sleep: (duration) => realClock.sleep(duration),
    };
    const layer = ProviderRuntimeIngestionLive.pipe(
      Layer.provide(Layer.succeed(Clock.Clock, shiftedClock)),
      Layer.provideMerge(orchestrationLayer),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(Layer.succeed(ProviderService, provider.service)),
      Layer.provideMerge(makeTestServerSettingsLayer(options?.serverSettings)),
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), { prefix: "pp-runtime-ingestion-test-" }),
      ),
      Layer.provideMerge(NodeServices.layer),
    );
    runtime = ManagedRuntime.make(layer);
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const ingestion = await runtime.runPromise(Effect.service(ProviderRuntimeIngestionService));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(ingestion.start().pipe(Scope.provide(scope)));
    const drain = () => Effect.runPromise(ingestion.drain);
    const sql = await runtime.runPromise(Effect.service(SqlClient.SqlClient));
    const serverSettings = await runtime.runPromise(Effect.service(ServerSettingsService));

    const createdAt = new Date().toISOString();
    await Effect.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-provider-project-create"),
        projectId: asProjectId("project-1"),
        title: "Provider Project",
        workspaceRoot,
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await Effect.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-create"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        projectId: asProjectId("project-1"),
        title: options?.threadTitle ?? "Thread",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await Effect.runPromise(
      engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-seed"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          updatedAt: createdAt,
          lastError: null,
        },
        createdAt,
      }),
    );
    provider.setSession({
      provider: "codex",
      status: "ready",
      runtimeMode: "approval-required",
      threadId: ThreadId.makeUnsafe("thread-1"),
      createdAt,
      updatedAt: createdAt,
    });

    return {
      engine,
      emit: provider.emit,
      setProviderSession: provider.setSession,
      drain,
      sql,
      setAssistantStreaming: (enableAssistantStreaming: boolean) =>
        Effect.runPromise(serverSettings.updateSettings({ enableAssistantStreaming })),
      advanceClock: (ms: number) => {
        clockOffsetMs += ms;
      },
    };
  }

  describe("images Codex generates", () => {
    const attachment = {
      type: "image" as const,
      id: "thread-1-11111111-2222-3333-4444-555555555555",
      name: "image.png",
      mimeType: "image/png",
      sizeBytes: 10,
    };
    const imageMessageId = "assistant:image:item-image";
    type Harness = Awaited<ReturnType<typeof createHarness>>;

    const emitImage = (harness: Harness, eventId: string, turnId = "turn-image") => {
      const [event] = withCodexGeneratedImageAttachment(
        [
          {
            type: "item.completed",
            eventId: asEventId(eventId),
            provider: "codex",
            createdAt: new Date().toISOString(),
            threadId: asThreadId("thread-1"),
            turnId: asTurnId(turnId),
            itemId: asItemId("item-image"),
            payload: { itemType: "image_view", status: "completed", title: "Image" },
          } as unknown as ProviderRuntimeEvent,
        ],
        attachment,
      );
      harness.emit(event as never);
    };

    const emitTurnStarted = (harness: Harness, turnId = "turn-image") =>
      harness.emit({
        type: "turn.started",
        eventId: asEventId(`evt-started-${turnId}`),
        provider: "codex",
        createdAt: new Date().toISOString(),
        threadId: asThreadId("thread-1"),
        turnId: asTurnId(turnId),
      });

    const emitTurnCompleted = (harness: Harness, turnId = "turn-image") =>
      harness.emit({
        type: "turn.completed",
        eventId: asEventId(`evt-completed-${turnId}`),
        provider: "codex",
        createdAt: new Date().toISOString(),
        threadId: asThreadId("thread-1"),
        turnId: asTurnId(turnId),
        status: "completed",
      });

    const hasImage = (thread: ProviderRuntimeTestThread) =>
      thread.messages.some((message) => message.id === imageMessageId);

    it("adds an image-only assistant message and keeps it through the projection", async () => {
      const harness = await createHarness();
      emitTurnStarted(harness);
      emitImage(harness, "evt-image-only");

      const thread = await waitForThread(harness.engine, hasImage);
      const message = thread.messages.find((entry) => entry.id === imageMessageId);
      expect(message).toMatchObject({
        role: "assistant",
        text: "",
        streaming: false,
        turnId: "turn-image",
        attachments: [attachment],
      });

      const rows = await Effect.runPromise(
        harness.sql<{ readonly attachments: string | null }>`
          SELECT attachments_json AS "attachments"
          FROM projection_thread_messages
          WHERE message_id = ${imageMessageId}
        `,
      );
      expect(JSON.parse(rows[0]?.attachments ?? "null")).toEqual([attachment]);
    });

    it("keeps the reply as its own message", async () => {
      const harness = await createHarness();
      emitTurnStarted(harness);
      harness.emit({
        type: "item.completed",
        eventId: asEventId("evt-reply"),
        provider: "codex",
        createdAt: new Date().toISOString(),
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-image"),
        itemId: asItemId("item-reply"),
        payload: { itemType: "assistant_message", status: "completed", detail: "Here it is" },
      });
      emitImage(harness, "evt-image-with-reply");

      const thread = await waitForThread(harness.engine, hasImage);
      const reply = thread.messages.find((entry) => entry.id === "assistant:item-reply");
      expect(reply?.text).toBe("Here it is");
      expect(reply?.attachments ?? []).toEqual([]);
    });

    it("accepts an image that finishes after turn.completed or under another turn", async () => {
      const harness = await createHarness();
      emitTurnStarted(harness);
      emitTurnCompleted(harness);
      await waitForThread(harness.engine, (thread) => thread.session?.status === "ready");
      emitTurnStarted(harness, "turn-next");
      await waitForThread(harness.engine, (thread) => thread.session?.activeTurnId === "turn-next");

      emitImage(harness, "evt-image-late");

      const thread = await waitForThread(harness.engine, hasImage);
      expect(thread.session?.activeTurnId).toBe("turn-next");
      expect(thread.messages.find((entry) => entry.id === imageMessageId)?.turnId).toBe(
        "turn-image",
      );
    });

    it("leaves one message when the same image is delivered twice", async () => {
      const harness = await createHarness();
      emitTurnStarted(harness);
      emitImage(harness, "evt-image-repeat");
      emitImage(harness, "evt-image-repeat");
      await harness.drain();

      const thread = await waitForThread(harness.engine, hasImage);
      expect(thread.messages.filter((entry) => entry.id === imageMessageId)).toHaveLength(1);
      const rows = await Effect.runPromise(
        harness.sql<{ readonly count: number }>`
          SELECT COUNT(*) AS "count"
          FROM projection_thread_messages
          WHERE message_id = ${imageMessageId}
        `,
      );
      expect(rows[0]?.count).toBe(1);
    });

    it("ignores an image item without a stored attachment", async () => {
      const harness = await createHarness();
      emitTurnStarted(harness);
      harness.emit({
        type: "item.completed",
        eventId: asEventId("evt-image-bare"),
        provider: "codex",
        createdAt: new Date().toISOString(),
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-image"),
        itemId: asItemId("item-image"),
        payload: { itemType: "image_view", status: "completed", title: "Image" },
      });
      await harness.drain();
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      expect(readModel.threads.get(asThreadId("thread-1"))?.messages ?? []).toEqual([]);
    });
  });

  describe("background tasks across Claude sessions", () => {
    type Harness = Awaited<ReturnType<typeof createHarness>>;

    const emitTask = (
      harness: Harness,
      type: "task.started" | "task.completed",
      taskId: string,
      provider: "claudeAgent" | "codex" = "claudeAgent",
    ) =>
      harness.emit({
        type,
        eventId: asEventId(`evt-${type}-${taskId}`),
        provider,
        createdAt: new Date().toISOString(),
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-task"),
        payload: type === "task.started" ? { taskId } : { taskId, status: "completed" },
      });

    const emitSessionStarted = (harness: Harness, provider: "claudeAgent" | "codex") =>
      harness.emit({
        type: "session.started",
        eventId: asEventId(`evt-session-started-${provider}`),
        provider,
        createdAt: new Date().toISOString(),
        threadId: asThreadId("thread-1"),
        message: "session started",
      });

    it("settles only the tasks a dead Claude session left open", async () => {
      const harness = await createHarness();
      emitTask(harness, "task.started", "task-open");
      emitTask(harness, "task.started", "task-done");
      emitTask(harness, "task.completed", "task-done");
      emitSessionStarted(harness, "claudeAgent");
      await harness.drain();

      const thread = await waitForThread(harness.engine, (entry) =>
        taskCompletions(entry.activities).some((payload) => payload.taskId === "task-open"),
      );
      expect(taskCompletions(thread.activities)).toHaveLength(2);
      expect(taskCompletions(thread.activities)).toEqual(
        expect.arrayContaining([
          { taskId: "task-done", status: "completed" },
          { taskId: "task-open", status: "stopped" },
        ]),
      );
      const settled = thread.activities.find(
        (activity) =>
          activity.kind === "task.completed" &&
          (activity.payload as { taskId: string }).taskId === "task-open",
      );
      expect(settled).toMatchObject({ summary: "Task stopped", tone: "info", turnId: null });
    });

    it("leaves Codex sessions alone", async () => {
      const harness = await createHarness();
      emitTask(harness, "task.started", "task-codex", "codex");
      emitSessionStarted(harness, "codex");
      await harness.drain();

      await waitForThread(harness.engine, (entry) =>
        entry.activities.some((activity) => activity.kind === "task.started"),
      );
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      const thread = readModel.threads.get(asThreadId("thread-1"));
      expect(taskCompletions(thread?.activities ?? [])).toEqual([]);
    });
  });

  describe("assistant text batching in streaming mode", () => {
    const at = "2026-03-01T00:00:00.000Z";
    const messageId = "assistant:item-batched";
    type Harness = Awaited<ReturnType<typeof createHarness>>;

    const startTurn = async (harness: Harness) => {
      harness.emit({
        type: "turn.started",
        eventId: asEventId("evt-batched-turn"),
        provider: "codex",
        createdAt: at,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-batched"),
      });
      await harness.drain();
    };
    const emitDelta = (harness: Harness, delta: string) =>
      harness.emit({
        type: "content.delta",
        eventId: asEventId(`evt-batched-delta-${crypto.randomUUID()}`),
        provider: "codex",
        createdAt: at,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-batched"),
        itemId: asItemId("item-batched"),
        payload: { streamKind: "assistant_text", delta },
      });
    const emitCompleted = (harness: Harness) =>
      harness.emit({
        type: "item.completed",
        eventId: asEventId("evt-batched-completed"),
        provider: "codex",
        createdAt: at,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-batched"),
        itemId: asItemId("item-batched"),
        payload: { itemType: "assistant_message", status: "completed" },
      });
    const messageOf = async (harness: Harness) => {
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      return readModel.threads
        .get(asThreadId("thread-1"))
        ?.messages.find((entry: ProviderRuntimeTestMessage) => entry.id === messageId);
    };
    const messageEvents = async (harness: Harness) => {
      const events = await Effect.runPromise(Stream.runCollect(harness.engine.readEvents(0)));
      return Array.from(events).filter(
        (event) => event.type === "thread.message-sent" && event.payload.messageId === messageId,
      );
    };

    it("delivers the first delta at once and folds a burst into one flush", async () => {
      const harness = await createHarness({ serverSettings: { enableAssistantStreaming: true } });
      await startTurn(harness);
      const deltas = Array.from({ length: 20 }, (_, index) => `${index} `);
      for (const delta of deltas) {
        emitDelta(harness, delta);
      }
      await harness.drain();
      expect((await messageOf(harness))?.text).toBe("0 ");

      await waitForThread(harness.engine, (thread) =>
        thread.messages.some(
          (message: ProviderRuntimeTestMessage) =>
            message.id === messageId && message.text === deltas.join(""),
        ),
      );
      expect(await messageEvents(harness)).toHaveLength(2);
    });

    it("delivers the tail before the completion", async () => {
      const harness = await createHarness({ serverSettings: { enableAssistantStreaming: true } });
      await startTurn(harness);
      emitDelta(harness, "head ");
      emitDelta(harness, "tail");
      emitCompleted(harness);
      await harness.drain();

      const message = await messageOf(harness);
      expect(message?.text).toBe("head tail");
      expect(message?.streaming).toBe(false);
      const events = await messageEvents(harness);
      expect(
        events.map((event) => (event.type === "thread.message-sent" ? event.payload.streaming : 0)),
      ).toEqual([true, true, false]);

      // The trailing flush scheduled by the tail finds nothing left to deliver.
      await new Promise((resolve) => setTimeout(resolve, 100));
      await harness.drain();
      expect(await messageEvents(harness)).toHaveLength(3);
      expect((await messageOf(harness))?.text).toBe("head tail");
    });

    it("flushes a tail during a pause and sends the next delta straight away", async () => {
      const harness = await createHarness({ serverSettings: { enableAssistantStreaming: true } });
      await startTurn(harness);
      emitDelta(harness, "a");
      emitDelta(harness, "b");
      await harness.drain();
      expect((await messageOf(harness))?.text).toBe("a");

      await waitForThread(harness.engine, (thread) =>
        thread.messages.some(
          (message: ProviderRuntimeTestMessage) =>
            message.id === messageId && message.text === "ab",
        ),
      );
      harness.advanceClock(1_000);
      emitDelta(harness, "c");
      await harness.drain();
      expect((await messageOf(harness))?.text).toBe("abc");
    });

    it("still flushes the tail promptly after the wall clock steps backwards", async () => {
      const harness = await createHarness({ serverSettings: { enableAssistantStreaming: true } });
      await startTurn(harness);
      emitDelta(harness, "a");
      await harness.drain();
      expect((await messageOf(harness))?.text).toBe("a");

      harness.advanceClock(-60 * 60 * 1000);
      emitDelta(harness, "b");
      await harness.drain();
      await waitForThread(harness.engine, (thread) =>
        thread.messages.some(
          (message: ProviderRuntimeTestMessage) =>
            message.id === messageId && message.text === "ab",
        ),
      );
    });

    it("keeps order when streaming is switched on mid-message", async () => {
      const harness = await createHarness({ serverSettings: { enableAssistantStreaming: false } });
      await startTurn(harness);
      emitDelta(harness, "buffered ");
      await harness.drain();
      expect(await messageOf(harness)).toBeUndefined();

      await harness.setAssistantStreaming(true);
      emitDelta(harness, "streamed");
      await harness.drain();
      expect((await messageOf(harness))?.text).toBe("buffered streamed");
    });

    it("keeps order and text when streaming is switched off mid-message", async () => {
      const harness = await createHarness({ serverSettings: { enableAssistantStreaming: true } });
      await startTurn(harness);
      emitDelta(harness, "one ");
      emitDelta(harness, "two ");
      await harness.drain();

      await harness.setAssistantStreaming(false);
      emitDelta(harness, "three");
      emitCompleted(harness);
      await harness.drain();
      expect((await messageOf(harness))?.text).toBe("one two three");
    });

    it("delivers a pending tail when the session exits", async () => {
      const harness = await createHarness({ serverSettings: { enableAssistantStreaming: true } });
      await startTurn(harness);
      emitDelta(harness, "head ");
      emitDelta(harness, "tail");
      harness.emit({
        type: "session.exited",
        eventId: asEventId("evt-batched-exit"),
        provider: "codex",
        createdAt: at,
        threadId: asThreadId("thread-1"),
        payload: {},
      });
      await harness.drain();
      expect((await messageOf(harness))?.text).toBe("head tail");
    });

    it("shows recovery steps once when a database write fails, keeping the session state", async () => {
      const harness = await createHarness({ serverSettings: { enableAssistantStreaming: true } });
      await startTurn(harness);
      await Effect.runPromise(
        harness.sql.unsafe(`
        CREATE TEMP TRIGGER reject_message_events BEFORE INSERT ON main.orchestration_events
        WHEN NEW.event_type = 'thread.message-sent'
        BEGIN SELECT RAISE(ABORT, 'driver-private-text'); END
      `),
      );

      for (const delta of ["a", "b", "c"]) {
        emitDelta(harness, delta);
        await harness.drain();
        harness.advanceClock(100);
      }

      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      const session = readModel.threads.get(asThreadId("thread-1"))?.session;
      expect(session?.lastError).toContain("could not complete this database request");
      expect(session?.lastError).not.toContain("driver-private-text");
      expect(session?.status).toBe("running");
      expect(session?.activeTurnId).toBe("turn-batched");

      const events = await Effect.runPromise(Stream.runCollect(harness.engine.readEvents(0)));
      const errorUpdates = Array.from(events).filter(
        (event) => event.type === "thread.session-set" && event.payload.session.lastError !== null,
      );
      expect(errorUpdates).toHaveLength(1);
    });

    it("survives a failed attempt to show the database error", async () => {
      const harness = await createHarness({ serverSettings: { enableAssistantStreaming: true } });
      await startTurn(harness);
      await Effect.runPromise(harness.sql.unsafe("PRAGMA query_only = ON"));
      emitDelta(harness, "lost");
      await harness.drain();
      await Effect.runPromise(harness.sql.unsafe("PRAGMA query_only = OFF"));

      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      const session = readModel.threads.get(asThreadId("thread-1"))?.session;
      expect(session?.lastError).toBeNull();
      expect(session?.status).toBe("running");

      harness.advanceClock(100);
      emitDelta(harness, "kept");
      await harness.drain();
      expect((await messageOf(harness))?.text).toBe("kept");
    });
  });

  it("maps turn started/completed events into thread session updates", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      createdAt: now,
      turnId: asTurnId("turn-1"),
    });

    await waitForThread(
      harness.engine,
      (thread) => thread.session?.status === "running" && thread.session?.activeTurnId === "turn-1",
    );

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      createdAt: new Date().toISOString(),
      turnId: asTurnId("turn-1"),
      payload: {
        state: "failed",
        errorMessage: "turn failed",
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.status === "error" &&
        entry.session?.activeTurnId === null &&
        entry.session?.lastError === "turn failed",
    );
    expect(thread.session?.status).toBe("error");
    expect(thread.session?.lastError).toBe("turn failed");
  });

  it("applies provider session.state.changed transitions directly", async () => {
    const harness = await createHarness();
    const waitingAt = new Date().toISOString();

    harness.emit({
      type: "session.state.changed",
      eventId: asEventId("evt-session-state-waiting"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      createdAt: waitingAt,
      payload: {
        state: "waiting",
        reason: "awaiting approval",
      },
    });

    let thread = await waitForThread(
      harness.engine,
      (entry) => entry.session?.status === "running" && entry.session?.activeTurnId === null,
    );
    expect(thread.session?.status).toBe("running");
    expect(thread.session?.lastError).toBeNull();

    harness.emit({
      type: "session.state.changed",
      eventId: asEventId("evt-session-state-error"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      createdAt: new Date().toISOString(),
      payload: {
        state: "error",
        reason: "provider crashed",
      },
    });

    thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.status === "error" &&
        entry.session?.activeTurnId === null &&
        entry.session?.lastError === "provider crashed",
    );
    expect(thread.session?.status).toBe("error");
    expect(thread.session?.lastError).toBe("provider crashed");

    harness.emit({
      type: "session.state.changed",
      eventId: asEventId("evt-session-state-stopped"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      createdAt: new Date().toISOString(),
      payload: {
        state: "stopped",
      },
    });

    thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.status === "stopped" &&
        entry.session?.activeTurnId === null &&
        entry.session?.lastError === "provider crashed",
    );
    expect(thread.session?.status).toBe("stopped");
    expect(thread.session?.lastError).toBe("provider crashed");

    harness.emit({
      type: "session.state.changed",
      eventId: asEventId("evt-session-state-ready"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      createdAt: new Date().toISOString(),
      payload: {
        state: "ready",
      },
    });

    thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.status === "ready" &&
        entry.session?.activeTurnId === null &&
        entry.session?.lastError === null,
    );
    expect(thread.session?.status).toBe("ready");
    expect(thread.session?.lastError).toBeNull();
  });

  it("ignores untargeted turn completions while a turn is starting", async () => {
    const harness = await createHarness();
    const startingAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-starting"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "starting",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: null,
          updatedAt: startingAt,
          lastError: null,
        },
        createdAt: startingAt,
      }),
    );

    // Claude's resume handshake emits a completion for a turn that never ran.
    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-handshake"),
      provider: "claudeAgent",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      status: "completed",
    });

    await harness.drain();
    const midReadModel = await Effect.runPromise(harness.engine.getReadModel());
    const midThread = midReadModel.threads.get(ThreadId.makeUnsafe("thread-1"));
    expect(midThread?.session?.status).toBe("starting");

    // A failed untargeted completion is ignored too: it cannot be tied to a turn.
    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-handshake-failed"),
      provider: "claudeAgent",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      status: "failed",
      errorMessage: "resume rejected",
    });

    await harness.drain();
    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.get(ThreadId.makeUnsafe("thread-1"));
    expect(thread?.session?.status).toBe("starting");
    expect(thread?.session?.lastError).toBeNull();
  });

  it("keeps a pending turn start in starting until the provider reports turn.started", async () => {
    const harness = await createHarness();
    const startingAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-pending-turn-start"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("message-pending-turn-start"),
          role: "user",
          text: "hello",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: startingAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-pending-starting"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "starting",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          updatedAt: startingAt,
          lastError: null,
        },
        createdAt: startingAt,
      }),
    );

    harness.emit({
      type: "session.state.changed",
      eventId: asEventId("evt-pending-session-ready"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      createdAt: new Date().toISOString(),
      payload: { state: "ready" },
    });
    harness.emit({
      type: "thread.started",
      eventId: asEventId("evt-pending-thread-started"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      createdAt: new Date().toISOString(),
      payload: { providerThreadId: "provider-thread-pending" },
    });
    await harness.drain();

    const midThread = (await Effect.runPromise(harness.engine.getReadModel())).threads.get(
      ThreadId.makeUnsafe("thread-1"),
    );
    expect(midThread?.session?.status).toBe("starting");
    expect(midThread?.session?.activeTurnId).toBeNull();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-pending-turn-started"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      createdAt: new Date().toISOString(),
      turnId: asTurnId("turn-pending"),
    });
    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.status === "running" && entry.session?.activeTurnId === "turn-pending",
    );
    expect(thread.session?.status).toBe("running");

    harness.emit({
      type: "session.state.changed",
      eventId: asEventId("evt-pending-session-ready-after"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      createdAt: new Date().toISOString(),
      payload: { state: "ready" },
    });
    // With the start consumed, ready means idle again.
    await waitForThread(
      harness.engine,
      (entry) => entry.session?.status === "ready" && entry.session?.activeTurnId === null,
    );
  });

  it("accepts a targeted turn completion when no turn is active", async () => {
    const harness = await createHarness();
    const startingAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-starting-targeted"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "starting",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          updatedAt: startingAt,
          lastError: null,
        },
        createdAt: startingAt,
      }),
    );

    // The turn.started for this turn was lost; its completion must still settle the thread.
    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-lost-start"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-lost-start"),
      status: "completed",
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) => entry.session?.status === "ready" && entry.session?.activeTurnId === null,
    );
    expect(thread.session?.lastError).toBeNull();
  });

  it("clears the active turn when the provider session becomes ready", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-session-ready"),
      provider: "claudeAgent",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-session-ready"),
    });
    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-session-ready",
    );

    harness.emit({
      type: "session.state.changed",
      eventId: asEventId("evt-session-ready-mid-turn"),
      provider: "claudeAgent",
      threadId: asThreadId("thread-1"),
      createdAt: new Date().toISOString(),
      payload: {
        state: "ready",
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) => entry.session?.status === "ready" && entry.session?.activeTurnId === null,
    );
    expect(thread.session?.lastError).toBeNull();
  });

  it("clears the active turn and finalizes buffered text when the session errors mid-turn", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-session-error"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-session-error"),
    });
    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-session-error",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-session-error-delta"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-session-error"),
      itemId: asItemId("item-session-error"),
      payload: {
        streamKind: "assistant_text",
        delta: "partial answer",
      },
    });
    await harness.drain();

    harness.emit({
      type: "session.state.changed",
      eventId: asEventId("evt-session-error-mid-turn"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      createdAt: new Date().toISOString(),
      payload: {
        state: "error",
        reason: "provider process exited",
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.status === "error" &&
        entry.session?.activeTurnId === null &&
        entry.messages.some(
          (message: ProviderRuntimeTestMessage) =>
            message.id === "assistant:item-session-error" && !message.streaming,
        ),
    );
    expect(thread.session?.lastError).toBe("provider process exited");
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-session-error",
    );
    expect(message?.text).toBe("partial answer");
  });

  it("clears the active turn when the session stops mid-turn", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-session-stopped"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-session-stopped"),
    });
    await waitForThread(
      harness.engine,
      (thread) => thread.session?.activeTurnId === "turn-session-stopped",
    );

    harness.emit({
      type: "session.state.changed",
      eventId: asEventId("evt-session-stopped-mid-turn"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      createdAt: new Date().toISOString(),
      payload: {
        state: "stopped",
      },
    });

    await waitForThread(
      harness.engine,
      (entry) => entry.session?.status === "stopped" && entry.session?.activeTurnId === null,
    );
  });

  it("keeps the active turn when the session reports running mid-turn", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-session-running"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-session-running"),
    });
    await waitForThread(
      harness.engine,
      (thread) => thread.session?.activeTurnId === "turn-session-running",
    );

    harness.emit({
      type: "session.state.changed",
      eventId: asEventId("evt-session-waiting-mid-turn"),
      provider: "codex",
      threadId: asThreadId("thread-1"),
      createdAt: new Date().toISOString(),
      payload: {
        state: "waiting",
        reason: "awaiting approval",
      },
    });

    await harness.drain();
    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.get(ThreadId.makeUnsafe("thread-1"));
    expect(thread?.session?.status).toBe("running");
    expect(thread?.session?.activeTurnId).toBe("turn-session-running");
  });

  it("does not clear active turn when session/thread started arrives mid-turn", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-midturn-lifecycle"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-midturn-lifecycle"),
    });

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-midturn-lifecycle",
    );

    harness.emit({
      type: "thread.started",
      eventId: asEventId("evt-thread-started-midturn-lifecycle"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
    });
    harness.emit({
      type: "session.started",
      eventId: asEventId("evt-session-started-midturn-lifecycle"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
    });

    await harness.drain();
    const midReadModel = await Effect.runPromise(harness.engine.getReadModel());
    const midThread = midReadModel.threads.get(ThreadId.makeUnsafe("thread-1"));
    expect(midThread?.session?.status).toBe("running");
    expect(midThread?.session?.activeTurnId).toBe("turn-midturn-lifecycle");

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-midturn-lifecycle"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-midturn-lifecycle"),
      status: "completed",
    });

    await waitForThread(
      harness.engine,
      (thread) => thread.session?.status === "ready" && thread.session?.activeTurnId === null,
    );
  });

  it("accepts claude turn lifecycle when seeded thread id is a synthetic placeholder", async () => {
    const harness = await createHarness();
    const seededAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-seed-claude-placeholder"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: null,
          updatedAt: seededAt,
          lastError: null,
        },
        createdAt: seededAt,
      }),
    );

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-claude-placeholder"),
      provider: "claudeAgent",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-claude-placeholder"),
    });

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-claude-placeholder",
    );

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-claude-placeholder"),
      provider: "claudeAgent",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-claude-placeholder"),
      status: "completed",
    });

    await waitForThread(
      harness.engine,
      (thread) => thread.session?.status === "ready" && thread.session?.activeTurnId === null,
    );
  });

  it("ignores auxiliary turn completions from a different provider thread", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-primary"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-primary"),
    });

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" && thread.session?.activeTurnId === "turn-primary",
    );

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-aux"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-aux"),
      status: "completed",
    });

    await harness.drain();
    const midReadModel = await Effect.runPromise(harness.engine.getReadModel());
    const midThread = midReadModel.threads.get(ThreadId.makeUnsafe("thread-1"));
    expect(midThread?.session?.status).toBe("running");
    expect(midThread?.session?.activeTurnId).toBe("turn-primary");

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-primary"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-primary"),
      status: "completed",
    });

    await waitForThread(
      harness.engine,
      (thread) => thread.session?.status === "ready" && thread.session?.activeTurnId === null,
    );
  });

  it("ignores non-active turn completion when runtime omits thread id", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-guarded"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-guarded-main"),
    });

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-guarded-main",
    );

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-guarded-other"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-guarded-other"),
      status: "completed",
    });

    await harness.drain();
    const midReadModel = await Effect.runPromise(harness.engine.getReadModel());
    const midThread = midReadModel.threads.get(ThreadId.makeUnsafe("thread-1"));
    expect(midThread?.session?.status).toBe("running");
    expect(midThread?.session?.activeTurnId).toBe("turn-guarded-main");

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-guarded-main"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-guarded-main"),
      status: "completed",
    });

    await waitForThread(
      harness.engine,
      (thread) => thread.session?.status === "ready" && thread.session?.activeTurnId === null,
    );
  });

  it("maps canonical content delta/item completed into finalized assistant messages", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-1"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-2"),
      itemId: asItemId("item-1"),
      payload: {
        streamKind: "assistant_text",
        delta: "hello",
      },
    });
    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-2"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-2"),
      itemId: asItemId("item-1"),
      payload: {
        streamKind: "assistant_text",
        delta: " world",
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-2"),
      itemId: asItemId("item-1"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-1" && !message.streaming,
      ),
    );
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-1",
    );
    expect(message?.text).toBe("hello world");
    expect(message?.streaming).toBe(false);
  });

  it("uses assistant item completion detail when no assistant deltas were streamed", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-assistant-item-completed-no-delta"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-no-delta"),
      itemId: asItemId("item-no-delta"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        detail: "assistant-only final text",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-no-delta" && !message.streaming,
      ),
    );
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-no-delta",
    );
    expect(message?.text).toBe("assistant-only final text");
    expect(message?.streaming).toBe(false);
  });

  it("projects completed plan items into first-class proposed plans", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.proposed.completed",
      eventId: asEventId("evt-plan-item-completed"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-plan-final"),
      payload: {
        planMarkdown: "## Ship plan\n\n- wire projection\n- render follow-up",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.proposedPlans.some(
        (proposedPlan: ProviderRuntimeTestProposedPlan) =>
          proposedPlan.id === "plan:thread-1:turn:turn-plan-final",
      ),
    );
    const proposedPlan = thread.proposedPlans.find(
      (entry: ProviderRuntimeTestProposedPlan) => entry.id === "plan:thread-1:turn:turn-plan-final",
    );
    expect(proposedPlan?.planMarkdown).toBe(
      "## Ship plan\n\n- wire projection\n- render follow-up",
    );
  });

  it("marks the source proposed plan implemented only after the target turn starts", async () => {
    const harness = await createHarness();
    const sourceThreadId = asThreadId("thread-plan");
    const targetThreadId = asThreadId("thread-implement");
    const sourceTurnId = asTurnId("turn-plan-source");
    const targetTurnId = asTurnId("turn-plan-implement");
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-create-plan-source"),
        threadId: sourceThreadId,
        projectId: asProjectId("project-1"),
        title: "Plan Source",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        interactionMode: "plan",
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-plan-source"),
        threadId: sourceThreadId,
        session: {
          threadId: sourceThreadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          updatedAt: createdAt,
          lastError: null,
        },
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-create-plan-target"),
        threadId: targetThreadId,
        projectId: asProjectId("project-1"),
        title: "Plan Target",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-plan-target"),
        threadId: targetThreadId,
        session: {
          threadId: targetThreadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          updatedAt: createdAt,
          lastError: null,
        },
        createdAt,
      }),
    );
    harness.setProviderSession({
      provider: "codex",
      status: "ready",
      runtimeMode: "approval-required",
      threadId: targetThreadId,
      createdAt,
      updatedAt: createdAt,
      activeTurnId: targetTurnId,
    });

    harness.emit({
      type: "turn.proposed.completed",
      eventId: asEventId("evt-plan-source-completed"),
      provider: "codex",
      createdAt,
      threadId: sourceThreadId,
      turnId: sourceTurnId,
      payload: {
        planMarkdown: "# Source plan",
      },
    });

    const sourceThreadWithPlan = await waitForThread(
      harness.engine,
      (thread) =>
        thread.proposedPlans.some(
          (proposedPlan: ProviderRuntimeTestProposedPlan) =>
            proposedPlan.id === "plan:thread-plan:turn:turn-plan-source" &&
            proposedPlan.implementedAt === null,
        ),
      2_000,
      sourceThreadId,
    );
    const sourcePlan = sourceThreadWithPlan.proposedPlans.find(
      (entry: ProviderRuntimeTestProposedPlan) =>
        entry.id === "plan:thread-plan:turn:turn-plan-source",
    );
    expect(sourcePlan).toBeDefined();
    if (!sourcePlan) {
      throw new Error("Expected source plan to exist.");
    }

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-plan-target"),
        threadId: targetThreadId,
        message: {
          messageId: asMessageId("msg-plan-target"),
          role: "user",
          text: "PLEASE IMPLEMENT THIS PLAN:\n# Source plan",
          attachments: [],
        },
        sourceProposedPlan: {
          threadId: sourceThreadId,
          planId: sourcePlan.id,
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: new Date().toISOString(),
      }),
    );

    const sourceThreadBeforeStart = await waitForThread(
      harness.engine,
      (thread) =>
        thread.proposedPlans.some(
          (proposedPlan: ProviderRuntimeTestProposedPlan) =>
            proposedPlan.id === sourcePlan.id && proposedPlan.implementedAt === null,
        ),
      2_000,
      sourceThreadId,
    );
    expect(
      sourceThreadBeforeStart.proposedPlans.find((entry) => entry.id === sourcePlan.id),
    ).toMatchObject({
      implementedAt: null,
      implementationThreadId: null,
    });

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-plan-target-started"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: targetThreadId,
      turnId: targetTurnId,
    });

    const sourceThreadAfterStart = await waitForThread(
      harness.engine,
      (thread) =>
        thread.proposedPlans.some(
          (proposedPlan: ProviderRuntimeTestProposedPlan) =>
            proposedPlan.id === sourcePlan.id &&
            proposedPlan.implementedAt !== null &&
            proposedPlan.implementationThreadId === targetThreadId,
        ),
      2_000,
      sourceThreadId,
    );
    expect(
      sourceThreadAfterStart.proposedPlans.find((entry) => entry.id === sourcePlan.id),
    ).toMatchObject({
      implementationThreadId: "thread-implement",
    });
  });

  it("does not mark the source proposed plan implemented for a rejected turn.started event", async () => {
    const harness = await createHarness();
    const sourceThreadId = asThreadId("thread-plan");
    const targetThreadId = asThreadId("thread-1");
    const sourceTurnId = asTurnId("turn-plan-source");
    const activeTurnId = asTurnId("turn-already-running");
    const staleTurnId = asTurnId("turn-stale-start");
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-create-plan-source-guarded"),
        threadId: sourceThreadId,
        projectId: asProjectId("project-1"),
        title: "Plan Source",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        interactionMode: "plan",
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-plan-source-guarded"),
        threadId: sourceThreadId,
        session: {
          threadId: sourceThreadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          updatedAt: createdAt,
          lastError: null,
        },
        createdAt,
      }),
    );
    harness.setProviderSession({
      provider: "codex",
      status: "running",
      runtimeMode: "approval-required",
      threadId: targetThreadId,
      createdAt,
      updatedAt: createdAt,
      activeTurnId,
    });

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-already-running"),
      provider: "codex",
      createdAt,
      threadId: targetThreadId,
      turnId: activeTurnId,
    });

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" && thread.session?.activeTurnId === activeTurnId,
      2_000,
      targetThreadId,
    );

    harness.emit({
      type: "turn.proposed.completed",
      eventId: asEventId("evt-plan-source-completed-guarded"),
      provider: "codex",
      createdAt,
      threadId: sourceThreadId,
      turnId: sourceTurnId,
      payload: {
        planMarkdown: "# Source plan",
      },
    });

    const sourceThreadWithPlan = await waitForThread(
      harness.engine,
      (thread) =>
        thread.proposedPlans.some(
          (proposedPlan: ProviderRuntimeTestProposedPlan) =>
            proposedPlan.id === "plan:thread-plan:turn:turn-plan-source" &&
            proposedPlan.implementedAt === null,
        ),
      2_000,
      sourceThreadId,
    );
    const sourcePlan = sourceThreadWithPlan.proposedPlans.find(
      (entry: ProviderRuntimeTestProposedPlan) =>
        entry.id === "plan:thread-plan:turn:turn-plan-source",
    );
    expect(sourcePlan).toBeDefined();
    if (!sourcePlan) {
      throw new Error("Expected source plan to exist.");
    }

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-plan-target-guarded"),
        threadId: targetThreadId,
        message: {
          messageId: asMessageId("msg-plan-target-guarded"),
          role: "user",
          text: "PLEASE IMPLEMENT THIS PLAN:\n# Source plan",
          attachments: [],
        },
        sourceProposedPlan: {
          threadId: sourceThreadId,
          planId: sourcePlan.id,
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: new Date().toISOString(),
      }),
    );

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-stale-plan-implementation"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: targetThreadId,
      turnId: staleTurnId,
    });

    await harness.drain();

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const sourceThreadAfterRejectedStart = readModel.threads.get(sourceThreadId);
    expect(
      sourceThreadAfterRejectedStart?.proposedPlans.find((entry) => entry.id === sourcePlan.id),
    ).toMatchObject({
      implementedAt: null,
      implementationThreadId: null,
    });

    const targetThreadAfterRejectedStart = readModel.threads.get(targetThreadId);
    expect(targetThreadAfterRejectedStart?.session?.status).toBe("running");
    expect(targetThreadAfterRejectedStart?.session?.activeTurnId).toBe(activeTurnId);
  });

  it("does not mark the source proposed plan implemented for an unrelated turn.started when no thread active turn is tracked", async () => {
    const harness = await createHarness();
    const sourceThreadId = asThreadId("thread-plan");
    const targetThreadId = asThreadId("thread-implement");
    const sourceTurnId = asTurnId("turn-plan-source");
    const expectedTurnId = asTurnId("turn-plan-implement");
    const replayedTurnId = asTurnId("turn-replayed");
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-create-plan-source-unrelated"),
        threadId: sourceThreadId,
        projectId: asProjectId("project-1"),
        title: "Plan Source",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        interactionMode: "plan",
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-plan-source-unrelated"),
        threadId: sourceThreadId,
        session: {
          threadId: sourceThreadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          updatedAt: createdAt,
          lastError: null,
        },
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-create-plan-target-unrelated"),
        threadId: targetThreadId,
        projectId: asProjectId("project-1"),
        title: "Plan Target",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-plan-target-unrelated"),
        threadId: targetThreadId,
        session: {
          threadId: targetThreadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          updatedAt: createdAt,
          lastError: null,
        },
        createdAt,
      }),
    );

    harness.emit({
      type: "turn.proposed.completed",
      eventId: asEventId("evt-plan-source-completed-unrelated"),
      provider: "codex",
      createdAt,
      threadId: sourceThreadId,
      turnId: sourceTurnId,
      payload: {
        planMarkdown: "# Source plan",
      },
    });

    const sourceThreadWithPlan = await waitForThread(
      harness.engine,
      (thread) =>
        thread.proposedPlans.some(
          (proposedPlan: ProviderRuntimeTestProposedPlan) =>
            proposedPlan.id === "plan:thread-plan:turn:turn-plan-source" &&
            proposedPlan.implementedAt === null,
        ),
      2_000,
      sourceThreadId,
    );
    const sourcePlan = sourceThreadWithPlan.proposedPlans.find(
      (entry: ProviderRuntimeTestProposedPlan) =>
        entry.id === "plan:thread-plan:turn:turn-plan-source",
    );
    expect(sourcePlan).toBeDefined();
    if (!sourcePlan) {
      throw new Error("Expected source plan to exist.");
    }

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-plan-target-unrelated"),
        threadId: targetThreadId,
        message: {
          messageId: asMessageId("msg-plan-target-unrelated"),
          role: "user",
          text: "PLEASE IMPLEMENT THIS PLAN:\n# Source plan",
          attachments: [],
        },
        sourceProposedPlan: {
          threadId: sourceThreadId,
          planId: sourcePlan.id,
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: new Date().toISOString(),
      }),
    );

    harness.setProviderSession({
      provider: "codex",
      status: "running",
      runtimeMode: "approval-required",
      threadId: targetThreadId,
      createdAt,
      updatedAt: createdAt,
      activeTurnId: expectedTurnId,
    });

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-unrelated-plan-implementation"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: targetThreadId,
      turnId: replayedTurnId,
    });

    await harness.drain();

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const sourceThreadAfterUnrelatedStart = readModel.threads.get(sourceThreadId);
    expect(
      sourceThreadAfterUnrelatedStart?.proposedPlans.find((entry) => entry.id === sourcePlan.id),
    ).toMatchObject({
      implementedAt: null,
      implementationThreadId: null,
    });
  });

  it("finalizes buffered proposed-plan deltas into a first-class proposed plan on turn completion", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-plan-buffer"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-plan-buffer"),
    });

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" && thread.session?.activeTurnId === "turn-plan-buffer",
    );

    harness.emit({
      type: "turn.proposed.delta",
      eventId: asEventId("evt-plan-delta-1"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-plan-buffer"),
      payload: {
        delta: "## Buffered plan\n\n- first",
      },
    });
    harness.emit({
      type: "turn.proposed.delta",
      eventId: asEventId("evt-plan-delta-2"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-plan-buffer"),
      payload: {
        delta: "\n- second",
      },
    });
    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-plan-buffer"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-plan-buffer"),
      payload: {
        state: "completed",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.proposedPlans.some(
        (proposedPlan: ProviderRuntimeTestProposedPlan) =>
          proposedPlan.id === "plan:thread-1:turn:turn-plan-buffer",
      ),
    );
    const proposedPlan = thread.proposedPlans.find(
      (entry: ProviderRuntimeTestProposedPlan) =>
        entry.id === "plan:thread-1:turn:turn-plan-buffer",
    );
    expect(proposedPlan?.planMarkdown).toBe("## Buffered plan\n\n- first\n- second");
  });

  it("buffers assistant deltas by default until completion", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-buffered"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered"),
    });
    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" && thread.session?.activeTurnId === "turn-buffered",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-buffered"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered"),
      itemId: asItemId("item-buffered"),
      payload: {
        streamKind: "assistant_text",
        delta: "buffer me",
      },
    });

    await harness.drain();
    const midReadModel = await Effect.runPromise(harness.engine.getReadModel());
    const midThread = midReadModel.threads.get(ThreadId.makeUnsafe("thread-1"));
    expect(
      midThread?.messages.some(
        (message: ProviderRuntimeTestMessage) => message.id === "assistant:item-buffered",
      ),
    ).toBe(false);

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed-buffered"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered"),
      itemId: asItemId("item-buffered"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-buffered" && !message.streaming,
      ),
    );
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-buffered",
    );
    expect(message?.text).toBe("buffer me");
    expect(message?.streaming).toBe(false);
  });

  it("streams assistant deltas when thread.turn.start requests streaming mode", async () => {
    const harness = await createHarness({ serverSettings: { enableAssistantStreaming: true } });
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-streaming-mode"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("message-streaming-mode"),
          role: "user",
          text: "stream please",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.drain();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-streaming-mode"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-mode"),
    });
    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-streaming-mode",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-streaming-mode"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-mode"),
      itemId: asItemId("item-streaming-mode"),
      payload: {
        streamKind: "assistant_text",
        delta: "hello live",
      },
    });

    const liveThread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-streaming-mode" &&
          message.streaming &&
          message.text === "hello live",
      ),
    );
    const liveMessage = liveThread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-streaming-mode",
    );
    expect(liveMessage?.streaming).toBe(true);

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed-streaming-mode"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-mode"),
      itemId: asItemId("item-streaming-mode"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        detail: "hello live",
      },
    });

    const finalThread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-streaming-mode" && !message.streaming,
      ),
    );
    const finalMessage = finalThread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-streaming-mode",
    );
    expect(finalMessage?.text).toBe("hello live");
    expect(finalMessage?.streaming).toBe(false);
  });

  it("delivers finished paragraphs while the rest of the message stays buffered", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    const threadId = asThreadId("thread-1");
    const turnId = asTurnId("turn-paragraph-flush");
    const itemId = asItemId("item-paragraph-flush");
    const messageId = `assistant:${itemId}`;

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-paragraph-started"),
      provider: "codex",
      createdAt: now,
      threadId,
      turnId,
    });
    await waitForThread(
      harness.engine,
      (thread) => thread.session?.status === "running" && thread.session?.activeTurnId === turnId,
    );

    // Each delta lands well outside the pacing window of the one before.
    const emitDelta = async (eventId: string, delta: string) => {
      harness.advanceClock(1_000);
      harness.emit({
        type: "content.delta",
        eventId: asEventId(eventId),
        provider: "codex",
        createdAt: now,
        threadId,
        turnId,
        itemId,
        payload: { streamKind: "assistant_text", delta },
      });
      await harness.drain();
    };
    const messageOf = async () =>
      (await Effect.runPromise(harness.engine.getReadModel())).threads
        .get(threadId)
        ?.messages.find((m: ProviderRuntimeTestMessage) => m.id === messageId);

    await emitDelta("evt-paragraph-1", "First paragraph.\n\nSecond para");
    expect(await messageOf()).toMatchObject({ text: "First paragraph.\n\n", streaming: true });

    // An open code block holds the whole block until its closing fence lands.
    await emitDelta("evt-paragraph-2", "graph.\n\n```ts\nconst a = 1;\n\nconst b = 2;\n");
    expect((await messageOf())?.text).toBe("First paragraph.\n\nSecond paragraph.\n\n");

    await emitDelta("evt-paragraph-3", "```\n\nTail without newline");
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-paragraph-completed"),
      provider: "codex",
      createdAt: now,
      threadId,
      turnId,
      itemId,
      payload: { itemType: "assistant_message", status: "completed" },
    });
    const finalThread = await waitForThread(harness.engine, (thread) =>
      thread.messages.some(
        (message: ProviderRuntimeTestMessage) => message.id === messageId && !message.streaming,
      ),
    );
    expect(
      finalThread.messages.find((m: ProviderRuntimeTestMessage) => m.id === messageId)?.text,
    ).toBe(
      "First paragraph.\n\nSecond paragraph.\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nTail without newline",
    );
  });

  it("holds paragraphs that finish inside the pacing window and lands them together", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    const threadId = asThreadId("thread-1");
    const turnId = asTurnId("turn-paced");
    const itemId = asItemId("item-paced");

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-paced-started"),
      provider: "codex",
      createdAt: now,
      threadId,
      turnId,
    });
    await waitForThread(
      harness.engine,
      (thread) => thread.session?.status === "running" && thread.session?.activeTurnId === turnId,
    );
    let clockMs = 0;
    const emitDelta = async (eventId: string, delta: string, offsetMs: number) => {
      harness.advanceClock(offsetMs - clockMs);
      clockMs = offsetMs;
      harness.emit({
        type: "content.delta",
        eventId: asEventId(eventId),
        provider: "codex",
        createdAt: now,
        threadId,
        turnId,
        itemId,
        payload: { streamKind: "assistant_text", delta },
      });
      await harness.drain();
    };
    const messageText = async () =>
      (await Effect.runPromise(harness.engine.getReadModel())).threads
        .get(threadId)
        ?.messages.find((m: ProviderRuntimeTestMessage) => m.id === `assistant:${itemId}`)?.text;

    await emitDelta("evt-paced-1", "One.\n\n", 0);
    await emitDelta("evt-paced-2", "Two.\n\n", 100);
    await emitDelta("evt-paced-3", "Three.\n\n", 200);
    expect(await messageText()).toBe("One.\n\n");

    await emitDelta("evt-paced-4", "Four.\n\n", 500);
    expect(await messageText()).toBe("One.\n\nTwo.\n\nThree.\n\nFour.\n\n");
  });

  it("spills oversized buffered deltas and still finalizes full assistant text", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    const oversizedText = "x".repeat(40_000);

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-buffer-spill"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffer-spill"),
    });
    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-buffer-spill",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-buffer-spill"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffer-spill"),
      itemId: asItemId("item-buffer-spill"),
      payload: {
        streamKind: "assistant_text",
        delta: oversizedText,
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed-buffer-spill"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffer-spill"),
      itemId: asItemId("item-buffer-spill"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-buffer-spill" && !message.streaming,
      ),
    );
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-buffer-spill",
    );
    expect(message?.text.length).toBe(oversizedText.length);
    expect(message?.text).toBe(oversizedText);
    expect(message?.streaming).toBe(false);
  });

  it("does not duplicate assistant completion when item.completed is followed by turn.completed", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-for-complete-dedup"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-complete-dedup"),
    });

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-complete-dedup",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-for-complete-dedup"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-complete-dedup"),
      itemId: asItemId("item-complete-dedup"),
      payload: {
        streamKind: "assistant_text",
        delta: "done",
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed-for-complete-dedup"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-complete-dedup"),
      itemId: asItemId("item-complete-dedup"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });
    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-for-complete-dedup"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-complete-dedup"),
      payload: {
        state: "completed",
      },
    });

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "ready" &&
        thread.session?.activeTurnId === null &&
        thread.messages.some(
          (message: ProviderRuntimeTestMessage) =>
            message.id === "assistant:item-complete-dedup" && !message.streaming,
        ),
    );

    const events = await Effect.runPromise(
      Stream.runCollect(harness.engine.readEvents(0)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      ),
    );
    const completionEvents = events.filter((event) => {
      if (event.type !== "thread.message-sent") {
        return false;
      }
      return (
        event.payload.messageId === "assistant:item-complete-dedup" &&
        event.payload.streaming === false
      );
    });
    expect(completionEvents).toHaveLength(1);
  });

  it("maps canonical request events into approval activities with requestKind", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "request.opened",
      eventId: asEventId("evt-request-opened"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      requestId: ApprovalRequestId.makeUnsafe("req-open"),
      payload: {
        requestType: "command_execution_approval",
        detail: "pwd",
      },
    });

    harness.emit({
      type: "request.resolved",
      eventId: asEventId("evt-request-resolved"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      requestId: ApprovalRequestId.makeUnsafe("req-open"),
      payload: {
        requestType: "command_execution_approval",
        decision: "accept",
      },
    });

    await waitForThread(
      harness.engine,
      (entry) =>
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "approval.requested",
        ) &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "approval.resolved",
        ),
    );

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.get(ThreadId.makeUnsafe("thread-1"));
    expect(thread).toBeDefined();

    const requested = thread?.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-request-opened",
    );
    const requestedPayload =
      requested?.payload && typeof requested.payload === "object"
        ? (requested.payload as Record<string, unknown>)
        : undefined;
    expect(requestedPayload?.requestKind).toBe("command");
    expect(requestedPayload?.requestType).toBe("command_execution_approval");

    const resolved = thread?.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-request-resolved",
    );
    const resolvedPayload =
      resolved?.payload && typeof resolved.payload === "object"
        ? (resolved.payload as Record<string, unknown>)
        : undefined;
    expect(resolvedPayload?.requestKind).toBe("command");
    expect(resolvedPayload?.requestType).toBe("command_execution_approval");
  });

  it("maps runtime.error into errored session state", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "runtime.error",
      eventId: asEventId("evt-runtime-error"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-3"),
      payload: {
        message: "runtime exploded",
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.status === "error" &&
        entry.session?.activeTurnId === "turn-3" &&
        entry.session?.lastError === "runtime exploded",
    );
    expect(thread.session?.status).toBe("error");
    expect(thread.session?.lastError).toBe("runtime exploded");
  });

  it("records runtime.error activities from the typed payload message", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "runtime.error",
      eventId: asEventId("evt-runtime-error-activity"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-runtime-error-activity"),
      payload: {
        message: "runtime activity exploded",
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some((activity) => activity.id === "evt-runtime-error-activity"),
    );
    const activity = thread.activities.find(
      (entry: ProviderRuntimeTestActivity) => entry.id === "evt-runtime-error-activity",
    );
    const activityPayload =
      activity?.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : undefined;

    expect(activity?.kind).toBe("runtime.error");
    expect(activityPayload?.message).toBe("runtime activity exploded");
  });

  it("keeps the session running when a runtime.warning arrives during an active turn", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-warning-turn-started"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-warning"),
      payload: {},
    });

    harness.emit({
      type: "runtime.warning",
      eventId: asEventId("evt-warning-runtime"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-warning"),
      payload: {
        message: "Reconnecting... 2/5",
        detail: {
          willRetry: true,
        },
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.status === "running" &&
        entry.session?.activeTurnId === "turn-warning" &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) =>
            activity.id === "evt-warning-runtime" && activity.kind === "runtime.warning",
        ),
    );
    expect(thread.session?.status).toBe("running");
    expect(thread.session?.activeTurnId).toBe("turn-warning");
    expect(thread.session?.lastError).toBeNull();
  });

  it("maps session/thread lifecycle and item.started into session/activity projections", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "session.started",
      eventId: asEventId("evt-session-started"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      message: "session started",
    });
    harness.emit({
      type: "thread.started",
      eventId: asEventId("evt-thread-started"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
    });
    harness.emit({
      type: "item.started",
      eventId: asEventId("evt-tool-started"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-9"),
      payload: {
        itemType: "command_execution",
        status: "in_progress",
        title: "Read file",
        detail: "/tmp/file.ts",
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.status === "ready" &&
        entry.session?.activeTurnId === null &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "tool.started",
        ),
    );

    expect(thread.session?.status).toBe("ready");
    expect(
      thread.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.kind === "tool.started",
      ),
    ).toBe(true);
  });

  it("mirrors a provider title only while the thread still has the default title", async () => {
    const harness = await createHarness({ threadTitle: DEFAULT_THREAD_TITLE });
    const now = new Date().toISOString();

    harness.emit({
      type: "thread.metadata.updated",
      eventId: asEventId("evt-thread-metadata-default"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        name: "Renamed by provider",
        metadata: { source: "provider" },
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) => entry.title === "Renamed by provider",
    );
    expect(thread.title).toBe("Renamed by provider");
  });

  it("does not let a provider title overwrite a title the thread already has", async () => {
    const harness = await createHarness({ threadTitle: "User-set title" });
    const now = new Date().toISOString();

    harness.emit({
      type: "thread.metadata.updated",
      eventId: asEventId("evt-thread-metadata-real"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        name: "Renamed by provider",
        metadata: { source: "provider" },
      },
    });

    await harness.drain();
    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    expect(readModel.threads.get(asThreadId("thread-1"))?.title).toBe("User-set title");
  });

  it("consumes P1 runtime events into thread metadata, diff checkpoints, and activities", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "thread.metadata.updated",
      eventId: asEventId("evt-thread-metadata-updated"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        name: "Renamed by provider",
        metadata: { source: "provider" },
      },
    });

    harness.emit({
      type: "turn.plan.updated",
      eventId: asEventId("evt-turn-plan-updated"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-p1"),
      payload: {
        explanation: "Working through the plan",
        plan: [
          { step: "Inspect files", status: "completed" },
          { step: "Apply patch", status: "in_progress" },
        ],
      },
    });

    harness.emit({
      type: "item.updated",
      eventId: asEventId("evt-item-updated"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-p1"),
      itemId: asItemId("item-p1-tool"),
      payload: {
        itemType: "command_execution",
        status: "in_progress",
        title: "Run tests",
        detail: "bun test",
        data: { pid: 123 },
      },
    });

    harness.emit({
      type: "runtime.warning",
      eventId: asEventId("evt-runtime-warning"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-p1"),
      payload: {
        message: "Provider got slow",
        detail: { latencyMs: 1500 },
      },
    });

    harness.emit({
      type: "turn.diff.updated",
      eventId: asEventId("evt-turn-diff-updated"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-p1"),
      itemId: asItemId("item-p1-assistant"),
      payload: {
        unifiedDiff: "diff --git a/file.txt b/file.txt\n+hello\n",
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.title === "Thread" &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "turn.plan.updated",
        ) &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "tool.updated",
        ) &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "runtime.warning",
        ) &&
        entry.checkpoints.some(
          (checkpoint: ProviderRuntimeTestCheckpoint) => checkpoint.turnId === "turn-p1",
        ),
    );

    expect(thread.title).toBe("Thread");

    const planActivity = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-turn-plan-updated",
    );
    const planPayload =
      planActivity?.payload && typeof planActivity.payload === "object"
        ? (planActivity.payload as Record<string, unknown>)
        : undefined;
    expect(planActivity?.kind).toBe("turn.plan.updated");
    expect(Array.isArray(planPayload?.plan)).toBe(true);

    const toolUpdate = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-item-updated",
    );
    const toolUpdatePayload =
      toolUpdate?.payload && typeof toolUpdate.payload === "object"
        ? (toolUpdate.payload as Record<string, unknown>)
        : undefined;
    expect(toolUpdate?.kind).toBe("tool.updated");
    expect(toolUpdatePayload?.itemType).toBe("command_execution");
    expect(toolUpdatePayload?.status).toBe("in_progress");

    const warning = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-runtime-warning",
    );
    const warningPayload =
      warning?.payload && typeof warning.payload === "object"
        ? (warning.payload as Record<string, unknown>)
        : undefined;
    expect(warning?.kind).toBe("runtime.warning");
    expect(warningPayload?.message).toBe("Provider got slow");

    const checkpoint = thread.checkpoints.find(
      (entry: ProviderRuntimeTestCheckpoint) => entry.turnId === "turn-p1",
    );
    expect(checkpoint?.status).toBe("missing");
    expect(checkpoint?.assistantMessageId).toBe("assistant:item-p1-assistant");
    expect(checkpoint?.checkpointRef).toBe("provider-diff:evt-turn-diff-updated");
  });

  it("projects context window updates into normalized thread activities", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "thread.token-usage.updated",
      eventId: asEventId("evt-thread-token-usage-updated"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        usage: {
          usedTokens: 1075,
          totalProcessedTokens: 10_200,
          maxTokens: 128_000,
          inputTokens: 1000,
          cachedInputTokens: 500,
          outputTokens: 50,
          reasoningOutputTokens: 25,
          lastUsedTokens: 1075,
          lastInputTokens: 1000,
          lastCachedInputTokens: 500,
          lastOutputTokens: 50,
          lastReasoningOutputTokens: 25,
          compactsAutomatically: true,
        },
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.kind === "context-window.updated",
      ),
    );

    const usageActivity = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.kind === "context-window.updated",
    );
    expect(usageActivity).toBeDefined();
    expect(usageActivity?.payload).toMatchObject({
      usedTokens: 1075,
      totalProcessedTokens: 10_200,
      maxTokens: 128_000,
      inputTokens: 1000,
      cachedInputTokens: 500,
      outputTokens: 50,
      reasoningOutputTokens: 25,
      lastUsedTokens: 1075,
      compactsAutomatically: true,
    });
  });

  it("projects Codex camelCase token usage payloads into normalized thread activities", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "thread.token-usage.updated",
      eventId: asEventId("evt-thread-token-usage-updated-camel"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        usage: {
          usedTokens: 126,
          totalProcessedTokens: 11_839,
          maxTokens: 258_400,
          inputTokens: 120,
          cachedInputTokens: 0,
          outputTokens: 6,
          reasoningOutputTokens: 0,
          lastUsedTokens: 126,
          lastInputTokens: 120,
          lastCachedInputTokens: 0,
          lastOutputTokens: 6,
          lastReasoningOutputTokens: 0,
          compactsAutomatically: true,
        },
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.kind === "context-window.updated",
      ),
    );

    const usageActivity = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.kind === "context-window.updated",
    );
    expect(usageActivity?.payload).toMatchObject({
      usedTokens: 126,
      totalProcessedTokens: 11_839,
      maxTokens: 258_400,
      inputTokens: 120,
      cachedInputTokens: 0,
      outputTokens: 6,
      reasoningOutputTokens: 0,
      lastUsedTokens: 126,
      lastInputTokens: 120,
      lastOutputTokens: 6,
      compactsAutomatically: true,
    });
  });

  it("projects Claude usage snapshots with context window into normalized thread activities", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "thread.token-usage.updated",
      eventId: asEventId("evt-thread-token-usage-updated-claude-window"),
      provider: "claudeAgent",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        usage: {
          usedTokens: 31_251,
          lastUsedTokens: 31_251,
          maxTokens: 200_000,
          toolUses: 25,
          durationMs: 43_567,
        },
      },
      raw: {
        source: "claude.sdk.message",
        method: "claude/result/success",
        payload: {},
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.kind === "context-window.updated",
      ),
    );

    const usageActivity = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.kind === "context-window.updated",
    );
    expect(usageActivity?.payload).toMatchObject({
      usedTokens: 31_251,
      lastUsedTokens: 31_251,
      maxTokens: 200_000,
      toolUses: 25,
      durationMs: 43_567,
    });
  });

  it("projects compacted thread state into context compaction activities", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "thread.state.changed",
      eventId: asEventId("evt-thread-compacted"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-1"),
      payload: {
        state: "compacted",
        detail: { source: "provider" },
      },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.kind === "context-compaction",
      ),
    );

    const activity = thread.activities.find(
      (candidate: ProviderRuntimeTestActivity) => candidate.kind === "context-compaction",
    );
    expect(activity?.summary).toBe("Context compacted");
    expect(activity?.tone).toBe("info");
  });

  it("projects Codex task lifecycle chunks into thread activities", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "task.started",
      eventId: asEventId("evt-task-started"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-task-1"),
      payload: {
        taskId: "turn-task-1",
        taskType: "plan",
      },
    });

    harness.emit({
      type: "task.progress",
      eventId: asEventId("evt-task-progress"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-task-1"),
      payload: {
        taskId: "turn-task-1",
        description: "Comparing the desktop rollout chunks to the app-server stream.",
        summary: "Code reviewer is validating the desktop rollout chunks.",
      },
    });

    harness.emit({
      type: "task.completed",
      eventId: asEventId("evt-task-completed"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-task-1"),
      payload: {
        taskId: "turn-task-1",
        status: "completed",
        summary: "<proposed_plan>\n# Plan title\n</proposed_plan>",
      },
    });
    harness.emit({
      type: "turn.proposed.completed",
      eventId: asEventId("evt-task-proposed-plan-completed"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-task-1"),
      payload: {
        planMarkdown: "# Plan title",
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "task.completed",
        ) &&
        entry.proposedPlans.some(
          (proposedPlan: ProviderRuntimeTestProposedPlan) =>
            proposedPlan.id === "plan:thread-1:turn:turn-task-1",
        ),
    );

    const started = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-task-started",
    );
    const progress = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-task-progress",
    );
    const completed = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-task-completed",
    );

    const progressPayload =
      progress?.payload && typeof progress.payload === "object"
        ? (progress.payload as Record<string, unknown>)
        : undefined;
    const completedPayload =
      completed?.payload && typeof completed.payload === "object"
        ? (completed.payload as Record<string, unknown>)
        : undefined;

    expect(started?.kind).toBe("task.started");
    expect(started?.summary).toBe("Plan task started");
    expect(progress?.kind).toBe("task.progress");
    expect(progressPayload?.detail).toBe("Code reviewer is validating the desktop rollout chunks.");
    expect(progressPayload?.summary).toBe(
      "Code reviewer is validating the desktop rollout chunks.",
    );
    expect(completed?.kind).toBe("task.completed");
    expect(completedPayload?.detail).toBe("<proposed_plan>\n# Plan title\n</proposed_plan>");
    expect(
      thread.proposedPlans.find(
        (entry: ProviderRuntimeTestProposedPlan) => entry.id === "plan:thread-1:turn:turn-task-1",
      )?.planMarkdown,
    ).toBe("# Plan title");
  });

  it("projects structured user input request and resolution as thread activities", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "user-input.requested",
      eventId: asEventId("evt-user-input-requested"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-user-input"),
      requestId: ApprovalRequestId.makeUnsafe("req-user-input-1"),
      payload: {
        questions: [
          {
            id: "sandbox_mode",
            header: "Sandbox",
            question: "Which mode should be used?",
            options: [
              {
                label: "workspace-write",
                description: "Allow workspace writes only",
              },
            ],
          },
        ],
      },
    });

    harness.emit({
      type: "user-input.resolved",
      eventId: asEventId("evt-user-input-resolved"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-user-input"),
      requestId: ApprovalRequestId.makeUnsafe("req-user-input-1"),
      payload: {
        answers: {
          sandbox_mode: "workspace-write",
        },
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "user-input.requested",
        ) &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "user-input.resolved",
        ),
    );

    const requested = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-user-input-requested",
    );
    expect(requested?.kind).toBe("user-input.requested");

    const resolved = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-user-input-resolved",
    );
    const resolvedPayload =
      resolved?.payload && typeof resolved.payload === "object"
        ? (resolved.payload as Record<string, unknown>)
        : undefined;
    expect(resolved?.kind).toBe("user-input.resolved");
    expect(resolvedPayload?.answers).toEqual({
      sandbox_mode: "workspace-write",
    });
  });

  it("continues processing runtime events after a single event handler failure", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-invalid-delta"),
      provider: "codex",
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-invalid"),
      itemId: asItemId("item-invalid"),
      payload: {
        streamKind: "assistant_text",
        delta: undefined,
      },
    } as unknown as ProviderRuntimeEvent);

    harness.emit({
      type: "runtime.error",
      eventId: asEventId("evt-runtime-error-after-failure"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-after-failure"),
      payload: {
        message: "runtime still processed",
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.status === "error" &&
        entry.session?.activeTurnId === "turn-after-failure" &&
        entry.session?.lastError === "runtime still processed",
    );
    expect(thread.session?.status).toBe("error");
    expect(thread.session?.lastError).toBe("runtime still processed");
  });

  describe("thinking blocks", () => {
    const threadId = asThreadId("thread-1");
    const turnId = asTurnId("turn-1");
    const at = "2026-04-08T00:00:00.000Z";
    const reasoningActivities = async (harness: { engine: OrchestrationEngineShape }) =>
      (
        (await Effect.runPromise(harness.engine.getReadModel())).threads.get(threadId)
          ?.activities ?? []
      ).filter((activity: ProviderRuntimeTestActivity) => activity.kind === "reasoning.block");

    const emitDelta = (
      harness: { emit: (event: LegacyProviderRuntimeEvent) => void },
      eventId: string,
      delta: string,
      extra: {
        streamKind?: string;
        itemId?: string;
        summaryIndex?: number;
        turnId?: TurnId | undefined;
      } = {},
    ) =>
      harness.emit({
        type: "content.delta",
        eventId: asEventId(eventId),
        provider: "codex",
        createdAt: at,
        threadId,
        ...("turnId" in extra ? (extra.turnId ? { turnId: extra.turnId } : {}) : { turnId }),
        ...(extra.itemId ? { itemId: asItemId(extra.itemId) } : {}),
        payload: {
          streamKind: extra.streamKind ?? "reasoning_summary_text",
          delta,
          ...(extra.summaryIndex !== undefined ? { summaryIndex: extra.summaryIndex } : {}),
        },
      });
    const emitTurnCompleted = (harness: { emit: (event: LegacyProviderRuntimeEvent) => void }) =>
      harness.emit({
        type: "turn.completed",
        eventId: asEventId("evt-turn-completed"),
        provider: "codex",
        createdAt: at,
        threadId,
        turnId,
        status: "completed",
      });

    it("takes the later summary parts from item.completed when only the first streamed", async () => {
      const harness = await createHarness();
      harness.emit({
        type: "turn.started",
        eventId: asEventId("evt-turn-started"),
        provider: "codex",
        createdAt: at,
        threadId,
        turnId,
      });
      emitDelta(harness, "evt-think-1", "First part.", { itemId: "reasoning-1", summaryIndex: 0 });
      await harness.drain();
      harness.emit({
        type: "item.completed",
        eventId: asEventId("evt-reasoning-done"),
        provider: "codex",
        createdAt: at,
        threadId,
        turnId,
        itemId: asItemId("reasoning-1"),
        payload: {
          itemType: "reasoning",
          status: "completed",
          detail: "First part.\n\nSecond part.",
        },
      } as never);
      await harness.drain();
      const settled = await reasoningActivities(harness);
      expect(settled).toHaveLength(1);
      expect(payloadOf(settled[0])).toMatchObject({
        detail: "First part.\n\nSecond part.",
        status: "completed",
      });
    });

    const emitTurnStarted = (harness: { emit: (event: LegacyProviderRuntimeEvent) => void }) =>
      harness.emit({
        type: "turn.started",
        eventId: asEventId("evt-turn-started"),
        provider: "claudeAgent",
        createdAt: at,
        threadId,
        turnId,
      });
    const emitReasoningCompleted = (
      harness: { emit: (event: LegacyProviderRuntimeEvent) => void },
      eventId: string,
      extra: { detail?: string; data?: unknown } = {},
    ) =>
      harness.emit({
        type: "item.completed",
        eventId: asEventId(eventId),
        provider: "claudeAgent",
        createdAt: at,
        threadId,
        turnId,
        itemId: asItemId("thinking-1"),
        payload: { itemType: "reasoning", status: "completed", ...extra },
      } as never);

    it("marks a thought promoted to assistant text under its own id", async () => {
      const harness = await createHarness();
      emitTurnStarted(harness);
      emitDelta(harness, "evt-think-1", "Checking the tests now.", { itemId: "thinking-1" });
      emitReasoningCompleted(harness, "evt-think-done");
      await harness.drain();
      const [thought] = await reasoningActivities(harness);
      expect(payloadOf(thought)?.status).toBe("completed");

      emitReasoningCompleted(harness, "evt-think-promoted", {
        detail: "Checking the tests now.",
        data: { promotedToAssistantText: true },
      });
      await harness.drain();
      const settled = await reasoningActivities(harness);
      expect(settled).toHaveLength(1);
      expect(settled[0]?.id).toBe(thought?.id);
      expect(payloadOf(settled[0])).toMatchObject({
        status: "promoted",
        detail: "Checking the tests now.",
      });
    });

    it("closes a block still open when its item is promoted", async () => {
      const harness = await createHarness();
      emitTurnStarted(harness);
      emitDelta(harness, "evt-think-1", "Checking", { itemId: "thinking-1" });
      emitDelta(harness, "evt-think-2", " the tests now.", { itemId: "thinking-1" });
      emitReasoningCompleted(harness, "evt-think-promoted", {
        detail: "Checking the tests now.",
        data: { promotedToAssistantText: true },
      });
      await harness.drain();
      const settled = await reasoningActivities(harness);
      expect(settled).toHaveLength(1);
      expect(payloadOf(settled[0])).toMatchObject({
        status: "promoted",
        detail: "Checking the tests now.",
      });
    });

    it("marks a thought that only arrived whole when it is promoted", async () => {
      const harness = await createHarness();
      emitTurnStarted(harness);
      emitReasoningCompleted(harness, "evt-think-whole", { detail: "From the snapshot" });
      await harness.drain();
      const [thought] = await reasoningActivities(harness);
      emitReasoningCompleted(harness, "evt-think-promoted", {
        detail: "From the snapshot",
        data: { promotedToAssistantText: true },
      });
      await harness.drain();
      const settled = await reasoningActivities(harness);
      expect(settled).toHaveLength(1);
      expect(settled[0]?.id).toBe(thought?.id);
      expect(payloadOf(settled[0])?.status).toBe("promoted");
    });

    it("does not create a thought when an item with no thought yet is promoted", async () => {
      const harness = await createHarness();
      emitTurnStarted(harness);
      emitReasoningCompleted(harness, "evt-think-promoted", {
        detail: "Never seen",
        data: { promotedToAssistantText: true },
      });
      await harness.drain();
      expect(await reasoningActivities(harness)).toEqual([]);
    });

    it("streams one activity per block in streaming and buffered mode and closes it at turn end", async () => {
      for (const enableAssistantStreaming of [true, false]) {
        const harness = await createHarness({ serverSettings: { enableAssistantStreaming } });
        harness.emit({
          type: "turn.started",
          eventId: asEventId("evt-turn-started"),
          provider: "codex",
          createdAt: at,
          threadId,
          turnId,
        });
        emitDelta(harness, "evt-think-1", "Weighing the options");
        await harness.drain();
        const [live] = await reasoningActivities(harness);
        expect(live).toMatchObject({ tone: "thinking", summary: "Thinking", turnId: "turn-1" });
        expect(payloadOf(live)).toMatchObject({
          detail: "Weighing the options",
          status: "inProgress",
          stream: "summary",
        });

        harness.advanceClock(1_000);
        emitDelta(harness, "evt-think-2", " and picking one.");
        await harness.drain();
        expect(await reasoningActivities(harness)).toHaveLength(1);

        emitTurnCompleted(harness);
        await harness.drain();
        const settled = await reasoningActivities(harness);
        expect(settled).toHaveLength(1);
        expect(settled[0]?.id).toBe(live?.id);
        expect(settled[0]?.summary).toBe("Thought");
        expect(payloadOf(settled[0])).toMatchObject({
          detail: "Weighing the options and picking one.",
          status: "completed",
        });
        const messages = (await Effect.runPromise(harness.engine.getReadModel())).threads.get(
          threadId,
        )?.messages;
        expect(messages).toEqual([]);
        await Effect.runPromise(Scope.close(scope!, Exit.void));
        scope = null;
        await runtime!.dispose();
        runtime = null;
      }
    });

    it("spaces out rewrites of the growing text but never loses the tail", async () => {
      const harness = await createHarness();
      const appended: number[] = [];
      emitDelta(harness, "evt-first", "x".repeat(400));
      await harness.drain();
      appended.push(payloadOf((await reasoningActivities(harness))[0])!.detail.length);
      harness.advanceClock(1_000);
      emitDelta(harness, "evt-too-small", "y".repeat(10));
      await harness.drain();
      appended.push(payloadOf((await reasoningActivities(harness))[0])!.detail.length);
      expect(appended).toEqual([400, 400]);
      emitDelta(harness, "evt-too-soon", "z".repeat(200));
      await harness.drain();
      harness.advanceClock(100);
      emitDelta(harness, "evt-still-too-soon", "z".repeat(1));
      await harness.drain();
      expect(payloadOf((await reasoningActivities(harness))[0])?.detail.length).toBe(610);
      emitTurnCompleted(harness);
      await harness.drain();
      expect(payloadOf((await reasoningActivities(harness))[0])?.detail.length).toBe(611);
    });

    it("keeps summary and raw text in separate blocks and separates summary parts", async () => {
      const harness = await createHarness();
      emitDelta(harness, "evt-part-0", "First part.", { itemId: "rs-1", summaryIndex: 0 });
      emitDelta(harness, "evt-part-1", "Second part.", { itemId: "rs-1", summaryIndex: 1 });
      emitDelta(harness, "evt-raw", "raw chain", {
        itemId: "rs-1",
        streamKind: "reasoning_text",
      });
      emitDelta(harness, "evt-summary-again", "Third part.", { itemId: "rs-1", summaryIndex: 2 });
      emitTurnCompleted(harness);
      await harness.drain();
      const blocks = await reasoningActivities(harness);
      expect(blocks.map((block) => payloadOf(block)?.detail)).toEqual([
        "First part.\n\nSecond part.\n\nThird part.",
        "raw chain",
      ]);
      expect(blocks.map((block) => payloadOf(block)?.stream)).toEqual(["summary", "raw"]);
    });

    it("closes the open block before the assistant text or tool call that follows it", async () => {
      const harness = await createHarness();
      emitDelta(harness, "evt-before-text", "Before the answer");
      emitDelta(harness, "evt-text", "The answer", { streamKind: "assistant_text", itemId: "m-1" });
      await harness.drain();
      expect(payloadOf((await reasoningActivities(harness))[0])?.status).toBe("completed");

      emitDelta(harness, "evt-before-tool", "Before the tool");
      harness.emit({
        type: "item.started",
        eventId: asEventId("evt-tool-started"),
        provider: "codex",
        createdAt: at,
        threadId,
        turnId,
        itemId: asItemId("tool-1"),
        payload: { itemType: "command_execution", title: "Ran command" },
      });
      await harness.drain();
      const blocks = await reasoningActivities(harness);
      expect(blocks.map((block) => payloadOf(block)?.status)).toEqual(["completed", "completed"]);
    });

    it("closes the block when the session exits or the turn is interrupted", async () => {
      const harness = await createHarness();
      emitDelta(harness, "evt-aborted-block", "Interrupted thought");
      harness.emit({
        type: "turn.aborted",
        eventId: asEventId("evt-turn-aborted"),
        provider: "codex",
        createdAt: at,
        threadId,
        turnId,
        payload: { reason: "interrupted" },
      });
      await harness.drain();
      expect(payloadOf((await reasoningActivities(harness))[0])?.status).toBe("completed");

      emitDelta(harness, "evt-exit-block", "Cut off thought");
      harness.emit({
        type: "session.exited",
        eventId: asEventId("evt-session-exited"),
        provider: "codex",
        createdAt: at,
        threadId,
        payload: { reason: "exit" },
      });
      await harness.drain();
      const blocks = await reasoningActivities(harness);
      expect(blocks.map((block) => payloadOf(block)?.status)).toEqual(["completed", "completed"]);
    });

    it("closes a block left open by an earlier turn when the next one starts", async () => {
      const harness = await createHarness();
      emitDelta(harness, "evt-orphan", "Orphaned thought");
      harness.emit({
        type: "turn.started",
        eventId: asEventId("evt-next-turn"),
        provider: "codex",
        createdAt: at,
        threadId,
        turnId: asTurnId("turn-2"),
      });
      await harness.drain();
      expect(payloadOf((await reasoningActivities(harness))[0])?.status).toBe("completed");
    });

    it("drops blank and turnless thinking and fills in a block from its completed item", async () => {
      const harness = await createHarness();
      emitDelta(harness, "evt-blank", "   \n");
      emitDelta(harness, "evt-turnless", "No turn", { turnId: undefined });
      await harness.drain();
      expect(await reasoningActivities(harness)).toEqual([]);

      harness.emit({
        type: "item.completed",
        eventId: asEventId("evt-item-backfill"),
        provider: "codex",
        createdAt: at,
        threadId,
        turnId,
        itemId: asItemId("rs-backfill"),
        payload: { itemType: "reasoning", detail: "From the snapshot" },
      });
      await harness.drain();
      expect(payloadOf((await reasoningActivities(harness))[0])).toMatchObject({
        detail: "From the snapshot",
        status: "completed",
      });
    });

    it("does not duplicate a streamed block when its item completes with the same text", async () => {
      const harness = await createHarness();
      emitDelta(harness, "evt-streamed", "Streamed text", { itemId: "rs-1" });
      const completeItem = (eventId: string) =>
        harness.emit({
          type: "item.completed",
          eventId: asEventId(eventId),
          provider: "codex",
          createdAt: at,
          threadId,
          turnId,
          itemId: asItemId("rs-1"),
          payload: { itemType: "reasoning", detail: "Streamed text" },
        });
      completeItem("evt-item-complete");
      completeItem("evt-item-complete-again");
      await harness.drain();
      const blocks = await reasoningActivities(harness);
      expect(blocks).toHaveLength(1);
      expect(payloadOf(blocks[0])).toMatchObject({ detail: "Streamed text", status: "completed" });
    });

    it("continues an oversized block in a new activity", async () => {
      const harness = await createHarness();
      emitDelta(harness, "evt-big", "x".repeat(16_000), { itemId: "rs-big" });
      emitDelta(harness, "evt-after-big", "more", { itemId: "rs-big" });
      emitTurnCompleted(harness);
      await harness.drain();
      const blocks = await reasoningActivities(harness);
      expect(blocks.map((block) => payloadOf(block)?.detail.length).toSorted()).toEqual([
        16_000, 4,
      ]);
      expect(blocks.map((block) => payloadOf(block)?.status)).toEqual(["completed", "completed"]);
    });

    const emitItemCompleted = (
      harness: { emit: (event: LegacyProviderRuntimeEvent) => void },
      eventId: string,
      itemId: string,
      detail: string,
    ) =>
      harness.emit({
        type: "item.completed",
        eventId: asEventId(eventId),
        provider: "codex",
        createdAt: at,
        threadId,
        turnId,
        itemId: asItemId(itemId),
        payload: { itemType: "reasoning", status: "completed", detail },
      });
    const emitChildToolStarted = (harness: { emit: (event: LegacyProviderRuntimeEvent) => void }) =>
      harness.emit({
        type: "item.started",
        eventId: asEventId("evt-child-tool"),
        provider: "codex",
        createdAt: at,
        threadId,
        turnId,
        itemId: asItemId("child-tool"),
        payload: { itemType: "command_execution", title: "Ran command" },
      });
    const details = async (harness: { engine: OrchestrationEngineShape }) =>
      (await reasoningActivities(harness)).map((block) => payloadOf(block)?.detail);

    it("does not repeat a filled block's text when the item completes with all of it", async () => {
      const harness = await createHarness();
      const full = "x".repeat(16_000);
      emitDelta(harness, "evt-big", full, { itemId: "rs-big" });
      emitDelta(harness, "evt-after-big", "more", { itemId: "rs-big" });
      emitItemCompleted(harness, "evt-big-done", "rs-big", `${full}more`);
      emitItemCompleted(harness, "evt-big-done-again", "rs-big", `${full}more`);
      await harness.drain();
      expect((await details(harness)).map((detail) => detail?.length).toSorted()).toEqual([
        16_000, 4,
      ]);
    });

    it("adds only the tail when a filled block closed and no later delta came", async () => {
      const harness = await createHarness();
      const full = "x".repeat(16_000);
      emitDelta(harness, "evt-big", full, { itemId: "rs-big" });
      emitItemCompleted(harness, "evt-big-done", "rs-big", `${full}\n\ntail`);
      emitItemCompleted(harness, "evt-big-done-again", "rs-big", `${full}\n\ntail`);
      await harness.drain();
      expect((await details(harness)).map((detail) => detail?.length).toSorted()).toEqual([
        16_000, 4,
      ]);
    });

    it("skips the backfill when the final text does not begin with the filled block", async () => {
      const harness = await createHarness();
      emitDelta(harness, "evt-big", "x".repeat(16_000), { itemId: "rs-big" });
      emitDelta(harness, "evt-after-big", "more", { itemId: "rs-big" });
      emitItemCompleted(harness, "evt-big-done", "rs-big", "y".repeat(20_000));
      await harness.drain();
      expect((await details(harness)).map((detail) => detail?.length).toSorted()).toEqual([
        16_000, 4,
      ]);
    });

    it("grows one row when a child's step lands between an item's deltas", async () => {
      const harness = await createHarness();
      emitDelta(harness, "evt-a", "A", { itemId: "rs-1", summaryIndex: 0 });
      await harness.drain();
      const [opened] = await reasoningActivities(harness);
      emitChildToolStarted(harness);
      emitDelta(harness, "evt-b", "B", { itemId: "rs-1", summaryIndex: 1 });
      emitItemCompleted(harness, "evt-done", "rs-1", "A\n\nB");
      await harness.drain();
      const blocks = await reasoningActivities(harness);
      expect(blocks).toHaveLength(1);
      expect(blocks[0]?.id).toBe(opened?.id);
      expect(payloadOf(blocks[0])).toMatchObject({ detail: "A\n\nB", status: "completed" });
    });

    it("fills in a block that closed early when only item.completed has the rest", async () => {
      const harness = await createHarness();
      emitDelta(harness, "evt-a", "A", { itemId: "rs-1", summaryIndex: 0 });
      emitChildToolStarted(harness);
      emitItemCompleted(harness, "evt-done", "rs-1", "A\n\nB");
      emitItemCompleted(harness, "evt-done-again", "rs-1", "A\n\nB");
      await harness.drain();
      const blocks = await reasoningActivities(harness);
      expect(blocks).toHaveLength(1);
      expect(payloadOf(blocks[0])).toMatchObject({ detail: "A\n\nB", status: "completed" });
    });

    it("keeps itemless deltas around a tool call in separate rows", async () => {
      const harness = await createHarness();
      emitDelta(harness, "evt-a", "A");
      emitChildToolStarted(harness);
      emitDelta(harness, "evt-b", "B");
      emitTurnCompleted(harness);
      await harness.drain();
      expect(await details(harness)).toEqual(["A", "B"]);
    });

    const recordedCodexNotifications = (
      summary: ReadonlyArray<string>,
      deltas: ReadonlyArray<ProviderEvent>,
    ): ReadonlyArray<ProviderEvent> => [
      codexNotification("item/started", {
        item: { type: "reasoning", id: "rs_1", summary: [], content: [] },
      }),
      ...deltas,
      codexNotification("item/completed", {
        item: { type: "reasoning", id: "rs_1", summary, content: [] },
      }),
      codexNotification(
        "item/started",
        { item: { type: "commandExecution", id: "cmd_1", command: "ls", status: "inProgress" } },
        "cmd_1",
      ),
    ];
    const codexEventCounter = { value: 0 };
    function codexNotification(
      method: string,
      payload: Record<string, unknown>,
      itemId = "rs_1",
    ): ProviderEvent {
      codexEventCounter.value += 1;
      return {
        id: asEventId(`evt-codex-${codexEventCounter.value}`),
        kind: "notification",
        provider: "codex",
        threadId,
        // Rows at one timestamp sort by id, so each notification gets its own.
        createdAt: new Date(Date.parse(at) + codexEventCounter.value * 1_000).toISOString(),
        method,
        turnId,
        itemId: asItemId(itemId),
        payload: { threadId: "provider-thread", turnId: "turn-1", itemId, ...payload },
      };
    }
    const emitCodexNotifications = (
      harness: { emit: (event: LegacyProviderRuntimeEvent) => void },
      notifications: ReadonlyArray<ProviderEvent>,
    ) => {
      for (const notification of notifications) {
        for (const event of mapToRuntimeEvents(notification, threadId)) {
          harness.emit(event as unknown as LegacyProviderRuntimeEvent);
        }
      }
    };
    const threadActivities = async (harness: { engine: OrchestrationEngineShape }) =>
      (await Effect.runPromise(harness.engine.getReadModel())).threads.get(threadId)?.activities ??
      [];

    it("turns a recorded Codex reasoning sequence into one Thought before the tool", async () => {
      const harness = await createHarness();
      emitCodexNotifications(
        harness,
        recordedCodexNotifications(
          ["First part", "Second part"],
          [
            codexNotification("item/reasoning/summaryPartAdded", { summaryIndex: 0 }),
            codexNotification("item/reasoning/summaryTextDelta", {
              summaryIndex: 0,
              delta: "First",
            }),
            codexNotification("item/reasoning/summaryTextDelta", {
              summaryIndex: 0,
              delta: " part",
            }),
            codexNotification("item/reasoning/summaryPartAdded", { summaryIndex: 1 }),
            codexNotification("item/reasoning/summaryTextDelta", {
              summaryIndex: 1,
              delta: "Second part",
            }),
          ],
        ),
      );
      await harness.drain();
      const blocks = await reasoningActivities(harness);
      expect(blocks).toHaveLength(1);
      expect(blocks[0]?.summary).toBe("Thought");
      expect(payloadOf(blocks[0])).toMatchObject({
        detail: "First part\n\nSecond part",
        status: "completed",
        stream: "summary",
      });
      const kinds = (await threadActivities(harness)).map((activity) => activity.kind);
      expect(kinds.indexOf("reasoning.block")).toBeGreaterThanOrEqual(0);
      expect(kinds.indexOf("reasoning.block")).toBeLessThan(kinds.indexOf("tool.started"));
    });

    it("adds no thinking row for a recorded Codex reasoning item with no summary", async () => {
      const harness = await createHarness();
      emitCodexNotifications(harness, recordedCodexNotifications([], []));
      await harness.drain();
      expect(await reasoningActivities(harness)).toEqual([]);
      const kinds = (await threadActivities(harness)).map((activity) => activity.kind);
      expect(kinds).toContain("tool.started");
    });
  });
});

describe("splitBufferedAssistantText", () => {
  it("keeps a partial trailing line buffered", () => {
    expect(splitBufferedAssistantText("one\n\ntwo")).toEqual({ ready: "one\n\n", rest: "two" });
    expect(splitBufferedAssistantText("one\ntwo")).toEqual({ ready: "", rest: "one\ntwo" });
  });

  it("does not split inside an open fence and delivers the block at its closing fence", () => {
    const open = "intro\n\n```\ncode\n\nmore\n";
    expect(splitBufferedAssistantText(open)).toEqual({
      ready: "intro\n\n",
      rest: "```\ncode\n\nmore\n",
    });
    expect(splitBufferedAssistantText(`${open}\`\`\`\nafter`)).toEqual({
      ready: `${open}\`\`\`\n`,
      rest: "after",
    });
  });

  it("does not treat a fence with an info string as a closing fence", () => {
    const text = "```\n```javascript\nstill code\n\nmore\n";
    expect(splitBufferedAssistantText(text)).toEqual({ ready: "", rest: text });
  });

  it("treats a fence indented four or more spaces as code, not a closing fence", () => {
    const text = "```\n    ```\n\nstill code\n";
    expect(splitBufferedAssistantText(text)).toEqual({ ready: "", rest: text });
    expect(splitBufferedAssistantText("```\n   ```\nafter")).toEqual({
      ready: "```\n   ```\n",
      rest: "after",
    });
  });

  it("keeps a fence nested under a list item open across its blank lines", () => {
    const text = "- step\n\n    ```ts\n    a\n\n    b\n    ```\n\nafter\n";
    expect(splitBufferedAssistantText(text)).toEqual({
      ready: "- step\n\n    ```ts\n    a\n\n    b\n    ```\n\n",
      rest: "after\n",
    });
  });

  it("does not treat a no-break-space line as blank", () => {
    expect(splitBufferedAssistantText("para\n \ncont\n\nnext")).toEqual({
      ready: "para\n \ncont\n\n",
      rest: "next",
    });
  });

  it("treats CRLF blank lines as boundaries", () => {
    expect(splitBufferedAssistantText("one\r\n\r\ntwo")).toEqual({
      ready: "one\r\n\r\n",
      rest: "two",
    });
  });

  it("only closes a fence with the same marker of equal or greater length", () => {
    const text = "````\n```\nstill code\n\n````\n\nout\n";
    expect(splitBufferedAssistantText(text)).toEqual({
      ready: "````\n```\nstill code\n\n````\n\n",
      rest: "out\n",
    });
    expect(splitBufferedAssistantText("~~~\n```\n\nx\n")).toEqual({
      ready: "",
      rest: "~~~\n```\n\nx\n",
    });
  });

  it("delivers tight list items one at a time", () => {
    expect(splitBufferedAssistantText("## Steps\n\n- one\n- two\n- thr")).toEqual({
      ready: "## Steps\n\n- one\n- two\n",
      rest: "- thr",
    });
    expect(splitBufferedAssistantText("1. one\n2. two\n   more\n3. t")).toEqual({
      ready: "1. one\n2. two\n   more\n",
      rest: "3. t",
    });
  });

  it("keeps a partial list marker and list-like code buffered", () => {
    expect(splitBufferedAssistantText("intro\n-")).toEqual({ ready: "", rest: "intro\n-" });
    expect(splitBufferedAssistantText("intro\n1.")).toEqual({ ready: "", rest: "intro\n1." });
    expect(splitBufferedAssistantText("intro\n- ")).toEqual({ ready: "", rest: "intro\n- " });
    expect(splitBufferedAssistantText("- one\n")).toEqual({ ready: "", rest: "- one\n" });
    expect(splitBufferedAssistantText("```\n- one\n- two\n")).toEqual({
      ready: "",
      rest: "```\n- one\n- two\n",
    });
  });

  it("holds a heading until the block under it is done", () => {
    expect(splitBufferedAssistantText("intro\n\n## Setup\n\nInstall it")).toEqual({
      ready: "intro\n\n",
      rest: "## Setup\n\nInstall it",
    });
    expect(
      splitBufferedAssistantText("intro\n\n# Plan\n\n## Setup\n\nInstall it.\n\nNext"),
    ).toEqual({
      ready: "intro\n\n# Plan\n\n## Setup\n\nInstall it.\n\n",
      rest: "Next",
    });
  });

  it("delivers the paragraph above a heading with no blank line between them", () => {
    expect(splitBufferedAssistantText("para\n## Setup\n\nInstall")).toEqual({
      ready: "para\n",
      rest: "## Setup\n\nInstall",
    });
    // A bold line there continues the paragraph, so both stay buffered.
    expect(splitBufferedAssistantText("para\n**Setup**\n\nInstall")).toEqual({
      ready: "",
      rest: "para\n**Setup**\n\nInstall",
    });
  });

  it("holds a line of only bold text like a heading", () => {
    expect(splitBufferedAssistantText("**Risk by area:**\n\n| a |\n|---|\n")).toEqual({
      ready: "",
      rest: "**Risk by area:**\n\n| a |\n|---|\n",
    });
    expect(splitBufferedAssistantText("**Use *npm* now**\n\nInstall it")).toEqual({
      ready: "",
      rest: "**Use *npm* now**\n\nInstall it",
    });
    expect(splitBufferedAssistantText("**Note:** read this.\n\nNext")).toEqual({
      ready: "**Note:** read this.\n\n",
      rest: "Next",
    });
  });

  it("delivers a held heading with its first list item or its whole code block", () => {
    expect(splitBufferedAssistantText("## Steps\n\n- one\n- tw")).toEqual({
      ready: "## Steps\n\n- one\n",
      rest: "- tw",
    });
    expect(splitBufferedAssistantText("## Code\n\n```ts\na\n\nb\n")).toEqual({
      ready: "",
      rest: "## Code\n\n```ts\na\n\nb\n",
    });
    expect(splitBufferedAssistantText("## Code\n\n```ts\na\n```\nafter")).toEqual({
      ready: "## Code\n\n```ts\na\n```\n",
      rest: "after",
    });
  });
});
