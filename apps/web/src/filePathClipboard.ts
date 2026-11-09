import { isWindowsAbsolutePath } from "@piedpiper/shared/path";

// Git for Windows reports UNC paths with forward slashes (//server/share).
const FORWARD_SLASH_UNC_PATH_PATTERN = /^[\\/]{2}[^\\/]/;

/**
 * A path as it should be copied, in the style of the host holding the file: `hostPath` is its full
 * path there, which can differ from the client's style. Only for copied or shown text, not opening.
 */
export function formatFilePathForClipboard(path: string, hostPath: string = path): string {
  return isWindowsAbsolutePath(hostPath) || FORWARD_SLASH_UNC_PATH_PATTERN.test(hostPath)
    ? path.replaceAll("/", "\\")
    : path;
}

/** Copies a workspace path in its host's style; the toast context carries the same text. */
export function copyWorkspacePath(
  workspacePath: string,
  copy: (value: string, context: { path: string }) => void,
): void {
  const copiedPath = formatFilePathForClipboard(workspacePath);
  copy(copiedPath, { path: copiedPath });
}
