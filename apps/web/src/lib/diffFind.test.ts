import { parseDiffFromFile, parsePatchFiles } from "@pierre/diffs";
import { describe, expect, it } from "vitest";

import {
  buildDiffFindMatchKey,
  buildDiffFindPattern,
  collectDiffFindMatches,
  DIFF_FIND_SCOPE_ATTRIBUTE,
  estimateDiffFindMatchOffset,
  estimateDiffFindRowTop,
  formatDiffFindCount,
  isDiffFindChord,
  isDiffFindEvent,
  MAX_DIFF_FIND_MATCHES,
  parseDiffRowIndex,
  resolveDiffFindLineRange,
  reuseDiffFindFiles,
  wrapDiffFindIndex,
} from "./diffFind";

const PATCH = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,4 +1,5 @@",
  " const keep = 1;",
  "-const oldName = 2;",
  "+const newName = 2;",
  "+const added = oldName + oldName;",
  " const tail = 4;",
  "@@ -20,3 +21,3 @@ function x() {",
  " ctx20 name",
  "-del21 Name",
  "+add22 names",
  " ctx22",
  "diff --git a/src/b.ts b/src/b.ts",
  "--- a/src/b.ts",
  "+++ b/src/b.ts",
  "@@ -1 +1 @@",
  "-nil",
  "+: nil",
  "",
].join("\n");

const files = parsePatchFiles(PATCH)
  .flatMap((parsed) => parsed.files)
  .map((file, index) => ({ fileKey: `file-${index}`, file }));

const find = (query: string) =>
  collectDiffFindMatches(files, query).matches.map(
    ({ fileKey, side, lineNumber, occurrence }) => `${fileKey}:${side}:${lineNumber}:${occurrence}`,
  );

describe("collectDiffFindMatches", () => {
  it("finds removed and added lines in render order, with each occurrence", () => {
    expect(find("oldName")).toEqual([
      "file-0:deletions:2:0",
      "file-0:additions:3:0",
      "file-0:additions:3:1",
    ]);
    expect(find("nil")).toEqual(["file-1:deletions:1:0", "file-1:additions:1:0"]);
  });

  it("ignores case", () => {
    expect(find("NAME")).toContain("file-0:deletions:21:0");
    expect(find("name")).toContain("file-0:additions:22:0");
  });

  it("reads an unchanged line once and counts lines from each hunk's own start", () => {
    const { matches } = collectDiffFindMatches(files, "ctx");
    expect(matches.map(({ side, lineNumber, isContext }) => [side, lineNumber, isContext])).toEqual(
      [
        ["additions", 21, true],
        ["additions", 23, true],
      ],
    );
  });

  it("keeps each match's whole line", () => {
    const { matches } = collectDiffFindMatches(files, "ctx");
    expect(matches.map(({ lineText }) => lineText.trim())).toEqual(["ctx20 name", "ctx22"]);
  });

  it("treats the query as plain text", () => {
    expect(find("+ old")).toEqual(["file-0:additions:3:0"]);
    expect(find("n.me")).toEqual([]);
    expect(find("(")).toEqual([]);
    expect(buildDiffFindPattern("a.b(")?.test("a.b(")).toBe(true);
  });

  it("returns nothing for an empty query", () => {
    expect(collectDiffFindMatches(files, "")).toEqual({ matches: [], truncated: false });
    expect(buildDiffFindPattern("")).toBeNull();
  });

  it("gives rows for both layouts, past the separator between hunks", () => {
    const rowsOf = (query: string) => collectDiffFindMatches(files, query).matches[0]!;
    expect(rowsOf("newName")).toMatchObject({ unifiedRow: 2, splitRow: 1, separators: 0 });
    expect(rowsOf("const added")).toMatchObject({ unifiedRow: 3, splitRow: 2, separators: 0 });
    expect(rowsOf("ctx22")).toMatchObject({ unifiedRow: 8, splitRow: 6, separators: 1 });
  });

  it("includes the lines a full-context file shows between and after its hunks", () => {
    const lines = Array.from({ length: 30 }, (_, index) => `line ${index + 1}\n`);
    const newLines = lines.map((line, index) => (index === 14 ? "changed\n" : line));
    const file = parseDiffFromFile(
      { name: "long.ts", contents: lines.join("") },
      { name: "long.ts", contents: newLines.join("") },
    );
    expect(file.isPartial).toBe(false);
    const matchLine = (query: string) =>
      collectDiffFindMatches([{ fileKey: "f", file }], query).matches.map((match) => [
        match.side,
        match.lineNumber,
        match.unifiedRow,
      ]);
    expect(matchLine("line 2\n")).toEqual([["additions", 2, 1]]);
    expect(matchLine("line 30")).toEqual([["additions", 30, 30]]);
    expect(matchLine("changed")).toEqual([["additions", 15, 15]]);
    expect(matchLine("line 15")).toEqual([["deletions", 15, 14]]);
  });

  it("stops collecting at the cap and says so", () => {
    const manyLines = Array.from({ length: MAX_DIFF_FIND_MATCHES + 5 }, (_, index) => `+x${index}`);
    const [patch] = parsePatchFiles(
      [
        "diff --git a/big.ts b/big.ts",
        "--- /dev/null",
        "+++ b/big.ts",
        `@@ -0,0 +1,${manyLines.length} @@`,
        ...manyLines,
        "",
      ].join("\n"),
    );
    const result = collectDiffFindMatches([{ fileKey: "big", file: patch!.files[0]! }], "x");
    expect(result.truncated).toBe(true);
    expect(result.matches).toHaveLength(MAX_DIFF_FIND_MATCHES);
  });
});

describe("wrapDiffFindIndex", () => {
  it("wraps in both directions", () => {
    expect(wrapDiffFindIndex(2, 1, 3)).toBe(0);
    expect(wrapDiffFindIndex(0, -1, 3)).toBe(2);
    expect(wrapDiffFindIndex(0, 1, 0)).toBe(0);
  });
});

describe("match identity", () => {
  it("separates the two sides of the same line number and each occurrence", () => {
    const keys = collectDiffFindMatches(files, "name").matches.map(buildDiffFindMatchKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("marks only the match's own side", () => {
    const match = collectDiffFindMatches(files, "nil").matches[0]!;
    expect(resolveDiffFindLineRange(match)).toEqual({
      start: 1,
      end: 1,
      side: "deletions",
      endSide: "deletions",
    });
  });
});

describe("formatDiffFindCount", () => {
  const base = { activeIndex: 1, matchCount: 3, truncated: false };

  it("stays quiet with no query and reports the position otherwise", () => {
    expect(formatDiffFindCount({ ...base, query: "" })).toBe("");
    expect(formatDiffFindCount({ ...base, query: "a" })).toBe("2/3");
    expect(formatDiffFindCount({ ...base, query: "a", truncated: true })).toBe("2/3+");
    expect(formatDiffFindCount({ ...base, query: "a", activeIndex: 0, matchCount: 0 })).toBe(
      "No results",
    );
  });
});

describe("estimateDiffFindMatchOffset", () => {
  it("uses the row for the layout and counts separators", () => {
    const match = collectDiffFindMatches(files, "ctx22").matches[0]!;
    const layout = { lineHeight: 10, headerHeight: 40, separatorHeight: 30 };
    expect(estimateDiffFindMatchOffset(match, { ...layout, split: false })).toBe(150);
    expect(estimateDiffFindMatchOffset(match, { ...layout, split: true })).toBe(130);
  });
});

describe("isDiffFindChord", () => {
  const event = { key: "f", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };

  it("uses the platform's modifier", () => {
    expect(isDiffFindChord({ ...event, metaKey: true }, "MacIntel")).toBe(true);
    expect(isDiffFindChord({ ...event, ctrlKey: true }, "MacIntel")).toBe(false);
    expect(isDiffFindChord({ ...event, ctrlKey: true }, "Win32")).toBe(true);
    expect(isDiffFindChord({ ...event, key: "F", ctrlKey: true }, "Linux x86_64")).toBe(true);
  });

  it("leaves other chords alone", () => {
    expect(isDiffFindChord(event, "MacIntel")).toBe(false);
    expect(isDiffFindChord({ ...event, metaKey: true, shiftKey: true }, "MacIntel")).toBe(false);
    expect(isDiffFindChord({ ...event, metaKey: true, altKey: true }, "MacIntel")).toBe(false);
    expect(isDiffFindChord({ ...event, metaKey: true, key: "g" }, "MacIntel")).toBe(false);
  });

  it("leaves the chord with both modifiers alone, which is fullscreen on a Mac", () => {
    const both = { ...event, metaKey: true, ctrlKey: true };
    expect(isDiffFindChord(both, "MacIntel")).toBe(false);
    expect(isDiffFindChord(both, "Win32")).toBe(false);
  });

  it("goes by the physical key on a non-Latin layout", () => {
    const cyrillic = { ...event, key: "а", code: "KeyF" };
    expect(isDiffFindChord({ ...cyrillic, metaKey: true }, "MacIntel")).toBe(true);
    expect(isDiffFindChord({ ...cyrillic, code: "KeyG", metaKey: true }, "MacIntel")).toBe(false);
  });
});

describe("reuseDiffFindFiles", () => {
  const file = parsePatchFiles(PATCH)[0]!.files[0]!;
  const otherFile = { ...file };

  it("holds the array while every entry is the same", () => {
    const previous = [{ fileKey: "a", file }];
    expect(reuseDiffFindFiles(previous, [{ fileKey: "a", file }])).toBe(previous);
  });

  it("takes the new array when a key, a file or the length differs", () => {
    const previous = [{ fileKey: "a", file }];
    for (const next of [
      [{ fileKey: "b", file }],
      [{ fileKey: "a", file: otherFile }],
      [
        { fileKey: "a", file },
        { fileKey: "b", file },
      ],
      [],
    ]) {
      expect(reuseDiffFindFiles(previous, next)).toBe(next);
    }
  });
});

describe("estimateDiffFindRowTop", () => {
  // Rows of 40px, as wrapped lines are, where a line-height sum would land far short.
  const mounted = [400, 401, 402, 403].map((row, index) => ({
    row,
    top: 1000 + index * 40,
    bottom: 1040 + index * 40,
  }));

  it("steps from the nearest mounted row at the measured height", () => {
    expect(estimateDiffFindRowTop(1000, mounted)).toBe(1120 + 597 * 40);
    expect(estimateDiffFindRowTop(390, mounted)).toBe(1000 - 10 * 40);
  });

  it("is null with nothing mounted", () => {
    expect(estimateDiffFindRowTop(5, [])).toBeNull();
  });
});

describe("parseDiffRowIndex", () => {
  it("picks the layout's value", () => {
    expect(parseDiffRowIndex("7,5", false)).toBe(7);
    expect(parseDiffRowIndex("7,5", true)).toBe(5);
  });

  it("is null when it cannot tell", () => {
    expect(parseDiffRowIndex(undefined, false)).toBeNull();
    expect(parseDiffRowIndex("7", true)).toBeNull();
  });
});

const node = (attribute: string | null) =>
  ({ hasAttribute: (name: string) => name === attribute }) as unknown as EventTarget;

describe("isDiffFindEvent", () => {
  it("looks through the composed path, past shadow roots and non-elements", () => {
    const composedPath = () => [node(null), {} as EventTarget, node(DIFF_FIND_SCOPE_ATTRIBUTE)];
    expect(isDiffFindEvent({ composedPath })).toBe(true);
    expect(isDiffFindEvent({ composedPath: () => [node(null), {} as EventTarget] })).toBe(false);
  });
});
