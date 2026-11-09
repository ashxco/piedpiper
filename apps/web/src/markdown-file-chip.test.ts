import { describe, expect, it } from "vitest";

import {
  buildFileChipParentSuffixByPath,
  FILE_CHIP_SUFFIX_PROPERTY,
  FILE_CHIP_TRAILING_PROPERTY,
  fileChipMarkdown,
  isPathLikeLinkLabel,
  remarkMarkdownFileChips,
  resolveMarkdownFileChipMeta,
} from "./markdown-file-chip";

const CWD = "/repo/project";

function hProperties(node: object) {
  return (node as { data?: { hProperties?: Record<string, unknown> } }).data?.hProperties;
}

describe("resolveMarkdownFileChipMeta", () => {
  it("splits the position and workspace-relative path", () => {
    expect(resolveMarkdownFileChipMeta("src/a.ts:12:3", CWD)).toEqual({
      targetPath: "/repo/project/src/a.ts:12:3",
      filePath: "/repo/project/src/a.ts",
      basename: "a.ts",
      position: ":12:3",
      relativePath: "src/a.ts:12:3",
      isBareFileName: false,
    });
    expect(resolveMarkdownFileChipMeta("/elsewhere/b.ts", CWD)?.relativePath).toBeNull();
    expect(resolveMarkdownFileChipMeta("ChatView.tsx:4", CWD)?.isBareFileName).toBe(true);
    expect(resolveMarkdownFileChipMeta("https://example.com/a.ts", CWD)).toBeNull();
  });
});

describe("buildFileChipParentSuffixByPath", () => {
  it("adds just enough parent folders to tell same-named files apart", () => {
    const suffixes = buildFileChipParentSuffixByPath([
      "/repo/apps/web/src/index.ts",
      "/repo/apps/server/src/index.ts",
      "/repo/packages/shared/src/lib/deep/index.ts",
      "/repo/README.md",
    ]);
    expect(suffixes.get("/repo/apps/web/src/index.ts")).toBe("web/src");
    expect(suffixes.get("/repo/apps/server/src/index.ts")).toBe("server/src");
    expect(suffixes.get("/repo/packages/shared/src/lib/deep/index.ts")).toBe("lib/deep");
    expect(suffixes.has("/repo/README.md")).toBe(false);
  });

  it("goes deeper when the last two folders collide", () => {
    const suffixes = buildFileChipParentSuffixByPath(["/a/x/src/lib/i.ts", "/b/x/src/lib/i.ts"]);
    expect(suffixes.get("/a/x/src/lib/i.ts")).toBe("a/x/src/lib");
  });
});

describe("isPathLikeLinkLabel", () => {
  const meta = { basename: "a.ts", targetPath: "/repo/project/src/a.ts:3", position: ":3" };
  it("treats spelled-out paths as replaceable and prose as authored", () => {
    expect(isPathLikeLinkLabel("a.ts:3", "src/a.ts:3", meta)).toBe(true);
    expect(isPathLikeLinkLabel("`src/a.ts`", "src/a.ts:3", meta)).toBe(true);
    expect(isPathLikeLinkLabel("the config loader", "src/a.ts:3", meta)).toBe(false);
    expect(isPathLikeLinkLabel("src\\a.ts#L3", "src/a.ts:3", meta)).toBe(true);
    expect(isPathLikeLinkLabel("read/write helpers", "src/a.ts:3", meta)).toBe(false);
    expect(isPathLikeLinkLabel("client/server", "src/a.ts:3", meta)).toBe(false);
  });
});

describe("fileChipMarkdown", () => {
  it("escapes brackets and wraps destinations with spaces", () => {
    expect(fileChipMarkdown("a [b]", "/repo/My File.ts")).toBe("[a \\[b\\]](</repo/My File.ts>)");
  });
});

describe("remarkMarkdownFileChips", () => {
  it("marks file links with their suffix and moves trailing punctuation onto them", () => {
    const first = { type: "link", url: "apps/web/index.ts", children: [] };
    const second = { type: "link", url: "apps/server/index.ts", children: [] };
    const web = { type: "link", url: "https://example.com", children: [] };
    const after = { type: "text", value: "). Done" };
    const tree = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [first, { type: "text", value: " and " }, second, after, web],
        },
      ],
    };
    remarkMarkdownFileChips({ cwd: CWD })(tree);

    expect(hProperties(first)).toEqual({ [FILE_CHIP_SUFFIX_PROPERTY]: "apps/web" });
    expect(hProperties(second)).toEqual({
      [FILE_CHIP_SUFFIX_PROPERTY]: "apps/server",
      [FILE_CHIP_TRAILING_PROPERTY]: ").",
    });
    expect(after.value).toBe(" Done");
    expect(hProperties(web)).toBeUndefined();
  });
});
