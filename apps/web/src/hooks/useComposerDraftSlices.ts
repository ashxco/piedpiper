import { type ThreadId } from "@piedpiper/contracts";
import { isClaudeUltrathinkPrompt } from "@piedpiper/shared/model";
import { useShallow } from "zustand/react/shallow";

import { type ComposerThreadDraftState, useComposerDraftStore } from "../composerDraftStore";

export type ComposerThreadDraftWithoutPrompt = Omit<ComposerThreadDraftState, "prompt">;

const EMPTY_DRAFT_WITHOUT_PROMPT = Object.freeze<ComposerThreadDraftWithoutPrompt>({
  images: [],
  nonPersistedImageIds: [],
  persistedAttachments: [],
  terminalContexts: [],
  modelSelectionByProvider: {},
  activeProvider: null,
  runtimeMode: null,
  interactionMode: null,
});

/** Sentinel that keeps provider-state derivation in sync with ultrathink detection only. */
const ULTRATHINK_PROVIDER_STATE_PROMPT = "ultrathink";

export function readComposerThreadPrompt(threadId: ThreadId): string {
  return useComposerDraftStore.getState().draftsByThreadId[threadId]?.prompt ?? "";
}

/**
 * Subscribes to everything in the thread draft except the prompt text so the
 * subscriber does not re-render on every composer keystroke.
 */
export function useComposerThreadDraftWithoutPrompt(
  threadId: ThreadId,
): ComposerThreadDraftWithoutPrompt {
  return useComposerDraftStore(
    useShallow((state): ComposerThreadDraftWithoutPrompt => {
      const draft = state.draftsByThreadId[threadId];
      if (!draft) {
        return EMPTY_DRAFT_WITHOUT_PROMPT;
      }
      const { prompt: _prompt, ...rest } = draft;
      return rest;
    }),
  );
}

/**
 * Calls `listener` only when this thread's stored prompt changes, ignoring every other
 * draft-store write (other threads, images, model selection, ...).
 */
export function subscribeComposerThreadPrompt(
  threadId: ThreadId,
  listener: (prompt: string) => void,
): () => void {
  return useComposerDraftStore.subscribe((state, previousState) => {
    const nextPrompt = state.draftsByThreadId[threadId]?.prompt ?? "";
    if (nextPrompt === (previousState.draftsByThreadId[threadId]?.prompt ?? "")) return;
    listener(nextPrompt);
  });
}

export function useComposerThreadPrompt(threadId: ThreadId): string {
  return useComposerDraftStore((state) => state.draftsByThreadId[threadId]?.prompt ?? "");
}

/**
 * Provider state only depends on whether the prompt activates ultrathink, so
 * subscribe to that bit instead of the full text.
 */
export function useComposerProviderStatePrompt(threadId: ThreadId): string {
  return useComposerDraftStore((state) =>
    isClaudeUltrathinkPrompt(state.draftsByThreadId[threadId]?.prompt)
      ? ULTRATHINK_PROVIDER_STATE_PROMPT
      : "",
  );
}
