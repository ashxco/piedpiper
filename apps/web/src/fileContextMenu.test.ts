import { beforeEach, describe, expect, it, vi } from "vitest";

const { addToast, getServerConfig, writeTextToClipboard } = vi.hoisted(() => ({
  addToast: vi.fn(),
  getServerConfig: vi.fn((): { availableEditors: string[] } | null => null),
  writeTextToClipboard: vi.fn(async (_value: string) => undefined),
}));

vi.mock("./components/ui/toast", () => ({ toastManager: { add: addToast } }));
vi.mock("./rpc/serverState", () => ({ getServerConfig }));
vi.mock("./hooks/useCopyToClipboard", () => ({ writeTextToClipboard }));

import {
  buildFileContextMenuItems,
  parseFileContextMenuAction,
  showFileContextMenu,
} from "./fileContextMenu";

describe("buildFileContextMenuItems", () => {
  it("lists detected editors flat, then the default app, reveal, then copy path", () => {
    expect(buildFileContextMenuItems(["file-manager", "zed", "vscode"], "MacIntel")).toEqual([
      { id: "open-in:vscode", label: "Open in VS Code" },
      { id: "open-in:zed", label: "Open in Zed" },
      { id: "open-in:file-manager", label: "Open with default app" },
      { id: "reveal", label: "Reveal in Finder" },
      { id: "copy-path", label: "Copy path" },
    ]);
  });

  it("labels reveal for the platform's file manager", () => {
    expect(buildFileContextMenuItems(["file-manager"], "Win32")).toContainEqual({
      id: "reveal",
      label: "Reveal in File Explorer",
    });
    expect(buildFileContextMenuItems(["file-manager"], "Linux x86_64")).toContainEqual({
      id: "reveal",
      label: "Reveal in Files",
    });
  });

  it("still offers copy path when no editor is available", () => {
    expect(buildFileContextMenuItems([])).toEqual([{ id: "copy-path", label: "Copy path" }]);
  });
});

describe("parseFileContextMenuAction", () => {
  it("parses editor and copy actions and rejects unknown ids", () => {
    expect(parseFileContextMenuAction("open-in:zed")).toEqual({ kind: "open", editor: "zed" });
    expect(parseFileContextMenuAction("copy-path")).toEqual({ kind: "copy-path" });
    expect(parseFileContextMenuAction("reveal")).toEqual({ kind: "reveal" });
    expect(parseFileContextMenuAction("open-in:notepad")).toBeNull();
    expect(parseFileContextMenuAction(null)).toBeNull();
  });
});

describe("showFileContextMenu", () => {
  beforeEach(() => {
    addToast.mockClear();
    getServerConfig.mockReset();
    getServerConfig.mockReturnValue(null);
    writeTextToClipboard.mockReset();
    writeTextToClipboard.mockResolvedValue(undefined);
  });

  function makeApi(choice: string | null, openInEditor = vi.fn(async () => undefined)) {
    const getConfig = vi.fn(async () => ({ availableEditors: ["vscode", "file-manager"] }));
    const api = {
      server: { getConfig },
      contextMenu: { show: async () => choice },
      shell: { openInEditor },
    } as unknown as Parameters<typeof showFileContextMenu>[0]["api"];
    return { api, getConfig, openInEditor };
  }

  it("reports a failed copy with the text the clipboard write used", async () => {
    const { api } = makeApi("copy-path");
    writeTextToClipboard.mockRejectedValueOnce(new Error("denied"));
    await expect(
      showFileContextMenu({ api, targetPath: "C:/repo/a.ts", position: { x: 1, y: 2 } }),
    ).rejects.toThrow("denied");
    expect(addToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", description: "C:\\repo\\a.ts" }),
    );
  });

  it("copies the path", async () => {
    const { api } = makeApi("copy-path");
    await showFileContextMenu({ api, targetPath: "/repo/src/a.ts", position: { x: 1, y: 2 } });
    expect(writeTextToClipboard).toHaveBeenCalledWith("/repo/src/a.ts");
  });

  it("copies a Windows path with backslashes but opens it unchanged", async () => {
    const { api, openInEditor } = makeApi("copy-path");
    await showFileContextMenu({ api, targetPath: "C:/repo/a.ts", position: { x: 1, y: 2 } });
    expect(writeTextToClipboard).toHaveBeenCalledWith("C:\\repo\\a.ts");

    const reveal = makeApi("reveal");
    await showFileContextMenu({
      api: reveal.api,
      targetPath: "C:/repo/a.ts",
      position: { x: 1, y: 2 },
    });
    expect(reveal.openInEditor).toHaveBeenCalledWith("C:/repo/a.ts", "file-manager", {
      reveal: true,
    });
    expect(openInEditor).not.toHaveBeenCalled();
  });

  it("reveals the file in the file manager", async () => {
    const { api, openInEditor } = makeApi("reveal");
    await showFileContextMenu({ api, targetPath: "/repo/src/a.ts", position: { x: 1, y: 2 } });
    expect(openInEditor).toHaveBeenCalledWith("/repo/src/a.ts", "file-manager", { reveal: true });
  });

  it("uses the cached server config instead of fetching it", async () => {
    getServerConfig.mockReturnValue({ availableEditors: ["vscode"] });
    const { api, getConfig, openInEditor } = makeApi("open-in:vscode");
    await showFileContextMenu({ api, targetPath: "/repo/src/a.ts", position: { x: 1, y: 2 } });
    expect(getConfig).not.toHaveBeenCalled();
    expect(openInEditor).toHaveBeenCalledWith("/repo/src/a.ts", "vscode");
  });

  it("shows an error toast when the action fails", async () => {
    const { api } = makeApi(
      "open-in:vscode",
      vi.fn(async () => {
        throw new Error("missing editor");
      }),
    );
    await expect(
      showFileContextMenu({ api, targetPath: "/repo/src/a.ts", position: { x: 1, y: 2 } }),
    ).rejects.toThrow("missing editor");
    expect(addToast).toHaveBeenCalledWith({
      type: "error",
      title: "Could not open in VS Code",
      description: "/repo/src/a.ts",
    });
  });

  it("opens the file in the chosen editor", async () => {
    const openInEditor = vi.fn(async () => undefined);
    const api = {
      server: { getConfig: async () => ({ availableEditors: ["vscode", "file-manager"] }) },
      contextMenu: { show: async () => "open-in:file-manager" },
      shell: { openInEditor },
    } as unknown as Parameters<typeof showFileContextMenu>[0]["api"];

    await showFileContextMenu({ api, targetPath: "/repo/src/a.ts", position: { x: 1, y: 2 } });

    expect(openInEditor).toHaveBeenCalledWith("/repo/src/a.ts", "file-manager");
  });

  it("does nothing when the menu is dismissed", async () => {
    const openInEditor = vi.fn(async () => undefined);
    const api = {
      server: { getConfig: async () => ({ availableEditors: ["vscode"] }) },
      contextMenu: { show: async () => null },
      shell: { openInEditor },
    } as unknown as Parameters<typeof showFileContextMenu>[0]["api"];

    await showFileContextMenu({ api, targetPath: "/repo/src/a.ts", position: { x: 1, y: 2 } });

    expect(openInEditor).not.toHaveBeenCalled();
  });
});
