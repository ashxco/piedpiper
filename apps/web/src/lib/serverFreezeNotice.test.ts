import { afterEach, describe, expect, it, vi } from "vitest";

import {
  readLastShownServerFreeze,
  rememberShownServerFreeze,
  serverFreezeNotice,
  serverFreezeNoticeToShow,
} from "./serverFreezeNotice";

const stall = {
  detectedAt: "2026-10-20T07:50:37.633Z",
  durationMs: 12_422,
  loadAverage: 219.4,
  cpuCount: 18,
};

describe("serverFreezeNotice", () => {
  it("blames an overloaded CPU when the load is above the core count", () => {
    expect(serverFreezeNotice(stall)).toEqual({
      title: "The server froze for 12s",
      description: "Its CPU is overloaded (load 219.4 on 18 cores).",
    });
  });

  it("keeps a load just over the core count from reading as equal to it", () => {
    expect(serverFreezeNotice({ ...stall, loadAverage: 8.4, cpuCount: 8 }).description).toBe(
      "Its CPU is overloaded (load 8.4 on 8 cores).",
    );
  });

  it("uses the singular on a one-core host", () => {
    expect(serverFreezeNotice({ ...stall, loadAverage: 3, cpuCount: 1 }).description).toBe(
      "Its CPU is overloaded (load 3.0 on 1 core).",
    );
  });

  it("blames the server when the CPU had room or no load is reported", () => {
    const busy = "Pied Piper's server was too busy to answer.";
    expect(serverFreezeNotice({ ...stall, loadAverage: 18 }).description).toBe(busy);
    const { loadAverage: _load, ...windows } = stall;
    expect(serverFreezeNotice(windows).description).toBe(busy);
  });
});

describe("serverFreezeNoticeToShow", () => {
  it("shows nothing without a stall", () => {
    expect(serverFreezeNoticeToShow(undefined, null)).toBeNull();
  });

  it("shows each stall once, keyed on detectedAt", () => {
    expect(serverFreezeNoticeToShow(stall, null)).toEqual(serverFreezeNotice(stall));
    expect(serverFreezeNoticeToShow({ ...stall }, stall.detectedAt)).toBeNull();
    const later = { ...stall, detectedAt: "2026-10-20T08:00:00.000Z" };
    expect(serverFreezeNoticeToShow(later, stall.detectedAt)).toEqual(serverFreezeNotice(later));
  });
});

const blocked = () => {
  throw new Error("blocked");
};

describe("the last shown freeze", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("survives a reload, so the repeated stall is not shown again", () => {
    const stored = new Map<string, string>();
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
    });
    expect(readLastShownServerFreeze()).toBeNull();

    rememberShownServerFreeze(stall.detectedAt);

    expect(serverFreezeNoticeToShow(stall, readLastShownServerFreeze())).toBeNull();
  });

  it("reads as nothing shown when storage throws", () => {
    vi.stubGlobal("sessionStorage", { getItem: blocked, setItem: blocked });

    expect(() => rememberShownServerFreeze(stall.detectedAt)).not.toThrow();
    expect(readLastShownServerFreeze()).toBeNull();
  });
});
