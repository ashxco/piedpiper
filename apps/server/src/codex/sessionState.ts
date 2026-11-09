/**
 * File-private types describing the Codex app-server session state and the
 * JSON-RPC protocol envelopes the manager exchanges with the codex CLI.
 *
 * Extracted from codexAppServerManager.ts so the manager file can focus on
 * methods rather than nested type definitions. The manager class still owns
 * the actual `Map<ThreadId, CodexSessionContext>` and the request/response
 * routing logic — these types are just the shapes those structures use.
 */
import { type ChildProcessWithoutNullStreams } from "node:child_process";
import type readline from "node:readline";

import {
  type ApprovalRequestId,
  type ProviderItemId,
  type ProviderRequestKind,
  type ProviderSession,
  type ThreadId,
  type TurnId,
} from "@piedpiper/contracts";

import { type CodexAccountSnapshot } from "../provider/codexAccount";

export type PendingRequestKey = string;

export interface PendingRequest {
  method: string;
  timeout: ReturnType<typeof setTimeout>;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export interface PendingApprovalRequest {
  requestId: ApprovalRequestId;
  jsonRpcId: string | number;
  method:
    | "item/commandExecution/requestApproval"
    | "item/fileChange/requestApproval"
    | "item/fileRead/requestApproval"
    | "item/permissions/requestApproval"
    | "mcpServer/elicitation/request";
  requestKind: ProviderRequestKind;
  /** Original request params, needed to build method-specific responses. */
  params?: unknown;
  threadId: ThreadId;
  turnId?: TurnId;
  itemId?: ProviderItemId;
}

export interface PendingUserInputRequest {
  requestId: ApprovalRequestId;
  jsonRpcId: string | number;
  threadId: ThreadId;
  turnId?: TurnId;
  itemId?: ProviderItemId;
}

/** A capacity failure kept from the UI while its retry is pending. */
export interface HeldCodexCapacityFailure {
  error?: JsonRpcNotification;
  completed: JsonRpcNotification;
}

/** One user turn, which capacity retries may stretch over several native Codex turns. */
export interface CodexTurnRun {
  /** The first native turn's id; the only id the rest of the app ever sees. */
  logicalTurnId?: TurnId;
  /** The native turn now running; undefined while its turn/start is unanswered. */
  nativeTurnId?: string;
  /** turn/start params with empty input, which continues the persisted history. */
  retryParams: Record<string, unknown>;
  retryable: boolean;
  attempt: number;
  stopRequested: boolean;
  sawCapacityError: boolean;
  heldError?: JsonRpcNotification;
  held?: HeldCodexCapacityFailure;
  retryTimer?: ReturnType<typeof setTimeout>;
  starting?: Promise<void>;
  /** `held` is a completed turn, kept while Codex starts the next turn of an active goal. */
  goalHold?: boolean;
}

/** A commandExecution item still running, kept so Stop can end it and close its row. */
export interface CodexRunningCommand {
  /** The item/started params, which also carry the conversation that owns the command. */
  startedParams: Record<string, unknown>;
  processId?: string;
  terminateRequested?: boolean;
}

/** A requested compaction, tracked because a failed one reports through its row, not the session. */
export interface CodexCompactionTurn {
  /** Undefined until its turn/started arrives. */
  nativeTurnId?: string;
  /** contextCompaction items started but not completed, by item id, with their item/started params. */
  openItems: Map<string, Record<string, unknown>>;
  errorMessage?: string;
  /** Settles the wait in compactThread; an error means the session ended first. */
  settleStart?: (error?: Error) => void;
}

/** A capacity retry whose turn/start timed out, so its turn may still begin with nothing to own it. */
export interface CodexAbandonedRetry {
  expiresAtMs: number;
}

export interface CodexSessionContext {
  session: ProviderSession;
  account: CodexAccountSnapshot;
  child: ChildProcessWithoutNullStreams;
  output: readline.Interface;
  pending: Map<PendingRequestKey, PendingRequest>;
  pendingApprovals: Map<ApprovalRequestId, PendingApprovalRequest>;
  pendingUserInputs: Map<ApprovalRequestId, PendingUserInputRequest>;
  collabReceiverTurns: Map<string, TurnId>;
  /** Provider thread ids of Codex background memory-consolidation threads. */
  memoryConsolidationThreadIds?: Set<string>;
  /** codexSessionAllowanceKey values the user chose "Always allow this session" for; later ones are auto-approved. */
  sessionAllowedRequestKinds?: Set<string>;
  nextRequestId: number;
  stopping: boolean;
  /** The latest user turn, tracked so a capacity failure can be retried. */
  turnRun?: CodexTurnRun | undefined;
  /** Native ids of capacity-retry turns, mapped to the logical turn they continue. */
  capacityRetryTurns?: Map<string, TurnId>;
  /** Logical turns ended by Stop while waiting to retry; a repeated Stop has nothing to do. */
  capacityRetryStoppedTurns?: Set<string>;
  /** Running commands by logical turn; an entry lasts only until that turn ends. */
  runningCommands?: Map<string, Map<string, CodexRunningCommand>>;
  /** Logical turns the user stopped that have not ended yet. */
  stoppedCommandTurns?: Set<string>;
  /** Item ids closed at turn end, true when the user stopped them; Codex's own later item/completed is dropped. */
  closedCommandItems?: Map<string, boolean>;
  compactionTurn?: CodexCompactionTurn | undefined;
  /** Native ids of this session's compaction turns, which a revert counts as turns of their own. */
  compactionTurnIds?: Set<string>;
  abandonedRetry?: CodexAbandonedRetry | undefined;
  /** Native turns started by an abandoned retry; they are interrupted and never reach the app. */
  abandonedRetryTurns?: Set<string>;
  /** The root thread's goal status as Codex last reported it; null when it has no goal. */
  goalStatus?: string | null;
  /** The last goal reported to the app, so a repeat is not reported twice. */
  goalSnapshot?: string;
  /** A request to make the goal active is unanswered, so Codex may start a turn for it at any moment. */
  goalActivating?: boolean;
  /** The goal was made active with no turn running, so Codex starts the next turn itself. */
  goalTurnExpected?: boolean;
  /** The user stopped the goal's work; a turn Codex starts anyway is ended unseen. */
  goalStopRequested?: boolean;
  /** Native turns Codex started for a goal with no user turn to continue, which a revert counts as their own. */
  goalTurnIds?: Set<string>;
  /** Set once the child process has exited; late stream errors are then ignored. */
  exited?: boolean;
  /** A stdout line went over the limit; readline's remaining output is discarded. */
  stdoutOverflowed?: boolean;
  /** Last ~8 KB of the child's stderr, used to explain an unexpected exit. */
  stderrTail?: string;
}

export interface JsonRpcError {
  code?: number;
  message?: string;
}

export interface JsonRpcRequest {
  id: string | number;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  id: string | number;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcNotification {
  method: string;
  params?: unknown;
}
