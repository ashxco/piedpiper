import { type RefObject, useEffect, useRef } from "react";

import type { ComposerPromptEditorHandle } from "../components/ComposerPromptEditor";
import {
  buildComposerPromptHistoryEntries,
  type ComposerPromptHistoryMessage,
  type ComposerPromptHistoryPosition,
  stepComposerPromptHistory,
} from "../components/chat/composerPromptHistory";

/**
 * ArrowUp/ArrowDown prompt recall for one thread's composer. `navigate` returns the
 * prompt to put in the composer, or null to let the arrow move the caret. Call
 * `noteEdit` from the composer's change handler so any edit ends browsing.
 */
export function useComposerPromptHistory(input: {
  threadId: string;
  messages: ReadonlyArray<ComposerPromptHistoryMessage>;
  editorRef: RefObject<ComposerPromptEditorHandle | null>;
}) {
  const { threadId, messages, editorRef } = input;
  const positionRef = useRef<ComposerPromptHistoryPosition | null>(null);

  // The composer persists across threads; a recall from one must not carry into another.
  useEffect(() => {
    positionRef.current = null;
  }, [threadId]);

  const navigate = (direction: "backward" | "forward", currentPrompt: string): string | null => {
    // A typed draft with no active recall never steps; skip the layout read.
    if (positionRef.current === null && currentPrompt.length > 0) return null;
    const editor = editorRef.current;
    if (!editor?.isCaretOnVisualEdge(direction === "backward" ? "start" : "end")) return null;
    const step = stepComposerPromptHistory({
      direction,
      entries: buildComposerPromptHistoryEntries(messages),
      position: positionRef.current,
      currentPrompt,
    });
    if (!step) return null;
    positionRef.current = step.position;
    return step.prompt;
  };

  const noteEdit = (nextPrompt: string) => {
    if (positionRef.current?.recalled !== nextPrompt) {
      positionRef.current = null;
    }
  };

  return { navigate, noteEdit };
}
