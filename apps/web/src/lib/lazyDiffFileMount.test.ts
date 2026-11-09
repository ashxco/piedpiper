import { parseDiffFromFile, parsePatchFiles } from "@pierre/diffs";
import { describe, expect, it } from "vitest";

import {
  addMountedDiffFileKeys,
  estimateDiffFileHeight,
  LAZY_DIFF_FILE_MOUNT_THRESHOLD,
  pickDiffFileKeysToMount,
  resolveMountedDiffFileKeys,
  shouldLazyMountDiffFiles,
} from "./lazyDiffFileMount";

const LINE_HEIGHT = 20;
const HEADER = 44;
const BOTTOM_PADDING = 8;
const SEPARATOR = 32;
const SEPARATOR_GAP = 8;

function parseFile(patch: string) {
  const file = parsePatchFiles(patch).flatMap((parsed) => parsed.files)[0];
  if (!file) throw new Error("no file in patch");
  return file;
}

const stacked = { split: false, collapsed: false, lineHeight: LINE_HEIGHT };
const split = { split: true, collapsed: false, lineHeight: LINE_HEIGHT };

/** Two deletions against three additions, then a line of context. */
const ONE_HUNK = parseFile(
  [
    "diff --git a/a.ts b/a.ts",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1,3 +1,4 @@",
    "-one",
    "-two",
    "+uno",
    "+dos",
    "+tres",
    " same",
    "",
  ].join("\n"),
);

const TWO_HUNKS = parseFile(
  [
    "diff --git a/a.ts b/a.ts",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -5,1 +5,1 @@",
    "-one",
    "+uno",
    "@@ -20,1 +20,1 @@",
    "-two",
    "+dos",
    "",
  ].join("\n"),
);

describe("shouldLazyMountDiffFiles", () => {
  it("only applies above the threshold", () => {
    expect(shouldLazyMountDiffFiles(0)).toBe(false);
    expect(shouldLazyMountDiffFiles(LAZY_DIFF_FILE_MOUNT_THRESHOLD)).toBe(false);
    expect(shouldLazyMountDiffFiles(LAZY_DIFF_FILE_MOUNT_THRESHOLD + 1)).toBe(true);
  });
});

describe("estimateDiffFileHeight", () => {
  it("counts each row of the stacked layout", () => {
    expect(estimateDiffFileHeight(ONE_HUNK, stacked)).toBe(
      HEADER + 6 * LINE_HEIGHT + BOTTOM_PADDING,
    );
  });

  it("pairs deletions with additions in the split layout", () => {
    expect(estimateDiffFileHeight(ONE_HUNK, split)).toBe(HEADER + 4 * LINE_HEIGHT + BOTTOM_PADDING);
  });

  it("follows the code line height", () => {
    expect(estimateDiffFileHeight(ONE_HUNK, { ...stacked, lineHeight: 26 })).toBe(
      HEADER + 6 * 26 + BOTTOM_PADDING,
    );
  });

  it("is only the header when collapsed, whatever the layout", () => {
    expect(estimateDiffFileHeight(TWO_HUNKS, { ...stacked, collapsed: true })).toBe(HEADER);
    expect(estimateDiffFileHeight(TWO_HUNKS, { ...split, collapsed: true })).toBe(HEADER);
  });

  it("adds a separator before each hunk that skips lines, with a gap between hunks", () => {
    const firstSeparator = SEPARATOR + SEPARATOR_GAP;
    const secondSeparator = SEPARATOR_GAP + SEPARATOR + SEPARATOR_GAP;
    expect(estimateDiffFileHeight(TWO_HUNKS, stacked)).toBe(
      HEADER +
        firstSeparator +
        2 * LINE_HEIGHT +
        secondSeparator +
        2 * LINE_HEIGHT +
        BOTTOM_PADDING,
    );
    expect(estimateDiffFileHeight(TWO_HUNKS, split)).toBe(
      HEADER + firstSeparator + LINE_HEIGHT + secondSeparator + LINE_HEIGHT + BOTTOM_PADDING,
    );
  });

  it("is only the header for a file with no hunks, such as a pure rename", () => {
    const rename = parseFile(
      [
        "diff --git a/a.ts b/b.ts",
        "similarity index 100%",
        "rename from a.ts",
        "rename to b.ts",
        "",
      ].join("\n"),
    );
    expect(rename.hunks).toHaveLength(0);
    expect(estimateDiffFileHeight(rename, stacked)).toBe(HEADER);
  });

  it("adds the row saying a side has no newline at the end", () => {
    const noNewline = parseFile(
      [
        "diff --git a/a.ts b/a.ts",
        "--- a/a.ts",
        "+++ b/a.ts",
        "@@ -1 +1 @@",
        "-one",
        "\\ No newline at end of file",
        "+uno",
        "\\ No newline at end of file",
        "",
      ].join("\n"),
    );
    expect(estimateDiffFileHeight(noNewline, stacked)).toBe(
      HEADER + 4 * LINE_HEIGHT + BOTTOM_PADDING,
    );
    expect(estimateDiffFileHeight(noNewline, split)).toBe(
      HEADER + 2 * LINE_HEIGHT + BOTTOM_PADDING,
    );
  });

  it("counts the unchanged lines a full-context file shows between and after hunks", () => {
    const lines = Array.from({ length: 30 }, (_, index) => `line ${index + 1}\n`);
    const before = lines.join("");
    const after = lines.map((line, index) => (index === 14 ? "changed\n" : line)).join("");
    const file = parseDiffFromFile(
      { name: "a.ts", contents: before },
      { name: "a.ts", contents: after },
    );
    expect(file.isPartial).toBe(false);
    // 29 unchanged lines, then the deletion and addition.
    expect(estimateDiffFileHeight(file, stacked)).toBe(HEADER + 31 * LINE_HEIGHT + BOTTOM_PADDING);
    expect(estimateDiffFileHeight(file, split)).toBe(HEADER + 30 * LINE_HEIGHT + BOTTOM_PADDING);
  });
});

describe("addMountedDiffFileKeys", () => {
  it("returns the same set when nothing is new", () => {
    const current = new Set(["a"]);
    expect(addMountedDiffFileKeys(current, ["a"])).toBe(current);
    expect(addMountedDiffFileKeys(current, [])).toBe(current);
  });

  it("adds without touching the set it was given", () => {
    const current = new Set(["a"]);
    expect([...addMountedDiffFileKeys(current, ["b", "b", "a"])]).toEqual(["a", "b"]);
    expect([...current]).toEqual(["a"]);
  });
});

describe("resolveMountedDiffFileKeys", () => {
  const manyKeys = Array.from(
    { length: LAZY_DIFF_FILE_MOUNT_THRESHOLD + 1 },
    (_, index) => `file${index}`,
  );

  it("counts every file of an ordinary diff as mounted", () => {
    const keys = resolveMountedDiffFileKeys(new Set(), {
      fileKeys: ["a", "b"],
      requiredKeys: [],
    });
    expect([...keys]).toEqual(["a", "b"]);
  });

  it("holds its identity while an ordinary diff stays the same, even with a repeated key", () => {
    const fileKeys = ["a", "a", "b"];
    const first = resolveMountedDiffFileKeys(new Set(), { fileKeys, requiredKeys: [] });
    expect(resolveMountedDiffFileKeys(first, { fileKeys, requiredKeys: [] })).toBe(first);
  });

  it("mounts nothing of a long patch but the files it must", () => {
    const keys = resolveMountedDiffFileKeys(new Set(), {
      fileKeys: manyKeys,
      requiredKeys: ["file30"],
    });
    expect([...keys]).toEqual(["file30"]);
  });

  it("keeps a file mounted once nothing requires it any more", () => {
    const current = new Set(["file30"]);
    expect(resolveMountedDiffFileKeys(current, { fileKeys: manyKeys, requiredKeys: [] })).toBe(
      current,
    );
  });

  it("keeps the viewers of an ordinary diff when it grows past the threshold", () => {
    const small = resolveMountedDiffFileKeys(new Set(), { fileKeys: ["a"], requiredKeys: [] });
    const grown = resolveMountedDiffFileKeys(small, {
      fileKeys: ["a", ...manyKeys],
      requiredKeys: [],
    });
    expect([...grown]).toEqual(["a"]);
  });

  it("starts over when the patch is gone, as the scroller is too", () => {
    const keys = resolveMountedDiffFileKeys(new Set(manyKeys), { fileKeys: [], requiredKeys: [] });
    expect(keys.size).toBe(0);
  });
});

const file = (key: string, top: number, bottom = top + 200) => ({ key, top, bottom });

describe("pickDiffFileKeysToMount", () => {
  const viewport = { top: 100, bottom: 900 };
  it("takes the files in view first, and from there outwards", () => {
    expect(
      pickDiffFileKeysToMount(
        [
          file("far below", 3000),
          file("just above", -300),
          file("in view lower", 700),
          file("below", 1000),
          file("in view upper", 200),
        ],
        viewport,
        10,
      ),
    ).toEqual(["in view upper", "in view lower", "below", "just above", "far below"]);
  });

  it("counts a file overlapping an edge as in view", () => {
    expect(
      pickDiffFileKeysToMount([file("below", 950), file("across the top", 0, 150)], viewport, 1),
    ).toEqual(["across the top"]);
  });

  it("stops at the limit, leaving the input as it was", () => {
    const pending = [file("c", 500), file("a", 100), file("b", 300)];
    expect(pickDiffFileKeysToMount(pending, viewport, 2)).toEqual(["a", "b"]);
    expect(pending.map(({ key }) => key)).toEqual(["c", "a", "b"]);
  });
});
