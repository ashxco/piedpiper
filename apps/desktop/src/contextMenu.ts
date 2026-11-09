import type { MenuItemConstructorOptions } from "electron";

export interface EditContextMenuParams {
  readonly misspelledWord: string;
  readonly dictionarySuggestions: readonly string[];
  readonly mediaType: string;
  readonly x: number;
  readonly y: number;
  readonly editFlags: {
    readonly canCut: boolean;
    readonly canCopy: boolean;
    readonly canPaste: boolean;
    readonly canSelectAll: boolean;
  };
}

export interface EditContextMenuActions {
  /** The right-clicked link, already vetted as safe to expose, or null. */
  readonly safeLinkUrl: string | null;
  readonly replaceMisspelling: (suggestion: string) => void;
  readonly copyText: (text: string) => void;
  readonly copyImageAt: (x: number, y: number) => void;
}

/** Template for the renderer's native right-click menu (spelling, link/image copy, edit roles). */
export function buildEditContextMenuTemplate(
  params: EditContextMenuParams,
  actions: EditContextMenuActions,
): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = [];

  if (params.misspelledWord) {
    for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
      template.push({ label: suggestion, click: () => actions.replaceMisspelling(suggestion) });
    }
    if (params.dictionarySuggestions.length === 0) {
      template.push({ label: "No suggestions", enabled: false });
    }
    template.push({ type: "separator" });
  }

  const { safeLinkUrl } = actions;
  const copyItems: MenuItemConstructorOptions[] = [];
  if (safeLinkUrl) {
    copyItems.push({ label: "Copy Link", click: () => actions.copyText(safeLinkUrl) });
  }
  if (params.mediaType === "image") {
    copyItems.push({ label: "Copy Image", click: () => actions.copyImageAt(params.x, params.y) });
  }
  if (copyItems.length > 0) {
    template.push(...copyItems, { type: "separator" });
  }

  template.push(
    { role: "cut", enabled: params.editFlags.canCut },
    { role: "copy", enabled: params.editFlags.canCopy },
    { role: "paste", enabled: params.editFlags.canPaste },
    { role: "selectAll", enabled: params.editFlags.canSelectAll },
  );
  return template;
}

/**
 * Converts a renderer-reported position (CSS pixels) into the window points `Menu.popup` expects,
 * or null when it is missing or invalid so the menu opens at the cursor.
 */
export function resolveContextMenuPopupPosition(
  position: { readonly x: number; readonly y: number } | null | undefined,
  zoomFactor: number,
): { x: number; y: number } | null {
  if (
    !position ||
    !Number.isFinite(position.x) ||
    !Number.isFinite(position.y) ||
    position.x < 0 ||
    position.y < 0
  ) {
    return null;
  }
  const zoom = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
  return { x: Math.floor(position.x * zoom), y: Math.floor(position.y * zoom) };
}
