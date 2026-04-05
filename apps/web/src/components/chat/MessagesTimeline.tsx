import { type MessageId, type ThreadId, type TurnId } from "@piedpiper/contracts";
import {
  detectAdvisorHandoffs as detectHandoffs,
  stripAdvisorHandoffMarkers,
  type DetectedHandoff,
} from "../../lib/advisorSkills";
import { AdvisorHandoffCard } from "./AdvisorHandoffCard";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  measureElement as measureVirtualElement,
  type VirtualItem,
  useVirtualizer,
} from "@tanstack/react-virtual";
import { deriveTimelineEntries, formatElapsed } from "../../session-logic";

import { AUTO_SCROLL_BOTTOM_THRESHOLD_PX } from "../../chat-scroll";
import { useToolInputPreviews } from "../../storeSelectors";
import { type ToolInputStream, type TurnDiffSummary } from "../../types";
import { ShimmerText } from "./ShimmerText";
import { buildFriendlyToolText } from "./friendlyToolText";
import { ToolInputCodePreview } from "./ToolInputCodePreview";
import { summarizeTurnDiffStats } from "../../lib/turnDiffTree";
import ChatMarkdown from "../ChatMarkdown";
import {
  BotIcon,
  CheckIcon,
  CircleAlertIcon,
  CircleHelpIcon,
  EyeIcon,
  GlobeIcon,
  HammerIcon,
  type LucideIcon,
  SparklesIcon,
  SquarePenIcon,
  TerminalIcon,
  Undo2Icon,
  WrenchIcon,
  ZapIcon,
} from "lucide-react";
import { Button } from "../ui/button";
import { clamp } from "effect/Number";
import { buildExpandedImagePreview, ExpandedImagePreview } from "./ExpandedImagePreview";
import { ProposedPlanCard } from "./ProposedPlanCard";
import { ChangedFilesTree } from "./ChangedFilesTree";
import { DiffStatLabel, hasNonZeroStat } from "./DiffStatLabel";
import { MessageCopyButton } from "./MessageCopyButton";
import {
  MAX_VISIBLE_WORK_LOG_ENTRIES,
  deriveMessagesTimelineRows,
  estimateMessagesTimelineRowHeight,
  isPreviewEligibleWorkEntry,
  normalizeCompactToolLabel,
  type MessagesTimelineRow,
} from "./MessagesTimeline.logic";
import { TerminalContextInlineChip } from "./TerminalContextInlineChip";
import {
  deriveDisplayedUserMessageState,
  type ParsedTerminalContextEntry,
} from "~/lib/terminalContext";
import { cn } from "~/lib/utils";
import { type TimestampFormat } from "@piedpiper/contracts/settings";
import { formatShortTimestamp } from "../../timestampFormat";
import {
  buildInlineTerminalContextText,
  formatInlineTerminalContextLabel,
  textContainsInlineTerminalContextLabels,
} from "./userMessageTerminalContexts";

const ALWAYS_UNVIRTUALIZED_TAIL_ROWS = 8;

interface MessagesTimelineProps {
  threadId: ThreadId;
  hasMessages: boolean;
  isWorking: boolean;
  activeTurnInProgress: boolean;
  activeTurnStartedAt: string | null;
  scrollContainer: HTMLDivElement | null;
  timelineEntries: ReturnType<typeof deriveTimelineEntries>;
  completionDividerBeforeEntryId: string | null;
  completionSummary: string | null;
  turnDiffSummaryByAssistantMessageId: Map<MessageId, TurnDiffSummary>;
  nowIso: string;
  expandedWorkGroups: Record<string, boolean>;
  onToggleWorkGroup: (groupId: string) => void;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  revertTurnCountByUserMessageId: Map<MessageId, number>;
  onRevertUserMessage: (messageId: MessageId) => void;
  isRevertingCheckpoint: boolean;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  markdownCwd: string | undefined;
  resolvedTheme: "light" | "dark";
  timestampFormat: TimestampFormat;
  workspaceRoot: string | undefined;
  /** When true, work-group entries (tool calls, bash scripts) are hidden from
   *  the timeline — used by advisor skill sessions to keep the UX as a clean
   *  question/answer flow. */
  hideWorkEntries?: boolean;
  /** When set, renders an advisor avatar beside every assistant message. */
  advisorAvatarSrc?: string | null | undefined;
  /** Welcome greeting shown as a centered header at the top of advisor chats. */
  advisorGreeting?: string | null | undefined;
  /** Avatar image for the greeting header. */
  advisorGreetingAvatarSrc?: string | null | undefined;
  /** When true, scans assistant messages for advisor slash-command handoffs. */
  enableAdvisorHandoffs?: boolean;
  /** Called when the user clicks "Start" on a handoff card. */
  onStartAdvisorHandoff?: ((handoff: DetectedHandoff) => void) | undefined;
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

export const MessagesTimeline = memo(function MessagesTimeline({
  threadId,
  hasMessages,
  isWorking,
  activeTurnInProgress,
  activeTurnStartedAt,
  scrollContainer,
  timelineEntries,
  completionDividerBeforeEntryId,
  completionSummary,
  turnDiffSummaryByAssistantMessageId,
  nowIso,
  expandedWorkGroups,
  onToggleWorkGroup,
  onOpenTurnDiff,
  revertTurnCountByUserMessageId,
  onRevertUserMessage,
  isRevertingCheckpoint,
  onImageExpand,
  markdownCwd,
  resolvedTheme,
  timestampFormat,
  workspaceRoot,
  hideWorkEntries,
  advisorAvatarSrc,
  advisorGreeting,
  advisorGreetingAvatarSrc,
  enableAdvisorHandoffs,
  onStartAdvisorHandoff,
  onVirtualizerSnapshot,
}: MessagesTimelineProps) {
  const toolInputPreviews = useToolInputPreviews(threadId);
  const timelineRootRef = useRef<HTMLDivElement | null>(null);
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

  const rows = useMemo(
    () =>
      deriveMessagesTimelineRows({
        timelineEntries,
        completionDividerBeforeEntryId,
      }),
    [timelineEntries, completionDividerBeforeEntryId],
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

  const rowVirtualizer = useVirtualizer({
    count: virtualizedRowCount,
    getScrollElement: () => scrollContainer,
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
      });
    },
    measureElement: measureVirtualElement,
    useAnimationFrameWithResizeObserver: true,
    overscan: 8,
  });
  useEffect(() => {
    if (timelineWidthPx === null) return;
    rowVirtualizer.measure();
  }, [rowVirtualizer, timelineWidthPx]);
  useEffect(() => {
    rowVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) => {
      const viewportHeight = instance.scrollRect?.height ?? 0;
      const scrollOffset = instance.scrollOffset ?? 0;
      const itemIntersectsViewport =
        item.end > scrollOffset && item.start < scrollOffset + viewportHeight;
      if (itemIntersectsViewport) {
        return false;
      }
      const remainingDistance = instance.getTotalSize() - (scrollOffset + viewportHeight);
      return remainingDistance > AUTO_SCROLL_BOTTOM_THRESHOLD_PX;
    };
    return () => {
      rowVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = undefined;
    };
  }, [rowVirtualizer]);
  const pendingMeasureFrameRef = useRef<number | null>(null);
  const onTimelineImageLoad = useCallback(() => {
    if (pendingMeasureFrameRef.current !== null) return;
    pendingMeasureFrameRef.current = window.requestAnimationFrame(() => {
      pendingMeasureFrameRef.current = null;
      rowVirtualizer.measure();
    });
  }, [rowVirtualizer]);
  useEffect(() => {
    return () => {
      const frame = pendingMeasureFrameRef.current;
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, []);
  useLayoutEffect(() => {
    if (!onVirtualizerSnapshot) {
      return;
    }
    onVirtualizerSnapshot({
      totalSize: rowVirtualizer.getTotalSize(),
      measurements: rowVirtualizer.measurementsCache
        .slice(0, virtualizedRowCount)
        .flatMap((measurement) => {
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
  }, [onVirtualizerSnapshot, rowVirtualizer, rows, virtualizedRowCount]);

  const virtualRows = rowVirtualizer.getVirtualItems();
  const nonVirtualizedRows = rows.slice(virtualizedRowCount);
  const [allDirectoriesExpandedByTurnId, setAllDirectoriesExpandedByTurnId] = useState<
    Record<string, boolean>
  >({});
  const onToggleAllDirectories = useCallback((turnId: TurnId) => {
    setAllDirectoriesExpandedByTurnId((current) => ({
      ...current,
      [turnId]: !(current[turnId] ?? true),
    }));
  }, []);

  const renderRowContent = (row: TimelineRow) => {
    // In advisor skill sessions, hide all work-group rows (tool calls, work log).
    // User-input answers are acknowledged by the agent in its next response.
    if (row.kind === "work" && hideWorkEntries) return null;

    return (
      <div
        className="pb-4"
        data-timeline-row-id={row.id}
        data-timeline-row-kind={row.kind}
        data-message-id={row.kind === "message" ? row.message.id : undefined}
        data-message-role={row.kind === "message" ? row.message.role : undefined}
      >
        {row.kind === "work" &&
          (() => {
            const groupId = row.id;
            const groupedEntries = row.groupedEntries;
            // Preview-eligible single-entry rows render flush in the timeline
            // (no parent card, no group header) so the diff panel reads as
            // its own first-class block of content.
            const isStandalonePreviewRow =
              groupedEntries.length === 1 &&
              groupedEntries[0] !== undefined &&
              isPreviewEligibleWorkEntry(groupedEntries[0]);
            if (isStandalonePreviewRow) {
              const workEntry = groupedEntries[0]!;
              if (workEntry.inProgress) return null;
              const livePreview = workEntry.providerItemId
                ? toolInputPreviews[workEntry.providerItemId]
                : undefined;
              const previewToShow = livePreview ?? workEntry.staticPreview;
              if (!previewToShow) return null;
              return (
                <SimpleWorkEntryRow
                  key={`work-row:${workEntry.id}`}
                  workEntry={workEntry}
                  livePreview={previewToShow}
                  showPreviewArea
                  workspaceRoot={workspaceRoot}
                />
              );
            }
            const isExpanded = expandedWorkGroups[groupId] ?? false;
            const hasOverflow = groupedEntries.length > MAX_VISIBLE_WORK_LOG_ENTRIES;
            const visibleEntries =
              hasOverflow && !isExpanded
                ? groupedEntries.slice(-MAX_VISIBLE_WORK_LOG_ENTRIES)
                : groupedEntries;
            const hiddenCount = groupedEntries.length - visibleEntries.length;
            const onlyToolEntries = groupedEntries.every((entry) => entry.tone === "tool");
            const showHeader = hasOverflow || !onlyToolEntries;
            const groupLabel = onlyToolEntries ? "Tool calls" : "Work log";

            return (
              <div className="rounded-xl border border-border/45 bg-card/25 px-2 py-1.5">
                {showHeader && (
                  <div className="mb-1.5 flex items-center justify-between gap-2 px-0.5">
                    <p className="text-[9px] uppercase tracking-[0.16em] text-muted-foreground/55">
                      {groupLabel} ({groupedEntries.length})
                    </p>
                    {hasOverflow && (
                      <button
                        type="button"
                        className="text-[9px] uppercase tracking-[0.12em] text-muted-foreground/55 transition-colors duration-150 hover:text-foreground/75"
                        onClick={() => onToggleWorkGroup(groupId)}
                      >
                        {isExpanded ? "Show less" : `Show ${hiddenCount} more`}
                      </button>
                    )}
                  </div>
                )}
                <div className="space-y-0.5">
                  {visibleEntries.map((workEntry) => (
                    <SimpleWorkEntryRow
                      key={`work-row:${workEntry.id}`}
                      workEntry={workEntry}
                      showPreviewArea={false}
                      workspaceRoot={workspaceRoot}
                    />
                  ))}
                </div>
              </div>
            );
          })()}

        {row.kind === "message" &&
          row.message.role === "user" &&
          row.message.text.startsWith("[qa-card]\n") &&
          (() => {
            const lines = row.message.text.slice("[qa-card]\n".length).split("\n");
            return (
              <div className="flex items-start gap-2.5 rounded-xl border border-border/30 bg-secondary/50 px-4 py-3">
                <CircleHelpIcon className="mt-0.5 size-5 shrink-0 text-foreground/60" />
                <div className="min-w-0 flex-1">
                  {lines.map((line) => {
                    const [question, answer] = line.split("\t");
                    return (
                      <div
                        key={line}
                        className="[&+&]:mt-2 [&+&]:border-t [&+&]:border-border/20 [&+&]:pt-2"
                      >
                        <p className="text-[13px] text-muted-foreground/70">{question}</p>
                        <p className="text-[13px] font-medium text-foreground/80">{answer}</p>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })()}

        {row.kind === "message" &&
          row.message.role === "user" &&
          !row.message.text.startsWith("[qa-card]\n") &&
          (() => {
            const userImages = row.message.attachments ?? [];
            const displayedUserMessage = deriveDisplayedUserMessageState(row.message.text);
            const terminalContexts = displayedUserMessage.contexts;
            const canRevertAgentWork = revertTurnCountByUserMessageId.has(row.message.id);
            return (
              <div className="group flex flex-col items-end gap-1">
                <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-secondary px-4 py-3">
                  {userImages.length > 0 && (
                    <div className="mb-2 grid max-w-[420px] grid-cols-2 gap-2">
                      {userImages.map(
                        (image: NonNullable<TimelineMessage["attachments"]>[number]) => (
                          <div
                            key={image.id}
                            className="overflow-hidden rounded-lg border border-border/80 bg-background/70"
                          >
                            {image.previewUrl ? (
                              <button
                                type="button"
                                className="h-full w-full cursor-zoom-in"
                                aria-label={`Preview ${image.name}`}
                                onClick={() => {
                                  const preview = buildExpandedImagePreview(userImages, image.id);
                                  if (!preview) return;
                                  onImageExpand(preview);
                                }}
                              >
                                <img
                                  src={image.previewUrl}
                                  alt={image.name}
                                  className="h-full max-h-[220px] w-full object-cover"
                                  onLoad={onTimelineImageLoad}
                                  onError={onTimelineImageLoad}
                                />
                              </button>
                            ) : (
                              <div className="flex min-h-[72px] items-center justify-center px-2 py-3 text-center text-[11px] text-muted-foreground/70">
                                {image.name}
                              </div>
                            )}
                          </div>
                        ),
                      )}
                    </div>
                  )}
                  {(displayedUserMessage.visibleText.trim().length > 0 ||
                    terminalContexts.length > 0) && (
                    <UserMessageBody
                      text={displayedUserMessage.visibleText}
                      terminalContexts={terminalContexts}
                    />
                  )}
                </div>
                <div className="flex items-center gap-2 px-1 opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover:opacity-100">
                  <p className="text-[10px] text-muted-foreground/40">
                    {formatShortTimestamp(row.message.createdAt, timestampFormat)}
                  </p>
                  <div className="flex items-center gap-1.5">
                    {displayedUserMessage.copyText && (
                      <MessageCopyButton text={displayedUserMessage.copyText} />
                    )}
                    {canRevertAgentWork && (
                      <button
                        type="button"
                        disabled={isRevertingCheckpoint || isWorking}
                        onClick={() => onRevertUserMessage(row.message.id)}
                        title="Revert to this message"
                        className="flex cursor-pointer items-center justify-center text-muted-foreground/40 transition-colors hover:text-foreground/70 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <Undo2Icon className="size-3" />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })()}

        {row.kind === "message" &&
          row.message.role === "assistant" &&
          (() => {
            const messageText =
              row.message.text || (row.message.streaming ? "" : "(empty response)");
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
                <div className={advisorAvatarSrc ? "flex items-start gap-2.5" : ""}>
                  {advisorAvatarSrc && (
                    <img
                      src={advisorAvatarSrc}
                      alt=""
                      draggable={false}
                      className="mt-1 size-6 shrink-0 object-contain"
                    />
                  )}
                  <div className="min-w-0 flex-1 px-1 py-0.5">
                    <ChatMarkdown
                      text={
                        enableAdvisorHandoffs
                          ? stripAdvisorHandoffMarkers(messageText)
                          : messageText
                      }
                      cwd={markdownCwd}
                      isStreaming={Boolean(row.message.streaming)}
                    />
                    {enableAdvisorHandoffs &&
                      onStartAdvisorHandoff &&
                      !row.message.streaming &&
                      (() => {
                        const handoffs = detectHandoffs(messageText);
                        if (handoffs.length === 0) return null;
                        return (
                          <div className="mt-2 space-y-2">
                            {handoffs.map((h) => (
                              <AdvisorHandoffCard
                                key={h.advisorId}
                                handoff={h}
                                onStart={onStartAdvisorHandoff}
                              />
                            ))}
                          </div>
                        );
                      })()}
                    {(() => {
                      const turnSummary = turnDiffSummaryByAssistantMessageId.get(row.message.id);
                      if (!turnSummary) return null;
                      const checkpointFiles = turnSummary.files;
                      if (checkpointFiles.length === 0) return null;
                      const summaryStat = summarizeTurnDiffStats(checkpointFiles);
                      const changedFileCountLabel = String(checkpointFiles.length);
                      const allDirectoriesExpanded =
                        allDirectoriesExpandedByTurnId[turnSummary.turnId] ?? true;
                      return (
                        <div className="mt-2 rounded-lg border border-border/80 bg-card/45 p-2.5">
                          <div className="mb-1.5 flex items-center justify-between gap-2">
                            <p className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground/65">
                              <span>Changed files ({changedFileCountLabel})</span>
                              {hasNonZeroStat(summaryStat) && (
                                <>
                                  <span className="mx-1">•</span>
                                  <DiffStatLabel
                                    additions={summaryStat.additions}
                                    deletions={summaryStat.deletions}
                                  />
                                </>
                              )}
                            </p>
                            <div className="flex items-center gap-1.5">
                              <Button
                                type="button"
                                size="xs"
                                variant="outline"
                                data-scroll-anchor-ignore
                                onClick={() => onToggleAllDirectories(turnSummary.turnId)}
                              >
                                {allDirectoriesExpanded ? "Collapse all" : "Expand all"}
                              </Button>
                              <Button
                                type="button"
                                size="xs"
                                variant="outline"
                                onClick={() =>
                                  onOpenTurnDiff(turnSummary.turnId, checkpointFiles[0]?.path)
                                }
                              >
                                View diff
                              </Button>
                            </div>
                          </div>
                          <ChangedFilesTree
                            key={`changed-files-tree:${turnSummary.turnId}`}
                            turnId={turnSummary.turnId}
                            files={checkpointFiles}
                            allDirectoriesExpanded={allDirectoriesExpanded}
                            resolvedTheme={resolvedTheme}
                            onOpenTurnDiff={onOpenTurnDiff}
                          />
                        </div>
                      );
                    })()}
                    <div className="mt-1.5 flex items-center gap-2 opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover:opacity-100">
                      {row.message.text.trim().length > 0 && (
                        <MessageCopyButton text={row.message.text} />
                      )}
                      <p className="text-[10px] text-muted-foreground/40">
                        {formatMessageMeta(
                          row.message.createdAt,
                          row.message.streaming
                            ? formatElapsed(row.durationStart, nowIso)
                            : formatElapsed(row.durationStart, row.message.completedAt),
                          timestampFormat,
                        )}
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            );
          })()}

        {row.kind === "proposed-plan" && (
          <div className="min-w-0 px-1 py-0.5">
            <ProposedPlanCard
              planMarkdown={row.proposedPlan.planMarkdown}
              cwd={markdownCwd}
              workspaceRoot={workspaceRoot}
            />
          </div>
        )}
      </div>
    );
  };

  if (!hasMessages) {
    return null;
  }

  return (
    <div
      ref={timelineRootRef}
      data-timeline-root="true"
      className="mx-auto w-full min-w-0 max-w-3xl overflow-x-hidden"
    >
      {advisorGreeting && (
        <div className="flex flex-col items-center gap-4 pb-14 pt-14 text-center">
          {advisorGreetingAvatarSrc ? (
            <img
              src={advisorGreetingAvatarSrc}
              alt=""
              draggable={false}
              className="size-20 object-contain"
            />
          ) : (
            <div className="flex size-10 items-center justify-center rounded-full bg-foreground/[0.04]">
              <SparklesIcon className="size-4 text-foreground/25" />
            </div>
          )}
          <p className="max-w-sm text-[13px] leading-relaxed text-foreground/70">
            {advisorGreeting}
          </p>
        </div>
      )}
      {virtualizedRowCount > 0 && (
        <div className="relative" style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
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
                className="absolute left-0 top-0 w-full"
                style={{ transform: `translateY(${virtualRow.start}px)` }}
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
  );
});

type TimelineEntry = ReturnType<typeof deriveTimelineEntries>[number];
type TimelineMessage = Extract<TimelineEntry, { kind: "message" }>["message"];
type TimelineWorkEntry = Extract<MessagesTimelineRow, { kind: "work" }>["groupedEntries"][number];
type TimelineRow = MessagesTimelineRow;

function formatMessageMeta(
  createdAt: string,
  duration: string | null,
  timestampFormat: TimestampFormat,
): string {
  if (!duration) return formatShortTimestamp(createdAt, timestampFormat);
  return `${formatShortTimestamp(createdAt, timestampFormat)} • ${duration}`;
}

const UserMessageTerminalContextInlineLabel = memo(
  function UserMessageTerminalContextInlineLabel(props: { context: ParsedTerminalContextEntry }) {
    const tooltipText =
      props.context.body.length > 0
        ? `${props.context.header}\n${props.context.body}`
        : props.context.header;

    return <TerminalContextInlineChip label={props.context.header} tooltipText={tooltipText} />;
  },
);

const UserMessageBody = memo(function UserMessageBody(props: {
  text: string;
  terminalContexts: ParsedTerminalContextEntry[];
}) {
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
            <span key={`user-terminal-context-inline-before:${context.header}:${cursor}`}>
              {props.text.slice(cursor, matchIndex)}
            </span>,
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
            <span key={`user-message-terminal-context-inline-rest:${cursor}`}>
              {props.text.slice(cursor)}
            </span>,
          );
        }

        return (
          <div className="wrap-break-word whitespace-pre-wrap font-mono text-sm leading-relaxed text-foreground">
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
      inlineNodes.push(<span key="user-message-terminal-context-inline-text">{props.text}</span>);
    } else if (inlinePrefix.length === 0) {
      return null;
    }

    return (
      <div className="wrap-break-word whitespace-pre-wrap font-mono text-sm leading-relaxed text-foreground">
        {inlineNodes}
      </div>
    );
  }

  if (props.text.length === 0) {
    return null;
  }

  return (
    <pre className="whitespace-pre-wrap wrap-break-word font-mono text-sm leading-relaxed text-foreground">
      {props.text}
    </pre>
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

function workToneClass(tone: "thinking" | "tool" | "info" | "error"): string {
  if (tone === "error") return "text-rose-300/50 dark:text-rose-300/50";
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

function workEntryIcon(workEntry: TimelineWorkEntry): LucideIcon {
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

const SimpleWorkEntryRow = memo(function SimpleWorkEntryRow(props: {
  workEntry: TimelineWorkEntry;
  livePreview?: ToolInputStream | undefined;
  showPreviewArea?: boolean;
  workspaceRoot?: string | undefined;
}) {
  const { workEntry, livePreview, showPreviewArea = false, workspaceRoot } = props;
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
    return <ToolInputCodePreview stream={livePreview} defaultCollapsed={isStatic} />;
  }

  const friendlyText = buildFriendlyToolText({ workEntry, workspaceRoot });
  const fallbackHeading = toolWorkEntryHeading(workEntry);
  const fallbackPreview = workEntryPreview(workEntry);
  const labelText =
    friendlyText ?? (fallbackPreview ? `${fallbackHeading} - ${fallbackPreview}` : fallbackHeading);
  const isInProgress = workEntry.inProgress === true;
  const hasChangedFiles = (workEntry.changedFiles?.length ?? 0) > 0;
  const previewIsChangedFiles = hasChangedFiles && !workEntry.command && !workEntry.detail;

  return (
    <div className="rounded-lg px-1 py-1">
      <div className="flex items-center gap-2">
        <span className="flex size-5 shrink-0 items-center justify-center text-foreground/80">
          <EntryIcon className="size-3" />
        </span>
        <div className="min-w-0 flex-1 overflow-hidden">
          {isInProgress ? (
            <ShimmerText className="block truncate text-sm">{labelText}</ShimmerText>
          ) : (
            <p
              className={cn("truncate text-sm text-foreground/85", workToneClass(workEntry.tone))}
              title={labelText}
            >
              {labelText}
            </p>
          )}
        </div>
      </div>
      {hasChangedFiles && !previewIsChangedFiles && !friendlyText && (
        <div className="mt-1 flex flex-wrap gap-1 pl-6">
          {workEntry.changedFiles?.slice(0, 4).map((filePath) => (
            <span
              key={`${workEntry.id}:${filePath}`}
              className="rounded-md border border-border/55 bg-background/75 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground/75"
              title={filePath}
            >
              {filePath}
            </span>
          ))}
          {(workEntry.changedFiles?.length ?? 0) > 4 && (
            <span className="px-1 text-[10px] text-muted-foreground/55">
              +{(workEntry.changedFiles?.length ?? 0) - 4}
            </span>
          )}
        </div>
      )}
    </div>
  );
});
