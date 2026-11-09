import { applyClaudePromptEffortPrefix } from "@piedpiper/shared/model";
import { describe, expect, it } from "vitest";

import {
  IMAGE_ONLY_BOOTSTRAP_PROMPT,
  isImageOnlyBootstrapPrompt,
} from "./imageOnlyBootstrapPrompt";

describe("isImageOnlyBootstrapPrompt", () => {
  it("recognizes the placeholder with and without the Ultrathink prefix", () => {
    expect(isImageOnlyBootstrapPrompt(IMAGE_ONLY_BOOTSTRAP_PROMPT)).toBe(true);
    expect(isImageOnlyBootstrapPrompt(`Ultrathink:\n${IMAGE_ONLY_BOOTSTRAP_PROMPT}`)).toBe(true);
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
