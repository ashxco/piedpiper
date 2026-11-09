import { type TurnId } from "@piedpiper/contracts";
import { type ToolCallVisibility } from "@piedpiper/contracts/settings";

import {
  isFailedWorkLogToolStatus,
  type TimelineEntry,
  type WorkLogEntry,
} from "../../session-logic";
import { type ChatMessage } from "../../types";

/**
 * Whether the visibility mode removes this work row. Errors always stay. Zen keeps only those and
 * compaction; the other modes also keep info rows such as task progress.
 */
export function isWorkEntryHiddenByToolCallVisibility(
  entry: WorkLogEntry,
  visibility: ToolCallVisibility,
): boolean {
  if (visibility === "showAll" || entry.tone === "error") return false;
  if (visibility === "zen") return entry.isContextCompaction !== true;
  const isToolRow = entry.itemType !== undefined || entry.tone === "tool";
  if (visibility === "hideSuccessful") return isToolRow && entry.toolStatus === "completed";
  return isToolRow || entry.tone === "thinking";
}

export interface ToolCallVisibilityResult {
  readonly entries: ReadonlyArray<TimelineEntry>;
  /** The newest hidden work row, when nothing visible follows it. */
  readonly trailingHiddenEntry: WorkLogEntry | null;
  /** Zen hid the running turn's text after the last visible entry; there may be no work row. */
  readonly hasTrailingHiddenMessage: boolean;
  /** Visible failed tool rows retried by a hidden success, which must not flag their group. */
  readonly retriedFailureEntryIds: ReadonlySet<string>;
  /** Messages Zen hid from a settled turn, by the entry left showing for that turn. */
  readonly absorbedMessagesByEntryId: ReadonlyMap<string, ReadonlyArray<ChatMessage>>;
}

const NOTHING_ABSORBED: ReadonlyMap<string, ReadonlyArray<ChatMessage>> = new Map();
const NO_RETRIED_FAILURES: ReadonlySet<string> = new Set();

function isAssistantEntry(
  entry: TimelineEntry,
): entry is Extract<TimelineEntry, { kind: "message" }> {
  return entry.kind === "message" && entry.message.role === "assistant";
}

/** The entry to keep per settled turn: its last message with text, else its last message. */
function deriveZenAnswerEntryIdByTurn(entries: ReadonlyArray<TimelineEntry>): Map<TurnId, string> {
  const answerByTurn = new Map<TurnId, { id: string; hasText: boolean }>();
  for (const entry of entries) {
    if (!isAssistantEntry(entry) || !entry.message.turnId) continue;
    const hasText = entry.message.text.trim().length > 0;
    const current = answerByTurn.get(entry.message.turnId);
    if (!current || hasText || !current.hasText) {
      answerByTurn.set(entry.message.turnId, { id: entry.id, hasText });
    }
  }
  return new Map([...answerByTurn].map(([turnId, answer]) => [turnId, answer.id]));
}

export function applyToolCallVisibility(
  timelineEntries: ReadonlyArray<TimelineEntry>,
  visibility: ToolCallVisibility,
  turn: { readonly activeTurnInProgress?: boolean; readonly activeTurnId?: TurnId | null } = {},
): ToolCallVisibilityResult {
  if (visibility === "showAll") {
    return {
      entries: timelineEntries,
      trailingHiddenEntry: null,
      hasTrailingHiddenMessage: false,
      retriedFailureEntryIds: NO_RETRIED_FAILURES,
      absorbedMessagesByEntryId: NOTHING_ABSORBED,
    };
  }
  const running = turn.activeTurnInProgress === true;
  const activeTurnId = turn.activeTurnId ?? null;
  const isRunningMessage = (message: ChatMessage) =>
    running && (activeTurnId === null ? message.streaming : message.turnId === activeTurnId);
  const zenAnswers = visibility === "zen" ? deriveZenAnswerEntryIdByTurn(timelineEntries) : null;

  const entries: TimelineEntry[] = [];
  let trailingHiddenEntry: WorkLogEntry | null = null;
  let hasTrailingHiddenMessage = false;
  let lastVisibleFailureId: string | null = null;
  const retriedFailureEntryIds = new Set<string>();
  const absorbedMessagesByEntryId = new Map<string, ChatMessage[]>();
  const absorb = (answerId: string, message: ChatMessage) => {
    const absorbed = absorbedMessagesByEntryId.get(answerId);
    if (absorbed) absorbed.push(message);
    else absorbedMessagesByEntryId.set(answerId, [message]);
  };

  for (const entry of timelineEntries) {
    if (entry.kind === "work" && isWorkEntryHiddenByToolCallVisibility(entry.entry, visibility)) {
      trailingHiddenEntry = entry.entry;
      if (lastVisibleFailureId !== null) retriedFailureEntryIds.add(lastVisibleFailureId);
      continue;
    }
    if (zenAnswers && isAssistantEntry(entry)) {
      if (isRunningMessage(entry.message)) {
        hasTrailingHiddenMessage = true;
        continue;
      }
      const answerId = entry.message.turnId ? zenAnswers.get(entry.message.turnId) : undefined;
      // A message with no turn cannot be grouped, so it always stays.
      // A generated image renders only in its own row, and absorbing keeps nothing but its id.
      if (
        answerId !== undefined &&
        answerId !== entry.id &&
        !entry.message.attachments?.some((attachment) => attachment.type === "image")
      ) {
        absorb(answerId, entry.message);
        continue;
      }
    }
    entries.push(entry);
    trailingHiddenEntry = null;
    hasTrailingHiddenMessage = false;
    lastVisibleFailureId =
      entry.kind === "work" &&
      entry.entry.tone === "tool" &&
      isFailedWorkLogToolStatus(entry.entry.toolStatus)
        ? entry.id
        : entry.kind === "work" && entry.entry.tone !== "tool"
          ? lastVisibleFailureId
          : null;
  }
  return {
    entries,
    trailingHiddenEntry,
    hasTrailingHiddenMessage,
    retriedFailureEntryIds,
    absorbedMessagesByEntryId,
  };
}

/** A work group's failure flag, ignoring failures whose retry the visibility mode hid. */
export function workGroupEndsInUnretriedFailure(
  groupedEntries: ReadonlyArray<WorkLogEntry>,
  retriedFailureEntryIds: ReadonlySet<string>,
): boolean {
  const latestToolEntry = groupedEntries.findLast((entry) => entry.tone === "tool");
  return (
    latestToolEntry !== undefined &&
    isFailedWorkLogToolStatus(latestToolEntry.toolStatus) &&
    !retriedFailureEntryIds.has(latestToolEntry.id)
  );
}
