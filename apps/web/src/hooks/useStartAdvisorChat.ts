import { ADVISORS_PROJECT_ID } from "@piedpiper/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useState } from "react";

import { advisorThreadTitle } from "../lib/advisorIdentity";
import { newCommandId, newThreadId } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import { toastManager } from "../components/ui/toast";

export interface UseStartAdvisorChatResult {
  /**
   * Creates a new server-side thread under the hidden Advisors project (which
   * the server bootstraps on startup), pinned to Claude Haiku and seeded with
   * a system prompt that puts the model in the named character's voice.
   * Navigates to the new thread on success. Toasts on failure.
   */
  readonly startAdvisorChat: (characterId: string) => Promise<void>;
  /** True while a thread.create dispatch is in flight. */
  readonly isStartingAdvisorChat: boolean;
}

export function useStartAdvisorChat(): UseStartAdvisorChatResult {
  const navigate = useNavigate();
  const [isStartingAdvisorChat, setIsStartingAdvisorChat] = useState(false);

  const startAdvisorChat = useCallback(
    async (characterId: string): Promise<void> => {
      if (isStartingAdvisorChat) return;
      const api = readNativeApi();
      if (!api) return;

      const threadId = newThreadId();
      const title = advisorThreadTitle(characterId);
      const createdAt = new Date().toISOString();

      setIsStartingAdvisorChat(true);
      // Lazy-import the catalog so the ~5000-line CHARACTER_LINES corpus
      // lands in its own chunk and never reaches the chat critical path.
      // First click triggers the chunk download (small, fast); subsequent
      // clicks reuse the cached module.
      const { buildAdvisorSystemPrompt } = await import("../lib/advisorCatalog");
      const systemPrompt = buildAdvisorSystemPrompt(characterId);
      try {
        await api.orchestration.dispatchCommand({
          type: "thread.create",
          commandId: newCommandId(),
          threadId,
          projectId: ADVISORS_PROJECT_ID,
          title,
          modelSelection: {
            provider: "claudeAgent",
            model: "claude-haiku-4-5",
          },
          runtimeMode: "full-access",
          // Advisors default to "ask" mode: pure conversational, no tools.
          // The user can toggle to "default" (Agent) from the composer if
          // they want the advisor to actually generate a file.
          interactionMode: "ask",
          systemPrompt,
          branch: null,
          worktreePath: null,
          createdAt,
        });
        await navigate({
          to: "/$threadId",
          params: { threadId },
        });
      } catch (error) {
        const description =
          error instanceof Error
            ? error.message
            : "An error occurred while starting the advisor chat.";
        toastManager.add({
          type: "error",
          title: "Couldn't start advisor chat",
          description,
        });
      } finally {
        setIsStartingAdvisorChat(false);
      }
    },
    [isStartingAdvisorChat, navigate],
  );

  return { startAdvisorChat, isStartingAdvisorChat };
}
