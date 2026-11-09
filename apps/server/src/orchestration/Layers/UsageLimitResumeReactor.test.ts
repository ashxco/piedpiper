import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  THREAD_USAGE_LIMIT_ACTIVITY_KIND,
  THREAD_USAGE_LIMIT_RESUME_CANCELLED_ACTIVITY_KIND,
  ThreadId,
  TurnId,
} from "@piedpiper/contracts";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";

import { ServerConfig } from "../../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import type { OrchestrationDispatchError } from "../Errors.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { makeUsageLimitResumeReactor } from "./UsageLimitResumeReactor.ts";

const projectId = ProjectId.makeUnsafe("project-1");
const threadId = ThreadId.makeUnsafe("thread-1");
const turnId = TurnId.makeUnsafe("turn-1");
const failedMs = Date.parse("2026-03-01T10:00:00.000Z");
const failedAt = new Date(failedMs).toISOString();
const resetMs = failedMs + 60 * 60 * 1000;
const resetAt = new Date(resetMs).toISOString();
const resumeMessageId = `usage-limit-resume:thread-1:turn-1:${resetMs}`;

const makeLayer = (autoResumeLimitedThreads: boolean) =>
  OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(SqlitePersistenceMemory),
    Layer.provideMerge(ServerSettingsService.layerTest({ autoResumeLimitedThreads })),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "piedpiper-usage-limit-resume-test-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

const seedLimitedThread = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  yield* engine.dispatch({
    type: "project.create",
    commandId: CommandId.makeUnsafe("cmd-project"),
    projectId,
    title: "Project",
    workspaceRoot: "/tmp/project-1",
    defaultModelSelection: null,
    createdAt: failedAt,
  });
  yield* engine.dispatch({
    type: "thread.create",
    commandId: CommandId.makeUnsafe("cmd-thread"),
    threadId,
    projectId,
    title: "Thread",
    modelSelection: { provider: "claudeAgent", model: "claude-sonnet-4-5" },
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    runtimeMode: "full-access",
    branch: null,
    worktreePath: null,
    createdAt: failedAt,
  });
  yield* engine.dispatch({
    type: "thread.session.set",
    commandId: CommandId.makeUnsafe("cmd-session-running"),
    threadId,
    session: {
      threadId,
      status: "running",
      providerName: "claudeAgent",
      runtimeMode: "full-access",
      activeTurnId: turnId,
      lastError: null,
      updatedAt: failedAt,
    },
    createdAt: failedAt,
  });
});

const failTurnOnLimit = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  yield* engine.dispatch({
    type: "thread.session.set",
    commandId: CommandId.makeUnsafe("cmd-session-error"),
    threadId,
    session: {
      threadId,
      status: "error",
      providerName: "claudeAgent",
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: "Usage limit reached",
      updatedAt: failedAt,
    },
    createdAt: failedAt,
  });
  yield* engine.dispatch({
    type: "thread.activity.append",
    commandId: CommandId.makeUnsafe("cmd-limit"),
    threadId,
    activity: {
      id: EventId.makeUnsafe("evt-limit"),
      tone: "error",
      kind: THREAD_USAGE_LIMIT_ACTIVITY_KIND,
      summary: "Usage limit reached",
      payload: { resetAt },
      turnId,
      createdAt: failedAt,
    },
    createdAt: failedAt,
  });
});

const readThread = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const model = yield* engine.getReadModel();
  return model.threads.get(threadId)!;
});

const resumeMessages = readThread.pipe(
  Effect.map((thread) =>
    thread.messages.filter((message) => message.id === MessageId.makeUnsafe(resumeMessageId)),
  ),
);

/** Runs `body` with a started reactor, with `settle` to let a dispatch reach its queue. */
const withReactor = <A, E, R>(body: (settle: Effect.Effect<void>) => Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const reactor = yield* makeUsageLimitResumeReactor;
      yield* reactor.start();
      const settle = Effect.gen(function* () {
        for (let round = 0; round < 5; round += 1) {
          yield* Effect.yieldNow;
          yield* TestClock.adjust(0);
          yield* reactor.drain;
        }
      });
      yield* settle;
      return yield* body(settle);
    }),
  );

const provideEnabled = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(makeLayer(true)));

describe("UsageLimitResumeReactor", () => {
  it.effect("sends one turn when the limit resets, attributed by its message id", () =>
    provideEnabled(
      Effect.gen(function* () {
        yield* TestClock.setTime(failedMs);
        yield* seedLimitedThread;
        yield* withReactor((settle) =>
          Effect.gen(function* () {
            yield* failTurnOnLimit;
            yield* settle;
            yield* TestClock.adjust("59 minutes");
            yield* settle;
            assert.lengthOf(yield* resumeMessages, 0);

            yield* TestClock.adjust("90 seconds");
            yield* settle;
            const [message] = yield* resumeMessages;
            assert.equal(message?.role, "user");
            assert.equal(message?.text, "Continue where you left off.");

            yield* TestClock.adjust("10 minutes");
            yield* settle;
            assert.lengthOf(yield* resumeMessages, 1);
            const thread = yield* readThread;
            assert.lengthOf(
              thread.messages.filter((entry) => entry.role === "user"),
              1,
            );
          }),
        );
      }),
    ),
  );

  it.effect("stays off unless the setting is on", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(failedMs);
      yield* seedLimitedThread;
      yield* withReactor((settle) =>
        Effect.gen(function* () {
          yield* failTurnOnLimit;
          yield* settle;
          yield* TestClock.adjust("2 hours");
          yield* settle;
          assert.lengthOf(yield* resumeMessages, 0);
        }),
      );
    }).pipe(Effect.provide(makeLayer(false))),
  );

  it.effect("re-arms after a restart without sending twice", () =>
    provideEnabled(
      Effect.gen(function* () {
        yield* TestClock.setTime(failedMs);
        yield* seedLimitedThread;
        yield* failTurnOnLimit;

        // The limit landed while no reactor ran; a new one arms from the read model.
        yield* withReactor((settle) =>
          Effect.gen(function* () {
            assert.lengthOf(yield* resumeMessages, 0);
            yield* TestClock.adjust("61 minutes");
            yield* settle;
            assert.lengthOf(yield* resumeMessages, 1);
          }),
        );
        const [firstSend] = yield* resumeMessages;

        // The next start finds the resume sent but its turn lost, and resends the same message.
        yield* withReactor((settle) =>
          Effect.gen(function* () {
            yield* TestClock.adjust("5 minutes");
            yield* settle;
            const thread = yield* readThread;
            assert.lengthOf(
              thread.messages.filter((entry) => entry.role === "user"),
              1,
            );
            const [resent] = yield* resumeMessages;
            assert.notEqual(resent?.updatedAt, firstSend?.updatedAt);
          }),
        );
      }),
    ),
  );

  it.effect("does not resend after the resumed turn started", () =>
    provideEnabled(
      Effect.gen(function* () {
        yield* TestClock.setTime(failedMs);
        yield* seedLimitedThread;
        yield* failTurnOnLimit;
        yield* withReactor((settle) =>
          Effect.gen(function* () {
            yield* TestClock.adjust("61 minutes");
            yield* settle;
          }),
        );
        const engine = yield* OrchestrationEngineService;
        const sentThread = yield* readThread;
        yield* engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.makeUnsafe("cmd-resumed-running"),
          threadId,
          session: {
            ...sentThread.session!,
            status: "running",
            activeTurnId: TurnId.makeUnsafe("turn-2"),
          },
          createdAt: new Date(resetMs + 1000).toISOString(),
        });
        const before = (yield* readThread).updatedAt;
        yield* withReactor((settle) =>
          Effect.gen(function* () {
            yield* TestClock.adjust("5 minutes");
            yield* settle;
            assert.equal((yield* readThread).updatedAt, before);
          }),
        );
      }),
    ),
  );

  const cancelledBy = (
    name: string,
    cancel: Effect.Effect<unknown, OrchestrationDispatchError, OrchestrationEngineService>,
  ) =>
    it.effect(`does not resume after ${name}`, () =>
      provideEnabled(
        Effect.gen(function* () {
          yield* TestClock.setTime(failedMs);
          yield* seedLimitedThread;
          yield* withReactor((settle) =>
            Effect.gen(function* () {
              yield* failTurnOnLimit;
              yield* settle;
              yield* cancel;
              yield* settle;
              yield* TestClock.adjust("2 hours");
              yield* settle;
              assert.lengthOf(yield* resumeMessages, 0);
            }),
          );
        }),
      ),
    );

  const later = new Date(failedMs + 1000).toISOString();
  cancelledBy(
    "Stop",
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      yield* engine.dispatch({
        type: "thread.session.stop",
        commandId: CommandId.makeUnsafe("cmd-stop"),
        threadId,
        createdAt: later,
      });
    }),
  );
  cancelledBy(
    "the banner's Cancel",
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      yield* engine.dispatch({
        type: "thread.usage-limit-resume.cancel",
        commandId: CommandId.makeUnsafe("cmd-cancel"),
        threadId,
        turnId,
        createdAt: later,
      });
    }),
  );
  cancelledBy(
    "archive",
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      yield* engine.dispatch({
        type: "thread.archive",
        commandId: CommandId.makeUnsafe("cmd-archive"),
        threadId,
      });
    }),
  );

  const hasDurableCancel = readThread.pipe(
    Effect.map((thread) =>
      thread.activities.some(
        (activity) => activity.kind === THREAD_USAGE_LIMIT_RESUME_CANCELLED_ACTIVITY_KIND,
      ),
    ),
  );

  it.effect("archiving cancels for good, so unarchiving and restarting never resumes", () =>
    provideEnabled(
      Effect.gen(function* () {
        yield* TestClock.setTime(failedMs);
        yield* seedLimitedThread;
        const engine = yield* OrchestrationEngineService;
        yield* withReactor((settle) =>
          Effect.gen(function* () {
            yield* failTurnOnLimit;
            yield* settle;
            yield* engine.dispatch({
              type: "thread.archive",
              commandId: CommandId.makeUnsafe("cmd-archive-durable"),
              threadId,
            });
            yield* settle;
            assert.isTrue(yield* hasDurableCancel);
          }),
        );
        yield* engine.dispatch({
          type: "thread.unarchive",
          commandId: CommandId.makeUnsafe("cmd-unarchive-durable"),
          threadId,
        });
        yield* withReactor((settle) =>
          Effect.gen(function* () {
            yield* TestClock.adjust("2 hours");
            yield* settle;
            assert.lengthOf(yield* resumeMessages, 0);
          }),
        );
      }),
    ),
  );

  it.effect("keeps the resume through a stop that only reloads the session", () =>
    provideEnabled(
      Effect.gen(function* () {
        yield* TestClock.setTime(failedMs);
        yield* seedLimitedThread;
        yield* withReactor((settle) =>
          Effect.gen(function* () {
            yield* failTurnOnLimit;
            yield* settle;
            const engine = yield* OrchestrationEngineService;
            yield* engine.dispatch({
              type: "thread.session.stop",
              commandId: CommandId.makeUnsafe("cmd-stop-reload"),
              threadId,
              keepUsageLimitResume: true,
              createdAt: later,
            });
            yield* settle;
            assert.isFalse(yield* hasDurableCancel);
            yield* TestClock.adjust("61 minutes");
            yield* settle;
            assert.lengthOf(yield* resumeMessages, 1);
          }),
        );
      }),
    ),
  );

  it.effect("still resumes a limit whose session was running when it landed and at reset", () =>
    provideEnabled(
      Effect.gen(function* () {
        yield* TestClock.setTime(failedMs);
        yield* seedLimitedThread;
        yield* withReactor((settle) =>
          Effect.gen(function* () {
            const engine = yield* OrchestrationEngineService;
            // Limit first, while the session still reads running: the arm must survive this.
            yield* engine.dispatch({
              type: "thread.activity.append",
              commandId: CommandId.makeUnsafe("cmd-limit-busy"),
              threadId,
              activity: {
                id: EventId.makeUnsafe("evt-limit-busy"),
                tone: "error",
                kind: THREAD_USAGE_LIMIT_ACTIVITY_KIND,
                summary: "Usage limit reached",
                payload: { resetAt },
                turnId,
                createdAt: failedAt,
              },
              createdAt: failedAt,
            });
            yield* settle;
            yield* TestClock.adjust("61 minutes");
            yield* settle;
            assert.lengthOf(yield* resumeMessages, 0);

            yield* failTurnOnLimit;
            yield* settle;
            yield* TestClock.adjust("31 seconds");
            yield* settle;
            assert.lengthOf(yield* resumeMessages, 1);
            yield* TestClock.adjust("10 minutes");
            yield* settle;
            assert.lengthOf(yield* resumeMessages, 1);
          }),
        );
      }),
    ),
  );

  it.effect("waits for a pending approval at reset, then resumes once it is answered", () =>
    provideEnabled(
      Effect.gen(function* () {
        yield* TestClock.setTime(failedMs);
        yield* seedLimitedThread;
        yield* withReactor((settle) =>
          Effect.gen(function* () {
            const engine = yield* OrchestrationEngineService;
            const appendRequest = (id: string, kind: string, createdAt: string) =>
              engine.dispatch({
                type: "thread.activity.append",
                commandId: CommandId.makeUnsafe(`cmd-${id}`),
                threadId,
                activity: {
                  id: EventId.makeUnsafe(id),
                  tone: "approval",
                  kind,
                  summary: kind,
                  payload: { requestId: "req-1" },
                  turnId,
                  createdAt,
                },
                createdAt,
              });
            yield* failTurnOnLimit;
            yield* appendRequest("evt-approval-open", "approval.requested", later);
            yield* settle;
            yield* TestClock.adjust("61 minutes");
            yield* settle;
            assert.lengthOf(yield* resumeMessages, 0);

            yield* appendRequest(
              "evt-approval-close",
              "approval.resolved",
              new Date(resetMs + 2 * 60 * 1000).toISOString(),
            );
            yield* settle;
            yield* TestClock.adjust("31 seconds");
            yield* settle;
            assert.lengthOf(yield* resumeMessages, 1);
          }),
        );
      }),
    ),
  );

  it.effect("a Stop during a pending approval cancels the resume durably", () =>
    provideEnabled(
      Effect.gen(function* () {
        yield* TestClock.setTime(failedMs);
        yield* seedLimitedThread;
        yield* withReactor((settle) =>
          Effect.gen(function* () {
            const engine = yield* OrchestrationEngineService;
            yield* failTurnOnLimit;
            yield* engine.dispatch({
              type: "thread.activity.append",
              commandId: CommandId.makeUnsafe("cmd-approval-open-stop"),
              threadId,
              activity: {
                id: EventId.makeUnsafe("evt-approval-open-stop"),
                tone: "approval",
                kind: "approval.requested",
                summary: "approval",
                payload: { requestId: "req-stop" },
                turnId,
                createdAt: later,
              },
              createdAt: later,
            });
            yield* settle;
            yield* engine.dispatch({
              type: "thread.session.stop",
              commandId: CommandId.makeUnsafe("cmd-stop-pending"),
              threadId,
              createdAt: later,
            });
            yield* settle;
            assert.isTrue(yield* hasDurableCancel);
          }),
        );
      }),
    ),
  );

  it.effect("does not resume after a new user message", () =>
    provideEnabled(
      Effect.gen(function* () {
        yield* TestClock.setTime(failedMs);
        yield* seedLimitedThread;
        yield* withReactor((settle) =>
          Effect.gen(function* () {
            yield* failTurnOnLimit;
            yield* settle;
            const engine = yield* OrchestrationEngineService;
            yield* engine.dispatch({
              type: "thread.turn.start",
              commandId: CommandId.makeUnsafe("cmd-user-turn"),
              threadId,
              message: {
                messageId: MessageId.makeUnsafe("msg-user"),
                role: "user",
                text: "Try again",
                attachments: [],
              },
              runtimeMode: "full-access",
              interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
              createdAt: later,
            });
            yield* settle;
            yield* TestClock.adjust("2 hours");
            yield* settle;
            assert.lengthOf(yield* resumeMessages, 0);
          }),
        );
      }),
    ),
  );

  it.effect("does not resume when Stop landed just before the limit failure", () =>
    provideEnabled(
      Effect.gen(function* () {
        yield* TestClock.setTime(failedMs);
        yield* seedLimitedThread;
        yield* withReactor((settle) =>
          Effect.gen(function* () {
            const engine = yield* OrchestrationEngineService;
            yield* engine.dispatch({
              type: "thread.turn.interrupt",
              commandId: CommandId.makeUnsafe("cmd-interrupt"),
              threadId,
              turnId,
              createdAt: failedAt,
            });
            yield* settle;
            yield* failTurnOnLimit;
            yield* settle;
            yield* TestClock.adjust("2 hours");
            yield* settle;
            assert.lengthOf(yield* resumeMessages, 0);
          }),
        );

        // The durable cancel keeps a restart from arming it again.
        yield* withReactor((settle) =>
          Effect.gen(function* () {
            yield* TestClock.adjust("2 hours");
            yield* settle;
            assert.lengthOf(yield* resumeMessages, 0);
          }),
        );
      }),
    ),
  );
});
