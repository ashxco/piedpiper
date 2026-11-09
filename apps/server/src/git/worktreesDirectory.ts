import * as OS from "node:os";
import * as NodePath from "node:path";

export type WorktreesDirectoryResolution =
  | { readonly ok: true; readonly directory: string }
  | { readonly ok: false; readonly detail: string };

/**
 * Resolves the configured "Worktree location" setting to the folder new worktrees go under.
 * Empty keeps the default; `~` expands to the home folder; anything else must be absolute and
 * must not be a drive or filesystem root.
 */
export function resolveWorktreesDirectory(input: {
  readonly configured: string;
  readonly defaultDirectory: string;
  readonly homeDir?: string;
  readonly platform?: NodeJS.Platform;
}): WorktreesDirectoryResolution {
  const configured = input.configured.trim();
  if (configured.length === 0) {
    return { ok: true, directory: input.defaultDirectory };
  }
  const platform = input.platform ?? process.platform;
  const pathApi = platform === "win32" ? NodePath.win32 : NodePath.posix;
  const homeDir = input.homeDir ?? OS.homedir();
  const expanded =
    configured === "~"
      ? homeDir
      : configured.startsWith("~/") || (platform === "win32" && configured.startsWith("~\\"))
        ? pathApi.join(homeDir, configured.slice(2))
        : configured;
  const invalid = (reason: string): WorktreesDirectoryResolution => ({
    ok: false,
    detail: `Worktree location "${configured}" ${reason}. Change it in Settings > Git > Worktree location.`,
  });
  if (!pathApi.isAbsolute(expanded)) {
    return invalid("is not an absolute folder path");
  }
  const directory = pathApi.normalize(expanded);
  const { root } = pathApi.parse(directory);
  if (stripTrailingSeparators(directory, pathApi) === stripTrailingSeparators(root, pathApi)) {
    return invalid("is a drive root; choose a folder inside it");
  }
  return { ok: true, directory: stripTrailingSeparators(directory, pathApi) };
}

function stripTrailingSeparators(value: string, pathApi: NodePath.PlatformPath): string {
  let end = value.length;
  while (end > 1 && (value[end - 1] === pathApi.sep || value[end - 1] === "/")) end -= 1;
  return value.slice(0, end);
}

/** True when `candidate` is `directory` itself or anywhere below it. */
export function isPathInsideDirectory(
  candidate: string,
  directory: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const pathApi = platform === "win32" ? NodePath.win32 : NodePath.posix;
  // Windows and default macOS volumes compare paths case-insensitively.
  const fold = (value: string) =>
    platform === "win32" || platform === "darwin" ? value.toLowerCase() : value;
  const relative = pathApi.relative(
    fold(pathApi.resolve(directory)),
    fold(pathApi.resolve(candidate)),
  );
  if (relative === "") return true;
  if (pathApi.isAbsolute(relative)) return false;
  return relative !== ".." && !relative.startsWith(`..${pathApi.sep}`);
}
