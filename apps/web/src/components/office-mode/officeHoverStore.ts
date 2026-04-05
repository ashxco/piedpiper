import { create } from "zustand";
import type { ThreadId } from "@piedpiper/contracts";

interface OfficeHoverState {
  hoveredThreadId: ThreadId | null;
  setHoveredThreadId: (id: ThreadId | null) => void;
}

export const useOfficeHoverStore = create<OfficeHoverState>((set) => ({
  hoveredThreadId: null,
  setHoveredThreadId: (id) => set({ hoveredThreadId: id }),
}));
