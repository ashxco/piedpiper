import { create } from "zustand";

/** Files remain tied to the requested chat while navigation mounts its composer. */
export const usePendingThreadFiles = create<{ byThread: ReadonlyMap<string, File[]> }>(() => ({
  byThread: new Map(),
}));

export function enqueueThreadFiles(threadId: string, files: File[]) {
  if (files.length === 0) return;
  usePendingThreadFiles.setState(({ byThread }) => {
    const next = new Map(byThread);
    next.set(threadId, [...(next.get(threadId) ?? []), ...files]);
    return { byThread: next };
  });
}
export function takeThreadFiles(threadId: string): File[] {
  const files = usePendingThreadFiles.getState().byThread.get(threadId) ?? [];
  if (files.length)
    usePendingThreadFiles.setState(({ byThread }) => {
      const next = new Map(byThread);
      next.delete(threadId);
      return { byThread: next };
    });
  return files;
}
