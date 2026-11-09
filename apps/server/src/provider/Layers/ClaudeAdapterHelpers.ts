/**
 * Pure helpers used by ClaudeAdapterLive.
 *
 * Extracted from ClaudeAdapter.ts to keep the adapter layer file focused
 * on session lifecycle wiring. None of these functions touch the adapter
 * runtime state directly — they classify Claude SDK messages, normalize
 * token usage, build prompt content, and coerce SDK shapes to canonical
 * runtime types.
 */
import * as Path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { sliceSurrogateSafe } from "@piedpiper/shared/String";
import {
  type CanUseTool,
  type ElicitationRequest,
  type ElicitationResult,
  type PermissionMode,
  type SDKCompactBoundaryMessage,
  type SDKMessage,
  type SDKRateLimitInfo,
  type SDKResultMessage,
  type SDKUserMessage,
  type SettingSource,
} from "@anthropic-ai/claude-agent-sdk";
import {
  ApprovalRequestId,
  type CanonicalItemType,
  type CanonicalRequestType,
  type ChatAttachment,
  type ProviderApprovalDecision,
  type ProviderGoal,
  ProviderItemId,
  type ProviderRuntimeEvent,
  type ProviderRuntimeTurnStatus,
  type ProviderSendTurnInput,
  type ThreadTokenUsageSnapshot,
  type RuntimeContentStreamKind,
  RuntimeItemId,
  type RuntimePlanStep,
  RuntimeRequestId,
  ThreadId,
  TurnId,
  ClaudeCodeEffort,
  isProviderSendTurnSupportedImageMimeType,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES,
} from "@piedpiper/contracts";
import { tokenizeCliArgs } from "@piedpiper/shared/cliArgs";
import { applyClaudePromptEffortPrefix, trimOrNull } from "@piedpiper/shared/model";
import { fromLenientJson } from "@piedpiper/shared/schemaJson";
import { Cause, Effect, Exit, FileSystem, Schema } from "effect";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { expandHomePathForPlatform } from "../../os-jank.ts";
import { toMcpElicitationResponse } from "../../codex/protocolHelpers.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { isClaudeSlashCommandPrompt } from "../claudeSlashCommands.ts";
import {
  buildClaudePdfDocumentBlock,
  claudeBase64RetainedBytes,
  type ClaudeAttachmentBudget,
} from "../pdfDocumentBudget.ts";
import { readClaudeGoal } from "./ClaudeGoal.ts";
import { getClaudeModelCapabilities } from "./ClaudeProvider.ts";

export const PROVIDER = "claudeAgent" as const;
export type ClaudeTextStreamKind = Extract<
  RuntimeContentStreamKind,
  "assistant_text" | "reasoning_text" | "reasoning_summary_text"
>;
export type ClaudeToolResultStreamKind = Extract<
  RuntimeContentStreamKind,
  "command_output" | "file_change_output"
>;

export interface ClaudeResumeState {
  threadId?: ThreadId;
  resume?: string;
  resumeSessionAt?: string;
  turnCount?: number;
  /** Last root transcript entry of each turn, oldest first; null where unknown (older cursors). */
  turnEndMessageIds?: Array<string | null>;
  /** Rewind point Claude must resume at (truncating later history) until the new branch has output. */
  rewindTo?: string;
  /** The `/goal` Claude keeps across a resume, so its completion is still seen after a restart. */
  goal?: ProviderGoal;
  /** Index of the turn that set `goal`; a rollback past it removes the goal from Claude's transcript. */
  goalSetAtTurn?: number;
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function isSyntheticClaudeThreadId(value: string): boolean {
  return value.startsWith("claude-thread-");
}

export function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  return fallback;
}

export function toError(cause: unknown, fallback: string): Error {
  return cause instanceof Error ? cause : new Error(toMessage(cause, fallback));
}

export function normalizeClaudeStreamMessages(cause: Cause.Cause<Error>): ReadonlyArray<string> {
  const errors = Cause.prettyErrors(cause)
    .map((error) => error.message.trim())
    .filter((message) => message.length > 0);
  if (errors.length > 0) {
    return errors;
  }

  const squashed = toMessage(Cause.squash(cause), "").trim();
  return squashed.length > 0 ? [squashed] : [];
}

export function getEffectiveClaudeCodeEffort(
  effort: ClaudeCodeEffort | null | undefined,
): Exclude<ClaudeCodeEffort, "ultrathink"> | null {
  if (!effort) {
    return null;
  }
  return effort === "ultrathink" ? null : effort;
}

export function isClaudeInterruptedMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("all fibers interrupted without error") ||
    normalized.includes("request was aborted") ||
    normalized.includes("interrupted by user")
  );
}

export function isClaudeInterruptedCause(cause: Cause.Cause<Error>): boolean {
  return (
    Cause.hasInterruptsOnly(cause) ||
    normalizeClaudeStreamMessages(cause).some(isClaudeInterruptedMessage)
  );
}

export function messageFromClaudeStreamCause(cause: Cause.Cause<Error>, fallback: string): string {
  return normalizeClaudeStreamMessages(cause)[0] ?? fallback;
}

/** Claude exits with this when `resumeSessionAt` names an entry its loaded history lacks (e.g. compacted away). */
export function isClaudeMissingRewindPointText(text: string): boolean {
  return text.includes("No message found with message.uuid");
}

export function interruptionMessageFromClaudeCause(cause: Cause.Cause<Error>): string {
  const message = messageFromClaudeStreamCause(cause, "Claude runtime interrupted.");
  return isClaudeInterruptedMessage(message) ? "Claude runtime interrupted." : message;
}

export function resultErrorsText(result: SDKResultMessage): string {
  return "errors" in result && Array.isArray(result.errors)
    ? result.errors.join(" ").toLowerCase()
    : "";
}

export function isInterruptedResult(result: SDKResultMessage): boolean {
  // The CLI stamps user aborts explicitly (mid-tool-call / mid-stream).
  if (
    result.terminal_reason === "aborted_tools" ||
    result.terminal_reason === "aborted_streaming"
  ) {
    return true;
  }

  const errors = resultErrorsText(result);
  if (errors.includes("interrupt")) {
    return true;
  }

  return (
    result.subtype === "error_during_execution" &&
    result.is_error === false &&
    (errors.includes("request was aborted") ||
      errors.includes("interrupted by user") ||
      errors.includes("aborted"))
  );
}

export function asRuntimeItemId(value: string): RuntimeItemId {
  return RuntimeItemId.makeUnsafe(value);
}

/** Windows of the built-in models; `[1m]` on a selection always means the 1M window. */
const CLAUDE_CONTEXT_WINDOW_BY_MODEL: Readonly<Record<string, number>> = {
  "claude-fable-5-1": 1_000_000,
  "claude-opus-5-5": 1_000_000,
  "claude-sonnet-5-5": 1_000_000,
  "claude-haiku-5-5": 1_000_000,
  "claude-opus-4-6": 200_000,
  "claude-sonnet-4-6": 200_000,
  "claude-haiku-4-5": 200_000,
};

const CLAUDE_1M_MODEL_SUFFIX = /\[1m\]$/i;

/** The window of an SDK model id, or undefined for a model the table does not know. */
export function claudeContextWindowForApiModel(
  apiModelId: string | null | undefined,
): number | undefined {
  const model = apiModelId?.trim();
  if (!model) return undefined;
  if (CLAUDE_1M_MODEL_SUFFIX.test(model)) return 1_000_000;
  return Object.hasOwn(CLAUDE_CONTEXT_WINDOW_BY_MODEL, model)
    ? CLAUDE_CONTEXT_WINDOW_BY_MODEL[model]
    : undefined;
}

/** The window each model in `modelUsage` was measured against, as Claude Code resolved it. */
export function claudeReportedContextWindows(modelUsage: unknown): ReadonlyMap<string, number> {
  const windows = new Map<string, number>();
  if (!modelUsage || typeof modelUsage !== "object") return windows;
  for (const [model, value] of Object.entries(modelUsage as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const contextWindow = (value as { contextWindow?: unknown }).contextWindow;
    if (typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0) {
      windows.set(model, contextWindow);
    }
  }
  return windows;
}

/** A window reported for this model, under its selection id or its id without `[1m]`. */
export function claudeReportedContextWindowForModel(
  reported: ReadonlyMap<string, number>,
  apiModelId: string | null | undefined,
): number | undefined {
  const model = apiModelId?.trim();
  if (!model) return undefined;
  return reported.get(model) ?? reported.get(model.replace(CLAUDE_1M_MODEL_SUFFIX, ""));
}

/** The `[1m]` suffix, then Claude's own report for this model (it can differ from the table), then the table. */
export function claudeKnownContextWindowForModel(
  reported: ReadonlyMap<string, number>,
  apiModelId: string | null | undefined,
): number | undefined {
  if (apiModelId && CLAUDE_1M_MODEL_SUFFIX.test(apiModelId.trim())) return 1_000_000;
  return (
    claudeReportedContextWindowForModel(reported, apiModelId) ??
    claudeContextWindowForApiModel(apiModelId)
  );
}

/** What is known about this model, then the largest report, which may be a subagent's model. */
export function resolveClaudeResultContextWindow(
  apiModelId: string | null | undefined,
  modelUsage: unknown,
): number | undefined {
  return (
    claudeKnownContextWindowForModel(claudeReportedContextWindows(modelUsage), apiModelId) ??
    maxClaudeContextWindowFromModelUsage(modelUsage)
  );
}

export function maxClaudeContextWindowFromModelUsage(modelUsage: unknown): number | undefined {
  if (!modelUsage || typeof modelUsage !== "object") {
    return undefined;
  }

  let maxContextWindow: number | undefined;
  for (const value of Object.values(modelUsage as Record<string, unknown>)) {
    if (!value || typeof value !== "object") {
      continue;
    }
    const contextWindow = (value as { contextWindow?: unknown }).contextWindow;
    if (
      typeof contextWindow !== "number" ||
      !Number.isFinite(contextWindow) ||
      contextWindow <= 0
    ) {
      continue;
    }
    maxContextWindow = Math.max(maxContextWindow ?? 0, contextWindow);
  }

  return maxContextWindow;
}

export function normalizeClaudeTokenUsage(
  usage: unknown,
  contextWindow?: number,
): ThreadTokenUsageSnapshot | undefined {
  if (!usage || typeof usage !== "object") {
    return undefined;
  }

  const record = usage as Record<string, unknown>;
  const directUsedTokens =
    typeof record.total_tokens === "number" && Number.isFinite(record.total_tokens)
      ? record.total_tokens
      : undefined;
  const inputTokens =
    (typeof record.input_tokens === "number" && Number.isFinite(record.input_tokens)
      ? record.input_tokens
      : 0) +
    (typeof record.cache_creation_input_tokens === "number" &&
    Number.isFinite(record.cache_creation_input_tokens)
      ? record.cache_creation_input_tokens
      : 0) +
    (typeof record.cache_read_input_tokens === "number" &&
    Number.isFinite(record.cache_read_input_tokens)
      ? record.cache_read_input_tokens
      : 0);
  const outputTokens =
    typeof record.output_tokens === "number" && Number.isFinite(record.output_tokens)
      ? record.output_tokens
      : 0;
  const derivedTotalTokens = inputTokens + outputTokens;
  const totalProcessedTokens =
    directUsedTokens ?? (derivedTotalTokens > 0 ? derivedTotalTokens : undefined);
  if (totalProcessedTokens === undefined || totalProcessedTokens <= 0) {
    return undefined;
  }

  const maxTokens =
    typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0
      ? contextWindow
      : undefined;
  // Result usage is summed over every API call in the turn, so it can exceed the window.
  const usedTokens =
    maxTokens !== undefined ? Math.min(totalProcessedTokens, maxTokens) : totalProcessedTokens;

  return {
    usedTokens,
    lastUsedTokens: usedTokens,
    ...(totalProcessedTokens > usedTokens ? { totalProcessedTokens } : {}),
    ...(inputTokens > 0 ? { inputTokens } : {}),
    ...(outputTokens > 0 ? { outputTokens } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(typeof record.tool_uses === "number" && Number.isFinite(record.tool_uses)
      ? { toolUses: record.tool_uses }
      : {}),
    ...(typeof record.duration_ms === "number" && Number.isFinite(record.duration_ms)
      ? { durationMs: record.duration_ms }
      : {}),
  };
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Prompt tokens of one Claude API request: uncached input plus cache writes and reads. */
export function claudeUsageInputTokens(usage: Record<string, unknown>): number {
  return (
    (finiteNonNegative(usage.input_tokens) ?? 0) +
    (finiteNonNegative(usage.cache_creation_input_tokens) ?? 0) +
    (finiteNonNegative(usage.cache_read_input_tokens) ?? 0)
  );
}

/**
 * Merges a stream `message_delta` usage into its request's `message_start` usage. Delta usage is
 * cumulative for the message; fields it leaves null or absent keep their start value.
 */
export function mergeClaudeStreamUsage(
  current: Record<string, unknown>,
  delta: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(delta)) {
    if (value !== null && value !== undefined) merged[key] = value;
  }
  return merged;
}

/**
 * Context-window snapshot from one root request's usage (the latest `iterations` entry when
 * present). Usage without input tokens is a placeholder, never a measurement.
 */
export function claudeRequestContextUsage(
  usage: unknown,
  contextWindow?: number,
  totalProcessedTokens?: number,
): ThreadTokenUsageSnapshot | undefined {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return undefined;
  const record = usage as Record<string, unknown>;
  const iterations = Array.isArray(record.iterations) ? record.iterations : undefined;
  const lastIteration = iterations?.at(-1);
  const active =
    lastIteration && typeof lastIteration === "object" && !Array.isArray(lastIteration)
      ? (lastIteration as Record<string, unknown>)
      : record;
  const inputTokens = claudeUsageInputTokens(active);
  if (inputTokens <= 0) return undefined;
  const outputTokens = finiteNonNegative(active.output_tokens) ?? 0;
  const activeTokens = inputTokens + outputTokens;
  const maxTokens =
    typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0
      ? contextWindow
      : undefined;
  const usedTokens = maxTokens !== undefined ? Math.min(activeTokens, maxTokens) : activeTokens;
  return {
    usedTokens,
    lastUsedTokens: usedTokens,
    ...(totalProcessedTokens !== undefined && totalProcessedTokens > usedTokens
      ? { totalProcessedTokens }
      : {}),
    inputTokens,
    ...(outputTokens > 0 ? { outputTokens } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
  };
}

/** Context-window snapshot after a compaction, from `compact_boundary` metadata when it reports the size. */
export function claudeCompactBoundaryContextUsage(
  message: unknown,
  contextWindow?: number,
): ThreadTokenUsageSnapshot | undefined {
  const metadata = (message as { compact_metadata?: unknown } | undefined)?.compact_metadata;
  if (!metadata || typeof metadata !== "object") return undefined;
  const postTokens = finiteNonNegative((metadata as Record<string, unknown>).post_tokens);
  if (postTokens === undefined || postTokens <= 0) return undefined;
  const maxTokens =
    typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0
      ? contextWindow
      : undefined;
  const usedTokens = maxTokens !== undefined ? Math.min(postTokens, maxTokens) : postTokens;
  return {
    usedTokens,
    lastUsedTokens: usedTokens,
    ...(maxTokens !== undefined ? { maxTokens } : {}),
  };
}

export function asCanonicalTurnId(value: TurnId): TurnId {
  return value;
}

export function asRuntimeRequestId(value: ApprovalRequestId): RuntimeRequestId {
  return RuntimeRequestId.makeUnsafe(value);
}

export function readClaudeResumeState(resumeCursor: unknown): ClaudeResumeState | undefined {
  if (!resumeCursor || typeof resumeCursor !== "object") {
    return undefined;
  }
  const cursor = resumeCursor as {
    threadId?: unknown;
    resume?: unknown;
    sessionId?: unknown;
    resumeSessionAt?: unknown;
    turnCount?: unknown;
    turnEndMessageIds?: unknown;
    rewindTo?: unknown;
    goal?: unknown;
    goalSetAtTurn?: unknown;
  };

  const threadIdCandidate = typeof cursor.threadId === "string" ? cursor.threadId : undefined;
  const threadId =
    threadIdCandidate && !isSyntheticClaudeThreadId(threadIdCandidate)
      ? ThreadId.makeUnsafe(threadIdCandidate)
      : undefined;
  const resumeCandidate =
    typeof cursor.resume === "string"
      ? cursor.resume
      : typeof cursor.sessionId === "string"
        ? cursor.sessionId
        : undefined;
  const resume = resumeCandidate && isUuid(resumeCandidate) ? resumeCandidate : undefined;
  const resumeSessionAt =
    typeof cursor.resumeSessionAt === "string" ? cursor.resumeSessionAt : undefined;
  const turnCountValue = typeof cursor.turnCount === "number" ? cursor.turnCount : undefined;
  const turnEndMessageIds =
    Array.isArray(cursor.turnEndMessageIds) &&
    cursor.turnEndMessageIds.every((id: unknown) => id === null || typeof id === "string")
      ? (cursor.turnEndMessageIds as Array<string | null>)
      : undefined;
  const goal = readClaudeGoal(cursor.goal);

  return {
    ...(threadId ? { threadId } : {}),
    ...(resume ? { resume } : {}),
    ...(resumeSessionAt ? { resumeSessionAt } : {}),
    ...(turnEndMessageIds ? { turnEndMessageIds: [...turnEndMessageIds] } : {}),
    ...(typeof cursor.rewindTo === "string" && cursor.rewindTo.length > 0
      ? { rewindTo: cursor.rewindTo }
      : {}),
    ...(turnCountValue !== undefined && Number.isInteger(turnCountValue) && turnCountValue >= 0
      ? { turnCount: turnCountValue }
      : {}),
    ...(goal ? { goal } : {}),
    ...(goal && typeof cursor.goalSetAtTurn === "number"
      ? { goalSetAtTurn: cursor.goalSetAtTurn }
      : {}),
  };
}

const CLAUDE_MCP_TOOL_NAME = /^mcp__(.+?)__(.+)$/;

/** Server and tool of an `mcp__<server>__<tool>` name; claude.ai connectors carry a `claude_ai_` server prefix. */
export function parseClaudeMcpToolName(
  toolName: string,
): { readonly server: string; readonly tool: string } | undefined {
  const match = CLAUDE_MCP_TOOL_NAME.exec(toolName);
  if (!match?.[1] || !match[2]) return undefined;
  const server = match[1].replace(/^claude_ai_/, "");
  return { server: server.length > 0 ? server : match[1], tool: match[2] };
}

const normalizeClaudeToolName = (toolName: string) =>
  toolName.toLowerCase().replace(/[\s_-]+/g, "");

/** Claude's tools by what they do; anything else (TodoWrite, TaskCreate, CronCreate, Team*, KillShell) is dynamic. */
const CLAUDE_TOOL_ITEM_TYPES: ReadonlyMap<string, CanonicalItemType> = new Map([
  ["bash", "command_execution"],
  ["powershell", "command_execution"],
  ["edit", "file_change"],
  ["multiedit", "file_change"],
  ["write", "file_change"],
  ["notebookedit", "file_change"],
  ["task", "collab_agent_tool_call"],
  ["agent", "collab_agent_tool_call"],
  ["websearch", "web_search"],
]);

const CLAUDE_READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "read",
  "notebookread",
  "glob",
  "grep",
  "ls",
]);

/** The input field whose text streams into a preview card while Claude writes the call. */
const CLAUDE_TOOL_STREAM_FIELDS: ReadonlyMap<string, string> = new Map([
  ["write", "content"],
  ["edit", "new_string"],
  ["bash", "command"],
  ["powershell", "command"],
]);

export function classifyToolItemType(toolName: string): CanonicalItemType {
  if (parseClaudeMcpToolName(toolName)) {
    return "mcp_tool_call";
  }
  const normalized = normalizeClaudeToolName(toolName);
  // ListMcpResourcesTool, ReadMcpResourceTool and friends have no mcp__ prefix.
  if (normalized.includes("mcp")) {
    return "mcp_tool_call";
  }
  return CLAUDE_TOOL_ITEM_TYPES.get(normalized) ?? "dynamic_tool_call";
}

export function isReadOnlyToolName(toolName: string): boolean {
  return CLAUDE_READ_ONLY_TOOLS.has(normalizeClaudeToolName(toolName));
}

export function classifyRequestType(toolName: string): CanonicalRequestType {
  if (parseClaudeMcpToolName(toolName)) {
    return "dynamic_tool_call";
  }
  if (isReadOnlyToolName(toolName)) {
    return "file_read_approval";
  }
  const itemType = classifyToolItemType(toolName);
  return itemType === "command_execution"
    ? "command_execution_approval"
    : itemType === "file_change"
      ? "file_change_approval"
      : "dynamic_tool_call";
}

export function summarizeToolRequest(toolName: string, input: Record<string, unknown>): string {
  const commandValue = input.command ?? input.cmd;
  const command = typeof commandValue === "string" ? commandValue : undefined;
  if (command && command.trim().length > 0) {
    return `${toolName}: ${sliceSurrogateSafe(command.trim(), 400)}`;
  }

  const serialized = JSON.stringify(input);
  if (serialized.length <= 400) {
    return `${toolName}: ${serialized}`;
  }
  return `${toolName}: ${sliceSurrogateSafe(serialized, 397)}...`;
}

const CLAUDE_APPROVAL_TEXT_MAX_CHARS = 400;

/** Terminal escapes and stray controls come from Claude's prompt renderer or the model's input. */
function stripClaudeApprovalControls(value: string): string {
  // oxlint-disable-next-line no-control-regex -- removing these characters is the point
  return stripVTControlCharacters(value).replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "");
}

function claudeApprovalText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = stripClaudeApprovalControls(value).trim();
  return text === "" ? undefined : sliceSurrogateSafe(text, CLAUDE_APPROVAL_TEXT_MAX_CHARS);
}

/** The file an approval is about; a `path` next to `pattern` (Grep, Glob) only scopes the search. */
function claudeApprovalPath(input: Record<string, unknown>): string | undefined {
  return (
    claudeApprovalText(input.file_path) ??
    claudeApprovalText(input.notebook_path) ??
    (input.pattern === undefined ? claudeApprovalText(input.path) : undefined)
  );
}

/** What an approval card shows: the command, else Claude's prompt, else the file, else the raw input. */
export function claudeApprovalDetail(input: {
  readonly toolName: string;
  readonly toolInput: Record<string, unknown>;
  readonly title?: string | undefined;
  readonly description?: string | undefined;
}): string {
  const { toolName, toolInput } = input;
  const summary = stripClaudeApprovalControls(summarizeToolRequest(toolName, toolInput)).trim();
  // The user approves the command itself; Claude's title and description only summarize it.
  if (claudeApprovalText(toolInput.command ?? toolInput.cmd)) return summary;
  const prompt = claudeApprovalText(input.title) ?? claudeApprovalText(input.description);
  if (prompt) {
    // An MCP title names the action; the arguments are what is being approved.
    return parseClaudeMcpToolName(toolName) && Object.keys(toolInput).length > 0
      ? `${prompt}\n${summary}`
      : prompt;
  }
  // Any argument of an MCP tool can matter, so one named `path` must not stand in for the rest.
  const path = parseClaudeMcpToolName(toolName) ? undefined : claudeApprovalPath(toolInput);
  return path ? `${toolName}: ${path}` : summary;
}

const humanizeMcpNamePart = (value: string) => value.replace(/[_-]+/g, " ").trim();

export function titleForTool(itemType: CanonicalItemType, toolName?: string): string {
  const mcp = toolName === undefined ? undefined : parseClaudeMcpToolName(toolName);
  if (mcp) {
    return `${humanizeMcpNamePart(mcp.tool) || mcp.tool} (${humanizeMcpNamePart(mcp.server) || mcp.server})`;
  }
  switch (itemType) {
    case "command_execution":
      return "Command run";
    case "file_change":
      return "File change";
    case "mcp_tool_call":
      return "MCP tool call";
    case "collab_agent_tool_call":
      return "Subagent task";
    case "web_search":
      return "Web search";
    case "image_view":
      return "Image view";
    case "dynamic_tool_call":
      return "Tool call";
    default:
      return "Item";
  }
}

export const SUPPORTED_CLAUDE_IMAGE_MIME_TYPES: ReadonlySet<string> = new Set(
  PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES,
);

// MIME types are case-insensitive; the contract schema accepts any casing of `image/*`.
export function normalizeSupportedClaudeImageMimeType(mimeType: string): string | null {
  const normalized = mimeType.trim().toLowerCase();
  return isProviderSendTurnSupportedImageMimeType(normalized) ? normalized : null;
}

export const CLAUDE_SETTING_SOURCES = [
  "user",
  "project",
  "local",
] as const satisfies ReadonlyArray<SettingSource>;

/** CLI flags the SDK or adapter controls; a user launch argument with one of these names is dropped. */
export const CLAUDE_RESERVED_LAUNCH_FLAGS: ReadonlySet<string> = new Set([
  "allow-dangerously-skip-permissions",
  "await-initialize",
  "continue",
  "dangerously-skip-permissions",
  "effort",
  "fork-session",
  "include-hook-events",
  "include-partial-messages",
  "input-format",
  "model",
  "no-session-persistence",
  "output-format",
  "permission-mode",
  "permission-prompt-tool",
  "print",
  "replay-user-messages",
  "resume",
  "resume-drops-turn",
  "resume-session-at",
  "sdk-url",
  "session-id",
  "session-mirror",
  "setting-sources",
  "system-prompt",
  "verbose",
]);

/** Value-less Claude CLI flags, so a bare word after one is reported instead of becoming its value. */
const CLAUDE_BOOLEAN_LAUNCH_FLAGS: ReadonlySet<string> = new Set([
  "bare",
  "chrome",
  "debug-to-stderr",
  "disable-slash-commands",
  "ide",
  "mcp-debug",
  "no-chrome",
  "strict-mcp-config",
]);

export interface ClaudeLaunchExtraArgs {
  readonly extraArgs: Record<string, string | null>;
  /** Reserved `--flags`, short flags, bare values and everything after `--`, none of it forwarded. */
  readonly ignored: ReadonlyArray<string>;
  /** Every `--add-dir` value in order; `extraArgs` holds one value per flag, so these use the SDK option. */
  readonly additionalDirectories: ReadonlyArray<string>;
  /** The last `--append-system-prompt` text; the SDK's own append overrides the CLI flag, so it is folded in. */
  readonly appendSystemPrompt?: string;
  /** The last `--append-system-prompt-file` value; the SDK's append would drop the flag too, so it is read and folded in. */
  readonly appendSystemPromptFile?: string;
  /** An append flag given without a value; its instructions would silently vanish, so the session must not start. */
  readonly appendFlagMissingValue?: ClaudeAppendFlag;
  /** The raw `--settings` value, empty when the flag has none; the SDK replaces the flag with its own. */
  readonly settingsArg?: string;
}

export type ClaudeAppendFlag = "--append-system-prompt" | "--append-system-prompt-file";

/** Turns the `launchArgs` setting into SDK `extraArgs`, keeping only `--long` flags the SDK does not set itself. */
export function claudeLaunchExtraArgs(launchArgs: string | undefined): ClaudeLaunchExtraArgs {
  const tokens = tokenizeCliArgs(launchArgs);
  const extraArgs: Record<string, string | null> = {};
  const ignored: Array<string> = [];
  const additionalDirectories: Array<string> = [];
  let appendSystemPrompt: string | undefined;
  let appendSystemPromptFile: string | undefined;
  let appendFlagMissingValue: ClaudeAppendFlag | undefined;
  let settingsArg: string | undefined;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token === "--") {
      ignored.push(...tokens.slice(index + 1));
      break;
    }
    const rest = token.startsWith("--") ? token.slice(2) : "";
    if (!rest || rest.startsWith("=")) {
      ignored.push(token);
      continue;
    }
    const eqIndex = rest.indexOf("=");
    const name = eqIndex === -1 ? rest : rest.slice(0, eqIndex);
    let value: string | null = eqIndex === -1 ? null : rest.slice(eqIndex + 1);
    if (name === "add-dir") {
      // Variadic like the CLI's option, except `--add-dir=a`, which takes just that one value.
      const directories: Array<string> = value === null ? [] : [value];
      if (value === null) {
        for (
          let next = tokens[index + 1];
          next !== undefined && !next.startsWith("-");
          next = tokens[index + 1]
        ) {
          directories.push(next);
          index++;
        }
      }
      const named = directories.filter((directory) => directory.length > 0);
      if (named.length === 0) ignored.push("--add-dir");
      additionalDirectories.push(...named);
      continue;
    }
    const next = tokens[index + 1];
    if (name === "append-system-prompt" || name === "append-system-prompt-file") {
      // Folded out of extraArgs, so a dash-led value such as "- be brief" is safe to take.
      if (value === null && next !== undefined && !next.startsWith("--")) {
        value = next;
        index++;
      }
      if (name === "append-system-prompt") {
        if (value === null) appendFlagMissingValue = "--append-system-prompt";
        else appendSystemPrompt = value;
      } else if (!value) {
        appendFlagMissingValue = "--append-system-prompt-file";
      } else {
        appendSystemPromptFile = value;
      }
      continue;
    }
    // A following token starting with "-" is never a value: the SDK would emit `--flag=-x`, which the CLI rejects.
    if (
      value === null &&
      next !== undefined &&
      !next.startsWith("-") &&
      !CLAUDE_BOOLEAN_LAUNCH_FLAGS.has(name)
    ) {
      value = next;
      index++;
    }
    if (name === "settings") {
      settingsArg = value ?? "";
    } else if (CLAUDE_RESERVED_LAUNCH_FLAGS.has(name)) {
      ignored.push(`--${name}`);
    } else {
      extraArgs[name] = value;
    }
  }
  return {
    extraArgs,
    ignored,
    additionalDirectories,
    ...(appendSystemPrompt === undefined ? {} : { appendSystemPrompt }),
    ...(appendSystemPromptFile === undefined ? {} : { appendSystemPromptFile }),
    ...(appendFlagMissingValue === undefined ? {} : { appendFlagMissingValue }),
    ...(settingsArg === undefined ? {} : { settingsArg }),
  };
}

const decodeClaudeLaunchSettingsJson = Schema.decodeUnknownExit(
  fromLenientJson(Schema.Record(Schema.String, Schema.Unknown)),
);

/** Decodes `--settings` JSON text; undefined when it is not one JSON object. */
export function parseClaudeLaunchSettings(text: string): Record<string, unknown> | undefined {
  const decoded = decodeClaudeLaunchSettingsJson(text);
  if (Exit.isFailure(decoded) || Array.isArray(decoded.value)) return undefined;
  return decoded.value as Record<string, unknown>;
}

/** Launch arguments never pass through a shell, so a leading `~` is expanded here. */
function resolveClaudeLaunchPath(value: string, cwd: string | undefined): string {
  return Path.resolve(cwd ?? process.cwd(), expandHomePathForPlatform(value));
}

export function claudeAppendFlagMissingValueError(
  flag: ClaudeAppendFlag,
): ProviderAdapterValidationError {
  return new ProviderAdapterValidationError({
    provider: PROVIDER,
    operation: "startSession",
    issue:
      flag === "--append-system-prompt"
        ? `The --append-system-prompt launch argument has no text. Add it after the flag, written as --append-system-prompt="..." if it starts with dashes, then try again.`
        : `The --append-system-prompt-file launch argument has no file path. Add it after the flag in the Claude launch arguments, then try again.`,
  });
}

/** Reads an `--append-system-prompt-file` launch argument against the cwd, like the CLI. */
export const readClaudeLaunchAppendFile = Effect.fn("readClaudeLaunchAppendFile")(
  function* (input: {
    readonly fileArg: string;
    readonly cwd: string | undefined;
    readonly fileSystem: FileSystem.FileSystem;
  }) {
    const filePath = resolveClaudeLaunchPath(input.fileArg.trim(), input.cwd);
    const text = yield* input.fileSystem.readFileString(filePath).pipe(
      Effect.mapError(
        () =>
          new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Claude could not read the --append-system-prompt-file launch argument at ${filePath}. Fix the path in the Claude launch arguments, then try again.`,
          }),
      ),
    );
    return text.replace(/\r?\n$/u, "");
  },
);

/**
 * Reads a `--settings` launch argument the way the CLI does: a value starting with `{` is inline
 * JSON, anything else a file against the cwd. Errors never carry the cause or the inline text,
 * because a parse failure quotes its input and settings can hold credentials in `env`.
 */
export const readClaudeLaunchSettings = Effect.fn("readClaudeLaunchSettings")(function* (input: {
  readonly settingsArg: string;
  readonly cwd: string | undefined;
  readonly fileSystem: FileSystem.FileSystem;
}) {
  const failure = (filePath?: string) =>
    new ProviderAdapterValidationError({
      provider: PROVIDER,
      operation: "startSession",
      issue: `Claude could not read the --settings launch argument${
        filePath === undefined ? "" : ` at ${filePath}`
      } as a JSON object. Fix it in the Claude launch arguments, then try again.`,
    });
  const value = input.settingsArg.trim();
  if (value.length === 0) return yield* failure();
  if (value.startsWith("{")) {
    return parseClaudeLaunchSettings(value) ?? (yield* failure());
  }
  const filePath = resolveClaudeLaunchPath(value, input.cwd);
  const text = yield* input.fileSystem
    .readFileString(filePath)
    .pipe(Effect.mapError(() => failure(filePath)));
  return parseClaudeLaunchSettings(text) ?? (yield* failure(filePath));
});

/**
 * Background work keeping a session busy. The CLI's level signal outranks the task bookends, whose
 * end frame can go missing: an id it leaves out only counts during a turn, when it can be a
 * foreground subagent. CLIs that never send the level fall back to the bookends.
 */
export function claudeLiveBackgroundWorkCount(input: {
  readonly liveTaskIds: ReadonlySet<string>;
  readonly backgroundRoster: ReadonlySet<string> | undefined;
  readonly turnActive: boolean;
}): number {
  const { liveTaskIds, backgroundRoster, turnActive } = input;
  if (backgroundRoster === undefined) return liveTaskIds.size;
  if (!turnActive) return backgroundRoster.size;
  let count = backgroundRoster.size;
  for (const taskId of liveTaskIds) {
    if (!backgroundRoster.has(taskId)) count++;
  }
  return count;
}

// Claude Code holds its goal Stop check for these subagent types and for running local_bash tasks.
const CLAUDE_GOAL_DEFERRING_SUBAGENT_TYPES: ReadonlySet<string> = new Set([
  "local_agent",
  "remote_agent",
  "in_process_teammate",
  "local_workflow",
]);

/**
 * Tasks that keep Claude from checking a goal, which is not the idle count: an ambient subagent
 * defers the check though it is no activity, and a running mcp_task does not defer it. A shell off
 * the level has no agent behind it, so its id is a stale bookend; an unknown type counts.
 */
export function claudeGoalDeferringWorkCount(input: {
  readonly liveTaskIds: ReadonlySet<string>;
  readonly backgroundRoster: ReadonlySet<string> | undefined;
  readonly taskTypes: ReadonlyMap<string, string>;
}): number {
  const { liveTaskIds, backgroundRoster, taskTypes } = input;
  let count = 0;
  for (const taskId of new Set([...liveTaskIds, ...(backgroundRoster ?? [])])) {
    const taskType = taskTypes.get(taskId);
    if (
      taskType === undefined ||
      CLAUDE_GOAL_DEFERRING_SUBAGENT_TYPES.has(taskType) ||
      (taskType === "local_bash" &&
        (backgroundRoster === undefined || backgroundRoster.has(taskId)))
    ) {
      count++;
    }
  }
  return count;
}

export function buildPromptText(input: ProviderSendTurnInput): string {
  const rawEffort =
    input.modelSelection?.provider === "claudeAgent" ? input.modelSelection.options?.effort : null;
  const claudeModel =
    input.modelSelection?.provider === "claudeAgent" ? input.modelSelection.model : undefined;
  const caps = getClaudeModelCapabilities(claudeModel);

  // For prompt injection, we check if the raw effort is a prompt-injected level (e.g. "ultrathink").
  // resolveEffort strips prompt-injected values (returning the default instead), so we check the raw value directly.
  const trimmedEffort = trimOrNull(rawEffort);
  const promptEffort =
    trimmedEffort && caps.promptInjectedEffortLevels.includes(trimmedEffort) ? trimmedEffort : null;
  const text = input.input?.trim() ?? "";
  return isClaudeSlashCommandPrompt(text)
    ? text
    : applyClaudePromptEffortPrefix(text, promptEffort);
}

export function buildUserMessage(input: {
  readonly sdkContent: Array<Record<string, unknown>>;
}): SDKUserMessage {
  return {
    type: "user",
    session_id: "",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: input.sdkContent as unknown as SDKUserMessage["message"]["content"],
    },
  } as SDKUserMessage;
}

export function buildClaudeImageContentBlock(input: {
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}): Record<string, unknown> {
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: input.mimeType,
      data: Buffer.from(input.bytes).toString("base64"),
    },
  };
}

type ClaudeAttachmentReadDependencies = {
  readonly fileSystem: FileSystem.FileSystem;
  readonly attachmentsDir: string;
};

const readClaudeImageContentBlock = Effect.fn("readClaudeImageContentBlock")(function* (
  attachment: ChatAttachment,
  dependencies: ClaudeAttachmentReadDependencies,
) {
  const mimeType = normalizeSupportedClaudeImageMimeType(attachment.mimeType);
  if (!mimeType) {
    return yield* new ProviderAdapterRequestError({
      provider: PROVIDER,
      method: "turn/start",
      detail: `Unsupported Claude image attachment type '${attachment.mimeType}'. Attach GIF, JPEG, PNG, or WebP images.`,
    });
  }

  const attachmentPath = resolveAttachmentPath({
    attachmentsDir: dependencies.attachmentsDir,
    attachment,
  });
  if (!attachmentPath) {
    return yield* new ProviderAdapterRequestError({
      provider: PROVIDER,
      method: "turn/start",
      detail: `Invalid attachment id '${attachment.id}'.`,
    });
  }

  const bytes = yield* dependencies.fileSystem.readFile(attachmentPath).pipe(
    Effect.mapError(
      (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "turn/start",
          detail: toMessage(cause, "Failed to read attachment file."),
          cause,
        }),
    ),
  );

  return { block: buildClaudeImageContentBlock({ mimeType, bytes }), byteLength: bytes.byteLength };
});

/** Undefined for anything unreadable or oversized, which then stays path-only. */
const readClaudePdfAttachmentBytes = (
  attachment: ChatAttachment,
  dependencies: ClaudeAttachmentReadDependencies,
  /** What the session can still retain, as base64; a file that cannot fit is not read at all. */
  remainingRetainedBytes: number,
): Effect.Effect<Uint8Array | undefined> =>
  Effect.gen(function* () {
    const attachmentPath = resolveAttachmentPath({
      attachmentsDir: dependencies.attachmentsDir,
      attachment,
    });
    if (!attachmentPath) return undefined;
    const info = yield* dependencies.fileSystem.stat(attachmentPath);
    if (
      info.type !== "File" ||
      Number(info.size) > PROVIDER_SEND_TURN_MAX_FILE_BYTES ||
      claudeBase64RetainedBytes(Number(info.size)) > remainingRetainedBytes
    ) {
      return undefined;
    }
    return yield* dependencies.fileSystem.readFile(attachmentPath);
  }).pipe(Effect.orElseSucceed(() => undefined));

/**
 * Builds the user message, sending the PDFs the session's budget has room for as document blocks.
 * The caller settles the returned reservation once the message is queued or not.
 */
export const buildUserMessageWithPdfBudgetEffect = Effect.fn("buildUserMessageWithPdfBudgetEffect")(
  function* (
    input: ProviderSendTurnInput,
    dependencies: ClaudeAttachmentReadDependencies & {
      readonly pdfBudget: ClaudeAttachmentBudget;
    },
  ) {
    const text = buildPromptText(input);
    const parts: Array<
      | { readonly kind: "image"; readonly block: Record<string, unknown> }
      | { readonly kind: "pdf"; readonly index: number }
    > = [];
    const imageBytes: Array<number> = [];
    const pdfs: Array<Uint8Array> = [];

    // Every read comes before the reservation, so a failed read has nothing to roll back.
    for (const attachment of input.attachments ?? []) {
      if (attachment.type === "image") {
        const image = yield* readClaudeImageContentBlock(attachment, dependencies);
        imageBytes.push(image.byteLength);
        parts.push({ kind: "image", block: image.block });
        continue;
      }
      // A session with no pages left would only read the file to drop it again.
      if (dependencies.pdfBudget.remainingPages() <= 0) continue;
      const bytes = yield* readClaudePdfAttachmentBytes(
        attachment,
        dependencies,
        dependencies.pdfBudget.remainingBytes(),
      );
      if (bytes) {
        parts.push({ kind: "pdf", index: pdfs.length });
        pdfs.push(bytes);
      }
    }

    return yield* Effect.try({
      try: () => {
        const reservation = dependencies.pdfBudget.reserve({
          textBytes: Buffer.byteLength(JSON.stringify({ type: "text", text })),
          imageBytes,
          pdfs,
        });
        try {
          const sdkContent = parts.flatMap((part) => {
            if (part.kind === "image") return [part.block];
            return reservation.documentIndexes.has(part.index)
              ? [buildClaudePdfDocumentBlock(pdfs[part.index]!)]
              : [];
          });
          // The CLI only expands slash commands when the final content block is text.
          if (text.length > 0) {
            sdkContent.push({ type: "text", text });
          }
          return { message: buildUserMessage({ sdkContent }), reservation };
        } catch (cause) {
          reservation.rollback();
          throw cause;
        }
      },
      catch: (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "turn/start",
          detail: toMessage(cause, "Failed to prepare attachments."),
          cause,
        }),
    });
  },
);

export const CLAUDE_CONTEXT_WINDOW_FULL_MESSAGE =
  "Claude stopped: the prompt exceeds the model's context window. Run /compact or start a new thread.";

/** Failure text for terminal reasons the CLI uses for dead turns, even on success-tagged results. */
export function terminalResultError(
  reason: SDKResultMessage["terminal_reason"],
  failureHint?: string,
): string | undefined {
  switch (reason) {
    case "api_error":
      return failureHint ?? "Claude gave up after repeated API errors.";
    case "malformed_tool_use_exhausted":
      return "Claude gave up after repeated malformed tool calls.";
    case "budget_exhausted":
      return "Claude stopped: the turn's token budget was exhausted.";
    case "structured_output_retry_exhausted":
      return "Claude could not produce the requested structured output.";
    case "tool_deferred_unavailable":
      return "Claude could not resume a deferred tool call: the tool is no longer available.";
    case "turn_setup_failed":
      return "Claude could not start the turn.";
    case "blocking_limit":
      return failureHint ?? CLAUDE_CONTEXT_WINDOW_FULL_MESSAGE;
    case "rapid_refill_breaker":
      return "Claude stopped: the context refilled too quickly after compaction.";
    case "prompt_too_long":
      return CLAUDE_CONTEXT_WINDOW_FULL_MESSAGE;
    case "image_error":
      return "Claude stopped: an image in the conversation could not be processed.";
    case "model_error":
      return "Claude stopped: the model returned an error.";
    default:
      return undefined;
  }
}

/** The CLI reports repeated 529s as a success result with api_error_status 529. */
function isOverloadedResult(result: SDKResultMessage): boolean {
  return result.subtype === "success" && result.api_error_status === 529;
}

/** "API Error: ..." result text the CLI writes for a success-tagged api_error turn. */
function apiErrorResultText(result: SDKResultMessage): string | undefined {
  if (result.subtype !== "success" || typeof result.result !== "string") {
    return undefined;
  }
  const text = result.result.trim();
  return text.startsWith("API Error:") ? sliceSurrogateSafe(text, 500) : undefined;
}

/**
 * Derives turn status and its user-facing error from one result. `failureHint`
 * is turn evidence (expired login, rejected usage window) that names the cause.
 */
export function resultOutcome(
  result: SDKResultMessage,
  failureHint?: string,
): { status: ProviderRuntimeTurnStatus; errorMessage: string | undefined } {
  const successTaggedFailure = result.subtype === "success" && result.is_error === true;
  const structuredError = isOverloadedResult(result)
    ? "Claude API is overloaded (529). Try again shortly."
    : (terminalResultError(
        result.terminal_reason,
        failureHint ??
          (result.terminal_reason === "api_error" ? apiErrorResultText(result) : undefined),
      ) ?? (successTaggedFailure ? failureHint : undefined));
  // "[ede_diagnostic] ..." entries are CLI-internal and must never become the error banner.
  const listedErrors: ReadonlyArray<unknown> =
    "errors" in result && Array.isArray(result.errors) ? result.errors : [];
  const listedError =
    result.subtype === "success" && !successTaggedFailure
      ? undefined
      : listedErrors.find(
          (error): error is string =>
            typeof error === "string" &&
            error.trim().length > 0 &&
            !error.startsWith("[ede_diagnostic]"),
        );
  const errorMessage = listedError || structuredError;
  if (isInterruptedResult(result)) return { status: "interrupted", errorMessage };
  if (structuredError !== undefined) return { status: "failed", errorMessage };
  if (result.subtype === "success") return { status: "completed", errorMessage: undefined };
  return {
    status: resultErrorsText(result).includes("cancel") ? "cancelled" : "failed",
    errorMessage,
  };
}

export const CLAUDE_AUTH_FAILURE_MESSAGE =
  "Claude could not authenticate. For subscription login, run `claude auth login` on this machine; for API-key authentication, check the configured credentials. Then send the message again.";

/** A plain `claude auth login` signs in the default account, not a configured directory. */
export function claudeAuthFailureMessage(configDir: string | undefined): string {
  return configDir === undefined
    ? CLAUDE_AUTH_FAILURE_MESSAGE
    : `Claude could not authenticate for ${configDir}. For subscription login, run \`claude auth login\` with CLAUDE_CONFIG_DIR set to that directory; for API-key authentication, check the configured credentials. Then send the message again.`;
}

export const CLAUDE_USAGE_LIMIT_FAILURE_MESSAGE =
  "Claude usage limit reached. Send the message again once the limit resets.";

const CLAUDE_USAGE_LIMIT_WINDOWS = {
  five_hour: "5-hour",
  seven_day: "7-day",
  seven_day_opus: "7-day Opus",
  seven_day_sonnet: "7-day Sonnet",
  seven_day_overage_included: "7-day model",
  overage: "overage",
} satisfies Record<NonNullable<SDKRateLimitInfo["rateLimitType"]>, string>;

/** Beyond this the reset time is not credible, so the notice ships without a wait. */
const CLAUDE_USAGE_LIMIT_MAX_WAIT_MS = 30 * 24 * 60 * 60 * 1000;

/** True when overage keeps the account running despite a rejected window. */
export function isClaudeOverageAllowed(info: SDKRateLimitInfo): boolean {
  return (
    info.overageStatus === "allowed" ||
    info.overageStatus === "allowed_warning" ||
    info.isUsingOverage === true ||
    info.overageInUse === true
  );
}

/** A rejected window with no overage parks the turn inside the SDK. */
export function isClaudeUsageLimitBlocking(info: SDKRateLimitInfo): boolean {
  return info.status === "rejected" && !isClaudeOverageAllowed(info);
}

export function formatClaudeUsageLimitWait(waitMs: number): string {
  const totalMinutes = Math.ceil(waitMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${totalMinutes}m`;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

/** States the remaining wait (not a wall-clock time) since clients may be in other timezones. */
export function describeClaudeUsageLimit(info: SDKRateLimitInfo, nowMs: number): string {
  const label = info.rateLimitType ? CLAUDE_USAGE_LIMIT_WINDOWS[info.rateLimitType] : undefined;
  const resetsAtMs =
    typeof info.resetsAt === "number" && Number.isFinite(info.resetsAt)
      ? info.resetsAt * 1000
      : undefined;
  const waitMs =
    resetsAtMs === undefined || !Number.isFinite(nowMs) ? undefined : resetsAtMs - nowMs;
  const wait =
    waitMs !== undefined && waitMs > 0 && waitMs <= CLAUDE_USAGE_LIMIT_MAX_WAIT_MS
      ? formatClaudeUsageLimitWait(waitMs)
      : undefined;
  return `Claude usage limit reached. This turn is paused until the ${
    label ? `${label} ` : ""
  }limit resets${wait ? ` in ${wait}` : ""}.`;
}

/**
 * The window a root assistant frame says is blocking. The CLI throttles unchanged `rate_limit_event`
 * frames but repeats this payload on each blocked response, so a quick retry may carry only this.
 * `api_error_params` is not in the SDK types, so everything under it is read as unknown.
 */
export function readAssistantRateLimitWindow(
  message: unknown,
): ClaudeAssistantRateLimitWindow | undefined {
  const params = (message as { readonly api_error_params?: unknown } | undefined)?.api_error_params;
  const info =
    params && typeof params === "object"
      ? (params as { readonly rate_limit_info?: unknown }).rate_limit_info
      : undefined;
  if (!info || typeof info !== "object") return undefined;
  if (!isClaudeUsageLimitBlocking(info as SDKRateLimitInfo)) return undefined;
  const { rateLimitType, resetsAt } = info as {
    readonly rateLimitType?: unknown;
    readonly resetsAt?: unknown;
  };
  return {
    type:
      typeof rateLimitType === "string" && rateLimitType.trim().length > 0
        ? rateLimitType
        : "unknown",
    resetsAt: typeof resetsAt === "number" ? resetsAt : null,
  };
}

export interface ClaudeAssistantRateLimitWindow {
  readonly type: string;
  /** Epoch seconds; null when the frame names none. */
  readonly resetsAt: number | null;
}

/** Whether the result is consistent with a usage limit, not another failure after a rejected window. */
function isResultUsageLimited(result: SDKResultMessage | undefined): boolean {
  if (!result) return true;
  const { api_error_status: apiErrorStatus, terminal_reason: terminalReason } = result as {
    readonly api_error_status?: number | null;
    readonly terminal_reason?: string | null;
  };
  if (apiErrorStatus !== undefined && apiErrorStatus !== null && apiErrorStatus !== 429) {
    return false;
  }
  return (
    terminalReason === undefined ||
    terminalReason === null ||
    terminalReason === "api_error" ||
    terminalReason === "blocking_limit"
  );
}

/**
 * `turn.completed` fields for a turn that failed on a usage limit; empty otherwise. The turn can
 * only run again once every limit has reset, so this is the latest reset, or null if any is unknown.
 * A failure with another cause stays out, because these fields arm an automatic resume.
 */
export function claudeRateLimitCompletionFields(input: {
  readonly status: ProviderRuntimeTurnStatus;
  readonly rejectedRateLimitTypes: ReadonlyMap<string, number | null>;
  readonly latestAssistantRateLimited: boolean;
  readonly assistantRateLimitWindow?: ClaudeAssistantRateLimitWindow | undefined;
  readonly authenticationFailed?: boolean | undefined;
  readonly result: SDKResultMessage | undefined;
}): { readonly rateLimitResetAt?: string | null; readonly rateLimitTypes?: ReadonlyArray<string> } {
  if (input.status !== "failed") return {};
  if (input.authenticationFailed || !isResultUsageLimited(input.result)) return {};
  const resets = new Map(input.rejectedRateLimitTypes);
  const assistantWindow = input.assistantRateLimitWindow;
  // An event's reset wins, as the frame can lag it.
  if (assistantWindow && !resets.has(assistantWindow.type)) {
    resets.set(assistantWindow.type, assistantWindow.resetsAt);
  }
  if (resets.size === 0 && !input.latestAssistantRateLimited) return {};

  let latestSeconds: number | null = null;
  let unknownReset = resets.size === 0;
  for (const resetsAt of resets.values()) {
    if (resetsAt === null || !Number.isFinite(resetsAt) || resetsAt <= 0) unknownReset = true;
    else if (latestSeconds === null || resetsAt > latestSeconds) latestSeconds = resetsAt;
  }
  const latest = unknownReset || latestSeconds === null ? null : new Date(latestSeconds * 1000);
  return {
    rateLimitResetAt: latest && !Number.isNaN(latest.getTime()) ? latest.toISOString() : null,
    rateLimitTypes: Array.from(resets.keys()).filter((limitType) => limitType !== "unknown"),
  };
}

export function turnStatusFromResult(result: SDKResultMessage): ProviderRuntimeTurnStatus {
  return resultOutcome(result).status;
}

export function streamKindFromDeltaType(deltaType: string): ClaudeTextStreamKind {
  return deltaType.includes("thinking") ? "reasoning_summary_text" : "assistant_text";
}

export function nativeProviderRefs(options?: {
  readonly providerItemId?: string | undefined;
}): NonNullable<ProviderRuntimeEvent["providerRefs"]> {
  if (options?.providerItemId) {
    return {
      providerItemId: ProviderItemId.makeUnsafe(options.providerItemId),
    };
  }
  return {};
}

/**
 * Claude 5.1 and later return the text written ahead of a tool call as a thinking block.
 * Summarized display cannot mark it, so only the second of two blocks before a call counts.
 */
export function claudeWritesUpdatesAsThinking(model: string): boolean {
  const match = /claude-[a-z]+-(\d+)(?:-(\d{1,2}))?(?!\d)/u.exec(model);
  if (match === null) return false;
  const major = Number(match[1]);
  return major > 5 || (major === 5 && Number(match[2] ?? 0) >= 1);
}

/** Text of an assistant snapshot, in block order; `endBlock` stops at that content position. */
export function extractAssistantTextBlocks(message: SDKMessage, endBlock?: number): Array<string> {
  if (message.type !== "assistant") {
    return [];
  }

  const content = (message.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) {
    return [];
  }

  const fragments: string[] = [];
  for (const block of content.slice(0, endBlock)) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const candidate = block as { type?: unknown; text?: unknown };
    if (
      candidate.type === "text" &&
      typeof candidate.text === "string" &&
      candidate.text.length > 0
    ) {
      fragments.push(candidate.text);
    }
  }

  return fragments;
}

export function extractContentBlockText(block: unknown): string {
  if (!block || typeof block !== "object") {
    return "";
  }

  const candidate = block as { type?: unknown; text?: unknown };
  return candidate.type === "text" && typeof candidate.text === "string" ? candidate.text : "";
}

export function extractTextContent(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => extractTextContent(entry)).join("");
  }

  if (!value || typeof value !== "object") {
    return "";
  }

  const record = value as {
    text?: unknown;
    content?: unknown;
  };

  if (typeof record.text === "string") {
    return record.text;
  }

  return extractTextContent(record.content);
}

/** True for frames the SDK forwards from a Task subagent rather than the parent agent. */
export function isSubagentMessage(message: SDKMessage): boolean {
  const parentToolUseId = (message as { parent_tool_use_id?: unknown }).parent_tool_use_id;
  return typeof parentToolUseId === "string" && parentToolUseId.length > 0;
}

/** The tool call a frame belongs to; null for the root agent. */
export function parentToolUseIdFromMessage(message: SDKMessage): string | null {
  const parentToolUseId = (message as { parent_tool_use_id?: unknown }).parent_tool_use_id;
  return typeof parentToolUseId === "string" && parentToolUseId.length > 0 ? parentToolUseId : null;
}

/** How a tool the turn left open ended: a stop is not a failure. */
export function claudeOpenToolStatusForTurn(
  turnStatus: ProviderRuntimeTurnStatus,
): "completed" | "failed" | "stopped" {
  return turnStatus === "completed" ? "completed" : turnStatus === "failed" ? "failed" : "stopped";
}

export function isTodoTool(toolName: string): boolean {
  return toolName.toLowerCase().includes("todowrite");
}

/** Maps TodoWrite input (`{ todos: [{ content, status }] }`) to plan steps; null when it has none. */
export function extractPlanStepsFromTodoInput(input: unknown): RuntimePlanStep[] | null {
  if (!input || typeof input !== "object") return null;
  const todos = (input as { todos?: unknown }).todos;
  if (!Array.isArray(todos)) return null;
  const steps = todos
    .filter((todo): todo is Record<string, unknown> => todo !== null && typeof todo === "object")
    .map(
      (todo): RuntimePlanStep => ({
        step:
          typeof todo.content === "string" && todo.content.trim().length > 0
            ? todo.content.trim()
            : "Task",
        status:
          todo.status === "completed"
            ? "completed"
            : todo.status === "in_progress"
              ? "inProgress"
              : "pending",
      }),
    );
  return steps.length > 0 ? steps : null;
}

/** One entry of a Claude session's task list (TaskCreate/TaskUpdate/TaskList), keyed by Claude's task id. */
export interface ClaudeTaskEntry {
  readonly subject: string;
  readonly status: RuntimePlanStep["status"];
}

const CLAUDE_TASK_TOOL_NAMES: ReadonlySet<string> = new Set([
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
]);

export function isClaudeTaskTool(toolName: string): boolean {
  return CLAUDE_TASK_TOOL_NAMES.has(toolName);
}

function claudeTaskField(value: unknown, key: string): unknown {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function claudeTaskString(value: unknown, key: string): string | undefined {
  const field = claudeTaskField(value, key);
  if (typeof field === "number" && Number.isFinite(field)) return String(field);
  return typeof field === "string" && field.trim().length > 0 ? field.trim() : undefined;
}

function claudeTaskStatus(value: unknown): RuntimePlanStep["status"] | undefined {
  switch (value) {
    case "pending":
      return "pending";
    case "in_progress":
      return "inProgress";
    case "completed":
      return "completed";
    default:
      return undefined;
  }
}

/**
 * Applies a successful TaskCreate/TaskUpdate/TaskList call to a session's task map in place.
 * `result` is the structured `tool_use_result`, or the text result subagents get
 * ("Task #3 created successfully: <subject>", "Updated task #3 ..."). TaskList replaces the map,
 * a `deleted` status removes the task. Returns whether the map changed.
 */
export function applyClaudeTaskToolResult(
  tasks: Map<string, ClaudeTaskEntry>,
  toolName: string,
  input: unknown,
  result: unknown,
): boolean {
  if (toolName === "TaskList") {
    const listed = claudeTaskField(result, "tasks");
    if (!Array.isArray(listed)) return false;
    const next = new Map<string, ClaudeTaskEntry>();
    for (const task of listed) {
      const id = claudeTaskString(task, "id");
      const subject = claudeTaskString(task, "subject");
      const status = claudeTaskStatus(claudeTaskField(task, "status"));
      if (id !== undefined && subject !== undefined && status !== undefined) {
        next.set(id, { subject, status });
      }
    }
    if (next.size === 0 && tasks.size === 0) return false;
    tasks.clear();
    for (const [id, task] of next) tasks.set(id, task);
    return true;
  }
  if (toolName === "TaskCreate") {
    const created = claudeTaskField(result, "task");
    const fromText =
      typeof result === "string"
        ? /^Task #(\S+) created successfully: (.+)$/s.exec(result.trim())
        : null;
    const id = claudeTaskString(created, "id") ?? fromText?.[1];
    const subject =
      claudeTaskString(created, "subject") ??
      fromText?.[2]?.trim() ??
      claudeTaskString(input, "subject");
    if (id === undefined || subject === undefined) return false;
    tasks.set(id, { subject, status: "pending" });
    return true;
  }
  if (
    toolName !== "TaskUpdate" ||
    claudeTaskField(result, "success") === false ||
    (typeof result === "string" && !result.trim().startsWith("Updated task #"))
  ) {
    return false;
  }
  const id = claudeTaskString(input, "taskId") ?? claudeTaskString(result, "taskId");
  const task = id === undefined ? undefined : tasks.get(id);
  if (id === undefined || task === undefined) return false;
  const nativeStatus = claudeTaskField(input, "status");
  if (nativeStatus === "deleted") {
    tasks.delete(id);
    return true;
  }
  const subject = claudeTaskString(input, "subject") ?? task.subject;
  const status = claudeTaskStatus(nativeStatus) ?? task.status;
  if (subject === task.subject && status === task.status) return false;
  tasks.set(id, { subject, status });
  return true;
}

/** Claude's on-disk task list directory for a session (`<config>/tasks/<list id>`). */
export function claudeTaskStoreDirectory(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homeDir: string;
  readonly cwd: string | undefined;
  readonly sessionId: string;
}): string {
  const configDirOverride = input.env.CLAUDE_CONFIG_DIR?.trim();
  const configDir = configDirOverride
    ? Path.resolve(input.cwd ?? ".", configDirOverride)
    : Path.join(input.homeDir, ".claude");
  const listId = input.env.CLAUDE_CODE_TASK_LIST_ID?.trim() || input.sessionId;
  return Path.join(configDir, "tasks", listId.replace(/[^a-zA-Z0-9_-]/g, "-"));
}

/** One `<n>.json` file of Claude's task store, or undefined for internal or malformed tasks. */
export function parseClaudeTaskStoreFile(
  contents: string,
): (ClaudeTaskEntry & { readonly id: string }) | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return undefined;
  }
  const id = claudeTaskString(parsed, "id");
  const subject = claudeTaskString(parsed, "subject");
  const status = claudeTaskStatus(claudeTaskField(parsed, "status"));
  const metadata = claudeTaskField(parsed, "metadata");
  if (id === undefined || subject === undefined || status === undefined) return undefined;
  if (claudeTaskField(metadata, "_internal")) return undefined;
  return { id, subject, status };
}

/** Reads Claude's persisted task list in id order; undefined when the store is missing or unreadable. */
export const readClaudeTaskStore = Effect.fn("readClaudeTaskStore")(
  function* (fileSystem: FileSystem.FileSystem, directory: string) {
    const names = (yield* fileSystem.readDirectory(directory))
      .filter((name) => /^\d+\.json$/.test(name))
      .toSorted((left, right) => Number.parseInt(left, 10) - Number.parseInt(right, 10));
    const tasks = new Map<string, ClaudeTaskEntry>();
    for (const name of names) {
      const contents = yield* fileSystem
        .readFileString(Path.join(directory, name))
        .pipe(Effect.orElseSucceed(() => ""));
      const task = parseClaudeTaskStoreFile(contents);
      if (task) tasks.set(task.id, { subject: task.subject, status: task.status });
    }
    return tasks;
  },
  Effect.orElseSucceed((): Map<string, ClaudeTaskEntry> | undefined => undefined),
);

export function planStepsFromClaudeTasks(
  tasks: ReadonlyMap<string, ClaudeTaskEntry>,
): RuntimePlanStep[] {
  return Array.from(tasks.values(), (task) => ({ step: task.subject, status: task.status }));
}

export function extractExitPlanModePlan(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as {
    plan?: unknown;
  };
  return typeof record.plan === "string" && record.plan.trim().length > 0
    ? record.plan.trim()
    : undefined;
}

export function exitPlanCaptureKey(input: {
  readonly toolUseId?: string | undefined;
  readonly planMarkdown: string;
}): string {
  return input.toolUseId && input.toolUseId.length > 0
    ? `tool:${input.toolUseId}`
    : `plan:${input.planMarkdown}`;
}

export function tryParseJsonRecord(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export function toolInputFingerprint(input: Record<string, unknown>): string | undefined {
  try {
    return JSON.stringify(input);
  } catch {
    return undefined;
  }
}

export function toolResultStreamKind(
  itemType: CanonicalItemType,
): ClaudeToolResultStreamKind | undefined {
  switch (itemType) {
    case "command_execution":
      return "command_output";
    case "file_change":
      return "file_change_output";
    default:
      return undefined;
  }
}

export function toolResultBlocksFromUserMessage(message: SDKMessage): Array<{
  readonly toolUseId: string;
  readonly block: Record<string, unknown>;
  readonly text: string;
  readonly isError: boolean;
}> {
  if (message.type !== "user") {
    return [];
  }

  const content = (message.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) {
    return [];
  }

  const blocks: Array<{
    readonly toolUseId: string;
    readonly block: Record<string, unknown>;
    readonly text: string;
    readonly isError: boolean;
  }> = [];

  for (const entry of content) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const block = entry as Record<string, unknown>;
    if (block.type !== "tool_result") {
      continue;
    }

    const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : undefined;
    if (!toolUseId) {
      continue;
    }

    blocks.push({
      toolUseId,
      block,
      text: extractTextContent(block.content),
      isError: block.is_error === true,
    });
  }

  return blocks;
}

/** Max characters of tool result text kept in persisted tool lifecycle events. */
export const MAX_PERSISTED_TOOL_RESULT_TEXT_LENGTH = 4_000;

function imageMimeTypeOf(record: Record<string, unknown>): string | undefined {
  const source =
    record.source && typeof record.source === "object"
      ? (record.source as Record<string, unknown>)
      : undefined;
  for (const candidate of [
    source?.media_type,
    record.mimeType,
    record.media_type,
    record.mime_type,
  ]) {
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return undefined;
}

/**
 * Copy of a Claude tool_result block safe to persist in the activity log: image bodies
 * (Anthropic `source.data` and MCP `data` shapes) become `{ type: "image", mimeType }`
 * placeholders and text is capped at a shared budget.
 */
export function sanitizeToolResultForPersistence(
  block: Record<string, unknown>,
  maxTextLength: number = MAX_PERSISTED_TOOL_RESULT_TEXT_LENGTH,
): Record<string, unknown> {
  let remaining = maxTextLength;
  const capText = (text: string): string => {
    if (text.length <= remaining) {
      remaining -= text.length;
      return text;
    }
    const kept = sliceSurrogateSafe(text, Math.max(0, remaining));
    remaining = 0;
    return `${kept}\u2026 [truncated ${text.length - kept.length} characters]`;
  };
  const visit = (value: unknown, depth: number): unknown => {
    if (typeof value === "string") return capText(value);
    if (!value || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    if (!Array.isArray(value) && record.type === "image") {
      const mimeType = imageMimeTypeOf(record);
      return mimeType ? { type: "image", mimeType } : { type: "image" };
    }
    if (depth > 8) return "[omitted]";
    if (Array.isArray(value)) return value.map((entry) => visit(entry, depth + 1));
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(record)) {
      result[key] = key === "tool_use_id" || key === "type" ? entry : visit(entry, depth + 1);
    }
    return result;
  };
  return visit(block, 0) as Record<string, unknown>;
}

export function toSessionError(
  threadId: ThreadId,
  cause: unknown,
): ProviderAdapterSessionNotFoundError | ProviderAdapterSessionClosedError | undefined {
  const normalized = toMessage(cause, "").toLowerCase();
  if (normalized.includes("unknown session") || normalized.includes("not found")) {
    return new ProviderAdapterSessionNotFoundError({
      provider: PROVIDER,
      threadId,
      cause,
    });
  }
  if (normalized.includes("closed")) {
    return new ProviderAdapterSessionClosedError({
      provider: PROVIDER,
      threadId,
      cause,
    });
  }
  return undefined;
}

export function toRequestError(
  threadId: ThreadId,
  method: string,
  cause: unknown,
): ProviderAdapterError {
  const sessionError = toSessionError(threadId, cause);
  if (sessionError) {
    return sessionError;
  }
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: toMessage(cause, `${method} failed`),
    cause,
  });
}

export function sdkMessageType(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as { type?: unknown };
  return typeof record.type === "string" ? record.type : undefined;
}

export function sdkMessageSubtype(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as { subtype?: unknown };
  return typeof record.subtype === "string" ? record.subtype : undefined;
}

/** Messages a compaction kept in Claude's resumable chain; older CLIs report only the segment's ends. */
export function claudeCompactPreservedMessageIds(
  message: Pick<SDKCompactBoundaryMessage, "compact_metadata">,
): ReadonlySet<string> {
  const preservedMessages = message.compact_metadata?.preserved_messages;
  const preservedSegment = message.compact_metadata?.preserved_segment;
  if (preservedMessages) return new Set(preservedMessages.uuids);
  return new Set(preservedSegment ? [preservedSegment.head_uuid, preservedSegment.tail_uuid] : []);
}

/**
 * The mod holding a tool call until someone acts in its terminal pane, which Pied Piper cannot
 * show. `ui_panes` is missing from the SDK union; passive panes never request focus.
 */
export function claudeFocusRequestedPanePlugin(message: unknown): string | undefined {
  if (sdkMessageSubtype(message) !== "ui_panes") return undefined;
  const { focus_requested_id: paneId, panes } = message as {
    readonly focus_requested_id?: unknown;
    readonly panes?: unknown;
  };
  if (typeof paneId !== "string" || paneId.trim().length === 0) return undefined;
  const pane = Array.isArray(panes)
    ? (panes as ReadonlyArray<{ readonly id?: unknown; readonly plugin?: unknown } | null>).find(
        (entry) => entry?.id === paneId,
      )
    : undefined;
  return typeof pane?.plugin === "string" && pane.plugin.trim().length > 0 ? pane.plugin : paneId;
}

export function claudeModPaneUnsupportedMessage(plugin: string): string {
  return `The Claude Code mod "${plugin}" is waiting for input in its terminal pane, which Pied Piper cannot show. Disable the mod for sessions run from Pied Piper, or run the task in the Claude Code terminal.`;
}

export function sdkNativeMethod(message: SDKMessage): string {
  const subtype = sdkMessageSubtype(message);
  if (subtype) {
    return `claude/${message.type}/${subtype}`;
  }

  if (message.type === "stream_event") {
    const streamType = sdkMessageType(message.event);
    if (streamType) {
      const deltaType =
        streamType === "content_block_delta"
          ? sdkMessageType((message.event as { delta?: unknown }).delta)
          : undefined;
      if (deltaType) {
        return `claude/${message.type}/${streamType}/${deltaType}`;
      }
      return `claude/${message.type}/${streamType}`;
    }
  }

  return `claude/${message.type}`;
}

/**
 * Returns the JSON field whose string value should be streamed live for a
 * given Claude tool name, or `undefined` if the tool is not eligible for
 * streaming preview.
 *
 * Matches a small, fixed set of patterns that cover the canonical Claude
 * tool surface (Write, Edit/Replace/Patch, Bash/Shell). Anything else falls
 * through to `undefined` so we don't waste cycles parsing tool inputs that
 * the UI cannot meaningfully render character-by-character.
 */
export function toolInputStreamField(toolName: string): string | undefined {
  if (parseClaudeMcpToolName(toolName)) {
    return undefined;
  }
  return CLAUDE_TOOL_STREAM_FIELDS.get(normalizeClaudeToolName(toolName));
}

/**
 * Stateful per-instance JSON string extractor with a strict no-lossy-escape
 * invariant. One instance is owned by each in-flight tool; the adapter calls
 * `update(partialInputJson)` every time more partial JSON arrives from the
 * Claude SDK and forwards the returned delta over the runtime event stream.
 *
 * The extractor never silently substitutes characters: every escape either
 * decodes correctly, is emitted verbatim (only for malformed `\uXXXX`), or
 * extraction pauses until the next call has more buffer to consume.
 *
 * Limitation (v1 scope): file path extraction only works when a `"path"` key
 * appears in the JSON before the target field. This covers all known Claude
 * tool schemas (Write, StrReplace, Bash) where the path precedes the content
 * field. The scanner is intentionally simple — it is not a general-purpose
 * JSON parser.
 */
export class ToolInputStreamExtractor {
  readonly targetField: string;
  private valueStartOffset: number | null = null;
  private cursor = 0;
  private scanOffset = 0;
  private _filePath: string | undefined = undefined;
  private _oldString: string | undefined = undefined;
  private _done = false;

  constructor(targetField: string) {
    this.targetField = targetField;
  }

  get filePath(): string | undefined {
    return this._filePath;
  }

  /**
   * For Edit-style tools (`new_string` target), the value of `old_string`
   * captured from earlier in the JSON object — used by the UI to render the
   * removed lines as a real diff.
   */
  get oldString(): string | undefined {
    return this._oldString;
  }

  get done(): boolean {
    return this._done;
  }

  /**
   * Re-run the opportunistic file-path / old-string scan against the current
   * buffer. Called from the adapter on every input_json_delta so the meta
   * fields can be filled in even AFTER the target field has started
   * streaming. Both scans always start at offset 0 since these keys live at
   * the top of the tool input object.
   */
  refreshOpportunisticHints(partialJson: string): void {
    this.runOpportunisticScans(partialJson);
  }

  /**
   * Consume more of the accumulated `partialJson` buffer and return the new
   * extracted text since the last call. Returns `null` if no progress was
   * made or extraction is already complete.
   *
   * The caller MUST pass the FULL accumulated buffer (not the incremental
   * SDK delta), because the extractor needs to recover from chunk boundaries
   * that fall inside `\uXXXX` escapes or at trailing `\` characters.
   */
  update(partialJson: string): string | null {
    if (this._done) {
      return null;
    }

    if (this.valueStartOffset === null) {
      const found = this.scanForFieldStart(partialJson);
      if (found === null) {
        // Bound the next scan so we don't miss a key whose `"<key>":"` prefix
        // straddles two update() calls. The padding (key length + 10) covers
        // the surrounding quotes, colon, optional whitespace, and the value's
        // opening quote.
        this.scanOffset = Math.max(0, partialJson.length - this.targetField.length - 10);
        return null;
      }
      this.valueStartOffset = found;
      this.cursor = found;
    }

    if (this.cursor >= partialJson.length) {
      return null;
    }

    const len = partialJson.length;
    let delta = "";
    let i = this.cursor;
    while (i < len) {
      const ch = partialJson.charCodeAt(i);

      // Closing quote of the target string value — extraction is done.
      if (ch === 0x22 /* " */) {
        this._done = true;
        i += 1;
        break;
      }

      // Escape sequence — decode strictly or pause without consuming.
      if (ch === 0x5c /* \ */) {
        if (i + 1 >= len) {
          // Trailing backslash; wait for the next chunk.
          break;
        }
        const next = partialJson.charCodeAt(i + 1);
        if (next === 0x75 /* u */) {
          if (i + 5 >= len) {
            // Need 4 hex digits after `\u`; pause.
            break;
          }
          const hex = partialJson.slice(i + 2, i + 6);
          const code = parseInt(hex, 16);
          if (Number.isNaN(code)) {
            // Malformed \uXXXX — emit the 6 source characters verbatim.
            // This is the only deviation from spec; the alternative would
            // be to drop or substitute, which violates our invariant.
            delta += partialJson.slice(i, i + 6);
          } else {
            delta += String.fromCharCode(code);
          }
          i += 6;
          continue;
        }

        // Single-character escape.
        switch (next) {
          case 0x22 /* " */:
            delta += '"';
            break;
          case 0x5c /* \ */:
            delta += "\\";
            break;
          case 0x2f /* / */:
            delta += "/";
            break;
          case 0x6e /* n */:
            delta += "\n";
            break;
          case 0x72 /* r */:
            delta += "\r";
            break;
          case 0x74 /* t */:
            delta += "\t";
            break;
          case 0x62 /* b */:
            delta += "\b";
            break;
          case 0x66 /* f */:
            delta += "\f";
            break;
          default:
            // Unknown escape — preserve the source target character verbatim.
            delta += partialJson.charAt(i + 1);
            break;
        }
        i += 2;
        continue;
      }

      // Plain literal character.
      delta += partialJson.charAt(i);
      i += 1;
    }

    this.cursor = i;
    return delta.length > 0 ? delta : null;
  }

  /**
   * Linear scan for the opening `"` of the target field's string value.
   * Opportunistically extracts a `"path"` key encountered earlier in the
   * object. Returns the absolute offset of the first content character of
   * the target value, or `null` if the buffer doesn't yet contain enough
   * to commit.
   */
  private scanForFieldStart(partialJson: string): number | null {
    this.runOpportunisticScans(partialJson);
    const targetStart = this.findKeyValueOpening(partialJson, this.targetField, this.scanOffset);
    return targetStart;
  }

  /**
   * Try to capture file_path / old_string hints from anywhere in the buffer.
   * Always scans from offset 0 — these keys live at the top of the object so
   * the cost is bounded and we don't miss them when the advancing
   * `scanOffset` (used for the target field) skips past their position.
   */
  private runOpportunisticScans(partialJson: string): void {
    if (this._filePath === undefined) {
      for (const candidateKey of ["file_path", "path"]) {
        const candidateStart = this.findKeyValueOpening(partialJson, candidateKey, 0);
        if (candidateStart === null) continue;
        const decoded = this.decodeStringValue(partialJson, candidateStart);
        if (decoded !== null) {
          this._filePath = decoded.value;
          break;
        }
      }
    }
    if (this._oldString === undefined && this.targetField === "new_string") {
      const oldStart = this.findKeyValueOpening(partialJson, "old_string", 0);
      if (oldStart !== null) {
        const decoded = this.decodeStringValue(partialJson, oldStart);
        if (decoded !== null) {
          this._oldString = decoded.value;
        }
      }
    }
  }

  /**
   * Find a `"<key>"\s*:\s*"` pattern starting at `from` and return the offset
   * of the first content character of the value (right after the opening
   * quote). Returns `null` if not found or if the trailing `:` / opening
   * quote isn't present yet.
   */
  private findKeyValueOpening(buffer: string, key: string, from: number): number | null {
    const needle = `"${key}"`;
    let searchFrom = from;
    while (searchFrom <= buffer.length) {
      const keyIdx = buffer.indexOf(needle, searchFrom);
      if (keyIdx === -1) {
        return null;
      }
      let i = keyIdx + needle.length;
      // Skip whitespace before `:`.
      while (i < buffer.length && isJsonWhitespace(buffer.charCodeAt(i))) {
        i += 1;
      }
      if (i >= buffer.length) {
        return null;
      }
      if (buffer.charCodeAt(i) !== 0x3a /* : */) {
        // False match (e.g. `"path"` appeared inside another value). Keep
        // searching forward.
        searchFrom = keyIdx + needle.length;
        continue;
      }
      i += 1;
      // Skip whitespace before the value's opening quote.
      while (i < buffer.length && isJsonWhitespace(buffer.charCodeAt(i))) {
        i += 1;
      }
      if (i >= buffer.length) {
        return null;
      }
      if (buffer.charCodeAt(i) !== 0x22 /* " */) {
        // Value isn't a string (number, object, etc). Out of v1 scope —
        // keep searching for a later occurrence of the same key.
        searchFrom = keyIdx + needle.length;
        continue;
      }
      return i + 1;
    }
    return null;
  }

  /**
   * Decode a JSON string value starting at the given content offset using
   * the same escape rules as `update`. Returns `null` if the value is not
   * yet complete (closing quote missing, or trailing/incomplete escape).
   */
  private decodeStringValue(
    buffer: string,
    contentStart: number,
  ): { readonly value: string; readonly endOffset: number } | null {
    let value = "";
    let i = contentStart;
    const len = buffer.length;
    while (i < len) {
      const ch = buffer.charCodeAt(i);
      if (ch === 0x22 /* " */) {
        return { value, endOffset: i + 1 };
      }
      if (ch === 0x5c /* \ */) {
        if (i + 1 >= len) {
          return null;
        }
        const next = buffer.charCodeAt(i + 1);
        if (next === 0x75 /* u */) {
          if (i + 5 >= len) {
            return null;
          }
          const hex = buffer.slice(i + 2, i + 6);
          const code = parseInt(hex, 16);
          if (Number.isNaN(code)) {
            value += buffer.slice(i, i + 6);
          } else {
            value += String.fromCharCode(code);
          }
          i += 6;
          continue;
        }
        switch (next) {
          case 0x22:
            value += '"';
            break;
          case 0x5c:
            value += "\\";
            break;
          case 0x2f:
            value += "/";
            break;
          case 0x6e:
            value += "\n";
            break;
          case 0x72:
            value += "\r";
            break;
          case 0x74:
            value += "\t";
            break;
          case 0x62:
            value += "\b";
            break;
          case 0x66:
            value += "\f";
            break;
          default:
            value += buffer.charAt(i + 1);
            break;
        }
        i += 2;
        continue;
      }
      value += buffer.charAt(i);
      i += 1;
    }
    return null;
  }
}

function isJsonWhitespace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

export function sdkNativeItemId(message: SDKMessage): string | undefined {
  if (message.type === "assistant") {
    const maybeId = (message.message as { id?: unknown }).id;
    if (typeof maybeId === "string") {
      return maybeId;
    }
    return undefined;
  }

  if (message.type === "user") {
    return toolResultBlocksFromUserMessage(message)[0]?.toolUseId;
  }

  if (message.type === "stream_event") {
    const event = message.event as {
      type?: unknown;
      content_block?: { id?: unknown };
    };
    if (event.type === "content_block_start" && typeof event.content_block?.id === "string") {
      return event.content_block.id;
    }
  }

  return undefined;
}

type ClaudeMcpElicitationContent = NonNullable<ElicitationResult["content"]>;

function isClaudeMcpElicitationValue(value: unknown): value is ClaudeMcpElicitationContent[string] {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    (Array.isArray(value) && value.every((item) => typeof item === "string"))
  );
}

/** A plain one-time approval (`allow`, `approve_once`, `allow this time`), never a broader grant. */
const CLAUDE_MCP_ONE_TIME_APPROVAL =
  /^(?:once|accept|approve|allow)(?:[_\s-]*(?:once(?:[_\s-]*only)?|this[_\s-]*time))?$/i;

function isClaudeMcpOneTimeApproval(value: unknown): boolean {
  return typeof value === "string" && CLAUDE_MCP_ONE_TIME_APPROVAL.test(value.trim());
}

function claudeMcpAnswerableField(field: Record<string, unknown>): Record<string, unknown> {
  const answerable: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(field)) {
    if (name === "default") continue;
    // Only a plain one-time choice may be picked, so `allow_all` before `allow_once` is skipped.
    if (name === "enum" && Array.isArray(value)) {
      answerable.enum = value.filter(isClaudeMcpOneTimeApproval);
    } else if (name === "oneOf" && Array.isArray(value)) {
      answerable.oneOf = value.filter(
        (option) =>
          typeof option === "object" &&
          option !== null &&
          isClaudeMcpOneTimeApproval((option as { const?: unknown }).const),
      );
    } else {
      answerable[name] = value;
    }
  }
  return answerable;
}

function withoutSchemaDefaults(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = schema.properties;
  if (typeof properties !== "object" || properties === null || Array.isArray(properties)) {
    return schema;
  }
  return {
    ...schema,
    properties: Object.fromEntries(
      Object.entries(properties).map(([key, field]) => [
        key,
        typeof field === "object" && field !== null && !Array.isArray(field)
          ? claudeMcpAnswerableField(field as Record<string, unknown>)
          : field,
      ]),
    ),
  };
}

/**
 * The answer an approved MCP elicitation sends, or undefined when the approval card cannot
 * answer it (URL mode, no schema, or required fields only free text could fill). Schema
 * defaults and choices broader than a one-time approval are dropped so they never grant
 * something the user did not see.
 */
export function claudeMcpElicitationAcceptance(
  request: ElicitationRequest,
): ElicitationResult | undefined {
  if (request.mode === "url" || request.requestedSchema === undefined) return undefined;
  const response = toMcpElicitationResponse(
    { mode: "form", requestedSchema: withoutSchemaDefaults(request.requestedSchema) },
    "accept",
  );
  // The helper leaves content out when the schema is not a form it can read.
  const filled = response.content;
  if (response.action !== "accept") return undefined;
  if (typeof filled !== "object" || filled === null || Array.isArray(filled)) return undefined;
  const content: ClaudeMcpElicitationContent = {};
  for (const [key, value] of Object.entries(filled)) {
    if (!isClaudeMcpElicitationValue(value)) return undefined;
    content[key] = value;
  }
  return { action: "accept", content };
}

/** Approval-card detail for an MCP elicitation: the server's label and its message. */
export function claudeMcpElicitationDetail(request: ElicitationRequest): string {
  const source = (request.displayName ?? request.title ?? request.serverName).trim();
  const message = request.message.trim();
  if (!message) return source || "MCP server request";
  return source ? `${source}: ${message}` : message;
}

/** Extra approval-card fields from Claude's permission callback; both stay absent for a plain ask. */
export function claudeApprovalPresentation(input: {
  readonly detail: string | undefined;
  readonly callbackOptions: Pick<
    Parameters<CanUseTool>[2],
    "decisionReason" | "suppressAlwaysAllowRule"
  >;
}): { readonly reason?: string; readonly noStandingGrant?: true } {
  // The reason can carry terminal escapes from the CLI's own prompt renderer.
  const reason = stripVTControlCharacters(input.callbackOptions.decisionReason ?? "").trim();
  return {
    ...(reason === "" || reason === input.detail?.trim() ? {} : { reason }),
    ...(input.callbackOptions.suppressAlwaysAllowRule === true ? { noStandingGrant: true } : {}),
  };
}

/** Downgrades a session grant to a one-time approval when Claude forbids a standing rule. */
export function effectiveClaudeApprovalDecision(
  decision: ProviderApprovalDecision,
  noStandingGrant: boolean | undefined,
): ProviderApprovalDecision {
  return noStandingGrant === true && decision === "acceptForSession" ? "accept" : decision;
}

/** Marks a `runtime.warning` as one state of a retry row; the web keeps only the latest per retryId. */
export const CLAUDE_PROVIDER_RETRY_DETAIL_KIND = "provider_retry";

export type ClaudeApiRetryOutcome = "recovered" | "failed" | "stopped";

export interface ClaudeApiRetryStatus {
  readonly attempt: number;
  readonly maxRetries: number;
  readonly errorStatus: number | null;
  readonly error: string | undefined;
  readonly noResponseWaitedMs?: number | undefined;
  /** A usage-limit notice already explains the wait, so the row only counts retries. */
  readonly explainedByUsageLimit: boolean;
}

function claudeApiRetryCause(status: ClaudeApiRetryStatus): string {
  if (status.noResponseWaitedMs !== undefined) {
    return `sent no response after ${Math.max(1, Math.round(status.noResponseWaitedMs / 1000))}s`;
  }
  const reason =
    status.errorStatus === 529 || status.error === "overloaded"
      ? "overloaded"
      : status.error === "rate_limit" || status.errorStatus === 429
        ? "rate limited"
        : status.error === "server_error"
          ? "server error"
          : "error";
  return status.errorStatus === null ? reason : `${reason} (${status.errorStatus})`;
}

/** The label of a retry row while the CLI is still backing off. */
export function claudeApiRetryingMessage(status: ClaudeApiRetryStatus): string {
  const count = `retry ${status.attempt} of ${status.maxRetries}`;
  return status.explainedByUsageLimit
    ? `Claude API ${count}`
    : `Claude API ${claudeApiRetryCause(status)}, ${count}`;
}

/** The label a retry row settles on once the request recovered or the turn ended. */
export function claudeApiRetrySettledMessage(
  status: ClaudeApiRetryStatus,
  outcome: ClaudeApiRetryOutcome,
): string {
  if (outcome === "recovered") {
    return `Claude API recovered after ${status.attempt} ${status.attempt === 1 ? "retry" : "retries"}`;
  }
  const cause = status.explainedByUsageLimit ? "" : ` ${claudeApiRetryCause(status)},`;
  return outcome === "failed"
    ? `Claude API${cause} gave up at retry ${status.attempt} of ${status.maxRetries}`
    : `Claude API${cause} stopped at retry ${status.attempt} of ${status.maxRetries}`;
}

/** What to try, in order, when Claude may refuse a mode: permissive modes step down, never up. */
export function claudePermissionModeFallbacks(mode: PermissionMode): ReadonlyArray<PermissionMode> {
  if (mode === "bypassPermissions") return ["bypassPermissions", "auto", "default"];
  if (mode === "auto") return ["auto", "default"];
  return [mode];
}

/** Claude refuses Auto per model and account, and both Auto and bypass by policy. */
export function isClaudePermissionModeRefusal(cause: unknown, mode: PermissionMode): boolean {
  if (mode !== "auto" && mode !== "bypassPermissions") return false;
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.includes(`Cannot set permission mode to ${mode}`);
}

/** Claude's availability check had no answer yet; this is not a verdict on the mode. */
export function isClaudePermissionModeUnanswered(cause: unknown, mode: PermissionMode): boolean {
  if (!isClaudePermissionModeRefusal(cause, mode)) return false;
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.includes("ask again") || message.includes("not known yet");
}

const CLAUDE_PERMISSION_UNANSWERED_RETRIES = 2;
const CLAUDE_PERMISSION_UNANSWERED_RETRY_DELAY_MS = 200;

/** Asks Claude for a mode, asking again when it has no answer yet; other errors propagate. */
export async function requestClaudePermissionMode(
  setPermissionMode: (mode: PermissionMode) => Promise<void>,
  mode: PermissionMode,
): Promise<"accepted" | "refused" | "unanswered"> {
  for (let retries = 0; ; retries += 1) {
    try {
      await setPermissionMode(mode);
      return "accepted";
    } catch (cause) {
      if (!isClaudePermissionModeRefusal(cause, mode)) throw cause;
      if (!isClaudePermissionModeUnanswered(cause, mode)) return "refused";
      if (retries >= CLAUDE_PERMISSION_UNANSWERED_RETRIES) return "unanswered";
    }
    await new Promise((resolve) =>
      setTimeout(resolve, CLAUDE_PERMISSION_UNANSWERED_RETRY_DELAY_MS),
    );
  }
}

/** The notice for running below the requested mode, or undefined when nothing was lost. */
export function claudePermissionDowngradeNotice(
  requested: PermissionMode | undefined,
  live: PermissionMode,
  autoUnconfirmed = false,
): string | undefined {
  if (requested === "bypassPermissions" && live === "auto") {
    return "Full access is unavailable for this session, so Claude is using Auto.";
  }
  if (requested === "bypassPermissions" && live === "default") {
    return "Full access is unavailable for this session, so Claude will ask for approvals.";
  }
  if (requested === "auto" && live === "default") {
    return autoUnconfirmed
      ? "Auto could not be confirmed for this turn, so Claude will ask for approvals."
      : "Auto is unavailable for this session, so Claude will ask for approvals.";
  }
  return undefined;
}
