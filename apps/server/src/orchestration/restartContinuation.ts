/**
 * Continues turns that a graceful shutdown cut short. Shutdown leaves a marker on the provider
 * binding, because `session.exited` can clear the projection; the next start consumes every
 * marker, decides here, and sends a prompt that goes through the normal turn path.
 */
import {
  CommandId,
  MessageId,
  type OrchestrationThread,
  type ProviderSession,
  type ThreadId,
  TurnId,
} from "@piedpiper/contracts";
import { Cause, Effect, Option } from "effect";

import { latestProviderGoal } from "../codex/codexGoalCommand.ts";
import { hasPendingProviderRequest } from "../provider/Layers/ProviderSessionReaper.ts";
import {
  type ProviderRuntimeBinding,
  ProviderSessionDirectory,
  type ProviderSessionDirectoryShape,
} from "../provider/Services/ProviderSessionDirectory.ts";
import { getServerSettingsOrDefault } from "../serverSettings.ts";
import { isCompactCommandMessage } from "./compactCommand.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";

export const RESTART_CONTINUATION_MARKER_KEY = "continueAfterRestart";

// The web matches this prefix in apps/web/src/lib/restartContinuation.ts to show a notice.
export const RESTART_CONTINUATION_MESSAGE_ID_PREFIX = "message:restart-continuation:";

export const RESTART_CONTINUATION_TEXT =
  "Continue where you left off. Your last turn was cut short, so a command or other action it started may have finished or may still be running. Before you repeat one that changes state, confirm it did not take effect and is not still running; if you cannot tell, say so instead of repeating it.";

/** A turn that keeps taking the server down must not restart it forever. */
export const RESTART_CONTINUATION_MAX_IN_WINDOW = 3;
export const RESTART_CONTINUATION_WINDOW_MS = 5 * 60 * 1000;

export type RestartContinuationThread = Pick<
  OrchestrationThread,
  "activities" | "archivedAt" | "deletedAt" | "latestTurn" | "messages" | "session"
>;

export type RestartContinuationRefusal =
  | "disabled"
  | "missing-thread"
  | "archived"
  | "no-resume-cursor"
  | "stale"
  | "finished"
  | "maintenance-command"
  | "user-stopped"
  | "already-sent"
  | "pending-request"
  | "loop-cap";

export type RestartContinuationDecision =
  | { readonly action: "skip"; readonly reason: RestartContinuationRefusal }
  | { readonly action: "send"; readonly messageId: MessageId };

export function readRestartContinuationMarker(runtimePayload: unknown): TurnId | null {
  if (runtimePayload === null || typeof runtimePayload !== "object") return null;
  if (Array.isArray(runtimePayload)) return null;
  const value = (runtimePayload as Record<string, unknown>)[RESTART_CONTINUATION_MARKER_KEY];
  return typeof value === "string" && value.length > 0 ? TurnId.makeUnsafe(value) : null;
}

export function restartContinuationMessageId(turnId: TurnId): MessageId {
  return MessageId.makeUnsafe(`${RESTART_CONTINUATION_MESSAGE_ID_PREFIX}${turnId}`);
}

const skip = (reason: RestartContinuationRefusal): RestartContinuationDecision => ({
  action: "skip",
  reason,
});

export function decideRestartContinuation(input: {
  readonly thread: RestartContinuationThread | undefined;
  readonly markedTurnId: TurnId;
  readonly hasResumeCursor: boolean;
  readonly enabled: boolean;
  readonly nowMs: number;
}): RestartContinuationDecision {
  const { thread, markedTurnId, nowMs } = input;
  if (!input.enabled) return skip("disabled");
  if (thread === undefined) return skip("missing-thread");
  if (thread.archivedAt !== null || thread.deletedAt !== null) return skip("archived");
  if (!input.hasResumeCursor) return skip("no-resume-cursor");

  const latestTurn = thread.latestTurn;
  if (latestTurn?.turnId !== markedTurnId) return skip("stale");
  if (latestTurn.state === "completed" || latestTurn.state === "error") return skip("finished");
  // A cut /compact asked for no work, and a continuation could resume work that already finished.
  // One sent after the turn began did not start it, and an active goal's turn is real work.
  const lastUserMessage = thread.messages.findLast((message) => message.role === "user");
  if (
    lastUserMessage !== undefined &&
    isCompactCommandMessage(lastUserMessage) &&
    Date.parse(lastUserMessage.createdAt) <= Date.parse(latestTurn.requestedAt) &&
    latestProviderGoal(thread.activities)?.status !== "active"
  ) {
    return skip("maintenance-command");
  }
  // Shutdown's own session.exited also reads "interrupted", but it leaves the session "stopped".
  if (latestTurn.state === "interrupted" && thread.session?.status !== "stopped") {
    return skip("user-stopped");
  }

  const messageId = restartContinuationMessageId(markedTurnId);
  if (thread.messages.some((message) => message.id === messageId)) return skip("already-sent");
  // Runs before startup closes orphaned approvals, so approvals and questions both count here.
  if (hasPendingProviderRequest(thread, latestTurn.requestedAt)) return skip("pending-request");

  const recentContinuations = thread.messages.filter(
    (message) =>
      message.id.startsWith(RESTART_CONTINUATION_MESSAGE_ID_PREFIX) &&
      nowMs - Date.parse(message.createdAt) < RESTART_CONTINUATION_WINDOW_MS,
  ).length;
  if (recentContinuations >= RESTART_CONTINUATION_MAX_IN_WINDOW) return skip("loop-cap");

  return { action: "send", messageId };
}

/**
 * Called first in shutdown, while the adapters still report their active turns. A thread whose
 * stop was requested but has not landed is left out: the projection cannot show that request.
 */
export const markSessionsForRestartContinuation = Effect.fn("markSessionsForRestartContinuation")(
  function* (input: {
    readonly enabled: boolean;
    readonly sessions: ReadonlyArray<ProviderSession>;
    readonly directory: Pick<ProviderSessionDirectoryShape, "upsert">;
    readonly interruptRequestedThreadIds?: ReadonlySet<ThreadId>;
  }) {
    if (!input.enabled) return;
    yield* Effect.forEach(
      input.sessions,
      (session) => {
        if (session.activeTurnId === undefined) return Effect.void;
        if (input.interruptRequestedThreadIds?.has(session.threadId)) return Effect.void;
        return input.directory
          .upsert({
            threadId: session.threadId,
            provider: session.provider,
            runtimePayload: { [RESTART_CONTINUATION_MARKER_KEY]: session.activeTurnId },
          })
          .pipe(
            Effect.catch((cause) =>
              Effect.logWarning("failed to mark thread to continue after restart", {
                threadId: session.threadId,
                cause,
              }),
            ),
          );
      },
      { discard: true },
    );
  },
);

export interface RestartContinuation {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly messageId: MessageId;
}

const logUnlessInterrupted =
  (message: string, annotations: Record<string, unknown>) =>
  <E>(cause: Cause.Cause<E>) =>
    Cause.hasInterrupts(cause)
      ? Effect.failCause(cause)
      : Effect.logWarning(message, { ...annotations, cause });

const listBindings = (directory: ProviderSessionDirectoryShape) =>
  directory.listBindings
    ? directory.listBindings()
    : directory.listThreadIds().pipe(
        Effect.flatMap((threadIds) =>
          Effect.forEach(threadIds, (threadId) => directory.getBinding(threadId)),
        ),
        Effect.map((bindings) => bindings.flatMap((binding) => Option.toArray(binding))),
      );

/**
 * Consumes every marker and returns the threads to continue. Call before
 * `reconcileProviderSessions`, which settles the turns this reads as still cut short.
 */
export const takeRestartContinuations = Effect.gen(function* () {
  const directory = yield* ProviderSessionDirectory;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const bindings: ReadonlyArray<ProviderRuntimeBinding> = yield* listBindings(directory);
  const marked = bindings.flatMap((binding) => {
    const markedTurnId = readRestartContinuationMarker(binding.runtimePayload);
    return markedTurnId === null ? [] : [{ binding, markedTurnId }];
  });
  if (marked.length === 0) return [];

  const { continueThreadsAfterRestart } = yield* getServerSettingsOrDefault;
  const readModel = yield* orchestrationEngine.getReadModel();
  const nowMs = Date.now();
  const continuations: Array<RestartContinuation> = [];
  for (const { binding, markedTurnId } of marked) {
    const { threadId } = binding;
    // Consumed before anything can fail, so a crash here cannot replay the turn on every start.
    const consumed = yield* directory
      .upsert({
        threadId,
        provider: binding.provider,
        runtimePayload: { [RESTART_CONTINUATION_MARKER_KEY]: null },
      })
      .pipe(
        Effect.as(true),
        Effect.catchCause((cause) =>
          logUnlessInterrupted("failed to consume restart continuation marker", { threadId })(
            cause,
          ).pipe(Effect.as(false)),
        ),
      );
    if (!consumed) continue;

    const decision = decideRestartContinuation({
      thread: readModel.threads.get(threadId),
      markedTurnId,
      hasResumeCursor: binding.resumeCursor !== null && binding.resumeCursor !== undefined,
      enabled: continueThreadsAfterRestart,
      nowMs,
    });
    if (decision.action === "skip") {
      yield* Effect.logInfo("not continuing thread after restart", {
        threadId,
        reason: decision.reason,
      });
      continue;
    }
    continuations.push({ threadId, turnId: markedTurnId, messageId: decision.messageId });
  }
  return continuations;
}).pipe(
  Effect.catchCause((cause) =>
    logUnlessInterrupted(
      "failed to read restart continuations",
      {},
    )(cause).pipe(Effect.as([] as ReadonlyArray<RestartContinuation>)),
  ),
);

/** Sends each continuation; one failure leaves that thread settled and the rest still run. */
export const dispatchRestartContinuations = Effect.fn("dispatchRestartContinuations")(function* (
  continuations: ReadonlyArray<RestartContinuation>,
) {
  if (continuations.length === 0) return;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const readModel = yield* orchestrationEngine.getReadModel();
  for (const { threadId, turnId, messageId } of continuations) {
    const thread = readModel.threads.get(threadId);
    if (thread === undefined) continue;
    yield* orchestrationEngine
      .dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe(`restart-continuation:${threadId}:${turnId}`),
        threadId,
        message: {
          messageId,
          role: "user",
          text: RESTART_CONTINUATION_TEXT,
          attachments: [],
        },
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        createdAt: new Date().toISOString(),
      })
      .pipe(
        Effect.catchCause(
          logUnlessInterrupted("failed to continue thread after restart", { threadId }),
        ),
      );
  }
});
