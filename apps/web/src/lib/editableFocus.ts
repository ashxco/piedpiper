const EDITABLE_SELECTOR =
  'input,textarea,select,[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"],[role="textbox"]';

/** Shadow-root key events target their host; inspect the focused descendant as well. */
export function isEditableFocused(target: EventTarget | null = document.activeElement): boolean {
  let element = target instanceof Element ? target : null;
  while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
  return element !== null && element.closest(EDITABLE_SELECTOR) !== null;
}

/**
 * Chromium on Linux pastes the PRIMARY selection into the focused editable on a middle click
 * anywhere unless the mouseup is cancelled, so a middle click on empty chat space would paste
 * into the composer. A middle click on an editable, or on a terminal (xterm takes the paste through
 * its hidden textarea), still pastes there.
 */
export function preventMiddleClickPasteOutsideEditable(event: {
  readonly button: number;
  readonly target: EventTarget | null;
  preventDefault(): void;
}): void {
  if (event.button !== 1 || isEditableFocused(event.target)) return;
  if (event.target instanceof Element && event.target.closest(".xterm") !== null) return;
  event.preventDefault();
}
