import { type MessageId } from "@piedpiper/contracts";
import { type TimelineEntry, type WorkLogEntry } from "../../session-logic";
import { buildTurnDiffTree, type TurnDiffTreeNode } from "../../lib/turnDiffTree";
import { type ChatMessage, type ProposedPlan, type TurnDiffSummary } from "../../types";
import { estimateTimelineMessageHeight } from "../timelineHeight";

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
    }
  | {
      kind: "message";
      id: string;
      createdAt: string;
      message: ChatMessage;
      durationStart: string;
      showCompletionDivider: boolean;
    }
  | {
      kind: "proposed-plan";
      id: string;
      createdAt: string;
      proposedPlan: ProposedPlan;
    };

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
  return entry.itemType === "file_change" || entry.itemType === "command_execution";
}

export function deriveMessagesTimelineRows(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  completionDividerBeforeEntryId: string | null;
}): MessagesTimelineRow[] {
  const nextRows: MessagesTimelineRow[] = [];
  const durationStartByMessageId = computeMessageDurationStart(
    input.timelineEntries.flatMap((entry) => (entry.kind === "message" ? [entry.message] : [])),
  );

  for (let index = 0; index < input.timelineEntries.length; index += 1) {
    const timelineEntry = input.timelineEntries[index];
    if (!timelineEntry) {
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
        });
        continue;
      }
      const groupedEntries = [timelineEntry.entry];
      let cursor = index + 1;
      while (cursor < input.timelineEntries.length) {
        const nextEntry = input.timelineEntries[cursor];
        if (!nextEntry || nextEntry.kind !== "work") break;
        if (isPreviewEligibleWorkEntry(nextEntry.entry)) break;
        groupedEntries.push(nextEntry.entry);
        cursor += 1;
      }
      nextRows.push({
        kind: "work",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        groupedEntries,
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

    nextRows.push({
      kind: "message",
      id: timelineEntry.id,
      createdAt: timelineEntry.createdAt,
      message: timelineEntry.message,
      durationStart:
        durationStartByMessageId.get(timelineEntry.message.id) ?? timelineEntry.message.createdAt,
      showCompletionDivider:
        timelineEntry.message.role === "assistant" &&
        input.completionDividerBeforeEntryId === timelineEntry.id,
    });
  }

  return nextRows;
}

export function estimateMessagesTimelineRowHeight(
  row: MessagesTimelineRow,
  input: {
    timelineWidthPx: number | null;
    expandedWorkGroups?: Readonly<Record<string, boolean>>;
    turnDiffSummaryByAssistantMessageId?: ReadonlyMap<MessageId, TurnDiffSummary>;
  },
): number {
  switch (row.kind) {
    case "work":
      return estimateWorkRowHeight(row, input);
    case "proposed-plan":
      return estimateTimelineProposedPlanHeight(row.proposedPlan);
    case "message": {
      let estimate = estimateTimelineMessageHeight(row.message, {
        timelineWidthPx: input.timelineWidthPx,
      });
      const turnDiffSummary = input.turnDiffSummaryByAssistantMessageId?.get(row.message.id);
      if (turnDiffSummary && turnDiffSummary.files.length > 0) {
        estimate += estimateChangedFilesCardHeight(turnDiffSummary);
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
  const hasOverflow = row.groupedEntries.length > MAX_VISIBLE_WORK_LOG_ENTRIES;
  const visibleEntries =
    hasOverflow && !isExpanded
      ? row.groupedEntries.slice(-MAX_VISIBLE_WORK_LOG_ENTRIES)
      : row.groupedEntries;
  const onlyToolEntries = row.groupedEntries.every((entry) => entry.tone === "tool");
  const showHeader = hasOverflow || !onlyToolEntries;

  // Card chrome, optional header, and one compact work-entry row per visible
  // entry. Streaming-eligible tools (file_change / command_execution) replace
  // the 32px icon row with the diff-style preview panel; the panel grows from
  // ~36px (header only, no body) to ~210px (header + clipped body) so we use
  // an in-between estimate as the initial guess. The virtualizer will measure
  // the actual size after the first render and self-correct.
  let entriesHeight = 0;
  for (const entry of visibleEntries) {
    if (entry.itemType === "file_change" || entry.itemType === "command_execution") {
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

function estimateChangedFilesCardHeight(turnDiffSummary: TurnDiffSummary): number {
  const treeNodes = buildTurnDiffTree(turnDiffSummary.files);
  const visibleNodeCount = countTurnDiffTreeNodes(treeNodes);

  // Card chrome: top/bottom padding, header row, and tree spacing.
  return 60 + visibleNodeCount * 25;
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
