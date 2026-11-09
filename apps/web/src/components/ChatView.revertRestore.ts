import {
  type MessageId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_TOTAL_IMAGE_BYTES,
  type ThreadId,
} from "@piedpiper/contracts";
import { create } from "zustand";

import { type ComposerImageAttachment } from "../composerDraftStore";
import { randomUUID } from "~/lib/utils";
import { type ReviewCommentContext } from "~/reviewCommentContext";
import { useStore } from "../store";
import { type ChatMessage, type Thread } from "../types";
import { recallableComposerPrompt } from "./chat/composerPromptHistory";
import { deriveUserMessageWithReviewComments } from "./timelineHeight";

const REVERT_IMAGE_FETCH_TIMEOUT_MS = 30_000;
const REVERT_WAIT_TIMEOUT_MS = 120_000;
const REVERT_FAILED_ACTIVITY_KIND = "checkpoint.revert.failed";

/** The draft stays first, so reverting never reorders what the user was already writing. */
export function mergeRevertedPrompt(currentPrompt: string, messageText: string): string {
  const restored = recallableComposerPrompt(messageText);
  if (restored.length === 0) return currentPrompt;
  return currentPrompt.length > 0 ? `${currentPrompt}\n\n${restored}` : restored;
}

/**
 * The message's diff comments, for the draft. Fresh ids: parsed ones repeat between messages, and
 * the draft would drop a different comment on the same lines from an earlier revert.
 */
export function restorableReviewComments(messageText: string): ReviewCommentContext[] {
  return deriveUserMessageWithReviewComments(messageText).reviewComments.map((comment) =>
    Object.assign({}, comment, { id: randomUUID() }),
  );
}

/**
 * Threads with a revert in flight. Kept per thread and outside ChatView: a revert can outlast a
 * switch away and back, and its landing would discard a turn sent meanwhile.
 */
const useRevertingThreadStore = create<{ readonly threadIds: ReadonlySet<ThreadId> }>(() => ({
  threadIds: new Set(),
}));

export function useIsThreadReverting(threadId: ThreadId | null): boolean {
  return useRevertingThreadStore((state) => threadId !== null && state.threadIds.has(threadId));
}

export function isThreadReverting(threadId: ThreadId): boolean {
  return useRevertingThreadStore.getState().threadIds.has(threadId);
}

export function setThreadReverting(threadId: ThreadId, reverting: boolean): void {
  useRevertingThreadStore.setState((state) => {
    const threadIds = new Set(state.threadIds);
    if (reverting) threadIds.add(threadId);
    else threadIds.delete(threadId);
    return { threadIds };
  });
}

export interface RevertedMessageImages {
  readonly files: ReadonlyArray<File>;
  /** Images that could not be read back; the revert goes on without them. */
  readonly failedNames: ReadonlyArray<string>;
}

/** Fetched before the revert: the message's preview URLs are only known while it is in the store. */
export async function fetchRevertedMessageImages(
  message: Pick<ChatMessage, "attachments">,
): Promise<RevertedMessageImages> {
  // PDFs have no preview URL to fetch from, so only images come back.
  const images = (message.attachments ?? []).filter((attachment) => attachment.type === "image");
  const results = await Promise.all(
    images.map(async (attachment) => {
      if (!attachment.previewUrl) return { name: attachment.name, file: null };
      try {
        const response = await fetch(attachment.previewUrl, {
          // Attachments are cached for a year, and an entry from before CORS headers were added
          // would fail this cross-origin read.
          cache: "reload",
          signal: AbortSignal.timeout(REVERT_IMAGE_FETCH_TIMEOUT_MS),
        });
        if (!response.ok) return { name: attachment.name, file: null };
        const blob = await response.blob();
        const file = new File([blob], attachment.name, { type: attachment.mimeType });
        return { name: attachment.name, file };
      } catch {
        return { name: attachment.name, file: null };
      }
    }),
  );
  return {
    files: results.flatMap((result) => (result.file ? [result.file] : [])),
    failedNames: results.flatMap((result) => (result.file ? [] : [result.name])),
  };
}

/** Checked before the destructive revert, so a refusal costs the user nothing. */
export function revertedImagesFitDraft(input: {
  readonly draftImages: ReadonlyArray<{ readonly sizeBytes: number }>;
  readonly preparingImageCount: number;
  readonly restoredFiles: ReadonlyArray<Pick<File, "size">>;
}): boolean {
  const { draftImages, preparingImageCount, restoredFiles } = input;
  if (restoredFiles.length === 0) return true;
  const count = draftImages.length + preparingImageCount + restoredFiles.length;
  if (count > PROVIDER_SEND_TURN_MAX_ATTACHMENTS) return false;
  const totalBytes =
    draftImages.reduce((total, image) => total + image.sizeBytes, 0) +
    restoredFiles.reduce((total, file) => total + file.size, 0);
  return totalBytes <= PROVIDER_SEND_TURN_MAX_TOTAL_IMAGE_BYTES;
}

export function unrestoredImagesToast(failedNames: ReadonlyArray<string>): {
  title: string;
  description: string;
} {
  return {
    title: `${failedNames.length === 1 ? "An image was" : `${failedNames.length} images were`} not restored.`,
    description: `Attach ${failedNames.length === 1 ? "it" : "them"} again before sending: ${failedNames.join(", ")}.`,
  };
}

export function buildRevertedComposerImages(files: ReadonlyArray<File>): ComposerImageAttachment[] {
  return files.map((file) => ({
    type: "image",
    id: randomUUID(),
    name: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
    previewUrl: URL.createObjectURL(file),
    file,
  }));
}

function hasCheckpointAfter(thread: Thread | undefined, turnCount: number): boolean {
  return (thread?.turnDiffSummaries ?? []).some(
    (summary) =>
      summary.checkpointTurnCount === undefined || summary.checkpointTurnCount > turnCount,
  );
}

function revertFailureDetail(activity: Thread["activities"][number]): string {
  const payload = activity.payload as { detail?: unknown } | null | undefined;
  return typeof payload?.detail === "string" && payload.detail.length > 0
    ? payload.detail
    : "Failed to revert thread state.";
}

/**
 * Accepting the revert command does not mean it worked, so this settles on what reaches the store:
 * the message leaves, or a new revert failure appears. Newer checkpoints disappearing also counts,
 * for a user message the server's retention keeps.
 */
export function waitForRevertedMessage(input: {
  threadId: ThreadId;
  messageId: MessageId;
  turnCount: number;
  revert: () => Promise<unknown>;
  timeoutMs?: number;
}): Promise<void> {
  const { threadId, messageId, turnCount } = input;
  const readThread = () => useStore.getState().threads.find((thread) => thread.id === threadId);
  const initialThread = readThread();
  const knownFailureIds = new Set(
    (initialThread?.activities ?? [])
      .filter((activity) => activity.kind === REVERT_FAILED_ACTIVITY_KIND)
      .map((activity) => activity.id),
  );
  const hadNewerCheckpoint = hasCheckpointAfter(initialThread, turnCount);

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let unsubscribe: (() => void) | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      unsubscribe?.();
      if (error) reject(error);
      else resolve();
    };
    const inspect = () => {
      const thread = readThread();
      if (!thread) {
        finish(new Error("The thread is no longer available."));
        return;
      }
      const failure = thread.activities.find(
        (activity) =>
          activity.kind === REVERT_FAILED_ACTIVITY_KIND && !knownFailureIds.has(activity.id),
      );
      if (failure) {
        finish(new Error(revertFailureDetail(failure)));
        return;
      }
      const messageLeft = !thread.messages.some((message) => message.id === messageId);
      if (messageLeft || (hadNewerCheckpoint && !hasCheckpointAfter(thread, turnCount))) finish();
    };
    // Subscribed before dispatching: the revert's events can arrive before the command resolves.
    unsubscribe = useStore.subscribe(inspect);
    timeout = setTimeout(
      () => finish(new Error("Timed out waiting for the thread to revert.")),
      input.timeoutMs ?? REVERT_WAIT_TIMEOUT_MS,
    );
    input.revert().catch((error: unknown) => {
      finish(error instanceof Error ? error : new Error("Failed to revert thread state."));
    });
  });
}
