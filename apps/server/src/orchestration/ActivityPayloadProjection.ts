/**
 * Slims tool activity payloads to the fields the web work log renders, and
 * thins thread snapshots of rows no client reads.
 *
 * Tool lifecycle `data` is slimmed when runtime events are normalized, so the
 * database, live events and snapshots all carry the small form. The snapshot
 * pass re-applies it for rows persisted before slimming existed.
 */
import type { OrchestrationThreadActivity } from "@piedpiper/contracts";
import { sliceSurrogateSafe } from "@piedpiper/shared/String";

const MAX_CHANGED_FILES = 12;
const MAX_RESULT_SUMMARY_CHARS = 84;
const CHANGED_FILE_NESTED_KEYS = [
  "item",
  "result",
  "input",
  "data",
  "changes",
  "files",
  "edits",
  "patch",
  "patches",
  "operations",
] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function pushChangedFile(target: string[], seen: Set<string>, value: unknown): void {
  const normalized = asTrimmedString(value);
  if (!normalized || seen.has(normalized)) {
    return;
  }
  seen.add(normalized);
  target.push(normalized);
}

// Mirrors the web's collectChangedFiles so the precomputed list matches what it found before slimming.
function collectChangedFiles(
  value: unknown,
  target: string[],
  seen: Set<string>,
  depth: number,
): void {
  if (depth > 4 || target.length >= MAX_CHANGED_FILES) {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectChangedFiles(entry, target, seen, depth + 1);
      if (target.length >= MAX_CHANGED_FILES) {
        return;
      }
    }
    return;
  }
  const record = asRecord(value);
  if (!record) {
    return;
  }
  pushChangedFile(target, seen, record.path);
  pushChangedFile(target, seen, record.filePath);
  pushChangedFile(target, seen, record.relativePath);
  pushChangedFile(target, seen, record.filename);
  pushChangedFile(target, seen, record.newPath);
  pushChangedFile(target, seen, record.oldPath);
  for (const nestedKey of CHANGED_FILE_NESTED_KEYS) {
    if (!(nestedKey in record)) {
      continue;
    }
    collectChangedFiles(record[nestedKey], target, seen, depth + 1);
    if (target.length >= MAX_CHANGED_FILES) {
      return;
    }
  }
}

/** First meaningful line of tool output, or a line count when there is none. */
export function summarizeToolTextOutput(value: string): string | null {
  let meaningfulLineCount = 0;
  let offset = 0;
  while (offset <= value.length) {
    const newlineIndex = value.indexOf("\n", offset);
    const lineEnd = newlineIndex === -1 ? value.length : newlineIndex;
    const line = value.slice(offset, lineEnd).replace(/\s+/g, " ").trim();
    if (line.length > 0) {
      meaningfulLineCount += 1;
      if (line !== "```") {
        const summary =
          line.length <= MAX_RESULT_SUMMARY_CHARS
            ? line
            : `${sliceSurrogateSafe(line, MAX_RESULT_SUMMARY_CHARS - 3).trimEnd()}...`;
        // V8 can keep the whole output alive behind a short slice, so the summary must own its bytes.
        return Array.from(summary).join("");
      }
    }
    if (newlineIndex === -1) {
      break;
    }
    offset = newlineIndex + 1;
  }
  return meaningfulLineCount > 1 ? `${meaningfulLineCount.toLocaleString()} lines` : null;
}

// Text of a Claude tool_result block (string or block array content) or a Codex MCP result.
function extractResultText(result: unknown): string | null {
  if (typeof result === "string") {
    return result;
  }
  const record = asRecord(result);
  if (!record) {
    return null;
  }
  if (typeof record.content === "string") {
    return record.content;
  }
  if (Array.isArray(record.content)) {
    const texts: string[] = [];
    for (const entry of record.content) {
      const text = asRecord(entry)?.text;
      if (typeof text === "string" && text.trim().length > 0) {
        texts.push(text);
      }
    }
    return texts.length > 0 ? texts.join("\n") : null;
  }
  for (const key of ["stdout", "output", "text"] as const) {
    if (typeof record[key] === "string") {
      return record[key] as string;
    }
  }
  return null;
}

function summarizeResult(result: unknown): Record<string, unknown> | undefined {
  if (result === undefined || result === null) {
    return undefined;
  }
  const record = asRecord(result);
  const text = extractResultText(result);
  const summary = text ? summarizeToolTextOutput(text) : null;
  const isError = record?.is_error === true;
  if (!summary && !isError) {
    return undefined;
  }
  return {
    ...(summary ? { content: summary } : {}),
    ...(isError ? { is_error: true } : {}),
  };
}

// Codex items carry their full output (aggregatedOutput, diffs, MCP results); keep only what is rendered.
const PROJECTED_ITEM_ARGUMENTS_MAX_CHARS = 20_000;

// Where a Codex item reports its failure: MCP in error, commands in output, dynamic tools in contentItems.
function extractItemFailureText(item: Record<string, unknown>): string | null {
  const errorMessage = asTrimmedString(asRecord(item.error)?.message);
  if (errorMessage) {
    return errorMessage;
  }
  const failed = item.status === "failed";
  if (failed && typeof item.aggregatedOutput === "string") {
    return item.aggregatedOutput;
  }
  if ((failed || item.success === false) && Array.isArray(item.contentItems)) {
    const texts = item.contentItems.flatMap((entry) => {
      const text = asTrimmedString(asRecord(entry)?.text);
      return text ? [text] : [];
    });
    return texts.length > 0 ? texts.join("\n") : null;
  }
  return null;
}

function summarizeItemFailure(item: Record<string, unknown>): Record<string, unknown> | undefined {
  const text = extractItemFailureText(item);
  const summary = text ? summarizeToolTextOutput(text) : null;
  return summary ? { content: summary } : undefined;
}

function projectItem(item: Record<string, unknown>): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const key of ["type", "id", "status", "command", "tool", "server"] as const) {
    if (key in item) {
      projected[key] = item[key];
    }
  }
  const input = asRecord(item.input);
  if (input && "command" in input) {
    projected.input = { command: input.command };
  }
  // Codex MCP, dynamic and collab rows show these as their Input section; the web caps its display.
  const args = asRecord(item.arguments);
  if (args && JSON.stringify(args).length <= PROJECTED_ITEM_ARGUMENTS_MAX_CHARS) {
    projected.arguments = args;
  }
  // A Codex subagent call has no arguments; its prompt is the Input.
  if (typeof item.prompt === "string" && item.prompt.length <= PROJECTED_ITEM_ARGUMENTS_MAX_CHARS) {
    projected.prompt = item.prompt;
  }
  const result = asRecord(item.result);
  const resultSummary = summarizeResult(item.result) ?? summarizeItemFailure(item);
  if ((result && "command" in result) || resultSummary) {
    projected.result = {
      ...resultSummary,
      ...(result && "command" in result ? { command: result.command } : {}),
    };
  }
  return projected;
}

/**
 * Keeps the tool lifecycle `data` fields the web reads (toolName, input,
 * command fields, changed-file paths) and replaces tool output with a one-line
 * summary. Idempotent, so already slim data passes through unchanged in shape.
 */
export function projectToolLifecycleData(data: unknown): unknown {
  const record = asRecord(data);
  if (!record) {
    return data;
  }
  const projected: Record<string, unknown> = {};
  if ("toolName" in record) {
    projected.toolName = record.toolName;
  }
  if ("input" in record) {
    projected.input = record.input;
  }
  if ("command" in record) {
    projected.command = record.command;
  }
  const item = asRecord(record.item);
  if (item) {
    projected.item = projectItem(item);
  }
  const resultSummary = summarizeResult(record.result);
  if (resultSummary) {
    projected.result = resultSummary;
  }
  const changedFiles: string[] = [];
  collectChangedFiles(record, changedFiles, new Set<string>(), 0);
  if (changedFiles.length > 0) {
    projected.files = changedFiles.map((path) => ({ path }));
  }
  return projected;
}

function isToolLifecycleKind(kind: OrchestrationThreadActivity["kind"]): boolean {
  return kind === "tool.started" || kind === "tool.updated" || kind === "tool.completed";
}

/** Slims a tool lifecycle activity's `data`; other activities pass through untouched. */
export function projectActivityPayload(
  activity: OrchestrationThreadActivity,
): OrchestrationThreadActivity {
  if (!isToolLifecycleKind(activity.kind)) {
    return activity;
  }
  const payload = asRecord(activity.payload);
  if (!payload || payload.data === undefined) {
    return activity;
  }
  return { ...activity, payload: { ...payload, data: projectToolLifecycleData(payload.data) } };
}

// Same validity rule as the web's deriveLatestContextWindowSnapshot, so a dropped row never shadowed a kept one.
function isResolvableContextWindowActivity(activity: OrchestrationThreadActivity): boolean {
  if (activity.kind !== "context-window.updated") {
    return false;
  }
  const usedTokens = asRecord(activity.payload)?.usedTokens;
  return typeof usedTokens === "number" && Number.isFinite(usedTokens) && usedTokens >= 0;
}

/**
 * Keeps only the last resolvable context-window row per turn. Clients read the
 * latest one; per-turn retention keeps a value after a revert drops turns.
 */
function dropStaleContextWindowActivities(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<OrchestrationThreadActivity> {
  const latestIndexByTurn = new Map<string | null, number>();
  for (let index = 0; index < activities.length; index += 1) {
    if (isResolvableContextWindowActivity(activities[index]!)) {
      latestIndexByTurn.set(activities[index]!.turnId, index);
    }
  }
  if (latestIndexByTurn.size === 0) {
    return activities;
  }
  return activities.filter(
    (activity, index) =>
      !isResolvableContextWindowActivity(activity) ||
      latestIndexByTurn.get(activity.turnId) === index,
  );
}

/**
 * The identity the web uses to fold lifecycle rows into one call
 * (deriveToolLifecycleCollapseKey): providerItemId, else itemType/label/detail.
 */
function toolLifecycleIdentity(activity: OrchestrationThreadActivity): string | null {
  const payload = asRecord(activity.payload);
  if (!payload) {
    return null;
  }
  const providerItemId = asTrimmedString(payload.providerItemId);
  if (providerItemId) {
    return `pid:${providerItemId}`;
  }
  const itemType = asTrimmedString(payload.itemType) ?? "";
  const label = (asTrimmedString(payload.title) ?? activity.summary)
    .replace(/\s+(?:complete|completed)\s*$/i, "")
    .trim();
  const detail = asTrimmedString(payload.detail) ?? "";
  if (itemType.length === 0 && label.length === 0 && detail.length === 0) {
    return null;
  }
  return [itemType, label, detail].join("\u001f");
}

/**
 * Drops `tool.updated` rows that a later `tool.completed` of the same call in
 * the same turn supersedes, when that completion carries the final data. Matching is
 * per turn because a revert discards whole turns on the client.
 */
function dropSupersededToolUpdatedActivities(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<OrchestrationThreadActivity> {
  const lastCompletionIndexByKey = new Map<string, number>();
  for (let index = 0; index < activities.length; index += 1) {
    const activity = activities[index]!;
    // A completion without data (persisted before slimming) cannot stand in for its updates.
    if (activity.kind !== "tool.completed" || asRecord(asRecord(activity.payload)?.data) === null) {
      continue;
    }
    const identity = toolLifecycleIdentity(activity);
    if (identity) {
      lastCompletionIndexByKey.set(`${activity.turnId ?? ""}\u001e${identity}`, index);
    }
  }
  if (lastCompletionIndexByKey.size === 0) {
    return activities;
  }
  return activities.filter((activity, index) => {
    if (activity.kind !== "tool.updated") {
      return true;
    }
    const identity = toolLifecycleIdentity(activity);
    if (!identity) {
      return true;
    }
    const completionIndex = lastCompletionIndexByKey.get(
      `${activity.turnId ?? ""}\u001e${identity}`,
    );
    return completionIndex === undefined || completionIndex < index;
  });
}

/** Snapshot form of a thread's activities: superseded rows dropped, tool payloads slimmed. */
export function projectSnapshotActivities(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): Array<OrchestrationThreadActivity> {
  return dropSupersededToolUpdatedActivities(dropStaleContextWindowActivities(activities)).map(
    projectActivityPayload,
  );
}
