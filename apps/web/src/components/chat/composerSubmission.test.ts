import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from "@piedpiper/contracts";
import { describe, expect, it } from "vitest";

import { getComposerPromptLengthValidationMessage } from "./composerSubmission";

describe("getComposerPromptLengthValidationMessage", () => {
  it("allows input at the provider limit", () => {
    expect(
      getComposerPromptLengthValidationMessage("x".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS)),
    ).toBeNull();
  });

  it("ignores surrounding whitespace the provider trims", () => {
    expect(
      getComposerPromptLengthValidationMessage(
        `  ${"x".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS)}\n\n`,
      ),
    ).toBeNull();
  });

  it("reports a single character over the limit", () => {
    expect(
      getComposerPromptLengthValidationMessage("x".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS + 1)),
    ).toBe(
      "Prompt is 1 character over the 120,000-character limit. Shorten or split it before sending.",
    );
  });

  it("formats larger overages with separators", () => {
    expect(
      getComposerPromptLengthValidationMessage(
        "x".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS + 1_500),
      ),
    ).toBe(
      "Prompt is 1,500 characters over the 120,000-character limit. Shorten or split it before sending.",
    );
  });
});
