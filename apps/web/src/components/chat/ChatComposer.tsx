import {
  type ApprovalRequestId,
  type ModelSelection,
  type ProjectId,
  type ProviderApprovalDecision,
  type ProviderKind,
  type ProviderModelOptions,
  type ServerProvider,
  type ServerProviderModel,
  type ThreadId,
  ProviderInteractionMode,
  RuntimeMode,
} from "@piedpiper/contracts";
import {
  type ReactNode,
  type Ref,
  Suspense,
  lazy,
  memo,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { BotIcon, ListTodoIcon } from "lucide-react";
import { shortcutLabelForCommand } from "~/keybindings";
import { useServerKeybindings } from "~/rpc/serverState";
import { cn, newCommandId } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import { useStore } from "~/store";
import { Button } from "../ui/button";
import {
  type ComposerTriggerKind,
  collapseExpandedComposerCursor,
  expandCollapsedComposerCursor,
} from "../../composer-logic";
import { toastManager } from "../ui/toast";
import { isComposerImageFile } from "../ChatView.heicImage";
import { usePreparingComposerImages } from "../ChatView.preparingImages";
import {
  type ComposerDropDataTransfer,
  insertComposerPathMentions,
  resolveComposerDroppedPath,
  splitComposerDroppedItems,
  toComposerMentionPath,
} from "./composerFolderDrop";
import type {
  LatestProposedPlanState,
  PendingApproval,
  PendingUserInput,
} from "../../session-logic";
import { formatWorkingTimer } from "../../session-logic";
import type { SessionPhase } from "../../types";
import type { ComposerImageAttachment } from "../../composerDraftStore";
import type { TerminalContextDraft } from "../../lib/terminalContext";
import type { ComposerProviderState } from "./composerProviderRegistry";
import type { ComposerCommandItem } from "./ComposerCommandMenu";
import type { ComposerCommandKey, ComposerPromptEditorHandle } from "../ComposerPromptEditor";
import type { ComposerPageScrollDirection } from "./composerPageScrollKeys";
import type { PendingUserInputDraftAnswer, PendingUserInputProgress } from "../../pendingUserInput";
import type { ContextWindowSnapshot } from "../../lib/contextWindow";
import {
  COMPOSER_ICON_ONLY_LABEL_CLASS_NAME,
  resolveComposerFooterBlockStates,
  shouldUseCompactComposerPrimaryActions,
} from "../composerFooterLayout";
import { proposedPlanTitle } from "../../proposedPlan";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";
import { formatContextWindowTokens } from "../../lib/contextWindow";
import { ShimmerText } from "./ShimmerText";
import { WORKING_MESSAGES } from "../office-mode/workingMessages";
import { UnicodeSpinnerStrip } from "../sidebar/UnicodeSpinner";
import { MissingCwdBanner } from "./MissingCwdBanner";
import { ComposerPromptEditor } from "../ComposerPromptEditor";
import {
  composerSuggestionOptionId,
  composerSuggestionStatusMessage,
} from "./composerSuggestionA11y";
import { ComposerApprovalRedirectSendButton } from "./ComposerApprovalRedirectSendButton";
import { ComposerAttachButton } from "./ComposerAttachButton";
import { ComposerImageTiles } from "./ComposerImageTiles";
import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";
import { ComposerPendingApprovalPanel } from "./ComposerPendingApprovalPanel";
import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";
import { ComposerPlanFollowUpBanner } from "./ComposerPlanFollowUpBanner";
import { CompactComposerControlsMenu } from "./CompactComposerControlsMenu";
import { ComposerPrimaryActions } from "./ComposerPrimaryActions";
import {
  ComposerWorktreeProgress,
  type ComposerWorktreeProgressValue,
} from "./ComposerWorktreeProgress";
import {
  adoptThreadStopTurn,
  beginThreadForceStop,
  clearThreadForceStop,
  clearThreadStop,
  isThreadStopPending,
  useComposerThreadStopStore,
} from "./composerThreadStop";
import { ComposerRuntimeModePicker } from "./ComposerRuntimeModePicker";
import {
  type ChatComposerControl,
  type ChatComposerOpenMenu,
  type ComposerFooterBlockId,
  createComposerMenuOpenChangeHandlers,
  isComposerMenuTriggerHidden,
  resolveComposerControlMenu,
  resolveComposerOverflowShortcutLabel,
} from "./composerControlMenu";
import { useComposerFooterControlsLayout } from "./useComposerFooterControlsLayout";
import {
  formatComposerMultiModelNotice,
  isSameComposerModel,
  setComposerMultiModelSelections,
  toggleComposerMultiModelSelection,
  useComposerMultiModelStore,
} from "./composerMultiModelStore";
import { ProviderModelPicker } from "./ProviderModelPicker";
import { ContextWindowMeter } from "./ContextWindowMeter";
import { deriveComposerSendState } from "../ChatView.logic";
import {
  renderProviderTraitsMenuContent,
  renderProviderTraitsPicker,
} from "./composerProviderRegistry";
import { readPromptUltrathink } from "./TraitsPicker";
import { ComposerPendingReviewComments } from "./ComposerPendingReviewComments";
import { selectReviewComments, useReviewCommentDraftStore } from "~/reviewCommentDraftStore";
import {
  readComposerThreadPrompt,
  useComposerThreadPrompt,
} from "../../hooks/useComposerDraftSlices";

const loadComposerCommandMenu = () => import("./ComposerCommandMenu");
const ComposerCommandMenu = lazy(() =>
  loadComposerCommandMenu().then((mod) => ({ default: mod.ComposerCommandMenu })),
);

/**
 * Ticks on its own while a turn runs so the per-second timer only re-renders
 * this label instead of the whole composer (or ChatView).
 */
const WorkingStatusLabel = memo(function WorkingStatusLabel(props: {
  active: boolean;
  workingLabel: string | null;
  activeWorkStartedAt: string | null;
  activeContextWindow: ContextWindowSnapshot | null;
  isSendQueued: boolean;
}) {
  const { active, workingLabel, activeWorkStartedAt, activeContextWindow, isSendQueued } = props;
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNowTick(Date.now());
    const timer = window.setInterval(() => {
      setNowTick(Date.now());
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [active]);

  if (workingLabel) {
    return <>{workingLabel}</>;
  }
  const parts: string[] = [];
  const timer = activeWorkStartedAt
    ? formatWorkingTimer(activeWorkStartedAt, new Date(nowTick).toISOString())
    : null;
  if (timer) parts.push(timer);
  const tokens = activeContextWindow?.totalProcessedTokens;
  if (tokens != null && tokens > 0) parts.push(`↑ ${formatContextWindowTokens(tokens)} tokens`);
  const tools = activeContextWindow?.toolUses;
  if (tools != null && tools > 0) parts.push(`${tools} tool${tools === 1 ? "" : "s"}`);
  const verb = WORKING_MESSAGES[Math.floor(nowTick / 30000) % WORKING_MESSAGES.length] ?? "Working";
  if (isSendQueued) parts.push("message queued");
  return <>{parts.length > 0 ? `${verb}… ${parts.join(" · ")}` : `${verb}…`}</>;
});

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export type { ChatComposerControl };

export interface ChatComposerHandle {
  /** Opens a footer control's menu (the compact menu in compact layout); false when it is not shown. */
  openControl: (control: ChatComposerControl) => boolean;
  /** Routes a drop from outside the composer (the chat column) like a drop on the composer. */
  handleDroppedItems: (
    dataTransfer: ComposerDropDataTransfer,
    options?: { replaceSelection?: boolean },
  ) => void;
}

export interface ChatComposerProps {
  ref?: Ref<ChatComposerHandle>;
  // Thread/project identity
  threadId: ThreadId;
  projectId: ProjectId | undefined;
  missingCwd: string | null;
  onMissingCwdResolved: () => void;
  /** Resolves file links in agent question text. */
  markdownCwd?: string | undefined;

  // Working state
  isWorking: boolean;
  /** A message is waiting to send when the running turn ends. */
  isSendQueued: boolean;
  workingLabel: string | null;
  activeWorkStartedAt: string | null;
  activeContextWindow: ContextWindowSnapshot | null;
  /** Compacts on demand from the context meter; absent when the thread cannot. */
  onCompact?: (() => void) | undefined;
  compactDisabledReason?: string | null | undefined;
  phase: SessionPhase;
  isConnecting: boolean;
  isSendBusy: boolean;
  isPreparingWorktree: boolean;
  worktreeProgress?: ComposerWorktreeProgressValue | null | undefined;
  onCancelPreparingWorktree?: (() => void) | undefined;
  onWorkLocallyInstead?: (() => void) | undefined;

  // Provider/model
  selectedProvider: ProviderKind;
  /** Set once the thread has started; the server keeps a thread on one provider. */
  lockedProvider: ProviderKind | null;
  selectedModelForPicker: string;
  /** Raw selected model slug used for the provider traits pickers. */
  selectedModel: string;
  selectedProviderModels: ReadonlyArray<ServerProviderModel>;
  composerModelOptions: ProviderModelOptions | null | undefined;
  providerStatuses: ReadonlyArray<ServerProvider>;
  modelOptionsByProvider: Record<string, ReadonlyArray<ServerProvider["models"][number]>>;
  composerProviderState: ComposerProviderState;
  onProviderModelSelect: (provider: ProviderKind, model: string) => void;
  /** A new thread in a Git project can start on several models, each in its own worktree. */
  multiModelEnabled?: boolean | undefined;
  /** The branch those worktrees start from, shown while several models are selected. */
  multiModelBaseBranch?: string | null | undefined;
  /** Prompt replacement requested by the traits pickers (effort prefix). */
  onTraitsPromptChange: (prompt: string) => void;

  // Prompt editor state (owned by ChatView / draft store). The prompt text itself
  // is subscribed to inside the composer so keystrokes do not re-render ChatView.
  /** Last programmatic caret position; keystrokes do not update it. */
  composerCursor: number;
  /** Bumps on every programmatic caret move, including moves to the same offset. */
  composerCursorRequestId?: number;
  composerTerminalContexts: ReadonlyArray<TerminalContextDraft>;
  composerEditorRef: React.RefObject<ComposerPromptEditorHandle | null>;
  onPromptChange: (
    nextPrompt: string,
    nextCursor: number,
    expandedCursor: number,
    cursorAdjacentToMention: boolean,
    terminalContextIds: string[],
  ) => void;
  // Method syntax: handlers typed for a subset of keys stay assignable.
  onComposerCommandKey(key: ComposerCommandKey, event: KeyboardEvent): boolean;
  /** Pages the chat timeline for PageUp/PageDown the editor does not need. */
  onComposerPageScroll?: (direction: ComposerPageScrollDirection) => void;
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
  /** Declines a non-blocking question; blocking ones must be answered. */
  onDismissPendingUserInput?: ((requestId: ApprovalRequestId) => void) | undefined;

  // Plan follow-up
  showPlanFollowUpPrompt: boolean;
  activeProposedPlan: LatestProposedPlanState | null;

  // Mode controls
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  toggleInteractionMode: () => void;
  handleRuntimeModeChange: (mode: RuntimeMode) => void;
  togglePlanSidebar: () => void;
  planSidebarOpen: boolean;
  activePlan: unknown;
  sidebarProposedPlan: unknown;

  // Submit
  onSend: (e?: { preventDefault: () => void }) => void;
  onInterrupt: () => void;
  onImplementPlanInNewThread: () => void;

  // Layout context
  resolvedTheme: "light" | "dark";
  hasComposerHeader: boolean;
  scheduleStickToBottom: () => void;
  /** Called when files are dropped on the composer. */
  onFileDrop: (files: File[]) => void;
  /** Called on every edit typed into the prompt editor (feeds the typing guard). */
  onComposerEditorTyping?: () => void;
  /** Called when the prompt editor gains or loses focus. */
  onComposerEditorFocusChange?: (focused: boolean) => void;
}

const isComposerEditorEvent = (event: React.FocusEvent<HTMLDivElement>) =>
  event.target instanceof Element && event.target.closest('[data-testid="composer-editor"]');

/**
 * Composer form extracted from ChatView. Owns the drag/drop and compact-layout
 * state so that layout measurement re-renders are contained within the
 * composer instead of propagating to the entire chat view.
 */
export const ChatComposer = memo(function ChatComposer(props: ChatComposerProps) {
  const {
    ref,
    threadId,
    projectId,
    missingCwd,
    onMissingCwdResolved,
    markdownCwd,
    isWorking,
    isSendQueued,
    workingLabel,
    activeWorkStartedAt,
    activeContextWindow,
    onCompact,
    compactDisabledReason,
    phase,
    isConnecting,
    isSendBusy,
    isPreparingWorktree,
    worktreeProgress = null,
    onCancelPreparingWorktree,
    onWorkLocallyInstead,
    selectedProvider,
    lockedProvider,
    selectedModelForPicker,
    selectedModel,
    selectedProviderModels,
    composerModelOptions,
    providerStatuses,
    modelOptionsByProvider,
    composerProviderState,
    onProviderModelSelect,
    multiModelEnabled = false,
    multiModelBaseBranch,
    onTraitsPromptChange,
    composerCursor,
    composerCursorRequestId,
    composerTerminalContexts,
    composerEditorRef,
    onPromptChange,
    onComposerCommandKey,
    onComposerPageScroll,
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
    onDismissPendingUserInput,
    showPlanFollowUpPrompt,
    activeProposedPlan,
    runtimeMode,
    interactionMode,
    toggleInteractionMode,
    handleRuntimeModeChange,
    togglePlanSidebar,
    planSidebarOpen,
    activePlan,
    sidebarProposedPlan,
    onSend,
    onInterrupt,
    onImplementPlanInNewThread,
    resolvedTheme,
    hasComposerHeader,
    scheduleStickToBottom,
    onFileDrop,
    onComposerEditorTyping,
    onComposerEditorFocusChange,
  } = props;

  const activeTurnId = useStore(
    (store) =>
      store.threads.find((thread) => thread.id === threadId)?.session?.activeTurnId ?? null,
  );
  // The pending question panel offers Dismiss on a blocking question a restart left open.
  const threadSession = useStore(
    (store) => store.threads.find((thread) => thread.id === threadId)?.session ?? null,
  );
  const threadStopRequest = useComposerThreadStopStore(
    (store) => store.requestsByThreadId[threadId],
  );
  const isStopPending = isThreadStopPending(threadStopRequest, {
    isRunning: phase === "running",
    activeTurnId,
  });
  useEffect(() => {
    if (!threadStopRequest) return;
    if (!isStopPending) clearThreadStop(threadId);
    else if (threadStopRequest.turnId === null && activeTurnId !== null) {
      adoptThreadStopTurn(threadId, activeTurnId);
    }
  }, [activeTurnId, isStopPending, threadId, threadStopRequest]);
  const onForceStop = () => {
    const api = readNativeApi();
    if (!api || !beginThreadForceStop(threadId)) return;
    void api.orchestration
      .dispatchCommand({
        type: "thread.session.stop",
        commandId: newCommandId(),
        threadId,
        createdAt: new Date().toISOString(),
      })
      .catch((error: unknown) => {
        clearThreadForceStop(threadId);
        toastManager.add({
          type: "error",
          title: "Could not force stop",
          description: error instanceof Error ? error.message : "The stop request failed.",
        });
      });
  };

  const prompt = useComposerThreadPrompt(threadId);
  const reviewCommentCount = useReviewCommentDraftStore(selectReviewComments(threadId)).length;
  const composerSendState = useMemo(
    () =>
      deriveComposerSendState({
        prompt,
        imageCount: composerImages.length,
        terminalContexts: composerTerminalContexts,
      }),
    [composerImages.length, composerTerminalContexts, prompt],
  );
  const composerHasSendableContent = composerSendState.hasSendableContent || reviewCommentCount > 0;
  // Comments alone refine the plan on send, so the button must not promise to implement it.
  const planFollowUpHasContent = prompt.trim().length > 0 || reviewCommentCount > 0;
  const composerFooterHasWideActions =
    showPlanFollowUpPrompt || activePendingProgress !== null || isStopPending;
  const composerFooterActionLayoutKey = useMemo(() => {
    if (activePendingProgress) {
      return `pending:${activePendingProgress.questionIndex}:${activePendingProgress.isLastQuestion}:${activePendingIsResponding}`;
    }
    if (phase === "running") {
      return isStopPending ? "running:stopping" : "running";
    }
    if (showPlanFollowUpPrompt) {
      return planFollowUpHasContent ? "plan:refine" : "plan:implement";
    }
    return `idle:${composerHasSendableContent}:${isSendBusy}:${isConnecting}:${isPreparingWorktree}`;
  }, [
    activePendingIsResponding,
    activePendingProgress,
    composerHasSendableContent,
    isConnecting,
    isPreparingWorktree,
    isSendBusy,
    isStopPending,
    phase,
    planFollowUpHasContent,
    showPlanFollowUpPrompt,
  ]);
  // The traits picker only sees the derived ultrathink state, so it skips re-rendering per keystroke.
  const promptUltrathink = readPromptUltrathink(prompt);
  const editPromptFromTraits = (edit: (current: string) => string) => {
    onTraitsPromptChange(edit(readComposerThreadPrompt(threadId)));
  };
  const traitsInput = {
    provider: selectedProvider,
    threadId,
    model: selectedModel,
    models: selectedProviderModels,
    modelOptions: composerModelOptions?.[selectedProvider],
    promptUltrathink,
    onPromptEdit: editPromptFromTraits,
  };
  const keybindings = useServerKeybindings();
  const modelShortcutLabel = shortcutLabelForCommand(keybindings, "modelPicker.toggle");
  const effortShortcutLabel = shortcutLabelForCommand(keybindings, "composer.effort");
  const modeShortcutLabel = shortcutLabelForCommand(keybindings, "composer.mode");
  const [openMenu, setOpenMenu] = useState<ChatComposerOpenMenu | null>(null);
  // Stable per-menu handlers keep memoized pickers (TraitsPicker) from re-rendering per keystroke.
  const [menuOpenChangeHandlers] = useState(() =>
    createComposerMenuOpenChangeHandlers(setOpenMenu),
  );
  const multiModelSelections = useComposerMultiModelStore((state) =>
    multiModelEnabled ? (state.selectionsByThreadId[threadId] ?? null) : null,
  );
  const onToggleModel = (provider: ProviderKind, model: string) => {
    const primary = { provider: selectedProvider, model: selectedModelForPicker } as ModelSelection;
    const { selections, single } = toggleComposerMultiModelSelection({
      current: multiModelSelections,
      primary,
      toggled: { provider, model },
    });
    setComposerMultiModelSelections(threadId, selections);
    if (single && !isSameComposerModel(single, primary)) {
      onProviderModelSelect(single.provider, single.model);
    }
  };
  const onSingleModelSelect = (provider: ProviderKind, model: string) => {
    setComposerMultiModelSelections(threadId, null);
    onProviderModelSelect(provider, model);
  };
  // Destructured because the React Compiler rejects `ref={result.someRef}`.
  const {
    footerRef: composerFooterRef,
    leadingRef: composerFooterLeadingRef,
    actionsRef: composerFooterActionsRef,
    layout: composerFooterLayout,
  } = useComposerFooterControlsLayout(composerFooterActionLayoutKey);
  const showPlanSidebarControl = Boolean(
    activePlan || sidebarProposedPlan || planSidebarOpen || showPlanFollowUpPrompt,
  );
  const footerBlockIds: ComposerFooterBlockId[] = showPlanSidebarControl
    ? ["traits", "mode", "access", "plan"]
    : ["traits", "mode", "access"];
  const { hidden: hiddenFooterBlocks, iconOnly: iconOnlyFooterBlocks } =
    resolveComposerFooterBlockStates(footerBlockIds, composerFooterLayout);
  const isFooterBlockIconOnly = (block: ComposerFooterBlockId) =>
    iconOnlyFooterBlocks.includes(block);
  const openMenuTriggerHidden =
    openMenu !== null && isComposerMenuTriggerHidden(openMenu, hiddenFooterBlocks);
  // A resize can take the trigger out from under an open menu.
  useEffect(() => {
    if (openMenuTriggerHidden) setOpenMenu(null);
  }, [openMenuTriggerHidden]);
  const menuOpenProps = (menu: ChatComposerOpenMenu) => ({
    open: openMenu === menu && !isComposerMenuTriggerHidden(menu, hiddenFooterBlocks),
    onOpenChange: menuOpenChangeHandlers[menu],
  });
  const providerTraitsMenuContent = renderProviderTraitsMenuContent(traitsInput);
  const providerTraitsPicker = renderProviderTraitsPicker({
    ...traitsInput,
    ...menuOpenProps("effort"),
    triggerTitle: effortShortcutLabel ? `Change effort (${effortShortcutLabel})` : undefined,
    iconOnly: isFooterBlockIconOnly("traits"),
  });
  const renderFooterBlock = (block: ComposerFooterBlockId, content: ReactNode) => {
    const hidden = hiddenFooterBlocks.includes(block);
    return (
      <div
        data-composer-footer-block={block}
        aria-hidden={hidden || undefined}
        inert={hidden || undefined}
        className={cn(
          "flex w-max shrink-0 items-center",
          hidden && "pointer-events-none invisible absolute start-0 top-0",
        )}
      >
        {content}
      </div>
    );
  };
  const composerSuggestionListId = `${useId()}-suggestions`;
  // The editor's aria-activedescendant must name a mounted option, so load the menu before it first opens.
  const [commandMenuLoaded, setCommandMenuLoaded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void loadComposerCommandMenu().then(() => {
      if (!cancelled) setCommandMenuLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const composerSuggestionListVisible =
    commandMenuLoaded && composerMenuOpen && composerMenuItems.length > 0;
  const preparingComposerImages = usePreparingComposerImages(threadId);

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
  // Folders and files other than images go in as @path mentions in the desktop app. That includes a
  // dropped PDF, on purpose: the agent reads it where it is, and the attach button still sends one.
  const insertDroppedPathMentions = (
    items: File[],
    options?: { replaceSelection?: boolean },
  ): File[] => {
    const getPathForFile = window.desktopBridge?.getPathForFile;
    const paths: string[] = [];
    const unresolved: File[] = [];
    for (const item of items) {
      const path = resolveComposerDroppedPath(item, getPathForFile);
      if (path === null) {
        unresolved.push(item);
      } else {
        paths.push(toComposerMentionPath(path, markdownCwd));
      }
    }
    if (paths.length > 0) {
      // A claimed paste replaces the selection, like every other paste; a drop does not.
      if (options?.replaceSelection) composerEditorRef.current?.deleteSelection();
      const snapshot = composerEditorRef.current?.readSnapshot() ?? {
        value: prompt,
        cursor: collapseExpandedComposerCursor(prompt, prompt.length),
        expandedCursor: prompt.length,
        terminalContextIds: composerTerminalContexts.map((context) => context.id),
      };
      const next = insertComposerPathMentions(snapshot.value, snapshot.expandedCursor, paths);
      const nextCursor = collapseExpandedComposerCursor(next.text, next.cursor);
      onPromptChange(
        next.text,
        nextCursor,
        expandCollapsedComposerCursor(next.text, nextCursor),
        false,
        snapshot.terminalContextIds,
      );
      window.requestAnimationFrame(() => composerEditorRef.current?.focusAt(nextCursor));
    }
    return unresolved;
  };
  const handleDroppedItems = (
    dataTransfer: ComposerDropDataTransfer,
    options?: { replaceSelection?: boolean },
  ) => {
    const { files, folders } = splitComposerDroppedItems(dataTransfer);
    // The editor is hidden while a question is open; the attach path explains why.
    if (activePendingUserInput) {
      onFileDrop([...files, ...folders]);
      return;
    }
    const images = files.filter(isComposerImageFile);
    const otherFiles = files.filter((file) => !isComposerImageFile(file));
    const unresolved = insertDroppedPathMentions([...folders, ...otherFiles], options);
    for (const folder of unresolved.filter((item) => folders.includes(item))) {
      toastManager.add({
        type: "error",
        title: `Couldn't get the path of "${folder.name}"`,
        description: "Type the folder path with @ instead.",
      });
    }
    const filesForAttach = [...images, ...unresolved.filter((item) => !folders.includes(item))];
    if (filesForAttach.length > 0) onFileDrop(filesForAttach);
  };
  const onComposerDrop = (event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    dragDepthRef.current = 0;
    setIsDragOverComposer(false);
    handleDroppedItems(event.dataTransfer);
  };

  const onEditorChange: ChatComposerProps["onPromptChange"] = (...args) => {
    onComposerEditorTyping?.();
    onPromptChange(...args);
  };

  // ---------- Compact layout detection (local) ----------
  const [isComposerPrimaryActionsCompact, setIsComposerPrimaryActionsCompact] = useState(false);
  const composerFormRef = useRef<HTMLFormElement>(null);
  const composerFormHeightRef = useRef(0);

  useLayoutEffect(() => {
    const composerForm = composerFormRef.current;
    if (!composerForm) return;
    const measurePrimaryActionsCompact = () =>
      shouldUseCompactComposerPrimaryActions(composerForm.clientWidth, {
        hasWideActions: composerFooterHasWideActions,
      });

    composerFormHeightRef.current = composerForm.getBoundingClientRect().height;
    setIsComposerPrimaryActionsCompact(measurePrimaryActionsCompact());
    if (typeof ResizeObserver === "undefined") return;

    const shouldAutoScrollRef = { current: true };
    const observer = new ResizeObserver((entries) => {
      const [entry] = entries;
      if (!entry) return;
      setIsComposerPrimaryActionsCompact(measurePrimaryActionsCompact());
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
  }, [threadId, composerFooterHasWideActions, scheduleStickToBottom]);

  // The footer controls are hidden while an approval or a question is pending.
  const footerControlsShown =
    !activePendingApproval && !activePendingUserInput && !(missingCwd && projectId);
  useImperativeHandle(ref, () => ({
    openControl: (control) => {
      // A second modelPicker.toggle press closes the open picker.
      if (control === "model" && openMenu === "model") {
        setOpenMenu(null);
        return true;
      }
      const menu = resolveComposerControlMenu({
        control,
        footerControlsShown,
        hiddenBlocks: hiddenFooterBlocks,
        hasTraitsPicker: providerTraitsPicker != null,
      });
      if (menu === null) return false;
      setOpenMenu(menu);
      return true;
    },
    handleDroppedItems,
  }));

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
          className="mx-auto w-full min-w-0 max-w-(--chat-composer-max-width)"
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
                        <WorkingStatusLabel
                          active={phase === "running"}
                          workingLabel={workingLabel}
                          activeWorkStartedAt={activeWorkStartedAt}
                          activeContextWindow={activeContextWindow}
                          isSendQueued={isSendQueued}
                        />
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
                    cwd={markdownCwd}
                    respondingRequestIds={respondingRequestIds}
                    answers={activePendingDraftAnswers}
                    questionIndex={activePendingQuestionIndex}
                    onSelectOption={onSelectActivePendingUserInputOption}
                    onCustomAnswer={(_questionId: string, text: string) =>
                      onPromptChange(text, text.length, text.length, false, [])
                    }
                    onAdvance={onAdvanceActivePendingUserInput}
                    onDismiss={onDismissPendingUserInput}
                    isTurnRunning={phase === "running"}
                    session={threadSession}
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
                onFocusCapture={(event) => {
                  if (isComposerEditorEvent(event)) onComposerEditorFocusChange?.(true);
                }}
                onBlurCapture={(event) => {
                  if (isComposerEditorEvent(event)) onComposerEditorFocusChange?.(false);
                }}
                className={cn(
                  "relative px-3 sm:px-4",
                  activePendingUserInput
                    ? "pb-1 pt-1.5"
                    : cn("pb-2", hasComposerHeader ? "pt-2.5 sm:pt-3" : "pt-3.5 sm:pt-4"),
                )}
              >
                <div role="status" aria-atomic="true" className="sr-only">
                  {composerSuggestionStatusMessage({
                    menuOpen: composerMenuOpen,
                    itemCount: composerMenuItems.length,
                    triggerKind: composerTriggerKind,
                    isLoading: isComposerMenuLoading,
                  })}
                </div>
                {composerMenuOpen && (
                  <div className="absolute inset-x-0 bottom-full z-20 mb-2 px-1">
                    <Suspense fallback={null}>
                      <ComposerCommandMenu
                        listId={composerSuggestionListId}
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

                {pendingUserInputs.length === 0 && (
                  <ComposerPendingReviewComments threadId={threadId} className="mb-1.5" />
                )}

                {pendingUserInputs.length === 0 && (
                  <ComposerImageTiles
                    threadId={threadId}
                    images={composerImages}
                    preparingImages={preparingComposerImages}
                    nonPersistedImageIds={nonPersistedComposerImageIdSet}
                    onRemoveImage={onRemoveComposerImage}
                    onExpandImage={onExpandImage}
                  />
                )}
                {/* Hide the rich editor during user-input questions —
                the inline input in the question panel handles custom answers. */}
                {!activePendingUserInput && (
                  <ComposerPromptEditor
                    ref={composerEditorRef}
                    ariaLabel="Message"
                    suggestionListId={composerSuggestionListId}
                    activeSuggestionId={
                      composerSuggestionListVisible && activeComposerMenuItem
                        ? composerSuggestionOptionId(
                            composerSuggestionListId,
                            activeComposerMenuItem.id,
                          )
                        : undefined
                    }
                    value={prompt}
                    cursor={composerCursor}
                    {...(composerCursorRequestId !== undefined
                      ? { cursorRequestId: composerCursorRequestId }
                      : {})}
                    terminalContexts={composerTerminalContexts}
                    onRemoveTerminalContext={removeComposerTerminalContextFromDraft}
                    onChange={onEditorChange}
                    onCommandKeyDown={onComposerCommandKey}
                    {...(onComposerPageScroll ? { onPageScroll: onComposerPageScroll } : {})}
                    onPaste={onComposerPaste}
                    placeholder={
                      isComposerApprovalState
                        ? "Send a message to decline and redirect the agent"
                        : showPlanFollowUpPrompt && activeProposedPlan
                          ? reviewCommentCount > 0
                            ? "Add feedback to send with your comments"
                            : "Add feedback to refine the plan, or leave this blank to implement it"
                          : phase === "disconnected"
                            ? "Ask for follow-up changes or attach images"
                            : "Ask anything, @tag files/folders, or use / to show available commands"
                    }
                    disabled={isConnecting}
                  />
                )}
              </div>

              {multiModelSelections ? (
                <div
                  data-composer-multi-model-notice="true"
                  className="truncate px-3 pb-1 text-muted-foreground text-xs sm:px-4"
                >
                  {formatComposerMultiModelNotice(
                    multiModelSelections.length,
                    multiModelBaseBranch,
                  )}
                </div>
              ) : null}

              {/* Bottom toolbar */}
              {activePendingApproval ? (
                <div className="flex flex-wrap items-center justify-end gap-2 px-2.5 pb-2.5 sm:px-3 sm:pb-3">
                  <ComposerApprovalRedirectSendButton
                    hasSendableContent={composerHasSendableContent}
                    disabled={
                      respondingRequestIds.includes(activePendingApproval.requestId) ||
                      isSendBusy ||
                      isConnecting
                    }
                  />
                  <ComposerPendingApprovalActions
                    requestId={activePendingApproval.requestId}
                    isResponding={respondingRequestIds.includes(activePendingApproval.requestId)}
                    noStandingGrant={activePendingApproval.noStandingGrant === true}
                    onRespondToApproval={onRespondToApproval}
                  />
                </div>
              ) : (
                <div
                  ref={composerFooterRef}
                  data-chat-composer-footer="true"
                  className={cn(
                    "flex min-w-0 flex-nowrap items-center gap-2 overflow-visible px-2 pb-1.5 sm:px-2.5 sm:pb-2",
                    activePendingUserInput ? "justify-end" : "justify-between",
                  )}
                >
                  <div
                    ref={composerFooterLeadingRef}
                    className={cn(
                      "relative -m-1 flex min-w-0 flex-1 items-center gap-1 p-1",
                      // Nothing is left to collapse, so scrolling is what keeps the menu reachable.
                      hiddenFooterBlocks.length === footerBlockIds.length
                        ? "overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                        : "overflow-hidden",
                      activePendingUserInput && "hidden",
                    )}
                  >
                    <ComposerAttachButton disabled={isConnecting} onFiles={onFileDrop} />
                    {/* Provider/model picker */}
                    <ProviderModelPicker
                      provider={selectedProvider}
                      model={selectedModelForPicker}
                      lockedProvider={lockedProvider}
                      providers={providerStatuses}
                      modelOptionsByProvider={modelOptionsByProvider}
                      {...(composerProviderState.modelPickerIconClassName
                        ? {
                            activeProviderIconClassName:
                              composerProviderState.modelPickerIconClassName,
                          }
                        : {})}
                      {...menuOpenProps("model")}
                      shortcutLabel={modelShortcutLabel}
                      onProviderModelChange={onSingleModelSelect}
                      selectedModels={multiModelSelections ?? undefined}
                      onToggleModel={multiModelEnabled ? onToggleModel : undefined}
                    />

                    {renderFooterBlock("traits", providerTraitsPicker)}

                    {renderFooterBlock(
                      "mode",
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
                              : "Agent mode \u2014 click to enter plan mode"
                        }
                        {...(isFooterBlockIconOnly("mode")
                          ? {
                              "aria-label":
                                interactionMode === "plan"
                                  ? "Plan mode"
                                  : interactionMode === "ask"
                                    ? "Ask mode"
                                    : "Agent mode",
                            }
                          : {})}
                      >
                        <BotIcon />
                        <span
                          data-composer-control-label
                          className={cn(
                            isFooterBlockIconOnly("mode") && COMPOSER_ICON_ONLY_LABEL_CLASS_NAME,
                          )}
                        >
                          {interactionMode === "plan"
                            ? "Plan"
                            : interactionMode === "ask"
                              ? "Ask"
                              : "Agent"}
                        </span>
                      </Button>,
                    )}

                    {renderFooterBlock(
                      "access",
                      <ComposerRuntimeModePicker
                        runtimeMode={runtimeMode}
                        onRuntimeModeChange={handleRuntimeModeChange}
                        shortcutLabel={modeShortcutLabel}
                        iconOnly={isFooterBlockIconOnly("access")}
                        {...menuOpenProps("mode")}
                      />,
                    )}

                    {showPlanSidebarControl
                      ? renderFooterBlock(
                          "plan",
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
                            {...(isFooterBlockIconOnly("plan")
                              ? {
                                  "aria-label": planSidebarOpen
                                    ? "Hide plan sidebar"
                                    : "Show plan sidebar",
                                }
                              : {})}
                          >
                            <ListTodoIcon />
                            <span
                              data-composer-control-label
                              className={cn(
                                isFooterBlockIconOnly("plan") &&
                                  COMPOSER_ICON_ONLY_LABEL_CLASS_NAME,
                              )}
                            >
                              Plan
                            </span>
                          </Button>,
                        )
                      : null}

                    {/* Stays mounted so its width is known before the first control overflows. */}
                    <div
                      data-composer-footer-overflow
                      aria-hidden={hiddenFooterBlocks.length === 0 || undefined}
                      inert={hiddenFooterBlocks.length === 0 || undefined}
                      className={cn(
                        "w-max shrink-0",
                        hiddenFooterBlocks.length === 0 &&
                          "pointer-events-none invisible absolute start-0 top-0",
                      )}
                    >
                      <CompactComposerControlsMenu
                        activePlan={hiddenFooterBlocks.includes("plan")}
                        interactionMode={interactionMode}
                        planSidebarOpen={planSidebarOpen}
                        runtimeMode={runtimeMode}
                        traitsMenuContent={
                          hiddenFooterBlocks.includes("traits")
                            ? providerTraitsMenuContent
                            : undefined
                        }
                        showInteractionMode={hiddenFooterBlocks.includes("mode")}
                        showRuntimeMode={hiddenFooterBlocks.includes("access")}
                        onToggleInteractionMode={toggleInteractionMode}
                        onTogglePlanSidebar={togglePlanSidebar}
                        onRuntimeModeChange={handleRuntimeModeChange}
                        shortcutLabel={resolveComposerOverflowShortcutLabel({
                          hiddenBlocks: hiddenFooterBlocks,
                          effortShortcutLabel,
                          modeShortcutLabel,
                        })}
                        {...menuOpenProps("compact")}
                      />
                    </div>
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
                      <ContextWindowMeter
                        usage={activeContextWindow}
                        onCompact={onCompact}
                        compactDisabledReason={compactDisabledReason}
                      />
                    ) : null}
                    {isPreparingWorktree ? (
                      <ComposerWorktreeProgress
                        progress={worktreeProgress}
                        onCancel={onCancelPreparingWorktree}
                        onWorkLocally={onWorkLocallyInstead}
                      />
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
                      promptHasText={planFollowUpHasContent}
                      isSendBusy={isSendBusy}
                      isConnecting={isConnecting}
                      isPreparingWorktree={isPreparingWorktree}
                      onPreviousPendingQuestion={onPreviousActivePendingUserInputQuestion}
                      onInterrupt={onInterrupt}
                      stopRequestedAtMs={
                        isStopPending && threadStopRequest ? threadStopRequest.requestedAtMs : null
                      }
                      forceStopRequestedAtMs={
                        isStopPending ? (threadStopRequest?.forceStopRequestedAtMs ?? null) : null
                      }
                      onForceStop={onForceStop}
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
