/**
 * ProviderSessionReaperLive - Stops provider sessions that nobody is using.
 *
 * Two triggers:
 * - a periodic sweep stops sessions whose thread has been idle (no active
 *   turn, no pending approval or user-input request) for longer than the
 *   idle threshold, so leaked provider processes do not accumulate;
 * - archiving or deleting a thread (or deleting its project) stops its
 *   session right away; deletion also drops the persisted binding when the
 *   runtime repository is available.
 *
 * `ProviderService.stopSession` keeps the resume cursor, so a reaped thread
 * resumes transparently on its next turn.
 *
 * @module ProviderSessionReaperLive
 */
import {
  CommandId,
  type OrchestrationEvent,
  type OrchestrationThread,
  type ProviderSession,
  type ThreadId,
} from "@piedpiper/contracts";
import { Cause, Duration, Effect, Option, PubSub } from "effect";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProviderSessionRuntimeRepository } from "../../persistence/Services/ProviderSessionRuntime.ts";
import { ProviderService } from "../Services/ProviderService.ts";
import { type ProviderSessionReaperShape } from "../Services/ProviderSessionReaper.ts";

const DEFAULT_PROVIDER_SESSION_IDLE_THRESHOLD_MS = 30 * 60 * 1000;
const DEFAULT_PROVIDER_SESSION_SWEEP_INTERVAL_MS = 60 * 1000;
/** A background task silent this long is treated as lost, so a missed completion cannot pin a process. */
export const BACKGROUND_TASK_MAX_SILENCE_MS = 6 * 60 * 60 * 1000;

export interface ProviderSessionReaperOptions {
  readonly idleThresholdMs?: number;
  readonly sweepIntervalMs?: number;
  /** Clock override for tests; defaults to `Date.now`. */
  readonly now?: () => number;
}

type ReapReason = "idle" | "archived" | "deleted";

const PENDING_REQUEST_KINDS: Record<string, "open" | "close"> = {
  "approval.requested": "open",
  "user-input.requested": "open",
  "approval.resolved": "close",
  "user-input.resolved": "close",
};

function parseTime(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function activityTaskId(activity: OrchestrationThread["activities"][number]): string | null {
  const payload = activity.payload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const taskId = (payload as { taskId?: unknown }).taskId;
  return typeof taskId === "string" && taskId.length > 0 ? taskId : null;
}

function activityRequestId(activity: OrchestrationThread["activities"][number]): string | null {
  const payload = activity.payload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const requestId = (payload as { requestId?: unknown }).requestId;
  return typeof requestId === "string" && requestId.length > 0 ? requestId : null;
}

/**
 * True when the thread has an approval or user-input request that was opened
 * during this provider session and never resolved.
 */
export function hasPendingProviderRequest(
  thread: Pick<OrchestrationThread, "activities">,
  sessionCreatedAt: string,
): boolean {
  const sessionStart = parseTime(sessionCreatedAt);
  const pending = new Set<string>();
  for (const activity of thread.activities) {
    const transition = PENDING_REQUEST_KINDS[activity.kind];
    if (transition === undefined) continue;
    const requestId = activityRequestId(activity);
    if (requestId === null) continue;
    if (transition === "close") {
      pending.delete(requestId);
      continue;
    }
    // A non-blocking question leaves nothing waiting, and its answer can resume the session later.
    if ((activity.payload as { responseMode?: unknown } | null)?.responseMode === "message") {
      continue;
    }
    // Requests from earlier sessions cannot be answered any more; ignore them.
    const openedAt = parseTime(activity.createdAt);
    if (sessionStart !== null && openedAt !== null && openedAt < sessionStart) continue;
    pending.add(requestId);
  }
  return pending.size > 0;
}

/**
 * True when a Claude session still has a background task (subagent, background
 * shell) that started during this session, has not completed, and reported
 * activity within `BACKGROUND_TASK_MAX_SILENCE_MS`. Codex is excluded because
 * it maps every turn to a task and an aborted turn can leave one unfinished.
 */
export function hasLiveBackgroundTask(
  thread: Pick<OrchestrationThread, "activities">,
  session: Pick<ProviderSession, "provider" | "createdAt">,
  nowMs: number,
): boolean {
  if (session.provider !== "claudeAgent") return false;
  const sessionStart = parseTime(session.createdAt);
  const lastSeenByTask = new Map<string, number>();
  for (const activity of thread.activities) {
    if (
      activity.kind !== "task.started" &&
      activity.kind !== "task.progress" &&
      activity.kind !== "task.completed"
    ) {
      continue;
    }
    const taskId = activityTaskId(activity);
    if (taskId === null) continue;
    if (activity.kind === "task.completed") {
      lastSeenByTask.delete(taskId);
      continue;
    }
    const seenAt = parseTime(activity.createdAt);
    if (seenAt === null) continue;
    if (activity.kind === "task.started") {
      if (sessionStart !== null && seenAt < sessionStart) continue;
      lastSeenByTask.set(taskId, seenAt);
      continue;
    }
    if (lastSeenByTask.has(taskId)) lastSeenByTask.set(taskId, seenAt);
  }
  for (const seenAt of lastSeenByTask.values()) {
    if (nowMs - seenAt < BACKGROUND_TASK_MAX_SILENCE_MS) return true;
  }
  return false;
}

/**
 * Resolve when a provider session went idle, or `null` while it is busy.
 *
 * Busy means: the provider reports a running/connecting session or an active
 * turn, the orchestration session is starting/running or tracks an active
 * turn, an approval/user-input request is still pending, or a Claude
 * background task is still running (per the adapter or the thread's activities).
 */
export function resolveProviderSessionIdleSince(input: {
  readonly session: ProviderSession;
  readonly thread: OrchestrationThread | undefined;
  readonly now?: number;
  /** Background tasks the adapter still tracks; covers tasks whose activities fell out of the read model. */
  readonly liveBackgroundTaskCount?: number;
}): number | null {
  const { session, thread } = input;
  if (session.status === "running" || session.status === "connecting") return null;
  if (session.activeTurnId !== undefined) return null;
  if ((input.liveBackgroundTaskCount ?? 0) > 0) return null;

  const orchestrationSession = thread?.session ?? null;
  if (orchestrationSession !== null) {
    if (orchestrationSession.status === "running" || orchestrationSession.status === "starting") {
      return null;
    }
    if (orchestrationSession.activeTurnId !== null) return null;
  }
  if (thread !== undefined && hasPendingProviderRequest(thread, session.createdAt)) return null;
  if (thread !== undefined && hasLiveBackgroundTask(thread, session, input.now ?? Date.now())) {
    return null;
  }

  const candidates = [
    parseTime(session.updatedAt),
    parseTime(session.createdAt),
    parseTime(thread?.updatedAt),
    parseTime(orchestrationSession?.updatedAt),
  ].filter((value): value is number => value !== null);
  return candidates.length === 0 ? null : Math.max(...candidates);
}

export const makeProviderSessionReaper = Effect.fn("makeProviderSessionReaper")(function* (
  options?: ProviderSessionReaperOptions,
) {
  const providerService = yield* ProviderService;
  const orchestrationEngine = yield* OrchestrationEngineService;
  // Optional so the reaper also runs where provider persistence is not wired.
  const runtimeRepository = yield* Effect.serviceOption(ProviderSessionRuntimeRepository);

  const idleThresholdMs = Math.max(
    1,
    options?.idleThresholdMs ?? DEFAULT_PROVIDER_SESSION_IDLE_THRESHOLD_MS,
  );
  const sweepIntervalMs = Math.max(
    1,
    options?.sweepIntervalMs ?? DEFAULT_PROVIDER_SESSION_SWEEP_INTERVAL_MS,
  );
  const now = options?.now ?? Date.now;

  const countLiveBackgroundTasks = (session: ProviderSession) =>
    providerService.countLiveBackgroundTasks?.({
      threadId: session.threadId,
      provider: session.provider,
    }) ?? Effect.succeed(0);

  const markThreadSessionStopped = Effect.fn("markThreadSessionStopped")(function* (
    threadId: ThreadId,
  ) {
    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.get(threadId);
    if (!thread?.session || thread.session.status === "stopped") return;
    const stoppedAt = new Date(now()).toISOString();
    yield* orchestrationEngine.dispatch({
      type: "thread.session.set",
      commandId: CommandId.makeUnsafe(`server:provider-session-reaped:${crypto.randomUUID()}`),
      threadId,
      session: {
        ...thread.session,
        status: "stopped",
        activeTurnId: null,
        updatedAt: stoppedAt,
      },
      createdAt: stoppedAt,
    });
  });

  // Returns true when a session was actually stopped.
  const stopSessionForThread = Effect.fn("stopSessionForThread")(function* (input: {
    readonly threadId: ThreadId;
    readonly reason: ReapReason;
    readonly idleMs?: number;
  }) {
    const sessions = yield* providerService.listSessions();
    const liveSession = sessions.find((session) => session.threadId === input.threadId);
    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.get(input.threadId);
    const orchestrationActive =
      thread?.session !== null &&
      thread?.session !== undefined &&
      thread.session.status !== "stopped";
    if (liveSession === undefined && !orchestrationActive) return false;
    if (input.reason === "idle") {
      // The sweep's snapshot may be stale by now: a turn or approval may have started since.
      if (liveSession === undefined) return false;
      const idleSince = resolveProviderSessionIdleSince({
        session: liveSession,
        thread,
        now: now(),
        liveBackgroundTaskCount: yield* countLiveBackgroundTasks(liveSession),
      });
      if (idleSince === null || now() - idleSince < idleThresholdMs) return false;
    }

    const stopped = yield* providerService.stopSession({ threadId: input.threadId }).pipe(
      Effect.as(true),
      Effect.catchCause((cause) =>
        Effect.logWarning("provider.session.reaper.stop-failed", {
          threadId: input.threadId,
          reason: input.reason,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(false)),
      ),
    );
    yield* markThreadSessionStopped(input.threadId).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider.session.reaper.session-set-failed", {
          threadId: input.threadId,
          reason: input.reason,
          cause: Cause.pretty(cause),
        }),
      ),
    );
    if (stopped && liveSession !== undefined) {
      yield* Effect.logInfo("provider.session.reaped", {
        threadId: input.threadId,
        provider: liveSession?.provider ?? thread?.session?.providerName ?? null,
        reason: input.reason,
        ...(input.idleMs !== undefined ? { idleMs: input.idleMs } : {}),
      });
    }
    return stopped && liveSession !== undefined;
  });

  // A deleted thread will never resume, so its binding (and resume cursor) is dead weight.
  const removeBinding = (threadId: ThreadId) =>
    Option.match(runtimeRepository, {
      onNone: () => Effect.void,
      onSome: (repository) =>
        repository.deleteByThreadId({ threadId }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("provider.session.reaper.remove-binding-failed", {
              threadId,
              cause: Cause.pretty(cause),
            }),
          ),
        ),
    });

  const handleDeletedThread = (threadId: ThreadId) =>
    stopSessionForThread({ threadId, reason: "deleted" }).pipe(
      Effect.andThen(removeBinding(threadId)),
    );

  const handleDomainEvent = Effect.fn("handleDomainEvent")(function* (event: OrchestrationEvent) {
    switch (event.type) {
      case "thread.archived":
        yield* stopSessionForThread({ threadId: event.payload.threadId, reason: "archived" });
        return;
      case "thread.deleted":
        yield* handleDeletedThread(event.payload.threadId);
        return;
      case "project.deleted": {
        // Project deletion does not emit thread.deleted for the project's threads.
        const readModel = yield* orchestrationEngine.getReadModel();
        const threadIds = [...readModel.threads.values()]
          .filter((thread) => thread.projectId === event.payload.projectId)
          .map((thread) => thread.id);
        yield* Effect.forEach(
          threadIds,
          (threadId) =>
            handleDeletedThread(threadId).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("provider.session.reaper.event-failed", {
                  eventType: event.type,
                  threadId,
                  cause: Cause.pretty(cause),
                }),
              ),
            ),
          { discard: true },
        );
        return;
      }
      default:
        return;
    }
  });

  const sweep: ProviderSessionReaperShape["sweep"] = Effect.gen(function* () {
    const sessions = yield* providerService.listSessions();
    if (sessions.length === 0) return 0;
    const readModel = yield* orchestrationEngine.getReadModel();
    const sweepStartedAt = now();
    let reaped = 0;
    for (const session of sessions) {
      const thread = readModel.threads.get(session.threadId);
      const idleSince = resolveProviderSessionIdleSince({ session, thread, now: sweepStartedAt });
      if (idleSince === null) continue;
      const idleMs = sweepStartedAt - idleSince;
      if (idleMs < idleThresholdMs) continue;
      if ((yield* countLiveBackgroundTasks(session)) > 0) continue;
      const stopped = yield* stopSessionForThread({
        threadId: session.threadId,
        reason: "idle",
        idleMs,
      });
      if (stopped) reaped += 1;
    }
    return reaped;
  }).pipe(
    Effect.withSpan("providerSessionReaperSweep"),
    Effect.catchCause((cause) =>
      Effect.logWarning("provider.session.reaper.sweep-failed", {
        cause: Cause.pretty(cause),
      }).pipe(Effect.as(0)),
    ),
  );

  const start: ProviderSessionReaperShape["start"] = Effect.fn("start")(function* () {
    // Subscribe synchronously BEFORE forking the consumer loop. See note in
    // CheckpointReactor.start for why this matters.
    const domainEventQueue = yield* orchestrationEngine.subscribeDomainEvents();

    yield* Effect.forkScoped(
      Effect.forever(
        PubSub.take(domainEventQueue).pipe(
          Effect.flatMap((event) =>
            handleDomainEvent(event).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("provider.session.reaper.event-failed", {
                  eventType: event.type,
                  cause: Cause.pretty(cause),
                }),
              ),
            ),
          ),
        ),
      ),
    );

    yield* Effect.forkScoped(
      Effect.forever(Effect.sleep(Duration.millis(sweepIntervalMs)).pipe(Effect.andThen(sweep))),
    );

    yield* Effect.logDebug("provider.session.reaper.started", {
      idleThresholdMs,
      sweepIntervalMs,
    });
  });

  return {
    start,
    sweep,
  } satisfies ProviderSessionReaperShape;
});
