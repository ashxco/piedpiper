import { describe, expect, it } from "vitest";

import {
  areAllDiffFilesCollapsed,
  buildDiffCollapseScopeKey,
  buildDiffFileCollapseKey,
  expandScopedDiffFile,
  isDiffFileCollapsed,
  resolveCollapsedDiffFileKeys,
  setAllScopedDiffFilesCollapsed,
  toggleScopedDiffFile,
} from "./diffCollapse";

const FILE_KEYS = ["src/app.ts", "src/index.ts"];
const FIRST_FILE_KEY = FILE_KEYS[0]!;

describe("diff collapse controls", () => {
  it("reports whether every rendered file is collapsed", () => {
    expect(areAllDiffFilesCollapsed(FILE_KEYS, new Set(FILE_KEYS))).toBe(true);
    expect(areAllDiffFilesCollapsed(FILE_KEYS, new Set([FIRST_FILE_KEY]))).toBe(false);
    expect(areAllDiffFilesCollapsed([], new Set())).toBe(false);
  });

  it("builds file keys that ignore the parsed cache key", () => {
    expect(buildDiffFileCollapseKey({ name: "b.ts", prevName: "a.ts" })).toBe("a.ts:b.ts");
    expect(buildDiffFileCollapseKey({ name: "b.ts" })).toBe("none:b.ts");
  });

  it("scopes collapse state to the thread and selected turn, not the turn counts", () => {
    expect(buildDiffCollapseScopeKey("thread-1", "turn-2")).toBe("thread-1:turn:turn-2");
    expect(buildDiffCollapseScopeKey("thread-1", null)).toBe("thread-1:conversation");
    expect(buildDiffCollapseScopeKey(null, "turn-2")).toBeNull();
  });

  it("follows the setting until a file is toggled", () => {
    expect(resolveCollapsedDiffFileKeys(null, "scope-a", FILE_KEYS, true)).toEqual(
      new Set(FILE_KEYS),
    );
    expect(resolveCollapsedDiffFileKeys(null, "scope-a", FILE_KEYS, false)).toEqual(new Set());
    const toggled = toggleScopedDiffFile(null, "scope-a", FIRST_FILE_KEY);
    expect(resolveCollapsedDiffFileKeys(toggled, "scope-a", FILE_KEYS, true)).toEqual(
      new Set(["src/index.ts"]),
    );
    // A setting change still applies to the files the user did not touch.
    expect(resolveCollapsedDiffFileKeys(toggled, "scope-a", FILE_KEYS, false)).toEqual(
      new Set([FIRST_FILE_KEY]),
    );
  });

  it("gives files that join a scope after a toggle the default state", () => {
    const toggled = toggleScopedDiffFile(null, "scope-a", FIRST_FILE_KEY);
    expect(isDiffFileCollapsed(toggled, "scope-a", "src/whitespace-only.ts", true)).toBe(true);
    expect(isDiffFileCollapsed(toggled, "scope-a", FIRST_FILE_KEY, true)).toBe(false);
  });

  it("toggles a file back to the default", () => {
    const once = toggleScopedDiffFile(null, "scope-a", FIRST_FILE_KEY);
    const twice = toggleScopedDiffFile(once, "scope-a", FIRST_FILE_KEY);
    expect(isDiffFileCollapsed(twice, "scope-a", FIRST_FILE_KEY, true)).toBe(true);
    expect(once.overrides).toEqual(new Set([FIRST_FILE_KEY]));
  });

  it("collapse and expand all set the scope default, including for later files", () => {
    const collapsed = setAllScopedDiffFilesCollapsed("scope-a", true);
    expect(resolveCollapsedDiffFileKeys(collapsed, "scope-a", FILE_KEYS, false)).toEqual(
      new Set(FILE_KEYS),
    );
    expect(isDiffFileCollapsed(collapsed, "scope-a", "src/new.ts", false)).toBe(true);
    const expanded = setAllScopedDiffFilesCollapsed("scope-a", false);
    expect(resolveCollapsedDiffFileKeys(expanded, "scope-a", FILE_KEYS, true)).toEqual(new Set());
  });

  it("expands a revealed file and keeps the state when it is already expanded", () => {
    const expanded = expandScopedDiffFile(null, "scope-a", FIRST_FILE_KEY, true);
    expect(isDiffFileCollapsed(expanded, "scope-a", FIRST_FILE_KEY, true)).toBe(false);
    expect(isDiffFileCollapsed(expanded, "scope-a", "src/index.ts", true)).toBe(true);
    expect(expandScopedDiffFile(expanded, "scope-a", FIRST_FILE_KEY, true)).toBe(expanded);
    expect(expandScopedDiffFile(null, "scope-a", FIRST_FILE_KEY, false)).toBeNull();
  });

  it("ignores state stored for another scope", () => {
    const toggled = toggleScopedDiffFile(null, "scope-a", FIRST_FILE_KEY);
    expect(isDiffFileCollapsed(toggled, "scope-b", FIRST_FILE_KEY, true)).toBe(true);
    const otherScope = toggleScopedDiffFile(toggled, "scope-b", "src/index.ts");
    expect(otherScope).toEqual({
      scopeKey: "scope-b",
      collapsedByDefault: null,
      overrides: new Set(["src/index.ts"]),
    });
  });
});
