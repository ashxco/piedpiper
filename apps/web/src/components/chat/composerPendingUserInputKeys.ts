// Kept free of the panel's Markdown imports so the shortcut logic tests without a DOM.

/**
 * Map a keydown to a question option index: a-z or 1-9, only for a single
 * printable character with no modifier held. Returns null when the key is not a
 * shortcut or the option does not exist.
 */
export function resolvePendingUserInputShortcutIndex(
  event: Pick<globalThis.KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey">,
  optionCount: number,
): number | null {
  // Shift is allowed: layouts like AZERTY produce digits on the shifted row.
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  if (typeof event.key !== "string" || event.key.length !== 1) return null;
  const key = event.key.toLowerCase();
  let optionIndex: number;
  if (key >= "a" && key <= "z") {
    optionIndex = key.charCodeAt(0) - 97;
  } else if (key >= "1" && key <= "9") {
    optionIndex = key.charCodeAt(0) - 49;
  } else {
    return null;
  }
  return optionIndex < optionCount ? optionIndex : null;
}

/**
 * True when the key event originated in a text input, textarea, select, editable
 * region, or a widget with its own typeahead (menu, listbox, combobox, dialog).
 */
export function isPendingUserInputTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  ) {
    return true;
  }
  return (
    target.closest(
      '[contenteditable]:not([contenteditable="false"]),[role="menu"],[role="listbox"],[role="combobox"],[role="dialog"],[role="alertdialog"]',
    ) !== null
  );
}
