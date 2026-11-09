import type { OrchestrationEvent, ThreadId } from "@piedpiper/contracts";
import { create } from "zustand";

import { toastManager } from "./components/ui/toast";

/** Above the server's worst case: three CLI attempts of three minutes each plus their backoff. */
export const THREAD_TITLE_REGENERATION_TIMEOUT_MS = 10 * 60_000;

interface ThreadTitleRegenerationState {
  readonly regeneratingThreadIds: ReadonlySet<ThreadId>;
}

/** Not persisted: a reload or reconnect forgets the run, and the server's title still arrives. */
export const useThreadTitleRegenerationStore = create<ThreadTitleRegenerationState>(() => ({
  regeneratingThreadIds: new Set(),
}));

const timeoutsByThreadId = new Map<ThreadId, ReturnType<typeof setTimeout>>();

export function isThreadTitleRegenerating(threadId: ThreadId): boolean {
  return useThreadTitleRegenerationStore.getState().regeneratingThreadIds.has(threadId);
}

/** Returns whether the thread was pending, so a settled event only notifies the client that asked. */
export function endThreadTitleRegeneration(threadId: ThreadId): boolean {
  const timeout = timeoutsByThreadId.get(threadId);
  if (timeout !== undefined) clearTimeout(timeout);
  timeoutsByThreadId.delete(threadId);
  if (!isThreadTitleRegenerating(threadId)) return false;
  const next = new Set(useThreadTitleRegenerationStore.getState().regeneratingThreadIds);
  next.delete(threadId);
  useThreadTitleRegenerationStore.setState({ regeneratingThreadIds: next });
  return true;
}

export function beginThreadTitleRegeneration(threadId: ThreadId): void {
  endThreadTitleRegeneration(threadId);
  timeoutsByThreadId.set(
    threadId,
    setTimeout(() => endThreadTitleRegeneration(threadId), THREAD_TITLE_REGENERATION_TIMEOUT_MS),
  );
  const next = new Set(useThreadTitleRegenerationStore.getState().regeneratingThreadIds);
  next.add(threadId);
  useThreadTitleRegenerationStore.setState({ regeneratingThreadIds: next });
}

/** For a reconnect: a settled event sent while disconnected would otherwise never clear the row. */
export function clearThreadTitleRegenerations(): void {
  for (const timeout of timeoutsByThreadId.values()) clearTimeout(timeout);
  timeoutsByThreadId.clear();
  if (useThreadTitleRegenerationStore.getState().regeneratingThreadIds.size === 0) return;
  useThreadTitleRegenerationStore.setState({ regeneratingThreadIds: new Set() });
}

function notifyTitleRegenerationFailed(description: string): void {
  toastManager.add({ type: "error", title: "Failed to regenerate title", description });
}

/** Pending starts before the dispatch, so a settled event that beats the response is not missed. */
export async function runThreadTitleRegeneration(
  threadId: ThreadId,
  dispatch: () => Promise<unknown>,
  notifyError: (description: string) => void = notifyTitleRegenerationFailed,
): Promise<void> {
  if (isThreadTitleRegenerating(threadId)) return;
  beginThreadTitleRegeneration(threadId);
  try {
    await dispatch();
  } catch (error) {
    endThreadTitleRegeneration(threadId);
    notifyError(error instanceof Error ? error.message : "An error occurred.");
  }
}

export function applyThreadTitleRegenerationEvents(
  events: ReadonlyArray<OrchestrationEvent>,
  notifyError: (description: string) => void = notifyTitleRegenerationFailed,
): void {
  for (const event of events) {
    if (event.type === "thread.deleted") {
      endThreadTitleRegeneration(event.payload.threadId);
    } else if (event.type === "thread.title-regeneration-settled") {
      const wasPending = endThreadTitleRegeneration(event.payload.threadId);
      if (wasPending && event.payload.outcome === "failed") {
        notifyError(event.payload.detail ?? "An error occurred.");
      }
    }
  }
}
