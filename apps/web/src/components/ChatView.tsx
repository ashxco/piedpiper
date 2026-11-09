import { takeThreadFiles, usePendingThreadFiles } from "../pendingThreadFiles";
import { useOpenToolDiff } from "../hooks/useOpenToolDiff";
import { usePromptStashStore, type PromptStashEntry } from "../promptStashStore";
import { hydrateImagesFromPersisted } from "../lib/composerAttachmentNormalization";
import { shouldAttachPastedText, nextPastedTextFileName } from "../lib/pastedText";
import { useComposerContextStore } from "../composerContextStore";
import {
  type ApprovalRequestId,
  DEFAULT_MODEL_BY_PROVIDER,
  type MessageId,
  type ModelSelection,
  type ProjectScript,
  type ProviderKind,
  type ProjectEntry,
  type ProjectId,
  type ProviderApprovalDecision,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  PROVIDER_SEND_TURN_MAX_TOTAL_IMAGE_BYTES,
  PROVIDER_DISPLAY_NAMES,
  type ServerProvider,
  type ThreadId,
  type TurnId,
  OrchestrationThreadActivity,
  ProviderInteractionMode,
  RuntimeMode,
  TerminalOpenInput,
  type TerminalSessionSnapshot,
} from "@piedpiper/contracts";
import { normalizeModelSlug } from "@piedpiper/shared/model";
import { isProviderSendTurnSupportedImageMimeType } from "@piedpiper/shared/attachments";
import { truncate } from "@piedpiper/shared/String";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { gitStatusQueryOptions } from "~/lib/gitReactQuery";
import { buildAssistantQuoteInsertion } from "~/lib/assistantTextSelection";
import { projectSearchEntriesQueryOptions } from "~/lib/projectReactQuery";
import { isElectron } from "../env";
import { parseDiffRouteSearch, stripDiffSearchParams } from "../diffRouteSearch";
import {
  clampCollapsedComposerCursor,
  type ComposerTrigger,
  collapseExpandedComposerCursor,
  detectComposerTrigger,
  expandCollapsedComposerCursor,
  composerStateAtPromptEnd,
  isStandaloneUsageLimitsSlashCommand,
  parseStandaloneComposerSlashCommand,
  replaceTextRange,
} from "../composer-logic";
import {
  type ComposerListEdit,
  listContinuationForEnter,
  listIndentForTab,
  listOutdentForTab,
} from "../composer-list-continuation";
import { serializeComposerMentionPath } from "../composer-editor-mentions";
import {
  deriveCompletionDividerBeforeEntryId,
  derivePhase,
  deriveTimelineEntries,
  deriveActiveWorkStartedAt,
  deriveActivePlanState,
  findSidebarProposedPlan,
  findLatestProposedPlan,
  hasActionableProposedPlan,
  hasHeldAnswerAwaitingDelivery,
  isPendingUserInputAwaitingUser,
  isLatestTurnSettled,
  formatElapsed,
} from "../session-logic";
import { getSmoothScrollBehavior, isScrollContainerNearBottom } from "../chat-scroll";
import {
  buildPendingUserInputAnswers,
  carryDisplacedCustomAnswerIntoPrompt,
  derivePendingUserInputProgress,
  selectPendingUserInputOption,
  setPendingUserInputCustomAnswer,
  type PendingUserInputDraftAnswer,
} from "../pendingUserInput";
import { useStore } from "../store";
import { useProjectById, useThreadById, useUserProjects } from "../storeSelectors";
import { useUiStateStore } from "../uiStateStore";
import {
  buildPlanImplementationThreadTitle,
  buildPlanImplementationPrompt,
  resolvePlanFollowUpSubmission,
} from "../proposedPlan";
import {
  DEFAULT_INTERACTION_MODE,
  DEFAULT_THREAD_TERMINAL_ID,
  MAX_TERMINALS_PER_GROUP,
  type ChatMessage,
  type TurnDiffSummary,
} from "../types";

import { basenameOfPath } from "../vscode-icons";
import { useLocalDispatchState } from "../hooks/useLocalDispatchState";
import { useComposerSession } from "../hooks/useComposerSession";
import { useComposerPromptHistory } from "../hooks/useComposerPromptHistory";
import { useTheme } from "../hooks/useTheme";
import { useThreadPlanCatalog } from "../hooks/useThreadPlanCatalog";
import { useToolInputPreviewSubscription } from "../hooks/useToolInputPreviewSubscription";
import { useTurnDiffSummaries } from "../hooks/useTurnDiffSummaries";
import {
  isComposerControlCommand,
  isRepeatedTerminalCloseShortcut,
  isTerminalCloseShortcut,
  resolveContextualShortcutOutcome,
  resolveShortcutCommand,
  shortcutLabelForCommand,
} from "../keybindings";
import {
  confirmTerminalCloseIfRunning,
  isTerminalCloseConfirmPending,
} from "../terminalCloseConfirmation";
import { NewThreadLanding } from "./chat/NewThreadLanding";
import { deriveThreadActivityStatus } from "./chat/threadActivityAnnouncement";
import { useThreadActivityAnnouncer } from "./chat/useThreadActivityAnnouncer";
import { ChatComposer, type ChatComposerHandle } from "./chat/ChatComposer";
import { ChatPlanPanel, type ChatPlanPanelHandle } from "./chat/ChatPlanPanel";
import { ChatTerminalSection } from "./chat/ChatTerminalSection";
import { ChevronDownIcon, PaperclipIcon } from "lucide-react";
import { handleWorkspaceFileDragEvent } from "./chat/workspaceFileDrop";
import { splitComposerDroppedItems } from "./chat/composerFolderDrop";
import { getComposerPromptLengthValidationMessage } from "./chat/composerSubmission";
import { isComposerModifierKeyPressed, shouldComposerEnterSend } from "./chat/composerSendShortcut";
import { cn, randomUUID } from "~/lib/utils";
import { getWsRpcClient } from "../wsRpcClient";
import { toastManager } from "./ui/toast";
import {
  projectScriptCwd,
  projectScriptRuntimeEnv,
  projectScriptIdFromCommand,
  projectScriptTerminalInput,
  setupProjectScript,
} from "~/projectScripts";
import { BranchToolbarMismatchNotice } from "./BranchToolbarMismatchNotice";
import { beginThreadStop, clearThreadStop } from "./chat/composerThreadStop";
import {
  buildThreadMessageRevealPosition,
  takeThreadMessageReveal,
  useThreadMessageRevealRequestId,
} from "./sidebar/threadMessageReveal";
import { SnoozedThreadBanner } from "./sidebar/SnoozedThreadBanner";
import { isInsideConfirmationDialog } from "../lib/confirmationDialogGuard";
import { workspaceAreaProps } from "../lib/workspaceFocus";
import { appendReviewCommentsToPrompt } from "~/reviewCommentContext";
import { selectReviewComments, useReviewCommentDraftStore } from "~/reviewCommentDraftStore";
import { resolveThreadBranchUpdateForNextTurn } from "./BranchToolbar.logic";
import { requestDiffFileReveal } from "../diffFileRevealStore";
import { newCommandId, newMessageId, newProjectId, newThreadId } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import { useArmedUsageLimitResume } from "~/hooks/useArmedUsageLimitResume";
import {
  findExistingProjectByPath,
  findExistingProjectFromCreateError,
  resolveCreatedProjectId,
} from "~/hooks/useAddProjectFromPath";
import { useHandleNewThread } from "~/hooks/useHandleNewThread";
import { isDiffFindChord, isDiffFindEvent } from "~/lib/diffFind";
import { dispatchProjectArchived, isProjectArchived } from "~/lib/projectArchive";
import { terminalNumberLabelById } from "~/lib/terminalNumbering";
import { useStableCallback } from "~/hooks/useStableCallback";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { normalizeThreadActionError, threadErrorToastTitle } from "~/rpc/transportError";
import { getProviderModels, resolveSelectableProvider } from "../providerModels";
import { useSettings } from "../hooks/useSettings";
import { resolveAppModelSelection } from "../modelSelection";
import { isCommandSurfaceOpen } from "../filePickerStore";
import { isRestartContinuationMessageId } from "../lib/restartContinuation";
import { isTerminalFocused } from "../lib/terminalFocus";
import {
  type ComposerImageAttachment,
  type DraftThreadEnvMode,
  deriveEffectiveComposerModelState,
  composerDraftHasUserContent,
  moveFailedFirstSendToDraftThread,
  useComposerDraftStore,
} from "../composerDraftStore";
import {
  readComposerThreadPrompt,
  subscribeComposerThreadPrompt,
  useComposerProviderStatePrompt,
  useComposerThreadDraftWithoutPrompt,
} from "../hooks/useComposerDraftSlices";
import {
  insertInlineTerminalContextPlaceholder,
  removeInlineTerminalContextPlaceholder,
  type TerminalContextDraft,
  type TerminalContextSelection,
} from "../lib/terminalContext";
import { deriveLatestContextWindowSnapshot } from "../lib/contextWindow";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { allocateTerminalId, useTerminalTabStateStore } from "../terminalTabStateStore";
import {
  type ComposerCommandKey,
  type ComposerPromptEditorHandle,
  isImeComposingKeyboardEvent,
} from "./ComposerPromptEditor";
import { PullRequestThreadDialog } from "./PullRequestThreadDialog";
import { AssistantSelectionToolbar } from "./chat/AssistantSelectionToolbar";
import { MessagesTimeline } from "./chat/MessagesTimeline";
import { deriveModelSwitchLabelByMessageId } from "./chat/MessagesTimeline.logic";
import { ChatHeader } from "./chat/ChatHeader";
import { ProviderUsageLimitsPanel } from "./chat/ProviderUsageLimits";
import { UsageLimitResumeBanner } from "./chat/UsageLimitResumeBanner";
import { openThreadFind } from "./chat/threadFindStore";
import {
  readComposerMultiModelSelections,
  setComposerMultiModelSelections,
  useComposerMultiModelStore,
} from "./chat/composerMultiModelStore";
import { useWorktreeBaseBranch } from "./BranchToolbarWorktreeBase";
import { isModelHiddenWhileBrowsing } from "./chat/ProviderModelPicker.logic";
import { sendComposerMultiModel } from "./chat/composerMultiModelSend";
import { runComposerSingleSend } from "./chat/composerSingleSend";
import { useComposerWorktreeCreation } from "../hooks/useComposerWorktreeCreation";
import { useThreadFindStore } from "./chat/threadFindStore";
import { TooltipScrollDismissArea } from "./ui/tooltip";
import { refreshProviderStatuses } from "./chat/ProviderStatusBanner";
import {
  clearThreadErrorDismissalsForThread,
  dismissThreadErrorForSession,
  isThreadErrorDismissedForSession,
  parseStructuredThreadErrorMessage,
  ThreadErrorDetails,
  undismissThreadErrorForSession,
} from "./chat/ThreadErrorBanner";
import { useComposerTriggerState } from "./chat/composerTriggerState";
import { canBrowseComposerPromptHistory } from "./chat/composerPromptHistory";
import {
  type ComposerPageScrollDirection,
  scrollTimelineByComposerPage,
} from "./chat/composerPageScrollKeys";
import { useComposerTypingGuard } from "./chat/useComposerTypingGuard";
import { withoutHeldComposerRequests } from "./chat/composerTypingGuard";
import {
  composerApprovalRedirectToast,
  redirectPendingApprovals,
} from "./chat/composerApprovalRedirect";
import type { ComposerCommandItem } from "./chat/ComposerCommandMenu";
import {
  buildComposerFileAttachment,
  readFileAsDataUrl,
  buildExpiredTerminalContextToastCopy,
  buildLocalDraftThread,
  cloneComposerImageForRetry,
  collectUserMessageBlobPreviewUrls,
  composerSendFollowUpRequiresModifier,
  getPlanImplementationLengthValidationMessage,
  deriveComposerSendState,
  deriveQaCardMessages,
  dropAsyncAnswerMessagesWithQaCards,
  LAST_INVOKED_SCRIPT_BY_PROJECT_KEY,
  LastInvokedScriptByProjectSchema,
  PullRequestDialogState,
  revokeBlobPreviewUrl,
  serializeComposerImages,
  restorePlanFollowUpComposer,
  revokeUserMessagePreviewUrls,
  buildDraftOptionsAfterBackgroundSend,
  type ComposerSendFollowUp,
  keyboardEventTargetElement,
  resolveComposerSendFollowUp,
  shouldRefocusComposerOnWindowFocus,
  queuedSendAfterImageFit,
  resolveQueuedSendFollowUp,
  pasteTextToFocusComposer,
  shouldClaimComposerFilePaste,
  shouldTypeToFocusComposer,
  TYPE_TO_FOCUS_FLOATING_LAYER_SELECTOR,
  threadHasStarted,
  waitForStartedServerThread,
  isComposerMenuOpen,
  isComposerFileAttachment,
  isComposerTextFile,
  isComposerPdfFile,
  isPathSuggestionCurrent,
  resolveCompactDisabledReason,
  shouldRestoreComposerAfterFailedSend,
  visiblePathSearchEntries,
  buildComposerOutgoingMessageText,
  findReusableProjectScriptTerminal,
  type PullRequestSetupRequest,
  resolvePullRequestSetupRequest,
  buildOptimisticUserMessage,
  buildSearchableModelOptions,
  buildThreadCreateModelSelection,
  buildTurnStartImageAttachments,
  buildCheckpointRevertCommand,
  canInterruptRunningTurn,
  chatEmptyStateHeading,
  COMPOSER_ATTACHMENT_TOTAL_SIZE_ERROR,
  COMPOSER_IMAGE_TOTAL_SIZE_ERROR,
  estimateComposerImageBudgetBytes,
  nextRuntimeModeInCycle,
  takeComposerImagesWithinTotalBudget,
  deriveSendThreadTitle,
  formatOutgoingPrompt,
  resolveUnlockedComposerProvider,
  ComposerSendCancelledError,
  resolveFailedSendErrorMessage,
  resolveWorktreeSendPlan,
  type ComposerPathSearchTarget,
} from "./ChatView.logic";
import {
  captureTimelinePosition,
  expandedWorkGroupsFromPosition,
  scrollTimelineRowToStart,
  stepTimelinePositionRestore,
  timelinePositionCache,
} from "./ChatView.timelinePosition";
import { shellSignalsReadiness, watchShellReadiness } from "./ChatView.shellReadiness";
import { RevertCheckpointDialog, type RevertCheckpointDialogState } from "./ChatView.revertDialog";
import {
  buildRevertedComposerImages,
  fetchRevertedMessageImages,
  isThreadReverting,
  mergeRevertedPrompt,
  restorableReviewComments,
  revertedImagesFitDraft,
  setThreadReverting,
  unrestoredImagesToast,
  useIsThreadReverting,
  waitForRevertedMessage,
} from "./ChatView.revertRestore";
import { providerStatusNoticeTracker } from "./ChatView.providerStatusNotice";
import { ComposerMenuFocusContext } from "./ChatView.composerMenuFocus";
import { resolveThreadReferenceCopyTarget } from "./ChatView.threadReference";
import {
  claudeSlashCommandsQueryOptions,
  CODEX_COMPOSER_PROVIDER_COMMANDS,
  LOCAL_COMPOSER_SLASH_COMMAND_NAMES,
} from "./ChatView.providerCommands";
import { deriveThreadGoal, ThreadGoalRow } from "./ChatView.threadGoal";
import {
  pendingUserInputDraftKey,
  usePendingUserInputDraftStore,
} from "./ChatView.pendingUserInputDrafts";
import {
  ExpandedImageDialog,
  isExpandedImageOpen,
  useExpandedImageStore,
} from "./ChatView.expandedImage";
import {
  isComposerImageFile,
  isHeicImageFile,
  MAX_HEIC_DECODE_PIXELS,
  prepareComposerImageAttachment,
} from "./ChatView.heicImage";
import {
  addPreparingComposerImages,
  countPreparingComposerImages,
  createPreparingComposerImage,
  keepStillPreparingImages,
  removePreparingComposerImages,
  usePreparingComposerImages,
} from "./ChatView.preparingImages";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import {
  canOfferProviderCommands,
  type ComposerProviderCommand,
  filterComposerProviderCommands,
  providerCommandInsertion,
} from "~/lib/composerProviderCommands";
import {
  useServerAvailableEditors,
  useServerConfig,
  useServerKeybindings,
} from "~/rpc/serverState";

/** Provider status toast with a Refresh action that re-probes providers in place. */
function addProviderStatusToast(input: {
  type: "error" | "warning";
  title: string;
  description: string;
}): string {
  const refreshAction = {
    children: "Refresh",
    onClick: () => {
      toastManager.update(toastId, {
        actionProps: { children: "Refreshing...", disabled: true },
      });
      void refreshProviderStatuses().finally(() => {
        toastManager.update(toastId, { actionProps: refreshAction });
      });
    },
  };
  // No auto-dismiss: the tracker closes it once the status recovers, so Refresh stays reachable.
  const toastId: string = toastManager.add({ ...input, timeout: 0, actionProps: refreshAction });
  return toastId;
}

// Outside the component because the React Compiler skips a component with a throw inside a try.
function failRevertForImageRoom(): never {
  throw new Error("Make room for this message's images in the composer before reverting.");
}

const ATTACHMENT_PREVIEW_HANDOFF_TTL_MS = 5000;
const TIMELINE_POSITION_RESTORE_MAX_FRAMES = 30;
const IMAGE_SIZE_LIMIT_LABEL = `${Math.round(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES / (1024 * 1024))}MB`;
const FILE_SIZE_LIMIT_LABEL = `${Math.round(PROVIDER_SEND_TURN_MAX_FILE_BYTES / (1024 * 1024))}MB`;
const EMPTY_ACTIVITIES: OrchestrationThreadActivity[] = [];
const EMPTY_PROJECT_ENTRIES: ProjectEntry[] = [];
const EMPTY_PROVIDERS: ServerProvider[] = [];
const EMPTY_PROVIDER_COMMANDS: ReadonlyArray<ComposerProviderCommand> = [];
const EMPTY_PENDING_USER_INPUT_ANSWERS: Record<string, PendingUserInputDraftAnswer> = {};

const COMPOSER_PATH_QUERY_DEBOUNCE_MS = 120;
const COMPOSER_EDITOR_SELECTOR = '[data-testid="composer-editor"]';
const SCRIPT_TERMINAL_COLS = 120;
const SCRIPT_TERMINAL_ROWS = 30;

const extendReplacementRangeForTrailingSpace = (
  text: string,
  rangeEnd: number,
  replacement: string,
): number => {
  if (!replacement.endsWith(" ")) {
    return rangeEnd;
  }
  return text[rangeEnd] === " " ? rangeEnd + 1 : rangeEnd;
};

const syncTerminalContextsByIds = (
  contexts: ReadonlyArray<TerminalContextDraft>,
  ids: ReadonlyArray<string>,
): TerminalContextDraft[] => {
  const contextsById = new Map(contexts.map((context) => [context.id, context]));
  return ids.flatMap((id) => {
    const context = contextsById.get(id);
    return context ? [context] : [];
  });
};

const terminalContextIdListsEqual = (
  contexts: ReadonlyArray<TerminalContextDraft>,
  ids: ReadonlyArray<string>,
): boolean =>
  contexts.length === ids.length && contexts.every((context, index) => context.id === ids[index]);

interface ChatViewProps {
  threadId: ThreadId;
}

// Reads the latest store state so two fast creations cannot get the same id.
function allocateThreadTerminalId(threadId: ThreadId): string {
  const { terminalStateByThreadId } = useTerminalStateStore.getState();
  return allocateTerminalId(
    threadId,
    selectThreadTerminalState(terminalStateByThreadId, threadId).terminalIds,
  );
}

/** Module-level so the React Compiler need not handle try/catch inside the component. */
async function pickProjectAndStartThread(
  projects: readonly {
    readonly id: ProjectId;
    readonly cwd: string;
    readonly archivedAt?: string | null | undefined;
  }[],
  startThread: (projectId: ProjectId) => unknown,
): Promise<void> {
  const api = readNativeApi();
  if (!api) return;
  try {
    const pickedPath = await api.dialogs.pickFolder();
    if (!pickedPath) return;
    const cwd = pickedPath.trim();
    if (!cwd) return;
    const existing = findExistingProjectByPath(projects, cwd);
    if (existing) {
      if (isProjectArchived(existing)) {
        try {
          await dispatchProjectArchived(api, existing.id, null);
        } catch (error) {
          toastManager.add({
            type: "error",
            title: "Failed to unarchive project",
            description: error instanceof Error ? error.message : "An error occurred.",
          });
          return;
        }
      }
      void startThread(existing.id);
      return;
    }
    const projectId = newProjectId();
    const title = cwd.split(/[/\\]/).findLast((s: string) => s.length > 0) ?? cwd;
    const result = await api.orchestration.dispatchCommand({
      type: "project.create",
      commandId: newCommandId(),
      projectId,
      title,
      workspaceRoot: cwd,
      // Null so new drafts follow the installed provider instead of a stamped Claude default.
      defaultModelSelection: null,
      createdAt: new Date().toISOString(),
    });
    const actedProjectId = await resolveCreatedProjectId(api, {
      projectId,
      sequence: result.sequence,
      projects: useStore.getState().projects,
    });
    void startThread(actedProjectId);
  } catch (error) {
    const recovered = findExistingProjectFromCreateError(useStore.getState().projects, error);
    if (recovered) {
      void startThread(recovered.id);
      return;
    }
    toastManager.add({
      type: "error",
      title: "Failed to add project",
      description:
        error instanceof Error ? error.message : "An error occurred while adding the project.",
    });
  }
}

export default function ChatView({ threadId }: ChatViewProps) {
  useToolInputPreviewSubscription(threadId);
  const serverThread = useThreadById(threadId);
  const setStoreThreadError = useStore((store) => store.setError);
  const setStoreThreadBranch = useStore((store) => store.setThreadBranch);
  const markThreadVisited = useUiStateStore((store) => store.markThreadVisited);
  const activeThreadLastVisitedAt = useUiStateStore(
    (store) => store.threadLastVisitedAtById[threadId],
  );
  const settings = useSettings();
  const setStickyComposerModelSelection = useComposerDraftStore(
    (store) => store.setStickyModelSelection,
  );
  const timestampFormat = settings.timestampFormat;
  const navigate = useNavigate();
  const onOpenToolDiff = useOpenToolDiff(threadId);
  const rawSearch = useSearch({
    strict: false,
    select: (params) => parseDiffRouteSearch(params),
  });
  const { resolvedTheme } = useTheme();
  // The prompt text is deliberately not subscribed here: ChatComposer owns that
  // subscription so a keystroke does not re-render the whole chat view. The latest
  // text is mirrored into promptRef for the handlers below.
  const composerDraft = useComposerThreadDraftWithoutPrompt(threadId);
  const providerStatePrompt = useComposerProviderStatePrompt(threadId);
  const composerImages = composerDraft.images;
  const composerTerminalContexts = composerDraft.terminalContexts;
  const composerReviewComments = useReviewCommentDraftStore(selectReviewComments(threadId));
  const clearReviewComments = useReviewCommentDraftStore((store) => store.clearComments);
  const restoreReviewComments = useReviewCommentDraftStore((store) => store.restoreComments);
  const nonPersistedComposerImageIds = composerDraft.nonPersistedImageIds;
  const setComposerDraftPrompt = useComposerDraftStore((store) => store.setPrompt);
  const setComposerDraftModelSelection = useComposerDraftStore((store) => store.setModelSelection);
  const setComposerDraftRuntimeMode = useComposerDraftStore((store) => store.setRuntimeMode);
  const setComposerDraftInteractionMode = useComposerDraftStore(
    (store) => store.setInteractionMode,
  );
  const addComposerDraftImages = useComposerDraftStore((store) => store.addImages);
  const removeComposerDraftImage = useComposerDraftStore((store) => store.removeImage);
  const insertComposerDraftTerminalContext = useComposerDraftStore(
    (store) => store.insertTerminalContext,
  );
  const addComposerDraftTerminalContexts = useComposerDraftStore(
    (store) => store.addTerminalContexts,
  );
  const removeComposerDraftTerminalContext = useComposerDraftStore(
    (store) => store.removeTerminalContext,
  );
  const setComposerDraftTerminalContexts = useComposerDraftStore(
    (store) => store.setTerminalContexts,
  );
  const clearComposerDraftPersistedAttachments = useComposerDraftStore(
    (store) => store.clearPersistedAttachments,
  );
  const syncComposerDraftPersistedAttachments = useComposerDraftStore(
    (store) => store.syncPersistedAttachments,
  );
  const clearComposerDraftContent = useComposerDraftStore((store) => store.clearComposerContent);
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const getDraftThreadByProjectId = useComposerDraftStore(
    (store) => store.getDraftThreadByProjectId,
  );
  const getDraftThread = useComposerDraftStore((store) => store.getDraftThread);
  const setProjectDraftThreadId = useComposerDraftStore((store) => store.setProjectDraftThreadId);
  const clearProjectDraftThreadId = useComposerDraftStore(
    (store) => store.clearProjectDraftThreadId,
  );
  const draftThread = useComposerDraftStore(
    (store) => store.draftThreadsByThreadId[threadId] ?? null,
  );
  const promptRef = useRef(readComposerThreadPrompt(threadId));
  const currentThreadIdRef = useRef(threadId);
  useLayoutEffect(() => {
    currentThreadIdRef.current = threadId;
  }, [threadId]);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [isWorkspaceFileDragActive, setIsWorkspaceFileDragActive] = useState(false);
  const [optimisticUserMessages, setOptimisticUserMessages] = useState<ChatMessage[]>([]);
  const optimisticUserMessagesRef = useRef(optimisticUserMessages);
  useLayoutEffect(() => {
    optimisticUserMessagesRef.current = optimisticUserMessages;
  }, [optimisticUserMessages]);
  const composerTerminalContextsRef = useRef<TerminalContextDraft[]>(composerTerminalContexts);
  const [localDraftErrorsByThreadId, setLocalDraftErrorsByThreadId] = useState<
    Record<ThreadId, string | null>
  >({});
  const [isConnecting, _setIsConnecting] = useState(false);
  const [usageLimitsPanelThreadId, setUsageLimitsPanelThreadId] = useState<ThreadId | null>(null);
  const [revertDialogState, setRevertDialogState] = useState<
    (RevertCheckpointDialogState & { threadId: ThreadId; messageId: MessageId }) | null
  >(null);
  const [respondingRequestIds, setRespondingRequestIds] = useState<ApprovalRequestId[]>([]);
  const [respondingUserInputRequestIds, setRespondingUserInputRequestIds] = useState<
    ApprovalRequestId[]
  >([]);
  const pendingUserInputAnswersByKey = usePendingUserInputDraftStore((state) => state.answers);
  const pendingUserInputQuestionIndexByKey = usePendingUserInputDraftStore(
    (state) => state.questionIndex,
  );
  const setPendingUserInputAnswersByKey = usePendingUserInputDraftStore(
    (state) => state.updateAnswers,
  );
  const setPendingUserInputQuestionIndexByKey = usePendingUserInputDraftStore(
    (state) => state.updateQuestionIndex,
  );
  const [expandedWorkGroups, setExpandedWorkGroups] = useState<Record<string, boolean>>({});
  const planPanelRef = useRef<ChatPlanPanelHandle>(null);
  const [planSidebarOpen, setPlanSidebarOpen] = useState(false);
  const onPlanSidebarOpenChange = useCallback((open: boolean) => setPlanSidebarOpen(open), []);
  const [terminalFocusRequestId, setTerminalFocusRequestId] = useState(0);
  const [composerHighlightedItemId, setComposerHighlightedItemId] = useState<string | null>(null);
  const [pullRequestDialogState, setPullRequestDialogState] =
    useState<PullRequestDialogState | null>(null);
  const [pendingPullRequestSetupRequest, setPendingPullRequestSetupRequest] =
    useState<PullRequestSetupRequest | null>(null);
  const [attachmentPreviewHandoffByMessageId, setAttachmentPreviewHandoffByMessageId] = useState<
    Record<string, string[]>
  >({});
  // `composerCursor` only tracks programmatic caret moves (it is what the editor
  // applies); `composerCursorRef` always mirrors the live caret, keystrokes included.
  // `requestId` bumps on every programmatic move so the editor applies it even when the
  // target equals the last programmatic value.
  const [composerCursorRequest, setComposerCursorRequest] = useState(() => {
    const initialPrompt = readComposerThreadPrompt(threadId);
    return {
      cursor: collapseExpandedComposerCursor(initialPrompt, initialPrompt.length),
      requestId: 0,
    };
  });
  const composerCursor = composerCursorRequest.cursor;
  const composerCursorRef = useRef(composerCursor);
  const setComposerCursor = useCallback((next: number | ((existing: number) => number)) => {
    const resolved = typeof next === "function" ? next(composerCursorRef.current) : next;
    composerCursorRef.current = resolved;
    setComposerCursorRequest((previous) => ({
      cursor: resolved,
      requestId: previous.requestId + 1,
    }));
  }, []);
  const {
    trigger: composerTrigger,
    setTrigger: setDetectedComposerTrigger,
    resolveTrigger: resolveComposerTriggerDismissal,
    dismissTrigger: dismissComposerTrigger,
    resetTrigger: setComposerTrigger,
  } = useComposerTriggerState((): ComposerTrigger | null => {
    const initialPrompt = readComposerThreadPrompt(threadId);
    return detectComposerTrigger(initialPrompt, initialPrompt.length);
  });
  const [, setLastInvokedScriptByProjectId] = useLocalStorage(
    LAST_INVOKED_SCRIPT_BY_PROJECT_KEY,
    {},
    LastInvokedScriptByProjectSchema,
  );
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  const [messagesScrollElement, setMessagesScrollElement] = useState<HTMLDivElement | null>(null);
  const shouldAutoScrollRef = useRef(true);
  const lastKnownScrollTopRef = useRef(0);
  const isPointerScrollActiveRef = useRef(false);
  const lastTouchClientYRef = useRef<number | null>(null);
  const pendingUserScrollUpIntentRef = useRef(false);
  const pendingAutoScrollFrameRef = useRef<number | null>(null);
  const pendingInteractionAnchorRef = useRef<{
    element: HTMLElement;
    top: number;
  } | null>(null);
  const pendingInteractionAnchorFrameRef = useRef<number | null>(null);
  // Thread whose scroll position the timeline currently shows, and whether a saved one is being restored.
  const timelinePositionThreadIdRef = useRef<ThreadId | null>(null);
  const timelinePositionRestoringRef = useRef(false);
  const timelinePositionCaptureFrameRef = useRef<number | null>(null);
  const composerEditorRef = useRef<ComposerPromptEditorHandle>(null);
  const composerControlsRef = useRef<ChatComposerHandle>(null);
  const composerImagesRef = useRef<ComposerImageAttachment[]>([]);
  const composerSelectLockRef = useRef(false);
  const attachmentPreviewHandoffByMessageIdRef = useRef<Record<string, string[]>>({});
  const attachmentPreviewHandoffTimeoutByMessageIdRef = useRef<Record<string, number>>({});
  // ChatView stays mounted across threads, so sends and worktree creations are tracked per thread:
  // one in flight blocks only its own thread, and only that thread offers its controls.
  const sendInFlightThreadIdsRef = useRef(new Set<ThreadId>());
  const {
    activeCreation: activeWorktreeCreation,
    createWorktree,
    prepareWorktree,
    cancel: onCancelPreparingWorktree,
    workLocally: onWorkLocallyInstead,
  } = useComposerWorktreeCreation(threadId);
  const [queuedSendThreadId, setQueuedSendThreadId] = useState<ThreadId | null>(null);
  // Follow-up of a send held while images were fitted; read and cleared when the queue flushes.
  const queuedSendFollowUpRef = useRef<ComposerSendFollowUp | null>(null);
  // Whether the queued send is waiting on an armed usage-limit resume, as opposed to a running turn.
  const queuedSendHeldForResumeRef = useRef(false);
  const goalClearAfterStopThreadIdsRef = useRef(new Set<ThreadId>());
  const terminalOpenByThreadRef = useRef<Record<string, boolean>>({});
  const setMessagesScrollContainerRef = useCallback((element: HTMLDivElement | null) => {
    messagesScrollRef.current = element;
    setMessagesScrollElement(element);
  }, []);

  const terminalState = useTerminalStateStore((state) =>
    selectThreadTerminalState(state.terminalStateByThreadId, threadId),
  );
  const storeSetTerminalOpen = useTerminalStateStore((s) => s.setTerminalOpen);
  const storeSplitTerminal = useTerminalStateStore((s) => s.splitTerminal);
  const storeSplitTerminalVertical = useTerminalStateStore((s) => s.splitTerminalVertical);
  const storeNewTerminal = useTerminalStateStore((s) => s.newTerminal);
  const storeSetActiveTerminal = useTerminalStateStore((s) => s.setActiveTerminal);
  const storeCloseTerminal = useTerminalStateStore((s) => s.closeTerminal);

  const setPrompt = useCallback(
    (nextPrompt: string) => {
      setComposerDraftPrompt(threadId, nextPrompt);
    },
    [setComposerDraftPrompt, threadId],
  );
  const addComposerImagesToDraft = useCallback(
    (images: ComposerImageAttachment[]) => {
      addComposerDraftImages(threadId, images);
    },
    [addComposerDraftImages, threadId],
  );
  const addComposerTerminalContextsToDraft = useCallback(
    (contexts: TerminalContextDraft[]) => {
      addComposerDraftTerminalContexts(threadId, contexts);
    },
    [addComposerDraftTerminalContexts, threadId],
  );
  const removeComposerImageFromDraft = useStableCallback((imageId: string) => {
    removeComposerDraftImage(threadId, imageId);
  });
  const removeComposerTerminalContextFromDraft = useStableCallback((contextId: string) => {
    const contextIndex = composerTerminalContexts.findIndex((context) => context.id === contextId);
    if (contextIndex < 0) {
      return;
    }
    const nextPrompt = removeInlineTerminalContextPlaceholder(promptRef.current, contextIndex);
    promptRef.current = nextPrompt.prompt;
    setPrompt(nextPrompt.prompt);
    removeComposerDraftTerminalContext(threadId, contextId);
    setComposerCursor(nextPrompt.cursor);
    // Detected, not reset, so an Escape dismissal survives removing a terminal chip.
    setDetectedComposerTrigger(
      detectComposerTrigger(
        nextPrompt.prompt,
        expandCollapsedComposerCursor(nextPrompt.prompt, nextPrompt.cursor),
      ),
    );
  });

  const fallbackDraftProject = useProjectById(draftThread?.projectId);
  const localDraftError = serverThread ? null : (localDraftErrorsByThreadId[threadId] ?? null);
  const localDraftThread = useMemo(
    () =>
      draftThread
        ? buildLocalDraftThread(
            threadId,
            draftThread,
            fallbackDraftProject?.defaultModelSelection ?? {
              provider: "claudeAgent",
              model: DEFAULT_MODEL_BY_PROVIDER.claudeAgent,
            },
            localDraftError,
          )
        : undefined,
    [draftThread, fallbackDraftProject?.defaultModelSelection, localDraftError, threadId],
  );
  const activeThread = serverThread ?? localDraftThread;
  const runtimeMode =
    composerDraft.runtimeMode ?? activeThread?.runtimeMode ?? settings.defaultRuntimeMode;
  const interactionMode =
    composerDraft.interactionMode ?? activeThread?.interactionMode ?? DEFAULT_INTERACTION_MODE;
  const isServerThread = serverThread !== undefined;
  const isLocalDraftThread = !isServerThread && localDraftThread !== undefined;
  const diffOpen = rawSearch.diff === "1";
  const activeThreadId = activeThread?.id ?? null;
  const isRevertingCheckpoint = useIsThreadReverting(activeThreadId);
  // Pasted images are fitted asynchronously; a send waits until the thread's images are ready.
  const hasPendingImageFits = usePreparingComposerImages(activeThreadId).length > 0;
  const armedUsageLimitResume = useArmedUsageLimitResume(activeThread);
  const activeLatestTurn = activeThread?.latestTurn ?? null;
  const sourceProposedPlanThreadId = activeLatestTurn?.sourceProposedPlan?.threadId;
  const threadPlanCatalog = useThreadPlanCatalog(
    useMemo(() => {
      const threadIds: ThreadId[] = [];
      if (activeThreadId) {
        threadIds.push(activeThreadId);
      }
      if (sourceProposedPlanThreadId && sourceProposedPlanThreadId !== activeThreadId) {
        threadIds.push(sourceProposedPlanThreadId);
      }
      return threadIds;
    }, [sourceProposedPlanThreadId, activeThreadId]),
  );
  const activeContextWindow = useMemo(
    () => deriveLatestContextWindowSnapshot(activeThread?.activities ?? []),
    [activeThread?.activities],
  );
  const latestTurnSettled = isLatestTurnSettled(activeLatestTurn, activeThread?.session ?? null);
  const activeProject = useProjectById(activeThread?.projectId);
  const allProjects = useUserProjects();
  const { handleNewThread: createNewThread } = useHandleNewThread();

  const handleSwitchProject = useCallback(
    (projectId: ProjectId) => {
      void createNewThread(projectId);
    },
    [createNewThread],
  );

  const handleAddProject = useCallback(
    () => pickProjectAndStartThread(allProjects, createNewThread),
    [allProjects, createNewThread],
  );

  const closePullRequestDialog = useCallback(() => {
    setPullRequestDialogState(null);
  }, []);

  const openOrReuseProjectDraftThread = useCallback(
    async (input: { branch: string; worktreePath: string | null; envMode: DraftThreadEnvMode }) => {
      if (!activeProject) {
        throw new Error("No active project is available for this pull request.");
      }
      const storedDraftThread = getDraftThreadByProjectId(activeProject.id);
      if (storedDraftThread) {
        setDraftThreadContext(storedDraftThread.threadId, input);
        setProjectDraftThreadId(activeProject.id, storedDraftThread.threadId, input);
        if (storedDraftThread.threadId !== threadId) {
          await navigate({
            to: "/$threadId",
            params: { threadId: storedDraftThread.threadId },
          });
        }
        return storedDraftThread.threadId;
      }

      const activeDraftThread = getDraftThread(threadId);
      if (
        !isServerThread &&
        activeDraftThread?.projectId === activeProject.id &&
        !activeDraftThread.promoting
      ) {
        setDraftThreadContext(threadId, input);
        setProjectDraftThreadId(activeProject.id, threadId, input);
        return threadId;
      }

      clearProjectDraftThreadId(activeProject.id);
      const nextThreadId = newThreadId();
      setProjectDraftThreadId(activeProject.id, nextThreadId, {
        createdAt: new Date().toISOString(),
        runtimeMode: settings.defaultRuntimeMode,
        interactionMode: DEFAULT_INTERACTION_MODE,
        ...input,
      });
      await navigate({
        to: "/$threadId",
        params: { threadId: nextThreadId },
      });
      return nextThreadId;
    },
    [
      activeProject,
      clearProjectDraftThreadId,
      getDraftThread,
      getDraftThreadByProjectId,
      isServerThread,
      navigate,
      setDraftThreadContext,
      settings.defaultRuntimeMode,
      setProjectDraftThreadId,
      threadId,
    ],
  );

  const handlePreparedPullRequestThread = useCallback(
    async (input: {
      branch: string;
      worktreePath: string | null;
      checkoutChanged?: boolean | undefined;
    }) => {
      const targetThreadId = await openOrReuseProjectDraftThread({
        branch: input.branch,
        worktreePath: input.worktreePath,
        envMode: input.worktreePath ? "worktree" : "local",
      });
      const setupScript =
        input.worktreePath && activeProject ? setupProjectScript(activeProject.scripts) : null;
      setPendingPullRequestSetupRequest(
        resolvePullRequestSetupRequest({
          targetThreadId: targetThreadId ?? null,
          worktreePath: input.worktreePath,
          scriptId: setupScript?.id ?? null,
          checkoutChanged: input.checkoutChanged,
        }),
      );
    },
    [activeProject, openOrReuseProjectDraftThread],
  );

  useEffect(() => {
    if (!serverThread?.id) return;
    if (!latestTurnSettled) return;
    if (!activeLatestTurn?.completedAt) return;
    const turnCompletedAt = Date.parse(activeLatestTurn.completedAt);
    if (Number.isNaN(turnCompletedAt)) return;
    const lastVisitedAt = activeThreadLastVisitedAt ? Date.parse(activeThreadLastVisitedAt) : NaN;
    if (!Number.isNaN(lastVisitedAt) && lastVisitedAt >= turnCompletedAt) return;

    markThreadVisited(serverThread.id, activeLatestTurn.completedAt);
  }, [
    activeLatestTurn?.completedAt,
    activeThreadLastVisitedAt,
    latestTurnSettled,
    markThreadVisited,
    serverThread?.id,
  ]);

  const sessionProvider = activeThread?.session?.provider ?? null;
  const selectedProviderByThreadId = composerDraft.activeProvider ?? null;
  // A local draft's modelSelection is a placeholder, not a user choice, so only server threads count.
  const threadProvider =
    serverThread?.modelSelection.provider ?? activeProject?.defaultModelSelection?.provider ?? null;
  const hasThreadStarted = threadHasStarted(activeThread);
  const lockedProvider: ProviderKind | null = hasThreadStarted
    ? (sessionProvider ?? threadProvider ?? selectedProviderByThreadId ?? null)
    : null;
  const serverConfig = useServerConfig();
  const providerStatuses = serverConfig?.providers ?? EMPTY_PROVIDERS;
  const unlockedSelectedProvider = resolveUnlockedComposerProvider({
    providers: providerStatuses,
    draftProvider: selectedProviderByThreadId,
    threadProvider,
  });
  const selectedProvider: ProviderKind = lockedProvider ?? unlockedSelectedProvider;
  const threadModelSelection = serverThread?.modelSelection;
  const projectModelSelection = activeProject?.defaultModelSelection;
  const { modelOptions: composerModelOptions, selectedModel } = useMemo(
    () =>
      deriveEffectiveComposerModelState({
        draft: composerDraft,
        providers: providerStatuses,
        selectedProvider,
        threadModelSelection,
        projectModelSelection,
        settings,
      }),
    [
      composerDraft,
      projectModelSelection,
      providerStatuses,
      selectedProvider,
      settings,
      threadModelSelection,
    ],
  );
  const selectedProviderModels = getProviderModels(providerStatuses, selectedProvider);
  const selectedModelForPicker = selectedModel;
  const phase = derivePhase(activeThread?.session ?? null);
  const canInterrupt = canInterruptRunningTurn({
    phase,
    sessionStatus: activeThread?.session?.status,
  });
  const threadActivities = activeThread?.activities ?? EMPTY_ACTIVITIES;
  const {
    composerProviderState,
    selectedPromptEffort,
    selectedModelSelection,
    workLogEntries,
    latestTurnHasToolActivity,
    pendingApprovals: incomingPendingApprovals,
    pendingUserInputs: incomingPendingUserInputs,
  } = useComposerSession({
    selectedProvider,
    selectedModel,
    selectedProviderModels,
    prompt: providerStatePrompt,
    composerModelOptions,
    threadActivities,
    activeLatestTurnId: activeLatestTurn?.turnId ?? undefined,
  });
  const composerTypingGuard = useComposerTypingGuard(threadId, [
    ...incomingPendingApprovals.map((approval) => approval.requestId),
    ...incomingPendingUserInputs.map((request) => request.requestId),
  ]);
  const pendingApprovals = withoutHeldComposerRequests(
    incomingPendingApprovals,
    composerTypingGuard.heldRequestIds,
  );
  const pendingUserInputs = withoutHeldComposerRequests(
    incomingPendingUserInputs,
    composerTypingGuard.heldRequestIds,
  );
  const pendingApprovalsRef = useRef(pendingApprovals);
  const respondingRequestIdsRef = useRef(respondingRequestIds);
  useLayoutEffect(() => {
    pendingApprovalsRef.current = pendingApprovals;
    respondingRequestIdsRef.current = respondingRequestIds;
  }, [pendingApprovals, respondingRequestIds]);
  const activePendingUserInput = pendingUserInputs[0] ?? null;
  const activePendingDraftKey = activePendingUserInput
    ? pendingUserInputDraftKey(threadId, activePendingUserInput.requestId)
    : null;
  const activePendingDraftAnswers = useMemo(
    () =>
      activePendingDraftKey
        ? (pendingUserInputAnswersByKey[activePendingDraftKey] ?? EMPTY_PENDING_USER_INPUT_ANSWERS)
        : EMPTY_PENDING_USER_INPUT_ANSWERS,
    [activePendingDraftKey, pendingUserInputAnswersByKey],
  );
  const activePendingQuestionIndex = activePendingDraftKey
    ? (pendingUserInputQuestionIndexByKey[activePendingDraftKey] ?? 0)
    : 0;
  const prunePendingUserInputDrafts = usePendingUserInputDraftStore((state) => state.pruneThread);
  const loadedServerThreadId = serverThread?.id ?? null;
  useEffect(() => {
    // Only prune once this thread's activities are loaded, or its drafts would be wiped.
    if (loadedServerThreadId === null || loadedServerThreadId !== threadId) return;
    prunePendingUserInputDrafts(
      loadedServerThreadId,
      new Set(incomingPendingUserInputs.map((request) => request.requestId)),
    );
  }, [incomingPendingUserInputs, loadedServerThreadId, prunePendingUserInputDrafts, threadId]);
  const activePendingProgress = useMemo(
    () =>
      activePendingUserInput
        ? derivePendingUserInputProgress(
            activePendingUserInput.questions,
            activePendingDraftAnswers,
            activePendingQuestionIndex,
          )
        : null,
    [activePendingDraftAnswers, activePendingQuestionIndex, activePendingUserInput],
  );
  const activePendingResolvedAnswers = useMemo(
    () =>
      activePendingUserInput
        ? buildPendingUserInputAnswers(activePendingUserInput.questions, activePendingDraftAnswers)
        : null,
    [activePendingDraftAnswers, activePendingUserInput],
  );
  const activePendingIsResponding = activePendingUserInput
    ? respondingUserInputRequestIds.includes(activePendingUserInput.requestId)
    : false;
  const [missingCwd, setMissingCwd] = useState<string | null>(null);
  const projectCwd = activeProject?.cwd ?? null;
  const activeThreadIdForCwdCheck = activeThread?.id ?? null;
  useEffect(() => {
    if (!projectCwd || !activeThreadIdForCwdCheck) {
      setMissingCwd(null);
      return;
    }
    let cancelled = false;
    getWsRpcClient()
      .projects.checkDirectoryExists({ path: projectCwd })
      .then((result) => {
        if (!cancelled) setMissingCwd(result.exists ? null : projectCwd);
      })
      .catch(() => {
        if (!cancelled) setMissingCwd(null);
      });
    return () => {
      cancelled = true;
    };
  }, [projectCwd, activeThreadIdForCwdCheck]);

  const activeProposedPlan = useMemo(() => {
    if (!latestTurnSettled) {
      return null;
    }
    return findLatestProposedPlan(
      activeThread?.proposedPlans ?? [],
      activeLatestTurn?.turnId ?? null,
    );
  }, [activeLatestTurn?.turnId, activeThread?.proposedPlans, latestTurnSettled]);
  const sidebarProposedPlan = useMemo(
    () =>
      findSidebarProposedPlan({
        threads: threadPlanCatalog,
        latestTurn: activeLatestTurn,
        latestTurnSettled,
        threadId: activeThread?.id ?? null,
      }),
    [activeLatestTurn, activeThread?.id, latestTurnSettled, threadPlanCatalog],
  );
  // Only Claude task lists outlive their turn; Codex plans are per turn.
  const keepUnfinishedEarlierPlan = selectedProvider === "claudeAgent";
  const activePlan = useMemo(
    () =>
      deriveActivePlanState(threadActivities, activeLatestTurn?.turnId ?? undefined, {
        keepUnfinishedEarlierPlan,
      }),
    [activeLatestTurn?.turnId, keepUnfinishedEarlierPlan, threadActivities],
  );
  const showPlanFollowUpPrompt =
    pendingUserInputs.length === 0 &&
    interactionMode === "plan" &&
    latestTurnSettled &&
    hasActionableProposedPlan(activeProposedPlan);
  const activePendingApproval = pendingApprovals[0] ?? null;
  const {
    beginLocalDispatch,
    resetLocalDispatch,
    localDispatchStartedAt,
    isPreparingWorktree,
    isSendBusy,
  } = useLocalDispatchState({
    activeThread,
    activeLatestTurn,
    phase,
    activePendingApproval: activePendingApproval?.requestId ?? null,
    activePendingUserInput: activePendingUserInput?.requestId ?? null,
    threadError: activeThread?.error,
  });
  // The server holds the session in "starting" (phase "connecting") from send until turn.started,
  // after useLocalDispatchState has already cleared isSendBusy.
  const isPhaseConnecting = phase === "connecting";
  const isWorking =
    phase === "running" || isPhaseConnecting || isSendBusy || isConnecting || isRevertingCheckpoint;
  useThreadActivityAnnouncer(isServerThread ? threadId : null, {
    ...deriveThreadActivityStatus({
      running: phase === "running",
      pendingApprovalRequestId: activePendingApproval?.requestId ?? null,
      pendingUserInputRequestId:
        activePendingUserInput &&
        isPendingUserInputAwaitingUser(
          activePendingUserInput,
          phase === "running" || isPhaseConnecting,
        )
          ? activePendingUserInput.requestId
          : null,
    }),
    turnId: activeLatestTurn?.turnId ?? null,
    turnState: activeLatestTurn?.state ?? null,
  });
  const workingLabel =
    activePendingUserInput &&
    isPendingUserInputAwaitingUser(activePendingUserInput, phase === "running" || isPhaseConnecting)
      ? "Awaiting your response…"
      : isConnecting || isPhaseConnecting
        ? "Connecting…"
        : isSendBusy
          ? "Sending…"
          : isRevertingCheckpoint
            ? "Reverting…"
            : null;
  const activeWorkStartedAt = deriveActiveWorkStartedAt(
    activeLatestTurn,
    activeThread?.session ?? null,
    localDispatchStartedAt,
  );
  const isComposerApprovalState = activePendingApproval !== null;
  const hasComposerHeader =
    isComposerApprovalState ||
    pendingUserInputs.length > 0 ||
    (showPlanFollowUpPrompt && activeProposedPlan !== null);
  const lastSyncedPendingInputRef = useRef<{
    requestId: string | null;
    questionId: string | null;
  } | null>(null);
  useEffect(() => {
    const nextCustomAnswer = activePendingProgress?.customAnswer;
    if (typeof nextCustomAnswer !== "string") {
      if (lastSyncedPendingInputRef.current !== null) {
        // The question resolved; the composer edits the thread draft again.
        const draftPrompt = readComposerThreadPrompt(threadId);
        promptRef.current = draftPrompt;
        const { cursor, trigger } = composerStateAtPromptEnd(draftPrompt);
        setComposerCursor(cursor);
        setComposerTrigger(trigger);
      }
      lastSyncedPendingInputRef.current = null;
      return;
    }
    const nextRequestId = activePendingUserInput?.requestId ?? null;
    const nextQuestionId = activePendingProgress?.activeQuestion?.id ?? null;
    const questionChanged =
      lastSyncedPendingInputRef.current?.requestId !== nextRequestId ||
      lastSyncedPendingInputRef.current?.questionId !== nextQuestionId;
    const textChangedExternally = promptRef.current !== nextCustomAnswer;

    lastSyncedPendingInputRef.current = {
      requestId: nextRequestId,
      questionId: nextQuestionId,
    };

    if (!questionChanged && !textChangedExternally) {
      return;
    }

    promptRef.current = nextCustomAnswer;
    const { cursor, trigger } = composerStateAtPromptEnd(nextCustomAnswer);
    setComposerCursor(cursor);
    setComposerTrigger(trigger);
    setComposerHighlightedItemId(null);
  }, [
    activePendingProgress?.customAnswer,
    activePendingUserInput?.requestId,
    activePendingProgress?.activeQuestion?.id,
    setComposerCursor,
    setComposerTrigger,
    threadId,
  ]);
  useEffect(() => {
    attachmentPreviewHandoffByMessageIdRef.current = attachmentPreviewHandoffByMessageId;
  }, [attachmentPreviewHandoffByMessageId]);
  const clearAttachmentPreviewHandoffs = useCallback(() => {
    for (const timeoutId of Object.values(attachmentPreviewHandoffTimeoutByMessageIdRef.current)) {
      window.clearTimeout(timeoutId);
    }
    attachmentPreviewHandoffTimeoutByMessageIdRef.current = {};
    for (const previewUrls of Object.values(attachmentPreviewHandoffByMessageIdRef.current)) {
      for (const previewUrl of previewUrls) {
        revokeBlobPreviewUrl(previewUrl);
      }
    }
    attachmentPreviewHandoffByMessageIdRef.current = {};
    setAttachmentPreviewHandoffByMessageId({});
  }, []);
  useEffect(() => {
    return () => {
      clearAttachmentPreviewHandoffs();
      for (const message of optimisticUserMessagesRef.current) {
        revokeUserMessagePreviewUrls(message);
      }
    };
  }, [clearAttachmentPreviewHandoffs]);
  const handoffAttachmentPreviews = useCallback((messageId: MessageId, previewUrls: string[]) => {
    if (previewUrls.length === 0) return;

    const previousPreviewUrls = attachmentPreviewHandoffByMessageIdRef.current[messageId] ?? [];
    for (const previewUrl of previousPreviewUrls) {
      if (!previewUrls.includes(previewUrl)) {
        revokeBlobPreviewUrl(previewUrl);
      }
    }
    setAttachmentPreviewHandoffByMessageId((existing) => {
      const next = {
        ...existing,
        [messageId]: previewUrls,
      };
      attachmentPreviewHandoffByMessageIdRef.current = next;
      return next;
    });

    const existingTimeout = attachmentPreviewHandoffTimeoutByMessageIdRef.current[messageId];
    if (typeof existingTimeout === "number") {
      window.clearTimeout(existingTimeout);
    }
    attachmentPreviewHandoffTimeoutByMessageIdRef.current[messageId] = window.setTimeout(() => {
      const currentPreviewUrls = attachmentPreviewHandoffByMessageIdRef.current[messageId];
      if (currentPreviewUrls) {
        for (const previewUrl of currentPreviewUrls) {
          revokeBlobPreviewUrl(previewUrl);
        }
      }
      setAttachmentPreviewHandoffByMessageId((existing) => {
        if (!(messageId in existing)) return existing;
        const next = { ...existing };
        delete next[messageId];
        attachmentPreviewHandoffByMessageIdRef.current = next;
        return next;
      });
      delete attachmentPreviewHandoffTimeoutByMessageIdRef.current[messageId];
    }, ATTACHMENT_PREVIEW_HANDOFF_TTL_MS);
  }, []);
  const serverMessages = activeThread?.messages;
  const timelineMessages = useMemo(() => {
    const messages = serverMessages ?? [];
    const serverMessagesWithPreviewHandoff =
      Object.keys(attachmentPreviewHandoffByMessageId).length === 0
        ? messages
        : // Spread only fires for the few messages that actually changed;
          // unchanged ones early-return their original reference.
          // In-place mutation would break React's immutable state contract.
          // oxlint-disable-next-line no-map-spread
          messages.map((message) => {
            if (
              message.role !== "user" ||
              !message.attachments ||
              message.attachments.length === 0
            ) {
              return message;
            }
            const handoffPreviewUrls = attachmentPreviewHandoffByMessageId[message.id];
            if (!handoffPreviewUrls || handoffPreviewUrls.length === 0) {
              return message;
            }

            let changed = false;
            let imageIndex = 0;
            const attachments = message.attachments.map((attachment) => {
              if (attachment.type !== "image") {
                return attachment;
              }
              const handoffPreviewUrl = handoffPreviewUrls[imageIndex];
              imageIndex += 1;
              if (!handoffPreviewUrl || attachment.previewUrl === handoffPreviewUrl) {
                return attachment;
              }
              changed = true;
              return {
                ...attachment,
                previewUrl: handoffPreviewUrl,
              };
            });

            return changed ? { ...message, attachments } : message;
          });

    if (optimisticUserMessages.length === 0) {
      return serverMessagesWithPreviewHandoff;
    }
    // Optimistic messages the server has not echoed yet stay visible, which also covers
    // the draft→server transition gap where the new server thread has no messages.
    const serverIds = new Set(serverMessagesWithPreviewHandoff.map((message) => message.id));
    const pendingMessages = optimisticUserMessages.filter((message) => !serverIds.has(message.id));
    if (pendingMessages.length === 0) {
      return serverMessagesWithPreviewHandoff;
    }
    return [...serverMessagesWithPreviewHandoff, ...pendingMessages];
  }, [serverMessages, attachmentPreviewHandoffByMessageId, optimisticUserMessages]);
  const composerPromptHistory = useComposerPromptHistory({
    threadId,
    messages: timelineMessages,
    editorRef: composerEditorRef,
  });

  // Derive persistent Q&A cards from thread activities so they survive refresh.
  const qaCardMessages = useMemo<ChatMessage[]>(
    () => (activeThread ? deriveQaCardMessages(activeThread.activities ?? []) : []),
    [activeThread],
  );

  const timelineMessagesFiltered = useMemo(() => {
    // The card and the provider-history message have the same text, so each answer shows once.
    let msgs = [...dropAsyncAnswerMessagesWithQaCards(timelineMessages, qaCardMessages)];
    // Merge persistent Q&A cards, deduplicating with optimistic ones
    if (qaCardMessages.length > 0) {
      const existingQaIds = new Set(
        msgs.filter((m) => m.text.startsWith("[qa-card]\n")).map((m) => m.id),
      );
      const newCards = qaCardMessages.filter((c) => !existingQaIds.has(c.id));
      if (newCards.length > 0) {
        msgs = [...msgs, ...newCards].toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
      }
    }
    return msgs;
  }, [timelineMessages, qaCardMessages]);

  const timelineEntries = useMemo(
    () =>
      deriveTimelineEntries(
        timelineMessagesFiltered,
        activeThread?.proposedPlans ?? [],
        workLogEntries,
      ),
    [activeThread?.proposedPlans, timelineMessagesFiltered, workLogEntries],
  );
  const { turnDiffSummaries, inferredCheckpointTurnCountByTurnId } =
    useTurnDiffSummaries(activeThread);
  const turnDiffSummaryByAssistantMessageId = useMemo(() => {
    const byMessageId = new Map<MessageId, TurnDiffSummary>();
    for (const summary of turnDiffSummaries) {
      if (!summary.assistantMessageId) continue;
      byMessageId.set(summary.assistantMessageId, summary);
    }
    return byMessageId;
  }, [turnDiffSummaries]);
  const revertTurnCountByUserMessageId = useMemo(() => {
    const byUserMessageId = new Map<MessageId, number>();
    for (let index = 0; index < timelineEntries.length; index += 1) {
      const entry = timelineEntries[index];
      if (
        !entry ||
        entry.kind !== "message" ||
        entry.message.role !== "user" ||
        // A continuation notice has no Revert of its own, so its diff belongs to the real prompt.
        isRestartContinuationMessageId(entry.message.id)
      ) {
        continue;
      }

      for (let nextIndex = index + 1; nextIndex < timelineEntries.length; nextIndex += 1) {
        const nextEntry = timelineEntries[nextIndex];
        if (!nextEntry || nextEntry.kind !== "message") {
          continue;
        }
        if (nextEntry.message.role === "user") {
          if (isRestartContinuationMessageId(nextEntry.message.id)) continue;
          break;
        }
        const summary = turnDiffSummaryByAssistantMessageId.get(nextEntry.message.id);
        if (!summary) {
          continue;
        }
        const turnCount =
          summary.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[summary.turnId];
        if (typeof turnCount !== "number") {
          break;
        }
        byUserMessageId.set(entry.message.id, Math.max(0, turnCount - 1));
        break;
      }
    }

    return byUserMessageId;
  }, [inferredCheckpointTurnCountByTurnId, timelineEntries, turnDiffSummaryByAssistantMessageId]);

  const activeLatestTurnStartedAt = activeLatestTurn?.startedAt;
  const activeLatestTurnCompletedAt = activeLatestTurn?.completedAt;
  const completionSummary = useMemo(() => {
    if (!latestTurnSettled) return null;
    if (!activeLatestTurnStartedAt) return null;
    if (!activeLatestTurnCompletedAt) return null;
    if (!latestTurnHasToolActivity) return null;
    // A reverted turn's timing is its checkpoint's time twice, which measures nothing.
    if (Date.parse(activeLatestTurnCompletedAt) <= Date.parse(activeLatestTurnStartedAt)) {
      return null;
    }

    const elapsed = formatElapsed(activeLatestTurnStartedAt, activeLatestTurnCompletedAt);
    return elapsed ? `Worked for ${elapsed}` : null;
  }, [
    activeLatestTurnCompletedAt,
    activeLatestTurnStartedAt,
    latestTurnHasToolActivity,
    latestTurnSettled,
  ]);
  const completionDividerBeforeEntryId = useMemo(() => {
    if (!latestTurnSettled) return null;
    if (!completionSummary) return null;
    return deriveCompletionDividerBeforeEntryId(timelineEntries, activeLatestTurn);
  }, [activeLatestTurn, completionSummary, latestTurnSettled, timelineEntries]);
  const gitCwd = activeProject
    ? projectScriptCwd({
        project: { cwd: activeProject.cwd },
        worktreePath: activeThread?.worktreePath ?? null,
      })
    : null;
  const composerTriggerKind = composerTrigger?.kind ?? null;
  const pathTriggerQuery = composerTrigger?.kind === "path" ? composerTrigger.query : "";
  const isPathTrigger = composerTriggerKind === "path";
  const [debouncedPathQuery, composerPathQueryDebouncer] = useDebouncedValue(
    pathTriggerQuery,
    { wait: COMPOSER_PATH_QUERY_DEBOUNCE_MS },
    (debouncerState) => ({ isPending: debouncerState.isPending }),
  );
  const effectivePathQuery = pathTriggerQuery.length > 0 ? debouncedPathQuery : "";
  const gitStatusQuery = useQuery(gitStatusQueryOptions(gitCwd));
  const keybindings = useServerKeybindings();
  const availableEditors = useServerAvailableEditors();
  const modelOptionsByProvider = useMemo(
    () => ({
      codex: providerStatuses.find((provider) => provider.provider === "codex")?.models ?? [],
      claudeAgent:
        providerStatuses.find((provider) => provider.provider === "claudeAgent")?.models ?? [],
    }),
    [providerStatuses],
  );
  const modelSwitchLabelByMessageId = useMemo(
    () =>
      deriveModelSwitchLabelByMessageId(
        threadActivities,
        (selection) =>
          modelOptionsByProvider[selection.provider].find(
            (option) => option.slug === selection.model,
          )?.name ?? selection.model,
        (selection, value) =>
          modelOptionsByProvider[selection.provider]
            .find((option) => option.slug === selection.model)
            ?.capabilities?.reasoningEffortLevels.find((level) => level.value === value)?.label ??
          value,
      ),
    [modelOptionsByProvider, threadActivities],
  );
  const selectedModelForPickerWithCustomFallback = useMemo(() => {
    const currentOptions = modelOptionsByProvider[selectedProvider];
    return currentOptions.some((option) => option.slug === selectedModelForPicker)
      ? selectedModelForPicker
      : (normalizeModelSlug(selectedModelForPicker, selectedProvider) ?? selectedModelForPicker);
  }, [modelOptionsByProvider, selectedModelForPicker, selectedProvider]);
  const searchableModelOptions = useMemo(
    () => buildSearchableModelOptions({ modelOptionsByProvider, lockedProvider, providerStatuses }),
    [lockedProvider, modelOptionsByProvider, providerStatuses],
  );
  const workspaceEntriesQuery = useQuery(
    projectSearchEntriesQueryOptions({
      cwd: gitCwd,
      query: effectivePathQuery,
      enabled: isPathTrigger,
      limit: 80,
    }),
  );
  const workspaceEntries = visiblePathSearchEntries(workspaceEntriesQuery, EMPTY_PROJECT_ENTRIES);
  // Placeholder data still holds the previous query's results.
  const workspaceEntriesSearchTarget: ComposerPathSearchTarget | null =
    workspaceEntriesQuery.isPlaceholderData ? null : { cwd: gitCwd, query: effectivePathQuery };
  const triggerCanOfferProviderCommands = useComposerDraftStore(
    (store) =>
      composerTrigger?.kind === "slash-command" &&
      canOfferProviderCommands(
        store.draftsByThreadId[threadId]?.prompt ?? "",
        composerTrigger.rangeStart,
      ),
  );
  const canOfferClaudeCommands =
    selectedProvider === "claudeAgent" && triggerCanOfferProviderCommands;
  const claudeSlashCommandsQuery = useQuery(
    claudeSlashCommandsQueryOptions({
      cwd: gitCwd,
      enabled: canOfferClaudeCommands,
      binaryPath: settings.providers.claudeAgent.binaryPath,
      homePath: settings.providers.claudeAgent.homePath,
    }),
  );
  const providerSlashCommands = canOfferClaudeCommands
    ? (claudeSlashCommandsQuery.data ?? EMPTY_PROVIDER_COMMANDS)
    : selectedProvider === "codex" && triggerCanOfferProviderCommands
      ? CODEX_COMPOSER_PROVIDER_COMMANDS
      : EMPTY_PROVIDER_COMMANDS;
  const offerCompactSlashCommand = selectedProvider === "codex" && isServerThread;
  const composerMenuItems = useMemo<ComposerCommandItem[]>(() => {
    if (!composerTrigger) return [];
    if (composerTrigger.kind === "path") {
      return workspaceEntries.map((entry) => ({
        id: `path:${entry.kind}:${entry.path}`,
        type: "path",
        path: entry.path,
        pathKind: entry.kind,
        label: basenameOfPath(entry.path),
        description: entry.parentPath ?? "",
      }));
    }

    if (composerTrigger.kind === "slash-command") {
      const slashCommandItems = [
        {
          id: "slash:model",
          type: "slash-command",
          command: "model",
          label: "/model",
          description: "Switch response model for this thread",
        },
        ...(offerCompactSlashCommand
          ? ([
              {
                id: "slash:compact",
                type: "slash-command",
                command: "compact",
                label: "/compact",
                description: "Summarize this thread to free up context",
              },
            ] as const)
          : []),
        {
          id: "slash:plan",
          type: "slash-command",
          command: "plan",
          label: "/plan",
          description: "Switch this thread into plan mode",
        },
        {
          id: "slash:default",
          type: "slash-command",
          command: "default",
          label: "/default",
          description: "Switch this thread back to normal chat mode",
        },
        {
          id: "slash:clear",
          type: "slash-command",
          command: "clear",
          label: "/clear",
          description: "Start the next message with fresh context",
        },
        {
          id: "slash:usage-limits",
          type: "slash-command",
          command: "usage-limits",
          label: "/usage-limits",
          description: "Show session and weekly limits with reset times",
        },
      ] satisfies ReadonlyArray<Extract<ComposerCommandItem, { type: "slash-command" }>>;
      const query = composerTrigger.query.trim().toLowerCase();
      // Prefix only, so a typed /age or /lan still sends. A name the provider reports itself sends
      // too: a Claude-reported /usage must not open usage-limits.
      const namesProviderCommand = providerSlashCommands.some(
        (command) =>
          command.name.toLowerCase() === query &&
          !LOCAL_COMPOSER_SLASH_COMMAND_NAMES.includes(command.name.toLowerCase()),
      );
      const localItems: ComposerCommandItem[] = namesProviderCommand
        ? []
        : slashCommandItems.filter(
            (item) =>
              !query || item.command.startsWith(query) || item.label.slice(1).startsWith(query),
          );
      const providerItems = filterComposerProviderCommands(
        providerSlashCommands,
        composerTrigger.query,
        LOCAL_COMPOSER_SLASH_COMMAND_NAMES,
      ).map(
        (command): ComposerCommandItem => ({
          id: `provider-command:${command.name}`,
          type: "provider-command",
          command,
          label: `/${command.name}`,
          description: command.description ?? "",
        }),
      );
      return [...localItems, ...providerItems];
    }

    const selectedModelRefs = [
      { provider: selectedProvider, model: selectedModel },
      ...(readComposerMultiModelSelections(threadId) ?? []),
    ];
    return searchableModelOptions
      .filter(({ provider, slug, isCustom, searchSlug, searchName, searchProvider }) => {
        const query = composerTrigger.query.trim().toLowerCase();
        if (!query) {
          return !isModelHiddenWhileBrowsing({
            ref: { provider, model: slug },
            isCustom,
            favorites: settings.favorites,
            hiddenModels: settings.hiddenModels,
            selected: selectedModelRefs,
          });
        }
        return (
          searchSlug.includes(query) || searchName.includes(query) || searchProvider.includes(query)
        );
      })
      .map(({ provider, providerLabel, slug, name }) => ({
        id: `model:${provider}:${slug}`,
        type: "model",
        provider,
        model: slug,
        label: name,
        description: `${providerLabel} · ${slug}`,
      }));
  }, [
    composerTrigger,
    offerCompactSlashCommand,
    providerSlashCommands,
    searchableModelOptions,
    selectedModel,
    selectedProvider,
    settings.favorites,
    settings.hiddenModels,
    threadId,
    workspaceEntries,
  ]);
  const composerMenuOpen = isComposerMenuOpen(composerTrigger, composerMenuItems.length);
  const activeComposerMenuItem = useMemo(
    () =>
      composerMenuItems.find((item) => item.id === composerHighlightedItemId) ??
      composerMenuItems[0] ??
      null,
    [composerHighlightedItemId, composerMenuItems],
  );
  const nonPersistedComposerImageIdSet = useMemo(
    () => new Set(nonPersistedComposerImageIds),
    [nonPersistedComposerImageIds],
  );
  const activeProviderStatus = useMemo(
    () => providerStatuses.find((status) => status.provider === selectedProvider) ?? null,
    [selectedProvider, providerStatuses],
  );
  const prevThreadErrorRef = useRef<string | null>(null);
  useEffect(() => {
    const error = activeThread?.error ?? null;
    if (error && error !== prevThreadErrorRef.current) {
      // A reconnect snapshot can bring back an error that was already shown; skip it.
      if (!isThreadErrorDismissedForSession(activeThread!.id, error)) {
        toastManager.add({
          type: "error",
          title: threadErrorToastTitle(error),
          // Plain errors stay strings so the toast keeps its copy button.
          description:
            parseStructuredThreadErrorMessage(error) === null ? (
              error
            ) : (
              <ThreadErrorDetails error={error} />
            ),
        });
        dismissThreadErrorForSession(activeThread!.id, error);
      }
      setStoreThreadError(activeThread!.id, null);
    }
    prevThreadErrorRef.current = error;
  }, [activeThread?.error, activeThread?.id, setStoreThreadError]);

  useEffect(() => {
    providerStatusNoticeTracker.sync(
      activeProviderStatus,
      (status) => {
        const label = status.provider.charAt(0).toUpperCase() + status.provider.slice(1);
        return addProviderStatusToast({
          type: status.status === "error" ? "error" : "warning",
          title: `${label} provider status`,
          description:
            status.message ??
            (status.status === "error"
              ? `${label} provider is unavailable.`
              : `${label} provider has limited availability.`),
        });
      },
      (toastId) => toastManager.close(toastId),
    );
  }, [activeProviderStatus]);

  // Default true while loading to avoid toolbar flicker.
  const isGitRepo = gitStatusQuery.data?.isRepo ?? true;
  const nonTerminalShortcutLabelOptions = useMemo(
    () => ({
      context: {
        terminalFocus: false,
        terminalOpen: Boolean(terminalState.terminalOpen),
      },
    }),
    [terminalState.terminalOpen],
  );
  const terminalToggleShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.toggle"),
    [keybindings],
  );
  const diffPanelShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "diff.toggle", nonTerminalShortcutLabelOptions),
    [keybindings, nonTerminalShortcutLabelOptions],
  );
  const onToggleDiff = useStableCallback(() => {
    void navigate({
      to: "/$threadId",
      params: { threadId },
      replace: true,
      search: (previous) => {
        const rest = stripDiffSearchParams(previous);
        return diffOpen ? { ...rest, diff: undefined } : { ...rest, diff: "1" };
      },
    });
  });

  const activeTerminalGroup =
    terminalState.terminalGroups.find(
      (group) => group.id === terminalState.activeTerminalGroupId,
    ) ??
    terminalState.terminalGroups.find((group) =>
      group.terminalIds.includes(terminalState.activeTerminalId),
    ) ??
    null;
  const hasReachedSplitLimit =
    (activeTerminalGroup?.terminalIds.length ?? 0) >= MAX_TERMINALS_PER_GROUP;
  const setThreadError = useCallback(
    (targetThreadId: ThreadId | null, rawError: string | null) => {
      if (!targetThreadId) return;
      const error = normalizeThreadActionError(rawError);
      if (error === null) {
        // Clearing happens when the user starts a new action, so a repeat of the same error shows again.
        clearThreadErrorDismissalsForThread(targetThreadId);
      } else {
        // Errors raised here come from a user action, so a repeat must show again; only server replays stay masked.
        undismissThreadErrorForSession(targetThreadId, error);
      }
      if (useStore.getState().threads.some((thread) => thread.id === targetThreadId)) {
        setStoreThreadError(targetThreadId, error);
        return;
      }
      setLocalDraftErrorsByThreadId((existing) => {
        if ((existing[targetThreadId] ?? null) === error) {
          return existing;
        }
        return {
          ...existing,
          [targetThreadId]: error,
        };
      });
    },
    [setStoreThreadError],
  );

  const focusComposer = useCallback(() => {
    composerEditorRef.current?.focusAtEnd();
  }, []);
  const scheduleComposerFocus = useCallback(() => {
    window.requestAnimationFrame(() => {
      focusComposer();
    });
  }, [focusComposer]);
  const addTerminalContextToDraft = useStableCallback((selection: TerminalContextSelection) => {
    if (!activeThread) {
      return;
    }
    const snapshot = composerEditorRef.current?.readSnapshot() ?? {
      value: promptRef.current,
      cursor: composerCursorRef.current,
      expandedCursor: expandCollapsedComposerCursor(promptRef.current, composerCursorRef.current),
      terminalContextIds: composerTerminalContexts.map((context) => context.id),
    };
    const insertion = insertInlineTerminalContextPlaceholder(
      snapshot.value,
      snapshot.expandedCursor,
    );
    const nextCollapsedCursor = collapseExpandedComposerCursor(insertion.prompt, insertion.cursor);
    const inserted = insertComposerDraftTerminalContext(
      activeThread.id,
      insertion.prompt,
      {
        id: randomUUID(),
        threadId: activeThread.id,
        createdAt: new Date().toISOString(),
        ...selection,
      },
      insertion.contextIndex,
    );
    if (!inserted) {
      return;
    }
    promptRef.current = insertion.prompt;
    setComposerCursor(nextCollapsedCursor);
    setComposerTrigger(detectComposerTrigger(insertion.prompt, insertion.cursor));
    window.requestAnimationFrame(() => {
      composerEditorRef.current?.focusAt(nextCollapsedCursor);
    });
  });
  const setTerminalOpen = useCallback(
    (open: boolean) => {
      if (!activeThreadId) return;
      storeSetTerminalOpen(activeThreadId, open);
    },
    [activeThreadId, storeSetTerminalOpen],
  );
  const toggleTerminalVisibility = useStableCallback(() => {
    if (!activeThreadId) return;
    setTerminalOpen(!terminalState.terminalOpen);
  });
  const splitTerminal = useCallback(() => {
    if (!activeThreadId || hasReachedSplitLimit) return;
    storeSplitTerminal(activeThreadId, allocateThreadTerminalId(activeThreadId));
    setTerminalFocusRequestId((value) => value + 1);
  }, [activeThreadId, hasReachedSplitLimit, storeSplitTerminal]);
  const splitTerminalVertical = useCallback(() => {
    if (!activeThreadId || hasReachedSplitLimit) return;
    storeSplitTerminalVertical(activeThreadId, allocateThreadTerminalId(activeThreadId));
    setTerminalFocusRequestId((value) => value + 1);
  }, [activeThreadId, hasReachedSplitLimit, storeSplitTerminalVertical]);
  const createNewTerminal = useCallback(() => {
    if (!activeThreadId) return;
    storeNewTerminal(activeThreadId, allocateThreadTerminalId(activeThreadId));
    setTerminalFocusRequestId((value) => value + 1);
  }, [activeThreadId, storeNewTerminal]);
  const closeTerminal = useCallback(
    (terminalId: string) => {
      const api = readNativeApi();
      if (!activeThreadId || !api) return;
      const isFinalTerminal = terminalState.terminalIds.length <= 1;
      const fallbackExitWrite = () =>
        api.terminal
          .write({ threadId: activeThreadId, terminalId, data: "exit\n" })
          .catch(() => undefined);
      const endClose = () =>
        useTerminalTabStateStore.getState().endClose(activeThreadId, terminalId);

      useTerminalTabStateStore.getState().beginClose(activeThreadId, terminalId);
      if ("close" in api.terminal && typeof api.terminal.close === "function") {
        void (async () => {
          if (isFinalTerminal) {
            await api.terminal
              .clear({ threadId: activeThreadId, terminalId })
              .catch(() => undefined);
          }
          await api.terminal.close({
            threadId: activeThreadId,
            terminalId,
            deleteHistory: true,
          });
        })()
          .catch(() => fallbackExitWrite())
          .finally(endClose);
      } else {
        void fallbackExitWrite().finally(endClose);
      }
      storeCloseTerminal(activeThreadId, terminalId);
      setTerminalFocusRequestId((value) => value + 1);
    },
    [activeThreadId, storeCloseTerminal, terminalState.terminalIds.length],
  );
  const runProjectScript = useCallback(
    async (
      script: ProjectScript,
      options?: {
        cwd?: string;
        env?: Record<string, string>;
        worktreePath?: string | null;
        preferNewTerminal?: boolean;
        rememberAsLastInvoked?: boolean;
        /** Project and setup scripts stay out of shell history; chat code blocks keep it. */
        shellHistory?: "preserve" | "suppress";
      },
    ) => {
      const api = readNativeApi();
      if (!api || !activeThreadId || !activeProject || !activeThread) return;
      if (options?.rememberAsLastInvoked !== false) {
        setLastInvokedScriptByProjectId((current) => {
          if (current[activeProject.id] === script.id) return current;
          return { ...current, [activeProject.id]: script.id };
        });
      }
      const targetCwd = options?.cwd ?? gitCwd ?? activeProject.cwd;
      const baseTerminalId =
        terminalState.activeTerminalId ||
        terminalState.terminalIds[0] ||
        DEFAULT_THREAD_TERMINAL_ID;
      const reusableTerminalId = options?.preferNewTerminal
        ? null
        : findReusableProjectScriptTerminal({
            baseTerminalId,
            terminalIds: terminalState.terminalIds,
            runningTerminalIds: terminalState.runningTerminalIds,
            // Opening a terminal with a different cwd or env restarts it and wipes its scrollback.
            allowOtherTerminals:
              options?.cwd === undefined &&
              options?.worktreePath === undefined &&
              options?.env === undefined,
          });
      const shouldCreateNewTerminal = reusableTerminalId === null;
      const targetTerminalId = reusableTerminalId ?? allocateThreadTerminalId(activeThreadId);

      setTerminalOpen(true);
      if (shouldCreateNewTerminal) {
        storeNewTerminal(activeThreadId, targetTerminalId);
      } else {
        storeSetActiveTerminal(activeThreadId, targetTerminalId);
      }
      setTerminalFocusRequestId((value) => value + 1);

      const runtimeEnv = projectScriptRuntimeEnv({
        project: {
          cwd: activeProject.cwd,
        },
        worktreePath: options?.worktreePath ?? activeThread.worktreePath ?? null,
        ...(options?.env ? { extraEnv: options.env } : {}),
      });
      const openTerminalInput: TerminalOpenInput = shouldCreateNewTerminal
        ? {
            threadId: activeThreadId,
            terminalId: targetTerminalId,
            cwd: targetCwd,
            env: runtimeEnv,
            cols: SCRIPT_TERMINAL_COLS,
            rows: SCRIPT_TERMINAL_ROWS,
          }
        : {
            threadId: activeThreadId,
            terminalId: targetTerminalId,
            cwd: targetCwd,
            env: runtimeEnv,
          };

      const scriptThreadId = activeThreadId;
      const reportScriptError = (error: unknown) => {
        setThreadError(
          scriptThreadId,
          error instanceof Error ? error.message : `Failed to run script "${script.name}".`,
        );
      };
      const isScriptTerminalOpen = () =>
        selectThreadTerminalState(
          useTerminalStateStore.getState().terminalStateByThreadId,
          scriptThreadId,
        ).terminalIds.includes(targetTerminalId);
      const writeCommand = () =>
        api.terminal.write({
          threadId: scriptThreadId,
          terminalId: targetTerminalId,
          data: projectScriptTerminalInput(
            script.command,
            options?.shellHistory ? { shellHistory: options.shellHistory } : undefined,
          ),
        });
      // A new shell can lose typed input to an rc-file prompt, so wait until it is reading.
      // A non-active tab may have no shell after a restart; a live one resolves from its history.
      const readiness =
        (shouldCreateNewTerminal || targetTerminalId !== baseTerminalId) &&
        shellSignalsReadiness(navigator.platform)
          ? watchShellReadiness({
              subscribe: (listener) => api.terminal.onEvent(listener),
              threadId: scriptThreadId,
              terminalId: targetTerminalId,
              isTerminalOpen: isScriptTerminalOpen,
            })
          : null;

      let openedSnapshot: TerminalSessionSnapshot;
      try {
        openedSnapshot = await api.terminal.open(openTerminalInput);
      } catch (error) {
        readiness?.cancel();
        reportScriptError(error);
        return;
      }
      if (!readiness) {
        await writeCommand().catch(reportScriptError);
        return;
      }
      // A fast shell can enable bracketed paste before the event stream is registered.
      readiness.observeHistory(openedSnapshot.history);
      void readiness.promise
        // The terminal may have been closed while waiting; its session is gone then.
        .then((shell) =>
          shell === "exited" || !isScriptTerminalOpen() ? undefined : writeCommand(),
        )
        .catch(reportScriptError);
    },
    [
      activeProject,
      activeThread,
      activeThreadId,
      gitCwd,
      setTerminalOpen,
      setThreadError,
      storeNewTerminal,
      storeSetActiveTerminal,
      setLastInvokedScriptByProjectId,
      terminalState.activeTerminalId,
      terminalState.runningTerminalIds,
      terminalState.terminalIds,
    ],
  );
  // Chat code blocks run as one-off scripts, so they never become the remembered script.
  const runShellCommand = useStableCallback((command: string) => {
    void runProjectScript(
      {
        id: "chat-code-block",
        name: "Chat code block",
        command: command.trim(),
        icon: "play",
        runOnWorktreeCreate: false,
      },
      { rememberAsLastInvoked: false, shellHistory: "preserve" },
    );
  });

  useEffect(() => {
    if (!pendingPullRequestSetupRequest || !activeProject || !activeThreadId || !activeThread) {
      return;
    }
    if (pendingPullRequestSetupRequest.threadId !== activeThreadId) {
      return;
    }
    if (activeThread.worktreePath !== pendingPullRequestSetupRequest.worktreePath) {
      return;
    }

    const setupScript =
      activeProject.scripts.find(
        (script) => script.id === pendingPullRequestSetupRequest.scriptId,
      ) ?? null;
    setPendingPullRequestSetupRequest(null);
    if (!setupScript) {
      return;
    }

    void runProjectScript(setupScript, {
      cwd: pendingPullRequestSetupRequest.worktreePath,
      worktreePath: pendingPullRequestSetupRequest.worktreePath,
      rememberAsLastInvoked: false,
    }).catch((error) => {
      toastManager.add({
        type: "error",
        title: "Failed to run setup script.",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    });
  }, [
    activeProject,
    activeThread,
    activeThreadId,
    pendingPullRequestSetupRequest,
    runProjectScript,
  ]);
  const handleRuntimeModeChange = useStableCallback((mode: RuntimeMode) => {
    if (mode === runtimeMode) return;
    setComposerDraftRuntimeMode(threadId, mode);
    if (isLocalDraftThread) {
      setDraftThreadContext(threadId, { runtimeMode: mode });
    }
    scheduleComposerFocus();
  });

  const handleInteractionModeChange = useCallback(
    (mode: ProviderInteractionMode) => {
      if (mode === interactionMode) return;
      setComposerDraftInteractionMode(threadId, mode);
      if (isLocalDraftThread) {
        setDraftThreadContext(threadId, { interactionMode: mode });
      }
      scheduleComposerFocus();
    },
    [
      interactionMode,
      isLocalDraftThread,
      scheduleComposerFocus,
      setComposerDraftInteractionMode,
      setDraftThreadContext,
      threadId,
    ],
  );
  const toggleInteractionMode = useStableCallback(() => {
    handleInteractionModeChange(interactionMode === "plan" ? "default" : "plan");
  });
  const cycleRuntimeMode = useStableCallback(() => {
    void handleRuntimeModeChange(nextRuntimeModeInCycle(runtimeMode));
  });
  const togglePlanSidebar = useStableCallback(() => {
    planPanelRef.current?.toggle(activePlan?.turnId ?? null, sidebarProposedPlan?.turnId ?? null);
  });

  const currentGitBranch = gitStatusQuery.data?.branch ?? null;
  const copyThreadReference = useStableCallback(() => {
    const target = resolveThreadReferenceCopyTarget({
      threadId,
      threadBranch: activeThread?.branch ?? null,
      status: gitStatusQuery.data,
    });
    writeTextToClipboard(target.value).then(
      () => {
        toastManager.add({
          type: "success",
          title: target.successTitle,
          description: target.value,
        });
      },
      (error: unknown) => {
        toastManager.add({
          type: "error",
          title: target.failureTitle,
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      },
    );
  });
  const persistThreadSettingsForNextTurn = useCallback(
    async (input: {
      threadId: ThreadId;
      createdAt: string;
      modelSelection?: ModelSelection;
      runtimeMode: RuntimeMode;
      interactionMode: ProviderInteractionMode;
    }) => {
      if (!serverThread) {
        return;
      }
      const api = readNativeApi();
      if (!api) {
        return;
      }

      const modelSelectionChanged =
        input.modelSelection !== undefined &&
        (input.modelSelection.model !== serverThread.modelSelection.model ||
          input.modelSelection.provider !== serverThread.modelSelection.provider ||
          JSON.stringify(input.modelSelection.options ?? null) !==
            JSON.stringify(serverThread.modelSelection.options ?? null));
      // Local-mode threads adopt the current checkout as their branch when a turn is sent.
      const branchUpdate = resolveThreadBranchUpdateForNextTurn({
        threadBranch: serverThread.branch,
        threadWorktreePath: serverThread.worktreePath,
        currentGitBranch,
      });
      if (modelSelectionChanged || branchUpdate) {
        await api.orchestration.dispatchCommand({
          type: "thread.meta.update",
          commandId: newCommandId(),
          threadId: input.threadId,
          ...(modelSelectionChanged && input.modelSelection
            ? { modelSelection: input.modelSelection }
            : {}),
          ...(branchUpdate
            ? {
                branch: branchUpdate.branch,
                worktreePath: null,
                expectedBranch: branchUpdate.expectedBranch,
              }
            : {}),
        });
      }

      if (input.runtimeMode !== serverThread.runtimeMode) {
        await api.orchestration.dispatchCommand({
          type: "thread.runtime-mode.set",
          commandId: newCommandId(),
          threadId: input.threadId,
          runtimeMode: input.runtimeMode,
          createdAt: input.createdAt,
        });
      }

      if (input.interactionMode !== serverThread.interactionMode) {
        await api.orchestration.dispatchCommand({
          type: "thread.interaction-mode.set",
          commandId: newCommandId(),
          threadId: input.threadId,
          interactionMode: input.interactionMode,
          createdAt: input.createdAt,
        });
      }
    },
    [currentGitBranch, serverThread],
  );

  // Auto-scroll on new messages
  const messageCount = timelineMessages.length;
  const scrollMessagesToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const scrollContainer = messagesScrollRef.current;
    if (!scrollContainer) return;
    scrollContainer.scrollTo({ top: scrollContainer.scrollHeight, behavior });
    lastKnownScrollTopRef.current = scrollContainer.scrollTop;
    shouldAutoScrollRef.current = true;
  }, []);
  const cancelPendingStickToBottom = useCallback(() => {
    const pendingFrame = pendingAutoScrollFrameRef.current;
    if (pendingFrame === null) return;
    pendingAutoScrollFrameRef.current = null;
    window.cancelAnimationFrame(pendingFrame);
  }, []);
  const onComposerPageScroll = useCallback(
    (direction: ComposerPageScrollDirection) => {
      const container = messagesScrollRef.current;
      if (!container) return;
      if (direction === "up") {
        // Same intent flag as the wheel handler, so leaving the bottom stops stick-to-bottom.
        pendingUserScrollUpIntentRef.current = true;
        // A stick-to-bottom frame queued while streaming would otherwise snap straight back.
        if (container.scrollHeight - container.clientHeight > 1) {
          cancelPendingStickToBottom();
          shouldAutoScrollRef.current = false;
          setShowScrollToBottom(true);
        }
      }
      scrollTimelineByComposerPage(container, direction);
    },
    [cancelPendingStickToBottom],
  );
  // MessagesTimeline calls this at the start of every minimap jump, so follow-to-bottom
  // does not undo the jump.
  const onTimelineManualNavigation = useCallback(() => {
    cancelPendingStickToBottom();
    shouldAutoScrollRef.current = false;
    pendingUserScrollUpIntentRef.current = false;
    setShowScrollToBottom(true);
  }, [cancelPendingStickToBottom]);
  const cancelPendingInteractionAnchorAdjustment = useCallback(() => {
    const pendingFrame = pendingInteractionAnchorFrameRef.current;
    if (pendingFrame === null) return;
    pendingInteractionAnchorFrameRef.current = null;
    window.cancelAnimationFrame(pendingFrame);
  }, []);
  const scheduleStickToBottom = useCallback(() => {
    if (pendingAutoScrollFrameRef.current !== null) return;
    pendingAutoScrollFrameRef.current = window.requestAnimationFrame(() => {
      pendingAutoScrollFrameRef.current = null;
      scrollMessagesToBottom();
    });
  }, [scrollMessagesToBottom]);
  const onMessagesClickCapture = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const scrollContainer = messagesScrollRef.current;
      if (!scrollContainer || !(event.target instanceof Element)) return;

      const trigger = event.target.closest<HTMLElement>(
        "button, summary, [role='button'], [data-scroll-anchor-target]",
      );
      if (!trigger || !scrollContainer.contains(trigger)) return;
      if (trigger.closest("[data-scroll-anchor-ignore]")) return;

      pendingInteractionAnchorRef.current = {
        element: trigger,
        top: trigger.getBoundingClientRect().top,
      };

      cancelPendingInteractionAnchorAdjustment();
      pendingInteractionAnchorFrameRef.current = window.requestAnimationFrame(() => {
        pendingInteractionAnchorFrameRef.current = null;
        const anchor = pendingInteractionAnchorRef.current;
        pendingInteractionAnchorRef.current = null;
        const activeScrollContainer = messagesScrollRef.current;
        if (!anchor || !activeScrollContainer) return;
        if (!anchor.element.isConnected || !activeScrollContainer.contains(anchor.element)) return;

        const nextTop = anchor.element.getBoundingClientRect().top;
        const delta = nextTop - anchor.top;
        if (Math.abs(delta) < 0.5) return;

        activeScrollContainer.scrollTop += delta;
        lastKnownScrollTopRef.current = activeScrollContainer.scrollTop;
      });
    },
    [cancelPendingInteractionAnchorAdjustment],
  );
  const forceStickToBottom = useCallback(() => {
    cancelPendingStickToBottom();
    scrollMessagesToBottom();
    scheduleStickToBottom();
  }, [cancelPendingStickToBottom, scheduleStickToBottom, scrollMessagesToBottom]);
  const scheduleTimelinePositionCapture = useCallback(() => {
    if (timelinePositionRestoringRef.current) return;
    if (timelinePositionCaptureFrameRef.current !== null) return;
    // Bound now: by the time the frame fires the view may already show another thread.
    const positionThreadId = timelinePositionThreadIdRef.current;
    timelinePositionCaptureFrameRef.current = window.requestAnimationFrame(() => {
      timelinePositionCaptureFrameRef.current = null;
      const scrollContainer = messagesScrollRef.current;
      if (
        !positionThreadId ||
        positionThreadId !== timelinePositionThreadIdRef.current ||
        !scrollContainer ||
        timelinePositionRestoringRef.current
      ) {
        return;
      }
      const expandedWorkGroupIds =
        timelinePositionCache.get(positionThreadId)?.expandedWorkGroupIds ?? [];
      timelinePositionCache.set(
        positionThreadId,
        captureTimelinePosition(scrollContainer, expandedWorkGroupIds),
      );
    });
  }, []);
  const onMessagesScroll = useCallback(() => {
    const scrollContainer = messagesScrollRef.current;
    if (!scrollContainer) return;
    scheduleTimelinePositionCapture();
    const currentScrollTop = scrollContainer.scrollTop;
    const isNearBottom = isScrollContainerNearBottom(scrollContainer);

    // The first frame of an upward smooth scroll is still near the bottom; it must not turn
    // auto-scroll back on.
    if (
      !shouldAutoScrollRef.current &&
      isNearBottom &&
      currentScrollTop >= lastKnownScrollTopRef.current - 1 &&
      // A find jump's own scroll must not re-arm following, which would carry a tail match away.
      useThreadFindStore.getState().openThreadId === null
    ) {
      shouldAutoScrollRef.current = true;
      pendingUserScrollUpIntentRef.current = false;
    } else if (shouldAutoScrollRef.current && pendingUserScrollUpIntentRef.current) {
      const scrolledUp = currentScrollTop < lastKnownScrollTopRef.current - 1;
      if (scrolledUp && !isNearBottom) {
        shouldAutoScrollRef.current = false;
      }
      pendingUserScrollUpIntentRef.current = false;
    } else if (shouldAutoScrollRef.current && isPointerScrollActiveRef.current) {
      const scrolledUp = currentScrollTop < lastKnownScrollTopRef.current - 1;
      if (scrolledUp && !isNearBottom) {
        shouldAutoScrollRef.current = false;
      }
    } else if (shouldAutoScrollRef.current && !isNearBottom) {
      // Catch-all for keyboard/assistive scroll interactions.
      const scrolledUp = currentScrollTop < lastKnownScrollTopRef.current - 1;
      if (scrolledUp) {
        shouldAutoScrollRef.current = false;
      }
    }

    setShowScrollToBottom(!shouldAutoScrollRef.current);
    lastKnownScrollTopRef.current = currentScrollTop;
  }, [scheduleTimelinePositionCapture]);
  const onMessagesWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    if (event.deltaY < 0) {
      pendingUserScrollUpIntentRef.current = true;
    }
  }, []);
  const onMessagesPointerDown = useCallback((_event: React.PointerEvent<HTMLDivElement>) => {
    isPointerScrollActiveRef.current = true;
  }, []);
  const onMessagesPointerUp = useCallback((_event: React.PointerEvent<HTMLDivElement>) => {
    isPointerScrollActiveRef.current = false;
  }, []);
  const onMessagesPointerCancel = useCallback((_event: React.PointerEvent<HTMLDivElement>) => {
    isPointerScrollActiveRef.current = false;
  }, []);
  const onMessagesTouchStart = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    const touch = event.touches[0];
    if (!touch) return;
    lastTouchClientYRef.current = touch.clientY;
  }, []);
  const onMessagesTouchMove = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    const touch = event.touches[0];
    if (!touch) return;
    const previousTouchY = lastTouchClientYRef.current;
    if (previousTouchY !== null && touch.clientY > previousTouchY + 1) {
      pendingUserScrollUpIntentRef.current = true;
    }
    lastTouchClientYRef.current = touch.clientY;
  }, []);
  const onMessagesTouchEnd = useCallback((_event: React.TouchEvent<HTMLDivElement>) => {
    lastTouchClientYRef.current = null;
  }, []);
  useEffect(() => {
    return () => {
      cancelPendingStickToBottom();
      cancelPendingInteractionAnchorAdjustment();
      if (timelinePositionCaptureFrameRef.current !== null) {
        window.cancelAnimationFrame(timelinePositionCaptureFrameRef.current);
        timelinePositionCaptureFrameRef.current = null;
      }
    };
  }, [cancelPendingInteractionAnchorAdjustment, cancelPendingStickToBottom]);
  const messageRevealRequestId = useThreadMessageRevealRequestId(activeThread?.id);
  useLayoutEffect(() => {
    // The old timeline is already unmounted here, so a pending capture can only misread the new one.
    if (timelinePositionCaptureFrameRef.current !== null) {
      window.cancelAnimationFrame(timelinePositionCaptureFrameRef.current);
      timelinePositionCaptureFrameRef.current = null;
    }
    timelinePositionThreadIdRef.current = activeThread?.id ?? null;
    if (!activeThread?.id) return;
    const restoreThreadId = activeThread.id;
    const messageReveal = takeThreadMessageReveal(activeThread.id);
    const cachedPosition = timelinePositionCache.get(activeThread.id);
    const savedPosition = messageReveal
      ? buildThreadMessageRevealPosition(messageReveal, cachedPosition)
      : cachedPosition;
    if (messageReveal && savedPosition) {
      // The later reset of expanded work groups reads the cache, and StrictMode's re-run needs it.
      timelinePositionCache.set(activeThread.id, savedPosition);
      setExpandedWorkGroups(expandedWorkGroupsFromPosition(savedPosition));
    }
    if (savedPosition && !savedPosition.atEnd && savedPosition.anchorRowId !== null) {
      // Bring the saved anchor row back over a few frames: rows are re-measured after mount,
      // and expanded work groups are restored by a later effect.
      cancelPendingStickToBottom();
      shouldAutoScrollRef.current = false;
      setShowScrollToBottom(true);
      timelinePositionRestoringRef.current = true;
      let frame: number | null = null;
      let settledFrames = 0;
      let framesLeft = TIMELINE_POSITION_RESTORE_MAX_FRAMES;
      const stopRestore = () => {
        timelinePositionRestoringRef.current = false;
        if (frame !== null) window.cancelAnimationFrame(frame);
        frame = null;
        window.removeEventListener("wheel", stopRestore, true);
        window.removeEventListener("keydown", stopRestore, true);
        window.removeEventListener("pointerdown", stopRestore, true);
        window.removeEventListener("touchstart", stopRestore, true);
      };
      const step = () => {
        frame = null;
        const scrollContainer = messagesScrollRef.current;
        if (!scrollContainer || !timelinePositionRestoringRef.current) return;
        const remaining = stepTimelinePositionRestore(scrollContainer, savedPosition, (rowId) =>
          scrollTimelineRowToStart(restoreThreadId, rowId),
        );
        lastKnownScrollTopRef.current = scrollContainer.scrollTop;
        settledFrames = remaining !== null && Math.abs(remaining) < 1 ? settledFrames + 1 : 0;
        framesLeft -= 1;
        if (settledFrames >= 3 || framesLeft <= 0) {
          stopRestore();
          return;
        }
        frame = window.requestAnimationFrame(step);
      };
      // Any user scroll gesture wins over the restore.
      window.addEventListener("wheel", stopRestore, { capture: true, passive: true });
      window.addEventListener("keydown", stopRestore, true);
      window.addEventListener("pointerdown", stopRestore, true);
      window.addEventListener("touchstart", stopRestore, { capture: true, passive: true });
      step();
      return stopRestore;
    }
    shouldAutoScrollRef.current = true;
    scheduleStickToBottom();
    const timeout = window.setTimeout(() => {
      const scrollContainer = messagesScrollRef.current;
      if (!scrollContainer) return;
      if (isScrollContainerNearBottom(scrollContainer)) return;
      scheduleStickToBottom();
    }, 96);
    return () => {
      window.clearTimeout(timeout);
    };
  }, [activeThread?.id, cancelPendingStickToBottom, messageRevealRequestId, scheduleStickToBottom]);
  // ResizeObserver for composer form height is now inside ChatComposer.
  useEffect(() => {
    if (!shouldAutoScrollRef.current) return;
    scheduleStickToBottom();
  }, [messageCount, scheduleStickToBottom]);
  useEffect(() => {
    if (phase !== "running") return;
    if (!shouldAutoScrollRef.current) return;
    scheduleStickToBottom();
  }, [phase, scheduleStickToBottom, timelineEntries]);
  // Live output never reaches ChatView's render, so subscribing avoids a re-render on every delta.
  useEffect(() => {
    return useStore.subscribe((state, previous) => {
      if (state.toolInputPreviews[threadId] === previous.toolInputPreviews[threadId]) return;
      if (shouldAutoScrollRef.current) scheduleStickToBottom();
    });
  }, [scheduleStickToBottom, threadId]);

  useEffect(() => {
    setExpandedWorkGroups(
      expandedWorkGroupsFromPosition(
        activeThread?.id ? timelinePositionCache.get(activeThread.id) : undefined,
      ),
    );
    setPullRequestDialogState(null);
    // Plan sidebar reset is handled by ChatPlanPanel's own thread-change effect.
  }, [activeThread?.id]);

  useEffect(() => {
    if (!composerMenuOpen) {
      setComposerHighlightedItemId(null);
      return;
    }
    setComposerHighlightedItemId((existing) =>
      existing && composerMenuItems.some((item) => item.id === existing)
        ? existing
        : (composerMenuItems[0]?.id ?? null),
    );
  }, [composerMenuItems, composerMenuOpen]);

  useEffect(() => {
    setIsWorkspaceFileDragActive(false);
  }, [activeThread?.id]);

  useEffect(() => {
    if (!isWorkspaceFileDragActive) return;
    const clearWorkspaceFileDrag = () => setIsWorkspaceFileDragActive(false);
    window.addEventListener("dragend", clearWorkspaceFileDrag);
    window.addEventListener("drop", clearWorkspaceFileDrag);
    return () => {
      window.removeEventListener("dragend", clearWorkspaceFileDrag);
      window.removeEventListener("drop", clearWorkspaceFileDrag);
    };
  }, [isWorkspaceFileDragActive]);

  useEffect(() => {
    if (!activeThread?.id || terminalState.terminalOpen) return;
    const frame = window.requestAnimationFrame(() => {
      focusComposer();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [activeThread?.id, focusComposer, terminalState.terminalOpen]);

  // Returning to the window restores focus to wherever it last was; put it in the composer instead.
  useEffect(() => {
    if (!activeThread?.id || terminalState.terminalOpen) return;
    let frame: number | null = null;
    const onWindowFocus = () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      // Two frames so the browser's own focus restore runs first.
      frame = window.requestAnimationFrame(() => {
        frame = window.requestAnimationFrame(() => {
          frame = null;
          if (shouldRefocusComposerOnWindowFocus(document.activeElement)) focusComposer();
        });
      });
    };
    window.addEventListener("focus", onWindowFocus);
    return () => {
      window.removeEventListener("focus", onWindowFocus);
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [activeThread?.id, focusComposer, terminalState.terminalOpen]);

  useEffect(() => {
    composerImagesRef.current = composerImages;
  }, [composerImages]);

  useEffect(() => {
    composerTerminalContextsRef.current = composerTerminalContexts;
  }, [composerTerminalContexts]);

  useEffect(() => {
    if (!activeThread?.id) return;
    if (activeThread.messages.length === 0) return;
    const serverIds = new Set(activeThread.messages.map((message) => message.id));
    const removedMessages = optimisticUserMessages.filter((message) => serverIds.has(message.id));
    if (removedMessages.length === 0) return;
    // Defer cleanup so the memo's dedup handles the visual transition
    // seamlessly — the optimistic message is already hidden by the memo
    // when the server copy arrives, so this is purely state housekeeping.
    const timer = window.setTimeout(() => {
      setOptimisticUserMessages((existing) =>
        existing.filter((message) => !serverIds.has(message.id)),
      );
    }, 500);
    for (const removedMessage of removedMessages) {
      const previewUrls = collectUserMessageBlobPreviewUrls(removedMessage);
      if (previewUrls.length > 0) {
        handoffAttachmentPreviews(removedMessage.id, previewUrls);
        continue;
      }
      revokeUserMessagePreviewUrls(removedMessage);
    }
    return () => window.clearTimeout(timer);
  }, [activeThread?.id, activeThread?.messages, handoffAttachmentPreviews, optimisticUserMessages]);

  // Mirror external prompt changes (store hydration, other writers) into promptRef
  // without subscribing ChatView's render to the prompt text.
  useEffect(() => {
    const syncPromptFromStore = (nextPrompt: string) => {
      if (promptRef.current === nextPrompt) return;
      promptRef.current = nextPrompt;
      setComposerCursor((existing) => clampCollapsedComposerCursor(nextPrompt, existing));
    };
    syncPromptFromStore(readComposerThreadPrompt(threadId));
    // Only react to this thread's stored prompt changing: promptRef may hold a pending
    // custom answer that unrelated draft-store writes must not clobber.
    return subscribeComposerThreadPrompt(threadId, syncPromptFromStore);
  }, [setComposerCursor, threadId]);

  useEffect(() => {
    setOptimisticUserMessages((existing) => {
      for (const message of existing) {
        revokeUserMessagePreviewUrls(message);
      }
      return [];
    });
    resetLocalDispatch();
    setComposerHighlightedItemId(null);
    setComposerCursor(collapseExpandedComposerCursor(promptRef.current, promptRef.current.length));
    setComposerTrigger(detectComposerTrigger(promptRef.current, promptRef.current.length));
    useExpandedImageStore.getState().close();
  }, [resetLocalDispatch, setComposerCursor, setComposerTrigger, threadId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (composerImages.length === 0) {
        clearComposerDraftPersistedAttachments(threadId);
        return;
      }
      const getPersistedAttachmentsForThread = () =>
        useComposerDraftStore.getState().draftsByThreadId[threadId]?.persistedAttachments ?? [];
      try {
        const currentPersistedAttachments = getPersistedAttachmentsForThread();
        const serialized = await serializeComposerImages(
          composerImages,
          currentPersistedAttachments,
        );
        if (cancelled) {
          return;
        }
        // Stage attachments in persisted draft state first so persist middleware can write them.
        syncComposerDraftPersistedAttachments(threadId, serialized);
      } catch {
        const currentImageIds = new Set(composerImages.map((image) => image.id));
        const fallbackPersistedAttachments = getPersistedAttachmentsForThread();
        const fallbackPersistedIds = fallbackPersistedAttachments
          .map((attachment) => attachment.id)
          .filter((id) => currentImageIds.has(id));
        const fallbackPersistedIdSet = new Set(fallbackPersistedIds);
        const fallbackAttachments = fallbackPersistedAttachments.filter((attachment) =>
          fallbackPersistedIdSet.has(attachment.id),
        );
        if (cancelled) {
          return;
        }
        syncComposerDraftPersistedAttachments(threadId, fallbackAttachments);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    clearComposerDraftPersistedAttachments,
    composerImages,
    syncComposerDraftPersistedAttachments,
    threadId,
  ]);

  const activeWorktreePath = activeThread?.worktreePath;
  const envMode: DraftThreadEnvMode = activeWorktreePath
    ? "worktree"
    : isLocalDraftThread
      ? (draftThread?.envMode ?? "local")
      : "local";
  const hasMultiModelSelection = useComposerMultiModelStore(
    (state) => state.selectionsByThreadId[threadId] !== undefined,
  );
  // A New worktree draft with no branch starts from the default branch, which is never written to
  // the draft, so one that later runs locally records no stray branch.
  const worktreeBase = useWorktreeBaseBranch({
    cwd: activeProject?.cwd ?? null,
    enabled:
      isLocalDraftThread &&
      !activeThread?.worktreePath &&
      !activeThread?.branch &&
      (envMode === "worktree" || hasMultiModelSelection),
  });
  const worktreeBaseBranch = activeThread?.branch ?? worktreeBase.baseBranch;

  useEffect(() => {
    if (!activeThreadId) return;
    const previous = terminalOpenByThreadRef.current[activeThreadId] ?? false;
    const current = Boolean(terminalState.terminalOpen);

    if (!previous && current) {
      terminalOpenByThreadRef.current[activeThreadId] = current;
      setTerminalFocusRequestId((value) => value + 1);
      return;
    } else if (previous && !current) {
      terminalOpenByThreadRef.current[activeThreadId] = current;
      const frame = window.requestAnimationFrame(() => {
        focusComposer();
      });
      return () => {
        window.cancelAnimationFrame(frame);
      };
    }

    terminalOpenByThreadRef.current[activeThreadId] = current;
  }, [activeThreadId, focusComposer, terminalState.terminalOpen]);

  const addComposerImages = (files: File[]) => {
    if (!activeThreadId || files.length === 0) return;

    // The revert checked the room for its restored images before it started.
    if (isThreadReverting(activeThreadId)) {
      toastManager.add({
        type: "error",
        title: "Attach files after the revert finishes.",
      });
      return;
    }

    if (pendingUserInputs.length > 0) {
      toastManager.add({
        type: "error",
        title: "Attach files after answering pending questions.",
      });
      return;
    }

    // Fitting is async, so images still being fitted count toward the attachment limit.
    const targetThreadId = activeThreadId;
    const acceptedFiles: File[] = [];
    const acceptedDocuments: ComposerImageAttachment[] = [];
    // Documents and images share the attachment count and total byte budget.
    const batchHasDocument =
      files.some((file) => isComposerPdfFile(file) || isComposerTextFile(file)) ||
      composerImagesRef.current.some(isComposerFileAttachment);
    const attachmentCountNoun = batchHasDocument ? "attachments" : "images";
    const imageTotalSizeError = batchHasDocument
      ? COMPOSER_ATTACHMENT_TOTAL_SIZE_ERROR
      : COMPOSER_IMAGE_TOTAL_SIZE_ERROR;
    let nextImageCount =
      composerImagesRef.current.length + countPreparingComposerImages(targetThreadId);
    let nextTotalBytes = composerImagesRef.current.reduce(
      (total, image) => total + image.sizeBytes,
      0,
    );
    let error: string | null = null;
    for (const file of files) {
      if (isComposerPdfFile(file) || isComposerTextFile(file)) {
        if (file.size > PROVIDER_SEND_TURN_MAX_FILE_BYTES) {
          error = `'${file.name}' exceeds the ${FILE_SIZE_LIMIT_LABEL} attachment limit.`;
          continue;
        }
        if (nextImageCount >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
          error = `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} ${attachmentCountNoun} per message.`;
          break;
        }
        if (nextTotalBytes + file.size > PROVIDER_SEND_TURN_MAX_TOTAL_IMAGE_BYTES) {
          error = COMPOSER_ATTACHMENT_TOTAL_SIZE_ERROR;
          continue;
        }
        acceptedDocuments.push(buildComposerFileAttachment(randomUUID(), file));
        nextImageCount += 1;
        nextTotalBytes += file.size;
        continue;
      }
      const isHeicImage = isHeicImageFile(file);
      if (!file.type.startsWith("image/") && !isHeicImage) {
        error = `Unsupported file type for '${file.name}'. Please attach images, PDFs, or text files.`;
        continue;
      }
      if (!isHeicImage && !isProviderSendTurnSupportedImageMimeType(file.type)) {
        error = `'${file.name}' is not a supported image type. Attach GIF, HEIC, HEIF, JPEG, PNG, or WebP images.`;
        continue;
      }
      if (nextImageCount >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
        error = `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} ${attachmentCountNoun} per message.`;
        break;
      }
      const budgetBytes = estimateComposerImageBudgetBytes(file);
      if (nextTotalBytes + budgetBytes > PROVIDER_SEND_TURN_MAX_TOTAL_IMAGE_BYTES) {
        error = imageTotalSizeError;
        continue;
      }
      acceptedFiles.push(file);
      nextImageCount += 1;
      nextTotalBytes += budgetBytes;
    }

    // Documents need no fitting, so they land in the draft right away.
    if (acceptedDocuments.length > 0) {
      addComposerDraftImages(targetThreadId, acceptedDocuments);
    }
    if (acceptedFiles.length === 0) {
      setThreadError(targetThreadId, error);
      return;
    }

    // The draft image reuses its tile's id, and both change in one tick so the strip never gaps.
    const preparingBatch = acceptedFiles.map((file) => ({ id: randomUUID(), file }));
    const preparingIds = new Set(preparingBatch.map((entry) => entry.id));
    addPreparingComposerImages(
      targetThreadId,
      preparingBatch.map((entry) => createPreparingComposerImage(entry.id, entry.file)),
    );
    void Promise.all(
      preparingBatch.map((entry) =>
        prepareComposerImageAttachment(entry.file, PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)
          .catch(() => ({ ok: false, reason: "unreadable" }) as const)
          .then((result) => ({ ...entry, result })),
      ),
    )
      .then((results) => {
        const stillPreparingIds = removePreparingComposerImages(targetThreadId, preparingIds);
        const nextImages: ComposerImageAttachment[] = [];
        for (const { id, file: source, result } of keepStillPreparingImages(
          results,
          stillPreparingIds,
        )) {
          if (!result.ok) {
            error =
              result.reason === "too-large"
                ? `'${source.name}' exceeds the ${IMAGE_SIZE_LIMIT_LABEL} attachment limit.`
                : result.reason === "too-many-pixels"
                  ? `'${source.name}' is too large to convert (over ${MAX_HEIC_DECODE_PIXELS / 1_000_000} megapixels).`
                  : `'${source.name}' could not be read as an image.`;
            continue;
          }
          nextImages.push({
            type: "image",
            id,
            name: result.file.name || "image",
            mimeType: result.file.type,
            sizeBytes: result.file.size,
            previewUrl: URL.createObjectURL(result.file),
            file: result.file,
          });
        }
        // Recheck with fitted sizes against the thread's images now, which include other batches.
        const existingBytes = (
          useComposerDraftStore.getState().draftsByThreadId[targetThreadId]?.images ?? []
        ).reduce((total, image) => total + image.sizeBytes, 0);
        const withinBudget = takeComposerImagesWithinTotalBudget(existingBytes, nextImages);
        if (withinBudget.overBudget) {
          error = imageTotalSizeError;
          for (const image of nextImages) {
            if (!withinBudget.accepted.includes(image)) revokeBlobPreviewUrl(image.previewUrl);
          }
        }
        // The draft is keyed by thread, so images land where they were pasted even after a switch.
        if (withinBudget.accepted.length > 0) {
          addComposerDraftImages(targetThreadId, withinBudget.accepted);
        }
        if (error !== null && currentThreadIdRef.current === targetThreadId) {
          queuedSendFollowUpRef.current = null;
          setQueuedSendThreadId((queuedThreadId) =>
            queuedSendAfterImageFit({
              queuedThreadId,
              fitThreadId: targetThreadId,
              fitFailed: true,
            }),
          );
        }
        // A fully removed batch must not clear an error from the send its removal released.
        if (error !== null || stillPreparingIds.size > 0) setThreadError(targetThreadId, error);
      })
      .finally(() => {
        // A leaked tile would hold every later send from this thread.
        removePreparingComposerImages(targetThreadId, preparingIds);
      });
  };

  const addComposerImagesStable = useStableCallback(addComposerImages);
  const pendingThreadFiles = usePendingThreadFiles((state) =>
    activeThreadId ? state.byThread.get(activeThreadId) : undefined,
  );
  useEffect(() => {
    if (!activeThreadId || !activeThread || !pendingThreadFiles?.length) return;
    const files = takeThreadFiles(activeThreadId);
    if (files.length) addComposerImagesStable(files);
  }, [activeThreadId, activeThread, pendingThreadFiles, addComposerImagesStable]);
  const pasteAsTextUntilRef = useRef(0);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      pasteAsTextUntilRef.current =
        (event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "v"
          ? Date.now() + 1000
          : 0;
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, []);
  const onComposerPaste = useCallback(
    (event: React.ClipboardEvent<HTMLElement>) => {
      const files = Array.from(event.clipboardData.files);
      if (files.length === 0) {
        const text = event.clipboardData.getData("text/plain");
        const bypass = Date.now() < pasteAsTextUntilRef.current;
        pasteAsTextUntilRef.current = 0;
        const images = composerImagesRef.current;
        const bytes = shouldAttachPastedText(text, bypass)
          ? new TextEncoder().encode(text).byteLength
          : 0;
        if (
          bytes > 0 &&
          activeThreadId &&
          !isThreadReverting(activeThreadId) &&
          pendingUserInputs.length === 0 &&
          images.length + countPreparingComposerImages(activeThreadId) <
            PROVIDER_SEND_TURN_MAX_ATTACHMENTS &&
          bytes <= PROVIDER_SEND_TURN_MAX_FILE_BYTES &&
          images.reduce((total, image) => total + image.sizeBytes, bytes) <=
            PROVIDER_SEND_TURN_MAX_TOTAL_IMAGE_BYTES
        ) {
          event.preventDefault();
          composerEditorRef.current?.deleteSelection();
          addComposerImagesStable([
            new File([text], nextPastedTextFileName(images.map((image) => image.name)), {
              type: "text/plain",
            }),
          ]);
        }
        return;
      }
      const imageFiles = files.filter(
        (file) => isComposerImageFile(file) || isComposerPdfFile(file) || isComposerTextFile(file),
      );
      if (imageFiles.length === 0) {
        return;
      }
      event.preventDefault();
      addComposerImagesStable(imageFiles);
    },
    [addComposerImagesStable, activeThreadId, pendingUserInputs.length],
  );
  const onComposerFileDrop = useCallback(
    (files: File[]) => {
      addComposerImagesStable(files);
      focusComposer();
    },
    [addComposerImagesStable, focusComposer],
  );

  const onRevertToTurnCount = useStableCallback((turnCount: number, messageId: MessageId) => {
    if (!activeThread || isRevertingCheckpoint) return;

    if (phase === "running" || isPhaseConnecting || isSendBusy || isConnecting) {
      setThreadError(activeThread.id, "Interrupt the current turn before reverting checkpoints.");
      return;
    }
    setRevertDialogState({ threadId: activeThread.id, messageId, turnCount, open: true });
  });
  const onCancelRevertDialog = useCallback(() => {
    setRevertDialogState((current) => (current ? { ...current, open: false } : current));
  }, []);
  const onRevertDialogClosed = useCallback(() => setRevertDialogState(null), []);
  const onConfirmRevert = useStableCallback(async (restoreFiles: boolean) => {
    const request = revertDialogState;
    onCancelRevertDialog();
    const api = readNativeApi();
    if (!api || !request || !activeThread || activeThread.id !== request.threadId) return;
    if (isThreadReverting(request.threadId)) return;
    if (phase === "running" || isPhaseConnecting || isSendBusy || isConnecting) {
      setThreadError(activeThread.id, "Interrupt the current turn before reverting checkpoints.");
      return;
    }

    const targetThreadId = activeThread.id;
    const message = activeThread.messages.find((entry) => entry.id === request.messageId);
    setThreadReverting(targetThreadId, true);
    setThreadError(targetThreadId, null);
    try {
      // Images are read first: once the message is gone, so are its preview URLs.
      const { files: restoredImageFiles, failedNames: unrestoredImageNames } = message
        ? await fetchRevertedMessageImages(message)
        : { files: [], failedNames: [] };
      const readDraft = () =>
        useComposerDraftStore.getState().draftsByThreadId[targetThreadId] ?? null;
      if (
        !revertedImagesFitDraft({
          draftImages: readDraft()?.images ?? [],
          preparingImageCount: countPreparingComposerImages(targetThreadId),
          restoredFiles: restoredImageFiles,
        })
      ) {
        failRevertForImageRoom();
      }
      await waitForRevertedMessage({
        threadId: targetThreadId,
        messageId: request.messageId,
        turnCount: request.turnCount,
        revert: () =>
          api.orchestration.dispatchCommand(
            buildCheckpointRevertCommand({
              commandId: newCommandId(),
              threadId: targetThreadId,
              turnCount: request.turnCount,
              restoreFiles,
              createdAt: new Date().toISOString(),
            }),
          ),
      });
      const nextPrompt = mergeRevertedPrompt(readDraft()?.prompt ?? "", message?.text ?? "");
      setComposerDraftPrompt(targetThreadId, nextPrompt);
      restoreReviewComments(targetThreadId, restorableReviewComments(message?.text ?? ""));
      addComposerDraftImages(targetThreadId, buildRevertedComposerImages(restoredImageFiles));
      if (unrestoredImageNames.length > 0) {
        toastManager.add({ type: "warning", ...unrestoredImagesToast(unrestoredImageNames) });
      }
      if (message?.attachments?.some((attachment) => attachment.type === "file")) {
        toastManager.add({
          type: "info",
          title: "PDFs were not restored.",
          description: "Attach them again before sending.",
        });
      }
      if (currentThreadIdRef.current === targetThreadId) {
        promptRef.current = nextPrompt;
        const nextCursor = collapseExpandedComposerCursor(nextPrompt, nextPrompt.length);
        setComposerCursor(nextCursor);
        setComposerTrigger(detectComposerTrigger(nextPrompt, nextPrompt.length));
        window.requestAnimationFrame(() => {
          if (currentThreadIdRef.current === targetThreadId) {
            composerEditorRef.current?.focusAt(nextCursor);
          }
        });
      }
    } catch (err) {
      setThreadError(
        targetThreadId,
        err instanceof Error ? err.message : "Failed to revert thread state.",
      );
    }
    setThreadReverting(targetThreadId, false);
  });

  // Thread-bound so awaited work (the send redirect) keeps acting on the thread it started on.
  const respondToApprovalForThread = async (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => {
    const api = readNativeApi();
    if (!api) return;

    setRespondingRequestIds((existing) =>
      existing.includes(requestId) ? existing : [...existing, requestId],
    );
    await api.orchestration
      .dispatchCommand({
        type: "thread.approval.respond",
        commandId: newCommandId(),
        threadId,
        requestId,
        decision,
        createdAt: new Date().toISOString(),
      })
      .catch((err: unknown) => {
        setThreadError(
          threadId,
          err instanceof Error ? err.message : "Failed to submit approval decision.",
        );
      });
    setRespondingRequestIds((existing) => existing.filter((id) => id !== requestId));
  };
  const onRespondToApproval = useStableCallback(
    async (requestId: ApprovalRequestId, decision: ProviderApprovalDecision) => {
      if (!activeThreadId) return;
      await respondToApprovalForThread(activeThreadId, requestId, decision);
    },
  );

  const onRespondToUserInput = useCallback(
    async (requestId: ApprovalRequestId, answers: Record<string, unknown>) => {
      const api = readNativeApi();
      if (!api || !activeThreadId) return;

      setRespondingUserInputRequestIds((existing) =>
        existing.includes(requestId) ? existing : [...existing, requestId],
      );
      await api.orchestration
        .dispatchCommand({
          type: "thread.user-input.respond",
          commandId: newCommandId(),
          threadId: activeThreadId,
          requestId,
          answers,
          createdAt: new Date().toISOString(),
        })
        .catch((err: unknown) => {
          setThreadError(
            activeThreadId,
            err instanceof Error ? err.message : "Failed to submit user input.",
          );
        });
      setRespondingUserInputRequestIds((existing) => existing.filter((id) => id !== requestId));
    },
    [activeThreadId, setThreadError],
  );

  const onDismissPendingUserInput = useCallback(
    async (requestId: ApprovalRequestId) => {
      const api = readNativeApi();
      if (!api || !activeThreadId) return;

      setRespondingUserInputRequestIds((existing) =>
        existing.includes(requestId) ? existing : [...existing, requestId],
      );
      await api.orchestration
        .dispatchCommand({
          type: "thread.user-input.dismiss",
          commandId: newCommandId(),
          threadId: activeThreadId,
          requestId,
          createdAt: new Date().toISOString(),
        })
        .catch((err: unknown) => {
          setThreadError(
            activeThreadId,
            err instanceof Error ? err.message : "Failed to dismiss the question.",
          );
        });
      setRespondingUserInputRequestIds((existing) => existing.filter((id) => id !== requestId));
    },
    [activeThreadId, setThreadError],
  );

  const setActivePendingUserInputQuestionIndex = useCallback(
    (nextQuestionIndex: number) => {
      if (!activePendingDraftKey) {
        return;
      }
      setPendingUserInputQuestionIndexByKey((existing) => ({
        ...existing,
        [activePendingDraftKey]: nextQuestionIndex,
      }));
    },
    [activePendingDraftKey, setPendingUserInputQuestionIndexByKey],
  );

  const onSelectActivePendingUserInputOption = useStableCallback(
    (questionId: string, optionLabel: string) => {
      if (!activePendingDraftKey) {
        return;
      }
      // A custom answer outranks options, so typed text moves into the thread draft instead.
      const currentDraftPrompt = readComposerThreadPrompt(threadId);
      const nextDraftPrompt = carryDisplacedCustomAnswerIntoPrompt(
        currentDraftPrompt,
        activePendingDraftAnswers[questionId]?.customAnswer,
      );
      if (nextDraftPrompt !== currentDraftPrompt) {
        setPrompt(nextDraftPrompt);
        toastManager.add({
          type: "info",
          title: "Your typed text was set aside",
          description: "It will be back in the composer once the question is answered.",
          data: { threadId },
        });
      }
      const question = activePendingUserInput?.questions.find((q) => q.id === questionId);
      setPendingUserInputAnswersByKey((existing) => ({
        ...existing,
        [activePendingDraftKey]: {
          ...existing[activePendingDraftKey],
          [questionId]: question
            ? selectPendingUserInputOption(
                existing[activePendingDraftKey]?.[questionId],
                question,
                optionLabel,
              )
            : { selectedOptionLabel: optionLabel, customAnswer: "" },
        },
      }));
      promptRef.current = "";
      setComposerCursor(0);
      setComposerTrigger(null);
    },
  );

  const onChangeActivePendingUserInputCustomAnswer = useCallback(
    (
      questionId: string,
      value: string,
      nextCursor: number,
      expandedCursor: number,
      cursorAdjacentToMention: boolean,
    ) => {
      if (!activePendingDraftKey) {
        return;
      }
      promptRef.current = value;
      setPendingUserInputAnswersByKey((existing) => ({
        ...existing,
        [activePendingDraftKey]: {
          ...existing[activePendingDraftKey],
          [questionId]: setPendingUserInputCustomAnswer(
            existing[activePendingDraftKey]?.[questionId],
            value,
          ),
        },
      }));
      composerCursorRef.current = nextCursor;
      const nextTrigger = cursorAdjacentToMention
        ? null
        : detectComposerTrigger(value, expandedCursor);
      setDetectedComposerTrigger(nextTrigger);
    },
    [activePendingDraftKey, setDetectedComposerTrigger, setPendingUserInputAnswersByKey],
  );

  const onAdvanceActivePendingUserInput = useStableCallback(() => {
    if (!activePendingUserInput || !activePendingProgress) {
      return;
    }
    // Enter must not skip an unanswered question; the Next button is disabled in that case too.
    if (!activePendingProgress.canAdvance) {
      return;
    }
    if (activePendingProgress.isLastQuestion) {
      if (activePendingResolvedAnswers) {
        void onRespondToUserInput(activePendingUserInput.requestId, activePendingResolvedAnswers);
      }
      return;
    }
    setActivePendingUserInputQuestionIndex(activePendingProgress.questionIndex + 1);
  });

  const onPreviousActivePendingUserInputQuestion = useStableCallback(() => {
    if (!activePendingProgress) {
      return;
    }
    setActivePendingUserInputQuestionIndex(Math.max(activePendingProgress.questionIndex - 1, 0));
  });

  const onSubmitPlanFollowUp = useCallback(
    async ({
      text,
      interactionMode: nextInteractionMode,
    }: {
      text: string;
      interactionMode: "default" | "plan";
    }): Promise<boolean> => {
      const api = readNativeApi();
      if (
        !api ||
        !activeThread ||
        !isServerThread ||
        isSendBusy ||
        isConnecting ||
        sendInFlightThreadIdsRef.current.has(activeThread.id)
      ) {
        return false;
      }

      const trimmed = text.trim();
      if (!trimmed) {
        return false;
      }

      const threadIdForSend = activeThread.id;
      const messageIdForSend = newMessageId();
      const messageCreatedAt = new Date().toISOString();
      const outgoingMessageText = formatOutgoingPrompt({
        provider: selectedProvider,
        model: selectedModel,
        models: selectedProviderModels,
        effort: selectedPromptEffort,
        text: trimmed,
      });
      const lengthError = getComposerPromptLengthValidationMessage(outgoingMessageText);
      if (lengthError) {
        setThreadError(threadIdForSend, lengthError);
        return false;
      }

      sendInFlightThreadIdsRef.current.add(threadIdForSend);
      beginLocalDispatch({ preparingWorktree: false });
      setThreadError(threadIdForSend, null);
      setOptimisticUserMessages((existing) => [
        ...existing,
        {
          id: messageIdForSend,
          role: "user",
          text: outgoingMessageText,
          createdAt: messageCreatedAt,
          streaming: false,
        },
      ]);
      shouldAutoScrollRef.current = true;
      forceStickToBottom();
      // Built outside the try block: the React Compiler cannot lower conditional expressions inside try/catch.
      const turnStartCommand = {
        type: "thread.turn.start" as const,
        ...(useComposerContextStore.getState().freshContextThreads.has(threadIdForSend)
          ? { freshContext: true }
          : {}),
        commandId: newCommandId(),
        threadId: threadIdForSend,
        message: {
          messageId: messageIdForSend,
          role: "user" as const,
          text: outgoingMessageText,
          attachments: [],
        },
        modelSelection: selectedModelSelection,
        titleSeed: activeThread.title,
        runtimeMode,
        interactionMode: nextInteractionMode,
        ...(nextInteractionMode === "default" && activeProposedPlan
          ? {
              sourceProposedPlan: {
                threadId: activeThread.id,
                planId: activeProposedPlan.id,
              },
            }
          : {}),
        createdAt: messageCreatedAt,
      };
      const openPlanPanel = () => planPanelRef.current?.open();

      try {
        await persistThreadSettingsForNextTurn({
          threadId: threadIdForSend,
          createdAt: messageCreatedAt,
          modelSelection: selectedModelSelection,
          runtimeMode,
          interactionMode: nextInteractionMode,
        });

        // Keep the mode toggle and plan-follow-up banner in sync immediately
        // while the same-thread implementation turn is starting.
        setComposerDraftInteractionMode(threadIdForSend, nextInteractionMode);

        await api.orchestration.dispatchCommand(turnStartCommand);
        useComposerContextStore.getState().setFreshContext(threadIdForSend, false);
        // Optimistically open the plan sidebar when implementing (not refining).
        // "default" mode here means the agent is executing the plan, which produces
        // step-tracking activities that the sidebar will display.
        if (nextInteractionMode === "default") {
          openPlanPanel();
        }
        sendInFlightThreadIdsRef.current.delete(threadIdForSend);
        return true;
      } catch (err) {
        setOptimisticUserMessages((existing) =>
          existing.filter((message) => message.id !== messageIdForSend),
        );
        setThreadError(
          threadIdForSend,
          err instanceof Error ? err.message : "Failed to send plan follow-up.",
        );
        sendInFlightThreadIdsRef.current.delete(threadIdForSend);
        if (currentThreadIdRef.current === threadIdForSend) resetLocalDispatch();
        return false;
      }
    },
    [
      activeThread,
      activeProposedPlan,
      beginLocalDispatch,
      forceStickToBottom,
      isConnecting,
      isSendBusy,
      isServerThread,
      persistThreadSettingsForNextTurn,
      resetLocalDispatch,
      runtimeMode,
      selectedPromptEffort,
      selectedModelSelection,
      selectedProvider,
      selectedProviderModels,
      setComposerDraftInteractionMode,
      setThreadError,
      selectedModel,
    ],
  );

  // Only runs after the turn started: a failed send restores the composer on the sent thread.
  const openNewThreadAfterSend = async (input: {
    sentThreadId: ThreadId;
    projectId: ProjectId;
    followUp: ComposerSendFollowUp;
    draftOptions: ReturnType<typeof buildDraftOptionsAfterBackgroundSend>;
  }) => {
    // The sent draft stays marked promoting, so the new-thread flow skips it; the root
    // reconcile finalizes it once the server thread arrives, keeping the route valid meanwhile.
    if (currentThreadIdRef.current !== input.sentThreadId) return;
    // Outside the try: the React Compiler cannot lower conditionals inside try/catch.
    const newThreadOptions = input.followUp === "background" ? input.draftOptions : undefined;
    try {
      await createNewThread(input.projectId, newThreadOptions);
    } catch {
      toastManager.add({
        type: "warning",
        title: "Message sent, but a fresh composer could not be opened.",
      });
      return;
    }
    if (input.followUp !== "background") return;
    toastManager.add({
      type: "success",
      title: "Thread started",
      actionProps: {
        children: "Open",
        onClick: () => {
          void navigate({ to: "/$threadId", params: { threadId: input.sentThreadId } });
        },
      },
    });
  };

  // Declared before onSend, whose approval redirect interrupts the turn.
  const interruptThread = async (threadId: ThreadId) => {
    const api = readNativeApi();
    if (!api) return;
    await api.orchestration.dispatchCommand({
      type: "thread.turn.interrupt",
      commandId: newCommandId(),
      threadId,
      createdAt: new Date().toISOString(),
    });
  };
  // The thread.stop shortcut and the Stop button both call this.
  // False only when the turn was left running because no interrupt could be requested.
  const onInterrupt = useStableCallback(async (): Promise<boolean> => {
    if (!readNativeApi() || !activeThreadId) return false;
    // Re-check, so a stale canInterrupt does nothing.
    if (!canInterruptRunningTurn({ phase, sessionStatus: activeThread?.session?.status })) {
      return true;
    }
    // Recorded before the dispatch, so repeat presses stop here.
    if (!beginThreadStop(activeThreadId, activeThread?.session?.activeTurnId ?? null)) return true;
    try {
      await interruptThread(activeThreadId);
      return true;
    } catch (error) {
      clearThreadStop(activeThreadId);
      setThreadError(
        activeThreadId,
        error instanceof Error ? error.message : "Failed to interrupt the turn.",
      );
      return false;
    }
  });

  // The figures go stale once quota is being spent again.
  const usagePanelTurnKey = `${activeThread?.latestTurn?.turnId ?? ""}:${activePendingUserInput?.requestId ?? ""}`;
  const usagePanelTurnKeyRef = useRef(usagePanelTurnKey);
  useEffect(() => {
    if (usagePanelTurnKeyRef.current === usagePanelTurnKey) return;
    usagePanelTurnKeyRef.current = usagePanelTurnKey;
    setUsageLimitsPanelThreadId((current) => (current === activeThread?.id ? null : current));
  }, [activeThread?.id, usagePanelTurnKey]);

  const openUsageLimitsPanel = () => {
    setUsageLimitsPanelThreadId(activeThreadId);
    // Same RPC as the Refresh buttons: opening the panel re-probes on purpose so usage is fresh.
    void refreshProviderStatuses();
  };

  const clearComposerForSend = (targetThreadId: ThreadId) => {
    clearComposerDraftContent(targetThreadId);
    if (currentThreadIdRef.current !== targetThreadId) return;
    promptRef.current = "";
    setComposerHighlightedItemId(null);
    setComposerCursor(0);
    setComposerTrigger(null);
  };

  const freshContext = useComposerContextStore((state) => state.freshContextThreads.has(threadId));
  const setFreshContext = useComposerContextStore((state) => state.setFreshContext);

  const [isStashingPrompt, setIsStashingPrompt] = useState(false);
  const stashingPromptRef = useRef(false);
  const onStashError = useStableCallback((error: unknown) => {
    toastManager.add({
      type: "error",
      title: "Could not update stashed prompts",
      description: error instanceof Error ? error.message : "Device storage is unavailable.",
    });
  });
  const onStashPrompt = useStableCallback(async () => {
    if (stashingPromptRef.current || countPreparingComposerImages(threadId) > 0) return;
    const draft = useComposerDraftStore.getState().draftsByThreadId[threadId];
    const comments = useReviewCommentDraftStore.getState().commentsByThreadId[threadId] ?? [];
    if (
      !draft ||
      (!draft.prompt.trim() &&
        draft.images.length === 0 &&
        draft.terminalContexts.length === 0 &&
        comments.length === 0)
    )
      return;
    if (draft.images.reduce((bytes, image) => bytes + image.sizeBytes, 0) > 2 * 1024 * 1024) {
      onStashError(
        new Error(
          "This prompt has too much attachment data to stash on this device. Remove some attachments and try again.",
        ),
      );
      return;
    }
    stashingPromptRef.current = true;
    setIsStashingPrompt(true);
    try {
      const attachments = await Promise.all(
        draft.images.map(async (image) => ({
          id: image.id,
          name: image.name,
          mimeType: image.mimeType,
          sizeBytes: image.sizeBytes,
          dataUrl: await readFileAsDataUrl(image.file),
        })),
      );
      usePromptStashStore.getState().add({
        id: randomUUID(),
        prompt: draft.prompt,
        attachments,
        terminalContexts: draft.terminalContexts,
        reviewComments: comments,
        provider: selectedProvider,
        modelSelection: selectedModelSelection,
        runtimeMode,
        interactionMode,
        freshContext,
      });
      const current = useComposerDraftStore.getState().draftsByThreadId[threadId];
      const currentComments =
        useReviewCommentDraftStore.getState().commentsByThreadId[threadId] ?? [];
      if (
        current?.prompt === draft.prompt &&
        current.images === draft.images &&
        current.terminalContexts === draft.terminalContexts &&
        currentComments.length === comments.length &&
        currentComments.every((comment, i) => comment === comments[i])
      ) {
        clearComposerForSend(threadId);
        for (const image of draft.images) revokeBlobPreviewUrl(image.previewUrl);
        clearReviewComments(threadId);
        setFreshContext(threadId, false);
      }
    } catch (error) {
      onStashError(error);
    }
    stashingPromptRef.current = false;
    setIsStashingPrompt(false);
  });
  const onRestorePrompt = useStableCallback((entry: PromptStashEntry) => {
    if (
      composerDraftHasUserContent(threadId) ||
      (useReviewCommentDraftStore.getState().commentsByThreadId[threadId]?.length ?? 0) > 0
    )
      return;
    try {
      const images = hydrateImagesFromPersisted(entry.attachments);
      if (images.length !== entry.attachments.length) {
        for (const image of images) revokeBlobPreviewUrl(image.previewUrl);
        onStashError(
          new Error("A saved attachment could not be read. The stashed prompt was kept."),
        );
        return;
      }
      const store = useComposerDraftStore.getState();
      store.setPrompt(threadId, entry.prompt);
      store.addImages(threadId, images);
      store.setTerminalContexts(threadId, [...entry.terminalContexts]);
      store.setModelSelection(threadId, entry.modelSelection);
      store.setRuntimeMode(threadId, entry.runtimeMode);
      store.setInteractionMode(threadId, entry.interactionMode);
      restoreReviewComments(threadId, entry.reviewComments);
      setFreshContext(threadId, entry.freshContext);
      usePromptStashStore.getState().remove(entry.id);
      scheduleComposerFocus();
    } catch (error) {
      onStashError(error);
    }
  });

  const onSend = async (
    e?: { preventDefault: () => void },
    options?: { followUp?: ComposerSendFollowUp },
  ) => {
    e?.preventDefault();
    const sendFollowUp = options?.followUp ?? null;
    const api = readNativeApi();
    if (
      !api ||
      !activeThread ||
      isSendBusy ||
      // A send now would hit the "Select a base branch" error while the list is still loading.
      worktreeBase.isResolving ||
      isConnecting ||
      isRevertingCheckpoint ||
      sendInFlightThreadIdsRef.current.has(activeThread.id)
    ) {
      return;
    }
    if (/^\/clear\s*$/i.test(promptRef.current.trim())) {
      setFreshContext(activeThread.id, true);
      setPrompt("");
      setComposerTrigger(null);
      return;
    }
    composerTypingGuard.onSend();
    if (activePendingProgress) {
      onAdvanceActivePendingUserInput();
      return;
    }
    // Opens the panel and starts no turn, so nothing below (running, approvals) applies to it.
    if (
      composerImages.length === 0 &&
      composerTerminalContexts.length === 0 &&
      composerReviewComments.length === 0 &&
      isStandaloneUsageLimitsSlashCommand(promptRef.current)
    ) {
      openUsageLimitsPanel();
      clearComposerForSend(activeThread.id);
      return;
    }
    // Sending during an approval declines it and stops the turn; the message follows once it ends.
    if (pendingApprovals.length > 0) {
      const redirectSendState = deriveComposerSendState({
        prompt: promptRef.current,
        imageCount: composerImages.length,
        terminalContexts: composerTerminalContexts,
        reviewCommentCount: composerReviewComments.length,
      });
      if (!redirectSendState.hasSendableContent) {
        return;
      }
      // Apply the normal path's rejections first, so the approval is left alone when nothing
      // will be sent.
      const redirectSlashCommand =
        composerImages.length === 0 &&
        redirectSendState.sendableTerminalContexts.length === 0 &&
        composerReviewComments.length === 0
          ? parseStandaloneComposerSlashCommand(redirectSendState.trimmedPrompt)
          : null;
      if (redirectSlashCommand) {
        handleInteractionModeChange(redirectSlashCommand);
        clearComposerForSend(activeThread.id);
        return;
      }
      const redirectLengthError = getComposerPromptLengthValidationMessage(
        buildComposerOutgoingMessageText({
          prompt: promptRef.current,
          terminalContexts: redirectSendState.sendableTerminalContexts,
          reviewComments: composerReviewComments,
          provider: selectedProvider,
          model: selectedModel,
          models: selectedProviderModels,
          effort: selectedPromptEffort,
        }),
      );
      if (redirectLengthError) {
        setThreadError(activeThread.id, redirectLengthError);
        return;
      }
      const redirectThreadId = activeThread.id;
      sendInFlightThreadIdsRef.current.add(redirectThreadId);
      const result = await redirectPendingApprovals({
        shownApprovalIds: pendingApprovals.map((approval) => approval.requestId),
        // After a thread switch the ref holds the other thread's approvals, which must not count.
        readPendingApprovalIds: () =>
          currentThreadIdRef.current === redirectThreadId
            ? pendingApprovalsRef.current.map((approval) => approval.requestId)
            : [],
        readRespondingRequestIds: () => respondingRequestIdsRef.current,
        readDraft: () => useComposerDraftStore.getState().draftsByThreadId[redirectThreadId],
        respondToApproval: (requestId, decision) =>
          respondToApprovalForThread(redirectThreadId, requestId, decision),
        interruptTurn: () => interruptThread(redirectThreadId),
        isStillCurrent: () => currentThreadIdRef.current === redirectThreadId,
      }).finally(() => {
        sendInFlightThreadIdsRef.current.delete(redirectThreadId);
      });
      if (result.status === "redirected") {
        if (currentThreadIdRef.current === redirectThreadId) {
          setQueuedSendThreadId(redirectThreadId);
        }
        return;
      }
      const toast = composerApprovalRedirectToast(result);
      if (toast) toastManager.add({ type: "info", ...toast });
      return;
    }
    // Sending mid-turn would cut the running turn short; hold the message until it ends.
    // Likewise hold it while pasted images are still being fitted.
    if (phase === "running" || hasPendingImageFits) {
      const queued = resolveQueuedSendFollowUp({
        isRunning: phase === "running",
        followUp: sendFollowUp,
      });
      // One queue per view: a new hold replaces one kept for another thread, whose draft remains.
      if (queuedSendThreadId !== null && queuedSendThreadId !== activeThread.id) {
        queuedSendHeldForResumeRef.current = false;
        toastManager.add({
          type: "info",
          title: "The message held in another thread was not sent.",
          description: "It is still in that thread's draft.",
        });
      }
      queuedSendFollowUpRef.current = queued.followUp;
      setQueuedSendThreadId(activeThread.id);
      if (queued.droppedFollowUp) {
        toastManager.add({
          type: "info",
          title: "Message queued until the turn ends.",
          description: "Open a new thread once it has been sent.",
        });
      }
      return;
    }
    const promptForSend = promptRef.current;
    const {
      trimmedPrompt: trimmed,
      sendableTerminalContexts: sendableComposerTerminalContexts,
      expiredTerminalContextCount,
      hasSendableContent,
    } = deriveComposerSendState({
      prompt: promptForSend,
      imageCount: composerImages.length,
      terminalContexts: composerTerminalContexts,
      reviewCommentCount: composerReviewComments.length,
    });
    if (showPlanFollowUpPrompt && activeProposedPlan) {
      // An empty draft with review comments refines the plan with just those comments: implementing
      // it would leave the comments behind without saying so.
      const followUp = resolvePlanFollowUpSubmission({
        draftText: appendReviewCommentsToPrompt(trimmed, composerReviewComments),
        planMarkdown: activeProposedPlan.planMarkdown,
      });
      const followUpOutgoingText = formatOutgoingPrompt({
        provider: selectedProvider,
        model: selectedModel,
        models: selectedProviderModels,
        effort: selectedPromptEffort,
        text: followUp.text.trim(),
      });
      // An empty draft implements the plan, whose text the user did not type.
      const followUpLengthError =
        followUp.interactionMode === "default"
          ? getPlanImplementationLengthValidationMessage(followUpOutgoingText)
          : getComposerPromptLengthValidationMessage(followUpOutgoingText);
      if (followUpLengthError) {
        setThreadError(activeThread.id, followUpLengthError);
        return;
      }
      const followUpThreadId = activeThread.id;
      const followUpSnapshot = {
        prompt: promptForSend,
        terminalContexts: [...composerTerminalContexts],
        images: [...composerImages],
      };
      const followUpReviewComments = [...composerReviewComments];
      clearComposerForSend(followUpThreadId);
      clearReviewComments(followUpThreadId);
      const followUpSent = await onSubmitPlanFollowUp({
        text: followUp.text,
        interactionMode: followUp.interactionMode,
      });
      if (!followUpSent) {
        restoreReviewComments(followUpThreadId, followUpReviewComments);
        restorePlanFollowUpComposer({
          snapshot: followUpSnapshot,
          draftHasUserContent: composerDraftHasUserContent(followUpThreadId),
          threadIsCurrent: currentThreadIdRef.current === followUpThreadId,
          writeComposerRefs: (snapshot) => {
            promptRef.current = snapshot.prompt;
            composerTerminalContextsRef.current = [...snapshot.terminalContexts];
          },
          writePrompt: (prompt) => setComposerDraftPrompt(followUpThreadId, prompt),
          writeTerminalContexts: (contexts) =>
            setComposerDraftTerminalContexts(followUpThreadId, [...contexts]),
          writeImages: (images) =>
            addComposerDraftImages(followUpThreadId, images.map(cloneComposerImageForRetry)),
          resetCursor: ({ cursor, prompt }) => {
            setComposerCursor(cursor);
            setComposerTrigger(detectComposerTrigger(prompt, prompt.length));
          },
        });
      }
      return;
    }
    const multiModelSelections = isLocalDraftThread
      ? readComposerMultiModelSelections(activeThread.id)
      : null;
    const standaloneSlashCommand =
      composerImages.length === 0 &&
      sendableComposerTerminalContexts.length === 0 &&
      composerReviewComments.length === 0 &&
      // With several models selected, a prompt of exactly `/plan` is what gets sent.
      !multiModelSelections
        ? parseStandaloneComposerSlashCommand(trimmed)
        : null;
    if (standaloneSlashCommand) {
      handleInteractionModeChange(standaloneSlashCommand);
      clearComposerForSend(activeThread.id);
      return;
    }
    if (!hasSendableContent) {
      if (expiredTerminalContextCount > 0) {
        const toastCopy = buildExpiredTerminalContextToastCopy(
          expiredTerminalContextCount,
          "empty",
        );
        toastManager.add({
          type: "warning",
          title: toastCopy.title,
          description: toastCopy.description,
        });
      }
      return;
    }
    if (!activeProject) return;
    if (multiModelSelections) {
      const multiThreadId = activeThread.id;
      if (expiredTerminalContextCount > 0) {
        const toastCopy = buildExpiredTerminalContextToastCopy(
          expiredTerminalContextCount,
          "omitted",
        );
        toastManager.add({
          type: "warning",
          title: toastCopy.title,
          description: toastCopy.description,
        });
      }
      sendInFlightThreadIdsRef.current.add(multiThreadId);
      beginLocalDispatch({ preparingWorktree: true });
      await sendComposerMultiModel({
        threadId: multiThreadId,
        isGitRepo,
        baseBranch: worktreeBaseBranch,
        selections: multiModelSelections,
        primarySelection: selectedModelSelection,
        providers: providerStatuses,
        project: {
          id: activeProject.id,
          cwd: activeProject.cwd,
          scripts: activeProject.scripts,
        },
        prompt: promptForSend,
        trimmedPrompt: trimmed,
        images: [...composerImages],
        terminalContexts: [...sendableComposerTerminalContexts],
        reviewComments: [...composerReviewComments],
        runtimeMode,
        interactionMode,
        api,
        createWorktree,
        isThreadCurrent: () => currentThreadIdRef.current === multiThreadId,
        reportError: (message) => setThreadError(multiThreadId, message),
        clearComposer: () => {
          clearComposerForSend(multiThreadId);
          clearReviewComments(multiThreadId);
        },
        onComposerRestored: (restoredPrompt) => {
          if (currentThreadIdRef.current !== multiThreadId) return;
          promptRef.current = restoredPrompt;
          setComposerCursor(collapseExpandedComposerCursor(restoredPrompt, restoredPrompt.length));
          setComposerTrigger(detectComposerTrigger(restoredPrompt, restoredPrompt.length));
        },
        openDraft: () => void navigate({ to: "/$threadId", params: { threadId: multiThreadId } }),
        onComposerReleased: () => {
          sendInFlightThreadIdsRef.current.delete(multiThreadId);
          if (currentThreadIdRef.current === multiThreadId) resetLocalDispatch();
        },
      });
      return;
    }
    const threadIdForSend = activeThread.id;
    const isFirstMessage = !isServerThread || activeThread.messages.length === 0;
    const { shouldCreateWorktree, baseBranchForWorktree } = resolveWorktreeSendPlan({
      isFirstMessage,
      envMode,
      branch: worktreeBaseBranch,
      worktreePath: activeThread.worktreePath,
    });

    // In worktree mode, require an explicit base branch so we don't silently
    // fall back to local execution when branch selection is missing.
    if (shouldCreateWorktree && !worktreeBaseBranch) {
      setThreadError(threadIdForSend, "Select a base branch before sending in New worktree mode.");
      return;
    }

    const draftOptionsAfterBackgroundSend = buildDraftOptionsAfterBackgroundSend({
      envMode,
      branch: activeThread.branch,
      worktreePath: activeThread.worktreePath,
    });
    const composerImagesSnapshot = [...composerImages];
    const composerTerminalContextsSnapshot = [...sendableComposerTerminalContexts];
    const composerReviewCommentsSnapshot = [...composerReviewComments];
    const outgoingMessageText = buildComposerOutgoingMessageText({
      prompt: promptForSend,
      terminalContexts: composerTerminalContextsSnapshot,
      reviewComments: composerReviewCommentsSnapshot,
      hasNonImageAttachment: composerImagesSnapshot.some(
        (attachment) => !attachment.mimeType.startsWith("image/"),
      ),
      provider: selectedProvider,
      model: selectedModel,
      models: selectedProviderModels,
      effort: selectedPromptEffort,
    });
    // Over-limit input would fail provider validation after the draft is cleared; keep it instead.
    const promptLengthError = getComposerPromptLengthValidationMessage(outgoingMessageText);
    if (promptLengthError) {
      setThreadError(threadIdForSend, promptLengthError);
      return;
    }

    sendInFlightThreadIdsRef.current.add(threadIdForSend);
    beginLocalDispatch({ preparingWorktree: Boolean(baseBranchForWorktree) });

    const messageIdForSend = newMessageId();
    const messageCreatedAt = new Date().toISOString();
    const turnAttachmentsPromise = buildTurnStartImageAttachments(composerImagesSnapshot);
    setOptimisticUserMessages((existing) => [
      ...existing,
      buildOptimisticUserMessage({
        id: messageIdForSend,
        text: outgoingMessageText,
        images: composerImagesSnapshot,
        createdAt: messageCreatedAt,
      }),
    ]);
    // Sending a message should always bring the latest user turn into view.
    shouldAutoScrollRef.current = true;
    forceStickToBottom();

    setThreadError(threadIdForSend, null);
    if (expiredTerminalContextCount > 0) {
      const toastCopy = buildExpiredTerminalContextToastCopy(
        expiredTerminalContextCount,
        "omitted",
      );
      toastManager.add({
        type: "warning",
        title: toastCopy.title,
        description: toastCopy.description,
      });
    }
    clearComposerForSend(threadIdForSend);
    clearReviewComments(threadIdForSend);

    const draftThreadForSend = isLocalDraftThread ? draftThread : null;
    if (isLocalDraftThread) {
      useComposerDraftStore.getState().setDraftThreadPromoting(threadIdForSend, true);
    }
    const sendResult = await runComposerSingleSend(
      {
        thread: {
          id: threadIdForSend,
          createdAt: activeThread.createdAt,
          branch: activeThread.branch,
          worktreePath: activeThread.worktreePath,
          isServer: isServerThread,
          isLocalDraft: isLocalDraftThread,
          isFirstMessage,
        },
        project: activeProject,
        message: {
          id: messageIdForSend,
          text: outgoingMessageText,
          title: deriveSendThreadTitle({
            trimmedPrompt: trimmed,
            images: composerImagesSnapshot,
            terminalContexts: composerTerminalContextsSnapshot,
            reviewComments: composerReviewCommentsSnapshot,
          }),
          createdAt: messageCreatedAt,
          attachments: turnAttachmentsPromise,
        },
        freshContext,
        settings: { modelSelection: selectedModelSelection, runtimeMode, interactionMode },
        threadCreateModelSelection: buildThreadCreateModelSelection({
          provider: selectedProvider,
          model: selectedModel,
          projectDefaultModel: activeProject.defaultModelSelection?.model,
          options: selectedModelSelection.options,
        }),
        persistModelSelection: Boolean(selectedModel),
        worktree: { baseBranch: baseBranchForWorktree, localBranch: currentGitBranch },
      },
      {
        dispatchCommand: (command) => api.orchestration.dispatchCommand(command),
        prepareWorktree: (baseBranch) =>
          prepareWorktree({
            threadId: threadIdForSend,
            cwd: activeProject.cwd,
            branch: baseBranch,
            canWorkLocally: isLocalDraftThread,
          }),
        updateThreadContext: (context, workedLocally) => {
          if (workedLocally) {
            setDraftThreadContext(threadIdForSend, { ...context, envMode: "local" });
            if (currentThreadIdRef.current === threadIdForSend) {
              beginLocalDispatch({ preparingWorktree: false });
            }
          } else if (isServerThread) {
            // The terminal drawer must immediately use the worktree cwd and environment.
            setStoreThreadBranch(threadIdForSend, context.branch, context.worktreePath);
          }
        },
        runProjectScript,
        persistSettings: persistThreadSettingsForNextTurn,
        onReadyToSend: () => {
          if (currentThreadIdRef.current === threadIdForSend) {
            beginLocalDispatch({ preparingWorktree: false });
          }
        },
      },
    );
    const turnStartSucceeded = sendResult.status === "sent";
    if (turnStartSucceeded) setFreshContext(threadIdForSend, false);
    if (sendResult.status === "failed") {
      const { error: err, createdServerThread: createdServerThreadForLocalDraft } = sendResult;
      const sendErrorMessage = resolveFailedSendErrorMessage(err);
      // The user left the draft (e.g. Cmd+N while the worktree was created): the failed draft
      // has no sidebar row, so offer a way back to it.
      const leftFailedDraft =
        Boolean(draftThreadForSend) && currentThreadIdRef.current !== threadIdForSend;
      const notifyLeftFailedDraft = (targetThreadId: ThreadId) => {
        if (!leftFailedDraft || sendErrorMessage === null) return;
        toastManager.add({
          type: "error",
          title: "Could not start thread",
          description: sendErrorMessage,
          actionProps: {
            children: "Open draft",
            onClick: () =>
              void navigate({ to: "/$threadId", params: { threadId: targetThreadId } }),
          },
        });
      };
      // Failed before thread.create: the draft is reusable again.
      if (draftThreadForSend && !createdServerThreadForLocalDraft) {
        useComposerDraftStore.getState().setDraftThreadPromoting(threadIdForSend, false);
      }
      const movesToRetryDraft = createdServerThreadForLocalDraft && Boolean(draftThreadForSend);
      // The on-screen refs only describe the failed thread while it is still the visible one.
      const shouldRestoreComposer = shouldRestoreComposerAfterFailedSend({
        turnStartSucceeded,
        movesToRetryDraft,
        threadIsCurrent: currentThreadIdRef.current === threadIdForSend,
        draftHasUserContent: composerDraftHasUserContent(threadIdForSend),
        liveComposerEmpty:
          promptRef.current.length === 0 &&
          composerImagesRef.current.length === 0 &&
          composerTerminalContextsRef.current.length === 0,
      });
      // A cancel was the user's own choice, so no bubble may stay behind looking sent, even when
      // the composer took new text meanwhile.
      const isCancelled = err instanceof ComposerSendCancelledError;
      if (shouldRestoreComposer || isCancelled) {
        setOptimisticUserMessages((existing) => {
          const removed = existing.filter((message) => message.id === messageIdForSend);
          for (const message of removed) {
            revokeUserMessagePreviewUrls(message);
          }
          const next = existing.filter((message) => message.id !== messageIdForSend);
          return next.length === existing.length ? existing : next;
        });
      }
      if (createdServerThreadForLocalDraft) {
        if (draftThreadForSend) {
          // thread.deleted wipes every draft keyed by this id, so restore into a fresh draft thread.
          const retryThreadId = newThreadId();
          moveFailedFirstSendToDraftThread({
            fromThreadId: threadIdForSend,
            toThreadId: retryThreadId,
            projectId: activeProject.id,
            draftThread: { ...draftThreadForSend, createdAt: new Date().toISOString() },
            restore: shouldRestoreComposer
              ? {
                  prompt: promptForSend,
                  images: composerImagesSnapshot.map(cloneComposerImageForRetry),
                  terminalContexts: composerTerminalContextsSnapshot,
                }
              : null,
          });
          if (shouldRestoreComposer) {
            restoreReviewComments(retryThreadId, composerReviewCommentsSnapshot);
          }
          setThreadError(retryThreadId, sendErrorMessage);
          notifyLeftFailedDraft(retryThreadId);
          if (currentThreadIdRef.current === threadIdForSend) {
            await navigate({
              to: "/$threadId",
              params: { threadId: retryThreadId },
              replace: true,
            }).catch(() => undefined);
          }
        }
        await api.orchestration
          .dispatchCommand({
            type: "thread.delete",
            commandId: newCommandId(),
            threadId: threadIdForSend,
          })
          .catch(() => undefined);
      }
      if (!createdServerThreadForLocalDraft || !draftThreadForSend) {
        if (shouldRestoreComposer) {
          const isFailedThreadVisible = currentThreadIdRef.current === threadIdForSend;
          if (isFailedThreadVisible) promptRef.current = promptForSend;
          setPrompt(promptForSend);
          addComposerImagesToDraft(composerImagesSnapshot.map(cloneComposerImageForRetry));
          addComposerTerminalContextsToDraft(composerTerminalContextsSnapshot);
          restoreReviewComments(threadIdForSend, composerReviewCommentsSnapshot);
          if (isFailedThreadVisible) {
            setComposerCursor(collapseExpandedComposerCursor(promptForSend, promptForSend.length));
            setComposerTrigger(detectComposerTrigger(promptForSend, promptForSend.length));
          }
        } else if (isCancelled && currentThreadIdRef.current === threadIdForSend) {
          // setPrompt overwrites, while the images and contexts helpers append.
          const mergedPrompt = promptRef.current
            ? `${promptForSend}\n\n${promptRef.current}`
            : promptForSend;
          promptRef.current = mergedPrompt;
          setPrompt(mergedPrompt);
          addComposerImagesToDraft(composerImagesSnapshot.map(cloneComposerImageForRetry));
          addComposerTerminalContextsToDraft(composerTerminalContextsSnapshot);
          restoreReviewComments(threadIdForSend, composerReviewCommentsSnapshot);
          setComposerCursor(collapseExpandedComposerCursor(mergedPrompt, mergedPrompt.length));
        }
        setThreadError(threadIdForSend, sendErrorMessage);
        if (!createdServerThreadForLocalDraft) notifyLeftFailedDraft(threadIdForSend);
      }
    }
    sendInFlightThreadIdsRef.current.delete(threadIdForSend);
    if (!turnStartSucceeded && currentThreadIdRef.current === threadIdForSend) {
      resetLocalDispatch();
    }
    if (turnStartSucceeded && sendFollowUp !== null) {
      await openNewThreadAfterSend({
        sentThreadId: threadIdForSend,
        projectId: activeProject.id,
        followUp: sendFollowUp,
        draftOptions: draftOptionsAfterBackgroundSend,
      });
    }
  };
  const onSendLatest = useStableCallback(onSend);

  const heldAnswerAwaitingDelivery = activeThread
    ? hasHeldAnswerAwaitingDelivery(activeThread)
    : false;
  // Flush a message queued during a turn once the session stops running.
  useEffect(() => {
    if (queuedSendThreadId === null) return;
    if (queuedSendThreadId !== activeThread?.id) {
      // That hold can last hours, so a look at another thread must not lose the send.
      if (queuedSendHeldForResumeRef.current) return;
      queuedSendFollowUpRef.current = null;
      setQueuedSendThreadId(null);
      return;
    }
    // While a usage-limit resume is armed, a flushed message would count as newer and cancel it.
    queuedSendHeldForResumeRef.current = armedUsageLimitResume !== null;
    if (
      phase === "running" ||
      isSendBusy ||
      isConnecting ||
      hasPendingImageFits ||
      armedUsageLimitResume !== null ||
      // The reactor is about to send it as a turn; flushing now would race it into two turn starts.
      heldAnswerAwaitingDelivery
    ) {
      return;
    }
    setQueuedSendThreadId(null);
    const followUp = queuedSendFollowUpRef.current;
    queuedSendFollowUpRef.current = null;
    void onSendLatest(undefined, followUp ? { followUp } : undefined);
  }, [
    activeThread?.id,
    armedUsageLimitResume,
    hasPendingImageFits,
    heldAnswerAwaitingDelivery,
    isConnecting,
    isSendBusy,
    onSendLatest,
    phase,
    queuedSendThreadId,
  ]);

  // Stable identity for the memoized composer; `onSend` closes over fresh state each render.
  const onSendStable = useCallback(
    (e?: { preventDefault: () => void }) => {
      void onSendLatest(e);
    },
    [onSendLatest],
  );

  // Exact text: no effort prefix, no plan follow-up, no attachments, and the draft stays as it is.
  const sendThreadControlMessage = useStableCallback(async (text: string): Promise<boolean> => {
    const api = readNativeApi();
    if (
      !api ||
      !activeThread ||
      !isServerThread ||
      isSendBusy ||
      isConnecting ||
      isRevertingCheckpoint ||
      sendInFlightThreadIdsRef.current.has(activeThread.id)
    ) {
      return false;
    }
    const threadIdForSend = activeThread.id;
    const messageIdForSend = newMessageId();
    const messageCreatedAt = new Date().toISOString();
    sendInFlightThreadIdsRef.current.add(threadIdForSend);
    beginLocalDispatch({ preparingWorktree: false });
    setThreadError(threadIdForSend, null);
    setOptimisticUserMessages((existing) => [
      ...existing,
      {
        id: messageIdForSend,
        role: "user",
        text,
        createdAt: messageCreatedAt,
        streaming: false,
      },
    ]);
    shouldAutoScrollRef.current = true;
    forceStickToBottom();
    let sent = false;
    try {
      await api.orchestration.dispatchCommand({
        type: "thread.turn.start",
        commandId: newCommandId(),
        threadId: threadIdForSend,
        message: {
          messageId: messageIdForSend,
          role: "user",
          text,
          attachments: [],
        },
        modelSelection: selectedModelSelection,
        titleSeed: activeThread.title,
        runtimeMode,
        interactionMode,
        createdAt: messageCreatedAt,
      });
      sent = true;
    } catch (err) {
      setOptimisticUserMessages((existing) =>
        existing.filter((message) => message.id !== messageIdForSend),
      );
      setThreadError(
        threadIdForSend,
        err instanceof Error ? err.message : "Failed to send message.",
      );
    }
    sendInFlightThreadIdsRef.current.delete(threadIdForSend);
    // A control command may start no turn, so the session might never acknowledge a held dispatch.
    if (currentThreadIdRef.current === threadIdForSend) resetLocalDispatch();
    return sent;
  });

  const composerHasDraftText = useComposerDraftStore(
    (store) => (store.draftsByThreadId[threadId]?.prompt ?? "").trim().length > 0,
  );
  const compactBlockers = {
    isRunning: isWorking,
    hasPendingRequest: pendingApprovals.length > 0 || pendingUserInputs.length > 0,
    hasPlanFollowUp: showPlanFollowUpPrompt,
  };
  const hasDraftContext =
    composerImages.length > 0 ||
    composerTerminalContexts.length > 0 ||
    composerReviewComments.length > 0;
  const compactDisabledReason = resolveCompactDisabledReason({
    ...compactBlockers,
    hasDraft: composerHasDraftText || hasDraftContext,
  });
  const onCompactThread = useStableCallback(() => {
    if (compactDisabledReason !== null) return;
    void sendThreadControlMessage("/compact");
  });
  // Reads the prompt after the menu removed its own trigger text, so that text is not a draft.
  const onCompactFromSlashMenu = () => {
    const reason = resolveCompactDisabledReason({
      ...compactBlockers,
      hasDraft: promptRef.current.trim().length > 0 || hasDraftContext,
    });
    if (reason !== null) {
      toastManager.add({ type: "info", title: reason });
      return;
    }
    void sendThreadControlMessage("/compact");
  };

  const threadGoal = deriveThreadGoal(activeThread?.activities ?? EMPTY_ACTIVITIES);
  const onClearThreadGoal = useStableCallback(async () => {
    if (phase === "running") {
      // The stop lands as a settled session, so the clear goes out once the thread can take it.
      // Armed first: the session can settle before the dispatch resolves, and a ref re-runs no effect.
      if (!activeThreadId) return;
      const armedThreadId = activeThreadId;
      goalClearAfterStopThreadIdsRef.current.add(armedThreadId);
      if (!(await onInterrupt())) goalClearAfterStopThreadIdsRef.current.delete(armedThreadId);
      return;
    }
    await sendThreadControlMessage("/goal clear");
  });
  // The running turn must end first, or the control message would count as a new prompt mid-turn.
  useEffect(() => {
    if (
      !activeThreadId ||
      !goalClearAfterStopThreadIdsRef.current.has(activeThreadId) ||
      phase === "running" ||
      isSendBusy ||
      isConnecting ||
      isRevertingCheckpoint ||
      sendInFlightThreadIdsRef.current.has(activeThreadId)
    ) {
      return;
    }
    goalClearAfterStopThreadIdsRef.current.delete(activeThreadId);
    void sendThreadControlMessage("/goal clear");
  }, [
    activeThreadId,
    isConnecting,
    isRevertingCheckpoint,
    isSendBusy,
    phase,
    sendThreadControlMessage,
  ]);

  const onImplementPlanInNewThread = useStableCallback(async () => {
    const api = readNativeApi();
    if (
      !api ||
      !activeThread ||
      !activeProject ||
      !activeProposedPlan ||
      !isServerThread ||
      isSendBusy ||
      isConnecting ||
      sendInFlightThreadIdsRef.current.has(activeThread.id)
    ) {
      return;
    }

    const createdAt = new Date().toISOString();
    const nextThreadId = newThreadId();
    const planMarkdown = activeProposedPlan.planMarkdown;
    const implementationPrompt = buildPlanImplementationPrompt(planMarkdown);
    const outgoingImplementationPrompt = formatOutgoingPrompt({
      provider: selectedProvider,
      model: selectedModel,
      models: selectedProviderModels,
      effort: selectedPromptEffort,
      text: implementationPrompt,
    });
    const implementationLengthError = getPlanImplementationLengthValidationMessage(
      outgoingImplementationPrompt,
    );
    if (implementationLengthError) {
      setThreadError(activeThread.id, implementationLengthError);
      return;
    }
    const nextThreadTitle = truncate(buildPlanImplementationThreadTitle(planMarkdown));
    const nextThreadModelSelection: ModelSelection = selectedModelSelection;

    const sourceThreadId = activeThread.id;
    sendInFlightThreadIdsRef.current.add(sourceThreadId);
    beginLocalDispatch({ preparingWorktree: false });
    const finish = () => {
      sendInFlightThreadIdsRef.current.delete(sourceThreadId);
      if (currentThreadIdRef.current === sourceThreadId) resetLocalDispatch();
    };

    await api.orchestration
      .dispatchCommand({
        type: "thread.create",
        commandId: newCommandId(),
        threadId: nextThreadId,
        projectId: activeProject.id,
        title: nextThreadTitle,
        modelSelection: nextThreadModelSelection,
        // A new thread starts in the configured default, not the source thread's mode.
        runtimeMode: settings.defaultRuntimeMode,
        interactionMode: "default",
        branch: activeThread.branch,
        worktreePath: activeThread.worktreePath,
        createdAt,
      })
      .then(() => {
        return api.orchestration.dispatchCommand({
          type: "thread.turn.start",
          commandId: newCommandId(),
          threadId: nextThreadId,
          message: {
            messageId: newMessageId(),
            role: "user",
            text: outgoingImplementationPrompt,
            attachments: [],
          },
          modelSelection: selectedModelSelection,
          titleSeed: nextThreadTitle,
          runtimeMode: settings.defaultRuntimeMode,
          interactionMode: "default",
          sourceProposedPlan: {
            threadId: activeThread.id,
            planId: activeProposedPlan.id,
          },
          createdAt,
        });
      })
      .then(() => {
        return waitForStartedServerThread(nextThreadId);
      })
      .then(() => {
        // Signal that the plan sidebar should open on the new thread.
        planPanelRef.current?.setOpenOnNextThread();
        return navigate({
          to: "/$threadId",
          params: { threadId: nextThreadId },
        });
      })
      .catch(async (err) => {
        await api.orchestration
          .dispatchCommand({
            type: "thread.delete",
            commandId: newCommandId(),
            threadId: nextThreadId,
          })
          .catch(() => undefined);
        toastManager.add({
          type: "error",
          title: "Could not start implementation thread",
          description:
            err instanceof Error ? err.message : "An error occurred while creating the new thread.",
        });
      })
      .then(finish, finish);
  });

  const onProviderModelSelect = useStableCallback((provider: ProviderKind, model: string) => {
    if (!activeThread) return;
    const resolvedProvider = resolveSelectableProvider(providerStatuses, provider);
    const resolvedModel = resolveAppModelSelection(
      resolvedProvider,
      settings,
      providerStatuses,
      model,
    );
    const nextModelSelection: ModelSelection = {
      provider: resolvedProvider,
      model: resolvedModel,
    };
    setComposerDraftModelSelection(activeThread.id, nextModelSelection);
    setStickyComposerModelSelection(nextModelSelection);
    scheduleComposerFocus();
  });
  const setPromptFromTraits = useStableCallback((nextPrompt: string) => {
    const currentPrompt = promptRef.current;
    if (nextPrompt === currentPrompt) {
      scheduleComposerFocus();
      return;
    }
    promptRef.current = nextPrompt;
    setPrompt(nextPrompt);
    const nextCursor = collapseExpandedComposerCursor(nextPrompt, nextPrompt.length);
    setComposerCursor(nextCursor);
    // Detected, not reset, so picking Ultrathink keeps an Escape dismissal.
    setDetectedComposerTrigger(detectComposerTrigger(nextPrompt, nextPrompt.length));
    scheduleComposerFocus();
  });
  const applyPromptReplacement = useCallback(
    (
      rangeStart: number,
      rangeEnd: number,
      replacement: string,
      options?: { expectedText?: string; expandedCursorAfterReplace?: number },
    ): boolean => {
      const currentText = promptRef.current;
      const safeStart = Math.max(0, Math.min(currentText.length, rangeStart));
      const safeEnd = Math.max(safeStart, Math.min(currentText.length, rangeEnd));
      if (
        options?.expectedText !== undefined &&
        currentText.slice(safeStart, safeEnd) !== options.expectedText
      ) {
        return false;
      }
      const next = replaceTextRange(promptRef.current, rangeStart, rangeEnd, replacement);
      const nextCursor = collapseExpandedComposerCursor(
        next.text,
        options?.expandedCursorAfterReplace ?? next.cursor,
      );
      promptRef.current = next.text;
      const activePendingQuestion = activePendingProgress?.activeQuestion;
      if (activePendingQuestion && activePendingDraftKey) {
        setPendingUserInputAnswersByKey((existing) => ({
          ...existing,
          [activePendingDraftKey]: {
            ...existing[activePendingDraftKey],
            [activePendingQuestion.id]: setPendingUserInputCustomAnswer(
              existing[activePendingDraftKey]?.[activePendingQuestion.id],
              next.text,
            ),
          },
        }));
      } else {
        setPrompt(next.text);
      }
      setComposerCursor(nextCursor);
      setComposerTrigger(
        detectComposerTrigger(next.text, expandCollapsedComposerCursor(next.text, nextCursor)),
      );
      window.requestAnimationFrame(() => {
        composerEditorRef.current?.focusAt(nextCursor);
      });
      return true;
    },
    [
      activePendingDraftKey,
      activePendingProgress?.activeQuestion,
      setComposerCursor,
      setComposerTrigger,
      setPendingUserInputAnswersByKey,
      setPrompt,
    ],
  );

  const onWindowPasteCapture = useStableCallback((event: globalThis.ClipboardEvent) => {
    const { clipboardData } = event;
    if (!activeThreadId || !clipboardData || event.defaultPrevented) return;
    if (isConnecting || isTerminalFocused() || isExpandedImageOpen()) return;
    if (composerEditorRef.current === null) return;
    const target = keyboardEventTargetElement(event.target);
    if (target?.closest(COMPOSER_EDITOR_SELECTOR)) {
      const handleDroppedItems = composerControlsRef.current?.handleDroppedItems;
      if (!handleDroppedItems) return;
      // Claimed in capture: Lexical's root listener would insert the file name before React's onPaste.
      const claimed = shouldClaimComposerFilePaste({
        ...splitComposerDroppedItems(clipboardData),
        plainText: clipboardData.getData("text/plain"),
      });
      if (!claimed) return;
      event.preventDefault();
      event.stopPropagation();
      handleDroppedItems(clipboardData, { replaceSelection: true });
      return;
    }
    // The draft is a decline-and-redirect message then, as with type-to-focus.
    if (activePendingApproval !== null) return;
    // The composer blurs on a click into the timeline, so this paste would otherwise be dropped.
    const text = pasteTextToFocusComposer({
      event,
      target,
      floatingLayerOpen: document.querySelector(TYPE_TO_FOCUS_FLOATING_LAYER_SELECTOR) !== null,
    });
    if (text === null) return;
    const end = promptRef.current.length;
    if (applyPromptReplacement(end, end, text)) {
      event.preventDefault();
      event.stopPropagation();
    }
  });
  useEffect(() => {
    window.addEventListener("paste", onWindowPasteCapture, true);
    return () => window.removeEventListener("paste", onWindowPasteCapture, true);
  }, [onWindowPasteCapture]);

  useEffect(() => {
    const handler = (event: globalThis.KeyboardEvent) => {
      // An auto-repeated close must not cascade into the next terminal or close the tab,
      // even after the last terminal closed and terminal.close no longer resolves here.
      if (isRepeatedTerminalCloseShortcut(event, keybindings)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      // Focus sits in the confirm dialog, so a second close would otherwise reach the window close.
      if (
        isTerminalCloseConfirmPending() &&
        isTerminalCloseShortcut(event, keybindings, {
          context: { terminalFocus: true, terminalOpen: true },
        })
      ) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (isCommandSurfaceOpen()) return;
      if (!activeThreadId || event.defaultPrevented) return;
      const shortcutContext = {
        terminalFocus: isTerminalFocused(),
        terminalOpen: Boolean(terminalState.terminalOpen),
      };

      const command = resolveShortcutCommand(event, keybindings, {
        context: shortcutContext,
      });
      if (command && isInsideConfirmationDialog(event.target)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      // A plain key with no bound shortcut lands in the composer; pending questions own
      // a-z/1-9 for option picks, so it stays off while one is open.
      if (
        !command &&
        !shortcutContext.terminalFocus &&
        !isConnecting &&
        !isExpandedImageOpen() &&
        pendingUserInputs.length === 0 &&
        activePendingApproval === null &&
        composerEditorRef.current !== null &&
        shouldTypeToFocusComposer({
          event,
          target: keyboardEventTargetElement(event.target),
          floatingLayerOpen: document.querySelector(TYPE_TO_FOCUS_FLOATING_LAYER_SELECTOR) !== null,
        })
      ) {
        const end = promptRef.current.length;
        if (applyPromptReplacement(end, end, event.key)) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
      }

      if (!command) return;

      if (command === "chat.find") {
        // Left unclaimed inside a diff, which runs its own find after this capture listener.
        // The panel only takes the fixed Mod+F, so a rebound chord still opens thread find.
        if (isDiffFindEvent(event) && isDiffFindChord(event, navigator.platform)) return;
        event.preventDefault();
        event.stopPropagation();
        // Still claimed, so browser find stays shut, but the find bar would sit behind the overlay.
        if (isExpandedImageOpen()) return;
        openThreadFind(activeThreadId);
        return;
      }

      if (command === "terminal.toggle") {
        event.preventDefault();
        event.stopPropagation();
        toggleTerminalVisibility();
        return;
      }

      if (command === "terminal.split") {
        event.preventDefault();
        event.stopPropagation();
        if (!terminalState.terminalOpen) {
          setTerminalOpen(true);
        }
        splitTerminal();
        return;
      }

      if (command === "terminal.splitVertical") {
        event.preventDefault();
        event.stopPropagation();
        if (!terminalState.terminalOpen) {
          setTerminalOpen(true);
        }
        splitTerminalVertical();
        return;
      }

      if (command === "terminal.close") {
        event.preventDefault();
        event.stopPropagation();
        if (!terminalState.terminalOpen) return;
        // Captured before awaiting so the dialog closes the terminal it was opened for.
        const terminalId = terminalState.activeTerminalId;
        const closeCapturedTerminal = closeTerminal;
        void confirmTerminalCloseIfRunning({
          threadId: activeThreadId,
          terminalId,
          terminalLabel:
            terminalNumberLabelById(terminalState.terminalIds).get(terminalId) ?? "Terminal",
        }).then((confirmed) => {
          if (!confirmed) return;
          // Skip a terminal that exited and was cleaned up while the dialog was open.
          const latest = selectThreadTerminalState(
            useTerminalStateStore.getState().terminalStateByThreadId,
            activeThreadId,
          );
          if (latest.terminalIds.includes(terminalId)) closeCapturedTerminal(terminalId);
        });
        return;
      }

      if (command === "terminal.new") {
        event.preventDefault();
        event.stopPropagation();
        if (!terminalState.terminalOpen) {
          setTerminalOpen(true);
        }
        createNewTerminal();
        return;
      }

      if (command === "diff.toggle") {
        event.preventDefault();
        event.stopPropagation();
        onToggleDiff();
        return;
      }

      if (command === "diff.close") {
        const outcome = resolveContextualShortcutOutcome(event, diffOpen, {
          swallowInactiveRepeat: true,
        });
        if (outcome === "pass") return;
        event.preventDefault();
        event.stopPropagation();
        if (outcome === "handle") onToggleDiff();
        return;
      }

      if (command === "thread.copyReference") {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat && isServerThread) copyThreadReference();
        return;
      }

      if (command === "thread.stop") {
        const outcome = resolveContextualShortcutOutcome(event, canInterrupt);
        if (outcome === "pass") return;
        event.preventDefault();
        event.stopPropagation();
        if (outcome === "handle") void onInterrupt();
        return;
      }

      if (command === "composer.stash") {
        // User overrides can remove the default condition; still never capture editor/terminal saves.
        if (
          !(event.target instanceof Element) ||
          !event.target.closest('[data-chat-composer-form="true"]')
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) {
          if (composerDraftHasUserContent(threadId) || composerReviewComments.length > 0)
            void onStashPrompt();
          else composerControlsRef.current?.openStash();
        }
        return;
      }
      if (command === "composer.increaseEffort" || command === "composer.decreaseEffort") {
        if (event.repeat) {
          event.preventDefault();
          return;
        }
        if (
          composerControlsRef.current?.stepEffort(command === "composer.increaseEffort" ? 1 : -1)
        ) {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }
      if (isComposerControlCommand(command)) {
        if (command === "modelPicker.toggle" || command === "composer.effort") {
          if (event.repeat) {
            event.preventDefault();
            return;
          }
          const opened = composerControlsRef.current?.openControl(
            command === "modelPicker.toggle" ? "model" : "effort",
          );
          if (!opened) return;
          event.preventDefault();
          event.stopPropagation();
          return;
        }

        if (command === "composer.mode") {
          // Same conditions as ChatComposer's footerControlsShown: no mode change while hidden.
          const footerControlsHidden =
            activePendingApproval !== null ||
            pendingUserInputs.length > 0 ||
            Boolean(missingCwd && activeProject?.id);
          if (footerControlsHidden) return;
          event.preventDefault();
          if (event.repeat) return;
          event.stopPropagation();
          cycleRuntimeMode();
          return;
        }
      }

      const scriptId = projectScriptIdFromCommand(command);
      if (!scriptId || !activeProject) return;
      const script = activeProject.scripts.find((entry) => entry.id === scriptId);
      if (!script) return;
      event.preventDefault();
      event.stopPropagation();
      void runProjectScript(script);
    };
    // Capture phase so focused xterm/diff panes cannot swallow app shortcuts first.
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [
    activePendingApproval,
    activeProject,
    onStashPrompt,
    composerReviewComments.length,
    threadId,
    applyPromptReplacement,
    isConnecting,
    missingCwd,
    pendingUserInputs.length,
    terminalState.terminalOpen,
    terminalState.activeTerminalId,
    activeThreadId,
    closeTerminal,
    createNewTerminal,
    setTerminalOpen,
    runProjectScript,
    splitTerminal,
    splitTerminalVertical,
    keybindings,
    onToggleDiff,
    toggleTerminalVisibility,
    diffOpen,
    canInterrupt,
    onInterrupt,
    cycleRuntimeMode,
    terminalState.terminalIds,
    copyThreadReference,
    isServerThread,
  ]);

  const readComposerSnapshot = useCallback((): {
    value: string;
    cursor: number;
    expandedCursor: number;
    terminalContextIds: string[];
  } => {
    const editorSnapshot = composerEditorRef.current?.readSnapshot();
    if (editorSnapshot) {
      return editorSnapshot;
    }
    return {
      value: promptRef.current,
      cursor: composerCursorRef.current,
      expandedCursor: expandCollapsedComposerCursor(promptRef.current, composerCursorRef.current),
      terminalContextIds: composerTerminalContexts.map((context) => context.id),
    };
  }, [composerTerminalContexts]);

  const resolveActiveComposerTrigger = useCallback((): {
    snapshot: { value: string; cursor: number; expandedCursor: number };
    trigger: ComposerTrigger | null;
  } => {
    const snapshot = readComposerSnapshot();
    return {
      snapshot,
      trigger: resolveComposerTriggerDismissal(
        detectComposerTrigger(snapshot.value, snapshot.expandedCursor),
      ),
    };
  }, [readComposerSnapshot, resolveComposerTriggerDismissal]);

  const onSelectComposerItem = useStableCallback((item: ComposerCommandItem) => {
    if (composerSelectLockRef.current) return;
    composerSelectLockRef.current = true;
    window.requestAnimationFrame(() => {
      composerSelectLockRef.current = false;
    });
    const { snapshot, trigger } = resolveActiveComposerTrigger();
    if (!trigger) return;
    if (item.type === "path") {
      if (!isPathSuggestionCurrent(workspaceEntriesSearchTarget, trigger, gitCwd)) return;
      const replacement = `@${serializeComposerMentionPath(item.path)} `;
      const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
        snapshot.value,
        trigger.rangeEnd,
        replacement,
      );
      const applied = applyPromptReplacement(trigger.rangeStart, replacementRangeEnd, replacement, {
        expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd),
      });
      if (applied) {
        setComposerHighlightedItemId(null);
      }
      return;
    }
    if (item.type === "provider-command") {
      const replacement = providerCommandInsertion(item.command);
      const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
        snapshot.value,
        trigger.rangeEnd,
        replacement,
      );
      const applied = applyPromptReplacement(trigger.rangeStart, replacementRangeEnd, replacement, {
        expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd),
      });
      if (applied) {
        setComposerHighlightedItemId(null);
      }
      return;
    }
    if (item.type === "slash-command") {
      if (item.command === "clear") {
        if (
          applyPromptReplacement(trigger.rangeStart, trigger.rangeEnd, "", {
            expectedText: snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd),
          })
        ) {
          setFreshContext(threadId, true);
          setComposerHighlightedItemId(null);
        }
        return;
      }
      if (item.command === "compact" || item.command === "usage-limits") {
        const applied = applyPromptReplacement(trigger.rangeStart, trigger.rangeEnd, "", {
          expectedText: snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd),
        });
        if (!applied) return;
        setComposerHighlightedItemId(null);
        if (item.command === "compact") {
          onCompactFromSlashMenu();
          return;
        }
        openUsageLimitsPanel();
        return;
      }
      if (item.command === "model") {
        const replacement = "/model ";
        const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
          snapshot.value,
          trigger.rangeEnd,
          replacement,
        );
        const applied = applyPromptReplacement(
          trigger.rangeStart,
          replacementRangeEnd,
          replacement,
          { expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd) },
        );
        if (applied) {
          setComposerHighlightedItemId(null);
        }
        return;
      }
      void handleInteractionModeChange(item.command === "plan" ? "plan" : "default");
      const applied = applyPromptReplacement(trigger.rangeStart, trigger.rangeEnd, "", {
        expectedText: snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd),
      });
      if (applied) {
        setComposerHighlightedItemId(null);
      }
      return;
    }
    // `/model X` replaces a multi-selection, as the picker does.
    setComposerMultiModelSelections(threadId, null);
    onProviderModelSelect(item.provider, item.model);
    const applied = applyPromptReplacement(trigger.rangeStart, trigger.rangeEnd, "", {
      expectedText: snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd),
    });
    if (applied) {
      setComposerHighlightedItemId(null);
    }
  });
  const onComposerMenuItemHighlighted = useCallback((itemId: string | null) => {
    setComposerHighlightedItemId(itemId);
  }, []);
  const nudgeComposerMenuHighlight = useCallback(
    (key: "ArrowDown" | "ArrowUp") => {
      if (composerMenuItems.length === 0) {
        return;
      }
      const highlightedIndex = composerMenuItems.findIndex(
        (item) => item.id === composerHighlightedItemId,
      );
      const normalizedIndex =
        highlightedIndex >= 0 ? highlightedIndex : key === "ArrowDown" ? -1 : 0;
      const offset = key === "ArrowDown" ? 1 : -1;
      const nextIndex =
        (normalizedIndex + offset + composerMenuItems.length) % composerMenuItems.length;
      const nextItem = composerMenuItems[nextIndex];
      setComposerHighlightedItemId(nextItem?.id ?? null);
    },
    [composerHighlightedItemId, composerMenuItems],
  );
  const isComposerMenuLoading =
    composerTriggerKind === "path" &&
    ((pathTriggerQuery.length > 0 && composerPathQueryDebouncer.state.isPending) ||
      workspaceEntriesQuery.isLoading ||
      workspaceEntriesQuery.isFetching);

  const activePendingActiveQuestion = activePendingProgress?.activeQuestion;
  const onPromptChange = useStableCallback(
    (
      nextPrompt: string,
      nextCursor: number,
      expandedCursor: number,
      cursorAdjacentToMention: boolean,
      terminalContextIds: string[],
    ) => {
      if (activePendingActiveQuestion && activePendingUserInput) {
        onChangeActivePendingUserInputCustomAnswer(
          activePendingActiveQuestion.id,
          nextPrompt,
          nextCursor,
          expandedCursor,
          cursorAdjacentToMention,
        );
        return;
      }
      promptRef.current = nextPrompt;
      setPrompt(nextPrompt);
      composerPromptHistory.noteEdit(nextPrompt);
      if (!terminalContextIdListsEqual(composerTerminalContexts, terminalContextIds)) {
        setComposerDraftTerminalContexts(
          threadId,
          syncTerminalContextsByIds(composerTerminalContexts, terminalContextIds),
        );
      }
      // Keystroke path: the editor already owns the caret, so only mirror it.
      composerCursorRef.current = nextCursor;
      const nextTrigger = cursorAdjacentToMention
        ? null
        : detectComposerTrigger(nextPrompt, expandedCursor);
      setDetectedComposerTrigger(nextTrigger);
    },
  );

  const applyComposerListEdit = (
    event: KeyboardEvent,
    listEdit: (value: string, start: number, end: number) => ComposerListEdit | null,
  ): boolean => {
    if (pendingUserInputs.length > 0 || isImeComposingKeyboardEvent(event)) return false;
    if (window.getSelection()?.isCollapsed === false) return false;
    const snapshot = readComposerSnapshot();
    if (snapshot.value !== promptRef.current) return false;
    const edit = listEdit(snapshot.value, snapshot.expandedCursor, snapshot.expandedCursor);
    return (
      edit !== null &&
      applyPromptReplacement(edit.start, edit.end, edit.replacement, {
        expandedCursorAfterReplace: edit.cursorAfter,
      })
    );
  };

  const onComposerCommandKey = useStableCallback(
    (key: ComposerCommandKey, event: KeyboardEvent) => {
      if (key === "Tab" && event.shiftKey) {
        if (applyComposerListEdit(event, listOutdentForTab)) return true;
        toggleInteractionMode();
        return true;
      }

      // Escape follows only the visible menu; re-detecting a trigger here would ignore a
      // suppressed or programmatically cleared one and swallow the window Escape handler.
      if (key === "Escape") {
        if (!composerMenuOpen || isImeComposingKeyboardEvent(event)) return false;
        dismissComposerTrigger(composerTrigger);
        return true;
      }

      const { trigger } = resolveActiveComposerTrigger();
      const menuIsActive =
        composerMenuOpen || isComposerMenuOpen(trigger, composerMenuItems.length);

      if (menuIsActive) {
        const currentItems = composerMenuItems;
        if (key === "ArrowDown" && currentItems.length > 0) {
          nudgeComposerMenuHighlight("ArrowDown");
          return true;
        }
        if (key === "ArrowUp" && currentItems.length > 0) {
          nudgeComposerMenuHighlight("ArrowUp");
          return true;
        }
        if (key === "Tab" || key === "Enter") {
          const selectedItem = activeComposerMenuItem ?? currentItems[0];
          if (selectedItem) {
            onSelectComposerItem(selectedItem);
            return true;
          }
        }
      }

      if (key === "ArrowUp" || key === "ArrowDown") {
        if (
          !canBrowseComposerPromptHistory({
            event,
            hasPendingApproval: isComposerApprovalState,
            hasPendingUserInput: pendingUserInputs.length > 0,
            imageCount: composerImagesRef.current.length,
            terminalContextCount: composerTerminalContexts.length,
          })
        ) {
          return false;
        }
        const recalled = composerPromptHistory.navigate(
          key === "ArrowUp" ? "backward" : "forward",
          promptRef.current,
        );
        if (recalled === null) return false;
        promptRef.current = recalled;
        setPrompt(recalled);
        setComposerCursor(composerStateAtPromptEnd(recalled).cursor);
        setComposerTrigger(null);
        setComposerHighlightedItemId(null);
        return true;
      }

      if (key === "Enter" && !event.shiftKey) {
        const followUp = resolveComposerSendFollowUp({
          command: resolveShortcutCommand(event, keybindings, {
            context: {
              terminalFocus: false,
              terminalOpen: Boolean(terminalState.terminalOpen),
              composerFocus: true,
              draftThreadRoute: isLocalDraftThread,
            },
          }),
          altKey: event.altKey,
          sendRequiresModifier: composerSendFollowUpRequiresModifier(settings.sendShortcut),
          isDraftThread: isLocalDraftThread,
        });
        if (followUp !== null) {
          void onSendLatest(undefined, { followUp });
          return true;
        }
      }
      if (
        key === "Enter" &&
        shouldComposerEnterSend({
          sendShortcut: settings.sendShortcut,
          prompt: promptRef.current,
          shiftKey: event.shiftKey,
          modifierKey: isComposerModifierKeyPressed(event, navigator.platform),
        })
      ) {
        void onSendLatest();
        return true;
      }
      // Reached only by a key that doesn't send; anything else falls through to Lexical's newline.
      if ((key === "Enter" || key === "Tab") && !event.altKey && !event.metaKey && !event.ctrlKey) {
        return applyComposerListEdit(
          event,
          key === "Enter" ? listContinuationForEnter : listIndentForTab,
        );
      }
      return false;
    },
  );
  const onQuoteAssistantSelection = useStableCallback((text: string) => {
    const snapshot = composerEditorRef.current?.readSnapshot();
    const value = snapshot?.value ?? promptRef.current;
    const cursor =
      snapshot?.expandedCursor ??
      expandCollapsedComposerCursor(promptRef.current, composerCursorRef.current);
    applyPromptReplacement(cursor, cursor, buildAssistantQuoteInsertion(value, cursor, text));
  });
  const onToggleWorkGroup = useStableCallback((groupId: string) => {
    const next = { ...expandedWorkGroups, [groupId]: !expandedWorkGroups[groupId] };
    setExpandedWorkGroups(next);
    if (activeThreadId) timelinePositionCache.setExpandedWorkGroups(activeThreadId, next);
  });
  const onExpandTimelineImage = useExpandedImageStore((state) => state.open);
  const onOpenTurnDiff = useStableCallback((turnId: TurnId, filePath?: string) => {
    if (filePath) requestDiffFileReveal(filePath);
    void navigate({
      to: "/$threadId",
      params: { threadId },
      search: (previous) => {
        const rest = stripDiffSearchParams(previous);
        return filePath
          ? { ...rest, diff: "1", diffTurnId: turnId, diffFilePath: filePath }
          : { ...rest, diff: "1", diffTurnId: turnId };
      },
    });
  });
  // Stable identity: its inputs change on every streaming chunk and an unstable identity
  // would re-render every timeline row via the row context.
  const onRevertUserMessage = useStableCallback((messageId: MessageId) => {
    const targetTurnCount = revertTurnCountByUserMessageId.get(messageId);
    if (typeof targetTurnCount !== "number") {
      return;
    }
    onRevertToTurnCount(targetTurnCount, messageId);
  });
  const onMissingCwdResolved = useCallback(() => setMissingCwd(null), []);
  // Dispatched per event: building the handlers during render trips the compiler's ref check.
  const onWorkspaceFileDragEvent = (event: React.DragEvent<HTMLDivElement>) => {
    handleWorkspaceFileDragEvent(
      {
        setDragActive: setIsWorkspaceFileDragActive,
        addFiles: onComposerFileDrop,
        addDroppedItems: (dataTransfer) => {
          const handleDroppedItems = composerControlsRef.current?.handleDroppedItems;
          if (handleDroppedItems) handleDroppedItems(dataTransfer);
          else onComposerFileDrop(Array.from(dataTransfer.files));
        },
      },
      event,
    );
  };

  // Empty state: no active thread
  if (!activeThread) {
    return (
      <div className="flex h-full min-w-0 flex-1 flex-col">
        {isElectron && <div className="drag-region h-[52px] shrink-0" />}
        <div className="flex flex-1 flex-col items-center justify-center gap-2 -mt-[60px]">
          <img
            src="/empty-thread.png"
            alt=""
            className="size-48 object-contain"
            draggable={false}
          />
          <div className="text-center">
            <h2 className="text-2xl font-semibold text-foreground">
              {chatEmptyStateHeading(allProjects)}
            </h2>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div data-chat-column className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden">
      {/* Top bar */}
      <header
        data-chat-header
        className={cn(
          "border-b border-border px-3 sm:px-5",
          isElectron
            ? "drag-region flex h-[52px] items-center wco:pr-[calc(100vw-env(titlebar-area-width)-env(titlebar-area-x)+1em)]"
            : "py-2 sm:py-3",
        )}
      >
        <ChatHeader
          activeThreadId={activeThread.id}
          activeThreadTitle={activeThread.title}
          activeProjectName={activeProject?.name}
          isGitRepo={isGitRepo}
          openInCwd={gitCwd}
          keybindings={keybindings}
          availableEditors={availableEditors}
          terminalAvailable={activeProject !== undefined}
          terminalOpen={terminalState.terminalOpen}
          terminalToggleShortcutLabel={terminalToggleShortcutLabel}
          diffToggleShortcutLabel={diffPanelShortcutLabel}
          gitCwd={gitCwd}
          diffOpen={diffOpen}
          onToggleTerminal={toggleTerminalVisibility}
          onToggleDiff={onToggleDiff}
          canRename={isServerThread}
        />
      </header>

      {/* Main content area with optional plan sidebar */}
      <div className="relative flex min-h-0 min-w-0 flex-1">
        {/* Chat column */}
        <div
          className="relative flex min-h-0 min-w-0 flex-1 flex-col"
          data-chat-workspace-drop-target="true"
          onDragEnter={onWorkspaceFileDragEvent}
          onDragOver={onWorkspaceFileDragEvent}
          onDragLeave={onWorkspaceFileDragEvent}
          onDrop={onWorkspaceFileDragEvent}
        >
          {isWorkspaceFileDragActive ? (
            <div
              className="pointer-events-none absolute inset-2 z-40 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary/60 bg-primary/[0.035]"
              data-chat-workspace-drop-overlay="true"
            >
              <div
                role="status"
                className="flex items-center gap-2 rounded-full border border-primary/25 bg-background/95 px-4 py-2.5 text-sm font-medium text-foreground shadow-lg"
              >
                <PaperclipIcon className="size-4 text-primary" aria-hidden="true" />
                Drop files to attach
              </div>
            </div>
          ) : null}
          {/* Messages Wrapper */}
          <div className="relative flex min-h-0 flex-1 flex-col">
            {/* Messages */}
            <TooltipScrollDismissArea
              {...workspaceAreaProps("conversation", 1, "Conversation")}
              ref={setMessagesScrollContainerRef}
              className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-y-contain px-3 py-3 sm:px-5 sm:py-4"
              onScroll={onMessagesScroll}
              onClickCapture={onMessagesClickCapture}
              onWheel={onMessagesWheel}
              onPointerDown={onMessagesPointerDown}
              onPointerUp={onMessagesPointerUp}
              onPointerCancel={onMessagesPointerCancel}
              onTouchStart={onMessagesTouchStart}
              onTouchMove={onMessagesTouchMove}
              onTouchEnd={onMessagesTouchEnd}
              onTouchCancel={onMessagesTouchEnd}
            >
              {timelineEntries.length === 0 && !isWorking && (
                <NewThreadLanding
                  activeProject={activeProject}
                  allProjects={allProjects}
                  onSwitchProject={handleSwitchProject}
                  onAddProject={() => void handleAddProject()}
                />
              )}
              <MessagesTimeline
                key={activeThread.id}
                threadId={activeThread.id}
                hasMessages={timelineEntries.length > 0}
                isWorking={isWorking}
                activeTurnInProgress={isWorking || !latestTurnSettled}
                activeTurnId={activeThread.session?.activeTurnId ?? null}
                onManualNavigation={onTimelineManualNavigation}
                activeTurnStartedAt={activeWorkStartedAt}
                scrollContainer={messagesScrollElement}
                timelineEntries={timelineEntries}
                completionDividerBeforeEntryId={completionDividerBeforeEntryId}
                completionSummary={completionSummary}
                modelSwitchLabelByMessageId={modelSwitchLabelByMessageId}
                turnDiffSummaryByAssistantMessageId={turnDiffSummaryByAssistantMessageId}
                latestTurnId={activeThread.latestTurn?.turnId ?? null}
                expandedWorkGroups={expandedWorkGroups}
                onToggleWorkGroup={onToggleWorkGroup}
                onOpenTurnDiff={onOpenTurnDiff}
                onOpenToolDiff={onOpenToolDiff}
                revertTurnCountByUserMessageId={revertTurnCountByUserMessageId}
                onRevertUserMessage={onRevertUserMessage}
                isRevertingCheckpoint={isRevertingCheckpoint}
                onImageExpand={onExpandTimelineImage}
                markdownCwd={gitCwd ?? undefined}
                resolvedTheme={resolvedTheme}
                timestampFormat={timestampFormat}
                workspaceRoot={gitCwd ?? undefined}
                assistantLabel={PROVIDER_DISPLAY_NAMES[selectedProvider]}
                {...(activeProject ? { onRunShellCommand: runShellCommand } : {})}
                onThreadFindClose={focusComposer}
                latestTurn={activeLatestTurn}
              />
            </TooltipScrollDismissArea>

            {/* scroll to bottom pill — shown when user has scrolled away from the bottom */}
            {showScrollToBottom && (
              <div className="pointer-events-none absolute bottom-1 left-1/2 z-30 flex -translate-x-1/2 justify-center py-1.5">
                <button
                  type="button"
                  onClick={() => scrollMessagesToBottom(getSmoothScrollBehavior())}
                  className="pointer-events-auto flex items-center gap-1.5 rounded-full border border-border/60 bg-card px-3 py-1 text-muted-foreground text-xs shadow-sm transition-colors hover:border-border hover:text-foreground hover:cursor-pointer"
                >
                  <ChevronDownIcon className="size-3.5" />
                  Scroll to bottom
                </button>
              </div>
            )}
          </div>

          {/* Stays mounted across the banner swap: the terminal drawer reserves this height. */}
          <div data-chat-composer-root className="shrink-0">
            <div className="px-3 sm:px-5">
              <BranchToolbarMismatchNotice
                threadId={activeThread.id}
                onRestored={scheduleComposerFocus}
              />
              <SnoozedThreadBanner threadId={activeThread.id} />
              <UsageLimitResumeBanner threadId={activeThread.id} armed={armedUsageLimitResume} />
              {usageLimitsPanelThreadId === activeThread.id ? (
                <div className="mx-auto w-full max-w-(--chat-composer-max-width) pb-2">
                  <ProviderUsageLimitsPanel
                    providers={providerStatuses}
                    onClose={() => setUsageLimitsPanelThreadId(null)}
                  />
                </div>
              ) : null}
              {threadGoal ? (
                <ThreadGoalRow
                  goal={threadGoal}
                  // Unmet checks loop inside one SDK turn, so a running goal must stay clearable.
                  clearDisabled={compactBlockers.hasPendingRequest || isSendBusy}
                  onClear={onClearThreadGoal}
                />
              ) : null}
            </div>
            {/* Input bar — replaced by missing cwd banner when folder is gone */}
            <ComposerMenuFocusContext value={composerEditorRef}>
              <div {...workspaceAreaProps("composer", 2, "Message input")} className="shrink-0">
                <ChatComposer
                  ref={composerControlsRef}
                  threadId={activeThread.id}
                  projectId={activeProject?.id}
                  missingCwd={missingCwd}
                  onMissingCwdResolved={onMissingCwdResolved}
                  isWorking={isWorking}
                  isSendQueued={
                    queuedSendThreadId !== null && queuedSendThreadId === activeThread?.id
                  }
                  workingLabel={workingLabel}
                  activeWorkStartedAt={activeWorkStartedAt}
                  activeContextWindow={activeContextWindow}
                  phase={phase}
                  isConnecting={isConnecting}
                  // A thread switch resets the local dispatch, but its worktree may still be creating.
                  isSendBusy={
                    isSendBusy || worktreeBase.isResolving || activeWorktreeCreation !== null
                  }
                  isPreparingWorktree={isPreparingWorktree || activeWorktreeCreation !== null}
                  worktreeProgress={activeWorktreeCreation?.progress ?? null}
                  onCancelPreparingWorktree={
                    activeWorktreeCreation ? onCancelPreparingWorktree : undefined
                  }
                  onWorkLocallyInstead={
                    activeWorktreeCreation?.canWorkLocally ? onWorkLocallyInstead : undefined
                  }
                  selectedProvider={selectedProvider}
                  lockedProvider={lockedProvider}
                  selectedModelForPicker={selectedModelForPickerWithCustomFallback}
                  selectedModel={selectedModel}
                  selectedProviderModels={selectedProviderModels}
                  composerModelOptions={composerModelOptions}
                  onTraitsPromptChange={setPromptFromTraits}
                  providerStatuses={providerStatuses}
                  modelOptionsByProvider={modelOptionsByProvider}
                  composerProviderState={composerProviderState}
                  onProviderModelSelect={onProviderModelSelect}
                  multiModelEnabled={isLocalDraftThread && isGitRepo}
                  multiModelBaseBranch={worktreeBaseBranch}
                  onCompact={onCompactThread}
                  compactDisabledReason={compactDisabledReason}
                  composerCursor={composerCursor}
                  composerCursorRequestId={composerCursorRequest.requestId}
                  composerTerminalContexts={composerTerminalContexts}
                  composerEditorRef={composerEditorRef}
                  onPromptChange={onPromptChange}
                  onComposerCommandKey={onComposerCommandKey}
                  onComposerPaste={onComposerPaste}
                  removeComposerTerminalContextFromDraft={removeComposerTerminalContextFromDraft}
                  composerMenuOpen={composerMenuOpen}
                  composerMenuItems={composerMenuItems}
                  activeComposerMenuItem={activeComposerMenuItem}
                  composerTriggerKind={composerTriggerKind}
                  isComposerMenuLoading={isComposerMenuLoading}
                  composerHighlightedItemId={composerHighlightedItemId}
                  onComposerMenuItemHighlighted={onComposerMenuItemHighlighted}
                  onSelectComposerItem={onSelectComposerItem}
                  composerImages={composerImages}
                  nonPersistedComposerImageIdSet={nonPersistedComposerImageIdSet}
                  onRemoveComposerImage={removeComposerImageFromDraft}
                  onExpandImage={onExpandTimelineImage}
                  activePendingApproval={activePendingApproval}
                  pendingApprovals={pendingApprovals}
                  respondingRequestIds={respondingRequestIds}
                  onRespondToApproval={onRespondToApproval}
                  onDismissPendingUserInput={onDismissPendingUserInput}
                  isComposerApprovalState={isComposerApprovalState}
                  activePendingUserInput={activePendingUserInput}
                  pendingUserInputs={pendingUserInputs}
                  activePendingDraftAnswers={activePendingDraftAnswers}
                  activePendingQuestionIndex={activePendingQuestionIndex}
                  activePendingProgress={activePendingProgress}
                  activePendingIsResponding={activePendingIsResponding}
                  activePendingResolvedAnswers={activePendingResolvedAnswers}
                  onSelectActivePendingUserInputOption={onSelectActivePendingUserInputOption}
                  onAdvanceActivePendingUserInput={onAdvanceActivePendingUserInput}
                  onPreviousActivePendingUserInputQuestion={
                    onPreviousActivePendingUserInputQuestion
                  }
                  showPlanFollowUpPrompt={showPlanFollowUpPrompt}
                  activeProposedPlan={activeProposedPlan}
                  runtimeMode={runtimeMode}
                  interactionMode={interactionMode}
                  toggleInteractionMode={toggleInteractionMode}
                  handleRuntimeModeChange={handleRuntimeModeChange}
                  togglePlanSidebar={togglePlanSidebar}
                  planSidebarOpen={planSidebarOpen}
                  activePlan={activePlan}
                  sidebarProposedPlan={sidebarProposedPlan}
                  onStashPrompt={onStashPrompt}
                  onRestorePrompt={onRestorePrompt}
                  onStashError={onStashError}
                  isStashingPrompt={isStashingPrompt}
                  freshContext={freshContext}
                  onCancelFreshContext={() => setFreshContext(threadId, false)}
                  onSend={onSendStable}
                  onInterrupt={onInterrupt}
                  onImplementPlanInNewThread={onImplementPlanInNewThread}
                  resolvedTheme={resolvedTheme}
                  hasComposerHeader={hasComposerHeader}
                  scheduleStickToBottom={scheduleStickToBottom}
                  onFileDrop={onComposerFileDrop}
                  markdownCwd={gitCwd ?? undefined}
                  onComposerPageScroll={onComposerPageScroll}
                  onComposerEditorTyping={composerTypingGuard.onDraftChange}
                  onComposerEditorFocusChange={composerTypingGuard.onFocusChange}
                />
              </div>
            </ComposerMenuFocusContext>
          </div>

          {pullRequestDialogState ? (
            <PullRequestThreadDialog
              key={pullRequestDialogState.key}
              open
              cwd={activeProject?.cwd ?? null}
              initialReference={pullRequestDialogState.initialReference}
              onOpenChange={(open) => {
                if (!open) {
                  closePullRequestDialog();
                }
              }}
              onPrepared={handlePreparedPullRequestThread}
            />
          ) : null}
        </div>
        {/* end chat column */}

        {/* Plan sidebar */}
        <ChatPlanPanel
          ref={planPanelRef}
          threadId={activeThread.id}
          activePlan={activePlan}
          activeProposedPlan={sidebarProposedPlan}
          markdownCwd={gitCwd ?? undefined}
          workspaceRoot={gitCwd ?? undefined}
          timestampFormat={timestampFormat}
          onOpenChange={onPlanSidebarOpenChange}
        />
      </div>
      {/* end horizontal flex container */}

      <ChatTerminalSection
        activeThreadId={activeThreadId}
        terminalFocusRequestId={terminalFocusRequestId}
        keybindings={keybindings}
        onAddTerminalContext={addTerminalContextToDraft}
      />

      <ExpandedImageDialog />
      {activePendingApproval === null && activePendingUserInput === null && (
        <AssistantSelectionToolbar
          key={activeThread.id}
          viewport={messagesScrollElement}
          onQuote={onQuoteAssistantSelection}
        />
      )}
      <RevertCheckpointDialog
        state={revertDialogState}
        onCancel={onCancelRevertDialog}
        onClosed={onRevertDialogClosed}
        onConfirm={(restoreFiles) => void onConfirmRevert(restoreFiles)}
      />
    </div>
  );
}
