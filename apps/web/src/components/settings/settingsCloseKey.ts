import { isImeComposingKeyboardEvent } from "../../lib/imeComposition";

/** Escape closes settings unless a control handled it or an IME is cancelling a composition. */
export function isSettingsCloseKey(
  event: Pick<KeyboardEvent, "defaultPrevented" | "key" | "isComposing" | "keyCode">,
): boolean {
  return event.key === "Escape" && !event.defaultPrevented && !isImeComposingKeyboardEvent(event);
}
