import { afterEach, describe, expect, it } from "vitest";

import { useCommandPaletteStore } from "./commandPaletteStore";
import { isCommandSurfaceOpen, isFilePickerOpen, useFilePickerStore } from "./filePickerStore";

afterEach(() => {
  useFilePickerStore.getState().setOpen(false);
  useCommandPaletteStore.getState().setOpen(false);
});

describe("isCommandSurfaceOpen", () => {
  it("is false until the palette or the picker opens", () => {
    expect(isCommandSurfaceOpen()).toBe(false);

    useFilePickerStore.getState().toggleOpen();
    expect(isFilePickerOpen()).toBe(true);
    expect(isCommandSurfaceOpen()).toBe(true);

    useFilePickerStore.getState().toggleOpen();
    expect(isFilePickerOpen()).toBe(false);
    expect(isCommandSurfaceOpen()).toBe(false);

    useCommandPaletteStore.getState().setOpen(true);
    expect(isCommandSurfaceOpen()).toBe(true);
  });
});
