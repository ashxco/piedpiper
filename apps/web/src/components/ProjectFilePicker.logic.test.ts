import type { KeybindingCommand, ResolvedKeybindingsConfig } from "@piedpiper/contracts";
import { describe, expect, it } from "vitest";

import {
  FILE_PICKER_RESULT_LIMIT,
  filePickerEntries,
  filePickerEntryLabels,
  isFilePickerResultStale,
  joinWorkspaceFilePath,
  normalizeFilePickerQuery,
  resolveFilePickerShortcut,
} from "./ProjectFilePicker.logic";

const notTerminal = { type: "not", node: { type: "identifier", name: "terminalFocus" } } as const;
const binding = (key: string, command: KeybindingCommand) => ({
  command,
  shortcut: { key, metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, modKey: false },
  whenAst: notTerminal,
});
const KEYBINDINGS: ResolvedKeybindingsConfig = [
  binding("k", "commandPalette.toggle"),
  binding("p", "filePicker.toggle"),
];
const OUTSIDE_TERMINAL = { terminalFocus: false, terminalOpen: false, platform: "MacIntel" };

describe("isFilePickerResultStale", () => {
  const settled = { normalizedQuery: "readme", searchQuery: "readme", isPlaceholderData: false };

  it("accepts rows that belong to the typed query", () => {
    expect(isFilePickerResultStale(settled)).toBe(false);
  });

  it("flags rows while the debounce lags or the new query is still fetching", () => {
    expect(isFilePickerResultStale({ ...settled, searchQuery: "rea" })).toBe(true);
    expect(isFilePickerResultStale({ ...settled, isPlaceholderData: true })).toBe(true);
  });
});

const keydown = (key: string, extra: object = {}) => ({
  key,
  metaKey: true,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...extra,
});

describe("resolveFilePickerShortcut", () => {
  it("toggles on the chord and swallows auto-repeat", () => {
    expect(resolveFilePickerShortcut(keydown("p"), KEYBINDINGS, OUTSIDE_TERMINAL)).toBe("toggle");
    expect(
      resolveFilePickerShortcut(keydown("p", { repeat: true }), KEYBINDINGS, OUTSIDE_TERMINAL),
    ).toBe("swallow");
  });

  it("leaves the chord alone in the terminal, or when already handled", () => {
    expect(
      resolveFilePickerShortcut(keydown("p"), KEYBINDINGS, {
        ...OUTSIDE_TERMINAL,
        terminalFocus: true,
      }),
    ).toBeNull();
    expect(
      resolveFilePickerShortcut(
        keydown("p", { defaultPrevented: true }),
        KEYBINDINGS,
        OUTSIDE_TERMINAL,
      ),
    ).toBeNull();
    expect(resolveFilePickerShortcut(keydown("x"), KEYBINDINGS, OUTSIDE_TERMINAL)).toBeNull();
  });

  it("does not fire while a keybinding is being recorded", () => {
    const target = { closest: () => ({}) } as unknown as EventTarget;
    expect(resolveFilePickerShortcut(keydown("p", { target }), KEYBINDINGS, OUTSIDE_TERMINAL)).toBe(
      null,
    );
  });

  it("yields to the command palette even if its listener already claimed the event", () => {
    expect(
      resolveFilePickerShortcut(
        keydown("k", { defaultPrevented: true }),
        KEYBINDINGS,
        OUTSIDE_TERMINAL,
      ),
    ).toBe("yield-to-palette");
  });
});

describe("filePickerEntries", () => {
  it("drops directories and keeps the server's order", () => {
    expect(
      filePickerEntries([
        { path: "src", kind: "directory" },
        { path: "src/z.ts", kind: "file", parentPath: "src" },
        { path: "a.ts", kind: "file" },
      ]).map((entry) => entry.path),
    ).toEqual(["src/z.ts", "a.ts"]);
  });

  it("caps the rows", () => {
    const entries = Array.from({ length: FILE_PICKER_RESULT_LIMIT + 5 }, (_, index) => ({
      path: `f${index}.ts`,
      kind: "file" as const,
    }));
    expect(filePickerEntries(entries)).toHaveLength(FILE_PICKER_RESULT_LIMIT);
  });
});

describe("normalizeFilePickerQuery", () => {
  it("never produces what the search schema refuses", () => {
    expect(normalizeFilePickerQuery("   ")).toBe("");
    expect(normalizeFilePickerQuery("  chat view ")).toBe("chat view");
    expect(normalizeFilePickerQuery("a".repeat(300))).toHaveLength(256);
    expect(normalizeFilePickerQuery(`${"a".repeat(255)} b`)).toHaveLength(255);
  });
});

describe("joinWorkspaceFilePath", () => {
  it("joins under POSIX and Windows folders", () => {
    expect(joinWorkspaceFilePath("/repo", "src/a.ts")).toBe("/repo/src/a.ts");
    expect(joinWorkspaceFilePath("/repo/", "a.ts")).toBe("/repo/a.ts");
    expect(joinWorkspaceFilePath("/", "a.ts")).toBe("/a.ts");
    expect(joinWorkspaceFilePath(String.raw`C:\repo`, "src/a.ts")).toBe(
      String.raw`C:\repo\src\a.ts`,
    );
    expect(joinWorkspaceFilePath(String.raw`C:\repo\ `.trim(), "a.ts")).toBe(
      String.raw`C:\repo\a.ts`,
    );
  });
});

describe("filePickerEntryLabels", () => {
  it("splits the name from its folder", () => {
    expect(filePickerEntryLabels("a.ts")).toEqual({ name: "a.ts" });
    expect(filePickerEntryLabels("src/lib/a.ts")).toEqual({ name: "a.ts", directory: "src/lib" });
  });
});
