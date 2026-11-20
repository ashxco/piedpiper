import type { ModelSelection, ThreadId } from "@piedpiper/contracts";
import { useEffect, useRef } from "react";

import { useStableCallback } from "./useStableCallback";

/** Sends composer option changes to the running query, including keyboard effort changes. */
export function useLiveClaudeSelection(input: {
  threadId: ThreadId | undefined;
  running: boolean;
  selection: ModelSelection;
  savedSelection: ModelSelection | undefined;
  apply: (threadId: ThreadId, selection: ModelSelection) => Promise<unknown>;
  onError: (threadId: ThreadId, error: unknown) => void;
}) {
  const previous = useRef<{ threadId: ThreadId | undefined; key: string } | null>(null);
  const selectionKey = JSON.stringify(input.selection);
  const apply = useStableCallback(input.apply);
  const onError = useStableCallback(input.onError);
  useEffect(() => {
    const last = previous.current;
    previous.current = { threadId: input.threadId, key: selectionKey };
    if (
      !last ||
      last.threadId !== input.threadId ||
      last.key === selectionKey ||
      !input.threadId ||
      !input.running ||
      input.selection.provider !== "claudeAgent" ||
      input.savedSelection?.provider !== "claudeAgent" ||
      input.selection.model !== input.savedSelection.model ||
      selectionKey === JSON.stringify(input.savedSelection)
    )
      return;
    const threadId = input.threadId;
    void apply(threadId, input.selection).catch((error: unknown) => onError(threadId, error));
  }, [
    input.threadId,
    input.running,
    input.selection,
    input.savedSelection,
    selectionKey,
    apply,
    onError,
  ]);
}
