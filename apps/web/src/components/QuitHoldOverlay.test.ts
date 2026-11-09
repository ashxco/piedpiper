import { describe, expect, it } from "vitest";

import { formatQuitShortcutHint } from "./QuitHoldOverlay";

describe("formatQuitShortcutHint", () => {
  it("names the platform shortcut for each mode", () => {
    expect(formatQuitShortcutHint("hold", "MacIntel")).toBe("Hold ⌘Q or press twice to quit");
    expect(formatQuitShortcutHint("double-click", "Linux x86_64")).toBe(
      "Press Ctrl+Q again to quit",
    );
  });
});
