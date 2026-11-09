import type { ThreadId } from "@piedpiper/contracts";
import * as Schema from "effect/Schema";
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";

import { ReviewCommentContextSchema, type ReviewCommentContext } from "./reviewCommentContext";

export const REVIEW_COMMENT_DRAFT_STORAGE_KEY = "piedpiper:review-comment-drafts:v1";

const EMPTY_REVIEW_COMMENTS: ReadonlyArray<ReviewCommentContext> = [];
const isReviewCommentContext = Schema.is(ReviewCommentContextSchema);

interface ReviewCommentDraftState {
  /** Comments waiting for the thread's next prompt. */
  commentsByThreadId: Readonly<Record<string, ReadonlyArray<ReviewCommentContext>>>;
  addComment: (threadId: ThreadId, comment: ReviewCommentContext) => void;
  removeComment: (threadId: ThreadId, commentId: string) => void;
  clearComments: (threadId: ThreadId) => void;
  /** Puts comments back after a failed send, ahead of any added since. */
  restoreComments: (threadId: ThreadId, comments: ReadonlyArray<ReviewCommentContext>) => void;
}

function withThreadComments(
  state: ReviewCommentDraftState,
  threadId: ThreadId,
  comments: ReadonlyArray<ReviewCommentContext>,
): Pick<ReviewCommentDraftState, "commentsByThreadId"> {
  const { [threadId]: _previous, ...rest } = state.commentsByThreadId;
  return { commentsByThreadId: comments.length > 0 ? { ...rest, [threadId]: comments } : rest };
}

function dedupeComments(
  comments: ReadonlyArray<ReviewCommentContext>,
): ReadonlyArray<ReviewCommentContext> {
  const seen = new Set<string>();
  return comments.filter((comment) => {
    if (seen.has(comment.id)) return false;
    seen.add(comment.id);
    return true;
  });
}

export function selectReviewComments(threadId: ThreadId | null) {
  return (state: ReviewCommentDraftState): ReadonlyArray<ReviewCommentContext> =>
    (threadId ? state.commentsByThreadId[threadId] : undefined) ?? EMPTY_REVIEW_COMMENTS;
}

/** Keeps only well-formed entries, so a corrupt or older draft cannot break the composer. */
export function sanitizePersistedReviewComments(
  persisted: unknown,
): Record<string, ReadonlyArray<ReviewCommentContext>> {
  const commentsByThreadId =
    typeof persisted === "object" && persisted !== null
      ? (persisted as { commentsByThreadId?: unknown }).commentsByThreadId
      : undefined;
  if (typeof commentsByThreadId !== "object" || commentsByThreadId === null) return {};
  const result: Record<string, ReadonlyArray<ReviewCommentContext>> = {};
  for (const [threadId, comments] of Object.entries(commentsByThreadId)) {
    if (!Array.isArray(comments)) continue;
    const valid = comments.filter(isReviewCommentContext);
    if (valid.length > 0) result[threadId] = valid;
  }
  return result;
}

/**
 * Text of the open diff form, here so a remounted form keeps it. A store of its own: persist writes
 * after every set, which would re-serialize every drafted comment on each keystroke.
 */
export const useReviewCommentFormStore = create<{
  text: string;
  setText: (text: string) => void;
}>()((set) => ({
  text: "",
  setText: (text) => set({ text }),
}));

// A full or blocked store only costs persistence; the comments stay usable in memory.
const quotaSafeLocalStorage: StateStorage = {
  getItem: (name) => localStorage.getItem(name),
  setItem: (name, value) => {
    try {
      localStorage.setItem(name, value);
    } catch {
      // The comment still goes out with the next prompt unless the app reloads first.
    }
  },
  removeItem: (name) => localStorage.removeItem(name),
};

export const useReviewCommentDraftStore = create<ReviewCommentDraftState>()(
  persist(
    (set) => ({
      commentsByThreadId: {},
      addComment: (threadId, comment) =>
        set((state) =>
          withThreadComments(
            state,
            threadId,
            dedupeComments([...(state.commentsByThreadId[threadId] ?? []), comment]),
          ),
        ),
      removeComment: (threadId, commentId) =>
        set((state) =>
          withThreadComments(
            state,
            threadId,
            (state.commentsByThreadId[threadId] ?? []).filter(
              (comment) => comment.id !== commentId,
            ),
          ),
        ),
      clearComments: (threadId) => set((state) => withThreadComments(state, threadId, [])),
      restoreComments: (threadId, comments) =>
        set((state) =>
          withThreadComments(
            state,
            threadId,
            dedupeComments([...comments, ...(state.commentsByThreadId[threadId] ?? [])]),
          ),
        ),
    }),
    {
      name: REVIEW_COMMENT_DRAFT_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() => quotaSafeLocalStorage),
      partialize: (state) => ({ commentsByThreadId: state.commentsByThreadId }),
      merge: (persisted, current) => ({
        ...current,
        commentsByThreadId: sanitizePersistedReviewComments(persisted),
      }),
    },
  ),
);
