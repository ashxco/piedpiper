export interface CloseShortcutInput {
  readonly type: string;
  readonly key: string;
  readonly isAutoRepeat: boolean;
  readonly meta: boolean;
  readonly control: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
}

/**
 * Whether an auto-repeated Cmd/Ctrl+W keydown should be swallowed so a held shortcut closes
 * one terminal instead of each one behind it.
 */
export function shouldBlockRepeatedCloseShortcut(
  input: CloseShortcutInput,
  platform: NodeJS.Platform,
): boolean {
  if (input.type !== "keyDown" || !input.isAutoRepeat) return false;
  const modifier = platform === "darwin" ? input.meta : input.control;
  return modifier && !input.alt && !input.shift && input.key.toLowerCase() === "w";
}
