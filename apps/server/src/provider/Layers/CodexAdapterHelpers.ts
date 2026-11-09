/**
 * Pure helpers used by CodexAdapterLive.
 *
 * Extracted from CodexAdapter.ts to keep the adapter layer file focused
 * on session lifecycle wiring. None of these functions touch the adapter
 * runtime state directly — they classify Codex item types, normalize
 * token usage, build runtime event payloads, and coerce Codex protocol
 * shapes to canonical runtime types.
 */
import {
  type CanonicalItemType,
  type CanonicalRequestType,
  type CodexModelOptions,
  EventId,
  type ModelCapabilities,
  ProviderApprovalDecision,
  type ProviderEvent,
  type ProviderRuntimeEvent,
  type ThreadTokenUsageSnapshot,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  ProviderItemId,
  ThreadId,
  TurnId,
} from "@piedpiper/contracts";
import { Schema } from "effect";

import { codexGoalToProviderGoal } from "../../codex/codexGoalCommand.ts";
import { CODEX_STANDARD_SERVICE_TIER, normalizeCodexServiceTierId } from "../codexModelList.ts";
import {
  CODEX_MCP_ELICITATION_METHOD,
  CODEX_PERMISSIONS_APPROVAL_METHOD,
  readRequestedPermissionPaths,
} from "../../codex/protocolHelpers.ts";

import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  type ProviderAdapterError,
} from "../Errors.ts";

export const PROVIDER = "codex" as const;

/**
 * The Fast toggle as a Codex service tier: on is "fast", an explicit off is null so it
 * overrides a config-level `service_tier = "fast"`, and unset defers to the user's config.
 * Checked on Codex CLI 0.166: with config `service_tier = "fast"`, thread/start with
 * `serviceTier: null` reports "default" while an omitted field reports "priority". null is
 * used rather than "default" because older CLIs typed the tier as an enum without "default".
 */
export function codexServiceTierForFastMode(
  fastMode: boolean | undefined,
): "fast" | null | undefined {
  if (fastMode === true) return "fast";
  if (fastMode === false) return null;
  return undefined;
}

/**
 * The Fast toggle as `codex exec` config arguments. TOML has no null, so an explicit off
 * becomes `service_tier="default"` (checked on CLI 0.166), sent only when the Codex config
 * turns fast on, since older CLIs may reject a tier they do not know.
 */
export function codexExecServiceTierArgs(
  fastMode: boolean | undefined,
  configuredFastDefault: boolean | undefined,
): ReadonlyArray<string> {
  if (fastMode === true) return ["--config", `service_tier="fast"`];
  if (fastMode === false && configuredFastDefault === true) {
    return ["--config", `service_tier="default"`];
  }
  return [];
}

/**
 * The selected tier as a Codex service tier: an explicit `serviceTier` wins, otherwise the older
 * `fastMode` boolean applies. null is Standard; undefined defers to the user's config.
 */
export function resolveCodexServiceTier(
  options: Pick<CodexModelOptions, "serviceTier" | "fastMode"> | undefined,
): string | null | undefined {
  const serviceTier = options?.serviceTier;
  if (serviceTier === undefined) return codexServiceTierForFastMode(options?.fastMode);
  if (serviceTier === null || serviceTier === CODEX_STANDARD_SERVICE_TIER) return null;
  return normalizeCodexServiceTierId(serviceTier);
}

const CODEX_SERVICE_TIER_ID_PATTERN = /^[\w.-]+$/;

/**
 * `codex exec` arguments for the selected tier. Standard needs `service_tier="default"` only when
 * something else is the default, since older CLIs may reject a tier they do not know.
 */
export function codexExecServiceTierArgsForOptions(
  options: Pick<CodexModelOptions, "serviceTier" | "fastMode"> | undefined,
  capabilities:
    | Pick<ModelCapabilities, "fastModeDefault" | "serviceTierOptions">
    | undefined
    | null,
): ReadonlyArray<string> {
  const serviceTier = resolveCodexServiceTier(options);
  if (serviceTier === undefined) return [];
  if (serviceTier === null) {
    const tierDefault = capabilities?.serviceTierOptions?.find((option) => option.isDefault);
    const nonStandardDefault =
      capabilities?.fastModeDefault === true ||
      (tierDefault !== undefined && tierDefault.value !== CODEX_STANDARD_SERVICE_TIER);
    return nonStandardDefault ? ["--config", `service_tier="${CODEX_STANDARD_SERVICE_TIER}"`] : [];
  }
  // Settings keep a saved tier after the catalog stops listing it, and older CLIs may reject it.
  const listedTiers = capabilities?.serviceTierOptions ?? [];
  const isOffered =
    listedTiers.length === 0 || listedTiers.some((option) => option.value === serviceTier);
  // The id goes into a TOML string, and a stored selection is not guaranteed to be a catalog id.
  return isOffered && CODEX_SERVICE_TIER_ID_PATTERN.test(serviceTier)
    ? ["--config", `service_tier="${serviceTier}"`]
    : [];
}

export function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  return fallback;
}

export function toSessionError(
  threadId: ThreadId,
  cause: unknown,
): ProviderAdapterSessionNotFoundError | ProviderAdapterSessionClosedError | undefined {
  const normalized = toMessage(cause, "").toLowerCase();
  if (normalized.includes("unknown session") || normalized.includes("unknown provider session")) {
    return new ProviderAdapterSessionNotFoundError({
      provider: PROVIDER,
      threadId,
      cause,
    });
  }
  if (normalized.includes("session is closed")) {
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

export function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return value as Record<string, unknown>;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export const FATAL_CODEX_STDERR_SNIPPETS = ["failed to connect to websocket"];

export function isFatalCodexProcessStderrMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return FATAL_CODEX_STDERR_SNIPPETS.some((snippet) => normalized.includes(snippet));
}

export function normalizeCodexTokenUsage(value: unknown): ThreadTokenUsageSnapshot | undefined {
  const usage = asObject(value);
  const totalUsage = asObject(usage?.total_token_usage ?? usage?.total);
  const lastUsage = asObject(usage?.last_token_usage ?? usage?.last);

  const totalProcessedTokens =
    asNumber(totalUsage?.total_tokens) ?? asNumber(totalUsage?.totalTokens);
  const usedTokens =
    asNumber(lastUsage?.total_tokens) ?? asNumber(lastUsage?.totalTokens) ?? totalProcessedTokens;
  if (usedTokens === undefined || usedTokens <= 0) {
    return undefined;
  }

  const maxTokens = asNumber(usage?.model_context_window) ?? asNumber(usage?.modelContextWindow);
  const inputTokens = asNumber(lastUsage?.input_tokens) ?? asNumber(lastUsage?.inputTokens);
  const cachedInputTokens =
    asNumber(lastUsage?.cached_input_tokens) ?? asNumber(lastUsage?.cachedInputTokens);
  const outputTokens = asNumber(lastUsage?.output_tokens) ?? asNumber(lastUsage?.outputTokens);
  const reasoningOutputTokens =
    asNumber(lastUsage?.reasoning_output_tokens) ?? asNumber(lastUsage?.reasoningOutputTokens);

  return {
    usedTokens,
    ...(totalProcessedTokens !== undefined && totalProcessedTokens > usedTokens
      ? { totalProcessedTokens }
      : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
    ...(usedTokens !== undefined ? { lastUsedTokens: usedTokens } : {}),
    ...(inputTokens !== undefined ? { lastInputTokens: inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { lastCachedInputTokens: cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { lastOutputTokens: outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined
      ? { lastReasoningOutputTokens: reasoningOutputTokens }
      : {}),
    compactsAutomatically: true,
  };
}

export function toTurnId(value: string | undefined): TurnId | undefined {
  return value?.trim() ? TurnId.makeUnsafe(value) : undefined;
}

export function toProviderItemId(value: string | undefined): ProviderItemId | undefined {
  return value?.trim() ? ProviderItemId.makeUnsafe(value) : undefined;
}

export function toTurnStatus(value: unknown): "completed" | "failed" | "cancelled" | "interrupted" {
  switch (value) {
    case "completed":
    case "failed":
    case "cancelled":
    case "interrupted":
      return value;
    default:
      return "completed";
  }
}

export function normalizeItemType(raw: unknown): string {
  const type = asString(raw);
  if (!type) return "item";
  return type
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function toCanonicalItemType(raw: unknown): CanonicalItemType {
  const type = normalizeItemType(raw);
  if (type.includes("user")) return "user_message";
  if (type.includes("agent message") || type.includes("assistant")) return "assistant_message";
  if (type.includes("reasoning") || type.includes("thought")) return "reasoning";
  if (type.includes("plan") || type.includes("todo")) return "plan";
  if (type.includes("command")) return "command_execution";
  if (type.includes("file change") || type.includes("patch") || type.includes("edit"))
    return "file_change";
  if (type.includes("mcp")) return "mcp_tool_call";
  if (type.includes("dynamic tool")) return "dynamic_tool_call";
  if (type.includes("collab")) return "collab_agent_tool_call";
  if (type.includes("web search")) return "web_search";
  if (type.includes("image")) return "image_view";
  if (type.includes("review entered")) return "review_entered";
  if (type.includes("review exited")) return "review_exited";
  if (type.includes("compact")) return "context_compaction";
  if (type.includes("error")) return "error";
  return "unknown";
}

export function itemTitle(itemType: CanonicalItemType): string | undefined {
  switch (itemType) {
    case "assistant_message":
      return "Assistant message";
    case "user_message":
      return "User message";
    case "reasoning":
      return "Reasoning";
    case "plan":
      return "Plan";
    case "command_execution":
      return "Ran command";
    case "file_change":
      return "File change";
    case "mcp_tool_call":
      return "MCP tool call";
    case "dynamic_tool_call":
      return "Tool call";
    case "web_search":
      return "Web search";
    case "image_view":
      return "Image view";
    case "error":
      return "Error";
    default:
      return undefined;
  }
}

/** `summary` parts as one text: plain strings on current CLIs, `{ text }` objects on older ones. */
function reasoningSummaryText(summary: unknown): string | undefined {
  if (!Array.isArray(summary)) return undefined;
  const parts = summary.flatMap((part) => {
    const text = asString(part) ?? asString(asObject(part)?.text);
    return text && text.trim().length > 0 ? [text] : [];
  });
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

export function itemDetail(
  item: Record<string, unknown>,
  payload: Record<string, unknown>,
  itemType?: CanonicalItemType,
): string | undefined {
  const nestedResult = asObject(item.result);
  const action = asObject(item.action);
  const actionQueries = Array.isArray(action?.queries) ? action.queries : [];
  const candidates = [
    ...(itemType === "web_search"
      ? [item.query, action?.query, ...actionQueries, action?.pattern, action?.url].map(asString)
      : []),
    asString(item.command),
    asString(item.title),
    asString(item.revisedPrompt),
    asString(item.summary) ??
      (itemType === "reasoning" ? reasoningSummaryText(item.summary) : undefined),
    asString(item.text),
    asString(item.path),
    asString(item.prompt),
    asString(nestedResult?.command),
    asString(payload.command),
    asString(payload.message),
    asString(payload.prompt),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const trimmed = candidate.trim();
    if (trimmed.length === 0) continue;
    return trimmed;
  }
  return undefined;
}

export function toRequestTypeFromMethod(method: string): CanonicalRequestType {
  switch (method) {
    case "item/commandExecution/requestApproval":
      return "command_execution_approval";
    case "item/fileRead/requestApproval":
      return "file_read_approval";
    case "item/fileChange/requestApproval":
      return "file_change_approval";
    case "applyPatchApproval":
      return "apply_patch_approval";
    case "execCommandApproval":
      return "exec_command_approval";
    case "item/tool/requestUserInput":
      return "tool_user_input";
    case "item/tool/call":
      return "dynamic_tool_call";
    case "account/chatgptAuthTokens/refresh":
      return "auth_tokens_refresh";
    default:
      return "unknown";
  }
}

function nonEmptyString(value: unknown): string | undefined {
  const text = asString(value)?.trim();
  return text ? text : undefined;
}

// Legacy execCommandApproval sends the command as an argv array.
function commandDetail(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return nonEmptyString(value.filter((part) => typeof part === "string").join(" "));
  }
  return nonEmptyString(value);
}

const MAX_DESCRIBED_FILE_CHANGES = 20;

// Apply-patch approvals carry the edited paths only as the keys of `fileChanges`.
export function describeFileChanges(fileChanges: unknown): string | undefined {
  const changes = asObject(fileChanges);
  if (!changes) return undefined;
  const entries = Object.entries(changes).toSorted(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) return undefined;
  const described = entries.slice(0, MAX_DESCRIBED_FILE_CHANGES).map(([path, change]) => {
    const record = asObject(change);
    const type = nonEmptyString(record?.type) ?? "change";
    const movePath = type === "update" ? nonEmptyString(record?.move_path) : undefined;
    return movePath ? `${type} ${path} -> ${movePath}` : `${type} ${path}`;
  });
  const remaining = entries.length - described.length;
  return remaining > 0 ? `${described.join("\n")}\n+${remaining} more` : described.join("\n");
}

/** Path -> change kind (`{ type, move_path? }`) recorded from a fileChange item, without diff bodies. */
export type CodexFileChangeKinds = Readonly<Record<string, unknown>>;

const FILE_CHANGE_TRACKER_RESET_METHODS = new Set([
  "turn/completed",
  "session/connecting",
  "session/closed",
  "session/exited",
]);

/**
 * Remembers the paths each in-flight fileChange item touches, because current
 * Codex sends `item/fileChange/requestApproval` without any file paths.
 */
export function makeCodexFileChangeTracker() {
  const byThread = new Map<string, Map<string, CodexFileChangeKinds>>();

  /** Records the event and returns the file changes known for it when it is a file-change approval. */
  const observe = (event: ProviderEvent): CodexFileChangeKinds | undefined => {
    const threadKey = String(event.threadId);
    if (FILE_CHANGE_TRACKER_RESET_METHODS.has(event.method)) {
      byThread.delete(threadKey);
      return undefined;
    }
    const item = asObject(asObject(event.payload)?.item);
    const itemId = asString(item?.id);
    if (event.method === "item/started" && itemId && item?.type === "fileChange") {
      const kinds: Record<string, unknown> = {};
      for (const change of asArray(item.changes) ?? []) {
        const record = asObject(change);
        const path = nonEmptyString(record?.path);
        if (!path) continue;
        kinds[path] = typeof record?.kind === "string" ? { type: record.kind } : record?.kind;
      }
      let items = byThread.get(threadKey);
      if (!items) {
        items = new Map();
        byThread.set(threadKey, items);
      }
      items.set(itemId, kinds);
      return undefined;
    }
    if (event.method === "item/completed" && itemId) {
      byThread.get(threadKey)?.delete(itemId);
      return undefined;
    }
    if (event.kind === "request" && event.method === "item/fileChange/requestApproval") {
      const requestItemId = event.itemId ?? asString(asObject(event.payload)?.itemId);
      return requestItemId ? byThread.get(threadKey)?.get(requestItemId) : undefined;
    }
    return undefined;
  };

  return { observe };
}

const isCompactedStateEvent = (event: ProviderRuntimeEvent): boolean =>
  event.type === "thread.state.changed" && event.payload.state === "compacted";

/**
 * A CLI can report one compaction both as the contextCompaction item and as the deprecated
 * thread/compacted notification, in either order. Pairs them per turn so each yields one row.
 */
export function makeCodexCompactionDeduper() {
  const byThread = new Map<
    string,
    { turnId: string | undefined; item: number; notification: number }
  >();

  const apply = (
    event: ProviderEvent,
    runtimeEvents: ReadonlyArray<ProviderRuntimeEvent>,
  ): ReadonlyArray<ProviderRuntimeEvent> => {
    if (!runtimeEvents.some(isCompactedStateEvent)) return runtimeEvents;
    const threadKey = String(event.threadId);
    const turnId = event.turnId ? String(event.turnId) : undefined;
    let counts = byThread.get(threadKey);
    if (!counts || counts.turnId !== turnId) {
      counts = { turnId, item: 0, notification: 0 };
      byThread.set(threadKey, counts);
    }
    const isNotification = event.method === "thread/compacted";
    const seen = isNotification ? ++counts.notification : ++counts.item;
    const seenFromOtherSource = isNotification ? counts.item : counts.notification;
    return seen > seenFromOtherSource
      ? runtimeEvents
      : runtimeEvents.filter((runtimeEvent) => !isCompactedStateEvent(runtimeEvent));
  };

  return { apply };
}

/** Matches `dropSupersededProviderRetryActivities` in the web app, which keeps the latest per id. */
const CODEX_PROVIDER_RETRY_DETAIL_KIND = "provider_retry";

// Runtime events showing Codex moved on, so the row settles and the next warning starts a new one.
const CODEX_RETRY_SETTLING_EVENT_TYPES: ReadonlySet<ProviderRuntimeEvent["type"]> = new Set([
  "turn.started",
  "turn.completed",
  "turn.aborted",
  "item.started",
  "item.completed",
  "content.delta",
  "task.started",
  "task.progress",
  "runtime.error",
  "session.exited",
]);

type CodexRetryOutcome = "recovered" | "failed" | "stopped";

function codexRetryOutcome(event: ProviderRuntimeEvent): CodexRetryOutcome {
  switch (event.type) {
    case "turn.completed":
      return event.payload.state === "failed"
        ? "failed"
        : event.payload.state === "completed"
          ? "recovered"
          : "stopped";
    case "turn.aborted":
      return "stopped";
    case "runtime.error":
    case "session.exited":
      return "failed";
    default:
      return "recovered";
  }
}

function codexRetrySettledMessage(
  outcome: CodexRetryOutcome,
  attempts: number,
  detail: Record<string, unknown>,
): string {
  const retries = `${attempts} ${attempts === 1 ? "retry" : "retries"}`;
  if (outcome === "recovered") return `Recovered after ${retries}`;
  if (outcome === "stopped") return "Stopped while retrying";
  return asObject(detail.error)?.codexErrorInfo === "serverOverloaded"
    ? `Still at capacity after ${retries}`
    : `Gave up after ${retries}`;
}

/**
 * Codex sends one `error` with `willRetry` per attempt. Gives the attempts of one streak a shared
 * `retryId`, so they read as a single updating row, and settles that row when the streak ends.
 */
export function makeCodexRetryStreakTracker() {
  const streakByThread = new Map<
    string,
    {
      readonly retryId: string;
      readonly attempts: number;
      readonly detail: Record<string, unknown>;
      readonly turnId: ProviderEvent["turnId"];
    }
  >();

  const apply = (
    event: ProviderEvent,
    runtimeEvents: ReadonlyArray<ProviderRuntimeEvent>,
  ): ReadonlyArray<ProviderRuntimeEvent> => {
    const threadKey = String(event.threadId);
    const payload = asObject(event.payload);
    const streak = streakByThread.get(threadKey);
    // Codex logs connection errors between attempts, which says nothing about how the streak ends.
    if (event.method === "process/stderr") return runtimeEvents;
    if (event.method !== "error" || payload?.willRetry !== true) {
      const settling = runtimeEvents.find((item) =>
        CODEX_RETRY_SETTLING_EVENT_TYPES.has(item.type),
      );
      if (!settling || !streak) return runtimeEvents;
      streakByThread.delete(threadKey);
      const outcome = codexRetryOutcome(settling);
      const settled: ProviderRuntimeEvent = {
        ...runtimeEventBase(
          { ...event, ...(event.turnId ? {} : { turnId: streak.turnId }) },
          event.threadId,
        ),
        eventId: EventId.makeUnsafe(`${event.id}:retry-settled`),
        type: "runtime.warning",
        payload: {
          message: codexRetrySettledMessage(outcome, streak.attempts, streak.detail),
          detail: {
            ...streak.detail,
            kind: CODEX_PROVIDER_RETRY_DETAIL_KIND,
            retryId: streak.retryId,
            state: outcome,
            willRetry: false,
            attempts: streak.attempts,
          },
        },
      };
      return [settled, ...runtimeEvents];
    }
    const retryId = streak?.retryId ?? `codex-retry:${event.id}`;
    streakByThread.set(threadKey, {
      retryId,
      attempts: (streak?.attempts ?? 0) + 1,
      detail: payload,
      turnId: event.turnId ?? streak?.turnId,
    });
    return runtimeEvents.map((runtimeEvent) =>
      runtimeEvent.type === "runtime.warning"
        ? {
            ...runtimeEvent,
            payload: {
              ...runtimeEvent.payload,
              detail: {
                ...payload,
                kind: CODEX_PROVIDER_RETRY_DETAIL_KIND,
                retryId,
                state: "retrying",
              },
            },
          }
        : runtimeEvent,
    );
  };

  return { apply };
}

export function toRequestOpenedDetail(
  method: string,
  payload: Record<string, unknown> | undefined,
  fileChanges?: CodexFileChangeKinds,
): string | undefined {
  if (method === CODEX_PERMISSIONS_APPROVAL_METHOD) {
    const paths = readRequestedPermissionPaths(payload);
    const requested = [...paths.read, ...paths.write];
    return (
      nonEmptyString(payload?.reason) ??
      (requested.length > 0 ? `Access: ${requested.join(", ")}` : undefined)
    );
  }
  if (method === CODEX_MCP_ELICITATION_METHOD) {
    return nonEmptyString(payload?.message) ?? nonEmptyString(payload?.serverName);
  }
  if (method === "item/fileChange/requestApproval") {
    return (
      nonEmptyString(payload?.reason) ??
      describeFileChanges(fileChanges) ??
      nonEmptyString(payload?.grantRoot)
    );
  }
  if (method === "applyPatchApproval") {
    return (
      nonEmptyString(payload?.reason) ??
      describeFileChanges(payload?.fileChanges) ??
      nonEmptyString(payload?.grantRoot)
    );
  }
  return (
    commandDetail(payload?.command) ??
    nonEmptyString(payload?.reason) ??
    nonEmptyString(payload?.prompt)
  );
}

export function toRequestTypeFromKind(kind: unknown): CanonicalRequestType {
  switch (kind) {
    case "command":
      return "command_execution_approval";
    case "file-read":
      return "file_read_approval";
    case "file-change":
      return "file_change_approval";
    default:
      return "unknown";
  }
}

export function toRequestTypeFromResolvedPayload(
  payload: Record<string, unknown> | undefined,
): CanonicalRequestType {
  const request = asObject(payload?.request);
  const method = asString(request?.method) ?? asString(payload?.method);
  if (method) {
    return toRequestTypeFromMethod(method);
  }
  const requestKind = asString(request?.kind) ?? asString(payload?.requestKind);
  if (requestKind) {
    return toRequestTypeFromKind(requestKind);
  }
  return "unknown";
}

export function toCanonicalUserInputAnswers(
  answers: ProviderUserInputAnswers | undefined,
): ProviderUserInputAnswers {
  if (!answers) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(answers).flatMap(([questionId, value]) => {
      if (typeof value === "string") {
        return [[questionId, value] as const];
      }

      if (Array.isArray(value)) {
        const normalized = value.filter((entry): entry is string => typeof entry === "string");
        return [[questionId, normalized.length === 1 ? normalized[0] : normalized] as const];
      }

      const answerObject = asObject(value);
      const answerList = asArray(answerObject?.answers)?.filter(
        (entry): entry is string => typeof entry === "string",
      );
      if (!answerList) {
        return [];
      }
      return [[questionId, answerList.length === 1 ? answerList[0] : answerList] as const];
    }),
  );
}

function toUserInputOption(entry: unknown, index: number) {
  const fromString = asString(entry)?.trim();
  if (fromString) return { label: fromString, description: fromString };
  const option = asObject(entry);
  if (!option) return undefined;
  const description = asString(option.description)?.trim();
  const label = asString(option.label)?.trim() || description || `Option ${index + 1}`;
  return { label, description: description || label };
}

/**
 * Codex waits until this request is answered, so a blank field gets a stand-in rather than losing
 * the question. No options means a free-text answer. Any object entry yields a question, which
 * `hasCodexUserInputQuestions` relies on.
 */
export function toUserInputQuestions(payload: Record<string, unknown> | undefined) {
  const questions = asArray(payload?.questions);
  if (!questions) {
    return undefined;
  }

  const parsedQuestions = questions.flatMap((entry, index) => {
    const question = asObject(entry);
    if (!question) return [];
    const header = asString(question.header)?.trim();
    const options = (asArray(question.options) ?? []).flatMap((option, optionIndex) => {
      const parsed = toUserInputOption(option, optionIndex);
      return parsed ? [parsed] : [];
    });
    return [
      {
        id: asString(question.id)?.trim() || `question-${index + 1}`,
        header: header || "Question",
        question: asString(question.question)?.trim() || header || "Codex is asking for input.",
        options,
      },
    ];
  });

  return parsedQuestions.length > 0 ? parsedQuestions : undefined;
}

/**
 * A `request_user_input_async` item as panel questions; undefined for any other item. Codex does
 * not wait for these, so options carry no description and free text is always allowed.
 */
export function toCodexAsyncQuestions(item: Record<string, unknown> | undefined) {
  if (item?.type !== "agentMessage" || item.delivery !== "async") return undefined;
  const parsedQuestions = (asArray(item.questions) ?? []).flatMap((entry, index) => {
    const question = asObject(entry);
    const title = asString(question?.title)?.trim();
    if (!title) return [];
    const labels = (asArray(question?.options) ?? []).flatMap((option) => {
      const label = asString(option)?.trim();
      return label ? [label] : [];
    });
    return [
      {
        id: String(index),
        header: "Question",
        question: title,
        options: [...new Set(labels)].map((label) => ({ label, description: label })),
      },
    ];
  });
  return parsedQuestions.length > 0 ? parsedQuestions : undefined;
}

export function toThreadState(
  value: unknown,
): "active" | "idle" | "archived" | "closed" | "compacted" | "error" {
  switch (value) {
    case "idle":
      return "idle";
    case "archived":
      return "archived";
    case "closed":
      return "closed";
    case "compacted":
      return "compacted";
    case "error":
    case "failed":
      return "error";
    default:
      return "active";
  }
}

export function contentStreamKindFromMethod(
  method: string,
):
  | "assistant_text"
  | "reasoning_text"
  | "reasoning_summary_text"
  | "plan_text"
  | "command_output"
  | "file_change_output" {
  switch (method) {
    case "item/agentMessage/delta":
      return "assistant_text";
    case "item/reasoning/textDelta":
      return "reasoning_text";
    case "item/reasoning/summaryTextDelta":
      return "reasoning_summary_text";
    case "item/commandExecution/outputDelta":
      return "command_output";
    case "item/fileChange/outputDelta":
      return "file_change_output";
    default:
      return "assistant_text";
  }
}

export const PROPOSED_PLAN_BLOCK_REGEX = /<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>/i;

export function extractProposedPlanMarkdown(text: string | undefined): string | undefined {
  const match = text ? PROPOSED_PLAN_BLOCK_REGEX.exec(text) : null;
  const planMarkdown = match?.[1]?.trim();
  return planMarkdown && planMarkdown.length > 0 ? planMarkdown : undefined;
}

export function asRuntimeItemId(itemId: ProviderItemId): RuntimeItemId {
  return RuntimeItemId.makeUnsafe(itemId);
}

export function asRuntimeRequestId(requestId: string): RuntimeRequestId {
  return RuntimeRequestId.makeUnsafe(requestId);
}

export function asRuntimeTaskId(taskId: string): RuntimeTaskId {
  return RuntimeTaskId.makeUnsafe(taskId);
}

export function codexEventMessage(
  payload: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  return asObject(payload?.msg);
}

export function codexEventBase(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): Omit<ProviderRuntimeEvent, "type" | "payload"> {
  const payload = asObject(event.payload);
  const msg = codexEventMessage(payload);
  const turnId = event.turnId ?? toTurnId(asString(msg?.turn_id) ?? asString(msg?.turnId));
  const itemId = event.itemId ?? toProviderItemId(asString(msg?.item_id) ?? asString(msg?.itemId));
  const requestId = asString(msg?.request_id) ?? asString(msg?.requestId);
  const base = runtimeEventBase(event, canonicalThreadId);
  const providerRefs = base.providerRefs
    ? {
        ...base.providerRefs,
        ...(turnId ? { providerTurnId: turnId } : {}),
        ...(itemId ? { providerItemId: itemId } : {}),
        ...(requestId ? { providerRequestId: requestId } : {}),
      }
    : {
        ...(turnId ? { providerTurnId: turnId } : {}),
        ...(itemId ? { providerItemId: itemId } : {}),
        ...(requestId ? { providerRequestId: requestId } : {}),
      };

  return {
    ...base,
    ...(turnId ? { turnId } : {}),
    ...(itemId ? { itemId: asRuntimeItemId(itemId) } : {}),
    ...(requestId ? { requestId: asRuntimeRequestId(requestId) } : {}),
    ...(Object.keys(providerRefs).length > 0 ? { providerRefs } : {}),
  };
}

export function eventRawSource(
  event: ProviderEvent,
): NonNullable<ProviderRuntimeEvent["raw"]>["source"] {
  return event.kind === "request" ? "codex.app-server.request" : "codex.app-server.notification";
}

export function providerRefsFromEvent(
  event: ProviderEvent,
): ProviderRuntimeEvent["providerRefs"] | undefined {
  const refs: Record<string, string> = {};
  if (event.turnId) refs.providerTurnId = event.turnId;
  if (event.itemId) refs.providerItemId = event.itemId;
  if (event.requestId) refs.providerRequestId = event.requestId;

  return Object.keys(refs).length > 0 ? (refs as ProviderRuntimeEvent["providerRefs"]) : undefined;
}

export function runtimeEventBase(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): Omit<ProviderRuntimeEvent, "type" | "payload"> {
  const refs = providerRefsFromEvent(event);
  return {
    eventId: event.id,
    provider: event.provider,
    threadId: canonicalThreadId,
    createdAt: event.createdAt,
    ...(event.turnId ? { turnId: event.turnId } : {}),
    ...(event.itemId ? { itemId: asRuntimeItemId(event.itemId) } : {}),
    ...(event.requestId ? { requestId: asRuntimeRequestId(event.requestId) } : {}),
    ...(refs ? { providerRefs: refs } : {}),
    raw: {
      source: eventRawSource(event),
      method: event.method,
      payload: event.payload ?? {},
    },
  };
}

/** "Stop hook (user): reason" for a `hook/completed` run that stopped the turn, else undefined. */
export function codexHookStopMessage(
  payload: Record<string, unknown> | undefined,
): string | undefined {
  const run = asObject(payload?.run);
  if (run?.status !== "stopped" || !Array.isArray(run.entries)) return undefined;
  const reason = run.entries
    .flatMap((entry) => {
      const record = asObject(entry);
      const text = record?.kind === "stop" ? asString(record.text)?.trim() : undefined;
      return text ? [text] : [];
    })
    .join("\n");
  if (!reason) return undefined;
  // Codex sends camelCase names ("stop", "preToolUse"); show them as "Stop", "PreToolUse".
  const rawEventName = asString(run.eventName)?.trim();
  const eventName = rawEventName ? rawEventName[0]!.toUpperCase() + rawEventName.slice(1) : "Codex";
  const source = asString(run.source)?.trim();
  return `${eventName} hook${source ? ` (${source})` : ""}: ${reason}`;
}

function isFailedImageGeneration(item: Record<string, unknown>): boolean {
  return item.type === "imageGeneration" && item.failure !== undefined && item.failure !== null;
}

function imageGenerationTitle(status: string | undefined): string {
  switch (status) {
    case "completed":
      return "Generated image";
    case "failed":
      return "Image generation failed";
    case "declined":
    case "stopped":
      return "Image generation stopped";
    default:
      return "Generating image";
  }
}

export function mapItemLifecycle(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
  lifecycle: "item.started" | "item.updated" | "item.completed",
): ProviderRuntimeEvent | undefined {
  const payload = asObject(event.payload);
  const item = asObject(payload?.item);
  const source = item ?? payload;
  if (!source) {
    return undefined;
  }

  const itemType = toCanonicalItemType(source.type ?? source.kind);
  if (itemType === "unknown" && lifecycle !== "item.updated") {
    return undefined;
  }

  const detail = itemDetail(source, payload ?? {}, itemType);
  const status =
    lifecycle === "item.started"
      ? "inProgress"
      : lifecycle === "item.completed"
        ? source.status === "failed" || source.status === "declined" || source.status === "stopped"
          ? source.status
          : isFailedImageGeneration(source)
            ? "failed"
            : "completed"
        : undefined;
  const title =
    source.type === "imageGeneration" ? imageGenerationTitle(status) : itemTitle(itemType);

  return {
    ...runtimeEventBase(event, canonicalThreadId),
    type: lifecycle,
    payload: {
      itemType,
      ...(status ? { status } : {}),
      ...(title ? { title } : {}),
      ...(detail ? { detail } : {}),
      ...(event.payload !== undefined ? { data: event.payload } : {}),
    },
  };
}

export function mapToRuntimeEvents(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
  fileChanges?: CodexFileChangeKinds,
): ReadonlyArray<ProviderRuntimeEvent> {
  const payload = asObject(event.payload);
  const turn = asObject(payload?.turn);

  if (event.kind === "error") {
    if (!event.message) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "runtime.error",
        payload: {
          message: event.message,
          class: "provider_error",
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (event.kind === "request") {
    if (event.method === "item/tool/requestUserInput") {
      const questions = toUserInputQuestions(payload);
      if (!questions) {
        return [];
      }
      return [
        {
          ...runtimeEventBase(event, canonicalThreadId),
          type: "user-input.requested",
          payload: {
            questions,
          },
        },
      ];
    }

    const detail = toRequestOpenedDetail(event.method, payload, fileChanges);
    const methodRequestType = toRequestTypeFromMethod(event.method);
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "request.opened",
        payload: {
          requestType:
            methodRequestType === "unknown" && event.requestKind !== undefined
              ? toRequestTypeFromKind(event.requestKind)
              : methodRequestType,
          ...(detail ? { detail } : {}),
          ...(event.payload !== undefined ? { args: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "item/requestApproval/decision" && event.requestId) {
    const decision = Schema.decodeUnknownSync(ProviderApprovalDecision)(payload?.decision);
    const requestType =
      event.requestKind !== undefined
        ? toRequestTypeFromKind(event.requestKind)
        : toRequestTypeFromMethod(event.method);
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "request.resolved",
        payload: {
          requestType,
          ...(decision ? { decision } : {}),
          ...(event.payload !== undefined ? { resolution: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "session/connecting") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.state.changed",
        payload: {
          state: "starting",
          ...(event.message ? { reason: event.message } : {}),
        },
      },
    ];
  }

  if (event.method === "session/ready") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.state.changed",
        payload: {
          state: "ready",
          ...(event.message ? { reason: event.message } : {}),
        },
      },
    ];
  }

  if (event.method === "session/started") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.started",
        payload: {
          ...(event.message ? { message: event.message } : {}),
          ...(event.payload !== undefined ? { resume: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "session/exited" || event.method === "session/closed") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.exited",
        payload: {
          ...(event.message ? { reason: event.message } : {}),
          ...(event.method === "session/closed" ? { exitKind: "graceful" } : {}),
        },
      },
    ];
  }

  if (event.method === "thread/started") {
    const payloadThreadId = asString(asObject(payload?.thread)?.id);
    const providerThreadId = payloadThreadId ?? asString(payload?.threadId);
    if (!providerThreadId) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "thread.started",
        payload: {
          providerThreadId,
        },
      },
    ];
  }

  if (
    event.method === "thread/status/changed" ||
    event.method === "thread/archived" ||
    event.method === "thread/unarchived" ||
    event.method === "thread/closed" ||
    event.method === "thread/compacted"
  ) {
    return [
      {
        type: "thread.state.changed",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          state:
            event.method === "thread/archived"
              ? "archived"
              : event.method === "thread/closed"
                ? "closed"
                : event.method === "thread/compacted"
                  ? "compacted"
                  : toThreadState(asObject(payload?.thread)?.state ?? payload?.state),
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "thread/goal/updated" || event.method === "thread/goal/cleared") {
    const goal =
      event.method === "thread/goal/updated" ? codexGoalToProviderGoal(payload?.goal) : null;
    // An update this build cannot read says nothing about the goal, so it must not read as cleared.
    if (event.method === "thread/goal/updated" && goal === null) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "thread.goal.updated",
        payload: { goal },
      },
    ];
  }

  if (event.method === "thread/name/updated") {
    return [
      {
        type: "thread.metadata.updated",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          ...(asString(payload?.threadName) ? { name: asString(payload?.threadName) } : {}),
          ...(event.payload !== undefined ? { metadata: asObject(event.payload) } : {}),
        },
      },
    ];
  }

  if (event.method === "thread/tokenUsage/updated") {
    const tokenUsage = asObject(payload?.tokenUsage);
    const normalizedUsage = normalizeCodexTokenUsage(tokenUsage ?? event.payload);
    if (!normalizedUsage) {
      return [];
    }
    return [
      {
        type: "thread.token-usage.updated",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          usage: normalizedUsage,
        },
      },
    ];
  }

  if (event.method === "turn/started") {
    const turnId = event.turnId;
    if (!turnId) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        turnId,
        type: "turn.started",
        payload: {
          ...(asString(turn?.model) ? { model: asString(turn?.model) } : {}),
          ...(asString(turn?.effort) ? { effort: asString(turn?.effort) } : {}),
        },
      },
    ];
  }

  if (event.method === "turn/completed") {
    const errorMessage = asString(asObject(turn?.error)?.message);
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.completed",
        payload: {
          state: toTurnStatus(turn?.status),
          ...(asString(turn?.stopReason) ? { stopReason: asString(turn?.stopReason) } : {}),
          ...(turn?.usage !== undefined ? { usage: turn.usage } : {}),
          ...(asObject(turn?.modelUsage) ? { modelUsage: asObject(turn?.modelUsage) } : {}),
          ...(asNumber(turn?.totalCostUsd) !== undefined
            ? { totalCostUsd: asNumber(turn?.totalCostUsd) }
            : {}),
          ...(errorMessage ? { errorMessage } : {}),
        },
      },
    ];
  }

  if (event.method === "turn/aborted") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.aborted",
        payload: {
          reason: event.message ?? "Turn aborted",
        },
      },
    ];
  }

  if (event.method === "turn/plan/updated") {
    const steps = Array.isArray(payload?.plan) ? payload.plan : [];
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.plan.updated",
        payload: {
          ...(asString(payload?.explanation)
            ? { explanation: asString(payload?.explanation) }
            : {}),
          plan: steps
            .map((entry) => asObject(entry))
            .filter((entry): entry is Record<string, unknown> => entry !== undefined)
            .map((entry) => ({
              step: asString(entry.step) ?? "step",
              status:
                entry.status === "completed" || entry.status === "inProgress"
                  ? entry.status
                  : "pending",
            })),
        },
      },
    ];
  }

  if (event.method === "turn/diff/updated") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.diff.updated",
        payload: {
          unifiedDiff:
            asString(payload?.unifiedDiff) ??
            asString(payload?.diff) ??
            asString(payload?.patch) ??
            "",
        },
      },
    ];
  }

  if (event.method === "item/started") {
    const started = mapItemLifecycle(event, canonicalThreadId, "item.started");
    return started ? [started] : [];
  }

  if (event.method === "item/completed") {
    const payload = asObject(event.payload);
    const item = asObject(payload?.item);
    const source = item ?? payload;
    if (!source) {
      return [];
    }
    const asyncQuestions = toCodexAsyncQuestions(item);
    if (asyncQuestions) {
      // Stable ids: Codex can replay the item, and the answer is matched by request id.
      const stableId = `codex-async:${canonicalThreadId}:${asString(source.id) ?? event.id}`;
      return [
        {
          ...runtimeEventBase(event, canonicalThreadId),
          eventId: EventId.makeUnsafe(stableId),
          requestId: RuntimeRequestId.makeUnsafe(stableId),
          type: "user-input.requested",
          payload: {
            responseMode: "message",
            questions: asyncQuestions,
          },
        },
      ];
    }
    const itemType = source ? toCanonicalItemType(source.type ?? source.kind) : "unknown";
    if (itemType === "plan") {
      const detail = itemDetail(source, payload ?? {}, itemType);
      if (!detail) {
        return [];
      }
      return [
        {
          ...runtimeEventBase(event, canonicalThreadId),
          type: "turn.proposed.completed",
          payload: {
            planMarkdown: detail,
          },
        },
      ];
    }
    const completed = mapItemLifecycle(event, canonicalThreadId, "item.completed");
    if (!completed) {
      return [];
    }
    // Newer CLIs deprecate thread/compacted in favor of this item; the timeline row needs the state event.
    if (itemType === "context_compaction" && source.status !== "failed") {
      return [
        completed,
        {
          ...runtimeEventBase(event, canonicalThreadId),
          eventId: EventId.makeUnsafe(`${event.id}:thread-compacted`),
          type: "thread.state.changed",
          payload: { state: "compacted" },
        },
      ];
    }
    return [completed];
  }

  if (
    event.method === "item/reasoning/summaryPartAdded" ||
    event.method === "item/commandExecution/terminalInteraction"
  ) {
    const updated = mapItemLifecycle(event, canonicalThreadId, "item.updated");
    return updated ? [updated] : [];
  }

  if (event.method === "item/plan/delta") {
    const delta =
      event.textDelta ??
      asString(payload?.delta) ??
      asString(payload?.text) ??
      asString(asObject(payload?.content)?.text);
    if (!delta || delta.length === 0) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.proposed.delta",
        payload: {
          delta,
        },
      },
    ];
  }

  if (
    event.method === "item/agentMessage/delta" ||
    event.method === "item/commandExecution/outputDelta" ||
    event.method === "item/fileChange/outputDelta" ||
    event.method === "item/reasoning/summaryTextDelta" ||
    event.method === "item/reasoning/textDelta"
  ) {
    const delta =
      event.textDelta ??
      asString(payload?.delta) ??
      asString(payload?.text) ??
      asString(asObject(payload?.content)?.text);
    if (!delta || delta.length === 0) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "content.delta",
        payload: {
          streamKind: contentStreamKindFromMethod(event.method),
          delta,
          ...(typeof payload?.contentIndex === "number"
            ? { contentIndex: payload.contentIndex }
            : {}),
          ...(typeof payload?.summaryIndex === "number"
            ? { summaryIndex: payload.summaryIndex }
            : {}),
        },
      },
    ];
  }

  if (event.method === "item/mcpToolCall/progress") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "tool.progress",
        payload: {
          ...(asString(payload?.toolUseId) ? { toolUseId: asString(payload?.toolUseId) } : {}),
          ...(asString(payload?.toolName) ? { toolName: asString(payload?.toolName) } : {}),
          ...(asString(payload?.summary) ? { summary: asString(payload?.summary) } : {}),
          ...(asNumber(payload?.elapsedSeconds) !== undefined
            ? { elapsedSeconds: asNumber(payload?.elapsedSeconds) }
            : {}),
        },
      },
    ];
  }

  if (event.method === "serverRequest/resolved") {
    const requestType =
      toRequestTypeFromResolvedPayload(payload) !== "unknown"
        ? toRequestTypeFromResolvedPayload(payload)
        : event.requestId && event.requestKind !== undefined
          ? toRequestTypeFromKind(event.requestKind)
          : "unknown";
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "request.resolved",
        payload: {
          requestType,
          ...(event.payload !== undefined ? { resolution: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "item/tool/requestUserInput/resolved" && event.requestId) {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "user-input.resolved",
        payload: { answers: {} },
      },
    ];
  }

  if (event.method === "item/tool/requestUserInput/answered") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "user-input.resolved",
        payload: {
          answers: toCanonicalUserInputAnswers(
            asObject(event.payload)?.answers as ProviderUserInputAnswers | undefined,
          ),
        },
      },
    ];
  }

  if (event.method === "codex/event/task_started") {
    const msg = codexEventMessage(payload);
    const taskId = asString(payload?.id) ?? asString(msg?.turn_id);
    if (!taskId) {
      return [];
    }
    return [
      {
        ...codexEventBase(event, canonicalThreadId),
        type: "task.started",
        payload: {
          taskId: asRuntimeTaskId(taskId),
          ...(asString(msg?.collaboration_mode_kind)
            ? { taskType: asString(msg?.collaboration_mode_kind) }
            : {}),
        },
      },
    ];
  }

  if (event.method === "codex/event/task_complete") {
    const msg = codexEventMessage(payload);
    const taskId = asString(payload?.id) ?? asString(msg?.turn_id);
    const proposedPlanMarkdown = extractProposedPlanMarkdown(asString(msg?.last_agent_message));
    if (!taskId) {
      if (!proposedPlanMarkdown) {
        return [];
      }
      return [
        {
          ...codexEventBase(event, canonicalThreadId),
          type: "turn.proposed.completed",
          payload: {
            planMarkdown: proposedPlanMarkdown,
          },
        },
      ];
    }
    const events: ProviderRuntimeEvent[] = [
      {
        ...codexEventBase(event, canonicalThreadId),
        type: "task.completed",
        payload: {
          taskId: asRuntimeTaskId(taskId),
          status: "completed",
          ...(asString(msg?.last_agent_message)
            ? { summary: asString(msg?.last_agent_message) }
            : {}),
        },
      },
    ];
    if (proposedPlanMarkdown) {
      events.push({
        ...codexEventBase(event, canonicalThreadId),
        type: "turn.proposed.completed",
        payload: {
          planMarkdown: proposedPlanMarkdown,
        },
      });
    }
    return events;
  }

  if (event.method === "codex/event/agent_reasoning") {
    const msg = codexEventMessage(payload);
    const taskId = asString(payload?.id);
    const description = asString(msg?.text);
    if (!taskId || !description) {
      return [];
    }
    return [
      {
        ...codexEventBase(event, canonicalThreadId),
        type: "task.progress",
        payload: {
          taskId: asRuntimeTaskId(taskId),
          description,
        },
      },
    ];
  }

  if (event.method === "codex/event/reasoning_content_delta") {
    const msg = codexEventMessage(payload);
    const delta = asString(msg?.delta);
    if (!delta) {
      return [];
    }
    return [
      {
        ...codexEventBase(event, canonicalThreadId),
        type: "content.delta",
        payload: {
          streamKind:
            asNumber(msg?.summary_index) !== undefined
              ? "reasoning_summary_text"
              : "reasoning_text",
          delta,
          ...(asNumber(msg?.summary_index) !== undefined
            ? { summaryIndex: asNumber(msg?.summary_index) }
            : {}),
        },
      },
    ];
  }

  if (event.method === "model/rerouted") {
    return [
      {
        type: "model.rerouted",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          fromModel: asString(payload?.fromModel) ?? "unknown",
          toModel: asString(payload?.toModel) ?? "unknown",
          reason: asString(payload?.reason) ?? "unknown",
        },
      },
    ];
  }

  if (event.method === "deprecationNotice") {
    return [
      {
        type: "deprecation.notice",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          summary: asString(payload?.summary) ?? "Deprecation notice",
          ...(asString(payload?.details) ? { details: asString(payload?.details) } : {}),
        },
      },
    ];
  }

  if (event.method === "configWarning") {
    return [
      {
        type: "config.warning",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          summary: asString(payload?.summary) ?? "Configuration warning",
          ...(asString(payload?.details) ? { details: asString(payload?.details) } : {}),
          ...(asString(payload?.path) ? { path: asString(payload?.path) } : {}),
          ...(payload?.range !== undefined ? { range: payload.range } : {}),
        },
      },
    ];
  }

  if (event.method === "account/updated") {
    return [
      {
        type: "account.updated",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          account: event.payload ?? {},
        },
      },
    ];
  }

  if (event.method === "account/rateLimits/updated") {
    return [
      {
        type: "account.rate-limits.updated",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          rateLimits: event.payload ?? {},
        },
      },
    ];
  }

  if (event.method === "mcpServer/oauthLogin/completed") {
    return [
      {
        type: "mcp.oauth.completed",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          success: payload?.success === true,
          ...(asString(payload?.name) ? { name: asString(payload?.name) } : {}),
          ...(asString(payload?.error) ? { error: asString(payload?.error) } : {}),
        },
      },
    ];
  }

  if (event.method === "thread/realtime/started") {
    const realtimeSessionId = asString(payload?.realtimeSessionId);
    return [
      {
        type: "thread.realtime.started",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          realtimeSessionId,
        },
      },
    ];
  }

  if (event.method === "thread/realtime/itemAdded") {
    return [
      {
        type: "thread.realtime.item-added",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          item: event.payload ?? {},
        },
      },
    ];
  }

  if (event.method === "thread/realtime/outputAudio/delta") {
    return [
      {
        type: "thread.realtime.audio.delta",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          audio: event.payload ?? {},
        },
      },
    ];
  }

  if (event.method === "thread/realtime/error") {
    const message = asString(payload?.message) ?? event.message ?? "Realtime error";
    return [
      {
        type: "thread.realtime.error",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          message,
        },
      },
    ];
  }

  if (event.method === "thread/realtime/closed") {
    return [
      {
        type: "thread.realtime.closed",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          reason: event.message,
        },
      },
    ];
  }

  if (event.method === "error") {
    const message =
      asString(asObject(payload?.error)?.message) ?? event.message ?? "Provider runtime error";
    const willRetry = payload?.willRetry === true;
    return [
      {
        type: willRetry ? "runtime.warning" : "runtime.error",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          message,
          ...(!willRetry ? { class: "provider_error" as const } : {}),
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "hook/completed") {
    const message = codexHookStopMessage(payload);
    return message
      ? [
          {
            type: "runtime.warning",
            ...runtimeEventBase(event, canonicalThreadId),
            payload: { message, ...(event.payload !== undefined ? { detail: event.payload } : {}) },
          },
        ]
      : [];
  }

  if (event.method === "process/stderr") {
    const message = event.message ?? "Codex process stderr";
    const isFatal = isFatalCodexProcessStderrMessage(message);
    return [
      isFatal
        ? {
            type: "runtime.error",
            ...runtimeEventBase(event, canonicalThreadId),
            payload: {
              message,
              class: "provider_error" as const,
              ...(event.payload !== undefined ? { detail: event.payload } : {}),
            },
          }
        : {
            type: "runtime.warning",
            ...runtimeEventBase(event, canonicalThreadId),
            payload: {
              message,
              ...(event.payload !== undefined ? { detail: event.payload } : {}),
            },
          },
    ];
  }

  if (event.method === "session/autoModeUnsupported") {
    return [
      {
        type: "runtime.warning",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          message: event.message ?? "Auto mode is not supported by this Codex CLI.",
        },
      },
    ];
  }

  if (event.method === "windows/worldWritableWarning") {
    return [
      {
        type: "runtime.warning",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          message: event.message ?? "Windows world-writable warning",
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "windowsSandbox/setupCompleted") {
    const payloadRecord = asObject(event.payload);
    const success = payloadRecord?.success;
    const successMessage = event.message ?? "Windows sandbox setup completed";
    const failureMessage = event.message ?? "Windows sandbox setup failed";

    return [
      {
        type: "session.state.changed",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          state: success === false ? "error" : "ready",
          reason: success === false ? failureMessage : successMessage,
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
      ...(success === false
        ? [
            {
              type: "runtime.warning" as const,
              ...runtimeEventBase(event, canonicalThreadId),
              payload: {
                message: failureMessage,
                ...(event.payload !== undefined ? { detail: event.payload } : {}),
              },
            },
          ]
        : []),
    ];
  }

  return [];
}
