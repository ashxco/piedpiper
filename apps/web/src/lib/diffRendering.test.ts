import { describe, expect, it } from "vitest";
import { parsePatchFiles } from "@pierre/diffs";
import {
  buildPatchCacheKey,
  getDiffLineStat,
  getRenderablePatch,
  reuseUnchangedDiffFiles,
} from "./diffRendering";

describe("buildPatchCacheKey", () => {
  it("returns a stable cache key for identical content", () => {
    const patch = "diff --git a/a.ts b/a.ts\n+console.log('hello')";

    expect(buildPatchCacheKey(patch)).toBe(buildPatchCacheKey(patch));
  });

  it("keeps trailing whitespace in the hash", () => {
    const patch = "diff --git a/a.ts b/a.ts\n+console.log('hello')";

    expect(buildPatchCacheKey(`${patch}\t`)).not.toBe(buildPatchCacheKey(patch));
  });

  it("changes when diff content changes", () => {
    const before = "diff --git a/a.ts b/a.ts\n+console.log('hello')";
    const after = "diff --git a/a.ts b/a.ts\n+console.log('hello world')";

    expect(buildPatchCacheKey(before)).not.toBe(buildPatchCacheKey(after));
  });

  it("changes when cache scope changes", () => {
    const patch = "diff --git a/a.ts b/a.ts\n+console.log('hello')";

    expect(buildPatchCacheKey(patch, "diff-panel:light")).not.toBe(
      buildPatchCacheKey(patch, "diff-panel:dark"),
    );
  });
});

describe("getDiffLineStat", () => {
  it("totals additions and deletions across every file and hunk", () => {
    const patch = [
      "diff --git a/example.ts b/example.ts",
      "--- a/example.ts",
      "+++ b/example.ts",
      "@@ -1,2 +1,3 @@",
      "-before",
      "+after",
      "+added",
      " context",
      "@@ -10,2 +11,1 @@",
      "-removed",
      " context",
      "diff --git a/README.md b/README.md",
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -1 +1,2 @@",
      " title",
      "+description",
    ].join("\n");

    const files = parsePatchFiles(patch).flatMap((parsed) => parsed.files);
    expect(files).toHaveLength(2);
    expect(getDiffLineStat(files)).toEqual({ additions: 3, deletions: 2 });
  });

  it("returns zero for no files", () => {
    expect(getDiffLineStat([])).toEqual({ additions: 0, deletions: 0 });
  });
});

const patchWithLastLines = (lastLines: string[]) =>
  [
    "diff --git a/example.ts b/example.ts",
    "--- a/example.ts",
    "+++ b/example.ts",
    ...lastLines,
    "",
  ].join("\n");

const patchWithAddedLine = (added: string) =>
  [
    "diff --git a/example.ts b/example.ts",
    "--- a/example.ts",
    "+++ b/example.ts",
    "@@ -1 +1 @@",
    "-a",
    `+${added}`,
    "",
  ].join("\n");

const fileBlock = (name: string, added: string, spec = "@@ -1 +1 @@") => [
  `diff --git a/${name} b/${name}`,
  `--- a/${name}`,
  `+++ b/${name}`,
  spec,
  "-a",
  `+${added}`,
];

describe("getRenderablePatch", () => {
  it("keeps whitespace at the end of the last hunk", () => {
    const trailing = getRenderablePatch(
      patchWithLastLines(["@@ -1 +1 @@", "-a", "+  b \t"]),
      "review",
    );
    expect(trailing?.kind).toBe("files");
    if (trailing?.kind !== "files") return;
    expect(trailing.files[0]?.additionLines).toEqual(["  b \t\n"]);

    const blankContext = getRenderablePatch(
      patchWithLastLines(["@@ -1,2 +1,2 @@", "-a", "+b", " "]),
      "review",
    );
    expect(blankContext?.kind).toBe("files");
    if (blankContext?.kind !== "files") return;
    expect(blankContext.files[0]?.additionLines).toEqual(["b\n", "\n"]);
    expect(blankContext.files[0]?.hunks[0]?.unifiedLineCount).toBe(3);

    expect(getRenderablePatch(" \n\t\n", "review")).toBeNull();
    expect(getRenderablePatch(undefined)).toBeNull();
  });

  it("caches patches that differ only in trailing whitespace separately", () => {
    const plain = getRenderablePatch(patchWithAddedLine("b"), "review");
    const tabbed = getRenderablePatch(patchWithAddedLine("b\t"), "review");
    expect(plain?.kind).toBe("files");
    expect(tabbed?.kind).toBe("files");
    if (plain?.kind !== "files" || tabbed?.kind !== "files") return;
    expect(tabbed.files[0]?.cacheKey).not.toBe(plain.files[0]?.cacheKey);
  });

  describe("per-file cache keys", () => {
    const keysOf = (blocks: ReadonlyArray<ReadonlyArray<string>>, scope = "review") => {
      const parsed = getRenderablePatch([...blocks.flat(), ""].join("\n"), scope);
      if (parsed?.kind !== "files") throw new Error("patch did not parse");
      return Object.fromEntries(parsed.files.map((file) => [file.name, file.cacheKey]));
    };

    it("keeps a file's key when only another file changes, or the files shift", () => {
      const before = keysOf([fileBlock("x.ts", "one"), fileBlock("y.ts", "two")]);
      const after = keysOf([
        fileBlock("w.ts", "new"),
        fileBlock("x.ts", "one"),
        fileBlock("y.ts", "edit"),
      ]);
      expect(after["x.ts"]).toBe(before["x.ts"]);
      expect(after["y.ts"]).not.toBe(before["y.ts"]);
    });

    it("changes with the file's position and the scope", () => {
      const base = keysOf([fileBlock("x.ts", "one")]);
      expect(keysOf([fileBlock("x.ts", "one", "@@ -5 +5 @@")])["x.ts"]).not.toBe(base["x.ts"]);
      expect(keysOf([fileBlock("x.ts", "one")], "other")["x.ts"]).not.toBe(base["x.ts"]);
    });

    it("carries over the parsed objects of unchanged files", () => {
      const parse = (blocks: ReadonlyArray<ReadonlyArray<string>>) => {
        const parsed = getRenderablePatch([...blocks.flat(), ""].join("\n"), "review");
        if (parsed?.kind !== "files") throw new Error("patch did not parse");
        return parsed.files;
      };
      const before = parse([fileBlock("x.ts", "one"), fileBlock("y.ts", "two")]);

      const same = parse([fileBlock("x.ts", "one"), fileBlock("y.ts", "two")]);
      expect(reuseUnchangedDiffFiles(before, same)).toBe(before);

      const edited = reuseUnchangedDiffFiles(
        before,
        parse([fileBlock("x.ts", "one"), fileBlock("y.ts", "edit")]),
      );
      expect(edited).not.toBe(before);
      expect(edited[0]).toBe(before[0]);
      expect(edited[1]).not.toBe(before[1]);
      expect(reuseUnchangedDiffFiles(edited, parse([fileBlock("y.ts", "edit")]))).toEqual([
        edited[1],
      ]);
    });

    it("stays unique when a patch repeats a block exactly", () => {
      const block = fileBlock("x.ts", "one");
      const parsed = getRenderablePatch([...block, ...block, ""].join("\n"), "review");
      if (parsed?.kind !== "files") throw new Error("patch did not parse");
      expect(new Set(parsed.files.map((file) => file.cacheKey)).size).toBe(parsed.files.length);
    });
  });
});
