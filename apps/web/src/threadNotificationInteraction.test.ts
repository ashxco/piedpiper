import { describe, expect, it } from "vitest";

import { threadNotificationRequiresInteraction } from "./threadNotificationInteraction";

describe("threadNotificationRequiresInteraction", () => {
  it("keeps completed notifications up on Windows only", () => {
    expect(threadNotificationRequiresInteraction("completed", "Win32")).toBe(true);
    expect(threadNotificationRequiresInteraction("completed", "MacIntel")).toBe(false);
    expect(threadNotificationRequiresInteraction("completed", "Linux x86_64")).toBe(false);
  });

  it("leaves the other kinds alone on Windows", () => {
    expect(threadNotificationRequiresInteraction("failed", "Win32")).toBe(false);
    expect(threadNotificationRequiresInteraction("approval", "Win32")).toBe(false);
    expect(threadNotificationRequiresInteraction("input", "Win32")).toBe(false);
  });
});
