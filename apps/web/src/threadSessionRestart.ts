import type { ThreadId } from "@piedpiper/contracts";

import { canRestartThreadSession } from "./components/CommandPalette.logic";
import { toastManager } from "./components/ui/toast";
import { newCommandId } from "./lib/utils";
import { readNativeApi } from "./nativeApi";
import { useStore } from "./store";

/**
 * Stops an idle session so the next message resumes it with reloaded MCP servers, plugins and
 * settings. Confirms first because the stop ends Claude background tasks the web cannot see.
 */
export async function restartThreadSession(threadId: ThreadId): Promise<void> {
  const api = readNativeApi();
  if (!api) return;
  const confirmed = await api.dialogs.confirm(
    [
      "Restart this session?",
      "The conversation is kept. MCP servers, plugins and settings reload on your next message.",
      "Any Claude background tasks in this session will stop.",
    ].join("\n"),
  );
  if (!confirmed) return;
  // A turn can start while the confirmation is up.
  const thread = useStore.getState().sidebarThreadsById[threadId];
  if (!thread || !canRestartThreadSession(thread)) {
    toastManager.add({
      type: "warning",
      title: "Session not restarted",
      description: "The session became busy. Try again when it is idle.",
    });
    return;
  }
  try {
    await api.orchestration.dispatchCommand({
      type: "thread.session.stop",
      commandId: newCommandId(),
      threadId,
      // A restart only reloads the session, so a pending usage-limit resume stays armed.
      keepUsageLimitResume: true,
      createdAt: new Date().toISOString(),
    });
  } catch (error) {
    toastManager.add({
      type: "error",
      title: "Failed to restart session",
      description: error instanceof Error ? error.message : "An error occurred.",
    });
    return;
  }
  toastManager.add({
    type: "success",
    title: "Session will restart",
    description: "Your next message starts it again and keeps the conversation.",
  });
}
