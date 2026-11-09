import { create } from "zustand";

import { isCommandPaletteOpen } from "./commandPaletteStore";

interface FilePickerStore {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggleOpen: () => void;
}

export const useFilePickerStore = create<FilePickerStore>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  toggleOpen: () => set((state) => ({ open: !state.open })),
}));

export function isFilePickerOpen(): boolean {
  return useFilePickerStore.getState().open;
}

/** For window key listeners whose shortcuts stand down while a modal command surface is open. */
export function isCommandSurfaceOpen(): boolean {
  return isCommandPaletteOpen() || isFilePickerOpen();
}
