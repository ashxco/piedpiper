import type { SendShortcut } from "@piedpiper/contracts";

import { isMacPlatform } from "~/lib/utils";

export function sendShortcutRequiresModifier(sendShortcut: SendShortcut, prompt: string): boolean {
  return (
    sendShortcut === "mod-enter" ||
    (sendShortcut === "mod-enter-multiline" && /[\r\n]/.test(prompt))
  );
}

/** Whether an Enter keypress in the composer sends; when it does not, Enter inserts a newline. */
export function shouldComposerEnterSend(input: {
  sendShortcut: SendShortcut;
  prompt: string;
  shiftKey: boolean;
  modifierKey: boolean;
}): boolean {
  if (input.shiftKey) return false;
  return !sendShortcutRequiresModifier(input.sendShortcut, input.prompt) || input.modifierKey;
}

export function isComposerModifierKeyPressed(
  event: Pick<KeyboardEvent, "metaKey" | "ctrlKey">,
  platform: string,
): boolean {
  return isMacPlatform(platform) ? event.metaKey : event.ctrlKey;
}
