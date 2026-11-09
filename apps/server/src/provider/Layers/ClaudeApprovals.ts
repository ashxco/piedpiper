import type {
  CanUseTool,
  ElicitationRequest,
  ElicitationResult,
  Options as ClaudeQueryOptions,
  PermissionResult,
  PermissionUpdate,
} from "@anthropic-ai/claude-agent-sdk";
import {
  ApprovalRequestId,
  type CanonicalRequestType,
  type EventId,
  type ProviderApprovalDecision,
  type ProviderInteractionMode,
  type ProviderRuntimeEvent,
  type ProviderUserInputAnswers,
  type ThreadId,
  type TurnId,
  type UserInputQuestion,
} from "@piedpiper/contracts";
import {
  CLAUDE_RESUME_COMPACTION_COMPACT_ANSWER,
  CLAUDE_RESUME_COMPACTION_KEEP_ANSWER,
  CLAUDE_RESUME_COMPACTION_NEVER_ANSWER,
  claudeResumeCompactionAction,
  formatClaudeResumeCompactionQuestion,
} from "@piedpiper/shared/claudeCompaction";
import { Deferred, Effect, Random } from "effect";
import {
  PROVIDER,
  asCanonicalTurnId,
  asRuntimeRequestId,
  classifyRequestType,
  claudeApprovalDetail,
  extractExitPlanModePlan,
  nativeProviderRefs,
} from "./ClaudeAdapterHelpers.ts";
import {
  claudeApprovalPresentation,
  claudeMcpElicitationAcceptance,
  claudeMcpElicitationDetail,
  effectiveClaudeApprovalDecision,
  toSessionPermissionUpdates,
  claudeUserInputQuestions,
  claudeUserInputAnswers,
} from "./ClaudeApprovalHelpers.ts";

export interface PendingApproval {
  readonly requestType: CanonicalRequestType;
  readonly detail?: string;
  readonly suggestions?: ReadonlyArray<PermissionUpdate>;
  /** Claude forbids a standing grant, so "Always allow this session" is approved once. */
  readonly noStandingGrant?: boolean;
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

export interface PendingUserInput {
  readonly questions: ReadonlyArray<UserInputQuestion>;
  readonly answers: Deferred.Deferred<ProviderUserInputAnswers>;
  /** Unparks the waiting handler as cancelled; session teardown must run it. */
  readonly cancel: Effect.Effect<void>;
}

/** The only `request_user_dialog` kind Pied Piper renders: compact an old session on resume. */
export const CLAUDE_RESUME_DIALOG_KIND = "resume_return";

function dialogPayloadCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

/** The live fields permission callbacks read; the adapter owns and updates them. */
interface ClaudeApprovalContext {
  readonly session: { readonly threadId: ThreadId };
  readonly turnState: { readonly turnId: TurnId } | undefined;
  readonly stopped: boolean;
  readonly serverShuttingDown: boolean;
  readonly currentInteractionMode: ProviderInteractionMode;
}

/** Per-session approval state shared by SDK callbacks, response handlers and teardown. */
export function makeClaudeApprovals<Context extends ClaudeApprovalContext>({
  getContext,
  makeEventStamp,
  offerRuntimeEvent,
  emitProposedPlanCompleted,
  runFork,
}: {
  readonly getContext: Effect.Effect<Context | undefined>;
  readonly makeEventStamp: () => Effect.Effect<{ eventId: EventId; createdAt: string }>;
  readonly offerRuntimeEvent: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
  readonly emitProposedPlanCompleted: (
    context: Context,
    input: {
      readonly planMarkdown: string;
      readonly toolUseId?: string | undefined;
      readonly rawSource: "claude.sdk.permission";
      readonly rawMethod: string;
      readonly rawPayload: unknown;
    },
  ) => Effect.Effect<void>;
  readonly runFork: (effect: Effect.Effect<unknown>) => unknown;
}) {
  const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
  const pendingUserInputs = new Map<ApprovalRequestId, PendingUserInput>();

  const awaitApproval = Effect.fn("awaitClaudeApproval")(function* (
    requestId: ApprovalRequestId,
    approval: PendingApproval,
    signal: AbortSignal,
  ) {
    pendingApprovals.set(requestId, approval);
    const onAbort = () => {
      if (!pendingApprovals.has(requestId)) return;
      pendingApprovals.delete(requestId);
      runFork(Deferred.succeed(approval.decision, "cancel"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    // The request can already be aborted when the listener is attached.
    if (signal.aborted) onAbort();
    const decision = yield* Deferred.await(approval.decision).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          signal.removeEventListener("abort", onAbort);
          pendingApprovals.delete(requestId);
        }),
      ),
    );
    return effectiveClaudeApprovalDecision(decision, approval.noStandingGrant);
  });

  /**
   * Handle AskUserQuestion tool calls by emitting a `user-input.requested`
   * runtime event and waiting for the user to respond via `respondToUserInput`.
   */
  const handleAskUserQuestion = Effect.fn("handleAskUserQuestion")(function* (
    context: Context,
    toolInput: Record<string, unknown>,
    callbackOptions: { readonly signal: AbortSignal; readonly toolUseID?: string },
  ) {
    const requestId = ApprovalRequestId.makeUnsafe(yield* Random.nextUUIDv4);

    const questions = claudeUserInputQuestions(toolInput.questions);

    const answersDeferred = yield* Deferred.make<ProviderUserInputAnswers>();
    let aborted = false;
    const settleAsAborted = Effect.suspend(() => {
      if (!pendingUserInputs.has(requestId)) {
        return Effect.void;
      }
      aborted = true;
      pendingUserInputs.delete(requestId);
      return Deferred.succeed(answersDeferred, {} as ProviderUserInputAnswers).pipe(Effect.asVoid);
    });
    const pendingInput: PendingUserInput = {
      questions,
      answers: answersDeferred,
      cancel: settleAsAborted,
    };

    // Emit user-input.requested so the UI can present the questions.
    const requestedStamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "user-input.requested",
      eventId: requestedStamp.eventId,
      provider: PROVIDER,
      createdAt: requestedStamp.createdAt,
      threadId: context.session.threadId,
      ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
      requestId: asRuntimeRequestId(requestId),
      payload: { questions },
      providerRefs: nativeProviderRefs({
        providerItemId: callbackOptions.toolUseID,
      }),
      raw: {
        source: "claude.sdk.permission",
        method: "canUseTool/AskUserQuestion",
        payload: { toolName: "AskUserQuestion", input: toolInput },
      },
    });

    pendingUserInputs.set(requestId, pendingInput);

    // Handle abort (e.g. turn interrupted while waiting for user input).
    const onAbort = () => {
      runFork(settleAsAborted);
    };
    callbackOptions.signal.addEventListener("abort", onAbort, { once: true });
    // The abort can fire before the listener is attached, and then never reaches it.
    if (callbackOptions.signal.aborted) {
      yield* settleAsAborted;
    }

    // Block until the user provides answers.
    const answers = yield* Deferred.await(answersDeferred).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          callbackOptions.signal.removeEventListener("abort", onAbort);
          pendingUserInputs.delete(requestId);
        }),
      ),
    );

    // Emit user-input.resolved so the UI knows the interaction completed. A server quit leaves
    // the question open, so it can still be answered after the restart.
    if (!(aborted && context.serverShuttingDown)) {
      const resolvedStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "user-input.resolved",
        eventId: resolvedStamp.eventId,
        provider: PROVIDER,
        createdAt: resolvedStamp.createdAt,
        threadId: context.session.threadId,
        ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
        requestId: asRuntimeRequestId(requestId),
        payload: { answers },
        providerRefs: nativeProviderRefs({
          providerItemId: callbackOptions.toolUseID,
        }),
        raw: {
          source: "claude.sdk.permission",
          method: "canUseTool/AskUserQuestion/resolved",
          payload: { answers },
        },
      });
    }

    if (aborted) {
      return {
        behavior: "deny",
        message: "User cancelled tool execution.",
      } satisfies PermissionResult;
    }

    return {
      behavior: "allow",
      updatedInput: {
        questions: toolInput.questions,
        answers: claudeUserInputAnswers(questions, answers),
      },
    } satisfies PermissionResult;
  });

  const canUseToolEffect = Effect.fn("canUseTool")(function* (
    toolName: Parameters<CanUseTool>[0],
    toolInput: Parameters<CanUseTool>[1],
    callbackOptions: Parameters<CanUseTool>[2],
  ) {
    const context = yield* getContext;
    if (!context) {
      return {
        behavior: "deny",
        message: "Claude session context is unavailable.",
      } satisfies PermissionResult;
    }
    // stopSessionInternal already cancelled pending requests; nothing would settle a new one.
    if (context.stopped) {
      return {
        behavior: "deny",
        message: "Claude session is closed.",
      } satisfies PermissionResult;
    }

    // Handle AskUserQuestion: surface clarifying questions to the
    // user via the user-input runtime event channel, regardless of
    // runtime mode (plan mode relies on this heavily).
    if (toolName === "AskUserQuestion") {
      return yield* handleAskUserQuestion(context, toolInput, callbackOptions);
    }

    if (toolName === "ExitPlanMode") {
      const planMarkdown = extractExitPlanModePlan(toolInput);
      if (planMarkdown) {
        yield* emitProposedPlanCompleted(context, {
          planMarkdown,
          toolUseId: callbackOptions.toolUseID,
          rawSource: "claude.sdk.permission",
          rawMethod: "canUseTool/ExitPlanMode",
          rawPayload: {
            toolName,
            input: toolInput,
          },
        });
      }

      return {
        behavior: "deny",
        message:
          "The client captured your proposed plan. Stop here and wait for the user's feedback or implementation request in a later turn.",
      } satisfies PermissionResult;
    }

    // Ask mode: pure conversational. Block every tool with a friendly
    // deny message so the model has to respond in natural language.
    // Read from the live context ref so toggling between turns works
    // without restarting the session.
    if (context.currentInteractionMode === "ask") {
      return {
        behavior: "deny",
        message:
          "Ask mode is enabled. Tools are disabled — respond to the user conversationally without invoking any tools. The user can switch to Agent mode if they want tool access.",
      } satisfies PermissionResult;
    }

    // Under bypassPermissions the CLI only forwards what it refuses to bypass (Plan-mode writes,
    // "ask" rules, safety checks, policy-disabled bypass), so Full access still asks for these.
    const requestId = ApprovalRequestId.makeUnsafe(yield* Random.nextUUIDv4);
    const requestType = classifyRequestType(toolName);
    const detail = claudeApprovalDetail({
      toolName,
      toolInput,
      title: callbackOptions.title,
      description: callbackOptions.description,
    });
    const presentation = claudeApprovalPresentation({ detail, callbackOptions });
    const decisionDeferred = yield* Deferred.make<ProviderApprovalDecision>();
    const pendingApproval: PendingApproval = {
      requestType,
      detail,
      decision: decisionDeferred,
      ...(callbackOptions.suggestions ? { suggestions: callbackOptions.suggestions } : {}),
      ...(presentation.noStandingGrant ? { noStandingGrant: true } : {}),
    };

    const requestedStamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "request.opened",
      eventId: requestedStamp.eventId,
      provider: PROVIDER,
      createdAt: requestedStamp.createdAt,
      threadId: context.session.threadId,
      ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
      requestId: asRuntimeRequestId(requestId),
      payload: {
        requestType,
        detail,
        ...presentation,
        args: {
          toolName,
          input: toolInput,
          ...(callbackOptions.toolUseID ? { toolUseId: callbackOptions.toolUseID } : {}),
        },
      },
      providerRefs: nativeProviderRefs({
        providerItemId: callbackOptions.toolUseID,
      }),
      raw: {
        source: "claude.sdk.permission",
        method: "canUseTool/request",
        payload: {
          toolName,
          input: toolInput,
        },
      },
    });

    const decision = yield* awaitApproval(requestId, pendingApproval, callbackOptions.signal);

    const resolvedStamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "request.resolved",
      eventId: resolvedStamp.eventId,
      provider: PROVIDER,
      createdAt: resolvedStamp.createdAt,
      threadId: context.session.threadId,
      ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
      requestId: asRuntimeRequestId(requestId),
      payload: {
        requestType,
        decision,
      },
      providerRefs: nativeProviderRefs({
        providerItemId: callbackOptions.toolUseID,
      }),
      raw: {
        source: "claude.sdk.permission",
        method: "canUseTool/decision",
        payload: {
          decision,
        },
      },
    });

    if (decision === "accept" || decision === "acceptForSession") {
      return {
        behavior: "allow",
        updatedInput: toolInput,
        ...(decision === "acceptForSession"
          ? {
              updatedPermissions: toSessionPermissionUpdates(toolName, pendingApproval.suggestions),
            }
          : {}),
      } satisfies PermissionResult;
    }

    return {
      behavior: "deny",
      message:
        decision === "cancel" ? "User cancelled tool execution." : "User declined tool execution.",
    } satisfies PermissionResult;
  });

  const handleUserDialog = Effect.fn("handleUserDialog")(function* (
    request: Parameters<NonNullable<ClaudeQueryOptions["onUserDialog"]>>[0],
    callbackOptions: Parameters<NonNullable<ClaudeQueryOptions["onUserDialog"]>>[1],
  ) {
    // The SDK contract: unrecognized kinds get `cancelled`, which applies the dialog's default.
    if (request.dialogKind !== CLAUDE_RESUME_DIALOG_KIND) {
      return { behavior: "cancelled" as const };
    }
    const context = yield* getContext;
    if (!context || context.stopped) {
      return { behavior: "cancelled" as const };
    }
    const question = formatClaudeResumeCompactionQuestion({
      ageMinutes: dialogPayloadCount(request.payload.sessionAgeMinutes),
      estimatedTokens: dialogPayloadCount(request.payload.estimatedTokens),
    });
    const result = yield* handleAskUserQuestion(
      context,
      {
        questions: [
          {
            header: "Resume session",
            question,
            options: [
              {
                label: CLAUDE_RESUME_COMPACTION_COMPACT_ANSWER,
                description: "Resume with a summary and use fewer tokens.",
              },
              {
                label: CLAUDE_RESUME_COMPACTION_KEEP_ANSWER,
                description: "Resume without changing the conversation.",
              },
              {
                label: CLAUDE_RESUME_COMPACTION_NEVER_ANSWER,
                description: "Keep full history and skip future resume prompts.",
              },
            ],
            multiSelect: false,
          },
        ],
      },
      {
        signal: callbackOptions.signal,
        ...(request.toolUseID ? { toolUseID: request.toolUseID } : {}),
      },
    );
    if (result.behavior !== "allow") {
      return { behavior: "cancelled" as const };
    }
    const answers = result.updatedInput.answers as Record<string, unknown> | undefined;
    return {
      behavior: "completed" as const,
      result: claudeResumeCompactionAction(answers?.[question]),
    };
  });
  const handleMcpElicitation = Effect.fn("handleMcpElicitation")(function* (
    request: ElicitationRequest,
    callbackOptions: Parameters<NonNullable<ClaudeQueryOptions["onElicitation"]>>[1],
  ) {
    if (callbackOptions.signal.aborted) return { action: "cancel" } satisfies ElicitationResult;
    const acceptance = claudeMcpElicitationAcceptance(request);
    const context = yield* getContext;
    if (!acceptance || !context || context.stopped) {
      yield* Effect.logWarning("Declined an MCP elicitation the approval card cannot answer", {
        serverName: request.serverName,
        mode: request.mode,
        hasSession: context !== undefined && !context.stopped,
      });
      return { action: "decline" } satisfies ElicitationResult;
    }

    const requestId = ApprovalRequestId.makeUnsafe(yield* Random.nextUUIDv4);
    const requestType: CanonicalRequestType = "dynamic_tool_call";
    const detail = claudeMcpElicitationDetail(request);
    const decisionDeferred = yield* Deferred.make<ProviderApprovalDecision>();
    const raw = {
      source: "claude.sdk.permission" as const,
      method: "onElicitation/request",
      payload: request,
    };
    const requestedStamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "request.opened",
      eventId: requestedStamp.eventId,
      provider: PROVIDER,
      createdAt: requestedStamp.createdAt,
      threadId: context.session.threadId,
      ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
      requestId: asRuntimeRequestId(requestId),
      payload: {
        requestType,
        detail,
        args: { serverName: request.serverName, message: request.message },
        // Every accept is one-time, so the card must not offer a session grant.
        noStandingGrant: true,
      },
      providerRefs: nativeProviderRefs(),
      raw,
    });
    // Shared with tool approvals so response handling and session teardown settle both.
    const decision = yield* awaitApproval(
      requestId,
      {
        requestType,
        detail,
        decision: decisionDeferred,
        noStandingGrant: true,
      },
      callbackOptions.signal,
    );
    const resolvedStamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "request.resolved",
      eventId: resolvedStamp.eventId,
      provider: PROVIDER,
      createdAt: resolvedStamp.createdAt,
      threadId: context.session.threadId,
      ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
      requestId: asRuntimeRequestId(requestId),
      payload: { requestType, decision },
      providerRefs: nativeProviderRefs(),
      raw: { ...raw, method: "onElicitation/decision", payload: { decision } },
    });
    // Never null, which the SDK reads as answered out of band.
    return decision === "accept"
      ? acceptance
      : ({ action: decision === "cancel" ? "cancel" : "decline" } satisfies ElicitationResult);
  });
  return {
    pendingApprovals,
    pendingUserInputs,
    canUseTool: canUseToolEffect,
    onUserDialog: handleUserDialog,
    onElicitation: handleMcpElicitation,
  };
}
