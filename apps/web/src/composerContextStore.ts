import { create } from "zustand";

/** Next-turn context is kept per chat, including when its view unmounts. */
export const useComposerContextStore = create<{
  freshContextThreads: ReadonlySet<string>;
  setFreshContext: (threadId: string, fresh: boolean) => void;
}>((set) => ({
  freshContextThreads: new Set(),
  setFreshContext: (threadId, fresh) =>
    set((state) => {
      const next = new Set(state.freshContextThreads);
      if (fresh) next.add(threadId);
      else next.delete(threadId);
      return { freshContextThreads: next };
    }),
}));
