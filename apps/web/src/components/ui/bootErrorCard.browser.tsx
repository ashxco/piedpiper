import { afterEach, describe, expect, it } from "vitest";

import { showBootError } from "~/lib/bootError";

afterEach(() => {
  document.getElementById("boot-error")?.remove();
  document.getElementById("root")?.remove();
});

describe("showBootError", () => {
  it("moves focus to Reload and makes the app root inert", () => {
    const root = document.createElement("div");
    root.id = "root";
    const stale = document.createElement("button");
    root.append(stale);
    document.body.append(root);
    stale.focus();

    showBootError(new Error("Failed to fetch dynamically imported module"));

    expect(document.activeElement?.textContent).toBe("Reload");
    expect(root.hasAttribute("inert")).toBe(true);
    expect(document.querySelector("#boot-error [role='alert']")?.textContent).toContain(
      "Failed to fetch dynamically imported module",
    );
  });
});
