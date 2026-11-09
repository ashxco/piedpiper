import {
  CommandId,
  THREAD_USAGE_LIMIT_ACTIVITY_KIND,
  THREAD_USAGE_LIMIT_RESUME_CANCELLED_ACTIVITY_KIND,
  type MessageId,
  type OrchestrationEvent,
  type OrchestrationThread,
  type ThreadId,
  type TurnId,
} from "@piedpiper/contracts";
import { makeDrainableWorker } from "@piedpiper/shared/DrainableWorker";
import { Cause, Clock, Duration, Effect, Layer, PubSub, Stream } from "effect";

import { ServerSettingsService } from "../../serverSettings.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  UsageLimitResumeReactor,
  type UsageLimitResumeReactorShape,
} from "../Services/UsageLimitResumeReactor.ts";
import {
  decideUsageLimitResume,
  isRetriableUsageLimitRefusal,
  readLatestUsageLimit,
  USAGE_LIMIT_RESUME_TEXT,
  usageLimitResumeCommandId,
  type UsageLimitResumePhase,
} from "../usageLimitResume.ts";

// Short ticks instead of one long timer: a sleeping laptop pauses timers, and long ones overflow.
const TICK_INTERVAL = Duration.seconds(30);

type WorkItem =
  | { readonly type: "event"; readonly event: OrchestrationEvent }
  | { readonly type: "tick" }
  | { readonly type: "rescan"; readonly phase: UsageLimitResumePhase };

const isRelevantEvent = (event: OrchestrationEvent): boolean => {
  switch (event.type) {
    case "thread.activity-appended":
      return (
        event.payload.activity.kind === THREAD_USAGE_LIMIT_ACTIVITY_KIND ||
        event.payload.activity.kind === THREAD_USAGE_LIMIT_RESUME_CANCELLED_ACTIVITY_KIND
      );
    case "thread.turn-start-requested":
    case "thread.turn-interrupt-requested":
    case "thread.session-stop-requested":
    case "thread.archived":
    case "thread.deleted":
      return true;
    default:
      return false;
  }
};

export const makeUsageLimitResumeReactor = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const serverSettings = yield* ServerSettingsService;

  const armed = new Map<ThreadId, number>();
  // A Stop can land just before the limit failure it raced; remembered until the next turn start.
  const stopSeen = new Set<ThreadId>();

  const readThread = (threadId: ThreadId) =>
    orchestrationEngine.getReadModel().pipe(Effect.map((model) => model.threads.get(threadId)));

  const cancelResume = (threadId: ThreadId, turnId: TurnId, createdAt: string) =>
    orchestrationEngine.dispatch({
      type: "thread.usage-limit-resume.cancel",
      commandId: CommandId.makeUnsafe(`usage-limit-resume-cancel:${threadId}:${turnId}`),
      threadId,
      turnId,
      createdAt,
    });

  const sendResume = Effect.fn("sendResume")(function* (
    thread: OrchestrationThread,
    decision: { readonly messageId: MessageId; readonly resend: boolean },
    nowMs: number,
  ) {
    yield* Effect.logInfo("resuming thread after its usage limit reset", {
      threadId: thread.id,
      resend: decision.resend,
    });
    yield* orchestrationEngine.dispatch({
      type: "thread.turn.start",
      // A resend needs a fresh command: the first one's receipt would swallow it.
      commandId: usageLimitResumeCommandId(
        decision.messageId,
        decision.resend ? `restart-${nowMs}` : undefined,
      ),
      threadId: thread.id,
      message: {
        messageId: decision.messageId,
        role: "user",
        text: USAGE_LIMIT_RESUME_TEXT,
        attachments: [],
      },
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      createdAt: new Date(nowMs).toISOString(),
    });
  });

  const evaluate = Effect.fn("evaluate")(function* (
    threadId: ThreadId,
    phase: UsageLimitResumePhase,
  ) {
    const thread = yield* readThread(threadId);
    if (thread === undefined) {
      armed.delete(threadId);
      return;
    }
    const settings = yield* serverSettings.getSettings;
    const nowMs = yield* Clock.currentTimeMillis;
    const decision = decideUsageLimitResume({
      threadId,
      thread,
      enabled: settings.autoResumeLimitedThreads,
      nowMs,
      phase,
    });
    if (decision.action === "wait") {
      armed.set(threadId, decision.dueAtMs);
      return;
    }
    if (decision.action === "none" && isRetriableUsageLimitRefusal(decision.reason)) {
      // Past due is fine: the next tick decides again, and sends once the request or run clears.
      const resetAt = readLatestUsageLimit(thread.activities)?.resetAt;
      if (resetAt) armed.set(threadId, Date.parse(resetAt));
      return;
    }
    armed.delete(threadId);
    if (decision.action === "send") {
      yield* sendResume(thread, decision, nowMs);
    }
  });

  /** Records a durable cancel when this thread has a limit that could still resume. */
  const cancelIfPending = Effect.fn("cancelIfPending")(function* (
    threadId: ThreadId,
    createdAt: string,
  ) {
    armed.delete(threadId);
    const thread = yield* readThread(threadId);
    if (thread === undefined) return;
    // Ignores the setting and the archive itself, so neither turning the setting on later nor
    // unarchiving can resume a thread the user stopped or put away.
    const decision = decideUsageLimitResume({
      threadId,
      thread: { ...thread, archivedAt: null },
      enabled: true,
      nowMs: yield* Clock.currentTimeMillis,
      phase: "firing",
    });
    const limit = readLatestUsageLimit(thread.activities);
    if (limit === null) return;
    if (decision.action !== "none" || isRetriableUsageLimitRefusal(decision.reason)) {
      yield* cancelResume(threadId, limit.turnId, createdAt);
    }
  });

  const processEvent = Effect.fn("processEvent")(function* (event: OrchestrationEvent) {
    switch (event.type) {
      case "thread.activity-appended": {
        const { threadId, activity } = event.payload;
        if (activity.kind === THREAD_USAGE_LIMIT_RESUME_CANCELLED_ACTIVITY_KIND) {
          armed.delete(threadId);
          return;
        }
        if (stopSeen.has(threadId) && activity.turnId !== null) {
          yield* cancelResume(threadId, activity.turnId, activity.createdAt);
          return;
        }
        yield* evaluate(threadId, "arming");
        return;
      }
      case "thread.turn-start-requested":
        stopSeen.delete(event.payload.threadId);
        armed.delete(event.payload.threadId);
        return;
      case "thread.session-stop-requested":
        if (event.payload.keepUsageLimitResume) return;
        stopSeen.add(event.payload.threadId);
        yield* cancelIfPending(event.payload.threadId, event.payload.createdAt);
        return;
      case "thread.turn-interrupt-requested":
        stopSeen.add(event.payload.threadId);
        yield* cancelIfPending(event.payload.threadId, event.payload.createdAt);
        return;
      case "thread.archived":
        yield* cancelIfPending(event.payload.threadId, event.occurredAt);
        return;
      case "thread.deleted":
        stopSeen.delete(event.payload.threadId);
        armed.delete(event.payload.threadId);
        return;
      default:
        return;
    }
  });

  const processTick = Effect.fn("processTick")(function* () {
    if (armed.size === 0) return;
    const nowMs = yield* Clock.currentTimeMillis;
    for (const [threadId, dueAtMs] of Array.from(armed)) {
      if (nowMs < dueAtMs) continue;
      yield* evaluate(threadId, "firing").pipe(
        Effect.catchCause((cause) => {
          // The command's receipt makes a retry pointless; the failure is the thread's to show.
          armed.delete(threadId);
          return Effect.logWarning("usage limit resume failed", {
            threadId,
            cause: Cause.pretty(cause),
          });
        }),
      );
    }
  });

  const processRescan = Effect.fn("processRescan")(function* (phase: UsageLimitResumePhase) {
    const settings = yield* serverSettings.getSettings;
    if (!settings.autoResumeLimitedThreads) return;
    const model = yield* orchestrationEngine.getReadModel();
    for (const thread of model.threads.values()) {
      if (armed.has(thread.id) || readLatestUsageLimit(thread.activities) === null) continue;
      yield* evaluate(thread.id, phase).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("usage limit resume failed", {
            threadId: thread.id,
            cause: Cause.pretty(cause),
          }),
        ),
      );
    }
  });

  const processItem = (item: WorkItem) => {
    switch (item.type) {
      case "event":
        return processEvent(item.event);
      case "tick":
        return processTick();
      case "rescan":
        return processRescan(item.phase);
    }
  };

  const worker = yield* makeDrainableWorker((item: WorkItem) =>
    processItem(item).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("usage limit resume reactor failed to process an item", {
              item: item.type,
              cause: Cause.pretty(cause),
            }),
      ),
    ),
  );

  const start: UsageLimitResumeReactorShape["start"] = Effect.fn("start")(function* () {
    // Subscribed before the scan, so a limit landing during it is not missed.
    const domainEvents = yield* orchestrationEngine.subscribeDomainEvents();
    yield* Effect.forkScoped(
      Effect.forever(
        PubSub.take(domainEvents).pipe(
          Effect.flatMap((event) =>
            isRelevantEvent(event) ? worker.enqueue({ type: "event", event }) : Effect.void,
          ),
        ),
      ),
    );

    let wasEnabled = yield* serverSettings.getSettings.pipe(
      Effect.map((settings) => settings.autoResumeLimitedThreads),
      Effect.orElseSucceed(() => false),
    );
    yield* Effect.forkScoped(
      Stream.runForEach(serverSettings.streamChanges, (settings) => {
        const flippedOn = settings.autoResumeLimitedThreads && !wasEnabled;
        wasEnabled = settings.autoResumeLimitedThreads;
        return flippedOn ? worker.enqueue({ type: "rescan", phase: "arming" }) : Effect.void;
      }),
    );

    yield* Effect.forkScoped(
      Effect.forever(
        Effect.sleep(TICK_INTERVAL).pipe(Effect.andThen(worker.enqueue({ type: "tick" }))),
      ),
    );

    yield* worker.enqueue({ type: "rescan", phase: "restart" });
  });

  return {
    start,
    drain: worker.drain,
  } satisfies UsageLimitResumeReactorShape;
});

export const UsageLimitResumeReactorLive = Layer.effect(
  UsageLimitResumeReactor,
  makeUsageLimitResumeReactor,
);
