import { Schema } from "effect";

import {
  CommandId,
  EventId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
  RuntimeRequestId,
} from "./baseSchemas";
import {
  ModelSelection,
  RuntimeMode,
  ProviderKind,
  ProviderInteractionMode,
} from "./orchestration";
import {
  OrchestrationMessage,
  OrchestrationThreadActivity,
  OrchestrationCheckpointSummary,
  OrchestrationProposedPlan,
  ThreadTurnStartRequestedPayload,
} from "./orchestration";

// The execution model follows T3 Code's orchestration-v2. App identities are durable;
// native provider identities remain references at the adapter boundary.
export const RunId = TrimmedNonEmptyString.pipe(Schema.brand("RunId"));
export type RunId = typeof RunId.Type;
export const NodeId = TrimmedNonEmptyString.pipe(Schema.brand("NodeId"));
export type NodeId = typeof NodeId.Type;
export const ProviderThreadId = TrimmedNonEmptyString.pipe(Schema.brand("ProviderThreadId"));
export type ProviderThreadId = typeof ProviderThreadId.Type;
export const RunAttemptId = TrimmedNonEmptyString.pipe(Schema.brand("RunAttemptId"));
export type RunAttemptId = typeof RunAttemptId.Type;
export const CheckpointScopeId = TrimmedNonEmptyString.pipe(Schema.brand("CheckpointScopeId"));
export type CheckpointScopeId = typeof CheckpointScopeId.Type;
export const ContextHandoffId = TrimmedNonEmptyString.pipe(Schema.brand("ContextHandoffId"));
export type ContextHandoffId = typeof ContextHandoffId.Type;
export const ProviderSessionId = TrimmedNonEmptyString.pipe(Schema.brand("ProviderSessionId"));
export type ProviderSessionId = typeof ProviderSessionId.Type;
export const ProviderTurnId = TrimmedNonEmptyString.pipe(Schema.brand("ProviderTurnId"));
export type ProviderTurnId = typeof ProviderTurnId.Type;
export const CheckpointId = TrimmedNonEmptyString.pipe(Schema.brand("CheckpointId"));
export type CheckpointId = typeof CheckpointId.Type;

export const OrchestrationV2ExecutionStatus = Schema.Literals([
  "pending",
  "running",
  "waiting",
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);
export type OrchestrationV2ExecutionStatus = typeof OrchestrationV2ExecutionStatus.Type;

export const OrchestrationV2AppThread = Schema.Struct({
  id: ThreadId,
  projectId: ProjectId,
  title: Schema.String,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  systemPrompt: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  activeProviderThreadId: Schema.NullOr(ProviderThreadId),
  parentThreadId: Schema.NullOr(ThreadId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type OrchestrationV2AppThread = typeof OrchestrationV2AppThread.Type;

export const OrchestrationV2Run = Schema.Struct({
  id: RunId,
  threadId: ThreadId,
  ordinal: NonNegativeInt,
  provider: ProviderKind,
  providerThreadId: Schema.NullOr(ProviderThreadId),
  nativeTurnRef: Schema.NullOr(TurnId),
  userMessageId: Schema.NullOr(MessageId),
  rootNodeId: NodeId,
  activeAttemptId: Schema.NullOr(RunAttemptId),
  contextHandoffId: Schema.NullOr(ContextHandoffId),
  status: OrchestrationV2ExecutionStatus,
  requestedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
});
export type OrchestrationV2Run = typeof OrchestrationV2Run.Type;

export const OrchestrationV2Node = Schema.Struct({
  id: NodeId,
  threadId: ThreadId,
  runId: Schema.NullOr(RunId),
  parentNodeId: Schema.NullOr(NodeId),
  rootNodeId: NodeId,
  kind: Schema.Literals([
    "root_turn",
    "assistant_message",
    "reasoning",
    "plan",
    "tool_call",
    "approval_request",
    "user_input_request",
    "subagent",
    "hook",
    "system",
  ]),
  status: OrchestrationV2ExecutionStatus,
  countsForRun: Schema.Boolean,
  providerThreadId: Schema.NullOr(ProviderThreadId),
  nativeTurnRef: Schema.NullOr(TurnId),
  nativeItemRef: Schema.NullOr(Schema.String),
  checkpointScopeId: Schema.NullOr(CheckpointScopeId),
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
});
export type OrchestrationV2Node = typeof OrchestrationV2Node.Type;

export const OrchestrationV2ProviderThread = Schema.Struct({
  id: ProviderThreadId,
  threadId: ThreadId,
  provider: ProviderKind,
  nativeThreadRef: Schema.NullOr(Schema.String),
  resumeCursor: Schema.Unknown,
  status: Schema.Literals(["not_loaded", "idle", "active", "closed", "error"]),
  firstRunOrdinal: Schema.NullOr(NonNegativeInt),
  lastRunOrdinal: Schema.NullOr(NonNegativeInt),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestrationV2ProviderThread = typeof OrchestrationV2ProviderThread.Type;

export const OrchestrationV2RunAttempt = Schema.Struct({
  id: RunAttemptId,
  threadId: ThreadId,
  runId: RunId,
  ordinal: NonNegativeInt,
  rootNodeId: NodeId,
  providerThreadId: Schema.NullOr(ProviderThreadId),
  nativeTurnRef: Schema.NullOr(TurnId),
  reason: Schema.Literals(["initial", "steering_restart", "retry", "provider_recovery"]),
  status: OrchestrationV2ExecutionStatus,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
});
export type OrchestrationV2RunAttempt = typeof OrchestrationV2RunAttempt.Type;

export const OrchestrationV2ContextHandoff = Schema.Struct({
  id: ContextHandoffId,
  threadId: ThreadId,
  targetRunId: RunId,
  sourceProviderThreadId: Schema.NullOr(ProviderThreadId),
  targetProviderThreadId: ProviderThreadId,
  fromOrdinal: NonNegativeInt,
  toOrdinal: NonNegativeInt,
  strategy: Schema.Literals(["delta_since_target_last_seen", "full_thread_summary"]),
  summaryText: Schema.String,
  status: Schema.Literals(["pending", "ready", "failed", "superseded"]),
  createdAt: IsoDateTime,
});
export type OrchestrationV2ContextHandoff = typeof OrchestrationV2ContextHandoff.Type;

export const OrchestrationV2RuntimeRequest = Schema.Struct({
  id: RuntimeRequestId,
  threadId: ThreadId,
  runId: Schema.NullOr(RunId),
  nodeId: NodeId,
  providerThreadId: Schema.NullOr(ProviderThreadId),
  nativeRequestRef: Schema.String,
  kind: Schema.Literals(["approval", "user_input"]),
  status: Schema.Literals(["pending", "resolved", "cancelled"]),
  canRespond: Schema.Boolean,
  payload: Schema.Unknown,
  createdAt: IsoDateTime,
  resolvedAt: Schema.NullOr(IsoDateTime),
});
export type OrchestrationV2RuntimeRequest = typeof OrchestrationV2RuntimeRequest.Type;

export const OrchestrationV2Message = Schema.Struct({
  threadId: ThreadId,
  runId: Schema.NullOr(RunId),
  message: OrchestrationMessage,
});
export const OrchestrationV2MessagePatch = Schema.Struct({
  ...OrchestrationV2Message.fields,
  textOffset: NonNegativeInt,
});

export const OrchestrationV2Activity = Schema.Struct({
  threadId: ThreadId,
  runId: Schema.NullOr(RunId),
  activity: OrchestrationThreadActivity,
});

export const OrchestrationV2Checkpoint = Schema.Struct({
  threadId: ThreadId,
  runId: RunId,
  scopeId: CheckpointScopeId,
  checkpoint: OrchestrationCheckpointSummary,
});
export const OrchestrationV2Plan = Schema.Struct({
  threadId: ThreadId,
  runId: Schema.NullOr(RunId),
  plan: OrchestrationProposedPlan,
});

export const OrchestrationV2RunInput = Schema.Struct({
  id: RunId,
  request: ThreadTurnStartRequestedPayload,
});

const EventBase = Schema.Struct({
  eventId: EventId,
  threadId: ThreadId,
  commandId: Schema.NullOr(CommandId),
  occurredAt: IsoDateTime,
});

export const OrchestrationV2Event = Schema.Union([
  Schema.Struct({
    ...EventBase.fields,
    type: Schema.Literal("message.patched"),
    payload: OrchestrationV2MessagePatch,
  }),
  Schema.Struct({
    ...EventBase.fields,
    type: Schema.Literal("runtime-request.updated"),
    payload: OrchestrationV2RuntimeRequest,
  }),
  Schema.Struct({
    ...EventBase.fields,
    type: Schema.Literal("run-input.updated"),
    payload: OrchestrationV2RunInput,
  }),
  Schema.Struct({
    ...EventBase.fields,
    type: Schema.Literal("thread.updated"),
    payload: OrchestrationV2AppThread,
  }),
  Schema.Struct({
    ...EventBase.fields,
    type: Schema.Literal("run.updated"),
    payload: OrchestrationV2Run,
  }),
  Schema.Struct({
    ...EventBase.fields,
    type: Schema.Literal("node.updated"),
    payload: OrchestrationV2Node,
  }),
  Schema.Struct({
    ...EventBase.fields,
    type: Schema.Literal("run-attempt.updated"),
    payload: OrchestrationV2RunAttempt,
  }),
  Schema.Struct({
    ...EventBase.fields,
    type: Schema.Literal("provider-thread.updated"),
    payload: OrchestrationV2ProviderThread,
  }),
  Schema.Struct({
    ...EventBase.fields,
    type: Schema.Literal("context-handoff.updated"),
    payload: OrchestrationV2ContextHandoff,
  }),
  Schema.Struct({
    ...EventBase.fields,
    type: Schema.Literal("message.updated"),
    payload: OrchestrationV2Message,
  }),
  Schema.Struct({
    ...EventBase.fields,
    type: Schema.Literal("activity.updated"),
    payload: OrchestrationV2Activity,
  }),
  Schema.Struct({
    ...EventBase.fields,
    type: Schema.Literal("checkpoint.updated"),
    payload: OrchestrationV2Checkpoint,
  }),
  Schema.Struct({
    ...EventBase.fields,
    type: Schema.Literal("plan.updated"),
    payload: OrchestrationV2Plan,
  }),
]);
export type OrchestrationV2Event = typeof OrchestrationV2Event.Type;
