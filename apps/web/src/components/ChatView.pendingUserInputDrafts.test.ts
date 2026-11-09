import { beforeEach, describe, expect, it } from "vitest";

import {
  pendingUserInputDraftKey,
  pruneResolvedUserInputDrafts,
  usePendingUserInputDraftStore,
} from "./ChatView.pendingUserInputDrafts";

const keyA1 = pendingUserInputDraftKey("thread-a", "req-1");
const keyA2 = pendingUserInputDraftKey("thread-a", "req-2");
const keyB1 = pendingUserInputDraftKey("thread-b", "req-1");

describe("pruneResolvedUserInputDrafts", () => {
  it("drops only the thread's resolved requests", () => {
    const drafts = { [keyA1]: 1, [keyA2]: 2, [keyB1]: 3 };
    expect(pruneResolvedUserInputDrafts(drafts, "thread-a", new Set(["req-2"]))).toEqual({
      [keyA2]: 2,
      [keyB1]: 3,
    });
  });

  it("returns the same object when nothing is resolved", () => {
    const drafts = { [keyA1]: 1, [keyB1]: 3 };
    expect(pruneResolvedUserInputDrafts(drafts, "thread-a", new Set(["req-1"]))).toBe(drafts);
    expect(pruneResolvedUserInputDrafts(drafts, "thread-c", new Set())).toBe(drafts);
  });
});

describe("usePendingUserInputDraftStore", () => {
  beforeEach(() => {
    usePendingUserInputDraftStore.setState({ answers: {}, questionIndex: {} });
  });

  it("keeps drafts in a module store and prunes both maps per thread", () => {
    const store = usePendingUserInputDraftStore.getState();
    store.updateAnswers((current) => ({
      ...current,
      [keyA1]: { q: { customAnswer: "typed" } },
      [keyB1]: { q: { customAnswer: "other" } },
    }));
    store.updateQuestionIndex((current) => ({ ...current, [keyA1]: 2, [keyB1]: 1 }));

    store.pruneThread("thread-a", new Set(["req-1"]));
    expect(usePendingUserInputDraftStore.getState().answers[keyA1]?.q?.customAnswer).toBe("typed");

    const before = usePendingUserInputDraftStore.getState();
    store.pruneThread("thread-a", new Set(["req-1"]));
    expect(usePendingUserInputDraftStore.getState()).toBe(before);

    store.pruneThread("thread-a", new Set());
    const after = usePendingUserInputDraftStore.getState();
    expect(after.answers).toEqual({ [keyB1]: { q: { customAnswer: "other" } } });
    expect(after.questionIndex).toEqual({ [keyB1]: 1 });
  });
});
