import { type MessageId, type OrchestrationLatestTurn, type TurnId } from "@piedpiper/contracts";

import { isRestartContinuationMessageId } from "~/lib/restartContinuation";

import { formatElapsed, isFailedWorkLogToolStatus, type TimelineEntry } from "../session-logic";

export type TurnFoldLatestTurn = Pick<
  OrchestrationLatestTurn,
  "turnId" | "state" | "startedAt" | "completedAt"
>;

/** Also the timeline row: fold ids live in the same expanded map as work groups. */
export interface TurnFoldRowData {
  kind: "turn-fold";
  id: string;
  createdAt: string;
  turnId: TurnId;
  label: string;
  expanded: boolean;
}

export interface TurnFold {
  id: string;
  turnId: TurnId;
  createdAt: string;
  label: string;
  hiddenEntryIds: ReadonlySet<string>;
}

export interface TurnFoldInput {
  latestTurn: TurnFoldLatestTurn | null;
  /** `session.activeTurnId`: the projector can mark a running turn settled when a checkpoint lands. */
  runningTurnId: TurnId | null;
  /** While a turn runs, a promptless provider restart's earlier turns stay itemized with it. */
  activeTurnInProgress: boolean;
  /** Messages carrying a changed-files card, which a fold must not take away. */
  keepVisibleMessageIds?: ReadonlySet<MessageId> | ReadonlyMap<MessageId, unknown> | undefined;
}

export const TURN_FOLD_ROW_HEIGHT_PX = 40;

export function turnFoldRowId(turnId: TurnId): string {
  return `turn-fold:${turnId}`;
}

type TimelineMessageEntry = Extract<TimelineEntry, { kind: "message" }>;

interface TurnGroup {
  entries: TimelineEntry[];
  terminalEntry: TimelineMessageEntry | null;
  hasStreamingMessage: boolean;
  hasError: boolean;
  /** The prompt that started the turn; a second turn after one prompt uses its own first entry. */
  startBoundary: string | null;
}

function isPromptEntry(entry: TimelineEntry): boolean {
  return (
    entry.kind === "message" &&
    entry.message.role === "user" &&
    !entry.message.text.startsWith("[qa-card]\n") &&
    !isRestartContinuationMessageId(entry.message.id)
  );
}

function foldableEntryTurnId(entry: TimelineEntry): TurnId | null {
  if (entry.kind === "work") return entry.entry.turnId ?? null;
  if (entry.kind === "message" && entry.message.role === "assistant") {
    return entry.message.turnId ?? null;
  }
  return null;
}

function isCompactionEntry(entry: TimelineEntry): boolean {
  return entry.kind === "work" && entry.entry.isContextCompaction === true;
}

/** Rows that only fold beside other work, and that never stay behind after the terminal message. */
function isNoiseEntry(entry: TimelineEntry): boolean {
  return isCompactionEntry(entry) || (entry.kind === "work" && entry.entry.tone === "thinking");
}

function deriveUnsettledTurnId(input: TurnFoldInput): TurnId | null {
  if (input.runningTurnId !== null) return input.runningTurnId;
  const { latestTurn } = input;
  if (!latestTurn) return null;
  return latestTurn.completedAt !== null && latestTurn.state !== "running"
    ? null
    : latestTurn.turnId;
}

function deriveUnfoldedTurnIds(
  timelineEntries: ReadonlyArray<TimelineEntry>,
  input: TurnFoldInput,
): ReadonlySet<TurnId> {
  const unsettledTurnId = deriveUnsettledTurnId(input);
  if (unsettledTurnId === null) return new Set();
  const turnIds = new Set<TurnId>([unsettledTurnId]);
  if (!input.activeTurnInProgress) return turnIds;
  for (let index = timelineEntries.length - 1; index >= 0; index -= 1) {
    const entry = timelineEntries[index];
    if (!entry || isPromptEntry(entry)) break;
    const turnId = foldableEntryTurnId(entry);
    if (turnId !== null) turnIds.add(turnId);
  }
  return turnIds;
}

function groupEntriesByTurn(timelineEntries: ReadonlyArray<TimelineEntry>): Map<TurnId, TurnGroup> {
  const groups = new Map<TurnId, TurnGroup>();
  let pendingPromptAt: string | null = null;
  for (const entry of timelineEntries) {
    if (isPromptEntry(entry)) {
      pendingPromptAt = entry.createdAt;
      continue;
    }
    const turnId = foldableEntryTurnId(entry);
    if (turnId === null) continue;
    let group = groups.get(turnId);
    if (!group) {
      group = {
        entries: [],
        terminalEntry: null,
        hasStreamingMessage: false,
        hasError: false,
        startBoundary: pendingPromptAt,
      };
      pendingPromptAt = null;
      groups.set(turnId, group);
    }
    group.entries.push(entry);
    if (entry.kind === "message") {
      // A late text-less image must not take the terminal slot and fold the reply.
      if (
        entry.message.text.trim().length > 0 ||
        group.terminalEntry === null ||
        group.terminalEntry.message.text.trim().length === 0
      ) {
        group.terminalEntry = entry;
      }
      if (entry.message.streaming) group.hasStreamingMessage = true;
    } else if (entry.kind === "work" && entry.entry.tone === "error") {
      group.hasError = true;
    }
  }
  return groups;
}

function entryEndedAt(entry: TimelineEntry): string {
  return entry.kind === "message"
    ? (entry.message.completedAt ?? entry.createdAt)
    : entry.createdAt;
}

function deriveTurnElapsed(
  group: TurnGroup,
  turnId: TurnId,
  latestTurn: TurnFoldLatestTurn | null,
): string | null {
  // A reverted turn's timing is its checkpoint's time twice, which measures nothing.
  if (
    latestTurn?.turnId === turnId &&
    latestTurn.startedAt &&
    latestTurn.completedAt &&
    Date.parse(latestTurn.completedAt) > Date.parse(latestTurn.startedAt)
  ) {
    return formatElapsed(latestTurn.startedAt, latestTurn.completedAt);
  }
  const firstEntry = group.entries[0];
  if (!firstEntry) return null;
  // A turn cut short can leave work behind its terminal message, so take whichever ended last.
  const endedAt = group.entries.reduce((latest, entry) => {
    const candidate = entryEndedAt(entry);
    return Date.parse(candidate) > Date.parse(latest) ? candidate : latest;
  }, entryEndedAt(firstEntry));
  return formatElapsed(group.startBoundary ?? firstEntry.createdAt, endedAt);
}

function deriveTurnFoldLabel(
  group: TurnGroup,
  turnId: TurnId,
  latestTurn: TurnFoldLatestTurn | null,
): string {
  const elapsed = deriveTurnElapsed(group, turnId, latestTurn);
  if (latestTurn?.turnId === turnId && latestTurn.state === "interrupted") {
    // "interrupted" also covers a failed checkpoint capture or a stopped session, not only the user.
    return elapsed ? `Stopped after ${elapsed}` : "Stopped this response";
  }
  return elapsed ? `Worked for ${elapsed}` : "Worked";
}

/**
 * Folds of settled turns, keyed by the entry each fold's row sits above. Only a turn's work and
 * assistant messages fold: prompts, Q&A cards and proposed plans stay in the timeline. Pass the
 * entries left after tool-call visibility filtering.
 */
export function deriveTurnFolds(
  timelineEntries: ReadonlyArray<TimelineEntry>,
  input: TurnFoldInput,
): ReadonlyMap<string, TurnFold> {
  const unfoldedTurnIds = deriveUnfoldedTurnIds(timelineEntries, input);
  const folds = new Map<string, TurnFold>();
  for (const [turnId, group] of groupEntriesByTurn(timelineEntries)) {
    if (unfoldedTurnIds.has(turnId) || group.hasStreamingMessage || group.hasError) continue;
    if (input.latestTurn?.turnId === turnId && input.latestTurn.state === "error") continue;

    const terminalIndex = group.terminalEntry
      ? group.entries.indexOf(group.terminalEntry)
      : group.entries.length;
    // One successful tool call right after the reply is a wrap-up; a longer tail stays readable.
    const isLoneTrailingWork = (entry: TimelineEntry, index: number) =>
      group.entries.length === terminalIndex + 2 &&
      index === terminalIndex + 1 &&
      entry.kind === "work" &&
      !isFailedWorkLogToolStatus(entry.entry.toolStatus);
    const hiddenEntries = group.entries.filter((entry, index) => {
      if (entry === group.terminalEntry) return false;
      if (entry.kind === "message" && input.keepVisibleMessageIds?.has(entry.message.id)) {
        return false;
      }
      // A generated image is part of the answer, so it stays out of the fold.
      if (
        entry.kind === "message" &&
        entry.message.attachments?.some((attachment) => attachment.type === "image")
      ) {
        return false;
      }
      return index < terminalIndex || isNoiseEntry(entry) || isLoneTrailingWork(entry, index);
    });
    // Compaction and thoughts alone stay visible; they only fold along with other work. So does a
    // reply's only other activity, as a fold would hide less than it adds.
    const anchor = hiddenEntries[0];
    if (!anchor || hiddenEntries.every(isNoiseEntry)) continue;
    if (hiddenEntries.length === 1 && group.entries.indexOf(anchor) > terminalIndex) continue;

    folds.set(anchor.id, {
      id: turnFoldRowId(turnId),
      turnId,
      createdAt: anchor.createdAt,
      label: deriveTurnFoldLabel(group, turnId, input.latestTurn),
      hiddenEntryIds: new Set(hiddenEntries.map((entry) => entry.id)),
    });
  }
  return folds;
}

/**
 * Drops the entries of collapsed folds and puts a fold row above each fold's first hidden entry.
 * A row is not a work entry, so work grouping never merges across it.
 */
export function applyTurnFolds(
  timelineEntries: ReadonlyArray<TimelineEntry>,
  input: TurnFoldInput & { expandedFoldIds?: Readonly<Record<string, boolean>> | undefined },
): {
  entries: ReadonlyArray<TimelineEntry | TurnFoldRowData>;
  foldedTurnIds: ReadonlySet<TurnId>;
} {
  const folds = deriveTurnFolds(timelineEntries, input);
  if (folds.size === 0) return { entries: timelineEntries, foldedTurnIds: new Set() };

  const collapsedEntryIds = new Set<string>();
  const foldedTurnIds = new Set<TurnId>();
  for (const fold of folds.values()) {
    foldedTurnIds.add(fold.turnId);
    if (input.expandedFoldIds?.[fold.id] === true) continue;
    for (const entryId of fold.hiddenEntryIds) collapsedEntryIds.add(entryId);
  }

  const entries: Array<TimelineEntry | TurnFoldRowData> = [];
  for (const entry of timelineEntries) {
    const fold = folds.get(entry.id);
    if (fold) {
      const expanded = input.expandedFoldIds?.[fold.id] === true;
      entries.push({
        kind: "turn-fold",
        id: fold.id,
        createdAt: fold.createdAt,
        turnId: fold.turnId,
        label: fold.label,
        expanded,
      });
    }
    if (!collapsedEntryIds.has(entry.id)) entries.push(entry);
  }
  return { entries, foldedTurnIds };
}
