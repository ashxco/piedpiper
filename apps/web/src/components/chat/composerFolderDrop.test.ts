import { describe, expect, it } from "vitest";

import {
  insertComposerPathMentions,
  resolveComposerDroppedPath,
  splitComposerDroppedItems,
  toComposerMentionPath,
} from "./composerFolderDrop";

function item(file: File, isDirectory: boolean) {
  return { kind: "file", getAsFile: () => file, webkitGetAsEntry: () => ({ isDirectory }) };
}

describe("splitComposerDroppedItems", () => {
  it("routes directories to folders and everything else to files", () => {
    const image = new File(["x"], "shot.png", { type: "image/png" });
    const folder = new File([], "src");
    expect(
      splitComposerDroppedItems({
        files: [image, folder],
        items: [item(image, false), item(folder, true), { ...item(image, false), kind: "string" }],
      }),
    ).toEqual({ files: [image], folders: [folder] });
  });

  it("treats every file as a file when items are unavailable", () => {
    const file = new File(["x"], "a.txt");
    expect(splitComposerDroppedItems({ files: [file] })).toEqual({ files: [file], folders: [] });
  });
});

describe("resolveComposerDroppedPath", () => {
  it("returns the bridge path and null in a plain browser", () => {
    const folder = new File([], "src");
    expect(resolveComposerDroppedPath(folder, () => "/repo/src")).toBe("/repo/src");
    expect(resolveComposerDroppedPath(folder, () => "")).toBeNull();
    expect(resolveComposerDroppedPath(folder, undefined)).toBeNull();
  });
});

describe("toComposerMentionPath", () => {
  it("makes paths inside the workspace relative", () => {
    expect(toComposerMentionPath("/repo/src/lib", "/repo")).toBe("src/lib");
    expect(toComposerMentionPath("/repo/src/", "/repo/")).toBe("src");
    expect(toComposerMentionPath("C:\\repo\\src", "C:\\repo")).toBe("src");
    expect(toComposerMentionPath("C:\\repo\\src\\lib\\", "C:\\repo")).toBe("src/lib");
  });

  it("keeps outside, sibling-prefix and root paths absolute", () => {
    expect(toComposerMentionPath("/other/src", "/repo")).toBe("/other/src");
    expect(toComposerMentionPath("/repo-two/src", "/repo")).toBe("/repo-two/src");
    expect(toComposerMentionPath("/repo", "/repo")).toBe("/repo");
    expect(toComposerMentionPath("/repo/src", undefined)).toBe("/repo/src");
  });
});

describe("insertComposerPathMentions", () => {
  it("inserts mentions at the caret with token boundaries", () => {
    expect(insertComposerPathMentions("look at", 7, ["src", "my dir"])).toEqual({
      text: 'look at @src @"my dir" ',
      cursor: 23,
    });
    expect(insertComposerPathMentions("a b", 1, ["src"])).toEqual({ text: "a @src b", cursor: 7 });
    expect(insertComposerPathMentions("", 0, ["src"])).toEqual({ text: "@src ", cursor: 5 });
  });
});
