import { ULTRATHINK_PROMPT_PREFIX } from "../../composer-logic";
import { isImageOnlyBootstrapPrompt } from "../../lib/imageOnlyBootstrapPrompt";
import { isRestartContinuationMessageId } from "../../lib/restartContinuation";
import { extractTrailingTerminalContexts } from "../../lib/terminalContext";
import { buildPlanImplementationPrompt } from "../../proposedPlan";
import { stripTrailingReviewComments } from "../../reviewCommentContext";

/**
 * Shell-style prompt recall for the composer. ArrowUp on an empty composer walks
 * back through the active thread's sent prompts, ArrowDown walks forward, and
 * stepping past the newest entry clears the composer. History is derived from the
 * thread's user messages on each keypress, so nothing is stored.
 */

export { IMAGE_ONLY_BOOTSTRAP_PROMPT } from "../../lib/imageOnlyBootstrapPrompt";

/** Prefix of the message sent when the user implements a proposed plan, derived from the builder so it cannot drift. */
export const PLAN_IMPLEMENTATION_PROMPT_PREFIX = buildPlanImplementationPrompt("");

export interface ComposerPromptHistoryMessage {
  readonly id: string;
  readonly role: string;
  readonly text: string;
}

export interface ComposerPromptHistoryEntry {
  readonly id: string;
  readonly prompt: string;
}

/**
 * Active recall. `entryId` is resolved against fresh entries on every step, so a
 * server ack replacing an optimistic message cannot move the position. `recalled`
 * is the text put in the composer; once the composer differs, browsing is over.
 */
export interface ComposerPromptHistoryPosition {
  readonly entryId: string;
  readonly recalled: string;
}

export interface ComposerPromptHistoryStep {
  readonly position: ComposerPromptHistoryPosition | null;
  readonly prompt: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Inline terminal chips are sent as `@terminal-1:12-13` labels whose content lives in
 * the trailing block. Once the block is stripped each label points at nothing, so
 * remove one label (and one adjacent space) per block header like `Terminal 1 lines 12-13`.
 */
function stripInlineTerminalLabels(prompt: string, headers: ReadonlyArray<string>): string {
  let result = prompt;
  for (const header of headers) {
    const match = /^(.+?) lines? (\d+(?:-\d+)?)$/.exec(header);
    if (!match) continue;
    const label = `@${match[1]!.trim().toLowerCase().replace(/\s+/g, "-")}:${match[2]}`;
    // Whole label only: `@terminal-1:4` must not match inside `@terminal-1:40`.
    const index = result.search(new RegExp(`${escapeRegExp(label)}(?![\\d-])`));
    if (index < 0) continue;
    let start = index;
    let end = index + label.length;
    if (result[end] === " ") end += 1;
    else if (result[start - 1] === " ") start -= 1;
    result = result.slice(0, start) + result.slice(end);
  }
  return result;
}

/**
 * Reduces a sent message to the text the user typed: drops the trailing terminal
 * context block with its inline labels, the diff comment blocks and the ultrathink prefix. App-composed sends
 * (image-only bootstrap, plan implementation) are not history and come back empty.
 */
export function recallableComposerPrompt(messageText: string): string {
  let prompt = messageText.trim();
  if (prompt.startsWith(ULTRATHINK_PROMPT_PREFIX)) {
    prompt = prompt.slice(ULTRATHINK_PROMPT_PREFIX.length);
  }
  const terminalContexts = extractTrailingTerminalContexts(prompt);
  if (terminalContexts.contextCount > 0) {
    prompt = stripInlineTerminalLabels(
      // Comment text can quote a terminal label, so the blocks go first.
      stripTrailingReviewComments(terminalContexts.promptText),
      terminalContexts.contexts.map((context) => context.header),
    );
  } else {
    prompt = stripTrailingReviewComments(prompt);
  }
  const trimmed = prompt.trim();
  if (
    isImageOnlyBootstrapPrompt(trimmed) ||
    trimmed.startsWith(PLAN_IMPLEMENTATION_PROMPT_PREFIX)
  ) {
    return "";
  }
  return trimmed;
}

/**
 * Oldest first. Consecutive identical prompts collapse into the newest one (like
 * shell `ignoredups`), and messages with no recallable text are skipped.
 */
export function buildComposerPromptHistoryEntries(
  messages: ReadonlyArray<ComposerPromptHistoryMessage>,
): ComposerPromptHistoryEntry[] {
  const entries: ComposerPromptHistoryEntry[] = [];
  for (const message of messages) {
    if (message.role !== "user") continue;
    // A prompt Pied Piper sent itself; recalling it could send it by accident.
    if (isRestartContinuationMessageId(message.id)) continue;
    const prompt = recallableComposerPrompt(message.text);
    if (prompt.length === 0) continue;
    const previous = entries.at(-1);
    if (previous && previous.prompt === prompt) {
      entries[entries.length - 1] = { id: message.id, prompt };
      continue;
    }
    entries.push({ id: message.id, prompt });
  }
  return entries;
}

function findActiveEntryIndex(
  entries: ReadonlyArray<ComposerPromptHistoryEntry>,
  position: ComposerPromptHistoryPosition,
): number {
  const byId = entries.findIndex((entry) => entry.id === position.entryId);
  if (byId >= 0) return byId;
  // A duplicate collapse can retire the recalled id while its text lives on.
  return entries.findLastIndex((entry) => entry.prompt === position.recalled);
}

/**
 * Returns null when the key should fall through to normal caret movement. Backward
 * starts only from an empty composer and stops at the oldest entry; forward past
 * the newest entry clears the composer and ends browsing.
 */
export function stepComposerPromptHistory(input: {
  readonly direction: "backward" | "forward";
  readonly entries: ReadonlyArray<ComposerPromptHistoryEntry>;
  readonly position: ComposerPromptHistoryPosition | null;
  readonly currentPrompt: string;
}): ComposerPromptHistoryStep | null {
  const { entries, position, currentPrompt } = input;
  const activeIndex =
    position && position.recalled === currentPrompt ? findActiveEntryIndex(entries, position) : -1;

  if (input.direction === "backward") {
    if (activeIndex < 0 && currentPrompt.length > 0) return null;
    const entry = entries[activeIndex < 0 ? entries.length - 1 : activeIndex - 1];
    if (!entry) return null;
    return { position: { entryId: entry.id, recalled: entry.prompt }, prompt: entry.prompt };
  }

  if (activeIndex < 0) return null;
  const entry = entries[activeIndex + 1];
  if (!entry) return { position: null, prompt: "" };
  return { position: { entryId: entry.id, recalled: entry.prompt }, prompt: entry.prompt };
}

export interface ComposerPromptHistoryKeyEvent {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  isComposing: boolean;
  keyCode: number;
}

/**
 * True when ArrowUp/ArrowDown may browse history at all: no modifier, no IME
 * composition, nothing pending, and no attachments that a recalled prompt would
 * silently be sent with.
 */
export function canBrowseComposerPromptHistory(input: {
  event: ComposerPromptHistoryKeyEvent;
  hasPendingApproval: boolean;
  hasPendingUserInput: boolean;
  imageCount: number;
  terminalContextCount: number;
}): boolean {
  const { event } = input;
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
  if (event.isComposing || event.keyCode === 229) return false;
  if (input.hasPendingApproval || input.hasPendingUserInput) return false;
  return input.imageCount === 0 && input.terminalContextCount === 0;
}
