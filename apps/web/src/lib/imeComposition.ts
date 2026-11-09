/**
 * True while an IME (Chinese, Japanese, Korean input) is composing, so Enter only confirms a
 * candidate. keyCode 229 is how some browsers flag composition keydowns without isComposing.
 * From a React handler pass `event.nativeEvent`, since React's KeyboardEvent has no isComposing.
 */
export function isImeComposingKeyboardEvent(
  event: Pick<KeyboardEvent, "isComposing" | "keyCode">,
): boolean {
  return event.isComposing || event.keyCode === 229;
}
