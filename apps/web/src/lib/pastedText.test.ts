import { describe, expect, it } from "vitest";
import { nextPastedTextFileName, shouldAttachPastedText } from "./pastedText";

describe("large text paste", () => {
  it("uses UTF-8 bytes and lets paste-as-text bypass attachment conversion", () => {
    expect(shouldAttachPastedText("x".repeat(32 * 1024), false)).toBe(false);
    expect(shouldAttachPastedText("x".repeat(32 * 1024 + 1), false)).toBe(true);
    expect(shouldAttachPastedText("界".repeat(12_000), false)).toBe(true);
    expect(shouldAttachPastedText("x".repeat(100_000), true)).toBe(false);
  });
  it("chooses a name without colliding with previous pasted files", () => {
    expect(nextPastedTextFileName(["pasted-text.txt", "pasted-text-2.txt"])).toBe(
      "pasted-text-3.txt",
    );
  });
});
