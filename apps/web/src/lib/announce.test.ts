import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface FakeRegion {
  className: string;
  textContent: string;
  dataset: Record<string, string>;
  attributes: Record<string, string>;
  setAttribute: (name: string, value: string) => void;
}

function installFakeDocument() {
  const regions: FakeRegion[] = [];
  const listeners: Record<string, (() => void)[]> = {};
  vi.stubGlobal("document", {
    createElement: () => {
      const region: FakeRegion = {
        className: "",
        textContent: "",
        dataset: {},
        attributes: {},
        setAttribute(name, value) {
          this.attributes[name] = value;
        },
      };
      return region;
    },
    body: { append: (region: FakeRegion) => regions.push(region) },
    addEventListener: (type: string, listener: () => void) => {
      (listeners[type] ??= []).push(listener);
    },
  });
  return {
    regions,
    focusIn: () => listeners.focusin?.forEach((listener) => listener()),
    spoken: () => regions.map((region) => region.textContent).filter(Boolean),
  };
}

describe("announce", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("creates polite live regions up front and speaks once focus settles", async () => {
    const fake = installFakeDocument();
    const { announce, ANNOUNCE_FOCUS_SETTLE_MS } = await import("./announce");

    announce("Switched to Fix login");

    expect(fake.regions).toHaveLength(2);
    expect(fake.regions[0]?.attributes).toEqual({ "aria-live": "polite", "aria-atomic": "true" });
    expect(fake.spoken()).toEqual([]);

    vi.advanceTimersByTime(ANNOUNCE_FOCUS_SETTLE_MS - 1);
    fake.focusIn();
    vi.advanceTimersByTime(ANNOUNCE_FOCUS_SETTLE_MS - 1);
    expect(fake.spoken()).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(fake.spoken()).toEqual(["Switched to Fix login"]);
  });

  it("replaces a pending message from the same source and alternates regions for repeats", async () => {
    const fake = installFakeDocument();
    const { announce, ANNOUNCE_FOCUS_SETTLE_MS } = await import("./announce");

    announce("Switched to A", "thread-switch");
    announce("Switched to B", "thread-switch");
    vi.advanceTimersByTime(ANNOUNCE_FOCUS_SETTLE_MS);
    expect(fake.regions[0]?.textContent).toBe("Switched to B");

    announce("Switched to B", "thread-switch");
    vi.advanceTimersByTime(ANNOUNCE_FOCUS_SETTLE_MS);
    expect(fake.regions[0]?.textContent).toBe("");
    expect(fake.regions[1]?.textContent).toBe("Switched to B");
  });

  it("drops a cancelled message", async () => {
    const fake = installFakeDocument();
    const { announce, cancelAnnouncement, ANNOUNCE_FOCUS_SETTLE_MS } = await import("./announce");

    announce("Model changed", "model");
    cancelAnnouncement("model");
    vi.advanceTimersByTime(ANNOUNCE_FOCUS_SETTLE_MS);

    expect(fake.spoken()).toEqual([]);
  });
});
