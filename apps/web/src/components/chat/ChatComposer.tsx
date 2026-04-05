import {
  type ApprovalRequestId,
  type ProjectId,
  type ProviderApprovalDecision,
  type ProviderKind,
  type ServerProvider,
  type ThreadId,
  ProviderInteractionMode,
  RuntimeMode,
} from "@piedpiper/contracts";
import {
  type ReactNode,
  Suspense,
  lazy,
  memo,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  BotIcon,
  CircleAlertIcon,
  LockIcon,
  LockOpenIcon,
  ListTodoIcon,
  XIcon,
} from "lucide-react";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { ComposerTriggerKind } from "../../composer-logic";
import type {
  LatestProposedPlanState,
  PendingApproval,
  PendingUserInput,
} from "../../session-logic";
import type { SessionPhase } from "../../types";
import type { ComposerImageAttachment } from "../../composerDraftStore";
import type { TerminalContextDraft } from "../../lib/terminalContext";
import type { ComposerProviderState } from "./composerProviderRegistry";
import type { ComposerCommandItem } from "./ComposerCommandMenu";
import type { ComposerPromptEditorHandle } from "../ComposerPromptEditor";
import type { PendingUserInputDraftAnswer, PendingUserInputProgress } from "../../pendingUserInput";
import type { ContextWindowSnapshot } from "../../lib/contextWindow";
import {
  resolveComposerFooterContentWidth,
  shouldForceCompactComposerFooterForFit,
  shouldUseCompactComposerFooter,
  shouldUseCompactComposerPrimaryActions,
} from "../composerFooterLayout";
import { proposedPlanTitle } from "../../proposedPlan";
import { buildExpandedImagePreview, ExpandedImagePreview } from "./ExpandedImagePreview";
import { formatContextWindowTokens } from "../../lib/contextWindow";
import { ShimmerText } from "./ShimmerText";
import { WORKING_MESSAGES } from "../office-mode/workingMessages";
import { UnicodeSpinnerStrip } from "../sidebar/UnicodeSpinner";
import { MissingCwdBanner } from "./MissingCwdBanner";
import { ComposerPromptEditor } from "../ComposerPromptEditor";
import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";
import { ComposerPendingApprovalPanel } from "./ComposerPendingApprovalPanel";
import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";
import { ComposerPlanFollowUpBanner } from "./ComposerPlanFollowUpBanner";
import { CompactComposerControlsMenu } from "./CompactComposerControlsMenu";
import { ComposerPrimaryActions } from "./ComposerPrimaryActions";
import { ProviderModelPicker } from "./ProviderModelPicker";
import { ContextWindowMeter } from "./ContextWindowMeter";

const ComposerCommandMenu = lazy(() =>
  import("./ComposerCommandMenu").then((mod) => ({ default: mod.ComposerCommandMenu })),
);

function formatWorkingTimer(startIso: string, endIso: string): string | null {
  const startedAtMs = Date.parse(startIso);
  const endedAtMs = Date.parse(endIso);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs)) return null;
  const elapsedSeconds = Math.max(0, Math.floor((endedAtMs - startedAtMs) / 1000));
  if (elapsedSeconds < 60) return `${elapsedSeconds}s`;
  const hours = Math.floor(elapsedSeconds / 3600);
  const minutes = Math.floor((elapsedSeconds % 3600) / 60);
  const seconds = elapsedSeconds % 60;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface ChatComposerProps {
  // Thread/project identity
  threadId: ThreadId;
  projectId: ProjectId | undefined;
  missingCwd: string | null;
  onMissingCwdResolved: () => void;

  // Working state
  isWorking: boolean;
  workingLabel: string | null;
  activeWorkStartedAt: string | null;
  nowIso: string;
  nowTick: number;
  activeContextWindow: ContextWindowSnapshot | null;
  phase: SessionPhase;
  isConnecting: boolean;
  isSendBusy: boolean;
  isPreparingWorktree: boolean;

  // Provider/model
  selectedProvider: ProviderKind;
  selectedModelForPicker: string;
  providerStatuses: ReadonlyArray<ServerProvider>;
  modelOptionsByProvider: Record<string, ReadonlyArray<ServerProvider["models"][number]>>;
  composerProviderState: ComposerProviderState;
  onProviderModelSelect: (provider: ProviderKind, model: string) => void;

  // Prompt editor state (owned by ChatView / draft store)
  prompt: string;
  composerCursor: number;
  composerTerminalContexts: ReadonlyArray<TerminalContextDraft>;
  composerEditorRef: React.RefObject<ComposerPromptEditorHandle | null>;
  onPromptChange: (
    nextPrompt: string,
    nextCursor: number,
    expandedCursor: number,
    cursorAdjacentToMention: boolean,
    terminalContextIds: string[],
  ) => void;
  onComposerCommandKey: (
    key: "ArrowDown" | "ArrowUp" | "Enter" | "Tab",
    event: KeyboardEvent,
  ) => boolean;
  onComposerPaste: (event: React.ClipboardEvent<HTMLElement>) => void;
  removeComposerTerminalContextFromDraft: (contextId: string) => void;

  // Composer menu
  composerMenuOpen: boolean;
  composerMenuItems: ComposerCommandItem[];
  activeComposerMenuItem: ComposerCommandItem | null;
  composerTriggerKind: ComposerTriggerKind | null;
  isComposerMenuLoading: boolean;
  composerHighlightedItemId: string | null;
  onComposerMenuItemHighlighted: (itemId: string | null) => void;
  onSelectComposerItem: (item: ComposerCommandItem) => void;

  // Images
  composerImages: ReadonlyArray<ComposerImageAttachment>;
  nonPersistedComposerImageIdSet: ReadonlySet<string>;
  onRemoveComposerImage: (imageId: string) => void;
  onExpandImage: (preview: ExpandedImagePreview) => void;

  // Pending approvals
  activePendingApproval: PendingApproval | null;
  pendingApprovals: ReadonlyArray<PendingApproval>;
  respondingRequestIds: ApprovalRequestId[];
  onRespondToApproval: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<void>;
  isComposerApprovalState: boolean;

  // Pending user inputs
  activePendingUserInput: PendingUserInput | null;
  pendingUserInputs: PendingUserInput[];
  activePendingDraftAnswers: Record<string, PendingUserInputDraftAnswer>;
  activePendingQuestionIndex: number;
  activePendingProgress: PendingUserInputProgress | null;
  activePendingIsResponding: boolean;
  activePendingResolvedAnswers: Record<string, unknown> | null;
  onSelectActivePendingUserInputOption: (questionId: string, optionLabel: string) => void;
  onAdvanceActivePendingUserInput: () => void;
  onPreviousActivePendingUserInputQuestion: () => void;

  // Plan follow-up
  showPlanFollowUpPrompt: boolean;
  activeProposedPlan: LatestProposedPlanState | null;

  // Mode controls
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  isAdvisorThread: boolean;
  toggleInteractionMode: () => void;
  toggleRuntimeMode: () => void;
  handleRuntimeModeChange: (mode: RuntimeMode) => void;
  togglePlanSidebar: () => void;
  planSidebarOpen: boolean;
  activePlan: unknown;
  sidebarProposedPlan: unknown;

  // Provider traits
  providerTraitsMenuContent: ReactNode;
  providerTraitsPicker: ReactNode;

  // Submit
  onSend: (e?: { preventDefault: () => void }) => void;
  onInterrupt: () => void;
  onImplementPlanInNewThread: () => void;

  // Layout context
  resolvedTheme: "light" | "dark";
  hasComposerHeader: boolean;
  composerSendState: { hasSendableContent: boolean };
  composerFooterHasWideActions: boolean;
  composerFooterActionLayoutKey: string;
  scheduleStickToBottom: () => void;
  /** Called when files are dropped on the composer. */
  onFileDrop: (files: File[]) => void;
}

/**
 * Composer form extracted from ChatView. Owns the drag/drop and compact-layout
 * state so that layout measurement re-renders are contained within the
 * composer instead of propagating to the entire chat view.
 */
export const ChatComposer = memo(function ChatComposer(props: ChatComposerProps) {
  const {
    threadId,
    projectId,
    missingCwd,
    onMissingCwdResolved,
    isWorking,
    workingLabel,
    activeWorkStartedAt,
    nowIso,
    nowTick,
    activeContextWindow,
    phase,
    isConnecting,
    isSendBusy,
    isPreparingWorktree,
    selectedProvider,
    selectedModelForPicker,
    providerStatuses,
    modelOptionsByProvider,
    composerProviderState,
    onProviderModelSelect,
    prompt,
    composerCursor,
    composerTerminalContexts,
    composerEditorRef,
    onPromptChange,
    onComposerCommandKey,
    onComposerPaste,
    removeComposerTerminalContextFromDraft,
    composerMenuOpen,
    composerMenuItems,
    activeComposerMenuItem,
    composerTriggerKind,
    isComposerMenuLoading,
    onComposerMenuItemHighlighted,
    onSelectComposerItem,
    composerImages,
    nonPersistedComposerImageIdSet,
    onRemoveComposerImage,
    onExpandImage,
    activePendingApproval,
    pendingApprovals,
    respondingRequestIds,
    onRespondToApproval,
    isComposerApprovalState,
    activePendingUserInput,
    pendingUserInputs,
    activePendingDraftAnswers,
    activePendingQuestionIndex,
    activePendingProgress,
    activePendingIsResponding,
    activePendingResolvedAnswers,
    onSelectActivePendingUserInputOption,
    onAdvanceActivePendingUserInput,
    onPreviousActivePendingUserInputQuestion,
    showPlanFollowUpPrompt,
    activeProposedPlan,
    runtimeMode,
    interactionMode,
    isAdvisorThread,
    toggleInteractionMode,
    toggleRuntimeMode,
    handleRuntimeModeChange,
    togglePlanSidebar,
    planSidebarOpen,
    activePlan,
    sidebarProposedPlan,
    providerTraitsMenuContent,
    providerTraitsPicker,
    onSend,
    onInterrupt,
    onImplementPlanInNewThread,
    resolvedTheme,
    hasComposerHeader,
    composerFooterHasWideActions,
    composerFooterActionLayoutKey,
    scheduleStickToBottom,
    onFileDrop,
  } = props;

  // ---------- Drag/drop state (local) ----------
  const [isDragOverComposer, setIsDragOverComposer] = useState(false);
  const dragDepthRef = useRef(0);

  const onComposerDragEnter = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setIsDragOverComposer(true);
  }, []);
  const onComposerDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setIsDragOverComposer(true);
  }, []);
  const onComposerDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setIsDragOverComposer(false);
    }
  }, []);
  const onComposerDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (!event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      dragDepthRef.current = 0;
      setIsDragOverComposer(false);
      const files = Array.from(event.dataTransfer.files);
      onFileDrop(files);
    },
    [onFileDrop],
  );

  // ---------- Compact layout detection (local) ----------
  const [isComposerFooterCompact, setIsComposerFooterCompact] = useState(false);
  const [isComposerPrimaryActionsCompact, setIsComposerPrimaryActionsCompact] = useState(false);
  const composerFormRef = useRef<HTMLFormElement>(null);
  const composerFormHeightRef = useRef(0);
  const composerFooterRef = useRef<HTMLDivElement>(null);
  const composerFooterLeadingRef = useRef<HTMLDivElement>(null);
  const composerFooterActionsRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const composerForm = composerFormRef.current;
    if (!composerForm) return;
    const measureComposerFormWidth = () => composerForm.clientWidth;
    const measureFooterCompactness = () => {
      const composerFormWidth = measureComposerFormWidth();
      const heuristicFooterCompact = shouldUseCompactComposerFooter(composerFormWidth, {
        hasWideActions: composerFooterHasWideActions,
      });
      const footer = composerFooterRef.current;
      const footerStyle = footer ? window.getComputedStyle(footer) : null;
      const footerContentWidth = resolveComposerFooterContentWidth({
        footerWidth: footer?.clientWidth ?? null,
        paddingLeft: footerStyle ? Number.parseFloat(footerStyle.paddingLeft) : null,
        paddingRight: footerStyle ? Number.parseFloat(footerStyle.paddingRight) : null,
      });
      const fitInput = {
        footerContentWidth,
        leadingContentWidth: composerFooterLeadingRef.current?.scrollWidth ?? null,
        actionsWidth: composerFooterActionsRef.current?.scrollWidth ?? null,
      };
      const nextFooterCompact =
        heuristicFooterCompact || shouldForceCompactComposerFooterForFit(fitInput);
      const nextPrimaryActionsCompact =
        nextFooterCompact &&
        shouldUseCompactComposerPrimaryActions(composerFormWidth, {
          hasWideActions: composerFooterHasWideActions,
        });
      return {
        primaryActionsCompact: nextPrimaryActionsCompact,
        footerCompact: nextFooterCompact,
      };
    };

    composerFormHeightRef.current = composerForm.getBoundingClientRect().height;
    const initialCompactness = measureFooterCompactness();
    setIsComposerPrimaryActionsCompact(initialCompactness.primaryActionsCompact);
    setIsComposerFooterCompact(initialCompactness.footerCompact);
    if (typeof ResizeObserver === "undefined") return;

    const shouldAutoScrollRef = { current: true };
    const observer = new ResizeObserver((entries) => {
      const [entry] = entries;
      if (!entry) return;
      const nextCompactness = measureFooterCompactness();
      setIsComposerPrimaryActionsCompact((previous) =>
        previous === nextCompactness.primaryActionsCompact
          ? previous
          : nextCompactness.primaryActionsCompact,
      );
      setIsComposerFooterCompact((previous) =>
        previous === nextCompactness.footerCompact ? previous : nextCompactness.footerCompact,
      );
      const nextHeight = entry.contentRect.height;
      const previousHeight = composerFormHeightRef.current;
      composerFormHeightRef.current = nextHeight;
      if (previousHeight > 0 && Math.abs(nextHeight - previousHeight) < 0.5) return;
      if (!shouldAutoScrollRef.current) return;
      scheduleStickToBottom();
    });
    observer.observe(composerForm);
    return () => {
      observer.disconnect();
    };
  }, [
    threadId,
    composerFooterActionLayoutKey,
    composerFooterHasWideActions,
    scheduleStickToBottom,
  ]);

  // Reset drag state on thread change
  useLayoutEffect(() => {
    dragDepthRef.current = 0;
    setIsDragOverComposer(false);
  }, [threadId]);

  // ---------- Render ----------
  if (missingCwd && projectId) {
    return (
      <MissingCwdBanner
        missingCwd={missingCwd}
        threadId={threadId}
        projectId={projectId}
        onResolved={onMissingCwdResolved}
      />
    );
  }

  return (
    <>
      {/* Input bar */}
      <div
        className={cn(
          "px-3 pb-6 sm:px-5 sm:pb-8",
          isWorking ? "pt-3 sm:pt-4" : "pt-[24px] sm:pt-[26px]",
        )}
      >
        <form
          ref={composerFormRef}
          onSubmit={onSend}
          className="mx-auto w-full min-w-0 max-w-[52rem]"
          data-chat-composer-form="true"
        >
          <div
            className={cn(
              "group rounded-[22px] p-px transition-colors duration-200",
              composerProviderState.composerFrameClassName,
            )}
            onDragEnter={onComposerDragEnter}
            onDragOver={onComposerDragOver}
            onDragLeave={onComposerDragLeave}
            onDrop={onComposerDrop}
          >
            <div
              className={cn(
                "border-0 bg-secondary py-0.5 transition-colors duration-200 has-focus-visible:bg-accent",
                "rounded-[20px]",
                isDragOverComposer && "bg-accent/30",
                composerProviderState.composerSurfaceClassName,
              )}
            >
              {/* Working status — collapses inside the composer card */}
              <div
                className="grid transition-[grid-template-rows] duration-200 ease-out"
                style={{ gridTemplateRows: isWorking ? "1fr" : "0fr" }}
              >
                <div className="min-h-0 overflow-hidden">
                  <div className="flex items-center justify-between rounded-t-[19px] bg-black/20 px-4 py-2 sm:px-5">
                    <div className="min-w-0 flex-1">
                      <ShimmerText className="text-[13px] font-medium">
                        {workingLabel ??
                          (() => {
                            const parts: string[] = [];
                            const timer = activeWorkStartedAt
                              ? formatWorkingTimer(activeWorkStartedAt, nowIso)
                              : null;
                            if (timer) parts.push(timer);
                            const tokens = activeContextWindow?.totalProcessedTokens;
                            if (tokens != null && tokens > 0)
                              parts.push(`\u2191 ${formatContextWindowTokens(tokens)} tokens`);
                            const tools = activeContextWindow?.toolUses;
                            if (tools != null && tools > 0)
                              parts.push(`${tools} tool${tools === 1 ? "" : "s"}`);
                            const verb =
                              WORKING_MESSAGES[
                                Math.floor(nowTick / 30000) % WORKING_MESSAGES.length
                              ] ?? "Working";
                            return parts.length > 0
                              ? `${verb}\u2026\u2002${parts.join("\u2003\u00b7\u2003")}`
                              : `${verb}\u2026`;
                          })()}
                      </ShimmerText>
                    </div>
                    <UnicodeSpinnerStrip className="shrink-0 text-[16px] leading-none" />
                  </div>
                </div>
              </div>
              {activePendingApproval ? (
                <div className="rounded-t-[19px] border-b border-border/65 bg-muted/20">
                  <ComposerPendingApprovalPanel
                    approval={activePendingApproval}
                    pendingCount={pendingApprovals.length}
                  />
                </div>
              ) : pendingUserInputs.length > 0 ? (
                <div className="rounded-t-[19px] border-b border-border/65 bg-muted/20">
                  <ComposerPendingUserInputPanel
                    pendingUserInputs={pendingUserInputs}
                    respondingRequestIds={respondingRequestIds}
                    answers={activePendingDraftAnswers}
                    questionIndex={activePendingQuestionIndex}
                    onSelectOption={onSelectActivePendingUserInputOption}
                    onCustomAnswer={(_questionId: string, text: string) =>
                      onPromptChange(text, text.length, text.length, false, [])
                    }
                    onAdvance={onAdvanceActivePendingUserInput}
                  />
                </div>
              ) : showPlanFollowUpPrompt && activeProposedPlan ? (
                <div className="rounded-t-[19px] border-b border-border/65 bg-muted/20">
                  <ComposerPlanFollowUpBanner
                    key={activeProposedPlan.id}
                    planTitle={proposedPlanTitle(activeProposedPlan.planMarkdown) ?? null}
                  />
                </div>
              ) : null}
              <div
                className={cn(
                  "relative px-3 sm:px-4",
                  activePendingUserInput
                    ? "pb-1 pt-1.5"
                    : cn("pb-2", hasComposerHeader ? "pt-2.5 sm:pt-3" : "pt-3.5 sm:pt-4"),
                )}
              >
                {composerMenuOpen && !isComposerApprovalState && (
                  <div className="absolute inset-x-0 bottom-full z-20 mb-2 px-1">
                    <Suspense fallback={null}>
                      <ComposerCommandMenu
                        items={composerMenuItems}
                        resolvedTheme={resolvedTheme}
                        isLoading={isComposerMenuLoading}
                        triggerKind={composerTriggerKind}
                        activeItemId={activeComposerMenuItem?.id ?? null}
                        onHighlightedItemChange={onComposerMenuItemHighlighted}
                        onSelect={onSelectComposerItem}
                      />
                    </Suspense>
                  </div>
                )}

                {!isComposerApprovalState &&
                  pendingUserInputs.length === 0 &&
                  composerImages.length > 0 && (
                    <div className="mb-3 flex flex-wrap gap-2">
                      {composerImages.map((image) => (
                        <div
                          key={image.id}
                          className="relative h-16 w-16 overflow-hidden rounded-lg border border-border/80 bg-background"
                        >
                          {image.previewUrl ? (
                            <button
                              type="button"
                              className="h-full w-full cursor-zoom-in"
                              aria-label={`Preview ${image.name}`}
                              onClick={() => {
                                const preview = buildExpandedImagePreview(composerImages, image.id);
                                if (!preview) return;
                                onExpandImage(preview);
                              }}
                            >
                              <img
                                src={image.previewUrl}
                                alt={image.name}
                                className="h-full w-full object-cover"
                              />
                            </button>
                          ) : (
                            <div className="flex h-full w-full items-center justify-center px-1 text-center text-[10px] text-muted-foreground/70">
                              {image.name}
                            </div>
                          )}
                          {nonPersistedComposerImageIdSet.has(image.id) && (
                            <Tooltip>
                              <TooltipTrigger
                                render={
                                  <span
                                    role="img"
                                    aria-label="Draft attachment may not persist"
                                    className="absolute left-1 top-1 inline-flex items-center justify-center rounded bg-background/85 p-0.5 text-amber-600"
                                  >
                                    <CircleAlertIcon className="size-3" />
                                  </span>
                                }
                              />
                              <TooltipPopup
                                side="top"
                                className="max-w-64 whitespace-normal leading-tight"
                              >
                                Draft attachment could not be saved locally and may be lost on
                                navigation.
                              </TooltipPopup>
                            </Tooltip>
                          )}
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            className="absolute right-1 top-1 bg-background/80 hover:bg-background/90"
                            onClick={() => onRemoveComposerImage(image.id)}
                            aria-label={`Remove ${image.name}`}
                          >
                            <XIcon />
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                {/* Hide the rich editor during user-input questions —
                the inline input in the question panel handles custom answers. */}
                {!activePendingUserInput && (
                  <ComposerPromptEditor
                    ref={composerEditorRef}
                    value={isComposerApprovalState ? "" : prompt}
                    cursor={composerCursor}
                    terminalContexts={!isComposerApprovalState ? composerTerminalContexts : []}
                    onRemoveTerminalContext={removeComposerTerminalContextFromDraft}
                    onChange={onPromptChange}
                    onCommandKeyDown={onComposerCommandKey}
                    onPaste={onComposerPaste}
                    placeholder={
                      isComposerApprovalState
                        ? (activePendingApproval?.detail ??
                          "Resolve this approval request to continue")
                        : showPlanFollowUpPrompt && activeProposedPlan
                          ? "Add feedback to refine the plan, or leave this blank to implement it"
                          : phase === "disconnected"
                            ? "Ask for follow-up changes or attach images"
                            : "Ask anything, @tag files/folders, or use / to show available commands"
                    }
                    disabled={isConnecting || isComposerApprovalState}
                  />
                )}
              </div>

              {/* Bottom toolbar */}
              {activePendingApproval ? (
                <div className="flex items-center justify-end gap-2 px-2.5 pb-2.5 sm:px-3 sm:pb-3">
                  <ComposerPendingApprovalActions
                    requestId={activePendingApproval.requestId}
                    isResponding={respondingRequestIds.includes(activePendingApproval.requestId)}
                    onRespondToApproval={onRespondToApproval}
                  />
                </div>
              ) : (
                <div
                  ref={composerFooterRef}
                  data-chat-composer-footer="true"
                  data-chat-composer-footer-compact={isComposerFooterCompact ? "true" : "false"}
                  className={cn(
                    "flex min-w-0 flex-nowrap items-center overflow-hidden px-2 pb-1.5 sm:px-2.5 sm:pb-2",
                    activePendingUserInput ? "justify-end" : "justify-between",
                    isComposerFooterCompact ? "gap-1.5" : "gap-3",
                  )}
                >
                  <div
                    ref={composerFooterLeadingRef}
                    className={cn(
                      "flex min-w-0 flex-1 items-center",
                      activePendingUserInput && "hidden",
                      isComposerFooterCompact
                        ? "gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                        : "gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:min-w-max sm:overflow-visible",
                    )}
                  >
                    {/* Provider/model picker */}
                    <ProviderModelPicker
                      compact={isComposerFooterCompact}
                      provider={selectedProvider}
                      model={selectedModelForPicker}
                      lockedProvider={null}
                      providers={providerStatuses}
                      modelOptionsByProvider={modelOptionsByProvider}
                      {...(composerProviderState.modelPickerIconClassName
                        ? {
                            activeProviderIconClassName:
                              composerProviderState.modelPickerIconClassName,
                          }
                        : {})}
                      onProviderModelChange={onProviderModelSelect}
                    />

                    {isComposerFooterCompact ? (
                      <CompactComposerControlsMenu
                        activePlan={Boolean(activePlan || sidebarProposedPlan || planSidebarOpen)}
                        interactionMode={interactionMode}
                        isAdvisor={isAdvisorThread}
                        planSidebarOpen={planSidebarOpen}
                        runtimeMode={runtimeMode}
                        traitsMenuContent={providerTraitsMenuContent}
                        onToggleInteractionMode={toggleInteractionMode}
                        onTogglePlanSidebar={togglePlanSidebar}
                        onToggleRuntimeMode={toggleRuntimeMode}
                      />
                    ) : (
                      <>
                        {providerTraitsPicker ?? null}

                        <Button
                          variant="ghost"
                          className={cn(
                            "shrink-0 whitespace-nowrap px-2 text-[11px]",
                            interactionMode === "plan"
                              ? "bg-amber-500/15 text-amber-600 hover:text-amber-700 dark:text-amber-400 dark:hover:text-amber-300"
                              : interactionMode === "ask"
                                ? "bg-sky-500/15 text-sky-600 hover:text-sky-700 dark:text-sky-400 dark:hover:text-sky-300"
                                : "text-foreground/60 hover:text-foreground/90",
                          )}
                          size="xs"
                          type="button"
                          onClick={toggleInteractionMode}
                          title={
                            interactionMode === "plan"
                              ? "Plan mode \u2014 click to return to agent mode"
                              : interactionMode === "ask"
                                ? "Ask mode (no tools) \u2014 click to enter agent mode"
                                : isAdvisorThread
                                  ? "Agent mode \u2014 click to enter ask mode"
                                  : "Agent mode \u2014 click to enter plan mode"
                          }
                        >
                          <BotIcon />
                          <span className="sr-only sm:not-sr-only">
                            {interactionMode === "plan"
                              ? "Plan"
                              : interactionMode === "ask"
                                ? "Ask"
                                : "Agent"}
                          </span>
                        </Button>

                        <Button
                          variant="ghost"
                          className="shrink-0 whitespace-nowrap px-2 text-[11px] text-foreground/60 hover:text-foreground/90"
                          size="xs"
                          type="button"
                          onClick={() =>
                            void handleRuntimeModeChange(
                              runtimeMode === "full-access" ? "approval-required" : "full-access",
                            )
                          }
                          title={
                            runtimeMode === "full-access"
                              ? "Full access \u2014 click to require approvals"
                              : "Approval required \u2014 click for full access"
                          }
                        >
                          {runtimeMode === "full-access" ? <LockOpenIcon /> : <LockIcon />}
                          <span className="sr-only sm:not-sr-only">
                            {runtimeMode === "full-access" ? "Full access" : "Supervised"}
                          </span>
                        </Button>

                        {activePlan ||
                        sidebarProposedPlan ||
                        planSidebarOpen ||
                        showPlanFollowUpPrompt ? (
                          <>
                            <Button
                              variant="ghost"
                              className={cn(
                                "shrink-0 whitespace-nowrap px-2 text-[11px]",
                                planSidebarOpen
                                  ? "text-foreground hover:text-foreground/80"
                                  : "text-foreground/60 hover:text-foreground/90",
                              )}
                              size="xs"
                              type="button"
                              onClick={togglePlanSidebar}
                              title={planSidebarOpen ? "Hide plan sidebar" : "Show plan sidebar"}
                            >
                              <ListTodoIcon />
                              <span className="sr-only sm:not-sr-only">Plan</span>
                            </Button>
                          </>
                        ) : null}
                      </>
                    )}
                  </div>

                  {/* Right side: send / stop button */}
                  <div
                    ref={composerFooterActionsRef}
                    data-chat-composer-actions="right"
                    data-chat-composer-primary-actions-compact={
                      isComposerPrimaryActionsCompact ? "true" : "false"
                    }
                    className="flex shrink-0 flex-nowrap items-center justify-end gap-2"
                  >
                    {activeContextWindow && !activePendingProgress ? (
                      <ContextWindowMeter usage={activeContextWindow} />
                    ) : null}
                    {isPreparingWorktree ? (
                      <span className="text-muted-foreground/70 text-xs">
                        Preparing worktree...
                      </span>
                    ) : null}
                    <ComposerPrimaryActions
                      compact={isComposerPrimaryActionsCompact}
                      pendingAction={
                        activePendingProgress
                          ? {
                              questionIndex: activePendingProgress.questionIndex,
                              isLastQuestion: activePendingProgress.isLastQuestion,
                              canAdvance: activePendingProgress.canAdvance,
                              isResponding: activePendingIsResponding,
                              isComplete: Boolean(activePendingResolvedAnswers),
                            }
                          : null
                      }
                      isRunning={phase === "running"}
                      showPlanFollowUpPrompt={
                        pendingUserInputs.length === 0 && showPlanFollowUpPrompt
                      }
                      promptHasText={prompt.trim().length > 0}
                      isSendBusy={isSendBusy}
                      isConnecting={isConnecting}
                      isPreparingWorktree={isPreparingWorktree}
                      onPreviousPendingQuestion={onPreviousActivePendingUserInputQuestion}
                      onInterrupt={() => void onInterrupt()}
                      onImplementPlanInNewThread={() => void onImplementPlanInNewThread()}
                    />
                  </div>
                </div>
              )}
            </div>
          </div>
        </form>
      </div>
    </>
  );
});
