import {
  type AssistantDeliveryMode,
  CommandId,
  MessageId,
  type OrchestrationEvent,
  type OrchestrationProposedPlanId,
  CheckpointRef,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
  type ThreadReasoningActivityPayload,
} from "@piedpiper/contracts";
import { Cache, Cause, Clock, Duration, Effect, Layer, Option, PubSub } from "effect";
import { type DrainableWorker, makeDrainableWorker } from "@piedpiper/shared/DrainableWorker";

import { userFacingDatabaseErrorMessage } from "../../persistence/Errors.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import { readCodexGeneratedImageAttachment } from "../../codex/generatedImages.ts";
import { isGitRepository } from "../../git/Utils.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  ProviderRuntimeIngestionService,
  type ProviderRuntimeIngestionShape,
} from "../Services/ProviderRuntimeIngestion.ts";
import {
  normalizeProposedPlanMarkdown,
  normalizeRuntimeTurnState,
  orchestrationSessionStatusFromRuntimeState,
  proposedPlanIdForTurn,
  proposedPlanIdFromEvent,
  runtimeEventToActivities,
  sameId,
  toTurnId,
} from "./RuntimeNormalizer.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { canReplaceThreadTitle } from "../threadTitles.ts";
import {
  settleOpenTasksCommands,
  splitBufferedAssistantText,
} from "./ProviderRuntimeIngestionHelpers.ts";
import {
  appendReasoningDelta,
  type ClosedReasoningText,
  eventEndsReasoningBlock,
  hasVisibleReasoningText,
  markReasoningBlockEmitted,
  openReasoningBlock,
  type ReasoningBlock,
  reasoningBlockBaseKey,
  reasoningBlockIsFull,
  reasoningBlockToActivity,
  reasoningFinalTextTail,
  reasoningStreamOf,
  recordClosedReasoningBlock,
  shouldEmitReasoningBlock,
} from "./ProviderRuntimeIngestionReasoning.ts";

const providerTurnKey = (threadId: ThreadId, turnId: TurnId) => `${threadId}:${turnId}`;
const sessionStatusAllowsActiveTurn = (
  status: ReturnType<typeof orchestrationSessionStatusFromRuntimeState>,
): boolean => status === "starting" || status === "running";
const providerCommandId = (event: ProviderRuntimeEvent, tag: string): CommandId =>
  CommandId.makeUnsafe(`provider:${event.eventId}:${tag}:${crypto.randomUUID()}`);

interface ReasoningTurnState {
  readonly open: ReasoningBlock | null;
  readonly seenBaseKeys: ReadonlySet<string>;
  readonly closedByBaseKey: ReadonlyMap<string, ClosedReasoningText>;
  /** The block each item's activity last went out with, so a promotion can update that activity. */
  readonly lastDispatchedByBaseKey: ReadonlyMap<string, ReasoningBlock>;
}

const EMPTY_REASONING_TURN_STATE: ReasoningTurnState = {
  open: null,
  seenBaseKeys: new Set<string>(),
  closedByBaseKey: new Map<string, ClosedReasoningText>(),
  lastDispatchedByBaseKey: new Map<string, ReasoningBlock>(),
};

const TURN_MESSAGE_IDS_BY_TURN_CACHE_CAPACITY = 10_000;
const TURN_MESSAGE_IDS_BY_TURN_TTL = Duration.minutes(120);
const BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_CACHE_CAPACITY = 20_000;
const BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_TTL = Duration.minutes(120);
const BUFFERED_PROPOSED_PLAN_BY_ID_CACHE_CAPACITY = 10_000;
const BUFFERED_PROPOSED_PLAN_BY_ID_TTL = Duration.minutes(120);
const MAX_BUFFERED_ASSISTANT_CHARS = 24_000;
// Paragraphs finishing within this window after a delivery land together on the next one.
const MIN_ASSISTANT_DELIVERY_INTERVAL_MS = 400;
// Streaming mode batches token deltas into updates this far apart.
const ASSISTANT_STREAM_FLUSH_INTERVAL_MS = 50;
// A failing database rejects every event of a turn; one banner update per thread is enough.
const DATABASE_ERROR_SURFACE_INTERVAL = Duration.seconds(30);
const DATABASE_ERROR_SURFACE_CACHE_CAPACITY = 1_000;
const STRICT_PROVIDER_LIFECYCLE_GUARD =
  process.env.PIEDPIPER_STRICT_PROVIDER_LIFECYCLE_GUARD !== "0";

type TurnStartRequestedDomainEvent = Extract<
  OrchestrationEvent,
  { type: "thread.turn-start-requested" }
>;

type RuntimeIngestionInput =
  | {
      source: "runtime";
      event: ProviderRuntimeEvent;
    }
  | {
      source: "domain";
      event: TurnStartRequestedDomainEvent;
    }
  | {
      source: "assistant-flush";
      event: ProviderRuntimeEvent;
      messageId: MessageId;
    };

const make = Effect.fn("make")(function* () {
  const scope = yield* Effect.scope;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;
  const projectionTurnRepository = yield* ProjectionTurnRepository;
  const serverSettingsService = yield* ServerSettingsService;

  const turnMessageIdsByTurnKey = yield* Cache.make<string, Set<MessageId>>({
    capacity: TURN_MESSAGE_IDS_BY_TURN_CACHE_CAPACITY,
    timeToLive: TURN_MESSAGE_IDS_BY_TURN_TTL,
    lookup: () => Effect.succeed(new Set<MessageId>()),
  });

  const bufferedAssistantTextByMessageId = yield* Cache.make<MessageId, string>({
    capacity: BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_CACHE_CAPACITY,
    timeToLive: BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_TTL,
    lookup: () => Effect.succeed(""),
  });
  // Epoch millis of the last early delivery per message, for pacing.
  const lastAssistantDeliveryAtByMessageId = yield* Cache.make<MessageId, number>({
    capacity: BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_CACHE_CAPACITY,
    timeToLive: BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_TTL,
    lookup: () => Effect.succeed(0),
  });

  // Messages with a trailing flush scheduled, and the newest delta to stamp that flush with.
  const pendingAssistantFlushes = new Map<
    MessageId,
    { readonly event: ProviderRuntimeEvent; readonly turnId: TurnId | undefined }
  >();

  const databaseErrorSurfacedByThreadId = yield* Cache.make<ThreadId, true>({
    capacity: DATABASE_ERROR_SURFACE_CACHE_CAPACITY,
    timeToLive: DATABASE_ERROR_SURFACE_INTERVAL,
    lookup: () => Effect.succeed(true as const),
  });

  const bufferedProposedPlanById = yield* Cache.make<string, { text: string; createdAt: string }>({
    capacity: BUFFERED_PROPOSED_PLAN_BY_ID_CACHE_CAPACITY,
    timeToLive: BUFFERED_PROPOSED_PLAN_BY_ID_TTL,
    lookup: () => Effect.succeed({ text: "", createdAt: "" }),
  });

  // Per turn: the thinking block being streamed, the items that already produced one, and what closed.
  const reasoningStateByTurnKey = yield* Cache.make<string, ReasoningTurnState>({
    capacity: TURN_MESSAGE_IDS_BY_TURN_CACHE_CAPACITY,
    timeToLive: TURN_MESSAGE_IDS_BY_TURN_TTL,
    lookup: () => Effect.succeed(EMPTY_REASONING_TURN_STATE),
  });

  const isGitRepoForThread = Effect.fn("isGitRepoForThread")(function* (threadId: ThreadId) {
    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.get(threadId);
    if (!thread) {
      return false;
    }
    const workspaceCwd = resolveThreadWorkspaceCwd({
      thread,
      projects: readModel.projects,
    });
    if (!workspaceCwd) {
      return false;
    }
    return yield* isGitRepository(workspaceCwd);
  });

  const rememberAssistantMessageId = (threadId: ThreadId, turnId: TurnId, messageId: MessageId) =>
    Cache.getOption(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId)).pipe(
      Effect.flatMap((existingIds) =>
        Cache.set(
          turnMessageIdsByTurnKey,
          providerTurnKey(threadId, turnId),
          Option.match(existingIds, {
            onNone: () => new Set([messageId]),
            onSome: (ids) => {
              const nextIds = new Set(ids);
              nextIds.add(messageId);
              return nextIds;
            },
          }),
        ),
      ),
    );

  const forgetAssistantMessageId = (threadId: ThreadId, turnId: TurnId, messageId: MessageId) =>
    Cache.getOption(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId)).pipe(
      Effect.flatMap((existingIds) =>
        Option.match(existingIds, {
          onNone: () => Effect.void,
          onSome: (ids) => {
            const nextIds = new Set(ids);
            nextIds.delete(messageId);
            if (nextIds.size === 0) {
              return Cache.invalidate(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId));
            }
            return Cache.set(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId), nextIds);
          },
        }),
      ),
    );

  const getAssistantMessageIdsForTurn = (threadId: ThreadId, turnId: TurnId) =>
    Cache.getOption(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId)).pipe(
      Effect.map((existingIds) =>
        Option.getOrElse(existingIds, (): Set<MessageId> => new Set<MessageId>()),
      ),
    );

  const clearAssistantMessageIdsForTurn = (threadId: ThreadId, turnId: TurnId) =>
    Cache.invalidate(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId));

  const appendBufferedAssistantText = (messageId: MessageId, delta: string, atMillis: number) =>
    Cache.getOption(bufferedAssistantTextByMessageId, messageId).pipe(
      Effect.flatMap(
        Effect.fn("appendBufferedAssistantText")(function* (existingText) {
          const nextText = Option.match(existingText, {
            onNone: () => delta,
            onSome: (text) => `${text}${delta}`,
          });

          // Deliver finished paragraphs, closed code blocks and list items early
          // so the user sees progress without token-by-token repaints.
          const { ready, rest } = splitBufferedAssistantText(nextText);
          const lastDeliveredAt = Option.getOrUndefined(
            yield* Cache.getOption(lastAssistantDeliveryAtByMessageId, messageId),
          );
          const paced =
            lastDeliveredAt === undefined ||
            atMillis - lastDeliveredAt >= MIN_ASSISTANT_DELIVERY_INTERVAL_MS;
          if (paced && ready.trim().length > 0 && rest.length <= MAX_BUFFERED_ASSISTANT_CHARS) {
            if (rest.length > 0) {
              yield* Cache.set(bufferedAssistantTextByMessageId, messageId, rest);
            } else {
              yield* Cache.invalidate(bufferedAssistantTextByMessageId, messageId);
            }
            yield* Cache.set(lastAssistantDeliveryAtByMessageId, messageId, atMillis);
            return ready;
          }

          if (nextText.length <= MAX_BUFFERED_ASSISTANT_CHARS) {
            yield* Cache.set(bufferedAssistantTextByMessageId, messageId, nextText);
            return "";
          }

          // Safety valve: flush full buffered text as an assistant delta to cap memory.
          yield* Cache.invalidate(bufferedAssistantTextByMessageId, messageId);
          return nextText;
        }),
      ),
    );

  const takeBufferedAssistantText = (messageId: MessageId) =>
    Cache.getOption(bufferedAssistantTextByMessageId, messageId).pipe(
      Effect.flatMap((existingText) =>
        Cache.invalidate(bufferedAssistantTextByMessageId, messageId).pipe(
          Effect.as(Option.getOrElse(existingText, () => "")),
        ),
      ),
    );

  const clearBufferedAssistantText = (messageId: MessageId) =>
    Effect.sync(() => pendingAssistantFlushes.delete(messageId)).pipe(
      Effect.andThen(Cache.invalidate(bufferedAssistantTextByMessageId, messageId)),
      Effect.andThen(Cache.invalidate(lastAssistantDeliveryAtByMessageId, messageId)),
    );

  // First delta and any after a quiet gap go straight out; a burst shares one trailing flush.
  const streamAssistantDelta = Effect.fn("streamAssistantDelta")(function* (input: {
    readonly event: ProviderRuntimeEvent;
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
    readonly turnId: TurnId | undefined;
    readonly delta: string;
  }) {
    const { event, messageId, turnId } = input;
    const atMillis = yield* Clock.currentTimeMillis;
    const lastDeliveredAt = Option.getOrUndefined(
      yield* Cache.getOption(lastAssistantDeliveryAtByMessageId, messageId),
    );
    // Includes text buffered before a switch from buffered mode, so it cannot land out of order.
    const text = `${Option.getOrElse(
      yield* Cache.getOption(bufferedAssistantTextByMessageId, messageId),
      () => "",
    )}${input.delta}`;
    const flushPending = pendingAssistantFlushes.has(messageId);
    // Clamped: after the wall clock steps back, a negative gap would stall the trailing flush.
    const sinceDeliveryMs =
      lastDeliveredAt === undefined
        ? Number.POSITIVE_INFINITY
        : Math.max(0, atMillis - lastDeliveredAt);
    if (
      (!flushPending && sinceDeliveryMs >= ASSISTANT_STREAM_FLUSH_INTERVAL_MS) ||
      text.length > MAX_BUFFERED_ASSISTANT_CHARS
    ) {
      pendingAssistantFlushes.delete(messageId);
      yield* Cache.invalidate(bufferedAssistantTextByMessageId, messageId);
      yield* Cache.set(lastAssistantDeliveryAtByMessageId, messageId, atMillis);
      yield* orchestrationEngine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: providerCommandId(event, "assistant-delta"),
        threadId: input.threadId,
        messageId,
        delta: text,
        ...(turnId ? { turnId } : {}),
        createdAt: event.createdAt,
      });
      return;
    }
    yield* Cache.set(bufferedAssistantTextByMessageId, messageId, text);
    pendingAssistantFlushes.set(messageId, { event, turnId });
    if (flushPending) {
      return;
    }
    // Enqueued, not dispatched here, so the flush keeps its place among runtime events.
    yield* Effect.sleep(
      Duration.millis(Math.max(0, ASSISTANT_STREAM_FLUSH_INTERVAL_MS - sinceDeliveryMs)),
    ).pipe(
      Effect.andThen(worker.enqueue({ source: "assistant-flush", event, messageId })),
      Effect.forkIn(scope),
    );
  });

  const flushStreamingAssistantText = Effect.fn("flushStreamingAssistantText")(function* (
    messageId: MessageId,
  ) {
    const pending = pendingAssistantFlushes.get(messageId);
    if (pending === undefined) {
      return;
    }
    pendingAssistantFlushes.delete(messageId);
    const text = yield* takeBufferedAssistantText(messageId);
    if (text.length === 0) {
      return;
    }
    yield* Cache.set(lastAssistantDeliveryAtByMessageId, messageId, yield* Clock.currentTimeMillis);
    yield* orchestrationEngine.dispatch({
      type: "thread.message.assistant.delta",
      commandId: providerCommandId(pending.event, "assistant-delta-stream-flush"),
      threadId: pending.event.threadId,
      messageId,
      delta: text,
      ...(pending.turnId ? { turnId: pending.turnId } : {}),
      createdAt: pending.event.createdAt,
    });
  });

  // An exit clears buffers without settling; text already received must not go with them.
  const flushStreamingAssistantTextForThread = Effect.fn("flushStreamingAssistantTextForThread")(
    function* (threadId: ThreadId) {
      const messageIds = Array.from(pendingAssistantFlushes)
        .filter(([, pending]) => pending.event.threadId === threadId)
        .map(([messageId]) => messageId);
      yield* Effect.forEach(messageIds, flushStreamingAssistantText, { discard: true });
    },
  );

  const appendBufferedProposedPlan = (planId: string, delta: string, createdAt: string) =>
    Cache.getOption(bufferedProposedPlanById, planId).pipe(
      Effect.flatMap((existingEntry) => {
        const existing = Option.getOrUndefined(existingEntry);
        return Cache.set(bufferedProposedPlanById, planId, {
          text: `${existing?.text ?? ""}${delta}`,
          createdAt:
            existing?.createdAt && existing.createdAt.length > 0 ? existing.createdAt : createdAt,
        });
      }),
    );

  const takeBufferedProposedPlan = (planId: string) =>
    Cache.getOption(bufferedProposedPlanById, planId).pipe(
      Effect.flatMap((existingEntry) =>
        Cache.invalidate(bufferedProposedPlanById, planId).pipe(
          Effect.as(Option.getOrUndefined(existingEntry)),
        ),
      ),
    );

  const clearBufferedProposedPlan = (planId: string) =>
    Cache.invalidate(bufferedProposedPlanById, planId);

  const clearAssistantMessageState = (messageId: MessageId) =>
    clearBufferedAssistantText(messageId);

  const finalizeAssistantMessage = Effect.fn("finalizeAssistantMessage")(function* (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    messageId: MessageId;
    turnId?: TurnId;
    createdAt: string;
    commandTag: string;
    finalDeltaCommandTag: string;
    fallbackText?: string;
  }) {
    const bufferedText = yield* takeBufferedAssistantText(input.messageId);
    const text =
      bufferedText.length > 0
        ? bufferedText
        : (input.fallbackText?.trim().length ?? 0) > 0
          ? input.fallbackText!
          : "";

    if (text.length > 0) {
      yield* orchestrationEngine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: providerCommandId(input.event, input.finalDeltaCommandTag),
        threadId: input.threadId,
        messageId: input.messageId,
        delta: text,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        createdAt: input.createdAt,
      });
    }

    yield* orchestrationEngine.dispatch({
      type: "thread.message.assistant.complete",
      commandId: providerCommandId(input.event, input.commandTag),
      threadId: input.threadId,
      messageId: input.messageId,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      createdAt: input.createdAt,
    });
    yield* clearAssistantMessageState(input.messageId);
  });

  const upsertProposedPlan = Effect.fn("upsertProposedPlan")(function* (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    threadProposedPlans: ReadonlyArray<{
      id: string;
      createdAt: string;
      implementedAt: string | null;
      implementationThreadId: ThreadId | null;
    }>;
    planId: string;
    turnId?: TurnId;
    planMarkdown: string | undefined;
    createdAt: string;
    updatedAt: string;
  }) {
    const planMarkdown = normalizeProposedPlanMarkdown(input.planMarkdown);
    if (!planMarkdown) {
      return;
    }

    const existingPlan = input.threadProposedPlans.find((entry) => entry.id === input.planId);
    yield* orchestrationEngine.dispatch({
      type: "thread.proposed-plan.upsert",
      commandId: providerCommandId(input.event, "proposed-plan-upsert"),
      threadId: input.threadId,
      proposedPlan: {
        id: input.planId,
        turnId: input.turnId ?? null,
        planMarkdown,
        implementedAt: existingPlan?.implementedAt ?? null,
        implementationThreadId: existingPlan?.implementationThreadId ?? null,
        createdAt: existingPlan?.createdAt ?? input.createdAt,
        updatedAt: input.updatedAt,
      },
      createdAt: input.updatedAt,
    });
  });

  const finalizeBufferedProposedPlan = Effect.fn("finalizeBufferedProposedPlan")(function* (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    threadProposedPlans: ReadonlyArray<{
      id: string;
      createdAt: string;
      implementedAt: string | null;
      implementationThreadId: ThreadId | null;
    }>;
    planId: string;
    turnId?: TurnId;
    fallbackMarkdown?: string;
    updatedAt: string;
  }) {
    const bufferedPlan = yield* takeBufferedProposedPlan(input.planId);
    const bufferedMarkdown = normalizeProposedPlanMarkdown(bufferedPlan?.text);
    const fallbackMarkdown = normalizeProposedPlanMarkdown(input.fallbackMarkdown);
    const planMarkdown = bufferedMarkdown ?? fallbackMarkdown;
    if (!planMarkdown) {
      return;
    }

    yield* upsertProposedPlan({
      event: input.event,
      threadId: input.threadId,
      threadProposedPlans: input.threadProposedPlans,
      planId: input.planId,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      planMarkdown,
      createdAt:
        bufferedPlan?.createdAt && bufferedPlan.createdAt.length > 0
          ? bufferedPlan.createdAt
          : input.updatedAt,
      updatedAt: input.updatedAt,
    });
    yield* clearBufferedProposedPlan(input.planId);
  });

  const getReasoningState = (threadId: ThreadId, turnId: TurnId) =>
    Cache.getOption(reasoningStateByTurnKey, providerTurnKey(threadId, turnId)).pipe(
      Effect.map((state) => Option.getOrElse(state, () => EMPTY_REASONING_TURN_STATE)),
    );

  const dispatchReasoningActivity = Effect.fn("dispatchReasoningActivity")(function* (input: {
    readonly event: ProviderRuntimeEvent;
    readonly threadId: ThreadId;
    readonly block: ReasoningBlock;
    readonly status: ThreadReasoningActivityPayload["status"];
    readonly tag: string;
  }) {
    const state = yield* getReasoningState(input.threadId, input.block.turnId);
    yield* Cache.set(reasoningStateByTurnKey, providerTurnKey(input.threadId, input.block.turnId), {
      ...state,
      lastDispatchedByBaseKey: new Map(state.lastDispatchedByBaseKey).set(
        input.block.baseKey,
        input.block,
      ),
    });
    yield* orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: providerCommandId(input.event, input.tag),
      threadId: input.threadId,
      activity: reasoningBlockToActivity(input.block, input.status),
      createdAt: input.event.createdAt,
    });
  });

  // Blank blocks are dropped: Claude can open a thinking block and only sign it.
  const closeOpenReasoningBlock = Effect.fn("closeOpenReasoningBlock")(function* (input: {
    readonly event: ProviderRuntimeEvent;
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly tag: string;
  }) {
    const state = yield* getReasoningState(input.threadId, input.turnId);
    if (state.open === null) {
      return;
    }
    yield* Cache.set(reasoningStateByTurnKey, providerTurnKey(input.threadId, input.turnId), {
      ...state,
      open: null,
      closedByBaseKey: recordClosedReasoningBlock(state.closedByBaseKey, state.open),
    });
    if (hasVisibleReasoningText(state.open)) {
      yield* dispatchReasoningActivity({
        event: input.event,
        threadId: input.threadId,
        block: state.open,
        status: "completed",
        tag: input.tag,
      });
    }
  });

  const appendReasoningText = Effect.fn("appendReasoningText")(function* (input: {
    readonly event: Extract<ProviderRuntimeEvent, { type: "content.delta" }>;
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly streamKind: "reasoning_text" | "reasoning_summary_text";
  }) {
    const { event, threadId, turnId } = input;
    const stream = reasoningStreamOf(input.streamKind);
    const baseKey = reasoningBlockBaseKey(stream, String(event.itemId ?? turnId));
    const existing = yield* getReasoningState(threadId, turnId);
    if (existing.open !== null && existing.open.baseKey !== baseKey) {
      yield* closeOpenReasoningBlock({
        event,
        threadId,
        turnId,
        tag: "reasoning-complete-on-new-block",
      });
    }
    const state = yield* getReasoningState(threadId, turnId);
    let block = appendReasoningDelta(
      // An item's earlier text closed early, so its row grows in place instead of splitting.
      state.open ??
        state.closedByBaseKey.get(baseKey)?.block ??
        openReasoningBlock({ event, baseKey, stream, turnId }),
      event.payload.delta,
      event.payload.summaryIndex ?? event.payload.contentIndex,
    );
    const seenBaseKeys = new Set(state.seenBaseKeys).add(baseKey);
    if (reasoningBlockIsFull(block)) {
      yield* Cache.set(reasoningStateByTurnKey, providerTurnKey(threadId, turnId), {
        ...state,
        open: null,
        seenBaseKeys,
        closedByBaseKey: recordClosedReasoningBlock(state.closedByBaseKey, block),
      });
      yield* dispatchReasoningActivity({
        event,
        threadId,
        block,
        status: "completed",
        tag: "reasoning-complete-on-full-block",
      });
      return;
    }
    const atMillis = yield* Clock.currentTimeMillis;
    const shouldEmit = shouldEmitReasoningBlock(block, atMillis);
    if (shouldEmit) {
      block = markReasoningBlockEmitted(block, atMillis);
    }
    yield* Cache.set(reasoningStateByTurnKey, providerTurnKey(threadId, turnId), {
      ...state,
      open: block,
      seenBaseKeys,
    });
    if (shouldEmit) {
      yield* dispatchReasoningActivity({
        event,
        threadId,
        block,
        status: "inProgress",
        tag: "reasoning-progress",
      });
    }
  });

  // The adapter re-emits this thinking block as assistant text, so its Thought row goes away.
  // A block split by the size limit only has its last part marked.
  const promoteReasoningItem = Effect.fn("promoteReasoningItem")(function* (input: {
    readonly event: Extract<ProviderRuntimeEvent, { type: "item.completed" }>;
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly itemKey: string;
  }) {
    const { event, threadId, turnId, itemKey } = input;
    const summaryKey = reasoningBlockBaseKey("summary", itemKey);
    const rawKey = reasoningBlockBaseKey("raw", itemKey);
    const { open } = yield* getReasoningState(threadId, turnId);
    if (open !== null && (open.baseKey === summaryKey || open.baseKey === rawKey)) {
      yield* closeOpenReasoningBlock({
        event,
        threadId,
        turnId,
        tag: "reasoning-complete-on-item-completed",
      });
    }
    const { lastDispatchedByBaseKey } = yield* getReasoningState(threadId, turnId);
    const block = lastDispatchedByBaseKey.get(summaryKey) ?? lastDispatchedByBaseKey.get(rawKey);
    if (block !== undefined) {
      yield* dispatchReasoningActivity({
        event,
        threadId,
        block,
        status: "promoted",
        tag: "reasoning-promoted",
      });
    }
  });

  // A reasoning item finished. Its final text fills in for a block that streamed less of it.
  const completeReasoningItem = Effect.fn("completeReasoningItem")(function* (input: {
    readonly event: Extract<ProviderRuntimeEvent, { type: "item.completed" }>;
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
  }) {
    const { event, threadId, turnId } = input;
    const turnKey = providerTurnKey(threadId, turnId);
    const state = yield* getReasoningState(threadId, turnId);
    const itemKey = String(event.itemId ?? turnId);
    if (
      (event.payload.data as { promotedToAssistantText?: unknown } | undefined)
        ?.promotedToAssistantText === true
    ) {
      yield* promoteReasoningItem({ event, threadId, turnId, itemKey });
      return;
    }
    const finalText = event.payload.detail ?? "";
    const baseKey = reasoningBlockBaseKey("summary", itemKey);
    const streamedItem =
      state.seenBaseKeys.has(baseKey) ||
      state.seenBaseKeys.has(reasoningBlockBaseKey("raw", itemKey));
    const closed = state.closedByBaseKey.get(baseKey);
    // Blocks that already filled up hold the start of the final text, so only the rest is compared.
    const tail = streamedItem ? reasoningFinalTextTail(finalText, closed?.fullTexts ?? []) : null;
    const hasTail = tail !== null && tail.trim() !== "";
    const openIsSummary = state.open?.baseKey === baseKey;
    // A block that streamed only the first summary part keeps the rest once the item reports it.
    if (
      hasTail &&
      state.open !== null &&
      (openIsSummary
        ? !hasVisibleReasoningText(state.open) || tail.length > state.open.text.length
        : closed === undefined && !hasVisibleReasoningText(state.open))
    ) {
      yield* Cache.set(reasoningStateByTurnKey, turnKey, {
        ...state,
        open: { ...state.open, text: tail },
      });
    }
    yield* closeOpenReasoningBlock({
      event,
      threadId,
      turnId,
      tag: "reasoning-complete-on-item-completed",
    });
    if (!streamedItem) {
      if (finalText.trim() === "") {
        return;
      }
      const current = yield* getReasoningState(threadId, turnId);
      yield* Cache.set(reasoningStateByTurnKey, turnKey, {
        ...current,
        seenBaseKeys: new Set(current.seenBaseKeys).add(baseKey),
      });
      yield* dispatchReasoningActivity({
        event,
        threadId,
        block: appendReasoningDelta(
          openReasoningBlock({ event, baseKey, stream: "summary", turnId }),
          finalText,
          undefined,
        ),
        status: "completed",
        tag: "reasoning-complete-from-item",
      });
      return;
    }
    // The summary's block closed early and no later delta came, so only this event has the rest.
    if (!hasTail || openIsSummary || closed === undefined) {
      return;
    }
    if (closed.block !== null && tail.length <= closed.block.text.length) {
      return;
    }
    const block = {
      ...(closed.block ?? openReasoningBlock({ event, baseKey, stream: "summary", turnId })),
      text: tail,
    };
    const current = yield* getReasoningState(threadId, turnId);
    yield* Cache.set(reasoningStateByTurnKey, turnKey, {
      ...current,
      closedByBaseKey: recordClosedReasoningBlock(current.closedByBaseKey, block),
    });
    yield* dispatchReasoningActivity({
      event,
      threadId,
      block,
      status: "completed",
      tag: "reasoning-backfill-from-item",
    });
  });

  // No turn will close these blocks any more, so close them for the whole thread.
  const closeReasoningBlocksForThread = Effect.fn("closeReasoningBlocksForThread")(function* (
    event: ProviderRuntimeEvent,
    threadId: ThreadId,
    tag: string,
  ) {
    const prefix = `${threadId}:`;
    const keys = Array.from(yield* Cache.keys(reasoningStateByTurnKey));
    yield* Effect.forEach(
      keys,
      Effect.fn(function* (key) {
        if (!key.startsWith(prefix)) {
          return;
        }
        yield* closeOpenReasoningBlock({
          event,
          threadId,
          turnId: TurnId.makeUnsafe(key.slice(prefix.length)),
          tag,
        });
        yield* Cache.invalidate(reasoningStateByTurnKey, key);
      }),
      { concurrency: 1 },
    ).pipe(Effect.asVoid);
  });

  const clearTurnStateForSession = Effect.fn("clearTurnStateForSession")(function* (
    threadId: ThreadId,
  ) {
    const prefix = `${threadId}:`;
    const proposedPlanPrefix = `plan:${threadId}:`;
    const turnKeys = Array.from(yield* Cache.keys(turnMessageIdsByTurnKey));
    const proposedPlanKeys = Array.from(yield* Cache.keys(bufferedProposedPlanById));
    yield* Effect.forEach(
      turnKeys,
      Effect.fn(function* (key) {
        if (!key.startsWith(prefix)) {
          return;
        }

        const messageIds = yield* Cache.getOption(turnMessageIdsByTurnKey, key);
        if (Option.isSome(messageIds)) {
          yield* Effect.forEach(messageIds.value, clearAssistantMessageState, {
            concurrency: 1,
          }).pipe(Effect.asVoid);
        }

        yield* Cache.invalidate(turnMessageIdsByTurnKey, key);
      }),
      { concurrency: 1 },
    ).pipe(Effect.asVoid);
    yield* Effect.forEach(
      proposedPlanKeys,
      (key) =>
        key.startsWith(proposedPlanPrefix)
          ? Cache.invalidate(bufferedProposedPlanById, key)
          : Effect.void,
      { concurrency: 1 },
    ).pipe(Effect.asVoid);
  });

  const getSourceProposedPlanReferenceForPendingTurnStart = Effect.fn(
    "getSourceProposedPlanReferenceForPendingTurnStart",
  )(function* (threadId: ThreadId) {
    const pendingTurnStart = yield* projectionTurnRepository.getPendingTurnStartByThreadId({
      threadId,
    });
    if (Option.isNone(pendingTurnStart)) {
      return null;
    }

    const sourceThreadId = pendingTurnStart.value.sourceProposedPlanThreadId;
    const sourcePlanId = pendingTurnStart.value.sourceProposedPlanId;
    if (sourceThreadId === null || sourcePlanId === null) {
      return null;
    }

    return {
      sourceThreadId,
      sourcePlanId,
    } as const;
  });

  const getExpectedProviderTurnIdForThread = Effect.fn("getExpectedProviderTurnIdForThread")(
    function* (threadId: ThreadId) {
      const sessions = yield* providerService.listSessions();
      const session = sessions.find((entry) => entry.threadId === threadId);
      return session?.activeTurnId;
    },
  );

  const getSourceProposedPlanReferenceForAcceptedTurnStart = Effect.fn(
    "getSourceProposedPlanReferenceForAcceptedTurnStart",
  )(function* (threadId: ThreadId, eventTurnId: TurnId | undefined) {
    if (eventTurnId === undefined) {
      return null;
    }

    const expectedTurnId = yield* getExpectedProviderTurnIdForThread(threadId);
    if (!sameId(expectedTurnId, eventTurnId)) {
      return null;
    }

    return yield* getSourceProposedPlanReferenceForPendingTurnStart(threadId);
  });

  const markSourceProposedPlanImplemented = Effect.fn("markSourceProposedPlanImplemented")(
    function* (
      sourceThreadId: ThreadId,
      sourcePlanId: OrchestrationProposedPlanId,
      implementationThreadId: ThreadId,
      implementedAt: string,
    ) {
      const readModel = yield* orchestrationEngine.getReadModel();
      const sourceThread = readModel.threads.get(sourceThreadId);
      const sourcePlan = sourceThread?.proposedPlans.find((entry) => entry.id === sourcePlanId);
      if (!sourceThread || !sourcePlan || sourcePlan.implementedAt !== null) {
        return;
      }

      yield* orchestrationEngine.dispatch({
        type: "thread.proposed-plan.upsert",
        commandId: CommandId.makeUnsafe(
          `provider:source-proposed-plan-implemented:${implementationThreadId}:${crypto.randomUUID()}`,
        ),
        threadId: sourceThread.id,
        proposedPlan: {
          ...sourcePlan,
          implementedAt,
          implementationThreadId,
          updatedAt: implementedAt,
        },
        createdAt: implementedAt,
      });
    },
  );

  // Finalize everything still buffered for a turn once it can no longer progress.
  const settleTurn = Effect.fn("settleTurn")(function* (input: {
    readonly event: ProviderRuntimeEvent;
    readonly thread: {
      readonly id: ThreadId;
      readonly proposedPlans: ReadonlyArray<{
        id: string;
        createdAt: string;
        implementedAt: string | null;
        implementationThreadId: ThreadId | null;
      }>;
    };
    readonly turnId: TurnId;
    readonly now: string;
  }) {
    const { event, thread, turnId, now } = input;
    yield* closeOpenReasoningBlock({
      event,
      threadId: thread.id,
      turnId,
      tag: "reasoning-complete-on-settle",
    });
    yield* Cache.invalidate(reasoningStateByTurnKey, providerTurnKey(thread.id, turnId));
    const assistantMessageIds = yield* getAssistantMessageIdsForTurn(thread.id, turnId);
    yield* Effect.forEach(
      assistantMessageIds,
      (assistantMessageId) =>
        finalizeAssistantMessage({
          event,
          threadId: thread.id,
          messageId: assistantMessageId,
          turnId,
          createdAt: now,
          commandTag: "assistant-complete-finalize",
          finalDeltaCommandTag: "assistant-delta-finalize-fallback",
        }),
      { concurrency: 1 },
    ).pipe(Effect.asVoid);
    yield* clearAssistantMessageIdsForTurn(thread.id, turnId);

    yield* finalizeBufferedProposedPlan({
      event,
      threadId: thread.id,
      threadProposedPlans: thread.proposedPlans,
      planId: proposedPlanIdForTurn(thread.id, turnId),
      turnId,
      updatedAt: now,
    });
  });

  const processRuntimeEvent = Effect.fn("processRuntimeEvent")(function* (
    event: ProviderRuntimeEvent,
  ) {
    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.get(event.threadId);
    if (!thread) return;

    const now = event.createdAt;
    const eventTurnId = toTurnId(event.turnId);
    const activeTurnId = thread.session?.activeTurnId ?? null;
    const isSessionLifecycleEvent =
      event.type === "session.started" ||
      event.type === "session.state.changed" ||
      event.type === "thread.started";
    // A sent message keeps the thread "starting" until the provider reports turn.started.
    // session.exited is left out: it cannot be told apart from the new session dying, so a stale-retry exit may briefly show "stopped".
    const hasPendingTurnStart =
      isSessionLifecycleEvent &&
      thread.session?.status === "starting" &&
      Option.isSome(
        yield* projectionTurnRepository.getPendingTurnStartByThreadId({ threadId: thread.id }),
      );

    const conflictsWithActiveTurn =
      activeTurnId !== null && eventTurnId !== undefined && !sameId(activeTurnId, eventTurnId);
    const missingTurnForActiveTurn = activeTurnId !== null && eventTurnId === undefined;

    const shouldApplyThreadLifecycle = (() => {
      if (!STRICT_PROVIDER_LIFECYCLE_GUARD) {
        return true;
      }
      switch (event.type) {
        case "session.exited":
          return true;
        case "session.started":
        case "thread.started":
          return true;
        case "turn.started":
          return !conflictsWithActiveTurn;
        case "turn.completed":
          if (conflictsWithActiveTurn || missingTurnForActiveTurn) {
            return false;
          }
          // Only the active turn may close the lifecycle state.
          if (activeTurnId !== null && eventTurnId !== undefined) {
            return sameId(activeTurnId, eventTurnId);
          }
          // No active turn tracked: an untargeted completion cannot prove it
          // belongs to a turn this thread ran and would stomp a "starting" state.
          return eventTurnId !== undefined;
        default:
          return true;
      }
    })();
    const acceptedTurnStartedSourcePlan =
      event.type === "turn.started" && shouldApplyThreadLifecycle
        ? yield* getSourceProposedPlanReferenceForAcceptedTurnStart(thread.id, eventTurnId)
        : null;

    if (
      event.type === "session.started" ||
      event.type === "session.state.changed" ||
      event.type === "session.exited" ||
      event.type === "thread.started" ||
      event.type === "turn.started" ||
      event.type === "turn.completed"
    ) {
      const isStaleSessionError =
        event.type === "turn.completed" &&
        normalizeRuntimeTurnState(event.payload.state) === "failed" &&
        typeof event.payload.errorMessage === "string" &&
        (event.payload.errorMessage.includes("No conversation found with session ID") ||
          event.payload.errorMessage.includes("does not exist"));

      const status = (() => {
        if (isStaleSessionError) return "stopped" as const;
        switch (event.type) {
          case "session.state.changed": {
            const runtimeStatus = orchestrationSessionStatusFromRuntimeState(event.payload.state);
            return hasPendingTurnStart && runtimeStatus === "ready" ? "starting" : runtimeStatus;
          }
          case "turn.started":
            return "running";
          case "session.exited":
            return "stopped";
          case "turn.completed":
            return normalizeRuntimeTurnState(event.payload.state) === "failed" ? "error" : "ready";
          case "session.started":
          case "thread.started":
            // Provider thread/session start notifications can arrive during an
            // active or pending turn; preserve that lifecycle state.
            return activeTurnId !== null ? "running" : hasPendingTurnStart ? "starting" : "ready";
        }
      })();
      // A session that is no longer starting/running cannot have a turn in
      // flight; keeping the stale id would leave the thread "working" forever.
      const nextActiveTurnId =
        event.type === "turn.started"
          ? (eventTurnId ?? null)
          : event.type === "turn.completed" || event.type === "session.exited"
            ? null
            : event.type === "session.state.changed" &&
                !sessionStatusAllowsActiveTurn(
                  orchestrationSessionStatusFromRuntimeState(event.payload.state),
                )
              ? null
              : activeTurnId;
      const lastError = isStaleSessionError
        ? null
        : event.type === "session.state.changed" && event.payload.state === "error"
          ? (event.payload.reason ?? thread.session?.lastError ?? "Provider session error")
          : event.type === "turn.completed" &&
              normalizeRuntimeTurnState(event.payload.state) === "failed"
            ? (event.payload.errorMessage ?? thread.session?.lastError ?? "Turn failed")
            : status === "ready"
              ? null
              : (thread.session?.lastError ?? null);

      if (shouldApplyThreadLifecycle) {
        if (event.type === "turn.started" && acceptedTurnStartedSourcePlan !== null) {
          yield* markSourceProposedPlanImplemented(
            acceptedTurnStartedSourcePlan.sourceThreadId,
            acceptedTurnStartedSourcePlan.sourcePlanId,
            thread.id,
            now,
          ).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("provider runtime ingestion failed to mark source proposed plan", {
                eventId: event.eventId,
                eventType: event.type,
                cause: Cause.pretty(cause),
              }),
            ),
          );
        }

        yield* orchestrationEngine.dispatch({
          type: "thread.session.set",
          commandId: providerCommandId(event, "thread-session-set"),
          threadId: thread.id,
          session: {
            threadId: thread.id,
            status,
            providerName: event.provider,
            runtimeMode: thread.session?.runtimeMode ?? "full-access",
            activeTurnId: nextActiveTurnId,
            lastError,
            updatedAt: now,
          },
          createdAt: now,
        });

        // The provider will not send turn.completed for a turn its session
        // dropped mid-flight; settle it here so streamed text is not lost.
        if (
          event.type === "session.state.changed" &&
          activeTurnId !== null &&
          nextActiveTurnId === null
        ) {
          yield* settleTurn({ event, thread, turnId: activeTurnId, now });
        }
      }
    }

    // Closed first, so a thought lands ahead of the text or tool call that ended it.
    if (eventTurnId !== undefined && eventEndsReasoningBlock(event)) {
      yield* closeOpenReasoningBlock({
        event,
        threadId: thread.id,
        turnId: eventTurnId,
        tag: "reasoning-complete-on-next-step",
      });
    }
    // A new turn means any earlier block was left open by a turn that never settled.
    if (event.type === "turn.started" && shouldApplyThreadLifecycle) {
      yield* closeReasoningBlocksForThread(event, thread.id, "reasoning-complete-on-turn-started");
    }
    // Every close path is keyed by turn, so a turnless block could never be closed.
    if (
      event.type === "content.delta" &&
      eventTurnId !== undefined &&
      !conflictsWithActiveTurn &&
      event.payload.delta.length > 0 &&
      (event.payload.streamKind === "reasoning_text" ||
        event.payload.streamKind === "reasoning_summary_text")
    ) {
      yield* appendReasoningText({
        event,
        threadId: thread.id,
        turnId: eventTurnId,
        streamKind: event.payload.streamKind,
      });
    }
    if (
      event.type === "item.completed" &&
      event.payload.itemType === "reasoning" &&
      eventTurnId !== undefined &&
      !conflictsWithActiveTurn
    ) {
      yield* completeReasoningItem({ event, threadId: thread.id, turnId: eventTurnId });
    }

    const assistantDelta =
      event.type === "content.delta" && event.payload.streamKind === "assistant_text"
        ? event.payload.delta
        : undefined;
    const proposedPlanDelta =
      event.type === "turn.proposed.delta" ? event.payload.delta : undefined;

    if (assistantDelta && assistantDelta.length > 0) {
      const assistantMessageId = MessageId.makeUnsafe(
        `assistant:${event.itemId ?? event.turnId ?? event.eventId}`,
      );
      const turnId = toTurnId(event.turnId);
      if (turnId) {
        yield* rememberAssistantMessageId(thread.id, turnId, assistantMessageId);
      }

      const assistantDeliveryMode: AssistantDeliveryMode = yield* Effect.map(
        serverSettingsService.getSettings,
        (settings) => (settings.enableAssistantStreaming ? "streaming" : "buffered"),
      );
      if (assistantDeliveryMode === "buffered") {
        // Pace on the server clock; event timestamps may repeat across deltas.
        const spillChunk = yield* appendBufferedAssistantText(
          assistantMessageId,
          assistantDelta,
          yield* Clock.currentTimeMillis,
        );
        if (spillChunk.length > 0) {
          yield* orchestrationEngine.dispatch({
            type: "thread.message.assistant.delta",
            commandId: providerCommandId(event, "assistant-delta-buffer-spill"),
            threadId: thread.id,
            messageId: assistantMessageId,
            delta: spillChunk,
            ...(turnId ? { turnId } : {}),
            createdAt: now,
          });
        }
      } else {
        yield* streamAssistantDelta({
          event,
          threadId: thread.id,
          messageId: assistantMessageId,
          turnId,
          delta: assistantDelta,
        });
      }
    }

    if (proposedPlanDelta && proposedPlanDelta.length > 0) {
      const planId = proposedPlanIdFromEvent(event, thread.id);
      yield* appendBufferedProposedPlan(planId, proposedPlanDelta, now);
    }

    const assistantCompletion =
      event.type === "item.completed" && event.payload.itemType === "assistant_message"
        ? {
            messageId: MessageId.makeUnsafe(
              `assistant:${event.itemId ?? event.turnId ?? event.eventId}`,
            ),
            fallbackText: event.payload.detail,
          }
        : undefined;
    const proposedPlanCompletion =
      event.type === "turn.proposed.completed"
        ? {
            planId: proposedPlanIdFromEvent(event, thread.id),
            turnId: toTurnId(event.turnId),
            planMarkdown: event.payload.planMarkdown,
          }
        : undefined;

    if (assistantCompletion) {
      const assistantMessageId = assistantCompletion.messageId;
      const turnId = toTurnId(event.turnId);
      const existingAssistantMessage = thread.messages.find(
        (entry) => entry.id === assistantMessageId,
      );
      const shouldApplyFallbackCompletionText =
        !existingAssistantMessage || existingAssistantMessage.text.length === 0;
      if (turnId) {
        yield* rememberAssistantMessageId(thread.id, turnId, assistantMessageId);
      }

      yield* finalizeAssistantMessage({
        event,
        threadId: thread.id,
        messageId: assistantMessageId,
        ...(turnId ? { turnId } : {}),
        createdAt: now,
        commandTag: "assistant-complete",
        finalDeltaCommandTag: "assistant-delta-finalize",
        ...(assistantCompletion.fallbackText !== undefined && shouldApplyFallbackCompletionText
          ? { fallbackText: assistantCompletion.fallbackText }
          : {}),
      });

      if (turnId) {
        yield* forgetAssistantMessageId(thread.id, turnId, assistantMessageId);
      }
    }

    // Not gated on the active turn: an image can finish after turn.completed, and the adapter
    // already dropped those the user interrupted.
    const generatedImage =
      event.type === "item.completed" && event.payload.itemType === "image_view"
        ? readCodexGeneratedImageAttachment(event.payload.data)
        : undefined;
    if (generatedImage) {
      const turnId = toTurnId(event.turnId);
      yield* orchestrationEngine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: providerCommandId(event, "assistant-generated-image"),
        threadId: thread.id,
        messageId: MessageId.makeUnsafe(`assistant:image:${event.itemId ?? event.eventId}`),
        attachments: [generatedImage],
        ...(turnId ? { turnId } : {}),
        createdAt: now,
      });
    }

    if (proposedPlanCompletion) {
      yield* finalizeBufferedProposedPlan({
        event,
        threadId: thread.id,
        threadProposedPlans: thread.proposedPlans,
        planId: proposedPlanCompletion.planId,
        ...(proposedPlanCompletion.turnId ? { turnId: proposedPlanCompletion.turnId } : {}),
        fallbackMarkdown: proposedPlanCompletion.planMarkdown,
        updatedAt: now,
      });
    }

    if (event.type === "turn.completed") {
      const turnId = toTurnId(event.turnId);
      if (turnId) {
        yield* settleTurn({ event, thread, turnId, now });
      }
    }

    if (event.type === "session.exited") {
      yield* closeReasoningBlocksForThread(event, thread.id, "reasoning-complete-on-session-exit");
      yield* flushStreamingAssistantTextForThread(thread.id);
      yield* clearTurnStateForSession(thread.id);
    }

    if (event.type === "runtime.error") {
      const runtimeErrorMessage = event.payload.message;

      // Suppress stale session errors — the reactor will auto-retry with a fresh session.
      const isStaleSessionRuntimeError =
        typeof runtimeErrorMessage === "string" &&
        (runtimeErrorMessage.includes("No conversation found with session ID") ||
          runtimeErrorMessage.includes("does not exist"));

      const shouldApplyRuntimeError =
        !isStaleSessionRuntimeError &&
        (!STRICT_PROVIDER_LIFECYCLE_GUARD
          ? true
          : activeTurnId === null ||
            eventTurnId === undefined ||
            sameId(activeTurnId, eventTurnId));

      if (shouldApplyRuntimeError) {
        yield* orchestrationEngine.dispatch({
          type: "thread.session.set",
          commandId: providerCommandId(event, "runtime-error-session-set"),
          threadId: thread.id,
          session: {
            threadId: thread.id,
            status: "error",
            providerName: event.provider,
            runtimeMode: thread.session?.runtimeMode ?? "full-access",
            activeTurnId: eventTurnId ?? null,
            lastError: runtimeErrorMessage,
            updatedAt: now,
          },
          createdAt: now,
        });
      }
    }

    // Provider-generated names must not overwrite a title the user (or title generation) already set.
    if (
      event.type === "thread.metadata.updated" &&
      event.payload.name &&
      canReplaceThreadTitle(thread.title)
    ) {
      yield* orchestrationEngine.dispatch({
        type: "thread.meta.update",
        commandId: providerCommandId(event, "thread-meta-update"),
        threadId: thread.id,
        title: event.payload.name,
      });
    }

    if (event.type === "turn.diff.updated") {
      const turnId = toTurnId(event.turnId);
      if (turnId && (yield* isGitRepoForThread(thread.id))) {
        // Skip if a checkpoint already exists for this turn. A real
        // (non-placeholder) capture from CheckpointReactor should not
        // be clobbered, and dispatching a duplicate placeholder for the
        // same turnId would produce an unstable checkpointTurnCount.
        if (thread.checkpoints.some((c) => c.turnId === turnId)) {
          // Already tracked; no-op.
        } else {
          const assistantMessageId = MessageId.makeUnsafe(
            `assistant:${event.itemId ?? event.turnId ?? event.eventId}`,
          );
          const maxTurnCount = thread.checkpoints.reduce(
            (max, c) => Math.max(max, c.checkpointTurnCount),
            0,
          );
          yield* orchestrationEngine.dispatch({
            type: "thread.turn.diff.complete",
            commandId: providerCommandId(event, "thread-turn-diff-complete"),
            threadId: thread.id,
            turnId,
            completedAt: now,
            checkpointRef: CheckpointRef.makeUnsafe(`provider-diff:${event.eventId}`),
            status: "missing",
            files: [],
            assistantMessageId,
            checkpointTurnCount: maxTurnCount + 1,
            createdAt: now,
          });
        }
      }
    }

    // A new Claude session means the previous CLI is gone, along with any task it left open.
    if (event.type === "session.started" && event.provider === "claudeAgent") {
      yield* Effect.forEach(
        settleOpenTasksCommands({
          threadId: thread.id,
          activities: thread.activities,
          createdAt: now,
          commandId: () => providerCommandId(event, "thread-activity-settle-stale-task"),
        }),
        (command) => orchestrationEngine.dispatch(command),
        { discard: true },
      );
    }

    const activities = runtimeEventToActivities(event);
    yield* Effect.forEach(activities, (activity) =>
      orchestrationEngine.dispatch({
        type: "thread.activity.append",
        commandId: providerCommandId(event, "thread-activity-append"),
        threadId: thread.id,
        activity,
        createdAt: activity.createdAt,
      }),
    ).pipe(Effect.asVoid);
  });

  const processDomainEvent = (_event: TurnStartRequestedDomainEvent) => Effect.void;

  const processInput = (input: RuntimeIngestionInput) => {
    switch (input.source) {
      case "runtime":
        return processRuntimeEvent(input.event);
      case "domain":
        return processDomainEvent(input.event);
      case "assistant-flush":
        return flushStreamingAssistantText(input.messageId);
    }
  };

  // Best effort, and leaves the status alone: the write may fail for the same reason the event did.
  const surfaceDatabaseError = Effect.fn("surfaceDatabaseError")(function* (
    event: ProviderRuntimeEvent,
    message: string,
  ) {
    const threadId = event.threadId;
    if (Option.isSome(yield* Cache.getOption(databaseErrorSurfacedByThreadId, threadId))) {
      return;
    }
    yield* Cache.set(databaseErrorSurfacedByThreadId, threadId, true);
    const readModel = yield* orchestrationEngine.getReadModel();
    const session = readModel.threads.get(threadId)?.session;
    if (!session || session.lastError === message) {
      return;
    }
    yield* orchestrationEngine.dispatch({
      type: "thread.session.set",
      commandId: providerCommandId(event, "database-error-session-set"),
      threadId,
      session: { ...session, lastError: message, updatedAt: event.createdAt },
      createdAt: event.createdAt,
    });
  });

  const processInputSafely = (input: RuntimeIngestionInput) =>
    processInput(input).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        const databaseMessage = userFacingDatabaseErrorMessage(Cause.squash(cause));
        return Effect.logWarning("provider runtime ingestion failed to process event", {
          source: input.source,
          eventId: input.event.eventId,
          eventType: input.event.type,
          cause: Cause.pretty(cause),
        }).pipe(
          Effect.andThen(
            databaseMessage === undefined || input.source === "domain"
              ? Effect.void
              : surfaceDatabaseError(input.event, databaseMessage).pipe(
                  Effect.catchCause((surfaceCause) =>
                    Cause.hasInterruptsOnly(surfaceCause)
                      ? Effect.failCause(surfaceCause)
                      : Effect.logWarning("provider runtime ingestion could not surface error", {
                          eventId: input.event.eventId,
                          cause: Cause.pretty(surfaceCause),
                        }),
                  ),
                ),
          ),
        );
      }),
    );

  const worker: DrainableWorker<RuntimeIngestionInput> =
    yield* makeDrainableWorker(processInputSafely);

  const start: ProviderRuntimeIngestionShape["start"] = Effect.fn("start")(function* () {
    // Subscribe synchronously BEFORE forking the consumer loops. See note in
    // CheckpointReactor.start for why this matters.
    const runtimeEventQueue = yield* providerService.subscribeEvents();
    const domainEventQueue = yield* orchestrationEngine.subscribeDomainEvents();

    yield* Effect.forkScoped(
      Effect.forever(
        PubSub.take(runtimeEventQueue).pipe(
          Effect.flatMap((event) => worker.enqueue({ source: "runtime", event })),
        ),
      ),
    );
    yield* Effect.forkScoped(
      Effect.forever(
        PubSub.take(domainEventQueue).pipe(
          Effect.flatMap((event) => {
            if (event.type !== "thread.turn-start-requested") {
              return Effect.void;
            }
            return worker.enqueue({ source: "domain", event });
          }),
        ),
      ),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies ProviderRuntimeIngestionShape;
});

export const ProviderRuntimeIngestionLive = Layer.effect(
  ProviderRuntimeIngestionService,
  make(),
).pipe(Layer.provide(ProjectionTurnRepositoryLive));
