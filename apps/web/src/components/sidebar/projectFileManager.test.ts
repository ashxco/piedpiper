import { afterEach, describe, expect, it, vi } from "vitest";

import { __resetNativeApiForTests } from "../../nativeApi";
import { toastManager } from "../ui/toast";
import {
  fileManagerOpenLabel,
  hasFileManager,
  openProjectInFileManager,
} from "./projectFileManager";

function stubNativeApi(openInEditor: (path: string, editor: string) => Promise<void>) {
  vi.stubGlobal("window", { nativeApi: { shell: { openInEditor } } });
  __resetNativeApiForTests();
}

describe("fileManagerOpenLabel", () => {
  it.each([
    ["MacIntel", "Open in Finder"],
    ["Win32", "Open in File Explorer"],
    ["Linux x86_64", "Open in Files"],
  ])("names the file manager on %s", (platform, label) => {
    expect(fileManagerOpenLabel(platform)).toBe(label);
  });
});

describe("hasFileManager", () => {
  it("is true only when the server reports a file manager", () => {
    expect(hasFileManager(["vscode", "file-manager"])).toBe(true);
    expect(hasFileManager(["vscode"])).toBe(false);
    expect(hasFileManager([])).toBe(false);
  });
});

describe("openProjectInFileManager", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    __resetNativeApiForTests();
    vi.restoreAllMocks();
  });

  it("opens the folder without a reveal", async () => {
    const openInEditor = vi.fn(async () => undefined);
    stubNativeApi(openInEditor);

    await openProjectInFileManager("/repo");

    expect(openInEditor).toHaveBeenCalledExactlyOnceWith("/repo", "file-manager");
  });

  it("shows a toast when the folder cannot be opened", async () => {
    const addToast = vi.spyOn(toastManager, "add").mockReturnValue("toast");
    stubNativeApi(async () => {
      throw new Error("no such folder");
    });

    await expect(openProjectInFileManager("/gone")).resolves.toBeUndefined();

    expect(addToast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        title: "Unable to open project folder",
        description: "no such folder",
      }),
    );
  });
});
