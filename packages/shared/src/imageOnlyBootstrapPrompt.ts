/** Sent in place of an empty prompt so the agent can start a turn for an image-only message. */
export const IMAGE_ONLY_BOOTSTRAP_PROMPT =
  "[User attached one or more images without additional text. Respond using the conversation context and the attached image(s).]";

/** The same, for a message whose attachments are not all images, such as a PDF. */
export const ATTACHMENT_ONLY_BOOTSTRAP_PROMPT =
  "[User attached one or more files without additional text. Respond using the conversation context and the attached file(s).]";

const ULTRATHINK_PREFIX_PATTERN = /^Ultrathink:\s*/i;

/** True when `text` is either placeholder, with or without the Claude "Ultrathink:" prefix. */
export function isImageOnlyBootstrapPrompt(text: string): boolean {
  const prompt = text.trim().replace(ULTRATHINK_PREFIX_PATTERN, "");
  return prompt === IMAGE_ONLY_BOOTSTRAP_PROMPT || prompt === ATTACHMENT_ONLY_BOOTSTRAP_PROMPT;
}

/** The text title and branch generation should read: blank for the placeholder, otherwise unchanged. */
export function stripImageOnlyBootstrapPrompt(text: string): string {
  return isImageOnlyBootstrapPrompt(text) ? "" : text;
}
