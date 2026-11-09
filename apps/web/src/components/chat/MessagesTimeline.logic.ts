import {
  getModelSelectionEffort,
  type MessageId,
  type ModelSelection,
  type OrchestrationThreadActivity,
  THREAD_MODEL_SWITCH_ACTIVITY_KIND,
  ThreadModelSwitchActivityPayload,
  type TurnId,
} from "@piedpiper/contracts";
import { type ToolCallVisibility } from "@piedpiper/contracts/settings";
import { sliceSurrogateSafe } from "@piedpiper/shared/String";
import { Schema } from "effect";
import {
  isFailedWorkLogToolStatus,
  type TimelineEntry,
  type WorkLogEntry,
} from "../../session-logic";
import {
  CHANGED_FILES_MORE_BUTTON_HEIGHT_PX,
  checkpointFileTotals,
} from "../../lib/checkpointFileTotals";
import { isRestartContinuationMessageId } from "../../lib/restartContinuation";
import { buildTurnDiffTree, type TurnDiffTreeNode } from "../../lib/turnDiffTree";
import {
  type ChatMessage,
  type ProposedPlan,
  type ToolInputStream,
  type TurnDiffSummary,
} from "../../types";
import {
  applyTurnFolds,
  TURN_FOLD_ROW_HEIGHT_PX,
  type TurnFoldLatestTurn,
  type TurnFoldRowData,
} from "../ChatView.turnFolds";
import { estimateTimelineMessageHeight } from "../timelineHeight";
import {
  classifyToolName,
  isTodoToolName,
  makeDisplayPath,
  toolBriefFilePath,
  type ToolAction,
} from "./friendlyToolText";
import {
  applyToolCallVisibility,
  workGroupEndsInUnretriedFailure,
} from "./toolCallVisibility.logic";
import { isThoughtWorkEntry, thoughtWorkRowIsStreaming } from "./ThoughtWorkRow.logic";

export { isWorkEntryHiddenByToolCallVisibility } from "./toolCallVisibility.logic";

export const MAX_VISIBLE_WORK_LOG_ENTRIES = 6;

export interface TimelineDurationMessage {
  id: string;
  role: "user" | "assistant" | "system";
  createdAt: string;
  completedAt?: string | undefined;
}

export type MessagesTimelineRow =
  | {
      kind: "work";
      id: string;
      createdAt: string;
      groupedEntries: WorkLogEntry[];
      /** The latest tool attempt in the group failed or was declined. */
      hasFailure: boolean;
    }
  | {
      kind: "message";
      id: string;
      createdAt: string;
      message: ChatMessage;
      durationStart: string;
      showCompletionDivider: boolean;
      /** Divider text above a user message whose turn switched model or effort. */
      modelSwitchLabel?: string;
      /** Messages Zen hid from this message's turn; the turn's card and divider stay here. */
      absorbedMessageIds?: ReadonlyArray<MessageId>;
    }
  | {
      kind: "proposed-plan";
      id: string;
      createdAt: string;
      proposedPlan: ProposedPlan;
    }
  | {
      /** Stands in for hidden tool calls or hidden text while the turn is still running. */
      kind: "hidden-work";
      id: string;
      createdAt: string;
      /** Null when only assistant text is hidden. */
      latestEntry: WorkLogEntry | null;
    }
  | TurnFoldRowData;

export const HIDDEN_WORK_ROW_ID = "hidden-tool-calls-working";
const HIDDEN_WORK_ROW_HEIGHT_PX = 44;
const WORK_GROUP_SUMMARY_ROW_HEIGHT_PX = 44;
const WORK_GROUP_ENTRY_ROW_HEIGHT_PX = 30;
// The expanded card's margin, padding and border around its scroll area.
const WORK_GROUP_EXPANDED_CHROME_HEIGHT_PX = 18;
// Matches the `18rem` of `max-h-[min(18rem,50dvh)]` on the scroll area.
const WORK_GROUP_SCROLL_MAX_HEIGHT_PX = 288;
const WORK_GROUP_SCROLL_END_TOLERANCE_PX = 1;
const TOOL_GROUP_SUMMARY_MAX_ACTIONS = 2;
const MODEL_SWITCH_DIVIDER_HEIGHT_PX = 24;
// The restart notice's one `text-xs` line, its `py-0.5`, and the row's `pb-4`.
const RESTART_NOTICE_ROW_HEIGHT_PX = 36;

/** Above this a paste stays plain text; parsing 100k characters blocks for hundreds of ms per mount. */
const USER_MESSAGE_MARKDOWN_MAX_LENGTH = 40_000;
/** Table parsing grows faster than its length: 20k pipes take seconds where 2k take tens of ms. */
const USER_MESSAGE_MARKDOWN_MAX_PIPES = 2_000;

// Claude's insight style breaks lines with single newlines; its CLI prompt backticks the header.
const ASSISTANT_INSIGHT_HEADER_PATTERN = /^`?★ Insight(?:\s|─|`)/mu;

/** Whether an assistant reply holds an insight block, whose single newlines must stay line breaks. */
export function shouldPreserveAssistantLineBreaks(text: string): boolean {
  return ASSISTANT_INSIGHT_HEADER_PATTERN.test(text);
}

/** The row kept mounted so screen readers can always reach the thread's first heading. */
export function findFirstConversationMessageRowIndex(
  rows: ReadonlyArray<MessagesTimelineRow>,
): number | null {
  const index = rows.findIndex((row) => row.kind === "message" && row.message.role !== "system");
  return index < 0 ? null : index;
}

export function shouldRenderUserMessageAsMarkdown(text: string): boolean {
  if (text.length > USER_MESSAGE_MARKDOWN_MAX_LENGTH) return false;
  let pipes = 0;
  for (let index = text.indexOf("|"); index !== -1; index = text.indexOf("|", index + 1)) {
    pipes += 1;
    if (pipes > USER_MESSAGE_MARKDOWN_MAX_PIPES) return false;
  }
  return true;
}

export function computeMessageDurationStart(
  messages: ReadonlyArray<TimelineDurationMessage>,
): Map<string, string> {
  const result = new Map<string, string>();
  let lastBoundary: string | null = null;

  for (const message of messages) {
    if (message.role === "user") {
      lastBoundary = message.createdAt;
    }
    result.set(message.id, lastBoundary ?? message.createdAt);
    if (message.role === "assistant" && message.completedAt) {
      lastBoundary = message.completedAt;
    }
  }

  return result;
}

export function normalizeCompactToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}

export function isPreviewEligibleWorkEntry(entry: WorkLogEntry): boolean {
  if (entry.toolName && isTodoToolName(entry.toolName)) return false;
  return entry.itemType === "file_change" || entry.itemType === "command_execution";
}

/** The entries a group summary counts; thinking, info and error rows are not tool calls. */
function isToolGroupEntry(entry: WorkLogEntry): boolean {
  return entry.tone === "tool";
}

/** One tool call keeps its own, more specific row; two or more fold into a summary. */
export function shouldSummarizeWorkGroup(entries: ReadonlyArray<WorkLogEntry>): boolean {
  let toolEntries = 0;
  for (const entry of entries) {
    if (isToolGroupEntry(entry) && ++toolEntries >= 2) return true;
  }
  return false;
}

/** Warnings, errors and notices stay visible below a collapsed summary. */
export function resolvePinnedWorkGroupEntries(
  entries: ReadonlyArray<WorkLogEntry>,
): ReadonlyArray<WorkLogEntry> {
  return entries
    .filter((entry) => entry.tone === "info" || entry.tone === "error")
    .slice(-MAX_VISIBLE_WORK_LOG_ENTRIES);
}

/** Whether an entry belongs to the running turn; an entry without a turn id cannot be told apart. */
export function isWorkEntryInRunningTurn(
  entry: Pick<WorkLogEntry, "turnId">,
  isWorking: boolean,
  activeTurnId: TurnId | null,
): boolean {
  return isWorking && (entry.turnId == null || entry.turnId === activeTurnId);
}

/** A stopped turn leaves its entries in progress for good, so only the running turn's are live. */
export function isWorkEntryLive(
  entry: Pick<WorkLogEntry, "inProgress" | "turnId">,
  isWorking: boolean,
  activeTurnId: TurnId | null,
): boolean {
  return entry.inProgress === true && isWorkEntryInRunningTurn(entry, isWorking, activeTurnId);
}

/** The tool call a running group is on right now. */
export function resolveLiveWorkGroupEntry(
  entries: ReadonlyArray<WorkLogEntry>,
  isWorking: boolean,
  activeTurnId: TurnId | null,
): WorkLogEntry | null {
  return (
    entries.findLast(
      (entry) => isToolGroupEntry(entry) && isWorkEntryLive(entry, isWorking, activeTurnId),
    ) ?? null
  );
}

/** The thinking block still streaming in a group, which a collapsed summary keeps visible. */
export function resolveStreamingWorkGroupThought(
  entries: ReadonlyArray<WorkLogEntry>,
  isWorking: boolean,
  activeTurnId: TurnId | null,
): WorkLogEntry | null {
  return (
    entries.findLast(
      (entry) =>
        isThoughtWorkEntry(entry) &&
        thoughtWorkRowIsStreaming(entry, isWorking) &&
        isWorkEntryInRunningTurn(entry, isWorking, activeTurnId),
    ) ?? null
  );
}

function toolGroupAction(entry: WorkLogEntry): ToolAction {
  if (entry.toolName) {
    if (isTodoToolName(entry.toolName)) return "other";
    const named = classifyToolName(entry.toolName);
    if (named !== "other") return named;
  }
  if (entry.requestKind === "file-read" || entry.itemType === "image_view") return "read";
  if (entry.itemType === "web_search") return "web-search";
  // changedFiles lists any path a tool's input names, so it only says "edit" for an unnamed call.
  if (
    entry.requestKind === "file-change" ||
    entry.itemType === "file_change" ||
    (!entry.toolName && (entry.changedFiles?.length ?? 0) > 0)
  ) {
    return "edit";
  }
  if (entry.requestKind === "command" || entry.itemType === "command_execution" || entry.command) {
    return "command";
  }
  return "other";
}

/** Distinct files across the calls; a call that names no file counts as one. */
function countToolGroupFiles(entries: ReadonlyArray<WorkLogEntry>): number {
  const paths = new Set<string>();
  let withoutPath = 0;
  for (const entry of entries) {
    const briefPath = toolBriefFilePath(entry.toolBriefInput);
    const entryPaths = entry.changedFiles?.length
      ? entry.changedFiles
      : briefPath
        ? [briefPath]
        : [];
    if (entryPaths.length === 0) withoutPath += 1;
    for (const path of entryPaths) paths.add(path);
  }
  return paths.size + withoutPath;
}

function pluralize(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function toolGroupActionLabel(action: ToolAction, entries: ReadonlyArray<WorkLogEntry>): string {
  switch (action) {
    case "read":
      return `Read ${pluralize(countToolGroupFiles(entries), "file")}`;
    case "edit":
      return `Changed ${pluralize(countToolGroupFiles(entries), "file")}`;
    case "command":
      return `Ran ${pluralize(entries.length, "command")}`;
    case "code-search":
      return `Searched code ${pluralize(entries.length, "time")}`;
    case "web-search":
      return `Searched the web ${pluralize(entries.length, "time")}`;
    case "other":
      return `Used ${pluralize(entries.length, "tool")}`;
  }
}

/** Changes outrank lookups, and specific lookups outrank the catch-all, when not all actions fit. */
function toolGroupActionPriority(action: ToolAction): number {
  if (action === "edit" || action === "command") return 0;
  return action === "other" ? 2 : 1;
}

export interface ToolGroupSummary {
  /** "Read 4 files and searched code 2 times". */
  readonly label: string;
  /** "1 failed, 1 declined"; null when every call went through. */
  readonly failureNote: string | null;
  /** The only kind of action in the group, or null for a mix. */
  readonly soleAction: ToolAction | null;
}

export function summarizeToolGroup(entries: ReadonlyArray<WorkLogEntry>): ToolGroupSummary {
  const toolEntries = entries.filter(isToolGroupEntry);
  const entriesByAction = new Map<ToolAction, WorkLogEntry[]>();
  for (const entry of toolEntries) {
    const action = toolGroupAction(entry);
    const actionEntries = entriesByAction.get(action);
    if (actionEntries) actionEntries.push(entry);
    else entriesByAction.set(action, [entry]);
  }
  const actions = [...entriesByAction.keys()];
  const selected = new Set(
    actions
      .toSorted((left, right) => toolGroupActionPriority(left) - toolGroupActionPriority(right))
      .slice(0, TOOL_GROUP_SUMMARY_MAX_ACTIONS),
  );
  const labels: string[] = [];
  let remaining = 0;
  for (const [action, actionEntries] of entriesByAction) {
    if (selected.has(action)) labels.push(toolGroupActionLabel(action, actionEntries));
    else remaining += actionEntries.length;
  }
  if (remaining > 0)
    labels.push(`Performed ${remaining} other action${remaining === 1 ? "" : "s"}`);
  const sentence = labels.map((label, index) =>
    index === 0 ? label : `${label.charAt(0).toLowerCase()}${label.slice(1)}`,
  );
  const label =
    sentence.length < 3
      ? sentence.join(" and ")
      : `${sentence.slice(0, -1).join(", ")}, and ${sentence.at(-1)}`;

  const failed = toolEntries.filter((entry) => entry.toolStatus === "failed").length;
  const declined = toolEntries.filter((entry) => entry.toolStatus === "declined").length;
  const failureNotes = [
    ...(failed > 0 ? [`${failed} failed`] : []),
    ...(declined > 0 ? [`${declined} declined`] : []),
  ];
  return {
    label,
    failureNote: failureNotes.length > 0 ? failureNotes.join(", ") : null,
    soleAction: actions.length === 1 ? (actions[0] ?? null) : null,
  };
}

/** Lifecycle updates replace an entry's id, so a group keys off its first call's provider id. */
function workGroupRowId(
  timelineEntry: Extract<TimelineEntry, { kind: "work" }>,
  usedIds: Set<string>,
): string {
  const providerItemId = timelineEntry.entry.providerItemId;
  const stableId = providerItemId ? `work-group:${providerItemId}` : null;
  // A call whose lifecycle events interleave with others can open two groups.
  if (stableId === null || usedIds.has(stableId)) return timelineEntry.id;
  usedIds.add(stableId);
  return stableId;
}

export function isWorkGroupScrolledToEnd(metrics: {
  readonly scrollHeight: number;
  readonly clientHeight: number;
  readonly scrollTop: number;
}): boolean {
  return (
    metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop <=
    WORK_GROUP_SCROLL_END_TOLERANCE_PX
  );
}

/** Only a newly appended call moves the list, and only for a reader already at its end. */
export function shouldFollowWorkGroupAppend(input: {
  readonly previousCount: number;
  readonly nextCount: number;
  readonly wasAtEnd: boolean;
}): boolean {
  return input.wasAtEnd && input.nextCount > input.previousCount;
}

/** True when an upward scroll inside the group moves the group, or a result nested in it. */
export function workGroupConsumesUpwardScroll(
  target: { readonly scrollTop: number; readonly parentElement: unknown } | null,
  group: unknown,
): boolean {
  let element = target;
  while (element) {
    if (element.scrollTop > 0) return true;
    if (element === group) return false;
    element = element.parentElement as typeof target;
  }
  return false;
}

export function workLogEntryIndicatesToolFailure(entry: WorkLogEntry): boolean {
  return isFailedWorkLogToolStatus(entry.toolStatus);
}

/** True only when the latest tool attempt failed, so a retried failure does not flag the group. */
export function workLogEntriesEndInToolFailure(entries: ReadonlyArray<WorkLogEntry>): boolean {
  const latestToolEntry = entries.findLast((entry) => entry.tone === "tool");
  return latestToolEntry !== undefined && workLogEntryIndicatesToolFailure(latestToolEntry);
}

function normalizeLabelForComparison(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * True when a work row's preview only repeats its heading (Claude task.progress often sends the
 * same description as title and detail). The server truncates titles with "...", so a heading
 * ending in "..." also matches a preview that starts with its text.
 */
export function workEntryPreviewDuplicatesHeading(heading: string, preview: string): boolean {
  const normalizedHeading = normalizeLabelForComparison(heading);
  const normalizedPreview = normalizeLabelForComparison(preview);
  if (normalizedPreview === normalizedHeading) return true;
  if (!normalizedHeading.endsWith("...")) return false;
  const truncatedHeading = normalizedHeading.slice(0, -3).trimEnd();
  return truncatedHeading.length > 0 && normalizedPreview.startsWith(truncatedHeading);
}

const TOOL_INPUT_JSON_MAX_CHARS = 20_000;
const SHORT_LABEL_DETAIL_MAX_CHARS = 60;

/** What expanding a compact tool row adds to its one-line label. */
export interface ToolCallExpandedBody {
  /** The full command, where the label only has room for a shortened one. */
  readonly command: string | null;
  /** Formatted on demand with `formatToolInputJson`, so a collapsed row never serializes it. */
  readonly input: Readonly<Record<string, unknown>> | null;
  /** The Edit or Write content of a row that shows no preview card, such as a failed Edit. */
  readonly preview: ToolInputStream | null;
  readonly detail: string | null;
  /** The server keeps only one shortened line of tool output, so it is labelled as a summary. */
  readonly resultSummary: string | null;
  readonly changedFiles: ReadonlyArray<string>;
}

export function fullToolCommand(entry: WorkLogEntry): string | null {
  const preview = entry.staticPreview;
  if (preview?.fieldName === "command" && preview.text.trim().length > 0) return preview.text;
  return entry.command ?? entry.rawCommand ?? null;
}

/** Tool details are often "Tool: <command or JSON input>", which the body already shows in full. */
function expandedToolDetail(
  entry: WorkLogEntry,
  labelText: string,
  command: string | null,
): string | null {
  const detail = entry.detail?.trim();
  if (!detail) return null;
  if (workEntryPreviewDuplicatesHeading(labelText, detail)) return null;
  const toolPrefix = entry.toolName ? `${entry.toolName}: ` : null;
  const request =
    toolPrefix && detail.startsWith(toolPrefix) ? detail.slice(toolPrefix.length) : null;
  if (request !== null && entry.toolInput) return null;
  const shown = (request ?? detail).replace(/\.\.\.$/, "").trim();
  // A Codex subagent's detail is its prompt, cut short, which the Input section shows whole.
  const prompt = entry.toolInput?.prompt;
  if (
    typeof prompt === "string" &&
    (detail.endsWith("...") ? prompt.trim().startsWith(shown) : prompt.trim() === shown)
  ) {
    return null;
  }
  // A bare detail can be real output that happens to appear in the command, so it must match whole,
  // or as far as a trailing "..." says it was cut.
  const isCommandEcho =
    request !== null
      ? command?.includes(shown)
      : detail.endsWith("...")
        ? command?.trim().startsWith(shown)
        : command?.trim() === shown;
  if (isCommandEcho) return null;
  // The label only repeats a short detail whole; a long one is cut off by the row's width.
  if (detail.length <= SHORT_LABEL_DETAIL_MAX_CHARS && labelText.endsWith(detail)) return null;
  return detail;
}

/** The expanded content of a compact tool row, or null when it would add nothing to the label. */
export function buildToolCallExpandedBody(
  entry: WorkLogEntry,
  labelText: string,
): ToolCallExpandedBody | null {
  const fullCommand = fullToolCommand(entry);
  const trimmedCommand = fullCommand?.trim() ?? "";
  // The label only shows a short command whole; a long one is cut off by the row's width.
  const labelShowsCommand =
    trimmedCommand.length <= SHORT_LABEL_DETAIL_MAX_CHARS && labelText.includes(trimmedCommand);
  const command = fullCommand !== null && !labelShowsCommand ? fullCommand : null;
  const input = entry.toolInput && Object.keys(entry.toolInput).length > 0 ? entry.toolInput : null;
  const preview =
    entry.staticPreview && entry.staticPreview.fieldName !== "command" ? entry.staticPreview : null;
  const detail = expandedToolDetail(entry, labelText, fullCommand);
  const resultSummary = entry.toolResultSummary?.trim() || null;
  const files = entry.changedFiles ?? [];
  // A single file is usually the label's own subject, possibly as a shorter relative path.
  const onlyFileName = files.length === 1 ? files[0]?.split(/[\\/]/).at(-1) : undefined;
  const changedFiles = onlyFileName && labelText.includes(onlyFileName) ? [] : files;
  if (!command && !input && !preview && !detail && !resultSummary && changedFiles.length === 0) {
    return null;
  }
  return { command, input, preview, detail, resultSummary, changedFiles };
}

/** A file in the expanded panel: shortened inside the workspace, else in full, as this is where it can be read. */
export function formatExpandedToolFilePath(
  filePath: string,
  workspaceRoot: string | undefined,
): string {
  const displayPath = makeDisplayPath(filePath, workspaceRoot);
  return displayPath.startsWith("/") ? displayPath : filePath;
}

/** Pretty JSON of a tool's input, capped so one huge argument cannot stall the row. */
export function formatToolInputJson(input: Readonly<Record<string, unknown>>): string {
  const json = JSON.stringify(input, null, 2) ?? "";
  return json.length <= TOOL_INPUT_JSON_MAX_CHARS
    ? json
    : `${sliceSurrogateSafe(json, TOOL_INPUT_JSON_MAX_CHARS)}\n… truncated`;
}

/**
 * Shows control characters visibly, so a label cannot hide, reorder or reflow text: C0 and DEL as
 * their Unicode pictures, and C1, bidi overrides and line separators, which have none, as escapes.
 */
export function withVisibleControlCharacters(
  text: string,
  options?: { readonly keepLineBreaks?: boolean },
): string {
  /* oxlint-disable no-control-regex -- matching control characters is the point */
  const pattern = options?.keepLineBreaks
    ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g
    : /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g;
  /* oxlint-enable no-control-regex */
  return text.replace(pattern, (character) => {
    const code = character.charCodeAt(0);
    if (code === 0x7f) return "\u2421";
    return code < 0x20 ? String.fromCharCode(0x2400 + code) : `\\u{${code.toString(16)}}`;
  });
}

/** For a collapsed group: the group's latest tool attempt failed and so did a hidden one. */
export function hiddenWorkLogEntriesIndicateFailure(
  hiddenEntries: ReadonlyArray<WorkLogEntry>,
  visibleEntries: ReadonlyArray<WorkLogEntry>,
): boolean {
  return (
    workLogEntriesEndInToolFailure([...hiddenEntries, ...visibleEntries]) &&
    hiddenEntries.some(workLogEntryIndicatesToolFailure)
  );
}

const isThreadModelSwitchActivityPayload = Schema.is(ThreadModelSwitchActivityPayload);

export function deriveModelSwitchByMessageId(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): Map<MessageId, ThreadModelSwitchActivityPayload> {
  const result = new Map<MessageId, ThreadModelSwitchActivityPayload>();
  for (const activity of activities) {
    if (activity.kind !== THREAD_MODEL_SWITCH_ACTIVITY_KIND) continue;
    if (!isThreadModelSwitchActivityPayload(activity.payload)) continue;
    result.set(activity.payload.messageId, activity.payload);
  }
  return result;
}

/** "Opus 4.6 → Sonnet 4.6", "effort high → low", or both combined; null when nothing visible changed. */
export function formatModelSwitchLabel(
  change: ThreadModelSwitchActivityPayload,
  modelName: (selection: ModelSelection) => string,
  /** Display label for an effort value (e.g. "xhigh" -> "Extra high"); raw value when absent. */
  effortLabel?: (selection: ModelSelection, value: string) => string,
): string | null {
  const modelChanged =
    change.from.provider !== change.to.provider || change.from.model !== change.to.model;
  const fromEffort = getModelSelectionEffort(change.from);
  const toEffort = getModelSelectionEffort(change.to);
  const effortChanged =
    fromEffort !== undefined && toEffort !== undefined && fromEffort !== toEffort;
  const fromEffortLabel =
    fromEffort !== undefined && effortLabel ? effortLabel(change.from, fromEffort) : fromEffort;
  const toEffortLabel =
    toEffort !== undefined && effortLabel ? effortLabel(change.to, toEffort) : toEffort;
  if (modelChanged && effortChanged) {
    return `${modelName(change.from)} ${fromEffortLabel} → ${modelName(change.to)} ${toEffortLabel}`;
  }
  if (modelChanged) return `${modelName(change.from)} → ${modelName(change.to)}`;
  if (effortChanged) return `effort ${fromEffortLabel} → ${toEffortLabel}`;
  return null;
}

/** Divider labels keyed by the user message each model switch sits above. */
export function deriveModelSwitchLabelByMessageId(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  modelName: (selection: ModelSelection) => string,
  effortLabel?: (selection: ModelSelection, value: string) => string,
): Map<MessageId, string> {
  const result = new Map<MessageId, string>();
  for (const [messageId, change] of deriveModelSwitchByMessageId(activities)) {
    const label = formatModelSwitchLabel(change, modelName, effortLabel);
    if (label) result.set(messageId, label);
  }
  return result;
}

/** A "Compacting context" row left open by a turn that is no longer the running one. */
function isStaleContextCompactionEntry(
  entry: TimelineEntry,
  turnRunning: boolean,
  activeTurnId: TurnId | null,
): boolean {
  if (
    entry.kind !== "work" ||
    entry.entry.isContextCompaction !== true ||
    entry.entry.inProgress !== true
  ) {
    return false;
  }
  if (!turnRunning) return true;
  // An earlier turn's unclosed compaction (e.g. the server crashed mid-compaction).
  return (
    activeTurnId !== null && entry.entry.turnId !== undefined && entry.entry.turnId !== activeTurnId
  );
}

export function deriveMessagesTimelineRows(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  completionDividerBeforeEntryId: string | null;
  toolCallVisibility?: ToolCallVisibility;
  /** Shows a single "Working" row for hidden tool calls at the end of a running turn. */
  activeTurnInProgress?: boolean;
  /** The running turn's id; an open compaction row from any other turn is hidden. */
  activeTurnId?: TurnId | null;
  modelSwitchLabelByMessageId?: ReadonlyMap<MessageId, string>;
  /** Omitted means settled turns are not folded. */
  latestTurn?: TurnFoldLatestTurn | null;
  expandedWorkGroups?: Readonly<Record<string, boolean>>;
  turnDiffSummaryByAssistantMessageId?: ReadonlyMap<MessageId, TurnDiffSummary>;
}): MessagesTimelineRow[] {
  const nextRows: MessagesTimelineRow[] = [];
  const usedWorkGroupIds = new Set<string>();
  const turnRunning = input.activeTurnInProgress === true;
  const activeTurnId = input.activeTurnId ?? null;
  const liveEntries = input.timelineEntries.some((entry) =>
    isStaleContextCompactionEntry(entry, turnRunning, activeTurnId),
  )
    ? input.timelineEntries.filter(
        (entry) => !isStaleContextCompactionEntry(entry, turnRunning, activeTurnId),
      )
    : input.timelineEntries;
  const {
    entries: visibleEntries,
    trailingHiddenEntry,
    hasTrailingHiddenMessage,
    retriedFailureEntryIds,
    absorbedMessagesByEntryId,
  } = applyToolCallVisibility(liveEntries, input.toolCallVisibility ?? "showAll", {
    activeTurnInProgress: turnRunning,
    activeTurnId,
  });
  const durationStartByMessageId = computeMessageDurationStart(
    visibleEntries.flatMap((entry) => (entry.kind === "message" ? [entry.message] : [])),
  );
  const folded: {
    entries: ReadonlyArray<TimelineEntry | TurnFoldRowData>;
    foldedTurnIds: ReadonlySet<TurnId>;
  } =
    // Zen already reduces a settled turn to its last message, so there is nothing left to fold.
    input.latestTurn === undefined || input.toolCallVisibility === "zen"
      ? { entries: visibleEntries, foldedTurnIds: new Set() }
      : applyTurnFolds(visibleEntries, {
          latestTurn: input.latestTurn,
          runningTurnId: activeTurnId,
          activeTurnInProgress: turnRunning,
          expandedFoldIds: input.expandedWorkGroups,
          keepVisibleMessageIds: input.turnDiffSummaryByAssistantMessageId,
        });
  const { entries: timelineEntries, foldedTurnIds } = folded;

  for (let index = 0; index < timelineEntries.length; index += 1) {
    const timelineEntry = timelineEntries[index];
    if (!timelineEntry) {
      continue;
    }

    if (timelineEntry.kind === "turn-fold") {
      nextRows.push(timelineEntry);
      continue;
    }

    if (timelineEntry.kind === "work") {
      // Preview-eligible entries (file_change / command_execution) render
      // their own diff card and break grouping — they live as standalone
      // rows so the diff panels are flush with the conversation timeline
      // rather than nested inside a "Tool calls" parent card.
      if (isPreviewEligibleWorkEntry(timelineEntry.entry)) {
        nextRows.push({
          kind: "work",
          id: timelineEntry.id,
          createdAt: timelineEntry.createdAt,
          groupedEntries: [timelineEntry.entry],
          hasFailure: workLogEntriesEndInToolFailure([timelineEntry.entry]),
        });
        continue;
      }
      const groupedEntries = [timelineEntry.entry];
      let cursor = index + 1;
      while (cursor < timelineEntries.length) {
        const nextEntry = timelineEntries[cursor];
        if (!nextEntry || nextEntry.kind !== "work") break;
        if (isPreviewEligibleWorkEntry(nextEntry.entry)) break;
        groupedEntries.push(nextEntry.entry);
        cursor += 1;
      }
      nextRows.push({
        kind: "work",
        id: workGroupRowId(timelineEntry, usedWorkGroupIds),
        createdAt: timelineEntry.createdAt,
        groupedEntries,
        hasFailure: workGroupEndsInUnretriedFailure(groupedEntries, retriedFailureEntryIds),
      });
      index = cursor - 1;
      continue;
    }

    if (timelineEntry.kind === "proposed-plan") {
      nextRows.push({
        kind: "proposed-plan",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        proposedPlan: timelineEntry.proposedPlan,
      });
      continue;
    }

    const modelSwitchLabel =
      timelineEntry.message.role === "user"
        ? input.modelSwitchLabelByMessageId?.get(timelineEntry.message.id)
        : undefined;
    const absorbedMessageIds = absorbedMessagesByEntryId
      .get(timelineEntry.id)
      ?.map((message) => message.id);
    const turnId = timelineEntry.message.turnId;
    nextRows.push({
      kind: "message",
      id: timelineEntry.id,
      createdAt: timelineEntry.createdAt,
      message: timelineEntry.message,
      durationStart:
        durationStartByMessageId.get(timelineEntry.message.id) ?? timelineEntry.message.createdAt,
      showCompletionDivider:
        timelineEntry.message.role === "assistant" &&
        !(turnId && foldedTurnIds.has(turnId)) &&
        (input.completionDividerBeforeEntryId === timelineEntry.id ||
          absorbedMessageIds?.some((id) => id === input.completionDividerBeforeEntryId) === true),
      ...(modelSwitchLabel ? { modelSwitchLabel } : {}),
      ...(absorbedMessageIds ? { absorbedMessageIds } : {}),
    });
  }

  if (input.activeTurnInProgress && (trailingHiddenEntry || hasTrailingHiddenMessage)) {
    nextRows.push({
      kind: "hidden-work",
      id: HIDDEN_WORK_ROW_ID,
      // Anything hidden at the tail is at or before the newest entry.
      createdAt: trailingHiddenEntry?.createdAt ?? liveEntries.at(-1)?.createdAt ?? "",
      latestEntry: trailingHiddenEntry,
    });
  }

  return nextRows;
}

/** A turn's changed files can key off a message Zen hid in favor of this row's message. */
export function resolveMessageRowTurnDiffSummary(
  row: Extract<MessagesTimelineRow, { kind: "message" }>,
  turnDiffSummaryByAssistantMessageId: ReadonlyMap<MessageId, TurnDiffSummary> | undefined,
): TurnDiffSummary | undefined {
  if (!turnDiffSummaryByAssistantMessageId) return undefined;
  const ownSummary = turnDiffSummaryByAssistantMessageId.get(row.message.id);
  if (ownSummary) return ownSummary;
  for (const messageId of row.absorbedMessageIds ?? []) {
    const summary = turnDiffSummaryByAssistantMessageId.get(messageId);
    if (summary) return summary;
  }
  return undefined;
}

export function estimateMessagesTimelineRowHeight(
  row: MessagesTimelineRow,
  input: {
    timelineWidthPx: number | null;
    expandedWorkGroups?: Readonly<Record<string, boolean>>;
    turnDiffSummaryByAssistantMessageId?: ReadonlyMap<MessageId, TurnDiffSummary>;
    /** Whether a turn's changed-files card shows its tree; defaults to expanded. */
    isChangedFilesExpanded?: (turnDiffSummary: TurnDiffSummary) => boolean;
  },
): number {
  switch (row.kind) {
    case "work":
      return estimateWorkRowHeight(row, input);
    case "proposed-plan":
      return estimateTimelineProposedPlanHeight(row.proposedPlan);
    case "hidden-work":
      return HIDDEN_WORK_ROW_HEIGHT_PX;
    case "turn-fold":
      return TURN_FOLD_ROW_HEIGHT_PX;
    case "message": {
      if (row.message.role === "user" && isRestartContinuationMessageId(row.message.id)) {
        return RESTART_NOTICE_ROW_HEIGHT_PX;
      }
      let estimate = estimateTimelineMessageHeight(row.message, {
        timelineWidthPx: input.timelineWidthPx,
      });
      if (row.modelSwitchLabel) estimate += MODEL_SWITCH_DIVIDER_HEIGHT_PX;
      const turnDiffSummary = resolveMessageRowTurnDiffSummary(
        row,
        input.turnDiffSummaryByAssistantMessageId,
      );
      if (turnDiffSummary && turnDiffSummary.files.length > 0) {
        estimate +=
          (input.isChangedFilesExpanded?.(turnDiffSummary) ?? true)
            ? estimateChangedFilesCardHeight(turnDiffSummary)
            : COLLAPSED_CHANGED_FILES_CARD_HEIGHT_PX;
      }
      return estimate;
    }
  }
}

function estimateWorkRowHeight(
  row: Extract<MessagesTimelineRow, { kind: "work" }>,
  input: {
    expandedWorkGroups?: Readonly<Record<string, boolean>>;
  },
): number {
  const isExpanded = input.expandedWorkGroups?.[row.id] ?? false;
  if (shouldSummarizeWorkGroup(row.groupedEntries)) {
    return isExpanded
      ? WORK_GROUP_SUMMARY_ROW_HEIGHT_PX +
          WORK_GROUP_EXPANDED_CHROME_HEIGHT_PX +
          Math.min(
            WORK_GROUP_SCROLL_MAX_HEIGHT_PX,
            row.groupedEntries.length * WORK_GROUP_ENTRY_ROW_HEIGHT_PX,
          )
      : WORK_GROUP_SUMMARY_ROW_HEIGHT_PX +
          (resolvePinnedWorkGroupEntries(row.groupedEntries).length +
            // An estimate has no turn state, and only an unfinished block is labelled this way.
            (row.groupedEntries.some(
              (entry) => isThoughtWorkEntry(entry) && thoughtWorkRowIsStreaming(entry, true),
            )
              ? 1
              : 0)) *
            WORK_GROUP_ENTRY_ROW_HEIGHT_PX;
  }
  const hasOverflow = row.groupedEntries.length > MAX_VISIBLE_WORK_LOG_ENTRIES;
  const visibleEntries =
    hasOverflow && !isExpanded
      ? row.groupedEntries.slice(-MAX_VISIBLE_WORK_LOG_ENTRIES)
      : row.groupedEntries;
  const onlyToolEntries = row.groupedEntries.every(
    (entry) => entry.tone === "tool" || entry.tone === "thinking",
  );
  const showHeader = hasOverflow || !onlyToolEntries;

  // Card chrome, optional header, and one compact work-entry row per visible
  // entry. Streaming-eligible tools (file_change / command_execution) replace
  // the 32px icon row with the diff-style preview panel; the panel grows from
  // ~36px (header only, no body) to ~210px (header + clipped body) so we use
  // an in-between estimate as the initial guess. The virtualizer will measure
  // the actual size after the first render and self-correct.
  let entriesHeight = 0;
  for (const entry of visibleEntries) {
    if (
      isPreviewEligibleWorkEntry(entry) &&
      !isFailedWorkLogToolStatus(entry.toolStatus) &&
      entry.toolStatus !== "stopped"
    ) {
      entriesHeight += 200;
    } else {
      entriesHeight += 32;
    }
  }
  return 28 + (showHeader ? 26 : 0) + entriesHeight;
}

function estimateTimelineProposedPlanHeight(proposedPlan: ProposedPlan): number {
  const estimatedLines = Math.max(1, Math.ceil(proposedPlan.planMarkdown.length / 72));
  return 120 + Math.min(estimatedLines * 22, 880);
}

/** Card chrome plus the folder-chip and file-name summary lines. */
const COLLAPSED_CHANGED_FILES_CARD_HEIGHT_PX = 112;

function estimateChangedFilesCardHeight(turnDiffSummary: TurnDiffSummary): number {
  const treeNodes = buildTurnDiffTree(turnDiffSummary.files);
  const visibleNodeCount = countTurnDiffTreeNodes(treeNodes);

  const moreButtonHeight =
    checkpointFileTotals(turnDiffSummary).hiddenFileCount > 0
      ? CHANGED_FILES_MORE_BUTTON_HEIGHT_PX
      : 0;

  // Card chrome: top/bottom padding, header row, and tree spacing.
  return 60 + visibleNodeCount * 25 + moreButtonHeight;
}

function countTurnDiffTreeNodes(nodes: ReadonlyArray<TurnDiffTreeNode>): number {
  let count = 0;
  for (const node of nodes) {
    count += 1;
    if (node.kind === "directory") {
      count += countTurnDiffTreeNodes(node.children);
    }
  }
  return count;
}
