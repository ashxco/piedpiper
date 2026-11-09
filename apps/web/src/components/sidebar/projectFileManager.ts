import type { EditorId } from "@piedpiper/contracts";

import { isMacPlatform, isWindowsPlatform } from "../../lib/utils";
import { readNativeApi } from "../../nativeApi";
import { toastManager } from "../ui/toast";

const FILE_MANAGER_EDITOR_ID = "file-manager" satisfies EditorId;

export function fileManagerOpenLabel(platform: string): string {
  if (isMacPlatform(platform)) return "Open in Finder";
  if (isWindowsPlatform(platform)) return "Open in File Explorer";
  return "Open in Files";
}

export function hasFileManager(availableEditors: ReadonlyArray<EditorId>): boolean {
  return availableEditors.includes(FILE_MANAGER_EDITOR_ID);
}

/** Opens the folder itself, so no reveal; callers fire this with `void`, so failures toast here. */
export async function openProjectInFileManager(cwd: string): Promise<void> {
  const api = readNativeApi();
  if (!api) return;
  try {
    await api.shell.openInEditor(cwd, FILE_MANAGER_EDITOR_ID);
  } catch (error) {
    toastManager.add({
      type: "error",
      title: "Unable to open project folder",
      description: error instanceof Error ? error.message : "An error occurred.",
    });
  }
}
