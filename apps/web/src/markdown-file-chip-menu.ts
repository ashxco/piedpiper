import type { EditorId } from "@piedpiper/contracts";

import { formatFilePathForClipboard } from "./filePathClipboard";
import { isMacPlatform, isWindowsPlatform } from "./lib/utils";
import { isNetworkPath } from "./markdown-links";

export type FileChipMenuAction = "open" | "reveal" | "copy-relative" | "copy-full";

export function fileManagerRevealLabel(platform: string): string {
  if (isMacPlatform(platform)) return "Reveal in Finder";
  if (isWindowsPlatform(platform)) return "Reveal in File Explorer";
  return "Reveal in Files";
}

/** The right-click menu of a chat file chip, in display order. */
export function fileChipMenuItems(input: {
  canCopyRelative: boolean;
  availableEditors: ReadonlyArray<EditorId>;
  platform: string;
}): Array<{ id: FileChipMenuAction; label: string }> {
  const items: Array<{ id: FileChipMenuAction; label: string }> = [
    { id: "open", label: "Open in editor" },
  ];
  if (input.availableEditors.includes("file-manager")) {
    items.push({ id: "reveal", label: fileManagerRevealLabel(input.platform) });
  }
  if (input.canCopyRelative) {
    items.push({ id: "copy-relative", label: "Copy relative path" });
  }
  items.push({ id: "copy-full", label: "Copy full path" });
  return items;
}

function relativeTo(path: string, cwd: string): string {
  const root = cwd.replace(/[\\/]+$/, "");
  return path.slice(root.length).replace(/^[\\/]+/, "");
}

/** What a chip's copy actions put on the clipboard, in the path style of the host holding the file. */
export function fileChipClipboardPath(
  target: string,
  kind: "relative" | "full",
  cwd: string | undefined,
): string {
  const path = kind === "relative" && cwd ? relativeTo(target, cwd) : target;
  // `file://server/share` parses to `//server/share`, which only the project's own share reaches.
  return formatFilePathForClipboard(path, isNetworkPath(target) && cwd ? cwd : target);
}
