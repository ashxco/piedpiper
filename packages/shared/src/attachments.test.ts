import { describe, expect, it } from "vitest";
import { isProviderSendTurnSupportedImageMimeType } from "./attachments";

describe("isProviderSendTurnSupportedImageMimeType", () => {
  it("accepts provider-supported image types case-insensitively", () => {
    expect(isProviderSendTurnSupportedImageMimeType("image/png")).toBe(true);
    expect(isProviderSendTurnSupportedImageMimeType("IMAGE/JPEG")).toBe(true);
  });

  it("rejects image types providers cannot accept", () => {
    expect(isProviderSendTurnSupportedImageMimeType("image/heic")).toBe(false);
    expect(isProviderSendTurnSupportedImageMimeType("image/bmp")).toBe(false);
    expect(isProviderSendTurnSupportedImageMimeType("image/svg+xml")).toBe(false);
  });
});
