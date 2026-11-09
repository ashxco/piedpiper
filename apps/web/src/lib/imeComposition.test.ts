import { describe, expect, it } from "vitest";

import { isImeComposingKeyboardEvent } from "./imeComposition";

describe("isImeComposingKeyboardEvent", () => {
  it("detects composition from isComposing or keyCode 229", () => {
    expect(isImeComposingKeyboardEvent({ isComposing: true, keyCode: 13 })).toBe(true);
    expect(isImeComposingKeyboardEvent({ isComposing: false, keyCode: 229 })).toBe(true);
    expect(isImeComposingKeyboardEvent({ isComposing: false, keyCode: 13 })).toBe(false);
  });
});
