import { describe, expect, it } from "vitest";

import { resolveCompileCacheDir } from "./compileCacheDir";

describe("resolveCompileCacheDir", () => {
  it("uses the per-user temp dir on macOS and Windows", () => {
    expect(
      resolveCompileCacheDir({
        env: {},
        platform: "darwin",
        homeDir: "/Users/test",
        tmpDir: "/var/folders/ab/T",
      }),
    ).toBe("/var/folders/ab/T/piedpiper/compile-cache");
    expect(
      resolveCompileCacheDir({
        env: {},
        platform: "win32",
        homeDir: "C:\\Users\\test",
        tmpDir: "C:\\Users\\test\\AppData\\Local\\Temp",
      }),
    ).toBe("C:\\Users\\test\\AppData\\Local\\Temp\\piedpiper\\compile-cache");
  });

  it("uses XDG_CACHE_HOME or ~/.cache on linux instead of the shared /tmp", () => {
    const base = { platform: "linux" as const, homeDir: "/home/test", tmpDir: "/tmp" };
    expect(resolveCompileCacheDir({ ...base, env: { XDG_CACHE_HOME: "/xdg/cache" } })).toBe(
      "/xdg/cache/piedpiper/compile-cache",
    );
    expect(resolveCompileCacheDir({ ...base, env: { XDG_CACHE_HOME: " " } })).toBe(
      "/home/test/.cache/piedpiper/compile-cache",
    );
  });

  it("stays off under AppImage, whose mount path changes every launch", () => {
    expect(
      resolveCompileCacheDir({
        env: { APPIMAGE: "/home/test/PiedPiper.AppImage" },
        platform: "linux",
        homeDir: "/home/test",
        tmpDir: "/tmp",
      }),
    ).toBeNull();
  });
});
