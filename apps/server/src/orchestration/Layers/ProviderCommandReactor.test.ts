import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  ModelSelection,
  ProviderGoal,
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
  ThreadId,
  TurnId,
} from "@piedpiper/contracts";
import { IMAGE_ONLY_BOOTSTRAP_PROMPT } from "@piedpiper/shared/imageOnlyBootstrapPrompt";
import { Deferred, Effect, Exit, Layer, ManagedRuntime, PubSub, Scope, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";

import { deriveServerPaths, ServerConfig } from "../../config.ts";
import { TextGenerationError } from "@piedpiper/contracts";
import {
  ProviderAdapterRequestError,
  ProviderSessionNotFoundError,
} from "../../provider/Errors.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProviderSessionRuntimeRepositoryLive } from "../../persistence/Layers/ProviderSessionRuntime.ts";
import { ProviderSessionRuntimeRepository } from "../../persistence/Services/ProviderSessionRuntime.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import { GitCore, type GitCoreShape } from "../../git/Services/GitCore.ts";
import { GitHubCli, type GitHubCliShape } from "../../git/Services/GitHubCli.ts";
import { TextGeneration, type TextGenerationShape } from "../../git/Services/TextGeneration.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import {
  ProviderCommandReactorLive,
  resolveTitleRegenerationCwd,
} from "./ProviderCommandReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProviderCommandReactor } from "../Services/ProviderCommandReactor.ts";
import { RESTART_CONTINUATION_TEXT, restartContinuationMessageId } from "../restartContinuation.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ServerSettingsService } from "../../serverSettings.ts";

const asProjectId = (value: string): ProjectId => ProjectId.makeUnsafe(value);
const asApprovalRequestId = (value: string): ApprovalRequestId =>
  ApprovalRequestId.makeUnsafe(value);
const asMessageId = (value: string): MessageId => MessageId.makeUnsafe(value);
const asTurnId = (value: string): TurnId => TurnId.makeUnsafe(value);

const deriveServerPathsSync = (baseDir: string, devUrl: URL | undefined) =>
  Effect.runSync(deriveServerPaths(baseDir, devUrl).pipe(Effect.provide(NodeServices.layer)));

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const poll = async (): Promise<void> => {
    if (await predicate()) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for expectation.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    return poll();
  };

  return poll();
}

// Domain events reach the reactor asynchronously, so give them a moment before draining.
const settle = async (harness: { readonly drain: () => Promise<void> }) => {
  await new Promise((resolve) => setTimeout(resolve, 25));
  await harness.drain();
  await new Promise((resolve) => setTimeout(resolve, 25));
  await harness.drain();
};

const goalRequests = (harness: { runGoalRequest: Mock<ProviderServiceShape["runGoalRequest"]> }) =>
  harness.runGoalRequest.mock.calls.map((call) => call[0].request);

describe("ProviderCommandReactor", () => {
  let runtime: ManagedRuntime.ManagedRuntime<
    OrchestrationEngineService | ProviderCommandReactor,
    unknown
  > | null = null;
  let scope: Scope.Closeable | null = null;
  const createdStateDirs = new Set<string>();
  const createdBaseDirs = new Set<string>();

  afterEach(async () => {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
    for (const stateDir of createdStateDirs) {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
    createdStateDirs.clear();
    for (const baseDir of createdBaseDirs) {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
    createdBaseDirs.clear();
  });

  async function createHarness(input?: {
    readonly baseDir?: string;
    readonly threadModelSelection?: ModelSelection;
    readonly sessionModelSwitch?: "unsupported" | "in-session";
    readonly threadTitleInstructions?: string;
    readonly branchNaming?: {
      readonly branchNamingMode: "static" | "semantic" | "custom";
      readonly branchNamePrefix?: string;
      readonly branchNameInstructions?: string;
    };
  }) {
    const now = new Date().toISOString();
    const baseDir = input?.baseDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "piedpiper-reactor-"));
    createdBaseDirs.add(baseDir);
    // The reactor's processTurnStartRequested existsSync()s the project cwd
    // (or worktreePath when set) before calling startSession. Provide real
    // on-disk directories so the reactor doesn't short-circuit to a
    // missing-cwd error path.
    const projectWorkspaceRoot = path.join(baseDir, "project");
    const projectWorktreePath = path.join(baseDir, "project-worktree");
    fs.mkdirSync(projectWorkspaceRoot, { recursive: true });
    fs.mkdirSync(projectWorktreePath, { recursive: true });
    const { stateDir } = deriveServerPathsSync(baseDir, undefined);
    createdStateDirs.add(stateDir);
    const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
    let nextSessionIndex = 1;
    const runtimeSessions: Array<ProviderSession> = [];
    const modelSelection = input?.threadModelSelection ?? {
      provider: "codex",
      model: "gpt-5-codex",
    };
    const startSession = vi.fn((_: unknown, input: unknown) => {
      const sessionIndex = nextSessionIndex++;
      const resumeCursor =
        typeof input === "object" && input !== null && "resumeCursor" in input
          ? input.resumeCursor
          : undefined;
      const threadId =
        typeof input === "object" &&
        input !== null &&
        "threadId" in input &&
        typeof input.threadId === "string"
          ? ThreadId.makeUnsafe(input.threadId)
          : ThreadId.makeUnsafe(`thread-${sessionIndex}`);
      const cwd =
        typeof input === "object" &&
        input !== null &&
        "cwd" in input &&
        typeof input.cwd === "string"
          ? input.cwd
          : undefined;
      const session: ProviderSession = {
        ...(cwd !== undefined ? { cwd } : {}),
        provider: modelSelection.provider,
        status: "ready" as const,
        runtimeMode:
          typeof input === "object" &&
          input !== null &&
          "runtimeMode" in input &&
          (input.runtimeMode === "approval-required" || input.runtimeMode === "full-access")
            ? input.runtimeMode
            : "full-access",
        ...(modelSelection.model !== undefined ? { model: modelSelection.model } : {}),
        threadId,
        resumeCursor: resumeCursor ?? { opaque: `resume-${sessionIndex}` },
        createdAt: now,
        updatedAt: now,
      };
      // One live session per thread, like the real adapters.
      const existingIndex = runtimeSessions.findIndex((entry) => entry.threadId === threadId);
      if (existingIndex >= 0) {
        runtimeSessions.splice(existingIndex, 1);
      }
      runtimeSessions.push(session);
      return Effect.succeed(session);
    });
    const sendTurn = vi.fn((_: unknown) =>
      Effect.succeed({
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId: asTurnId("turn-1"),
      }),
    );
    const interruptTurn = vi.fn((_: unknown) => Effect.void);
    const respondToRequest = vi.fn<ProviderServiceShape["respondToRequest"]>(() => Effect.void);
    const respondToUserInput = vi.fn<ProviderServiceShape["respondToUserInput"]>(() => Effect.void);
    const compactThread = vi.fn<ProviderServiceShape["compactThread"]>(() => Effect.void);
    const runGoalRequest = vi.fn<ProviderServiceShape["runGoalRequest"]>(() =>
      Effect.succeed({ goal: null }),
    );
    const stopSession = vi.fn((input: unknown) =>
      Effect.sync(() => {
        const threadId =
          typeof input === "object" && input !== null && "threadId" in input
            ? (input as { threadId?: ThreadId }).threadId
            : undefined;
        if (!threadId) {
          return;
        }
        const index = runtimeSessions.findIndex((session) => session.threadId === threadId);
        if (index >= 0) {
          runtimeSessions.splice(index, 1);
        }
      }),
    );
    const renameBranch = vi.fn((input: unknown) =>
      Effect.succeed({
        branch:
          typeof input === "object" &&
          input !== null &&
          "newBranch" in input &&
          typeof input.newBranch === "string"
            ? input.newBranch
            : "renamed-branch",
      }),
    );
    const generateBranchName = vi.fn<TextGenerationShape["generateBranchName"]>((_) =>
      Effect.fail(
        new TextGenerationError({
          operation: "generateBranchName",
          detail: "disabled in test harness",
        }),
      ),
    );
    const generateThreadTitle = vi.fn<TextGenerationShape["generateThreadTitle"]>((_) =>
      Effect.fail(
        new TextGenerationError({
          operation: "generateThreadTitle",
          detail: "disabled in test harness",
        }),
      ),
    );
    const ghExecute = vi.fn<GitHubCliShape["execute"]>((_) =>
      Effect.succeed({
        stdout: '{"title":"Fix login","body":null}',
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      }),
    );

    const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;
    const service: ProviderServiceShape = {
      startSession: startSession as ProviderServiceShape["startSession"],
      sendTurn: sendTurn as ProviderServiceShape["sendTurn"],
      interruptTurn: interruptTurn as ProviderServiceShape["interruptTurn"],
      respondToRequest: respondToRequest as ProviderServiceShape["respondToRequest"],
      respondToUserInput: respondToUserInput as ProviderServiceShape["respondToUserInput"],
      stopSession: stopSession as ProviderServiceShape["stopSession"],
      listSessions: () => Effect.succeed(runtimeSessions),
      getCapabilities: (_provider) =>
        Effect.succeed({
          sessionModelSwitch: input?.sessionModelSwitch ?? "in-session",
        }),
      canRollbackConversation: () => Effect.succeed(true),
      rollbackConversation: () => unsupported(),
      compactThread: compactThread as ProviderServiceShape["compactThread"],
      runGoalRequest: runGoalRequest as ProviderServiceShape["runGoalRequest"],
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
    const layer = ProviderCommandReactorLive.pipe(
      Layer.provideMerge(orchestrationLayer),
      Layer.provideMerge(Layer.succeed(ProviderService, service)),
      Layer.provideMerge(Layer.succeed(GitCore, { renameBranch } as unknown as GitCoreShape)),
      Layer.provideMerge(
        Layer.succeed(GitHubCli, { execute: ghExecute } as unknown as GitHubCliShape),
      ),
      Layer.provideMerge(
        Layer.mock(TextGeneration, {
          generateBranchName,
          generateThreadTitle,
        }),
      ),
      Layer.provideMerge(
        ServerSettingsService.layerTest({
          ...(input?.threadTitleInstructions !== undefined
            ? { threadTitleInstructions: input.threadTitleInstructions }
            : {}),
          ...input?.branchNaming,
        }),
      ),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(NodeServices.layer),
    );
    const runtime = ManagedRuntime.make(layer);

    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const reactor = await runtime.runPromise(Effect.service(ProviderCommandReactor));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reactor.start().pipe(Scope.provide(scope)));
    const drain = () => Effect.runPromise(reactor.drain);

    await Effect.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-create"),
        projectId: asProjectId("project-1"),
        title: "Provider Project",
        workspaceRoot: projectWorkspaceRoot,
        defaultModelSelection: modelSelection,
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-create"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        projectId: asProjectId("project-1"),
        title: "Thread",
        modelSelection: modelSelection,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: now,
      }),
    );

    return {
      engine,
      reactor,
      runtime,
      projectWorkspaceRoot,
      projectWorktreePath,
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      compactThread,
      runGoalRequest,
      stopSession,
      renameBranch,
      generateBranchName,
      generateThreadTitle,
      ghExecute,
      stateDir,
      drain,
    };
  }

  it("reacts to thread.turn.start by ensuring session and sending provider turn", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-1"),
          role: "user",
          text: "hello reactor",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[0]).toEqual(ThreadId.makeUnsafe("thread-1"));
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      cwd: harness.projectWorkspaceRoot,
      modelSelection: {
        provider: "codex",
        model: "gpt-5-codex",
      },
      runtimeMode: "approval-required",
      // Lets Claude skip its own session-title request.
      title: "Thread",
    });

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.get(ThreadId.makeUnsafe("thread-1"));
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.runtimeMode).toBe("approval-required");
    // The provider has not reported turn.started yet, so the thread must not look idle.
    expect(thread?.session?.status).toBe("starting");
    expect(thread?.session?.activeTurnId).toBeNull();
  });

  it("marks the session as errored when the provider turn start fails", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.sendTurn.mockImplementationOnce(
      (_: unknown) =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: "codex",
            method: "turn/start",
            detail: "model is overloaded",
          }),
        ) as never,
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-fails"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-fails"),
          role: "user",
          text: "hello failure",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      return readModel.threads.get(ThreadId.makeUnsafe("thread-1"))?.session?.status === "error";
    });
    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.get(ThreadId.makeUnsafe("thread-1"));
    expect(thread?.session).toMatchObject({
      status: "error",
      activeTurnId: null,
      lastError: "model is overloaded",
    });
    expect(
      thread?.activities.some((activity) => activity.kind === "provider.turn.start.failed"),
    ).toBe(true);
    // The settle names the failed message, so the projection drops its pending start row.
    const pendingStarts = await harness.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql<{ readonly messageId: string }>`
          SELECT pending_message_id AS "messageId"
          FROM projection_turns
          WHERE thread_id = 'thread-1' AND turn_id IS NULL
        `;
      }),
    );
    expect(pendingStarts).toEqual([]);
  });

  it("generates a thread title on the first turn, retrying a transient failure", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    const seededTitle = "Please investigate reconnect failures after restar...";
    let attempts = 0;
    harness.generateThreadTitle.mockReturnValue(
      Effect.suspend(() => {
        attempts += 1;
        return attempts === 1
          ? Effect.fail(
              new TextGenerationError({
                operation: "generateThreadTitle",
                detail: "Claude CLI request timed out.",
              }),
            )
          : Effect.succeed({ title: "Generated title" });
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-thread-title-seed"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        title: seededTitle,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-title"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-title"),
          role: "user",
          text: "Please investigate reconnect failures after restarting the session.",
          attachments: [],
        },
        titleSeed: seededTitle,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.generateThreadTitle.mock.calls.length === 1);
    expect(harness.generateThreadTitle.mock.calls[0]?.[0]).toMatchObject({
      message: "Please investigate reconnect failures after restarting the session.",
    });

    // The retry backs off for 2s before the second attempt.
    await waitFor(async () => {
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      return readModel.threads.get(ThreadId.makeUnsafe("thread-1"))?.title === "Generated title";
    }, 5_000);
    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.get(ThreadId.makeUnsafe("thread-1"));
    expect(thread?.title).toBe("Generated title");
    expect(attempts).toBe(2);
  }, 10_000);

  it("passes the thread title instructions setting to first-turn title generation", async () => {
    const harness = await createHarness({
      threadTitleInstructions: "  Name the subsystem first  ",
    });
    harness.generateThreadTitle.mockReturnValue(Effect.succeed({ title: "Reconnect fix" }));
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-thread-title-seed-instructions"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        title: "Fix reconnects",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-title-instructions"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-title-instructions"),
          role: "user",
          text: "Fix reconnects",
          attachments: [],
        },
        titleSeed: "Fix reconnects",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: new Date().toISOString(),
      }),
    );

    await waitFor(() => harness.generateThreadTitle.mock.calls.length === 1);
    expect(harness.generateThreadTitle.mock.calls[0]?.[0]).toMatchObject({
      additionalInstructions: "Name the subsystem first",
    });
  });

  const startTurnNamingThread = async (
    harness: Awaited<ReturnType<typeof createHarness>>,
    text: string,
  ) => {
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-thread-title-seed-link"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        title: "Seed",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-title-link"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-title-link"),
          role: "user",
          text,
          attachments: [],
        },
        titleSeed: "Seed",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: new Date().toISOString(),
      }),
    );
  };

  it("passes a linked pull request's subject to first-turn title generation", async () => {
    const harness = await createHarness();
    harness.generateThreadTitle.mockReturnValue(Effect.succeed({ title: "Fix login" }));

    await startTurnNamingThread(harness, "Take over https://github.com/acme/app/pull/12.");

    await waitFor(() => harness.generateThreadTitle.mock.calls.length === 1);
    expect(harness.generateThreadTitle.mock.calls[0]?.[0]?.linkedContext).toContain("Fix login");
    expect(harness.ghExecute).toHaveBeenCalledTimes(1);
  });

  it("omits linked context and never calls gh for a message with no link", async () => {
    const harness = await createHarness();
    harness.generateThreadTitle.mockReturnValue(Effect.succeed({ title: "Reconnects" }));

    await startTurnNamingThread(harness, "Fix the reconnect loop");

    await waitFor(() => harness.generateThreadTitle.mock.calls.length === 1);
    expect(harness.generateThreadTitle.mock.calls[0]?.[0]).not.toHaveProperty("linkedContext");
    expect(harness.ghExecute).not.toHaveBeenCalled();
  });

  it("looks a link up once when title generation retries", async () => {
    const harness = await createHarness();
    let attempts = 0;
    harness.generateThreadTitle.mockReturnValue(
      Effect.suspend(() => {
        attempts += 1;
        return attempts <= 2
          ? Effect.fail(
              new TextGenerationError({
                operation: "generateThreadTitle",
                detail: "Claude CLI request timed out.",
              }),
            )
          : Effect.succeed({ title: "Fix login" });
      }),
    );

    await startTurnNamingThread(harness, "Take over https://github.com/acme/app/pull/12");

    // The retries back off for 2s and then 4s.
    await waitFor(async () => (await readThreadTitle(harness)) === "Fix login", 8_000);
    expect(attempts).toBe(3);
    expect(harness.ghExecute).toHaveBeenCalledTimes(1);
  }, 12_000);

  it("regenerates a title from links in user messages only", async () => {
    const harness = await createHarness();
    await startTitledTurn(harness);
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: CommandId.makeUnsafe("cmd-assistant-link"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId: asMessageId("assistant-message-link"),
        delta: "See https://github.com/acme/app/pull/99",
        createdAt: new Date().toISOString(),
      }),
    );
    harness.generateThreadTitle.mockReturnValue(Effect.succeed({ title: "Websocket loop" }));

    await regenerateTitle(harness, "cmd-title-regenerate-assistant-link");

    await waitFor(async () => (await readThreadTitle(harness)) === "Websocket loop");
    expect(harness.ghExecute).not.toHaveBeenCalled();
    expect(harness.generateThreadTitle.mock.calls[0]?.[0]).not.toHaveProperty("linkedContext");
  });

  it("regenerates a title with the subject of a link a user message holds", async () => {
    const harness = await createHarness();
    harness.generateThreadTitle.mockReturnValue(Effect.succeed({ title: "First" }));
    await startTurnNamingThread(harness, "Take over https://github.com/acme/app/pull/12");
    await waitFor(async () => (await readThreadTitle(harness)) === "First");
    harness.generateThreadTitle.mockClear();
    harness.ghExecute.mockClear();
    harness.generateThreadTitle.mockReturnValue(Effect.succeed({ title: "Second" }));

    await regenerateTitle(harness, "cmd-title-regenerate-user-link");

    await waitFor(async () => (await readThreadTitle(harness)) === "Second");
    expect(harness.ghExecute).toHaveBeenCalledTimes(1);
    expect(harness.generateThreadTitle.mock.calls[0]?.[0]?.linkedContext).toContain("Fix login");
  });

  it("falls back to the server's cwd for a title when a thread has no workspace", async () => {
    const projectId = asProjectId("project-missing");
    await expect(
      Effect.runPromise(
        resolveTitleRegenerationCwd({
          thread: { projectId, worktreePath: null },
          projects: new Map(),
          fallbackCwd: "/srv/opened-folder",
        }),
      ),
    ).resolves.toBe("/srv/opened-folder");
  });

  it("falls back to the server's cwd when a worktree is gone and its project is unknown", async () => {
    await expect(
      Effect.runPromise(
        resolveTitleRegenerationCwd({
          thread: {
            projectId: asProjectId("project-missing"),
            worktreePath: "/tmp/piedpiper-removed-worktree-does-not-exist",
          },
          projects: new Map(),
          fallbackCwd: "/srv/opened-folder",
        }),
      ),
    ).resolves.toBe("/srv/opened-folder");
  });

  async function startTitledTurn(harness: Awaited<ReturnType<typeof createHarness>>) {
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-thread-title-custom-regen"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        title: "Vague title",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-regen"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-regen"),
          role: "user",
          text: "Fix the websocket reconnect loop",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: new Date().toISOString(),
      }),
    );
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    harness.generateThreadTitle.mockClear();
  }

  const readThreadTitle = async (harness: Awaited<ReturnType<typeof createHarness>>) =>
    (await Effect.runPromise(harness.engine.getReadModel())).threads.get(
      ThreadId.makeUnsafe("thread-1"),
    )?.title;

  it("regenerates a thread title from its conversation with the previous title", async () => {
    const harness = await createHarness();
    await startTitledTurn(harness);
    harness.generateThreadTitle.mockReturnValue(
      Effect.succeed({ title: "Websocket reconnect loop" }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.title.regenerate",
        commandId: CommandId.makeUnsafe("cmd-title-regenerate"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        createdAt: new Date().toISOString(),
      }),
    );

    await waitFor(async () => (await readThreadTitle(harness)) === "Websocket reconnect loop");
    expect(harness.generateThreadTitle).toHaveBeenCalledTimes(1);
    const request = harness.generateThreadTitle.mock.calls[0]?.[0];
    expect(request?.previousTitle).toBe("Vague title");
    expect(request?.message).toContain("Fix the websocket reconnect loop");
  });

  it("keeps a manual rename made while the title is regenerating", async () => {
    const harness = await createHarness();
    await startTitledTurn(harness);
    const release = Effect.runSync(Deferred.make<void>());
    harness.generateThreadTitle.mockReturnValue(
      Deferred.await(release).pipe(Effect.as({ title: "Generated title" })),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.title.regenerate",
        commandId: CommandId.makeUnsafe("cmd-title-regenerate-race"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        createdAt: new Date().toISOString(),
      }),
    );
    await waitFor(() => harness.generateThreadTitle.mock.calls.length === 1);
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-thread-title-manual"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        title: "Manual title",
      }),
    );
    Effect.runSync(Deferred.succeed(release, undefined));
    await harness.drain();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(await readThreadTitle(harness)).toBe("Manual title");
  });

  const regenerateTitle = (harness: Awaited<ReturnType<typeof createHarness>>, commandId: string) =>
    Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.title.regenerate",
        commandId: CommandId.makeUnsafe(commandId),
        threadId: ThreadId.makeUnsafe("thread-1"),
        createdAt: new Date().toISOString(),
      }),
    );

  const readSettledTitleRegenerations = async (
    harness: Awaited<ReturnType<typeof createHarness>>,
  ) => {
    const events = await Effect.runPromise(Stream.runCollect(harness.engine.readEvents(0)));
    return Array.from(events).flatMap((event) =>
      event.type === "thread.title-regeneration-settled" ? [event.payload] : [],
    );
  };

  const waitForSettledTitleRegeneration = async (
    harness: Awaited<ReturnType<typeof createHarness>>,
  ) => {
    await waitFor(async () => (await readSettledTitleRegenerations(harness)).length > 0);
    return readSettledTitleRegenerations(harness);
  };

  it("settles a regeneration that updated the title, after the title is applied", async () => {
    const harness = await createHarness();
    await startTitledTurn(harness);
    harness.generateThreadTitle.mockReturnValue(Effect.succeed({ title: "Better title" }));

    await regenerateTitle(harness, "cmd-title-settle-updated");

    const settled = await waitForSettledTitleRegeneration(harness);
    expect(settled.map((payload) => payload.outcome)).toEqual(["updated"]);
    expect(await readThreadTitle(harness)).toBe("Better title");
  });

  it("settles as unchanged when the model returns the same title", async () => {
    const harness = await createHarness();
    await startTitledTurn(harness);
    harness.generateThreadTitle.mockReturnValue(Effect.succeed({ title: "Vague title" }));

    await regenerateTitle(harness, "cmd-title-settle-same");

    const settled = await waitForSettledTitleRegeneration(harness);
    expect(settled.map((payload) => payload.outcome)).toEqual(["unchanged"]);
  });

  it("settles as empty when the thread has nothing to summarize", async () => {
    const harness = await createHarness();

    await regenerateTitle(harness, "cmd-title-settle-empty");

    const settled = await waitForSettledTitleRegeneration(harness);
    expect(settled.map((payload) => payload.outcome)).toEqual(["empty"]);
    expect(harness.generateThreadTitle).not.toHaveBeenCalled();
  });

  it("settles as failed with the error message and no stack trace", async () => {
    const harness = await createHarness();
    await startTitledTurn(harness);
    // A defect is not retried, so the test does not wait through the backoff.
    harness.generateThreadTitle.mockReturnValue(Effect.die(new Error("model unavailable")));

    await regenerateTitle(harness, "cmd-title-settle-failed");

    const settled = await waitForSettledTitleRegeneration(harness);
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ outcome: "failed", detail: "model unavailable" });
  });

  it("settles a run once and not for a duplicate request skipped while it was in flight", async () => {
    const harness = await createHarness();
    await startTitledTurn(harness);
    const release = Effect.runSync(Deferred.make<void>());
    harness.generateThreadTitle.mockReturnValue(
      Deferred.await(release).pipe(Effect.as({ title: "Generated title" })),
    );

    await regenerateTitle(harness, "cmd-title-settle-first");
    await waitFor(() => harness.generateThreadTitle.mock.calls.length === 1);
    await regenerateTitle(harness, "cmd-title-settle-duplicate");
    await harness.drain();
    expect(await readSettledTitleRegenerations(harness)).toEqual([]);

    Effect.runSync(Deferred.succeed(release, undefined));
    await waitForSettledTitleRegeneration(harness);
    await harness.drain();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(harness.generateThreadTitle).toHaveBeenCalledTimes(1);
    expect(await readSettledTitleRegenerations(harness)).toHaveLength(1);
  });

  it("allows a new regeneration as soon as the previous one settled", async () => {
    const harness = await createHarness();
    await startTitledTurn(harness);
    harness.generateThreadTitle.mockReturnValue(Effect.succeed({ title: "First result" }));
    await regenerateTitle(harness, "cmd-title-settle-again-1");
    await waitForSettledTitleRegeneration(harness);

    harness.generateThreadTitle.mockReturnValue(Effect.succeed({ title: "Second result" }));
    await regenerateTitle(harness, "cmd-title-settle-again-2");

    await waitFor(async () => (await readSettledTitleRegenerations(harness)).length === 2);
    expect(await readThreadTitle(harness)).toBe("Second result");
  });

  it("does not hold up reactor shutdown for a regeneration still in flight", async () => {
    const harness = await createHarness();
    await startTitledTurn(harness);
    harness.generateThreadTitle.mockReturnValue(Effect.never);
    await regenerateTitle(harness, "cmd-title-settle-shutdown");
    await waitFor(() => harness.generateThreadTitle.mock.calls.length === 1);

    await Effect.runPromise(Scope.close(scope!, Exit.void));
    scope = null;

    expect(await readSettledTitleRegenerations(harness)).toEqual([]);
  });

  const setThreadWorktree = (harness: Awaited<ReturnType<typeof createHarness>>) =>
    Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-thread-worktree-regen"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        branch: "feature",
        worktreePath: harness.projectWorktreePath,
      }),
    );

  it("regenerates a title in the project root after the worktree was removed", async () => {
    const harness = await createHarness();
    await startTitledTurn(harness);
    await setThreadWorktree(harness);
    fs.rmSync(harness.projectWorktreePath, { recursive: true, force: true });
    harness.generateThreadTitle.mockReturnValue(Effect.succeed({ title: "Rootless title" }));

    await regenerateTitle(harness, "cmd-title-removed-worktree");

    await waitFor(async () => (await readThreadTitle(harness)) === "Rootless title");
    expect(harness.generateThreadTitle.mock.calls[0]?.[0]?.cwd).toBe(harness.projectWorkspaceRoot);
  });

  it("regenerates a title in the worktree while it still exists", async () => {
    const harness = await createHarness();
    await startTitledTurn(harness);
    await setThreadWorktree(harness);
    harness.generateThreadTitle.mockReturnValue(Effect.succeed({ title: "Worktree title" }));

    await regenerateTitle(harness, "cmd-title-existing-worktree");

    await waitFor(async () => (await readThreadTitle(harness)) === "Worktree title");
    expect(harness.generateThreadTitle.mock.calls[0]?.[0]?.cwd).toBe(harness.projectWorktreePath);
  });

  it("does not overwrite an existing custom thread title on the first turn", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    const seededTitle = "Please investigate reconnect failures after restar...";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-thread-title-custom"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        title: "Keep this custom title",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-title-preserve"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-title-preserve"),
          role: "user",
          text: "Please investigate reconnect failures after restarting the session.",
          attachments: [],
        },
        titleSeed: seededTitle,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.generateThreadTitle).not.toHaveBeenCalled();

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.get(ThreadId.makeUnsafe("thread-1"));
    expect(thread?.title).toBe("Keep this custom title");
  });

  it("matches the client-seeded title even when the outgoing prompt is reformatted", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    const seededTitle = "Fix reconnect spinner on resume";
    harness.generateThreadTitle.mockReturnValue(
      Effect.succeed({
        title: "Reconnect spinner resume bug",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-thread-title-formatted-seed"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        title: seededTitle,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-title-formatted"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-title-formatted"),
          role: "user",
          text: "[effort:high]\\n\\nFix reconnect spinner on resume",
          attachments: [],
        },
        titleSeed: seededTitle,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.generateThreadTitle.mock.calls.length === 1);
    await waitFor(async () => {
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      return (
        readModel.threads.get(ThreadId.makeUnsafe("thread-1"))?.title ===
        "Reconnect spinner resume bug"
      );
    });

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.get(ThreadId.makeUnsafe("thread-1"));
    expect(thread?.title).toBe("Reconnect spinner resume bug");
  });

  it("generates a worktree branch name for the first turn", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-thread-branch"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        branch: "piedpiper/1234abcd",
        worktreePath: harness.projectWorktreePath,
      }),
    );

    harness.generateBranchName.mockImplementation((input: unknown) =>
      Effect.succeed({
        branch:
          typeof input === "object" &&
          input !== null &&
          "modelSelection" in input &&
          typeof input.modelSelection === "object" &&
          input.modelSelection !== null &&
          "model" in input.modelSelection &&
          typeof input.modelSelection.model === "string"
            ? `feature/${input.modelSelection.model}`
            : "feature/generated",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-branch-model"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-branch-model"),
          role: "user",
          text: "Add a safer reconnect backoff.",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.generateBranchName.mock.calls.length === 1);
    expect(harness.generateBranchName.mock.calls[0]?.[0]).toMatchObject({
      message: "Add a safer reconnect backoff.",
    });
  });

  it("renames a flattened piedpiper-<hex> placeholder branch on the first turn", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-thread-branch-flat"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        branch: "piedpiper-1234abcd",
        worktreePath: harness.projectWorktreePath,
      }),
    );
    harness.generateBranchName.mockImplementation(() =>
      Effect.succeed({ branch: "feature/reconnect-backoff" }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-branch-flat"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-branch-flat"),
          role: "user",
          text: "Add a safer reconnect backoff.",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.generateBranchName.mock.calls.length === 1);
    await waitFor(() => harness.renameBranch.mock.calls.length === 1);
    expect(harness.renameBranch.mock.calls[0]?.[0]).toMatchObject({
      oldBranch: "piedpiper-1234abcd",
      newBranch: "piedpiper/feature/reconnect-backoff",
    });
  });

  describe("first-turn branch naming settings", () => {
    const renameWith = async (
      branchNaming: NonNullable<NonNullable<Parameters<typeof createHarness>[0]>["branchNaming"]>,
      generatedBranch: string,
    ) => {
      const harness = await createHarness({ branchNaming });
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.makeUnsafe("cmd-thread-branch-naming"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          branch: "piedpiper/1234abcd",
          worktreePath: harness.projectWorktreePath,
        }),
      );
      harness.generateBranchName.mockImplementation(() =>
        Effect.succeed({ branch: generatedBranch }),
      );
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe("cmd-turn-start-branch-naming"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          message: {
            messageId: asMessageId("user-message-branch-naming"),
            role: "user",
            text: "Add search",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: new Date().toISOString(),
        }),
      );
      await waitFor(() => harness.generateBranchName.mock.calls.length === 1);
      return harness;
    };

    it.each([
      {
        name: "static adds the prefix",
        naming: { branchNamingMode: "static", branchNamePrefix: "team" },
        generated: "add-search",
        expected: "team/add-search",
      },
      {
        name: "semantic keeps the generated namespace",
        naming: { branchNamingMode: "semantic" },
        generated: "feat/add-search",
        expected: "feat/add-search",
      },
      {
        name: "custom keeps the model's casing",
        naming: { branchNamingMode: "custom", branchNameInstructions: "Start with PROJ" },
        generated: "PROJ-1/Add_Search",
        expected: "PROJ-1/Add_Search",
      },
    ] as const)("$name", async ({ naming, generated, expected }) => {
      const harness = await renameWith(naming, generated);
      await waitFor(() => harness.renameBranch.mock.calls.length === 1);
      expect(harness.renameBranch.mock.calls[0]?.[0]).toMatchObject({
        oldBranch: "piedpiper/1234abcd",
        newBranch: expected,
      });
    });

    it("passes the naming settings to branch generation", async () => {
      const harness = await renameWith(
        {
          branchNamingMode: "custom",
          branchNamePrefix: "team",
          branchNameInstructions: "Start with PROJ",
        },
        "PROJ-1/Add_Search",
      );
      expect(harness.generateBranchName.mock.calls[0]?.[0]?.naming).toEqual({
        mode: "custom",
        prefix: "team",
        instructions: "Start with PROJ",
      });
    });

    it("does not rename to a name shaped like a placeholder", async () => {
      const harness = await renameWith(
        { branchNamingMode: "static", branchNamePrefix: "piedpiper" },
        "deadbeef",
      );
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);
      // The rename runs in a forked fiber, so give it a chance to act before asserting it did not.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(harness.renameBranch).not.toHaveBeenCalled();
    });
  });

  it("forwards codex model options through session start and turn send", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-fast"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-fast"),
          role: "user",
          text: "hello fast mode",
          attachments: [],
        },
        modelSelection: {
          provider: "codex",
          model: "gpt-5.3-codex",
          options: {
            reasoningEffort: "high",
            fastMode: true,
          },
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      modelSelection: {
        provider: "codex",
        model: "gpt-5.3-codex",
        options: {
          reasoningEffort: "high",
          fastMode: true,
        },
      },
    });
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      modelSelection: {
        provider: "codex",
        model: "gpt-5.3-codex",
        options: {
          reasoningEffort: "high",
          fastMode: true,
        },
      },
    });
  });

  it("forwards claude effort options through session start and turn send", async () => {
    const harness = await createHarness({
      threadModelSelection: { provider: "claudeAgent", model: "claude-sonnet-4-6" },
    });
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-claude-effort"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-effort"),
          role: "user",
          text: "hello with effort",
          attachments: [],
        },
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-sonnet-4-6",
          options: {
            effort: "max",
          },
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-sonnet-4-6",
        options: {
          effort: "max",
        },
      },
    });
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-sonnet-4-6",
        options: {
          effort: "max",
        },
      },
    });
  });

  it("forwards claude fast mode options through session start and turn send", async () => {
    const harness = await createHarness({
      threadModelSelection: { provider: "claudeAgent", model: "claude-opus-4-6" },
    });
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-claude-fast-mode"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-fast-mode"),
          role: "user",
          text: "hello with fast mode",
          attachments: [],
        },
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-opus-4-6",
          options: {
            fastMode: true,
          },
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-opus-4-6",
        options: {
          fastMode: true,
        },
      },
    });
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-opus-4-6",
        options: {
          fastMode: true,
        },
      },
    });
  });

  it("forwards plan interaction mode to the provider turn request", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.interaction-mode.set",
        commandId: CommandId.makeUnsafe("cmd-interaction-mode-set-plan"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        interactionMode: "plan",
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-plan"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-plan"),
          role: "user",
          text: "plan this change",
          attachments: [],
        },
        interactionMode: "plan",
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      interactionMode: "plan",
    });
  });

  it("rejects a first turn when requested provider conflicts with the thread model", async () => {
    const harness = await createHarness({
      threadModelSelection: { provider: "codex", model: "gpt-5-codex" },
    });
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-provider-first"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-provider-first"),
          role: "user",
          text: "hello claude",
          attachments: [],
        },
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-opus-4-6",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      const thread = readModel.threads.get(ThreadId.makeUnsafe("thread-1"));
      return (
        thread?.activities.some((activity) => activity.kind === "provider.turn.start.failed") ??
        false
      );
    });

    await waitFor(async () => {
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      return readModel.threads.get(ThreadId.makeUnsafe("thread-1"))?.session?.status === "error";
    });
    expect(harness.startSession).not.toHaveBeenCalled();
    expect(harness.sendTurn).not.toHaveBeenCalled();

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.get(ThreadId.makeUnsafe("thread-1"));
    expect(thread?.session).toMatchObject({
      status: "error",
      activeTurnId: null,
      lastError: expect.stringContaining("cannot switch to 'claudeAgent'"),
    });
    expect(
      thread?.activities.find((activity) => activity.kind === "provider.turn.start.failed"),
    ).toMatchObject({
      summary: "Provider turn start failed",
      payload: {
        detail: expect.stringContaining("cannot switch to 'claudeAgent'"),
      },
    });
  });

  it("preserves the active session model when in-session model switching is unsupported", async () => {
    const harness = await createHarness({ sessionModelSwitch: "unsupported" });
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-unsupported-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-unsupported-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-unsupported-2"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-unsupported-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);

    expect(harness.sendTurn.mock.calls[1]?.[0]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      modelSelection: {
        provider: "codex",
        model: "gpt-5-codex",
      },
    });
  });

  it("reuses the same provider session when runtime mode is unchanged", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-unchanged-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-unchanged-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-unchanged-2"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-unchanged-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.startSession.mock.calls.length).toBe(1);
    expect(harness.stopSession.mock.calls.length).toBe(0);
  });

  it("keeps the claude session when only effort changes", async () => {
    const MODEL = "claude-sonnet-4-6";
    const harness = await createHarness({
      threadModelSelection: { provider: "claudeAgent", model: MODEL },
    });
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-claude-effort-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-effort-1"),
          role: "user",
          text: "first claude turn",
          attachments: [],
        },
        modelSelection: {
          provider: "claudeAgent",
          model: MODEL,
          options: { effort: "medium" },
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-claude-effort-2"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-effort-2"),
          role: "user",
          text: "second claude turn",
          attachments: [],
        },
        modelSelection: {
          provider: "claudeAgent",
          model: MODEL,
          options: { effort: "max" },
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.startSession.mock.calls.length).toBe(1);
    expect(harness.sendTurn.mock.calls[1]?.[0]).toMatchObject({
      modelSelection: { provider: "claudeAgent", model: MODEL, options: { effort: "max" } },
    });
  });

  it("records a model switch activity when a later turn changes model or effort", async () => {
    const harness = await createHarness({
      threadModelSelection: { provider: "claudeAgent", model: "claude-opus-4-6" },
    });
    const now = new Date().toISOString();
    const startTurn = (index: number, modelSelection: ModelSelection) =>
      Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe(`cmd-turn-start-model-switch-${index}`),
          threadId: ThreadId.makeUnsafe("thread-1"),
          message: {
            messageId: asMessageId(`user-message-model-switch-${index}`),
            role: "user",
            text: `turn ${index}`,
            attachments: [],
          },
          modelSelection,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        }),
      );
    const switchActivities = async () => {
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      return (
        readModel.threads
          .get(ThreadId.makeUnsafe("thread-1"))
          ?.activities.filter((activity) => activity.kind === "turn.model-switched") ?? []
      );
    };

    // Differs from the thread's creation model, but the first turn gets no divider.
    await startTurn(1, {
      provider: "claudeAgent",
      model: "claude-sonnet-4-6",
      options: { effort: "high" },
    });
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await startTurn(2, {
      provider: "claudeAgent",
      model: "claude-sonnet-4-6",
      options: { effort: "high", fastMode: true },
    });
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(await switchActivities()).toEqual([]);

    await startTurn(3, {
      provider: "claudeAgent",
      model: "claude-opus-4-6",
      options: { effort: "low" },
    });
    await waitFor(() => harness.sendTurn.mock.calls.length === 3);
    const activities = await switchActivities();
    expect(activities).toHaveLength(1);
    expect(activities[0]?.payload).toEqual({
      messageId: "user-message-model-switch-3",
      from: {
        provider: "claudeAgent",
        model: "claude-sonnet-4-6",
        options: { effort: "high", fastMode: true },
      },
      to: { provider: "claudeAgent", model: "claude-opus-4-6", options: { effort: "low" } },
    });
  });

  it("measures a model switch from the persisted binding when no turn ran in this process", async () => {
    const harness = await createHarness({
      threadModelSelection: { provider: "codex", model: "gpt-5-codex" },
    });
    const now = new Date().toISOString();
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-persisted-switch-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-persisted-switch-1"),
          role: "user",
          text: "first turn",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await harness.runtime.runPromise(
      Effect.gen(function* () {
        const repository = yield* ProviderSessionRuntimeRepository;
        yield* repository.upsert({
          threadId: ThreadId.makeUnsafe("thread-1"),
          providerName: "codex",
          adapterKey: "codex",
          runtimeMode: "approval-required",
          status: "running",
          lastSeenAt: now,
          resumeCursor: null,
          runtimePayload: {
            modelSelection: {
              provider: "codex",
              model: "gpt-5-codex",
              options: { reasoningEffort: "high" },
            },
          },
        });
      }).pipe(Effect.provide(ProviderSessionRuntimeRepositoryLive)),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-persisted-switch-2"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-persisted-switch-2"),
          role: "user",
          text: "second turn",
          attachments: [],
        },
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
          options: { reasoningEffort: "low" },
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const activity = readModel.threads
      .get(ThreadId.makeUnsafe("thread-1"))
      ?.activities.find((entry) => entry.kind === "turn.model-switched");
    expect(activity?.payload).toMatchObject({
      messageId: "user-message-persisted-switch-2",
      from: { options: { reasoningEffort: "high" } },
      to: { options: { reasoningEffort: "low" } },
    });
  });

  it("chains model switch dividers across a turn whose start failed", async () => {
    const harness = await createHarness({
      threadModelSelection: { provider: "codex", model: "gpt-5-codex" },
    });
    const now = new Date().toISOString();
    const modelA: ModelSelection = { provider: "codex", model: "gpt-5-codex" };
    const modelB: ModelSelection = { provider: "codex", model: "gpt-5.4" };
    const startTurn = (index: number, modelSelection: ModelSelection) =>
      Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe(`cmd-turn-start-failed-switch-${index}`),
          threadId: ThreadId.makeUnsafe("thread-1"),
          message: {
            messageId: asMessageId(`user-message-failed-switch-${index}`),
            role: "user",
            text: `turn ${index}`,
            attachments: [],
          },
          modelSelection,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        }),
      );
    const readThread = async () =>
      (await Effect.runPromise(harness.engine.getReadModel())).threads.get(
        ThreadId.makeUnsafe("thread-1"),
      );

    await startTurn(1, modelA);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    // B fails before the session (re)starts, so neither the cache nor the binding moves to B.
    await Effect.runPromise(harness.stopSession({ threadId: ThreadId.makeUnsafe("thread-1") }));
    harness.startSession.mockImplementationOnce(
      () =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: "codex",
            method: "thread/start",
            detail: "auth failed",
          }),
        ) as never,
    );
    await startTurn(2, modelB);
    await waitFor(async () => (await readThread())?.session?.status === "error");

    // Retrying on B adds no second divider; going back to A records B -> A.
    await startTurn(3, modelB);
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    await startTurn(4, modelA);
    await waitFor(() => harness.sendTurn.mock.calls.length === 3);

    const switches = (await readThread())?.activities.filter(
      (activity) => activity.kind === "turn.model-switched",
    );
    // Every turn shares one createdAt, so activity order is by random id; compare as a set.
    expect(switches?.map((activity) => activity.payload)).toEqual(
      expect.arrayContaining([
        { messageId: "user-message-failed-switch-2", from: modelA, to: modelB },
        { messageId: "user-message-failed-switch-4", from: modelB, to: modelA },
      ]),
    );
    expect(switches).toHaveLength(2);
  });

  it("restarts for a runtime mode change on the persisted selection when nothing is cached", async () => {
    const harness = await createHarness({
      threadModelSelection: { provider: "codex", model: "gpt-5-codex" },
    });
    const now = new Date().toISOString();
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-runtime-mode-persisted"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-runtime-mode-persisted"),
          role: "user",
          text: "first turn",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    const persistedSelection: ModelSelection = {
      provider: "codex",
      model: "gpt-5-codex",
      options: { reasoningEffort: "high" },
    };
    await harness.runtime.runPromise(
      Effect.gen(function* () {
        const repository = yield* ProviderSessionRuntimeRepository;
        yield* repository.upsert({
          threadId: ThreadId.makeUnsafe("thread-1"),
          providerName: "codex",
          adapterKey: "codex",
          runtimeMode: "approval-required",
          status: "running",
          lastSeenAt: now,
          resumeCursor: null,
          runtimePayload: { modelSelection: persistedSelection },
        });
      }).pipe(Effect.provide(ProviderSessionRuntimeRepositoryLive)),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.makeUnsafe("cmd-runtime-mode-set-persisted-selection"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );
    await waitFor(() => harness.startSession.mock.calls.length === 2);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      runtimeMode: "full-access",
      modelSelection: persistedSelection,
    });
  });

  it("restarts claude sessions when the thinking toggle changes", async () => {
    const MODEL = "claude-haiku-4-5";
    const harness = await createHarness({
      threadModelSelection: { provider: "claudeAgent", model: MODEL },
    });
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-claude-thinking-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-thinking-1"),
          role: "user",
          text: "first claude turn",
          attachments: [],
        },
        modelSelection: {
          provider: "claudeAgent",
          model: MODEL,
          options: { thinking: true },
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-claude-thinking-2"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-thinking-2"),
          role: "user",
          text: "second claude turn",
          attachments: [],
        },
        modelSelection: {
          provider: "claudeAgent",
          model: MODEL,
          options: { thinking: false },
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      resumeCursor: { opaque: "resume-1" },
      modelSelection: { provider: "claudeAgent", model: MODEL, options: { thinking: false } },
    });
  });

  it("restarts the provider session when runtime mode is updated on the thread", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.makeUnsafe("cmd-runtime-mode-set-initial-full-access"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-runtime-mode-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-runtime-mode-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.makeUnsafe("cmd-runtime-mode-set-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      const thread = readModel.threads.get(ThreadId.makeUnsafe("thread-1"));
      return thread?.runtimeMode === "approval-required";
    });
    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-runtime-mode-2"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-runtime-mode-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);

    expect(harness.stopSession.mock.calls.length).toBe(0);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      resumeCursor: { opaque: "resume-1" },
      runtimeMode: "approval-required",
    });
    expect(harness.sendTurn.mock.calls[1]?.[0]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
    });

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.get(ThreadId.makeUnsafe("thread-1"));
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.runtimeMode).toBe("approval-required");
  });

  it("does not inject derived model options when restarting claude on runtime mode changes", async () => {
    const harness = await createHarness({
      threadModelSelection: { provider: "claudeAgent", model: "claude-opus-4-6" },
    });
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-runtime-mode-claude"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "claudeAgent",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.makeUnsafe("cmd-runtime-mode-set-claude-no-options"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);

    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-opus-4-6",
      },
      runtimeMode: "approval-required",
    });
  });

  it("rejects provider changes after a thread is already bound to a session provider", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-provider-switch-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-provider-switch-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-provider-switch-2"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-provider-switch-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-opus-4-6",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      const thread = readModel.threads.get(ThreadId.makeUnsafe("thread-1"));
      return (
        thread?.activities.some((activity) => activity.kind === "provider.turn.start.failed") ??
        false
      );
    });

    expect(harness.startSession.mock.calls.length).toBe(1);
    expect(harness.sendTurn.mock.calls.length).toBe(1);
    expect(harness.stopSession.mock.calls.length).toBe(0);

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.get(ThreadId.makeUnsafe("thread-1"));
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.providerName).toBe("codex");
    expect(thread?.session?.runtimeMode).toBe("approval-required");
    expect(
      thread?.activities.find((activity) => activity.kind === "provider.turn.start.failed"),
    ).toMatchObject({
      payload: {
        detail: expect.stringContaining("cannot switch to 'claudeAgent'"),
      },
    });
  });

  it("does not stop the active session when restart fails before rebind", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.makeUnsafe("cmd-runtime-mode-set-initial-full-access-2"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-restart-failure-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-restart-failure-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    harness.startSession.mockImplementationOnce(
      (_: unknown, __: unknown) => Effect.fail(new Error("simulated restart failure")) as never,
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.makeUnsafe("cmd-runtime-mode-set-restart-failure"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      const thread = readModel.threads.get(ThreadId.makeUnsafe("thread-1"));
      return thread?.runtimeMode === "approval-required";
    });
    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await harness.drain();

    expect(harness.stopSession.mock.calls.length).toBe(0);
    expect(harness.sendTurn.mock.calls.length).toBe(1);

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.get(ThreadId.makeUnsafe("thread-1"));
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.runtimeMode).toBe("full-access");
  });

  it("reacts to thread.turn.interrupt-requested by calling provider interrupt", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-1"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.makeUnsafe("cmd-turn-interrupt"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId: asTurnId("turn-1"),
        createdAt: now,
      }),
    );

    await waitFor(() => harness.interruptTurn.mock.calls.length === 1);
    expect(harness.interruptTurn.mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
    });
  });

  it("recovers from a failed interrupt by stopping the session and settling the thread", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-interrupt-failure"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-1"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );
    harness.interruptTurn.mockImplementationOnce(
      (_: unknown) =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: "codex",
            method: "turn/interrupt",
            detail: "interrupt timed out",
          }),
        ) as never,
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.makeUnsafe("cmd-turn-interrupt-failure"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId: asTurnId("turn-1"),
        createdAt: now,
      }),
    );

    await waitFor(() => harness.stopSession.mock.calls.length === 1);
    await waitFor(async () => {
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      return readModel.threads.get(ThreadId.makeUnsafe("thread-1"))?.session?.status === "stopped";
    });
    await harness.drain();

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.get(ThreadId.makeUnsafe("thread-1"));
    expect(thread?.session?.status).toBe("stopped");
    expect(thread?.session?.activeTurnId).toBeNull();
    expect(thread?.session?.lastError).toBe("interrupt timed out");
    const failureActivity = thread?.activities.find(
      (activity) => activity.kind === "provider.turn.interrupt.failed",
    );
    expect(failureActivity).toBeDefined();
    expect(failureActivity?.turnId).toBe("turn-1");
    expect(failureActivity?.payload).toEqual({ detail: "interrupt timed out" });
  });

  it("does not stop the session when a failed interrupt finds the turn already settled", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-interrupt-settled"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );
    harness.interruptTurn.mockImplementationOnce(
      (_: unknown) => Effect.fail(new Error("nothing to interrupt")) as never,
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.makeUnsafe("cmd-turn-interrupt-settled"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId: asTurnId("turn-1"),
        createdAt: now,
      }),
    );

    await waitFor(() => harness.interruptTurn.mock.calls.length === 1);
    await harness.drain();

    expect(harness.stopSession.mock.calls.length).toBe(0);
    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.get(ThreadId.makeUnsafe("thread-1"));
    expect(thread?.session?.status).toBe("ready");
  });

  async function setRunningSession(
    harness: Awaited<ReturnType<typeof createHarness>>,
    input: {
      readonly status: "running" | "starting";
      readonly activeTurnId: string | null;
      readonly commandId: string;
    },
  ) {
    const now = new Date().toISOString();
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe(input.commandId),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: input.status,
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: input.activeTurnId === null ? null : asTurnId(input.activeTurnId),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );
  }

  async function readThread(harness: Awaited<ReturnType<typeof createHarness>>) {
    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    return readModel.threads.get(ThreadId.makeUnsafe("thread-1"));
  }

  const failingInterrupt = (detail: string) =>
    Effect.fail(
      new ProviderAdapterRequestError({ provider: "codex", method: "turn/interrupt", detail }),
    ) as never;

  it("settles the thread when both the interrupt and the session stop fail", async () => {
    const harness = await createHarness();
    await setRunningSession(harness, {
      status: "running",
      activeTurnId: "turn-1",
      commandId: "cmd-session-set-stop-failure",
    });
    harness.interruptTurn.mockImplementationOnce((_: unknown) =>
      failingInterrupt("interrupt timed out"),
    );
    harness.stopSession.mockImplementationOnce(
      (_: unknown) =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: "codex",
            method: "session.stop",
            detail: "provider process already exited",
          }),
        ) as never,
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.makeUnsafe("cmd-turn-interrupt-stop-failure"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId: asTurnId("turn-1"),
        createdAt: new Date().toISOString(),
      }),
    );

    await waitFor(async () => (await readThread(harness))?.session?.status === "stopped");
    await harness.drain();
    const thread = await readThread(harness);
    expect(harness.stopSession.mock.calls.length).toBe(1);
    expect(thread?.session?.activeTurnId).toBeNull();
    expect(thread?.session?.lastError).toBe("interrupt timed out");
    expect(
      thread?.activities.some((activity) => activity.kind === "provider.turn.interrupt.failed"),
    ).toBe(true);
  });

  it("recovers a starting session interrupted without a turn id", async () => {
    const harness = await createHarness();
    await setRunningSession(harness, {
      status: "starting",
      activeTurnId: null,
      commandId: "cmd-session-set-starting-interrupt",
    });
    harness.interruptTurn.mockImplementationOnce((_: unknown) =>
      failingInterrupt("session not ready"),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.makeUnsafe("cmd-turn-interrupt-starting"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        createdAt: new Date().toISOString(),
      }),
    );

    await waitFor(async () => (await readThread(harness))?.session?.status === "stopped");
    await harness.drain();
    const thread = await readThread(harness);
    expect(thread?.session?.lastError).toBe("session not ready");
    const failureActivity = thread?.activities.find(
      (activity) => activity.kind === "provider.turn.interrupt.failed",
    );
    expect(failureActivity?.turnId).toBeNull();
  });

  it("records the interrupt failure even when the stop already settled the thread", async () => {
    const harness = await createHarness();
    await setRunningSession(harness, {
      status: "running",
      activeTurnId: "turn-1",
      commandId: "cmd-session-set-stop-race",
    });
    harness.interruptTurn.mockImplementationOnce((_: unknown) =>
      failingInterrupt("interrupt timed out"),
    );
    // Simulates runtime ingestion applying the session exit before the reactor re-reads.
    harness.stopSession.mockImplementationOnce((_: unknown) => {
      const stoppedAt = new Date().toISOString();
      return harness.engine
        .dispatch({
          type: "thread.session.set",
          commandId: CommandId.makeUnsafe("cmd-session-set-exited"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          session: {
            threadId: ThreadId.makeUnsafe("thread-1"),
            status: "stopped",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: null,
            lastError: null,
            updatedAt: stoppedAt,
          },
          createdAt: stoppedAt,
        })
        .pipe(Effect.asVoid) as never;
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.makeUnsafe("cmd-turn-interrupt-stop-race"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId: asTurnId("turn-1"),
        createdAt: new Date().toISOString(),
      }),
    );

    await waitFor(async () =>
      Boolean(
        (await readThread(harness))?.activities.some(
          (activity) => activity.kind === "provider.turn.interrupt.failed",
        ),
      ),
    );
    await harness.drain();
    const thread = await readThread(harness);
    expect(thread?.session?.status).toBe("stopped");
    // The newer session state written by the stop is not overwritten.
    expect(thread?.session?.lastError).toBeNull();
  });

  it("settles the thread when no live provider session is left to interrupt", async () => {
    const harness = await createHarness();
    await setRunningSession(harness, {
      status: "running",
      activeTurnId: "turn-1",
      commandId: "cmd-session-set-no-live-session",
    });
    harness.interruptTurn.mockImplementationOnce(
      (_: unknown) =>
        Effect.fail(new ProviderSessionNotFoundError({ threadId: "thread-1" })) as never,
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.makeUnsafe("cmd-turn-interrupt-no-live-session"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId: asTurnId("turn-1"),
        createdAt: new Date().toISOString(),
      }),
    );

    await waitFor(async () => (await readThread(harness))?.session?.status === "stopped");
    await harness.drain();
    const thread = await readThread(harness);
    expect(thread?.session?.activeTurnId).toBeNull();
    expect(thread?.session?.lastError).toBe(
      "No active provider session is running for this thread.",
    );
  });

  it("restarts the provider session in the new cwd when the thread moves to a worktree", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-cwd-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-cwd-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      cwd: harness.projectWorkspaceRoot,
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-thread-worktree-move"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        branch: "piedpiper/feature",
        worktreePath: harness.projectWorktreePath,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-cwd-2"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-cwd-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.startSession.mock.calls.length).toBe(2);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      cwd: harness.projectWorktreePath,
      resumeCursor: { opaque: "resume-1" },
    });

    // A third turn in the same cwd must not restart again.
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-cwd-3"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-cwd-3"),
          role: "user",
          text: "third",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await waitFor(() => harness.sendTurn.mock.calls.length === 3);
    expect(harness.startSession.mock.calls.length).toBe(2);
  });

  it("retries a stale session with a fresh start that discards the resume cursor", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.sendTurn.mockImplementationOnce(
      (_: unknown) =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: "codex",
            method: "turn/start",
            detail: "No conversation found with session ID: abc",
          }),
        ) as never,
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-stale"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-stale"),
          role: "user",
          text: "hello again",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.stopSession.mock.calls.length).toBe(1);
    expect(harness.startSession.mock.calls.length).toBe(2);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({ resumeCursor: null });
  });

  it("does not send a restart continuation into a fresh session when its cursor is stale", async () => {
    const harness = await createHarness();
    const threadId = ThreadId.makeUnsafe("thread-1");
    const now = new Date().toISOString();

    harness.sendTurn.mockImplementationOnce(
      (_: unknown) =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: "claudeAgent",
            method: "query",
            detail: "No conversation found with session ID: abc",
          }),
        ) as never,
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-stale-continuation"),
        threadId,
        message: {
          messageId: restartContinuationMessageId(asTurnId("turn-cut")),
          role: "user",
          text: RESTART_CONTINUATION_TEXT,
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.stopSession.mock.calls.length === 1);
    await settle(harness);

    expect(harness.sendTurn).toHaveBeenCalledTimes(1);
    expect(harness.startSession.mock.calls.map((call) => call[1])).not.toContainEqual(
      expect.objectContaining({ resumeCursor: null }),
    );
    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.get(threadId);
    expect(thread?.activities.map((activity) => activity.kind)).toContain(
      "provider.turn.start.failed",
    );
    expect(thread?.session?.activeTurnId).toBeNull();
  });

  it("starts a fresh session when only projected session state exists", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-projected-only"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-projected-only"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-projected-only"),
          role: "user",
          text: "resume codex",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      modelSelection: {
        provider: "codex",
        model: "gpt-5-codex",
      },
      runtimeMode: "approval-required",
    });
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
    });
  });

  it("reacts to thread.approval.respond by forwarding provider approval response", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-for-approval"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.approval.respond",
        commandId: CommandId.makeUnsafe("cmd-approval-respond"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        requestId: asApprovalRequestId("approval-request-1"),
        decision: "accept",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.respondToRequest.mock.calls.length === 1);
    expect(harness.respondToRequest.mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
      requestId: "approval-request-1",
      decision: "accept",
    });
  });

  it("reacts to thread.user-input.respond by forwarding structured user input answers", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-for-user-input"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.user-input.respond",
        commandId: CommandId.makeUnsafe("cmd-user-input-respond"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        requestId: asApprovalRequestId("user-input-request-1"),
        answers: {
          sandbox_mode: "workspace-write",
        },
        createdAt: now,
      }),
    );

    await waitFor(() => harness.respondToUserInput.mock.calls.length === 1);
    expect(harness.respondToUserInput.mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
      requestId: "user-input-request-1",
      answers: {
        sandbox_mode: "workspace-write",
      },
    });
  });

  it("surfaces stale provider approval request failures without faking approval resolution", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    harness.respondToRequest.mockImplementation(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: "codex",
          method: "session/request_permission",
          detail: "Unknown pending permission request: approval-request-1",
        }),
      ),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-for-approval-error"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.makeUnsafe("cmd-approval-requested"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        activity: {
          id: EventId.makeUnsafe("activity-approval-requested"),
          tone: "approval",
          kind: "approval.requested",
          summary: "Command approval requested",
          payload: {
            requestId: "approval-request-1",
            requestKind: "command",
          },
          turnId: null,
          createdAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.approval.respond",
        commandId: CommandId.makeUnsafe("cmd-approval-respond-stale"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        requestId: asApprovalRequestId("approval-request-1"),
        decision: "acceptForSession",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      const thread = readModel.threads.get(ThreadId.makeUnsafe("thread-1"));
      if (!thread) return false;
      return thread.activities.some(
        (activity) => activity.kind === "provider.approval.respond.failed",
      );
    });

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.get(ThreadId.makeUnsafe("thread-1"));
    expect(thread).toBeDefined();

    const failureActivity = thread?.activities.find(
      (activity) => activity.kind === "provider.approval.respond.failed",
    );
    expect(failureActivity).toBeDefined();
    expect(failureActivity?.payload).toMatchObject({
      requestId: "approval-request-1",
      detail: expect.stringContaining("Stale pending approval request: approval-request-1"),
    });

    const resolvedActivity = thread?.activities.find(
      (activity) =>
        activity.kind === "approval.resolved" &&
        typeof activity.payload === "object" &&
        activity.payload !== null &&
        (activity.payload as Record<string, unknown>).requestId === "approval-request-1",
    );
    expect(resolvedActivity).toBeUndefined();
  });

  it.each([
    "Unknown pending user-input request: user-input-request-1",
    // Codex's wording has no hyphen.
    "Unknown pending user input request: user-input-request-1",
  ])(
    "surfaces stale provider user-input failures without faking user-input resolution (%s)",
    async (detail) => {
      const harness = await createHarness();
      const now = new Date().toISOString();
      harness.respondToUserInput.mockImplementation(() =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: "claudeAgent",
            method: "item/tool/respondToUserInput",
            detail,
          }),
        ),
      );

      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.makeUnsafe("cmd-session-set-for-user-input-error"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          session: {
            threadId: ThreadId.makeUnsafe("thread-1"),
            status: "running",
            providerName: "claudeAgent",
            runtimeMode: "approval-required",
            activeTurnId: asTurnId("turn-still-running"),
            lastError: null,
            updatedAt: now,
          },
          createdAt: now,
        }),
      );

      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.activity.append",
          commandId: CommandId.makeUnsafe("cmd-user-input-requested"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          activity: {
            id: EventId.makeUnsafe("activity-user-input-requested"),
            tone: "info",
            kind: "user-input.requested",
            summary: "User input requested",
            payload: {
              requestId: "user-input-request-1",
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
            turnId: null,
            createdAt: now,
          },
          createdAt: now,
        }),
      );

      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.user-input.respond",
          commandId: CommandId.makeUnsafe("cmd-user-input-respond-stale"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          requestId: asApprovalRequestId("user-input-request-1"),
          answers: {
            sandbox_mode: "workspace-write",
          },
          createdAt: now,
        }),
      );

      await waitFor(async () => {
        const readModel = await Effect.runPromise(harness.engine.getReadModel());
        const thread = readModel.threads.get(ThreadId.makeUnsafe("thread-1"));
        if (!thread) return false;
        return thread.activities.some(
          (activity) => activity.kind === "provider.user-input.respond.failed",
        );
      });

      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      const thread = readModel.threads.get(ThreadId.makeUnsafe("thread-1"));
      expect(thread).toBeDefined();

      const failureActivity = thread?.activities.find(
        (activity) => activity.kind === "provider.user-input.respond.failed",
      );
      expect(failureActivity).toBeDefined();
      expect(failureActivity?.payload).toMatchObject({
        requestId: "user-input-request-1",
        detail: expect.stringContaining("Stale pending user-input request: user-input-request-1"),
      });

      const resolvedActivity = thread?.activities.find(
        (activity) =>
          activity.kind === "user-input.resolved" &&
          typeof activity.payload === "object" &&
          activity.payload !== null &&
          (activity.payload as Record<string, unknown>).requestId === "user-input-request-1",
      );
      expect(resolvedActivity).toBeUndefined();
    },
  );

  it("reacts to thread.session.stop by stopping provider session and clearing thread session state", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-for-stop"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.stop",
        commandId: CommandId.makeUnsafe("cmd-session-stop"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        createdAt: now,
      }),
    );

    await waitFor(() => harness.stopSession.mock.calls.length === 1);
    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.get(ThreadId.makeUnsafe("thread-1"));
    expect(thread?.session).not.toBeNull();
    expect(thread?.session?.status).toBe("stopped");
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.activeTurnId).toBeNull();
  });

  it("shows a failed session stop in the thread and keeps the session it could not stop", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-for-failed-stop"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );
    harness.stopSession.mockImplementationOnce(
      (_: unknown) =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: "codex",
            method: "session.stop",
            detail: "could not stop",
          }),
        ) as never,
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.stop",
        commandId: CommandId.makeUnsafe("cmd-session-stop-fails"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        createdAt: now,
      }),
    );

    await waitFor(async () =>
      Boolean(
        (await readThread(harness))?.activities.some(
          (activity) => activity.kind === "provider.session.stop.failed",
        ),
      ),
    );
    await harness.drain();
    const thread = await readThread(harness);
    expect(thread?.session?.status).toBe("ready");
    const failure = thread?.activities.find(
      (activity) => activity.kind === "provider.session.stop.failed",
    );
    expect(failure?.tone).toBe("error");
    expect(JSON.stringify(failure?.payload)).toContain("could not stop");
  });

  it("starts a stopped session again on the next message without discarding its resume state", async () => {
    const harness = await createHarness();
    await startTitledTurn(harness);
    expect(harness.startSession).toHaveBeenCalledTimes(1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.stop",
        commandId: CommandId.makeUnsafe("cmd-session-restart"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        createdAt: new Date().toISOString(),
      }),
    );
    await waitFor(() => harness.stopSession.mock.calls.length === 1);
    await harness.drain();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-after-restart"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-after-restart"),
          role: "user",
          text: "Carry on",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: new Date().toISOString(),
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.startSession).toHaveBeenCalledTimes(2);
    // No cursor at all means ProviderService resumes from the persisted binding; null would discard it.
    expect(harness.startSession.mock.calls[1]?.[1]).not.toHaveProperty("resumeCursor");
  });

  describe("question answers without a provider callback", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    type Harness = Awaited<ReturnType<typeof createHarness>>;
    let commandCounter = 0;
    const nextCommandId = (tag: string) => CommandId.makeUnsafe(`cmd-${tag}-${commandCounter++}`);

    type SessionInput = {
      readonly status: "ready" | "running" | "starting" | "stopped" | "interrupted" | "error";
      readonly activeTurnId?: TurnId;
      readonly providerName?: "codex" | "claudeAgent";
    };

    const setSessionEffect = (harness: Harness, session: SessionInput) => {
      const now = new Date().toISOString();
      return harness.engine.dispatch({
        type: "thread.session.set",
        commandId: nextCommandId("session-set"),
        threadId,
        session: {
          threadId,
          status: session.status,
          providerName: session.providerName ?? "codex",
          runtimeMode: "approval-required",
          activeTurnId: session.activeTurnId ?? null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      });
    };

    const setSession = (harness: Harness, session: SessionInput) =>
      Effect.runPromise(setSessionEffect(harness, session));

    const askQuestion = (
      harness: Harness,
      requestId: string,
      extra?: { readonly responseMode?: "message"; readonly sequence?: number },
    ) => {
      const now = new Date().toISOString();
      return Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.activity.append",
          commandId: nextCommandId("ask"),
          threadId,
          activity: {
            id: EventId.makeUnsafe(`activity-${requestId}`),
            tone: "info",
            kind: "user-input.requested",
            summary: "User input requested",
            payload: {
              requestId,
              ...(extra?.responseMode ? { responseMode: extra.responseMode } : {}),
              questions: [
                {
                  id: "sandbox_mode",
                  header: "Sandbox",
                  question: "Which mode should be used?",
                  options: [{ label: "workspace-write", description: "Workspace writes only" }],
                },
              ],
            },
            turnId: null,
            ...(extra?.sequence !== undefined ? { sequence: extra.sequence } : {}),
            createdAt: now,
          },
          createdAt: now,
        }),
      );
    };

    const answer = (
      harness: Harness,
      requestId: string,
      answers: Record<string, unknown> = { sandbox_mode: "workspace-write" },
    ) =>
      Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.user-input.respond",
          commandId: nextCommandId("answer"),
          threadId,
          requestId: asApprovalRequestId(requestId),
          answers,
          createdAt: new Date().toISOString(),
        }),
      );

    const failRespondWith = (harness: Harness, detail: string) =>
      harness.respondToUserInput.mockImplementation(() =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: "codex",
            method: "item/tool/respondToUserInput",
            detail,
          }),
        ),
      );

    const readThread = async (harness: Harness) => {
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      const thread = readModel.threads.get(threadId);
      if (!thread) throw new Error("expected the thread");
      return thread;
    };

    const activitiesOfKind = async (harness: Harness, kind: string) =>
      (await readThread(harness)).activities.filter((activity) => activity.kind === kind);

    it.each([
      "Unknown pending user-input request: req-1",
      "Unknown pending user input request: req-1",
    ])("answers a lost callback with a new turn (%s)", async (detail) => {
      const harness = await createHarness();
      await setSession(harness, { status: "ready" });
      await askQuestion(harness, "req-1", { sequence: 7 });
      failRespondWith(harness, detail);

      await answer(harness, "req-1");
      await settle(harness);

      await waitFor(() => harness.sendTurn.mock.calls.length === 1);
      expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
        input: "Which mode should be used?\nworkspace-write",
      });
      const thread = await readThread(harness);
      expect(thread.messages.map((message) => message.id)).toContain("async-answer:req-1");
      const resolved = thread.activities.filter((row) => row.kind === "user-input.resolved");
      expect(resolved).toHaveLength(1);
      // Written held, so a crash before the turn start cannot lose the answer; delivery clears it.
      expect(resolved[0]?.payload).toEqual({
        requestId: "req-1",
        responseMode: "message",
        answers: { sandbox_mode: "workspace-write" },
      });
      // Sorted after its request, or the panel would reopen.
      expect(resolved[0]?.sequence).toBe(8);
      expect(await activitiesOfKind(harness, "provider.user-input.respond.failed")).toHaveLength(0);
    });

    it("answers on a stopped session without asking the provider", async () => {
      const harness = await createHarness();
      await setSession(harness, { status: "stopped" });
      await askQuestion(harness, "req-stopped");

      await answer(harness, "req-stopped", { sandbox_mode: ["a", " b "] });
      await settle(harness);

      await waitFor(() => harness.sendTurn.mock.calls.length === 1);
      expect(harness.respondToUserInput).not.toHaveBeenCalled();
      expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
        input: "Which mode should be used?\na, b",
      });
      expect(await activitiesOfKind(harness, "provider.user-input.respond.failed")).toHaveLength(0);
    });

    it("starts no second turn and adds no error for a repeat answer", async () => {
      const harness = await createHarness();
      await setSession(harness, { status: "ready" });
      await askQuestion(harness, "req-repeat");
      failRespondWith(harness, "Unknown pending user input request: req-repeat");

      await answer(harness, "req-repeat");
      await settle(harness);
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);

      await expect(answer(harness, "req-repeat")).rejects.toThrow(
        "This question has already been answered.",
      );
      await settle(harness);

      expect(harness.sendTurn).toHaveBeenCalledTimes(1);
      expect(await activitiesOfKind(harness, "user-input.resolved")).toHaveLength(1);
      expect(await activitiesOfKind(harness, "provider.user-input.respond.failed")).toHaveLength(0);
    });

    it.each([
      { name: "a live session", status: "ready" as const, respondCalls: 2 },
      { name: "a stopped session", status: "stopped" as const, respondCalls: 0 },
    ])(
      "closes a second answer queued before the first is processed ($name)",
      async ({ status, respondCalls }) => {
        const harness = await createHarness();
        await setSession(harness, { status });
        await askQuestion(harness, "req-queued");
        failRespondWith(harness, "Unknown pending user input request: req-queued");

        // Dispatched together, so the decider accepts both before the first row is written.
        await Promise.all([
          answer(harness, "req-queued", { sandbox_mode: "first" }),
          answer(harness, "req-queued", { sandbox_mode: "second" }),
        ]);
        await settle(harness);

        await waitFor(() => harness.sendTurn.mock.calls.length === 1);
        await settle(harness);
        expect(harness.respondToUserInput).toHaveBeenCalledTimes(respondCalls);
        expect(harness.sendTurn).toHaveBeenCalledTimes(1);
        expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
          input: "Which mode should be used?\nfirst",
        });
        expect(await activitiesOfKind(harness, "user-input.resolved")).toHaveLength(1);
        expect(await activitiesOfKind(harness, "provider.user-input.respond.failed")).toHaveLength(
          0,
        );
      },
    );

    describe("a session that responding brought back after a restart", () => {
      const answerWhileRecovering = async (harness: Harness, requestId: string) => {
        await setSession(harness, { status: "running", activeTurnId: asTurnId("turn-cut") });
        await setSession(harness, { status: "error" });
        await askQuestion(harness, requestId);
        await settle(harness);
        expect((await readThread(harness)).latestTurn?.state).toBe("error");

        // Stands in for the adapter's connecting event, which beats the failed response here.
        harness.respondToUserInput.mockImplementation(
          () =>
            setSessionEffect(harness, { status: "starting" }).pipe(
              Effect.andThen(
                Effect.fail(
                  new ProviderAdapterRequestError({
                    provider: "codex",
                    method: "item/tool/respondToUserInput",
                    detail: `Unknown pending user input request: ${requestId}`,
                  }),
                ),
              ),
            ) as never,
        );

        await answer(harness, requestId);
        await settle(harness);

        expect(await activitiesOfKind(harness, "provider.user-input.respond.failed")).toHaveLength(
          0,
        );
        expect(await activitiesOfKind(harness, "user-input.resolved")).toHaveLength(1);
        expect(harness.sendTurn).not.toHaveBeenCalled();
      };

      it("holds the answer until the session is ready, then sends it once", async () => {
        const harness = await createHarness();
        await answerWhileRecovering(harness, "req-recovering");

        await setSession(harness, { status: "ready" });
        await settle(harness);

        await waitFor(() => harness.sendTurn.mock.calls.length === 1);
        await settle(harness);
        expect(harness.sendTurn).toHaveBeenCalledTimes(1);
        expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
          input: "Which mode should be used?\nworkspace-write",
        });
      });

      it("does not send the answer after the user stops the session", async () => {
        const harness = await createHarness();
        await answerWhileRecovering(harness, "req-recovering-stop");

        const now = new Date().toISOString();
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.session.stop",
            commandId: nextCommandId("stop"),
            threadId,
            createdAt: now,
          }),
        );
        await settle(harness);
        await setSession(harness, { status: "ready" });
        await settle(harness);

        expect(harness.sendTurn).not.toHaveBeenCalled();
      });
    });

    it("treats a starting session as busy, so a lost callback starts no turn", async () => {
      const harness = await createHarness();
      await setSession(harness, { status: "starting" });
      await askQuestion(harness, "req-starting");
      failRespondWith(harness, "Unknown pending user input request: req-starting");

      await answer(harness, "req-starting");
      await settle(harness);

      const failures = await activitiesOfKind(harness, "provider.user-input.respond.failed");
      expect(failures[0]?.payload).toMatchObject({
        detail: expect.stringContaining("Stale pending user-input request"),
      });
      expect(harness.sendTurn).not.toHaveBeenCalled();
    });

    it("counts a whitespace-only array as unanswered", async () => {
      const harness = await createHarness();
      await setSession(harness, { status: "ready" });
      await askQuestion(harness, "req-blank-array");
      failRespondWith(harness, "Unknown pending user input request: req-blank-array");

      await answer(harness, "req-blank-array", { sandbox_mode: ["", " "] });
      await settle(harness);

      expect(harness.sendTurn).not.toHaveBeenCalled();
    });

    it("keeps the stale failure when the answers are empty", async () => {
      const harness = await createHarness();
      await setSession(harness, { status: "ready" });
      await askQuestion(harness, "req-empty");
      failRespondWith(harness, "Unknown pending user input request: req-empty");

      await answer(harness, "req-empty", { sandbox_mode: "   " });
      await settle(harness);

      const failures = await activitiesOfKind(harness, "provider.user-input.respond.failed");
      expect(failures).toHaveLength(1);
      expect(failures[0]?.payload).toMatchObject({
        detail: expect.stringContaining("Stale pending user-input request"),
      });
      expect(harness.sendTurn).not.toHaveBeenCalled();
    });

    it("keeps the no-session failure when the question is not open", async () => {
      const harness = await createHarness();
      await setSession(harness, { status: "stopped" });

      await answer(harness, "req-never-asked");
      await settle(harness);

      const failures = await activitiesOfKind(harness, "provider.user-input.respond.failed");
      expect(failures[0]?.payload).toMatchObject({
        detail: "No active provider session is bound to this thread.",
      });
      expect(harness.sendTurn).not.toHaveBeenCalled();
    });

    it("does not start a turn for a stale approval", async () => {
      const harness = await createHarness();
      await setSession(harness, { status: "ready" });
      harness.respondToRequest.mockImplementation(() =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: "codex",
            method: "respondToRequest",
            detail: "Unknown pending approval request: approval-stale",
          }),
        ),
      );

      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.approval.respond",
          commandId: nextCommandId("approval"),
          threadId,
          requestId: asApprovalRequestId("approval-stale"),
          decision: "accept",
          createdAt: new Date().toISOString(),
        }),
      );
      await settle(harness);

      expect(await activitiesOfKind(harness, "provider.approval.respond.failed")).toHaveLength(1);
      expect(harness.sendTurn).not.toHaveBeenCalled();
    });

    it("sends a non-blocking answer straight away on an idle thread", async () => {
      const harness = await createHarness();
      await setSession(harness, { status: "ready" });
      await askQuestion(harness, "req-idle", { responseMode: "message" });

      await answer(harness, "req-idle");
      await settle(harness);

      await waitFor(() => harness.sendTurn.mock.calls.length === 1);
      expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
        input: "Which mode should be used?\nworkspace-write",
      });
      expect(harness.respondToUserInput).not.toHaveBeenCalled();
    });

    it("holds non-blocking answers until each turn settles, then sends them in order", async () => {
      const harness = await createHarness();
      await setSession(harness, { status: "running", activeTurnId: asTurnId("turn-busy") });
      await askQuestion(harness, "req-held-1", { responseMode: "message" });
      await askQuestion(harness, "req-held-2", { responseMode: "message" });

      await answer(harness, "req-held-1", { sandbox_mode: "first" });
      await answer(harness, "req-held-2", { sandbox_mode: "second" });
      await settle(harness);
      expect(harness.sendTurn).not.toHaveBeenCalled();
      expect(harness.respondToUserInput).not.toHaveBeenCalled();

      await setSession(harness, { status: "ready" });
      await settle(harness);
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);
      expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
        input: "Which mode should be used?\nfirst",
      });

      // A second settle signal before the first answer's turn has run must not send the next one.
      await setSession(harness, { status: "running", activeTurnId: asTurnId("turn-answer-1") });
      await settle(harness);
      expect(harness.sendTurn).toHaveBeenCalledTimes(1);

      await setSession(harness, { status: "ready" });
      await settle(harness);
      await waitFor(() => harness.sendTurn.mock.calls.length === 2);
      expect(harness.sendTurn.mock.calls[1]?.[0]).toMatchObject({
        input: "Which mode should be used?\nsecond",
      });

      await setSession(harness, { status: "ready" });
      await settle(harness);
      expect(harness.sendTurn).toHaveBeenCalledTimes(2);
    });

    describe("a held answer after a stop or failure", () => {
      const holdAnswer = async (harness: Harness, requestId: string) => {
        await setSession(harness, { status: "running", activeTurnId: asTurnId("turn-busy") });
        await askQuestion(harness, requestId, { responseMode: "message" });
        await answer(harness, requestId, { sandbox_mode: "held" });
        await settle(harness);
      };

      it("sends no turn once the session is interrupted", async () => {
        const harness = await createHarness();
        await holdAnswer(harness, "req-interrupted");
        await setSession(harness, { status: "interrupted" });
        await settle(harness);
        expect(harness.sendTurn).not.toHaveBeenCalled();
      });

      it("sends no turn after a session stop", async () => {
        const harness = await createHarness();
        await holdAnswer(harness, "req-stop");
        const now = new Date().toISOString();
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.session.stop",
            commandId: nextCommandId("stop"),
            threadId,
            createdAt: now,
          }),
        );
        await settle(harness);
        await setSession(harness, { status: "stopped" });
        await settle(harness);
        expect(harness.sendTurn).not.toHaveBeenCalled();
      });

      it("sends no turn when a goal command follows the stop", async () => {
        const harness = await createHarness();
        // No turn to settle as interrupted, so only the recorded stop holds the answer back.
        await setSession(harness, { status: "starting" });
        await askQuestion(harness, "req-stop-goal", { responseMode: "message" });
        await answer(harness, "req-stop-goal", { sandbox_mode: "held" });
        await settle(harness);
        const stoppedAt = new Date().toISOString();
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.session.stop",
            commandId: nextCommandId("stop"),
            threadId,
            createdAt: stoppedAt,
          }),
        );
        await settle(harness);
        await setSession(harness, { status: "stopped" });
        await settle(harness);

        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.turn.start",
            commandId: nextCommandId("goal-after-stop"),
            threadId,
            message: {
              messageId: asMessageId("goal-after-stop"),
              role: "user",
              text: "/goal",
              attachments: [],
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "approval-required",
            createdAt: new Date().toISOString(),
          }),
        );
        await settle(harness);
        await setSession(harness, { status: "ready" });
        await settle(harness);

        expect(harness.runGoalRequest).toHaveBeenCalledTimes(1);
        expect(harness.sendTurn).not.toHaveBeenCalled();
      });

      it("sends no turn on an archived thread", async () => {
        const harness = await createHarness();
        await holdAnswer(harness, "req-archived");
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.archive",
            commandId: nextCommandId("archive"),
            threadId,
          }),
        );
        await setSession(harness, { status: "ready" });
        await settle(harness);
        expect(harness.sendTurn).not.toHaveBeenCalled();
      });

      it("waits out a failed turn, then delivers at the next normal settle", async () => {
        const harness = await createHarness();
        await holdAnswer(harness, "req-failed");
        await setSession(harness, { status: "error" });
        await settle(harness);
        expect(harness.sendTurn).not.toHaveBeenCalled();

        await setSession(harness, { status: "running", activeTurnId: asTurnId("turn-next") });
        await setSession(harness, { status: "ready" });
        await settle(harness);
        await waitFor(() => harness.sendTurn.mock.calls.length === 1);
      });

      it("still delivers on the startup rescan with status stopped and a completed turn", async () => {
        const harness = await createHarness();
        await setSession(harness, { status: "running", activeTurnId: asTurnId("turn-done") });
        await setSession(harness, { status: "ready" });
        await setSession(harness, { status: "stopped" });
        await settle(harness);
        const now = new Date().toISOString();
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.activity.append",
            commandId: nextCommandId("held"),
            threadId,
            activity: {
              id: EventId.makeUnsafe("async-answer:req-rescan"),
              tone: "info",
              kind: "user-input.resolved",
              summary: "User input submitted",
              payload: {
                requestId: "req-rescan",
                responseMode: "message",
                answers: {},
                held: true,
                replyText: "Question?\nAnswer",
              },
              turnId: null,
              createdAt: now,
            },
            createdAt: now,
          }),
        );
        await settle(harness);
        expect(harness.sendTurn).not.toHaveBeenCalled();

        await Effect.runPromise(harness.reactor.start().pipe(Scope.provide(scope!)));
        await settle(harness);
        await waitFor(() => harness.sendTurn.mock.calls.length === 1);
      });
    });

    it("delivers a held answer found at startup", async () => {
      const harness = await createHarness();
      const now = new Date().toISOString();
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.activity.append",
          commandId: nextCommandId("held"),
          threadId,
          activity: {
            id: EventId.makeUnsafe("async-answer:req-restart"),
            tone: "info",
            kind: "user-input.resolved",
            summary: "User input submitted",
            payload: {
              requestId: "req-restart",
              responseMode: "message",
              answers: {},
              held: true,
              replyText: "Question?\nAnswer",
            },
            turnId: null,
            createdAt: now,
          },
          createdAt: now,
        }),
      );
      await settle(harness);
      expect(harness.sendTurn).not.toHaveBeenCalled();

      // Stands in for a server restart: start() rescans the read model.
      await Effect.runPromise(harness.reactor.start().pipe(Scope.provide(scope!)));
      await settle(harness);

      await waitFor(() => harness.sendTurn.mock.calls.length === 1);
      expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({ input: "Question?\nAnswer" });
    });
  });

  describe("image-only first messages", () => {
    const image = {
      type: "image" as const,
      id: "thread-1-11111111-1111-4111-8111-111111111111",
      name: "shot.png",
      mimeType: "image/png",
      sizeBytes: 10,
    };

    it.each([
      ["without Ultrathink", IMAGE_ONLY_BOOTSTRAP_PROMPT],
      ["with Ultrathink", `Ultrathink:\n${IMAGE_ONLY_BOOTSTRAP_PROMPT}`],
    ])("gives generation an empty message and the provider the prompt (%s)", async (_, text) => {
      const harness = await createHarness();
      const now = new Date().toISOString();
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.makeUnsafe("cmd-image-only-branch"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          branch: "piedpiper/1234abcd",
          worktreePath: harness.projectWorktreePath,
        }),
      );

      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe("cmd-image-only-turn"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          message: {
            messageId: asMessageId("user-message-image-only"),
            role: "user",
            text,
            attachments: [image],
          },
          titleSeed: "Thread",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        }),
      );

      await waitFor(() => harness.generateBranchName.mock.calls.length === 1);
      await waitFor(() => harness.generateThreadTitle.mock.calls.length >= 1);
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);
      expect(harness.generateBranchName.mock.calls[0]?.[0]).toMatchObject({
        message: "",
        attachments: [image],
      });
      expect(harness.generateThreadTitle.mock.calls[0]?.[0]).toMatchObject({
        message: "",
        attachments: [image],
      });
      expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
        input: text,
        attachments: [image],
      });
    });
  });

  describe("on-demand compaction", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    type Harness = Awaited<ReturnType<typeof createHarness>>;

    const sendText = (harness: Harness, id: string, text: string) =>
      Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe(`cmd-${id}`),
          threadId,
          message: { messageId: asMessageId(id), role: "user", text, attachments: [] },
          titleSeed: "Thread",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: new Date().toISOString(),
        }),
      );

    const setSessionStatus = (
      harness: Harness,
      id: string,
      status: "ready" | "running",
      activeTurnId: TurnId | null = null,
    ) => {
      const now = new Date().toISOString();
      return Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.makeUnsafe(`cmd-session-${id}`),
          threadId,
          session: {
            threadId,
            status,
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId,
            lastError: null,
            updatedAt: now,
          },
          createdAt: now,
        }),
      );
    };

    const startConversation = async (harness: Harness) => {
      await sendText(harness, "first-message", "hello");
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);
      await harness.drain();
      await setSessionStatus(harness, "conversation-ready", "ready");
      await harness.drain();
      harness.sendTurn.mockClear();
      harness.generateThreadTitle.mockClear();
      harness.generateBranchName.mockClear();
    };

    const failures = async (harness: Harness) => {
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      return (readModel.threads.get(threadId)?.activities ?? []).filter(
        (activity) => activity.kind === "provider.turn.start.failed",
      );
    };

    const session = async (harness: Harness) => {
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      return readModel.threads.get(threadId)?.session;
    };

    it("routes an exact Codex /compact to compactThread instead of a turn", async () => {
      const harness = await createHarness();
      await startConversation(harness);

      await sendText(harness, "compact-message", " /COMPACT ");
      await harness.drain();

      await waitFor(() => harness.compactThread.mock.calls.length === 1);
      expect(harness.compactThread.mock.calls[0]?.[0]).toEqual({ threadId });
      expect(harness.sendTurn).not.toHaveBeenCalled();
      expect((await session(harness))?.status).toBe("starting");
    });

    it("rejects /compact on an empty thread without naming it", async () => {
      const harness = await createHarness();

      await sendText(harness, "compact-empty", "/compact");
      await harness.drain();

      await waitFor(async () => (await failures(harness)).length === 1);
      const [failure] = await failures(harness);
      expect(failure?.summary).toBe("Context compaction failed");
      expect(failure?.payload).toMatchObject({
        detail: "Context compaction requires an existing conversation.",
      });
      expect(harness.compactThread).not.toHaveBeenCalled();
      expect(harness.sendTurn).not.toHaveBeenCalled();
      expect(harness.generateThreadTitle).not.toHaveBeenCalled();
      expect(harness.generateBranchName).not.toHaveBeenCalled();
    });

    it("names the thread from the first real message after a rejected /compact", async () => {
      const harness = await createHarness();
      await sendText(harness, "compact-before-first", "/compact");
      await harness.drain();
      await waitFor(async () => (await failures(harness)).length === 1);

      await sendText(harness, "first-real-message", "fix the header");
      await waitFor(() => harness.generateThreadTitle.mock.calls.length >= 1);
      expect(harness.generateThreadTitle.mock.calls[0]?.[0]).toMatchObject({
        message: "fix the header",
      });
    });

    it("rejects /compact while a turn is running and leaves the session alone", async () => {
      const harness = await createHarness();
      await startConversation(harness);
      await setSessionStatus(harness, "compact-running", "running", asTurnId("turn-busy"));

      await sendText(harness, "compact-busy", "/compact");
      await harness.drain();

      await waitFor(async () => (await failures(harness)).length === 1);
      expect((await failures(harness))[0]?.payload).toMatchObject({
        detail: "Context compaction is unavailable while a provider turn is running.",
      });
      expect(harness.compactThread).not.toHaveBeenCalled();
      const after = await session(harness);
      expect(after?.status).toBe("running");
      expect(after?.activeTurnId).toBe("turn-busy");
    });

    it("rejects a second /compact and a normal message while compacting", async () => {
      const harness = await createHarness();
      await startConversation(harness);
      const gate = Effect.runSync(Deferred.make<void>());
      harness.compactThread.mockImplementation(() => Deferred.await(gate));

      await sendText(harness, "compact-held", "/compact");
      await waitFor(() => harness.compactThread.mock.calls.length === 1);

      await sendText(harness, "normal-during-compact", "hello again");
      await waitFor(async () => (await failures(harness)).length === 1);
      expect((await failures(harness))[0]?.payload).toMatchObject({
        detail: "Wait for context compaction to finish before sending another message.",
      });
      expect(harness.sendTurn).not.toHaveBeenCalled();

      await sendText(harness, "compact-again", "/compact");
      await waitFor(async () => (await failures(harness)).length === 2);
      expect(harness.compactThread).toHaveBeenCalledTimes(1);

      Effect.runSync(Deferred.succeed(gate, undefined));
    });

    it("restores ready and reports the error when compaction fails", async () => {
      const harness = await createHarness();
      await startConversation(harness);
      harness.compactThread.mockImplementation(() =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: "codex",
            method: "thread/compact/start",
            detail: "This Codex CLI cannot compact on demand. Update Codex and try again.",
          }),
        ),
      );

      await sendText(harness, "compact-fails", "/compact");

      await waitFor(async () => (await failures(harness)).length === 1);
      const [failure] = await failures(harness);
      expect(failure?.summary).toBe("Context compaction failed");
      expect(failure?.payload).toMatchObject({
        detail: "This Codex CLI cannot compact on demand. Update Codex and try again.",
      });
      await waitFor(async () => (await session(harness))?.status === "ready");
      expect((await session(harness))?.lastError).toBeNull();

      // The set is released, so the thread accepts turns again.
      await sendText(harness, "after-failed-compact", "carry on");
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    });

    it("sends a Claude /compact through the normal turn path", async () => {
      const harness = await createHarness({
        threadModelSelection: { provider: "claudeAgent", model: "claude-sonnet-4-6" },
      });

      await sendText(harness, "claude-compact", "/compact");

      await waitFor(() => harness.sendTurn.mock.calls.length === 1);
      expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({ input: "/compact" });
      expect(harness.compactThread).not.toHaveBeenCalled();
      expect(harness.generateThreadTitle).not.toHaveBeenCalled();
      expect(harness.generateBranchName).not.toHaveBeenCalled();
    });

    describe("Codex /goal", () => {
      const pausedGoal = { objective: "Ship it", status: "paused" } as const;
      const assistantTexts = async (harness: Harness) => {
        const readModel = await Effect.runPromise(harness.engine.getReadModel());
        return (readModel.threads.get(threadId)?.messages ?? [])
          .filter((message) => message.role === "assistant")
          .map((message) => message.text);
      };

      it("sets the objective paused, sends it as the turn, then activates it", async () => {
        const harness = await createHarness();
        const order: string[] = [];
        harness.runGoalRequest.mockImplementation((input) =>
          Effect.sync(() => {
            order.push(`goal:${input.request.type}`);
            return { goal: null };
          }),
        );
        harness.sendTurn.mockImplementation((() =>
          Effect.sync(() => {
            order.push("turn");
            return {
              threadId,
              turnId: asTurnId("turn-goal"),
            };
          })) as never);

        await sendText(harness, "goal-set", "/goal Ship it");
        await waitFor(() => harness.runGoalRequest.mock.calls.length === 3);

        expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({ input: "Ship it" });
        expect(order).toEqual(["goal:get", "goal:set", "turn", "goal:set"]);
        expect(goalRequests(harness)).toEqual([
          { type: "get" },
          { type: "set", objective: "Ship it", status: "paused" },
          { type: "set", status: "active" },
        ]);
        await waitFor(() => harness.generateThreadTitle.mock.calls.length >= 1);
        expect(harness.generateThreadTitle.mock.calls[0]?.[0]).toMatchObject({
          message: "Ship it",
        });
      });

      it("replaces an existing goal when a new objective is set", async () => {
        const harness = await createHarness();
        harness.runGoalRequest.mockImplementation((input) =>
          Effect.succeed({ goal: input.request.type === "get" ? pausedGoal : null } as never),
        );
        await sendText(harness, "goal-replace", "/goal Next thing");
        await waitFor(() => harness.runGoalRequest.mock.calls.length === 4);
        expect(goalRequests(harness).map((request) => request.type)).toEqual([
          "get",
          "clear",
          "set",
          "set",
        ]);
      });

      it("does not fail the turn when activating the goal fails", async () => {
        const harness = await createHarness();
        harness.runGoalRequest.mockImplementation((input) =>
          input.request.type === "set" && input.request.status === "active"
            ? Effect.fail(
                new ProviderAdapterRequestError({
                  provider: "codex",
                  method: "thread/goal/set",
                  detail: "nope",
                }),
              )
            : Effect.succeed({ goal: null }),
        );
        await sendText(harness, "goal-activate-fails", "/goal Ship it");
        await waitFor(() => harness.runGoalRequest.mock.calls.length === 3);
        await harness.drain();
        expect(await failures(harness)).toEqual([]);
      });

      it("refuses an objective over the limit before touching the existing goal", async () => {
        const harness = await createHarness();
        await sendText(harness, "goal-too-long", `/goal ${"x".repeat(4_001)}`);
        await waitFor(async () => (await failures(harness)).length === 1);
        await harness.drain();
        expect((await failures(harness))[0]).toMatchObject({
          summary: "Goal command failed",
          payload: {
            detail:
              "The goal objective is 4001 characters; Codex supports at most 4000. Shorten it and send /goal again.",
          },
        });
        expect(harness.runGoalRequest).not.toHaveBeenCalled();
        expect(harness.startSession).not.toHaveBeenCalled();
        expect(harness.sendTurn).not.toHaveBeenCalled();
      });

      describe("when replacing a goal fails", () => {
        const requestFailure = (detail: string) =>
          new ProviderAdapterRequestError({
            provider: "codex",
            method: "thread/goal/set",
            detail,
          });
        const existingGoal = (harness: Harness, goal: ProviderGoal | null) =>
          harness.runGoalRequest.mockImplementation((input) =>
            input.request.type === "set" && input.request.objective === "Next thing"
              ? Effect.fail(requestFailure("set refused"))
              : Effect.succeed({ goal: input.request.type === "get" ? goal : null } as never),
          );
        const restoreRequests = [
          { type: "clear" },
          { type: "set", objective: "Ship it", status: "paused" },
        ];

        it("restores the previous goal paused and says so", async () => {
          const harness = await createHarness();
          existingGoal(harness, pausedGoal as unknown as ProviderGoal);
          await sendText(harness, "goal-replace-fails", "/goal Next thing");
          await waitFor(async () => (await failures(harness)).length === 1);
          await harness.drain();

          expect(goalRequests(harness)).toEqual([
            { type: "get" },
            { type: "clear" },
            { type: "set", objective: "Next thing", status: "paused" },
            ...restoreRequests,
          ]);
          expect(await assistantTexts(harness)).toEqual([
            "Your previous goal is back, paused, with its usage reset: Ship it",
          ]);
          expect(JSON.stringify((await failures(harness))[0]?.payload)).toContain("set refused");
          expect(harness.sendTurn).not.toHaveBeenCalled();
        });

        it("says the previous goal is gone when restoring it fails too", async () => {
          const harness = await createHarness();
          harness.runGoalRequest.mockImplementation((input) =>
            input.request.type === "set"
              ? Effect.fail(requestFailure("set refused"))
              : Effect.succeed({
                  goal: input.request.type === "get" ? pausedGoal : null,
                } as never),
          );
          await sendText(harness, "goal-restore-fails", "/goal Next thing");
          await waitFor(async () => (await failures(harness)).length === 1);
          await harness.drain();

          expect(await assistantTexts(harness)).toEqual([
            "Your previous goal was cleared and could not be restored: Ship it",
          ]);
          expect(JSON.stringify((await failures(harness))[0]?.payload)).toContain("set refused");
        });

        it("does not bring back a goal that was already complete", async () => {
          const harness = await createHarness();
          existingGoal(harness, {
            objective: "Ship it",
            status: "complete",
          } as unknown as ProviderGoal);
          await sendText(harness, "goal-replace-complete", "/goal Next thing");
          await waitFor(async () => (await failures(harness)).length === 1);
          await harness.drain();

          expect(goalRequests(harness).slice(3)).toEqual([{ type: "clear" }]);
          expect(await assistantTexts(harness)).toEqual([]);
        });

        it("removes the new objective when its turn cannot start", async () => {
          const harness = await createHarness();
          harness.sendTurn.mockImplementation(
            () => Effect.fail(requestFailure("turn refused")) as never,
          );
          await sendText(harness, "goal-turn-fails", "/goal Ship it");
          await waitFor(async () => (await failures(harness)).length === 1);
          await harness.drain();

          expect(goalRequests(harness)).toEqual([
            { type: "get" },
            { type: "set", objective: "Ship it", status: "paused" },
            { type: "clear" },
          ]);
          expect(await assistantTexts(harness)).toEqual([]);
        });

        it("puts the previous goal back when the new goal's turn cannot start", async () => {
          const harness = await createHarness();
          harness.runGoalRequest.mockImplementation((input) =>
            Effect.succeed({ goal: input.request.type === "get" ? pausedGoal : null } as never),
          );
          harness.sendTurn.mockImplementation(
            () => Effect.fail(requestFailure("turn refused")) as never,
          );
          await sendText(harness, "goal-turn-fails-replace", "/goal Next thing");
          await waitFor(async () => (await failures(harness)).length === 1);
          await harness.drain();

          expect(goalRequests(harness).slice(3)).toEqual(restoreRequests);
        });

        it("leaves a stale session's retry to set the goal fresh", async () => {
          const harness = await createHarness();
          harness.sendTurn.mockImplementationOnce(
            () => Effect.fail(requestFailure("thread does not exist")) as never,
          );
          await sendText(harness, "goal-stale", "/goal Ship it");
          await waitFor(() => harness.sendTurn.mock.calls.length === 2);
          await waitFor(() => harness.runGoalRequest.mock.calls.length === 5);
          await harness.drain();

          expect(goalRequests(harness)).toEqual([
            { type: "get" },
            { type: "set", objective: "Ship it", status: "paused" },
            { type: "get" },
            { type: "set", objective: "Ship it", status: "paused" },
            { type: "set", status: "active" },
          ]);
          expect(await failures(harness)).toEqual([]);
        });
      });

      it("does not count a goal reply as a conversation to compact", async () => {
        const harness = await createHarness();
        await sendText(harness, "goal-before-compact", "/goal");
        await waitFor(async () => (await assistantTexts(harness)).length === 1);
        await harness.drain();

        await sendText(harness, "compact-after-goal", "/compact");
        await waitFor(async () => (await failures(harness)).length === 1);
        await harness.drain();

        expect((await failures(harness))[0]?.payload).toMatchObject({
          detail: "Context compaction requires an existing conversation.",
        });
        expect(harness.compactThread).not.toHaveBeenCalled();
      });

      it("reports a CLI without goals and sends no turn", async () => {
        const harness = await createHarness();
        const detail = "This Codex CLI cannot use /goal. Update Codex and try again.";
        harness.runGoalRequest.mockImplementation(() =>
          Effect.fail(
            new ProviderAdapterRequestError({
              provider: "codex",
              method: "thread/goal/get",
              detail,
            }),
          ),
        );
        await sendText(harness, "goal-unsupported", "/goal Ship it");
        await waitFor(async () => (await failures(harness)).length === 1);
        expect(JSON.stringify((await failures(harness))[0]?.payload)).toContain(detail);
        expect(harness.sendTurn).not.toHaveBeenCalled();
      });

      it("answers a bare /goal without a turn or naming the thread", async () => {
        const harness = await createHarness();
        await sendText(harness, "goal-show-empty", "/goal");
        await waitFor(async () => (await assistantTexts(harness)).length === 1);
        expect(await assistantTexts(harness)).toEqual(["No goal is set."]);
        expect(goalRequests(harness)).toEqual([{ type: "get" }]);
        expect(harness.sendTurn).not.toHaveBeenCalled();
        expect(harness.generateThreadTitle).not.toHaveBeenCalled();
        expect(harness.generateBranchName).not.toHaveBeenCalled();

        await sendText(harness, "first-real-message", "fix the header");
        await waitFor(() => harness.generateThreadTitle.mock.calls.length >= 1);
        expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({ input: "fix the header" });
      });

      it.each([
        ["/goal", [{ type: "get" }], "Goal paused: Ship it"],
        [
          "/goal pause",
          [{ type: "get" }, { type: "set", status: "paused" }],
          "Goal paused. Send /goal resume to continue.",
        ],
        ["/goal resume", [{ type: "get" }, { type: "set", status: "active" }], "Goal resumed."],
        ["/goal clear", [{ type: "clear" }], "Goal cleared."],
      ])("runs %s as a control command", async (text, requests, reply) => {
        const harness = await createHarness();
        await startConversation(harness);
        harness.runGoalRequest.mockImplementation((input) =>
          Effect.succeed(
            (input.request.type === "clear"
              ? { goal: null, cleared: true }
              : { goal: pausedGoal }) as never,
          ),
        );
        await sendText(harness, "goal-control", text);
        await waitFor(async () => (await assistantTexts(harness)).includes(reply));
        expect(goalRequests(harness)).toEqual(requests);
        expect(harness.sendTurn).not.toHaveBeenCalled();
        expect((await session(harness))?.status).toBe("ready");
      });

      it("rejects goal commands while a turn is running", async () => {
        const harness = await createHarness();
        await startConversation(harness);
        await setSessionStatus(harness, "goal-running", "running", asTurnId("turn-busy"));

        await sendText(harness, "goal-busy", "/goal clear");
        await waitFor(async () => (await failures(harness)).length === 1);
        await sendText(harness, "goal-set-busy", "/goal Ship it");
        await waitFor(async () => (await failures(harness)).length === 2);

        expect((await failures(harness))[0]).toMatchObject({
          summary: "Goal command failed",
          payload: { detail: "Goal commands are unavailable while a provider turn is running." },
        });
        expect(harness.runGoalRequest).not.toHaveBeenCalled();
        expect(harness.sendTurn).not.toHaveBeenCalled();
        expect((await session(harness))?.activeTurnId).toBe("turn-busy");
      });

      const appendGoalReport = (harness: Harness, status: "active" | "paused") => {
        const now = new Date().toISOString();
        return Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.activity.append",
            commandId: CommandId.makeUnsafe(`cmd-goal-report-${status}`),
            threadId,
            activity: {
              id: EventId.makeUnsafe(`goal-report-${status}`),
              tone: "info",
              kind: "goal.updated",
              summary: "Goal updated",
              payload: { goal: { objective: "Ship it", status } },
              turnId: null,
              createdAt: now,
            },
            createdAt: now,
          }),
        );
      };
      const interrupt = (harness: Harness) => {
        const now = new Date().toISOString();
        return Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.turn.interrupt",
            commandId: CommandId.makeUnsafe("cmd-goal-interrupt"),
            threadId,
            createdAt: now,
          }),
        );
      };

      it("leaves pausing an active goal on Stop to the adapter", async () => {
        const harness = await createHarness();
        await startConversation(harness);
        await setSessionStatus(harness, "goal-stop", "running", asTurnId("turn-goal"));
        await appendGoalReport(harness, "active");
        await interrupt(harness);
        await waitFor(() => harness.interruptTurn.mock.calls.length === 1);
        expect(harness.runGoalRequest).not.toHaveBeenCalled();
      });

      it("leaves a Claude /goal on the normal turn path", async () => {
        const harness = await createHarness({
          threadModelSelection: { provider: "claudeAgent", model: "claude-sonnet-4-6" },
        });
        await sendText(harness, "claude-goal", "/goal Ship it");
        await waitFor(() => harness.sendTurn.mock.calls.length === 1);
        expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({ input: "/goal Ship it" });
        expect(harness.runGoalRequest).not.toHaveBeenCalled();
      });
    });
  });
});
