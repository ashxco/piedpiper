import { afterEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({
  getLocalStorageItem: vi.fn<(key: string) => unknown>(() => null),
  setLocalStorageItem: vi.fn<(key: string, value: unknown) => void>(),
}));

vi.mock("./hooks/useLocalStorage", () => ({
  getLocalStorageItem: storage.getLocalStorageItem,
  setLocalStorageItem: storage.setLocalStorageItem,
  useLocalStorage: vi.fn(),
}));

import { resolveAndPersistPreferredEditor } from "./editorPreferences";

afterEach(() => {
  vi.restoreAllMocks();
  storage.getLocalStorageItem.mockReset().mockReturnValue(null);
  storage.setLocalStorageItem.mockReset();
});

describe("resolveAndPersistPreferredEditor", () => {
  it("returns the stored editor while it is still available", () => {
    storage.getLocalStorageItem.mockReturnValue("cursor");
    expect(resolveAndPersistPreferredEditor(["vscode", "cursor"])).toBe("cursor");
    expect(storage.setLocalStorageItem).not.toHaveBeenCalled();
  });

  it.each(["read", "write"] as const)(
    "still picks an available editor when its preference %s fails",
    (operation) => {
      const preference =
        operation === "read" ? storage.getLocalStorageItem : storage.setLocalStorageItem;
      preference.mockImplementationOnce(() => {
        throw new Error("Preference storage unavailable");
      });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      expect(resolveAndPersistPreferredEditor(["vscode"])).toBe("vscode");
      expect(warn).toHaveBeenCalledOnce();
    },
  );
});
