import type { ServerProvider } from "@piedpiper/contracts";
import { describe, expect, it } from "vitest";

import {
  deriveProviderUsageLimitRows,
  describeProviderUsageLimits,
  readProviderUsageLimits,
} from "./ProviderUsageLimits.logic";

const checkedAt = "2026-01-01T00:00:00.000Z";
const nowMs = Date.parse(checkedAt);

describe("deriveProviderUsageLimitRows", () => {
  it("labels usage and the wait until reset", () => {
    expect(
      deriveProviderUsageLimitRows(
        {
          checkedAt,
          windows: [
            {
              id: "primary",
              label: "Session",
              usedPercent: 41.6,
              resetsAt: "2026-01-01T02:14:00.000Z",
            },
            {
              id: "secondary",
              label: "Weekly",
              usedPercent: 130,
              resetsAt: "2026-01-04T05:00:00.000Z",
            },
            { id: "other", label: "Other", usedPercent: 0 },
          ],
        },
        nowMs,
      ),
    ).toEqual([
      {
        id: "primary",
        label: "Session",
        usedPercent: 41.6,
        usedLabel: "42% used",
        resetLabel: "Resets in 2h 14m",
      },
      {
        id: "secondary",
        label: "Weekly",
        usedPercent: 100,
        usedLabel: "100% used",
        resetLabel: "Resets in 3d 5h",
      },
      { id: "other", label: "Other", usedPercent: 0, usedLabel: "0% used", resetLabel: null },
    ]);
  });

  it("flags a reset that has already passed", () => {
    const [row] = deriveProviderUsageLimitRows(
      {
        checkedAt,
        windows: [{ id: "a", label: "A", usedPercent: 90, resetsAt: "2025-12-31T00:00:00.000Z" }],
      },
      nowMs,
    );
    expect(row?.resetLabel).toBe("Reset since last check");
  });

  it("has no rows without data", () => {
    expect(deriveProviderUsageLimitRows(undefined, nowMs)).toEqual([]);
  });
});

describe("describeProviderUsageLimits", () => {
  it("explains each state without windows", () => {
    expect(describeProviderUsageLimits(undefined)).toBe("No usage data yet.");
    expect(
      describeProviderUsageLimits({
        checkedAt,
        windows: [],
        unavailable: { reason: "unsupported" },
      }),
    ).toBe("This account has no subscription limits to show.");
    expect(
      describeProviderUsageLimits({
        checkedAt,
        windows: [],
        unavailable: { reason: "probeFailed", message: "Codex could not read usage." },
      }),
    ).toBe("Codex could not read usage.");
    expect(
      describeProviderUsageLimits({
        checkedAt,
        windows: [],
        unavailable: { reason: "probeFailed" },
      }),
    ).toBe("Could not read usage limits.");
    expect(describeProviderUsageLimits({ checkedAt, windows: [] })).toBe(
      "No usage limits reported.",
    );
  });

  it("asks a signed-out provider to sign in instead of promising data", () => {
    expect(describeProviderUsageLimits(undefined, "unauthenticated")).toBe(
      "Sign in to see usage limits.",
    );
    expect(describeProviderUsageLimits(undefined, "authenticated")).toBe("No usage data yet.");
    expect(describeProviderUsageLimits(undefined, "unknown")).toBe("No usage data yet.");
  });

  it("describes reported limits the same whatever the auth status", () => {
    expect(describeProviderUsageLimits({ checkedAt, windows: [] }, "unauthenticated")).toBe(
      "No usage limits reported.",
    );
    expect(
      describeProviderUsageLimits(
        { checkedAt, windows: [{ id: "a", label: "A", usedPercent: 1 }] },
        "unauthenticated",
      ),
    ).toBeNull();
  });

  it("adds nothing when rows are shown", () => {
    expect(
      describeProviderUsageLimits({
        checkedAt,
        windows: [{ id: "a", label: "A", usedPercent: 1 }],
      }),
    ).toBeNull();
  });
});

describe("readProviderUsageLimits", () => {
  it("reads limits from the snapshot and tolerates servers without them", () => {
    const provider = { provider: "codex" } as ServerProvider;
    expect(readProviderUsageLimits(provider)).toBeUndefined();
    const usageLimits = { checkedAt, windows: [] };
    expect(readProviderUsageLimits({ ...provider, usageLimits } as unknown as ServerProvider)).toBe(
      usageLimits,
    );
  });
});
