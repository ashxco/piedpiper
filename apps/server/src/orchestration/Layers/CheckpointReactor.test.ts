import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import type { ProviderKind, ProviderRuntimeEvent, ProviderSession } from "@piedpiper/contracts";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
} from "@piedpiper/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Exit, Layer, ManagedRuntime, PubSub, Scope, Stream } from "effect";
import { GitCommandError } from "@piedpiper/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CheckpointStoreLive } from "../../checkpointing/Layers/CheckpointStore.ts";
import {
  CheckpointStore,
  type CheckpointStoreShape,
} from "../../checkpointing/Services/CheckpointStore.ts";
import { CheckpointUnsupportedError } from "../../checkpointing/Errors.ts";
import { GitCoreLive } from "../../git/Layers/GitCore.ts";
import { GitManager } from "../../git/Services/GitManager.ts";
import { ProviderAdapterRequestError, type ProviderServiceError } from "../../provider/Errors.ts";
import { CheckpointReactorLive } from "./CheckpointReactor.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { RuntimeReceiptBusLive } from "./RuntimeReceiptBus.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { CheckpointReactor } from "../Services/CheckpointReactor.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import { checkpointRefForThreadTurn } from "../../checkpointing/Utils.ts";
import { ServerConfig } from "../../config.ts";
import { WorkspaceEntriesLive } from "../../workspace/Layers/WorkspaceEntries.ts";
import { WorkspacePathsLive } from "../../workspace/Layers/WorkspacePaths.ts";

const asProjectId = (value: string): ProjectId => ProjectId.makeUnsafe(value);
const asTurnId = (value: string): TurnId => TurnId.makeUnsafe(value);

type LegacyProviderRuntimeEvent = {
  readonly type: string;
  readonly eventId: EventId;
  readonly provider: ProviderKind;
  readonly createdAt: string;
  readonly threadId: ThreadId;
  readonly turnId?: string | undefined;
  readonly itemId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly payload?: unknown | undefined;
  readonly [key: string]: unknown;
};

function createProviderServiceHarness(
  cwd: string,
  hasSession = true,
  sessionCwd = cwd,
  providerName: ProviderSession["provider"] = "codex",
  extraSessions: ReadonlyArray<ProviderSession> = [],
  canRollback: () => Effect.Effect<boolean, never> = () => Effect.succeed(true),
  liveBackgroundTasks = 0,
) {
  const now = new Date().toISOString();
  const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
  const rollbackConversation = vi.fn(
    (_input: {
      readonly threadId: ThreadId;
      readonly numTurns: number;
    }): Effect.Effect<void, ProviderServiceError> => Effect.void,
  );

  const unsupported = <A>() =>
    Effect.die(new Error("Unsupported provider call in test")) as Effect.Effect<A, never>;
  const listSessions = () =>
    hasSession
      ? Effect.succeed([
          {
            provider: providerName,
            status: "ready",
            runtimeMode: "full-access",
            threadId: ThreadId.makeUnsafe("thread-1"),
            cwd: sessionCwd,
            createdAt: now,
            updatedAt: now,
          },
          ...extraSessions,
        ] satisfies ReadonlyArray<ProviderSession>)
      : Effect.succeed([...extraSessions] as ReadonlyArray<ProviderSession>);
  const service: ProviderServiceShape = {
    startSession: () => unsupported(),
    sendTurn: () => unsupported(),
    interruptTurn: () => unsupported(),
    respondToRequest: () => unsupported(),
    respondToUserInput: () => unsupported(),
    stopSession: () => unsupported(),
    listSessions,
    countLiveBackgroundTasks: () => Effect.succeed(liveBackgroundTasks),
    getCapabilities: () => Effect.succeed({ sessionModelSwitch: "in-session" }),
    compactThread: () => unsupported(),
    runGoalRequest: () => unsupported(),
    canRollbackConversation: canRollback,
    rollbackConversation,
    streamEvents: Stream.fromPubSub(runtimeEventPubSub),
    subscribeEvents: () => PubSub.subscribe(runtimeEventPubSub),
    subscribeToolInputPreview: () => PubSub.subscribe(runtimeEventPubSub),
  };

  const emit = (event: LegacyProviderRuntimeEvent): void => {
    Effect.runSync(PubSub.publish(runtimeEventPubSub, event as unknown as ProviderRuntimeEvent));
  };

  return {
    service,
    rollbackConversation,
    emit,
  };
}

async function waitForThread(
  engine: OrchestrationEngineShape,
  predicate: (thread: {
    latestTurn: { turnId: string } | null;
    checkpoints: ReadonlyArray<{ checkpointTurnCount: number }>;
    activities: ReadonlyArray<{ kind: string }>;
  }) => boolean,
  timeoutMs = 15_000,
) {
  const deadline = Date.now() + timeoutMs;
  const poll = async (): Promise<{
    latestTurn: { turnId: string } | null;
    checkpoints: ReadonlyArray<{ checkpointTurnCount: number }>;
    activities: ReadonlyArray<{ kind: string }>;
  }> => {
    const readModel = await Effect.runPromise(engine.getReadModel());
    const thread = readModel.threads.get(ThreadId.makeUnsafe("thread-1"));
    if (thread && predicate(thread)) {
      return thread;
    }
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for thread state.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    return poll();
  };
  return poll();
}

async function waitForEvent(
  engine: OrchestrationEngineShape,
  predicate: (event: { type: string }) => boolean,
  timeoutMs = 15_000,
) {
  const deadline = Date.now() + timeoutMs;
  const poll = async () => {
    const events = await Effect.runPromise(
      Stream.runCollect(engine.readEvents(0)).pipe(Effect.map((chunk) => Array.from(chunk))),
    );
    if (events.some(predicate)) {
      return events;
    }
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for orchestration event.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    return poll();
  };
  return poll();
}

function runGit(cwd: string, args: ReadonlyArray<string>) {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
}

function createGitRepository() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piedpiper-checkpoint-handler-"));
  runGit(cwd, ["init", "--initial-branch=main"]);
  runGit(cwd, ["config", "user.email", "test@example.com"]);
  runGit(cwd, ["config", "user.name", "Test User"]);
  fs.writeFileSync(path.join(cwd, "README.md"), "v1\n", "utf8");
  runGit(cwd, ["add", "."]);
  runGit(cwd, ["commit", "-m", "Initial"]);
  return cwd;
}

function gitRefExists(cwd: string, ref: string): boolean {
  try {
    runGit(cwd, ["show-ref", "--verify", "--quiet", ref]);
    return true;
  } catch {
    return false;
  }
}

function gitShowFileAtRef(cwd: string, ref: string, filePath: string): string {
  return runGit(cwd, ["show", `${ref}:${filePath}`]);
}

async function waitForGitRefExists(cwd: string, ref: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  const poll = async (): Promise<void> => {
    if (gitRefExists(cwd, ref)) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for git ref '${ref}'.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    return poll();
  };
  return poll();
}

describe("CheckpointReactor", () => {
  let runtime: ManagedRuntime.ManagedRuntime<
    OrchestrationEngineService | CheckpointReactor | CheckpointStore,
    unknown
  > | null = null;
  let scope: Scope.Closeable | null = null;
  const tempDirs: string[] = [];

  afterEach(async () => {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  async function createHarness(options?: {
    readonly wrapCheckpointStore?: (store: CheckpointStoreShape) => CheckpointStoreShape;
    readonly hasSession?: boolean;
    readonly seedFilesystemCheckpoints?: boolean;
    readonly projectWorkspaceRoot?: string;
    readonly threadWorktreePath?: string | null;
    readonly providerSessionCwd?: string;
    readonly providerName?: ProviderKind;
    readonly extraProviderSessions?: (cwd: string) => ReadonlyArray<ProviderSession>;
    readonly threadBranch?: string | null;
    readonly canRollback?: () => Effect.Effect<boolean, never>;
    readonly liveBackgroundTasks?: number;
  }) {
    const cwd = createGitRepository();
    tempDirs.push(cwd);
    // Records whether turn 1's checkpoint ref already existed when the PR refresh ran.
    const refreshCheckpointRefExisted: boolean[] = [];
    const refreshMissingPullRequest = vi.fn(
      (_input: { readonly cwd: string; readonly branch?: string | null }) =>
        Effect.sync(() => {
          refreshCheckpointRefExisted.push(
            gitRefExists(cwd, checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 1)),
          );
        }),
    );
    const provider = createProviderServiceHarness(
      cwd,
      options?.hasSession ?? true,
      options?.providerSessionCwd ?? cwd,
      options?.providerName ?? "codex",
      options?.extraProviderSessions?.(cwd) ?? [],
      options?.canRollback,
      options?.liveBackgroundTasks,
    );
    const orchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(SqlitePersistenceMemory),
    );

    const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
      prefix: "piedpiper-checkpoint-reactor-test-",
    });

    const layer = CheckpointReactorLive.pipe(
      Layer.provideMerge(orchestrationLayer),
      Layer.provideMerge(RuntimeReceiptBusLive),
      Layer.provideMerge(Layer.succeed(ProviderService, provider.service)),
      Layer.provideMerge(
        options?.wrapCheckpointStore
          ? Layer.effect(
              CheckpointStore,
              Effect.map(
                CheckpointStore.asEffect().pipe(Effect.provide(CheckpointStoreLive)),
                options.wrapCheckpointStore,
              ),
            )
          : CheckpointStoreLive,
      ),
      Layer.provideMerge(WorkspaceEntriesLive.pipe(Layer.provide(WorkspacePathsLive))),
      Layer.provideMerge(WorkspacePathsLive),
      Layer.provideMerge(Layer.mock(GitManager)({ refreshMissingPullRequest })),
      Layer.provideMerge(GitCoreLive),
      Layer.provideMerge(ServerConfigLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    runtime = ManagedRuntime.make(layer);
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const reactor = await runtime.runPromise(Effect.service(CheckpointReactor));
    const checkpointStore = await runtime.runPromise(Effect.service(CheckpointStore));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reactor.start().pipe(Scope.provide(scope)));
    const drain = () => Effect.runPromise(reactor.drain);

    const createdAt = new Date().toISOString();
    await Effect.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-create"),
        projectId: asProjectId("project-1"),
        title: "Test Project",
        workspaceRoot: options?.projectWorkspaceRoot ?? cwd,
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
        title: "Thread",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: options?.threadBranch ?? null,
        worktreePath: options?.threadWorktreePath ?? cwd,
        createdAt,
      }),
    );

    if (options?.seedFilesystemCheckpoints ?? true) {
      await runtime.runPromise(
        checkpointStore.captureCheckpoint({
          cwd,
          checkpointRef: checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 0),
        }),
      );
      fs.writeFileSync(path.join(cwd, "README.md"), "v2\n", "utf8");
      await runtime.runPromise(
        checkpointStore.captureCheckpoint({
          cwd,
          checkpointRef: checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 1),
        }),
      );
      fs.writeFileSync(path.join(cwd, "README.md"), "v3\n", "utf8");
      await runtime.runPromise(
        checkpointStore.captureCheckpoint({
          cwd,
          checkpointRef: checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 2),
        }),
      );
    }

    return {
      engine,
      provider,
      cwd,
      drain,
      refreshMissingPullRequest,
      refreshCheckpointRefExisted,
    };
  }

  it("captures pre-turn baseline on turn.started and post-turn checkpoint on turn.completed", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-capture"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.makeUnsafe("evt-turn-started-1"),
      provider: "codex",

      createdAt: new Date().toISOString(),
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: asTurnId("turn-1"),
    });
    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 0),
    );

    fs.writeFileSync(path.join(harness.cwd, "README.md"), "v2\n", "utf8");
    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.makeUnsafe("evt-turn-completed-1"),
      provider: "codex",

      createdAt: new Date().toISOString(),
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: asTurnId("turn-1"),
      payload: { state: "completed" },
    });

    await waitForEvent(harness.engine, (event) => event.type === "thread.turn-diff-completed");
    const thread = await waitForThread(
      harness.engine,
      (entry) => entry.latestTurn?.turnId === "turn-1" && entry.checkpoints.length === 1,
    );
    expect(thread.checkpoints[0]?.checkpointTurnCount).toBe(1);
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 0)),
    ).toBe(true);
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 1)),
    ).toBe(true);
    expect(
      gitShowFileAtRef(
        harness.cwd,
        checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 0),
        "README.md",
      ),
    ).toBe("v1\n");
    expect(
      gitShowFileAtRef(
        harness.cwd,
        checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 1),
        "README.md",
      ),
    ).toBe("v2\n");
  });

  it.each([
    { branch: "feature/pr", expectedCalls: 1 },
    { branch: null, expectedCalls: 0 },
  ])(
    "refreshes a missing PR lookup before the checkpoint when a turn completes on $branch",
    async ({ branch, expectedCalls }) => {
      const harness = await createHarness({
        seedFilesystemCheckpoints: false,
        threadBranch: branch,
      });
      const createdAt = new Date().toISOString();
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.makeUnsafe("cmd-session-set-pr-refresh"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          session: {
            threadId: ThreadId.makeUnsafe("thread-1"),
            status: "ready",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: null,
            lastError: null,
            updatedAt: createdAt,
          },
          createdAt,
        }),
      );

      harness.provider.emit({
        type: "turn.completed",
        eventId: EventId.makeUnsafe("evt-turn-completed-pr-refresh"),
        provider: "codex",
        createdAt: new Date().toISOString(),
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId: asTurnId("turn-1"),
        payload: { state: "completed" },
      });
      await waitForEvent(harness.engine, (event) => event.type === "thread.turn-diff-completed");

      expect(harness.refreshMissingPullRequest).toHaveBeenCalledTimes(expectedCalls);
      if (branch !== null) {
        expect(harness.refreshMissingPullRequest).toHaveBeenCalledWith({
          cwd: harness.cwd,
          branch,
        });
        expect(harness.refreshCheckpointRefExisted).toEqual([false]);
      }
    },
  );

  it("does not refresh the PR lookup when a turn on a branch is aborted", async () => {
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      threadBranch: "feature/pr",
    });
    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.makeUnsafe("evt-turn-started-pr-abort"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: asTurnId("turn-1"),
    });
    await harness.drain();
    harness.provider.emit({
      type: "turn.aborted",
      eventId: EventId.makeUnsafe("evt-turn-aborted-pr-abort"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: asTurnId("turn-1"),
      payload: { reason: "interrupted" },
    });

    await waitForThread(harness.engine, (entry) => entry.checkpoints.length === 1);
    expect(harness.refreshMissingPullRequest).not.toHaveBeenCalled();
  });

  it("ignores auxiliary thread turn completion while primary turn is active", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-primary-running"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-main"),
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.makeUnsafe("evt-turn-started-main"),
      provider: "codex",

      createdAt: new Date().toISOString(),
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: asTurnId("turn-main"),
    });
    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 0),
    );

    fs.writeFileSync(path.join(harness.cwd, "README.md"), "v2\n", "utf8");

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.makeUnsafe("evt-turn-completed-aux"),
      provider: "codex",

      createdAt: new Date().toISOString(),
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: asTurnId("turn-aux"),
      payload: { state: "completed" },
    });

    await harness.drain();
    const midReadModel = await Effect.runPromise(harness.engine.getReadModel());
    const midThread = midReadModel.threads.get(ThreadId.makeUnsafe("thread-1"));
    expect(midThread?.checkpoints).toHaveLength(0);

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.makeUnsafe("evt-turn-completed-main"),
      provider: "codex",

      createdAt: new Date().toISOString(),
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: asTurnId("turn-main"),
      payload: { state: "completed" },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) => entry.latestTurn?.turnId === "turn-main" && entry.checkpoints.length === 1,
    );
    expect(thread.checkpoints[0]?.checkpointTurnCount).toBe(1);
  });

  it("captures pre-turn and completion checkpoints for claude runtime events", async () => {
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      providerName: "claudeAgent",
    });
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-capture-claude"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.makeUnsafe("evt-turn-started-claude-1"),
      provider: "claudeAgent",
      createdAt: new Date().toISOString(),
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: asTurnId("turn-claude-1"),
    });
    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 0),
    );

    fs.writeFileSync(path.join(harness.cwd, "README.md"), "v2\n", "utf8");
    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.makeUnsafe("evt-turn-completed-claude-1"),
      provider: "claudeAgent",
      createdAt: new Date().toISOString(),
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: asTurnId("turn-claude-1"),
      payload: { state: "completed" },
    });

    await waitForEvent(harness.engine, (event) => event.type === "thread.turn-diff-completed");
    const thread = await waitForThread(
      harness.engine,
      (entry) => entry.latestTurn?.turnId === "turn-claude-1" && entry.checkpoints.length === 1,
    );

    expect(thread.checkpoints[0]?.checkpointTurnCount).toBe(1);
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 1)),
    ).toBe(true);
  });

  const setReadySession = (harness: Awaited<ReturnType<typeof createHarness>>, tag: string) => {
    const createdAt = new Date().toISOString();
    return Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe(`cmd-session-set-${tag}`),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );
  };

  it("captures a checkpoint without a summary or failure activity when the baseline is missing", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    await setReadySession(harness, "missing-baseline");

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.makeUnsafe("evt-turn-completed-missing-baseline"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: asTurnId("turn-missing-baseline"),
      payload: { state: "completed" },
    });

    await waitForEvent(harness.engine, (event) => event.type === "thread.turn-diff-completed");
    await harness.drain();
    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.get(ThreadId.makeUnsafe("thread-1"));
    expect(thread?.checkpoints[0]).toMatchObject({
      checkpointTurnCount: 1,
      status: "ready",
      files: [],
    });
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 1)),
    ).toBe(true);
    expect(
      thread?.activities.some((activity) => activity.kind === "checkpoint.capture.failed"),
    ).toBe(false);
  });

  it("leaves files a merged upstream brought in out of the turn's changed files", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    await setReadySession(harness, "pulled-files");
    const oldCommitEnv = {
      ...process.env,
      GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z",
      GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z",
    };
    runGit(harness.cwd, ["checkout", "-b", "upstream"]);
    fs.writeFileSync(path.join(harness.cwd, "pulled.txt"), "pulled\n", "utf8");
    runGit(harness.cwd, ["add", "."]);
    execFileSync("git", ["commit", "-m", "upstream"], { cwd: harness.cwd, env: oldCommitEnv });
    runGit(harness.cwd, ["checkout", "main"]);

    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.makeUnsafe("evt-turn-started-pulled-files"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: asTurnId("turn-pulled-files"),
    });
    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 0),
    );
    await harness.drain();
    runGit(harness.cwd, ["merge", "--ff-only", "upstream"]);
    fs.writeFileSync(path.join(harness.cwd, "README.md"), "edited\n", "utf8");
    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.makeUnsafe("evt-turn-completed-pulled-files"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: asTurnId("turn-pulled-files"),
      payload: { state: "completed" },
    });

    await waitForEvent(harness.engine, (event) => event.type === "thread.turn-diff-completed");
    await harness.drain();
    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.get(ThreadId.makeUnsafe("thread-1"));
    expect(thread?.checkpoints[0]?.files.map((file) => file.path)).toEqual(["README.md"]);
  });

  it("captures and finalizes a turn when the previous checkpoint lookup fails", async () => {
    let failLookup = false;
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      wrapCheckpointStore: (store) => ({
        ...store,
        hasCheckpointRef: (input) =>
          failLookup
            ? Effect.fail(
                new GitCommandError({
                  operation: "test.refLookup",
                  command: "git rev-parse",
                  cwd: input.cwd,
                  detail: "transient lookup spawn failure",
                }),
              )
            : store.hasCheckpointRef(input),
      }),
    });
    await setReadySession(harness, "lookup-failure");

    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.makeUnsafe("evt-turn-started-lookup-failure"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: asTurnId("turn-lookup-failure"),
    });
    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 0),
    );
    await harness.drain();
    fs.writeFileSync(path.join(harness.cwd, "README.md"), "new snapshot\n", "utf8");
    failLookup = true;
    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.makeUnsafe("evt-turn-completed-lookup-failure"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: asTurnId("turn-lookup-failure"),
      payload: { state: "completed" },
    });

    await waitForEvent(harness.engine, (event) => event.type === "thread.turn-diff-completed");
    await harness.drain();
    const ref = checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 1);
    expect(gitShowFileAtRef(harness.cwd, ref, "README.md")).toBe("new snapshot\n");
    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.get(ThreadId.makeUnsafe("thread-1"));
    expect(thread?.checkpoints[0]).toMatchObject({
      checkpointRef: ref,
      status: "ready",
      files: [],
    });
    expect(
      thread?.activities.some((activity) => activity.kind === "checkpoint.capture.failed"),
    ).toBe(false);
  });

  it("records an unsupported workspace as a missing checkpoint without a failure activity", async () => {
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      wrapCheckpointStore: (store) => ({
        ...store,
        captureCheckpoint: () =>
          Effect.fail(
            new CheckpointUnsupportedError({
              operation: "test.capture",
              detail: "The workspace directory is ignored by its Git repository.",
            }),
          ),
      }),
    });
    await setReadySession(harness, "unsupported");

    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.makeUnsafe("evt-turn-started-unsupported"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: asTurnId("turn-unsupported"),
    });
    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.makeUnsafe("evt-turn-completed-unsupported"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: asTurnId("turn-unsupported"),
      payload: { state: "completed" },
    });

    await waitForEvent(harness.engine, (event) => event.type === "thread.turn-diff-completed");
    await harness.drain();
    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.get(ThreadId.makeUnsafe("thread-1"));
    expect(thread?.checkpoints[0]).toMatchObject({ status: "missing", files: [] });
    expect(
      thread?.activities.some(
        (activity) =>
          activity.kind === "checkpoint.capture.failed" || activity.kind === "checkpoint.captured",
      ),
    ).toBe(false);
  });

  it("captures pre-turn baseline from project workspace root when thread worktree is unset", async () => {
    const harness = await createHarness({
      hasSession: false,
      seedFilesystemCheckpoints: false,
      threadWorktreePath: null,
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-for-baseline"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: MessageId.makeUnsafe("message-user-1"),
          role: "user",
          text: "start turn",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: new Date().toISOString(),
      }),
    );

    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 0),
    );
    expect(
      gitShowFileAtRef(
        harness.cwd,
        checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 0),
        "README.md",
      ),
    ).toBe("v1\n");
  });

  it("captures turn completion checkpoint from project workspace root when provider session cwd is unavailable", async () => {
    const harness = await createHarness({
      hasSession: false,
      seedFilesystemCheckpoints: false,
      threadWorktreePath: null,
    });
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-missing-provider-cwd"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-missing-cwd"),
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    fs.writeFileSync(path.join(harness.cwd, "README.md"), "v2\n", "utf8");
    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.makeUnsafe("evt-turn-completed-missing-provider-cwd"),
      provider: "codex",

      createdAt: new Date().toISOString(),
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: asTurnId("turn-missing-cwd"),
      payload: { state: "completed" },
    });

    await waitForEvent(harness.engine, (event) => event.type === "thread.turn-diff-completed");
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 1)),
    ).toBe(true);
    expect(
      gitShowFileAtRef(
        harness.cwd,
        checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 1),
        "README.md",
      ),
    ).toBe("v2\n");
  });

  it("ignores non-v2 checkpoint.captured runtime events", async () => {
    const harness = await createHarness();
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-checkpoint-captured"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    harness.provider.emit({
      type: "checkpoint.captured",
      eventId: EventId.makeUnsafe("evt-checkpoint-captured-3"),
      provider: "codex",

      createdAt: new Date().toISOString(),
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: asTurnId("turn-3"),
      turnCount: 3,
      status: "completed",
    });

    await harness.drain();
    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.get(ThreadId.makeUnsafe("thread-1"));
    expect(thread?.checkpoints.some((checkpoint) => checkpoint.checkpointTurnCount === 3)).toBe(
      false,
    );
  });

  it("continues processing runtime events after a single checkpoint runtime failure", async () => {
    const nonRepositorySessionCwd = fs.mkdtempSync(
      path.join(os.tmpdir(), "piedpiper-checkpoint-runtime-non-repo-"),
    );
    tempDirs.push(nonRepositorySessionCwd);

    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      providerSessionCwd: nonRepositorySessionCwd,
    });
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-non-repo-runtime"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.makeUnsafe("evt-runtime-capture-failure"),
      provider: "codex",

      createdAt: new Date().toISOString(),
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: asTurnId("turn-runtime-failure"),
      payload: { state: "completed" },
    });

    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.makeUnsafe("evt-turn-started-after-runtime-failure"),
      provider: "codex",

      createdAt: new Date().toISOString(),
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: asTurnId("turn-after-runtime-failure"),
    });

    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 0),
    );
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 0)),
    ).toBe(true);
  });

  it("executes provider revert and emits thread.reverted for checkpoint revert requests", async () => {
    const harness = await createHarness();
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.makeUnsafe("cmd-diff-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId: asTurnId("turn-1"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 1),
        status: "ready",
        files: [],
        checkpointTurnCount: 1,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.makeUnsafe("cmd-diff-2"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId: asTurnId("turn-2"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 2),
        status: "ready",
        files: [],
        checkpointTurnCount: 2,
        createdAt,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.makeUnsafe("cmd-revert-request"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnCount: 1,
        createdAt,
      }),
    );

    await waitForEvent(harness.engine, (event) => event.type === "thread.reverted");
    const thread = await waitForThread(harness.engine, (entry) => entry.checkpoints.length === 1);

    expect(thread.latestTurn?.turnId).toBe("turn-1");
    expect(thread.checkpoints).toHaveLength(1);
    expect(thread.checkpoints[0]?.checkpointTurnCount).toBe(1);
    expect(harness.provider.rollbackConversation).toHaveBeenCalledTimes(1);
    expect(harness.provider.rollbackConversation).toHaveBeenCalledWith({
      threadId: ThreadId.makeUnsafe("thread-1"),
      numTurns: 1,
    });
    expect(fs.readFileSync(path.join(harness.cwd, "README.md"), "utf8")).toBe("v2\n");
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 2)),
    ).toBe(false);
  });

  it("refuses a revert the provider cannot rewind, before touching any files", async () => {
    const harness = await createHarness({ canRollback: () => Effect.succeed(false) });
    const createdAt = new Date().toISOString();
    const threadId = ThreadId.makeUnsafe("thread-1");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set"),
        threadId,
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );
    for (const turn of [1, 2]) {
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.diff.complete",
          commandId: CommandId.makeUnsafe(`cmd-diff-${turn}`),
          threadId,
          turnId: asTurnId(`turn-${turn}`),
          completedAt: createdAt,
          checkpointRef: checkpointRefForThreadTurn(threadId, turn),
          status: "ready",
          files: [],
          checkpointTurnCount: turn,
          createdAt,
        }),
      );
    }
    const before = fs.readFileSync(path.join(harness.cwd, "README.md"), "utf8");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.makeUnsafe("cmd-revert-request"),
        threadId,
        turnCount: 1,
        createdAt,
      }),
    );

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some((activity) => activity.kind === "checkpoint.revert.failed"),
    );
    const failure = thread.activities.find(
      (activity) => activity.kind === "checkpoint.revert.failed",
    );
    expect(JSON.stringify((failure as { payload?: unknown } | undefined)?.payload)).toContain(
      "too old",
    );
    expect(thread.checkpoints).toHaveLength(2);
    expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(harness.cwd, "README.md"), "utf8")).toBe(before);
  });

  it("executes provider revert and emits thread.reverted for claude sessions", async () => {
    const harness = await createHarness({ providerName: "claudeAgent" });
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-claude"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.makeUnsafe("cmd-diff-claude-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId: asTurnId("turn-claude-1"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 1),
        status: "ready",
        files: [],
        checkpointTurnCount: 1,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.makeUnsafe("cmd-diff-claude-2"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId: asTurnId("turn-claude-2"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 2),
        status: "ready",
        files: [],
        checkpointTurnCount: 2,
        createdAt,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.makeUnsafe("cmd-revert-request-claude"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnCount: 1,
        createdAt,
      }),
    );

    await waitForEvent(harness.engine, (event) => event.type === "thread.reverted");
    expect(harness.provider.rollbackConversation).toHaveBeenCalledTimes(1);
    expect(harness.provider.rollbackConversation).toHaveBeenCalledWith({
      threadId: ThreadId.makeUnsafe("thread-1"),
      numTurns: 1,
    });
  });

  describe("background tasks across a revert", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");

    async function revertWithTaskRows(
      providerName: ProviderKind,
      completionTurn: string | null,
      startTurn = "turn-task-1",
      options: { readonly liveBackgroundTasks?: number; readonly turnCount?: number } = {},
    ) {
      const harness = await createHarness({
        providerName,
        ...(options.liveBackgroundTasks === undefined
          ? {}
          : { liveBackgroundTasks: options.liveBackgroundTasks }),
      });
      const createdAt = new Date().toISOString();
      const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

      await run(
        harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.makeUnsafe("cmd-session-set-task"),
          threadId,
          session: {
            threadId,
            status: "ready",
            providerName,
            runtimeMode: "approval-required",
            activeTurnId: null,
            lastError: null,
            updatedAt: createdAt,
          },
          createdAt,
        }),
      );
      for (const turn of [1, 2]) {
        await run(
          harness.engine.dispatch({
            type: "thread.turn.diff.complete",
            commandId: CommandId.makeUnsafe(`cmd-diff-task-${turn}`),
            threadId,
            turnId: asTurnId(`turn-task-${turn}`),
            completedAt: createdAt,
            checkpointRef: checkpointRefForThreadTurn(threadId, turn),
            status: "ready",
            files: [],
            checkpointTurnCount: turn,
            createdAt,
          }),
        );
      }
      await run(
        harness.engine.dispatch({
          type: "thread.activity.append",
          commandId: CommandId.makeUnsafe("cmd-task-started"),
          threadId,
          activity: {
            id: EventId.makeUnsafe("activity-task-started"),
            tone: "info",
            kind: "task.started",
            summary: "Task started",
            payload: { taskId: "task-kept" },
            turnId: asTurnId(startTurn),
            createdAt,
          },
          createdAt,
        }),
      );
      if (completionTurn !== null) {
        await run(
          harness.engine.dispatch({
            type: "thread.activity.append",
            commandId: CommandId.makeUnsafe("cmd-task-completed"),
            threadId,
            activity: {
              id: EventId.makeUnsafe("activity-task-completed"),
              tone: "info",
              kind: "task.completed",
              summary: "Task completed",
              payload: { taskId: "task-kept", status: "completed" },
              turnId: asTurnId(completionTurn),
              createdAt,
            },
            createdAt,
          }),
        );
      }
      await run(
        harness.engine.dispatch({
          type: "thread.checkpoint.revert",
          commandId: CommandId.makeUnsafe("cmd-revert-task"),
          threadId,
          turnCount: options.turnCount ?? 1,
          createdAt,
        }),
      );
      await waitForEvent(harness.engine, (event) => event.type === "thread.reverted");
      await harness.drain();
      const thread = (await run(harness.engine.getReadModel())).threads.get(threadId);
      return (thread?.activities ?? []).filter(
        (activity) => activity.kind === "task.started" || activity.kind === "task.completed",
      );
    }

    it("settles a kept turn's task whose completion was reverted on claude", async () => {
      const rows = await revertWithTaskRows("claudeAgent", "turn-task-2");
      expect(rows.map((row) => row.kind)).toEqual(["task.started", "task.completed"]);
      expect(rows[1]).toMatchObject({
        turnId: null,
        payload: { taskId: "task-kept", status: "stopped" },
      });
    });

    it("settles a kept turn's task that never reported a completion on claude", async () => {
      const rows = await revertWithTaskRows("claudeAgent", null);
      expect(rows.map((row) => row.kind)).toEqual(["task.started", "task.completed"]);
      expect(rows[1]).toMatchObject({ turnId: null, payload: { status: "stopped" } });
    });

    it("adds no settle row when the task's completion survives the revert", async () => {
      const rows = await revertWithTaskRows("claudeAgent", "turn-task-1");
      // Both rows carry the same timestamp, so their order is not the point here.
      expect(rows.map((row) => row.kind).toSorted()).toEqual(["task.completed", "task.started"]);
      expect(rows.find((row) => row.kind === "task.completed")).toMatchObject({
        payload: { status: "completed" },
      });
    });

    it("adds no settle row for a task whose start was reverted too", async () => {
      expect(await revertWithTaskRows("claudeAgent", null, "turn-task-2")).toEqual([]);
    });

    it("adds no settle row while the kept session still reports a running task", async () => {
      const rows = await revertWithTaskRows("claudeAgent", null, "turn-task-1", {
        liveBackgroundTasks: 1,
      });
      expect(rows.map((row) => row.kind)).toEqual(["task.started"]);
    });

    it("adds no settle row when the revert rewound no turns", async () => {
      const rows = await revertWithTaskRows("claudeAgent", null, "turn-task-1", { turnCount: 2 });
      expect(rows.map((row) => row.kind)).toEqual(["task.started"]);
    });

    it("adds no settle row on codex", async () => {
      const rows = await revertWithTaskRows("codex", null);
      expect(rows.map((row) => row.kind)).toEqual(["task.started"]);
    });
  });

  it("processes consecutive revert requests with deterministic rollback sequencing", async () => {
    const harness = await createHarness();
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-inline-revert"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.makeUnsafe("cmd-inline-revert-diff-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId: asTurnId("turn-1"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 1),
        status: "ready",
        files: [],
        checkpointTurnCount: 1,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.makeUnsafe("cmd-inline-revert-diff-2"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId: asTurnId("turn-2"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 2),
        status: "ready",
        files: [],
        checkpointTurnCount: 2,
        createdAt,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.makeUnsafe("cmd-sequenced-revert-request-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnCount: 1,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.makeUnsafe("cmd-sequenced-revert-request-0"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnCount: 0,
        createdAt,
      }),
    );

    await harness.drain();

    expect(harness.provider.rollbackConversation).toHaveBeenCalledTimes(2);
    expect(harness.provider.rollbackConversation.mock.calls[0]?.[0]).toEqual({
      threadId: ThreadId.makeUnsafe("thread-1"),
      numTurns: 1,
    });
    expect(harness.provider.rollbackConversation.mock.calls[1]?.[0]).toEqual({
      threadId: ThreadId.makeUnsafe("thread-1"),
      numTurns: 1,
    });
  });

  async function setSessionAndSeedTurns(
    harness: Awaited<ReturnType<typeof createHarness>>,
    prefix: string,
  ) {
    const createdAt = new Date().toISOString();
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe(`${prefix}-session-set`),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );
    for (const turnCount of [1, 2]) {
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.diff.complete",
          commandId: CommandId.makeUnsafe(`${prefix}-diff-${turnCount}`),
          threadId: ThreadId.makeUnsafe("thread-1"),
          turnId: asTurnId(`turn-${turnCount}`),
          completedAt: createdAt,
          checkpointRef: checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), turnCount),
          status: "ready",
          files: [],
          checkpointTurnCount: turnCount,
          createdAt,
        }),
      );
    }
  }

  async function createSiblingThread(
    harness: Awaited<ReturnType<typeof createHarness>>,
    worktreePath: string | null,
  ) {
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-create-sibling"),
        threadId: ThreadId.makeUnsafe("thread-2"),
        projectId: asProjectId("project-1"),
        title: "Sibling",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath,
        createdAt: new Date().toISOString(),
      }),
    );
  }

  it.each([
    { name: "shares the project root", sibling: (_cwd: string) => null },
    { name: "works in a nested directory", sibling: (cwd: string) => path.join(cwd, "nested") },
    { name: "works in an ancestor directory", sibling: (cwd: string) => path.dirname(cwd) },
    {
      name: "works through a symlinked alias",
      sibling: (cwd: string) => {
        const aliasParent = fs.mkdtempSync(path.join(os.tmpdir(), "piedpiper-sibling-alias-"));
        tempDirs.push(aliasParent);
        const alias = path.join(aliasParent, "alias");
        fs.symlinkSync(cwd, alias, "dir");
        return alias;
      },
    },
    {
      name: "is archived but shares the project root",
      sibling: (_cwd: string) => null,
      archiveSibling: true,
    },
  ])("refuses to restore files when another thread $name", async (testCase) => {
    const harness = await createHarness();
    const siblingPath = testCase.sibling(harness.cwd);
    if (siblingPath && !fs.existsSync(siblingPath)) fs.mkdirSync(siblingPath, { recursive: true });
    await createSiblingThread(harness, siblingPath);
    if ("archiveSibling" in testCase && testCase.archiveSibling) {
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.archive",
          commandId: CommandId.makeUnsafe("cmd-thread-archive-sibling"),
          threadId: ThreadId.makeUnsafe("thread-2"),
        }),
      );
    }
    await setSessionAndSeedTurns(harness, "cmd-shared-revert");
    fs.writeFileSync(path.join(harness.cwd, "sibling-work.txt"), "uncommitted\n", "utf8");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.makeUnsafe("cmd-shared-revert-request"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnCount: 1,
        createdAt: new Date().toISOString(),
      }),
    );
    await harness.drain();

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some((activity) => activity.kind === "checkpoint.revert.failed"),
    );
    expect(thread.checkpoints).toHaveLength(2);
    expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(harness.cwd, "README.md"), "utf8")).toBe("v3\n");
    expect(fs.readFileSync(path.join(harness.cwd, "sibling-work.txt"), "utf8")).toBe(
      "uncommitted\n",
    );
  });

  it("refuses to restore files when another thread's live session runs in the same cwd", async () => {
    const harness = await createHarness({
      extraProviderSessions: (cwd) => [
        {
          provider: "codex",
          status: "running",
          runtimeMode: "full-access",
          threadId: ThreadId.makeUnsafe("thread-conversation"),
          cwd,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    });
    await setSessionAndSeedTurns(harness, "cmd-session-shared-revert");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.makeUnsafe("cmd-session-shared-revert-request"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnCount: 1,
        createdAt: new Date().toISOString(),
      }),
    );
    await harness.drain();

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some((activity) => activity.kind === "checkpoint.revert.failed"),
    );
    expect(thread.checkpoints).toHaveLength(2);
    expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(harness.cwd, "README.md"), "utf8")).toBe("v3\n");
  });

  it("restores files when other threads use separate worktrees", async () => {
    const harness = await createHarness();
    const otherWorktree = fs.mkdtempSync(path.join(os.tmpdir(), "piedpiper-sibling-worktree-"));
    tempDirs.push(otherWorktree);
    await createSiblingThread(harness, otherWorktree);
    await setSessionAndSeedTurns(harness, "cmd-isolated-revert");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.makeUnsafe("cmd-isolated-revert-request"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnCount: 1,
        createdAt: new Date().toISOString(),
      }),
    );

    await waitForEvent(harness.engine, (event) => event.type === "thread.reverted");
    expect(harness.provider.rollbackConversation).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(path.join(harness.cwd, "README.md"), "utf8")).toBe("v2\n");
  });

  it("rewinds the conversation but keeps the working tree when restoreFiles is false", async () => {
    const harness = await createHarness();
    await setSessionAndSeedTurns(harness, "cmd-keep-files-revert");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.makeUnsafe("cmd-keep-files-revert-request"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnCount: 1,
        restoreFiles: false,
        createdAt: new Date().toISOString(),
      }),
    );

    await waitForEvent(harness.engine, (event) => event.type === "thread.reverted");
    const thread = await waitForThread(harness.engine, (entry) => entry.checkpoints.length === 1);
    expect(thread.checkpoints[0]?.checkpointTurnCount).toBe(1);
    expect(harness.provider.rollbackConversation).toHaveBeenCalledWith({
      threadId: ThreadId.makeUnsafe("thread-1"),
      numTurns: 1,
    });
    expect(fs.readFileSync(path.join(harness.cwd, "README.md"), "utf8")).toBe("v3\n");
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 2)),
    ).toBe(false);
  });

  const rollbackFailure = new ProviderAdapterRequestError({
    provider: "codex",
    method: "thread/rollback",
    detail: "too old for this Codex CLI to rewind",
  });

  const revertFailureDetails = async (engine: OrchestrationEngineShape) => {
    const readModel = await Effect.runPromise(engine.getReadModel());
    return (readModel.threads.get(ThreadId.makeUnsafe("thread-1"))?.activities ?? [])
      .filter((activity) => activity.kind === "checkpoint.revert.failed")
      .map((activity) => (activity.payload as { readonly detail: string }).detail);
  };

  it("reports restored files when the conversation rewind fails after a restore", async () => {
    const harness = await createHarness();
    await setSessionAndSeedTurns(harness, "cmd-rewind-fails-after-restore");
    harness.provider.rollbackConversation.mockImplementationOnce(() =>
      Effect.fail(rollbackFailure),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.makeUnsafe("cmd-rewind-fails-after-restore-request"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnCount: 1,
        createdAt: new Date().toISOString(),
      }),
    );
    await harness.drain();

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some((activity) => activity.kind === "checkpoint.revert.failed"),
    );
    expect(await revertFailureDetails(harness.engine)).toEqual([
      `Files were restored to turn 1, but the conversation could not be rewound: ${rollbackFailure.message}`,
    ]);
    expect(fs.readFileSync(path.join(harness.cwd, "README.md"), "utf8")).toBe("v2\n");
    expect(thread.checkpoints).toHaveLength(2);
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 2)),
    ).toBe(true);
  });

  it("does not claim restored files when a keep-files rewind fails", async () => {
    const harness = await createHarness();
    await setSessionAndSeedTurns(harness, "cmd-keep-files-rewind-fails");
    harness.provider.rollbackConversation.mockImplementationOnce(() =>
      Effect.fail(rollbackFailure),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.makeUnsafe("cmd-keep-files-rewind-fails-request"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnCount: 1,
        restoreFiles: false,
        createdAt: new Date().toISOString(),
      }),
    );
    await harness.drain();

    await waitForThread(harness.engine, (entry) =>
      entry.activities.some((activity) => activity.kind === "checkpoint.revert.failed"),
    );
    expect(await revertFailureDetails(harness.engine)).toEqual([rollbackFailure.message]);
    expect(fs.readFileSync(path.join(harness.cwd, "README.md"), "utf8")).toBe("v3\n");
  });

  it("allows a keep-files rewind when another thread shares the workspace", async () => {
    const harness = await createHarness();
    await createSiblingThread(harness, null);
    await setSessionAndSeedTurns(harness, "cmd-shared-keep-files");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.makeUnsafe("cmd-shared-restore-request"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnCount: 1,
        createdAt: new Date().toISOString(),
      }),
    );
    await harness.drain();
    await waitForThread(harness.engine, (entry) =>
      entry.activities.some((activity) => activity.kind === "checkpoint.revert.failed"),
    );
    expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.makeUnsafe("cmd-shared-keep-files-request"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnCount: 1,
        restoreFiles: false,
        createdAt: new Date().toISOString(),
      }),
    );

    await waitForEvent(harness.engine, (event) => event.type === "thread.reverted");
    await waitForThread(harness.engine, (entry) => entry.checkpoints.length === 1);
    expect(harness.provider.rollbackConversation).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(path.join(harness.cwd, "README.md"), "utf8")).toBe("v3\n");
  });

  it("captures the turn checkpoint on completion, not on a mid-turn diff placeholder", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const createdAt = new Date().toISOString();
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-placeholder"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-1"),
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );
    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.makeUnsafe("evt-turn-started-placeholder"),
      provider: "codex",
      createdAt,
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: asTurnId("turn-1"),
    });
    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 0),
    );

    fs.writeFileSync(path.join(harness.cwd, "README.md"), "v2\n", "utf8");
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.makeUnsafe("cmd-placeholder-diff"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId: asTurnId("turn-1"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 1),
        status: "missing",
        files: [],
        checkpointTurnCount: 1,
        createdAt,
      }),
    );
    await harness.drain();
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 1)),
    ).toBe(false);

    fs.writeFileSync(path.join(harness.cwd, "later.txt"), "one\ntwo\n", "utf8");
    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.makeUnsafe("evt-turn-completed-placeholder"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: asTurnId("turn-1"),
      payload: { state: "completed" },
    });

    const thread = (await waitForThread(harness.engine, (entry) =>
      entry.checkpoints.some(
        (checkpoint) => (checkpoint as { status?: string }).status === "ready",
      ),
    )) as unknown as {
      checkpoints: ReadonlyArray<{
        checkpointTurnCount: number;
        files: ReadonlyArray<{ path: string; additions: number; deletions: number }>;
      }>;
    };
    expect(thread.checkpoints).toHaveLength(1);
    expect(thread.checkpoints[0]?.checkpointTurnCount).toBe(1);
    expect(
      thread.checkpoints[0]?.files.map(({ path, additions, deletions }) => ({
        path,
        additions,
        deletions,
      })),
    ).toEqual([
      { path: "later.txt", additions: 2, deletions: 0 },
      { path: "README.md", additions: 1, deletions: 1 },
    ]);
    expect(
      gitShowFileAtRef(
        harness.cwd,
        checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 1),
        "later.txt",
      ),
    ).toBe("one\ntwo\n");
  });

  describe("assistant message the turn checkpoint points at", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const turnId = asTurnId("turn-1");
    const replyId = MessageId.makeUnsafe("assistant:reply");
    const imageId = MessageId.makeUnsafe("assistant:image:item-1");

    const completeTurnWithMessages = async (input: { readonly withReply: boolean }) => {
      const harness = await createHarness({ seedFilesystemCheckpoints: false });
      const createdAt = new Date().toISOString();
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.makeUnsafe("cmd-session-set-pointer"),
          threadId,
          session: {
            threadId,
            status: "running",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: createdAt,
          },
          createdAt,
        }),
      );
      harness.provider.emit({
        type: "turn.started",
        eventId: EventId.makeUnsafe("evt-turn-started-pointer"),
        provider: "codex",
        createdAt,
        threadId,
        turnId,
      });
      await waitForGitRefExists(harness.cwd, checkpointRefForThreadTurn(threadId, 0));

      if (input.withReply) {
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.message.assistant.delta",
            commandId: CommandId.makeUnsafe("cmd-reply-delta"),
            threadId,
            messageId: replyId,
            delta: "Here is your image.",
            turnId,
            createdAt,
          }),
        );
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.message.assistant.complete",
            commandId: CommandId.makeUnsafe("cmd-reply-complete"),
            threadId,
            messageId: replyId,
            turnId,
            createdAt,
          }),
        );
      }
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.message.assistant.complete",
          commandId: CommandId.makeUnsafe("cmd-image-complete"),
          threadId,
          messageId: imageId,
          attachments: [
            {
              type: "image",
              id: "thread-1-11111111-2222-3333-4444-555555555555",
              name: "image.png",
              mimeType: "image/png",
              sizeBytes: 10,
            },
          ],
          turnId,
          createdAt,
        }),
      );

      harness.provider.emit({
        type: "turn.completed",
        eventId: EventId.makeUnsafe("evt-turn-completed-pointer"),
        provider: "codex",
        createdAt: new Date().toISOString(),
        threadId,
        turnId,
        payload: { state: "completed" },
      });

      const thread = (await waitForThread(
        harness.engine,
        (entry) => entry.checkpoints.length > 0,
      )) as unknown as {
        checkpoints: ReadonlyArray<{ assistantMessageId: MessageId | null }>;
      };
      return thread.checkpoints[0];
    };

    it("stays on the reply when a generated image follows it", async () => {
      const checkpoint = await completeTurnWithMessages({ withReply: true });
      expect(checkpoint?.assistantMessageId).toBe(replyId);
    });

    it("binds to the image when the turn has no reply", async () => {
      const checkpoint = await completeTurnWithMessages({ withReply: false });
      expect(checkpoint?.assistantMessageId).toBe(imageId);
    });
  });

  it("captures a checkpoint when the tracked turn is aborted and ignores unrelated aborts", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const createdAt = new Date().toISOString();
    harness.provider.emit({
      type: "turn.aborted",
      eventId: EventId.makeUnsafe("evt-turn-aborted-unrelated"),
      provider: "codex",
      createdAt,
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: asTurnId("turn-unrelated"),
      payload: { reason: "interrupted" },
    });
    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.makeUnsafe("evt-turn-started-aborted"),
      provider: "codex",
      createdAt,
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: asTurnId("turn-1"),
    });
    await harness.drain();
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 1)),
    ).toBe(false);

    fs.writeFileSync(path.join(harness.cwd, "README.md"), "partial\n", "utf8");
    harness.provider.emit({
      type: "turn.aborted",
      eventId: EventId.makeUnsafe("evt-turn-aborted-1"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: asTurnId("turn-1"),
      payload: { reason: "interrupted" },
    });

    const thread = await waitForThread(harness.engine, (entry) => entry.checkpoints.length === 1);
    expect(thread.checkpoints[0]?.checkpointTurnCount).toBe(1);
    expect(
      gitShowFileAtRef(
        harness.cwd,
        checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 1),
        "README.md",
      ),
    ).toBe("partial\n");
  });

  it("appends an error activity when revert is requested without an active session", async () => {
    const harness = await createHarness({ hasSession: false });
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.makeUnsafe("cmd-revert-no-session"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnCount: 1,
        createdAt,
      }),
    );

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some((activity) => activity.kind === "checkpoint.revert.failed"),
    );

    expect(thread.activities.some((activity) => activity.kind === "checkpoint.revert.failed")).toBe(
      true,
    );
    expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
  });
});
