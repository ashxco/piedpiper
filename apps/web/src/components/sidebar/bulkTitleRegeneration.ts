import type { ThreadId } from "@piedpiper/contracts";

import { useStore } from "../../store";
import { runThreadTitleRegeneration } from "../../threadTitleRegenerationStore";
import { regenerateThreadTitlesSequentially } from "../Sidebar.logic";

/**
 * The single-thread flow for each selected thread, stopping at the first dispatch that fails so
 * the caller can show one toast. A thread already regenerating is skipped without a dispatch.
 */
export function regenerateThreadTitlesInBulk(
  threadIds: readonly ThreadId[],
  dispatch: (threadId: ThreadId) => Promise<unknown>,
): Promise<{ regeneratedThreadIds: ThreadId[]; firstError: unknown }> {
  return regenerateThreadTitlesSequentially(threadIds, (threadId) => {
    // Otherwise an earlier manual rename would drop the regenerated title in the store.
    useStore.getState().clearThreadUserRenamed(threadId);
    return runThreadTitleRegeneration(
      threadId,
      () => dispatch(threadId),
      (description) => {
        throw new Error(description);
      },
    );
  });
}
