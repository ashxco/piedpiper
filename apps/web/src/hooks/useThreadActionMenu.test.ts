import { ThreadId } from "@piedpiper/contracts";
import { describe, expect, it, vi } from "vitest";

import { useStore } from "../store";
import {
  clearThreadTitleRegenerations,
  isThreadTitleRegenerating,
} from "../threadTitleRegenerationStore";
import {
  deleteThreadFromActionMenu,
  regenerateThreadTitleFromActionMenu,
} from "./useThreadActionMenu";

const THREAD_ID = ThreadId.makeUnsafe("thread-1");

describe("deleteThreadFromActionMenu", () => {
  it("reports a failed delete instead of rejecting", async () => {
    const notifyError = vi.fn();
    await expect(
      deleteThreadFromActionMenu(
        THREAD_ID,
        () => Promise.reject(new Error("Server unavailable")),
        notifyError,
      ),
    ).resolves.toBeUndefined();
    expect(notifyError).toHaveBeenCalledWith("Server unavailable");
  });

  it("stays quiet when the delete succeeds", async () => {
    const notifyError = vi.fn();
    const confirmAndDelete = vi.fn(() => Promise.resolve(true));
    await deleteThreadFromActionMenu(THREAD_ID, confirmAndDelete, notifyError);
    expect(confirmAndDelete).toHaveBeenCalledWith(THREAD_ID);
    expect(notifyError).not.toHaveBeenCalled();
  });
});

describe("regenerateThreadTitleFromActionMenu", () => {
  it("clears the rename flag and starts pending before the dispatch", async () => {
    clearThreadTitleRegenerations();
    useStore.getState().markThreadUserRenamed(THREAD_ID);
    const seen: Array<{ renamed: boolean; pending: boolean }> = [];
    const dispatch = vi.fn(async () => {
      seen.push({
        renamed: useStore.getState().userRenamedThreadIds.has(THREAD_ID),
        pending: isThreadTitleRegenerating(THREAD_ID),
      });
      return { sequence: 1 };
    });

    await regenerateThreadTitleFromActionMenu(THREAD_ID, dispatch as never);

    expect(seen).toEqual([{ renamed: false, pending: true }]);
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ type: "thread.title.regenerate", threadId: THREAD_ID }),
    );
    clearThreadTitleRegenerations();
  });
});
