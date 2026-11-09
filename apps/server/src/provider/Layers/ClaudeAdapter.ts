/**
 * ClaudeAdapterLive - Scoped live implementation for the Claude Agent provider adapter.
 *
 * Wraps `@anthropic-ai/claude-agent-sdk` query sessions behind the generic
 * provider adapter contract and emits canonical runtime events.
 *
 * @module ClaudeAdapterLive
 */
import * as OS from "node:os";
import * as Path from "node:path";

import {
  type CanUseTool,
  query,
  type Options as ClaudeQueryOptions,
  type PermissionMode,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  ApprovalRequestId,
  type CanonicalItemType,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  type ProviderInteractionMode,
  ProviderItemId,
  type ProviderGoal,
  type ProviderRuntimeEvent,
  type ProviderRuntimeTurnStatus,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ThreadTokenUsageSnapshot,
  RuntimeTaskId,
  ThreadId,
  TurnId,
  ClaudeCodeEffort,
} from "@piedpiper/contracts";
import { resolveApiModelId, resolveEffort } from "@piedpiper/shared/model";
import { sliceSurrogateSafe } from "@piedpiper/shared/String";
import {
  Cause,
  DateTime,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Fiber,
  Layer,
  Queue,
  Random,
  Ref,
  Stream,
} from "effect";

import {
  makeClaudeApprovals,
  CLAUDE_RESUME_DIALOG_KIND,
  type PendingApproval,
  type PendingUserInput,
} from "./ClaudeApprovals.ts";
import {
  type ClaudeTaskEntry,
  isClaudeTaskTool,
  applyClaudeTaskToolResult,
  claudeTaskStoreDirectory,
  readClaudeTaskStore,
  planStepsFromClaudeTasks,
} from "./ClaudeTasks.ts";
import { ToolInputStreamExtractor } from "./ClaudeToolInputStream.ts";

import { redactProviderRuntimeEvent } from "../providerErrorRedaction.ts";
import { readClaudeRuntimeSettings, claudeAutoCompactThreshold } from "./ClaudeRuntimeSettings.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { getClaudeModelCapabilities } from "./ClaudeProvider.ts";
import {
  buildClaudeChildEnv,
  resolveClaudeConfigDir,
  resolveClaudeSdkExecutablePath,
} from "./ClaudeExecutable.ts";
import {
  CLAUDE_LIVE_COMMAND_OUTPUT_FIELD,
  claudeTaskOutputRoot,
  tailClaudeTaskOutput,
} from "./ClaudeTaskOutputTail.ts";
import {
  claudeGoalMetByTurn,
  claudeGoalsEqual,
  isClaudeGoalAcknowledgement,
  isClaudeGoalModelOutput,
  nextClaudeGoal,
} from "./ClaudeGoal.ts";
import {
  claudeExitMessageWithStderr,
  claudeProcessGroupSpawnerFor,
} from "../claudeProcessGroup.ts";
import { type ClaudeAttachmentBudget, makeClaudeAttachmentBudget } from "../pdfDocumentBudget.ts";
import { describeUnknownSdkMessage } from "../unknownSdkMessagePreview.ts";

export { buildClaudeChildEnv };
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { ClaudeAdapter, type ClaudeAdapterShape } from "../Services/ClaudeAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import {
  CLAUDE_PROVIDER_RETRY_DETAIL_KIND,
  CLAUDE_SETTING_SOURCES,
  PROVIDER,
  claudeApiRetryingMessage,
  claudeApiRetrySettledMessage,
  claudePermissionDowngradeNotice,
  claudePermissionModeFallbacks,
  requestClaudePermissionMode,
  type ClaudeApiRetryOutcome,
  type ClaudeApiRetryStatus,
  claudeAppendFlagMissingValueError,
  claudeGoalDeferringWorkCount,
  claudeLaunchExtraArgs,
  claudeLiveBackgroundWorkCount,
  readClaudeLaunchAppendFile,
  readClaudeLaunchSettings,
  asCanonicalTurnId,
  asRuntimeItemId,
  asRuntimeRequestId,
  buildUserMessageWithPdfBudgetEffect,
  claudeRateLimitCompletionFields,
  type ClaudeAssistantRateLimitWindow,
  classifyToolItemType,
  claudeContextWindowForApiModel,
  claudeKnownContextWindowForModel,
  claudeOpenToolStatusForTurn,
  claudeReportedContextWindows,
  exitPlanCaptureKey,
  extractAssistantTextBlocks,
  extractContentBlockText,
  extractExitPlanModePlan,
  extractPlanStepsFromTodoInput,
  isSubagentMessage,
  parentToolUseIdFromMessage,
  resolveClaudeResultContextWindow,
  isTodoTool,
  getEffectiveClaudeCodeEffort,
  interruptionMessageFromClaudeCause,
  isClaudeInterruptedCause,
  isClaudeMissingRewindPointText,
  messageFromClaudeStreamCause,
  nativeProviderRefs,
  normalizeClaudeTokenUsage,
  claudeCompactBoundaryContextUsage,
  claudeRequestContextUsage,
  claudeUsageInputTokens,
  mergeClaudeStreamUsage,
  readClaudeResumeState,
  sdkMessageSubtype,
  claudeCompactPreservedMessageIds,
  claudeFocusRequestedPanePlugin,
  claudeModPaneUnsupportedMessage,
  sdkMessageType,
  sdkNativeItemId,
  sdkNativeMethod,
  streamKindFromDeltaType,
  summarizeToolRequest,
  titleForTool,
  toError,
  toMessage,
  toRequestError,
  toolInputFingerprint,
  toolInputStreamField,
  sanitizeToolResultForPersistence,
  toolResultBlocksFromUserMessage,
  toolResultStreamKind,
  tryParseJsonRecord,
  resultOutcome,
  claudeAuthFailureMessage,
  claudeWritesUpdatesAsThinking,
  CLAUDE_USAGE_LIMIT_FAILURE_MESSAGE,
  describeClaudeUsageLimit,
  isClaudeUsageLimitBlocking,
  readAssistantRateLimitWindow,
} from "./ClaudeAdapterHelpers.ts";

type PromptQueueItem =
  | {
      readonly type: "message";
      readonly message: SDKUserMessage;
    }
  | {
      readonly type: "terminate";
    };

/** How long Stop waits for Claude to abort a running turn before closing the process. */
const CLAUDE_INTERRUPT_GRACE = "3 seconds";
/** How long interruptTurn waits for the SDK to acknowledge an interrupt before failing. */
const CLAUDE_INTERRUPT_ACK_TIMEOUT = "10 seconds";
/** Per-task and overall bounds for stopping background tasks before Stop interrupts the turn. */
const CLAUDE_STOP_TASK_TIMEOUT = "3 seconds";
const CLAUDE_STOP_TASKS_TOTAL_TIMEOUT = "10 seconds";
/** Restarting the Claude process would kill its background subagents and shells. */
export const CLAUDE_RESTART_WITH_LIVE_TASKS_DETAIL =
  "Claude still has background agents or shells running, and applying this change would restart Claude and stop them. Wait for the background work to finish, then try again.";
/** System notices missing from the SDK union: the work log shows the git/gh calls, and mod panes have no surface here. */
const IGNORED_UNTYPED_CLAUDE_SYSTEM_SUBTYPES: ReadonlySet<string> = new Set([
  "vcs_state_changed",
  "code_change_published",
  "ui_panes",
  "ui_invalidate",
  "session_title_changed",
]);
/** Wire-only top-level message types (absent from the SDKMessage union) with no runtime surface. */
const IGNORED_CLAUDE_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  "keep_alive",
  "command_lifecycle",
]);

/**
 * True when a result answers a Claude-initiated turn (background task, peer
 * message, resume handshake) rather than the active user turn. Real turns send
 * their turnId as the prompt uuid, which newer CLIs echo back; results with
 * neither echo nor origin (older CLIs) still complete the active turn.
 */
export function isClaudeResultForOtherTurn(
  result: SDKResultMessage,
  turn: { readonly turnId: string; readonly synthetic: boolean },
): boolean {
  if (turn.synthetic) return false;
  const echoed = [
    ...(result.user_message_uuids ?? []),
    ...(result.user_message_uuid ? [result.user_message_uuid] : []),
  ];
  if (echoed.length > 0) return !echoed.includes(turn.turnId);
  return result.origin !== undefined && result.origin.kind !== "human";
}

interface ClaudeTurnState {
  readonly turnId: TurnId;
  readonly startedAt: string;
  /** True for turns auto-opened by assistant output outside a user turn. */
  readonly synthetic: boolean;
  readonly assistantTextBlocks: Map<number, AssistantTextBlockState>;
  readonly assistantTextBlockOrder: Array<AssistantTextBlockState>;
  readonly capturedProposedPlanKeys: Set<string>;
  /** `${toolUseId}:${inputFingerprint}` of TodoWrite inputs already emitted as plan updates. */
  readonly capturedTodoPlanKeys: Set<string>;
  /** Set by Stop, so the synthetic error results that follow read as stopped, not failed. */
  interruptRequested?: boolean;
  nextSyntheticAssistantBlockIndex: number;
  /** Evidence the turn failed on an expired login, kept for the result fallback. */
  authenticationFailed: boolean;
  /** Usage-limit windows currently rejecting this turn: window type to reset in epoch seconds, null if unknown. */
  readonly rejectedRateLimitTypes: Map<string, number | null>;
  /** Usage-limit notices already shown for this turn, keyed `window:resetsAt`. */
  readonly announcedUsageLimitKeys: Set<string>;
  latestAssistantRateLimited: boolean;
  /** The blocking window the latest root assistant frame named; later parent responses replace it. */
  latestAssistantRateLimitWindow: ClaudeAssistantRateLimitWindow | undefined;
  /** Latest root transcript entry of this turn; a rewind resumes Claude at the kept turn's last one. */
  lastRootEntryUuid?: string;
  /** The retry row still open for this turn; the next root progress or the turn's end settles it. */
  apiRetry?: ClaudeApiRetryStatus & {
    readonly retryId: string;
    /** Opened while the root waited on a subagent, so that subagent's progress settles it too. */
    readonly whileSubagentRuns: boolean;
  };
  /** Rate-limit frames share one row: they can be another agent's wait, so none proves a new streak. */
  rateLimitRetryId?: string;
  /** A root response is streaming; a 429 comes before a response, so it cannot be about this one. */
  rootStreamOpen?: boolean;
  /** Model output since the goal's last failed check, which a turn needs before it can have met that goal. */
  sawGoalModelOutput?: boolean;
  /** Id of the root message being streamed; content block indexes restart with each message. */
  rootStreamMessageId?: string;
  /** Root thinking blocks that streamed text and have not ended, by block index. */
  readonly openThinkingBlocks: Map<number, string>;
  /** Text so far of each open root thinking block, by block index; blank ones never get an item. */
  readonly openThinkingText: Map<number, string>;
  /** Model of the root message being streamed. */
  rootStreamModel?: string | undefined;
  /** The root's latest block, when it was non-empty thinking; a following tool call may promote it. */
  lastThinking?: ClaudeLastThinkingBlock | undefined;
  /** Per root message, so a snapshot only reports thinking the stream did not already deliver. */
  readonly thinkingByMessage: Map<string, ClaudeMessageThinkingState>;
}

interface ClaudeMessageThinkingState {
  streamedBlocks: number;
  readonly snapshotTexts: Set<string>;
  /** The stream reports this message's blocks in order, so its snapshots leave `lastThinking` alone. */
  streamStarted: boolean;
  /** Other blocks its snapshots delivered, so a cumulative repeat of one changes nothing. */
  readonly snapshotBlockKeys: Set<string>;
}

interface ClaudeLastThinkingBlock {
  readonly messageId: string;
  readonly itemId: string;
  readonly text: string;
  readonly followsThinking: boolean;
}

interface AssistantTextBlockState {
  readonly itemId: string;
  readonly blockIndex: number;
  emittedTextDelta: boolean;
  fallbackText: string;
  streamClosed: boolean;
  completionEmitted: boolean;
}

interface ToolInFlight {
  readonly itemId: string;
  readonly itemType: CanonicalItemType;
  readonly toolName: string;
  /** The tool call whose frames started this one; null for the root agent. */
  readonly parentToolUseId: string | null;
  readonly title: string;
  readonly detail?: string;
  readonly input: Record<string, unknown>;
  readonly partialInputJsonParts: string[];
  readonly lastEmittedInputFingerprint?: string;
  readonly streamExtractor: ToolInputStreamExtractor | undefined;
}

interface ClaudeSessionContext {
  session: ProviderSession;
  /** Start input with the latest model and mode, used to restart the session on a rewind. */
  startInput: ProviderSessionStartInput;
  /** Last root transcript entry of each completed turn (resumed ones included); null where unknown. */
  readonly turnEndMessageIds: Array<string | null>;
  /** Set after a rewind until Claude writes to the new branch, so a restart still resumes there. */
  pendingRewindAt: string | undefined;
  readonly promptQueue: Queue.Queue<PromptQueueItem>;
  readonly query: ClaudeQueryRuntime;
  streamFiber: Fiber.Fiber<void, Error> | undefined;
  readonly startedAt: string;
  /** The mode the runtime mode asks for; undefined is Supervised. Refusals never change it. */
  readonly basePermissionMode: PermissionMode | undefined;
  /** Claude's mode as last reported or accepted; compare it to the base to spot a downgrade. */
  livePermissionMode: PermissionMode;
  /** Set by the first init or a mode change: a later init frame must not overwrite the live mode. */
  openingPermissionModeSettled: boolean;
  /** Downgrade notice last shown, so it does not repeat every turn. */
  permissionDowngradeNotice: string | undefined;
  /**
   * Live interaction-mode pin read by `canUseTool`. When `"ask"`, every tool
   * call is denied so the agent can only respond conversationally. Updated
   * by `sendTurn` whenever the per-turn input carries
   * a new `interactionMode`, so the user can toggle live without restarting
   * the session.
   */
  currentInteractionMode: ProviderInteractionMode;
  currentApiModelId: string | undefined;
  /** Effort, fast mode and ultracode the live query runs with, so a turn only re-applies changes. */
  currentEffort: string | null;
  currentFastMode: boolean;
  currentUltracode: boolean;
  /** Set when the server is quitting, not on an explicit stop: open questions survive the restart. */
  serverShuttingDown: boolean;
  readonly attachmentBudget: ClaudeAttachmentBudget;
  resumeSessionId: string | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  /** Only turn ids: keeping SDK messages here would hold every tool result for the session's life. */
  readonly turns: Array<{ readonly id: TurnId }>;
  readonly inFlightTools: Map<number, ToolInFlight>;
  turnState: ClaudeTurnState | undefined;
  lastKnownContextWindow: number | undefined;
  autoCompactWindow: string;
  readonly readRuntimeSettings: (
    model: string | undefined,
  ) => Effect.Effect<{ autoCompactWindow: string; toolSearchOverride: "true" | undefined }>;
  /** The model the init frame names, for a session started without one; never drives setModel. */
  initApiModelId: string | undefined;
  /** Claude had no answer on Auto when last asked, which is not a refusal. */
  autoPermissionUnconfirmed: boolean;
  /** Windows Claude reported per model, for switching back to a model the table does not know. */
  readonly reportedContextWindows: Map<string, number>;
  lastKnownTokenUsage: ThreadTokenUsageSnapshot | undefined;
  /** The session's Claude task list (TaskCreate/TaskUpdate/TaskList); subagents share it. */
  readonly claudeTasks: Map<string, ClaudeTaskEntry>;
  /** Whether claudeTasks reflects Claude's persisted list; a resumed session reads it once. */
  claudeTasksLoaded: boolean;
  /** Config directory this session's CLI started with; undefined leaves Claude's own default. */
  readonly claudeConfigDir: string | undefined;
  /** Task tool calls awaiting their result, by tool_use id. */
  readonly pendingTaskToolCalls: Map<
    string,
    { readonly toolName: string; readonly input: unknown }
  >;
  /** Usage of the latest root request, merged from its stream events; null once a compaction made it stale. */
  rootRequestUsage:
    | { readonly messageId: string; usage: Record<string, unknown> | null }
    | undefined;
  /** Set by compact_boundary until a root request reports fresh usage. */
  contextUsageStale: boolean;
  /** Item id of the automatic compaction Claude reported as running, until it ends. */
  runningCompactionItemId: string | undefined;
  /** Last live context-usage emission, used to dedupe and throttle stream updates. */
  lastLiveContextUsage:
    | { readonly messageId: string; readonly usedTokens: number; readonly atMs: number }
    | undefined;
  lastAssistantUuid: string | undefined;
  lastThreadStartedId: string | undefined;
  /** Resolved by completeTurn while Stop waits for Claude to abort the turn. */
  interruptedTurnSettled: Deferred.Deferred<void> | undefined;
  /** Set when interruptTurn timed out, so Stop skips the grace wait on an unresponsive CLI. */
  interruptAckTimedOut: boolean;
  /** Background tasks (subagents, shells) started but not yet reported finished. */
  readonly liveTaskIds: Set<string>;
  /** Tasks settled without their final frame, so a late one cannot report them twice. */
  readonly settledTaskIds: Set<string>;
  /** Tasks whose `task_updated` end frame came first; the `task_notification` behind it carries the summary. */
  readonly pendingTaskEnds: Map<string, "completed" | "failed">;
  /** Claude's type for each task it named, which decides whether the task holds a goal's check. */
  readonly taskTypes: Map<string, string>;
  /** Non-ambient tasks from Claude's last background level; undefined until the first one. */
  backgroundRoster: Set<string> | undefined;
  /** The `/goal` Claude last reported for this conversation. */
  goal: ProviderGoal | null;
  /** Index of the turn that set `goal`, so a rollback can tell whether the goal survives it. */
  goalSetAtTurn: number | undefined;
  /** Filled synchronously by the process-group spawner when the CLI exits abnormally. */
  readonly cliExit: { stderrTail?: string };
  /** Per process: a relative temp dir follows the cwd this CLI was launched in. */
  readonly taskOutputRoot: string | undefined;
  /** Foreground Bash calls whose output file is being tailed, by tool_use_id. */
  readonly taskOutputTails: Map<
    string,
    { readonly fiber: Fiber.Fiber<void, never>; readonly stop: Deferred.Deferred<void> }
  >;
  stopped: boolean;
}

/** The downgrade notice to show now: once per downgrade, and again only after regaining the mode. */
function takePermissionDowngradeNotice(context: ClaudeSessionContext): string | undefined {
  // Plan mode says nothing about whether the requested mode is available.
  if (context.livePermissionMode === "plan") return undefined;
  const notice = claudePermissionDowngradeNotice(
    context.basePermissionMode,
    context.livePermissionMode,
    context.autoPermissionUnconfirmed,
  );
  const isNew = notice !== undefined && notice !== context.permissionDowngradeNotice;
  context.permissionDowngradeNotice = notice;
  return isNew ? notice : undefined;
}

type ClaudeLiveFlagSettings = {
  readonly effortLevel?: Exclude<ClaudeCodeEffort, "ultrathink"> | null;
  readonly fastMode?: boolean | null;
  readonly ultracode?: boolean | null;
};

interface ClaudeQueryRuntime extends AsyncIterable<SDKMessage> {
  readonly interrupt: () => Promise<void>;
  readonly setModel: (model?: string) => Promise<void>;
  readonly setPermissionMode: (mode: PermissionMode) => Promise<void>;
  readonly setMaxThinkingTokens: (maxThinkingTokens: number | null) => Promise<void>;
  readonly applyFlagSettings: (settings: ClaudeLiveFlagSettings) => Promise<void>;
  readonly stopTask?: (taskId: string) => Promise<void>;
  readonly close: () => void;
}

export interface ClaudeAdapterLiveOptions {
  readonly createQuery?: (input: {
    readonly prompt: AsyncIterable<SDKUserMessage>;
    readonly options: ClaudeQueryOptions;
  }) => ClaudeQueryRuntime;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

/** Minimum gap between live context-usage updates of one session. */
const LIVE_CONTEXT_USAGE_THROTTLE_MS = 1_000;
const CLAUDE_REWIND_POINT_MISSING_WARNING =
  "Claude could not rewind to the reverted turn, likely because its history was compacted, so it still remembers the reverted turns. Start a new thread to drop them.";
const CLAUDE_REWIND_POINT_MISSING_TURN_MESSAGE =
  "Claude could not rewind its history to the reverted turn and was resumed without rewinding. Send the message again.";

function asUsageRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const noteThinkingBlock = (
  turnState: ClaudeTurnState,
  block: { readonly messageId: string; readonly itemId?: string; readonly text: string },
) => {
  const previous = turnState.lastThinking;
  turnState.lastThinking =
    block.itemId !== undefined && block.text.trim().length > 0
      ? {
          messageId: block.messageId,
          itemId: block.itemId,
          text: block.text,
          followsThinking: previous?.messageId === block.messageId,
        }
      : undefined;
};

const makeClaudeAdapter = Effect.fn("makeClaudeAdapter")(function* (
  options?: ClaudeAdapterLiveOptions,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const serverConfig = yield* ServerConfig;
  const nativeEventLogger =
    options?.nativeEventLogger ??
    (options?.nativeEventLogPath !== undefined
      ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
          stream: "native",
        })
      : undefined);

  const createQuery =
    options?.createQuery ??
    ((input: {
      readonly prompt: AsyncIterable<SDKUserMessage>;
      readonly options: ClaudeQueryOptions;
    }) => query({ prompt: input.prompt, options: input.options }) as ClaudeQueryRuntime);

  const sessions = new Map<ThreadId, ClaudeSessionContext>();
  const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const serverSettingsService = yield* ServerSettingsService;

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const nextEventId = Effect.map(Random.nextUUIDv4, (id) => EventId.makeUnsafe(id));
  const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

  const offerRuntimeEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> => {
    const context = sessions.get(event.threadId);
    const enriched =
      event.type === "thread.token-usage.updated" && context
        ? {
            ...event,
            payload: {
              usage: {
                ...event.payload.usage,
                ...claudeAutoCompactThreshold(
                  context.autoCompactWindow,
                  event.payload.usage.maxTokens,
                ),
              },
            },
          }
        : event;
    return Queue.offer(runtimeEventQueue, redactProviderRuntimeEvent(enriched)).pipe(Effect.asVoid);
  };

  const logNativeSdkMessage = Effect.fn("logNativeSdkMessage")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    if (!nativeEventLogger) {
      return;
    }
    // Per-token deltas and progress ticks would dominate the log; message boundaries are kept.
    if (
      (message.type === "stream_event" && message.event.type === "content_block_delta") ||
      (message.type === "system" && message.subtype === "thinking_tokens") ||
      (message.type === "tool_progress" && message.heartbeat === true)
    ) {
      return;
    }

    const observedAt = new Date().toISOString();
    const itemId = sdkNativeItemId(message);

    yield* nativeEventLogger.write(
      {
        observedAt,
        event: {
          id:
            "uuid" in message && typeof message.uuid === "string"
              ? message.uuid
              : crypto.randomUUID(),
          kind: "notification",
          provider: PROVIDER,
          createdAt: observedAt,
          method: sdkNativeMethod(message),
          ...(typeof message.session_id === "string"
            ? { providerThreadId: message.session_id }
            : {}),
          ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
          ...(itemId ? { itemId: ProviderItemId.makeUnsafe(itemId) } : {}),
          payload: message,
        },
      },
      context.session.threadId,
    );
  });

  const snapshotThread = Effect.fn("snapshotThread")(function* (context: ClaudeSessionContext) {
    const threadId = context.session.threadId;
    if (!threadId) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "readThread",
        issue: "Session thread id is not initialized yet.",
      });
    }
    return {
      threadId,
      turns: context.turns.map((turn) => ({ id: turn.id, items: [] })),
    };
  });

  const updateResumeCursor = Effect.fn("updateResumeCursor")(function* (
    context: ClaudeSessionContext,
  ) {
    const threadId = context.session.threadId;
    if (!threadId) return;

    const resumeCursor = {
      threadId,
      ...(context.resumeSessionId ? { resume: context.resumeSessionId } : {}),
      ...(context.lastAssistantUuid ? { resumeSessionAt: context.lastAssistantUuid } : {}),
      turnCount: context.turnEndMessageIds.length,
      turnEndMessageIds: [...context.turnEndMessageIds],
      ...(context.pendingRewindAt ? { rewindTo: context.pendingRewindAt } : {}),
      ...(context.goal ? { goal: context.goal } : {}),
      ...(context.goal && context.goalSetAtTurn !== undefined
        ? { goalSetAtTurn: context.goalSetAtTurn }
        : {}),
    };

    context.session = {
      ...context.session,
      resumeCursor,
      updatedAt: yield* nowIso,
    };
  });

  const setClaudeGoal = Effect.fn("setClaudeGoal")(function* (
    context: ClaudeSessionContext,
    goal: ProviderGoal | null,
  ) {
    if (claudeGoalsEqual(context.goal, goal)) return;
    const sameObjective = context.goal?.objective === goal?.objective;
    context.goal = goal;
    if (!sameObjective) {
      context.goalSetAtTurn = goal === null ? undefined : context.turnEndMessageIds.length;
    }
    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "thread.goal.updated",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      ...(context.turnState ? { turnId: context.turnState.turnId } : {}),
      payload: { goal },
      providerRefs: {},
    });
    yield* updateResumeCursor(context);
  });

  const trackClaudeGoal = Effect.fn("trackClaudeGoal")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    if (
      context.goal?.status === "active" &&
      context.turnState &&
      isClaudeGoalModelOutput(message)
    ) {
      context.turnState.sawGoalModelOutput = true;
    }
    const next = nextClaudeGoal(context.goal, message);
    if (next === undefined) return;
    // The Stop hook cap can end a turn right after a failed check, so only later output counts.
    if (message.type === "user" && context.turnState) {
      context.turnState.sawGoalModelOutput = false;
    }
    yield* setClaudeGoal(context, next);
  });

  const ensureAssistantTextBlock = Effect.fn("ensureAssistantTextBlock")(function* (
    context: ClaudeSessionContext,
    blockIndex: number,
    options?: {
      readonly fallbackText?: string;
      readonly streamClosed?: boolean;
    },
  ) {
    const turnState = context.turnState;
    if (!turnState) {
      return undefined;
    }

    const existing = turnState.assistantTextBlocks.get(blockIndex);
    if (existing && !existing.completionEmitted) {
      if (existing.fallbackText.length === 0 && options?.fallbackText) {
        existing.fallbackText = options.fallbackText;
      }
      if (options?.streamClosed) {
        existing.streamClosed = true;
      }
      return { blockIndex, block: existing };
    }

    const block: AssistantTextBlockState = {
      itemId: yield* Random.nextUUIDv4,
      blockIndex,
      emittedTextDelta: false,
      fallbackText: options?.fallbackText ?? "",
      streamClosed: options?.streamClosed ?? false,
      completionEmitted: false,
    };
    turnState.assistantTextBlocks.set(blockIndex, block);
    turnState.assistantTextBlockOrder.push(block);
    return { blockIndex, block };
  });

  const createSyntheticAssistantTextBlock = Effect.fn("createSyntheticAssistantTextBlock")(
    function* (context: ClaudeSessionContext, fallbackText: string) {
      const turnState = context.turnState;
      if (!turnState) {
        return undefined;
      }

      const blockIndex = turnState.nextSyntheticAssistantBlockIndex;
      turnState.nextSyntheticAssistantBlockIndex -= 1;
      return yield* ensureAssistantTextBlock(context, blockIndex, {
        fallbackText,
        streamClosed: true,
      });
    },
  );

  const completeAssistantTextBlock = Effect.fn("completeAssistantTextBlock")(function* (
    context: ClaudeSessionContext,
    block: AssistantTextBlockState,
    options?: {
      readonly force?: boolean;
      readonly rawMethod?: string;
      readonly rawPayload?: unknown;
    },
  ) {
    const turnState = context.turnState;
    if (!turnState || block.completionEmitted) {
      return;
    }

    if (!options?.force && !block.streamClosed) {
      return;
    }

    if (!block.emittedTextDelta && block.fallbackText.length > 0) {
      const deltaStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "content.delta",
        eventId: deltaStamp.eventId,
        provider: PROVIDER,
        createdAt: deltaStamp.createdAt,
        threadId: context.session.threadId,
        turnId: turnState.turnId,
        itemId: asRuntimeItemId(block.itemId),
        payload: {
          streamKind: "assistant_text",
          delta: block.fallbackText,
        },
        providerRefs: nativeProviderRefs(),
        ...(options?.rawMethod || options?.rawPayload
          ? {
              raw: {
                source: "claude.sdk.message" as const,
                ...(options.rawMethod ? { method: options.rawMethod } : {}),
                payload: options?.rawPayload,
              },
            }
          : {}),
      });
    }

    block.completionEmitted = true;
    if (turnState.assistantTextBlocks.get(block.blockIndex) === block) {
      turnState.assistantTextBlocks.delete(block.blockIndex);
    }

    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "item.completed",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      itemId: asRuntimeItemId(block.itemId),
      threadId: context.session.threadId,
      turnId: turnState.turnId,
      payload: {
        itemType: "assistant_message",
        status: "completed",
        title: "Assistant message",
        ...(block.fallbackText.length > 0 ? { detail: block.fallbackText } : {}),
      },
      providerRefs: nativeProviderRefs(),
      ...(options?.rawMethod || options?.rawPayload
        ? {
            raw: {
              source: "claude.sdk.message" as const,
              ...(options.rawMethod ? { method: options.rawMethod } : {}),
              payload: options?.rawPayload,
            },
          }
        : {}),
    });
  });

  const thinkingStateForMessage = (turnState: ClaudeTurnState, messageId: string) => {
    const existing = turnState.thinkingByMessage.get(messageId);
    if (existing) return existing;
    const created: ClaudeMessageThinkingState = {
      streamedBlocks: 0,
      snapshotTexts: new Set(),
      streamStarted: false,
      snapshotBlockKeys: new Set(),
    };
    turnState.thinkingByMessage.set(messageId, created);
    return created;
  };

  const streamedThinkingItemId = (turnState: ClaudeTurnState, blockIndex: number) => {
    const open = turnState.openThinkingBlocks.get(blockIndex);
    if (open !== undefined) return open;
    const messageId = turnState.rootStreamMessageId ?? String(turnState.turnId);
    const itemId = `${messageId}:thinking:${blockIndex}`;
    turnState.openThinkingBlocks.set(blockIndex, itemId);
    thinkingStateForMessage(turnState, messageId).streamedBlocks += 1;
    return itemId;
  };

  const emitThinkingCompleted = Effect.fn("emitThinkingCompleted")(function* (
    context: ClaudeSessionContext,
    input: {
      readonly itemId: string;
      readonly detail?: string;
      readonly promotedToAssistantText?: boolean;
      readonly rawMethod: string;
      readonly rawPayload: unknown;
    },
  ) {
    const turnState = context.turnState;
    if (!turnState) return;
    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "item.completed",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      turnId: turnState.turnId,
      itemId: asRuntimeItemId(input.itemId),
      payload: {
        itemType: "reasoning",
        status: "completed",
        ...(input.detail !== undefined ? { detail: input.detail } : {}),
        ...(input.promotedToAssistantText ? { data: { promotedToAssistantText: true } } : {}),
      },
      providerRefs: nativeProviderRefs(),
      raw: {
        source: "claude.sdk.message",
        method: input.rawMethod,
        payload: input.rawPayload,
      },
    });
  });

  /** `snapshotTextBlocks` is a prefix of the message's text, so a later call for the rest is safe. */
  const backfillAssistantTextBlocksFromSnapshot = Effect.fn(
    "backfillAssistantTextBlocksFromSnapshot",
  )(function* (
    context: ClaudeSessionContext,
    snapshotTextBlocks: ReadonlyArray<string>,
    rawPayload: unknown,
  ) {
    const turnState = context.turnState;
    if (!turnState) {
      return;
    }

    if (snapshotTextBlocks.length === 0) {
      return;
    }

    const orderedBlocks = turnState.assistantTextBlockOrder.map((block) => ({
      blockIndex: block.blockIndex,
      block,
    }));

    for (const [position, text] of snapshotTextBlocks.entries()) {
      const existingEntry = orderedBlocks[position];
      const entry =
        existingEntry ??
        (yield* createSyntheticAssistantTextBlock(context, text).pipe(
          Effect.map((created) => {
            if (!created) {
              return undefined;
            }
            orderedBlocks.push(created);
            return created;
          }),
        ));
      if (!entry) {
        continue;
      }

      if (entry.block.fallbackText.length === 0) {
        entry.block.fallbackText = text;
      }

      if (entry.block.streamClosed && !entry.block.completionEmitted) {
        yield* completeAssistantTextBlock(context, entry.block, {
          rawMethod: "claude/assistant",
          rawPayload,
        });
      }
    }
  });

  /** A tool call starts: on 5.1+, the second of two thinking blocks right before it is the update Claude wrote. */
  const promoteThinkingUpdate = Effect.fn("promoteThinkingUpdate")(function* (
    context: ClaudeSessionContext,
    input: {
      readonly messageId: string | undefined;
      readonly model: string | undefined;
      /** Snapshot text ahead of this tool call that has not necessarily been emitted yet. */
      readonly precedingText?: ReadonlyArray<string>;
      readonly rawMethod: string;
      readonly rawPayload: unknown;
    },
  ) {
    const turnState = context.turnState;
    const update = turnState?.lastThinking;
    if (!turnState || !update) return;
    turnState.lastThinking = undefined;
    if (
      update.messageId !== input.messageId ||
      !update.followsThinking ||
      input.model === undefined ||
      !claudeWritesUpdatesAsThinking(input.model)
    ) {
      return;
    }
    yield* backfillAssistantTextBlocksFromSnapshot(
      context,
      input.precedingText ?? [],
      input.rawPayload,
    );
    yield* emitThinkingCompleted(context, {
      itemId: update.itemId,
      detail: update.text,
      promotedToAssistantText: true,
      rawMethod: input.rawMethod,
      rawPayload: input.rawPayload,
    });
    // Not registered as a block: the snapshot text backfill aligns registered blocks by position.
    yield* completeAssistantTextBlock(
      context,
      {
        itemId: `${update.itemId}:update`,
        blockIndex: turnState.nextSyntheticAssistantBlockIndex,
        emittedTextDelta: false,
        fallbackText: update.text,
        streamClosed: true,
        completionEmitted: false,
      },
      { rawMethod: input.rawMethod, rawPayload: input.rawPayload },
    );
  });

  /** A root message's thinking that never streamed; the CLI may send one snapshot per block or repeat them. */
  const backfillThinkingFromSnapshot = Effect.fn("backfillThinkingFromSnapshot")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    const turnState = context.turnState;
    if (!turnState || message.type !== "assistant" || isSubagentMessage(message)) return;
    const snapshot = message.message as
      | { readonly id?: unknown; readonly model?: unknown; readonly content?: unknown }
      | undefined;
    const messageId = snapshot?.id;
    if (typeof messageId !== "string") return;
    const state = thinkingStateForMessage(turnState, messageId);
    const blocks: ReadonlyArray<unknown> = Array.isArray(snapshot?.content) ? snapshot.content : [];
    // One snapshot per block or cumulative repeats: identity, not position, tells a replay apart.
    const isNewBlock = (key: string) => {
      if (state.snapshotBlockKeys.has(key)) return false;
      state.snapshotBlockKeys.add(key);
      return true;
    };
    for (const [position, block] of blocks.entries()) {
      const { type, thinking, id } = (block ?? {}) as {
        readonly type?: unknown;
        readonly thinking?: unknown;
        readonly id?: unknown;
      };
      if (type === "thinking") {
        const text = typeof thinking === "string" ? thinking : "";
        if (text.trim().length === 0) {
          if (!state.streamStarted && isNewBlock(JSON.stringify(block))) {
            turnState.lastThinking = undefined;
          }
          continue;
        }
        if (state.snapshotTexts.has(text)) continue;
        const ordinal = state.snapshotTexts.size;
        state.snapshotTexts.add(text);
        if (ordinal < state.streamedBlocks) continue;
        const itemId = `${messageId}:thinking:${ordinal}`;
        yield* emitThinkingCompleted(context, {
          itemId,
          detail: text,
          rawMethod: "claude/assistant",
          rawPayload: message,
        });
        if (!state.streamStarted) noteThinkingBlock(turnState, { messageId, itemId, text });
        continue;
      }
      if (state.streamStarted) continue;
      if (type === "tool_use" || type === "server_tool_use" || type === "mcp_tool_use") {
        if (typeof id === "string" && !isNewBlock(id)) continue;
        yield* promoteThinkingUpdate(context, {
          messageId,
          model: typeof snapshot?.model === "string" ? snapshot.model : undefined,
          precedingText: extractAssistantTextBlocks(message, position),
          rawMethod: "claude/assistant",
          rawPayload: message,
        });
        continue;
      }
      if (isNewBlock(JSON.stringify(block))) turnState.lastThinking = undefined;
    }
  });

  const ensureThreadId = Effect.fn("ensureThreadId")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    if (typeof message.session_id !== "string" || message.session_id.length === 0) {
      return;
    }
    const nextThreadId = message.session_id;
    context.resumeSessionId = message.session_id;
    yield* updateResumeCursor(context);

    if (context.lastThreadStartedId !== nextThreadId) {
      context.lastThreadStartedId = nextThreadId;
      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "thread.started",
        eventId: stamp.eventId,
        provider: PROVIDER,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        payload: {
          providerThreadId: nextThreadId,
        },
        providerRefs: {},
        raw: {
          source: "claude.sdk.message",
          method: "claude/thread/started",
          payload: {
            session_id: message.session_id,
          },
        },
      });
    }
  });

  const emitRuntimeError = Effect.fn("emitRuntimeError")(function* (
    context: ClaudeSessionContext,
    message: string,
    cause?: unknown,
  ) {
    if (cause !== undefined) {
      void cause;
    }
    const turnState = context.turnState;
    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "runtime.error",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      ...(turnState ? { turnId: asCanonicalTurnId(turnState.turnId) } : {}),
      payload: {
        message,
        class: "provider_error",
        ...(cause !== undefined ? { detail: cause } : {}),
      },
      providerRefs: nativeProviderRefs(),
    });
  });

  const emitRuntimeWarning = Effect.fn("emitRuntimeWarning")(function* (
    context: ClaudeSessionContext,
    message: string,
    detail?: unknown,
  ) {
    const turnState = context.turnState;
    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "runtime.warning",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      ...(turnState ? { turnId: asCanonicalTurnId(turnState.turnId) } : {}),
      payload: {
        message,
        ...(detail !== undefined ? { detail } : {}),
      },
      providerRefs: nativeProviderRefs(),
    });
  });

  const emitTodoPlanUpdated = Effect.fn("emitTodoPlanUpdated")(function* (
    context: ClaudeSessionContext,
    input: {
      readonly toolName: string;
      readonly toolUseId: string | undefined;
      readonly toolInput: unknown;
      readonly rawMethod: string;
      readonly rawPayload: unknown;
    },
  ) {
    const turnState = context.turnState;
    if (!turnState || !isTodoTool(input.toolName)) {
      return;
    }
    const plan = extractPlanStepsFromTodoInput(input.toolInput);
    if (!plan) {
      return;
    }
    // Streamed input and the final assistant frame carry the same todos; emit once per input.
    const captureKey = `${input.toolUseId ?? ""}:${JSON.stringify(plan)}`;
    if (turnState.capturedTodoPlanKeys.has(captureKey)) {
      return;
    }
    turnState.capturedTodoPlanKeys.add(captureKey);

    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "turn.plan.updated",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      turnId: turnState.turnId,
      payload: { plan },
      providerRefs: nativeProviderRefs({ providerItemId: input.toolUseId }),
      raw: {
        source: "claude.sdk.message",
        method: input.rawMethod,
        payload: input.rawPayload,
      },
    });
  });

  const emitProposedPlanCompleted = Effect.fn("emitProposedPlanCompleted")(function* (
    context: ClaudeSessionContext,
    input: {
      readonly planMarkdown: string;
      readonly toolUseId?: string | undefined;
      readonly rawSource: "claude.sdk.message" | "claude.sdk.permission";
      readonly rawMethod: string;
      readonly rawPayload: unknown;
    },
  ) {
    const turnState = context.turnState;
    const planMarkdown = input.planMarkdown.trim();
    if (!turnState || planMarkdown.length === 0) {
      return;
    }

    const captureKey = exitPlanCaptureKey({
      toolUseId: input.toolUseId,
      planMarkdown,
    });
    if (turnState.capturedProposedPlanKeys.has(captureKey)) {
      return;
    }
    turnState.capturedProposedPlanKeys.add(captureKey);

    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "turn.proposed.completed",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      turnId: turnState.turnId,
      payload: {
        planMarkdown,
      },
      providerRefs: nativeProviderRefs({
        providerItemId: input.toolUseId,
      }),
      raw: {
        source: input.rawSource,
        method: input.rawMethod,
        payload: input.rawPayload,
      },
    });
  });

  /** Live context-window update from the latest root request, deduped and throttled per session. */
  const emitLiveContextUsage = Effect.fn("emitLiveContextUsage")(function* (
    context: ClaudeSessionContext,
    messageId: string,
    usage: Record<string, unknown>,
  ) {
    const snapshot = claudeRequestContextUsage(usage, context.lastKnownContextWindow);
    if (!snapshot) return;
    context.lastKnownTokenUsage = snapshot;
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const previous = context.lastLiveContextUsage;
    // completeTurn reports the final size, so skipped updates are never the last word.
    if (
      previous &&
      (previous.usedTokens === snapshot.usedTokens ||
        nowMs - previous.atMs < LIVE_CONTEXT_USAGE_THROTTLE_MS)
    ) {
      return;
    }
    context.lastLiveContextUsage = { messageId, usedTokens: snapshot.usedTokens, atMs: nowMs };
    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "thread.token-usage.updated",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
      payload: { usage: snapshot },
      providerRefs: nativeProviderRefs(),
    });
  });

  const trackRootStreamUsage = Effect.fn("trackRootStreamUsage")(function* (
    context: ClaudeSessionContext,
    event: { readonly type: string; readonly message?: unknown; readonly usage?: unknown },
  ) {
    if (event.type === "message_start") {
      const startMessage = event.message as { id?: unknown; usage?: unknown } | undefined;
      const messageId = typeof startMessage?.id === "string" ? startMessage.id : undefined;
      const usage = asUsageRecord(startMessage?.usage);
      if (!messageId || !usage) {
        // A new request without usage must not inherit the previous request's deltas.
        context.rootRequestUsage = undefined;
        return;
      }
      context.rootRequestUsage = { messageId, usage };
      if (claudeUsageInputTokens(usage) > 0) context.contextUsageStale = false;
      yield* emitLiveContextUsage(context, messageId, usage);
      return;
    }
    const delta = asUsageRecord(event.usage);
    const tracked = context.rootRequestUsage;
    if (!delta || !tracked?.usage) return;
    // Only merged: the next message_start or completeTurn reports it, keeping one live update per request.
    tracked.usage = mergeClaudeStreamUsage(tracked.usage, delta);
  });

  // Assistant snapshots repeat message_start usage (some proxies send zeros there), so they only
  // start tracking a request the stream missed or fill in input the stream has not reported.
  const trackRootAssistantSnapshotUsage = Effect.fn("trackRootAssistantSnapshotUsage")(function* (
    context: ClaudeSessionContext,
    assistantMessage: unknown,
  ) {
    const record = assistantMessage as
      | { id?: unknown; model?: unknown; usage?: unknown }
      | undefined;
    if (record?.model === "<synthetic>" || typeof record?.id !== "string") return;
    const usage = asUsageRecord(record.usage);
    if (!usage) return;
    const tracked = context.rootRequestUsage;
    if (!tracked || tracked.messageId !== record.id) {
      context.rootRequestUsage = { messageId: record.id, usage };
      if (claudeUsageInputTokens(usage) > 0) context.contextUsageStale = false;
      yield* emitLiveContextUsage(context, record.id, usage);
      return;
    }
    if (
      tracked.usage !== null &&
      claudeUsageInputTokens(tracked.usage) <= 0 &&
      claudeUsageInputTokens(usage) > 0
    ) {
      const trackedOutput = tracked.usage.output_tokens;
      const snapshotOutput = usage.output_tokens;
      tracked.usage = {
        ...usage,
        output_tokens: Math.max(
          typeof snapshotOutput === "number" ? snapshotOutput : 0,
          typeof trackedOutput === "number" ? trackedOutput : 0,
        ),
      };
      context.contextUsageStale = false;
      yield* emitLiveContextUsage(context, tracked.messageId, tracked.usage);
    }
  });

  /** Ends the running compaction item, if any; later duplicates find nothing to end. */
  const finishCompactionItem = Effect.fn("finishCompactionItem")(function* (
    context: ClaudeSessionContext,
    outcome: {
      readonly status: "completed" | "failed";
      readonly title: string;
      readonly detail?: string | undefined;
    },
    raw: { readonly method: string; readonly payload: unknown },
  ) {
    const itemId = context.runningCompactionItemId;
    if (!itemId) return;
    context.runningCompactionItemId = undefined;
    const detail = outcome.detail?.trim();
    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "item.completed",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
      itemId: asRuntimeItemId(itemId),
      payload: {
        itemType: "context_compaction",
        status: outcome.status,
        title: outcome.title,
        ...(detail ? { detail } : {}),
      },
      providerRefs: nativeProviderRefs({ providerItemId: itemId }),
      raw: { source: "claude.sdk.message", method: raw.method, payload: raw.payload },
    });
  });

  const emitApiRetryRow = Effect.fn("emitApiRetryRow")(function* (
    context: ClaudeSessionContext,
    retry: NonNullable<ClaudeTurnState["apiRetry"]>,
    state: "retrying" | ClaudeApiRetryOutcome,
  ) {
    yield* emitRuntimeWarning(
      context,
      state === "retrying"
        ? claudeApiRetryingMessage(retry)
        : claudeApiRetrySettledMessage(retry, state),
      {
        kind: CLAUDE_PROVIDER_RETRY_DETAIL_KIND,
        retryId: retry.retryId,
        state,
        attempt: retry.attempt,
        maxRetries: retry.maxRetries,
        errorStatus: retry.errorStatus,
      },
    );
  });

  const settleApiRetry = Effect.fn("settleApiRetry")(function* (
    context: ClaudeSessionContext,
    outcome: ClaudeApiRetryOutcome,
  ) {
    const retry = context.turnState?.apiRetry;
    if (!context.turnState || !retry) return;
    delete context.turnState.apiRetry;
    yield* emitApiRetryRow(context, retry, outcome);
  });

  // Waits for the tail's last read so its output lands before the call settles.
  const stopTaskOutputTail = Effect.fn("stopTaskOutputTail")(function* (
    context: ClaudeSessionContext,
    toolUseId: string,
  ) {
    const tail = context.taskOutputTails.get(toolUseId);
    if (!tail) return;
    context.taskOutputTails.delete(toolUseId);
    yield* Deferred.succeed(tail.stop, undefined);
    yield* Fiber.await(tail.fiber);
  });

  const stopAllTaskOutputTails = Effect.fn("stopAllTaskOutputTails")(function* (
    context: ClaudeSessionContext,
  ) {
    for (const toolUseId of Array.from(context.taskOutputTails.keys())) {
      yield* stopTaskOutputTail(context, toolUseId);
    }
  });

  const startTaskOutputTail = Effect.fn("startTaskOutputTail")(function* (
    context: ClaudeSessionContext,
    message: Extract<SDKMessage, { type: "system"; subtype: "task_started" }>,
  ) {
    const toolUseId = message.tool_use_id;
    const root = context.taskOutputRoot;
    const turnId = context.turnState?.turnId;
    if (
      root === undefined ||
      turnId === undefined ||
      toolUseId === undefined ||
      message.task_type !== "local_bash" ||
      // Older Claude Code builds omit the flag on foreground calls.
      message.is_backgrounded === true ||
      context.taskOutputTails.has(toolUseId)
    ) {
      return;
    }
    const tool = Array.from(context.inFlightTools.values()).find(
      (entry) => entry.itemId === toolUseId,
    );
    if (tool?.itemType !== "command_execution") return;
    const stop = yield* Deferred.make<void>();
    const fiber = yield* tailClaudeTaskOutput({
      root,
      sessionId: message.session_id,
      taskId: message.task_id,
      stop,
      onChunk: (chunk) =>
        makeEventStamp().pipe(
          Effect.flatMap((stamp) =>
            // The tool-input preview stream is ephemeral: ingestion never persists it.
            offerRuntimeEvent({
              type: "content.delta",
              eventId: stamp.eventId,
              provider: PROVIDER,
              createdAt: stamp.createdAt,
              threadId: context.session.threadId,
              turnId,
              itemId: asRuntimeItemId(tool.itemId),
              payload: {
                streamKind: "tool_input_text",
                delta: chunk,
                toolMeta: { toolName: tool.toolName, fieldName: CLAUDE_LIVE_COMMAND_OUTPUT_FIELD },
              },
              providerRefs: nativeProviderRefs({ providerItemId: tool.itemId }),
            }),
          ),
        ),
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.catchCause((cause) =>
        Effect.logDebug("claude.task_output_tail.failed", { toolUseId, cause }),
      ),
      Effect.forkDetach,
    );
    context.taskOutputTails.set(toolUseId, { fiber, stop });
  });

  const completeTurn = Effect.fn("completeTurn")(function* (
    context: ClaudeSessionContext,
    status: ProviderRuntimeTurnStatus,
    errorMessage?: string,
    result?: SDKResultMessage,
  ) {
    // Tools in flight are closed below, so their live output must land first.
    yield* stopAllTaskOutputTails(context);
    yield* settleApiRetry(
      context,
      status === "completed" ? "recovered" : status === "failed" ? "failed" : "stopped",
    );
    // A turn that ends mid-compaction never gets its boundary, so the item would spin forever.
    if (context.runningCompactionItemId) context.attachmentBudget.compactionAborted();
    yield* finishCompactionItem(
      context,
      {
        status: "failed",
        title:
          status === "completed" || status === "failed"
            ? "Context compaction failed"
            : "Context compaction stopped",
      },
      { method: "claude/result", payload: result ?? { status } },
    );
    const resultUsage =
      result?.usage && typeof result.usage === "object" ? { ...result.usage } : undefined;
    for (const [model, window] of claudeReportedContextWindows(result?.modelUsage)) {
      context.reportedContextWindows.set(model, window);
    }
    const resultContextWindow = resolveClaudeResultContextWindow(
      context.currentApiModelId ?? context.initApiModelId,
      result?.modelUsage,
    );
    if (resultContextWindow !== undefined) {
      context.lastKnownContextWindow = resultContextWindow;
    }

    // The SDK result.usage contains *accumulated* totals across all API calls
    // (input_tokens, cache_read_input_tokens, etc. summed over every request).
    // This does NOT represent the current context window size.
    // Instead, use the last known context-window-accurate usage from task_progress
    // events and treat the accumulated total as totalProcessedTokens.
    const accumulatedSnapshot = normalizeClaudeTokenUsage(
      resultUsage,
      resultContextWindow ?? context.lastKnownContextWindow,
    );
    const accumulatedTotalProcessedTokens =
      accumulatedSnapshot?.totalProcessedTokens ?? accumulatedSnapshot?.usedTokens;
    const lastGoodUsage = context.lastKnownTokenUsage;
    const maxTokens = resultContextWindow ?? context.lastKnownContextWindow;
    // The latest root request is the context size; the accumulated total is only "total processed".
    const rootRequestSnapshot = context.rootRequestUsage?.usage
      ? claudeRequestContextUsage(
          context.rootRequestUsage.usage,
          maxTokens,
          accumulatedTotalProcessedTokens,
        )
      : undefined;
    const usageSnapshot: ThreadTokenUsageSnapshot | undefined =
      rootRequestSnapshot ??
      (lastGoodUsage
        ? {
            ...lastGoodUsage,
            ...(typeof maxTokens === "number" && Number.isFinite(maxTokens) && maxTokens > 0
              ? { maxTokens }
              : {}),
            ...(accumulatedTotalProcessedTokens !== undefined &&
            accumulatedTotalProcessedTokens > lastGoodUsage.usedTokens
              ? { totalProcessedTokens: accumulatedTotalProcessedTokens }
              : {}),
          }
        : context.contextUsageStale
          ? undefined
          : accumulatedSnapshot);
    if (rootRequestSnapshot) {
      context.lastKnownTokenUsage = rootRequestSnapshot;
    }

    yield* flushPendingTaskEnds(context);

    const turnState = context.turnState;
    if (!turnState) {
      if (usageSnapshot) {
        const usageStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "thread.token-usage.updated",
          eventId: usageStamp.eventId,
          provider: PROVIDER,
          createdAt: usageStamp.createdAt,
          threadId: context.session.threadId,
          payload: {
            usage: usageSnapshot,
          },
          providerRefs: {},
        });
      }

      // No local turn means this is the resume handshake (result with num_turns 0),
      // a late result for a turn already completed, or a stream failure with no
      // turn in flight. A turnId-less turn.completed would stomp a pending turn start.
      yield* Effect.logDebug("claude.turn.result-without-active-turn", {
        threadId: context.session.threadId,
        status,
        numTurns: result?.num_turns,
        ...(errorMessage ? { errorMessage } : {}),
      });
      return;
    }

    for (const [index, tool] of context.inFlightTools.entries()) {
      const toolStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "item.completed",
        eventId: toolStamp.eventId,
        provider: PROVIDER,
        createdAt: toolStamp.createdAt,
        threadId: context.session.threadId,
        turnId: turnState.turnId,
        itemId: asRuntimeItemId(tool.itemId),
        payload: {
          itemType: tool.itemType,
          status: turnState.interruptRequested ? "stopped" : claudeOpenToolStatusForTurn(status),
          title: tool.title,
          ...(tool.detail ? { detail: tool.detail } : {}),
          data: {
            toolName: tool.toolName,
            input: tool.input,
          },
        },
        providerRefs: nativeProviderRefs({ providerItemId: tool.itemId }),
        raw: {
          source: "claude.sdk.message",
          method: "claude/result",
          payload: result ?? { status },
        },
      });
      context.inFlightTools.delete(index);
    }
    // Clear any remaining stale entries (e.g. from interrupted content blocks)
    context.inFlightTools.clear();

    for (const block of turnState.assistantTextBlockOrder) {
      yield* completeAssistantTextBlock(context, block, {
        force: true,
        rawMethod: "claude/result",
        rawPayload: result ?? { status },
      });
    }

    context.turns.push({ id: turnState.turnId });
    context.turnEndMessageIds.push(turnState.lastRootEntryUuid ?? null);

    if (usageSnapshot) {
      const usageStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "thread.token-usage.updated",
        eventId: usageStamp.eventId,
        provider: PROVIDER,
        createdAt: usageStamp.createdAt,
        threadId: context.session.threadId,
        turnId: turnState.turnId,
        payload: {
          usage: usageSnapshot,
        },
        providerRefs: nativeProviderRefs(),
      });
    }

    if (
      claudeGoalMetByTurn({
        goal: context.goal,
        sawModelOutput: turnState.sawGoalModelOutput === true,
        turnCompleted: status === "completed",
        result,
        liveBackgroundWork: claudeGoalDeferringWorkCount({
          liveTaskIds: context.liveTaskIds,
          backgroundRoster: context.backgroundRoster,
          taskTypes: context.taskTypes,
        }),
      }) &&
      context.goal
    ) {
      const { lastCheck: _lastCheck, ...goal } = context.goal;
      yield* setClaudeGoal(context, { ...goal, status: "complete" });
    }

    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "turn.completed",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      turnId: turnState.turnId,
      payload: {
        state: status,
        ...(result?.stop_reason !== undefined ? { stopReason: result.stop_reason } : {}),
        ...(result?.usage ? { usage: result.usage } : {}),
        ...(result?.modelUsage ? { modelUsage: result.modelUsage } : {}),
        ...(typeof result?.total_cost_usd === "number"
          ? { totalCostUsd: result.total_cost_usd }
          : {}),
        ...(errorMessage ? { errorMessage } : {}),
        ...claudeRateLimitCompletionFields({
          status,
          rejectedRateLimitTypes: turnState.rejectedRateLimitTypes,
          latestAssistantRateLimited: turnState.latestAssistantRateLimited,
          assistantRateLimitWindow: turnState.latestAssistantRateLimitWindow,
          authenticationFailed: turnState.authenticationFailed,
          result,
        }),
      },
      providerRefs: nativeProviderRefs(),
    });

    const updatedAt = yield* nowIso;
    context.turnState = undefined;
    context.interruptAckTimedOut = false;
    if (context.interruptedTurnSettled) {
      yield* Deferred.succeed(context.interruptedTurnSettled, undefined);
      context.interruptedTurnSettled = undefined;
    }
    context.session = {
      ...context.session,
      status: "ready",
      activeTurnId: undefined,
      updatedAt,
      ...(status === "failed" && errorMessage ? { lastError: errorMessage } : {}),
    };
    yield* updateResumeCursor(context);
  });

  const handleStreamEvent = Effect.fn("handleStreamEvent")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    if (message.type !== "stream_event") {
      return;
    }

    const { event } = message;

    if (event.type === "message_start" || event.type === "message_delta") {
      if (!isSubagentMessage(message)) {
        yield* trackRootStreamUsage(context, event);
        if (event.type === "message_start" && context.turnState) {
          const streamMessageId = (event.message as { readonly id?: unknown } | undefined)?.id;
          if (typeof streamMessageId === "string") {
            context.turnState.rootStreamMessageId = streamMessageId;
            thinkingStateForMessage(context.turnState, streamMessageId).streamStarted = true;
          }
          const streamModel = (event.message as { readonly model?: unknown } | undefined)?.model;
          context.turnState.rootStreamModel =
            typeof streamModel === "string" ? streamModel : undefined;
          context.turnState.lastThinking = undefined;
          context.turnState.openThinkingBlocks.clear();
          context.turnState.openThinkingText.clear();
          context.turnState.rootStreamOpen = true;
        }
      }
    }

    if (event.type === "message_stop" && !isSubagentMessage(message) && context.turnState) {
      context.turnState.rootStreamOpen = false;
    }

    if (event.type === "content_block_delta") {
      // A subagent's reasoning is private to it, and its block indexes are not the root's.
      if (event.delta.type === "thinking_delta" && isSubagentMessage(message)) {
        return;
      }
      if (
        (event.delta.type === "text_delta" || event.delta.type === "thinking_delta") &&
        context.turnState
      ) {
        const deltaText =
          event.delta.type === "text_delta"
            ? event.delta.text
            : typeof event.delta.thinking === "string"
              ? event.delta.thinking
              : "";
        if (deltaText.length === 0) {
          return;
        }
        const streamKind = streamKindFromDeltaType(event.delta.type);
        const assistantBlockEntry =
          event.delta.type === "text_delta"
            ? yield* ensureAssistantTextBlock(context, event.index)
            : undefined;
        if (assistantBlockEntry?.block) {
          assistantBlockEntry.block.emittedTextDelta = true;
        }
        const deltaItemId =
          event.delta.type === "thinking_delta"
            ? streamedThinkingItemId(context.turnState, event.index)
            : assistantBlockEntry?.block.itemId;
        if (event.delta.type === "thinking_delta") {
          context.turnState.openThinkingText.set(
            event.index,
            `${context.turnState.openThinkingText.get(event.index) ?? ""}${deltaText}`,
          );
        }
        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "content.delta",
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.session.threadId,
          turnId: context.turnState.turnId,
          ...(deltaItemId ? { itemId: asRuntimeItemId(deltaItemId) } : {}),
          payload: {
            streamKind,
            delta: deltaText,
          },
          providerRefs: nativeProviderRefs(),
          raw: {
            source: "claude.sdk.message",
            method: "claude/stream_event/content_block_delta",
            payload: message,
          },
        });
        return;
      }

      if (event.delta.type === "input_json_delta") {
        const tool = context.inFlightTools.get(event.index);
        if (!tool || typeof event.delta.partial_json !== "string") {
          return;
        }

        const parts = tool.partialInputJsonParts;
        parts.push(event.delta.partial_json);
        const partialInputJson = parts.join("");
        const parsedInput = tryParseJsonRecord(partialInputJson);
        const detail = parsedInput ? summarizeToolRequest(tool.toolName, parsedInput) : tool.detail;
        let nextTool: ToolInFlight = {
          ...tool,
          partialInputJsonParts: parts,
          ...(parsedInput ? { input: parsedInput } : {}),
          ...(detail ? { detail } : {}),
        };

        const nextFingerprint =
          parsedInput && Object.keys(parsedInput).length > 0
            ? toolInputFingerprint(parsedInput)
            : undefined;
        context.inFlightTools.set(event.index, nextTool);

        // Emit live tool-input preview delta. This runs on every accumulation
        // so the frontend can render the value being typed character by
        // character — independent of the fingerprint-gated `item.updated`
        // path below, which only fires when the full JSON parses cleanly.
        if (
          nextTool.streamExtractor !== undefined &&
          !nextTool.streamExtractor.done &&
          context.turnState !== undefined
        ) {
          // Refresh opportunistic hints (file_path, old_string) before
          // attempting to extract more of the target field. These run cheap
          // top-of-buffer scans and can succeed even after target streaming
          // has begun.
          nextTool.streamExtractor.refreshOpportunisticHints(partialInputJson);
          const previewDelta = nextTool.streamExtractor.update(partialInputJson);
          if (previewDelta !== null && previewDelta.length > 0) {
            const previewStamp = yield* makeEventStamp();
            yield* offerRuntimeEvent({
              type: "content.delta",
              eventId: previewStamp.eventId,
              provider: PROVIDER,
              createdAt: previewStamp.createdAt,
              threadId: context.session.threadId,
              turnId: context.turnState.turnId,
              itemId: asRuntimeItemId(nextTool.itemId),
              payload: {
                streamKind: "tool_input_text",
                delta: previewDelta,
                toolMeta: {
                  toolName: nextTool.toolName,
                  fieldName: nextTool.streamExtractor.targetField,
                  ...(nextTool.streamExtractor.filePath
                    ? { filePath: nextTool.streamExtractor.filePath }
                    : {}),
                  ...(nextTool.streamExtractor.oldString !== undefined
                    ? { oldString: nextTool.streamExtractor.oldString }
                    : {}),
                },
              },
              providerRefs: nativeProviderRefs({ providerItemId: nextTool.itemId }),
            });
          }
        }

        if (
          !parsedInput ||
          !nextFingerprint ||
          tool.lastEmittedInputFingerprint === nextFingerprint
        ) {
          return;
        }

        nextTool = {
          ...nextTool,
          lastEmittedInputFingerprint: nextFingerprint,
        };
        context.inFlightTools.set(event.index, nextTool);

        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "item.updated",
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.session.threadId,
          ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
          itemId: asRuntimeItemId(nextTool.itemId),
          payload: {
            itemType: nextTool.itemType,
            status: "inProgress",
            title: nextTool.title,
            ...(nextTool.detail ? { detail: nextTool.detail } : {}),
            data: {
              toolName: nextTool.toolName,
              input: nextTool.input,
            },
          },
          providerRefs: nativeProviderRefs({ providerItemId: nextTool.itemId }),
          raw: {
            source: "claude.sdk.message",
            method: "claude/stream_event/content_block_delta/input_json_delta",
            payload: message,
          },
        });
        if (!isSubagentMessage(message)) {
          yield* emitTodoPlanUpdated(context, {
            toolName: nextTool.toolName,
            toolUseId: nextTool.itemId,
            toolInput: parsedInput,
            rawMethod: "claude/stream_event/content_block_delta/input_json_delta",
            rawPayload: message,
          });
        }
      }
      return;
    }

    if (event.type === "content_block_start") {
      const { index, content_block: block } = event;
      const rootTurnState = isSubagentMessage(message) ? undefined : context.turnState;
      if (block.type === "thinking") {
        rootTurnState?.openThinkingText.set(index, "");
        return;
      }
      if (block.type === "text") {
        if (rootTurnState) rootTurnState.lastThinking = undefined;
        yield* ensureAssistantTextBlock(context, index, {
          fallbackText: extractContentBlockText(block),
        });
        return;
      }
      if (
        block.type !== "tool_use" &&
        block.type !== "server_tool_use" &&
        block.type !== "mcp_tool_use"
      ) {
        if (rootTurnState) rootTurnState.lastThinking = undefined;
        return;
      }
      if (rootTurnState) {
        yield* promoteThinkingUpdate(context, {
          messageId: rootTurnState.rootStreamMessageId,
          model: rootTurnState.rootStreamModel,
          rawMethod: "claude/stream_event/content_block_start",
          rawPayload: message,
        });
      }

      const toolName = block.name;
      const itemType = classifyToolItemType(toolName);
      const toolInput =
        typeof block.input === "object" && block.input !== null
          ? (block.input as Record<string, unknown>)
          : {};
      const itemId = block.id;
      const detail = summarizeToolRequest(toolName, toolInput);
      const inputFingerprint =
        Object.keys(toolInput).length > 0 ? toolInputFingerprint(toolInput) : undefined;
      const streamFieldName = toolInputStreamField(toolName);
      const streamExtractor = streamFieldName
        ? new ToolInputStreamExtractor(streamFieldName)
        : undefined;

      const tool: ToolInFlight = {
        itemId,
        itemType,
        toolName,
        parentToolUseId: parentToolUseIdFromMessage(message),
        title: titleForTool(itemType, toolName),
        detail,
        input: toolInput,
        partialInputJsonParts: [],
        ...(inputFingerprint ? { lastEmittedInputFingerprint: inputFingerprint } : {}),
        streamExtractor,
      };
      context.inFlightTools.set(index, tool);

      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "item.started",
        eventId: stamp.eventId,
        provider: PROVIDER,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
        itemId: asRuntimeItemId(tool.itemId),
        payload: {
          itemType: tool.itemType,
          status: "inProgress",
          title: tool.title,
          ...(tool.detail ? { detail: tool.detail } : {}),
          data: {
            toolName: tool.toolName,
            input: toolInput,
          },
        },
        providerRefs: nativeProviderRefs({ providerItemId: tool.itemId }),
        raw: {
          source: "claude.sdk.message",
          method: "claude/stream_event/content_block_start",
          payload: message,
        },
      });
      return;
    }

    if (event.type === "content_block_stop") {
      const { index } = event;
      const rootTurnState = isSubagentMessage(message) ? undefined : context.turnState;
      const thinkingItemId = rootTurnState?.openThinkingBlocks.get(index);
      const thinkingText = rootTurnState?.openThinkingText.get(index);
      if (rootTurnState && thinkingText !== undefined) {
        rootTurnState.openThinkingText.delete(index);
        noteThinkingBlock(rootTurnState, {
          messageId: rootTurnState.rootStreamMessageId ?? String(rootTurnState.turnId),
          ...(thinkingItemId !== undefined ? { itemId: thinkingItemId } : {}),
          text: thinkingText,
        });
      }
      if (thinkingItemId !== undefined) {
        context.turnState?.openThinkingBlocks.delete(index);
        yield* emitThinkingCompleted(context, {
          itemId: thinkingItemId,
          rawMethod: "claude/stream_event/content_block_stop",
          rawPayload: message,
        });
        return;
      }
      const assistantBlock = context.turnState?.assistantTextBlocks.get(index);
      if (assistantBlock) {
        assistantBlock.streamClosed = true;
        yield* completeAssistantTextBlock(context, assistantBlock, {
          rawMethod: "claude/stream_event/content_block_stop",
          rawPayload: message,
        });
        return;
      }
      const tool = context.inFlightTools.get(index);
      if (!tool) {
        return;
      }
    }
  });

  /** Applies finished Task tool calls (root or subagent) to the session task map and emits the merged plan. */
  const applyTaskToolResults = Effect.fn("applyTaskToolResults")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
    toolResults: ReturnType<typeof toolResultBlocksFromUserMessage>,
  ) {
    // The structured result describes the message's only tool result; subagents get text only.
    const structuredResult =
      toolResults.length === 1
        ? (message as { tool_use_result?: unknown }).tool_use_result
        : undefined;
    let changed = false;
    let lastToolUseId: string | undefined;
    if (
      !context.claudeTasksLoaded &&
      toolResults.some((toolResult) => {
        const call = context.pendingTaskToolCalls.get(toolResult.toolUseId);
        return call !== undefined && call.toolName !== "TaskList" && !toolResult.isError;
      })
    ) {
      // After a restart the map starts empty; earlier tasks live only in Claude's store.
      context.claudeTasksLoaded = true;
      const stored = context.resumeSessionId
        ? yield* readClaudeTaskStore(
            fileSystem,
            claudeTaskStoreDirectory({
              env:
                context.claudeConfigDir !== undefined
                  ? { ...process.env, CLAUDE_CONFIG_DIR: context.claudeConfigDir }
                  : process.env,
              homeDir: OS.homedir(),
              cwd: context.session.cwd,
              sessionId: context.resumeSessionId,
            }),
          )
        : undefined;
      if (stored && stored.size > 0) {
        context.claudeTasks.clear();
        for (const [id, task] of stored) context.claudeTasks.set(id, task);
        changed = true;
      }
    }
    for (const toolResult of toolResults) {
      const call = context.pendingTaskToolCalls.get(toolResult.toolUseId);
      if (!call) continue;
      context.pendingTaskToolCalls.delete(toolResult.toolUseId);
      if (toolResult.isError) continue;
      const result =
        structuredResult && typeof structuredResult === "object"
          ? structuredResult
          : toolResult.text;
      if (call.toolName === "TaskList") context.claudeTasksLoaded = true;
      if (applyClaudeTaskToolResult(context.claudeTasks, call.toolName, call.input, result)) {
        changed = true;
      }
      if (changed) lastToolUseId = toolResult.toolUseId;
    }
    if (!changed) return;
    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "turn.plan.updated",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
      payload: { plan: planStepsFromClaudeTasks(context.claudeTasks) },
      providerRefs: nativeProviderRefs({ providerItemId: lastToolUseId }),
      raw: {
        source: "claude.sdk.message",
        method: "claude/user",
        payload: message,
      },
    });
  });

  const handleUserMessage = Effect.fn("handleUserMessage")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    if (message.type !== "user") {
      return;
    }

    yield* trackClaudeGoal(context, message);

    if (context.turnState) {
      if (!isSubagentMessage(message) && typeof message.uuid === "string") {
        context.turnState.lastRootEntryUuid = message.uuid;
      }
    }

    const frameParent = parentToolUseIdFromMessage(message);
    // A fork's stream opens with placeholder results for its launch call and that call's siblings.
    const isForkPlaceholder = (toolUseId: string) =>
      Array.from(context.inFlightTools.values()).some(
        (tool) => tool.itemId === toolUseId && tool.parentToolUseId !== frameParent,
      );
    const toolResults = toolResultBlocksFromUserMessage(message).filter(
      (toolResult) => !isForkPlaceholder(toolResult.toolUseId),
    );
    for (const toolResult of toolResults) {
      const toolEntry = Array.from(context.inFlightTools.entries()).find(
        ([, tool]) => tool.itemId === toolResult.toolUseId,
      );
      if (!toolEntry) {
        continue;
      }

      const [index, tool] = toolEntry;
      yield* stopTaskOutputTail(context, tool.itemId);
      if (isClaudeTaskTool(tool.toolName) && !context.pendingTaskToolCalls.has(tool.itemId)) {
        context.pendingTaskToolCalls.set(tool.itemId, {
          toolName: tool.toolName,
          input: tool.input,
        });
      }
      // Claude answers a stopped call with a synthetic error result before the turn ends.
      const stopped = toolResult.isError && context.turnState?.interruptRequested === true;
      const itemStatus = stopped ? "stopped" : toolResult.isError ? "failed" : "completed";
      const toolData = {
        toolName: tool.toolName,
        input: tool.input,
        result: sanitizeToolResultForPersistence(toolResult.block),
      };

      const updatedStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "item.updated",
        eventId: updatedStamp.eventId,
        provider: PROVIDER,
        createdAt: updatedStamp.createdAt,
        threadId: context.session.threadId,
        ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
        itemId: asRuntimeItemId(tool.itemId),
        payload: {
          itemType: tool.itemType,
          status: stopped ? "stopped" : toolResult.isError ? "failed" : "inProgress",
          title: tool.title,
          ...(tool.detail ? { detail: tool.detail } : {}),
          data: toolData,
        },
        providerRefs: nativeProviderRefs({ providerItemId: tool.itemId }),
        raw: {
          source: "claude.sdk.message",
          method: "claude/user",
          payload: message,
        },
      });

      const streamKind = toolResultStreamKind(tool.itemType);
      if (streamKind && toolResult.text.length > 0 && context.turnState) {
        const deltaStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "content.delta",
          eventId: deltaStamp.eventId,
          provider: PROVIDER,
          createdAt: deltaStamp.createdAt,
          threadId: context.session.threadId,
          turnId: context.turnState.turnId,
          itemId: asRuntimeItemId(tool.itemId),
          payload: {
            streamKind,
            delta: toolResult.text,
          },
          providerRefs: nativeProviderRefs({ providerItemId: tool.itemId }),
          raw: {
            source: "claude.sdk.message",
            method: "claude/user",
            payload: message,
          },
        });
      }

      const completedStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "item.completed",
        eventId: completedStamp.eventId,
        provider: PROVIDER,
        createdAt: completedStamp.createdAt,
        threadId: context.session.threadId,
        ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
        itemId: asRuntimeItemId(tool.itemId),
        payload: {
          itemType: tool.itemType,
          status: itemStatus,
          title: tool.title,
          ...(tool.detail ? { detail: tool.detail } : {}),
          data: toolData,
        },
        providerRefs: nativeProviderRefs({ providerItemId: tool.itemId }),
        raw: {
          source: "claude.sdk.message",
          method: "claude/user",
          payload: message,
        },
      });

      context.inFlightTools.delete(index);
    }

    yield* applyTaskToolResults(context, message, toolResults);
  });

  const handleAssistantMessage = Effect.fn("handleAssistantMessage")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    if (message.type !== "assistant") {
      return;
    }

    const goalAcknowledgement = isClaudeGoalAcknowledgement(message);

    // Auto-start a synthetic turn for assistant messages that arrive without
    // an active turn (e.g., background agent/subagent responses between user prompts).
    if (!context.turnState && !goalAcknowledgement) {
      const turnId = TurnId.makeUnsafe(yield* Random.nextUUIDv4);
      const startedAt = yield* nowIso;
      context.turnState = {
        turnId,
        startedAt,
        synthetic: true,
        assistantTextBlocks: new Map(),
        assistantTextBlockOrder: [],
        capturedProposedPlanKeys: new Set(),
        capturedTodoPlanKeys: new Set(),
        nextSyntheticAssistantBlockIndex: -1,
        authenticationFailed: false,
        rejectedRateLimitTypes: new Map(),
        announcedUsageLimitKeys: new Set(),
        latestAssistantRateLimited: false,
        latestAssistantRateLimitWindow: undefined,
        openThinkingBlocks: new Map(),
        openThinkingText: new Map(),
        thinkingByMessage: new Map(),
      };
      context.session = {
        ...context.session,
        status: "running",
        activeTurnId: turnId,
        updatedAt: startedAt,
      };
      const turnStartedStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "turn.started",
        eventId: turnStartedStamp.eventId,
        provider: PROVIDER,
        createdAt: turnStartedStamp.createdAt,
        threadId: context.session.threadId,
        turnId,
        payload: {},
        providerRefs: {
          ...nativeProviderRefs(),
          providerTurnId: turnId,
        },
        raw: {
          source: "claude.sdk.message",
          method: "claude/synthetic-turn-start",
          payload: {},
        },
      });
    }

    yield* trackClaudeGoal(context, message);
    // Ahead of the frame's tool calls, so a promoted update reads before what it announces.
    yield* backfillThinkingFromSnapshot(context, message);

    const content = message.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== "object") {
          continue;
        }
        const toolUse = block as {
          type?: unknown;
          id?: unknown;
          name?: unknown;
          input?: unknown;
        };
        if (toolUse.type !== "tool_use") {
          continue;
        }
        if (
          typeof toolUse.name === "string" &&
          typeof toolUse.id === "string" &&
          isClaudeTaskTool(toolUse.name)
        ) {
          context.pendingTaskToolCalls.set(toolUse.id, {
            toolName: toolUse.name,
            input: toolUse.input,
          });
          continue;
        }
        if (typeof toolUse.name === "string" && isTodoTool(toolUse.name)) {
          // Subagent todo lists are private; only the parent agent's list drives the plan.
          if (isSubagentMessage(message)) continue;
          yield* emitTodoPlanUpdated(context, {
            toolName: toolUse.name,
            toolUseId: typeof toolUse.id === "string" ? toolUse.id : undefined,
            toolInput: toolUse.input,
            rawMethod: "claude/assistant",
            rawPayload: message,
          });
          continue;
        }
        if (toolUse.name !== "ExitPlanMode") {
          continue;
        }
        const planMarkdown = extractExitPlanModePlan(toolUse.input);
        if (!planMarkdown) {
          continue;
        }
        yield* emitProposedPlanCompleted(context, {
          planMarkdown,
          toolUseId: typeof toolUse.id === "string" ? toolUse.id : undefined,
          rawSource: "claude.sdk.message",
          rawMethod: "claude/assistant",
          rawPayload: message,
        });
      }
    }

    if (context.turnState) {
      // Retried limited requests may only carry an assistant error; later parent responses replace it.
      if (!isSubagentMessage(message)) {
        context.turnState.latestAssistantRateLimited = message.error === "rate_limit";
        context.turnState.latestAssistantRateLimitWindow =
          message.error === "rate_limit" ? readAssistantRateLimitWindow(message) : undefined;
        if (message.error === "authentication_failed") {
          context.turnState.authenticationFailed = true;
        }
      }
      // The goal row shows this change, so the CLI's confirmation stays out of the conversation.
      if (!goalAcknowledgement) {
        yield* backfillAssistantTextBlocksFromSnapshot(
          context,
          extractAssistantTextBlocks(message),
          message,
        );
      }
    }

    if (!isSubagentMessage(message)) {
      if (context.turnState) context.turnState.lastRootEntryUuid = message.uuid;
      context.pendingRewindAt = undefined;
      yield* trackRootAssistantSnapshotUsage(context, message.message);
      // Subagent uuids are not in the main transcript, so resuming at one fails.
      context.lastAssistantUuid = message.uuid;
      yield* updateResumeCursor(context);
    }
  });

  const handleResultMessage = Effect.fn("handleResultMessage")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    if (message.type !== "result") {
      return;
    }

    const turn = context.turnState;
    if (turn && isClaudeResultForOtherTurn(message, turn)) {
      // Completing here would end the user's turn before its prompt ran.
      yield* Effect.logDebug("claude.turn.result-for-other-turn", {
        threadId: context.session.threadId,
        turnId: turn.turnId,
        origin: message.origin?.kind,
        numTurns: message.num_turns,
      });
      return;
    }

    // A 403 (org or model access) is not fixed by logging in again; show the CLI's own text.
    const permissionDeniedText =
      message.subtype === "success" &&
      message.api_error_status === 403 &&
      typeof message.result === "string" &&
      message.result.trim().length > 0
        ? sliceSurrogateSafe(message.result.trim(), 500)
        : undefined;
    const failureHint =
      permissionDeniedText ??
      (turn?.authenticationFailed
        ? claudeAuthFailureMessage(context.claudeConfigDir)
        : turn && (turn.rejectedRateLimitTypes.size > 0 || turn.latestAssistantRateLimited)
          ? CLAUDE_USAGE_LIMIT_FAILURE_MESSAGE
          : undefined);
    const { status, errorMessage } = resultOutcome(message, failureHint);

    if (status === "failed") {
      yield* emitRuntimeError(context, errorMessage ?? "Claude turn failed.");
    }

    yield* completeTurn(context, status, errorMessage, message);
  });

  const handleSystemMessage = Effect.fn("handleSystemMessage")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    if (message.type !== "system") {
      return;
    }

    const stamp = yield* makeEventStamp();
    const base = {
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
      providerRefs: nativeProviderRefs(),
      raw: {
        source: "claude.sdk.message" as const,
        method: sdkNativeMethod(message),
        messageType: `${message.type}:${message.subtype}`,
        payload: message,
      },
    };

    switch (message.subtype) {
      case "init":
        yield* offerRuntimeEvent({
          ...base,
          type: "session.configured",
          payload: {
            config: message as Record<string, unknown>,
          },
        });
        // A session started without a model learns it here, before the first usage update.
        context.initApiModelId = message.model;
        if (context.lastKnownContextWindow === undefined) {
          context.lastKnownContextWindow = claudeContextWindowForApiModel(message.model);
        }
        // Claude may open below the requested mode; later init frames only repeat the current one.
        if (!context.openingPermissionModeSettled) {
          context.openingPermissionModeSettled = true;
          context.livePermissionMode = message.permissionMode;
          if (context.turnState) {
            const notice = takePermissionDowngradeNotice(context);
            if (notice) yield* emitRuntimeWarning(context, notice);
          }
        }
        return;
      case "status":
        if (message.permissionMode !== undefined) {
          // Claude can change its own mode mid-session (EnterPlanMode).
          context.openingPermissionModeSettled = true;
          context.livePermissionMode = message.permissionMode;
        }
        yield* offerRuntimeEvent({
          ...base,
          type: "session.state.changed",
          payload: {
            state: message.status === "compacting" ? "waiting" : "running",
            reason: `status:${message.status ?? "active"}`,
            detail: message,
          },
        });
        if (message.status === "compacting") {
          if (context.runningCompactionItemId) return;
          context.runningCompactionItemId = message.uuid;
          context.attachmentBudget.compactionStarted();
          const startedStamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            ...base,
            eventId: startedStamp.eventId,
            createdAt: startedStamp.createdAt,
            type: "item.started",
            itemId: asRuntimeItemId(message.uuid),
            payload: {
              itemType: "context_compaction",
              status: "inProgress",
              title: "Compacting context",
            },
            providerRefs: nativeProviderRefs({ providerItemId: message.uuid }),
          });
          return;
        }
        if (message.compact_result === "failed") {
          // Surface the failure even when no "compacting" status announced it.
          context.runningCompactionItemId ??= message.uuid;
          context.attachmentBudget.compactionAborted();
          yield* finishCompactionItem(
            context,
            {
              status: "failed",
              title: "Context compaction failed",
              detail: message.compact_error,
            },
            base.raw,
          );
        } else if (message.compact_result === "success") {
          yield* finishCompactionItem(
            context,
            { status: "completed", title: "Context compacted" },
            base.raw,
          );
        } else if (message.status === null && message.permissionMode === undefined) {
          // Claude cleared "compacting" without a result, so the compaction was abandoned.
          if (context.runningCompactionItemId) context.attachmentBudget.compactionAborted();
          yield* finishCompactionItem(
            context,
            { status: "failed", title: "Context compaction stopped" },
            base.raw,
          );
        }
        return;
      case "compact_boundary": {
        context.attachmentBudget.compactionFinished({
          full:
            message.compact_metadata?.preserved_segment === undefined &&
            message.compact_metadata?.preserved_messages === undefined,
        });
        yield* finishCompactionItem(
          context,
          { status: "completed", title: "Context compacted" },
          base.raw,
        );
        if (context.rootRequestUsage) context.rootRequestUsage.usage = null;
        context.contextUsageStale = true;
        context.lastLiveContextUsage = undefined;
        // Claude resumes only from the compacted chain, so only the messages it kept can be rewound to.
        const preservedIds = claudeCompactPreservedMessageIds(message);
        context.turnEndMessageIds.forEach((id, index) => {
          if (id !== null && !preservedIds.has(id)) context.turnEndMessageIds[index] = null;
        });
        const lastRootEntryUuid = context.turnState?.lastRootEntryUuid;
        if (context.turnState && lastRootEntryUuid && !preservedIds.has(lastRootEntryUuid)) {
          delete context.turnState.lastRootEntryUuid;
        }
        yield* updateResumeCursor(context);
        const compactedUsage = claudeCompactBoundaryContextUsage(
          message,
          context.lastKnownContextWindow,
        );
        context.lastKnownTokenUsage = compactedUsage;
        if (compactedUsage) {
          const usageStamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            ...base,
            eventId: usageStamp.eventId,
            createdAt: usageStamp.createdAt,
            type: "thread.token-usage.updated",
            payload: { usage: compactedUsage },
          });
        }
        yield* offerRuntimeEvent({
          ...base,
          type: "thread.state.changed",
          payload: {
            state: "compacted",
            detail: message,
          },
        });
        return;
      }
      case "hook_started":
        yield* offerRuntimeEvent({
          ...base,
          type: "hook.started",
          payload: {
            hookId: message.hook_id,
            hookName: message.hook_name,
            hookEvent: message.hook_event,
          },
        });
        return;
      case "hook_progress":
        yield* offerRuntimeEvent({
          ...base,
          type: "hook.progress",
          payload: {
            hookId: message.hook_id,
            output: message.output,
            stdout: message.stdout,
            stderr: message.stderr,
          },
        });
        return;
      case "hook_response":
        yield* offerRuntimeEvent({
          ...base,
          type: "hook.completed",
          payload: {
            hookId: message.hook_id,
            outcome: message.outcome,
            output: message.output,
            stdout: message.stdout,
            stderr: message.stderr,
            ...(typeof message.exit_code === "number" ? { exitCode: message.exit_code } : {}),
          },
        });
        return;
      case "task_started":
        context.liveTaskIds.add(message.task_id);
        context.settledTaskIds.delete(message.task_id);
        context.pendingTaskEnds.delete(message.task_id);
        if (message.task_type) context.taskTypes.set(message.task_id, message.task_type);
        yield* offerRuntimeEvent({
          ...base,
          type: "task.started",
          payload: {
            taskId: RuntimeTaskId.makeUnsafe(message.task_id),
            description: message.description,
            ...(message.task_type ? { taskType: message.task_type } : {}),
          },
        });
        yield* startTaskOutputTail(context, message);
        return;
      case "task_progress":
        yield* offerRuntimeEvent({
          ...base,
          type: "task.progress",
          payload: {
            taskId: RuntimeTaskId.makeUnsafe(message.task_id),
            description: message.description,
            ...(message.summary ? { summary: message.summary } : {}),
            ...(message.usage ? { usage: message.usage } : {}),
            ...(message.last_tool_name ? { lastToolName: message.last_tool_name } : {}),
          },
        });
        return;
      case "task_notification":
        context.backgroundRoster?.delete(message.task_id);
        context.pendingTaskEnds.delete(message.task_id);
        // Unknown ids still report: a resumed session can finish a task from an earlier process.
        if (
          !context.liveTaskIds.delete(message.task_id) &&
          context.settledTaskIds.has(message.task_id)
        ) {
          return;
        }
        context.settledTaskIds.add(message.task_id);
        yield* offerRuntimeEvent({
          ...base,
          type: "task.completed",
          payload: {
            taskId: RuntimeTaskId.makeUnsafe(message.task_id),
            status: message.status,
            ...(message.summary ? { summary: message.summary } : {}),
            ...(message.usage ? { usage: message.usage } : {}),
          },
        });
        return;
      case "files_persisted":
        yield* offerRuntimeEvent({
          ...base,
          type: "files.persisted",
          payload: {
            files: Array.isArray(message.files)
              ? message.files.map((file: { filename: string; file_id: string }) => ({
                  filename: file.filename,
                  fileId: file.file_id,
                }))
              : [],
            ...(Array.isArray(message.failed)
              ? {
                  failed: message.failed.map((entry: { filename: string; error: string }) => ({
                    filename: entry.filename,
                    error: entry.error,
                  })),
                }
              : {}),
          },
        });
        return;
      case "api_retry":
        // Side API calls retry outside a turn; a "running" state there would stick until the next turn.
        if (!context.turnState) {
          yield* Effect.logDebug("claude.api_retry.idle", {
            threadId: context.session.threadId,
            attempt: message.attempt,
          });
          return;
        }
        // Transport retry heartbeat; the terminal result reports the real failure.
        yield* offerRuntimeEvent({
          ...base,
          type: "session.state.changed",
          payload: {
            state: "running",
            reason: `api_retry:${message.attempt}/${message.max_retries}`,
          },
        });
        {
          // Frames name no agent; Claude's heartbeat for waiting subagents is a plain 429.
          const turn = context.turnState;
          const isRateLimit = message.error_status === 429;
          if (isRateLimit && turn.rootStreamOpen) return;
          // Any other failure is the root request's own, so whatever it was streaming has ended.
          if (!isRateLimit) turn.rootStreamOpen = false;
          const retry = {
            retryId:
              turn.apiRetry?.retryId ??
              (isRateLimit ? (turn.rateLimitRetryId ??= message.uuid) : message.uuid),
            whileSubagentRuns:
              turn.apiRetry?.whileSubagentRuns ??
              Array.from(context.inFlightTools.values()).some(
                (tool) => tool.itemType === "collab_agent_tool_call",
              ),
            attempt: message.attempt,
            maxRetries: message.max_retries,
            errorStatus: message.error_status,
            error: message.error,
            noResponseWaitedMs: message.no_response?.waited_ms,
            explainedByUsageLimit: turn.rejectedRateLimitTypes.size > 0,
          };
          turn.apiRetry = retry;
          yield* emitApiRetryRow(context, retry, "retrying");
        }
        return;
      case "session_state_changed":
        // A trailing idle can land after the next turn started; the result-driven completeTurn is authoritative.
        if (message.state === "idle" && context.turnState) {
          yield* Effect.logDebug("claude.session_state.idle_during_turn", {
            threadId: context.session.threadId,
          });
          return;
        }
        yield* offerRuntimeEvent({
          ...base,
          type: "session.state.changed",
          payload: {
            state:
              message.state === "running"
                ? "running"
                : message.state === "requires_action"
                  ? "waiting"
                  : "ready",
            reason: `session_state:${message.state}`,
          },
        });
        return;
      case "notification":
        if (message.priority === "high" || message.priority === "immediate") {
          yield* emitRuntimeWarning(context, message.text, message);
        }
        return;
      case "mirror_error":
        // Non-fatal: the SDK drops the batch and the session continues.
        yield* emitRuntimeWarning(
          context,
          `Claude workspace mirror error: ${message.error}`,
          message,
        );
        return;
      case "permission_denied":
        yield* emitRuntimeWarning(
          context,
          `Tool '${message.tool_name}' was denied${message.decision_reason ? `: ${message.decision_reason}` : ""}.`,
          message,
        );
        return;
      case "informational":
        yield* trackClaudeGoal(context, message);
        if (message.level === "warning" || message.prevent_continuation === true) {
          yield* emitRuntimeWarning(context, message.content, message);
          return;
        }
        yield* Effect.logDebug("claude.system.ignored", {
          threadId: context.session.threadId,
          subtype: message.subtype,
        });
        return;
      case "model_refusal_fallback":
        // A safety fallback switched models; the CLI ships the user-facing notice in `content`.
        yield* emitRuntimeWarning(context, message.content, message);
        return;
      case "task_updated": {
        const patchStatus = message.patch?.status;
        if (patchStatus === "completed" || patchStatus === "failed" || patchStatus === "killed") {
          context.backgroundRoster?.delete(message.task_id);
          // Settle here: a kill can be observed before the stopTask ack, which then skips the task.
          if (context.liveTaskIds.delete(message.task_id)) {
            if (patchStatus === "killed") {
              context.settledTaskIds.add(message.task_id);
              yield* emitTaskEnded(context, message.task_id, "stopped");
            } else {
              context.pendingTaskEnds.set(message.task_id, patchStatus);
            }
          }
          return;
        }
        yield* Effect.logDebug("claude.system.ignored", {
          threadId: context.session.threadId,
          subtype: message.subtype,
        });
        return;
      }
      case "background_tasks_changed":
        // Membership only: a task that left without its end frame stays in liveTaskIds for Stop.
        if (Array.isArray(message.tasks)) {
          context.backgroundRoster = new Set(
            message.tasks.filter((task) => task.ambient !== true).map((task) => task.task_id),
          );
          for (const task of message.tasks) {
            if (task.task_type) context.taskTypes.set(task.task_id, task.task_type);
          }
        }
        return;
      case "thinking_tokens":
      case "commands_changed":
      case "memory_recall":
      case "model_refusal_no_fallback":
      case "local_command_output":
      case "plugin_install":
      case "elicitation_complete":
      case "control_request_progress":
      case "worker_shutting_down":
      case "session_writes_lost":
        yield* Effect.logDebug("claude.system.ignored", {
          threadId: context.session.threadId,
          subtype: message.subtype,
        });
        return;
      default: {
        message satisfies never;
        const subtype = sdkMessageSubtype(message) ?? "unknown";
        const focusRequestedPlugin = claudeFocusRequestedPanePlugin(message);
        if (focusRequestedPlugin !== undefined && context.turnState) {
          const detail = claudeModPaneUnsupportedMessage(focusRequestedPlugin);
          yield* emitRuntimeError(context, detail, message);
          yield* completeTurn(context, "failed", detail);
          // Closing abandons the held tool call; an interrupt might never be acknowledged.
          // Forked because stopping interrupts the stream fiber running this handler.
          yield* stopSessionInternal(context, { emitExitEvent: true }).pipe(
            Effect.forkDetach({ startImmediately: true }),
          );
          return;
        }
        if (IGNORED_UNTYPED_CLAUDE_SYSTEM_SUBTYPES.has(subtype)) {
          yield* Effect.logDebug("claude.system.ignored", {
            threadId: context.session.threadId,
            subtype,
          });
          return;
        }
        yield* emitRuntimeWarning(
          context,
          describeUnknownSdkMessage(`Claude system message '${subtype}'`, message),
          message,
        );
        return;
      }
    }
  });

  const handleSdkTelemetryMessage = Effect.fn("handleSdkTelemetryMessage")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    const stamp = yield* makeEventStamp();
    const base = {
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
      providerRefs: nativeProviderRefs(),
      raw: {
        source: "claude.sdk.message" as const,
        method: sdkNativeMethod(message),
        messageType: message.type,
        payload: message,
      },
    };

    if (message.type === "tool_progress") {
      yield* offerRuntimeEvent({
        ...base,
        type: "tool.progress",
        payload: {
          toolUseId: message.tool_use_id,
          toolName: message.tool_name,
          elapsedSeconds: message.elapsed_time_seconds,
          ...(message.task_id ? { summary: `task:${message.task_id}` } : {}),
        },
      });
      return;
    }

    if (message.type === "tool_use_summary") {
      yield* offerRuntimeEvent({
        ...base,
        type: "tool.summary",
        payload: {
          summary: message.summary,
          ...(message.preceding_tool_use_ids.length > 0
            ? { precedingToolUseIds: message.preceding_tool_use_ids }
            : {}),
        },
      });
      return;
    }

    if (message.type === "auth_status") {
      yield* offerRuntimeEvent({
        ...base,
        type: "auth.status",
        payload: {
          isAuthenticating: message.isAuthenticating,
          output: message.output,
          ...(message.error ? { error: message.error } : {}),
        },
      });
      return;
    }

    if (message.type === "rate_limit_event") {
      yield* offerRuntimeEvent({
        ...base,
        type: "account.rate-limits.updated",
        payload: {
          rateLimits: message,
        },
      });
      const rateLimitInfo = message.rate_limit_info;
      const turnState = context.turnState;
      if (!rateLimitInfo || !turnState) {
        return;
      }
      const limitType = rateLimitInfo.rateLimitType ?? "unknown";
      const blocked = isClaudeUsageLimitBlocking(rateLimitInfo);
      if (blocked) {
        turnState.rejectedRateLimitTypes.set(limitType, rateLimitInfo.resetsAt ?? null);
      } else {
        turnState.rejectedRateLimitTypes.delete(limitType);
      }
      // A rejected window parks the turn with no further messages, so name it once per window.
      const limitKey = `${limitType}:${rateLimitInfo.resetsAt ?? "unknown"}`;
      if (blocked && !turnState.announcedUsageLimitKeys.has(limitKey)) {
        turnState.announcedUsageLimitKeys.add(limitKey);
        yield* emitRuntimeWarning(
          context,
          describeClaudeUsageLimit(rateLimitInfo, Date.parse(stamp.createdAt)),
          rateLimitInfo,
        );
      }
      return;
    }
  });

  const handleSdkMessage = Effect.fn("handleSdkMessage")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    yield* logNativeSdkMessage(context, message);
    yield* ensureThreadId(context, message);

    // An assistant frame carrying an error is the failed request itself, not progress.
    if (message.type === "stream_event" || (message.type === "assistant" && !message.error)) {
      if (!isSubagentMessage(message) || context.turnState?.apiRetry?.whileSubagentRuns) {
        yield* settleApiRetry(context, "recovered");
      }
    } else if (message.type === "assistant" && !isSubagentMessage(message) && context.turnState) {
      context.turnState.rootStreamOpen = false;
    }

    switch (message.type) {
      case "stream_event":
        yield* handleStreamEvent(context, message);
        return;
      case "user":
        yield* handleUserMessage(context, message);
        return;
      case "assistant":
        yield* handleAssistantMessage(context, message);
        return;
      case "result":
        yield* handleResultMessage(context, message);
        return;
      case "system":
        yield* handleSystemMessage(context, message);
        return;
      case "tool_progress":
      case "tool_use_summary":
      case "auth_status":
      case "rate_limit_event":
        yield* handleSdkTelemetryMessage(context, message);
        return;
      case "conversation_reset":
        // /clear and the other resets drop the CLI's goal with the conversation.
        yield* setClaudeGoal(context, null);
        return;
      case "prompt_suggestion":
        yield* Effect.logDebug("claude.message.ignored", {
          threadId: context.session.threadId,
          type: message.type,
        });
        return;
      default: {
        message satisfies never;
        const type = sdkMessageType(message) ?? "unknown";
        if (IGNORED_CLAUDE_MESSAGE_TYPES.has(type)) {
          yield* Effect.logDebug("claude.message.ignored", {
            threadId: context.session.threadId,
            type,
          });
          return;
        }
        yield* emitRuntimeWarning(
          context,
          describeUnknownSdkMessage(`Claude SDK message '${type}'`, message),
          message,
        );
        return;
      }
    }
  });

  const runSdkStream = (context: ClaudeSessionContext): Effect.Effect<void, Error> =>
    Stream.fromAsyncIterable(context.query, (cause) =>
      toError(cause, "Claude runtime stream failed."),
    ).pipe(
      Stream.takeWhile(() => !context.stopped),
      Stream.runForEach((message) => handleSdkMessage(context, message)),
    );

  // Without this the saved rewind point fails every later start the same way.
  const resumeWithoutRewind = Effect.fn("resumeWithoutRewind")(function* (
    context: ClaudeSessionContext,
  ) {
    context.pendingRewindAt = undefined;
    if (context.turnState) {
      yield* completeTurn(context, "failed", CLAUDE_REWIND_POINT_MISSING_TURN_MESSAGE);
    }
    yield* updateResumeCursor(context);
    const retainedTurns = [...context.turns];
    const {
      rewindTo: _rewindTo,
      resumeSessionAt: _resumeSessionAt,
      ...resumeCursor
    } = (context.session.resumeCursor ?? {}) as Record<string, unknown>;
    const restart = yield* startSessionUnguarded({
      ...context.startInput,
      runtimeMode: context.session.runtimeMode,
      ...(context.session.cwd ? { cwd: context.session.cwd } : {}),
      resumeCursor,
    }).pipe(Effect.exit);
    const restarted = sessions.get(context.session.threadId);
    if (Exit.isFailure(restart) || !restarted || restarted === context) {
      yield* emitRuntimeError(context, CLAUDE_REWIND_POINT_MISSING_TURN_MESSAGE, restart);
      if (!context.stopped) return yield* stopSessionInternal(context, { emitExitEvent: true });
      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "session.exited",
        eventId: stamp.eventId,
        provider: PROVIDER,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        payload: { reason: "Session stopped", exitKind: "error" },
        providerRefs: {},
      });
      return;
    }
    restarted.turns.push(...retainedTurns);
    yield* updateResumeCursor(restarted);
    yield* emitRuntimeWarning(restarted, CLAUDE_REWIND_POINT_MISSING_WARNING);
  });

  const handleStreamExit = Effect.fn("handleStreamExit")(function* (
    context: ClaudeSessionContext,
    exit: Exit.Exit<void, Error>,
  ) {
    if (context.stopped) {
      return;
    }

    if (Exit.isFailure(exit)) {
      // A failure while Stop waits for the abort is the interrupt itself, not a turn failure.
      if (isClaudeInterruptedCause(exit.cause) || context.interruptedTurnSettled) {
        if (context.turnState) {
          yield* completeTurn(
            context,
            "interrupted",
            interruptionMessageFromClaudeCause(exit.cause),
          );
        }
      } else {
        const message = claudeExitMessageWithStderr(
          messageFromClaudeStreamCause(exit.cause, "Claude runtime stream failed."),
          context.cliExit.stderrTail,
        );
        const pretty = Cause.pretty(exit.cause);
        if (
          context.pendingRewindAt !== undefined &&
          (isClaudeMissingRewindPointText(message) || isClaudeMissingRewindPointText(pretty))
        ) {
          return yield* resumeWithoutRewind(context);
        }
        yield* emitRuntimeError(context, message, pretty);
        yield* completeTurn(context, "failed", message);
      }
    } else if (context.turnState) {
      yield* completeTurn(context, "interrupted", "Claude runtime stream ended.");
    }

    yield* stopSessionInternal(context, {
      emitExitEvent: true,
    });
  });

  // Lets Claude abort the running turn through its own path before Stop closes
  // the process, so the prompt reaches the transcript. Closing a first turn
  // before Claude writes it leaves a resume cursor for a session Claude never
  // saved, and every later message fails with "No conversation found". Runs
  // before `stopped` is set so the stream fiber still handles the result; only
  // the user-facing stopSession waits, teardown paths close immediately.
  const settleInterruptedTurn = Effect.fn("settleInterruptedTurn")(function* (
    context: ClaudeSessionContext,
  ) {
    if (context.stopped || !context.turnState || context.interruptAckTimedOut) return;
    if (context.interruptedTurnSettled) {
      yield* Deferred.await(context.interruptedTurnSettled).pipe(
        Effect.timeoutOption(CLAUDE_INTERRUPT_GRACE),
      );
      return;
    }
    const settled = yield* Deferred.make<void>();
    context.interruptedTurnSettled = settled;
    context.turnState.interruptRequested = true;
    yield* Effect.raceFirst(
      Deferred.await(settled),
      Effect.tryPromise(() => context.query.interrupt()).pipe(
        // A rejected interrupt means the control channel is gone; nothing will settle the turn.
        Effect.matchEffect({ onFailure: () => Effect.void, onSuccess: () => Effect.never }),
      ),
    ).pipe(
      Effect.timeoutOption(CLAUDE_INTERRUPT_GRACE),
      Effect.ensuring(
        Effect.sync(() => {
          if (context.interruptedTurnSettled === settled) {
            context.interruptedTurnSettled = undefined;
          }
        }),
      ),
    );
  });

  const emitTaskEnded = Effect.fn("emitTaskEnded")(function* (
    context: ClaudeSessionContext,
    taskId: string,
    status: "completed" | "failed" | "stopped",
  ) {
    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "task.completed",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
      payload: {
        taskId: RuntimeTaskId.makeUnsafe(taskId),
        status,
      },
      providerRefs: nativeProviderRefs(),
    });
  });

  // No notification followed a task's end frame, so report the task with what that frame said.
  const flushPendingTaskEnds = Effect.fn("flushPendingTaskEnds")(function* (
    context: ClaudeSessionContext,
  ) {
    for (const [taskId, status] of context.pendingTaskEnds) {
      context.pendingTaskEnds.delete(taskId);
      context.settledTaskIds.add(taskId);
      yield* emitTaskEnded(context, taskId, status);
    }
  });

  // interrupt() only ends the parent turn; background subagents/shells keep running.
  const stopLiveTasks = Effect.fn("stopLiveTasks")(function* (context: ClaudeSessionContext) {
    yield* flushPendingTaskEnds(context);
    const taskIds = Array.from(
      new Set([...context.liveTaskIds, ...(context.backgroundRoster ?? [])]),
    );
    if (taskIds.length === 0) return;
    const query = context.query;
    if (query.stopTask) {
      yield* Effect.forEach(
        taskIds,
        (taskId) =>
          Effect.tryPromise(
            // Invoke through the query object: SDK methods rely on `this`.
            () => query.stopTask!(taskId),
          ).pipe(Effect.timeoutOption(CLAUDE_STOP_TASK_TIMEOUT), Effect.ignore),
        { concurrency: 8, discard: true },
      ).pipe(Effect.timeoutOption(CLAUDE_STOP_TASKS_TOTAL_TIMEOUT), Effect.ignore);
    }
    // The task_notification can lose the race with interrupt() or never come, and a stale id
    // would refuse every later restart, so a requested stop settles the task either way.
    for (const taskId of taskIds) {
      context.liveTaskIds.delete(taskId);
      context.backgroundRoster?.delete(taskId);
      if (!context.settledTaskIds.has(taskId)) {
        context.settledTaskIds.add(taskId);
        yield* emitTaskEnded(context, taskId, "stopped");
      }
    }
  });

  const stopSessionInternal = Effect.fn("stopSessionInternal")(function* (
    context: ClaudeSessionContext,
    options?: { readonly emitExitEvent?: boolean },
  ) {
    if (context.stopped) return;

    context.stopped = true;
    yield* stopAllTaskOutputTails(context);
    yield* flushPendingTaskEnds(context);

    for (const taskId of Array.from(context.liveTaskIds)) {
      context.liveTaskIds.delete(taskId);
      yield* emitTaskEnded(context, taskId, "stopped");
    }

    for (const [requestId, pending] of context.pendingApprovals) {
      yield* Deferred.succeed(pending.decision, "cancel");
      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "request.resolved",
        eventId: stamp.eventId,
        provider: PROVIDER,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
        requestId: asRuntimeRequestId(requestId),
        payload: {
          requestType: pending.requestType,
          decision: "cancel",
        },
        providerRefs: nativeProviderRefs(),
      });
    }
    context.pendingApprovals.clear();

    // A question nobody can answer any more must not stay open, or the thread
    // can never settle. cancel unparks the handler, which emits user-input.resolved.
    for (const pending of Array.from(context.pendingUserInputs.values())) {
      yield* pending.cancel;
    }
    context.pendingUserInputs.clear();

    if (context.turnState) {
      yield* completeTurn(context, "interrupted", "Session stopped.");
    }

    yield* Queue.shutdown(context.promptQueue);

    const streamFiber = context.streamFiber;
    context.streamFiber = undefined;
    if (streamFiber && streamFiber.pollUnsafe() === undefined) {
      yield* Fiber.interrupt(streamFiber);
    }

    // @effect-diagnostics-next-line tryCatchInEffectGen:off
    try {
      context.query.close();
    } catch (cause) {
      yield* emitRuntimeError(context, "Failed to close Claude runtime query.", cause);
    }

    const updatedAt = yield* nowIso;
    context.session = {
      ...context.session,
      status: "closed",
      activeTurnId: undefined,
      updatedAt,
    };

    // A follow-up can start while a detached stop is closing; the thread then belongs to it.
    if (sessions.get(context.session.threadId) !== context) return;

    if (options?.emitExitEvent !== false) {
      const stamp = yield* makeEventStamp();
      const { resumeCursor } = context.session;
      yield* offerRuntimeEvent({
        type: "session.exited",
        eventId: stamp.eventId,
        provider: PROVIDER,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        payload: {
          reason: "Session stopped",
          exitKind: "graceful",
          // The session can be gone before ProviderService reads the last turn's cursor from it.
          ...(resumeCursor !== undefined ? { resumeCursor } : {}),
        },
        providerRefs: {},
      });
    }

    sessions.delete(context.session.threadId);
  });

  const requireSession = (
    threadId: ThreadId,
  ): Effect.Effect<ClaudeSessionContext, ProviderAdapterError> => {
    const context = sessions.get(threadId);
    if (!context) {
      return Effect.fail(
        new ProviderAdapterSessionNotFoundError({
          provider: PROVIDER,
          threadId,
        }),
      );
    }
    if (context.stopped || context.session.status === "closed") {
      return Effect.fail(
        new ProviderAdapterSessionClosedError({
          provider: PROVIDER,
          threadId,
        }),
      );
    }
    return Effect.succeed(context);
  };

  /** Starts or replaces the session even when that kills live background tasks (rollback). */
  const startSessionUnguarded: ClaudeAdapterShape["startSession"] = Effect.fn("startSession")(
    function* (input) {
      if (input.provider !== undefined && input.provider !== PROVIDER) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
        });
      }

      // The server's cwd can differ from the launch directory: `piedpiper <path>`.
      const cwd = input.cwd ?? serverConfig.cwd;
      const claudeSettings = yield* serverSettingsService.getSettings.pipe(
        Effect.map((settings) => settings.providers.claudeAgent),
        Effect.mapError(
          (error) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: input.threadId,
              detail: error.message,
              cause: error,
            }),
        ),
      );
      const {
        extraArgs,
        ignored: ignoredLaunchArgs,
        additionalDirectories: launchDirectories,
        appendSystemPrompt: launchAppendSystemPrompt,
        appendSystemPromptFile: launchAppendSystemPromptFile,
        appendFlagMissingValue,
        settingsArg: launchSettingsArg,
      } = claudeLaunchExtraArgs(claudeSettings.launchArgs);
      if (appendFlagMissingValue) {
        return yield* claudeAppendFlagMissingValueError(appendFlagMissingValue);
      }
      // Before the old query closes, so a bad value leaves the running session alone.
      const launchSettings =
        launchSettingsArg === undefined
          ? undefined
          : yield* readClaudeLaunchSettings({
              settingsArg: launchSettingsArg,
              cwd,
              fileSystem,
            });
      const launchAppendFileText =
        launchAppendSystemPromptFile === undefined
          ? undefined
          : yield* readClaudeLaunchAppendFile({
              fileArg: launchAppendSystemPromptFile,
              cwd,
              fileSystem,
            });

      // A restart replaces the live query; close the old one so its process exits.
      const previousContext = sessions.get(input.threadId);
      if (previousContext) {
        yield* stopSessionInternal(previousContext, { emitExitEvent: false });
      }

      const startedAt = yield* nowIso;
      const resumeState = readClaudeResumeState(input.resumeCursor);
      const turnEndMessageIds: Array<string | null> =
        resumeState?.turnEndMessageIds ??
        Array.from({ length: resumeState?.turnCount ?? 0 }, () => null);
      const threadId = input.threadId;
      const existingResumeSessionId = resumeState?.resume;
      const newSessionId =
        existingResumeSessionId === undefined ? yield* Random.nextUUIDv4 : undefined;
      const sessionId = existingResumeSessionId ?? newSessionId;

      const services = yield* Effect.services();
      const runFork = Effect.runForkWith(services);
      const runPromise = Effect.runPromiseWith(services);

      const promptQueue = yield* Queue.unbounded<PromptQueueItem>();
      const prompt = Stream.fromQueue(promptQueue).pipe(
        Stream.filter((item) => item.type === "message"),
        Stream.map((item) => item.message),
        Stream.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause) ? Stream.empty : Stream.failCause(cause),
        ),
        Stream.toAsyncIterable,
      );

      const inFlightTools = new Map<number, ToolInFlight>();

      const contextRef = yield* Ref.make<ClaudeSessionContext | undefined>(undefined);

      const approvals = makeClaudeApprovals({
        getContext: Ref.get(contextRef),
        makeEventStamp,
        offerRuntimeEvent,
        emitProposedPlanCompleted,
        runFork,
      });
      const { pendingApprovals, pendingUserInputs } = approvals;
      const canUseTool: CanUseTool = (...args) => runPromise(approvals.canUseTool(...args));
      const onUserDialog: NonNullable<ClaudeQueryOptions["onUserDialog"]> = (...args) =>
        runPromise(approvals.onUserDialog(...args));
      const onElicitation: NonNullable<ClaudeQueryOptions["onElicitation"]> = (...args) =>
        runPromise(approvals.onElicitation(...args));

      let unresolvedClaudeShim: string | undefined;
      const claudeBinaryPath = resolveClaudeSdkExecutablePath(claudeSettings.binaryPath, {
        onUnresolvedShim: (shimPath) => {
          unresolvedClaudeShim = shimPath;
        },
      });
      if (unresolvedClaudeShim) {
        yield* Effect.logWarning(
          "Claude launcher shim resolved but no @anthropic-ai/claude-code entry was found next to it",
          { binaryPath: claudeSettings.binaryPath, shimPath: unresolvedClaudeShim },
        );
      }
      if (ignoredLaunchArgs.length > 0) {
        yield* Effect.logWarning(
          "Ignoring Claude launch arguments Pied Piper sets or cannot pass",
          {
            ignored: ignoredLaunchArgs,
          },
        );
      }
      const modelSelection =
        input.modelSelection?.provider === "claudeAgent" ? input.modelSelection : undefined;
      const caps = getClaudeModelCapabilities(modelSelection?.model);
      const apiModelId = modelSelection ? resolveApiModelId(modelSelection) : undefined;
      const effort = (resolveEffort(caps, modelSelection?.options?.effort) ??
        null) as ClaudeCodeEffort | null;
      const fastMode = modelSelection?.options?.fastMode === true && caps.supportsFastMode;
      const ultracode =
        modelSelection?.options?.ultracode === true && caps.supportsUltracode === true;
      const thinking =
        typeof modelSelection?.options?.thinking === "boolean" && caps.supportsThinkingToggle
          ? modelSelection.options.thinking
          : undefined;
      // Launch arguments that set thinking themselves keep it, as these flags would race them.
      const thinkingConfig: NonNullable<ClaudeQueryOptions["thinking"]> | undefined =
        thinking === false ||
        (thinking !== true && launchSettings?.alwaysThinkingEnabled === false) ||
        extraArgs.thinking !== undefined ||
        extraArgs["max-thinking-tokens"] !== undefined ||
        extraArgs["thinking-display"] === "omitted"
          ? undefined
          : caps.supportsThinkingToggle
            ? { type: "enabled", display: "summarized" }
            : { type: "adaptive", display: "summarized" };
      const effectiveEffort = getEffectiveClaudeCodeEffort(effort);
      const permissionMode: PermissionMode | undefined =
        input.runtimeMode === "full-access"
          ? "bypassPermissions"
          : input.runtimeMode === "auto"
            ? "auto"
            : undefined;
      // Pasted images are saved under attachmentsDir; granting it lets Claude read them without a prompt.
      const additionalDirectories = [
        ...(input.cwd ? [input.cwd] : []),
        serverConfig.attachmentsDir,
        ...launchDirectories,
      ];
      const childEnv = buildClaudeChildEnv(undefined, { homePath: claudeSettings.homePath });
      const readRuntimeSettings = (model: string | undefined) =>
        readClaudeRuntimeSettings({
          fileSystem,
          cwd,
          model,
          configDir: childEnv.CLAUDE_CONFIG_DIR ?? Path.join(OS.homedir(), ".claude"),
          autoCompactWindow: claudeSettings.autoCompactWindow,
          launchSettings,
          environment: childEnv,
        });
      const runtimeSettings = yield* readRuntimeSettings(apiModelId);
      // The user's --settings sit beneath what Pied Piper sets itself.
      const settings = {
        ...launchSettings,
        ...(runtimeSettings.toolSearchOverride
          ? {
              env: {
                ...(typeof launchSettings?.env === "object" && launchSettings.env !== null
                  ? launchSettings.env
                  : {}),
                ENABLE_TOOL_SEARCH: runtimeSettings.toolSearchOverride,
              },
            }
          : {}),
        ...(typeof thinking === "boolean" ? { alwaysThinkingEnabled: thinking } : {}),
        ...(thinkingConfig ? { showThinkingSummaries: true } : {}),
        ...(fastMode ? { fastMode: true } : {}),
        ...(ultracode ? { ultracode: true } : {}),
        ...(claudeSettings.autoCompactWindow
          ? { autoCompactWindow: Number(claudeSettings.autoCompactWindow) }
          : {}),
      };

      // The SDK's append replaces the CLI flags' text, so the launch arguments have to travel in it.
      const systemPromptAppend = [
        input.systemPrompt,
        launchAppendFileText,
        launchAppendSystemPrompt,
      ]
        .filter((text) => text !== undefined && text.length > 0)
        .join("\n\n");

      const taskOutputRoot = claudeTaskOutputRoot({
        environment: childEnv,
        cwd: yield* fileSystem.realPath(cwd).pipe(Effect.orElseSucceed(() => cwd)),
        platform: process.platform,
        uid: process.getuid?.(),
      });

      // Own process group so plugin MCP grandchildren stop with the CLI (not on Windows).
      const cliExit: ClaudeSessionContext["cliExit"] = {};
      const spawnClaudeCodeProcess = claudeProcessGroupSpawnerFor(process.platform, {
        onAbnormalExit: ({ code, signal, stderrTail }) => {
          cliExit.stderrTail = stderrTail;
          runFork(
            Effect.logDebug("Claude CLI exited abnormally", {
              threadId,
              code,
              signal,
              stderrTail,
            }),
          );
        },
      });

      const queryOptions: ClaudeQueryOptions = {
        cwd,
        ...(apiModelId ? { model: apiModelId } : {}),
        // A given title skips Claude's own session-naming request; ignored on resume.
        ...(input.title ? { title: input.title } : {}),
        pathToClaudeCodeExecutable: claudeBinaryPath,
        settingSources: [...CLAUDE_SETTING_SOURCES],
        ...(effectiveEffort ? { effort: effectiveEffort } : {}),
        ...(thinkingConfig ? { thinking: thinkingConfig } : {}),
        ...(permissionMode ? { permissionMode } : {}),
        ...(permissionMode === "bypassPermissions"
          ? { allowDangerouslySkipPermissions: true }
          : {}),
        ...(Object.keys(settings).length > 0
          ? { settings: settings as NonNullable<ClaudeQueryOptions["settings"]> }
          : {}),
        ...(existingResumeSessionId ? { resume: existingResumeSessionId } : {}),
        ...(existingResumeSessionId && resumeState?.rewindTo
          ? { resumeSessionAt: resumeState.rewindTo }
          : {}),
        ...(newSessionId ? { sessionId: newSessionId } : {}),
        // Without the preset the SDK sends an empty system prompt to the Claude Code tooling.
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          ...(systemPromptAppend.length > 0 ? { append: systemPromptAppend } : {}),
        },
        includePartialMessages: true,
        canUseTool,
        onUserDialog,
        onElicitation,
        supportedDialogKinds: [CLAUDE_RESUME_DIALOG_KIND],
        ...(spawnClaudeCodeProcess ? { spawnClaudeCodeProcess } : {}),
        env: childEnv,
        additionalDirectories,
        ...(Object.keys(extraArgs).length > 0 ? { extraArgs } : {}),
      };

      const queryRuntime = yield* Effect.try({
        try: () =>
          createQuery({
            prompt,
            options: queryOptions,
          }),
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId,
            detail: toMessage(cause, "Failed to start Claude runtime session."),
            cause,
          }),
      });

      const session: ProviderSession = {
        threadId,
        provider: PROVIDER,
        status: "ready",
        runtimeMode: input.runtimeMode,
        cwd,
        ...(modelSelection?.model ? { model: modelSelection.model } : {}),
        ...(threadId ? { threadId } : {}),
        resumeCursor: {
          ...(threadId ? { threadId } : {}),
          ...(sessionId ? { resume: sessionId } : {}),
          ...(resumeState?.resumeSessionAt ? { resumeSessionAt: resumeState.resumeSessionAt } : {}),
          turnCount: turnEndMessageIds.length,
          turnEndMessageIds: [...turnEndMessageIds],
          ...(resumeState?.rewindTo ? { rewindTo: resumeState.rewindTo } : {}),
          ...(resumeState?.goal ? { goal: resumeState.goal } : {}),
          ...(resumeState?.goalSetAtTurn === undefined
            ? {}
            : { goalSetAtTurn: resumeState.goalSetAtTurn }),
        },
        createdAt: startedAt,
        updatedAt: startedAt,
      };

      const context: ClaudeSessionContext = {
        session,
        startInput: input,
        turnEndMessageIds,
        pendingRewindAt: existingResumeSessionId ? resumeState?.rewindTo : undefined,
        promptQueue,
        query: queryRuntime,
        streamFiber: undefined,
        startedAt,
        basePermissionMode: permissionMode,
        livePermissionMode: permissionMode ?? "default",
        openingPermissionModeSettled: false,
        permissionDowngradeNotice: undefined,
        currentInteractionMode: input.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE,
        currentApiModelId: apiModelId,
        currentEffort: effectiveEffort,
        currentFastMode: fastMode,
        currentUltracode: ultracode,
        serverShuttingDown: false,
        attachmentBudget: makeClaudeAttachmentBudget({
          resumed: existingResumeSessionId !== undefined,
        }),
        resumeSessionId: sessionId,
        pendingApprovals,
        pendingUserInputs,
        turns: [],
        inFlightTools,
        turnState: undefined,
        lastKnownContextWindow: claudeContextWindowForApiModel(apiModelId),
        autoCompactWindow: runtimeSettings.autoCompactWindow,
        readRuntimeSettings,
        initApiModelId: undefined,
        autoPermissionUnconfirmed: false,
        reportedContextWindows: new Map(),
        lastKnownTokenUsage: undefined,
        claudeTasks: new Map(),
        claudeTasksLoaded: existingResumeSessionId === undefined,
        claudeConfigDir: resolveClaudeConfigDir(claudeSettings.homePath),
        pendingTaskToolCalls: new Map(),
        rootRequestUsage: undefined,
        contextUsageStale: false,
        runningCompactionItemId: undefined,
        lastLiveContextUsage: undefined,
        lastAssistantUuid: resumeState?.resumeSessionAt,
        lastThreadStartedId: undefined,
        interruptedTurnSettled: undefined,
        interruptAckTimedOut: false,
        liveTaskIds: new Set(),
        settledTaskIds: new Set(),
        pendingTaskEnds: new Map(),
        taskTypes: new Map(),
        backgroundRoster: undefined,
        goal: resumeState?.goal ?? null,
        goalSetAtTurn: resumeState?.goalSetAtTurn,
        cliExit,
        taskOutputRoot,
        taskOutputTails: new Map(),
        stopped: false,
      };
      yield* Ref.set(contextRef, context);
      sessions.set(threadId, context);

      const sessionStartedStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "session.started",
        eventId: sessionStartedStamp.eventId,
        provider: PROVIDER,
        createdAt: sessionStartedStamp.createdAt,
        threadId,
        payload: input.resumeCursor !== undefined ? { resume: input.resumeCursor } : {},
        providerRefs: {},
      });

      const configuredStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "session.configured",
        eventId: configuredStamp.eventId,
        provider: PROVIDER,
        createdAt: configuredStamp.createdAt,
        threadId,
        payload: {
          config: {
            ...(apiModelId ? { model: apiModelId } : {}),
            cwd,
            ...(effectiveEffort ? { effort: effectiveEffort } : {}),
            ...(permissionMode ? { permissionMode } : {}),
            ...(fastMode ? { fastMode: true } : {}),
            ...(ultracode ? { ultracode: true } : {}),
          },
        },
        providerRefs: {},
      });

      const readyStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "session.state.changed",
        eventId: readyStamp.eventId,
        provider: PROVIDER,
        createdAt: readyStamp.createdAt,
        threadId,
        payload: {
          state: "ready",
        },
        providerRefs: {},
      });

      let streamFiber: Fiber.Fiber<void, never>;
      streamFiber = runFork(
        Effect.exit(runSdkStream(context)).pipe(
          Effect.flatMap((exit) => {
            if (context.stopped) {
              return Effect.void;
            }
            if (context.streamFiber === streamFiber) {
              context.streamFiber = undefined;
            }
            return handleStreamExit(context, exit);
          }),
        ),
      );
      context.streamFiber = streamFiber;
      streamFiber.addObserver(() => {
        if (context.streamFiber === streamFiber) {
          context.streamFiber = undefined;
        }
      });

      return {
        ...session,
      };
    },
  );

  const liveBackgroundWork = (context: ClaudeSessionContext) =>
    claudeLiveBackgroundWorkCount({
      liveTaskIds: context.liveTaskIds,
      backgroundRoster: context.backgroundRoster,
      turnActive: context.turnState !== undefined,
    });

  const startSession: ClaudeAdapterShape["startSession"] = (input) =>
    Effect.suspend(() => {
      if (input.freshContext === true)
        return startSessionUnguarded({ ...input, resumeCursor: null });
      const previousContext = sessions.get(input.threadId);
      return previousContext && !previousContext.stopped && liveBackgroundWork(previousContext) > 0
        ? Effect.fail(
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session/start",
              detail: CLAUDE_RESTART_WITH_LIVE_TASKS_DETAIL,
            }),
          )
        : startSessionUnguarded(input);
    });

  // Supervised sessions have no base mode; falling back to bypass would skip approvals.
  const applyRequestedPermissionMode = Effect.fn("applyRequestedPermissionMode")(function* (
    context: ClaudeSessionContext,
  ) {
    context.openingPermissionModeSettled = true;
    context.autoPermissionUnconfirmed = false;
    for (const mode of claudePermissionModeFallbacks(context.basePermissionMode ?? "default")) {
      const outcome = yield* Effect.tryPromise({
        try: () =>
          requestClaudePermissionMode((next) => context.query.setPermissionMode(next), mode),
        catch: (cause) => toRequestError(context.session.threadId, "turn/setPermissionMode", cause),
      });
      if (outcome === "accepted") {
        context.livePermissionMode = mode;
        return;
      }
      if (outcome === "unanswered") context.autoPermissionUnconfirmed = true;
    }
  });

  const sendTurn: ClaudeAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (input) {
    const context = yield* requireSession(input.threadId);
    const modelSelection =
      input.modelSelection?.provider === "claudeAgent" ? input.modelSelection : undefined;

    if (context.turnState) {
      // Auto-close a stale synthetic turn (from background agent responses
      // between user prompts) to prevent blocking the user's next turn.
      yield* completeTurn(context, "completed");
    }

    context.autoCompactWindow = (yield* context.readRuntimeSettings(
      modelSelection
        ? resolveApiModelId(modelSelection)
        : (context.currentApiModelId ?? context.initApiModelId),
    )).autoCompactWindow;
    let modelChanged = false;
    if (modelSelection?.model) {
      // Model, effort and fast mode apply to the live query from this turn on.
      // A thinking toggle needs a new process; the command reactor restarts for it.
      const apiModelId = resolveApiModelId(modelSelection);
      const caps = getClaudeModelCapabilities(modelSelection.model);
      const effort = getEffectiveClaudeCodeEffort(
        (resolveEffort(caps, modelSelection.options?.effort) ?? null) as ClaudeCodeEffort | null,
      );
      const fastMode = modelSelection.options?.fastMode === true && caps.supportsFastMode;
      const ultracode =
        modelSelection.options?.ultracode === true && caps.supportsUltracode === true;
      if (context.currentApiModelId !== apiModelId) {
        yield* Effect.tryPromise({
          try: () => context.query.setModel(apiModelId),
          catch: (cause) => toRequestError(input.threadId, "turn/setModel", cause),
        });
        context.currentApiModelId = apiModelId;
        modelChanged = true;
        // The previous model's window would clamp the meter until the next result.
        context.lastKnownContextWindow = claudeKnownContextWindowForModel(
          context.reportedContextWindows,
          apiModelId,
        );
        if (context.lastKnownTokenUsage) {
          const { maxTokens: _staleMaxTokens, ...usage } = context.lastKnownTokenUsage;
          context.lastKnownTokenUsage =
            context.lastKnownContextWindow === undefined
              ? usage
              : { ...usage, maxTokens: context.lastKnownContextWindow };
        }
      }
      if (
        context.currentEffort !== effort ||
        context.currentFastMode !== fastMode ||
        context.currentUltracode !== ultracode
      ) {
        const applyFlags = (settings: ClaudeLiveFlagSettings) =>
          Effect.tryPromise({
            try: () => context.query.applyFlagSettings(settings),
            catch: (cause) => toRequestError(input.threadId, "turn/applyFlagSettings", cause),
          });
        const flags = { effortLevel: effort, fastMode: fastMode ? true : null };
        // Ultracode depends on the account and CLI, and a CLI can reject the key outright, so
        // losing it must not lose the turn. Per the SDK, flags without the key also turn it off.
        const applyWithUltracode = (ultracodeValue: true | null) =>
          applyFlags({ ...flags, ultracode: ultracodeValue }).pipe(
            Effect.as(ultracodeValue === true),
            Effect.catch((error) =>
              Effect.logWarning("Claude rejected ultracode; continuing without it", {
                threadId: input.threadId,
                detail: error.message,
              }).pipe(
                Effect.andThen(
                  ultracodeValue === true
                    ? emitRuntimeWarning(
                        context,
                        "Ultracode is not available for this session; continuing without it",
                      )
                    : Effect.void,
                ),
                Effect.andThen(applyFlags(flags)),
                Effect.as(false),
              ),
            ),
          );
        // Effort moving without an ultracode key turns ultracode off, so while it is on send both.
        const appliedUltracode = ultracode
          ? yield* applyWithUltracode(true)
          : context.currentUltracode
            ? yield* applyWithUltracode(null)
            : yield* applyFlags(flags).pipe(Effect.as(false));
        context.currentEffort = effort;
        context.currentFastMode = fastMode;
        context.currentUltracode = appliedUltracode;
      }
      context.session = {
        ...context.session,
        model: modelSelection.model,
      };
      context.startInput = { ...context.startInput, modelSelection };
    }

    // Apply interaction mode by switching the SDK's permission mode and
    // pinning the live mode on the context so `canUseTool` sees the change.
    // "plan"  → SDK permission mode "plan"; tools still proposed for approval.
    // "ask"   → SDK permission mode restored, but every tool is denied in
    //           canUseTool so the model has to answer in natural language.
    // "default" → restores the session's original permission mode.
    // When interactionMode is absent we leave the current mode unchanged.
    if (input.interactionMode !== undefined) {
      context.currentInteractionMode = input.interactionMode;
      context.startInput = { ...context.startInput, interactionMode: input.interactionMode };
    }
    let permissionNotice: string | undefined;
    if (input.interactionMode === "plan") {
      yield* Effect.tryPromise({
        try: () => context.query.setPermissionMode("plan"),
        catch: (cause) => toRequestError(input.threadId, "turn/setPermissionMode", cause),
      });
      context.openingPermissionModeSettled = true;
      context.livePermissionMode = "plan";
    } else if (
      input.interactionMode === "default" ||
      input.interactionMode === "ask" ||
      // The new model may allow what the last one refused.
      (modelChanged &&
        context.livePermissionMode !== "plan" &&
        context.livePermissionMode !== (context.basePermissionMode ?? "default"))
    ) {
      yield* applyRequestedPermissionMode(context);
      permissionNotice = takePermissionDowngradeNotice(context);
    }

    const turnId = TurnId.makeUnsafe(yield* Random.nextUUIDv4);
    const turnState: ClaudeTurnState = {
      turnId,
      startedAt: yield* nowIso,
      synthetic: false,
      assistantTextBlocks: new Map(),
      assistantTextBlockOrder: [],
      capturedProposedPlanKeys: new Set(),
      capturedTodoPlanKeys: new Set(),
      nextSyntheticAssistantBlockIndex: -1,
      authenticationFailed: false,
      rejectedRateLimitTypes: new Map(),
      announcedUsageLimitKeys: new Set(),
      latestAssistantRateLimited: false,
      latestAssistantRateLimitWindow: undefined,
      openThinkingBlocks: new Map(),
      openThinkingText: new Map(),
      thinkingByMessage: new Map(),
    };

    const updatedAt = yield* nowIso;
    context.turnState = turnState;
    context.interruptAckTimedOut = false;
    context.session = {
      ...context.session,
      status: "running",
      activeTurnId: turnId,
      updatedAt,
    };

    const turnStartedStamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "turn.started",
      eventId: turnStartedStamp.eventId,
      provider: PROVIDER,
      createdAt: turnStartedStamp.createdAt,
      threadId: context.session.threadId,
      turnId,
      payload: modelSelection?.model ? { model: modelSelection.model } : {},
      providerRefs: {},
    });
    // After turn.started so the notice lands in this turn's work log.
    if (permissionNotice) yield* emitRuntimeWarning(context, permissionNotice);

    // Uninterruptible so a PDF reservation always settles; these are local reads and an unbounded queue.
    yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const { message: builtMessage, reservation } = yield* buildUserMessageWithPdfBudgetEffect(
          input,
          {
            fileSystem,
            attachmentsDir: serverConfig.attachmentsDir,
            pdfBudget: context.attachmentBudget,
          },
        );
        // The CLI echoes this uuid on the turn's result so Claude-initiated turns can be told apart.
        const message: SDKUserMessage = {
          ...builtMessage,
          uuid: turnId as unknown as NonNullable<SDKUserMessage["uuid"]>,
        };

        const queued = yield* Queue.offer(context.promptQueue, {
          type: "message",
          message,
        }).pipe(Effect.mapError((cause) => toRequestError(input.threadId, "turn/start", cause)));
        if (queued) reservation.commit();
        else reservation.rollback();
      }),
    );

    return {
      threadId: context.session.threadId,
      turnId,
      ...(context.session.resumeCursor !== undefined
        ? { resumeCursor: context.session.resumeCursor }
        : {}),
    };
  });

  const interruptTurn: ClaudeAdapterShape["interruptTurn"] = Effect.fn("interruptTurn")(
    function* (threadId, _turnId) {
      const context = yield* requireSession(threadId);
      if (context.turnState) context.turnState.interruptRequested = true;
      yield* stopLiveTasks(context);
      // An interrupt the SDK never acknowledges must not wedge the shared provider worker.
      const acknowledged = yield* Effect.tryPromise({
        try: () => context.query.interrupt(),
        catch: (cause) => toRequestError(threadId, "turn/interrupt", cause),
      }).pipe(Effect.timeoutOption(CLAUDE_INTERRUPT_ACK_TIMEOUT));
      if (acknowledged._tag === "None") {
        context.interruptAckTimedOut = true;
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "turn/interrupt",
          detail: `Claude did not acknowledge the interrupt within ${CLAUDE_INTERRUPT_ACK_TIMEOUT}.`,
        });
      }
    },
  );

  const readThread: ClaudeAdapterShape["readThread"] = Effect.fn("readThread")(
    function* (threadId) {
      const context = yield* requireSession(threadId);
      return yield* snapshotThread(context);
    },
  );

  const rollbackThread: ClaudeAdapterShape["rollbackThread"] = Effect.fn("rollbackThread")(
    function* (threadId, numTurns) {
      const context = yield* requireSession(threadId);
      const retainedCount = Math.max(0, context.turnEndMessageIds.length - numTurns);
      const rollbackAt =
        retainedCount > 0 ? context.turnEndMessageIds[retainedCount - 1] : undefined;
      const sessionId = context.resumeSessionId;
      // More turns than recorded means older history this cursor never counted.
      const boundariesKnown =
        numTurns <= context.turnEndMessageIds.length &&
        (rollbackAt !== undefined
          ? rollbackAt !== null && sessionId !== undefined
          : context.turnEndMessageIds.every((id) => id !== null));
      if (numTurns < 1 || !boundariesKnown) {
        // Older cursors recorded no turn boundaries; keep the history rather than guess.
        context.turns.splice(Math.max(0, context.turns.length - numTurns));
        if (numTurns >= 1) {
          yield* emitRuntimeWarning(
            context,
            "Claude still remembers the reverted turns because their place in its history is unknown. Start a new thread to drop them.",
          );
        }
        yield* updateResumeCursor(context);
        return yield* snapshotThread(context);
      }
      const retainedTurns = context.turns.slice(0, Math.max(0, context.turns.length - numTurns));
      const retainedBoundaries = context.turnEndMessageIds.slice(0, retainedCount);
      // Claude restores a goal from its transcript, so one set in a removed turn is gone with it.
      const previousGoal = context.goal;
      const goalKept = previousGoal !== null && retainedCount > (context.goalSetAtTurn ?? 0);
      // Resuming at the kept turn's last entry trims Claude's history; no kept turns starts fresh.
      yield* startSessionUnguarded({
        ...context.startInput,
        runtimeMode: context.session.runtimeMode,
        ...(context.session.cwd ? { cwd: context.session.cwd } : {}),
        resumeCursor: rollbackAt
          ? {
              threadId,
              resume: sessionId,
              resumeSessionAt: rollbackAt,
              rewindTo: rollbackAt,
              turnCount: retainedCount,
              turnEndMessageIds: retainedBoundaries,
              ...(goalKept
                ? {
                    goal: previousGoal,
                    ...(context.goalSetAtTurn === undefined
                      ? {}
                      : { goalSetAtTurn: context.goalSetAtTurn }),
                  }
                : {}),
            }
          : undefined,
      });
      const restarted = yield* requireSession(threadId);
      restarted.turns.push(...retainedTurns);
      if (previousGoal !== null && !goalKept) {
        restarted.goal = previousGoal;
        yield* setClaudeGoal(restarted, null);
      }
      yield* updateResumeCursor(restarted);
      return yield* snapshotThread(restarted);
    },
  );

  const respondToRequest: ClaudeAdapterShape["respondToRequest"] = Effect.fn("respondToRequest")(
    function* (threadId, requestId, decision) {
      const context = yield* requireSession(threadId);
      const pending = context.pendingApprovals.get(requestId);
      if (!pending) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "item/requestApproval/decision",
          detail: `Unknown pending approval request: ${requestId}`,
        });
      }

      context.pendingApprovals.delete(requestId);
      yield* Deferred.succeed(pending.decision, decision);
    },
  );

  const respondToUserInput: ClaudeAdapterShape["respondToUserInput"] = Effect.fn(
    "respondToUserInput",
  )(function* (threadId, requestId, answers) {
    const context = yield* requireSession(threadId);
    const pending = context.pendingUserInputs.get(requestId);
    if (!pending) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "item/tool/respondToUserInput",
        detail: `Unknown pending user-input request: ${requestId}`,
      });
    }

    context.pendingUserInputs.delete(requestId);
    yield* Deferred.succeed(pending.answers, answers);
  });

  const stopSession: ClaudeAdapterShape["stopSession"] = Effect.fn("stopSession")(
    function* (threadId) {
      const context = yield* requireSession(threadId);
      yield* settleInterruptedTurn(context);
      yield* stopSessionInternal(context, {
        emitExitEvent: true,
      });
    },
  );

  const listSessions: ClaudeAdapterShape["listSessions"] = () =>
    Effect.sync(() => Array.from(sessions.values(), ({ session }) => ({ ...session })));

  const hasSession: ClaudeAdapterShape["hasSession"] = (threadId) =>
    Effect.sync(() => {
      const context = sessions.get(threadId);
      return context !== undefined && !context.stopped;
    });

  // Lets the idle-session reaper keep a session whose background task (dev server, watcher) is quiet.
  const countLiveBackgroundTasks: NonNullable<ClaudeAdapterShape["countLiveBackgroundTasks"]> = (
    threadId,
  ) =>
    Effect.sync(() => {
      const context = sessions.get(threadId);
      return context === undefined || context.stopped ? 0 : liveBackgroundWork(context);
    });

  // Only ProviderService's finalizer calls this, so it is always a server quit.
  const stopAll: ClaudeAdapterShape["stopAll"] = () =>
    Effect.forEach(
      sessions,
      ([, context]) => {
        context.serverShuttingDown = true;
        return stopSessionInternal(context, {
          emitExitEvent: true,
        });
      },
      { discard: true },
    );

  yield* Effect.addFinalizer(() =>
    Effect.forEach(
      sessions,
      ([, context]) => {
        context.serverShuttingDown = true;
        return stopSessionInternal(context, {
          emitExitEvent: false,
        });
      },
      { discard: true },
    ).pipe(Effect.tap(() => Queue.shutdown(runtimeEventQueue))),
  );

  return {
    provider: PROVIDER,
    capabilities: {
      sessionModelSwitch: "in-session",
    },
    startSession,
    sendTurn,
    interruptTurn,
    readThread,
    rollbackThread,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    countLiveBackgroundTasks,
    stopAll,
    streamEvents: Stream.fromQueue(runtimeEventQueue),
  } satisfies ClaudeAdapterShape;
});

export const ClaudeAdapterLive = Layer.effect(ClaudeAdapter, makeClaudeAdapter());

export function makeClaudeAdapterLive(options?: ClaudeAdapterLiveOptions) {
  return Layer.effect(ClaudeAdapter, makeClaudeAdapter(options));
}
