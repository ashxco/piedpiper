import { describe, expect, it, vi } from "vitest";

import { copyWorkspacePath, formatFilePathForClipboard } from "./filePathClipboard";

describe("formatFilePathForClipboard", () => {
  it.each([
    ["a drive path", "C:/repo/a.ts", String.raw`C:\repo\a.ts`],
    ["a mixed drive path", String.raw`C:\repo/src/a.ts`, String.raw`C:\repo\src\a.ts`],
    ["a UNC path", String.raw`\\server\share/a.ts`, String.raw`\\server\share\a.ts`],
    ["a forward-slash UNC path", "//server/share/a.ts", String.raw`\\server\share\a.ts`],
    ["a POSIX path", "/home/repo/a.ts", "/home/repo/a.ts"],
    ["a POSIX root path with extra slashes", "///repo/a.ts", "///repo/a.ts"],
    ["a position suffix", "C:/repo/a.ts:12:3", String.raw`C:\repo\a.ts:12:3`],
    ["a POSIX path with a backslash in a name", String.raw`/repo/a\b.ts`, String.raw`/repo/a\b.ts`],
  ])("formats %s", (_, path, expected) => {
    expect(formatFilePathForClipboard(path)).toBe(expected);
  });

  it("uses the host path to style a relative path", () => {
    expect(formatFilePathForClipboard("src/a.ts", "C:/repo/src/a.ts")).toBe(String.raw`src\a.ts`);
    expect(formatFilePathForClipboard("src/a.ts", "//server/share/src/a.ts")).toBe(
      String.raw`src\a.ts`,
    );
    expect(formatFilePathForClipboard("src/a.ts", "/repo/src/a.ts")).toBe("src/a.ts");
  });
});

describe("copyWorkspacePath", () => {
  it.each([
    ["a Windows workspace", "C:/repo/app", String.raw`C:\repo\app`],
    ["a forward-slash UNC workspace", "//server/share/repo", String.raw`\\server\share\repo`],
    ["a POSIX workspace", "/home/repo", "/home/repo"],
  ])("gives the clipboard and the toast the same text for %s", (_, workspacePath, expected) => {
    const copy = vi.fn();
    copyWorkspacePath(workspacePath, copy);
    expect(copy).toHaveBeenCalledExactlyOnceWith(expected, { path: expected });
  });
});
