import { ThreadId } from "@piedpiper/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() } }));

import { useStore } from "../../store";
import {
  applyThreadTitleRegenerationEvents,
  beginThreadTitleRegeneration,
  clearThreadTitleRegenerations,
  isThreadTitleRegenerating,
} from "../../threadTitleRegenerationStore";
import { regenerateThreadTitlesInBulk } from "./bulkTitleRegeneration";

const first = ThreadId.makeUnsafe("thread-1");
const second = ThreadId.makeUnsafe("thread-2");

describe("regenerateThreadTitlesInBulk", () => {
  afterEach(() => {
    clearThreadTitleRegenerations();
    useStore.getState().clearThreadUserRenamed(first);
  });

  it("clears a manual rename and leaves each thread pending after its dispatch", async () => {
    useStore.getState().markThreadUserRenamed(first);
    const dispatch = vi.fn(async () => undefined);

    const result = await regenerateThreadTitlesInBulk([first, second], dispatch);

    expect(result).toEqual({ regeneratedThreadIds: [first, second], firstError: null });
    expect(useStore.getState().userRenamedThreadIds.has(first)).toBe(false);
    expect(isThreadTitleRegenerating(first)).toBe(true);
    expect(isThreadTitleRegenerating(second)).toBe(true);
  });

  it("reports a failure the server settles later, since the thread is pending", async () => {
    await regenerateThreadTitlesInBulk([first], async () => undefined);
    const notifyError = vi.fn();

    applyThreadTitleRegenerationEvents(
      [
        {
          type: "thread.title-regeneration-settled",
          payload: { threadId: first, outcome: "failed", detail: "provider down" },
        } as never,
      ],
      notifyError,
    );

    expect(notifyError).toHaveBeenCalledExactlyOnceWith("provider down");
  });

  it("stops at the first rejected dispatch and clears that thread's pending state", async () => {
    const dispatch = vi.fn(async () => {
      throw new Error("server down");
    });

    const result = await regenerateThreadTitlesInBulk([first, second], dispatch);

    expect(dispatch).toHaveBeenCalledOnce();
    expect(result.regeneratedThreadIds).toEqual([]);
    expect(result.firstError).toEqual(new Error("server down"));
    expect(isThreadTitleRegenerating(first)).toBe(false);
  });

  it("does not dispatch again for a thread already regenerating", async () => {
    beginThreadTitleRegeneration(first);
    const dispatch = vi.fn(async () => undefined);

    await regenerateThreadTitlesInBulk([first, second], dispatch);

    expect(dispatch).toHaveBeenCalledExactlyOnceWith(second);
  });
});
