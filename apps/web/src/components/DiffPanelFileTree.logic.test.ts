import { describe, expect, it } from "vitest";

import { getRenderablePatch } from "../lib/diffRendering";
import { buildTurnDiffTree } from "../lib/turnDiffTree";
import {
  buildDiffFileTreeEntries,
  clampDiffFileTreeWidth,
  collectDiffTreeDirectoryPaths,
  resolveActiveDiffFilePath,
  resolveDiffFileStatus,
  resolveDiffFileTreeMaxWidth,
  resolveFileDiffPath,
} from "./DiffPanelFileTree.logic";

function hunk(additionLines: number, deletionLines: number) {
  return { additionLines, deletionLines } as never;
}

describe("clampDiffFileTreeWidth", () => {
  it("keeps 256px for the diff and caps the tree at 560px", () => {
    expect(resolveDiffFileTreeMaxWidth(640)).toBe(384);
    expect(resolveDiffFileTreeMaxWidth(2000)).toBe(560);
    expect(clampDiffFileTreeWidth(500, 640)).toBe(384);
    expect(clampDiffFileTreeWidth(900, 2000)).toBe(560);
  });

  it("never goes below the minimum, even in a tiny body", () => {
    expect(clampDiffFileTreeWidth(10, 2000)).toBe(160);
    expect(resolveDiffFileTreeMaxWidth(100)).toBe(160);
    expect(clampDiffFileTreeWidth(300, 100)).toBe(160);
  });
});

describe("resolveDiffFileStatus", () => {
  it("maps parser change types to tree statuses", () => {
    expect(resolveDiffFileStatus("new")).toBe("added");
    expect(resolveDiffFileStatus("deleted")).toBe("deleted");
    expect(resolveDiffFileStatus("rename-pure")).toBe("renamed");
    expect(resolveDiffFileStatus("rename-changed")).toBe("renamed");
    expect(resolveDiffFileStatus("change")).toBe("modified");
  });
});

describe("resolveFileDiffPath", () => {
  it("falls back to the previous name", () => {
    expect(resolveFileDiffPath({ name: "src/a.ts", prevName: "src/old.ts" })).toBe("src/a.ts");
    expect(resolveFileDiffPath({ name: "", prevName: "src/gone.ts" })).toBe("src/gone.ts");
  });

  it("reads both sides of a rename from the parser's names", () => {
    const parsed = getRenderablePatch(
      [
        "diff --git a/a/before.ts b/b/after.ts",
        "similarity index 90%",
        "rename from a/before.ts",
        "rename to b/after.ts",
        "--- a/a/before.ts",
        "+++ b/b/after.ts",
        "@@ -1 +1 @@",
        "-x",
        "+y",
        "",
      ].join("\n"),
    );
    if (parsed?.kind !== "files") throw new Error("patch did not parse");
    const file = parsed.files[0]!;
    expect(file.type).toBe("rename-changed");
    expect(resolveFileDiffPath(file)).toBe("b/after.ts");
    expect(resolveFileDiffPath({ name: file.prevName ?? "" })).toBe("a/before.ts");
  });

  it.each(["a/index.ts", "b/index.ts"])("keeps the real top-level folder in %s", (path) => {
    const parsed = getRenderablePatch(
      [
        `diff --git a/${path} b/${path}`,
        `--- a/${path}`,
        `+++ b/${path}`,
        "@@ -1 +1 @@",
        "-old",
        "+new",
        "",
      ].join("\n"),
    );
    expect(parsed?.kind).toBe("files");
    if (parsed?.kind !== "files") return;
    expect(parsed.files.map(resolveFileDiffPath)).toEqual([path]);
  });

  it("keeps a real top-level folder on a deleted file", () => {
    const parsed = getRenderablePatch(
      [
        "diff --git a/a/gone.ts b/a/gone.ts",
        "deleted file mode 100644",
        "--- a/a/gone.ts",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-old",
        "",
      ].join("\n"),
    );
    expect(parsed?.kind).toBe("files");
    if (parsed?.kind !== "files") return;
    expect(parsed.files.map(resolveFileDiffPath)).toEqual(["a/gone.ts"]);
  });
});

describe("buildDiffFileTreeEntries", () => {
  it("keeps the diff order and sums each file's hunks", () => {
    expect(
      buildDiffFileTreeEntries([
        { name: "src/z.ts", type: "new", hunks: [hunk(3, 0), hunk(2, 0)] },
        { name: "src/a.ts", prevName: "src/b.ts", type: "rename-changed", hunks: [hunk(1, 1)] },
        { name: "README.md", type: "deleted", hunks: [hunk(0, 4)] },
      ]),
    ).toEqual([
      { path: "src/z.ts", status: "added", additions: 5, deletions: 0 },
      { path: "src/a.ts", status: "renamed", additions: 1, deletions: 1 },
      { path: "README.md", status: "deleted", additions: 0, deletions: 4 },
    ]);
  });
});

describe("buildDiffFileTreeEntries with a type change", () => {
  const TYPE_CHANGE_PATCH = [
    "diff --git a/AGENTS.md b/AGENTS.md",
    "deleted file mode 100644",
    "--- a/AGENTS.md",
    "+++ /dev/null",
    "@@ -1,2 +0,0 @@",
    "-duplicated",
    "-instructions",
    "diff --git a/AGENTS.md b/AGENTS.md",
    "new file mode 120000",
    "--- /dev/null",
    "+++ b/AGENTS.md",
    "@@ -0,0 +1 @@",
    "+CLAUDE.md",
    "",
  ].join("\n");

  it("folds both blocks into one modified entry with summed stats", () => {
    const parsed = getRenderablePatch(TYPE_CHANGE_PATCH);
    expect(parsed?.kind).toBe("files");
    if (parsed?.kind !== "files") return;
    expect(parsed.files.map((file) => file.type)).toEqual(["deleted", "new"]);
    expect(buildDiffFileTreeEntries(parsed.files)).toEqual([
      { path: "AGENTS.md", status: "modified", additions: 1, deletions: 2 },
    ]);
  });

  it("keeps the first position of a folded path and leaves other files alone", () => {
    expect(
      buildDiffFileTreeEntries([
        { name: "z.ts", type: "deleted", hunks: [hunk(0, 1)] },
        { name: "a.ts", type: "new", hunks: [hunk(2, 0)] },
        { name: "z.ts", type: "new", hunks: [hunk(1, 0)] },
      ]),
    ).toEqual([
      { path: "z.ts", status: "modified", additions: 1, deletions: 1 },
      { path: "a.ts", status: "added", additions: 2, deletions: 0 },
    ]);
  });
});

describe("collectDiffTreeDirectoryPaths", () => {
  it("lists every directory, including nested and compacted ones", () => {
    const tree = buildTurnDiffTree([
      { path: "apps/web/src/a.ts" },
      { path: "apps/web/test/b.ts" },
      { path: "packages/shared/src/c.ts" },
      { path: "README.md" },
    ]);
    expect(collectDiffTreeDirectoryPaths(tree)).toEqual([
      "apps/web",
      "apps/web/src",
      "apps/web/test",
      "packages/shared/src",
    ]);
  });
});

describe("resolveActiveDiffFilePath", () => {
  const positions = [
    { path: "a.ts", top: -400 },
    { path: "b.ts", top: -20 },
    { path: "c.ts", top: 300 },
  ];

  it("picks the last file whose header reached the top", () => {
    expect(resolveActiveDiffFilePath(positions, 16)).toBe("b.ts");
  });

  it("counts a header just below the top within the threshold", () => {
    expect(resolveActiveDiffFilePath(positions, 320)).toBe("c.ts");
  });

  describe("when scrolled to the bottom", () => {
    const bottomPositions = [
      { path: "a.ts", top: -600 },
      { path: "b.ts", top: 10 },
      { path: "c.ts", top: 200 },
    ];

    it("keeps the current file while its header is in view", () => {
      expect(
        resolveActiveDiffFilePath(bottomPositions, 24, {
          viewportHeight: 400,
          currentPath: "c.ts",
        }),
      ).toBe("c.ts");
      expect(
        resolveActiveDiffFilePath(bottomPositions, 24, {
          viewportHeight: 400,
          currentPath: "b.ts",
        }),
      ).toBe("b.ts");
    });

    it("picks the last header in view when the current file scrolled out", () => {
      expect(
        resolveActiveDiffFilePath(bottomPositions, 24, {
          viewportHeight: 400,
          currentPath: "a.ts",
        }),
      ).toBe("c.ts");
    });

    it("falls back to the top-anchored file when no header is in view", () => {
      expect(
        resolveActiveDiffFilePath([{ path: "a.ts", top: -900 }], 24, {
          viewportHeight: 400,
          currentPath: null,
        }),
      ).toBe("a.ts");
    });
  });

  it("falls back to the first file before any header reaches the top", () => {
    expect(resolveActiveDiffFilePath([{ path: "a.ts", top: 50 }], 16)).toBe("a.ts");
    expect(resolveActiveDiffFilePath([], 16)).toBeNull();
  });
});
