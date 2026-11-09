import { ThreadId } from "@piedpiper/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ReviewCommentContext } from "./reviewCommentContext";
import {
  sanitizePersistedReviewComments,
  selectReviewComments,
  useReviewCommentDraftStore,
  useReviewCommentFormStore,
} from "./reviewCommentDraftStore";

const THREAD = ThreadId.makeUnsafe("thread-1");
const OTHER_THREAD = ThreadId.makeUnsafe("thread-2");

function comment(id: string): ReviewCommentContext {
  return {
    id,
    sectionId: "uncommitted",
    sectionTitle: "Uncommitted changes",
    filePath: "a.ts",
    startIndex: 0,
    endIndex: 0,
    rangeLabel: "+1",
    text: `text ${id}`,
    diff: "@@ -0,0 +1,1 @@\n+a",
  };
}

const read = (threadId: ThreadId) =>
  selectReviewComments(threadId)(useReviewCommentDraftStore.getState()).map((entry) => entry.id);

describe("useReviewCommentDraftStore", () => {
  beforeEach(() => {
    useReviewCommentDraftStore.setState({ commentsByThreadId: {} });
    useReviewCommentFormStore.setState({ text: "" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const stubStorage = (setItem: (name: string, value: string) => void) =>
    vi.stubGlobal("localStorage", { getItem: () => null, setItem, removeItem: () => undefined });

  it("persists a comment, but does not write while the comment form is typed in", () => {
    const setItem = vi.fn();
    stubStorage(setItem);
    useReviewCommentFormStore.getState().setText("typing");
    expect(setItem).not.toHaveBeenCalled();
    useReviewCommentDraftStore.getState().addComment(THREAD, comment("a"));
    expect(setItem).toHaveBeenCalledTimes(1);
  });

  it("keeps a comment in memory when storage is full", () => {
    stubStorage(() => {
      throw new Error("QuotaExceededError");
    });
    useReviewCommentDraftStore.getState().addComment(THREAD, comment("a"));
    expect(read(THREAD)).toEqual(["a"]);
  });

  it("adds per thread and ignores a duplicate id", () => {
    const store = useReviewCommentDraftStore.getState();
    store.addComment(THREAD, comment("a"));
    store.addComment(THREAD, comment("a"));
    store.addComment(OTHER_THREAD, comment("b"));
    expect(read(THREAD)).toEqual(["a"]);
    expect(read(OTHER_THREAD)).toEqual(["b"]);
  });

  it("removes and clears, dropping the empty thread entry", () => {
    const store = useReviewCommentDraftStore.getState();
    store.addComment(THREAD, comment("a"));
    store.addComment(THREAD, comment("b"));
    store.removeComment(THREAD, "a");
    expect(read(THREAD)).toEqual(["b"]);
    store.clearComments(THREAD);
    expect(read(THREAD)).toEqual([]);
    expect(useReviewCommentDraftStore.getState().commentsByThreadId).toEqual({});
  });

  it("restores comments after a failed send ahead of newer ones", () => {
    const store = useReviewCommentDraftStore.getState();
    store.addComment(THREAD, comment("new"));
    store.restoreComments(THREAD, [comment("a"), comment("new")]);
    expect(read(THREAD)).toEqual(["a", "new"]);
  });

  it("returns a stable empty list for an unknown thread", () => {
    const state = useReviewCommentDraftStore.getState();
    expect(selectReviewComments(THREAD)(state)).toBe(selectReviewComments(null)(state));
  });
});

describe("sanitizePersistedReviewComments", () => {
  it("keeps well-formed entries and drops the rest", () => {
    expect(
      sanitizePersistedReviewComments({
        commentsByThreadId: {
          good: [comment("a"), { id: "broken" }],
          bad: "nope",
          empty: [{ id: "broken" }],
        },
      }),
    ).toEqual({ good: [comment("a")] });
  });

  it("tolerates unknown shapes", () => {
    expect(sanitizePersistedReviewComments(null)).toEqual({});
    expect(sanitizePersistedReviewComments({ commentsByThreadId: 1 })).toEqual({});
  });
});
