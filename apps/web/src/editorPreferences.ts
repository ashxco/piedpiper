import { EDITORS, EditorId, NativeApi } from "@piedpiper/contracts";
import { getLocalStorageItem, setLocalStorageItem, useLocalStorage } from "./hooks/useLocalStorage";
import { useMemo } from "react";

const LAST_EDITOR_KEY = "piedpiper:last-editor";

export function usePreferredEditor(availableEditors: ReadonlyArray<EditorId>) {
  const [lastEditor, setLastEditor] = useLocalStorage(LAST_EDITOR_KEY, null, EditorId);

  const effectiveEditor = useMemo(() => {
    if (lastEditor && availableEditors.includes(lastEditor)) return lastEditor;
    return EDITORS.find((editor) => availableEditors.includes(editor.id))?.id ?? null;
  }, [lastEditor, availableEditors]);

  return [effectiveEditor, setLastEditor] as const;
}

export function resolveAndPersistPreferredEditor(
  availableEditors: readonly EditorId[],
): EditorId | null {
  const availableEditorIds = new Set(availableEditors);
  // Blocked or full storage must not stop the editor from opening; it only loses the preference.
  let stored: EditorId | null = null;
  try {
    stored = getLocalStorageItem(LAST_EDITOR_KEY, EditorId);
  } catch (error) {
    console.warn("Could not read the preferred editor.", error);
  }
  if (stored && availableEditorIds.has(stored)) return stored;
  const editor = EDITORS.find((editor) => availableEditorIds.has(editor.id))?.id ?? null;
  if (editor) {
    try {
      setLocalStorageItem(LAST_EDITOR_KEY, editor, EditorId);
    } catch (error) {
      console.warn("Could not save the preferred editor.", error);
    }
  }
  return editor ?? null;
}

/** `projectRoot` lets JetBrains IDEs open a positioned file in its thread's project. */
export async function openInPreferredEditor(
  api: NativeApi,
  targetPath: string,
  projectRoot?: string,
): Promise<EditorId> {
  const { availableEditors } = await api.server.getConfig();
  const editor = resolveAndPersistPreferredEditor(availableEditors);
  if (!editor) throw new Error("No available editors found.");
  await (projectRoot
    ? api.shell.openInEditor(targetPath, editor, { projectRoot })
    : api.shell.openInEditor(targetPath, editor));
  return editor;
}
