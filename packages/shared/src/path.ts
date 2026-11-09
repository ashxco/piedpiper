export function isWindowsDrivePath(value: string): boolean {
  return /^[a-zA-Z]:([/\\]|$)/.test(value);
}

export function isUncPath(value: string): boolean {
  return value.startsWith("\\\\");
}

export function isWindowsAbsolutePath(value: string): boolean {
  return isUncPath(value) || isWindowsDrivePath(value);
}

export function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || isWindowsAbsolutePath(value);
}

/** Absolute host paths, plus home-relative ones that the server expands. */
export function isHostPath(value: string): boolean {
  return isAbsolutePath(value) || value.startsWith("~/");
}

function isRootPath(value: string): boolean {
  // Bare C: means the current directory on C, not its root; require the drive separator.
  return value === "/" || value === "\\" || /^[a-zA-Z]:[/\\]$/.test(value);
}

function trimTrailingPathSeparators(value: string): string {
  if (value.length === 0 || isRootPath(value)) {
    return value;
  }
  const trimmed = value.startsWith("/")
    ? value.replace(/\/+$/g, "")
    : value.replace(/[\\/]+$/g, "");
  if (trimmed.length === 0) {
    return value;
  }
  return /^[a-zA-Z]:$/.test(trimmed) ? `${trimmed}\\` : trimmed;
}

/** Key for comparing worktree paths that may differ only in separators, trailing slashes or Windows casing. */
export function normalizeWorktreePathForComparison(value: string): string {
  const normalized = trimTrailingPathSeparators(value.trim());
  // Git for Windows reports UNC paths with forward slashes (//server/share).
  const isUnc = /^[\\/]{2}[^\\/]/.test(normalized);
  if (isWindowsDrivePath(normalized) || isUnc) {
    return normalized.replaceAll("/", "\\").toLowerCase();
  }
  return normalized;
}

/**
 * How a picked project icon is saved: workspace-relative when inside, else the picked absolute path.
 * Compares strings only, so pass a real path: a symlink leaving the workspace must stay absolute.
 */
export function toStoredProjectFaviconPath(workspaceRoot: string, pickedPath: string): string {
  const isWindows = isWindowsAbsolutePath(workspaceRoot);
  const normalize = (value: string) =>
    (isWindows ? value.replaceAll("\\", "/") : value).replace(/\/+$/, "");
  const root = normalize(workspaceRoot);
  const picked = normalize(pickedPath);
  const prefix = `${root}/`;
  const isInside = isWindows
    ? picked.toLowerCase().startsWith(prefix.toLowerCase())
    : picked.startsWith(prefix);
  if (!isInside) return pickedPath;
  const relative = picked.slice(prefix.length);
  return relative.split("/").includes("..") ? pickedPath : relative;
}

// Finder, Explorer and shells copy a path ready for a shell: `'/a b'`, `/a\'s\ b`, or `"C:\a b"`.
const QUOTED_PATH_AT_END = /(?:'((?:[^']|'\\'')+)'|"([^"]+)")\s*$/;
const SHELL_ESCAPE = /\\([\s'"\\()[\]{}<>|&;$`!*?#~^=])/g;

/**
 * What a folder box holds after a change. A full path pasted into it replaces the box, even after
 * the text already there, because `~/'/a b'` would name a nested folder.
 */
export function resolvePastedPath(previous: string, next: string): string {
  const isTyping = next.startsWith(previous)
    ? next.length === previous.length + 1
    : previous.startsWith(next);
  if (isTyping) return next;

  const match = QUOTED_PATH_AT_END.exec(next);
  // Text before the quote that wasn't in the box is a search, not a folder to paste after.
  if (match && previous.startsWith(next.slice(0, match.index).trimEnd())) {
    const quoted = match[1]?.replaceAll("'\\''", "'") ?? match[2] ?? "";
    if (isHostPath(quoted)) return quoted;
  }

  // Without a trailing separator, `/a` then `/a/b` is a longer path, not one pasted after a folder.
  const afterFolder = /[/\\]$/.test(previous) && next.startsWith(previous);
  const path = afterFolder ? next.slice(previous.length) : next;
  if (!isHostPath(path)) return next;
  // `\` separates folders in Windows paths, so it only escapes in `/` and `~/` paths.
  return isWindowsAbsolutePath(path) ? path : path.replace(SHELL_ESCAPE, "$1");
}

/** A whole pasted or dropped path, with shell quoting and escaping removed. */
export function unquotePastedPath(value: string): string {
  return resolvePastedPath("", value.trim()).trim();
}
