import { describe, expect, it } from "vitest";

import { describeUnknownSdkMessage, previewUnknownSdkContent } from "./unknownSdkMessagePreview.ts";

describe("describeUnknownSdkMessage", () => {
  it("lists readable scalar fields and skips identity keys and nested values", () => {
    const message = {
      type: "system",
      subtype: "notification",
      uuid: "u-1",
      session_id: "s-1",
      text: "  Model fell back\n to a safer mode ",
      retryable: false,
      attempt: 2,
      nested: { ignored: true },
    };
    expect(describeUnknownSdkMessage("Claude system message 'notification'", message)).toBe(
      "Claude system message 'notification' - text: Model fell back to a safer mode; retryable: false; attempt: 2",
    );
  });

  it("says when nothing displayable arrived", () => {
    expect(describeUnknownSdkMessage("Claude SDK message 'x'", { type: "x", uuid: "u" })).toBe(
      "Claude SDK message 'x' (no displayable text content)",
    );
    expect(previewUnknownSdkContent(null)).toBeUndefined();
  });

  it("caps long previews", () => {
    const preview = previewUnknownSdkContent({ text: "a".repeat(400) });
    expect(preview?.length).toBe(280);
    expect(preview?.endsWith("...")).toBe(true);
  });
});

describe("previewUnknownSdkContent truncation", () => {
  it("never cuts the preview inside an emoji at the length limit", () => {
    const preview = previewUnknownSdkContent({ text: `${"a".repeat(270)}😀${"b".repeat(10)}` });
    expect(preview).toBe(`text: ${"a".repeat(270)}...`);
  });
});
