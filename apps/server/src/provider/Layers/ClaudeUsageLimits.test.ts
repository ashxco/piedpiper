import { describe, expect, it, vi } from "vitest";

import {
  claudeRateLimitEventToWindows,
  claudeUsageToLimits,
  readClaudeUsage,
  type ClaudeUsageRead,
} from "./ClaudeUsageLimits.ts";

const checkedAt = "2026-01-01T00:00:00.000Z";

const usage = (rate_limits: ClaudeUsageRead["rate_limits"]): ClaudeUsageRead => ({
  rate_limits_available: true,
  rate_limits,
});

describe("claudeUsageToLimits", () => {
  it("reads get_usage percentages as 0-100 and resets as ISO", () => {
    expect(
      claudeUsageToLimits(
        usage({
          seven_day: { utilization: 61, resets_at: "2026-01-05T00:00:00Z" },
          five_hour: { utilization: 0.5, resets_at: null },
        }),
        checkedAt,
      ),
    ).toEqual({
      checkedAt,
      windows: [
        {
          id: "five_hour",
          kind: "session",
          label: "Session",
          windowDurationMins: 300,
          usedPercent: 0.5,
        },
        {
          id: "seven_day",
          kind: "weekly",
          label: "Weekly",
          windowDurationMins: 10_080,
          usedPercent: 61,
          resetsAt: "2026-01-05T00:00:00.000Z",
        },
      ],
    });
  });

  it("tells unsupported accounts apart from failed reads", () => {
    expect(
      claudeUsageToLimits({ rate_limits_available: false, rate_limits: null }, checkedAt)
        .unavailable?.reason,
    ).toBe("unsupported");
    expect(claudeUsageToLimits(usage(null), checkedAt).unavailable?.reason).toBe("probeFailed");
    expect(claudeUsageToLimits(undefined, checkedAt).unavailable?.reason).toBe("probeFailed");
  });

  it("skips windows without a figure and tolerates a malformed model bucket", () => {
    const limits = claudeUsageToLimits(
      usage({
        five_hour: { utilization: null, resets_at: null },
        model_scoped: [{ display_name: "", utilization: 5, resets_at: null }],
      }),
      checkedAt,
    );
    expect(limits).toEqual({ checkedAt, windows: [] });
  });

  it("gives the first model bucket the id streamed events use", () => {
    const limits = claudeUsageToLimits(
      usage({
        model_scoped: [
          { display_name: "Fable", utilization: 20, resets_at: "2026-01-05T00:00:00Z" },
          { display_name: "Big Model", utilization: 30, resets_at: null },
        ],
      }),
      checkedAt,
    );
    expect(limits.windows.map(({ id, label }) => [id, label])).toEqual([
      ["seven_day_big_model", "Weekly · Big Model"],
      ["seven_day_overage_included", "Weekly · Fable"],
    ]);
  });
});

describe("claudeRateLimitEventToWindows", () => {
  it("reads event utilization as 0-1 and resets as epoch seconds", () => {
    expect(
      claudeRateLimitEventToWindows(
        { rateLimitType: "five_hour", utilization: 0.42, resetsAt: 1_767_225_600 },
        undefined,
      ),
    ).toEqual([
      {
        id: "five_hour",
        kind: "session",
        label: "Session",
        windowDurationMins: 300,
        usedPercent: 42,
        resetsAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
  });

  it("drops events without a figure and types with no row", () => {
    expect(claudeRateLimitEventToWindows({ rateLimitType: "seven_day" }, undefined)).toEqual([]);
    expect(claudeRateLimitEventToWindows({ utilization: 0.1 }, undefined)).toEqual([]);
    expect(
      claudeRateLimitEventToWindows({ rateLimitType: "overage", utilization: 0.1 }, undefined),
    ).toEqual([]);
  });

  it("updates the overage bucket only once a read has named it", () => {
    const event = { rateLimitType: "seven_day_overage_included", utilization: 0.9 } as const;
    expect(claudeRateLimitEventToWindows(event, undefined)).toEqual([]);

    const current = claudeUsageToLimits(
      usage({ model_scoped: [{ display_name: "Fable", utilization: 20, resets_at: null }] }),
      checkedAt,
    );
    expect(claudeRateLimitEventToWindows(event, current)).toMatchObject([
      { id: "seven_day_overage_included", label: "Weekly · Fable", usedPercent: 90 },
    ]);
  });
});

describe("readClaudeUsage", () => {
  it("asks without the transcript scan and keeps only the rate limits", async () => {
    const read = vi.fn(async () => ({ ...usage(null), behaviors: null }));

    await expect(
      readClaudeUsage({ usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: read }),
    ).resolves.toEqual(usage(null));
    expect(read).toHaveBeenCalledWith({ skipBehaviors: true });
  });

  it("answers undefined when the read rejects or outlasts its deadline", async () => {
    await expect(
      readClaudeUsage({
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () =>
          Promise.reject(new Error("unsupported")),
      }),
    ).resolves.toBeUndefined();
    await expect(
      readClaudeUsage(
        {
          usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () =>
            new Promise<ClaudeUsageRead>(() => {}),
        },
        5,
      ),
    ).resolves.toBeUndefined();
  });
});

describe("claudeRateLimitEventToWindows without a utilization", () => {
  const current = {
    checkedAt: "2026-01-01T00:00:00.000Z",
    available: true,
    windows: [
      {
        id: "seven_day",
        kind: "weekly",
        label: "Weekly",
        windowDurationMins: 10_080,
        usedPercent: 40,
      },
    ],
  } as never;

  it("treats a rejected window as fully used", () => {
    expect(
      claudeRateLimitEventToWindows({ rateLimitType: "five_hour", status: "rejected" }, undefined),
    ).toMatchObject([{ id: "five_hour", usedPercent: 100 }]);
  });

  it("updates only the reset on a known window", () => {
    expect(
      claudeRateLimitEventToWindows(
        { rateLimitType: "seven_day", status: "allowed", resetsAt: 1_800_000_000 },
        current,
      ),
    ).toMatchObject([
      { id: "seven_day", usedPercent: 40, resetsAt: new Date(1_800_000_000_000).toISOString() },
    ]);
  });

  it("does nothing for a reset on an unknown window", () => {
    expect(
      claudeRateLimitEventToWindows(
        { rateLimitType: "five_hour", status: "allowed", resetsAt: 1_800_000_000 },
        current,
      ),
    ).toEqual([]);
  });
});
