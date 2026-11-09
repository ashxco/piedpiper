import { describe, expect, it } from "vitest";

import {
  makeUnavailableUsageLimits,
  makeUsageLimits,
  mergeUsageLimitsUpdate,
  resolveUsageLimitsAfterProbe,
  type ProviderUsageWindow,
} from "./providerUsageLimits";

const checkedAt = "2026-01-01T00:00:00.000Z";
const session: ProviderUsageWindow = {
  id: "five_hour",
  kind: "session",
  label: "Session",
  usedPercent: 10,
  resetsAt: "2026-01-01T05:00:00.000Z",
  windowDurationMins: 300,
};
const weekly: ProviderUsageWindow = {
  id: "seven_day",
  kind: "weekly",
  label: "Weekly",
  usedPercent: 50,
};

describe("makeUsageLimits", () => {
  it("orders windows by kind", () => {
    expect(
      makeUsageLimits({ checkedAt, windows: [weekly, session] }).windows.map(({ id }) => id),
    ).toEqual(["five_hour", "seven_day"]);
  });
});

describe("mergeUsageLimitsUpdate", () => {
  const previous = makeUsageLimits({ checkedAt, windows: [session, weekly] });
  const nextAt = "2026-01-01T01:00:00.000Z";

  it("updates one window by id, leaves others and keeps its known reset", () => {
    const merged = mergeUsageLimitsUpdate({
      previous,
      checkedAt: nextAt,
      windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent: 140 }],
    });
    expect(merged?.checkedAt).toBe(nextAt);
    expect(merged?.windows).toEqual([{ ...session, usedPercent: 100 }, weekly]);
  });

  it("clears a failed read once a live update reports a window", () => {
    const merged = mergeUsageLimitsUpdate({
      previous: makeUnavailableUsageLimits({ checkedAt, reason: "probeFailed" }),
      checkedAt: nextAt,
      windows: [weekly],
    });
    expect(merged).toEqual({ checkedAt: nextAt, windows: [weekly] });
  });

  it("leaves an unsupported account unsupported", () => {
    const unsupported = makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
    expect(
      mergeUsageLimitsUpdate({ previous: unsupported, checkedAt: nextAt, windows: [weekly] }),
    ).toBe(unsupported);
  });

  it("treats an empty update as no change", () => {
    expect(mergeUsageLimitsUpdate({ previous, checkedAt: nextAt, windows: [] })).toBe(previous);
  });
});

describe("resolveUsageLimitsAfterProbe", () => {
  const good = makeUsageLimits({ checkedAt, windows: [session] });
  const failed = makeUnavailableUsageLimits({ checkedAt, reason: "probeFailed" });
  const unsupported = makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });

  it("keeps good windows through a failed read", () => {
    expect(resolveUsageLimitsAfterProbe({ published: good, probed: failed })).toBe(good);
  });

  it("lets a good read, unsupported or nothing replace them", () => {
    const fresh = makeUsageLimits({ checkedAt, windows: [weekly] });
    expect(resolveUsageLimitsAfterProbe({ published: good, probed: fresh })).toBe(fresh);
    expect(resolveUsageLimitsAfterProbe({ published: good, probed: unsupported })).toBe(
      unsupported,
    );
    expect(resolveUsageLimitsAfterProbe({ published: good, probed: undefined })).toBeUndefined();
  });

  it("reports a failure when there is nothing good to keep", () => {
    expect(resolveUsageLimitsAfterProbe({ published: undefined, probed: failed })).toBe(failed);
    expect(resolveUsageLimitsAfterProbe({ published: unsupported, probed: failed })).toBe(failed);
  });
});
