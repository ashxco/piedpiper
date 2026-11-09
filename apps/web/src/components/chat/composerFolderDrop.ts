import { serializeComposerMentionPath } from "../../composer-editor-mentions";

export interface ComposerDropDataTransfer {
  readonly files: Iterable<File> | ArrayLike<File>;
  readonly items?: Iterable<{
    readonly kind: string;
    getAsFile(): File | null;
    webkitGetAsEntry(): { readonly isDirectory: boolean } | null;
  }>;
}

/** Separates dropped folders from files; must run during the drop event while items are readable. */
export function splitComposerDroppedItems(dataTransfer: ComposerDropDataTransfer): {
  files: File[];
  folders: File[];
} {
  if (dataTransfer.items === undefined) {
    return { files: Array.from(dataTransfer.files), folders: [] };
  }
  const files: File[] = [];
  const folders: File[] = [];
  for (const item of dataTransfer.items) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file === null) continue;
    if (item.webkitGetAsEntry()?.isDirectory === true) {
      folders.push(file);
    } else {
      files.push(file);
    }
  }
  return { files, folders };
}

/** The dropped item's absolute path, or null outside the desktop app (the bridge returns ""). */
export function resolveComposerDroppedPath(
  file: File,
  getPathForFile: ((file: File) => string) | undefined,
): string | null {
  const path = getPathForFile?.(file);
  return typeof path === "string" && path.length > 0 ? path : null;
}

/** Paths inside the workspace become relative, matching mentions picked from the @ menu. */
export function toComposerMentionPath(absolutePath: string, workspaceCwd: string | undefined) {
  if (!workspaceCwd) return absolutePath;
  const root = workspaceCwd.replace(/[\\/]+$/, "");
  if (root.length === 0 || !absolutePath.startsWith(root)) return absolutePath;
  const separator = absolutePath.charAt(root.length);
  if (separator !== "/" && separator !== "\\") return absolutePath;
  // Mentions from the @ menu are POSIX paths, so Windows separators are normalized.
  const relative = absolutePath
    .slice(root.length + 1)
    .replace(/[\\/]+$/, "")
    .replaceAll("\\", "/");
  return relative.length > 0 ? relative : absolutePath;
}

/** Inserts `@path` mentions at the caret, padded with spaces so each stays a separate token. */
export function insertComposerPathMentions(
  text: string,
  cursor: number,
  paths: ReadonlyArray<string>,
): { text: string; cursor: number } {
  const safeCursor = Math.max(0, Math.min(text.length, cursor));
  const before = text.slice(0, safeCursor);
  const after = text.slice(safeCursor);
  const mentions = paths.map((path) => `@${serializeComposerMentionPath(path)}`).join(" ");
  const leading = before.length > 0 && !/\s$/.test(before) ? " " : "";
  const insertion = `${leading}${mentions} `;
  const trimmedAfter = after.startsWith(" ") ? after.slice(1) : after;
  return {
    text: `${before}${insertion}${trimmedAfter}`,
    cursor: before.length + insertion.length,
  };
}
