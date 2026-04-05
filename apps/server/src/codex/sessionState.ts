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
    | "item/fileRead/requestApproval";
  requestKind: ProviderRequestKind;
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

export interface CodexSessionContext {
  session: ProviderSession;
  account: CodexAccountSnapshot;
  child: ChildProcessWithoutNullStreams;
  output: readline.Interface;
  pending: Map<PendingRequestKey, PendingRequest>;
  pendingApprovals: Map<ApprovalRequestId, PendingApprovalRequest>;
  pendingUserInputs: Map<ApprovalRequestId, PendingUserInputRequest>;
  collabReceiverTurns: Map<string, TurnId>;
  nextRequestId: number;
  stopping: boolean;
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
