import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { hasCachedUpdate, selectUpdateFile } from "./cachedUpdate";

describe("cached updates", () => {
  it("selects the archive the updater will install, including Rosetta hosts", () => {
    const files = [
      { url: "app-x64.dmg", sha512: "dmg" },
      { url: "app-x64.zip", sha512: "intel" },
      { url: "app-arm64.zip", sha512: "arm" },
    ];
    expect(selectUpdateFile(files, "darwin", "arm64")?.sha512).toBe("arm");
    expect(selectUpdateFile(files, "darwin", "x64")?.sha512).toBe("intel");
    expect(selectUpdateFile(files.slice(0, 2), "darwin", "arm64")?.sha512).toBe("intel");
    expect(selectUpdateFile(files, "win32", "x64")).toBeUndefined();
  });
  it("requires matching metadata and bytes without following a filename outside the cache", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pied-update-"));
    try {
      const sha512 = createHash("sha512").update("archive").digest("base64");
      const file = { url: "app.zip", sha512 };
      const metadata = (fileName: string, hash = sha512) =>
        writeFile(
          path.join(directory, "update-info.json"),
          JSON.stringify({ fileName, sha512: hash }),
        );
      expect(await hasCachedUpdate(directory, file)).toBe(false);
      await metadata("app.zip");
      await writeFile(path.join(directory, "app.zip"), "archive");
      expect(await hasCachedUpdate(directory, file)).toBe(true);
      await metadata("../app.zip");
      expect(await hasCachedUpdate(directory, file)).toBe(false);
      await metadata("app.zip", "old-release");
      expect(await hasCachedUpdate(directory, file)).toBe(false);
      await metadata("app.zip");
      await writeFile(path.join(directory, "app.zip"), "corrupt");
      expect(await hasCachedUpdate(directory, file)).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
