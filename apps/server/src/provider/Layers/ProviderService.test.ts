import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  ProviderApprovalDecision,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderTurnStartResult,
} from "@piedpiper/contracts";
import {
  ApprovalRequestId,
  EventId,
  type ProviderKind,
  ProviderSessionStartInput,
  ThreadId,
  TurnId,
} from "@piedpiper/contracts";
import { describe, it, assert, vi } from "@effect/vitest";
import { assertFailure } from "@effect/vitest/utils";

import { Effect, Fiber, Layer, Metric, Option, PubSub, Ref, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  ProviderAdapterSessionNotFoundError,
  ProviderSessionDirectoryPersistenceError,
  ProviderSessionNotFoundError,
  ProviderUnsupportedError,
  ProviderValidationError,
  type ProviderAdapterError,
  type ProviderServiceError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { ProviderAdapterRegistry } from "../Services/ProviderAdapterRegistry.ts";
import { ProviderService, type ProviderServiceShape } from "../Services/ProviderService.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import { appendAttachmentPathsToInput, makeProviderServiceLive } from "./ProviderService.ts";
import { ProviderSessionDirectoryLive } from "./ProviderSessionDirectory.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderSessionRuntimeRepositoryLive } from "../../persistence/Layers/ProviderSessionRuntime.ts";
import { ProviderSessionRuntimeRepository } from "../../persistence/Services/ProviderSessionRuntime.ts";
import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../../persistence/Layers/Sqlite.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ServerConfig } from "../../config.ts";
import { AnalyticsService } from "../../telemetry/Services/AnalyticsService.ts";
import { RESTART_CONTINUATION_MARKER_KEY } from "../../orchestration/restartContinuation.ts";

const defaultServerSettingsLayer = ServerSettingsService.layerTest();

const asRequestId = (value: string): ApprovalRequestId => ApprovalRequestId.makeUnsafe(value);
const asEventId = (value: string): EventId => EventId.makeUnsafe(value);
const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);
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

function makeFakeCodexAdapter(provider: ProviderKind = "codex") {
  const sessions = new Map<ThreadId, ProviderSession>();
  const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());

  const startSession = vi.fn((input: ProviderSessionStartInput) =>
    Effect.sync(() => {
      const now = new Date().toISOString();
      const session: ProviderSession = {
        provider,
        status: "ready",
        runtimeMode: input.runtimeMode,
        threadId: input.threadId,
        resumeCursor: input.resumeCursor ?? { opaque: `resume-${String(input.threadId)}` },
        cwd: input.cwd ?? process.cwd(),
        createdAt: now,
        updatedAt: now,
      };
      sessions.set(session.threadId, session);
      return session;
    }),
  );

  const sendTurn = vi.fn(
    (
      input: ProviderSendTurnInput,
    ): Effect.Effect<ProviderTurnStartResult, ProviderAdapterError> => {
      if (!sessions.has(input.threadId)) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({
            provider,
            threadId: input.threadId,
          }),
        );
      }

      return Effect.succeed({
        threadId: input.threadId,
        turnId: TurnId.makeUnsafe(`turn-${String(input.threadId)}`),
      });
    },
  );

  const interruptTurn = vi.fn(
    (_threadId: ThreadId, _turnId?: TurnId): Effect.Effect<void, ProviderAdapterError> =>
      Effect.void,
  );

  const respondToRequest = vi.fn(
    (
      _threadId: ThreadId,
      _requestId: string,
      _decision: ProviderApprovalDecision,
    ): Effect.Effect<void, ProviderAdapterError> => Effect.void,
  );

  const respondToUserInput = vi.fn(
    (
      _threadId: ThreadId,
      _requestId: string,
      _answers: Record<string, unknown>,
    ): Effect.Effect<void, ProviderAdapterError> => Effect.void,
  );

  const stopSession = vi.fn(
    (threadId: ThreadId): Effect.Effect<void, ProviderAdapterError> =>
      Effect.sync(() => {
        sessions.delete(threadId);
      }),
  );

  const listSessions = vi.fn(
    (): Effect.Effect<ReadonlyArray<ProviderSession>> =>
      Effect.sync(() => Array.from(sessions.values())),
  );

  const hasSession = vi.fn(
    (threadId: ThreadId): Effect.Effect<boolean> => Effect.succeed(sessions.has(threadId)),
  );

  const readThread = vi.fn(
    (
      threadId: ThreadId,
    ): Effect.Effect<
      {
        threadId: ThreadId;
        turns: ReadonlyArray<{ id: TurnId; items: readonly [] }>;
      },
      ProviderAdapterError
    > =>
      Effect.succeed({
        threadId,
        turns: [{ id: asTurnId("turn-1"), items: [] }],
      }),
  );

  const rollbackThread = vi.fn(
    (
      threadId: ThreadId,
      _numTurns: number,
    ): Effect.Effect<{ threadId: ThreadId; turns: readonly [] }, ProviderAdapterError> =>
      Effect.succeed({ threadId, turns: [] }),
  );

  const stopAll = vi.fn(
    (): Effect.Effect<void, ProviderAdapterError> =>
      Effect.sync(() => {
        sessions.clear();
      }),
  );

  const adapter: ProviderAdapterShape<ProviderAdapterError> = {
    provider,
    capabilities: {
      sessionModelSwitch: "in-session",
    },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    readThread,
    rollbackThread,
    stopAll,
    streamEvents: Stream.fromPubSub(runtimeEventPubSub),
  };

  const emit = (event: LegacyProviderRuntimeEvent): void => {
    Effect.runSync(PubSub.publish(runtimeEventPubSub, event as unknown as ProviderRuntimeEvent));
  };

  const updateSession = (
    threadId: ThreadId,
    update: (session: ProviderSession) => ProviderSession,
  ): void => {
    const existing = sessions.get(threadId);
    if (!existing) {
      return;
    }
    sessions.set(threadId, update(existing));
  };

  return {
    adapter,
    emit,
    updateSession,
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    readThread,
    rollbackThread,
    stopAll,
  };
}

const sleep = (ms: number) =>
  Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

const hasMetricSnapshot = (
  snapshots: ReadonlyArray<Metric.Metric.Snapshot>,
  id: string,
  attributes: Readonly<Record<string, string>>,
) =>
  snapshots.some(
    (snapshot) =>
      snapshot.id === id &&
      Object.entries(attributes).every(([key, value]) => snapshot.attributes?.[key] === value),
  );

function makeProviderServiceLayer() {
  const codex = makeFakeCodexAdapter();
  const claude = makeFakeCodexAdapter("claudeAgent");
  const registry: typeof ProviderAdapterRegistry.Service = {
    getByProvider: (provider) =>
      provider === "codex"
        ? Effect.succeed(codex.adapter)
        : provider === "claudeAgent"
          ? Effect.succeed(claude.adapter)
          : Effect.fail(new ProviderUnsupportedError({ provider })),
    listProviders: () => Effect.succeed(["codex", "claudeAgent"]),
  };

  const providerAdapterLayer = Layer.succeed(ProviderAdapterRegistry, registry);
  const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
    Layer.provide(SqlitePersistenceMemory),
  );
  const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));

  const layer = it.layer(
    Layer.mergeAll(
      makeProviderServiceLive().pipe(
        Layer.provide(providerAdapterLayer),
        Layer.provide(directoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provideMerge(AnalyticsService.layerTest),
      ),
      directoryLayer,

      runtimeRepositoryLayer,
      NodeServices.layer,
    ),
  );

  return {
    codex,
    claude,
    layer,
  };
}

it("appendAttachmentPathsToInput lists each attachment path after the user text", () => {
  const attachment = {
    type: "image" as const,
    id: "thread-1-11111111-1111-4111-8111-111111111111",
    name: "shot.png",
    mimeType: "image/png",
    sizeBytes: 10,
  };
  const attachmentsDir = path.join(os.tmpdir(), "pp-attachments");
  const expectedLine = `[Attached image "shot.png" is saved at: ${path.join(attachmentsDir, `${attachment.id}.png`)}]`;

  assert.equal(
    appendAttachmentPathsToInput("/review look at this", [attachment], attachmentsDir),
    `/review look at this\n\n${expectedLine}`,
  );
  assert.equal(appendAttachmentPathsToInput(undefined, [attachment], attachmentsDir), expectedLine);
  assert.equal(appendAttachmentPathsToInput("hello", [], attachmentsDir), "hello");
  assert.equal(appendAttachmentPathsToInput(undefined, [], attachmentsDir), undefined);
});

it("appendAttachmentPathsToInput lists a PDF under its .pdf path", () => {
  const attachment = {
    type: "file" as const,
    id: "thread-1-22222222-2222-4222-8222-222222222222",
    name: "spec.pdf",
    mimeType: "application/pdf" as const,
    sizeBytes: 10,
  };
  const attachmentsDir = path.join(os.tmpdir(), "pp-attachments");

  assert.equal(
    appendAttachmentPathsToInput("read this", [attachment], attachmentsDir),
    `read this\n\n[Attached file "spec.pdf" is saved at: ${path.join(attachmentsDir, `${attachment.id}.pdf`)}]`,
  );
});

it.effect("ProviderServiceLive tells the adapter where attachments are saved", () =>
  Effect.gen(function* () {
    const codex = makeFakeCodexAdapter();
    const registry: typeof ProviderAdapterRegistry.Service = {
      getByProvider: (provider) =>
        provider === "codex"
          ? Effect.succeed(codex.adapter)
          : Effect.fail(new ProviderUnsupportedError({ provider })),
      listProviders: () => Effect.succeed(["codex"]),
    };
    const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
    const providerLayer = makeProviderServiceLive().pipe(
      Layer.provide(Layer.succeed(ProviderAdapterRegistry, registry)),
      Layer.provide(directoryLayer),
      Layer.provide(defaultServerSettingsLayer),
      Layer.provide(AnalyticsService.layerTest),
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), { prefix: "pp-provider-attachments-" }),
      ),
      Layer.provide(NodeServices.layer),
    );

    yield* Effect.gen(function* () {
      const provider = yield* ProviderService;
      const config = yield* ServerConfig;
      const threadId = asThreadId("thread-attachments");
      yield* provider.startSession(threadId, {
        provider: "codex",
        threadId,
        runtimeMode: "full-access",
      });
      const attachment = {
        type: "image" as const,
        id: "thread-attachments-11111111-1111-4111-8111-111111111111",
        name: "shot.png",
        mimeType: "image/png",
        sizeBytes: 10,
      };
      yield* provider.sendTurn({
        threadId,
        input: "put this in the PR",
        attachments: [attachment],
      });

      const sent = codex.sendTurn.mock.calls[0]?.[0];
      assert.equal(
        sent?.input,
        `put this in the PR\n\n[Attached image "shot.png" is saved at: ${path.join(config.attachmentsDir, `${attachment.id}.png`)}]`,
      );
      assert.deepEqual(sent?.attachments, [attachment]);
    }).pipe(Effect.provide(providerLayer));
  }),
);

it.effect("ProviderServiceLive routes live background task counts to the adapter", () =>
  Effect.gen(function* () {
    const codex = makeFakeCodexAdapter();
    const claude = makeFakeCodexAdapter("claudeAgent");
    const claudeAdapter = {
      ...claude.adapter,
      countLiveBackgroundTasks: (threadId: ThreadId) =>
        Effect.succeed(threadId === asThreadId("thread-busy") ? 2 : 0),
    };
    const registry: typeof ProviderAdapterRegistry.Service = {
      getByProvider: (provider) =>
        provider === "codex"
          ? Effect.succeed(codex.adapter)
          : provider === "claudeAgent"
            ? Effect.succeed(claudeAdapter)
            : Effect.fail(new ProviderUnsupportedError({ provider })),
      listProviders: () => Effect.succeed(["codex", "claudeAgent"]),
    };
    const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
    const providerLayer = makeProviderServiceLive().pipe(
      Layer.provide(Layer.succeed(ProviderAdapterRegistry, registry)),
      Layer.provide(directoryLayer),
      Layer.provide(defaultServerSettingsLayer),
      Layer.provide(AnalyticsService.layerTest),
      Layer.provide(NodeServices.layer),
    );

    yield* Effect.gen(function* () {
      const provider = yield* ProviderService;
      const count = provider.countLiveBackgroundTasks!;
      assert.equal(
        yield* count({ threadId: asThreadId("thread-busy"), provider: "claudeAgent" }),
        2,
      );
      assert.equal(
        yield* count({ threadId: asThreadId("thread-idle"), provider: "claudeAgent" }),
        0,
      );
      // Adapters that do not report tasks count as none.
      assert.equal(yield* count({ threadId: asThreadId("thread-busy"), provider: "codex" }), 0);
    }).pipe(Effect.provide(providerLayer));
  }),
);

it.effect("ProviderServiceLive rejects new sessions for disabled providers", () =>
  Effect.gen(function* () {
    const codex = makeFakeCodexAdapter();
    const claude = makeFakeCodexAdapter("claudeAgent");
    const registry: typeof ProviderAdapterRegistry.Service = {
      getByProvider: (provider) =>
        provider === "codex"
          ? Effect.succeed(codex.adapter)
          : provider === "claudeAgent"
            ? Effect.succeed(claude.adapter)
            : Effect.fail(new ProviderUnsupportedError({ provider })),
      listProviders: () => Effect.succeed(["codex", "claudeAgent"]),
    };
    const providerAdapterLayer = Layer.succeed(ProviderAdapterRegistry, registry);
    const serverSettingsLayer = ServerSettingsService.layerTest({
      providers: {
        claudeAgent: {
          enabled: false,
        },
      },
    });
    const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
    const providerLayer = makeProviderServiceLive().pipe(
      Layer.provide(providerAdapterLayer),
      Layer.provide(directoryLayer),
      Layer.provide(serverSettingsLayer),
      Layer.provide(AnalyticsService.layerTest),
    );

    const failure = yield* Effect.flip(
      Effect.gen(function* () {
        const provider = yield* ProviderService;
        return yield* provider.startSession(asThreadId("thread-disabled"), {
          provider: "claudeAgent",
          threadId: asThreadId("thread-disabled"),
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(providerLayer)),
    );

    assert.instanceOf(failure, ProviderValidationError);
    assert.include(failure.issue, "Provider 'claudeAgent' is disabled in Pied Piper settings.");
    assert.equal(claude.startSession.mock.calls.length, 0);
  }).pipe(Effect.provide(NodeServices.layer)),
);

const routing = makeProviderServiceLayer();
it.effect("ProviderServiceLive keeps persisted resumable sessions on startup", () =>
  Effect.gen(function* () {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "piedpiper-provider-service-"));
    const dbPath = path.join(tempDir, "orchestration.sqlite");

    const codex = makeFakeCodexAdapter();
    const registry: typeof ProviderAdapterRegistry.Service = {
      getByProvider: (provider) =>
        provider === "codex"
          ? Effect.succeed(codex.adapter)
          : Effect.fail(new ProviderUnsupportedError({ provider })),
      listProviders: () => Effect.succeed(["codex"]),
    };

    const persistenceLayer = makeSqlitePersistenceLive(dbPath);
    const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
      Layer.provide(persistenceLayer),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));

    yield* Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      yield* directory.upsert({
        provider: "codex",
        threadId: ThreadId.makeUnsafe("thread-stale"),
      });
    }).pipe(Effect.provide(directoryLayer));

    const providerLayer = makeProviderServiceLive().pipe(
      Layer.provide(Layer.succeed(ProviderAdapterRegistry, registry)),
      Layer.provide(directoryLayer),
      Layer.provide(defaultServerSettingsLayer),
      Layer.provide(AnalyticsService.layerTest),
    );

    yield* Effect.gen(function* () {
      yield* ProviderService;
    }).pipe(Effect.provide(providerLayer));

    const persistedProvider = yield* Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      return yield* directory.getProvider(asThreadId("thread-stale"));
    }).pipe(Effect.provide(directoryLayer));
    assert.equal(persistedProvider, "codex");

    const runtime = yield* Effect.gen(function* () {
      const repository = yield* ProviderSessionRuntimeRepository;
      return yield* repository.getByThreadId({ threadId: asThreadId("thread-stale") });
    }).pipe(Effect.provide(runtimeRepositoryLayer));
    assert.equal(Option.isSome(runtime), true);

    const legacyTableRows = yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name = 'provider_sessions'
      `;
    }).pipe(Effect.provide(persistenceLayer));
    assert.equal(legacyTableRows.length, 0);

    fs.rmSync(tempDir, { recursive: true, force: true });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "ProviderServiceLive stopAll marks sessions stopped despite unreadable runtime rows",
  () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "piedpiper-provider-service-stopall-"));
      const dbPath = path.join(tempDir, "orchestration.sqlite");

      const codex = makeFakeCodexAdapter();
      const registry: typeof ProviderAdapterRegistry.Service = {
        getByProvider: (provider) =>
          provider === "codex"
            ? Effect.succeed(codex.adapter)
            : Effect.fail(new ProviderUnsupportedError({ provider })),
        listProviders: () => Effect.succeed(["codex"]),
      };

      const persistenceLayer = makeSqlitePersistenceLive(dbPath);
      const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
        Layer.provide(persistenceLayer),
      );
      const directoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );

      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
        INSERT INTO provider_session_runtime (
          thread_id, provider_name, adapter_key, runtime_mode, status, last_seen_at,
          resume_cursor_json, runtime_payload_json
        )
        VALUES
          ('thread-a-unknown-provider', 'someFutureProvider', 'x', 'full-access', 'running',
            '2000-01-01T00:00:00.000Z', NULL, NULL),
          ('thread-b-bad-status', 'codex', 'codex', 'full-access', 'hibernating',
            '2000-01-01T00:00:00.000Z', NULL, NULL)
      `;
      }).pipe(Effect.provide(persistenceLayer));
      yield* Effect.gen(function* () {
        const directory = yield* ProviderSessionDirectory;
        yield* directory.upsert({
          provider: "codex",
          threadId: asThreadId("thread-valid"),
          status: "running",
        });
      }).pipe(Effect.provide(directoryLayer));

      const providerLayer = makeProviderServiceLive().pipe(
        Layer.provide(Layer.succeed(ProviderAdapterRegistry, registry)),
        Layer.provide(directoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(AnalyticsService.layerTest),
      );
      // Closing the layer scope runs the stopAll finalizer.
      yield* Effect.gen(function* () {
        yield* ProviderService;
      }).pipe(Effect.provide(providerLayer));

      assert.equal(codex.stopAll.mock.calls.length, 1);
      const runtime = yield* Effect.gen(function* () {
        const repository = yield* ProviderSessionRuntimeRepository;
        return yield* repository.getByThreadId({ threadId: asThreadId("thread-valid") });
      }).pipe(Effect.provide(runtimeRepositoryLayer));
      assert.equal(Option.getOrUndefined(runtime)?.status, "stopped");

      fs.rmSync(tempDir, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("ProviderServiceLive stopAll keeps marking sessions stopped after one write fails", () =>
  Effect.gen(function* () {
    const codex = makeFakeCodexAdapter();
    const registry: typeof ProviderAdapterRegistry.Service = {
      getByProvider: (provider) =>
        provider === "codex"
          ? Effect.succeed(codex.adapter)
          : Effect.fail(new ProviderUnsupportedError({ provider })),
      listProviders: () => Effect.succeed(["codex"]),
    };
    const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const liveDirectoryLayer = ProviderSessionDirectoryLive.pipe(
      Layer.provide(runtimeRepositoryLayer),
    );
    let failStoppedWrites = false;
    const failingDirectoryLayer = Layer.effect(
      ProviderSessionDirectory,
      Effect.gen(function* () {
        const directory = yield* ProviderSessionDirectory;
        return {
          ...directory,
          upsert: (binding: Parameters<typeof directory.upsert>[0]) =>
            failStoppedWrites && binding.threadId === asThreadId("thread-unwritable")
              ? Effect.fail(
                  new ProviderSessionDirectoryPersistenceError({
                    operation: "ProviderSessionDirectory.upsert",
                    detail: "forced write failure",
                  }),
                )
              : directory.upsert(binding),
        };
      }),
    ).pipe(Layer.provideMerge(liveDirectoryLayer));

    const rows = yield* Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      for (const threadId of ["thread-unwritable", "thread-writable"]) {
        yield* directory.upsert({
          provider: "codex",
          threadId: asThreadId(threadId),
          status: "running",
        });
      }
      const providerLayer = makeProviderServiceLive().pipe(
        Layer.provide(Layer.succeed(ProviderAdapterRegistry, registry)),
        Layer.provide(Layer.succeed(ProviderSessionDirectory, directory)),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(AnalyticsService.layerTest),
      );
      failStoppedWrites = true;
      // Closing the layer scope runs the stopAll finalizer.
      yield* Effect.gen(function* () {
        yield* ProviderService;
      }).pipe(Effect.provide(providerLayer));
      const repository = yield* ProviderSessionRuntimeRepository;
      return yield* repository.list();
    }).pipe(Effect.provide(Layer.merge(failingDirectoryLayer, runtimeRepositoryLayer)));

    const statusByThread = new Map(rows.map((row) => [row.threadId, row.status]));
    assert.equal(statusByThread.get(asThreadId("thread-unwritable")), "running");
    assert.equal(statusByThread.get(asThreadId("thread-writable")), "stopped");
  }).pipe(Effect.provide(NodeServices.layer)),
);

describe("ProviderServiceLive stopAll restart continuation marker", () => {
  const threadId = asThreadId("thread-continue");
  const turnId = TurnId.makeUnsafe("turn-continue");

  const stopWithActiveTurn = (input: {
    readonly enabled: boolean;
    readonly beforeStop?: (
      provider: ProviderServiceShape,
    ) => Effect.Effect<unknown, ProviderServiceError>;
  }) =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "piedpiper-provider-service-marker-"));
      const codex = makeFakeCodexAdapter();
      const registry: typeof ProviderAdapterRegistry.Service = {
        getByProvider: (provider) =>
          provider === "codex"
            ? Effect.succeed(codex.adapter)
            : Effect.fail(new ProviderUnsupportedError({ provider })),
        listProviders: () => Effect.succeed(["codex"]),
      };
      const persistenceLayer = makeSqlitePersistenceLive(
        path.join(tempDir, "orchestration.sqlite"),
      );
      const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
        Layer.provide(persistenceLayer),
      );
      const providerLayer = makeProviderServiceLive().pipe(
        Layer.provide(Layer.succeed(ProviderAdapterRegistry, registry)),
        Layer.provide(ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer))),
        Layer.provide(
          ServerSettingsService.layerTest({ continueThreadsAfterRestart: input.enabled }),
        ),
        Layer.provide(AnalyticsService.layerTest),
      );
      // Closing the layer scope runs the stopAll finalizer.
      yield* Effect.gen(function* () {
        const provider = yield* ProviderService;
        yield* provider.startSession(threadId, {
          provider: "codex",
          threadId,
          runtimeMode: "full-access",
        });
        yield* input.beforeStop?.(provider) ?? Effect.void;
        codex.updateSession(threadId, (session) => ({ ...session, activeTurnId: turnId }));
      }).pipe(Effect.provide(providerLayer));

      const rows = yield* Effect.gen(function* () {
        const repository = yield* ProviderSessionRuntimeRepository;
        return yield* repository.list();
      }).pipe(Effect.provide(runtimeRepositoryLayer));
      fs.rmSync(tempDir, { recursive: true, force: true });
      const row = rows.find((candidate) => candidate.threadId === threadId);
      assert.equal(row?.status, "stopped");
      return row?.runtimePayload as Record<string, unknown>;
    }).pipe(Effect.provide(NodeServices.layer));

  it.effect("survives the stopped rewrite when the setting is on", () =>
    Effect.gen(function* () {
      const payload = yield* stopWithActiveTurn({ enabled: true });
      assert.equal(payload[RESTART_CONTINUATION_MARKER_KEY], turnId);
      assert.equal(payload.activeTurnId, null);
    }),
  );

  it.effect("is not written when the setting is off", () =>
    Effect.gen(function* () {
      const payload = yield* stopWithActiveTurn({ enabled: false });
      assert.isUndefined(payload[RESTART_CONTINUATION_MARKER_KEY]);
    }),
  );

  it.effect("is not written after an interrupt was requested", () =>
    Effect.gen(function* () {
      const payload = yield* stopWithActiveTurn({
        enabled: true,
        beforeStop: (provider) => provider.interruptTurn({ threadId, turnId }),
      });
      assert.isUndefined(payload[RESTART_CONTINUATION_MARKER_KEY]);
    }),
  );

  it.effect("is written again once a later turn was sent", () =>
    Effect.gen(function* () {
      const payload = yield* stopWithActiveTurn({
        enabled: true,
        beforeStop: (provider) =>
          provider
            .interruptTurn({ threadId, turnId })
            .pipe(Effect.andThen(provider.sendTurn({ threadId, input: "again", attachments: [] }))),
      });
      assert.equal(payload[RESTART_CONTINUATION_MARKER_KEY], turnId);
    }),
  );
});

it.effect("ProviderServiceLive stopAll leaves settled stopped rows untouched", () =>
  Effect.gen(function* () {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "piedpiper-provider-service-settled-"));
    const dbPath = path.join(tempDir, "orchestration.sqlite");

    const codex = makeFakeCodexAdapter();
    const registry: typeof ProviderAdapterRegistry.Service = {
      getByProvider: (provider) =>
        provider === "codex"
          ? Effect.succeed(codex.adapter)
          : Effect.fail(new ProviderUnsupportedError({ provider })),
      listProviders: () => Effect.succeed(["codex"]),
    };
    const recorded: Array<{ event: string; properties: unknown }> = [];
    const analyticsLayer = Layer.succeed(AnalyticsService, {
      record: (event: string, properties?: unknown) =>
        Effect.sync(() => {
          recorded.push({ event, properties });
        }),
      flush: Effect.void,
    } as unknown as typeof AnalyticsService.Service);

    const persistenceLayer = makeSqlitePersistenceLive(dbPath);
    const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
      Layer.provide(persistenceLayer),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));

    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO provider_session_runtime (
          thread_id, provider_name, adapter_key, runtime_mode, status, last_seen_at,
          resume_cursor_json, runtime_payload_json
        )
        VALUES
          ('thread-settled', 'codex', 'codex', 'full-access', 'stopped',
            '2000-01-01T00:00:00.000Z', '{"opaque":"keep"}', '{"activeTurnId":null}'),
          ('thread-running', 'codex', 'codex', 'full-access', 'running',
            '2000-01-01T00:00:00.000Z', NULL, '{"activeTurnId":"turn-1"}'),
          ('thread-stopped-mid-turn', 'codex', 'codex', 'full-access', 'stopped',
            '2000-01-01T00:00:00.000Z', NULL, '{"activeTurnId":"turn-2"}')
      `;
    }).pipe(Effect.provide(persistenceLayer));

    const providerLayer = makeProviderServiceLive().pipe(
      Layer.provide(Layer.succeed(ProviderAdapterRegistry, registry)),
      Layer.provide(directoryLayer),
      Layer.provide(defaultServerSettingsLayer),
      Layer.provide(analyticsLayer),
    );
    // Closing the layer scope runs the stopAll finalizer.
    yield* Effect.gen(function* () {
      yield* ProviderService;
    }).pipe(Effect.provide(providerLayer));

    const rows = yield* Effect.gen(function* () {
      const repository = yield* ProviderSessionRuntimeRepository;
      return yield* repository.list();
    }).pipe(Effect.provide(runtimeRepositoryLayer));
    const byThread = new Map(rows.map((row) => [row.threadId, row]));
    const settled = byThread.get(asThreadId("thread-settled"));
    assert.equal(settled?.lastSeenAt, "2000-01-01T00:00:00.000Z");
    assert.deepEqual(settled?.resumeCursor, { opaque: "keep" });
    for (const threadId of ["thread-running", "thread-stopped-mid-turn"]) {
      const row = byThread.get(asThreadId(threadId));
      assert.equal(row?.status, "stopped");
      assert.notEqual(row?.lastSeenAt, "2000-01-01T00:00:00.000Z");
      assert.equal(
        (row?.runtimePayload as { activeTurnId?: unknown } | undefined)?.activeTurnId,
        null,
      );
      assert.equal(
        (row?.runtimePayload as { lastRuntimeEvent?: unknown } | undefined)?.lastRuntimeEvent,
        "provider.stopAll",
      );
    }
    assert.deepEqual(
      recorded.filter((entry) => entry.event === "provider.sessions.stopped_all"),
      [{ event: "provider.sessions.stopped_all", properties: { stoppedSessionCount: 2 } }],
    );

    fs.rmSync(tempDir, { recursive: true, force: true });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("ProviderServiceLive stopAll caps a hanging analytics flush", () =>
  Effect.gen(function* () {
    const codex = makeFakeCodexAdapter();
    const registry: typeof ProviderAdapterRegistry.Service = {
      getByProvider: (provider) =>
        provider === "codex"
          ? Effect.succeed(codex.adapter)
          : Effect.fail(new ProviderUnsupportedError({ provider })),
      listProviders: () => Effect.succeed(["codex"]),
    };
    // A flush that never finishes, as with a blackholed telemetry host.
    const analyticsLayer = Layer.succeed(AnalyticsService, {
      record: () => Effect.void,
      flush: Effect.never,
    } as unknown as typeof AnalyticsService.Service);
    const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const providerLayer = makeProviderServiceLive().pipe(
      Layer.provide(Layer.succeed(ProviderAdapterRegistry, registry)),
      Layer.provide(ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer))),
      Layer.provide(defaultServerSettingsLayer),
      Layer.provide(analyticsLayer),
    );

    // Closing the layer scope runs the stopAll finalizer; its flush is capped at 1 second.
    const startedAt = Date.now();
    const finished = yield* Effect.gen(function* () {
      yield* ProviderService;
    }).pipe(Effect.provide(providerLayer), Effect.timeoutOption("5 seconds"));
    assert.ok(Option.isSome(finished));
    assert.isBelow(Date.now() - startedAt, 5_000);
  }),
);

it.effect("ProviderServiceLive listSessions reads bindings only for live sessions", () =>
  Effect.gen(function* () {
    const codex = makeFakeCodexAdapter();
    const registry: typeof ProviderAdapterRegistry.Service = {
      getByProvider: (provider) =>
        provider === "codex"
          ? Effect.succeed(codex.adapter)
          : Effect.fail(new ProviderUnsupportedError({ provider })),
      listProviders: () => Effect.succeed(["codex"]),
    };
    const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const liveDirectoryLayer = ProviderSessionDirectoryLive.pipe(
      Layer.provide(runtimeRepositoryLayer),
    );
    const getBindingCalls: Array<ThreadId> = [];
    const spyDirectoryLayer = Layer.effect(
      ProviderSessionDirectory,
      Effect.gen(function* () {
        const directory = yield* ProviderSessionDirectory;
        return {
          ...directory,
          getBinding: (threadId: ThreadId) => {
            getBindingCalls.push(threadId);
            return directory.getBinding(threadId);
          },
        };
      }),
    ).pipe(Layer.provide(liveDirectoryLayer));
    const providerLayer = makeProviderServiceLive().pipe(
      Layer.provide(Layer.succeed(ProviderAdapterRegistry, registry)),
      Layer.provideMerge(spyDirectoryLayer),
      Layer.provide(defaultServerSettingsLayer),
      Layer.provide(AnalyticsService.layerTest),
    );

    yield* Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      const provider = yield* ProviderService;
      for (const threadId of ["thread-idle-1", "thread-idle-2"]) {
        yield* directory.upsert({
          provider: "codex",
          threadId: asThreadId(threadId),
          status: "stopped",
        });
      }
      yield* provider.startSession(asThreadId("thread-live"), {
        provider: "codex",
        threadId: asThreadId("thread-live"),
        runtimeMode: "full-access",
      });

      getBindingCalls.length = 0;
      const sessions = yield* provider.listSessions();
      assert.deepEqual(
        sessions.map((session) => session.threadId),
        [asThreadId("thread-live")],
      );
      assert.deepEqual(getBindingCalls, [asThreadId("thread-live")]);
    }).pipe(Effect.provide(providerLayer));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "ProviderServiceLive restores rollback routing after restart using persisted thread mapping",
  () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "piedpiper-provider-service-restart-"));
      const dbPath = path.join(tempDir, "orchestration.sqlite");
      const persistenceLayer = makeSqlitePersistenceLive(dbPath);
      const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
        Layer.provide(persistenceLayer),
      );

      const firstCodex = makeFakeCodexAdapter();
      const firstRegistry: typeof ProviderAdapterRegistry.Service = {
        getByProvider: (provider) =>
          provider === "codex"
            ? Effect.succeed(firstCodex.adapter)
            : Effect.fail(new ProviderUnsupportedError({ provider })),
        listProviders: () => Effect.succeed(["codex"]),
      };

      const firstDirectoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const firstProviderLayer = makeProviderServiceLive().pipe(
        Layer.provide(Layer.succeed(ProviderAdapterRegistry, firstRegistry)),
        Layer.provide(firstDirectoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(AnalyticsService.layerTest),
      );
      const updatedResumeCursor = {
        threadId: asThreadId("thread-1"),
        resume: "resume-session-1",
        resumeSessionAt: "assistant-message-1",
        turnCount: 1,
      };

      const startedSession = yield* Effect.gen(function* () {
        const provider = yield* ProviderService;
        const threadId = asThreadId("thread-1");
        const session = yield* provider.startSession(threadId, {
          provider: "codex",
          cwd: "/tmp/project",
          runtimeMode: "full-access",
          threadId,
        });
        firstCodex.updateSession(threadId, (existing) => ({
          ...existing,
          status: "ready",
          resumeCursor: updatedResumeCursor,
          updatedAt: new Date(Date.now() + 1_000).toISOString(),
        }));
        return session;
      }).pipe(Effect.provide(firstProviderLayer));

      const persistedAfterStopAll = yield* Effect.gen(function* () {
        const repository = yield* ProviderSessionRuntimeRepository;
        return yield* repository.getByThreadId({ threadId: startedSession.threadId });
      }).pipe(Effect.provide(runtimeRepositoryLayer));
      assert.equal(Option.isSome(persistedAfterStopAll), true);
      if (Option.isSome(persistedAfterStopAll)) {
        assert.equal(persistedAfterStopAll.value.status, "stopped");
        assert.deepEqual(persistedAfterStopAll.value.resumeCursor, updatedResumeCursor);
      }

      const secondCodex = makeFakeCodexAdapter();
      const secondRegistry: typeof ProviderAdapterRegistry.Service = {
        getByProvider: (provider) =>
          provider === "codex"
            ? Effect.succeed(secondCodex.adapter)
            : Effect.fail(new ProviderUnsupportedError({ provider })),
        listProviders: () => Effect.succeed(["codex"]),
      };
      const secondDirectoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const secondProviderLayer = makeProviderServiceLive().pipe(
        Layer.provide(Layer.succeed(ProviderAdapterRegistry, secondRegistry)),
        Layer.provide(secondDirectoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(AnalyticsService.layerTest),
      );

      secondCodex.startSession.mockClear();
      secondCodex.rollbackThread.mockClear();

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService;
        yield* provider.rollbackConversation({
          threadId: startedSession.threadId,
          numTurns: 1,
        });
      }).pipe(Effect.provide(secondProviderLayer));

      assert.equal(secondCodex.startSession.mock.calls.length, 1);
      const resumedStartInput = secondCodex.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "codex");
        assert.equal(startPayload.cwd, "/tmp/project");
        assert.deepEqual(startPayload.resumeCursor, updatedResumeCursor);
        assert.equal(startPayload.threadId, startedSession.threadId);
      }
      assert.equal(secondCodex.rollbackThread.mock.calls.length, 1);
      const rollbackCall = secondCodex.rollbackThread.mock.calls[0];
      assert.equal(typeof rollbackCall?.[0], "string");
      assert.equal(rollbackCall?.[1], 1);

      fs.rmSync(tempDir, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
);

routing.layer("ProviderServiceLive routing", (it) => {
  it.effect("routes provider operations and rollback conversation", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;

      const session = yield* provider.startSession(asThreadId("thread-1"), {
        provider: "codex",
        threadId: asThreadId("thread-1"),
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });
      assert.equal(session.provider, "codex");

      const sessions = yield* provider.listSessions();
      assert.equal(sessions.length, 1);

      yield* provider.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });
      assert.equal(routing.codex.sendTurn.mock.calls.length, 1);

      yield* provider.interruptTurn({ threadId: session.threadId });
      assert.deepEqual(routing.codex.interruptTurn.mock.calls, [[session.threadId, undefined]]);

      yield* provider.respondToRequest({
        threadId: session.threadId,
        requestId: asRequestId("req-1"),
        decision: "accept",
      });
      assert.deepEqual(routing.codex.respondToRequest.mock.calls, [
        [session.threadId, asRequestId("req-1"), "accept"],
      ]);

      yield* provider.respondToUserInput({
        threadId: session.threadId,
        requestId: asRequestId("req-user-input-1"),
        answers: {
          sandbox_mode: "workspace-write",
        },
      });
      assert.deepEqual(routing.codex.respondToUserInput.mock.calls, [
        [
          session.threadId,
          asRequestId("req-user-input-1"),
          {
            sandbox_mode: "workspace-write",
          },
        ],
      ]);

      yield* provider.rollbackConversation({
        threadId: session.threadId,
        numTurns: 0,
      });

      routing.codex.stopSession.mockClear();
      yield* provider.stopSession({ threadId: session.threadId });
      assert.equal(routing.codex.stopSession.mock.calls.length, 1);
      routing.codex.startSession.mockClear();
      // The binding survives the stop, so the next turn resumes the thread instead of failing.
      yield* provider.sendTurn({
        threadId: session.threadId,
        input: "after-stop",
        attachments: [],
      });
      assert.equal(routing.codex.startSession.mock.calls.length, 1);
      assert.deepEqual(
        routing.codex.startSession.mock.calls[0]?.[0]?.resumeCursor,
        session.resumeCursor,
      );
    }),
  );

  it.effect("stopSession preserves the binding with its resume cursor and is idempotent", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const directory = yield* ProviderSessionDirectory;
      const threadId = asThreadId("thread-stop-preserve");

      const session = yield* provider.startSession(threadId, {
        provider: "codex",
        threadId,
        cwd: "/tmp/project-stop",
        runtimeMode: "approval-required",
      });
      routing.codex.stopSession.mockClear();

      yield* provider.stopSession({ threadId });
      yield* provider.stopSession({ threadId });
      assert.equal(routing.codex.stopSession.mock.calls.length, 1);

      const binding = Option.getOrUndefined(yield* directory.getBinding(threadId));
      assert.isDefined(binding);
      assert.equal(binding?.provider, "codex");
      assert.equal(binding?.status, "stopped");
      assert.equal(binding?.runtimeMode, "approval-required");
      assert.deepEqual(binding?.resumeCursor, session.resumeCursor);
      assert.equal(
        (binding?.runtimePayload as { cwd?: string } | null | undefined)?.cwd,
        "/tmp/project-stop",
      );

      routing.codex.startSession.mockClear();
      yield* provider.startSession(threadId, {
        provider: "codex",
        threadId,
        runtimeMode: "approval-required",
      });
      // Resume cursor and cwd both come back from the preserved binding.
      const restartInput = routing.codex.startSession.mock.calls[0]?.[0];
      assert.deepEqual(restartInput?.resumeCursor, session.resumeCursor);
      assert.equal(restartInput?.cwd, "/tmp/project-stop");
    }),
  );

  it.effect("persists the cursor a session.exited carries, over an existing binding only", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const directory = yield* ProviderSessionDirectory;
      const threadId = asThreadId("thread-claude-exit-cursor");
      yield* provider.startSession(threadId, {
        provider: "claudeAgent",
        threadId,
        cwd: "/tmp/project-claude-exit-cursor",
        runtimeMode: "full-access",
      });
      yield* sleep(50);
      const exited = (eventId: string, targetThreadId: typeof threadId, payload: object) => ({
        type: "session.exited" as const,
        eventId: asEventId(eventId),
        provider: "claudeAgent" as const,
        createdAt: new Date().toISOString(),
        threadId: targetThreadId,
        payload,
      });
      const before = Option.getOrUndefined(yield* directory.getBinding(threadId));

      routing.claude.emit(exited("evt-exit-no-cursor", threadId, { reason: "gone" }));
      yield* sleep(50);
      assert.deepEqual(
        Option.getOrUndefined(yield* directory.getBinding(threadId))?.resumeCursor,
        before?.resumeCursor,
      );

      const cursor = { turnEndMessageIds: ["a", "b"] };
      routing.claude.emit(exited("evt-exit-cursor", threadId, { resumeCursor: cursor }));
      yield* sleep(50);
      assert.deepEqual(
        Option.getOrUndefined(yield* directory.getBinding(threadId))?.resumeCursor,
        cursor,
      );

      const removedThreadId = asThreadId("thread-claude-exit-removed");
      routing.claude.emit(exited("evt-exit-removed", removedThreadId, { resumeCursor: cursor }));
      yield* sleep(50);
      assert.isTrue(Option.isNone(yield* directory.getBinding(removedThreadId)));
    }),
  );

  it.effect("persists the live Claude resume cursor on turn completion and stop", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const directory = yield* ProviderSessionDirectory;
      const threadId = asThreadId("thread-claude-live-cursor");

      yield* provider.startSession(threadId, {
        provider: "claudeAgent",
        threadId,
        cwd: "/tmp/project-claude-live-cursor",
        runtimeMode: "full-access",
      });
      const completedCursor = {
        resume: "session-1",
        turnEndMessageIds: ["assistant-uuid-1"],
      };
      routing.claude.updateSession(threadId, (session) => ({
        ...session,
        resumeCursor: completedCursor,
      }));
      // Let the service's adapter event subscription start before emitting.
      yield* sleep(50);
      routing.claude.emit({
        type: "turn.completed",
        eventId: asEventId("evt-claude-live-cursor"),
        provider: "claudeAgent",
        createdAt: new Date().toISOString(),
        threadId,
        turnId: asTurnId("turn-claude-live-cursor"),
        payload: { state: "completed" },
      });
      yield* sleep(50);

      const afterTurn = Option.getOrUndefined(yield* directory.getBinding(threadId));
      assert.deepEqual(afterTurn?.resumeCursor, completedCursor);

      const finalCursor = {
        resume: "session-1",
        turnEndMessageIds: ["assistant-uuid-1", "assistant-uuid-2"],
      };
      routing.claude.updateSession(threadId, (session) => ({
        ...session,
        resumeCursor: finalCursor,
      }));
      yield* provider.stopSession({ threadId });

      const binding = Option.getOrUndefined(yield* directory.getBinding(threadId));
      assert.equal(binding?.status, "stopped");
      assert.deepEqual(
        (binding?.resumeCursor as { turnEndMessageIds?: ReadonlyArray<string> } | undefined)
          ?.turnEndMessageIds,
        ["assistant-uuid-1", "assistant-uuid-2"],
      );
    }),
  );

  it.effect("compactThread calls the adapter, and fails when the provider has no compaction", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const threadId = asThreadId("thread-compact");
      yield* provider.startSession(threadId, {
        provider: "codex",
        threadId,
        cwd: "/tmp/project-compact",
        runtimeMode: "full-access",
      });

      const failure = yield* provider.compactThread({ threadId }).pipe(Effect.flip);
      assert.equal(failure._tag, "ProviderAdapterValidationError");
      assert.include(failure.message, "does not support on-demand compaction");

      const compactThread = vi.fn(() => Effect.void);
      const adapter = routing.codex.adapter as unknown as { compactThread?: typeof compactThread };
      adapter.compactThread = compactThread;
      yield* provider.compactThread({ threadId });
      delete adapter.compactThread;
      assert.deepEqual(compactThread.mock.calls[0], [threadId] as never);
    }),
  );

  it.effect("runGoalRequest calls the adapter, and fails when the provider has no goals", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const threadId = asThreadId("thread-goal");
      yield* provider.startSession(threadId, {
        provider: "codex",
        threadId,
        cwd: "/tmp/project-goal",
        runtimeMode: "full-access",
      });
      const request = { type: "set", status: "paused" } as const;

      const failure = yield* provider.runGoalRequest({ threadId, request }).pipe(Effect.flip);
      assert.equal(failure._tag, "ProviderAdapterValidationError");
      assert.include(failure.message, "does not support native goals");

      const runGoalRequest = vi.fn(() => Effect.succeed({ goal: null }));
      const adapter = routing.codex.adapter as unknown as {
        runGoalRequest?: typeof runGoalRequest;
      };
      adapter.runGoalRequest = runGoalRequest;
      const response = yield* provider.runGoalRequest({ threadId, request });
      delete adapter.runGoalRequest;
      assert.deepEqual(response, { goal: null });
      assert.deepEqual(runGoalRequest.mock.calls[0], [threadId, request] as never);
    }),
  );

  it.effect("rollbackConversation persists the adapter's rewound resume cursor", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const directory = yield* ProviderSessionDirectory;
      const threadId = asThreadId("thread-rollback-cursor");

      yield* provider.startSession(threadId, {
        provider: "codex",
        threadId,
        cwd: "/tmp/project-rollback",
        runtimeMode: "full-access",
      });
      const rewoundCursor = { resume: "session-1", resumeSessionAt: "assistant-uuid-1" };
      routing.codex.rollbackThread.mockImplementationOnce((rollbackThreadId) =>
        Effect.sync(() => {
          routing.codex.updateSession(rollbackThreadId, (session) => ({
            ...session,
            resumeCursor: rewoundCursor,
          }));
          return { threadId: rollbackThreadId, turns: [] };
        }),
      );

      yield* provider.rollbackConversation({ threadId, numTurns: 1 });

      const binding = Option.getOrUndefined(yield* directory.getBinding(threadId));
      assert.deepEqual(binding?.resumeCursor, rewoundCursor);
      assert.equal(
        (binding?.runtimePayload as { lastRuntimeEvent?: string } | null | undefined)
          ?.lastRuntimeEvent,
        "provider.rollback",
      );
    }),
  );

  it.effect("stopSession does not rewrite an already stopped binding", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const directory = yield* ProviderSessionDirectory;
      const threadId = asThreadId("thread-stop-repeat");

      yield* provider.startSession(threadId, {
        provider: "codex",
        threadId,
        runtimeMode: "full-access",
      });
      yield* provider.stopSession({ threadId });
      const firstStop = Option.getOrUndefined(yield* directory.getBinding(threadId));
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 5)));

      yield* provider.stopSession({ threadId });
      const secondStop = Option.getOrUndefined(yield* directory.getBinding(threadId));
      assert.equal(secondStop?.status, "stopped");
      assert.deepEqual(secondStop?.runtimePayload, firstStop?.runtimePayload);
    }),
  );

  it.effect("interruptTurn fails without starting a session when none is live", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const threadId = asThreadId("thread-interrupt-dead");

      yield* provider.startSession(threadId, {
        provider: "codex",
        threadId,
        runtimeMode: "full-access",
      });
      // The process is gone but the binding still says running (e.g. after a restart).
      yield* routing.codex.stopSession(threadId);
      routing.codex.startSession.mockClear();
      routing.codex.interruptTurn.mockClear();

      const result = yield* Effect.result(provider.interruptTurn({ threadId }));
      assertFailure(result, new ProviderSessionNotFoundError({ threadId }));
      assert.equal(routing.codex.startSession.mock.calls.length, 0);
      assert.equal(routing.codex.interruptTurn.mock.calls.length, 0);
    }),
  );

  it.effect("stopSession is a no-op for threads that never had a session", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      routing.codex.stopSession.mockClear();
      yield* provider.stopSession({ threadId: asThreadId("thread-never-started") });
      assert.equal(routing.codex.stopSession.mock.calls.length, 0);
    }),
  );

  it.effect("startSession with a null resume cursor starts fresh and drops the persisted one", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const directory = yield* ProviderSessionDirectory;
      const threadId = asThreadId("thread-fresh-start");

      yield* provider.startSession(threadId, {
        provider: "codex",
        threadId,
        runtimeMode: "full-access",
      });
      yield* provider.stopSession({ threadId });
      routing.codex.startSession.mockClear();
      routing.codex.startSession.mockImplementationOnce((input) =>
        Effect.sync(() => {
          const now = new Date().toISOString();
          const fresh: ProviderSession = {
            provider: "codex",
            status: "ready",
            runtimeMode: input.runtimeMode,
            threadId: input.threadId,
            createdAt: now,
            updatedAt: now,
          };
          return fresh;
        }),
      );

      yield* provider.startSession(threadId, {
        provider: "codex",
        threadId,
        runtimeMode: "full-access",
        resumeCursor: null,
      });

      assert.equal("resumeCursor" in (routing.codex.startSession.mock.calls[0]?.[0] ?? {}), false);
      const binding = Option.getOrUndefined(yield* directory.getBinding(threadId));
      assert.equal(binding?.resumeCursor ?? null, null);
    }),
  );

  it.effect("startSession stops a session the thread left on another provider", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const threadId = asThreadId("thread-provider-switch");

      yield* provider.startSession(threadId, {
        provider: "codex",
        threadId,
        runtimeMode: "full-access",
      });
      routing.codex.stopSession.mockClear();

      yield* provider.startSession(threadId, {
        provider: "claudeAgent",
        threadId,
        runtimeMode: "full-access",
      });

      assert.deepEqual(routing.codex.stopSession.mock.calls, [[threadId]]);
      assert.equal(yield* routing.codex.adapter.hasSession(threadId), false);
      assert.equal(yield* routing.claude.adapter.hasSession(threadId), true);
    }),
  );

  it.effect("recovers stale persisted sessions for rollback by resuming thread identity", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;

      const initial = yield* provider.startSession(asThreadId("thread-1"), {
        provider: "codex",
        threadId: asThreadId("thread-1"),
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });
      yield* routing.codex.stopSession(initial.threadId);
      routing.codex.startSession.mockClear();
      routing.codex.rollbackThread.mockClear();

      yield* provider.rollbackConversation({
        threadId: initial.threadId,
        numTurns: 1,
      });

      assert.equal(routing.codex.startSession.mock.calls.length, 1);
      const resumedStartInput = routing.codex.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "codex");
        assert.equal(startPayload.cwd, "/tmp/project");
        assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
        assert.equal(startPayload.threadId, initial.threadId);
      }
      assert.equal(routing.codex.rollbackThread.mock.calls.length, 1);
      const rollbackCall = routing.codex.rollbackThread.mock.calls[0];
      assert.equal(rollbackCall?.[1], 1);
    }),
  );

  it.effect("routes explicit claudeAgent provider session starts to the claude adapter", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      routing.claude.startSession.mockClear();

      const session = yield* provider.startSession(asThreadId("thread-claude"), {
        provider: "claudeAgent",
        threadId: asThreadId("thread-claude"),
        cwd: "/tmp/project-claude",
        runtimeMode: "full-access",
      });

      assert.equal(session.provider, "claudeAgent");
      assert.equal(routing.claude.startSession.mock.calls.length, 1);
      const startInput = routing.claude.startSession.mock.calls[0]?.[0];
      assert.equal(typeof startInput === "object" && startInput !== null, true);
      if (startInput && typeof startInput === "object") {
        const startPayload = startInput as { provider?: string; cwd?: string };
        assert.equal(startPayload.provider, "claudeAgent");
        assert.equal(startPayload.cwd, "/tmp/project-claude");
      }
    }),
  );

  it.effect("recovers stale sessions for sendTurn using persisted cwd", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;

      const initial = yield* provider.startSession(asThreadId("thread-1"), {
        provider: "codex",
        threadId: asThreadId("thread-1"),
        cwd: "/tmp/project-send-turn",
        runtimeMode: "full-access",
      });

      yield* routing.codex.stopAll();
      routing.codex.startSession.mockClear();
      routing.codex.sendTurn.mockClear();

      yield* provider.sendTurn({
        threadId: initial.threadId,
        input: "resume",
        attachments: [],
      });

      assert.equal(routing.codex.startSession.mock.calls.length, 1);
      const resumedStartInput = routing.codex.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "codex");
        assert.equal(startPayload.cwd, "/tmp/project-send-turn");
        assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
        assert.equal(startPayload.threadId, initial.threadId);
      }
      assert.equal(routing.codex.sendTurn.mock.calls.length, 1);
    }),
  );

  it.effect("recovers stale claudeAgent sessions for sendTurn using persisted cwd", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;

      const initial = yield* provider.startSession(asThreadId("thread-claude-send-turn"), {
        provider: "claudeAgent",
        threadId: asThreadId("thread-claude-send-turn"),
        cwd: "/tmp/project-claude-send-turn",
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-opus-4-6",
          options: {
            effort: "max",
          },
        },
        runtimeMode: "full-access",
      });

      yield* routing.claude.stopAll();
      routing.claude.startSession.mockClear();
      routing.claude.sendTurn.mockClear();

      yield* provider.sendTurn({
        threadId: initial.threadId,
        input: "resume with claude",
        attachments: [],
      });

      assert.equal(routing.claude.startSession.mock.calls.length, 1);
      const resumedStartInput = routing.claude.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          modelSelection?: unknown;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "claudeAgent");
        assert.equal(startPayload.cwd, "/tmp/project-claude-send-turn");
        assert.deepEqual(startPayload.modelSelection, {
          provider: "claudeAgent",
          model: "claude-opus-4-6",
          options: {
            effort: "max",
          },
        });
        assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
        assert.equal(startPayload.threadId, initial.threadId);
      }
      assert.equal(routing.claude.sendTurn.mock.calls.length, 1);
    }),
  );

  it.effect("lists no sessions after adapter runtime clears", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;

      yield* provider.startSession(asThreadId("thread-1"), {
        provider: "codex",
        threadId: asThreadId("thread-1"),
        runtimeMode: "full-access",
      });
      yield* provider.startSession(asThreadId("thread-2"), {
        provider: "codex",
        threadId: asThreadId("thread-2"),
        runtimeMode: "full-access",
      });

      yield* routing.codex.stopAll();
      yield* routing.claude.stopAll();

      const remaining = yield* provider.listSessions();
      assert.equal(remaining.length, 0);
    }),
  );

  it.effect("persists runtime status transitions in provider_session_runtime", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;

      const session = yield* provider.startSession(asThreadId("thread-1"), {
        provider: "codex",
        threadId: asThreadId("thread-1"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* provider.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      const runningRuntime = yield* runtimeRepository.getByThreadId({
        threadId: session.threadId,
      });
      assert.equal(Option.isSome(runningRuntime), true);
      if (Option.isSome(runningRuntime)) {
        assert.equal(runningRuntime.value.status, "running");
        assert.deepEqual(runningRuntime.value.resumeCursor, session.resumeCursor);
        const payload = runningRuntime.value.runtimePayload;
        assert.equal(payload !== null && typeof payload === "object", true);
        if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
          const runtimePayload = payload as {
            cwd: string;
            model: string | null;
            activeTurnId: string | null;
            lastError: string | null;
            lastRuntimeEvent: string | null;
          };
          assert.equal(runtimePayload.cwd, process.cwd());
          assert.equal(runtimePayload.model, null);
          assert.equal(runtimePayload.activeTurnId, `turn-${String(session.threadId)}`);
          assert.equal(runtimePayload.lastError, null);
          assert.equal(runtimePayload.lastRuntimeEvent, "provider.sendTurn");
        }
      }
    }),
  );

  it.effect("reuses persisted resume cursor when startSession is called after a restart", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "piedpiper-provider-service-start-"));
      const dbPath = path.join(tempDir, "orchestration.sqlite");
      const persistenceLayer = makeSqlitePersistenceLive(dbPath);
      const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
        Layer.provide(persistenceLayer),
      );

      const firstClaude = makeFakeCodexAdapter("claudeAgent");
      const firstRegistry: typeof ProviderAdapterRegistry.Service = {
        getByProvider: (provider) =>
          provider === "claudeAgent"
            ? Effect.succeed(firstClaude.adapter)
            : Effect.fail(new ProviderUnsupportedError({ provider })),
        listProviders: () => Effect.succeed(["claudeAgent"]),
      };
      const firstDirectoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const firstProviderLayer = makeProviderServiceLive().pipe(
        Layer.provide(Layer.succeed(ProviderAdapterRegistry, firstRegistry)),
        Layer.provide(firstDirectoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(AnalyticsService.layerTest),
      );

      const initial = yield* Effect.gen(function* () {
        const provider = yield* ProviderService;
        return yield* provider.startSession(asThreadId("thread-claude-start"), {
          provider: "claudeAgent",
          threadId: asThreadId("thread-claude-start"),
          cwd: "/tmp/project-claude-start",
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(firstProviderLayer));

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService;
        yield* provider.listSessions();
      }).pipe(Effect.provide(firstProviderLayer));

      const secondClaude = makeFakeCodexAdapter("claudeAgent");
      const secondRegistry: typeof ProviderAdapterRegistry.Service = {
        getByProvider: (provider) =>
          provider === "claudeAgent"
            ? Effect.succeed(secondClaude.adapter)
            : Effect.fail(new ProviderUnsupportedError({ provider })),
        listProviders: () => Effect.succeed(["claudeAgent"]),
      };
      const secondDirectoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const secondProviderLayer = makeProviderServiceLive().pipe(
        Layer.provide(Layer.succeed(ProviderAdapterRegistry, secondRegistry)),
        Layer.provide(secondDirectoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(AnalyticsService.layerTest),
      );

      secondClaude.startSession.mockClear();

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService;
        yield* provider.startSession(initial.threadId, {
          provider: "claudeAgent",
          threadId: initial.threadId,
          cwd: "/tmp/project-claude-start",
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(secondProviderLayer));

      assert.equal(secondClaude.startSession.mock.calls.length, 1);
      const resumedStartInput = secondClaude.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "claudeAgent");
        assert.equal(startPayload.cwd, "/tmp/project-claude-start");
        assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
        assert.equal(startPayload.threadId, initial.threadId);
      }

      fs.rmSync(tempDir, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

const fanout = makeProviderServiceLayer();
fanout.layer("ProviderServiceLive fanout", (it) => {
  it.effect("fans out adapter turn completion events", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const session = yield* provider.startSession(asThreadId("thread-1"), {
        provider: "codex",
        threadId: asThreadId("thread-1"),
        runtimeMode: "full-access",
      });

      const eventsRef = yield* Ref.make<Array<ProviderRuntimeEvent>>([]);
      const consumer = yield* Stream.runForEach(provider.streamEvents, (event) =>
        Ref.update(eventsRef, (current) => [...current, event]),
      ).pipe(Effect.forkChild);
      yield* sleep(50);

      const completedEvent: LegacyProviderRuntimeEvent = {
        type: "turn.completed",
        eventId: asEventId("evt-1"),
        provider: "codex",
        createdAt: new Date().toISOString(),
        threadId: session.threadId,
        turnId: asTurnId("turn-1"),
        status: "completed",
      };

      fanout.codex.emit(completedEvent);
      yield* sleep(50);

      const events = yield* Ref.get(eventsRef);
      yield* Fiber.interrupt(consumer);

      assert.equal(
        events.some((entry) => entry.type === "turn.completed"),
        true,
      );
    }),
  );

  it.effect("fans out canonical runtime events in emission order", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const session = yield* provider.startSession(asThreadId("thread-seq"), {
        provider: "codex",
        threadId: asThreadId("thread-seq"),
        runtimeMode: "full-access",
      });

      const receivedRef = yield* Ref.make<Array<ProviderRuntimeEvent>>([]);
      const consumer = yield* Stream.take(provider.streamEvents, 3).pipe(
        Stream.runForEach((event) => Ref.update(receivedRef, (current) => [...current, event])),
        Effect.forkChild,
      );
      yield* sleep(50);

      fanout.codex.emit({
        type: "tool.started",
        eventId: asEventId("evt-seq-1"),
        provider: "codex",
        createdAt: new Date().toISOString(),
        threadId: session.threadId,
        turnId: asTurnId("turn-1"),
        toolKind: "command",
        title: "Ran command",
      });
      fanout.codex.emit({
        type: "tool.completed",
        eventId: asEventId("evt-seq-2"),
        provider: "codex",
        createdAt: new Date().toISOString(),
        threadId: session.threadId,
        turnId: asTurnId("turn-1"),
        toolKind: "command",
        title: "Ran command",
      });
      fanout.codex.emit({
        type: "turn.completed",
        eventId: asEventId("evt-seq-3"),
        provider: "codex",
        createdAt: new Date().toISOString(),
        threadId: session.threadId,
        turnId: asTurnId("turn-1"),
        status: "completed",
      });

      yield* Fiber.join(consumer);
      const received = yield* Ref.get(receivedRef);
      assert.deepEqual(
        received.map((event) => event.eventId),
        [asEventId("evt-seq-1"), asEventId("evt-seq-2"), asEventId("evt-seq-3")],
      );
    }),
  );

  it.effect("keeps subscriber delivery ordered and isolates failing subscribers", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const session = yield* provider.startSession(asThreadId("thread-1"), {
        provider: "codex",
        threadId: asThreadId("thread-1"),
        runtimeMode: "full-access",
      });

      const receivedByHealthy: string[] = [];
      const expectedEventIds = new Set<string>(["evt-ordered-1", "evt-ordered-2", "evt-ordered-3"]);
      const healthyFiber = yield* Stream.take(provider.streamEvents, 3).pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            receivedByHealthy.push(event.eventId);
          }),
        ),
        Effect.forkChild,
      );
      const failingFiber = yield* Stream.take(provider.streamEvents, 1).pipe(
        Stream.runForEach(() => Effect.fail("listener crash")),
        Effect.forkChild,
      );
      yield* sleep(50);

      const events: ReadonlyArray<LegacyProviderRuntimeEvent> = [
        {
          type: "tool.completed",
          eventId: asEventId("evt-ordered-1"),
          provider: "codex",
          createdAt: new Date().toISOString(),
          threadId: session.threadId,
          turnId: asTurnId("turn-1"),
          toolKind: "command",
          title: "Ran command",
          detail: "echo one",
        },
        {
          type: "message.delta",
          eventId: asEventId("evt-ordered-2"),
          provider: "codex",
          createdAt: new Date().toISOString(),
          threadId: session.threadId,
          turnId: asTurnId("turn-1"),
          delta: "hello",
        },
        {
          type: "turn.completed",
          eventId: asEventId("evt-ordered-3"),
          provider: "codex",
          createdAt: new Date().toISOString(),
          threadId: session.threadId,
          turnId: asTurnId("turn-1"),
          status: "completed",
        },
      ];

      for (const event of events) {
        fanout.codex.emit(event);
      }
      const failingResult = yield* Effect.result(Fiber.join(failingFiber));
      assert.equal(failingResult._tag, "Failure");
      yield* Fiber.join(healthyFiber);

      assert.deepEqual(
        receivedByHealthy.filter((eventId) => expectedEventIds.has(eventId)).slice(0, 3),
        ["evt-ordered-1", "evt-ordered-2", "evt-ordered-3"],
      );
    }),
  );

  it.effect("records provider metrics with the routed provider label", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;

      const session = yield* provider.startSession(asThreadId("thread-metrics"), {
        provider: "claudeAgent",
        threadId: asThreadId("thread-metrics"),
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });

      yield* provider.interruptTurn({ threadId: session.threadId });
      yield* provider.respondToRequest({
        threadId: session.threadId,
        requestId: asRequestId("req-metrics-1"),
        decision: "accept",
      });
      yield* provider.respondToUserInput({
        threadId: session.threadId,
        requestId: asRequestId("req-metrics-2"),
        answers: {
          sandbox_mode: "workspace-write",
        },
      });
      yield* provider.rollbackConversation({
        threadId: session.threadId,
        numTurns: 1,
      });
      yield* provider.stopSession({ threadId: session.threadId });

      const snapshots = yield* Metric.snapshot;

      assert.equal(
        hasMetricSnapshot(snapshots, "piedpiper_provider_turns_total", {
          provider: "claudeAgent",
          operation: "interrupt",
          outcome: "success",
        }),
        true,
      );
      assert.equal(
        hasMetricSnapshot(snapshots, "piedpiper_provider_turns_total", {
          provider: "claudeAgent",
          operation: "approval-response",
          outcome: "success",
        }),
        true,
      );
      assert.equal(
        hasMetricSnapshot(snapshots, "piedpiper_provider_turns_total", {
          provider: "claudeAgent",
          operation: "user-input-response",
          outcome: "success",
        }),
        true,
      );
      assert.equal(
        hasMetricSnapshot(snapshots, "piedpiper_provider_turns_total", {
          provider: "claudeAgent",
          operation: "rollback",
          outcome: "success",
        }),
        true,
      );
      assert.equal(
        hasMetricSnapshot(snapshots, "piedpiper_provider_sessions_total", {
          provider: "claudeAgent",
          operation: "stop",
          outcome: "success",
        }),
        true,
      );
    }),
  );

  it.effect(
    "records sendTurn metrics with the resolved provider when modelSelection is omitted",
    () =>
      Effect.gen(function* () {
        const provider = yield* ProviderService;

        const session = yield* provider.startSession(asThreadId("thread-send-metrics"), {
          provider: "claudeAgent",
          threadId: asThreadId("thread-send-metrics"),
          cwd: "/tmp/project-send-metrics",
          runtimeMode: "full-access",
        });

        yield* provider.sendTurn({
          threadId: session.threadId,
          input: "hello",
          attachments: [],
        });

        const snapshots = yield* Metric.snapshot;

        assert.equal(
          hasMetricSnapshot(snapshots, "piedpiper_provider_turns_total", {
            provider: "claudeAgent",
            operation: "send",
            outcome: "success",
          }),
          true,
        );
        assert.equal(
          hasMetricSnapshot(snapshots, "piedpiper_provider_turn_duration", {
            provider: "claudeAgent",
            operation: "send",
          }),
          true,
        );
      }),
  );
});

const validation = makeProviderServiceLayer();
validation.layer("ProviderServiceLive validation", (it) => {
  it.effect("returns ProviderValidationError for invalid input payloads", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;

      const failure = yield* Effect.result(
        provider.startSession(asThreadId("thread-validation"), {
          threadId: asThreadId("thread-validation"),
          provider: "invalid-provider",
          runtimeMode: "full-access",
        } as never),
      );

      assert.equal(failure._tag, "Failure");
      if (failure._tag !== "Failure") {
        return;
      }
      assert.equal(failure.failure._tag, "ProviderValidationError");
      if (failure.failure._tag !== "ProviderValidationError") {
        return;
      }
      assert.equal(failure.failure.operation, "ProviderService.startSession");
      assert.equal(failure.failure.issue.includes("invalid-provider"), true);
    }),
  );

  it.effect("accepts startSession when adapter has not emitted provider thread id yet", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;

      validation.codex.startSession.mockImplementationOnce((input: ProviderSessionStartInput) =>
        Effect.sync(() => {
          const now = new Date().toISOString();
          return {
            provider: "codex",
            status: "ready",
            threadId: input.threadId,
            runtimeMode: input.runtimeMode,
            cwd: input.cwd ?? process.cwd(),
            createdAt: now,
            updatedAt: now,
          } satisfies ProviderSession;
        }),
      );

      const session = yield* provider.startSession(asThreadId("thread-missing"), {
        provider: "codex",
        threadId: asThreadId("thread-missing"),
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });

      assert.equal(session.threadId, asThreadId("thread-missing"));

      const runtime = yield* runtimeRepository.getByThreadId({
        threadId: session.threadId,
      });
      assert.equal(Option.isSome(runtime), true);
      if (Option.isSome(runtime)) {
        assert.equal(runtime.value.threadId, session.threadId);
      }
    }),
  );
});
