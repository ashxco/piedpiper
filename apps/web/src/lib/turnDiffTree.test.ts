import { describe, expect, it } from "vitest";

import { buildTurnDiffTree, orderDiffFilesLikeTree, summarizeTurnDiffStats } from "./turnDiffTree";

describe("summarizeTurnDiffStats", () => {
  it("sums only files with numeric additions/deletions", () => {
    const stat = summarizeTurnDiffStats([
      { path: "README.md", additions: 3, deletions: 1 },
      { path: "docs/notes.md" },
      { path: "src/index.ts", additions: 5, deletions: 2 },
    ]);

    expect(stat).toEqual({ additions: 8, deletions: 3 });
  });
});

describe("buildTurnDiffTree", () => {
  it("sorts directory and file names numerically with directories first", () => {
    const tree = buildTurnDiffTree([
      { path: "file10.ts", kind: "modified", additions: 1, deletions: 0 },
      { path: "dir10/file10.ts", kind: "modified", additions: 1, deletions: 0 },
      { path: "file2.ts", kind: "modified", additions: 1, deletions: 0 },
      { path: "dir2/file10.ts", kind: "modified", additions: 1, deletions: 0 },
      { path: "dir2/file2.ts", kind: "modified", additions: 1, deletions: 0 },
    ]);

    expect(tree.map((node) => node.name)).toEqual(["dir2", "dir10", "file2.ts", "file10.ts"]);
    const directory = tree[0];
    if (directory?.kind !== "directory") throw new Error("Expected a directory");
    expect(directory.children.map((node) => node.name)).toEqual(["file2.ts", "file10.ts"]);
  });

  it("preserves input order for case- and accent-insensitive name ties", () => {
    const tree = buildTurnDiffTree([
      { path: "a.ts", kind: "modified", additions: 1, deletions: 0 },
      { path: "A.ts", kind: "modified", additions: 2, deletions: 0 },
      { path: "FOLDER/a.ts", kind: "modified", additions: 3, deletions: 0 },
      { path: "folder/a.ts", kind: "modified", additions: 4, deletions: 0 },
      { path: "café.ts", kind: "modified", additions: 5, deletions: 0 },
      { path: "Cafe.ts", kind: "modified", additions: 6, deletions: 0 },
      { path: "cafe.ts", kind: "modified", additions: 7, deletions: 0 },
    ]);

    expect(tree.map((node) => node.name)).toEqual([
      "FOLDER",
      "folder",
      "a.ts",
      "A.ts",
      "café.ts",
      "Cafe.ts",
      "cafe.ts",
    ]);
  });

  it("compacts nested single-directory chains below a branch point", () => {
    expect(
      buildTurnDiffTree([
        { path: "src/a/b/first.ts", kind: "modified", additions: 1, deletions: 0 },
        { path: "src/c/d/second.ts", kind: "modified", additions: 2, deletions: 0 },
      ]),
    ).toMatchObject([
      {
        name: "src",
        children: [
          { name: "a/b", path: "src/a/b", children: [{ name: "first.ts" }] },
          { name: "c/d", path: "src/c/d", children: [{ name: "second.ts" }] },
        ],
      },
    ]);
    expect(
      buildTurnDiffTree([
        { path: "a/b/c/d/file.ts", kind: "modified", additions: 1, deletions: 0 },
      ]),
    ).toMatchObject([
      {
        name: "a/b/c/d",
        path: "a/b/c/d",
        children: [{ name: "file.ts", path: "a/b/c/d/file.ts" }],
      },
    ]);
  });

  it("builds nested directory nodes with aggregated stats", () => {
    const tree = buildTurnDiffTree([
      { path: "src/index.ts", additions: 2, deletions: 1 },
      { path: "src/components/Button.tsx", additions: 4, deletions: 2 },
      { path: "README.md", additions: 1, deletions: 0 },
    ]);

    expect(tree).toEqual([
      {
        kind: "directory",
        name: "src",
        path: "src",
        stat: { additions: 6, deletions: 3 },
        children: [
          {
            kind: "directory",
            name: "components",
            path: "src/components",
            stat: { additions: 4, deletions: 2 },
            children: [
              {
                kind: "file",
                name: "Button.tsx",
                path: "src/components/Button.tsx",
                stat: { additions: 4, deletions: 2 },
              },
            ],
          },
          {
            kind: "file",
            name: "index.ts",
            path: "src/index.ts",
            stat: { additions: 2, deletions: 1 },
          },
        ],
      },
      {
        kind: "file",
        name: "README.md",
        path: "README.md",
        stat: { additions: 1, deletions: 0 },
      },
    ]);
  });

  it("keeps files without stat values and excludes them from directory totals", () => {
    const tree = buildTurnDiffTree([
      { path: "docs/notes.md" },
      { path: "docs/todo.md", additions: 1, deletions: 1 },
    ]);

    expect(tree).toEqual([
      {
        kind: "directory",
        name: "docs",
        path: "docs",
        stat: { additions: 1, deletions: 1 },
        children: [
          {
            kind: "file",
            name: "notes.md",
            path: "docs/notes.md",
            stat: null,
          },
          {
            kind: "file",
            name: "todo.md",
            path: "docs/todo.md",
            stat: { additions: 1, deletions: 1 },
          },
        ],
      },
    ]);
  });

  it("normalizes file paths with windows separators", () => {
    const tree = buildTurnDiffTree([
      { path: "apps\\web\\src\\index.ts", additions: 2, deletions: 1 },
    ]);

    expect(tree).toEqual([
      {
        kind: "directory",
        name: "apps/web/src",
        path: "apps/web/src",
        stat: { additions: 2, deletions: 1 },
        children: [
          {
            kind: "file",
            name: "index.ts",
            path: "apps/web/src/index.ts",
            stat: { additions: 2, deletions: 1 },
          },
        ],
      },
    ]);
  });

  it("compacts only single-directory chains and stops at branch points", () => {
    const tree = buildTurnDiffTree([
      { path: "apps/server/src/index.ts", additions: 2, deletions: 1 },
      { path: "apps/server/main.ts", additions: 4, deletions: 0 },
    ]);

    expect(tree).toEqual([
      {
        kind: "directory",
        name: "apps/server",
        path: "apps/server",
        stat: { additions: 6, deletions: 1 },
        children: [
          {
            kind: "directory",
            name: "src",
            path: "apps/server/src",
            stat: { additions: 2, deletions: 1 },
            children: [
              {
                kind: "file",
                name: "index.ts",
                path: "apps/server/src/index.ts",
                stat: { additions: 2, deletions: 1 },
              },
            ],
          },
          {
            kind: "file",
            name: "main.ts",
            path: "apps/server/main.ts",
            stat: { additions: 4, deletions: 0 },
          },
        ],
      },
    ]);
  });

  it("preserves leading/trailing whitespace in path segments", () => {
    const tree = buildTurnDiffTree([
      { path: "a/file.ts", additions: 1, deletions: 0 },
      { path: " a/file.ts", additions: 2, deletions: 0 },
    ]);

    expect(tree).toHaveLength(2);
    const directoryNodes = tree.filter(
      (node): node is Extract<(typeof tree)[number], { kind: "directory" }> =>
        node.kind === "directory",
    );
    expect(directoryNodes.map((node) => node.name).toSorted()).toEqual([" a", "a"]);
    expect(directoryNodes.map((node) => node.path).toSorted()).toEqual([" a", "a"]);
  });
});

describe("orderDiffFilesLikeTree", () => {
  const order = (paths: string[]) =>
    orderDiffFilesLikeTree(
      paths.map((path) => ({ path })),
      (file) => file.path,
    ).map((file) => file.path);

  it("lists directories before sibling files, as the tree does", () => {
    expect(order(["z.ts", "src/b.ts", "a.ts", "src/lib/c.ts"])).toEqual([
      "src/lib/c.ts",
      "src/b.ts",
      "a.ts",
      "z.ts",
    ]);
  });

  it("sorts names numerically and case-insensitively", () => {
    expect(order(["file10.ts", "File2.ts", "file1.ts"])).toEqual([
      "file1.ts",
      "File2.ts",
      "file10.ts",
    ]);
  });

  it("matches the file order of a compacted tree", () => {
    const paths = ["a/b/c/one.ts", "a/b/two.ts", "a/three.ts", "four.ts"];
    expect(order(paths.toReversed())).toEqual(paths);
  });

  it("sorts paths the tree cannot place last and keeps their order", () => {
    expect(order(["", "b.ts", "/", "a.ts"])).toEqual(["a.ts", "b.ts", "", "/"]);
  });

  it("finds paths the tree normalizes", () => {
    expect(order(["z.ts", "src\\b.ts"])).toEqual(["src\\b.ts", "z.ts"]);
  });
});
