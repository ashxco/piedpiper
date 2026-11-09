import { describe, expect, it } from "vitest";

import {
  isDiffToggleDisabled,
  resolveHeaderRenameCommit,
  resolveTitleClickAction,
} from "./ChatHeader";

describe("isDiffToggleDisabled", () => {
  it.each([
    [true, false, false],
    [true, true, false],
    [false, false, true],
    [false, true, false],
  ])("isGitRepo=%s diffOpen=%s -> disabled=%s", (isGitRepo, diffOpen, expected) => {
    expect(isDiffToggleDisabled(isGitRepo, diffOpen)).toBe(expected);
  });
});

describe("resolveHeaderRenameCommit", () => {
  it("rejects blank titles", () => {
    expect(resolveHeaderRenameCommit("   ", "Old")).toEqual({ kind: "empty" });
  });

  it("skips unchanged titles after trimming", () => {
    expect(resolveHeaderRenameCommit("  Old ", "Old")).toEqual({ kind: "unchanged" });
  });

  it("renames to the trimmed title", () => {
    expect(resolveHeaderRenameCommit(" New title ", "Old")).toEqual({
      kind: "rename",
      title: "New title",
    });
  });
});

describe("resolveTitleClickAction", () => {
  it("waits on a first mouse click so a double-click can rename instead", () => {
    expect(resolveTitleClickAction({ detail: 1, onChevron: false })).toBe("open-delayed");
  });

  it("ignores the trailing click of a double-click", () => {
    expect(resolveTitleClickAction({ detail: 2, onChevron: false })).toBe("ignore");
    expect(resolveTitleClickAction({ detail: 3, onChevron: true })).toBe("ignore");
  });

  it("opens straight away from the keyboard or the chevron", () => {
    expect(resolveTitleClickAction({ detail: 0, onChevron: false })).toBe("open-now");
    expect(resolveTitleClickAction({ detail: 1, onChevron: true })).toBe("open-now");
  });
});
