import { createContext, use, type RefObject } from "react";

export interface ComposerMenuFocusTarget {
  focusAtEnd: () => void;
}

/** Provided around the composer; absent elsewhere (settings), where menus keep trigger focus. */
export const ComposerMenuFocusContext =
  createContext<RefObject<ComposerMenuFocusTarget | null> | null>(null);

const COMPOSER_MENU_POPUP_SELECTOR =
  '[data-slot="menu-popup"], [data-slot="menu-sub-content"], [data-slot="combobox-popup"]';

// The popup takes focus a frame after opening, so a quick or starved close finds it on the trigger.
// Only a closed trigger: one whose popup is open just took the focus for its own menu.
const COMPOSER_MENU_CLOSED_TRIGGER_SELECTOR =
  '[data-slot="menu-trigger"]:not([data-popup-open]), [data-slot="combobox-trigger"]:not([data-popup-open])';

/** Focus still in the closing popup, on a closed trigger or dropped to body is ours; anywhere else the user moved it. */
export function shouldFocusComposerAfterMenuClose(
  activeElement: Pick<Element, "closest" | "matches"> | null,
  body: unknown,
): boolean {
  if (activeElement === null || activeElement === body) return true;
  // A click that dismissed the menu focused an area's empty space. `matches`, as `closest` would
  // also catch every control inside the area.
  if (activeElement.matches("[data-workspace-area]:not(:focus-visible)")) return true;
  if (activeElement.matches(COMPOSER_MENU_CLOSED_TRIGGER_SELECTOR)) return true;
  return activeElement.closest(COMPOSER_MENU_POPUP_SELECTOR) !== null;
}

/** `finalFocus` for a composer menu's root popup: the prompt regains focus instead of the trigger. */
export function useComposerMenuFinalFocus(): (() => boolean) | undefined {
  const target = use(ComposerMenuFocusContext);
  if (target === null) return undefined;
  return () => {
    if (shouldFocusComposerAfterMenuClose(document.activeElement, document.body)) {
      // This runs during React's commit, which puts focus back on an element still in the document.
      queueMicrotask(() => target.current?.focusAtEnd());
    }
    return false;
  };
}
