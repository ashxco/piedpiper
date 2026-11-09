import {
  type ClaudeCodeEffort,
  type CommandId,
  DEFAULT_MODEL_BY_PROVIDER,
  type KeybindingCommand,
  type MessageId,
  type ModelSelection,
  type OrchestrationThreadActivity,
  PROVIDER_DISPLAY_NAMES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  PROVIDER_SEND_TURN_MAX_TOTAL_IMAGE_BYTES,
  ProjectId,
  type ProviderKind,
  type RuntimeMode,
  type SendShortcut,
  type ServerProvider,
  type ThreadId,
  type TurnId,
} from "@piedpiper/contracts";
import { applyClaudePromptEffortPrefix } from "@piedpiper/shared/model";
import { truncate } from "@piedpiper/shared/String";
import {
  type ChatAttachment,
  type ChatMessage,
  type Project,
  type SessionPhase,
  type Thread,
  type ThreadSession,
} from "../types";
import { selectableProjects } from "~/lib/projectArchive";
import { randomUUID } from "~/lib/utils";
import {
  type ComposerImageAttachment,
  type DraftThreadState,
  type PersistedComposerImageAttachment,
} from "../composerDraftStore";
import { Schema } from "effect";
import { TEMPORARY_WORKTREE_BRANCH_PREFIX } from "@piedpiper/shared/git";
import { useStore } from "../store";
import {
  appendTerminalContextsToPrompt,
  filterTerminalContextsWithText,
  formatTerminalContextLabel,
  stripInlineTerminalContextPlaceholders,
  type TerminalContextDraft,
} from "../lib/terminalContext";
import {
  ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
  IMAGE_ONLY_BOOTSTRAP_PROMPT,
} from "@piedpiper/shared/imageOnlyBootstrapPrompt";
import { isComposerImageFile } from "./ChatView.heicImage";
import { appendReviewCommentsToPrompt, type ReviewCommentContext } from "~/reviewCommentContext";
import { getProviderModelCapabilities, resolveSelectableProvider } from "../providerModels";
import { collapseExpandedComposerCursor, type ComposerTrigger } from "../composer-logic";
import type { DraftThreadEnvMode } from "../composerDraftStore";

export const LAST_INVOKED_SCRIPT_BY_PROJECT_KEY = "piedpiper:last-invoked-script-by-project";
export const MAX_HIDDEN_MOUNTED_TERMINAL_THREADS = 10;

export const LastInvokedScriptByProjectSchema = Schema.Record(ProjectId, Schema.String);

export function buildLocalDraftThread(
  threadId: ThreadId,
  draftThread: DraftThreadState,
  fallbackModelSelection: ModelSelection,
  error: string | null,
): Thread {
  return {
    id: threadId,
    codexThreadId: null,
    projectId: draftThread.projectId,
    title: "New thread",
    modelSelection: fallbackModelSelection,
    runtimeMode: draftThread.runtimeMode,
    interactionMode: draftThread.interactionMode,
    session: null,
    messages: [],
    error,
    createdAt: draftThread.createdAt,
    archivedAt: null,
    latestTurn: null,
    branch: draftThread.branch,
    worktreePath: draftThread.worktreePath,
    turnDiffSummaries: [],
    activities: [],
    proposedPlans: [],
  };
}

export function reconcileMountedTerminalThreadIds(input: {
  currentThreadIds: ReadonlyArray<ThreadId>;
  openThreadIds: ReadonlyArray<ThreadId>;
  activeThreadId: ThreadId | null;
  activeThreadTerminalOpen: boolean;
  maxHiddenThreadCount?: number;
}): ThreadId[] {
  const openThreadIdSet = new Set(input.openThreadIds);
  const hiddenThreadIds = input.currentThreadIds.filter(
    (threadId) => threadId !== input.activeThreadId && openThreadIdSet.has(threadId),
  );
  const maxHiddenThreadCount = Math.max(
    0,
    input.maxHiddenThreadCount ?? MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
  );
  const nextThreadIds =
    hiddenThreadIds.length > maxHiddenThreadCount
      ? hiddenThreadIds.slice(-maxHiddenThreadCount)
      : hiddenThreadIds;

  if (
    input.activeThreadId &&
    input.activeThreadTerminalOpen &&
    !nextThreadIds.includes(input.activeThreadId)
  ) {
    nextThreadIds.push(input.activeThreadId);
  }

  return nextThreadIds;
}

export function revokeBlobPreviewUrl(previewUrl: string | undefined): void {
  if (!previewUrl || typeof URL === "undefined" || !previewUrl.startsWith("blob:")) {
    return;
  }
  URL.revokeObjectURL(previewUrl);
}

export function revokeUserMessagePreviewUrls(message: ChatMessage): void {
  if (message.role !== "user" || !message.attachments) {
    return;
  }
  for (const attachment of message.attachments) {
    if (attachment.type !== "image") {
      continue;
    }
    revokeBlobPreviewUrl(attachment.previewUrl);
  }
}

export function collectUserMessageBlobPreviewUrls(message: ChatMessage): string[] {
  if (message.role !== "user" || !message.attachments) {
    return [];
  }
  const previewUrls: string[] = [];
  for (const attachment of message.attachments) {
    if (attachment.type !== "image") continue;
    if (!attachment.previewUrl || !attachment.previewUrl.startsWith("blob:")) continue;
    previewUrls.push(attachment.previewUrl);
  }
  return previewUrls;
}

export interface PullRequestDialogState {
  initialReference: string | null;
  key: number;
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("Could not read image data."));
    });
    reader.addEventListener("error", () => {
      reject(reader.error ?? new Error("Failed to read image."));
    });
    reader.readAsDataURL(file);
  });
}

/** Serializes composer images for draft persistence, reusing bytes already persisted by id. */
export async function serializeComposerImages(
  images: ReadonlyArray<ComposerImageAttachment>,
  persistedAttachments: ReadonlyArray<PersistedComposerImageAttachment>,
  readDataUrl: (file: File) => Promise<string> = readFileAsDataUrl,
): Promise<PersistedComposerImageAttachment[]> {
  const existingPersistedById = new Map(
    persistedAttachments.map((attachment) => [attachment.id, attachment]),
  );
  const staged = await Promise.all(
    images.map(async (image): Promise<PersistedComposerImageAttachment | null> => {
      // A PDF of up to 20 MB would overrun draft storage, so it lasts until a reload.
      if (isComposerPdfAttachment(image)) return null;
      const existingPersisted = existingPersistedById.get(image.id);
      try {
        const dataUrl = existingPersisted?.dataUrl ?? (await readDataUrl(image.file));
        return {
          id: image.id,
          name: image.name,
          mimeType: image.mimeType,
          sizeBytes: image.sizeBytes,
          dataUrl,
        };
      } catch {
        return existingPersisted ?? null;
      }
    }),
  );
  return staged.filter((attachment) => attachment !== null);
}

export function buildTemporaryWorktreeBranchName(): string {
  // Keep the 8-hex suffix shape for backend temporary-branch detection.
  const token = randomUUID().slice(0, 8).toLowerCase();
  return `${TEMPORARY_WORKTREE_BRANCH_PREFIX}/${token}`;
}

export function cloneComposerImageForRetry(
  image: ComposerImageAttachment,
): ComposerImageAttachment {
  if (typeof URL === "undefined" || !image.previewUrl.startsWith("blob:")) {
    return image;
  }
  try {
    return {
      ...image,
      previewUrl: URL.createObjectURL(image.file),
    };
  } catch {
    return image;
  }
}

export function deriveComposerSendState(options: {
  prompt: string;
  imageCount: number;
  terminalContexts: ReadonlyArray<TerminalContextDraft>;
  reviewCommentCount?: number;
}): {
  trimmedPrompt: string;
  sendableTerminalContexts: TerminalContextDraft[];
  expiredTerminalContextCount: number;
  hasSendableContent: boolean;
} {
  const trimmedPrompt = stripInlineTerminalContextPlaceholders(options.prompt).trim();
  const sendableTerminalContexts = filterTerminalContextsWithText(options.terminalContexts);
  const expiredTerminalContextCount =
    options.terminalContexts.length - sendableTerminalContexts.length;
  return {
    trimmedPrompt,
    sendableTerminalContexts,
    expiredTerminalContextCount,
    hasSendableContent:
      trimmedPrompt.length > 0 ||
      options.imageCount > 0 ||
      sendableTerminalContexts.length > 0 ||
      (options.reviewCommentCount ?? 0) > 0,
  };
}

export function buildExpiredTerminalContextToastCopy(
  expiredTerminalContextCount: number,
  variant: "omitted" | "empty",
): { title: string; description: string } {
  const count = Math.max(1, Math.floor(expiredTerminalContextCount));
  const noun = count === 1 ? "Expired terminal context" : "Expired terminal contexts";
  const pronoun = count === 1 ? "it" : "them";
  if (variant === "empty") {
    return {
      title: `${noun} won't be sent`,
      description: `Remove ${pronoun} or re-add ${pronoun} to include terminal output.`,
    };
  }
  return {
    title: `${noun} omitted from message`,
    description: `Re-add ${pronoun} if you want that terminal output included.`,
  };
}

export function threadHasStarted(thread: Thread | null | undefined): boolean {
  return Boolean(
    thread && (thread.latestTurn !== null || thread.messages.length > 0 || thread.session !== null),
  );
}

export async function waitForStartedServerThread(
  threadId: ThreadId,
  timeoutMs = 1_000,
): Promise<boolean> {
  const getThread = () => useStore.getState().threads.find((thread) => thread.id === threadId);
  const thread = getThread();

  if (threadHasStarted(thread)) {
    return true;
  }

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    let timeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;
    const finish = (result: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutId !== null) {
        globalThis.clearTimeout(timeoutId);
      }
      unsubscribe();
      resolve(result);
    };

    const unsubscribe = useStore.subscribe((state) => {
      if (!threadHasStarted(state.threads.find((thread) => thread.id === threadId))) {
        return;
      }
      finish(true);
    });

    if (threadHasStarted(getThread())) {
      finish(true);
      return;
    }

    timeoutId = globalThis.setTimeout(() => {
      finish(false);
    }, timeoutMs);
  });
}

export interface LocalDispatchSnapshot {
  startedAt: string;
  preparingWorktree: boolean;
  latestTurnTurnId: TurnId | null;
  latestTurnRequestedAt: string | null;
  latestTurnStartedAt: string | null;
  latestTurnCompletedAt: string | null;
  sessionOrchestrationStatus: ThreadSession["orchestrationStatus"] | null;
  sessionUpdatedAt: string | null;
}

export function createLocalDispatchSnapshot(
  activeThread: Thread | undefined,
  options?: { preparingWorktree?: boolean },
): LocalDispatchSnapshot {
  const latestTurn = activeThread?.latestTurn ?? null;
  const session = activeThread?.session ?? null;
  return {
    startedAt: new Date().toISOString(),
    preparingWorktree: Boolean(options?.preparingWorktree),
    latestTurnTurnId: latestTurn?.turnId ?? null,
    latestTurnRequestedAt: latestTurn?.requestedAt ?? null,
    latestTurnStartedAt: latestTurn?.startedAt ?? null,
    latestTurnCompletedAt: latestTurn?.completedAt ?? null,
    sessionOrchestrationStatus: session?.orchestrationStatus ?? null,
    sessionUpdatedAt: session?.updatedAt ?? null,
  };
}

export function hasServerAcknowledgedLocalDispatch(input: {
  localDispatch: LocalDispatchSnapshot | null;
  phase: SessionPhase;
  latestTurn: Thread["latestTurn"] | null;
  session: Thread["session"] | null;
  hasPendingApproval: boolean;
  hasPendingUserInput: boolean;
  threadError: string | null | undefined;
}): boolean {
  if (!input.localDispatch) {
    return false;
  }
  if (
    input.phase === "running" ||
    input.hasPendingApproval ||
    input.hasPendingUserInput ||
    Boolean(input.threadError)
  ) {
    return true;
  }

  const latestTurn = input.latestTurn ?? null;
  const session = input.session ?? null;

  return (
    input.localDispatch.latestTurnTurnId !== (latestTurn?.turnId ?? null) ||
    input.localDispatch.latestTurnRequestedAt !== (latestTurn?.requestedAt ?? null) ||
    input.localDispatch.latestTurnStartedAt !== (latestTurn?.startedAt ?? null) ||
    input.localDispatch.latestTurnCompletedAt !== (latestTurn?.completedAt ?? null) ||
    input.localDispatch.sessionOrchestrationStatus !== (session?.orchestrationStatus ?? null) ||
    input.localDispatch.sessionUpdatedAt !== (session?.updatedAt ?? null)
  );
}

/**
 * Derive persistent Q&A cards from thread activities so they survive refresh.
 * A resolution with no answers (for example a request the provider settled itself on interrupt)
 * produces no card, since the user never submitted anything.
 */
// Matches asyncAnswerMessageId in apps/server/src/orchestration/userInputRequests.ts.
const ASYNC_ANSWER_MESSAGE_ID_PREFIX = "async-answer:";

/** An answered async question's message, once its card stands in for it. */
export function dropAsyncAnswerMessagesWithQaCards(
  messages: ReadonlyArray<ChatMessage>,
  qaCards: ReadonlyArray<ChatMessage>,
): ReadonlyArray<ChatMessage> {
  if (qaCards.length === 0) return messages;
  const cardIds = new Set<string>(qaCards.map((card) => card.id));
  const kept = messages.filter(
    (message) =>
      !(
        message.id.startsWith(ASYNC_ANSWER_MESSAGE_ID_PREFIX) &&
        cardIds.has(`qa-${message.id.slice(ASYNC_ANSWER_MESSAGE_ID_PREFIX.length)}`)
      ),
  );
  return kept.length === messages.length ? messages : kept;
}

export function deriveQaCardMessages(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ChatMessage[] {
  const cards: ChatMessage[] = [];
  const requestedById = new Map<
    string,
    { questions: Array<{ id: string; question: string }>; createdAt: string }
  >();
  for (const a of activities) {
    const p = a.payload as Record<string, unknown> | undefined;
    const reqId = typeof p?.requestId === "string" ? p.requestId : null;
    if (a.kind === "user-input.requested" && reqId) {
      const qs = p?.questions;
      if (Array.isArray(qs)) {
        requestedById.set(reqId, {
          questions: qs.map((q: Record<string, unknown>) => ({
            id: String(q.id ?? ""),
            question: String(q.question ?? ""),
          })),
          createdAt: a.createdAt,
        });
      }
    }
    if (a.kind === "user-input.resolved" && reqId) {
      const req = requestedById.get(reqId);
      const answers = p?.answers as Record<string, unknown> | undefined;
      if (req && answers && Object.keys(answers).length > 0) {
        const lines = req.questions.map((q) => {
          const answer = answers[q.id];
          const text = Array.isArray(answer) ? answer.join(", ") : String(answer ?? "");
          return `${q.question}\t${text}`;
        });
        cards.push({
          id: `qa-${reqId}` as MessageId,
          role: "user",
          text: `[qa-card]\n${lines.join("\n")}`,
          createdAt: req.createdAt,
          streaming: false,
        });
      }
      requestedById.delete(reqId);
    }
  }
  return cards;
}

// Returning to the window should land the caret in the composer unless focus is deliberate:
// another text field, an editable region, or an open dialog or popup.
export function shouldRefocusComposerOnWindowFocus(
  activeElement:
    | (Pick<Element, "tagName" | "closest" | "getAttribute"> & { isContentEditable?: boolean })
    | null,
): boolean {
  if (activeElement === null || activeElement.tagName === "BODY") return true;
  if (
    activeElement.tagName === "INPUT" ||
    activeElement.tagName === "TEXTAREA" ||
    activeElement.tagName === "SELECT" ||
    activeElement.isContentEditable === true ||
    activeElement.getAttribute("role") === "textbox"
  ) {
    return false;
  }
  // Only keyboard focus counts: a row or area reached with F6 or arrows keeps it.
  return (
    activeElement.closest(
      '[data-workspace-area]:focus-visible, [data-sidebar-row]:focus-visible, [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-slot$="-popup"]',
    ) === null
  );
}

export interface PlanFollowUpComposerSnapshot {
  readonly prompt: string;
  readonly terminalContexts: ReadonlyArray<TerminalContextDraft>;
  readonly images?: ReadonlyArray<ComposerImageAttachment>;
}

/**
 * Puts back what a failed plan follow-up send cleared. A draft typed while the send was in
 * flight is newer and stays; the cursor and composer refs follow only while the thread is on screen.
 */
export function restorePlanFollowUpComposer(input: {
  readonly snapshot: PlanFollowUpComposerSnapshot;
  readonly draftHasUserContent: boolean;
  readonly threadIsCurrent: boolean;
  readonly writeComposerRefs: (snapshot: PlanFollowUpComposerSnapshot) => void;
  readonly writePrompt: (prompt: string) => void;
  readonly writeTerminalContexts: (contexts: ReadonlyArray<TerminalContextDraft>) => void;
  readonly writeImages?: (images: ReadonlyArray<ComposerImageAttachment>) => void;
  readonly resetCursor: (options: { cursor: number; prompt: string }) => void;
}): boolean {
  if (input.draftHasUserContent) return false;
  if (input.threadIsCurrent) input.writeComposerRefs(input.snapshot);
  input.writePrompt(input.snapshot.prompt);
  if (input.snapshot.terminalContexts.length > 0) {
    input.writeTerminalContexts(input.snapshot.terminalContexts);
  }
  if (input.snapshot.images && input.snapshot.images.length > 0) {
    input.writeImages?.(input.snapshot.images);
  }
  if (input.threadIsCurrent) {
    input.resetCursor({
      cursor: collapseExpandedComposerCursor(input.snapshot.prompt, input.snapshot.prompt.length),
      prompt: input.snapshot.prompt,
    });
  }
  return true;
}

const TYPE_TO_FOCUS_EXCLUDED_TARGET_SELECTOR = [
  "input",
  "textarea",
  "select",
  "[contenteditable]:not([contenteditable='false'])",
  '[role="textbox"]',
  "button",
  "a[href]",
  "summary",
  '[role="button"]',
  '[role="checkbox"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="tab"]',
  ".xterm",
].join(",");

export const TYPE_TO_FOCUS_FLOATING_LAYER_SELECTOR = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="menu"]',
  '[data-slot="dialog-popup"]',
  '[data-slot="alert-dialog-popup"]',
  '[data-slot="command-dialog-popup"]',
  '[data-slot="sheet-popup"]',
  '[data-slot="menu-popup"]',
  '[data-slot="select-popup"]',
  '[data-slot="popover-popup"]',
  '[data-slot="combobox-popup"]',
  '[data-slot="autocomplete-popup"]',
]
  // Base UI can keep a closed popup mounted but hidden; only open layers count.
  .map((selector) => `${selector}:not([hidden]):not([data-closed])`)
  .join(",");

/**
 * True when input that landed outside any editable or interactive element should go to the
 * composer. Shared by type-to-focus and paste-to-focus so both honour the same surfaces.
 */
export function shouldRedirectInputToComposer(input: {
  readonly event: Pick<Event, "defaultPrevented">;
  readonly target: Pick<Element, "closest"> | null;
  readonly floatingLayerOpen: boolean;
}): boolean {
  if (input.event.defaultPrevented || input.floatingLayerOpen) return false;
  return input.target?.closest(TYPE_TO_FOCUS_EXCLUDED_TARGET_SELECTOR) == null;
}

/**
 * True when a keydown typed outside any input should be redirected into the composer:
 * one printable non-space character, no command modifier, not mid-IME, and no
 * interactive target or open dialog/menu that the key belongs to.
 */
export function shouldTypeToFocusComposer(input: {
  readonly event: Pick<
    globalThis.KeyboardEvent,
    "key" | "metaKey" | "ctrlKey" | "altKey" | "isComposing" | "defaultPrevented"
  >;
  readonly target: Pick<Element, "closest"> | null;
  readonly floatingLayerOpen: boolean;
}): boolean {
  const { event } = input;
  if (event.isComposing) return false;
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  // Space keeps scrolling the timeline; the first real character moves focus.
  if (Array.from(event.key).length !== 1 || event.key === " ") return false;
  return shouldRedirectInputToComposer(input);
}

/** Plain text pasted with nothing editable focused. Files stay with the composer's own paste paths. */
export function pasteTextToFocusComposer(input: {
  readonly event: Pick<globalThis.ClipboardEvent, "defaultPrevented"> & {
    readonly clipboardData: {
      readonly files: ArrayLike<unknown>;
      getData(format: string): string;
    } | null;
  };
  readonly target: Pick<Element, "closest"> | null;
  readonly floatingLayerOpen: boolean;
}): string | null {
  const { clipboardData } = input.event;
  if (!clipboardData || clipboardData.files.length > 0) return null;
  if (!shouldRedirectInputToComposer(input)) return null;
  // The prompt editor splits on \n alone, and a Windows clipboard holds \r\n.
  const text = clipboardData.getData("text/plain").replace(/\r\n?/g, "\n");
  return text.length > 0 ? text : null;
}

/**
 * True when a paste into the composer holds files or folders the normal text paste would reduce to a
 * name. Folders always qualify; files only when any text is just their names, as Finder copies them.
 * A lone image with no text already works, and a file paired with real text stays a normal paste.
 */
export function shouldClaimComposerFilePaste(input: {
  readonly files: ReadonlyArray<Pick<File, "name" | "type">>;
  readonly folders: ReadonlyArray<Pick<File, "name">>;
  readonly plainText: string;
}): boolean {
  if (input.folders.length > 0) return true;
  if (input.files.length === 0) return false;
  const lines = input.plainText
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return !input.files.every(isComposerImageFile);
  // macOS file names can arrive decomposed while the clipboard text is composed.
  const names = new Set(input.files.map((file) => file.name.normalize("NFC")));
  return lines.every((line) => names.has(pathBasename(line).normalize("NFC")));
}

function pathBasename(path: string): string {
  return (
    path
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() ?? path
  );
}

/** Takes the unfiltered project list; an archived project is never named on a landing surface. */
export function chatEmptyStateHeading(
  projects: ReadonlyArray<Pick<Project, "id" | "name" | "archivedAt">>,
): string {
  const firstProject = selectableProjects(projects)[0];
  return firstProject ? `Let's pipe some code in ${firstProject.name}` : "Let's pipe some code in";
}

export function keyboardEventTargetElement(target: EventTarget | null): Element | null {
  if (target instanceof Element) return target;
  if (target instanceof Node) return target.parentElement;
  return null;
}

/** What happens after a send: stay on the thread, or open a fresh draft for the project. */
export type ComposerSendFollowUp = "background" | "new-thread";

/**
 * Maps a composer Enter keybinding to a send follow-up. Background send only applies to a
 * draft and new-thread send only to an existing thread; when the send shortcut already needs
 * the modifier, plain mod+Enter stays an ordinary send and only mod+Alt+Enter goes background.
 */
export function resolveComposerSendFollowUp(input: {
  readonly command: KeybindingCommand | null;
  readonly altKey: boolean;
  readonly sendRequiresModifier: boolean;
  readonly isDraftThread: boolean;
}): ComposerSendFollowUp | null {
  if (input.command === "composer.sendBackground") {
    if (!input.isDraftThread) return null;
    if (input.sendRequiresModifier && !input.altKey) return null;
    return "background";
  }
  if (input.command === "composer.sendAndNewThread") {
    return input.isDraftThread ? null : "new-thread";
  }
  return null;
}

/**
 * Whether the send setting can ever require a modifier. The follow-up decision uses this rather
 * than the prompt-dependent rule, so mod+Enter is always a normal send in both modifier modes.
 */
export function composerSendFollowUpRequiresModifier(sendShortcut: SendShortcut): boolean {
  return sendShortcut !== "enter";
}

/** Over-limit message for a plan implementation prompt, which the user cannot shorten themselves. */
export function getPlanImplementationLengthValidationMessage(providerInput: string): string | null {
  const excessCharacters = providerInput.trim().length - PROVIDER_SEND_TURN_MAX_INPUT_CHARS;
  if (excessCharacters <= 0) return null;
  const characterLabel = excessCharacters === 1 ? "character" : "characters";
  return `The proposed plan is ${excessCharacters.toLocaleString("en-US")} ${characterLabel} over the ${PROVIDER_SEND_TURN_MAX_INPUT_CHARS.toLocaleString("en-US")}-character limit. Ask the agent to shorten it.`;
}

/** The next draft after a background send keeps the sent draft's env mode and base branch. */
export function buildDraftOptionsAfterBackgroundSend(input: {
  readonly envMode: DraftThreadEnvMode;
  readonly branch: string | null;
  readonly worktreePath: string | null;
}): { envMode: DraftThreadEnvMode; branch: string | null; worktreePath: string | null } {
  return input.envMode === "worktree"
    ? { envMode: "worktree", branch: input.branch, worktreePath: null }
    : { envMode: "local", branch: input.branch, worktreePath: input.worktreePath };
}

export interface ComposerPathSearchTarget {
  cwd: string | null;
  query: string;
}

/** True when the visible @-file suggestions were fetched for the live trigger and directory. */
export function isPathSuggestionCurrent(
  searchTarget: ComposerPathSearchTarget | null,
  trigger: ComposerTrigger | null,
  cwd: string | null,
): boolean {
  return (
    searchTarget !== null &&
    trigger?.kind === "path" &&
    searchTarget.cwd === cwd &&
    searchTarget.query === trigger.query
  );
}

/**
 * Placeholder results that no fetch will replace (bare "@", or no cwd) are hidden, so the menu
 * never shows rows that selection would refuse to insert.
 */
export function visiblePathSearchEntries<T>(
  query: {
    data: { entries: ReadonlyArray<T> } | undefined;
    isPlaceholderData: boolean;
    isFetching: boolean;
  },
  empty: ReadonlyArray<T>,
): ReadonlyArray<T> {
  if (query.isPlaceholderData && !query.isFetching) return empty;
  return query.data?.entries ?? empty;
}

/**
 * Whether a failed send puts its text back into the composer. Once the turn started, or when the
 * user already typed something new, the composer is left alone. The live composer only describes
 * the failed thread while it is still visible and not moving to a retry draft.
 */
export function shouldRestoreComposerAfterFailedSend(input: {
  turnStartSucceeded: boolean;
  movesToRetryDraft: boolean;
  threadIsCurrent: boolean;
  draftHasUserContent: boolean;
  liveComposerEmpty: boolean;
}): boolean {
  if (input.turnStartSucceeded) return false;
  return input.movesToRetryDraft || !input.threadIsCurrent
    ? !input.draftHasUserContent
    : input.liveComposerEmpty;
}

/** Thrown out of a send the user cancelled while its worktree was being created. */
export class ComposerSendCancelledError extends Error {
  constructor() {
    super("Send cancelled.");
    this.name = "ComposerSendCancelledError";
  }
}

/** What a failed send reports; null for a cancel, which was the user's own choice. */
export function resolveFailedSendErrorMessage(error: unknown): string | null {
  if (error instanceof ComposerSendCancelledError) return null;
  return error instanceof Error ? error.message : "Failed to send message.";
}

export type WorktreeCreationAbortIntent = "cancel" | "work-locally";

export type WorktreeCreationOutcome<TResult> =
  | { readonly status: "created"; readonly result: TResult }
  | { readonly status: "work-locally" };

/**
 * Settles a send's worktree step. A rejection only counts as the user's abort when they asked for
 * one, so a real failure still surfaces; a cancel throws so the send takes its failure path.
 */
export async function settleWorktreeCreation<TResult>(
  creation: Promise<TResult>,
  readAbortIntent: () => WorktreeCreationAbortIntent | null,
): Promise<WorktreeCreationOutcome<TResult>> {
  try {
    return { status: "created", result: await creation };
  } catch (error) {
    const intent = readAbortIntent();
    if (intent === null) throw error;
    if (intent === "cancel") throw new ComposerSendCancelledError();
    return { status: "work-locally" };
  }
}

/** Prefixes the prompt with the effort keyword when the model takes effort in the prompt text. */
// Matches isClaudeSlashCommandPrompt on the server; `/usr/bin` is a path, not a command.
const COMPOSER_SLASH_COMMAND_TEXT = /^\s*\/[^\s/]+(\s|$)/;

export function formatOutgoingPrompt(params: {
  provider: ProviderKind;
  model: string | null;
  models: ReadonlyArray<ServerProvider["models"][number]>;
  effort: string | null;
  text: string;
}): string {
  // A slash command must stay first to expand, so its effort prefix would run it as a normal turn.
  if (COMPOSER_SLASH_COMMAND_TEXT.test(params.text)) return params.text;
  const caps = getProviderModelCapabilities(params.models, params.model, params.provider);
  if (params.effort && caps.promptInjectedEffortLevels.includes(params.effort)) {
    return applyClaudePromptEffortPrefix(params.text, params.effort as ClaudeCodeEffort | null);
  }
  return params.text;
}

/** Text sent for a composer message: prompt, review comments and terminal contexts, or the image-only bootstrap. */
export function buildComposerOutgoingMessageText(input: {
  prompt: string;
  terminalContexts: ReadonlyArray<TerminalContextDraft>;
  reviewComments?: ReadonlyArray<ReviewCommentContext>;
  /** So a PDF-only send does not tell the model the user attached images. */
  hasNonImageAttachment?: boolean;
  provider: ProviderKind;
  model: string | null;
  models: ReadonlyArray<ServerProvider["models"][number]>;
  effort: string | null;
}): string {
  const messageText = appendReviewCommentsToPrompt(
    appendTerminalContextsToPrompt(input.prompt, input.terminalContexts),
    input.reviewComments ?? [],
  );
  return formatOutgoingPrompt({
    provider: input.provider,
    model: input.model,
    models: input.models,
    effort: input.effort,
    text:
      messageText ||
      (input.hasNonImageAttachment
        ? ATTACHMENT_ONLY_BOOTSTRAP_PROMPT
        : IMAGE_ONLY_BOOTSTRAP_PROMPT),
  });
}

/**
 * The terminal a project script can run in, or null when it needs a new one: the base terminal
 * while idle, otherwise any idle terminal if the caller allows leaving the base one.
 */
export function findReusableProjectScriptTerminal(input: {
  readonly baseTerminalId: string;
  readonly terminalIds: ReadonlyArray<string>;
  readonly runningTerminalIds: ReadonlyArray<string>;
  readonly allowOtherTerminals: boolean;
}): string | null {
  const isIdle = (terminalId: string) => !input.runningTerminalIds.includes(terminalId);
  if (isIdle(input.baseTerminalId)) return input.baseTerminalId;
  if (!input.allowOtherTerminals) return null;
  return input.terminalIds.find(isIdle) ?? null;
}

export interface PullRequestSetupRequest {
  threadId: ThreadId;
  worktreePath: string;
  scriptId: string;
}

/** Null for a reused worktree that did not move, because another thread may be running in it. */
export function resolvePullRequestSetupRequest(input: {
  readonly targetThreadId: ThreadId | null;
  readonly worktreePath: string | null;
  readonly scriptId: string | null;
  readonly checkoutChanged: boolean | undefined;
}): PullRequestSetupRequest | null {
  if (!input.targetThreadId || !input.worktreePath || !input.scriptId) return null;
  if (input.checkoutChanged === false) return null;
  return {
    threadId: input.targetThreadId,
    worktreePath: input.worktreePath,
    scriptId: input.scriptId,
  };
}

/** Whether the first send has to create a worktree, and from which base branch. */
export function resolveWorktreeSendPlan(input: {
  isFirstMessage: boolean;
  envMode: DraftThreadEnvMode;
  branch: string | null;
  worktreePath: string | null;
}): { shouldCreateWorktree: boolean; baseBranchForWorktree: string | null } {
  const shouldCreateWorktree =
    input.isFirstMessage && input.envMode === "worktree" && !input.worktreePath;
  return {
    shouldCreateWorktree,
    baseBranchForWorktree: shouldCreateWorktree ? input.branch : null,
  };
}

export type TurnStartImageAttachment =
  | {
      type: "image";
      name: string;
      mimeType: string;
      sizeBytes: number;
      dataUrl: string;
    }
  | {
      type: "file";
      name: string;
      mimeType: "application/pdf";
      sizeBytes: number;
      dataUrl: string;
    };

const COMPOSER_PDF_MIME_TYPE = "application/pdf";

/** Some systems report no useful MIME type for a PDF, so the name counts too. */
export function isComposerPdfFile(file: Pick<File, "name" | "type">): boolean {
  return file.type.toLowerCase() === COMPOSER_PDF_MIME_TYPE || /\.pdf$/i.test(file.name);
}

/** Drafts are image-shaped: a PDF is told apart by its MIME type and has no preview. */
export function isComposerPdfAttachment(image: Pick<ComposerImageAttachment, "mimeType">): boolean {
  return image.mimeType === COMPOSER_PDF_MIME_TYPE;
}

export function buildComposerPdfAttachment(id: string, file: File): ComposerImageAttachment {
  return {
    type: "image",
    id,
    name: file.name || "document.pdf",
    mimeType: COMPOSER_PDF_MIME_TYPE,
    sizeBytes: file.size,
    previewUrl: "",
    // The data URL's type comes from the file, and the server rejects anything but a PDF.
    file:
      file.type === COMPOSER_PDF_MIME_TYPE
        ? file
        : new File([file], file.name, { type: COMPOSER_PDF_MIME_TYPE }),
  };
}

export function buildTurnStartImageAttachments(
  images: ReadonlyArray<ComposerImageAttachment>,
  readDataUrl: (file: File) => Promise<string> = readFileAsDataUrl,
): Promise<TurnStartImageAttachment[]> {
  return Promise.all(
    images.map(async (image): Promise<TurnStartImageAttachment> => {
      const fields = {
        name: image.name,
        sizeBytes: image.sizeBytes,
        dataUrl: await readDataUrl(image.file),
      };
      return isComposerPdfAttachment(image)
        ? { ...fields, type: "file", mimeType: COMPOSER_PDF_MIME_TYPE }
        : { ...fields, type: "image", mimeType: image.mimeType };
    }),
  );
}

/** The user message shown in the timeline until the server echoes the real one. */
export function buildOptimisticUserMessage(input: {
  id: MessageId;
  text: string;
  images: ReadonlyArray<ComposerImageAttachment>;
  createdAt: string;
}): ChatMessage {
  const attachments = input.images.map((image): ChatAttachment => {
    const fields = {
      id: image.id,
      name: image.name,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
    };
    return isComposerPdfAttachment(image)
      ? { ...fields, type: "file" }
      : { ...fields, type: "image", previewUrl: image.previewUrl };
  });
  return {
    id: input.id,
    role: "user",
    text: input.text,
    ...(attachments.length > 0 ? { attachments } : {}),
    createdAt: input.createdAt,
    streaming: false,
  };
}

/** Thread title for a send: the prompt, else the first image, terminal context or review comment. */
export function deriveSendThreadTitle(input: {
  trimmedPrompt: string;
  images: ReadonlyArray<Pick<ComposerImageAttachment, "name">>;
  terminalContexts: ReadonlyArray<TerminalContextDraft>;
  reviewComments?: ReadonlyArray<Pick<ReviewCommentContext, "filePath" | "rangeLabel">> | undefined;
}): string {
  const firstImage = input.images[0];
  const firstTerminalContext = input.terminalContexts[0];
  const firstReviewComment = input.reviewComments?.[0];
  const titleSeed = input.trimmedPrompt
    ? input.trimmedPrompt
    : firstImage
      ? `${isComposerPdfFile({ name: firstImage.name, type: "" }) ? "PDF" : "Image"}: ${firstImage.name}`
      : firstTerminalContext
        ? formatTerminalContextLabel(firstTerminalContext)
        : firstReviewComment
          ? `Comment on ${firstReviewComment.filePath} ${firstReviewComment.rangeLabel}`
          : "New thread";
  return truncate(titleSeed);
}

export function buildThreadCreateModelSelection(input: {
  provider: ProviderKind;
  model: string | null;
  projectDefaultModel: string | null | undefined;
  options: ModelSelection["options"] | undefined;
}): ModelSelection {
  return {
    provider: input.provider,
    model: input.model || input.projectDefaultModel || DEFAULT_MODEL_BY_PROVIDER.codex,
    ...(input.options ? { options: input.options } : {}),
  };
}

/** Guard for the thread.stop shortcut: only a turn the server reports as running can be interrupted. */
export function canInterruptRunningTurn(input: {
  phase: string;
  sessionStatus: string | null | undefined;
}): boolean {
  return input.phase === "running" && input.sessionStatus === "running";
}

const RUNTIME_MODE_CYCLE: ReadonlyArray<RuntimeMode> = ["approval-required", "auto", "full-access"];

/** Next mode for the composer.mode shortcut: approval-required -> auto -> full-access -> approval-required. */
export function nextRuntimeModeInCycle(mode: RuntimeMode): RuntimeMode {
  const index = RUNTIME_MODE_CYCLE.indexOf(mode);
  return RUNTIME_MODE_CYCLE[(index + 1) % RUNTIME_MODE_CYCLE.length] ?? "approval-required";
}

export const COMPOSER_IMAGE_TOTAL_SIZE_ERROR = `Images can total up to ${
  PROVIDER_SEND_TURN_MAX_TOTAL_IMAGE_BYTES / (1024 * 1024)
} MiB per message. Use smaller images or send fewer at once.`;
export const COMPOSER_ATTACHMENT_TOTAL_SIZE_ERROR = `Attachments can total up to ${
  PROVIDER_SEND_TURN_MAX_TOTAL_IMAGE_BYTES / (1024 * 1024)
} MiB per message. Use smaller files or send fewer at once.`;

/** Upper bound for an image's attached size: larger images are fitted down to the per-image cap. */
export function estimateComposerImageBudgetBytes(file: { size: number }): number {
  return Math.min(file.size, PROVIDER_SEND_TURN_MAX_IMAGE_BYTES);
}

/** Keeps images in order while the running total stays within the per-message image budget. */
export function takeComposerImagesWithinTotalBudget<T extends { sizeBytes: number }>(
  existingTotalBytes: number,
  images: ReadonlyArray<T>,
): { accepted: T[]; overBudget: boolean } {
  const accepted: T[] = [];
  let totalBytes = existingTotalBytes;
  let overBudget = false;
  for (const image of images) {
    if (totalBytes + image.sizeBytes > PROVIDER_SEND_TURN_MAX_TOTAL_IMAGE_BYTES) {
      overBudget = true;
      continue;
    }
    totalBytes += image.sizeBytes;
    accepted.push(image);
  }
  return { accepted, overBudget };
}

export function buildCheckpointRevertCommand(input: {
  commandId: CommandId;
  threadId: ThreadId;
  turnCount: number;
  restoreFiles: boolean;
  createdAt: string;
}) {
  return {
    type: "thread.checkpoint.revert" as const,
    commandId: input.commandId,
    threadId: input.threadId,
    turnCount: input.turnCount,
    // Absent means restore, the same as stored events.
    ...(input.restoreFiles ? {} : { restoreFiles: false }),
    createdAt: input.createdAt,
  };
}

/** Composer provider for a thread that has not started: explicit choices first, else an installed default. */
export function resolveUnlockedComposerProvider(input: {
  providers: ReadonlyArray<ServerProvider>;
  draftProvider: ProviderKind | null | undefined;
  threadProvider: ProviderKind | null | undefined;
}): ProviderKind {
  return resolveSelectableProvider(
    input.providers,
    input.draftProvider ?? input.threadProvider ?? null,
  );
}

/**
 * A send queued while images were being fitted must not go out without an image that failed
 * to fit; returns the queued thread to keep (null drops the queue so the user can resend).
 */
export function queuedSendAfterImageFit<T extends string>(input: {
  readonly queuedThreadId: T | null;
  readonly fitThreadId: T;
  readonly fitFailed: boolean;
}): T | null {
  if (input.fitFailed && input.queuedThreadId === input.fitThreadId) return null;
  return input.queuedThreadId;
}

/**
 * Follow-up kept for a queued send. A mid-turn queue is dropped on thread change, so it never
 * opens a new thread; `droppedFollowUp` tells the caller to say so.
 */
export function resolveQueuedSendFollowUp(input: {
  readonly isRunning: boolean;
  readonly followUp: ComposerSendFollowUp | null;
}): { followUp: ComposerSendFollowUp | null; droppedFollowUp: boolean } {
  if (!input.isRunning) return { followUp: input.followUp, droppedFollowUp: false };
  return { followUp: null, droppedFollowUp: input.followUp !== null };
}

const SEARCHABLE_MODEL_PROVIDERS: ReadonlyArray<ProviderKind> = ["claudeAgent", "codex"];

/** Models `/model` can offer: a locked thread keeps its provider, and a disabled provider is left out. */
export function buildSearchableModelOptions(input: {
  readonly modelOptionsByProvider: Readonly<
    Record<
      ProviderKind,
      ReadonlyArray<{
        readonly slug: string;
        readonly name: string;
        readonly isCustom?: boolean | undefined;
      }>
    >
  >;
  readonly lockedProvider: ProviderKind | null;
  readonly providerStatuses: ReadonlyArray<Pick<ServerProvider, "provider" | "enabled">>;
}) {
  return SEARCHABLE_MODEL_PROVIDERS.filter(
    (provider) =>
      (input.lockedProvider === null || input.lockedProvider === provider) &&
      input.providerStatuses.find((status) => status.provider === provider)?.enabled !== false,
  ).flatMap((provider) => {
    const providerLabel = PROVIDER_DISPLAY_NAMES[provider];
    return input.modelOptionsByProvider[provider].map(({ slug, name, isCustom }) => ({
      provider,
      providerLabel,
      slug,
      name,
      isCustom,
      searchSlug: slug.toLowerCase(),
      searchName: name.toLowerCase(),
      searchProvider: providerLabel.toLowerCase(),
    }));
  });
}

/** A slash trigger with nothing to offer stays closed, so `/usr/bin` or `/compact` just sends. */
export function isComposerMenuOpen(
  trigger: { readonly kind: string } | null,
  itemCount: number,
): boolean {
  if (trigger === null) return false;
  return trigger.kind !== "slash-command" || itemCount > 0;
}

/** Why compaction can't start right now, most blocking first; null when it can. */
export function resolveCompactDisabledReason(input: {
  readonly isRunning: boolean;
  readonly hasPendingRequest: boolean;
  readonly hasPlanFollowUp: boolean;
  readonly hasDraft: boolean;
}): string | null {
  if (input.isRunning) return "Wait for the current turn to finish";
  if (input.hasPendingRequest) return "Answer the pending request first";
  if (input.hasPlanFollowUp) return "Finish the plan follow-up first";
  if (input.hasDraft) return "Send or clear your draft before compacting";
  return null;
}
