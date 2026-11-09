import { describe, expect, it } from "vitest";

import { shouldFocusComposerAfterMenuClose } from "./ChatView.composerMenuFocus";

const body = { closest: () => null, matches: () => false };

const area = (mouseFocused: boolean) => ({
  closest: () => null,
  matches: (selector: string) =>
    selector === "[data-workspace-area]:not(:focus-visible)" && mouseFocused,
});

describe("shouldFocusComposerAfterMenuClose", () => {
  it("takes focus when it fell back to the body or nothing", () => {
    expect(shouldFocusComposerAfterMenuClose(body, body)).toBe(true);
    expect(shouldFocusComposerAfterMenuClose(null, body)).toBe(true);
  });

  it.each(["menu-popup", "menu-sub-content", "combobox-popup"])(
    "takes focus from inside a closing %s",
    (slot) => {
      const inside = {
        closest: (selector: string) => (selector.includes(`"${slot}"`) ? {} : null),
        matches: () => false,
      } as unknown as Pick<Element, "closest" | "matches">;
      expect(shouldFocusComposerAfterMenuClose(inside, body)).toBe(true);
    },
  );

  it("leaves focus the user moved elsewhere", () => {
    expect(shouldFocusComposerAfterMenuClose(body, null)).toBe(false);
  });

  it("takes focus from an area container a click focused, but not from a keyboard-focused one", () => {
    expect(shouldFocusComposerAfterMenuClose(area(true), body)).toBe(true);
    expect(shouldFocusComposerAfterMenuClose(area(false), body)).toBe(false);
  });
});
