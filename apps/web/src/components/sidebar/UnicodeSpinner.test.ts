import { describe, expect, it, vi } from "vitest";

import { readPrefersReducedMotion, subscribePrefersReducedMotion } from "./UnicodeSpinner";

function fakeMatchMedia(matches: boolean) {
  const query = {
    matches,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  const queries: string[] = [];
  const matchMedia = (q: string) => {
    queries.push(q);
    return query;
  };
  return { matchMedia, query, queries };
}

describe("readPrefersReducedMotion", () => {
  it("reads the reduced-motion media query", () => {
    const fake = fakeMatchMedia(true);
    expect(readPrefersReducedMotion(fake.matchMedia)).toBe(true);
    expect(fake.queries).toEqual(["(prefers-reduced-motion: reduce)"]);
    expect(readPrefersReducedMotion(fakeMatchMedia(false).matchMedia)).toBe(false);
  });

  it("falls back to animating when matchMedia is unavailable or throws", () => {
    expect(readPrefersReducedMotion(null)).toBe(false);
    expect(
      readPrefersReducedMotion(() => {
        throw new Error("unsupported");
      }),
    ).toBe(false);
  });
});

describe("subscribePrefersReducedMotion", () => {
  it("listens for preference changes and cleans up", () => {
    const fake = fakeMatchMedia(false);
    const onChange = vi.fn();
    const unsubscribe = subscribePrefersReducedMotion(onChange, fake.matchMedia);
    expect(fake.query.addEventListener).toHaveBeenCalledWith("change", onChange);
    unsubscribe();
    expect(fake.query.removeEventListener).toHaveBeenCalledWith("change", onChange);
  });

  it("is a no-op without matchMedia", () => {
    expect(() => subscribePrefersReducedMotion(() => {}, null)()).not.toThrow();
  });
});
