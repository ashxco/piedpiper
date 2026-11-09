import { FolderClosedIcon } from "lucide-react";
import { describe, expect, it, vi } from "vitest";

import { VisualStudioCode } from "../Icons";
import {
  getOpenInIconClass,
  openFavoriteEditorFromShortcut,
  openInEditorWithErrorToast,
  resolveOpenInOptions,
  runOpenFavoriteEditorShortcut,
} from "./OpenInPicker";
import { PyCharmIcon, VSCodium, VisualStudioCodeInsiders } from "./OpenInPickerEditorIcons";
import { FileExplorerIcon, FinderIcon } from "./OpenInPickerIcons";

const announce = vi.hoisted(() => vi.fn());
vi.mock("../../lib/announce", () => ({ announce }));
const toastAdd = vi.hoisted(() => vi.fn());
vi.mock("../ui/toast", () => ({ toastManager: { add: toastAdd } }));

describe("resolveOpenInOptions", () => {
  it.each([
    ["MacIntel", "Finder", FinderIcon],
    ["Win32", "File Explorer", FileExplorerIcon],
    ["Linux x86_64", "Files", FolderClosedIcon],
  ] as const)("includes the file manager with its icon on %s", (platform, label, Icon) => {
    expect(resolveOpenInOptions(platform, ["cursor", "vscode", "file-manager"])).toEqual([
      expect.objectContaining({ value: "cursor", label: "Cursor" }),
      expect.objectContaining({ value: "vscode", label: "VS Code" }),
      expect.objectContaining({ value: "file-manager", label, Icon }),
    ]);
  });

  it("omits the file manager when it is unavailable", () => {
    expect(resolveOpenInOptions("MacIntel", ["vscode"])).toEqual([
      expect.objectContaining({ value: "vscode" }),
    ]);
    expect(resolveOpenInOptions("MacIntel", [])).toEqual([]);
  });

  it("lists Kiro and the JetBrains IDEs after IntelliJ IDEA, before the file manager", () => {
    const options = resolveOpenInOptions("MacIntel", [
      "file-manager",
      "webstorm",
      "pycharm",
      "kiro",
      "idea",
    ]);
    expect(options.map((option) => option.label)).toEqual([
      "IntelliJ IDEA",
      "Kiro",
      "PyCharm",
      "WebStorm",
      "Finder",
    ]);
    expect(options.find((option) => option.value === "pycharm")?.Icon).toBe(PyCharmIcon);
  });

  it("gives VS Code, Insiders and VSCodium distinct icons", () => {
    const icons = resolveOpenInOptions("MacIntel", ["vscode", "vscode-insiders", "vscodium"]).map(
      (option) => option.Icon,
    );
    expect(icons).toEqual([VisualStudioCode, VisualStudioCodeInsiders, VSCodium]);
  });
});

describe("open-in icon kinds", () => {
  it("treats every editor as a brand", () => {
    const options = resolveOpenInOptions("Linux x86_64", ["cursor", "zed", "webstorm"]);
    expect(options.map((option) => option.kind)).toEqual(["brand", "brand", "brand"]);
  });

  it.each([
    ["MacIntel", "brand"],
    ["Win32", "brand"],
    ["Linux x86_64", "generic"],
  ] as const)("gives the file manager on %s the %s kind", (platform, kind) => {
    expect(resolveOpenInOptions(platform, ["file-manager"])).toEqual([
      expect.objectContaining({ kind }),
    ]);
  });

  it("opts only brand logos out of the dimming", () => {
    expect(getOpenInIconClass("brand")).toContain("opacity-100");
    expect(getOpenInIconClass("generic")).toBe("text-muted-foreground");
  });
});

describe("openInEditorWithErrorToast", () => {
  it("shows one toast naming the chosen editor on rejection and never announces", async () => {
    announce.mockClear();
    toastAdd.mockClear();
    const opened = await openInEditorWithErrorToast(
      () => Promise.reject(new Error("Editor command not found: zed")),
      "/repo",
      "zed",
      "Zed",
    );
    expect(opened).toBe(false);
    expect(toastAdd).toHaveBeenCalledTimes(1);
    expect(toastAdd).toHaveBeenCalledWith({
      type: "error",
      title: "Could not open in Zed",
      description: "Editor command not found: zed",
    });
    expect(announce).not.toHaveBeenCalled();
  });

  it("stays quiet on success, leaving the announcement to the shortcut path", async () => {
    announce.mockClear();
    toastAdd.mockClear();
    await expect(
      openInEditorWithErrorToast(() => Promise.resolve(), "/repo", "zed", "Zed"),
    ).resolves.toBe(true);
    expect(toastAdd).not.toHaveBeenCalled();
    expect(announce).not.toHaveBeenCalled();
  });
});

describe("runOpenFavoriteEditorShortcut", () => {
  const keydown = (repeat: boolean) => ({ repeat, preventDefault: vi.fn() });

  it("opens once on a fresh press", () => {
    const event = keydown(false);
    const open = vi.fn();
    runOpenFavoriteEditorShortcut(event, open);
    expect(open).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
  });

  it("swallows a held key without opening again", () => {
    const event = keydown(true);
    const open = vi.fn();
    runOpenFavoriteEditorShortcut(event, open);
    expect(open).not.toHaveBeenCalled();
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("passes the key through while inactive (repeat: %s)", (repeat) => {
    const event = keydown(repeat);
    runOpenFavoriteEditorShortcut(event, null);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});

describe("openFavoriteEditorFromShortcut", () => {
  it("announces the editor once it opens", async () => {
    announce.mockClear();
    const openInEditor = vi.fn(() => Promise.resolve());
    await openFavoriteEditorFromShortcut(openInEditor, "/repo", "zed", "Zed");
    expect(openInEditor).toHaveBeenCalledWith("/repo", "zed");
    expect(announce).toHaveBeenCalledWith("Opened in Zed", "open-in-editor");
  });

  it("shows an error toast instead of announcing when opening fails", async () => {
    announce.mockClear();
    toastAdd.mockClear();
    await openFavoriteEditorFromShortcut(
      () => Promise.reject(new Error("nope")),
      "/repo",
      "zed",
      "Zed",
    );
    expect(announce).not.toHaveBeenCalled();
    expect(toastAdd).toHaveBeenCalledWith({
      type: "error",
      title: "Could not open in Zed",
      description: "nope",
    });
  });
});
