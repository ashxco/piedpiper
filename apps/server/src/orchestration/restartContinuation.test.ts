import {
  EventId,
  MessageId,
  type OrchestrationCommand,
  type OrchestrationThread,
  type ProviderSession,
  ThreadId,
  TurnId,
} from "@piedpiper/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";

import {
  type ProviderSessionRuntime,
  ProviderSessionRuntimeRepository,
  type ProviderSessionRuntimeRepositoryShape,
} from "../persistence/Services/ProviderSessionRuntime.ts";
import { ProviderSessionDirectoryLive } from "../provider/Layers/ProviderSessionDirectory.ts";
import {
  type ProviderRuntimeBinding,
  ProviderSessionDirectory,
  type ProviderSessionDirectoryShape,
} from "../provider/Services/ProviderSessionDirectory.ts";
import { DEFAULT_SERVER_SETTINGS } from "@piedpiper/contracts/settings";
import { ServerSettingsService, type ServerSettingsShape } from "../serverSettings.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "./Services/OrchestrationEngine.ts";
import {
  decideRestartContinuation,
  dispatchRestartContinuations,
  markSessionsForRestartContinuation,
  readRestartContinuationMarker,
  RESTART_CONTINUATION_MARKER_KEY,
  RESTART_CONTINUATION_MAX_IN_WINDOW,
  RESTART_CONTINUATION_TEXT,
  RESTART_CONTINUATION_WINDOW_MS,
  restartContinuationMessageId,
  takeRestartContinuations,
} from "./restartContinuation.ts";

const NOW_MS = Date.parse("2026-06-01T12:00:00.000Z");
const iso = (msAgo: number) => new Date(NOW_MS - msAgo).toISOString();
const turnId = TurnId.makeUnsafe("turn-1");
const threadId = ThreadId.makeUnsafe("thread-1");

const makeThread = (overrides: Partial<OrchestrationThread> = {}): OrchestrationThread =>
  ({
    id: threadId,
    runtimeMode: "full-access",
    interactionMode: "default",
    archivedAt: null,
    deletedAt: null,
    messages: [],
    activities: [],
    latestTurn: {
      turnId,
      state: "running",
      requestedAt: iso(60_000),
      startedAt: iso(60_000),
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
      updatedAt: iso(1_000),
    },
    ...overrides,
  }) as unknown as OrchestrationThread;

const decide = (
  thread: OrchestrationThread | undefined,
  overrides: Partial<Parameters<typeof decideRestartContinuation>[0]> = {},
) =>
  decideRestartContinuation({
    thread,
    markedTurnId: turnId,
    hasResumeCursor: true,
    enabled: true,
    nowMs: NOW_MS,
    ...overrides,
  });

const latestTurnWith = (state: "completed" | "error" | "interrupted") =>
  ({
    turnId,
    state,
    requestedAt: iso(60_000),
    startedAt: iso(60_000),
    completedAt: iso(1_000),
    assistantMessageId: null,
  }) as OrchestrationThread["latestTurn"];

const continuationMessage = (id: string, msAgo: number) =>
  ({
    id: MessageId.makeUnsafe(`message:restart-continuation:${id}`),
    role: "user",
    text: RESTART_CONTINUATION_TEXT,
    createdAt: iso(msAgo),
  }) as unknown as OrchestrationThread["messages"][number];

describe("decideRestartContinuation", () => {
  it("continues a turn that shutdown left running", () => {
    assert.deepEqual(decide(makeThread()), {
      action: "send",
      messageId: restartContinuationMessageId(turnId),
    });
  });

  it("continues when session.exited already settled the turn as interrupted", () => {
    const thread = makeThread({
      latestTurn: latestTurnWith("interrupted"),
      session: { ...makeThread().session!, status: "stopped", activeTurnId: null },
    });
    assert.equal(decide(thread).action, "send");
  });

  it("skips while the setting is off", () => {
    assert.deepEqual(decide(makeThread(), { enabled: false }), {
      action: "skip",
      reason: "disabled",
    });
  });

  it("skips a missing, archived or deleted thread", () => {
    assert.deepEqual(decide(undefined), { action: "skip", reason: "missing-thread" });
    assert.deepEqual(decide(makeThread({ archivedAt: iso(0) })), {
      action: "skip",
      reason: "archived",
    });
    assert.deepEqual(decide(makeThread({ deletedAt: iso(0) })), {
      action: "skip",
      reason: "archived",
    });
  });

  it("skips without a resume cursor", () => {
    assert.deepEqual(decide(makeThread(), { hasResumeCursor: false }), {
      action: "skip",
      reason: "no-resume-cursor",
    });
  });

  it("skips a stale marker once another turn is the latest", () => {
    assert.deepEqual(decide(makeThread(), { markedTurnId: TurnId.makeUnsafe("turn-0") }), {
      action: "skip",
      reason: "stale",
    });
    assert.deepEqual(decide(makeThread({ latestTurn: null })), { action: "skip", reason: "stale" });
  });

  it("skips a cut turn that was only a /compact, but sends for an ordinary prompt", () => {
    const userMessage = (id: string, text: string) =>
      ({
        id: MessageId.makeUnsafe(id),
        role: "user",
        text,
        createdAt: iso(60_000),
      }) as unknown as OrchestrationThread["messages"][number];
    const assistantMessage = {
      ...userMessage("message-reply", "Compacted."),
      role: "assistant",
    } as OrchestrationThread["messages"][number];

    assert.deepEqual(
      decide(
        makeThread({
          messages: [
            userMessage("message-work", "Fix the bug"),
            userMessage("message-compact", " /compact "),
            assistantMessage,
          ],
        }),
      ),
      { action: "skip", reason: "maintenance-command" },
    );
    assert.deepEqual(
      decide(
        makeThread({
          messages: [
            userMessage("message-compact", "/compact"),
            userMessage("message-work", "Fix the bug"),
          ],
        }),
      ),
      { action: "send", messageId: restartContinuationMessageId(turnId) },
    );
  });

  describe("a /compact that did not start the marked turn", () => {
    const compactAt = (msAgo: number) =>
      ({
        id: MessageId.makeUnsafe("message-compact"),
        role: "user",
        text: "/compact",
        createdAt: iso(msAgo),
      }) as unknown as OrchestrationThread["messages"][number];
    const goalReport = (status: "active" | "paused") =>
      ({
        id: "goal-report",
        tone: "info",
        kind: "goal.updated",
        summary: "Goal updated",
        payload: { goal: { objective: "Ship it", status } },
        turnId: null,
        createdAt: iso(50_000),
      }) as unknown as OrchestrationThread["activities"][number];
    const send = { action: "send", messageId: restartContinuationMessageId(turnId) } as const;

    it("still continues a turn the /compact arrived during", () => {
      // The default fixture's turn was requested 60s ago, so this /compact came 30s into it.
      assert.deepEqual(decide(makeThread({ messages: [compactAt(30_000)] })), send);
    });

    it("skips the /compact's own turn when it was recorded after the message", () => {
      assert.deepEqual(decide(makeThread({ messages: [compactAt(90_000)] })), {
        action: "skip",
        reason: "maintenance-command",
      });
    });

    it("still continues a goal turn Codex started after the /compact", () => {
      assert.deepEqual(
        decide(makeThread({ messages: [compactAt(90_000)], activities: [goalReport("active")] })),
        send,
      );
      assert.deepEqual(
        decide(makeThread({ messages: [compactAt(90_000)], activities: [goalReport("paused")] })),
        { action: "skip", reason: "maintenance-command" },
      );
    });
  });

  it("skips a turn that finished before the marker was read", () => {
    for (const state of ["completed", "error"] as const) {
      assert.deepEqual(decide(makeThread({ latestTurn: latestTurnWith(state) })), {
        action: "skip",
        reason: "finished",
      });
    }
  });

  it("skips a turn the user stopped", () => {
    const thread = makeThread({
      latestTurn: latestTurnWith("interrupted"),
      session: { ...makeThread().session!, status: "interrupted", activeTurnId: null },
    });
    assert.deepEqual(decide(thread), { action: "skip", reason: "user-stopped" });
  });

  it("skips when this continuation was already sent", () => {
    const thread = makeThread({ messages: [continuationMessage("turn-1", 1_000)] });
    assert.deepEqual(decide(thread), { action: "skip", reason: "already-sent" });
  });

  it("skips while a question or approval is open, but not once it resolved", () => {
    const opened = (kind: string, requestId: string) =>
      ({
        id: EventId.makeUnsafe(`${kind}:${requestId}`),
        kind,
        createdAt: iso(1_000),
        payload: { requestId },
        turnId,
      }) as unknown as OrchestrationThread["activities"][number];
    for (const kind of ["user-input.requested", "approval.requested"]) {
      assert.deepEqual(decide(makeThread({ activities: [opened(kind, "r1")] })), {
        action: "skip",
        reason: "pending-request",
      });
    }
    const resolved = makeThread({
      activities: [opened("approval.requested", "r1"), opened("approval.resolved", "r1")],
    });
    assert.equal(decide(resolved).action, "send");
  });

  it("caps continuations inside the window and frees up once they age out", () => {
    const recent = Array.from({ length: RESTART_CONTINUATION_MAX_IN_WINDOW }, (_, index) =>
      continuationMessage(`old-${index}`, 1_000 * (index + 1)),
    );
    assert.deepEqual(decide(makeThread({ messages: recent })), {
      action: "skip",
      reason: "loop-cap",
    });
    const aged = recent.map((message, index) =>
      index === 0 ? continuationMessage("aged", RESTART_CONTINUATION_WINDOW_MS + 1) : message,
    );
    assert.equal(decide(makeThread({ messages: aged })).action, "send");
  });
});

describe("readRestartContinuationMarker", () => {
  it("reads a turn id and rejects anything else", () => {
    assert.equal(readRestartContinuationMarker({ [RESTART_CONTINUATION_MARKER_KEY]: "t" }), "t");
    for (const payload of [
      null,
      undefined,
      "x",
      [],
      {},
      { [RESTART_CONTINUATION_MARKER_KEY]: null },
      { [RESTART_CONTINUATION_MARKER_KEY]: "" },
      { [RESTART_CONTINUATION_MARKER_KEY]: 7 },
    ]) {
      assert.isNull(readRestartContinuationMarker(payload));
    }
  });
});

describe("markSessionsForRestartContinuation", () => {
  const session = (id: string, activeTurnId?: string) =>
    ({
      threadId: ThreadId.makeUnsafe(id),
      provider: "claudeAgent",
      ...(activeTurnId !== undefined ? { activeTurnId: TurnId.makeUnsafe(activeTurnId) } : {}),
    }) as unknown as ProviderSession;

  it.effect("marks active turns only, and tolerates one failed write", () =>
    Effect.gen(function* () {
      const upserts: Array<ProviderRuntimeBinding> = [];
      yield* markSessionsForRestartContinuation({
        enabled: true,
        sessions: [
          session("write-fails", "turn-a"),
          session("active", "turn-b"),
          session("idle"),
          session("stop-requested", "turn-c"),
        ],
        interruptRequestedThreadIds: new Set([ThreadId.makeUnsafe("stop-requested")]),
        directory: {
          upsert: (binding) =>
            binding.threadId === "write-fails"
              ? (Effect.fail(new Error("disk full")) as never)
              : Effect.sync(() => {
                  upserts.push(binding);
                }),
        },
      });
      assert.deepEqual<unknown>(upserts, [
        {
          threadId: "active",
          provider: "claudeAgent",
          runtimePayload: { [RESTART_CONTINUATION_MARKER_KEY]: "turn-b" },
        },
      ]);
    }),
  );

  it.effect("writes nothing while the setting is off", () =>
    Effect.gen(function* () {
      let writes = 0;
      yield* markSessionsForRestartContinuation({
        enabled: false,
        sessions: [session("active", "turn-b")],
        directory: { upsert: () => Effect.sync(() => void writes++) },
      });
      assert.equal(writes, 0);
    }),
  );
});

describe("takeRestartContinuations", () => {
  const binding = (id: string, payload: unknown, resumeCursor: unknown = { id: "c" }) =>
    ({
      threadId: ThreadId.makeUnsafe(id),
      provider: "claudeAgent",
      status: "stopped",
      resumeCursor,
      runtimePayload: payload,
    }) as ProviderRuntimeBinding;
  const marker = (turn: string) => ({
    [RESTART_CONTINUATION_MARKER_KEY]: turn,
    activeTurnId: null,
  });

  const run = (input: {
    readonly bindings: ReadonlyArray<ProviderRuntimeBinding>;
    readonly threads: ReadonlyArray<OrchestrationThread>;
    readonly enabled?: boolean;
    readonly failUpsertFor?: string;
  }) =>
    Effect.gen(function* () {
      const consumed: Array<string> = [];
      const continuations = yield* takeRestartContinuations.pipe(
        Effect.provideService(ProviderSessionDirectory, {
          listBindings: () => Effect.succeed(input.bindings),
          upsert: (next: ProviderRuntimeBinding) =>
            next.threadId === input.failUpsertFor
              ? Effect.die(new Error("write failed"))
              : Effect.sync(() => {
                  consumed.push(next.threadId);
                  assert.deepEqual<unknown>(next.runtimePayload, {
                    [RESTART_CONTINUATION_MARKER_KEY]: null,
                  });
                }),
        } as unknown as ProviderSessionDirectoryShape),
        Effect.provideService(OrchestrationEngineService, {
          getReadModel: () =>
            Effect.succeed({
              snapshotSequence: 1,
              projects: new Map(),
              threads: new Map(input.threads.map((thread) => [thread.id, thread])),
              updatedAt: iso(0),
            }),
        } as unknown as OrchestrationEngineShape),
        Effect.provideService(ServerSettingsService, {
          getSettings: Effect.succeed({
            ...DEFAULT_SERVER_SETTINGS,
            continueThreadsAfterRestart: input.enabled ?? true,
          }),
        } as unknown as ServerSettingsShape),
      );
      return { continuations, consumed };
    });

  const threadNamed = (id: string, turn: string) =>
    makeThread({
      id: ThreadId.makeUnsafe(id),
      latestTurn: {
        turnId: TurnId.makeUnsafe(turn),
        state: "running",
        requestedAt: new Date().toISOString(),
        startedAt: null,
        completedAt: null,
        assistantMessageId: null,
      },
    });

  it.effect("consumes every marker and selects only the threads that qualify", () =>
    Effect.gen(function* () {
      const { continuations, consumed } = yield* run({
        bindings: [
          binding("continue", marker("turn-a")),
          binding("no-cursor", marker("turn-b"), null),
          binding("unmarked", { activeTurnId: null }),
          binding("cleared", { [RESTART_CONTINUATION_MARKER_KEY]: null }),
        ],
        threads: [threadNamed("continue", "turn-a"), threadNamed("no-cursor", "turn-b")],
      });
      assert.deepEqual<unknown>(continuations, [
        {
          threadId: "continue",
          turnId: "turn-a",
          messageId: "message:restart-continuation:turn-a",
        },
      ]);
      assert.deepEqual(consumed, ["continue", "no-cursor"]);
    }),
  );

  it.effect("consumes markers without continuing while the setting is off", () =>
    Effect.gen(function* () {
      const { continuations, consumed } = yield* run({
        enabled: false,
        bindings: [binding("continue", marker("turn-a"))],
        threads: [threadNamed("continue", "turn-a")],
      });
      assert.deepEqual(continuations, []);
      assert.deepEqual(consumed, ["continue"]);
    }),
  );

  it.effect("does not continue a thread whose marker could not be consumed", () =>
    Effect.gen(function* () {
      const { continuations } = yield* run({
        failUpsertFor: "stuck",
        bindings: [binding("stuck", marker("turn-a")), binding("fine", marker("turn-b"))],
        threads: [threadNamed("stuck", "turn-a"), threadNamed("fine", "turn-b")],
      });
      assert.deepEqual(
        continuations.map((continuation) => continuation.threadId as string),
        ["fine"],
      );
    }),
  );

  it.effect("yields nothing when bindings cannot be read", () =>
    Effect.gen(function* () {
      const continuations = yield* takeRestartContinuations.pipe(
        Effect.provideService(ProviderSessionDirectory, {
          listBindings: () => Effect.die(new Error("db gone")),
        } as unknown as ProviderSessionDirectoryShape),
        Effect.provideService(
          OrchestrationEngineService,
          {} as unknown as OrchestrationEngineShape,
        ),
      );
      assert.deepEqual(continuations, []);
    }),
  );

  it.effect("falls back to reading each binding when listBindings is absent", () =>
    Effect.gen(function* () {
      const row = binding("continue", marker("turn-a"));
      const continuations = yield* takeRestartContinuations.pipe(
        Effect.provideService(ProviderSessionDirectory, {
          listThreadIds: () => Effect.succeed([row.threadId]),
          getBinding: () => Effect.succeed(Option.some(row)),
          upsert: () => Effect.void,
        } as unknown as ProviderSessionDirectoryShape),
        Effect.provideService(OrchestrationEngineService, {
          getReadModel: () =>
            Effect.succeed({
              threads: new Map([[row.threadId, threadNamed("continue", "turn-a")]]),
            }),
        } as unknown as OrchestrationEngineShape),
        Effect.provideService(ServerSettingsService, {
          getSettings: Effect.succeed({
            ...DEFAULT_SERVER_SETTINGS,
            continueThreadsAfterRestart: true,
          }),
        } as unknown as ServerSettingsShape),
      );
      assert.equal(continuations.length, 1);
    }),
  );
});

describe("dispatchRestartContinuations", () => {
  it.effect("sends the prompt through a turn start and survives one failed dispatch", () =>
    Effect.gen(function* () {
      const dispatched: Array<OrchestrationCommand> = [];
      const failing = ThreadId.makeUnsafe("fails");
      yield* dispatchRestartContinuations([
        { threadId: failing, turnId, messageId: restartContinuationMessageId(turnId) },
        { threadId, turnId, messageId: restartContinuationMessageId(turnId) },
        {
          threadId: ThreadId.makeUnsafe("gone"),
          turnId,
          messageId: restartContinuationMessageId(turnId),
        },
      ]).pipe(
        Effect.provideService(OrchestrationEngineService, {
          getReadModel: () =>
            Effect.succeed({
              threads: new Map([
                [failing, makeThread({ id: failing })],
                [threadId, makeThread()],
              ]),
            }),
          dispatch: (command: OrchestrationCommand) =>
            "threadId" in command && command.threadId === failing
              ? Effect.die(new Error("dispatch failed"))
              : Effect.sync(() => {
                  dispatched.push(command);
                  return { sequence: 1 };
                }),
        } as unknown as OrchestrationEngineShape),
      );
      assert.equal(dispatched.length, 1);
      const command = dispatched[0]!;
      assert.equal(command.type, "thread.turn.start");
      if (command.type !== "thread.turn.start") return;
      assert.equal(command.threadId, threadId);
      assert.equal(command.message.messageId, restartContinuationMessageId(turnId));
      assert.equal(command.message.text, RESTART_CONTINUATION_TEXT);
      assert.equal(command.runtimeMode, "full-access");
      assert.equal(command.interactionMode, "default");
    }),
  );
});

describe("marker survival", () => {
  it.effect("is kept by the payloads shutdown and reconcile write to the real directory", () =>
    Effect.gen(function* () {
      const rows = new Map<string, ProviderSessionRuntime>();
      const repository = {
        getByThreadId: ({ threadId: id }: { threadId: ThreadId }) =>
          Effect.sync(() => Option.fromNullishOr(rows.get(id))),
        upsert: (row: ProviderSessionRuntime) =>
          Effect.sync(() => void rows.set(row.threadId, row)),
      } as unknown as ProviderSessionRuntimeRepositoryShape;
      const directory = yield* Effect.service(ProviderSessionDirectory).pipe(
        Effect.provide(
          ProviderSessionDirectoryLive.pipe(
            Layer.provide(Layer.succeed(ProviderSessionRuntimeRepository, repository)),
          ),
        ),
      );
      const read = directory
        .getBinding(threadId)
        .pipe(
          Effect.map((row) => readRestartContinuationMarker(Option.getOrThrow(row).runtimePayload)),
        );

      yield* directory.upsert({
        threadId,
        provider: "claudeAgent",
        status: "running",
        resumeCursor: { id: "cursor" },
        runtimePayload: { activeTurnId: turnId },
      });
      yield* markSessionsForRestartContinuation({
        enabled: true,
        sessions: [
          { threadId, provider: "claudeAgent", activeTurnId: turnId } as unknown as ProviderSession,
        ],
        directory,
      });
      // runStopAll's session binding, its stopped rewrite, and reconcile's rewrite, in order.
      for (const runtimePayload of [
        { cwd: "/repo", activeTurnId: turnId, lastRuntimeEvent: "provider.stopAll" },
        { activeTurnId: null, lastRuntimeEvent: "provider.stopAll" },
        { activeTurnId: null },
      ]) {
        yield* directory.upsert({ threadId, provider: "claudeAgent", runtimePayload });
        assert.equal(yield* read, turnId);
      }
      const binding = Option.getOrThrow(yield* directory.getBinding(threadId));
      assert.deepEqual<unknown>(binding.resumeCursor, { id: "cursor" });
    }),
  );
});
