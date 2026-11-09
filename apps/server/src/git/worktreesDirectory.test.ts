import { describe, expect, it } from "vitest";

import { isPathInsideDirectory, resolveWorktreesDirectory } from "./worktreesDirectory.ts";

const resolve = (configured: string, platform: NodeJS.Platform = "linux") =>
  resolveWorktreesDirectory({
    configured,
    defaultDirectory: "/base/worktrees",
    homeDir: platform === "win32" ? "C:\\Users\\me" : "/home/me",
    platform,
  });

describe("resolveWorktreesDirectory", () => {
  it("keeps the default location when the setting is empty", () => {
    expect(resolve("")).toEqual({ ok: true, directory: "/base/worktrees" });
    expect(resolve("   ")).toEqual({ ok: true, directory: "/base/worktrees" });
  });

  it("expands ~ and normalizes absolute folders", () => {
    expect(resolve("~")).toEqual({ ok: true, directory: "/home/me" });
    expect(resolve("~/worktrees/")).toEqual({ ok: true, directory: "/home/me/worktrees" });
    expect(resolve("/mnt/fast//worktrees")).toEqual({ ok: true, directory: "/mnt/fast/worktrees" });
    expect(resolve("~\\worktrees", "win32")).toEqual({
      ok: true,
      directory: "C:\\Users\\me\\worktrees",
    });
    expect(resolve("D:\\worktrees\\", "win32")).toEqual({ ok: true, directory: "D:\\worktrees" });
  });

  it("rejects relative paths and drive roots with a pointer to Settings", () => {
    for (const [value, platform] of [
      ["worktrees", "linux"],
      ["~other/worktrees", "linux"],
      ["/", "linux"],
      ["D:\\", "win32"],
      ["D:worktrees", "win32"],
    ] as const) {
      const result = resolve(value, platform);
      expect(result.ok, value).toBe(false);
      if (!result.ok) expect(result.detail).toContain("Settings > Git > Worktree location");
    }
  });
});

describe("isPathInsideDirectory", () => {
  it("detects paths at or below the directory only", () => {
    expect(isPathInsideDirectory("/code/app/feature", "/code/app", "linux")).toBe(true);
    expect(isPathInsideDirectory("/code/app", "/code/app/", "linux")).toBe(true);
    expect(isPathInsideDirectory("/code/app-worktrees/feature", "/code/app", "linux")).toBe(false);
    expect(isPathInsideDirectory("/code/..app/feature", "/code", "linux")).toBe(true);
    expect(isPathInsideDirectory("/code", "/code/app", "linux")).toBe(false);
    expect(isPathInsideDirectory("/Code/App/x", "/code/app", "linux")).toBe(false);
    expect(isPathInsideDirectory("/Code/App/x", "/code/app", "darwin")).toBe(true);
    expect(isPathInsideDirectory("C:\\Code\\App\\x", "c:\\code\\app", "win32")).toBe(true);
    expect(isPathInsideDirectory("D:\\code\\app\\x", "C:\\code\\app", "win32")).toBe(false);
  });
});
