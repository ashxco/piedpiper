import { describe, expect, it } from "vitest";

import { isSettingsPathname } from "./settingsRoute";

describe("isSettingsPathname", () => {
  it("matches the settings route and its children", () => {
    expect(isSettingsPathname("/settings")).toBe(true);
    expect(isSettingsPathname("/settings/")).toBe(true);
    expect(isSettingsPathname("/settings/general")).toBe(true);
    expect(isSettingsPathname("/settings/archived")).toBe(true);
  });

  it("does not match other routes", () => {
    expect(isSettingsPathname("/")).toBe(false);
    expect(isSettingsPathname("/settingsx")).toBe(false);
    expect(isSettingsPathname("/thread-1")).toBe(false);
    expect(isSettingsPathname("/virtual-office/settings")).toBe(false);
  });
});
