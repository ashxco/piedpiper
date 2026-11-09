import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

type ReleaseFile = { url: string; sha512: string };

export function selectUpdateFile(
  files: unknown,
  platform: NodeJS.Platform,
  hostArch: string,
): ReleaseFile | undefined {
  if (!Array.isArray(files)) return;
  let candidates = files.filter(
    (file): file is ReleaseFile =>
      file !== null &&
      typeof file === "object" &&
      typeof file.url === "string" &&
      typeof file.sha512 === "string",
  );
  if (platform === "darwin") {
    const arm64 = hostArch === "arm64" && candidates.some((file) => file.url.includes("arm64"));
    candidates = candidates.filter((file) => file.url.includes("arm64") === arm64);
  }
  // Match electron-updater's first supported file, including its macOS architecture filtering.
  const extension = platform === "darwin" ? ".zip" : platform === "win32" ? ".exe" : ".appimage";
  return candidates.find((file) => file.url.toLowerCase().endsWith(extension));
}

/** A cache miss must not turn an update check into an unsolicited download. */
export async function hasCachedUpdate(directory: string, file: ReleaseFile): Promise<boolean> {
  try {
    const info: unknown = JSON.parse(
      await readFile(path.join(directory, "update-info.json"), "utf8"),
    );
    if (
      !info ||
      typeof info !== "object" ||
      !("fileName" in info) ||
      !("sha512" in info) ||
      typeof info.fileName !== "string" ||
      info.fileName.length === 0 ||
      path.basename(info.fileName) !== info.fileName ||
      info.sha512 !== file.sha512
    )
      return false;
    const hash = createHash("sha512");
    for await (const chunk of createReadStream(path.join(directory, info.fileName)))
      hash.update(chunk);
    return hash.digest("base64") === file.sha512;
  } catch {
    return false;
  }
}
