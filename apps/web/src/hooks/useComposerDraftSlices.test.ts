import { ThreadId } from "@piedpiper/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useComposerDraftStore } from "../composerDraftStore";
import { subscribeComposerThreadPrompt } from "./useComposerDraftSlices";

const THREAD_ID = ThreadId.makeUnsafe("thread-prompt-subscription");
const OTHER_THREAD_ID = ThreadId.makeUnsafe("thread-prompt-subscription-other");

describe("subscribeComposerThreadPrompt", () => {
  beforeEach(() => {
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
      stickyModelSelectionByProvider: {},
      stickyActiveProvider: null,
    });
  });

  it("only fires when this thread's prompt changes", () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(THREAD_ID, "draft");
    const listener = vi.fn();
    const unsubscribe = subscribeComposerThreadPrompt(THREAD_ID, listener);
    try {
      store.setPrompt(OTHER_THREAD_ID, "other thread");
      store.setInteractionMode(THREAD_ID, "plan");
      store.setRuntimeMode(THREAD_ID, "full-access");
      store.setPrompt(THREAD_ID, "draft");
      expect(listener).not.toHaveBeenCalled();

      store.setPrompt(THREAD_ID, "draft edited");
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenLastCalledWith("draft edited");

      store.setPrompt(THREAD_ID, "");
      expect(listener).toHaveBeenLastCalledWith("");
    } finally {
      unsubscribe();
    }
  });
});
