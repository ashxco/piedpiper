import { describe, expect, it } from "vitest";

import {
  isHostPath,
  isWindowsAbsolutePath,
  normalizeWorktreePathForComparison,
  resolvePastedPath,
  toStoredProjectFaviconPath,
  unquotePastedPath,
} from "./path";

describe("host path checks", () => {
  it.each([
    ["/Users/me", true],
    ["~/code", true],
    ["C:\\Users\\me", true],
    ["c:/code", true],
    ["\\\\host\\share", true],
    ["code/app", false],
    ["~code", false],
    ["", false],
  ])("isHostPath(%s) is %s", (value, expected) => {
    expect(isHostPath(value)).toBe(expected);
  });

  it("recognises Windows absolute paths", () => {
    expect(isWindowsAbsolutePath("D:\\a")).toBe(true);
    expect(isWindowsAbsolutePath("/a")).toBe(false);
  });
});

describe("resolvePastedPath", () => {
  it.each([
    ["Finder, a space", "", "'/Users/me/Monarch Money'", "/Users/me/Monarch Money"],
    ["Finder, an apostrophe", "", "/Users/me/Bob\\'s\\ Stuff", "/Users/me/Bob's Stuff"],
    ["Finder, a backslash", "", "/Users/me/a\\\\\\ b", "/Users/me/a\\ b"],
    ["Explorer, a drive", "", '"C:\\Users\\me\\My Code"', "C:\\Users\\me\\My Code"],
    ["Explorer, a share", "", '"\\\\host\\share\\My Code"', "\\\\host\\share\\My Code"],
    ["an apostrophe in double quotes", "", '"/Users/me/Bob\'s Stuff"', "/Users/me/Bob's Stuff"],
    ["a shell, home-relative", "", "~/Bob\\'s\\ Stuff", "~/Bob's Stuff"],
    ["surrounding whitespace", "", "  '/Users/me/My Code'\n", "/Users/me/My Code"],
    ["over a selection", "/Users/me/old", "'/Users/me/My Code'", "/Users/me/My Code"],
    ["after a prefilled folder", "~/", "~/'/Users/me/My Code'", "/Users/me/My Code"],
    ["plain, after a prefilled folder", "~/", "~//Users/me/code", "/Users/me/code"],
    ["after a Windows folder", "C:\\Users\\", 'C:\\Users\\"D:\\My Code"', "D:\\My Code"],
    ["a shell's quoted apostrophe", "", "'/Users/me/Bob'\\''s Work'", "/Users/me/Bob's Work"],
    ["over part of the box", "~/code/old", "~/code/'/a b'", "/a b"],
    ["after a clone destination", "~/code/", "~/code/'/Users/me/My Repo'", "/Users/me/My Repo"],
    ["a quote inside the quotes", "", "'/Users/me/it'\\''s here'", "/Users/me/it's here"],
  ])("reads the path copied from %s", (_source, previous, next, expected) => {
    expect(resolvePastedPath(previous, next)).toBe(expected);
  });

  it.each([
    ["typing a separator", "/Users/me", "/Users/me/"],
    ["typing a trailing space", "/Users/My", "/Users/My "],
    ["deleting", "/Users/me/", "/Users/me"],
    ["pasting a relative folder", "~/", "~/Documents/code"],
    ["a longer path over a selection", "/Users/me", "/Users/me/code"],
    ["quoted text that is no path", "", "'hello world'"],
    ["a quoted relative path", "", "'code/my app'"],
    ["a search ending in a quoted path", "", "find '/tmp/repo'"],
    ["a quote left open", "", "'/Users/me/My Code"],
    ["Windows separators", "", "C:\\Users\\me\\code"],
    ["a Windows dot folder", "", "C:\\Users\\me\\.config"],
    ["a share", "", "\\\\host\\share\\code"],
    ["a backslash before a letter", "", "/Users/me/a\\b"],
    ["apostrophes around a folder name", "", "~/'My Code'"],
    ["typing a separator after a folder", "~/code", "~/code/"],
    ["a longer path typed after a folder", "/Users/me", "/Users/me/code/app"],
    ["a Windows dot folder below home", "C:\\Users\\me\\", "C:\\Users\\me\\.vscode"],
    ["a typed ~/code\\.vscode", "", "~/code\\.vscode"],
  ])("keeps %s", (_case, previous, next) => {
    expect(resolvePastedPath(previous, next)).toBe(next);
  });

  it.each(["/Users/me/a\\ b", "'/Users/me/My Code'"])(
    "leaves %s typed one character at a time",
    (typed) => {
      const box = [...typed].reduce((text, char) => resolvePastedPath(text, text + char), "");
      expect(box).toBe(typed);
    },
  );
});

describe("unquotePastedPath", () => {
  it("unquotes and unescapes a whole path and trims it", () => {
    expect(unquotePastedPath("  '/Users/me/My Code'  ")).toBe("/Users/me/My Code");
    expect(unquotePastedPath("/Users/me/My\\ Code")).toBe("/Users/me/My Code");
    expect(unquotePastedPath(' "C:\\My Code" ')).toBe("C:\\My Code");
    expect(unquotePastedPath(" /Users/me/code ")).toBe("/Users/me/code");
  });
});

describe("normalizeWorktreePathForComparison", () => {
  it.each([
    ["/a/b/", "/a/b"],
    ["  /a/b  ", "/a/b"],
    ["/", "/"],
    ["C:/Repo/", "c:\\repo"],
    ["C:\\Repo\\", "c:\\repo"],
    ["C:\\", "c:\\"],
    ["C:/", "c:\\"],
    ["C:\\\\", "c:\\"],
    ["//server/share/", "\\\\server\\share"],
    ["\\\\Server\\Share\\", "\\\\server\\share"],
  ])("reads %s as %s", (value, expected) => {
    expect(normalizeWorktreePathForComparison(value)).toBe(expected);
  });

  it("keeps the case of POSIX paths", () => {
    expect(normalizeWorktreePathForComparison("/A")).toBe("/A");
    expect(normalizeWorktreePathForComparison("/A")).not.toBe(
      normalizeWorktreePathForComparison("/a"),
    );
  });

  it("leaves backslashes in POSIX paths alone", () => {
    expect(normalizeWorktreePathForComparison("/a/b\\")).toBe("/a/b\\");
  });
});

describe("toStoredProjectFaviconPath", () => {
  it.each([
    ["/repo", "/repo/brand/logo.png", "brand/logo.png"],
    ["/repo/", "/repo/logo.png", "logo.png"],
    ["/", "/logo.png", "logo.png"],
    ["C:\\Repo", "c:\\repo\\brand\\logo.png", "brand/logo.png"],
    ["C:/Repo", "C:\\Repo\\logo.png", "logo.png"],
  ])("stores %s + %s as relative", (root, picked, expected) => {
    expect(toStoredProjectFaviconPath(root, picked)).toBe(expected);
  });

  it.each([
    ["/repo", "/repo-other/logo.png"],
    ["/repo", "/pictures/logo.png"],
    ["/repo", "/repo/../pictures/logo.png"],
    ["/Repo", "/repo/logo.png"],
    ["C:\\Repo", "D:\\Repo\\logo.png"],
  ])("keeps %s + %s absolute", (root, picked) => {
    expect(toStoredProjectFaviconPath(root, picked)).toBe(picked);
  });
});
