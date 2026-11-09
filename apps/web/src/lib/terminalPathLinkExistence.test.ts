import { describe, expect, it, vi } from "vitest";

import {
  createTerminalPathKindCache,
  filterExistingTerminalPathLinks,
  toCheckableTerminalPath,
} from "./terminalPathLinkExistence";

describe("toCheckableTerminalPath", () => {
  it("strips line and column suffixes from absolute paths", () => {
    expect(toCheckableTerminalPath("/repo/src/a.ts:12:4")).toBe("/repo/src/a.ts");
    expect(toCheckableTerminalPath("C:\\repo\\a.ts:3")).toBe("C:\\repo\\a.ts");
  });

  it("refuses UNC, relative and oversized paths", () => {
    expect(toCheckableTerminalPath("\\\\server\\share\\a.ts")).toBeNull();
    expect(toCheckableTerminalPath("//server/share/a.ts")).toBeNull();
    expect(toCheckableTerminalPath("~/a.ts")).toBeNull();
    expect(toCheckableTerminalPath(`/${"a".repeat(600)}`)).toBeNull();
  });
});

describe("createTerminalPathKindCache", () => {
  it("dedupes concurrent lookups and caches results until the TTL passes", async () => {
    let time = 0;
    const statPath = vi.fn(async (path: string) => (path.endsWith("a.ts") ? "file" : "missing"));
    const cache = createTerminalPathKindCache({ statPath, ttlMs: 1_000, now: () => time });

    const [first, second] = await Promise.all([
      cache.resolve("/repo/a.ts:1"),
      cache.resolve("/repo/a.ts:2:3"),
    ]);
    expect([first, second]).toEqual(["file", "file"]);
    expect(await cache.resolve("/repo/a.ts")).toBe("file");
    expect(statPath).toHaveBeenCalledTimes(1);

    time = 1_500;
    await cache.resolve("/repo/a.ts");
    expect(statPath).toHaveBeenCalledTimes(2);
  });

  it("does not cache failures and reports them as unknown", async () => {
    const statPath = vi
      .fn<(path: string) => Promise<"file" | "directory" | "missing">>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce("directory");
    const cache = createTerminalPathKindCache({ statPath });

    expect(await cache.resolve("/repo")).toBeNull();
    expect(await cache.resolve("/repo")).toBe("directory");
  });

  it("settles a hung lookup to null without caching it, so a later call retries", async () => {
    const statPath = vi.fn(() => new Promise<"file">(() => undefined));
    const cache = createTerminalPathKindCache({ statPath, statTimeoutMs: 10 });

    expect(await cache.resolve("/repo/hung.ts")).toBeNull();
    expect(await cache.resolve("/repo/hung.ts")).toBeNull();
    expect(statPath).toHaveBeenCalledTimes(2);
  });

  it("evicts the oldest entry past the size limit", async () => {
    const statPath = vi.fn(async () => "file" as const);
    const cache = createTerminalPathKindCache({ statPath, maxEntries: 2 });

    await cache.resolve("/a");
    await cache.resolve("/b");
    await cache.resolve("/c");
    await cache.resolve("/a");
    expect(statPath).toHaveBeenCalledTimes(4);
  });
});

describe("filterExistingTerminalPathLinks", () => {
  it("drops only links whose path is missing", async () => {
    const cache = createTerminalPathKindCache({
      statPath: async (path) => (path === "/repo/real.ts" ? "file" : "missing"),
    });
    const links = [
      { text: "https://example.com", path: null },
      { text: "and/or", path: "/repo/and/or" },
      { text: "real.ts:4", path: "/repo/real.ts:4" },
      { text: "~/notes.md", path: "~/notes.md" },
    ];

    const kept = await filterExistingTerminalPathLinks(links, (link) => link.path, cache);

    expect(kept.map((link) => link.text)).toEqual([
      "https://example.com",
      "real.ts:4",
      "~/notes.md",
    ]);
  });
});
