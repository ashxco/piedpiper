import type { OrchestrationEvent } from "@piedpiper/contracts";
import { ThreadId } from "@piedpiper/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyThreadTitleRegenerationEvents,
  beginThreadTitleRegeneration,
  clearThreadTitleRegenerations,
  endThreadTitleRegeneration,
  isThreadTitleRegenerating,
  runThreadTitleRegeneration,
  THREAD_TITLE_REGENERATION_TIMEOUT_MS,
} from "./threadTitleRegenerationStore";

vi.mock("./components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));

const threadId = ThreadId.makeUnsafe("thread-1");
const otherThreadId = ThreadId.makeUnsafe("thread-2");

const settled = (
  outcome: "updated" | "unchanged" | "empty" | "failed",
  detail?: string,
  target = threadId,
) =>
  ({
    type: "thread.title-regeneration-settled",
    payload: {
      threadId: target,
      outcome,
      ...(detail !== undefined ? { detail } : {}),
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  }) as unknown as OrchestrationEvent;

let resolveDispatch = () => {};

describe("threadTitleRegenerationStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    clearThreadTitleRegenerations();
    vi.useRealTimers();
  });

  it.each(["updated", "unchanged", "empty"] as const)(
    "clears pending without an error on a settled %s",
    (outcome) => {
      const notifyError = vi.fn();
      beginThreadTitleRegeneration(threadId);

      applyThreadTitleRegenerationEvents([settled(outcome)], notifyError);

      expect(isThreadTitleRegenerating(threadId)).toBe(false);
      expect(notifyError).not.toHaveBeenCalled();
    },
  );

  it("clears pending and reports the detail on a settled failure", () => {
    const notifyError = vi.fn();
    beginThreadTitleRegeneration(threadId);

    applyThreadTitleRegenerationEvents([settled("failed", "model unavailable")], notifyError);

    expect(isThreadTitleRegenerating(threadId)).toBe(false);
    expect(notifyError).toHaveBeenCalledExactlyOnceWith("model unavailable");
  });

  it("does not report a failure this client was not waiting on, as in a replay", () => {
    const notifyError = vi.fn();

    applyThreadTitleRegenerationEvents([settled("failed", "old failure")], notifyError);

    expect(notifyError).not.toHaveBeenCalled();
  });

  it("leaves other threads pending", () => {
    beginThreadTitleRegeneration(threadId);
    beginThreadTitleRegeneration(otherThreadId);

    applyThreadTitleRegenerationEvents([settled("updated", undefined, otherThreadId)], vi.fn());

    expect(isThreadTitleRegenerating(threadId)).toBe(true);
    expect(isThreadTitleRegenerating(otherThreadId)).toBe(false);
  });

  it("clears pending when the thread is deleted", () => {
    beginThreadTitleRegeneration(threadId);

    applyThreadTitleRegenerationEvents(
      [{ type: "thread.deleted", payload: { threadId } } as unknown as OrchestrationEvent],
      vi.fn(),
    );

    expect(isThreadTitleRegenerating(threadId)).toBe(false);
  });

  it("clears everything on reconnect, including the timeouts", () => {
    beginThreadTitleRegeneration(threadId);
    beginThreadTitleRegeneration(otherThreadId);

    clearThreadTitleRegenerations();

    expect(isThreadTitleRegenerating(threadId)).toBe(false);
    expect(isThreadTitleRegenerating(otherThreadId)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("gives up after the timeout when no settled event arrives", () => {
    beginThreadTitleRegeneration(threadId);

    vi.advanceTimersByTime(THREAD_TITLE_REGENERATION_TIMEOUT_MS - 1);
    expect(isThreadTitleRegenerating(threadId)).toBe(true);

    vi.advanceTimersByTime(1);
    expect(isThreadTitleRegenerating(threadId)).toBe(false);
  });

  it("restarts the timeout when the same thread begins again", () => {
    beginThreadTitleRegeneration(threadId);
    vi.advanceTimersByTime(THREAD_TITLE_REGENERATION_TIMEOUT_MS - 1);

    beginThreadTitleRegeneration(threadId);
    vi.advanceTimersByTime(1);

    expect(isThreadTitleRegenerating(threadId)).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("reports whether the thread was pending when ended", () => {
    beginThreadTitleRegeneration(threadId);

    expect(endThreadTitleRegeneration(threadId)).toBe(true);
    expect(endThreadTitleRegeneration(threadId)).toBe(false);
  });

  it("is pending while the dispatch runs and stays pending after it succeeds", async () => {
    const run = runThreadTitleRegeneration(
      threadId,
      () => new Promise<void>((resolve) => (resolveDispatch = resolve)),
      vi.fn(),
    );
    expect(isThreadTitleRegenerating(threadId)).toBe(true);

    resolveDispatch();
    await run;

    expect(isThreadTitleRegenerating(threadId)).toBe(true);
  });

  it("does not dispatch again while a run is pending", async () => {
    const dispatch = vi.fn(() => Promise.resolve());
    beginThreadTitleRegeneration(threadId);

    await runThreadTitleRegeneration(threadId, dispatch, vi.fn());

    expect(dispatch).not.toHaveBeenCalled();
  });

  it("clears pending and reports the error when the dispatch fails", async () => {
    const notifyError = vi.fn();

    await runThreadTitleRegeneration(
      threadId,
      () => Promise.reject(new Error("socket closed")),
      notifyError,
    );

    expect(isThreadTitleRegenerating(threadId)).toBe(false);
    expect(notifyError).toHaveBeenCalledExactlyOnceWith("socket closed");
  });
});
