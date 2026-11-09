import { describe, expect, it } from "vitest";

import { isAllowedRendererNavigation } from "./navigationGuard";

const appUrl = "piedpiper://app/index.html";

describe("isAllowedRendererNavigation", () => {
  it.each(["piedpiper://app/index.html", "piedpiper://app/settings?tab=general"])(
    "allows the app's own scheme and host: %s",
    (navigationUrl) => {
      expect(isAllowedRendererNavigation({ navigationUrl, appUrl })).toBe(true);
    },
  );

  it.each([
    "piedpiper://other/index.html",
    "piedpiper:app/index.html",
    "piedpiper://app.evil/index.html",
    "https://app/index.html",
    "file:///etc/passwd",
    "not a url",
    "piedpiper://app:8080/",
    "piedpiper://user@other/",
    "data:text/html,<p>hi</p>",
    "javascript:alert(1)",
    "about:blank",
    "blob:piedpiper://app/0b5e2c4a",
  ])("rejects foreign scheme or host: %s", (navigationUrl) => {
    expect(isAllowedRendererNavigation({ navigationUrl, appUrl })).toBe(false);
  });

  it("never matches an app URL that has no host", () => {
    expect(
      isAllowedRendererNavigation({
        navigationUrl: "data:text/html,other",
        appUrl: "data:text/html,app",
      }),
    ).toBe(false);
  });

  it("allows dev-server navigations only within its origin", () => {
    const devServerUrl = "http://localhost:5733";
    const check = (navigationUrl: string) =>
      isAllowedRendererNavigation({ navigationUrl, appUrl, devServerUrl });
    expect(check("http://localhost:5733/")).toBe(true);
    expect(check("http://localhost:5733/thread/1")).toBe(true);
    expect(check("http://localhost:57330/")).toBe(false);
    expect(check("http://localhost:5733.evil.com/")).toBe(false);
    expect(check("http://localhost:5733@evil.com/")).toBe(false);
    expect(check("https://localhost:5733/")).toBe(false);
  });

  it("respects a dev-server path prefix at a segment boundary", () => {
    const devServerUrl = "http://localhost:5733/app";
    const check = (navigationUrl: string) =>
      isAllowedRendererNavigation({ navigationUrl, appUrl, devServerUrl });
    expect(check("http://localhost:5733/app")).toBe(true);
    expect(check("http://localhost:5733/app/thread")).toBe(true);
    expect(check("http://localhost:5733/application")).toBe(false);
  });

  it("ignores an empty dev-server URL", () => {
    expect(
      isAllowedRendererNavigation({ navigationUrl: "http://localhost/", appUrl, devServerUrl: "" }),
    ).toBe(false);
  });
});
