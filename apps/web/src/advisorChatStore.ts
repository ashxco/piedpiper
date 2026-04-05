import { type ThreadId } from "@piedpiper/contracts";
import { create } from "zustand";

/**
 * Per-character → server-thread map for the office floating advisor card.
 *
 * Lives outside `OfficeMode`'s local state so the user can navigate away from
 * the virtual office and come back without losing the resume-on-revisit
 * behaviour. Not persisted to localStorage — the underlying threads live in
 * SQLite already, this map is just an in-memory pointer cache for "which
 * thread did this character last use during this session?". Cleared on hard
 * reload, which is fine: clicking an NPC after reload simply starts a fresh
 * conversation, and the existing chats are still reachable through the
 * advisors page or the advisor history panel.
 *
 * Subscribers should select narrowly (`state.byCharacter[id]`) so unrelated
 * map mutations don't trigger re-renders.
 */
interface AdvisorChatStore {
  readonly byCharacter: Readonly<Record<string, ThreadId>>;
  readonly setThreadId: (characterId: string, threadId: ThreadId) => void;
  readonly clear: () => void;
}

export const useAdvisorChatStore = create<AdvisorChatStore>((set) => ({
  byCharacter: {},
  setThreadId: (characterId, threadId) =>
    set((state) =>
      state.byCharacter[characterId] === threadId
        ? state
        : { byCharacter: { ...state.byCharacter, [characterId]: threadId } },
    ),
  clear: () => set({ byCharacter: {} }),
}));

/** Read the persisted thread id for a character (or `null` if none). */
export function useAdvisorThreadIdForCharacter(characterId: string | null): ThreadId | null {
  return useAdvisorChatStore((state) =>
    characterId ? (state.byCharacter[characterId] ?? null) : null,
  );
}
