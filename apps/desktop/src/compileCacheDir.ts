import * as Path from "node:path";

/**
 * Where Node's on-disk V8 compile cache lives, or null when it must stay off. Linux uses the user's
 * cache dir because /tmp is shared between users; the macOS and Windows temp dirs are per user.
 * AppImage remounts the app at a new /tmp/.mount_* path each launch, and Node keys entries by path,
 * so every launch would miss and leave another copy behind.
 */
export function resolveCompileCacheDir(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly homeDir: string;
  readonly tmpDir: string;
}): string | null {
  if (input.env.APPIMAGE) return null;
  const pathApi = input.platform === "win32" ? Path.win32 : Path.posix;
  const cacheRoot =
    input.platform === "linux"
      ? input.env.XDG_CACHE_HOME?.trim() || pathApi.join(input.homeDir, ".cache")
      : input.tmpDir;
  return pathApi.join(cacheRoot, "piedpiper", "compile-cache");
}
