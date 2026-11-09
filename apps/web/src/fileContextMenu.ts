import { type ContextMenuItem, EDITORS, type EditorId, type NativeApi } from "@piedpiper/contracts";

import { toastManager } from "./components/ui/toast";
import { formatFilePathForClipboard } from "./filePathClipboard";
import { writeTextToClipboard } from "./hooks/useCopyToClipboard";
import { fileManagerRevealLabel } from "./markdown-file-chip-menu";
import { getServerConfig } from "./rpc/serverState";

const FILE_MANAGER_EDITOR_ID = "file-manager" satisfies EditorId;
const OPEN_IN_EDITOR_PREFIX = "open-in:";
const REVEAL_ACTION = "reveal";
const COPY_PATH_ACTION = "copy-path";

export type FileContextMenuAction =
  | { kind: "open"; editor: EditorId }
  | { kind: "reveal" }
  | { kind: "copy-path" };

/** Flat menu (the native menu has no submenus): each editor, the default app, reveal, then copy. */
export function buildFileContextMenuItems(
  availableEditors: ReadonlyArray<EditorId>,
  platform = typeof navigator === "undefined" ? "" : navigator.platform,
): ContextMenuItem[] {
  const available = new Set(availableEditors);
  const items: ContextMenuItem[] = [];
  for (const editor of EDITORS) {
    if (editor.id === FILE_MANAGER_EDITOR_ID || !available.has(editor.id)) continue;
    items.push({ id: `${OPEN_IN_EDITOR_PREFIX}${editor.id}`, label: `Open in ${editor.label}` });
  }
  if (available.has(FILE_MANAGER_EDITOR_ID)) {
    items.push({
      id: `${OPEN_IN_EDITOR_PREFIX}${FILE_MANAGER_EDITOR_ID}`,
      label: "Open with default app",
    });
    items.push({ id: REVEAL_ACTION, label: fileManagerRevealLabel(platform) });
  }
  items.push({ id: COPY_PATH_ACTION, label: "Copy path" });
  return items;
}

export function parseFileContextMenuAction(id: string | null): FileContextMenuAction | null {
  if (id === COPY_PATH_ACTION) return { kind: "copy-path" };
  if (id === REVEAL_ACTION) return { kind: "reveal" };
  if (!id?.startsWith(OPEN_IN_EDITOR_PREFIX)) return null;
  const editorId = id.slice(OPEN_IN_EDITOR_PREFIX.length);
  const editor = EDITORS.find((candidate) => candidate.id === editorId);
  return editor ? { kind: "open", editor: editor.id } : null;
}

function describeFileContextMenuFailure(action: FileContextMenuAction): string {
  switch (action.kind) {
    case "copy-path":
      return "Could not copy path";
    case "reveal":
      return "Could not reveal file";
    case "open": {
      if (action.editor === FILE_MANAGER_EDITOR_ID) return "Could not open file";
      const label = EDITORS.find((editor) => editor.id === action.editor)?.label ?? action.editor;
      return `Could not open in ${label}`;
    }
  }
}

function runFileContextMenuAction(
  api: NativeApi,
  targetPath: string,
  action: FileContextMenuAction,
): Promise<void> {
  switch (action.kind) {
    case "copy-path":
      return writeTextToClipboard(formatFilePathForClipboard(targetPath));
    case "reveal":
      return api.shell.openInEditor(targetPath, FILE_MANAGER_EDITOR_ID, { reveal: true });
    case "open":
      return api.shell.openInEditor(targetPath, action.editor);
  }
}

/** Shows the right-click menu for an absolute file path and runs the chosen action. */
export async function showFileContextMenu(input: {
  api: NativeApi;
  targetPath: string;
  position: { x: number; y: number };
}): Promise<void> {
  // The cached config avoids a websocket round trip before the menu opens.
  const availableEditors =
    getServerConfig()?.availableEditors ?? (await input.api.server.getConfig()).availableEditors;
  const choice = await input.api.contextMenu.show(
    buildFileContextMenuItems(availableEditors),
    input.position,
  );
  const action = parseFileContextMenuAction(choice);
  if (!action) return;
  try {
    await runFileContextMenuAction(input.api, input.targetPath, action);
  } catch (error) {
    toastManager.add({
      type: "error",
      title: describeFileContextMenuFailure(action),
      // The same text the clipboard write used.
      description:
        action.kind === "copy-path"
          ? formatFilePathForClipboard(input.targetPath)
          : input.targetPath,
    });
    throw error;
  }
}
