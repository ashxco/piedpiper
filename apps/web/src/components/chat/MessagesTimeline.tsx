import { type MessageId, type ThreadId, type TurnId } from "@piedpiper/contracts";
import {
  Component,
  createContext,
  Fragment,
  memo,
  use,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import { type VirtualItem } from "@tanstack/react-virtual";
import {
  deriveTimelineEntries,
  formatElapsed,
  isFailedWorkLogToolStatus,
} from "../../session-logic";

import { useToolInputPreviews } from "../../storeSelectors";
import { useStableCallback } from "../../hooks/useStableCallback";
import { type TimelineRowScrollResult, useTimelineRowScroller } from "../ChatView.timelinePosition";
import { TurnFoldRow } from "../ChatView.turnFoldRow";
import { type TurnFoldLatestTurn } from "../ChatView.turnFolds";
import { resolveThreadChangedFilesExpanded, useUiStateStore } from "../../uiStateStore";
import { type ChatImageAttachment, type ToolInputStream, type TurnDiffSummary } from "../../types";
import { findLiveCommandOutput } from "~/lib/liveCommandOutput";
import { LiveCommandOutput } from "./LiveCommandOutput";
import { ShimmerText } from "./ShimmerText";
import { buildFriendlyToolText } from "./friendlyToolText";
import { ToolInputCodePreview } from "./ToolInputCodePreview";
import { checkpointFileTotals } from "../../lib/checkpointFileTotals";
import {
  isRestartContinuationMessageId,
  RESTART_CONTINUATION_NOTICE,
} from "../../lib/restartContinuation";
import ChatMarkdown from "../ChatMarkdown";
import {
  BotIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CircleHelpIcon,
  EyeIcon,
  FileTextIcon,
  GlobeIcon,
  HammerIcon,
  LoaderIcon,
  type LucideIcon,
  SearchIcon,
  SquarePenIcon,
  TerminalIcon,
  Undo2Icon,
  WrenchIcon,
  XCircleIcon,
  ZapIcon,
} from "lucide-react";
import { Button } from "../ui/button";
import { clamp } from "effect/Number";
import { buildExpandedImagePreview, ExpandedImagePreview } from "./ExpandedImagePreview";
import { ProposedPlanCard } from "./ProposedPlanCard";
import { ChangedFilesMoreButton } from "./ChangedFilesMoreButton";
import { ChangedFilesTree } from "./ChangedFilesTree";
import { DiffStatLabel, hasNonZeroStat } from "./DiffStatLabel";
import {
  changedFileName,
  selectChangedFilePreview,
  shouldAutoExpandChangedFiles,
  summarizeChangedFileScopes,
} from "./changedFilesPresentation";
import { MessageCopyButton } from "./MessageCopyButton";
import {
  COLLAPSED_USER_MESSAGE_MAX_HEIGHT_PX,
  deriveUserMessageWithReviewComments,
  shouldCollapseUserMessage,
} from "../timelineHeight";
import { UserMessageReviewComments } from "./UserMessageReviewComments";
import { useSettings } from "../../hooks/useSettings";
import {
  MAX_VISIBLE_WORK_LOG_ENTRIES,
  deriveMessagesTimelineRows,
  estimateMessagesTimelineRowHeight,
  findFirstConversationMessageRowIndex,
  buildToolCallExpandedBody,
  formatExpandedToolFilePath,
  formatToolInputJson,
  fullToolCommand,
  hiddenWorkLogEntriesIndicateFailure,
  isPreviewEligibleWorkEntry,
  isWorkEntryInRunningTurn,
  isWorkEntryLive,
  isWorkGroupScrolledToEnd,
  normalizeCompactToolLabel,
  resolveLiveWorkGroupEntry,
  resolvePinnedWorkGroupEntries,
  resolveStreamingWorkGroupThought,
  resolveMessageRowTurnDiffSummary,
  shouldFollowWorkGroupAppend,
  shouldPreserveAssistantLineBreaks,
  shouldRenderUserMessageAsMarkdown,
  shouldSummarizeWorkGroup,
  summarizeToolGroup,
  withVisibleControlCharacters,
  workEntryPreviewDuplicatesHeading,
  workGroupConsumesUpwardScroll,
  type MessagesTimelineRow,
  type ToolCallExpandedBody,
  type ToolGroupSummary,
} from "./MessagesTimeline.logic";
import {
  deriveTimelineMinimapItems,
  TIMELINE_MINIMAP_JUMP_TOP_OFFSET_PX,
  type TimelineMinimapItem,
  type TimelineMinimapItemBounds,
} from "./MessagesTimeline.minimap.logic";
import { partitionMessageAttachments } from "./MessagesTimeline.attachments";
import { useTimelineRowVirtualizer } from "./MessagesTimeline.virtualizer";
import { MessagesTimelineMinimap } from "./MessagesTimelineMinimap";
import { ThoughtWorkEntryRow } from "./ThoughtWorkRow";
import { isThoughtWorkEntry } from "./ThoughtWorkRow.logic";
import { ThreadFind } from "./ThreadFindBar";
import { THREAD_FIND_REVEAL_EVENT } from "./threadFindHighlights";
import { closeThreadFind, useThreadFindStore } from "./threadFindStore";
import { TerminalContextInlineChip } from "./TerminalContextInlineChip";
import { type ParsedTerminalContextEntry } from "~/lib/terminalContext";
import { cn } from "~/lib/utils";
import { textDirection } from "~/markdown-text-direction";
import { type TimestampFormat } from "@piedpiper/contracts/settings";
import { formatDayAwareTimestamp } from "../../timestampFormat";
import { useLocalDayStart } from "../../hooks/useLocalDayStart";
import { isUsageLimitResumeMessageId } from "~/lib/usageLimitResume";
import { formatDiagnosticsBytes } from "../settings/DiagnosticsSettings.logic";
import { formatTimelineRowTimestampTooltip } from "./MessagesTimeline.rowTimestamp";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  buildInlineTerminalContextText,
  formatInlineTerminalContextLabel,
  splitInlineSegmentWhitespace,
  textContainsInlineTerminalContextLabels,
} from "./userMessageTerminalContexts";

const ALWAYS_UNVIRTUALIZED_TAIL_ROWS = 8;
const MINIMAP_SETTLE_MAX_FRAMES = 12;
const MINIMAP_SETTLE_ALIGNED_FRAMES = 3;

interface MessagesTimelineProps {
  threadId: ThreadId;
  hasMessages: boolean;
  isWorking: boolean;
  activeTurnInProgress: boolean;
  /** The running turn's id, so an earlier turn's unclosed compaction row stays hidden. */
  activeTurnId?: TurnId | null;
  /** The thread's latest turn; settled turns fold only when this is provided. */
  latestTurn?: TurnFoldLatestTurn | null | undefined;
  activeTurnStartedAt: string | null;
  scrollContainer: HTMLDivElement | null;
  timelineEntries: ReturnType<typeof deriveTimelineEntries>;
  completionDividerBeforeEntryId: string | null;
  completionSummary: string | null;
  turnDiffSummaryByAssistantMessageId: Map<MessageId, TurnDiffSummary>;
  expandedWorkGroups: Record<string, boolean>;
  onToggleWorkGroup: (groupId: string) => void;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  onOpenToolDiff?: ((toolId: string, stream: ToolInputStream) => void) | undefined;
  revertTurnCountByUserMessageId: Map<MessageId, number>;
  onRevertUserMessage: (messageId: MessageId) => void;
  isRevertingCheckpoint: boolean;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  markdownCwd: string | undefined;
  resolvedTheme: "light" | "dark";
  timestampFormat: TimestampFormat;
  workspaceRoot: string | undefined;
  /** Screen-reader heading for assistant messages, e.g. the provider name. */
  assistantLabel?: string | undefined;
  /** Model or effort switch dividers keyed by the user message they sit above. */
  modelSwitchLabelByMessageId?: ReadonlyMap<MessageId, string> | undefined;
  /** Runs a shell code block from an assistant message; omit when there is no project terminal. */
  onRunShellCommand?: ((command: string) => void) | undefined;
  /** The thread's latest turn; defaults to the turn of the last assistant reply after the last user message. */
  latestTurnId?: TurnId | null | undefined;
  /** Called before a user-initiated jump (the minimap), so follow-to-bottom can stop first. */
  onManualNavigation?: (() => void) | undefined;
  /** Called after the find bar closes from its own controls, to hand focus back. */
  onThreadFindClose?: (() => void) | undefined;
  onVirtualizerSnapshot?: (snapshot: {
    totalSize: number;
    measurements: ReadonlyArray<{
      id: string;
      kind: MessagesTimelineRow["kind"];
      index: number;
      size: number;
      start: number;
      end: number;
    }>;
  }) => void;
}

interface TimelineRowSharedState {
  threadId: ThreadId;
  timestampFormat: TimestampFormat;
  markdownCwd: string | undefined;
  workspaceRoot: string | undefined;
  resolvedTheme: "light" | "dark";
  onImageExpand: (preview: ExpandedImagePreview) => void;
  onToggleWorkGroup: (groupId: string) => void;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  onOpenToolDiff?: ((toolId: string, stream: ToolInputStream) => void) | undefined;
  onRevertUserMessage: (messageId: MessageId) => void;
  onTimelineImageLoad: () => void;
  onToggleAllDirectories: (turnId: TurnId, currentlyExpanded: boolean) => void;
  onRunShellCommand: ((command: string) => void) | undefined;
  assistantLabel: string;
  /** Tool row disclosure state outlives a row leaving the virtualized window. */
  isToolRowExpanded: (rowKey: string) => boolean;
  setToolRowExpanded: (rowKey: string, expanded: boolean) => void;
}

interface TimelineRowActivityState {
  isWorking: boolean;
  isRevertingCheckpoint: boolean;
  latestTurnId: TurnId | null;
  activeTurnId: TurnId | null;
}

// Split so per-turn activity flips only re-render the few controls that read them.
const TimelineRowCtx = createContext<TimelineRowSharedState | null>(null);
const TimelineRowActivityCtx = createContext<TimelineRowActivityState>({
  isWorking: false,
  isRevertingCheckpoint: false,
  latestTurnId: null,
  activeTurnId: null,
});

const NOOP_RUN_SHELL_COMMAND = (_command: string) => {};

function useTimelineRowContext(): TimelineRowSharedState {
  const ctx = use(TimelineRowCtx);
  if (!ctx) {
    throw new Error("Timeline rows must render inside MessagesTimeline.");
  }
  return ctx;
}

export const MessagesTimeline = memo(function MessagesTimeline({
  threadId,
  hasMessages,
  isWorking,
  activeTurnInProgress,
  activeTurnId = null,
  latestTurn,
  activeTurnStartedAt,
  scrollContainer,
  timelineEntries,
  completionDividerBeforeEntryId,
  completionSummary,
  turnDiffSummaryByAssistantMessageId,
  expandedWorkGroups,
  onToggleWorkGroup,
  onOpenTurnDiff,
  onOpenToolDiff,
  revertTurnCountByUserMessageId,
  onRevertUserMessage,
  isRevertingCheckpoint,
  onImageExpand,
  markdownCwd,
  resolvedTheme,
  timestampFormat,
  workspaceRoot,
  assistantLabel = "Assistant",
  modelSwitchLabelByMessageId,
  onRunShellCommand,
  latestTurnId: latestTurnIdProp,
  onManualNavigation,
  onThreadFindClose,
  onVirtualizerSnapshot,
}: MessagesTimelineProps) {
  const toolInputPreviews = useToolInputPreviews(threadId);
  const toolCallVisibilitySetting = useSettings((settings) => settings.toolCallVisibility);
  const isThreadFindOpen = useThreadFindStore((state) => state.openThreadId === threadId);
  // Find searches these rows, and Zen's hidden intermediate replies would report no matches.
  const toolCallVisibility =
    isThreadFindOpen && toolCallVisibilitySetting === "zen" ? "hideAll" : toolCallVisibilitySetting;
  const timelineRootRef = useRef<HTMLDivElement | null>(null);
  const [timelineRootElement, setTimelineRootElement] = useState<HTMLDivElement | null>(null);
  const setTimelineRoot = useCallback((node: HTMLDivElement | null) => {
    timelineRootRef.current = node;
    setTimelineRootElement(node);
  }, []);
  const [timelineWidthPx, setTimelineWidthPx] = useState<number | null>(null);

  useLayoutEffect(() => {
    const timelineRoot = timelineRootRef.current;
    if (!timelineRoot) return;

    const updateWidth = (nextWidth: number) => {
      setTimelineWidthPx((previousWidth) => {
        if (previousWidth !== null && Math.abs(previousWidth - nextWidth) < 0.5) {
          return previousWidth;
        }
        return nextWidth;
      });
    };

    updateWidth(timelineRoot.getBoundingClientRect().width);

    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      updateWidth(timelineRoot.getBoundingClientRect().width);
    });
    observer.observe(timelineRoot);
    return () => {
      observer.disconnect();
    };
  }, [hasMessages, isWorking]);

  // Without `latestTurn` nothing folds, which is what the find bar searches.
  const unfoldedRowsInput = useMemo(
    () => ({
      timelineEntries,
      completionDividerBeforeEntryId,
      toolCallVisibility,
      activeTurnInProgress,
      activeTurnId,
      ...(modelSwitchLabelByMessageId ? { modelSwitchLabelByMessageId } : {}),
      expandedWorkGroups,
      turnDiffSummaryByAssistantMessageId,
    }),
    [
      timelineEntries,
      completionDividerBeforeEntryId,
      toolCallVisibility,
      activeTurnInProgress,
      activeTurnId,
      modelSwitchLabelByMessageId,
      expandedWorkGroups,
      turnDiffSummaryByAssistantMessageId,
    ],
  );
  const rows = useMemo(
    () =>
      deriveMessagesTimelineRows({
        ...unfoldedRowsInput,
        ...(latestTurn === undefined ? {} : { latestTurn }),
      }),
    [unfoldedRowsInput, latestTurn],
  );

  const firstUnvirtualizedRowIndex = useMemo(() => {
    const firstTailRowIndex = Math.max(rows.length - ALWAYS_UNVIRTUALIZED_TAIL_ROWS, 0);
    if (!activeTurnInProgress) return firstTailRowIndex;

    const turnStartedAtMs =
      typeof activeTurnStartedAt === "string" ? Date.parse(activeTurnStartedAt) : Number.NaN;
    let firstCurrentTurnRowIndex = -1;
    if (!Number.isNaN(turnStartedAtMs)) {
      firstCurrentTurnRowIndex = rows.findIndex((row) => {
        if (!row.createdAt) return false;
        const rowCreatedAtMs = Date.parse(row.createdAt);
        return !Number.isNaN(rowCreatedAtMs) && rowCreatedAtMs >= turnStartedAtMs;
      });
    }

    if (firstCurrentTurnRowIndex < 0) {
      firstCurrentTurnRowIndex = rows.findIndex(
        (row) => row.kind === "message" && row.message.streaming,
      );
    }

    if (firstCurrentTurnRowIndex < 0) return firstTailRowIndex;

    for (let index = firstCurrentTurnRowIndex - 1; index >= 0; index -= 1) {
      const previousRow = rows[index];
      if (!previousRow || previousRow.kind !== "message") continue;
      if (previousRow.message.role === "user") {
        return Math.min(index, firstTailRowIndex);
      }
      if (previousRow.message.role === "assistant" && !previousRow.message.streaming) {
        break;
      }
    }

    return Math.min(firstCurrentTurnRowIndex, firstTailRowIndex);
  }, [activeTurnInProgress, activeTurnStartedAt, rows]);

  const virtualizedRowCount = clamp(firstUnvirtualizedRowIndex, {
    minimum: 0,
    maximum: rows.length,
  });
  const virtualMeasurementScopeKey =
    timelineWidthPx === null ? "width:unknown" : `width:${Math.round(timelineWidthPx)}`;

  const latestTurnId =
    latestTurnIdProp !== undefined
      ? latestTurnIdProp
      : deriveLatestChangedFilesTurnId(rows, turnDiffSummaryByAssistantMessageId);
  const changedFilesExpandedByTurnId = useUiStateStore(
    (state) => state.threadChangedFilesExpandedById[threadId],
  );
  const isChangedFilesExpanded = (summary: TurnDiffSummary) =>
    changedFilesExpandedByTurnId?.[summary.turnId] ??
    shouldAutoExpandChangedFiles(summary.files, summary.turnId === latestTurnId);

  const rowVirtualizer = useTimelineRowVirtualizer({
    count: virtualizedRowCount,
    scrollContainer,
    timelineWidthPx,
    pinnedRowIndex: findFirstConversationMessageRowIndex(rows),
    // Scope cached row measurements to the current timeline width so offscreen
    // rows do not keep stale heights after wrapping changes.
    getItemKey: (index: number) => {
      const rowId = rows[index]?.id ?? String(index);
      return `${virtualMeasurementScopeKey}:${rowId}`;
    },
    estimateSize: (index: number) => {
      const row = rows[index];
      if (!row) return 96;
      return estimateMessagesTimelineRowHeight(row, {
        expandedWorkGroups,
        timelineWidthPx,
        turnDiffSummaryByAssistantMessageId,
        isChangedFilesExpanded,
      });
    },
  });
  const measureRows = rowVirtualizer.measure;
  const pendingMeasureFrameRef = useRef<number | null>(null);
  const onTimelineImageLoad = useCallback(() => {
    if (pendingMeasureFrameRef.current !== null) return;
    pendingMeasureFrameRef.current = window.requestAnimationFrame(() => {
      pendingMeasureFrameRef.current = null;
      measureRows();
    });
  }, [measureRows]);
  useEffect(() => {
    return () => {
      const frame = pendingMeasureFrameRef.current;
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, []);
  const readVirtualLayout = rowVirtualizer.readLayout;
  useLayoutEffect(() => {
    if (!onVirtualizerSnapshot) {
      return;
    }
    const layout = readVirtualLayout();
    onVirtualizerSnapshot({
      totalSize: layout.totalSize,
      measurements: layout.measurements.slice(0, virtualizedRowCount).flatMap((measurement) => {
        const row = rows[measurement.index];
        if (!row) {
          return [];
        }
        return [
          {
            id: row.id,
            kind: row.kind,
            index: measurement.index,
            size: measurement.size,
            start: measurement.start,
            end: measurement.end,
          },
        ];
      }),
    });
  }, [onVirtualizerSnapshot, readVirtualLayout, rows, virtualizedRowCount]);

  // Lets ChatView's thread-switch scroll restore reach an anchor row outside the rendered
  // window through the virtualizer, since rows above it only have estimated heights.
  const scrollRowToStart = useStableCallback((rowId: string): TimelineRowScrollResult => {
    const index = rows.findIndex((row) => row.id === rowId);
    if (index < 0) return "missing";
    if (index < virtualizedRowCount) {
      rowVirtualizer.scrollToIndex(index, { align: "start" });
      return "scrolled";
    }
    return "not-virtualized";
  });
  useTimelineRowScroller(threadId, scrollRowToStart);

  // A find opened on an empty thread has no bar to show; it must not pop up with the first message.
  useEffect(() => {
    if (hasMessages) return;
    return () => closeThreadFind(threadId);
  }, [hasMessages, threadId]);

  const virtualRowsContainerRef = useRef<HTMLDivElement | null>(null);
  const minimapItems = useMemo(() => deriveTimelineMinimapItems(rows), [rows]);
  const resolveMinimapItemBounds = useStableCallback(
    (item: TimelineMinimapItem): TimelineMinimapItemBounds | null => {
      if (item.rowIndex < virtualizedRowCount) {
        const container = virtualRowsContainerRef.current;
        const measurement = readVirtualLayout().measurements[item.rowIndex];
        if (!container || !measurement) return null;
        return {
          top: container.getBoundingClientRect().top + measurement.start,
          height: measurement.size,
        };
      }
      const element = timelineRootRef.current?.querySelector(
        `[data-timeline-row-id="${CSS.escape(item.id)}"]`,
      );
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { top: rect.top, height: rect.height };
    },
  );
  const minimapSettleFrameRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (minimapSettleFrameRef.current !== null) {
        window.cancelAnimationFrame(minimapSettleFrameRef.current);
      }
    },
    [],
  );
  const scrollToMinimapItem = useStableCallback((item: TimelineMinimapItem) => {
    if (!scrollContainer) return;
    onManualNavigation?.();
    // Returns true once the row's rendered top sits the jump offset below the viewport top.
    const alignRow = () => {
      const element = timelineRootRef.current?.querySelector(
        `[data-timeline-row-id="${CSS.escape(item.id)}"]`,
      );
      const top = element
        ? element.getBoundingClientRect().top
        : resolveMinimapItemBounds(item)?.top;
      if (top === undefined) return true;
      const delta =
        top - scrollContainer.getBoundingClientRect().top - TIMELINE_MINIMAP_JUMP_TOP_OFFSET_PX;
      if (Math.abs(delta) < 1) return true;
      const previousScrollTop = scrollContainer.scrollTop;
      scrollContainer.scrollTo({ top: previousScrollTop + delta });
      return Math.abs(scrollContainer.scrollTop - previousScrollTop) < 1;
    };
    if (minimapSettleFrameRef.current !== null) {
      window.cancelAnimationFrame(minimapSettleFrameRef.current);
      minimapSettleFrameRef.current = null;
    }
    if (alignRow()) return;
    // Virtual rows render and get measured after the jump, which can move the target; settle on it.
    // One aligned frame is not enough, as rows measured a frame later still shift it.
    let remainingFrames = MINIMAP_SETTLE_MAX_FRAMES;
    let alignedFrames = 0;
    const settle = () => {
      minimapSettleFrameRef.current = null;
      remainingFrames -= 1;
      alignedFrames = alignRow() ? alignedFrames + 1 : 0;
      if (alignedFrames >= MINIMAP_SETTLE_ALIGNED_FRAMES || remainingFrames <= 0) return;
      minimapSettleFrameRef.current = window.requestAnimationFrame(settle);
    };
    minimapSettleFrameRef.current = window.requestAnimationFrame(settle);
  });

  const virtualRows = rowVirtualizer.virtualItems;
  const nonVirtualizedRows = rows.slice(virtualizedRowCount);
  const [allDirectoriesExpandedByTurnId, setAllDirectoriesExpandedByTurnId] = useState<
    Record<string, boolean>
  >({});
  // The shown value is passed in, since the default depends on the turn's auto-expand decision.
  const onToggleAllDirectories = useCallback((turnId: TurnId, currentlyExpanded: boolean) => {
    setAllDirectoriesExpandedByTurnId((current) => ({
      ...current,
      [turnId]: !(current[turnId] ?? currentlyExpanded),
    }));
  }, []);

  const expandedToolRowsRef = useRef(new Set<string>());
  const isToolRowExpanded = useCallback(
    (rowKey: string) => expandedToolRowsRef.current.has(rowKey),
    [],
  );
  const setToolRowExpanded = useCallback((rowKey: string, expanded: boolean) => {
    if (expanded) expandedToolRowsRef.current.add(rowKey);
    else expandedToolRowsRef.current.delete(rowKey);
  }, []);

  // Parent callbacks may change identity on every streaming chunk; keep the row context stable.
  const stableOnImageExpand = useStableCallback(onImageExpand);
  const stableOnToggleWorkGroup = useStableCallback(onToggleWorkGroup);
  const stableOnOpenTurnDiff = useStableCallback(onOpenTurnDiff);
  const stableOnOpenToolDiff = useStableCallback((toolId: string, stream: ToolInputStream) =>
    onOpenToolDiff?.(toolId, stream),
  );
  const hasOpenToolDiff = onOpenToolDiff !== undefined;
  const stableOnRevertUserMessage = useStableCallback(onRevertUserMessage);
  const stableOnRunShellCommand = useStableCallback(onRunShellCommand ?? NOOP_RUN_SHELL_COMMAND);
  const hasRunShellCommand = onRunShellCommand !== undefined;
  const sharedRowState = useMemo<TimelineRowSharedState>(
    () => ({
      threadId,
      timestampFormat,
      markdownCwd,
      workspaceRoot,
      resolvedTheme,
      onImageExpand: stableOnImageExpand,
      onToggleWorkGroup: stableOnToggleWorkGroup,
      onOpenTurnDiff: stableOnOpenTurnDiff,
      onOpenToolDiff: hasOpenToolDiff ? stableOnOpenToolDiff : undefined,
      onRevertUserMessage: stableOnRevertUserMessage,
      onTimelineImageLoad,
      onToggleAllDirectories,
      onRunShellCommand: hasRunShellCommand ? stableOnRunShellCommand : undefined,
      assistantLabel,
      isToolRowExpanded,
      setToolRowExpanded,
    }),
    [
      assistantLabel,
      hasRunShellCommand,
      hasOpenToolDiff,
      stableOnOpenToolDiff,
      isToolRowExpanded,
      markdownCwd,
      onTimelineImageLoad,
      onToggleAllDirectories,
      resolvedTheme,
      setToolRowExpanded,
      stableOnImageExpand,
      stableOnOpenTurnDiff,
      stableOnRevertUserMessage,
      stableOnRunShellCommand,
      stableOnToggleWorkGroup,
      threadId,
      timestampFormat,
      workspaceRoot,
    ],
  );
  const rowActivityState = useMemo<TimelineRowActivityState>(
    () => ({ isWorking, isRevertingCheckpoint, latestTurnId, activeTurnId }),
    [activeTurnId, isRevertingCheckpoint, isWorking, latestTurnId],
  );

  // Rows are memoized on their own data; everything else reaches them through
  // context so a streaming chunk or tool preview only re-renders the affected row.
  const renderRowContent = (row: TimelineRow) => {
    const standaloneWorkEntry =
      row.kind === "work" ? resolveStandalonePreviewWorkEntry(row.groupedEntries) : null;
    const turnSummary =
      row.kind === "message" && row.message.role === "assistant"
        ? resolveMessageRowTurnDiffSummary(row, turnDiffSummaryByAssistantMessageId)
        : undefined;
    return (
      <TimelineRowContent
        row={row}
        isWorkGroupExpanded={row.kind === "work" ? (expandedWorkGroups[row.id] ?? false) : false}
        livePreview={
          standaloneWorkEntry?.providerItemId
            ? toolInputPreviews[standaloneWorkEntry.providerItemId]
            : undefined
        }
        liveCommandOutput={
          // A stopped turn can leave its command in progress with the last output still stored.
          standaloneWorkEntry && isWorkEntryLive(standaloneWorkEntry, isWorking, activeTurnId)
            ? findLiveCommandOutput([standaloneWorkEntry], toolInputPreviews)
            : undefined
        }
        canRevertAgentWork={
          row.kind === "message" &&
          row.message.role === "user" &&
          revertTurnCountByUserMessageId.has(row.message.id)
        }
        turnSummary={turnSummary}
        allDirectoriesExpanded={
          turnSummary
            ? (allDirectoriesExpandedByTurnId[turnSummary.turnId] ??
              // A large card expanded by hand opens with its folders collapsed.
              shouldAutoExpandChangedFiles(turnSummary.files, turnSummary.turnId === latestTurnId))
            : true
        }
        completionSummary={
          row.kind === "message" && row.showCompletionDivider ? completionSummary : null
        }
      />
    );
  };

  if (!hasMessages) {
    return null;
  }

  return (
    <TimelineRowCtx.Provider value={sharedRowState}>
      <TimelineRowActivityCtx.Provider value={rowActivityState}>
        <div
          ref={setTimelineRoot}
          data-timeline-root="true"
          className="mx-auto w-full min-w-0 max-w-(--chat-max-width) overflow-x-clip"
        >
          {virtualizedRowCount > 0 && (
            <div
              ref={virtualRowsContainerRef}
              className="relative"
              style={{ height: `${rowVirtualizer.totalSize}px` }}
            >
              {virtualRows.map((virtualRow: VirtualItem) => {
                const row = rows[virtualRow.index];
                if (!row) return null;

                return (
                  <div
                    key={`virtual-row:${row.id}`}
                    data-index={virtualRow.index}
                    data-virtual-row-id={row.id}
                    data-virtual-row-kind={row.kind}
                    data-virtual-row-size={virtualRow.size}
                    data-virtual-row-start={virtualRow.start}
                    ref={rowVirtualizer.measureElement}
                    className="absolute left-0 w-full"
                    // `top` rather than a transform: a transformed row breaks the sticky changed-files header.
                    style={{ top: `${virtualRow.start}px` }}
                  >
                    {renderRowContent(row)}
                  </div>
                );
              })}
            </div>
          )}

          {nonVirtualizedRows.map((row) => (
            <div key={`non-virtual-row:${row.id}`}>{renderRowContent(row)}</div>
          ))}
        </div>
        <MessagesTimelineMinimap
          scrollContainer={scrollContainer}
          contentElement={timelineRootElement}
          items={minimapItems}
          resolveItemBounds={resolveMinimapItemBounds}
          onSelect={scrollToMinimapItem}
          onLeaveBottom={onManualNavigation}
        />
        <ThreadFind
          threadId={threadId}
          rows={rows}
          searchRowsInput={unfoldedRowsInput}
          onExpandFold={stableOnToggleWorkGroup}
          timelineRoot={timelineRootElement}
          scrollContainer={scrollContainer}
          scrollRowIntoWindow={scrollRowToStart}
          onNavigate={onManualNavigation}
          onClose={onThreadFindClose}
          markdownCwd={markdownCwd}
        />
      </TimelineRowActivityCtx.Provider>
    </TimelineRowCtx.Provider>
  );
});

/** The turn of the last assistant reply with changed files, unless a newer user message started another turn. */
export function deriveLatestChangedFilesTurnId(
  rows: ReadonlyArray<MessagesTimelineRow>,
  turnDiffSummaryByAssistantMessageId: ReadonlyMap<MessageId, TurnDiffSummary>,
): TurnId | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row?.kind !== "message") continue;
    if (row.message.role === "user") return null;
    const summary = resolveMessageRowTurnDiffSummary(row, turnDiffSummaryByAssistantMessageId);
    if (summary) return summary.turnId;
  }
  return null;
}

type TimelineWorkEntry = Extract<MessagesTimelineRow, { kind: "work" }>["groupedEntries"][number];
type TimelineRow = MessagesTimelineRow;

interface TimelineRowContentProps {
  row: TimelineRow;
  isWorkGroupExpanded: boolean;
  livePreview: ToolInputStream | undefined;
  liveCommandOutput: ToolInputStream | undefined;
  canRevertAgentWork: boolean;
  turnSummary: TurnDiffSummary | undefined;
  allDirectoriesExpanded: boolean;
  completionSummary: string | null;
}

function resolveStandalonePreviewWorkEntry(
  groupedEntries: ReadonlyArray<TimelineWorkEntry>,
): TimelineWorkEntry | null {
  const [onlyEntry] = groupedEntries;
  if (groupedEntries.length !== 1 || onlyEntry === undefined) return null;
  // A failed or stopped Edit or Bash falls through to the compact row, which shows its marker.
  return isPreviewEligibleWorkEntry(onlyEntry) &&
    !isFailedWorkLogToolStatus(onlyEntry.toolStatus) &&
    onlyEntry.toolStatus !== "stopped"
    ? onlyEntry
    : null;
}

/**
 * Work entries are re-derived from activities on every activity event, so compare their fields
 * (arrays and nested records one level deep) instead of object identity.
 */
export function areWorkEntriesEquivalent(
  previous: TimelineWorkEntry,
  next: TimelineWorkEntry,
): boolean {
  if (previous === next) return true;
  return areShallowRecordsEqual(previous, next, areWorkEntryFieldsEqual);
}

function areWorkEntryFieldsEqual(previous: unknown, next: unknown): boolean {
  if (Object.is(previous, next)) return true;
  if (Array.isArray(previous) && Array.isArray(next)) {
    return (
      previous.length === next.length &&
      previous.every((value, index) => Object.is(value, next[index]))
    );
  }
  if (isPlainRecord(previous) && isPlainRecord(next)) {
    return areShallowRecordsEqual(previous, next, Object.is);
  }
  return false;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function areShallowRecordsEqual(
  previous: object,
  next: object,
  isEqual: (previous: unknown, next: unknown) => boolean,
): boolean {
  const previousRecord = previous as Record<string, unknown>;
  const nextRecord = next as Record<string, unknown>;
  const previousKeys = Object.keys(previousRecord);
  if (previousKeys.length !== Object.keys(nextRecord).length) return false;
  return previousKeys.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(nextRecord, key) &&
      isEqual(previousRecord[key], nextRecord[key]),
  );
}

function areOptionalIdListsEqual(
  previous: ReadonlyArray<string> | undefined,
  next: ReadonlyArray<string> | undefined,
): boolean {
  if (previous === undefined || next === undefined) return previous === next;
  return previous.length === next.length && previous.every((value, index) => value === next[index]);
}

/** Rows are rebuilt on every timeline change, so compare the data they wrap instead of identity. */
export function areTimelineRowsEquivalent(previous: TimelineRow, next: TimelineRow): boolean {
  if (previous === next) return true;
  if (previous.id !== next.id || previous.createdAt !== next.createdAt) return false;
  if (previous.kind === "message" && next.kind === "message") {
    return (
      previous.message === next.message &&
      previous.durationStart === next.durationStart &&
      previous.showCompletionDivider === next.showCompletionDivider &&
      previous.modelSwitchLabel === next.modelSwitchLabel &&
      areOptionalIdListsEqual(previous.absorbedMessageIds, next.absorbedMessageIds)
    );
  }
  if (previous.kind === "work" && next.kind === "work") {
    return (
      previous.hasFailure === next.hasFailure &&
      previous.groupedEntries.length === next.groupedEntries.length &&
      previous.groupedEntries.every((entry, index) => {
        const nextEntry = next.groupedEntries[index];
        return nextEntry !== undefined && areWorkEntriesEquivalent(entry, nextEntry);
      })
    );
  }
  if (previous.kind === "proposed-plan" && next.kind === "proposed-plan") {
    return previous.proposedPlan === next.proposedPlan;
  }
  if (previous.kind === "hidden-work" && next.kind === "hidden-work") {
    if (previous.latestEntry === null || next.latestEntry === null) {
      return previous.latestEntry === next.latestEntry;
    }
    return areWorkEntriesEquivalent(previous.latestEntry, next.latestEntry);
  }
  if (previous.kind === "turn-fold" && next.kind === "turn-fold") {
    return previous.label === next.label && previous.expanded === next.expanded;
  }
  return false;
}

function areTimelineRowContentPropsEqual(
  previous: TimelineRowContentProps,
  next: TimelineRowContentProps,
): boolean {
  return (
    areTimelineRowsEquivalent(previous.row, next.row) &&
    previous.isWorkGroupExpanded === next.isWorkGroupExpanded &&
    previous.livePreview === next.livePreview &&
    previous.liveCommandOutput === next.liveCommandOutput &&
    previous.canRevertAgentWork === next.canRevertAgentWork &&
    previous.turnSummary === next.turnSummary &&
    previous.allDirectoriesExpanded === next.allDirectoriesExpanded &&
    previous.completionSummary === next.completionSummary
  );
}

const TimelineRowContent = memo(function TimelineRowContent(props: TimelineRowContentProps) {
  const { row } = props;
  const isQaCard = row.kind === "message" && row.message.text.startsWith("[qa-card]\n");
  const isRestartNotice =
    row.kind === "message" &&
    row.message.role === "user" &&
    isRestartContinuationMessageId(row.message.id);
  return (
    <div
      className="pb-4"
      data-timeline-row-id={row.id}
      data-timeline-row-kind={row.kind}
      data-message-id={row.kind === "message" ? row.message.id : undefined}
      data-message-role={row.kind === "message" ? row.message.role : undefined}
    >
      {row.kind === "work" && (
        <WorkGroupRow
          row={row}
          isExpanded={props.isWorkGroupExpanded}
          livePreview={props.livePreview}
          liveCommandOutput={props.liveCommandOutput}
        />
      )}

      {isRestartNotice && <RestartNoticeRow />}

      {row.kind === "message" && row.message.role === "user" && !isRestartNotice && isQaCard && (
        <QaCardRow text={row.message.text} />
      )}

      {row.kind === "message" && row.message.role === "user" && !isRestartNotice && !isQaCard && (
        <UserMessageRow row={row} canRevertAgentWork={props.canRevertAgentWork} />
      )}

      {row.kind === "message" && row.message.role === "assistant" && (
        <AssistantMessageRow
          row={row}
          turnSummary={props.turnSummary}
          allDirectoriesExpanded={props.allDirectoriesExpanded}
          completionSummary={props.completionSummary}
        />
      )}

      {row.kind === "proposed-plan" && <ProposedPlanRow row={row} />}

      {row.kind === "hidden-work" && <HiddenWorkRow row={row} />}

      {row.kind === "turn-fold" && <TimelineTurnFoldRow row={row} />}
    </div>
  );
}, areTimelineRowContentPropsEqual);

function TimelineTurnFoldRow({ row }: { row: Extract<TimelineRow, { kind: "turn-fold" }> }) {
  const { onToggleWorkGroup } = useTimelineRowContext();
  return <TurnFoldRow row={row} onToggle={onToggleWorkGroup} />;
}

/** One entry inside a work group: a thinking block gets its own disclosure row. */
function WorkGroupEntryRow({
  workEntry,
  workspaceRoot,
}: {
  workEntry: TimelineWorkEntry;
  workspaceRoot: string | undefined;
}) {
  const { timestampFormat, isToolRowExpanded, setToolRowExpanded } = useTimelineRowContext();
  const { isWorking, activeTurnId } = use(TimelineRowActivityCtx);
  if (isThoughtWorkEntry(workEntry)) {
    // Lifecycle updates replace the entry id, and with it the row's key.
    const expansionKey = workEntry.providerItemId ?? workEntry.id;
    return (
      <ThoughtWorkEntryRow
        key={expansionKey}
        workEntry={workEntry}
        defaultExpanded={isToolRowExpanded(expansionKey)}
        onExpandedChange={(expanded) => setToolRowExpanded(expansionKey, expanded)}
        turnRunning={isWorkEntryInRunningTurn(workEntry, isWorking, activeTurnId)}
        timestamp={
          <TimelineRowTimestamp createdAt={workEntry.createdAt} timestampFormat={timestampFormat} />
        }
      />
    );
  }
  return (
    <SimpleWorkEntryRow
      workEntry={workEntry}
      showPreviewArea={false}
      workspaceRoot={workspaceRoot}
    />
  );
}

function WorkGroupRow({
  row,
  isExpanded,
  livePreview,
  liveCommandOutput,
}: {
  row: Extract<TimelineRow, { kind: "work" }>;
  isExpanded: boolean;
  livePreview: ToolInputStream | undefined;
  liveCommandOutput: ToolInputStream | undefined;
}) {
  const { onToggleWorkGroup, workspaceRoot } = useTimelineRowContext();
  const { isWorking, activeTurnId } = use(TimelineRowActivityCtx);
  const groupId = row.id;
  const groupedEntries = row.groupedEntries;
  // Preview-eligible single-entry rows render flush in the timeline
  // (no parent card, no group header) so the diff panel reads as
  // its own first-class block of content.
  const standaloneWorkEntry = resolveStandalonePreviewWorkEntry(groupedEntries);
  if (standaloneWorkEntry) {
    if (isWorkEntryLive(standaloneWorkEntry, isWorking, activeTurnId)) {
      return liveCommandOutput ? (
        <LiveCommandOutput
          stream={liveCommandOutput}
          command={
            withVisibleControlCharacters(fullToolCommand(standaloneWorkEntry) ?? "") || undefined
          }
        />
      ) : null;
    }
    // Without a preview (a Codex command or file_change) the compact row still shows what ran, and
    // so does a call its stopped turn left in progress.
    const previewToShow = standaloneWorkEntry.inProgress
      ? standaloneWorkEntry.staticPreview
      : (livePreview ?? standaloneWorkEntry.staticPreview);
    return (
      <SimpleWorkEntryRow
        key={`work-row:${standaloneWorkEntry.id}`}
        workEntry={standaloneWorkEntry}
        livePreview={previewToShow}
        showPreviewArea
        workspaceRoot={workspaceRoot}
      />
    );
  }
  if (shouldSummarizeWorkGroup(groupedEntries)) {
    return <WorkGroupSummaryRow row={row} isExpanded={isExpanded} />;
  }
  const hasOverflow = groupedEntries.length > MAX_VISIBLE_WORK_LOG_ENTRIES;
  const visibleEntries =
    hasOverflow && !isExpanded
      ? groupedEntries.slice(-MAX_VISIBLE_WORK_LOG_ENTRIES)
      : groupedEntries;
  const hiddenCount = groupedEntries.length - visibleEntries.length;
  const onlyToolEntries = groupedEntries.every(
    (entry) => entry.tone === "tool" || entry.tone === "thinking",
  );
  const showHeader = hasOverflow || !onlyToolEntries;
  const groupLabel = onlyToolEntries ? "Tool calls" : "Work log";
  // hasFailure knows about a retry the visibility mode hid; the helper only sees these rows.
  const hiddenEntriesFailed =
    row.hasFailure &&
    hiddenWorkLogEntriesIndicateFailure(groupedEntries.slice(0, hiddenCount), visibleEntries);

  return (
    <div className="rounded-xl border border-border/45 bg-card/25 px-2 py-1.5">
      {showHeader && (
        <div className="mb-1.5 flex items-center justify-between gap-2 px-0.5">
          <p
            className={cn(
              "text-[9px] uppercase tracking-[0.16em] text-muted-foreground/55",
              row.hasFailure && FAILED_WORK_TEXT_CLASS,
            )}
          >
            {groupLabel} ({groupedEntries.length})
          </p>
          {hasOverflow && (
            <button
              type="button"
              className={cn(
                "text-[9px] uppercase tracking-[0.12em] text-muted-foreground/55 transition-colors duration-150 hover:text-foreground/75",
                hiddenEntriesFailed && FAILED_WORK_TEXT_CLASS,
              )}
              onClick={() => onToggleWorkGroup(groupId)}
            >
              {isExpanded ? "Show less" : `Show ${hiddenCount} more`}
            </button>
          )}
        </div>
      )}
      <div className="space-y-0.5">
        {visibleEntries.map((workEntry) => (
          <WorkGroupEntryRow
            key={`work-row:${workEntry.id}`}
            workEntry={workEntry}
            workspaceRoot={workspaceRoot}
          />
        ))}
      </div>
    </div>
  );
}

function toolGroupSummaryIcon(soleAction: ToolGroupSummary["soleAction"]): LucideIcon {
  switch (soleAction) {
    case "read":
      return EyeIcon;
    case "code-search":
      return SearchIcon;
    case "web-search":
      return GlobeIcon;
    case "edit":
      return SquarePenIcon;
    case "command":
      return TerminalIcon;
    default:
      return ZapIcon;
  }
}

/** A group of tool calls as one line, which names the current call while one is running. */
function WorkGroupSummaryRow({
  row,
  isExpanded,
}: {
  row: Extract<TimelineRow, { kind: "work" }>;
  isExpanded: boolean;
}) {
  const { onToggleWorkGroup, timestampFormat, workspaceRoot } = useTimelineRowContext();
  // A turn that stopped mid-call leaves its last entry in progress, so it needs a running turn too.
  const { isWorking, activeTurnId } = use(TimelineRowActivityCtx);
  const entries = row.groupedEntries;
  const liveEntry = resolveLiveWorkGroupEntry(entries, isWorking, activeTurnId);
  const streamingThought = resolveStreamingWorkGroupThought(entries, isWorking, activeTurnId);
  const summary = summarizeToolGroup(entries);
  const summaryText = summary.failureNote
    ? `${summary.label} · ${summary.failureNote}`
    : summary.label;
  const showFailure = row.hasFailure && !liveEntry;
  const SummaryIcon = liveEntry
    ? workEntryIcon(liveEntry)
    : showFailure
      ? XCircleIcon
      : toolGroupSummaryIcon(summary.soleAction);
  const latestEntry = entries.at(-1);
  return (
    <div data-tool-group-summary={isExpanded ? "expanded" : "collapsed"}>
      <div className="group/timeline-row relative flex items-center gap-2 rounded-lg px-1 py-1">
        <button
          type="button"
          aria-expanded={isExpanded}
          data-tool-group-toggle
          title={summaryText}
          onClick={() => onToggleWorkGroup(row.id)}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-sm text-left outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <span
            className={cn(
              "flex size-5 shrink-0 items-center justify-center text-foreground/80",
              showFailure && FAILED_WORK_TEXT_CLASS,
            )}
            {...(showFailure ? { role: "img", "aria-label": "Failed" } : {})}
          >
            <SummaryIcon className="size-3" />
          </span>
          <span className="min-w-0 flex-1 overflow-hidden">
            {liveEntry ? (
              <ShimmerText className="block truncate text-sm">
                {withVisibleControlCharacters(workEntryLabelText(liveEntry, workspaceRoot))}
              </ShimmerText>
            ) : (
              <span
                className={cn(
                  "block truncate text-sm",
                  showFailure ? FAILED_WORK_TEXT_CLASS : workToneClass("tool"),
                )}
              >
                {summaryText}
              </span>
            )}
          </span>
          <ChevronRightIcon
            aria-hidden="true"
            className={cn(
              "size-3 shrink-0 text-muted-foreground/50 transition-transform",
              isExpanded && "rotate-90",
            )}
          />
        </button>
        {latestEntry && (
          <TimelineRowTimestamp
            createdAt={latestEntry.createdAt}
            timestampFormat={timestampFormat}
          />
        )}
      </div>
      {isExpanded ? (
        <ExpandedWorkGroupEntries
          entries={entries}
          startAtEnd={liveEntry !== null}
          workspaceRoot={workspaceRoot}
        />
      ) : (
        <>
          {resolvePinnedWorkGroupEntries(entries).map((workEntry) => (
            <SimpleWorkEntryRow
              key={`work-row:${workEntry.id}`}
              workEntry={workEntry}
              showPreviewArea={false}
              workspaceRoot={workspaceRoot}
            />
          ))}
          {streamingThought && (
            <WorkGroupEntryRow
              key={`work-row:${streamingThought.id}`}
              workEntry={streamingThought}
              workspaceRoot={workspaceRoot}
            />
          )}
        </>
      )}
    </div>
  );
}

function ExpandedWorkGroupEntries({
  entries,
  startAtEnd,
  workspaceRoot,
}: {
  entries: ReadonlyArray<TimelineWorkEntry>;
  startAtEnd: boolean;
  workspaceRoot: string | undefined;
}) {
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const [initialStartAtEnd] = useState(startAtEnd);
  const wasAtEndRef = useRef(false);
  const previousCountRef = useRef(entries.length);
  useLayoutEffect(() => {
    const scrollArea = scrollAreaRef.current;
    if (!scrollArea) return;
    if (initialStartAtEnd) scrollArea.scrollTop = scrollArea.scrollHeight;
    wasAtEndRef.current = isWorkGroupScrolledToEnd(scrollArea);
  }, [initialStartAtEnd]);
  const entryCount = entries.length;
  useLayoutEffect(() => {
    const scrollArea = scrollAreaRef.current;
    const previousCount = previousCountRef.current;
    previousCountRef.current = entryCount;
    if (
      scrollArea &&
      shouldFollowWorkGroupAppend({
        previousCount,
        nextCount: entryCount,
        wasAtEnd: wasAtEndRef.current,
      })
    ) {
      scrollArea.scrollTop = scrollArea.scrollHeight;
    }
  }, [entryCount]);
  // ChatView reads an upward wheel or touch as leaving the bottom, but this scroll stays in here.
  const keepUpwardScrollInside = (event: {
    target: EventTarget;
    currentTarget: HTMLDivElement;
    stopPropagation: () => void;
  }) => {
    if (
      event.target instanceof Element &&
      workGroupConsumesUpwardScroll(event.target, event.currentTarget)
    ) {
      event.stopPropagation();
    }
  };
  return (
    <div className="mt-1 rounded-xl border border-border/45 bg-card/25 px-2 py-1.5">
      <div
        ref={scrollAreaRef}
        role="region"
        aria-label="Tool calls"
        tabIndex={0}
        data-tool-group-scroll
        className="max-h-[min(18rem,50dvh)] space-y-0.5 overflow-x-hidden overflow-y-auto rounded-md outline-none focus-visible:ring-1 focus-visible:ring-ring"
        onScroll={(event) => {
          wasAtEndRef.current = isWorkGroupScrolledToEnd(event.currentTarget);
        }}
        onTouchMove={keepUpwardScrollInside}
        onWheel={(event) => {
          if (event.deltaY < 0) keepUpwardScrollInside(event);
        }}
      >
        {entries.map((workEntry) => (
          <WorkGroupEntryRow
            key={`work-row:${workEntry.id}`}
            workEntry={workEntry}
            workspaceRoot={workspaceRoot}
          />
        ))}
      </div>
    </div>
  );
}

function HiddenWorkRow({ row }: { row: Extract<TimelineRow, { kind: "hidden-work" }> }) {
  const { workspaceRoot } = useTimelineRowContext();
  const EntryIcon = row.latestEntry ? workEntryIcon(row.latestEntry) : workToneIcon("tool").icon;
  // A thought's label is its raw text, which these modes hide on purpose.
  const labelText =
    row.latestEntry && !isThoughtWorkEntry(row.latestEntry)
      ? withVisibleControlCharacters(workEntryLabelText(row.latestEntry, workspaceRoot))
      : null;
  return (
    <div className="flex items-center gap-2 px-1 py-1">
      <span className="flex size-5 shrink-0 items-center justify-center text-foreground/80">
        <EntryIcon className="size-3" />
      </span>
      <div className="min-w-0 flex-1 overflow-hidden" title={labelText ?? undefined}>
        <ShimmerText className="block truncate text-sm">
          {labelText === null ? "Working" : `Working: ${labelText}`}
        </ShimmerText>
      </div>
    </div>
  );
}

/** Stands in for the prompt Pied Piper sent itself to continue a turn after a restart. */
function RestartNoticeRow() {
  return (
    <p
      data-restart-continuation-notice
      className="px-1 py-0.5 text-center text-xs text-muted-foreground"
    >
      {RESTART_CONTINUATION_NOTICE}
    </p>
  );
}

function QaCardRow({ text }: { text: string }) {
  const lines = text.slice("[qa-card]\n".length).split("\n");
  return (
    <div className="flex items-start gap-2.5 rounded-xl border border-border/30 bg-secondary/50 px-4 py-3">
      <CircleHelpIcon className="mt-0.5 size-5 shrink-0 text-foreground/60" />
      <div className="min-w-0 flex-1" data-thread-find-text>
        {lines.map((line) => {
          const [question, answer] = line.split("\t");
          return (
            <div key={line} className="[&+&]:mt-2 [&+&]:border-t [&+&]:border-border/20 [&+&]:pt-2">
              <p className="text-[13px] text-muted-foreground/70">{question}</p>
              <p className="text-[13px] font-medium text-foreground/80">{answer}</p>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function UserMessageRow({
  row,
  canRevertAgentWork,
}: {
  row: Extract<TimelineRow, { kind: "message" }>;
  canRevertAgentWork: boolean;
}) {
  const { markdownCwd, timestampFormat } = useTimelineRowContext();
  // A dependency on the day boundary, so "today" labels become "yesterday" after midnight.
  const dayStartMs = useLocalDayStart();
  const { images: userImages, files: userFiles } = partitionMessageAttachments(
    row.message.attachments ?? [],
  );
  const displayedUserMessage = deriveUserMessageWithReviewComments(row.message.text);
  const terminalContexts = displayedUserMessage.contexts;
  const { reviewComments } = displayedUserMessage;
  const hasTextBody =
    displayedUserMessage.visibleText.trim().length > 0 || terminalContexts.length > 0;
  // A message holding only diff comments has nothing to put in a bubble.
  const showBubble =
    hasTextBody || userImages.length > 0 || userFiles.length > 0 || reviewComments.length === 0;
  return (
    <div className="group flex flex-col items-end gap-1">
      {row.modelSwitchLabel && (
        <div data-model-switch-divider className="mb-2 flex w-full items-center gap-3">
          <span className="h-px flex-1 bg-border" />
          <span className="text-[10px] text-muted-foreground/70">{row.modelSwitchLabel}</span>
          <span className="h-px flex-1 bg-border" />
        </div>
      )}
      <MessageAuthorHeading label="You" />
      {showBubble && (
        <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-secondary px-4 py-3">
          {userImages.length > 0 && (
            <MessageImageAttachments
              images={userImages}
              // An image-only bubble has nothing below the grid to space from.
              className={cn((hasTextBody || userFiles.length > 0) && "mb-2")}
            />
          )}
          {userFiles.length > 0 && (
            <div
              className={cn(
                "flex max-w-[420px] flex-col items-start gap-1.5",
                hasTextBody && "mb-2",
              )}
            >
              {userFiles.map((file) => (
                <div
                  key={file.id}
                  data-user-file-attachment
                  title={file.name}
                  className="flex h-8 max-w-full items-center gap-1.5 rounded-lg border border-border/80 bg-background/70 px-2 text-[11px] text-muted-foreground"
                >
                  <FileTextIcon aria-hidden="true" className="size-3.5 shrink-0" />
                  <span className="min-w-0 truncate">{file.name}</span>
                  <span className="shrink-0 text-muted-foreground/60">
                    {formatDiagnosticsBytes(file.sizeBytes)}
                  </span>
                </div>
              ))}
            </div>
          )}
          {hasTextBody && (
            <CollapsibleUserMessageBody
              text={displayedUserMessage.visibleText}
              terminalContexts={terminalContexts}
              markdownCwd={markdownCwd}
            />
          )}
        </div>
      )}
      <UserMessageReviewComments comments={reviewComments} className="max-w-[80%]" />
      <div className="flex items-center gap-2 px-1">
        {isUsageLimitResumeMessageId(row.message.id) && (
          <p data-usage-limit-resume-label className="text-[10px] text-muted-foreground/40">
            Sent by Pied Piper
          </p>
        )}
        <div className="flex items-center gap-2 opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover:opacity-100">
          <p className="text-[10px] text-muted-foreground/40">
            {formatDayAwareTimestamp(row.message.createdAt, timestampFormat, dayStartMs)}
          </p>
          <div className="flex items-center gap-1.5">
            {displayedUserMessage.copyText && (
              <MessageCopyButton
                text={displayedUserMessage.copyText}
                rewriteCodexDirectives={false}
              />
            )}
            {canRevertAgentWork && <RevertUserMessageButton messageId={row.message.id} />}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Level of the per-message author heading; markdown headings in a reply nest below it. */
const MESSAGE_HEADING_LEVEL = 3;

/** Screen-reader-only author heading so assistive tech can jump between messages. */
function MessageAuthorHeading({ label }: { label: string }) {
  return <h3 className="sr-only select-none">{label}</h3>;
}

/**
 * Hover- or focus-revealed time with a full-date tooltip. The parent carries `group/timeline-row`
 * and `relative`; while hidden the time is absolutely positioned so it never takes row space.
 * Work rows hold no other focusable control, so the time itself is a tab stop.
 */
function TimelineRowTimestamp({
  createdAt,
  timestampFormat,
  className,
}: {
  createdAt: string;
  timestampFormat: TimestampFormat;
  className?: string;
}) {
  const dayStartMs = useLocalDayStart();
  const label = formatDayAwareTimestamp(createdAt, timestampFormat, dayStartMs);
  if (!label) return null;
  const fullLabel = formatTimelineRowTimestampTooltip(createdAt, timestampFormat);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            data-timeline-row-timestamp
            tabIndex={0}
            aria-label={fullLabel}
            className={cn(
              "pointer-events-none absolute right-1 shrink-0 rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-ring whitespace-nowrap text-[10px] tabular-nums text-muted-foreground/50 opacity-0 group-hover/timeline-row:pointer-events-auto group-hover/timeline-row:static group-hover/timeline-row:opacity-100 group-focus-within/timeline-row:pointer-events-auto group-focus-within/timeline-row:static group-focus-within/timeline-row:opacity-100",
              className,
            )}
          />
        }
      >
        {label}
      </TooltipTrigger>
      <TooltipPopup>{fullLabel}</TooltipPopup>
    </Tooltip>
  );
}

function MessageImageAttachments({
  images,
  className,
}: {
  images: ReadonlyArray<ChatImageAttachment>;
  className?: string;
}) {
  const { onImageExpand, onTimelineImageLoad } = useTimelineRowContext();
  // A lone image keeps its own shape instead of a half-width crop.
  const singleImage = images.length === 1;
  return (
    <div className={cn("max-w-[420px]", !singleImage && "grid grid-cols-2 gap-2", className)}>
      {images.map((image) => (
        <div
          key={image.id}
          className={cn(
            "overflow-hidden rounded-lg border border-border/80 bg-background/70",
            singleImage && "w-fit max-w-full",
          )}
        >
          {image.previewUrl ? (
            <button
              type="button"
              className={cn("cursor-zoom-in", singleImage ? "block max-w-full" : "h-full w-full")}
              aria-label={`Preview ${image.name}`}
              onClick={() => {
                const preview = buildExpandedImagePreview(images, image.id);
                if (!preview) return;
                onImageExpand(preview);
              }}
            >
              <img
                src={image.previewUrl}
                alt={image.name}
                decoding="async"
                className={cn(
                  "transform-gpu object-cover",
                  singleImage
                    ? "block h-48 w-auto min-w-24 max-w-full"
                    : "h-full max-h-[220px] w-full",
                )}
                onLoad={onTimelineImageLoad}
                onError={onTimelineImageLoad}
              />
            </button>
          ) : (
            <div
              className={cn(
                "flex items-center justify-center px-2 py-3 text-center text-[11px] text-muted-foreground/70",
                singleImage ? "h-48 w-64 max-w-full" : "min-h-[72px]",
              )}
            >
              {image.name}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function RevertUserMessageButton({ messageId }: { messageId: MessageId }) {
  const { onRevertUserMessage } = useTimelineRowContext();
  const { isRevertingCheckpoint, isWorking } = use(TimelineRowActivityCtx);
  return (
    <button
      type="button"
      disabled={isRevertingCheckpoint || isWorking}
      onClick={() => onRevertUserMessage(messageId)}
      title="Edit from here"
      className="flex cursor-pointer items-center justify-center text-muted-foreground/40 transition-colors hover:text-foreground/70 disabled:cursor-not-allowed disabled:opacity-50"
    >
      <Undo2Icon className="size-3" />
    </button>
  );
}

function AssistantMessageRow({
  row,
  turnSummary,
  allDirectoriesExpanded,
  completionSummary,
}: {
  row: Extract<TimelineRow, { kind: "message" }>;
  turnSummary: TurnDiffSummary | undefined;
  allDirectoriesExpanded: boolean;
  completionSummary: string | null;
}) {
  const { assistantLabel, markdownCwd, onRunShellCommand, threadId, timestampFormat } =
    useTimelineRowContext();
  const dayStartMs = useLocalDayStart();
  const { images: messageImages } = partitionMessageAttachments(row.message.attachments ?? []);
  const messageText = row.message.text || (row.message.streaming ? "" : "(empty response)");
  // An image-only reply is not an empty one.
  const showMessageText = row.message.text.length > 0 || messageImages.length === 0;
  const checkpointFiles = turnSummary?.files ?? [];
  return (
    <div className="group">
      {row.showCompletionDivider && (
        <div className="my-3 flex items-center gap-3">
          <span className="h-px flex-1 bg-border" />
          <span className="rounded-full border border-border bg-background px-2.5 py-1 text-[10px] uppercase tracking-[0.14em] text-muted-foreground/80">
            {completionSummary ? `Response • ${completionSummary}` : "Response"}
          </span>
          <span className="h-px flex-1 bg-border" />
        </div>
      )}
      <div>
        <div className="min-w-0 flex-1 px-1 py-0.5">
          <MessageAuthorHeading label={assistantLabel} />
          {showMessageText && (
            <div data-thread-find-text>
              <ChatMarkdown
                text={messageText}
                cwd={markdownCwd}
                threadId={threadId}
                isStreaming={Boolean(row.message.streaming)}
                headingLevelOffset={MESSAGE_HEADING_LEVEL}
                onRunShellCommand={onRunShellCommand}
                lineBreaks={shouldPreserveAssistantLineBreaks(messageText)}
              />
            </div>
          )}
          {messageImages.length > 0 && (
            <MessageImageAttachments
              images={messageImages}
              className={cn(showMessageText && "mt-2")}
            />
          )}
          {turnSummary && checkpointFiles.length > 0 && (
            <ChangedFilesCard
              turnSummary={turnSummary}
              allDirectoriesExpanded={allDirectoriesExpanded}
            />
          )}
          <div className="mt-1.5 flex items-center gap-2 opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover:opacity-100">
            {row.message.text.trim().length > 0 && <MessageCopyButton text={row.message.text} />}
            <p className="text-[10px] text-muted-foreground/40">
              {row.message.streaming ? (
                <LiveMessageMeta
                  createdAt={row.message.createdAt}
                  durationStart={row.durationStart}
                  timestampFormat={timestampFormat}
                />
              ) : (
                formatMessageMeta(
                  row.message.createdAt,
                  formatElapsed(row.durationStart, row.message.completedAt),
                  timestampFormat,
                  dayStartMs,
                )
              )}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function findScrollParent(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === "auto" || overflowY === "scroll") return node;
  }
  return null;
}

/**
 * Runs a header action that can shrink the card. When the sticky header was stuck to the top,
 * the shrunk card would leave it above the viewport, so scroll it back to where it was clicked.
 */
function keepStuckHeaderInPlace(header: HTMLElement | null, action: () => void): void {
  const topBefore = header?.getBoundingClientRect().top;
  flushSync(action);
  if (!header || topBefore === undefined || !header.isConnected) return;
  const delta = header.getBoundingClientRect().top - topBefore;
  if (delta > -0.5) return;
  const scrollParent = findScrollParent(header);
  if (scrollParent) scrollParent.scrollTop += delta;
}

/** Changed files for one turn; the expanded state is remembered per thread and turn. */
function ChangedFilesCard({
  turnSummary,
  allDirectoriesExpanded,
}: {
  turnSummary: TurnDiffSummary;
  allDirectoriesExpanded: boolean;
}) {
  const { threadId, onOpenTurnDiff, onToggleAllDirectories, resolvedTheme, workspaceRoot } =
    useTimelineRowContext();
  const { latestTurnId } = use(TimelineRowActivityCtx);
  const { turnId, files } = turnSummary;
  const expanded = useUiStateStore((state) =>
    resolveThreadChangedFilesExpanded(
      state,
      threadId,
      turnId,
      shouldAutoExpandChangedFiles(files, turnId === latestTurnId),
    ),
  );
  const headerRef = useRef<HTMLDivElement | null>(null);
  const toggleExpanded = () =>
    keepStuckHeaderInPlace(headerRef.current, () =>
      useUiStateStore.getState().setThreadChangedFilesExpanded(threadId, turnId, !expanded),
    );
  const totals = checkpointFileTotals(turnSummary);
  return (
    <div
      className="mt-2 rounded-lg border border-border/80 bg-card/45 p-2.5"
      data-changed-files-state={expanded ? "expanded" : "collapsed"}
    >
      <div
        ref={headerRef}
        data-changed-files-header
        className={cn(
          "flex items-center justify-between gap-2",
          expanded &&
            "sticky top-2 z-10 mb-1.5 bg-[color-mix(in_srgb,var(--card)_45%,var(--background))] before:absolute before:inset-x-0 before:-top-2 before:h-2 before:bg-[color-mix(in_srgb,var(--card)_45%,var(--background))] before:content-['']",
        )}
      >
        <button
          type="button"
          aria-expanded={expanded}
          data-scroll-anchor-ignore
          onClick={toggleExpanded}
          className="flex min-w-0 items-center gap-1 text-left text-[10px] uppercase tracking-[0.12em] text-muted-foreground/65 transition-colors hover:text-foreground/80"
        >
          <ChevronRightIcon
            aria-hidden="true"
            className={cn("size-3 shrink-0 transition-transform", expanded && "rotate-90")}
          />
          <span>Changed files ({totals.count.toLocaleString()})</span>
          {hasNonZeroStat(totals) && (
            <>
              <span className="mx-1">•</span>
              <DiffStatLabel additions={totals.additions} deletions={totals.deletions} />
            </>
          )}
        </button>
        <div className="flex items-center gap-1.5">
          {expanded && (
            <Button
              type="button"
              size="xs"
              variant="outline"
              data-scroll-anchor-ignore
              onClick={() =>
                keepStuckHeaderInPlace(headerRef.current, () =>
                  onToggleAllDirectories(turnId, allDirectoriesExpanded),
                )
              }
            >
              {allDirectoriesExpanded ? "Collapse all" : "Expand all"}
            </Button>
          )}
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => onOpenTurnDiff(turnId, files[0]?.path)}
          >
            View diff
          </Button>
        </div>
      </div>
      {expanded ? (
        <>
          <ChangedFilesTree
            key={`changed-files-tree:${turnId}`}
            turnId={turnId}
            files={files}
            allDirectoriesExpanded={allDirectoriesExpanded}
            resolvedTheme={resolvedTheme}
            onOpenTurnDiff={onOpenTurnDiff}
            workspaceRoot={workspaceRoot}
          />
          <ChangedFilesMoreButton
            hiddenFileCount={totals.hiddenFileCount}
            onClick={() => onOpenTurnDiff(turnId, files[0]?.path)}
          />
        </>
      ) : (
        <ChangedFilesCompactSummary
          files={files}
          totalFileCount={totals.count}
          capped={totals.hiddenFileCount > 0}
          onExpand={toggleExpanded}
        />
      )}
    </div>
  );
}

function ChangedFilesCompactSummary({
  files,
  totalFileCount,
  capped,
  onExpand,
}: {
  files: TurnDiffSummary["files"];
  totalFileCount: number;
  /** `files` is only a prefix, so per-scope counts would understate the turn. */
  capped: boolean;
  onExpand: () => void;
}) {
  const scopes = summarizeChangedFileScopes(files);
  const previewFiles = selectChangedFilePreview(files);
  const hiddenFileCount = totalFileCount - previewFiles.length;
  return (
    <button
      type="button"
      data-changed-files-summary
      data-scroll-anchor-ignore
      aria-expanded={false}
      aria-label={`Show ${totalFileCount} changed files`}
      onClick={onExpand}
      className="mt-1.5 flex w-full flex-col gap-1 rounded-md px-1 py-1 text-left transition-colors hover:bg-accent/40"
    >
      <span className="flex flex-wrap items-center gap-1">
        {scopes.map((scope) => (
          <span
            key={scope.label}
            className="rounded-md border border-border/55 bg-background/75 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground/75"
          >
            {capped ? scope.label : `${scope.label} · ${scope.fileCount}`}
          </span>
        ))}
      </span>
      <span className="truncate font-mono text-[11px] text-muted-foreground/70">
        {previewFiles.map((file) => changedFileName(file.path)).join(", ")}
        {hiddenFileCount > 0 && ` +${hiddenFileCount.toLocaleString()} more`}
      </span>
    </button>
  );
}

function ProposedPlanRow({ row }: { row: Extract<TimelineRow, { kind: "proposed-plan" }> }) {
  const { markdownCwd, workspaceRoot, threadId } = useTimelineRowContext();
  return (
    <div className="min-w-0 px-1 py-0.5" data-thread-find-text>
      <ProposedPlanCard
        planMarkdown={row.proposedPlan.planMarkdown}
        cwd={markdownCwd}
        workspaceRoot={workspaceRoot}
        threadId={threadId}
      />
    </div>
  );
}

/**
 * Live timestamp + elapsed duration for a streaming assistant message. Updates
 * its own text node every second so the timer never causes a React commit.
 */
function LiveMessageMeta({
  createdAt,
  durationStart,
  timestampFormat,
}: {
  createdAt: string;
  durationStart: string;
  timestampFormat: TimestampFormat;
}) {
  const textRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const updateText = () => {
      if (textRef.current) {
        textRef.current.textContent = formatLiveMessageMetaNow(
          createdAt,
          durationStart,
          timestampFormat,
        );
      }
    };
    updateText();
    const id = window.setInterval(updateText, 1000);
    return () => window.clearInterval(id);
  }, [createdAt, durationStart, timestampFormat]);
  return (
    <span ref={textRef}>{formatLiveMessageMetaNow(createdAt, durationStart, timestampFormat)}</span>
  );
}

export function formatLiveMessageMetaNow(
  createdAt: string,
  durationStart: string,
  timestampFormat: TimestampFormat,
  nowIso: string = new Date().toISOString(),
): string {
  const nowMs = Date.parse(nowIso);
  return formatMessageMeta(
    createdAt,
    formatElapsed(durationStart, nowIso),
    timestampFormat,
    Number.isNaN(nowMs) ? undefined : nowMs,
  );
}

export function formatMessageMeta(
  createdAt: string,
  duration: string | null,
  timestampFormat: TimestampFormat,
  nowMs?: number,
): string {
  const timestamp = formatDayAwareTimestamp(createdAt, timestampFormat, nowMs);
  if (!duration) return timestamp;
  return `${timestamp} • ${duration}`;
}

const UserMessageTerminalContextInlineLabel = memo(
  function UserMessageTerminalContextInlineLabel(props: { context: ParsedTerminalContextEntry }) {
    const tooltipText =
      props.context.body.length > 0
        ? `${props.context.header}\n${props.context.body}`
        : props.context.header;

    return (
      <span data-thread-find-ignore>
        <TerminalContextInlineChip label={props.context.header} tooltipText={tooltipText} />
      </span>
    );
  },
);

const COLLAPSED_USER_MESSAGE_FADE_MASK =
  "linear-gradient(to bottom, black calc(100% - 1.75rem), transparent)";

const CollapsibleUserMessageBody = memo(function CollapsibleUserMessageBody(props: {
  text: string;
  terminalContexts: ParsedTerminalContextEntry[];
  markdownCwd: string | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  // The text heuristic is the first guess; the measured content decides whether anything is clipped.
  const [overflows, setOverflows] = useState(true);
  const contentRef = useRef<HTMLDivElement>(null);
  const clipRef = useRef<HTMLDivElement>(null);
  const canCollapse = shouldCollapseUserMessage(props.text) && overflows;
  const isCollapsed = canCollapse && !expanded;
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const measure = () => {
      setOverflows(content.scrollHeight > COLLAPSED_USER_MESSAGE_MAX_HEIGHT_PX + 1);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const clip = clipRef.current;
    if (!clip) return;
    const reveal = () => setExpanded(true);
    clip.addEventListener(THREAD_FIND_REVEAL_EVENT, reveal);
    return () => clip.removeEventListener(THREAD_FIND_REVEAL_EVENT, reveal);
  }, []);
  return (
    <>
      <div
        ref={clipRef}
        className={cn(isCollapsed && "max-h-44 overflow-hidden")}
        data-thread-find-fold={isCollapsed ? "" : undefined}
        data-user-message-body="true"
        data-user-message-collapsible={canCollapse ? "true" : "false"}
        data-user-message-collapsed={isCollapsed ? "true" : "false"}
        style={
          isCollapsed
            ? {
                WebkitMaskImage: COLLAPSED_USER_MESSAGE_FADE_MASK,
                maskImage: COLLAPSED_USER_MESSAGE_FADE_MASK,
              }
            : undefined
        }
      >
        <div ref={contentRef} data-thread-find-text>
          <UserMessageBody
            text={props.text}
            terminalContexts={props.terminalContexts}
            markdownCwd={props.markdownCwd}
          />
        </div>
      </div>
      {canCollapse && (
        <div className="mt-1.5 flex">
          <Button
            type="button"
            size="xs"
            variant="ghost"
            aria-expanded={expanded}
            data-scroll-anchor-ignore
            onClick={() => setExpanded((value) => !value)}
            className="-ml-1.5 h-6 px-1.5 text-xs text-muted-foreground/70 hover:text-foreground/85 sm:h-6"
          >
            {expanded ? "Show less" : "Show full message"}
          </Button>
        </div>
      )}
    </>
  );
});

/** Text as typed, around chips and for a paste too long to parse as markdown. */
const USER_MESSAGE_PLAIN_TEXT_CLASS =
  "wrap-break-word whitespace-pre-wrap text-sm leading-relaxed text-foreground";

/** Deeply nested input can overflow the parser's stack, and a stored message would then throw on every open. */
class UserMessageMarkdownBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { hasError: boolean }
> {
  override state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  override render() {
    return this.state.hasError ? this.props.fallback : this.props.children;
  }
}

function UserMessageMarkdown(props: { text: string; markdownCwd: string | undefined }) {
  const { threadId } = useTimelineRowContext();
  return (
    <UserMessageMarkdownBoundary
      fallback={<span className={USER_MESSAGE_PLAIN_TEXT_CLASS}>{props.text}</span>}
    >
      <ChatMarkdown
        text={props.text}
        cwd={props.markdownCwd}
        threadId={threadId}
        headingLevelOffset={MESSAGE_HEADING_LEVEL}
        variant="user"
      />
    </UserMessageMarkdownBoundary>
  );
}

const UserMessageBody = memo(function UserMessageBody(props: {
  text: string;
  terminalContexts: ParsedTerminalContextEntry[];
  markdownCwd: string | undefined;
}) {
  const renderAsMarkdown = shouldRenderUserMessageAsMarkdown(props.text);
  const renderInlineSegment = (text: string, key: string) => {
    if (!renderAsMarkdown) return <span key={key}>{text}</span>;
    const { leading, content, trailing } = splitInlineSegmentWhitespace(text);
    return (
      <Fragment key={key}>
        {leading && <span aria-hidden="true">{leading}</span>}
        {content && <UserMessageMarkdown text={content} markdownCwd={props.markdownCwd} />}
        {trailing && <span aria-hidden="true">{trailing}</span>}
      </Fragment>
    );
  };
  // The markdown is block level, so its edge paragraphs must flow inline to sit beside a chip. Two
  // inline paragraphs would run together, so the first ends in a block the height of their gap.
  const inlineContainerClass = cn(
    USER_MESSAGE_PLAIN_TEXT_CLASS,
    "[&_.chat-markdown]:inline [&_.chat-markdown]:whitespace-normal [&_.chat-markdown]:text-foreground [&_.chat-markdown>p:first-child]:inline [&_.chat-markdown>p:last-child]:inline [&_.chat-markdown>p:first-child:not(:last-child)]:after:block [&_.chat-markdown>p:first-child:not(:last-child)]:after:h-[0.65rem]",
  );

  if (props.terminalContexts.length > 0) {
    const hasEmbeddedInlineLabels = textContainsInlineTerminalContextLabels(
      props.text,
      props.terminalContexts,
    );
    const inlinePrefix = buildInlineTerminalContextText(props.terminalContexts);
    const inlineNodes: ReactNode[] = [];

    if (hasEmbeddedInlineLabels) {
      let cursor = 0;

      for (const context of props.terminalContexts) {
        const label = formatInlineTerminalContextLabel(context.header);
        const matchIndex = props.text.indexOf(label, cursor);
        if (matchIndex === -1) {
          inlineNodes.length = 0;
          break;
        }
        if (matchIndex > cursor) {
          inlineNodes.push(
            renderInlineSegment(
              props.text.slice(cursor, matchIndex),
              `user-terminal-context-inline-before:${context.header}:${cursor}`,
            ),
          );
        }
        inlineNodes.push(
          <UserMessageTerminalContextInlineLabel
            key={`user-terminal-context-inline:${context.header}`}
            context={context}
          />,
        );
        cursor = matchIndex + label.length;
      }

      if (inlineNodes.length > 0) {
        if (cursor < props.text.length) {
          inlineNodes.push(
            renderInlineSegment(
              props.text.slice(cursor),
              `user-message-terminal-context-inline-rest:${cursor}`,
            ),
          );
        }

        return (
          <div dir={textDirection(props.text) ?? "auto"} className={inlineContainerClass}>
            {inlineNodes}
          </div>
        );
      }
    }

    for (const context of props.terminalContexts) {
      inlineNodes.push(
        <UserMessageTerminalContextInlineLabel
          key={`user-terminal-context-inline:${context.header}`}
          context={context}
        />,
      );
      inlineNodes.push(
        <span key={`user-terminal-context-inline-space:${context.header}`} aria-hidden="true">
          {" "}
        </span>,
      );
    }

    if (props.text.length > 0) {
      inlineNodes.push(
        renderInlineSegment(props.text, "user-message-terminal-context-inline-text"),
      );
    } else if (inlinePrefix.length === 0) {
      return null;
    }

    return (
      <div dir={textDirection(props.text) ?? "auto"} className={inlineContainerClass}>
        {inlineNodes}
      </div>
    );
  }

  if (props.text.length === 0) {
    return null;
  }

  if (!renderAsMarkdown) {
    return (
      <div dir={textDirection(props.text) ?? "auto"} className={USER_MESSAGE_PLAIN_TEXT_CLASS}>
        {props.text}
      </div>
    );
  }

  return (
    <div className="wrap-break-word [&_.chat-markdown]:text-foreground">
      <UserMessageMarkdown text={props.text} markdownCwd={props.markdownCwd} />
    </div>
  );
});

function workToneIcon(tone: TimelineWorkEntry["tone"]): {
  icon: LucideIcon;
  className: string;
} {
  if (tone === "error") {
    return {
      icon: CircleAlertIcon,
      className: "text-foreground/92",
    };
  }
  if (tone === "thinking") {
    return {
      icon: BotIcon,
      className: "text-foreground/92",
    };
  }
  if (tone === "info") {
    return {
      icon: CheckIcon,
      className: "text-foreground/92",
    };
  }
  return {
    icon: ZapIcon,
    className: "text-foreground/92",
  };
}

const FAILED_WORK_TEXT_CLASS = "text-rose-600/80 dark:text-rose-300/50";

function workToneClass(tone: "thinking" | "tool" | "info" | "error"): string {
  if (tone === "error") return FAILED_WORK_TEXT_CLASS;
  if (tone === "tool") return "text-muted-foreground/70";
  if (tone === "thinking") return "text-muted-foreground/50";
  return "text-muted-foreground/40";
}

function workEntryPreview(
  workEntry: Pick<TimelineWorkEntry, "detail" | "command" | "changedFiles">,
) {
  if (workEntry.command) return workEntry.command;
  if (workEntry.detail) return workEntry.detail;
  if ((workEntry.changedFiles?.length ?? 0) === 0) return null;
  const [firstPath] = workEntry.changedFiles ?? [];
  if (!firstPath) return null;
  return workEntry.changedFiles!.length === 1
    ? firstPath
    : `${firstPath} +${workEntry.changedFiles!.length - 1} more`;
}

function workEntryRawCommand(
  workEntry: Pick<TimelineWorkEntry, "command" | "rawCommand">,
): string | null {
  const rawCommand = workEntry.rawCommand?.trim();
  if (!rawCommand || !workEntry.command) return null;
  return rawCommand === workEntry.command.trim() ? null : rawCommand;
}

function workEntryIcon(workEntry: TimelineWorkEntry): LucideIcon {
  if (isFailedWorkLogToolStatus(workEntry.toolStatus)) return XCircleIcon;
  if (workEntry.isContextCompaction && workEntry.inProgress) return LoaderIcon;
  if (workEntry.requestKind === "command") return TerminalIcon;
  if (workEntry.requestKind === "file-read") return EyeIcon;
  if (workEntry.requestKind === "file-change") return SquarePenIcon;

  if (workEntry.itemType === "command_execution" || workEntry.command) {
    return TerminalIcon;
  }
  if (workEntry.itemType === "file_change" || (workEntry.changedFiles?.length ?? 0) > 0) {
    return SquarePenIcon;
  }
  if (workEntry.itemType === "web_search") return GlobeIcon;
  if (workEntry.itemType === "image_view") return EyeIcon;

  switch (workEntry.itemType) {
    case "mcp_tool_call":
      return WrenchIcon;
    case "dynamic_tool_call":
    case "collab_agent_tool_call":
      return HammerIcon;
  }

  return workToneIcon(workEntry.tone).icon;
}

function capitalizePhrase(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return value;
  }
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
}

function toolWorkEntryHeading(workEntry: TimelineWorkEntry): string {
  if (!workEntry.toolTitle) {
    return capitalizePhrase(normalizeCompactToolLabel(workEntry.label));
  }
  return capitalizePhrase(normalizeCompactToolLabel(workEntry.toolTitle));
}

function workEntryFallbackLabelText(workEntry: TimelineWorkEntry): string {
  const heading = toolWorkEntryHeading(workEntry);
  const preview = workEntryPreview(workEntry);
  return preview && !workEntryPreviewDuplicatesHeading(heading, preview)
    ? `${heading} - ${preview}`
    : heading;
}

function workEntryLabelText(workEntry: TimelineWorkEntry, workspaceRoot: string | undefined) {
  return (
    buildFriendlyToolText({ workEntry, workspaceRoot }) ?? workEntryFallbackLabelText(workEntry)
  );
}

const SimpleWorkEntryRow = memo(function SimpleWorkEntryRow(props: {
  workEntry: TimelineWorkEntry;
  livePreview?: ToolInputStream | undefined;
  showPreviewArea?: boolean;
  workspaceRoot?: string | undefined;
}) {
  const { workEntry, livePreview, showPreviewArea = false, workspaceRoot } = props;
  const { timestampFormat, isToolRowExpanded, setToolRowExpanded, onOpenToolDiff } =
    useTimelineRowContext();
  const { isWorking, activeTurnId } = use(TimelineRowActivityCtx);
  // Lifecycle updates replace the entry id, and with it the row's key.
  const expansionKey = workEntry.providerItemId ?? workEntry.id;
  const [isExpanded, setIsExpanded] = useState(() => isToolRowExpanded(expansionKey));
  const EntryIcon = workEntryIcon(workEntry);

  // For streaming-eligible tools we render the diff-style preview panel
  // ONLY once we actually have content to show. Until then we fall through
  // to the compact text row with a friendly "Creating /foo.ts" / "Editing
  // /foo.ts" line and a shimmer.
  const hasPreviewContent =
    livePreview !== undefined &&
    (livePreview.text.length > 0 || (livePreview.oldString?.length ?? 0) > 0);
  if (showPreviewArea && hasPreviewContent) {
    const isStatic = livePreview === workEntry.staticPreview;
    return (
      <ToolInputCodePreview
        stream={livePreview}
        defaultCollapsed={isStatic}
        onOpenDiff={onOpenToolDiff ? () => onOpenToolDiff(expansionKey, livePreview) : undefined}
      />
    );
  }

  const friendlyText = buildFriendlyToolText({ workEntry, workspaceRoot });
  const labelText = friendlyText ?? workEntryFallbackLabelText(workEntry);
  // A compaction can run outside a turn; anything else left open by a stopped turn is not running.
  const isInProgress = workEntry.isContextCompaction
    ? workEntry.inProgress === true
    : isWorkEntryLive(workEntry, isWorking, activeTurnId);
  const failureLabel =
    workEntry.toolStatus === "failed"
      ? "Failed"
      : workEntry.toolStatus === "declined"
        ? "Declined"
        : null;
  const rowTitle = withVisibleControlCharacters(workEntryRawCommand(workEntry) ?? labelText, {
    keepLineBreaks: true,
  });
  const hasChangedFiles = (workEntry.changedFiles?.length ?? 0) > 0;
  const previewIsChangedFiles = hasChangedFiles && !workEntry.command && !workEntry.detail;
  const visibleLabelText = withVisibleControlCharacters(labelText);
  const expandedBody = buildToolCallExpandedBody(workEntry, labelText);
  const showExpandedBody = expandedBody !== null && isExpanded;
  const toggleExpanded = () => {
    setToolRowExpanded(expansionKey, !isExpanded);
    setIsExpanded(!isExpanded);
  };
  const rowHeader = (
    <>
      <span
        className={cn(
          "flex size-5 shrink-0 items-center justify-center text-foreground/80",
          failureLabel && FAILED_WORK_TEXT_CLASS,
        )}
        {...(failureLabel ? { role: "img", "aria-label": failureLabel } : {})}
      >
        <EntryIcon
          className={cn("size-3", workEntry.isContextCompaction && isInProgress && "animate-spin")}
        />
      </span>
      <div className="min-w-0 flex-1 overflow-hidden" title={rowTitle}>
        {isInProgress ? (
          <ShimmerText className="block truncate text-sm">{visibleLabelText}</ShimmerText>
        ) : (
          <p
            className={cn(
              "truncate text-sm text-foreground/85",
              failureLabel ? FAILED_WORK_TEXT_CLASS : workToneClass(workEntry.tone),
            )}
          >
            {visibleLabelText}
          </p>
        )}
      </div>
      {workEntry.toolStatus === "stopped" && (
        <span className="shrink-0 text-[11px] text-muted-foreground/60">Stopped</span>
      )}
    </>
  );

  return (
    <div className="rounded-lg px-1 py-1">
      <div className="group/timeline-row relative flex items-center gap-2">
        {expandedBody ? (
          <div
            role="button"
            tabIndex={0}
            aria-expanded={isExpanded}
            data-tool-row-toggle
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
            onClick={() => {
              // Finishing a text selection on the label is not a click on the row.
              if (window.getSelection()?.isCollapsed === false) return;
              toggleExpanded();
            }}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget) return;
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              toggleExpanded();
            }}
          >
            {rowHeader}
            <ChevronRightIcon
              aria-hidden="true"
              className={cn(
                "size-3 shrink-0 text-muted-foreground/50 transition-transform",
                isExpanded && "rotate-90",
              )}
            />
          </div>
        ) : (
          rowHeader
        )}
        <TimelineRowTimestamp createdAt={workEntry.createdAt} timestampFormat={timestampFormat} />
      </div>
      {showExpandedBody ? (
        <ToolCallExpandedPanel
          body={expandedBody}
          workspaceRoot={workspaceRoot}
          onOpenDiff={
            onOpenToolDiff && expandedBody.preview
              ? () => onOpenToolDiff(expansionKey, expandedBody.preview!)
              : undefined
          }
        />
      ) : (
        hasChangedFiles &&
        !previewIsChangedFiles &&
        !friendlyText && (
          <div className="mt-1 flex flex-wrap gap-1 pl-6">
            {workEntry.changedFiles?.slice(0, 4).map((filePath) => (
              <span
                key={`${workEntry.id}:${filePath}`}
                className="rounded-md border border-border/55 bg-background/75 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground/75"
                title={withVisibleControlCharacters(filePath)}
              >
                {withVisibleControlCharacters(filePath)}
              </span>
            ))}
            {(workEntry.changedFiles?.length ?? 0) > 4 && (
              <span className="px-1 text-[10px] text-muted-foreground/55">
                +{(workEntry.changedFiles?.length ?? 0) - 4}
              </span>
            )}
          </div>
        )
      )}
    </div>
  );
});

function ToolCallExpandedSection(props: { label: string; children: string }) {
  return (
    <div>
      <p className="mb-0.5 text-[10px] uppercase tracking-[0.12em] text-muted-foreground/55">
        {props.label}
      </p>
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap wrap-break-word font-mono text-[length:var(--font-size-code,0.6875rem)] leading-relaxed text-foreground/80">
        {props.children}
      </pre>
    </div>
  );
}

/** Outside the row's toggle, so selecting text here never collapses it. */
function ToolCallExpandedPanel({
  body,
  workspaceRoot,
  onOpenDiff,
}: {
  body: ToolCallExpandedBody;
  workspaceRoot: string | undefined;
  onOpenDiff?: (() => void) | undefined;
}) {
  return (
    <div
      data-tool-row-body
      className="mt-1 ml-6 space-y-2 rounded-md border border-border/45 bg-background/60 px-2 py-1.5 select-text"
    >
      {body.command && (
        <ToolCallExpandedSection label="Command">
          {withVisibleControlCharacters(body.command, { keepLineBreaks: true })}
        </ToolCallExpandedSection>
      )}
      {body.input && (
        <ToolCallExpandedSection label="Input">
          {withVisibleControlCharacters(formatToolInputJson(body.input), { keepLineBreaks: true })}
        </ToolCallExpandedSection>
      )}
      {body.preview && (
        <ToolInputCodePreview
          stream={body.preview}
          defaultCollapsed={false}
          onOpenDiff={onOpenDiff}
        />
      )}
      {body.detail && (
        <ToolCallExpandedSection label="Detail">
          {withVisibleControlCharacters(body.detail, { keepLineBreaks: true })}
        </ToolCallExpandedSection>
      )}
      {body.resultSummary && (
        <ToolCallExpandedSection label="Result summary">
          {withVisibleControlCharacters(body.resultSummary, { keepLineBreaks: true })}
        </ToolCallExpandedSection>
      )}
      {body.changedFiles.length > 0 && (
        <ToolCallExpandedSection label="Files">
          {body.changedFiles
            .map((filePath) =>
              withVisibleControlCharacters(formatExpandedToolFilePath(filePath, workspaceRoot)),
            )
            .join("\n")}
        </ToolCallExpandedSection>
      )}
    </div>
  );
}
