import { describe, expect, it } from "vitest";

import { resolveStatusColor } from "./officeTheme";

describe("resolveStatusColor", () => {
  it("colors failed seats red in both themes", () => {
    expect(resolveStatusColor("Failed", true, "fallback")).toBe("#fca5a5");
    expect(resolveStatusColor("Failed", false, "fallback")).toBe("#ef4444");
  });

  it("falls back for unknown or missing labels", () => {
    expect(resolveStatusColor(null, true, "fallback")).toBe("fallback");
    expect(resolveStatusColor("Unknown", false, "fallback")).toBe("fallback");
  });
});
