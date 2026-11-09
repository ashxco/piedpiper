import { describe, expect, it } from "vitest";

import {
  completeProjectPath,
  isBrowsableProjectPath,
  moveProjectPathHighlight,
  stripTrailingPathSeparators,
  visibleProjectPathSuggestions,
} from "./projectPathSuggestions.logic";

describe("isBrowsableProjectPath", () => {
  it("accepts absolute and home paths", () => {
    for (const path of ["/", "/code/a", "~", "~/code", "~\\code", "C:\\code"]) {
      expect(isBrowsableProjectPath(path)).toBe(true);
    }
  });

  it("rejects relative, network, empty and oversized paths", () => {
    for (const path of ["", "code", "./code", "~other", "\\\\host\\s", "//host/s"]) {
      expect(isBrowsableProjectPath(path)).toBe(false);
    }
    expect(isBrowsableProjectPath(`/${"a".repeat(512)}`)).toBe(false);
  });
});

describe("stripTrailingPathSeparators", () => {
  it("strips what an accepted suggestion leaves behind", () => {
    expect(stripTrailingPathSeparators("/code/app/")).toBe("/code/app");
    expect(stripTrailingPathSeparators(" /code/app// ")).toBe("/code/app");
    expect(stripTrailingPathSeparators("~/")).toBe("~");
    expect(stripTrailingPathSeparators("C:\\code\\app\\")).toBe("C:\\code\\app");
  });

  it("keeps roots and paths with no trailing separator", () => {
    expect(stripTrailingPathSeparators("/")).toBe("/");
    expect(stripTrailingPathSeparators("C:\\")).toBe("C:\\");
    expect(stripTrailingPathSeparators("/code/app")).toBe("/code/app");
    expect(stripTrailingPathSeparators("")).toBe("");
  });

  it("treats a POSIX backslash as part of the name", () => {
    expect(stripTrailingPathSeparators("/code/odd\\")).toBe("/code/odd\\");
  });
});

describe("completeProjectPath", () => {
  it("ends with the separator of the path's platform", () => {
    expect(completeProjectPath({ name: "app", fullPath: "/code/app" })).toBe("/code/app/");
    expect(completeProjectPath({ name: "app", fullPath: "C:\\code\\app" })).toBe("C:\\code\\app\\");
  });

  it("keeps a folder name's own surrounding whitespace byte-exact", () => {
    const completed = completeProjectPath({ name: "foo ", fullPath: "/code/foo " });
    expect(completed).toBe("/code/foo /");
    expect(stripTrailingPathSeparators(completed)).toBe("/code/foo ");
  });
});

describe("visibleProjectPathSuggestions", () => {
  const entries = [
    { name: "alpha", fullPath: "/code/alpha" },
    { name: "Alpine", fullPath: "/code/Alpine" },
    { name: "beta", fullPath: "/code/beta" },
  ];
  const listing = { queriedPath: "/code/", entries };

  it("shows a current listing as it is, and nothing without one", () => {
    expect(visibleProjectPathSuggestions(listing, "/code/")).toEqual(entries);
    expect(visibleProjectPathSuggestions(undefined, "/code/")).toEqual([]);
  });

  it("narrows an older listing while a longer name is typed", () => {
    expect(visibleProjectPathSuggestions(listing, "/code/al").map((e) => e.name)).toEqual([
      "alpha",
      "Alpine",
    ]);
    expect(
      visibleProjectPathSuggestions({ queriedPath: "/code/AL", entries }, "/code/alp").length,
    ).toBe(2);
  });

  it("drops an older listing that can't answer the new text", () => {
    expect(visibleProjectPathSuggestions(listing, "/code/alpha/")).toEqual([]);
    expect(visibleProjectPathSuggestions(listing, "/other/")).toEqual([]);
    expect(visibleProjectPathSuggestions({ queriedPath: "/code/al", entries }, "/code/a")).toEqual(
      [],
    );
  });
});

describe("moveProjectPathHighlight", () => {
  it("starts from either end and wraps", () => {
    expect(moveProjectPathHighlight(null, 1, 3)).toBe(0);
    expect(moveProjectPathHighlight(null, -1, 3)).toBe(2);
    expect(moveProjectPathHighlight(2, 1, 3)).toBe(0);
    expect(moveProjectPathHighlight(0, -1, 3)).toBe(2);
  });
});
