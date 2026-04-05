/**
 * Pure helpers used by ClaudeAdapterLive.
 *
 * Extracted from ClaudeAdapter.ts to keep the adapter layer file focused
 * on session lifecycle wiring. None of these functions touch the adapter
 * runtime state directly — they classify Claude SDK messages, normalize
 * token usage, build prompt content, and coerce SDK shapes to canonical
 * runtime types.
 */
import {
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
  type SettingSource,
} from "@anthropic-ai/claude-agent-sdk";
import {
  ApprovalRequestId,
  type CanonicalItemType,
  type CanonicalRequestType,
  ProviderItemId,
  type ProviderRuntimeEvent,
  type ProviderRuntimeTurnStatus,
  type ProviderSendTurnInput,
  type ThreadTokenUsageSnapshot,
  type RuntimeContentStreamKind,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
  ClaudeCodeEffort,
} from "@piedpiper/contracts";
import { applyClaudePromptEffortPrefix, trimOrNull } from "@piedpiper/shared/model";
import { Cause, Effect, FileSystem } from "effect";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { getClaudeModelCapabilities } from "./ClaudeProvider.ts";

export const PROVIDER = "claudeAgent" as const;
export type ClaudeTextStreamKind = Extract<
  RuntimeContentStreamKind,
  "assistant_text" | "reasoning_text"
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
  const derivedUsedTokens = inputTokens + outputTokens;
  const usedTokens = directUsedTokens ?? (derivedUsedTokens > 0 ? derivedUsedTokens : undefined);
  if (usedTokens === undefined || usedTokens <= 0) {
    return undefined;
  }

  return {
    usedTokens,
    lastUsedTokens: usedTokens,
    ...(inputTokens > 0 ? { inputTokens } : {}),
    ...(outputTokens > 0 ? { outputTokens } : {}),
    ...(typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0
      ? { maxTokens: contextWindow }
      : {}),
    ...(typeof record.tool_uses === "number" && Number.isFinite(record.tool_uses)
      ? { toolUses: record.tool_uses }
      : {}),
    ...(typeof record.duration_ms === "number" && Number.isFinite(record.duration_ms)
      ? { durationMs: record.duration_ms }
      : {}),
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

  return {
    ...(threadId ? { threadId } : {}),
    ...(resume ? { resume } : {}),
    ...(resumeSessionAt ? { resumeSessionAt } : {}),
    ...(turnCountValue !== undefined && Number.isInteger(turnCountValue) && turnCountValue >= 0
      ? { turnCount: turnCountValue }
      : {}),
  };
}

export function classifyToolItemType(toolName: string): CanonicalItemType {
  const normalized = toolName.toLowerCase();
  if (normalized.includes("agent")) {
    return "collab_agent_tool_call";
  }
  if (
    normalized === "task" ||
    normalized === "agent" ||
    normalized.includes("subagent") ||
    normalized.includes("sub-agent")
  ) {
    return "collab_agent_tool_call";
  }
  if (
    normalized.includes("bash") ||
    normalized.includes("command") ||
    normalized.includes("shell") ||
    normalized.includes("terminal")
  ) {
    return "command_execution";
  }
  if (
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("file") ||
    normalized.includes("patch") ||
    normalized.includes("replace") ||
    normalized.includes("create") ||
    normalized.includes("delete")
  ) {
    return "file_change";
  }
  if (normalized.includes("mcp")) {
    return "mcp_tool_call";
  }
  if (normalized.includes("websearch") || normalized.includes("web search")) {
    return "web_search";
  }
  if (normalized.includes("image")) {
    return "image_view";
  }
  return "dynamic_tool_call";
}

export function isReadOnlyToolName(toolName: string): boolean {
  const normalized = toolName.toLowerCase();
  return (
    normalized === "read" ||
    normalized.includes("read file") ||
    normalized.includes("view") ||
    normalized.includes("grep") ||
    normalized.includes("glob") ||
    normalized.includes("search")
  );
}

export function classifyRequestType(toolName: string): CanonicalRequestType {
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
    return `${toolName}: ${command.trim().slice(0, 400)}`;
  }

  const serialized = JSON.stringify(input);
  if (serialized.length <= 400) {
    return `${toolName}: ${serialized}`;
  }
  return `${toolName}: ${serialized.slice(0, 397)}...`;
}

export function titleForTool(itemType: CanonicalItemType): string {
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

export const SUPPORTED_CLAUDE_IMAGE_MIME_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
export const CLAUDE_SETTING_SOURCES = [
  "user",
  "project",
  "local",
] as const satisfies ReadonlyArray<SettingSource>;

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
  return applyClaudePromptEffortPrefix(input.input?.trim() ?? "", promptEffort);
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

export const buildUserMessageEffect = Effect.fn("buildUserMessageEffect")(function* (
  input: ProviderSendTurnInput,
  dependencies: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly attachmentsDir: string;
  },
) {
  const text = buildPromptText(input);
  const sdkContent: Array<Record<string, unknown>> = [];

  if (text.length > 0) {
    sdkContent.push({ type: "text", text });
  }

  for (const attachment of input.attachments ?? []) {
    if (attachment.type !== "image") {
      continue;
    }

    if (!SUPPORTED_CLAUDE_IMAGE_MIME_TYPES.has(attachment.mimeType)) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "turn/start",
        detail: `Unsupported Claude image attachment type '${attachment.mimeType}'.`,
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

    sdkContent.push(
      buildClaudeImageContentBlock({
        mimeType: attachment.mimeType,
        bytes,
      }),
    );
  }

  return buildUserMessage({ sdkContent });
});

export function turnStatusFromResult(result: SDKResultMessage): ProviderRuntimeTurnStatus {
  if (result.subtype === "success") {
    return "completed";
  }

  const errors = resultErrorsText(result);
  if (isInterruptedResult(result)) {
    return "interrupted";
  }
  if (errors.includes("cancel")) {
    return "cancelled";
  }
  return "failed";
}

export function streamKindFromDeltaType(deltaType: string): ClaudeTextStreamKind {
  return deltaType.includes("thinking") ? "reasoning_text" : "assistant_text";
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

export function extractAssistantTextBlocks(message: SDKMessage): Array<string> {
  if (message.type !== "assistant") {
    return [];
  }

  const content = (message.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) {
    return [];
  }

  const fragments: string[] = [];
  for (const block of content) {
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
  if (/write|create/i.test(toolName)) {
    return "content";
  }
  if (/edit|replace|str_replace|patch/i.test(toolName)) {
    return "new_string";
  }
  if (/bash|shell|command|terminal/i.test(toolName)) {
    return "command";
  }
  return undefined;
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
