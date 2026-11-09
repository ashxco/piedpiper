import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import readline from "node:readline";

import {
  ApprovalRequestId,
  EventId,
  ProviderItemId,
  type ProviderUserInputAnswers,
  ThreadId,
  TurnId,
  type ProviderApprovalDecision,
  type ProviderEvent,
  type ProviderSession,
  type ProviderTurnStartResult,
  RuntimeMode,
  ProviderInteractionMode,
} from "@piedpiper/contracts";
import { resolveSpawnCommand } from "@piedpiper/shared/windowsCommand";
import { Effect, ServiceMap } from "effect";

import { readCodexAccountSnapshot, resolveCodexModelForAccount } from "./provider/codexAccount";
import { buildCodexInitializeParams } from "./provider/codexAppServer";
import { supportsCodexApprovalsReviewer } from "./provider/codexCliVersion";
import type {
  ProviderGoalRequest,
  ProviderGoalResponse,
} from "./provider/Services/ProviderAdapter";
import { CODEX_GOAL_UNSUPPORTED_MESSAGE, codexGoalToProviderGoal } from "./codex/codexGoalCommand";
import { codexHomeEnv } from "./codex/homePath";
import { codexAppServerArgs } from "./provider/codexLaunchArgs";
import { codexGoalObjectiveError } from "./provider/goalObjective.ts";
import {
  type CodexCompactionTurn,
  type CodexRunningCommand,
  type CodexSessionContext,
  type CodexTurnRun,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type PendingApprovalRequest,
} from "./codex/sessionState";
import { stripCodexGeneratedImageBytes } from "./codex/generatedImages";
import {
  type CodexApprovalMethod,
  type CodexThreadSnapshot,
  type CodexKnownTurns,
  type CodexTurnHistoryEntry,
  CODEX_MCP_ELICITATION_METHOD,
  CODEX_PERMISSIONS_APPROVAL_METHOD,
  assertSupportedCodexCliVersion,
  buildCodexApprovalResponse,
  codexSessionAllowanceKey,
  hasCodexSessionAllowance,
  hasCodexUserInputQuestions,
  isCodexRevertPlanSettled,
  isResponse,
  isServerNotification,
  isServerRequest,
  isSessionAllowableApprovalMethod,
  normalizeProviderThreadId,
  parseThreadSnapshot,
  planCodexThreadRevert,
  readArray,
  readBoolean,
  readChildParentTurnId,
  readCodexTurnsPage,
  readObject,
  readProviderConversationId,
  readResumeCursorThreadId,
  readResumeThreadId,
  readRouteFields,
  readString,
  rememberCollabReceiverTurns,
  requestKindForMethod,
  shouldSuppressChildConversationNotification,
  shouldSuppressMemoryConsolidationMessage,
  toCodexTurnHistoryEntries,
  toMcpElicitationResponse,
  toTurnId,
} from "./codex/protocolHelpers";
import {
  buildCodexCapacityRetryWarning,
  CODEX_CAPACITY_MAX_RETRIES,
  codexCapacityRetryDelayMs,
  isCodexCapacityError,
  isCodexCompactCommand,
  isCodexErrorClassified,
} from "./codex/capacityRetry";

export { buildCodexInitializeParams } from "./provider/codexAppServer";
export { readCodexAccountSnapshot, resolveCodexModelForAccount } from "./provider/codexAccount";
export type { CodexThreadSnapshot, CodexThreadTurnSnapshot } from "./codex/protocolHelpers";

// `localImage` lets the app-server read the file itself so turn/start does not
// scale with image size; it shipped with app-server protocol v2 alongside turn/start.
export type CodexAppServerTurnAttachment =
  | { readonly type: "image"; readonly url: string }
  | { readonly type: "localImage"; readonly path: string };

type CodexTurnInputItem =
  | { type: "text"; text: string; text_elements: [] }
  | { type: "image"; url: string }
  | { type: "localImage"; path: string };

export interface CodexAppServerSendTurnInput {
  readonly threadId: ThreadId;
  readonly input?: string;
  readonly attachments?: ReadonlyArray<CodexAppServerTurnAttachment>;
  readonly model?: string;
  readonly serviceTier?: string | null;
  readonly effort?: string;
  readonly interactionMode?: ProviderInteractionMode;
}

export interface CodexAppServerStartSessionInput {
  readonly threadId: ThreadId;
  readonly provider?: "codex";
  readonly cwd?: string;
  readonly model?: string;
  /** null explicitly clears a tier set in the user's Codex config. */
  readonly serviceTier?: string | null;
  readonly resumeCursor?: unknown;
  readonly binaryPath: string;
  readonly homePath?: string;
  /** Extra `codex app-server` arguments, already resolved against the env override. */
  readonly launchArgs?: string;
  readonly runtimeMode: RuntimeMode;
}

// Re-export the helpers from codex/parsing.ts so existing imports of
// codexAppServerManager.ts (notably the test file) keep working.
export {
  ANSI_ESCAPE_REGEX,
  BENIGN_ERROR_LOG_SNIPPETS,
  CODEX_STDERR_LOG_REGEX,
  CODEX_THREAD_IN_USE_MESSAGE,
  RECOVERABLE_THREAD_RESUME_ERROR_SNIPPETS,
  buildCodexCollaborationMode,
  classifyCodexStderrLine,
  isArchivedThreadError,
  isCodexActiveWriterError,
  isRecoverableThreadResumeError,
  killChildTree,
  mapCodexRuntimeMode,
  normalizeCodexModelSlug,
  toCodexUserInputAnswer,
  toCodexUserInputAnswers,
} from "./codex/parsing";

import {
  appendCodexStderrTail,
  buildCodexCollaborationMode,
  CODEX_MAX_STDOUT_LINE_BYTES,
  CODEX_THREAD_IN_USE_MESSAGE,
  createCodexStdoutLineLimiter,
  classifyCodexStderrLine,
  formatCodexExitMessage,
  isArchivedThreadError,
  isCodexActiveWriterError,
  isCodexTerminalGoneError,
  isCodexUnsupportedMethodError,
  isRecoverableThreadResumeError,
  killChildTree,
  mapCodexRuntimeMode,
  normalizeCodexModelSlug,
  toCodexUserInputAnswers,
  waitForStreamEnd,
} from "./codex/parsing";

const CODEX_EXIT_STDERR_DRAIN_MS = 250;
const CODEX_STDOUT_CLOSE_EXIT_GRACE_MS = 250;
const CODEX_TURNS_PAGE_SIZE = 100;
const CODEX_TERMINATE_COMMAND_TIMEOUT_MS = 5_000;
const CODEX_COMPACTION_START_TIMEOUT_MS = 20_000;
const CODEX_ABANDONED_RETRY_WINDOW_MS = 60_000;
// Codex starts the next goal turn milliseconds after the last one completes; this covers it declining.
const CODEX_GOAL_CONTINUATION_GRACE_MS = 5_000;

/**
 * Config overrides sent on thread/start and thread/resume, layered above config.toml.
 * Codex 0.152 made the update_plan checklist opt-in, and its 1 s MCP startup grace
 * drops cold npx/uvx servers from the first turn; a hung server delays only that turn.
 */
const CODEX_THREAD_CONFIG = {
  "tools.update_plan.enabled": true,
  mcp_optional_startup_grace_ms: 10_000,
  // Tool calls stop waiting on the detailed summary requested on turn/start. Checked on CLI 0.166 only.
  "features.concurrent_reasoning_summaries": true,
} as const;

export interface CodexAppServerManagerEvents {
  event: [event: ProviderEvent];
}

export class CodexAppServerManager extends EventEmitter<CodexAppServerManagerEvents> {
  private readonly sessions = new Map<ThreadId, CodexSessionContext>();
  // Starts still in the pre-spawn version check, so stopSession/stopAll can cancel them.
  private readonly pendingStarts = new Map<ThreadId, { cancelled: boolean }>();

  private runPromise: (effect: Effect.Effect<unknown, never>) => Promise<unknown>;
  constructor(services?: ServiceMap.ServiceMap<never>) {
    super();
    this.runPromise = services ? Effect.runPromiseWith(services) : Effect.runPromise;
  }

  async startSession(input: CodexAppServerStartSessionInput): Promise<ProviderSession> {
    const threadId = input.threadId;
    const now = new Date().toISOString();
    let context: CodexSessionContext | undefined;
    const startToken = { cancelled: false };
    this.cancelPendingStart(threadId);
    this.pendingStarts.set(threadId, startToken);

    try {
      await this.disposeExistingSession(threadId);

      const resolvedCwd = input.cwd ?? process.cwd();

      const session: ProviderSession = {
        provider: "codex",
        status: "connecting",
        runtimeMode: input.runtimeMode,
        model: normalizeCodexModelSlug(input.model),
        cwd: resolvedCwd,
        threadId,
        createdAt: now,
        updatedAt: now,
      };

      const codexBinaryPath = input.binaryPath;
      const codexHomePath = input.homePath;
      const codexCliVersion = await assertSupportedCodexCliVersion({
        binaryPath: codexBinaryPath,
        cwd: resolvedCwd,
        ...(codexHomePath ? { homePath: codexHomePath } : {}),
      });
      if (startToken.cancelled) {
        throw new Error("Codex session was stopped before it became ready.");
      }
      this.pendingStarts.delete(threadId);
      // An overlapping start may have registered a session while the version check ran;
      // dispose it in the same tick as the spawn below so the slot cannot be raced again.
      void this.disposeExistingSession(threadId);
      const env = {
        ...process.env,
        ...codexHomeEnv(codexHomePath),
      };
      // Windows: a real codex.exe spawns directly; a .cmd shim gets one escaped cmd.exe line.
      const spawnCommand = resolveSpawnCommand(
        codexBinaryPath,
        codexAppServerArgs(input.launchArgs),
        { env },
      );
      const child = spawn(spawnCommand.command, [...spawnCommand.args], {
        cwd: resolvedCwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        shell: spawnCommand.shell,
      });
      const output = readline.createInterface({ input: child.stdout });

      context = {
        session,
        account: {
          type: "unknown",
          planType: null,
          sparkEnabled: true,
        },
        child,
        output,
        pending: new Map(),
        pendingApprovals: new Map(),
        pendingUserInputs: new Map(),
        collabReceiverTurns: new Map(),
        nextRequestId: 1,
        stopping: false,
      };

      this.sessions.set(threadId, context);
      this.attachProcessListeners(context);

      this.emitLifecycleEvent(context, "session/connecting", "Starting codex app-server");

      await this.sendRequest(context, "initialize", buildCodexInitializeParams());

      this.writeMessage(context, { method: "initialized" });
      try {
        const accountReadResponse = await this.sendRequest(context, "account/read", {});
        context.account = readCodexAccountSnapshot(accountReadResponse);
        await Effect.logDebug("codex app-server account resolved", {
          threadId,
          type: context.account.type,
          planType: context.account.planType,
          sparkEnabled: context.account.sparkEnabled,
        }).pipe(this.runPromise);
      } catch (error) {
        await Effect.logDebug("codex app-server account/read failed", {
          threadId,
          cause: error instanceof Error ? error.message : String(error),
        }).pipe(this.runPromise);
      }

      const supportsApprovalsReviewer = supportsCodexApprovalsReviewer(codexCliVersion);
      if (input.runtimeMode === "auto" && !supportsApprovalsReviewer) {
        // Otherwise Auto silently behaves as Supervised while the composer still shows "Auto".
        this.emitLifecycleEvent(
          context,
          "session/autoModeUnsupported",
          "Auto needs Codex CLI 0.124.0 or newer; running as Supervised.",
        );
        await Effect.logWarning("codex app-server auto mode needs a newer Codex CLI", {
          threadId,
          codexCliVersion,
        }).pipe(this.runPromise);
      }

      const normalizedModel = resolveCodexModelForAccount(
        normalizeCodexModelSlug(input.model),
        context.account,
      );
      const sessionOverrides = {
        model: normalizedModel ?? null,
        ...(input.serviceTier !== undefined ? { serviceTier: input.serviceTier } : {}),
        cwd: input.cwd ?? null,
        ...mapCodexRuntimeMode(input.runtimeMode ?? "full-access", {
          supportsApprovalsReviewer,
        }),
        config: CODEX_THREAD_CONFIG,
      };

      const threadStartParams = {
        ...sessionOverrides,
        experimentalRawEvents: false,
      };
      const resumeThreadId = readResumeThreadId(input);
      this.emitLifecycleEvent(
        context,
        "session/threadOpenRequested",
        resumeThreadId
          ? `Attempting to resume thread ${resumeThreadId}.`
          : "Starting a new Codex thread.",
      );
      await Effect.logInfo("codex app-server opening thread", {
        threadId,
        requestedRuntimeMode: input.runtimeMode,
        requestedModel: normalizedModel ?? null,
        requestedCwd: resolvedCwd,
        resumeThreadId: resumeThreadId ?? null,
      }).pipe(this.runPromise);

      let threadOpenMethod: "thread/start" | "thread/resume" = "thread/start";
      let threadOpenResponse: unknown;
      if (resumeThreadId) {
        try {
          threadOpenMethod = "thread/resume";
          threadOpenResponse = await this.resumeThread(context, resumeThreadId, {
            ...sessionOverrides,
            threadId: resumeThreadId,
            // Only the thread id is read from the response, so skip serializing the turn history.
            excludeTurns: true,
          });
        } catch (rawError) {
          const error = isCodexActiveWriterError(rawError)
            ? new Error(CODEX_THREAD_IN_USE_MESSAGE, { cause: rawError })
            : rawError;
          if (!isRecoverableThreadResumeError(error)) {
            this.emitErrorEvent(
              context,
              "session/threadResumeFailed",
              error instanceof Error ? error.message : "Codex thread resume failed.",
            );
            await Effect.logWarning("codex app-server thread resume failed", {
              threadId,
              requestedRuntimeMode: input.runtimeMode,
              resumeThreadId,
              recoverable: false,
              cause: rawError instanceof Error ? rawError.message : String(rawError),
            }).pipe(this.runPromise);
            throw error;
          }

          threadOpenMethod = "thread/start";
          this.emitLifecycleEvent(
            context,
            "session/threadResumeFallback",
            `Could not resume thread ${resumeThreadId}; started a new thread instead.`,
          );
          await Effect.logWarning("codex app-server thread resume fell back to fresh start", {
            threadId,
            requestedRuntimeMode: input.runtimeMode,
            resumeThreadId,
            recoverable: true,
            cause: error instanceof Error ? error.message : String(error),
          }).pipe(this.runPromise);
          threadOpenResponse = await this.sendRequest(context, "thread/start", threadStartParams);
        }
      } else {
        threadOpenMethod = "thread/start";
        threadOpenResponse = await this.sendRequest(context, "thread/start", threadStartParams);
      }

      const threadOpenRecord = readObject(threadOpenResponse);
      const threadIdRaw =
        readString(readObject(threadOpenRecord, "thread"), "id") ??
        readString(threadOpenRecord, "threadId");
      if (!threadIdRaw) {
        throw new Error(`${threadOpenMethod} response did not include a thread id.`);
      }
      const providerThreadId = threadIdRaw;
      if (context.stopping) {
        throw new Error("Codex session was stopped before it became ready.");
      }

      this.updateSession(context, {
        status: "ready",
        resumeCursor: { threadId: providerThreadId },
      });
      this.emitLifecycleEvent(
        context,
        "session/threadOpenResolved",
        `Codex ${threadOpenMethod} resolved.`,
      );
      await Effect.logInfo("codex app-server thread open resolved", {
        threadId,
        threadOpenMethod,
        requestedResumeThreadId: resumeThreadId ?? null,
        resolvedThreadId: providerThreadId,
        requestedRuntimeMode: input.runtimeMode,
      }).pipe(this.runPromise);
      this.emitLifecycleEvent(context, "session/ready", `Connected to thread ${providerThreadId}`);
      return { ...context.session };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to start Codex session.";
      if (this.pendingStarts.get(threadId) === startToken) {
        this.pendingStarts.delete(threadId);
      }
      if (startToken.cancelled) {
        // Stopped (or superseded) before spawning; nothing to dispose or report.
      } else if (context) {
        // A stopping context was already disposed (stopSession or a replacement start); stay quiet.
        if (!context.stopping) {
          this.updateSession(context, {
            status: "error",
            lastError: message,
          });
          this.emitErrorEvent(context, "session/startFailed", message);
          // An exited child already reported session/exited; just release it quietly.
          this.disposeSession(context, { emitLifecycleEvent: !context.exited });
        }
      } else {
        this.emitEvent({
          id: EventId.makeUnsafe(randomUUID()),
          kind: "error",
          provider: "codex",
          threadId,
          createdAt: new Date().toISOString(),
          method: "session/startFailed",
          message,
        });
      }
      throw new Error(message, { cause: error });
    }
  }

  // Disposal runs synchronously so a caller can replace the slot before yielding; only logging is async.
  private disposeExistingSession(threadId: ThreadId): Promise<unknown> {
    const existingContext = this.sessions.get(threadId);
    if (!existingContext) {
      return Promise.resolve();
    }
    const existingStatus = existingContext.session.status;
    let disposeError: unknown;
    try {
      // Silent dispose: a session/closed event here would mark the replacement as exited.
      this.disposeSession(existingContext, { emitLifecycleEvent: false });
    } catch (error) {
      disposeError = error;
    }
    return Effect.gen(function* () {
      yield* Effect.logWarning("codex app-server replacing existing session", {
        threadId,
        existingStatus,
      });
      if (disposeError !== undefined) {
        yield* Effect.logWarning("codex app-server failed to dispose existing session", {
          threadId,
          existingStatus,
          cause: disposeError instanceof Error ? disposeError.message : String(disposeError),
        });
      }
    }).pipe(this.runPromise);
  }

  async sendTurn(input: CodexAppServerSendTurnInput): Promise<ProviderTurnStartResult> {
    const context = this.requireSession(input.threadId);
    context.collabReceiverTurns.clear();
    context.abandonedRetry = undefined;
    context.goalStopRequested = false;
    context.goalTurnExpected = false;
    if (
      context.compactionTurn?.nativeTurnId === undefined &&
      !context.compactionTurn?.settleStart
    ) {
      context.compactionTurn = undefined;
    }

    const turnInput: Array<CodexTurnInputItem> = [];
    if (input.input) {
      turnInput.push({
        type: "text",
        text: input.input,
        text_elements: [],
      });
    }
    for (const attachment of input.attachments ?? []) {
      if (attachment.type === "image") {
        turnInput.push({
          type: "image",
          url: attachment.url,
        });
      } else if (attachment.type === "localImage") {
        turnInput.push({
          type: "localImage",
          path: attachment.path,
        });
      }
    }
    if (turnInput.length === 0) {
      throw new Error("Turn input must include text or attachments.");
    }

    const providerThreadId = readResumeThreadId({
      threadId: context.session.threadId,
      runtimeMode: context.session.runtimeMode,
      resumeCursor: context.session.resumeCursor,
    });
    if (!providerThreadId) {
      throw new Error("Session is missing provider resume thread id.");
    }
    const turnStartParams: {
      threadId: string;
      input: Array<CodexTurnInputItem>;
      model?: string;
      serviceTier?: string | null;
      effort?: string;
      summary: "detailed";
      collaborationMode?: {
        mode: "default" | "plan";
        settings: {
          model: string;
          reasoning_effort?: string;
        };
      };
    } = {
      threadId: providerThreadId,
      input: turnInput,
      summary: "detailed",
    };
    const normalizedModel = resolveCodexModelForAccount(
      normalizeCodexModelSlug(input.model ?? context.session.model),
      context.account,
    );
    if (normalizedModel) {
      turnStartParams.model = normalizedModel;
    }
    if (input.serviceTier !== undefined) {
      turnStartParams.serviceTier = input.serviceTier;
    }
    if (input.effort) {
      turnStartParams.effort = input.effort;
    }
    // Codex has no notion of "ask" mode (it's a Claude-only enforcement
    // path in canUseTool). Coerce "ask" to "default" so the request just
    // runs as a regular agent turn.
    const codexInteractionMode: "default" | "plan" | undefined =
      input.interactionMode === "ask" ? "default" : input.interactionMode;
    const collaborationMode = buildCodexCollaborationMode({
      ...(codexInteractionMode !== undefined ? { interactionMode: codexInteractionMode } : {}),
      ...(normalizedModel !== undefined ? { model: normalizedModel } : {}),
      ...(input.effort !== undefined ? { effort: input.effort } : {}),
    });
    if (collaborationMode) {
      turnStartParams.collaborationMode = collaborationMode;
    }

    await this.supersedeTurnRun(context);
    const run: CodexTurnRun = {
      retryParams: { ...turnStartParams, input: [] },
      retryable: !isCodexCompactCommand(input.input, input.attachments?.length ?? 0),
      attempt: 0,
      stopRequested: false,
      sawCapacityError: false,
    };
    context.turnRun = run;

    const turnStart = this.sendRequest(context, "turn/start", turnStartParams);
    // Only the response names the turn, so Stop and a newer send wait for it.
    run.starting = turnStart
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        delete run.starting;
      });

    let response: unknown;
    try {
      response = await turnStart;
    } catch (error) {
      if (context.turnRun === run) {
        context.turnRun = undefined;
      }
      throw error;
    }

    const turn = readObject(readObject(response), "turn");
    const turnIdRaw = readString(turn, "id");
    if (!turnIdRaw) {
      if (context.turnRun === run) {
        context.turnRun = undefined;
      }
      throw new Error("turn/start response did not include a turn id.");
    }
    // A hold also clears the native id: this turn finished in the response's chunk, so don't rebind it.
    if (context.turnRun === run && run.nativeTurnId === undefined && !run.goalHold) {
      this.bindTurnRun(context, run, turnIdRaw);
    }
    const turnId = run.logicalTurnId ?? TurnId.makeUnsafe(turnIdRaw);

    // A chunk can carry the response and turn/completed together, and then the turn is already over.
    if (context.turnRun === run) {
      this.updateSession(context, {
        status: "running",
        activeTurnId: turnId,
        ...(context.session.resumeCursor !== undefined
          ? { resumeCursor: context.session.resumeCursor }
          : {}),
      });
    }

    return {
      threadId: context.session.threadId,
      turnId,
      ...(context.session.resumeCursor !== undefined
        ? { resumeCursor: context.session.resumeCursor }
        : {}),
    };
  }

  async interruptTurn(threadId: ThreadId, turnId?: TurnId): Promise<void> {
    const context = this.requireSession(threadId);
    this.pauseGoalForStop(context);
    if (turnId !== undefined && context.capacityRetryStoppedTurns?.has(turnId)) {
      return;
    }
    const run = context.turnRun;
    const targetsRun =
      run !== undefined &&
      (turnId === undefined || turnId === run.logicalTurnId || turnId === run.nativeTurnId);
    let commandTurnId =
      (targetsRun ? run.logicalTurnId : undefined) ??
      this.logicalTurnId(context, turnId ?? context.session.activeTurnId);
    // Interrupting leaves commands running, so they are ended alongside it.
    let terminatingCommands = this.stopTurnCommands(context, commandTurnId);
    if (targetsRun) {
      if (run.retryTimer !== undefined && run.held) {
        this.endTurnRunInterrupted(context, run, run.held.completed);
        await terminatingCommands;
        return;
      }
      run.stopRequested = true;
      if (run.starting) {
        await run.starting;
        if (context.turnRun !== run) {
          await terminatingCommands;
          return;
        }
        // A first turn has no id until its turn/start is answered.
        if (commandTurnId === undefined && run.logicalTurnId !== undefined) {
          commandTurnId = run.logicalTurnId;
          terminatingCommands = this.stopTurnCommands(context, commandTurnId);
        }
      }
    }
    const nativeTurnId = targetsRun ? run.nativeTurnId : undefined;
    const effectiveTurnId = nativeTurnId ?? turnId ?? context.session.activeTurnId;

    const providerThreadId = readResumeThreadId({
      threadId: context.session.threadId,
      runtimeMode: context.session.runtimeMode,
      resumeCursor: context.session.resumeCursor,
    });
    if (!effectiveTurnId || !providerThreadId) {
      await terminatingCommands;
      return;
    }

    try {
      await this.sendRequest(context, "turn/interrupt", {
        threadId: providerThreadId,
        turnId: effectiveTurnId,
      });
    } catch (error) {
      if (targetsRun) {
        run.stopRequested = false;
      }
      if (commandTurnId !== undefined) {
        context.stoppedCommandTurns?.delete(commandTurnId);
      }
      throw error;
    }
    await terminatingCommands;
  }

  /** One call to Codex's native goal API; none of them starts a turn itself, though Codex may. */
  async runGoalRequest(
    threadId: ThreadId,
    request: ProviderGoalRequest,
  ): Promise<ProviderGoalResponse> {
    const context = this.requireSession(threadId);
    const providerThreadId = readResumeCursorThreadId(context.session.resumeCursor);
    if (!providerThreadId) {
      throw new Error("Session is missing a provider resume thread id.");
    }
    try {
      switch (request.type) {
        case "get": {
          const response = await this.sendRequest(context, "thread/goal/get", {
            threadId: providerThreadId,
          });
          const rawGoal = readObject(response, "goal");
          this.reportGoal(context, providerThreadId, rawGoal);
          return { goal: codexGoalToProviderGoal(rawGoal ?? null) };
        }
        case "clear": {
          const response = await this.sendRequest(context, "thread/goal/clear", {
            threadId: providerThreadId,
          });
          this.reportGoal(context, providerThreadId, undefined);
          return { goal: null, cleared: readBoolean(response, "cleared") === true };
        }
        case "set":
          return await this.setGoal(context, providerThreadId, request);
      }
    } catch (error) {
      if (isCodexUnsupportedMethodError(error)) {
        throw new Error(CODEX_GOAL_UNSUPPORTED_MESSAGE, { cause: error });
      }
      throw error;
    }
  }

  private async setGoal(
    context: CodexSessionContext,
    providerThreadId: string,
    request: Extract<ProviderGoalRequest, { readonly type: "set" }>,
  ): Promise<ProviderGoalResponse> {
    const objectiveError =
      request.objective === undefined ? null : codexGoalObjectiveError(request.objective);
    if (objectiveError !== null) throw new Error(objectiveError);
    const activating = request.status === "active";
    if (activating) {
      context.goalActivating = true;
      context.goalStopRequested = false;
    }
    try {
      const response = await this.sendRequest(context, "thread/goal/set", {
        threadId: providerThreadId,
        ...(request.objective !== undefined ? { objective: request.objective } : {}),
        status: request.status,
      });
      const rawGoal = readObject(response, "goal");
      this.reportGoal(context, providerThreadId, rawGoal);
      if (activating) {
        // Codex may answer before it starts the turn this activation asks for.
        context.goalTurnExpected = context.turnRun === undefined && context.goalStatus === "active";
      }
      return { goal: codexGoalToProviderGoal(rawGoal ?? null) };
    } finally {
      if (activating) {
        context.goalActivating = false;
        this.releaseGoalHoldUnlessActive(context);
      }
    }
  }

  /** Keeps goal state and the app's goal row current; an undefined goal means none. */
  private reportGoal(
    context: CodexSessionContext,
    providerThreadId: string,
    goal: Record<string, unknown> | undefined,
  ): void {
    context.goalStatus = goal ? (readString(goal, "status") ?? null) : null;
    const snapshot = JSON.stringify(goal ?? null);
    if (snapshot !== context.goalSnapshot) {
      context.goalSnapshot = snapshot;
      // No turn id: Codex keeps the goal across a rewind, so its row must outlive any one turn.
      this.emitEvent({
        id: EventId.makeUnsafe(randomUUID()),
        kind: "notification",
        provider: "codex",
        threadId: context.session.threadId,
        createdAt: new Date().toISOString(),
        method: goal ? "thread/goal/updated" : "thread/goal/cleared",
        payload: { threadId: providerThreadId, ...(goal ? { goal } : {}) },
      });
    }
    this.releaseGoalHoldUnlessActive(context);
  }

  private handleGoalNotification(
    context: CodexSessionContext,
    notification: JsonRpcNotification,
  ): void {
    const eventThreadId = readString(notification.params, "threadId");
    const ownThreadId = readResumeCursorThreadId(context.session.resumeCursor);
    // A subagent's goal is its own; only the root thread's belongs on this thread's row.
    if (eventThreadId && ownThreadId && eventThreadId !== ownThreadId) {
      return;
    }
    const providerThreadId = eventThreadId ?? ownThreadId;
    if (providerThreadId) {
      this.reportGoal(
        context,
        providerThreadId,
        notification.method === "thread/goal/updated"
          ? readObject(notification.params, "goal")
          : undefined,
      );
    }
  }

  /** Best effort, as Stop must still end the turn: an active goal would otherwise start the next one. */
  private pauseGoalForStop(context: CodexSessionContext): void {
    const goalKnown = context.goalStatus !== undefined && context.goalStatus !== null;
    if (goalKnown || context.goalActivating) {
      context.goalStopRequested = true;
    }
    context.goalTurnExpected = false;
    const providerThreadId = readResumeCursorThreadId(context.session.resumeCursor);
    if (providerThreadId && (context.goalStatus === "active" || context.goalActivating)) {
      this.pauseGoal(context, providerThreadId);
    }
  }

  private pauseGoal(context: CodexSessionContext, providerThreadId: string): void {
    void this.sendRequest(context, "thread/goal/set", {
      threadId: providerThreadId,
      status: "paused",
    }).catch(async (error: unknown) => {
      if (context.stopping || context.exited) {
        return;
      }
      await Effect.logWarning("codex app-server could not pause a goal", {
        threadId: context.session.threadId,
        cause: error instanceof Error ? error.message : String(error),
      }).pipe(this.runPromise);
    });
  }

  /**
   * Codex begins the next turn of an active goal right after the last one completes, so the user's
   * turn stays open across them: one running thread, one checkpoint, and Stop still reaches it.
   */
  private holdRunForGoalContinuation(
    context: CodexSessionContext,
    run: CodexTurnRun,
    completed: JsonRpcNotification,
  ): void {
    run.held = { ...(run.heldError ? { error: run.heldError } : {}), completed };
    run.goalHold = true;
    delete run.nativeTurnId;
    // Capacity state describes one failing turn, and this one finished.
    delete run.heldError;
    run.attempt = 0;
    run.sawCapacityError = false;
    run.retryTimer = setTimeout(() => {
      delete run.retryTimer;
      if (context.turnRun !== run || !run.goalHold) {
        return;
      }
      // A goal must not read as active once its work has ended; a late turn is then ended unseen.
      const providerThreadId = readResumeCursorThreadId(context.session.resumeCursor);
      if (providerThreadId && context.goalStatus === "active") {
        context.goalStopRequested = true;
        this.pauseGoal(context, providerThreadId);
      }
      this.releaseGoalHold(context, run);
    }, CODEX_GOAL_CONTINUATION_GRACE_MS);
  }

  private clearGoalHold(run: CodexTurnRun): void {
    if (run.retryTimer !== undefined) {
      clearTimeout(run.retryTimer);
      delete run.retryTimer;
    }
    delete run.goalHold;
  }

  private releaseGoalHold(context: CodexSessionContext, run: CodexTurnRun): void {
    const held = run.held;
    this.clearGoalHold(run);
    delete run.held;
    if (context.turnRun === run) {
      context.turnRun = undefined;
    }
    if (held?.error) {
      this.handleServerNotification(context, held.error);
    }
    if (held) {
      this.handleServerNotification(context, held.completed);
    }
  }

  private releaseGoalHoldUnlessActive(context: CodexSessionContext): void {
    const run = context.turnRun;
    if (run?.goalHold && context.goalStatus !== "active" && !context.goalActivating) {
      this.releaseGoalHold(context, run);
    }
  }

  /**
   * A turn Codex started on its own with no user turn to continue. One that follows the goal being
   * made active is the thread's next turn. Any other, like one racing a Stop, is ended unseen
   * rather than left working out of sight, and returns true.
   */
  private handleUnownedGoalTurn(
    context: CodexSessionContext,
    notification: JsonRpcNotification,
    turnId: TurnId | undefined,
  ): boolean {
    if (
      notification.method !== "turn/started" ||
      turnId === undefined ||
      context.turnRun !== undefined ||
      context.compactionTurn !== undefined
    ) {
      return false;
    }
    const eventThreadId = readString(notification.params, "threadId");
    const ownThreadId = readResumeCursorThreadId(context.session.resumeCursor);
    if (!ownThreadId || (eventThreadId && eventThreadId !== ownThreadId)) {
      return false;
    }
    if (!context.goalStopRequested && (context.goalActivating || context.goalTurnExpected)) {
      context.goalTurnExpected = false;
      (context.goalTurnIds ??= new Set()).add(turnId);
      context.turnRun = {
        logicalTurnId: turnId,
        nativeTurnId: turnId,
        retryParams: { threadId: ownThreadId, input: [] },
        // Nothing the user sent would be lost, and a retry would start a turn they did not ask for.
        retryable: false,
        attempt: 0,
        stopRequested: false,
        sawCapacityError: false,
      };
      return false;
    }
    if (!context.goalStopRequested && context.goalStatus !== "active") {
      return false;
    }
    (context.abandonedRetryTurns ??= new Set()).add(turnId);
    this.pauseGoal(context, ownThreadId);
    void this.sendRequest(context, "turn/interrupt", {
      threadId: ownThreadId,
      turnId,
    }).catch(() => undefined);
    return true;
  }

  private async stopTurnCommands(
    context: CodexSessionContext,
    turnId: TurnId | undefined,
  ): Promise<void> {
    if (turnId === undefined) {
      return;
    }
    (context.stoppedCommandTurns ??= new Set()).add(turnId);
    const commands = context.runningCommands?.get(turnId);
    if (commands) {
      await Promise.all(
        Array.from(commands.values(), (command) => this.terminateCommand(context, command)),
      );
    }
  }

  /** Best effort and never rejects: older CLIs lack the method, and Stop must still succeed. */
  private async terminateCommand(
    context: CodexSessionContext,
    command: CodexRunningCommand,
  ): Promise<void> {
    const processId = command.processId;
    const threadId =
      readProviderConversationId(command.startedParams) ??
      readResumeCursorThreadId(context.session.resumeCursor);
    if (processId === undefined || threadId === undefined || command.terminateRequested) {
      return;
    }
    command.terminateRequested = true;
    try {
      const response = await this.sendRequest(
        context,
        "thread/backgroundTerminals/terminate",
        { threadId, processId },
        CODEX_TERMINATE_COMMAND_TIMEOUT_MS,
      );
      if (
        readBoolean(response, "terminated") === false &&
        (await this.isBackgroundTerminalListed(context, threadId, processId))
      ) {
        throw new Error("Codex reported the command still running after terminating it.");
      }
    } catch (error) {
      if (
        context.stopping ||
        context.exited ||
        isCodexUnsupportedMethodError(error) ||
        isCodexTerminalGoneError(error)
      ) {
        return;
      }
      await Effect.logWarning("codex app-server could not end a stopped command", {
        threadId: context.session.threadId,
        processId,
        cause: error instanceof Error ? error.message : String(error),
      }).pipe(this.runPromise);
    }
  }

  private async isBackgroundTerminalListed(
    context: CodexSessionContext,
    threadId: string,
    processId: string,
  ): Promise<boolean> {
    const requestedCursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const response: unknown = await this.sendRequest(
        context,
        "thread/backgroundTerminals/list",
        { threadId, ...(cursor !== undefined ? { cursor } : {}) },
        CODEX_TERMINATE_COMMAND_TIMEOUT_MS,
      );
      const page = readObject(response);
      const terminals = Array.isArray(page?.data) ? page.data : [];
      if (terminals.some((terminal) => readString(terminal, "processId") === processId)) {
        return true;
      }
      cursor = readString(page, "nextCursor");
      if (cursor !== undefined && requestedCursors.has(cursor)) {
        return false;
      }
      if (cursor !== undefined) {
        requestedCursors.add(cursor);
      }
    } while (cursor !== undefined);
    return false;
  }

  /** Keeps running commands current; returns the params to emit, marking a stopped row. */
  private trackCommandLifecycle(
    context: CodexSessionContext,
    method: string,
    params: unknown,
    turnId: TurnId | undefined,
  ): unknown {
    if (turnId === undefined) {
      return params;
    }
    if (method === "item/commandExecution/terminalInteraction") {
      const itemId = readString(params, "itemId");
      const processId = readString(params, "processId");
      if (itemId && processId && context.closedCommandItems?.get(itemId) === true) {
        // The row already says stopped, so a process reported only now must still be ended.
        context.closedCommandItems.set(itemId, false);
        void this.terminateCommand(context, {
          startedParams: readObject(params) ?? {},
          processId,
        });
        return params;
      }
      const command = itemId ? context.runningCommands?.get(turnId)?.get(itemId) : undefined;
      if (command && processId && command.processId === undefined) {
        command.processId = processId;
        if (context.stoppedCommandTurns?.has(turnId)) {
          void this.terminateCommand(context, command);
        }
      }
      return params;
    }
    if (method !== "item/started" && method !== "item/completed") {
      return params;
    }
    const startedParams = readObject(params);
    const item = readObject(params, "item");
    const itemId = readString(item, "id");
    if (!startedParams || !item || !itemId || readString(item, "type") !== "commandExecution") {
      return params;
    }
    const status = readString(item, "status");
    if (method === "item/started") {
      if (status !== undefined && status !== "inProgress") {
        return params;
      }
      const processId = readString(item, "processId");
      const command: CodexRunningCommand = {
        startedParams,
        ...(processId !== undefined ? { processId } : {}),
      };
      const running = (context.runningCommands ??= new Map());
      const commands = running.get(turnId) ?? new Map<string, CodexRunningCommand>();
      commands.set(itemId, command);
      running.set(turnId, commands);
      if (context.stoppedCommandTurns?.has(turnId)) {
        void this.terminateCommand(context, command);
      }
      return params;
    }
    context.runningCommands?.get(turnId)?.delete(itemId);
    // Terminating a command makes Codex report it as failed.
    return status === "failed" && context.stoppedCommandTurns?.has(turnId)
      ? { ...startedParams, item: { ...item, status: "stopped" } }
      : params;
  }

  /** At turn end, closes what a stopped, failed or interrupted turn left open; a turn that finished may leave commands running. */
  private settleTurnCommands(
    context: CodexSessionContext,
    turnId: TurnId | undefined,
    turnStatus: string | undefined,
  ): void {
    if (turnId === undefined) {
      return;
    }
    const stopRequested = context.stoppedCommandTurns?.delete(turnId) === true;
    const commands = context.runningCommands?.get(turnId);
    context.runningCommands?.delete(turnId);
    const closedStatus =
      stopRequested || turnStatus === "interrupted"
        ? "stopped"
        : turnStatus === "failed"
          ? "failed"
          : undefined;
    if (!commands || !closedStatus) {
      return;
    }
    for (const [itemId, command] of commands) {
      (context.closedCommandItems ??= new Map()).set(itemId, stopRequested);
      const route = readRouteFields(command.startedParams);
      this.emitEvent({
        id: EventId.makeUnsafe(randomUUID()),
        kind: "notification",
        provider: "codex",
        threadId: context.session.threadId,
        createdAt: new Date().toISOString(),
        method: "item/completed",
        turnId,
        ...(route.itemId ? { itemId: route.itemId } : {}),
        payload: {
          ...command.startedParams,
          item: { ...readObject(command.startedParams, "item"), status: closedStatus },
        },
      });
    }
  }

  async readThread(threadId: ThreadId): Promise<CodexThreadSnapshot> {
    const context = this.requireSession(threadId);
    const providerThreadId = readResumeThreadId({
      threadId: context.session.threadId,
      runtimeMode: context.session.runtimeMode,
      resumeCursor: context.session.resumeCursor,
    });
    if (!providerThreadId) {
      throw new Error("Session is missing a provider resume thread id.");
    }

    const response = await this.sendRequest(context, "thread/read", {
      threadId: providerThreadId,
      includeTurns: true,
    });
    return parseThreadSnapshot("thread/read", response);
  }

  /** Starts a compaction turn; its progress and result arrive as ordinary notifications. */
  async compactThread(threadId: ThreadId): Promise<void> {
    const context = this.requireSession(threadId);
    const providerThreadId = readResumeThreadId({
      threadId: context.session.threadId,
      runtimeMode: context.session.runtimeMode,
      resumeCursor: context.session.resumeCursor,
    });
    if (!providerThreadId) {
      throw new Error("Session is missing a provider resume thread id.");
    }
    if (context.session.activeTurnId) {
      throw new Error("Context compaction is unavailable while a turn is running.");
    }

    context.abandonedRetry = undefined;
    const compaction: CodexCompactionTurn = { openItems: new Map() };
    context.compactionTurn = compaction;
    try {
      await this.sendRequest(context, "thread/compact/start", { threadId: providerThreadId });
    } catch (error) {
      if (context.compactionTurn === compaction) {
        context.compactionTurn = undefined;
      }
      // Older CLIs reject the method by name.
      if (isCodexUnsupportedMethodError(error)) {
        throw new Error("This Codex CLI cannot compact on demand. Update Codex and try again.", {
          cause: error,
        });
      }
      throw error;
    }
    if (compaction.nativeTurnId !== undefined) {
      return;
    }
    // The caller holds the thread as starting until the turn begins, so it must learn if it never does.
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        delete compaction.settleStart;
        reject(new Error("Codex accepted the compaction but never started it."));
      }, CODEX_COMPACTION_START_TIMEOUT_MS);
      compaction.settleStart = (error) => {
        clearTimeout(timeout);
        delete compaction.settleStart;
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };
    });
  }

  async rollbackThread(threadId: ThreadId, numTurns: number): Promise<CodexThreadSnapshot> {
    const context = this.requireSession(threadId);
    const providerThreadId = readResumeThreadId({
      threadId: context.session.threadId,
      runtimeMode: context.session.runtimeMode,
      resumeCursor: context.session.resumeCursor,
    });
    if (!providerThreadId) {
      throw new Error("Session is missing a provider resume thread id.");
    }
    if (!Number.isInteger(numTurns) || numTurns < 1) {
      throw new Error("numTurns must be an integer >= 1.");
    }

    // A retry still waiting would otherwise start a turn on the rewound history.
    const waitingRun = context.turnRun;
    if (waitingRun?.retryTimer !== undefined && waitingRun.held) {
      this.endTurnRunInterrupted(context, waitingRun, waitingRun.held.completed);
    }

    const metadata = await this.sendRequest(context, "thread/read", {
      threadId: providerThreadId,
      includeTurns: false,
    });
    const historyMode = readString(readObject(readObject(metadata), "thread"), "historyMode");
    const snapshot =
      historyMode === "paginated"
        ? await this.revertPaginatedThread(context, providerThreadId, numTurns)
        : await this.rollbackLegacyThread(context, providerThreadId, numTurns);
    this.updateSession(context, {
      status: "ready",
      activeTurnId: undefined,
    });
    return snapshot;
  }

  private knownTurns(context: CodexSessionContext): CodexKnownTurns {
    return {
      ...(context.compactionTurnIds ? { compactionTurnIds: context.compactionTurnIds } : {}),
      ...(context.capacityRetryTurns ? { retryTurnIds: context.capacityRetryTurns } : {}),
      ...(context.goalTurnIds ? { goalTurnIds: context.goalTurnIds } : {}),
    };
  }

  /** Whether a rollback could work, so a caller can avoid restoring files for a rewind that cannot. */
  async canRollbackThread(threadId: ThreadId): Promise<boolean> {
    const context = this.requireSession(threadId);
    const providerThreadId = readResumeCursorThreadId(context.session.resumeCursor);
    if (!providerThreadId) {
      return false;
    }
    const metadata = await this.sendRequest(context, "thread/read", {
      threadId: providerThreadId,
      includeTurns: false,
    });
    if (readString(readObject(readObject(metadata), "thread"), "historyMode") === "paginated") {
      return true;
    }
    try {
      // numTurns 0 is rejected before anything changes, on CLIs that have the method at all.
      await this.sendRequest(context, "thread/rollback", {
        threadId: providerThreadId,
        numTurns: 0,
      });
    } catch (error) {
      return !isCodexUnsupportedMethodError(error);
    }
    return true;
  }

  private async revertPaginatedThread(
    context: CodexSessionContext,
    providerThreadId: string,
    numTurns: number,
  ): Promise<CodexThreadSnapshot> {
    const known = this.knownTurns(context);
    const turns = await this.listThreadTurnsForRevert(context, providerThreadId, numTurns, known);
    const { beforeTurnId } = planCodexThreadRevert(turns, numTurns, known);
    if (beforeTurnId !== undefined) {
      await this.sendRequest(context, "thread/revert", {
        threadId: providerThreadId,
        beforeTurnId,
      });
    }
    // Like the thread/revert response, this has no turns: the listing stops at the revert point.
    return { threadId: providerThreadId, turns: [] };
  }

  private async listThreadTurnsForRevert(
    context: CodexSessionContext,
    providerThreadId: string,
    numTurns: number,
    known: CodexKnownTurns,
  ): Promise<ReadonlyArray<CodexTurnHistoryEntry>> {
    const turns: Array<CodexTurnHistoryEntry> = [];
    const requestedCursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const response: unknown = await this.sendRequest(context, "thread/turns/list", {
        threadId: providerThreadId,
        cursor,
        limit: CODEX_TURNS_PAGE_SIZE,
        sortDirection: "desc",
        itemsView: "summary",
      });
      const page = readCodexTurnsPage(response);
      turns.push(...page.turns);
      if (isCodexRevertPlanSettled(turns, numTurns, known)) {
        return turns;
      }
      cursor = page.nextCursor;
      if (cursor !== null) {
        if (requestedCursors.has(cursor)) {
          throw new Error("Codex thread history pagination repeated a cursor.");
        }
        requestedCursors.add(cursor);
      }
    } while (cursor !== null);
    return turns;
  }

  /** thread/rollback counts native turns, which capacity retries can outnumber checkpoints by. */
  private async legacyNativeTurnCount(
    context: CodexSessionContext,
    providerThreadId: string,
    numTurns: number,
  ): Promise<number> {
    try {
      const response = await this.sendRequest(context, "thread/read", {
        threadId: providerThreadId,
        includeTurns: true,
      });
      const turns = readArray(readObject(readObject(response), "thread"), "turns") ?? [];
      const { removedTurns } = planCodexThreadRevert(
        toCodexTurnHistoryEntries(turns).toReversed(),
        numTurns,
        this.knownTurns(context),
      );
      return removedTurns > 0 ? removedTurns : numTurns;
    } catch (error) {
      await Effect.logWarning("codex app-server could not read history before a rollback", {
        threadId: context.session.threadId,
        cause: error instanceof Error ? error.message : String(error),
      }).pipe(this.runPromise);
      return numTurns;
    }
  }

  private async rollbackLegacyThread(
    context: CodexSessionContext,
    providerThreadId: string,
    numTurns: number,
  ): Promise<CodexThreadSnapshot> {
    const nativeTurns = await this.legacyNativeTurnCount(context, providerThreadId, numTurns);
    try {
      const response = await this.sendRequest(context, "thread/rollback", {
        threadId: providerThreadId,
        numTurns: nativeTurns,
      });
      return parseThreadSnapshot("thread/rollback", response);
    } catch (error) {
      // Current CLIs dropped thread/rollback, and thread/revert refuses legacy threads.
      if (isCodexUnsupportedMethodError(error)) {
        throw new Error(
          "This Codex conversation is too old for this Codex CLI to rewind. Start a new thread to continue from here.",
          { cause: error },
        );
      }
      throw error;
    }
  }

  async respondToRequest(
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ): Promise<void> {
    const context = this.requireSession(threadId);
    const pendingRequest = context.pendingApprovals.get(requestId);
    if (!pendingRequest) {
      throw new Error(`Unknown pending approval request: ${requestId}`);
    }

    context.pendingApprovals.delete(requestId);
    if (
      decision === "acceptForSession" &&
      isSessionAllowableApprovalMethod(pendingRequest.method)
    ) {
      (context.sessionAllowedRequestKinds ??= new Set()).add(
        codexSessionAllowanceKey(pendingRequest.requestKind, pendingRequest.params),
      );
    }
    this.writeMessage(context, {
      id: pendingRequest.jsonRpcId,
      result: buildCodexApprovalResponse(pendingRequest.method, pendingRequest.params, decision),
    });

    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "notification",
      provider: "codex",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      method: "item/requestApproval/decision",
      turnId: pendingRequest.turnId,
      itemId: pendingRequest.itemId,
      requestId: pendingRequest.requestId,
      requestKind: pendingRequest.requestKind,
      payload: {
        requestId: pendingRequest.requestId,
        requestKind: pendingRequest.requestKind,
        decision,
      },
    });
  }

  async respondToUserInput(
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    answers: ProviderUserInputAnswers,
  ): Promise<void> {
    const context = this.requireSession(threadId);
    const pendingRequest = context.pendingUserInputs.get(requestId);
    if (!pendingRequest) {
      throw new Error(`Unknown pending user input request: ${requestId}`);
    }

    context.pendingUserInputs.delete(requestId);
    const codexAnswers = toCodexUserInputAnswers(answers);
    this.writeMessage(context, {
      id: pendingRequest.jsonRpcId,
      result: {
        answers: codexAnswers,
      },
    });

    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "notification",
      provider: "codex",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      method: "item/tool/requestUserInput/answered",
      turnId: pendingRequest.turnId,
      itemId: pendingRequest.itemId,
      requestId: pendingRequest.requestId,
      payload: {
        requestId: pendingRequest.requestId,
        answers: codexAnswers,
      },
    });
  }

  stopSession(threadId: ThreadId): void {
    this.cancelPendingStart(threadId);
    const context = this.sessions.get(threadId);
    if (!context) {
      return;
    }

    this.disposeSession(context, { emitLifecycleEvent: true });
  }

  private disposeSession(
    context: CodexSessionContext,
    options?: { readonly emitLifecycleEvent?: boolean },
  ): void {
    if (context.stopping) {
      return;
    }

    context.stopping = true;
    this.clearTurnRun(context);

    this.rejectPendingRequests(context, "Session stopped before request completed.");

    context.output.close();

    if (!context.child.killed) {
      killChildTree(context.child);
    }

    this.updateSession(context, {
      status: "closed",
      activeTurnId: undefined,
    });
    if (options?.emitLifecycleEvent !== false) {
      this.emitLifecycleEvent(context, "session/closed", "Session stopped");
    }
    this.forgetSession(context);
  }

  // Only the context that still owns the thread slot may remove it; a stale
  // child exiting after a restart must not evict the replacement session.
  private forgetSession(context: CodexSessionContext): void {
    const threadId = context.session.threadId;
    if (this.sessions.get(threadId) === context) {
      this.sessions.delete(threadId);
    }
  }

  private rejectPendingRequests(context: CodexSessionContext, reason: string): void {
    const pending = Array.from(context.pending.values());
    context.pending.clear();
    context.pendingApprovals.clear();
    context.pendingUserInputs.clear();
    for (const request of pending) {
      clearTimeout(request.timeout);
      request.reject(new Error(`${request.method} failed: ${reason}`));
    }
  }

  listSessions(): ProviderSession[] {
    return Array.from(this.sessions.values(), ({ session }) => ({
      ...session,
    }));
  }

  hasSession(threadId: ThreadId): boolean {
    return this.sessions.has(threadId);
  }

  private cancelPendingStart(threadId: ThreadId): void {
    const pendingStart = this.pendingStarts.get(threadId);
    if (pendingStart) {
      pendingStart.cancelled = true;
      this.pendingStarts.delete(threadId);
    }
  }

  stopAll(): void {
    for (const threadId of [...this.pendingStarts.keys()]) {
      this.cancelPendingStart(threadId);
    }
    for (const threadId of this.sessions.keys()) {
      this.stopSession(threadId);
    }
  }

  private requireSession(threadId: ThreadId): CodexSessionContext {
    const context = this.sessions.get(threadId);
    if (!context) {
      throw new Error(`Unknown session for thread: ${threadId}`);
    }

    if (context.session.status === "closed") {
      throw new Error(`Session is closed for thread: ${threadId}`);
    }

    return context;
  }

  private attachProcessListeners(context: CodexSessionContext): void {
    // Prepended so it counts each chunk before readline buffers it.
    context.child.stdout.prependListener(
      "data",
      createCodexStdoutLineLimiter(() => {
        context.stdoutOverflowed = true;
        this.endSessionOnTransportLoss(
          context,
          `codex app-server sent a message over ${CODEX_MAX_STDOUT_LINE_BYTES / (1024 * 1024)} MB.`,
        );
      }),
    );
    // stdout can close while the process keeps running, and requests would wait out their timeouts.
    context.child.stdout.once("close", () => {
      if (context.stopping || context.exited) {
        return;
      }
      // Node can end stdout before it reports a crashed process's exit, which says more.
      setTimeout(() => {
        this.endSessionOnTransportLoss(context, "codex app-server closed its output stream.");
      }, CODEX_STDOUT_CLOSE_EXIT_GRACE_MS).unref();
    });

    context.output.on("line", (line) => {
      if (context.stdoutOverflowed) {
        return;
      }
      try {
        this.handleStdoutLine(context, line);
      } catch (error) {
        // A throw here would be an uncaught exception on the readline emitter.
        if (context.stopping || context.exited) {
          return;
        }
        this.emitErrorEvent(
          context,
          "protocol/handlerError",
          error instanceof Error ? error.message : "Failed to handle codex app-server message.",
        );
      }
    });

    // Without a listener an EPIPE on stdin (child died mid-write) crashes the server.
    context.child.stdin.on("error", (error) => {
      if (context.stopping || context.exited) {
        return;
      }
      // A failed write means the transport is gone: fail in-flight requests now, not at timeout.
      const message = error.message || "codex app-server stdin errored.";
      this.rejectPendingRequests(context, message);
      this.updateSession(context, { status: "error", lastError: message });
      this.emitErrorEvent(context, "process/stdinError", message);
    });

    context.child.stderr.on("data", (chunk: Buffer) => {
      const raw = chunk.toString();
      context.stderrTail = appendCodexStderrTail(context.stderrTail ?? "", raw);
      const lines = raw.split(/\r?\n/g);
      for (const rawLine of lines) {
        const classified = classifyCodexStderrLine(rawLine);
        if (!classified) {
          continue;
        }

        this.emitNotificationEvent(context, "process/stderr", classified.message);
      }
    });

    context.child.on("error", (error) => {
      if (context.stopping || context.exited) {
        return;
      }
      // A spawn failure may never fire "exit", so pending requests must be failed here.
      const message = error.message || "codex app-server process errored.";
      this.rejectPendingRequests(context, message);
      this.updateSession(context, {
        status: "error",
        lastError: message,
      });
      this.emitErrorEvent(context, "process/error", message);
    });

    context.child.on("exit", (code, signal) => {
      if (context.stopping || context.exited) {
        return;
      }

      context.exited = true;
      // "exit" can fire before stderr is fully read; give it a moment so the reason is included.
      void waitForStreamEnd(context.child.stderr, CODEX_EXIT_STDERR_DRAIN_MS).then(() => {
        if (context.stopping) {
          return;
        }
        this.finishExitedSession(
          context,
          code,
          formatCodexExitMessage(code, signal, context.stderrTail),
        );
      });
    });
  }

  private endSessionOnTransportLoss(context: CodexSessionContext, message: string): void {
    if (context.stopping || context.exited) {
      return;
    }
    context.exited = true;
    context.output.close();
    killChildTree(context.child);
    this.finishExitedSession(context, null, message);
  }

  private finishExitedSession(
    context: CodexSessionContext,
    code: number | null,
    message: string,
  ): void {
    this.clearTurnRun(context);
    this.rejectPendingRequests(context, message);
    this.updateSession(context, {
      status: "closed",
      activeTurnId: undefined,
      lastError: code === 0 ? context.session.lastError : message,
    });
    this.emitLifecycleEvent(context, "session/exited", message);
    this.forgetSession(context);
  }

  private handleStdoutLine(context: CodexSessionContext, line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.emitErrorEvent(
        context,
        "protocol/parseError",
        "Received invalid JSON from codex app-server.",
      );
      return;
    }

    if (!parsed || typeof parsed !== "object") {
      this.emitErrorEvent(
        context,
        "protocol/invalidMessage",
        "Received non-object protocol message.",
      );
      return;
    }

    if (isServerRequest(parsed)) {
      this.handleServerRequest(context, parsed);
      return;
    }

    if (isServerNotification(parsed)) {
      this.handleServerNotification(context, parsed);
      return;
    }

    if (isResponse(parsed)) {
      this.handleResponse(context, parsed);
      return;
    }

    this.emitErrorEvent(
      context,
      "protocol/unrecognizedMessage",
      "Received protocol message in an unknown shape.",
    );
  }

  private isMemoryConsolidationMessage(
    context: CodexSessionContext,
    method: string,
    params: unknown,
  ): boolean {
    context.memoryConsolidationThreadIds ??= new Set();
    return shouldSuppressMemoryConsolidationMessage(
      context.memoryConsolidationThreadIds,
      method,
      params,
    );
  }

  // Codex settles requests itself (interrupt, turn end); free our entry and close the card.
  private settleResolvedServerRequest(
    context: CodexSessionContext,
    params: unknown,
  ):
    | { requestId: ApprovalRequestId; requestKind: PendingApprovalRequest["requestKind"] }
    | undefined {
    const rawRequestId = readObject(params)?.requestId;
    if (typeof rawRequestId !== "string" && typeof rawRequestId !== "number") {
      return undefined;
    }
    for (const [requestId, pending] of context.pendingApprovals) {
      if (pending.jsonRpcId === rawRequestId) {
        context.pendingApprovals.delete(requestId);
        return { requestId, requestKind: pending.requestKind };
      }
    }
    for (const [requestId, pending] of context.pendingUserInputs) {
      if (pending.jsonRpcId === rawRequestId) {
        context.pendingUserInputs.delete(requestId);
        this.emitEvent({
          id: EventId.makeUnsafe(randomUUID()),
          kind: "notification",
          provider: "codex",
          threadId: context.session.threadId,
          createdAt: new Date().toISOString(),
          method: "item/tool/requestUserInput/resolved",
          ...(pending.turnId ? { turnId: pending.turnId } : {}),
          ...(pending.itemId ? { itemId: pending.itemId } : {}),
          requestId,
          payload: params,
        });
        return undefined;
      }
    }
    return undefined;
  }

  private handleServerNotification(
    context: CodexSessionContext,
    rawNotification: JsonRpcNotification,
  ): void {
    let notification: JsonRpcNotification = {
      ...rawNotification,
      params: stripCodexGeneratedImageBytes(rawNotification.params),
    };
    if (this.isMemoryConsolidationMessage(context, notification.method, notification.params)) {
      return;
    }
    // Ahead of the turn routing below, as an update names a turn that may be dropped or held.
    if (
      notification.method === "thread/goal/updated" ||
      notification.method === "thread/goal/cleared"
    ) {
      this.handleGoalNotification(context, notification);
      return;
    }
    const establishedProviderThreadId = readResumeCursorThreadId(context.session.resumeCursor);
    if (notification.method === "thread/started" && establishedProviderThreadId) {
      // Other threads on the same app-server must never take over an established session.
      const startedThreadId = normalizeProviderThreadId(
        readString(readObject(notification.params)?.thread, "id"),
      );
      if (startedThreadId !== establishedProviderThreadId) {
        return;
      }
    }
    const resolvedRequest =
      notification.method === "serverRequest/resolved"
        ? this.settleResolvedServerRequest(context, notification.params)
        : undefined;
    const rawRoute = readRouteFields(notification.params);
    rememberCollabReceiverTurns(context, notification.params, rawRoute.turnId);
    const childParentTurnId = readChildParentTurnId(context, notification.params);
    const isChildConversation = childParentTurnId !== undefined;
    if (
      isChildConversation &&
      shouldSuppressChildConversationNotification(notification.method, notification.params)
    ) {
      return;
    }
    if (!isChildConversation) {
      if (this.dropAbandonedRetryTurn(context, notification, rawRoute.turnId)) {
        return;
      }
      if (this.handleUnownedGoalTurn(context, notification, rawRoute.turnId)) {
        return;
      }
      if (this.interceptForCapacityRetry(context, notification)) {
        return;
      }
      const settled = this.settleCompactionNotification(context, notification);
      if (!settled) {
        return;
      }
      notification = settled;
    }
    const routedTurnId = this.logicalTurnId(context, childParentTurnId ?? rawRoute.turnId);
    if (
      notification.method === "item/completed" &&
      rawRoute.itemId &&
      context.closedCommandItems?.delete(rawRoute.itemId)
    ) {
      return;
    }
    const eventPayload = this.trackCommandLifecycle(
      context,
      notification.method,
      notification.params,
      routedTurnId,
    );
    if (notification.method === "turn/completed") {
      this.settleTurnCommands(
        context,
        routedTurnId,
        readString(readObject(notification.params, "turn"), "status"),
      );
    }
    const textDelta =
      notification.method === "item/agentMessage/delta"
        ? readString(notification.params, "delta")
        : undefined;

    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "notification",
      provider: "codex",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      method: notification.method,
      ...(routedTurnId ? { turnId: routedTurnId } : {}),
      ...(rawRoute.itemId ? { itemId: rawRoute.itemId } : {}),
      ...(resolvedRequest
        ? { requestId: resolvedRequest.requestId, requestKind: resolvedRequest.requestKind }
        : {}),
      textDelta,
      payload: eventPayload,
    });

    if (notification.method === "thread/started") {
      const providerThreadId = normalizeProviderThreadId(
        readString(readObject(notification.params)?.thread, "id"),
      );
      if (providerThreadId && !establishedProviderThreadId) {
        this.updateSession(context, { resumeCursor: { threadId: providerThreadId } });
      }
      return;
    }

    if (notification.method === "turn/started") {
      if (isChildConversation) {
        return;
      }
      const turnId = toTurnId(readString(readObject(notification.params)?.turn, "id"));
      this.bindCompactionTurn(context, notification.params, turnId);
      this.updateSession(context, {
        status: "running",
        activeTurnId: this.logicalTurnId(context, turnId),
      });
      return;
    }

    if (notification.method === "turn/completed") {
      if (isChildConversation) {
        return;
      }
      context.collabReceiverTurns.clear();
      const turn = readObject(notification.params, "turn");
      const status = readString(turn, "status");
      const errorMessage = readString(readObject(turn, "error"), "message");
      this.updateSession(context, {
        status: status === "failed" ? "error" : "ready",
        activeTurnId: undefined,
        lastError: errorMessage ?? context.session.lastError,
      });
      return;
    }

    if (notification.method === "error") {
      if (isChildConversation) {
        return;
      }
      const message = readString(readObject(notification.params)?.error, "message");
      const willRetry = readBoolean(notification.params, "willRetry");

      this.updateSession(context, {
        status: willRetry ? "running" : "error",
        lastError: message ?? context.session.lastError,
      });
    }
  }

  private bindCompactionTurn(
    context: CodexSessionContext,
    params: unknown,
    turnId: TurnId | undefined,
  ): void {
    const compaction = context.compactionTurn;
    const eventThreadId = readString(params, "threadId");
    const ownThreadId = readResumeCursorThreadId(context.session.resumeCursor);
    if (
      !compaction ||
      compaction.nativeTurnId !== undefined ||
      !turnId ||
      (eventThreadId && ownThreadId && eventThreadId !== ownThreadId)
    ) {
      return;
    }
    compaction.nativeTurnId = turnId;
    (context.compactionTurnIds ??= new Set()).add(turnId);
    compaction.settleStart?.();
  }

  /**
   * A failed compaction loses nothing, so it reports through its own row and leaves the session
   * ready. Checked on CLI 0.166: it sends item/started, then error and a failed turn/completed,
   * and never completes the item. Returns the notification to process, if any.
   */
  private settleCompactionNotification(
    context: CodexSessionContext,
    notification: JsonRpcNotification,
  ): JsonRpcNotification | undefined {
    const compaction = context.compactionTurn;
    const nativeTurnId = compaction?.nativeTurnId;
    if (!compaction || nativeTurnId === undefined) {
      return notification;
    }
    const params = readObject(notification.params);
    if (notification.method === "item/started" || notification.method === "item/completed") {
      const item = readObject(params, "item");
      const itemId = readString(item, "id");
      if (
        params &&
        itemId &&
        readString(item, "type") === "contextCompaction" &&
        readString(params, "turnId") === nativeTurnId
      ) {
        if (notification.method === "item/started") {
          compaction.openItems.set(itemId, params);
        } else {
          compaction.openItems.delete(itemId);
        }
      }
      return notification;
    }
    if (notification.method === "error") {
      if (
        readString(params, "turnId") !== nativeTurnId ||
        readBoolean(params, "willRetry") === true
      ) {
        return notification;
      }
      const message = readString(readObject(params, "error"), "message");
      if (message) {
        compaction.errorMessage = message;
      }
      return undefined;
    }
    if (notification.method !== "turn/completed") {
      return notification;
    }
    const turn = readObject(params, "turn");
    if (readString(turn, "id") !== nativeTurnId) {
      return notification;
    }
    context.compactionTurn = undefined;
    const status = readString(turn, "status");
    if (status !== "failed" && status !== "interrupted") {
      return notification;
    }
    const message =
      status === "interrupted"
        ? "Stopped before it finished."
        : (readString(readObject(turn, "error"), "message") ?? compaction.errorMessage);
    const openItems =
      compaction.openItems.size > 0
        ? compaction.openItems
        : new Map([
            [
              `${nativeTurnId}:compaction`,
              {
                threadId: readString(params, "threadId"),
                turnId: nativeTurnId,
                item: { type: "contextCompaction", id: `${nativeTurnId}:compaction` },
              } as Record<string, unknown>,
            ],
          ]);
    for (const [itemId, startedParams] of openItems) {
      this.emitEvent({
        id: EventId.makeUnsafe(randomUUID()),
        kind: "notification",
        provider: "codex",
        threadId: context.session.threadId,
        createdAt: new Date().toISOString(),
        method: "item/completed",
        turnId: TurnId.makeUnsafe(nativeTurnId),
        itemId: ProviderItemId.makeUnsafe(itemId),
        payload: {
          ...startedParams,
          item: { ...readObject(startedParams, "item"), status: "failed" },
          ...(message ? { message } : {}),
        },
      });
    }
    return status === "failed"
      ? {
          method: notification.method,
          params: { ...params, turn: { ...turn, status: "completed", error: null } },
        }
      : notification;
  }

  /** A retry's turn/start can time out and the turn still begin; nothing owns it, so it is ended unseen. */
  private dropAbandonedRetryTurn(
    context: CodexSessionContext,
    notification: JsonRpcNotification,
    turnId: TurnId | undefined,
  ): boolean {
    if (turnId !== undefined && context.abandonedRetryTurns?.has(turnId)) {
      if (notification.method === "turn/completed") {
        context.abandonedRetryTurns.delete(turnId);
      }
      return true;
    }
    const abandoned = context.abandonedRetry;
    if (notification.method !== "turn/started" || !abandoned || turnId === undefined) {
      return false;
    }
    context.abandonedRetry = undefined;
    const providerThreadId = readResumeCursorThreadId(context.session.resumeCursor);
    if (Date.now() > abandoned.expiresAtMs || !providerThreadId) {
      return false;
    }
    (context.abandonedRetryTurns ??= new Set()).add(turnId);
    void this.sendRequest(context, "turn/interrupt", {
      threadId: providerThreadId,
      turnId,
    }).catch(() => undefined);
    return true;
  }

  private logicalTurnId(
    context: CodexSessionContext,
    turnId: TurnId | undefined,
  ): TurnId | undefined {
    return turnId === undefined ? undefined : (context.capacityRetryTurns?.get(turnId) ?? turnId);
  }

  private bindTurnRun(context: CodexSessionContext, run: CodexTurnRun, nativeTurnId: string): void {
    run.nativeTurnId = nativeTurnId;
    delete run.held;
    if (run.logicalTurnId === undefined) {
      // A send that lands in a goal's running turn joins the turn that one already belongs to.
      run.logicalTurnId =
        context.capacityRetryTurns?.get(nativeTurnId) ?? TurnId.makeUnsafe(nativeTurnId);
    } else {
      (context.capacityRetryTurns ??= new Map()).set(nativeTurnId, run.logicalTurnId);
    }
  }

  /** True when the notification belongs to a capacity retry and must not reach the app as is. */
  private interceptForCapacityRetry(
    context: CodexSessionContext,
    notification: JsonRpcNotification,
  ): boolean {
    const run = context.turnRun;
    if (!run) {
      return false;
    }
    const params = readObject(notification.params);

    if (notification.method === "turn/started") {
      const nativeTurnId = readString(readObject(params, "turn"), "id");
      const eventThreadId = readString(params, "threadId");
      const ownThreadId = readResumeCursorThreadId(context.session.resumeCursor);
      if (!nativeTurnId || (eventThreadId && ownThreadId && eventThreadId !== ownThreadId)) {
        return false;
      }
      // A send during a retry's turn/start waits for it, so this may be the old retry's late event.
      if (run.nativeTurnId === undefined && !context.capacityRetryTurns?.has(nativeTurnId)) {
        this.clearGoalHold(run);
        this.bindTurnRun(context, run, nativeTurnId);
      }
      // The logical turn already started, and a second start would look like a new one.
      return context.capacityRetryTurns?.has(nativeTurnId) === true;
    }

    if (notification.method === "error") {
      if (
        !run.retryable ||
        readString(params, "turnId") !== run.nativeTurnId ||
        !isCodexCapacityError(readObject(params, "error"))
      ) {
        return false;
      }
      run.sawCapacityError = true;
      // With willRetry Codex is retrying on its own, so this is only progress.
      if (readBoolean(params, "willRetry") === true) {
        return false;
      }
      run.heldError = notification;
      return true;
    }

    if (notification.method !== "turn/completed") {
      return false;
    }
    const turn = readObject(params, "turn");
    if (readString(turn, "id") !== run.nativeTurnId) {
      return false;
    }
    const turnError = readObject(turn, "error");
    const isCapacityFailure =
      run.retryable &&
      readString(turn, "status") === "failed" &&
      (isCodexErrorClassified(turnError) ? isCodexCapacityError(turnError) : run.sawCapacityError);
    if (isCapacityFailure && run.stopRequested) {
      this.endTurnRunInterrupted(context, run, notification);
      return true;
    }
    if (isCapacityFailure && run.attempt < CODEX_CAPACITY_MAX_RETRIES) {
      this.scheduleCapacityRetry(context, run, notification);
      return true;
    }
    if (
      readString(turn, "status") === "completed" &&
      !run.stopRequested &&
      (context.goalStatus === "active" || context.goalActivating)
    ) {
      this.holdRunForGoalContinuation(context, run, notification);
      return true;
    }

    context.turnRun = undefined;
    if (run.heldError) {
      this.handleServerNotification(context, run.heldError);
    }
    return false;
  }

  private scheduleCapacityRetry(
    context: CodexSessionContext,
    run: CodexTurnRun,
    completed: JsonRpcNotification,
  ): void {
    run.attempt += 1;
    run.held = { ...(run.heldError ? { error: run.heldError } : {}), completed };
    delete run.heldError;
    run.sawCapacityError = false;
    const delayMs = codexCapacityRetryDelayMs(run.attempt);
    const logicalTurnId = run.logicalTurnId;
    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "notification",
      provider: "codex",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      method: "error",
      ...(logicalTurnId ? { turnId: logicalTurnId } : {}),
      payload: buildCodexCapacityRetryWarning({
        turnId: logicalTurnId ?? "",
        attempt: run.attempt,
        delayMs,
      }),
    });
    run.retryTimer = setTimeout(() => this.startCapacityRetry(context, run), delayMs);
  }

  private startCapacityRetry(context: CodexSessionContext, run: CodexTurnRun): void {
    delete run.retryTimer;
    if (context.turnRun !== run || context.stopping || context.exited) {
      return;
    }
    delete run.nativeTurnId;
    run.starting = this.sendCapacityRetry(context, run).finally(() => {
      delete run.starting;
    });
  }

  private async sendCapacityRetry(context: CodexSessionContext, run: CodexTurnRun): Promise<void> {
    try {
      const response = await this.sendRequest(context, "turn/start", run.retryParams);
      const nativeTurnId = readString(readObject(readObject(response), "turn"), "id");
      if (!nativeTurnId) {
        throw new Error("turn/start response did not include a turn id.");
      }
      if (context.turnRun === run && run.nativeTurnId === undefined && !run.goalHold) {
        this.bindTurnRun(context, run, nativeTurnId);
      }
    } catch (error) {
      if (context.turnRun !== run || context.stopping || context.exited) {
        return;
      }
      // Unlike a rejection, a timeout says nothing about whether Codex started the turn.
      if (error instanceof Error && error.message.startsWith("Timed out waiting")) {
        context.abandonedRetry = { expiresAtMs: Date.now() + CODEX_ABANDONED_RETRY_WINDOW_MS };
      }
      await Effect.logWarning("codex app-server capacity retry failed to start", {
        threadId: context.session.threadId,
        attempt: run.attempt,
        cause: error instanceof Error ? error.message : String(error),
      }).pipe(this.runPromise);
      if (context.turnRun !== run) {
        return;
      }
      const held = run.held;
      if (run.stopRequested && held) {
        this.endTurnRunInterrupted(context, run, held.completed);
        return;
      }
      this.releaseHeldCapacityFailure(context, run);
    }
  }

  /** Lets the failure Codex reported through after all, since no retry is coming. */
  private releaseHeldCapacityFailure(context: CodexSessionContext, run: CodexTurnRun): void {
    context.turnRun = undefined;
    if (run.held?.error) {
      this.handleServerNotification(context, run.held.error);
    }
    if (run.held) {
      this.handleServerNotification(context, run.held.completed);
    }
  }

  private endTurnRunInterrupted(
    context: CodexSessionContext,
    run: CodexTurnRun,
    completed: JsonRpcNotification,
  ): void {
    if (run.retryTimer !== undefined) {
      clearTimeout(run.retryTimer);
      delete run.retryTimer;
    }
    context.turnRun = undefined;
    if (run.logicalTurnId) {
      (context.capacityRetryStoppedTurns ??= new Set()).add(run.logicalTurnId);
    }
    const params = readObject(completed.params);
    this.handleServerNotification(context, {
      method: "turn/completed",
      params: {
        ...params,
        turn: { ...readObject(params, "turn"), status: "interrupted", error: null },
      },
    });
  }

  /** A user send ends a retry that is still waiting; the send itself is what continues the thread. */
  private async supersedeTurnRun(context: CodexSessionContext): Promise<void> {
    const run = context.turnRun;
    if (!run) {
      return;
    }
    if (run.goalHold) {
      this.releaseGoalHold(context, run);
      return;
    }
    if (run.retryTimer !== undefined && run.held) {
      this.endTurnRunInterrupted(context, run, run.held.completed);
      return;
    }
    if (run.starting) {
      await run.starting;
    }
    if (context.turnRun === run) {
      context.turnRun = undefined;
      if (run.heldError) {
        this.handleServerNotification(context, run.heldError);
      }
    }
  }

  private clearTurnRun(context: CodexSessionContext): void {
    if (context.turnRun?.retryTimer !== undefined) {
      clearTimeout(context.turnRun.retryTimer);
    }
    context.turnRun = undefined;
    context.compactionTurn?.settleStart?.(new Error("Session ended before compaction started."));
    context.compactionTurn = undefined;
  }

  private handleServerRequest(context: CodexSessionContext, request: JsonRpcRequest): void {
    if (this.isMemoryConsolidationMessage(context, request.method, request.params)) {
      this.writeMessage(context, {
        id: request.id,
        error: {
          code: -32601,
          message: `Background memory consolidation request not supported: ${request.method}`,
        },
      });
      return;
    }
    if (
      request.method === CODEX_MCP_ELICITATION_METHOD &&
      toMcpElicitationResponse(request.params, "accept").action !== "accept"
    ) {
      // Nothing the user could approve would satisfy this form, so decline without prompting.
      this.writeMessage(context, { id: request.id, result: { action: "decline" } });
      return;
    }
    const rawRoute = readRouteFields(request.params);
    const childParentTurnId = readChildParentTurnId(context, request.params);
    // Elicitation and permission requests can arrive without a turnId; attribute them to the running turn.
    const fallbackTurnId =
      request.method === CODEX_MCP_ELICITATION_METHOD ||
      request.method === CODEX_PERMISSIONS_APPROVAL_METHOD
        ? context.session.activeTurnId
        : undefined;
    const effectiveTurnId = this.logicalTurnId(
      context,
      childParentTurnId ?? rawRoute.turnId ?? fallbackTurnId,
    );
    const requestKind = requestKindForMethod(request.method, request.params);
    if (
      requestKind &&
      isSessionAllowableApprovalMethod(request.method) &&
      hasCodexSessionAllowance(context.sessionAllowedRequestKinds, requestKind, request.params)
    ) {
      // Codex's own acceptForSession covers only that exact command or patch.
      this.writeMessage(context, { id: request.id, result: { decision: "acceptForSession" } });
      return;
    }
    let requestId: ApprovalRequestId | undefined;
    if (requestKind) {
      requestId = ApprovalRequestId.makeUnsafe(randomUUID());
      const pendingRequest: PendingApprovalRequest = {
        requestId,
        jsonRpcId: request.id,
        method: request.method as CodexApprovalMethod,
        params: request.params,
        requestKind,
        threadId: context.session.threadId,
        ...(effectiveTurnId ? { turnId: effectiveTurnId } : {}),
        ...(rawRoute.itemId ? { itemId: rawRoute.itemId } : {}),
      };
      context.pendingApprovals.set(requestId, pendingRequest);
    }

    if (request.method === "item/tool/requestUserInput") {
      if (!hasCodexUserInputQuestions(request.params)) {
        this.writeMessage(context, {
          id: request.id,
          error: { code: -32602, message: "requestUserInput needs at least one question." },
        });
        return;
      }
      requestId = ApprovalRequestId.makeUnsafe(randomUUID());
      context.pendingUserInputs.set(requestId, {
        requestId,
        jsonRpcId: request.id,
        threadId: context.session.threadId,
        ...(effectiveTurnId ? { turnId: effectiveTurnId } : {}),
        ...(rawRoute.itemId ? { itemId: rawRoute.itemId } : {}),
      });
    }

    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "request",
      provider: "codex",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      method: request.method,
      ...(effectiveTurnId ? { turnId: effectiveTurnId } : {}),
      ...(rawRoute.itemId ? { itemId: rawRoute.itemId } : {}),
      requestId,
      requestKind,
      payload: request.params,
    });

    if (requestKind) {
      return;
    }

    if (request.method === "item/tool/requestUserInput") {
      return;
    }

    this.writeMessage(context, {
      id: request.id,
      error: {
        code: -32601,
        message: `Unsupported server request: ${request.method}`,
      },
    });
  }

  private handleResponse(context: CodexSessionContext, response: JsonRpcResponse): void {
    const key = String(response.id);
    const pending = context.pending.get(key);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    context.pending.delete(key);

    if (response.error?.message) {
      pending.reject(new Error(`${pending.method} failed: ${String(response.error.message)}`));
      return;
    }

    pending.resolve(response.result);
  }

  private async resumeThread(
    context: CodexSessionContext,
    providerThreadId: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    try {
      return await this.sendRequest(context, "thread/resume", params);
    } catch (error) {
      if (!isArchivedThreadError(error)) {
        throw error;
      }
      await Effect.logInfo("codex app-server unarchiving thread before resume", {
        threadId: context.session.threadId,
        providerThreadId,
      }).pipe(this.runPromise);
      // Unarchive keeps the native history; the response itself is not needed.
      await this.sendRequest(context, "thread/unarchive", { threadId: providerThreadId });
      return await this.sendRequest(context, "thread/resume", params);
    }
  }

  private async sendRequest<TResponse>(
    context: CodexSessionContext,
    method: string,
    params: unknown,
    timeoutMs = 20_000,
  ): Promise<TResponse> {
    if (context.stopping) {
      throw new Error(`${method} failed: Session stopped before request completed.`);
    }
    const id = context.nextRequestId;
    context.nextRequestId += 1;

    const result = await new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        context.pending.delete(String(id));
        reject(new Error(`Timed out waiting for ${method}.`));
      }, timeoutMs);

      context.pending.set(String(id), {
        method,
        timeout,
        resolve,
        reject,
      });
      try {
        this.writeMessage(context, {
          method,
          id,
          params,
        });
      } catch (error) {
        clearTimeout(timeout);
        context.pending.delete(String(id));
        reject(
          new Error(`${method} failed: ${error instanceof Error ? error.message : String(error)}`, {
            cause: error,
          }),
        );
      }
    });

    return result as TResponse;
  }

  private writeMessage(context: CodexSessionContext, message: unknown): void {
    const encoded = JSON.stringify(message);
    if (!context.child.stdin.writable) {
      throw new Error("Cannot write to codex app-server stdin.");
    }

    context.child.stdin.write(`${encoded}\n`);
  }

  private emitLifecycleEvent(context: CodexSessionContext, method: string, message: string): void {
    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "session",
      provider: "codex",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      method,
      message,
    });
  }

  private emitErrorEvent(context: CodexSessionContext, method: string, message: string): void {
    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "error",
      provider: "codex",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      method,
      message,
    });
  }

  private emitNotificationEvent(
    context: CodexSessionContext,
    method: string,
    message: string,
  ): void {
    this.emitEvent({
      id: EventId.makeUnsafe(randomUUID()),
      kind: "notification",
      provider: "codex",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      method,
      message,
    });
  }

  private emitEvent(event: ProviderEvent): void {
    this.emit("event", event);
  }

  private updateSession(context: CodexSessionContext, updates: Partial<ProviderSession>): void {
    context.session = {
      ...context.session,
      ...updates,
      updatedAt: new Date().toISOString(),
    };
  }
}
