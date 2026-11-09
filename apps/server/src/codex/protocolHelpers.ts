/**
 * Pure protocol helpers used by codexAppServerManager.ts.
 *
 * These functions only operate on plain values (strings, params shapes,
 * `CodexSessionContext` for the two collab helpers) and do not touch any
 * EventEmitter or class state. Extracting them lets the manager file focus
 * on the procedural session lifecycle methods instead of carrying ~270
 * lines of read/parse/guard helpers inline.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { resolveSpawnCommand } from "@piedpiper/shared/windowsCommand";

import {
  type ProviderApprovalDecision,
  type ProviderItemId,
  ProviderItemId as ProviderItemIdMaker,
  type ProviderRequestKind,
  type RuntimeMode,
  type ThreadId,
  type TurnId,
  TurnId as TurnIdMaker,
} from "@piedpiper/contracts";

import { killCodexChildProcess } from "../provider/codexAppServer";
import { formatMissingCodexCliMessage } from "../provider/providerMissingCliMessage";
import { codexHomeEnv } from "./homePath";
import {
  formatCodexCliUpgradeMessage,
  isCodexCliVersionSupported,
  parseCodexCliVersion,
} from "../provider/codexCliVersion";

import {
  type CodexSessionContext,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "./sessionState";

const CODEX_VERSION_CHECK_TIMEOUT_MS = 4_000;
const CODEX_VERSION_CHECK_MAX_OUTPUT = 1024 * 1024;

export interface CodexThreadTurnSnapshot {
  id: TurnId;
  items: unknown[];
}

export interface CodexThreadSnapshot {
  threadId: string;
  turns: CodexThreadTurnSnapshot[];
}

export interface CodexTurnHistoryEntry {
  readonly id: string;
  readonly items: ReadonlyArray<unknown>;
  readonly itemsView?: string;
  readonly status?: string;
}

/** Turns this session knows the nature of; a restart loses them, so listings are read too. */
export interface CodexKnownTurns {
  readonly compactionTurnIds?: ReadonlySet<string>;
  readonly retryTurnIds?: { readonly has: (turnId: string) => boolean };
  readonly goalTurnIds?: ReadonlySet<string>;
}

export function toCodexTurnHistoryEntries(
  entries: ReadonlyArray<unknown>,
): ReadonlyArray<CodexTurnHistoryEntry> {
  return entries.flatMap((entry): ReadonlyArray<CodexTurnHistoryEntry> => {
    const id = readString(entry, "id");
    if (!id) return [];
    const itemsView = readString(entry, "itemsView");
    const status = readString(entry, "status");
    const items = readObject(entry)?.items;
    return [
      {
        id,
        items: Array.isArray(items) ? items : [],
        ...(itemsView ? { itemsView } : {}),
        ...(status ? { status } : {}),
      },
    ];
  });
}

export function readCodexTurnsPage(response: unknown): {
  readonly turns: ReadonlyArray<CodexTurnHistoryEntry>;
  readonly nextCursor: string | null;
} {
  const record = readObject(response);
  if (!Array.isArray(record?.data)) {
    throw new Error("thread/turns/list response did not include turns.");
  }
  return {
    turns: toCodexTurnHistoryEntries(record.data),
    nextCursor: readString(record, "nextCursor") ?? null,
  };
}

const turnHasItem = (turn: CodexTurnHistoryEntry | undefined, type: string): boolean =>
  turn?.items.some((item) => readString(item, "type") === type) === true;

/**
 * Whether a native turn is a checkpoint of its own: a user turn, a compaction or a goal's first
 * turn. Capacity retries and later goal turns continue the turn before them. Checked on CLI 0.166: summary listings omit the
 * contextCompaction item, and a failed compaction keeps no items at all.
 */
function startsLogicalCodexTurn(
  turn: CodexTurnHistoryEntry,
  olderTurn: CodexTurnHistoryEntry | undefined,
  known: CodexKnownTurns | undefined,
): boolean {
  if (known?.retryTurnIds?.has(turn.id)) return false;
  if (turnHasItem(turn, "userMessage") || known?.goalTurnIds?.has(turn.id)) return true;
  if (known?.compactionTurnIds?.has(turn.id) || turnHasItem(turn, "contextCompaction")) return true;
  if (turnHasItem(turn, "agentMessage")) return false;
  if (turn.status === "completed") return true;
  // An unfinished retry attempt always follows a failed turn; a compaction need not.
  return (
    (turn.status === "failed" || turn.status === "interrupted") &&
    olderTurn !== undefined &&
    olderTurn.status !== "failed"
  );
}

function countsEveryCodexTurn(turnsNewestFirst: ReadonlyArray<CodexTurnHistoryEntry>): boolean {
  return (
    !turnsNewestFirst.some((turn) => turnHasItem(turn, "userMessage")) ||
    turnsNewestFirst.some((turn) => turn.itemsView === "notLoaded")
  );
}

function findCodexRevertTargetIndex(
  turnsNewestFirst: ReadonlyArray<CodexTurnHistoryEntry>,
  numTurns: number,
  known: CodexKnownTurns | undefined,
): number {
  const countsAll = countsEveryCodexTurn(turnsNewestFirst);
  let logicalTurns = 0;
  for (const [index, turn] of turnsNewestFirst.entries()) {
    if (countsAll || startsLogicalCodexTurn(turn, turnsNewestFirst[index + 1], known)) {
      logicalTurns += 1;
      if (logicalTurns === numTurns) return index;
    }
  }
  return -1;
}

/** Maps checkpoint turns to native turns: retries stay with the user turn they continue, unless no turn shows one. */
export function planCodexThreadRevert(
  turnsNewestFirst: ReadonlyArray<CodexTurnHistoryEntry>,
  numTurns: number,
  known?: CodexKnownTurns,
): { readonly removedTurns: number; readonly beforeTurnId?: string } {
  const targetIndex = findCodexRevertTargetIndex(turnsNewestFirst, numTurns, known);
  const target = targetIndex >= 0 ? turnsNewestFirst[targetIndex] : turnsNewestFirst.at(-1);
  if (!target) return { removedTurns: 0 };
  return {
    removedTurns: targetIndex >= 0 ? targetIndex + 1 : turnsNewestFirst.length,
    beforeTurnId: target.id,
  };
}

/** True once older pages cannot change the plan, so a revert need not page the whole thread. */
export function isCodexRevertPlanSettled(
  turnsNewestFirst: ReadonlyArray<CodexTurnHistoryEntry>,
  numTurns: number,
  known?: CodexKnownTurns,
): boolean {
  const showsTurnKinds =
    turnsNewestFirst.some((turn) => turnHasItem(turn, "userMessage")) ||
    turnsNewestFirst.some((turn) => turn.itemsView === "notLoaded");
  return showsTurnKinds && findCodexRevertTargetIndex(turnsNewestFirst, numTurns, known) >= 0;
}

/** Whether a `requestUserInput` has anything to show; without it nothing could ever answer. */
export function hasCodexUserInputQuestions(params: unknown): boolean {
  const questions = readObject(params)?.questions;
  return Array.isArray(questions) && questions.some((question) => readObject(question));
}

export function readObject(value: unknown, key?: string): Record<string, unknown> | undefined {
  const target =
    key === undefined
      ? value
      : value && typeof value === "object"
        ? (value as Record<string, unknown>)[key]
        : undefined;

  if (!target || typeof target !== "object") {
    return undefined;
  }

  return target as Record<string, unknown>;
}

export function readArray(value: unknown, key?: string): unknown[] | undefined {
  const target =
    key === undefined
      ? value
      : value && typeof value === "object"
        ? (value as Record<string, unknown>)[key]
        : undefined;
  return Array.isArray(target) ? target : undefined;
}

export function readString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" ? candidate : undefined;
}

export function readBoolean(value: unknown, key: string): boolean | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "boolean" ? candidate : undefined;
}

export function isServerRequest(value: unknown): value is JsonRpcRequest {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.method === "string" &&
    (typeof candidate.id === "string" || typeof candidate.id === "number")
  );
}

export function isServerNotification(value: unknown): value is JsonRpcNotification {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return typeof candidate.method === "string" && !("id" in candidate);
}

export function isResponse(value: unknown): value is JsonRpcResponse {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  const hasId = typeof candidate.id === "string" || typeof candidate.id === "number";
  const hasMethod = typeof candidate.method === "string";
  return hasId && !hasMethod;
}

export const CODEX_PERMISSIONS_APPROVAL_METHOD = "item/permissions/requestApproval";
export const CODEX_MCP_ELICITATION_METHOD = "mcpServer/elicitation/request";

export type CodexApprovalMethod =
  | "item/commandExecution/requestApproval"
  | "item/fileChange/requestApproval"
  | "item/fileRead/requestApproval"
  | typeof CODEX_PERMISSIONS_APPROVAL_METHOD
  | typeof CODEX_MCP_ELICITATION_METHOD;

function readStringArray(value: unknown, key: string): string[] {
  return (readArray(value, key) ?? []).filter(
    (entry): entry is string => typeof entry === "string",
  );
}

/** Display text for a sandbox `entries[].path`: `{type:"path"|"glob_pattern"|"special"}` or a bare string. */
function describePermissionEntryPath(path: unknown): string | undefined {
  if (typeof path === "string") return path || undefined;
  const record = readObject(path);
  if (!record) return undefined;
  const text = readString(record, "path") ?? readString(record, "pattern");
  if (text) return text;
  const value = record.value;
  if (typeof value === "string") return value || undefined;
  return value === undefined || value === null ? undefined : JSON.stringify(value);
}

/** Paths a sandbox permission request asks for, by access level (legacy lists and `entries`). */
export function readRequestedPermissionPaths(params: unknown): {
  read: string[];
  write: string[];
  /** True when any read/write is requested, even if no path could be described. */
  requestsRead: boolean;
  requestsWrite: boolean;
} {
  const fileSystem = readObject(readObject(params, "permissions"), "fileSystem");
  const read = readStringArray(fileSystem, "read");
  const write = readStringArray(fileSystem, "write");
  let requestsRead = read.length > 0;
  let requestsWrite = write.length > 0;
  for (const entry of readArray(fileSystem, "entries") ?? []) {
    const access = readString(entry, "access");
    const path = describePermissionEntryPath(readObject(entry)?.path);
    if (access === "write") {
      requestsWrite = true;
      if (path) write.push(path);
    } else if (access === "read") {
      requestsRead = true;
      if (path) read.push(path);
    }
  }
  return { read, write, requestsRead, requestsWrite };
}

export function requestKindForMethod(
  method: string,
  params?: unknown,
): ProviderRequestKind | undefined {
  if (method === "item/commandExecution/requestApproval") {
    return "command";
  }

  if (method === "item/fileRead/requestApproval") {
    return "file-read";
  }

  if (method === "item/fileChange/requestApproval") {
    return "file-change";
  }

  if (method === CODEX_PERMISSIONS_APPROVAL_METHOD) {
    const paths = readRequestedPermissionPaths(params);
    return paths.requestsWrite ? "file-change" : paths.requestsRead ? "file-read" : "command";
  }

  if (method === CODEX_MCP_ELICITATION_METHOD) {
    return "command";
  }

  return undefined;
}

/** Approval methods whose "allow this session" choice covers every later request of the same kind. */
export function isSessionAllowableApprovalMethod(method: string): boolean {
  return (
    method === "item/commandExecution/requestApproval" ||
    method === "item/fileChange/requestApproval" ||
    method === "item/fileRead/requestApproval"
  );
}

function elicitationPersistence(value: string): "session" | "always" | null {
  const normalized = value.toLowerCase();
  if (normalized.includes("session")) return "session";
  if (/always|permanent|forever|persistent/.test(normalized)) return "always";
  return null;
}

/** Option values that refuse rather than grant, e.g. `disallow` or `do_not_allow`. */
function isNegativeElicitationOption(value: string): boolean {
  const normalized = value.toLowerCase().replace(/[_-]+/g, " ");
  return /\b(?:dis|un)(?:allow|approve|accept)|\b(?:no|not|never|don'?t|deny|denied|decline|reject|block)\b/.test(
    normalized,
  );
}

/** MCP elicitation wire response for a decision; declines forms it cannot fill in. */
// Anchored, so a broader grant listed first ("allow_all", "approve_all_tools") is never chosen.
const ONE_TIME_ELICITATION_OPTION =
  /^(?:once|accept|approve|allow)(?:[_\s-]*(?:once(?:[_\s-]*only)?|this[_\s-]*time))?$/i;

export function toMcpElicitationResponse(
  params: unknown,
  decision: ProviderApprovalDecision,
): Record<string, unknown> {
  if (decision === "decline" || decision === "cancel") {
    return { action: decision };
  }
  if (readString(params, "mode") === "url") {
    return { action: "decline" };
  }
  const persist = decision === "acceptForSession" ? "session" : undefined;
  const schema = readObject(params, "requestedSchema");
  const properties = readObject(schema, "properties");
  const content: Record<string, unknown> = {};
  for (const [key, rawField] of Object.entries(properties ?? {})) {
    const field = readObject(rawField);
    const optionValues = [
      ...(readArray(field, "oneOf") ?? []).flatMap((option) => {
        const value = readString(option, "const");
        return value ? [value] : [];
      }),
      ...readStringArray(field, "enum"),
    ];
    const chosen = optionValues.find((value) =>
      persist
        ? elicitationPersistence(value) === persist
        : ONE_TIME_ELICITATION_OPTION.test(value.trim()) &&
          elicitationPersistence(value) === null &&
          !isNegativeElicitationOption(value),
    );
    const isPersistenceFlag =
      readString(field, "type") === "boolean" &&
      (key.toLowerCase() === "persist" ||
        elicitationPersistence(key) !== null ||
        elicitationPersistence(readString(field, "title") ?? "") !== null);
    if (chosen !== undefined) {
      content[key] = chosen;
    } else if (isPersistenceFlag) {
      content[key] = false;
    } else if (field && field.default !== undefined && field.default !== null) {
      content[key] = field.default;
    }
  }
  const required = readStringArray(schema, "required");
  if (required.some((key) => !Object.hasOwn(content, key))) {
    return { action: "decline" };
  }
  return {
    action: "accept",
    ...(persist ? { _meta: { persist } } : {}),
    ...(properties ? { content } : {}),
  };
}

/** Builds the method-specific JSON-RPC result for an approval decision. */
export function buildCodexApprovalResponse(
  method: CodexApprovalMethod,
  params: unknown,
  decision: ProviderApprovalDecision,
): Record<string, unknown> {
  if (method === CODEX_PERMISSIONS_APPROVAL_METHOD) {
    const granted = decision === "accept" || decision === "acceptForSession";
    // An empty grant tells the app-server the permission was withheld.
    return {
      permissions: granted ? (readObject(params, "permissions") ?? {}) : {},
      ...(decision === "acceptForSession" ? { scope: "session" } : {}),
    };
  }
  if (method === CODEX_MCP_ELICITATION_METHOD) {
    const response = toMcpElicitationResponse(params, decision);
    if (decision !== "acceptForSession" || response.action === "accept") return response;
    // The card always offers "allow this session"; without a session option, approve once instead of declining.
    const once = toMcpElicitationResponse(params, "accept");
    return once.action === "accept" ? { ...once, _meta: { persist: "session" } } : response;
  }
  return { decision };
}

const CODEX_REASONING_DELTA_METHODS: ReadonlySet<string> = new Set([
  "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded",
  "item/reasoning/textDelta",
]);

export function shouldSuppressChildConversationNotification(
  method: string,
  params?: unknown,
): boolean {
  // Ingestion keeps one open Thought row per turn, so a subagent's reasoning would break up the parent's.
  if (
    CODEX_REASONING_DELTA_METHODS.has(method) ||
    ((method === "item/started" || method === "item/completed") &&
      readString(readObject(params, "item"), "type") === "reasoning")
  ) {
    return true;
  }
  return (
    method === "thread/started" ||
    method === "thread/status/changed" ||
    method === "thread/archived" ||
    method === "thread/unarchived" ||
    method === "thread/closed" ||
    method === "thread/compacted" ||
    method === "thread/name/updated" ||
    method === "thread/tokenUsage/updated" ||
    method === "turn/started" ||
    method === "turn/completed" ||
    method === "turn/aborted" ||
    method === "turn/plan/updated" ||
    method === "item/plan/delta" ||
    // A subagent's hook stopping its own turn must not read as the main turn stopping.
    method === "hook/completed"
  );
}

export function parseThreadSnapshot(method: string, response: unknown): CodexThreadSnapshot {
  const responseRecord = readObject(response);
  const thread = readObject(responseRecord, "thread");
  const threadIdRaw = readString(thread, "id") ?? readString(responseRecord, "threadId");
  if (!threadIdRaw) {
    throw new Error(`${method} response did not include a thread id.`);
  }
  const turnsRaw = readArray(thread, "turns") ?? readArray(responseRecord, "turns") ?? [];
  const turns = turnsRaw.map((turnValue, index) => {
    const turn = readObject(turnValue);
    const turnIdRaw = readString(turn, "id") ?? `${threadIdRaw}:turn:${index + 1}`;
    const turnId = TurnIdMaker.makeUnsafe(turnIdRaw);
    const items = readArray(turn, "items") ?? [];
    return {
      id: turnId,
      items,
    };
  });

  return {
    threadId: threadIdRaw,
    turns,
  };
}

export function readRouteFields(params: unknown): {
  turnId?: TurnId;
  itemId?: ProviderItemId;
} {
  const route: {
    turnId?: TurnId;
    itemId?: ProviderItemId;
  } = {};

  const turnId = toTurnId(
    readString(params, "turnId") ?? readString(readObject(params, "turn"), "id"),
  );
  const itemId = toProviderItemId(
    readString(params, "itemId") ?? readString(readObject(params, "item"), "id"),
  );

  if (turnId) {
    route.turnId = turnId;
  }

  if (itemId) {
    route.itemId = itemId;
  }

  return route;
}

export function readProviderConversationId(params: unknown): string | undefined {
  return (
    readString(params, "threadId") ??
    readString(readObject(params, "thread"), "id") ??
    readString(params, "conversationId")
  );
}

/** Codex states why it wants more than the sandbox grants; a plain prompt carries no such reason. */
function isEscalatedCodexApproval(params: unknown): boolean {
  return (
    readString(params, "reason") !== undefined || readString(params, "grantRoot") !== undefined
  );
}

function codexConversationAllowanceKey(requestKind: string, params: unknown): string {
  return `${readProviderConversationId(params) ?? ""}\u0000${requestKind}`;
}

/** Scopes an "Always allow this session" grant to one kind and escalation level in one Codex conversation, so subagent approvals still prompt. */
export function codexSessionAllowanceKey(requestKind: string, params: unknown): string {
  const key = codexConversationAllowanceKey(requestKind, params);
  return isEscalatedCodexApproval(params) ? `${key}\u0000escalated` : key;
}

/** A grant given on an escalated request also covers plain ones; a plain grant never covers an escalation. */
export function hasCodexSessionAllowance(
  allowed: ReadonlySet<string> | undefined,
  requestKind: string,
  params: unknown,
): boolean {
  if (!allowed) return false;
  const key = codexConversationAllowanceKey(requestKind, params);
  return (
    allowed.has(`${key}\u0000escalated`) || (!isEscalatedCodexApproval(params) && allowed.has(key))
  );
}

function isMemoryConsolidationThread(thread: Record<string, unknown> | undefined): boolean {
  if (readString(thread, "threadSource") === "memory_consolidation") {
    return true;
  }
  return readString(readObject(thread, "source"), "subAgent") === "memory_consolidation";
}

/**
 * Tracks Codex's background memory-consolidation threads (spawned on the same app-server)
 * and reports whether a notification or request belongs to one and must be kept out of the chat.
 */
export function shouldSuppressMemoryConsolidationMessage(
  memoryThreadIds: Set<string>,
  method: string,
  params: unknown,
): boolean {
  if (method === "thread/started") {
    const thread = readObject(params, "thread");
    const startedThreadId = readString(thread, "id");
    if (startedThreadId && isMemoryConsolidationThread(thread)) {
      memoryThreadIds.add(startedThreadId);
      return true;
    }
  }
  if (memoryThreadIds.size === 0) {
    return false;
  }
  const threadId = readProviderConversationId(params);
  if (!threadId || !memoryThreadIds.has(threadId)) {
    return false;
  }
  // Resolution notices must still reach the pending-request bookkeeping.
  if (method === "serverRequest/resolved") {
    return false;
  }
  if (method === "thread/closed") {
    memoryThreadIds.delete(threadId);
  }
  return true;
}

export function readChildParentTurnId(
  context: CodexSessionContext,
  params: unknown,
): TurnId | undefined {
  const providerConversationId = readProviderConversationId(params);
  if (!providerConversationId) {
    return undefined;
  }
  return context.collabReceiverTurns.get(providerConversationId);
}

export function rememberCollabReceiverTurns(
  context: CodexSessionContext,
  params: unknown,
  parentTurnId: TurnId | undefined,
): void {
  if (!parentTurnId) {
    return;
  }
  const payload = readObject(params);
  const item = readObject(payload, "item") ?? payload;
  const itemType = readString(item, "type") ?? readString(item, "kind");
  if (itemType !== "collabAgentToolCall") {
    return;
  }

  const receiverThreadIds =
    readArray(item, "receiverThreadIds")
      ?.map((value) => (typeof value === "string" ? value : null))
      .filter((value): value is string => value !== null) ?? [];
  for (const receiverThreadId of receiverThreadIds) {
    context.collabReceiverTurns.set(receiverThreadId, parentTurnId);
  }
}

export function brandIfNonEmpty<T extends string>(
  value: string | undefined,
  maker: (value: string) => T,
): T | undefined {
  const normalized = value?.trim();
  return normalized?.length ? maker(normalized) : undefined;
}

export function normalizeProviderThreadId(value: string | undefined): string | undefined {
  return brandIfNonEmpty(value, (normalized) => normalized);
}

export function toTurnId(value: string | undefined): TurnId | undefined {
  return brandIfNonEmpty(value, TurnIdMaker.makeUnsafe);
}

export function toProviderItemId(value: string | undefined): ProviderItemId | undefined {
  return brandIfNonEmpty(value, ProviderItemIdMaker.makeUnsafe);
}

export function readResumeCursorThreadId(resumeCursor: unknown): string | undefined {
  if (!resumeCursor || typeof resumeCursor !== "object" || Array.isArray(resumeCursor)) {
    return undefined;
  }
  const rawThreadId = (resumeCursor as Record<string, unknown>).threadId;
  return typeof rawThreadId === "string" ? normalizeProviderThreadId(rawThreadId) : undefined;
}

export function readResumeThreadId(input: {
  readonly resumeCursor?: unknown;
  readonly threadId?: ThreadId;
  readonly runtimeMode?: RuntimeMode;
}): string | undefined {
  return readResumeCursorThreadId(input.resumeCursor);
}

export interface CodexCliVersionCheckResult {
  readonly error?: Error;
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Throws when the CLI is missing or too old; returns the parsed version when it could be read. */
export function evaluateCodexCliVersionCheck(
  binaryPath: string,
  result: CodexCliVersionCheckResult,
): string | undefined {
  if (result.error) {
    const lower = result.error.message.toLowerCase();
    if (
      lower.includes("enoent") ||
      lower.includes("command not found") ||
      lower.includes("not found")
    ) {
      throw new Error(formatMissingCodexCliMessage(binaryPath));
    }
    throw new Error(
      `Failed to execute Codex CLI version check: ${result.error.message || String(result.error)}`,
    );
  }

  if (result.status !== 0) {
    const detail =
      result.stderr.trim() || result.stdout.trim() || `Command exited with code ${result.status}.`;
    throw new Error(`Codex CLI version check failed. ${detail}`);
  }

  const parsedVersion = parseCodexCliVersion(`${result.stdout}\n${result.stderr}`);
  if (parsedVersion && !isCodexCliVersionSupported(parsedVersion)) {
    throw new Error(formatCodexCliUpgradeMessage(parsedVersion));
  }
  return parsedVersion ?? undefined;
}

function runCodexVersionCommand(input: {
  readonly binaryPath: string;
  readonly cwd: string;
  readonly homePath?: string;
}): Promise<CodexCliVersionCheckResult> {
  const env = {
    ...process.env,
    ...codexHomeEnv(input.homePath),
  };
  // Windows: a real codex.exe runs directly; a .cmd shim gets one escaped cmd.exe line.
  const spawnCommand = resolveSpawnCommand(input.binaryPath, ["--version"], { env });
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: CodexCliVersionCheckResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(spawnCommand.command, [...spawnCommand.args], {
        cwd: input.cwd,
        env,
        shell: spawnCommand.shell,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({
        error: error instanceof Error ? error : new Error(String(error)),
        status: null,
        stdout,
        stderr,
      });
      return;
    }
    child.stdin.end();
    const append = (current: string, chunk: Buffer) =>
      current.length >= CODEX_VERSION_CHECK_MAX_OUTPUT
        ? current
        : current +
          chunk.toString("utf8").slice(0, CODEX_VERSION_CHECK_MAX_OUTPUT - current.length);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    const timer = setTimeout(() => {
      killCodexChildProcess(child);
      finish({
        error: new Error(`Timed out after ${CODEX_VERSION_CHECK_TIMEOUT_MS}ms`),
        status: null,
        stdout,
        stderr,
      });
    }, CODEX_VERSION_CHECK_TIMEOUT_MS);
    child.once("error", (error) => finish({ error, status: null, stdout, stderr }));
    child.once("close", (code) => finish({ status: code, stdout, stderr }));
  });
}

// Async so a slow or hung `codex --version` never blocks the server event loop.
export async function assertSupportedCodexCliVersion(input: {
  readonly binaryPath: string;
  readonly cwd: string;
  readonly homePath?: string;
}): Promise<string | undefined> {
  return evaluateCodexCliVersionCheck(input.binaryPath, await runCodexVersionCommand(input));
}
