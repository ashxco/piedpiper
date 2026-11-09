import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from "@piedpiper/contracts";

/** Rejects provider input the server would refuse, so the draft survives instead of a failed turn. */
export function getComposerPromptLengthValidationMessage(providerInput: string): string | null {
  const excessCharacters = providerInput.trim().length - PROVIDER_SEND_TURN_MAX_INPUT_CHARS;
  if (excessCharacters <= 0) return null;

  const characterLabel = excessCharacters === 1 ? "character" : "characters";
  return `Prompt is ${excessCharacters.toLocaleString("en-US")} ${characterLabel} over the ${PROVIDER_SEND_TURN_MAX_INPUT_CHARS.toLocaleString("en-US")}-character limit. Shorten or split it before sending.`;
}
