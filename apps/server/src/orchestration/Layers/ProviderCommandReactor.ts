import {
  type ChatAttachment,
  CommandId,
  EventId,
  isModelSelectionSwitch,
  MessageId,
  ModelSelection,
  type OrchestrationEvent,
  type OrchestrationThread,
  type ProjectId,
  type ProviderGoal,
  ProviderKind,
  type OrchestrationSession,
  THREAD_MODEL_SWITCH_ACTIVITY_KIND,
  type ThreadModelSwitchActivityPayload,
  ThreadId,
  type ThreadTitleRegenerationOutcome,
  type ProviderSession,
  type RuntimeMode,
  type TurnId,
} from "@piedpiper/contracts";
import { Cache, Cause, Duration, Effect, Layer, Option, PubSub, Schedule, Schema } from "effect";
import { access } from "node:fs/promises";
import { makeDrainableWorker } from "@piedpiper/shared/DrainableWorker";
import { stripImageOnlyBootstrapPrompt } from "@piedpiper/shared/imageOnlyBootstrapPrompt";
import { isTemporaryWorktreeBranch } from "@piedpiper/shared/git";

import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import {
  type CodexGoalCommand,
  describeProviderGoal,
  parseCodexGoalCommand,
} from "../../codex/codexGoalCommand.ts";
import { ServerConfig } from "../../config.ts";
import {
  branchNamingOptionsFromSettings,
  formatGeneratedBranchName,
} from "../../git/branchNaming.ts";
import { GitCore } from "../../git/Services/GitCore.ts";
import { GitHubCli } from "../../git/Services/GitHubCli.ts";
import {
  resolveThreadTitleLinkedContext,
  threadTitleLinkSourceFromMessages,
} from "../../git/threadTitleLinks.ts";
import { increment, orchestrationEventsProcessedTotal } from "../../observability/Metrics.ts";
import {
  ProviderAdapterRequestError,
  ProviderServiceError,
  ProviderSessionNotFoundError,
} from "../../provider/Errors.ts";
import { formatThreadTitleRegenerationContext } from "../../git/Prompts.ts";
import { TextGeneration } from "../../git/Services/TextGeneration.ts";
import { codexGoalObjectiveError } from "../../provider/goalObjective.ts";
import type { ProviderGoalRequest } from "../../provider/Services/ProviderAdapter.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { makeProviderSessionReaper } from "../../provider/Layers/ProviderSessionReaper.ts";
import { ProviderSessionRuntimeRepositoryLive } from "../../persistence/Layers/ProviderSessionRuntime.ts";
import { ProviderSessionRuntimeRepository } from "../../persistence/Services/ProviderSessionRuntime.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  ProviderCommandReactor,
  type ProviderCommandReactorShape,
} from "../Services/ProviderCommandReactor.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { isCompactCommandMessage } from "../compactCommand.ts";
import { RESTART_CONTINUATION_MESSAGE_ID_PREFIX } from "../restartContinuation.ts";
import { canReplaceThreadTitle } from "../threadTitles.ts";
import {
  asyncAnswerMessageId,
  findNextHeldUserInputAnswer,
  formatUserInputAnswerPairs,
  readUserInputAnswerPairs,
  readUserInputRequestState,
  resolvedActivitySequence,
} from "../userInputRequests.ts";

type ProviderIntentEvent = Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.runtime-mode-set"
      | "thread.turn-start-requested"
      | "thread.turn-interrupt-requested"
      | "thread.approval-response-requested"
      | "thread.user-input-response-requested"
      | "thread.session-stop-requested"
      | "thread.title-regeneration-requested"
      | "thread.session-set";
  }
>;

// Delivers held question answers for threads that may have settled before this process started.
interface HeldAnswersRescan {
  readonly type: "held-answers.rescan";
  readonly threadId: ThreadId;
}

interface ThreadTitleRegenerationResult {
  readonly outcome: ThreadTitleRegenerationOutcome;
  readonly detail?: string;
}

const titleRegenerationResult = (
  outcome: ThreadTitleRegenerationOutcome,
): ThreadTitleRegenerationResult => ({ outcome });

const THREAD_TITLE_REGENERATION_DETAIL_MAX_CHARS = 500;

// The settled event is persisted and shown in a toast, so it gets the message and no stack trace.
function titleRegenerationFailureDetail(cause: Cause.Cause<unknown>): { detail?: string } {
  const error = Cause.squash(cause);
  const detail = (error instanceof Error ? error.message : String(error))
    .slice(0, THREAD_TITLE_REGENERATION_DETAIL_MAX_CHARS)
    .trim();
  return detail.length > 0 ? { detail } : {};
}

// Local to regeneration: a removed worktree must fail a turn start, but a title needs no worktree.
export const resolveTitleRegenerationCwd = Effect.fn("resolveTitleRegenerationCwd")(
  function* (input: {
    readonly thread: { readonly projectId: ProjectId; readonly worktreePath: string | null };
    readonly projects: ReadonlyMap<ProjectId, { readonly workspaceRoot: string }>;
    readonly fallbackCwd: string;
  }) {
    const cwd = resolveThreadWorkspaceCwd(input);
    const workspaceRoot = input.projects.get(input.thread.projectId)?.workspaceRoot;
    if (cwd === undefined) return input.fallbackCwd;
    if (cwd === workspaceRoot) return cwd;
    const cwdExists = yield* Effect.tryPromise(() => access(cwd).then(() => true)).pipe(
      Effect.catch(() => Effect.succeed(false)),
    );
    return cwdExists ? cwd : (workspaceRoot ?? input.fallbackCwd);
  },
);

function claudeThinkingSetting(selection: ModelSelection): boolean | undefined {
  return selection.provider === "claudeAgent" ? selection.options?.thinking : undefined;
}

function toNonEmptyProviderInput(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function mapProviderSessionStatusToOrchestrationStatus(
  status: "connecting" | "ready" | "running" | "error" | "closed",
): OrchestrationSession["status"] {
  switch (status) {
    case "connecting":
      return "starting";
    case "running":
      return "running";
    case "error":
      return "error";
    case "closed":
      return "stopped";
    case "ready":
    default:
      return "ready";
  }
}

const isSessionSettled = (session: OrchestrationSession | null | undefined): boolean =>
  (session?.activeTurnId ?? null) === null &&
  session?.status !== "running" &&
  session?.status !== "starting";

function parseCodexGoalMessage(
  message: OrchestrationThread["messages"][number],
): CodexGoalCommand | null {
  return message.role === "user" && (message.attachments?.length ?? 0) === 0
    ? parseCodexGoalCommand(message.text)
    : null;
}

/** A `/goal` that only controls the goal: it starts no turn, so it is no first message either. */
function isCodexGoalControlMessage(message: OrchestrationThread["messages"][number]): boolean {
  const command = parseCodexGoalMessage(message);
  return command !== null && command.type !== "set";
}

const GOAL_REPLY_MESSAGE_ID_PREFIX = "goal-reply:";

// The persisted resume cursor went stale: the session's own state is gone with it.
const isStaleSessionFailure = (cause: Cause.Cause<unknown>): boolean => {
  const pretty = Cause.pretty(cause);
  return (
    pretty.includes("No conversation found with session ID") || pretty.includes("does not exist")
  );
};

const turnStartKeyForEvent = (event: ProviderIntentEvent): string =>
  event.commandId !== null ? `command:${event.commandId}` : `event:${event.eventId}`;

const titleInstructionsInput = (instructions: string): { additionalInstructions?: string } =>
  instructions.trim().length > 0 ? { additionalInstructions: instructions.trim() } : {};

const serverCommandId = (tag: string): CommandId =>
  CommandId.makeUnsafe(`server:${tag}:${crypto.randomUUID()}`);

const HANDLED_TURN_START_KEY_MAX = 10_000;
const HANDLED_TURN_START_KEY_TTL = Duration.minutes(30);
const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";

// User-facing failure text: provider errors carry a clean detail; Cause.pretty includes stack frames.
function formatFailureDetail(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  if (Schema.is(ProviderAdapterRequestError)(error)) {
    return error.detail;
  }
  if (Schema.is(ProviderSessionNotFoundError)(error)) {
    return "No active provider session is running for this thread.";
  }
  return Cause.pretty(cause);
}

// Codex writes "user input" where Claude writes "user-input", and casing varies by provider.
function normalizeProviderErrorText(text: string): string {
  return text.toLowerCase().replace(/[-\s]+/g, " ");
}

function providerErrorTextForMatching(cause: Cause.Cause<ProviderServiceError>): string {
  const error = Cause.squash(cause);
  return normalizeProviderErrorText(
    Schema.is(ProviderAdapterRequestError)(error) ? error.detail : Cause.pretty(cause),
  );
}

function isUnknownPendingApprovalRequestError(cause: Cause.Cause<ProviderServiceError>): boolean {
  const text = providerErrorTextForMatching(cause);
  return (
    text.includes("unknown pending approval request") ||
    text.includes("unknown pending permission request")
  );
}

function isUnknownPendingUserInputRequestError(cause: Cause.Cause<ProviderServiceError>): boolean {
  return providerErrorTextForMatching(cause).includes("unknown pending user input request");
}

function stalePendingRequestDetail(
  requestKind: "approval" | "user-input",
  requestId: string,
): string {
  return `Stale pending ${requestKind} request: ${requestId}. Provider callback state does not survive app restarts or recovered sessions. Restart the turn to continue.`;
}

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;
  const git = yield* GitCore;
  const gitHubCli = yield* GitHubCli;
  const serverConfig = yield* ServerConfig;
  const textGeneration = yield* TextGeneration;
  const serverSettingsService = yield* ServerSettingsService;
  const handledTurnStartKeys = yield* Cache.make<string, true>({
    capacity: HANDLED_TURN_START_KEY_MAX,
    timeToLive: HANDLED_TURN_START_KEY_TTL,
    lookup: () => Effect.succeed(true),
  });

  const hasHandledTurnStartRecently = (key: string) =>
    Cache.getOption(handledTurnStartKeys, key).pipe(
      Effect.flatMap((cached) =>
        Cache.set(handledTurnStartKeys, key, true).pipe(Effect.as(Option.isSome(cached))),
      ),
    );

  const threadModelSelections = new Map<string, ModelSelection>();
  const providerSessionRuntimeRepository = yield* ProviderSessionRuntimeRepository;

  // Selection of the last processed turn start, even one that failed, so dividers keep chaining.
  const lastRecordedModelSelectionByThread = new Map<string, ModelSelection>();

  // The persisted binding holds the last sent selection, so the baseline survives a server restart.
  const readPersistedTurnModelSelection = Effect.fn("readPersistedTurnModelSelection")(function* (
    threadId: ThreadId,
  ) {
    const runtime = yield* providerSessionRuntimeRepository
      .getByThreadId({ threadId })
      .pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isNone(runtime)) return undefined;
    const payload = runtime.value.runtimePayload;
    if (payload === null || typeof payload !== "object" || !("modelSelection" in payload)) {
      return undefined;
    }
    return Schema.is(ModelSelection)(payload.modelSelection) ? payload.modelSelection : undefined;
  });

  const readPreviousTurnModelSelection = Effect.fn("readPreviousTurnModelSelection")(function* (
    threadId: ThreadId,
  ) {
    const cached =
      lastRecordedModelSelectionByThread.get(threadId) ?? threadModelSelections.get(threadId);
    if (cached !== undefined) return cached;
    return yield* readPersistedTurnModelSelection(threadId);
  });

  const appendModelSwitchActivity = Effect.fn("appendModelSwitchActivity")(function* (input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
    readonly to: ModelSelection;
    readonly createdAt: string;
  }) {
    const from = yield* readPreviousTurnModelSelection(input.threadId);
    if (from === undefined || !isModelSelectionSwitch(from, input.to)) return;
    const payload: ThreadModelSwitchActivityPayload = {
      messageId: input.messageId,
      from,
      to: input.to,
    };
    yield* orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: serverCommandId("model-switch-activity"),
      threadId: input.threadId,
      activity: {
        id: EventId.makeUnsafe(crypto.randomUUID()),
        tone: "info",
        kind: THREAD_MODEL_SWITCH_ACTIVITY_KIND,
        summary: "Model changed",
        payload,
        turnId: null,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
  });

  const appendProviderFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly kind:
      | "provider.turn.start.failed"
      | "provider.turn.start.failed.missing-cwd"
      | "provider.turn.interrupt.failed"
      | "provider.approval.respond.failed"
      | "provider.user-input.respond.failed"
      | "provider.session.stop.failed"
      | "provider.runtime-mode.set.failed";
    readonly summary: string;
    readonly detail: string;
    readonly turnId: TurnId | null;
    readonly createdAt: string;
    readonly requestId?: string;
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: serverCommandId("provider-failure-activity"),
      threadId: input.threadId,
      activity: {
        id: EventId.makeUnsafe(crypto.randomUUID()),
        tone: "error",
        kind: input.kind,
        summary: input.summary,
        payload: {
          detail: input.detail,
          ...(input.requestId ? { requestId: input.requestId } : {}),
        },
        turnId: input.turnId,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });

  const setThreadSession = (input: {
    readonly threadId: ThreadId;
    readonly session: OrchestrationSession;
    readonly failedTurnStartMessageId?: MessageId;
    readonly createdAt: string;
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.session.set",
      commandId: serverCommandId("provider-session-set"),
      threadId: input.threadId,
      session: input.session,
      ...(input.failedTurnStartMessageId !== undefined
        ? { failedTurnStartMessageId: input.failedTurnStartMessageId }
        : {}),
      createdAt: input.createdAt,
    });

  const resolveThread = Effect.fn("resolveThread")(function* (threadId: ThreadId) {
    const readModel = yield* orchestrationEngine.getReadModel();
    return readModel.threads.get(threadId);
  });

  const settleFailedTurnStart = Effect.fn("settleFailedTurnStart")(function* (input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
    readonly detail: string;
    readonly createdAt: string;
  }) {
    const thread = yield* resolveThread(input.threadId);
    if (!thread) {
      return;
    }
    const session = thread.session;
    // Another turn is in flight (e.g. a rejected follow-up); its lifecycle still owns the session.
    if (session?.status === "running" && session.activeTurnId !== null) {
      return;
    }
    yield* setThreadSession({
      threadId: input.threadId,
      session: {
        threadId: input.threadId,
        providerName: session?.providerName ?? null,
        runtimeMode: session?.runtimeMode ?? thread.runtimeMode,
        status: session?.status === "stopped" ? "stopped" : "error",
        activeTurnId: null,
        lastError: input.detail.trim() || "Provider turn start failed",
        updatedAt: input.createdAt,
      },
      failedTurnStartMessageId: input.messageId,
      createdAt: input.createdAt,
    });
  });

  const ensureSessionForThread = Effect.fn("ensureSessionForThread")(function* (
    threadId: ThreadId,
    createdAt: string,
    options?: {
      readonly modelSelection?: ModelSelection;
      /** Start a brand-new provider session and drop the persisted resume cursor. */
      readonly discardResumeState?: boolean;
      /** Keep the thread "starting" until the provider reports turn.started. */
      readonly pendingTurnStart?: boolean;
    },
  ) {
    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.get(threadId);
    if (!thread) {
      return yield* Effect.die(new Error(`Thread '${threadId}' was not found in read model.`));
    }

    const desiredRuntimeMode = thread.runtimeMode;
    const currentProvider: ProviderKind | undefined = Schema.is(ProviderKind)(
      thread.session?.providerName,
    )
      ? thread.session.providerName
      : undefined;
    const requestedModelSelection = options?.modelSelection;
    const threadProvider: ProviderKind = currentProvider ?? thread.modelSelection.provider;
    if (
      requestedModelSelection !== undefined &&
      requestedModelSelection.provider !== threadProvider
    ) {
      return yield* new ProviderAdapterRequestError({
        provider: threadProvider,
        method: "thread.turn.start",
        detail: `Thread '${threadId}' is bound to provider '${threadProvider}' and cannot switch to '${requestedModelSelection.provider}'.`,
      });
    }
    const preferredProvider: ProviderKind = currentProvider ?? threadProvider;
    const desiredModelSelection = requestedModelSelection ?? thread.modelSelection;
    if (options?.pendingTurnStart === true && thread.session?.status !== "running") {
      yield* setThreadSession({
        threadId,
        session: {
          threadId,
          status: "starting",
          providerName: thread.session?.providerName ?? preferredProvider,
          runtimeMode: desiredRuntimeMode,
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      });
    }
    const effectiveCwd = resolveThreadWorkspaceCwd({
      thread,
      projects: readModel.projects,
    });

    const resolveActiveSession = (threadId: ThreadId) =>
      providerService
        .listSessions()
        .pipe(Effect.map((sessions) => sessions.find((session) => session.threadId === threadId)));

    const startProviderSession = (input?: {
      readonly resumeCursor?: unknown;
      readonly provider?: ProviderKind;
    }) =>
      providerService.startSession(threadId, {
        threadId,
        ...(preferredProvider ? { provider: preferredProvider } : {}),
        ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
        modelSelection: desiredModelSelection,
        // A null cursor tells ProviderService to ignore the persisted resume state.
        ...(options?.discardResumeState
          ? { resumeCursor: null }
          : input?.resumeCursor !== undefined
            ? { resumeCursor: input.resumeCursor }
            : {}),
        runtimeMode: desiredRuntimeMode,
        ...(thread.systemPrompt ? { systemPrompt: thread.systemPrompt } : {}),
        ...(thread.title ? { title: thread.title } : {}),
        interactionMode: thread.interactionMode,
      });

    const bindSessionToThread = (session: ProviderSession) =>
      setThreadSession({
        threadId,
        session: {
          threadId,
          status:
            options?.pendingTurnStart === true && session.status === "ready"
              ? "starting"
              : mapProviderSessionStatusToOrchestrationStatus(session.status),
          providerName: session.provider,
          runtimeMode: desiredRuntimeMode,
          // Provider turn ids are not orchestration turn ids.
          activeTurnId: null,
          lastError: session.lastError ?? null,
          updatedAt: session.updatedAt,
        },
        createdAt,
      });

    // A projected session without a live provider session (e.g. after a restart) is not reusable.
    const activeSession = yield* resolveActiveSession(threadId);
    const existingSessionThreadId =
      thread.session &&
      thread.session.status !== "stopped" &&
      activeSession !== undefined &&
      !options?.discardResumeState
        ? thread.id
        : null;
    if (existingSessionThreadId) {
      const runtimeModeChanged = thread.runtimeMode !== thread.session?.runtimeMode;
      const providerChanged =
        requestedModelSelection !== undefined &&
        requestedModelSelection.provider !== currentProvider;
      // A thread moved to another worktree/project folder must not keep a
      // process rooted in the old cwd; resume it in the new one.
      const cwdChanged =
        activeSession?.cwd !== undefined &&
        effectiveCwd !== undefined &&
        activeSession.cwd !== effectiveCwd;
      const sessionModelSwitch =
        currentProvider === undefined
          ? "in-session"
          : (yield* providerService.getCapabilities(currentProvider)).sessionModelSwitch;
      const modelChanged =
        requestedModelSelection !== undefined &&
        requestedModelSelection.model !== activeSession?.model;
      const shouldRestartForModelChange = modelChanged && sessionModelSwitch === "restart-session";
      const previousModelSelection = threadModelSelections.get(threadId);
      // The Claude adapter applies model, effort and fast mode to the live
      // query; only an unknown prior selection or a thinking toggle needs a new process.
      const shouldRestartForModelSelectionChange =
        currentProvider === "claudeAgent" &&
        requestedModelSelection !== undefined &&
        (previousModelSelection === undefined ||
          claudeThinkingSetting(previousModelSelection) !==
            claudeThinkingSetting(requestedModelSelection));

      if (
        !runtimeModeChanged &&
        !providerChanged &&
        !cwdChanged &&
        !shouldRestartForModelChange &&
        !shouldRestartForModelSelectionChange
      ) {
        return existingSessionThreadId;
      }

      const resumeCursor =
        providerChanged || shouldRestartForModelChange
          ? undefined
          : (activeSession?.resumeCursor ?? undefined);
      yield* Effect.logInfo("provider command reactor restarting provider session", {
        threadId,
        existingSessionThreadId,
        currentProvider,
        desiredProvider: desiredModelSelection.provider,
        currentRuntimeMode: thread.session?.runtimeMode,
        desiredRuntimeMode: thread.runtimeMode,
        runtimeModeChanged,
        providerChanged,
        previousCwd: activeSession?.cwd,
        desiredCwd: effectiveCwd,
        cwdChanged,
        modelChanged,
        shouldRestartForModelChange,
        shouldRestartForModelSelectionChange,
        hasResumeCursor: resumeCursor !== undefined,
      });
      const restartedSession = yield* startProviderSession(
        resumeCursor !== undefined ? { resumeCursor } : undefined,
      );
      yield* Effect.logInfo("provider command reactor restarted provider session", {
        threadId,
        previousSessionId: existingSessionThreadId,
        restartedSessionThreadId: restartedSession.threadId,
        provider: restartedSession.provider,
        runtimeMode: restartedSession.runtimeMode,
        cwd: restartedSession.cwd,
      });
      yield* bindSessionToThread(restartedSession);
      return restartedSession.threadId;
    }

    const startedSession = yield* startProviderSession(undefined);
    yield* bindSessionToThread(startedSession);
    return startedSession.threadId;
  });

  const sendTurnForThread = Effect.fn("sendTurnForThread")(function* (input: {
    readonly threadId: ThreadId;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
    readonly modelSelection?: ModelSelection;
    readonly interactionMode?: "default" | "plan" | "ask";
    readonly createdAt: string;
    readonly discardResumeState?: boolean;
  }) {
    const thread = yield* resolveThread(input.threadId);
    if (!thread) {
      return;
    }
    yield* ensureSessionForThread(input.threadId, input.createdAt, {
      ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
      ...(input.discardResumeState ? { discardResumeState: true } : {}),
      pendingTurnStart: true,
    });
    if (input.modelSelection !== undefined) {
      threadModelSelections.set(input.threadId, input.modelSelection);
    }
    const normalizedInput = toNonEmptyProviderInput(input.messageText);
    const normalizedAttachments = input.attachments ?? [];
    const activeSession = yield* providerService
      .listSessions()
      .pipe(
        Effect.map((sessions) => sessions.find((session) => session.threadId === input.threadId)),
      );
    const sessionModelSwitch =
      activeSession === undefined
        ? "in-session"
        : (yield* providerService.getCapabilities(activeSession.provider)).sessionModelSwitch;
    const requestedModelSelection =
      input.modelSelection ?? threadModelSelections.get(input.threadId) ?? thread.modelSelection;
    const modelForTurn =
      sessionModelSwitch === "unsupported"
        ? activeSession?.model !== undefined
          ? {
              ...requestedModelSelection,
              model: activeSession.model,
            }
          : requestedModelSelection
        : input.modelSelection;

    yield* providerService.sendTurn({
      threadId: input.threadId,
      ...(normalizedInput ? { input: normalizedInput } : {}),
      ...(normalizedAttachments.length > 0 ? { attachments: normalizedAttachments } : {}),
      ...(modelForTurn !== undefined ? { modelSelection: modelForTurn } : {}),
      ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
    });
  });

  const maybeGenerateAndRenameWorktreeBranchForFirstTurn = Effect.fn(
    "maybeGenerateAndRenameWorktreeBranchForFirstTurn",
  )(function* (input: {
    readonly threadId: ThreadId;
    readonly branch: string | null;
    readonly worktreePath: string | null;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
  }) {
    if (!input.branch || !input.worktreePath) {
      return;
    }
    if (!isTemporaryWorktreeBranch(input.branch)) {
      return;
    }

    const oldBranch = input.branch;
    const cwd = input.worktreePath;
    const attachments = input.attachments ?? [];
    yield* Effect.gen(function* () {
      const settings = yield* serverSettingsService.getSettings;
      const naming = branchNamingOptionsFromSettings(settings);

      const generated = yield* textGeneration.generateBranchName({
        cwd,
        message: stripImageOnlyBootstrapPrompt(input.messageText),
        ...(attachments.length > 0 ? { attachments } : {}),
        naming,
        modelSelection: settings.textGenerationModelSelection,
      });
      if (!generated) return;

      const targetBranch = formatGeneratedBranchName(generated.branch, naming);
      // A name shaped like a placeholder would be renamed again on the next first-turn check.
      if (targetBranch === oldBranch || isTemporaryWorktreeBranch(targetBranch)) return;

      const renamed = yield* git.renameBranch({ cwd, oldBranch, newBranch: targetBranch });
      yield* orchestrationEngine.dispatch({
        type: "thread.meta.update",
        commandId: serverCommandId("worktree-branch-rename"),
        threadId: input.threadId,
        branch: renamed.branch,
        worktreePath: cwd,
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider command reactor failed to generate or rename worktree branch", {
          threadId: input.threadId,
          cwd,
          oldBranch,
          cause: Cause.pretty(cause),
        }),
      ),
    );
  });

  const maybeGenerateThreadTitleForFirstTurn = Effect.fn("maybeGenerateThreadTitleForFirstTurn")(
    function* (input: {
      readonly threadId: ThreadId;
      readonly cwd: string;
      readonly messageText: string;
      readonly attachments?: ReadonlyArray<ChatAttachment>;
      readonly titleSeed?: string;
    }) {
      const attachments = input.attachments ?? [];
      yield* Effect.gen(function* () {
        const { textGenerationModelSelection: modelSelection, threadTitleInstructions } =
          yield* serverSettingsService.getSettings;
        // Outside the retry, so a flaky model does not repeat the gh lookups.
        const linkedContext = yield* resolveThreadTitleLinkedContext({
          cwd: input.cwd,
          message: input.messageText,
          gitHubCli,
        });

        const generated = yield* textGeneration
          .generateThreadTitle({
            cwd: input.cwd,
            message: stripImageOnlyBootstrapPrompt(input.messageText),
            ...(attachments.length > 0 ? { attachments } : {}),
            ...titleInstructionsInput(threadTitleInstructions),
            ...(linkedContext ? { linkedContext } : {}),
            modelSelection,
          })
          .pipe(Effect.retry({ times: 2, schedule: Schedule.exponential("2 seconds") }));
        if (!generated) return;

        const thread = yield* resolveThread(input.threadId);
        if (!thread) return;
        if (!canReplaceThreadTitle(thread.title, input.titleSeed)) {
          return;
        }

        yield* orchestrationEngine.dispatch({
          type: "thread.meta.update",
          commandId: serverCommandId("thread-title-rename"),
          threadId: input.threadId,
          title: generated.title,
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("provider command reactor failed to generate or rename thread title", {
            threadId: input.threadId,
            cwd: input.cwd,
            cause: Cause.pretty(cause),
          }),
        ),
      );
    },
  );

  // One regeneration per thread at a time, so repeated clicks do not spawn one model CLI each.
  const titleRegenerationsInFlight = new Set<ThreadId>();

  const regenerateThreadTitle = Effect.fn("regenerateThreadTitle")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.title-regeneration-requested" }>,
  ) {
    const threadId = event.payload.threadId;
    return yield* Effect.gen(function* () {
      const thread = yield* resolveThread(threadId);
      if (!thread || thread.deletedAt !== null) {
        return titleRegenerationResult("unchanged");
      }
      const previousTitle = thread.title;
      const context = formatThreadTitleRegenerationContext(
        thread.messages.map((message) => ({
          role: message.role,
          text: message.text,
          attachments: message.attachments,
        })),
      );
      if (context.message.trim().length === 0) {
        return titleRegenerationResult("empty");
      }
      const readModel = yield* orchestrationEngine.getReadModel();
      const cwd = yield* resolveTitleRegenerationCwd({
        thread,
        projects: readModel.projects,
        fallbackCwd: serverConfig.cwd,
      });
      const { textGenerationModelSelection: modelSelection, threadTitleInstructions } =
        yield* serverSettingsService.getSettings;
      const linkedContext = yield* resolveThreadTitleLinkedContext({
        cwd,
        message: threadTitleLinkSourceFromMessages(thread.messages),
        gitHubCli,
      });
      const generated = yield* textGeneration
        .generateThreadTitle({
          cwd,
          message: context.message,
          ...(context.attachments.length > 0 ? { attachments: context.attachments } : {}),
          previousTitle,
          ...titleInstructionsInput(threadTitleInstructions),
          ...(linkedContext ? { linkedContext } : {}),
          modelSelection,
        })
        .pipe(Effect.retry({ times: 2, schedule: Schedule.exponential("2 seconds") }));
      if (!generated) return titleRegenerationResult("empty");
      if (generated.title === previousTitle) {
        return titleRegenerationResult("unchanged");
      }

      // A manual rename during generation wins over the generated title.
      const latest = yield* resolveThread(threadId);
      if (!latest || latest.deletedAt !== null || latest.title !== previousTitle) {
        return titleRegenerationResult("unchanged");
      }

      yield* orchestrationEngine.dispatch({
        type: "thread.meta.update",
        commandId: serverCommandId("thread-title-regenerate"),
        threadId,
        title: generated.title,
      });
      return titleRegenerationResult("updated");
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("provider command reactor failed to regenerate thread title", {
              threadId,
              cause: Cause.pretty(cause),
            }).pipe(
              Effect.as<ThreadTitleRegenerationResult>({
                outcome: "failed",
                ...titleRegenerationFailureDetail(cause),
              }),
            ),
      ),
    );
  });

  const settleThreadTitleRegeneration = (
    threadId: ThreadId,
    result: ThreadTitleRegenerationResult,
  ) =>
    orchestrationEngine
      .dispatch({
        type: "thread.title.regeneration.settle",
        commandId: serverCommandId("thread-title-regeneration-settle"),
        threadId,
        outcome: result.outcome,
        ...(result.detail !== undefined ? { detail: result.detail } : {}),
        createdAt: new Date().toISOString(),
      })
      .pipe(
        // Finalizers are uninterruptible: at shutdown skip this rather than wait on a stopping engine.
        Effect.interruptible,
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.logWarning("provider command reactor failed to settle title regeneration", {
                threadId,
                cause: Cause.pretty(cause),
              }),
        ),
      );

  // Threads with a compaction request in flight; a turn sent now would race it.
  const compactingThreadIds = new Set<ThreadId>();

  // Refuses a turn start: drops its pending turn row and leaves the session's state as it was.
  const rejectTurnStart = Effect.fn("rejectTurnStart")(function* (input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
    readonly summary: string;
    readonly detail: string;
    readonly createdAt: string;
  }) {
    yield* appendProviderFailureActivity({
      threadId: input.threadId,
      kind: "provider.turn.start.failed",
      summary: input.summary,
      detail: input.detail,
      turnId: null,
      createdAt: input.createdAt,
    });
    yield* dropPendingTurnStart(input);
  });

  const dropPendingTurnStart = Effect.fn("dropPendingTurnStart")(function* (input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
    readonly createdAt: string;
  }) {
    const thread = yield* resolveThread(input.threadId);
    if (!thread) {
      return;
    }
    yield* setThreadSession({
      threadId: input.threadId,
      session: {
        ...(thread.session ?? {
          threadId: input.threadId,
          status: "stopped" as const,
          providerName: null,
          runtimeMode: thread.runtimeMode,
          activeTurnId: null,
          lastError: null,
        }),
        updatedAt: input.createdAt,
      },
      failedTurnStartMessageId: input.messageId,
      createdAt: input.createdAt,
    });
  });

  const failCompaction = Effect.fn("failCompaction")(function* (input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
    readonly detail: string;
    readonly createdAt: string;
  }) {
    yield* appendProviderFailureActivity({
      threadId: input.threadId,
      kind: "provider.turn.start.failed",
      summary: "Context compaction failed",
      detail: input.detail,
      turnId: null,
      createdAt: input.createdAt,
    });
    const thread = yield* resolveThread(input.threadId);
    const session = thread?.session;
    if (!thread || (session?.status === "running" && session.activeTurnId !== null)) {
      return;
    }
    // A failed compaction loses nothing, so a live session goes back to ready, not error.
    const liveSession = (yield* providerService.listSessions()).find(
      (candidate) => candidate.threadId === input.threadId,
    );
    yield* setThreadSession({
      threadId: input.threadId,
      session: {
        threadId: input.threadId,
        providerName: session?.providerName ?? liveSession?.provider ?? null,
        runtimeMode: session?.runtimeMode ?? thread.runtimeMode,
        status: liveSession ? "ready" : "stopped",
        activeTurnId: null,
        lastError: null,
        updatedAt: input.createdAt,
      },
      failedTurnStartMessageId: input.messageId,
      createdAt: input.createdAt,
    });
  });

  const startThreadCompaction = Effect.fn("startThreadCompaction")(function* (input: {
    readonly thread: OrchestrationThread;
    readonly messageId: MessageId;
    readonly modelSelection: ModelSelection | undefined;
    readonly createdAt: string;
  }) {
    const threadId = input.thread.id;
    const reject = (detail: string) =>
      rejectTurnStart({
        threadId,
        messageId: input.messageId,
        summary: "Context compaction failed",
        detail,
        createdAt: input.createdAt,
      });
    const hasConversation = input.thread.messages.some(
      (message) =>
        message.id !== input.messageId &&
        message.role !== "system" &&
        !isCompactCommandMessage(message) &&
        !isCodexGoalControlMessage(message) &&
        !message.id.startsWith(GOAL_REPLY_MESSAGE_ID_PREFIX),
    );
    if (!hasConversation) {
      return yield* reject("Context compaction requires an existing conversation.");
    }
    const status = input.thread.session?.status;
    if (status === "running" || status === "starting" || compactingThreadIds.has(threadId)) {
      return yield* reject("Context compaction is unavailable while a provider turn is running.");
    }

    threadsStoppedByUser.delete(threadId);
    compactingThreadIds.add(threadId);
    // Lifecycle after acceptance comes from Codex's turn notifications through ingestion.
    yield* Effect.gen(function* () {
      yield* ensureSessionForThread(threadId, input.createdAt, {
        ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
        pendingTurnStart: true,
      });
      yield* providerService.compactThread({ threadId });
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : failCompaction({
              threadId,
              messageId: input.messageId,
              detail: formatFailureDetail(cause),
              createdAt: input.createdAt,
            }),
      ),
      Effect.ensuring(Effect.sync(() => compactingThreadIds.delete(threadId))),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("provider command reactor failed to record a compaction failure", {
              threadId,
              cause: Cause.pretty(cause),
            }),
      ),
      // Forked so a slow provider call does not hold up other threads.
      Effect.forkScoped,
    );
  });

  const appendGoalReply = Effect.fn("appendGoalReply")(function* (input: {
    readonly threadId: ThreadId;
    readonly text: string;
    readonly createdAt: string;
  }) {
    const messageId = MessageId.makeUnsafe(`${GOAL_REPLY_MESSAGE_ID_PREFIX}${crypto.randomUUID()}`);
    yield* orchestrationEngine.dispatch({
      type: "thread.message.assistant.delta",
      commandId: serverCommandId("goal-reply-delta"),
      threadId: input.threadId,
      messageId,
      delta: input.text,
      createdAt: input.createdAt,
    });
    yield* orchestrationEngine.dispatch({
      type: "thread.message.assistant.complete",
      commandId: serverCommandId("goal-reply-complete"),
      threadId: input.threadId,
      messageId,
      createdAt: input.createdAt,
    });
  });

  // Control commands start no native turn, so no checkpoint or rollback count comes of them.
  const runCodexGoalControl = Effect.fn("runCodexGoalControl")(function* (input: {
    readonly thread: OrchestrationThread;
    readonly messageId: MessageId;
    readonly command: Exclude<CodexGoalCommand, { readonly type: "set" }>;
    readonly modelSelection: ModelSelection | undefined;
    readonly createdAt: string;
  }) {
    const threadId = input.thread.id;
    const reject = (detail: string) =>
      rejectTurnStart({
        threadId,
        messageId: input.messageId,
        summary: "Goal command failed",
        detail,
        createdAt: input.createdAt,
      });
    const status = input.thread.session?.status;
    if (status === "running" || status === "starting") {
      return yield* reject("Goal commands are unavailable while a provider turn is running.");
    }
    const goalRequest = (request: ProviderGoalRequest) =>
      providerService.runGoalRequest({ threadId, request });
    const run = Effect.gen(function* () {
      yield* ensureSessionForThread(
        threadId,
        input.createdAt,
        input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {},
      );
      if (input.command.type === "clear") {
        const { cleared } = yield* goalRequest({ type: "clear" });
        return cleared === true ? "Goal cleared." : "No goal to clear.";
      }
      const { goal } = yield* goalRequest({ type: "get" });
      if (goal === null) {
        return "No goal is set.";
      }
      switch (input.command.type) {
        case "show":
          return describeProviderGoal(goal);
        case "pause":
          yield* goalRequest({ type: "set", status: "paused" });
          return "Goal paused. Send /goal resume to continue.";
        case "resume":
          // Codex starts the next goal turn itself once the goal is active.
          yield* goalRequest({ type: "set", status: "active" });
          return "Goal resumed.";
      }
    });
    yield* run.pipe(
      Effect.flatMap((text) => appendGoalReply({ threadId, text, createdAt: input.createdAt })),
      Effect.andThen(
        dropPendingTurnStart({
          threadId,
          messageId: input.messageId,
          createdAt: input.createdAt,
        }),
      ),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : reject(formatFailureDetail(cause)),
      ),
    );
  });

  // Puts back what a failed `/goal <objective>` replaced. A goal's usage cannot be restored.
  const undoCodexGoalReplace = Effect.fn("undoCodexGoalReplace")(function* (input: {
    readonly threadId: ThreadId;
    readonly previous: ProviderGoal | null;
    readonly createdAt: string;
  }) {
    const { threadId, createdAt } = input;
    // "set" cannot express complete, and a finished goal must not come back as paused.
    const previous = input.previous?.status === "complete" ? null : input.previous;
    const restored = yield* providerService
      .runGoalRequest({ threadId, request: { type: "clear" } })
      .pipe(
        Effect.andThen(
          previous === null
            ? Effect.void
            : providerService.runGoalRequest({
                threadId,
                request: { type: "set", objective: previous.objective, status: "paused" },
              }),
        ),
        Effect.as(true),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("provider command reactor failed to restore a Codex goal", {
                threadId,
                cause: Cause.pretty(cause),
              }).pipe(Effect.as(false)),
        ),
      );
    if (previous !== null) {
      yield* appendGoalReply({
        threadId,
        text: restored
          ? `Your previous goal is back, paused, with its usage reset: ${previous.objective}`
          : `Your previous goal was cleared and could not be restored: ${previous.objective}`,
        createdAt,
      });
    }
  });

  // Paused until the turn runs, so Codex does not start one of its own first.
  const sendCodexGoalTurn = Effect.fn("sendCodexGoalTurn")(function* (
    input: Parameters<typeof sendTurnForThread>[0],
    objective: string,
  ) {
    const { threadId } = input;
    yield* ensureSessionForThread(threadId, input.createdAt, {
      ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
      ...(input.discardResumeState ? { discardResumeState: true } : {}),
      pendingTurnStart: true,
    });
    const { goal: previous } = yield* providerService.runGoalRequest({
      threadId,
      request: { type: "get" },
    });
    // A new objective replaces the goal and what it has used so far.
    if (previous !== null) {
      yield* providerService.runGoalRequest({ threadId, request: { type: "clear" } });
    }
    // The session is already fresh; discarding again would lose the goal just set.
    const { discardResumeState: _discardResumeState, ...turnInput } = input;
    yield* providerService
      .runGoalRequest({ threadId, request: { type: "set", objective, status: "paused" } })
      .pipe(
        Effect.andThen(sendTurnForThread(turnInput)),
        // A stale session is retried fresh, and whatever goal it held is gone with it.
        Effect.tapCause((cause) =>
          Cause.hasInterruptsOnly(cause) || isStaleSessionFailure(cause)
            ? Effect.void
            : undoCodexGoalReplace({ threadId, previous, createdAt: input.createdAt }).pipe(
                Effect.catchCause((undoCause) =>
                  Cause.hasInterruptsOnly(undoCause)
                    ? Effect.failCause(undoCause)
                    : Effect.logWarning(
                        "provider command reactor failed to report a restored Codex goal",
                        { threadId, cause: Cause.pretty(undoCause) },
                      ),
                ),
              ),
        ),
      );
    // The turn is running by now, so a failure here must not fail its start.
    yield* providerService
      .runGoalRequest({ threadId, request: { type: "set", status: "active" } })
      .pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("provider command reactor failed to activate a Codex goal", {
                threadId,
                cause: Cause.pretty(cause),
              }),
        ),
      );
  });

  const processTurnStartRequested = Effect.fn("processTurnStartRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-start-requested" }>,
  ) {
    const key = turnStartKeyForEvent(event);
    if (yield* hasHandledTurnStartRecently(key)) {
      return;
    }

    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }

    const message = thread.messages.find((entry) => entry.id === event.payload.messageId);
    if (!message || message.role !== "user") {
      yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.start.failed",
        summary: "Provider turn start failed",
        detail: `User message '${event.payload.messageId}' was not found for turn start request.`,
        turnId: null,
        createdAt: event.payload.createdAt,
      });
      return;
    }

    const readModel = yield* orchestrationEngine.getReadModel();
    const threadCwd = resolveThreadWorkspaceCwd({ thread, projects: readModel.projects });
    const threadCwdExists = threadCwd
      ? yield* Effect.tryPromise(() => access(threadCwd).then(() => true)).pipe(
          Effect.catch(() => Effect.succeed(false)),
        )
      : true;
    if (threadCwd && !threadCwdExists) {
      const project = readModel.projects.get(thread.projectId);
      yield* orchestrationEngine.dispatch({
        type: "thread.activity.append",
        commandId: serverCommandId("provider-failure-activity"),
        threadId: event.payload.threadId,
        createdAt: event.payload.createdAt,
        activity: {
          id: EventId.makeUnsafe(crypto.randomUUID()),
          tone: "error",
          kind: "provider.turn.start.failed.missing-cwd",
          summary: `Workspace folder not found: ${threadCwd}`,
          payload: {
            detail: `The folder ${threadCwd} no longer exists on disk.`,
            missingCwd: threadCwd,
            threadId: event.payload.threadId,
            projectId: thread.projectId,
            projectTitle: project?.title ?? null,
            messageId: event.payload.messageId,
            messageText: message.text,
            ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
            ...(event.payload.modelSelection !== undefined
              ? { modelSelection: event.payload.modelSelection }
              : {}),
            interactionMode: event.payload.interactionMode,
          },
          turnId: null,
          createdAt: event.payload.createdAt,
        },
      });
      return;
    }

    const isCompact = isCompactCommandMessage(message);
    const turnProvider =
      event.payload.modelSelection?.provider ??
      thread.session?.providerName ??
      thread.modelSelection.provider;
    // Claude handles a typed /compact itself, so it keeps the ordinary send path.
    if (isCompact && turnProvider === "codex") {
      return yield* startThreadCompaction({
        thread,
        messageId: message.id,
        modelSelection: event.payload.modelSelection,
        createdAt: event.payload.createdAt,
      });
    }
    if (compactingThreadIds.has(event.payload.threadId)) {
      return yield* rejectTurnStart({
        threadId: event.payload.threadId,
        messageId: message.id,
        summary: "Provider turn start failed",
        detail: "Wait for context compaction to finish before sending another message.",
        createdAt: event.payload.createdAt,
      });
    }

    const goalCommand = turnProvider === "codex" ? parseCodexGoalMessage(message) : null;
    if (goalCommand !== null && goalCommand.type !== "set") {
      return yield* runCodexGoalControl({
        thread,
        messageId: message.id,
        command: goalCommand,
        modelSelection: event.payload.modelSelection,
        createdAt: event.payload.createdAt,
      });
    }
    const goalObjective = goalCommand?.type === "set" ? goalCommand.objective : null;
    if (
      goalObjective !== null &&
      (thread.session?.status === "running" || thread.session?.status === "starting")
    ) {
      return yield* rejectTurnStart({
        threadId: event.payload.threadId,
        messageId: message.id,
        summary: "Goal command failed",
        detail: "Goal commands are unavailable while a provider turn is running.",
        createdAt: event.payload.createdAt,
      });
    }
    // Refused before anything changes: replacing a goal clears the old one first.
    const goalObjectiveError =
      goalObjective !== null ? codexGoalObjectiveError(goalObjective) : null;
    if (goalObjectiveError !== null) {
      return yield* rejectTurnStart({
        threadId: event.payload.threadId,
        messageId: message.id,
        summary: "Goal command failed",
        detail: goalObjectiveError,
        createdAt: event.payload.createdAt,
      });
    }

    threadsStoppedByUser.delete(event.payload.threadId);

    // A /compact or a goal control is no first message: it must not name the thread or its branch.
    const isFirstUserMessageTurn =
      !isCompact &&
      thread.messages.filter(
        (entry) =>
          entry.role === "user" &&
          !isCompactCommandMessage(entry) &&
          !(turnProvider === "codex" && isCodexGoalControlMessage(entry)),
      ).length === 1;
    if (isFirstUserMessageTurn) {
      const generationCwd = threadCwd ?? serverConfig.cwd;
      const generationInput = {
        messageText: goalObjective ?? message.text,
        ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
        ...(event.payload.titleSeed !== undefined ? { titleSeed: event.payload.titleSeed } : {}),
      };

      yield* maybeGenerateAndRenameWorktreeBranchForFirstTurn({
        threadId: event.payload.threadId,
        branch: thread.branch,
        worktreePath: thread.worktreePath,
        ...generationInput,
      }).pipe(Effect.forkScoped);

      if (canReplaceThreadTitle(thread.title, event.payload.titleSeed)) {
        yield* maybeGenerateThreadTitleForFirstTurn({
          threadId: event.payload.threadId,
          cwd: generationCwd,
          ...generationInput,
        }).pipe(Effect.forkScoped);
      }
    }

    // The first turn has no previous selection to compare against.
    if (!isFirstUserMessageTurn) {
      yield* appendModelSwitchActivity({
        threadId: event.payload.threadId,
        messageId: message.id,
        to: event.payload.modelSelection ?? thread.modelSelection,
        createdAt: event.payload.createdAt,
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("provider command reactor failed to record model switch", {
            threadId: event.payload.threadId,
            cause: Cause.pretty(cause),
          }),
        ),
      );
    }
    if (event.payload.modelSelection !== undefined) {
      lastRecordedModelSelectionByThread.set(event.payload.threadId, event.payload.modelSelection);
    }

    const turnInput = {
      threadId: event.payload.threadId,
      messageText: goalObjective ?? message.text,
      ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
      ...(event.payload.modelSelection !== undefined
        ? { modelSelection: event.payload.modelSelection }
        : {}),
      interactionMode: event.payload.interactionMode,
      createdAt: event.payload.createdAt,
    };

    // A failed start must leave "starting", or the thread would look busy forever.
    const failTurnStart = (cause: Cause.Cause<unknown>) =>
      appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.start.failed",
        summary: "Provider turn start failed",
        detail: Cause.pretty(cause),
        turnId: null,
        createdAt: event.payload.createdAt,
      }).pipe(
        Effect.andThen(
          settleFailedTurnStart({
            threadId: event.payload.threadId,
            messageId: event.payload.messageId,
            detail: formatFailureDetail(cause),
            createdAt: event.payload.createdAt,
          }),
        ),
      );

    const sendTurn = (input: Parameters<typeof sendTurnForThread>[0]) =>
      goalObjective !== null ? sendCodexGoalTurn(input, goalObjective) : sendTurnForThread(input);

    yield* sendTurn(turnInput).pipe(
      Effect.catchCause((cause) => {
        if (!isStaleSessionFailure(cause)) {
          return failTurnStart(cause);
        }
        const stopStaleSession = providerService
          .stopSession({ threadId: event.payload.threadId })
          .pipe(Effect.catchCause(() => Effect.void));
        // A fresh session has no history, so "continue where you left off" would mean nothing.
        if (event.payload.messageId.startsWith(RESTART_CONTINUATION_MESSAGE_ID_PREFIX)) {
          return stopStaleSession.pipe(Effect.andThen(failTurnStart(cause)));
        }
        // Stale session — stop it and retry with a fresh session (the persisted
        // resume cursor is what went stale, so it must not be reused).
        return stopStaleSession.pipe(
          Effect.flatMap(() => sendTurn({ ...turnInput, discardResumeState: true })),
          Effect.catchCause(failTurnStart),
        );
      }),
    );
  });

  const processTurnInterruptRequested = Effect.fn("processTurnInterruptRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-interrupt-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }
    const hasSession = thread.session && thread.session.status !== "stopped";
    if (!hasSession) {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.interrupt.failed",
        summary: "Provider turn interrupt failed",
        detail: "No active provider session is bound to this thread.",
        turnId: event.payload.turnId ?? null,
        createdAt: event.payload.createdAt,
      });
    }

    // True while the thread still shows the interrupted turn as in flight.
    const interruptStillPending = (session: OrchestrationSession | null | undefined) =>
      session !== null &&
      session !== undefined &&
      session.status !== "stopped" &&
      session.status !== "ready" &&
      (event.payload.turnId === undefined ||
        session.activeTurnId === null ||
        session.activeTurnId === event.payload.turnId);

    // A failed interrupt would otherwise leave the thread "running" forever:
    // stop the session, mark it stopped and surface the failure.
    const recoverInterruptFailure = (cause: Cause.Cause<ProviderServiceError>) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.failCause(cause);
      }
      const detail = formatFailureDetail(cause);
      return Effect.gen(function* () {
        const latestThread = yield* resolveThread(event.payload.threadId);
        if (!interruptStillPending(latestThread?.session)) {
          return;
        }
        yield* Effect.logWarning("provider command reactor interrupt failed; stopping session", {
          threadId: event.payload.threadId,
          cause: Cause.pretty(cause),
        });

        yield* providerService.stopSession({ threadId: event.payload.threadId }).pipe(
          Effect.catchCause((stopCause) => {
            if (Cause.hasInterruptsOnly(stopCause)) {
              return Effect.failCause(stopCause);
            }
            return Effect.logWarning(
              "provider command reactor failed to stop session after interrupt failure",
              {
                threadId: event.payload.threadId,
                cause: Cause.pretty(stopCause),
                originalCause: detail,
              },
            );
          }),
        );
        // Appended even if the stop's own session events already settled the thread.
        yield* appendProviderFailureActivity({
          threadId: event.payload.threadId,
          kind: "provider.turn.interrupt.failed",
          summary: "Provider turn interrupt failed",
          detail,
          turnId: event.payload.turnId ?? null,
          createdAt: event.payload.createdAt,
        });

        const stoppedThread = yield* resolveThread(event.payload.threadId);
        const stoppedSession = stoppedThread?.session;
        if (!interruptStillPending(stoppedSession) || !stoppedSession) {
          return;
        }

        yield* setThreadSession({
          threadId: event.payload.threadId,
          session: {
            ...stoppedSession,
            status: "stopped",
            activeTurnId: null,
            lastError: detail,
            updatedAt: event.payload.createdAt,
          },
          createdAt: event.payload.createdAt,
        });
      });
    };

    // Orchestration turn ids are not provider turn ids, so interrupt by session.
    yield* providerService
      .interruptTurn({ threadId: event.payload.threadId })
      .pipe(Effect.catchCause(recoverInterruptFailure));
  });

  const processApprovalResponseRequested = Effect.fn("processApprovalResponseRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.approval-response-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }
    const hasSession = thread.session && thread.session.status !== "stopped";
    if (!hasSession) {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.approval.respond.failed",
        summary: "Provider approval response failed",
        detail: "No active provider session is bound to this thread.",
        turnId: null,
        createdAt: event.payload.createdAt,
        requestId: event.payload.requestId,
      });
    }

    yield* providerService
      .respondToRequest({
        threadId: event.payload.threadId,
        requestId: event.payload.requestId,
        decision: event.payload.decision,
      })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            yield* appendProviderFailureActivity({
              threadId: event.payload.threadId,
              kind: "provider.approval.respond.failed",
              summary: "Provider approval response failed",
              detail: isUnknownPendingApprovalRequestError(cause)
                ? stalePendingRequestDetail("approval", event.payload.requestId)
                : Cause.pretty(cause),
              turnId: null,
              createdAt: event.payload.createdAt,
              requestId: event.payload.requestId,
            });

            if (!isUnknownPendingApprovalRequestError(cause)) return;
          }),
        ),
      );
  });

  // The question outlived its provider callback: the answer goes back as a new user turn.
  const recoverLostUserInputAnswer = Effect.fn("recoverLostUserInputAnswer")(function* (input: {
    readonly thread: OrchestrationThread;
    readonly requestId: string;
    readonly answers: Readonly<Record<string, unknown>>;
    readonly createdAt: string;
    readonly settledBeforeResponse?: boolean;
  }) {
    const request = readUserInputRequestState(input.thread.activities, input.requestId);
    if (request.status === "resolved") {
      return "already-closed" as const;
    }
    // `starting` has no active turn yet, but its turn would still be cut short, unless the session
    // was idle before responding: then it is only the recovery that the response itself began.
    const session = input.thread.session;
    const isRecoveringForResponse =
      input.settledBeforeResponse === true &&
      session?.status === "starting" &&
      session.activeTurnId === null;
    if (request.status !== "open" || !(isSessionSettled(session) || isRecoveringForResponse)) {
      return "not-recovered" as const;
    }
    const { pairs } = readUserInputAnswerPairs(request.activity, input.answers);
    if (pairs.length === 0) {
      return "not-recovered" as const;
    }
    // A held row, so the restart rescan delivers it if this process dies before the turn starts.
    yield* orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: serverCommandId("async-answer-resolved"),
      threadId: input.thread.id,
      activity: {
        id: EventId.makeUnsafe(`async-answer:${input.requestId}`),
        tone: "info",
        kind: "user-input.resolved",
        summary: "User input submitted",
        payload: {
          requestId: input.requestId,
          responseMode: "message",
          answers: input.answers,
          held: true,
          replyText: formatUserInputAnswerPairs(pairs),
        },
        turnId: null,
        ...resolvedActivitySequence(request.activity),
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
    // Answered just now, so an earlier stop or failure does not hold it back, even if the session
    // is still starting and delivery has to wait for a later settle.
    threadsWithUserAnsweredHeldAnswer.add(input.thread.id);
    yield* deliverNextHeldAnswer(input.thread.id);
    return "recovered" as const;
  });

  const processUserInputResponseRequested = Effect.fn("processUserInputResponseRequested")(
    function* (
      event: Extract<ProviderIntentEvent, { type: "thread.user-input-response-requested" }>,
    ) {
      const thread = yield* resolveThread(event.payload.threadId);
      if (!thread) {
        return;
      }
      const hasSession = thread.session && thread.session.status !== "stopped";
      if (!hasSession) {
        const recovery = yield* recoverLostUserInputAnswer({
          thread,
          requestId: event.payload.requestId,
          answers: event.payload.answers,
          createdAt: event.payload.createdAt,
        });
        if (recovery !== "not-recovered") {
          return;
        }
        return yield* appendProviderFailureActivity({
          threadId: event.payload.threadId,
          kind: "provider.user-input.respond.failed",
          summary: "Provider user input response failed",
          detail: "No active provider session is bound to this thread.",
          turnId: null,
          createdAt: event.payload.createdAt,
          requestId: event.payload.requestId,
        });
      }

      const settledBeforeResponse = isSessionSettled(thread.session);
      yield* providerService
        .respondToUserInput({
          threadId: event.payload.threadId,
          requestId: event.payload.requestId,
          answers: event.payload.answers,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              const isLostCallback = isUnknownPendingUserInputRequestError(cause);
              if (isLostCallback) {
                // Re-read: responding may have recovered the session in the meantime.
                const latestThread = (yield* resolveThread(event.payload.threadId)) ?? thread;
                const recovery = yield* recoverLostUserInputAnswer({
                  thread: latestThread,
                  requestId: event.payload.requestId,
                  answers: event.payload.answers,
                  createdAt: event.payload.createdAt,
                  settledBeforeResponse,
                });
                if (recovery !== "not-recovered") {
                  return;
                }
              }
              yield* appendProviderFailureActivity({
                threadId: event.payload.threadId,
                kind: "provider.user-input.respond.failed",
                summary: "Provider user input response failed",
                detail: isLostCallback
                  ? stalePendingRequestDetail("user-input", event.payload.requestId)
                  : Cause.pretty(cause),
                turnId: null,
                createdAt: event.payload.createdAt,
                requestId: event.payload.requestId,
              });
            }),
          ),
        );
    },
  );

  const processSessionStopRequested = Effect.fn("processSessionStopRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.session-stop-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }

    const now = event.payload.createdAt;
    if (thread.session && thread.session.status !== "stopped") {
      const stopped = yield* providerService.stopSession({ threadId: thread.id }).pipe(
        Effect.as(true),
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            if (Cause.hasInterruptsOnly(cause)) {
              return yield* Effect.failCause(cause);
            }
            yield* appendProviderFailureActivity({
              threadId: thread.id,
              kind: "provider.session.stop.failed",
              summary: "Provider session stop failed",
              detail: formatFailureDetail(cause),
              turnId: null,
              createdAt: now,
            });
            return false;
          }),
        ),
      );
      if (!stopped) {
        // Clients marked the session closed when the stop was requested; it is still live.
        const current = (yield* resolveThread(thread.id))?.session ?? thread.session;
        yield* setThreadSession({
          threadId: thread.id,
          session: { ...current, updatedAt: now },
          createdAt: now,
        });
        return;
      }
    }

    yield* setThreadSession({
      threadId: thread.id,
      session: {
        threadId: thread.id,
        status: "stopped",
        providerName: thread.session?.providerName ?? null,
        runtimeMode: thread.session?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
        activeTurnId: null,
        lastError: thread.session?.lastError ?? null,
        updatedAt: now,
      },
      createdAt: now,
    });
  });

  // Between dispatch and its turn start event, the session still looks settled.
  const heldAnswerDeliveriesInFlight = new Set<ThreadId>();
  // Stops and interrupts the user asked for since the last turn start; a refused start or a goal
  // control starts no turn, so it leaves them in place.
  const threadsStoppedByUser = new Set<ThreadId>();
  // Lost-callback answers not yet sent; cleared by a later stop or interrupt.
  const threadsWithUserAnsweredHeldAnswer = new Set<ThreadId>();

  // One at a time, in order: the next answer waits for this one's turn to settle.
  const deliverNextHeldAnswer = Effect.fn("deliverNextHeldAnswer")(function* (threadId: ThreadId) {
    const thread = yield* resolveThread(threadId);
    if (
      !thread ||
      thread.deletedAt !== null ||
      thread.archivedAt !== null ||
      heldAnswerDeliveriesInFlight.has(threadId) ||
      compactingThreadIds.has(threadId) ||
      !isSessionSettled(thread.session)
    ) {
      return;
    }
    // Must not undo a stop, an interrupt or a failure. The answer stays held for the next settle.
    // Status "stopped" alone does not count: startup reconciliation sets it, and the rescan must
    // still deliver, which works because this set starts empty after a restart.
    if (
      !threadsWithUserAnsweredHeldAnswer.has(threadId) &&
      (threadsStoppedByUser.has(threadId) ||
        thread.latestTurn?.state === "interrupted" ||
        thread.latestTurn?.state === "error" ||
        thread.session?.status === "error" ||
        thread.session?.status === "interrupted")
    ) {
      return;
    }
    const held = findNextHeldUserInputAnswer(thread);
    if (!held) {
      threadsWithUserAnsweredHeldAnswer.delete(threadId);
      return;
    }
    heldAnswerDeliveriesInFlight.add(threadId);
    yield* orchestrationEngine
      .dispatch({
        type: "thread.turn.start",
        // Stable, so the command receipt keeps a repeat from sending the answer twice.
        commandId: CommandId.makeUnsafe(`async-answer:${threadId}:${held.requestId}`),
        threadId,
        message: {
          messageId: asyncAnswerMessageId(held.requestId),
          role: "user",
          text: held.text,
          attachments: [],
        },
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        createdAt: new Date().toISOString(),
      })
      .pipe(
        Effect.tap(() => Effect.sync(() => threadsWithUserAnsweredHeldAnswer.delete(threadId))),
        Effect.tapCause(() => Effect.sync(() => heldAnswerDeliveriesInFlight.delete(threadId))),
      );
  });

  const processDomainEvent = Effect.fn("processDomainEvent")(function* (
    event: ProviderIntentEvent,
  ) {
    yield* Effect.annotateCurrentSpan({
      "orchestration.event_type": event.type,
      "orchestration.thread_id": event.payload.threadId,
      ...(event.commandId ? { "orchestration.command_id": event.commandId } : {}),
    });
    yield* increment(orchestrationEventsProcessedTotal, {
      eventType: event.type,
    });
    switch (event.type) {
      case "thread.runtime-mode-set": {
        const thread = yield* resolveThread(event.payload.threadId);
        if (!thread?.session || thread.session.status === "stopped") {
          return;
        }
        // After a server restart the cache is empty; keep the last sent selection, not a newer thread default.
        const persistedModelSelection =
          threadModelSelections.get(event.payload.threadId) ??
          (yield* readPersistedTurnModelSelection(event.payload.threadId));
        const cachedModelSelection =
          persistedModelSelection?.provider ===
          (thread.session.providerName ?? thread.modelSelection.provider)
            ? persistedModelSelection
            : undefined;
        yield* ensureSessionForThread(
          event.payload.threadId,
          event.occurredAt,
          cachedModelSelection !== undefined ? { modelSelection: cachedModelSelection } : {},
        ).pipe(
          // E.g. Claude refuses to restart while background tasks run; the live process then keeps
          // the old permission mode, so tell the user instead of only logging.
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning("provider command reactor failed to apply runtime mode", {
                  threadId: event.payload.threadId,
                  cause: Cause.pretty(cause),
                }).pipe(
                  Effect.andThen(
                    appendProviderFailureActivity({
                      threadId: event.payload.threadId,
                      kind: "provider.runtime-mode.set.failed",
                      summary: "Runtime mode change was not applied",
                      detail: formatFailureDetail(cause),
                      turnId: null,
                      createdAt: event.occurredAt,
                    }),
                  ),
                ),
          ),
        );
        return;
      }
      case "thread.turn-start-requested":
        yield* processTurnStartRequested(event).pipe(
          Effect.ensuring(
            Effect.sync(() => heldAnswerDeliveriesInFlight.delete(event.payload.threadId)),
          ),
        );
        return;
      case "thread.session-set":
        yield* deliverNextHeldAnswer(event.payload.threadId);
        return;
      case "thread.turn-interrupt-requested":
        threadsStoppedByUser.add(event.payload.threadId);
        threadsWithUserAnsweredHeldAnswer.delete(event.payload.threadId);
        yield* processTurnInterruptRequested(event);
        return;
      case "thread.approval-response-requested":
        yield* processApprovalResponseRequested(event);
        return;
      case "thread.user-input-response-requested":
        yield* processUserInputResponseRequested(event);
        return;
      case "thread.session-stop-requested":
        threadsStoppedByUser.add(event.payload.threadId);
        threadsWithUserAnsweredHeldAnswer.delete(event.payload.threadId);
        yield* processSessionStopRequested(event);
        return;
      case "thread.title-regeneration-requested": {
        const threadId = event.payload.threadId;
        if (titleRegenerationsInFlight.has(threadId)) {
          yield* Effect.logDebug("thread title regeneration already in flight; skipping", {
            threadId,
          });
          return;
        }
        titleRegenerationsInFlight.add(threadId);
        let result: ThreadTitleRegenerationResult = { outcome: "failed" };
        // Forked so a slow model call does not hold up session commands behind it.
        yield* regenerateThreadTitle(event).pipe(
          Effect.tap((settled) =>
            Effect.sync(() => {
              result = settled;
            }),
          ),
          Effect.ensuring(
            Effect.suspend(() => {
              // Released first, so a click that follows the settled event is never skipped as a duplicate.
              titleRegenerationsInFlight.delete(threadId);
              return settleThreadTitleRegeneration(threadId, result);
            }),
          ),
          Effect.forkScoped,
        );
        return;
      }
    }
  });

  const processDomainEventSafely = (event: ProviderIntentEvent) =>
    processDomainEvent(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("provider command reactor failed to process event", {
          eventType: event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const processWorkItem = (item: ProviderIntentEvent | HeldAnswersRescan) =>
    item.type === "held-answers.rescan"
      ? deliverNextHeldAnswer(item.threadId).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning("provider command reactor failed to deliver a held answer", {
                  threadId: item.threadId,
                  cause: Cause.pretty(cause),
                }),
          ),
        )
      : processDomainEventSafely(item);

  const worker = yield* makeDrainableWorker(processWorkItem);
  // Wired here (not in server.ts) so the reaper shares this reactor's lifecycle.
  const sessionReaper = yield* makeProviderSessionReaper();

  const start: ProviderCommandReactorShape["start"] = Effect.fn("start")(function* () {
    // Subscribe synchronously BEFORE forking the consumer loop. See note in
    // CheckpointReactor.start for why this matters.
    const domainEventQueue = yield* orchestrationEngine.subscribeDomainEvents();
    yield* sessionReaper.start();

    yield* Effect.forkScoped(
      Effect.forever(
        PubSub.take(domainEventQueue).pipe(
          Effect.flatMap((event) => {
            if (event.type === "thread.session-set") {
              return isSessionSettled(event.payload.session) ? worker.enqueue(event) : Effect.void;
            }
            if (
              event.type === "thread.runtime-mode-set" ||
              event.type === "thread.turn-start-requested" ||
              event.type === "thread.turn-interrupt-requested" ||
              event.type === "thread.approval-response-requested" ||
              event.type === "thread.user-input-response-requested" ||
              event.type === "thread.session-stop-requested" ||
              event.type === "thread.title-regeneration-requested"
            ) {
              return worker.enqueue(event);
            }
            return Effect.void;
          }),
        ),
      ),
    );

    const readModel = yield* orchestrationEngine.getReadModel();
    for (const thread of readModel.threads.values()) {
      if (findNextHeldUserInputAnswer(thread)) {
        yield* worker.enqueue({ type: "held-answers.rescan", threadId: thread.id });
      }
    }
  });

  return {
    start,
    drain: worker.drain,
  } satisfies ProviderCommandReactorShape;
});

// The repository lets the embedded session reaper drop bindings of deleted threads.
export const ProviderCommandReactorLive = Layer.effect(ProviderCommandReactor, make).pipe(
  Layer.provide(ProviderSessionRuntimeRepositoryLive),
);
