import { describe, expect, it, vi } from "vitest";

import {
  type ComposerPageScrollKeyEvent,
  composerPageScrollDelta,
  resolveComposerPageScrollDirection,
  scrollTimelineByComposerPage,
} from "./composerPageScrollKeys";

function pageKey(overrides: Partial<ComposerPageScrollKeyEvent> = {}): ComposerPageScrollKeyEvent {
  return {
    key: "PageDown",
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    isComposing: false,
    keyCode: 34,
    defaultPrevented: false,
    ...overrides,
  };
}

const fitting = { scrollTop: 0, scrollHeight: 200, clientHeight: 200 };

describe("resolveComposerPageScrollDirection", () => {
  it("maps PageUp and PageDown to timeline directions", () => {
    expect(resolveComposerPageScrollDirection(pageKey({ key: "PageUp" }), fitting)).toBe("up");
    expect(resolveComposerPageScrollDirection(pageKey(), fitting)).toBe("down");
    expect(resolveComposerPageScrollDirection(pageKey(), null)).toBe("down");
  });

  it("ignores other keys and already handled events", () => {
    expect(resolveComposerPageScrollDirection(pageKey({ key: "ArrowDown" }), fitting)).toBeNull();
    expect(
      resolveComposerPageScrollDirection(pageKey({ defaultPrevented: true }), fitting),
    ).toBeNull();
  });

  it("leaves page keys to IME composition", () => {
    expect(resolveComposerPageScrollDirection(pageKey({ isComposing: true }), fitting)).toBeNull();
    expect(resolveComposerPageScrollDirection(pageKey({ keyCode: 229 }), fitting)).toBeNull();
  });

  it.each(["altKey", "ctrlKey", "metaKey", "shiftKey"] as const)(
    "leaves page keys to the editor while %s is held",
    (modifier) => {
      expect(resolveComposerPageScrollDirection(pageKey({ [modifier]: true }), fitting)).toBeNull();
    },
  );

  it("leaves page keys to an overflowing composer until it reaches the edge", () => {
    expect(
      resolveComposerPageScrollDirection(pageKey(), {
        scrollTop: 0,
        scrollHeight: 600,
        clientHeight: 200,
      }),
    ).toBeNull();
    expect(
      resolveComposerPageScrollDirection(pageKey({ key: "PageUp" }), {
        scrollTop: 400,
        scrollHeight: 600,
        clientHeight: 200,
      }),
    ).toBeNull();
    expect(
      resolveComposerPageScrollDirection(pageKey({ key: "PageUp" }), {
        scrollTop: 0.5,
        scrollHeight: 600,
        clientHeight: 200,
      }),
    ).toBe("up");
    expect(
      resolveComposerPageScrollDirection(pageKey(), {
        scrollTop: 399.5,
        scrollHeight: 600,
        clientHeight: 200,
      }),
    ).toBe("down");
  });
});

describe("composerPageScrollDelta", () => {
  it("scrolls about one viewport in the pressed direction", () => {
    expect(composerPageScrollDelta("down", 1000)).toBe(900);
    expect(composerPageScrollDelta("up", 1000)).toBe(-900);
    expect(composerPageScrollDelta("down", 0)).toBe(0);
  });
});

describe("scrollTimelineByComposerPage", () => {
  it("smooth-scrolls the timeline container by one page", () => {
    const scrollBy = vi.fn();
    scrollTimelineByComposerPage({ clientHeight: 500, scrollBy }, "up");
    expect(scrollBy).toHaveBeenCalledWith({ top: -450, behavior: "smooth" });
  });

  it("forwards the scroll behavior, so reduced motion jumps instead of animating", () => {
    const scrollBy = vi.fn();
    scrollTimelineByComposerPage({ clientHeight: 500, scrollBy }, "down", "auto");
    expect(scrollBy).toHaveBeenCalledWith({ top: 450, behavior: "auto" });
  });
});
