import { create } from "zustand";

interface CommandPaletteStore {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggleOpen: () => void;
}

export const useCommandPaletteStore = create<CommandPaletteStore>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  toggleOpen: () => set((state) => ({ open: !state.open })),
}));

/** For window key listeners whose shortcuts stand down while the palette has the keyboard. */
export function isCommandPaletteOpen(): boolean {
  return useCommandPaletteStore.getState().open;
}
