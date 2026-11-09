import { describe, expect, it } from "vitest";

import { applyClaudePromptEffortPrefix } from "./model";
import {
  ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
  IMAGE_ONLY_BOOTSTRAP_PROMPT,
  isImageOnlyBootstrapPrompt,
  stripImageOnlyBootstrapPrompt,
} from "./imageOnlyBootstrapPrompt";

describe("isImageOnlyBootstrapPrompt", () => {
  it("recognizes the placeholder with and without the Ultrathink prefix", () => {
    expect(isImageOnlyBootstrapPrompt(IMAGE_ONLY_BOOTSTRAP_PROMPT)).toBe(true);
    expect(isImageOnlyBootstrapPrompt(`ultrathink: ${IMAGE_ONLY_BOOTSTRAP_PROMPT}\n`)).toBe(true);
    expect(
      isImageOnlyBootstrapPrompt(
        applyClaudePromptEffortPrefix(IMAGE_ONLY_BOOTSTRAP_PROMPT, "ultrathink"),
      ),
    ).toBe(true);
  });

  it("rejects real user text", () => {
    expect(isImageOnlyBootstrapPrompt("")).toBe(false);
    expect(isImageOnlyBootstrapPrompt("What is in this image?")).toBe(false);
    expect(isImageOnlyBootstrapPrompt(`${IMAGE_ONLY_BOOTSTRAP_PROMPT} and more`)).toBe(false);
  });
});

describe("stripImageOnlyBootstrapPrompt", () => {
  it("blanks the placeholder with and without the Ultrathink prefix", () => {
    expect(stripImageOnlyBootstrapPrompt(IMAGE_ONLY_BOOTSTRAP_PROMPT)).toBe("");
    expect(stripImageOnlyBootstrapPrompt(`Ultrathink:\n${IMAGE_ONLY_BOOTSTRAP_PROMPT}`)).toBe("");
  });

  it("returns real user text unchanged", () => {
    expect(stripImageOnlyBootstrapPrompt("  fix the header  ")).toBe("  fix the header  ");
    expect(stripImageOnlyBootstrapPrompt(`${IMAGE_ONLY_BOOTSTRAP_PROMPT} and more`)).toBe(
      `${IMAGE_ONLY_BOOTSTRAP_PROMPT} and more`,
    );
  });
});

describe("the attachment-only placeholder", () => {
  it("counts as a placeholder everywhere the image-only one does", () => {
    expect(isImageOnlyBootstrapPrompt(ATTACHMENT_ONLY_BOOTSTRAP_PROMPT)).toBe(true);
    expect(isImageOnlyBootstrapPrompt(`Ultrathink: ${ATTACHMENT_ONLY_BOOTSTRAP_PROMPT}`)).toBe(
      true,
    );
    expect(stripImageOnlyBootstrapPrompt(ATTACHMENT_ONLY_BOOTSTRAP_PROMPT)).toBe("");
  });

  it("does not claim the files are images", () => {
    expect(ATTACHMENT_ONLY_BOOTSTRAP_PROMPT.toLowerCase()).not.toContain("image");
  });
});
