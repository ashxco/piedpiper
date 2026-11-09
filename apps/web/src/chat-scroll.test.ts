import { describe, expect, it } from "vitest";

import {
  AUTO_SCROLL_BOTTOM_THRESHOLD_PX,
  getSmoothScrollBehavior,
  isScrollContainerNearBottom,
} from "./chat-scroll";

describe("isScrollContainerNearBottom", () => {
  it("returns true when already at bottom", () => {
    expect(
      isScrollContainerNearBottom({
        scrollTop: 600,
        clientHeight: 400,
        scrollHeight: 1_000,
      }),
    ).toBe(true);
  });

  it("returns true when within the auto-scroll threshold", () => {
    expect(
      isScrollContainerNearBottom({
        scrollTop: 540,
        clientHeight: 400,
        scrollHeight: 1_000,
      }),
    ).toBe(true);
  });

  it("returns false when the user is meaningfully above the bottom", () => {
    expect(
      isScrollContainerNearBottom({
        scrollTop: 520,
        clientHeight: 400,
        scrollHeight: 1_000,
      }),
    ).toBe(false);
  });

  it("clamps negative thresholds to zero", () => {
    expect(
      isScrollContainerNearBottom(
        {
          scrollTop: 539,
          clientHeight: 400,
          scrollHeight: 1_000,
        },
        -1,
      ),
    ).toBe(false);
  });

  it("falls back to the default threshold for non-finite values", () => {
    expect(
      isScrollContainerNearBottom(
        {
          scrollTop: 540,
          clientHeight: 400,
          scrollHeight: 1_000,
        },
        Number.NaN,
      ),
    ).toBe(true);
    expect(AUTO_SCROLL_BOTTOM_THRESHOLD_PX).toBe(64);
  });
});

describe("getSmoothScrollBehavior", () => {
  it("returns auto when reduced motion is requested", () => {
    const queries: string[] = [];
    const behavior = getSmoothScrollBehavior((query) => {
      queries.push(query);
      return { matches: true };
    });
    expect(behavior).toBe("auto");
    expect(queries).toEqual(["(prefers-reduced-motion: reduce)"]);
  });

  it("returns smooth when reduced motion is not requested", () => {
    expect(getSmoothScrollBehavior(() => ({ matches: false }))).toBe("smooth");
  });

  it("falls back to smooth when matchMedia is unavailable or throws", () => {
    expect(getSmoothScrollBehavior(null)).toBe("smooth");
    expect(
      getSmoothScrollBehavior(() => {
        throw new Error("unsupported");
      }),
    ).toBe("smooth");
  });
});
