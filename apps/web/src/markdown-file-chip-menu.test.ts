import { describe, expect, it } from "vitest";

import {
  fileChipClipboardPath,
  fileChipMenuItems,
  fileManagerRevealLabel,
} from "./markdown-file-chip-menu";
import { resolveMarkdownFileChipMeta } from "./markdown-file-chip";

describe("fileChipMenuItems", () => {
  it("offers reveal only when the file manager is available", () => {
    expect(
      fileChipMenuItems({
        canCopyRelative: true,
        availableEditors: ["vscode"],
        platform: "MacIntel",
      }),
    ).toEqual([
      { id: "open", label: "Open in editor" },
      { id: "copy-relative", label: "Copy relative path" },
      { id: "copy-full", label: "Copy full path" },
    ]);
    expect(
      fileChipMenuItems({
        canCopyRelative: false,
        availableEditors: ["vscode", "file-manager"],
        platform: "MacIntel",
      }).map((item) => item.id),
    ).toEqual(["open", "reveal", "copy-full"]);
  });

  it("names the file manager by platform", () => {
    expect(fileManagerRevealLabel("MacIntel")).toBe("Reveal in Finder");
    expect(fileManagerRevealLabel("Win32")).toBe("Reveal in File Explorer");
    expect(fileManagerRevealLabel("Linux x86_64")).toBe("Reveal in Files");
  });
});

describe("fileChipClipboardPath", () => {
  it.each([
    {
      name: "a Windows drive path, keeping the position",
      href: "C:/repo/reports/Device Users.csv:12:3",
      cwd: "C:/repo",
      full: String.raw`C:\repo\reports\Device Users.csv:12:3`,
      relative: String.raw`reports\Device Users.csv:12:3`,
    },
    {
      name: "a relative link in a Windows workspace",
      href: "reports/report.csv",
      cwd: "C:/repo",
      full: String.raw`C:\repo\reports\report.csv`,
      relative: String.raw`reports\report.csv`,
    },
    {
      name: "a UNC path",
      href: String.raw`\\server\share\repo/reports/report.csv`,
      cwd: String.raw`\\server\share\repo`,
      full: String.raw`\\server\share\repo\reports\report.csv`,
      relative: String.raw`reports\report.csv`,
    },
    {
      name: "a file URL on the project's share",
      href: "file://server/share/repo/reports/report.csv",
      cwd: String.raw`\\server\share\repo`,
      full: String.raw`\\server\share\repo\reports\report.csv`,
      relative: String.raw`reports\report.csv`,
    },
    {
      name: "a file URL on a project share with forward slashes",
      href: "file://server/share/repo/reports/report.csv",
      cwd: "//server/share/repo",
      full: String.raw`\\server\share\repo\reports\report.csv`,
      relative: String.raw`reports\report.csv`,
    },
    {
      name: "a relative link in a forward-slash UNC workspace",
      href: "reports/report.csv",
      cwd: "//server/share/repo",
      full: String.raw`\\server\share\repo\reports\report.csv`,
      relative: String.raw`reports\report.csv`,
    },
    {
      name: "a POSIX path",
      href: "/home/repo/reports/report.csv:7",
      cwd: "/home/repo",
      full: "/home/repo/reports/report.csv:7",
      relative: "reports/report.csv:7",
    },
  ])("copies $name", ({ href, cwd, full, relative }) => {
    const target = resolveMarkdownFileChipMeta(href, cwd)?.targetPath;
    if (!target) throw new Error("Expected a file chip target.");
    expect(fileChipClipboardPath(target, "full", cwd)).toBe(full);
    expect(fileChipClipboardPath(target, "relative", cwd)).toBe(relative);
  });

  it("copies the full path for a relative copy without a workspace", () => {
    expect(fileChipClipboardPath("C:/repo/a.ts", "relative", undefined)).toBe(
      String.raw`C:\repo\a.ts`,
    );
  });
});
