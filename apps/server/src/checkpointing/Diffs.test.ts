import { describe, expect, it } from "vitest";

import { isGitImport, parseTurnDiffFilesFromNumstat } from "./Diffs.ts";

describe("parseTurnDiffFilesFromNumstat", () => {
  it("returns empty list for empty output", () => {
    expect(parseTurnDiffFilesFromNumstat("")).toEqual([]);
  });

  it("parses per-file additions and deletions sorted by path", () => {
    const numstat = ["0\t2\tsrc/b.ts", "2\t1\ta.txt", ""].join("\0");

    expect(parseTurnDiffFilesFromNumstat(numstat)).toEqual([
      { path: "a.txt", additions: 2, deletions: 1 },
      { path: "src/b.ts", additions: 0, deletions: 2 },
    ]);
  });

  it("reports binary files with zero line counts", () => {
    expect(parseTurnDiffFilesFromNumstat("-\t-\timage.png\0")).toEqual([
      { path: "image.png", additions: 0, deletions: 0 },
    ]);
  });

  it("keeps both paths for rename records", () => {
    const numstat = ["0\t0\t", "src/old.ts", "src/new.ts", "1\t0\tother.ts", ""].join("\0");

    expect(parseTurnDiffFilesFromNumstat(numstat)).toEqual([
      { path: "other.ts", additions: 1, deletions: 0 },
      { path: "src/new.ts", previousPath: "src/old.ts", additions: 0, deletions: 0 },
    ]);
  });

  it("keeps paths containing tabs, newlines and spaces verbatim", () => {
    expect(parseTurnDiffFilesFromNumstat("3\t0\tdir with space/we\tird\nname.txt\0")).toEqual([
      { path: "dir with space/we\tird\nname.txt", additions: 3, deletions: 0 },
    ]);
  });
});

describe("isGitImport", () => {
  const file = { path: "a.ts", additions: 1, deletions: 0 };
  const renamed = { path: "new.ts", previousPath: "old.ts", additions: 0, deletions: 0 };

  it("keeps every file when authored paths are unknown", () => {
    expect(isGitImport(file, null)).toBe(false);
  });

  it("drops files no authored path touched", () => {
    expect(isGitImport(file, new Set(["b.ts"]))).toBe(true);
    expect(isGitImport(file, new Set(["a.ts"]))).toBe(false);
  });

  it("keeps a rename when either side was authored", () => {
    expect(isGitImport(renamed, new Set(["old.ts"]))).toBe(false);
    expect(isGitImport(renamed, new Set(["new.ts"]))).toBe(false);
    expect(isGitImport(renamed, new Set())).toBe(true);
  });
});
