import { describe, expect, it, vi } from "vitest";

import {
  COARSE_JUST_NOW_MS,
  formatDayAwareTimestamp,
  formatRelativeElapsed,
  formatRelativeTime,
  formatRelativeTimeLabel,
  formatShortTimestamp,
  formatTimestamp,
  getTimestampFormatOptions,
  msUntilNextLocalDay,
  msUntilRelativeTimeChange,
  parseTimestampDate,
  relativeTimeElapsedMs,
  resolveTimestampLocale,
  startOfLocalDayMs,
  subscribeToLocalDayChanges,
  subscribeToRelativeTimeChanges,
} from "./timestampFormat";

describe("resolveTimestampLocale", () => {
  it("defers to the runtime default when the host reports no locale", () => {
    expect(resolveTimestampLocale(null)).toBeUndefined();
    expect(resolveTimestampLocale(undefined)).toBeUndefined();
    expect(resolveTimestampLocale("   ")).toBeUndefined();
  });

  it("uses a tag the host reports", () => {
    expect(resolveTimestampLocale("en-GB")).toBe("en-GB");
    expect(resolveTimestampLocale(" en-NL-u-hc-h23 ")).toBe("en-NL-u-hc-h23");
  });

  it("defers to the runtime default instead of throwing on a tag Intl rejects", () => {
    expect(resolveTimestampLocale("not a locale")).toBeUndefined();
    expect(resolveTimestampLocale("en_GB")).toBeUndefined();
  });

  it("gives the host's hour cycle under the locale setting and lets explicit ones win", () => {
    const format = (tag: string, timestampFormat: "locale" | "12-hour" | "24-hour") =>
      new Intl.DateTimeFormat(resolveTimestampLocale(tag), {
        ...getTimestampFormatOptions(timestampFormat, false),
        timeZone: "UTC",
      })
        .format(new Date("2026-04-07T15:44:00.000Z"))
        // ICU separates the day period with a narrow no-break space.
        .replace(/\u202f/g, " ");

    expect(format("en-GB", "locale")).toBe("15:44");
    expect(format("en-US", "locale")).toBe("3:44 PM");
    expect(format("en-US-u-hc-h23", "locale")).toBe("15:44");
    expect(format("en-GB-u-hc-h12", "locale").toLowerCase()).toBe("3:44 pm");
    expect(format("en-US-u-hc-h23", "12-hour")).toBe("3:44 PM");
    expect(format("en-GB-u-hc-h12", "24-hour")).toBe("15:44");
  });
});

describe("host system locale", () => {
  const loadWithLocale = async (getSystemLocale: () => string | null) => {
    vi.stubGlobal("window", { desktopBridge: { getSystemLocale } });
    vi.resetModules();
    try {
      return await import("./timestampFormat");
    } finally {
      vi.unstubAllGlobals();
    }
  };

  it("uses it for both the numeric date and the wall-clock time", async () => {
    const { formatDayAwareTimestamp: format, timestampLocale } = await loadWithLocale(
      () => "en-GB",
    );
    expect(timestampLocale).toBe("en-GB");
    const now = new Date(2026, 7, 14, 12, 0).getTime();
    expect(format(new Date(2026, 7, 12, 15, 44).toISOString(), "locale", now)).toBe("12/08 15:44");
  });

  it("falls back when the bridge throws or reports nothing", async () => {
    const thrown = await loadWithLocale(() => {
      throw new Error("ipc gone");
    });
    expect(thrown.timestampLocale).toBeUndefined();
    const empty = await loadWithLocale(() => null);
    expect(empty.timestampLocale).toBeUndefined();
  });
});

describe("getTimestampFormatOptions", () => {
  it("omits hour12 when locale formatting is requested", () => {
    expect(getTimestampFormatOptions("locale", true)).toEqual({
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
    });
  });

  it("builds a 12-hour formatter with seconds when requested", () => {
    expect(getTimestampFormatOptions("12-hour", true)).toEqual({
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
    });
  });

  it("builds a 24-hour formatter without seconds when requested", () => {
    expect(getTimestampFormatOptions("24-hour", false)).toEqual({
      hour: "numeric",
      minute: "2-digit",
      hour12: false,
    });
  });
});

describe("invalid timestamps", () => {
  const invalid = ["", "not-a-date", "2026-13-45T99:99:99Z"];

  it("parseTimestampDate returns null for unparseable input and a Date otherwise", () => {
    for (const value of invalid) {
      expect(parseTimestampDate(value)).toBeNull();
    }
    expect(parseTimestampDate("2026-01-02T03:04:05.000Z")?.toISOString()).toBe(
      "2026-01-02T03:04:05.000Z",
    );
  });

  it("formatters return empty strings instead of throwing or rendering NaN", () => {
    for (const value of invalid) {
      expect(formatTimestamp(value, "24-hour")).toBe("");
      expect(formatShortTimestamp(value, "12-hour")).toBe("");
      expect(formatRelativeTime(value)).toEqual({ value: "", suffix: null });
      expect(formatRelativeTimeLabel(value)).toBe("");
    }
  });

  it("still formats valid timestamps", () => {
    expect(formatTimestamp("2026-01-02T03:04:05.000Z", "24-hour")).not.toBe("");
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    expect(formatRelativeTimeLabel(twoDaysAgo)).toBe("2d ago");
  });
});

describe("relative time boundaries", () => {
  const base = Date.parse("2026-01-02T03:04:05.000Z");
  const iso = new Date(base).toISOString();

  it("formats against an explicit now", () => {
    expect(formatRelativeTimeLabel(iso, base + 2_000)).toBe("just now");
    expect(formatRelativeTimeLabel(iso, base + 20_500)).toBe("20s ago");
    expect(formatRelativeTimeLabel(iso, base + 5 * 60_000 + 30_000)).toBe("5m ago");
    expect(formatRelativeTimeLabel(iso, base + 3 * 3_600_000)).toBe("3h ago");
    expect(formatRelativeTime(iso, base - 60_000)).toEqual({ value: "just now", suffix: null });
  });

  it("floors elapsed time to the precision of the label", () => {
    expect(relativeTimeElapsedMs(iso, base + 3_999)).toBe(0);
    expect(relativeTimeElapsedMs(iso, base + 20_500)).toBe(20_000);
    expect(relativeTimeElapsedMs(iso, base + 5 * 60_000 + 30_000)).toBe(5 * 60_000);
    expect(relativeTimeElapsedMs(iso, base + 3 * 3_600_000 + 1)).toBe(3 * 3_600_000);
    expect(relativeTimeElapsedMs("not-a-date", base)).toBeNull();
  });

  it("returns the same snapshot for instants sharing a label", () => {
    for (const offset of [1_000, 30_000, 61_000, 4_000_000, 90_000_000]) {
      const elapsed = relativeTimeElapsedMs(iso, base + offset);
      expect(elapsed).not.toBeNull();
      expect(formatRelativeElapsed(elapsed!)).toEqual(formatRelativeTime(iso, base + offset));
    }
  });

  it("schedules the next change at the label boundary", () => {
    expect(msUntilRelativeTimeChange(iso, base + 1_000)).toBe(4_000);
    expect(msUntilRelativeTimeChange(iso, base + 20_400)).toBe(600);
    expect(msUntilRelativeTimeChange(iso, base + 59_500)).toBe(500);
    expect(msUntilRelativeTimeChange(iso, base + 61_000)).toBe(59_000);
    expect(msUntilRelativeTimeChange(iso, base + 3_600_000 + 10)).toBe(3_600_000 - 10);
    expect(msUntilRelativeTimeChange("not-a-date", base)).toBeNull();
  });

  it("caps the delay for far-future timestamps", () => {
    expect(msUntilRelativeTimeChange(iso, base - 365 * 86_400_000)).toBe(86_400_000);
  });

  it("changes the label exactly when the scheduled delay elapses", () => {
    let now = base + 1_234;
    for (let step = 0; step < 80; step += 1) {
      const delay = msUntilRelativeTimeChange(iso, now)!;
      expect(delay).toBeGreaterThan(0);
      expect(formatRelativeTimeLabel(iso, now + delay - 1)).toBe(formatRelativeTimeLabel(iso, now));
      expect(formatRelativeTimeLabel(iso, now + delay)).not.toBe(formatRelativeTimeLabel(iso, now));
      now += delay;
    }
  });
});

describe("coarse relative time", () => {
  const base = Date.parse("2026-01-02T03:04:05.000Z");
  const iso = new Date(base).toISOString();

  it("reads just now for the whole first minute", () => {
    expect(formatRelativeTimeLabel(iso, base + 20_500, COARSE_JUST_NOW_MS)).toBe("just now");
    expect(formatRelativeTimeLabel(iso, base + 59_999, COARSE_JUST_NOW_MS)).toBe("just now");
    expect(formatRelativeTimeLabel(iso, base + 60_000, COARSE_JUST_NOW_MS)).toBe("1m ago");
  });

  it("does not schedule a re-render until the first minute passes", () => {
    expect(relativeTimeElapsedMs(iso, base + 30_000, COARSE_JUST_NOW_MS)).toBe(0);
    expect(msUntilRelativeTimeChange(iso, base + 1_000, COARSE_JUST_NOW_MS)).toBe(59_000);
    expect(msUntilRelativeTimeChange(iso, base + 61_000, COARSE_JUST_NOW_MS)).toBe(59_000);
  });

  it("notifies subscribers when the label changes", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(base + 10_000);
      const onChange = vi.fn();
      const unsubscribe = subscribeToRelativeTimeChanges(iso, onChange, COARSE_JUST_NOW_MS);
      vi.advanceTimersByTime(49_999);
      expect(onChange).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(onChange).toHaveBeenCalledTimes(1);
      unsubscribe();
      vi.advanceTimersByTime(120_000);
      expect(onChange).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// Local-time Date constructor keeps calendar-day boundaries valid in any test timezone.
const localIso = (y: number, monthIndex: number, d: number, h: number, mi: number) =>
  new Date(y, monthIndex, d, h, mi).toISOString();

describe("formatDayAwareTimestamp", () => {
  const now = new Date(2026, 7, 14, 12, 0).getTime();
  const time = (isoDate: string) => formatShortTimestamp(isoDate, "12-hour");

  it("shows time only for today", () => {
    const messageAt = localIso(2026, 7, 14, 9, 30);
    expect(formatDayAwareTimestamp(messageAt, "12-hour", now)).toBe(time(messageAt));
  });

  it("labels the previous calendar day as yesterday even when under 24h old", () => {
    const messageAt = localIso(2026, 7, 13, 23, 30);
    const justPastMidnight = new Date(2026, 7, 14, 0, 30).getTime();
    expect(formatDayAwareTimestamp(messageAt, "12-hour", justPastMidnight)).toBe(
      `yesterday at ${time(messageAt)}`,
    );
  });

  it("prefixes older same-year messages with the numeric date", () => {
    const messageAt = localIso(2026, 7, 12, 12, 34);
    const datePart = new Intl.DateTimeFormat(undefined, {
      month: "numeric",
      day: "numeric",
    }).format(new Date(messageAt));
    expect(formatDayAwareTimestamp(messageAt, "12-hour", now)).toBe(
      `${datePart} ${time(messageAt)}`,
    );
  });

  it("includes the year once the calendar year differs", () => {
    const messageAt = localIso(2025, 11, 31, 18, 0);
    const datePart = new Intl.DateTimeFormat(undefined, {
      month: "numeric",
      day: "numeric",
      year: "numeric",
    }).format(new Date(messageAt));
    expect(formatDayAwareTimestamp(messageAt, "12-hour", now)).toBe(
      `${datePart} ${time(messageAt)}`,
    );
  });

  it("keeps the 24-hour setting", () => {
    const messageAt = localIso(2026, 7, 13, 18, 5);
    expect(formatDayAwareTimestamp(messageAt, "24-hour", now)).toBe(
      `yesterday at ${formatShortTimestamp(messageAt, "24-hour")}`,
    );
  });

  it("returns an empty string for invalid input", () => {
    expect(formatDayAwareTimestamp("not-a-date", "12-hour", now)).toBe("");
  });
});

describe("local day boundaries", () => {
  it("finds the start of the local day and the wait until the next one", () => {
    const evening = new Date(2026, 7, 14, 23, 59, 30).getTime();
    expect(startOfLocalDayMs(evening)).toBe(new Date(2026, 7, 14).getTime());
    expect(msUntilNextLocalDay(evening)).toBe(30_000);
    expect(msUntilNextLocalDay(new Date(2026, 7, 14).getTime())).toBeLessThanOrEqual(86_400_000);
  });

  it("lets a start-of-day snapshot flip today's label to yesterday after midnight", () => {
    const messageAt = localIso(2026, 7, 14, 21, 0);
    const today = startOfLocalDayMs(new Date(2026, 7, 14, 22, 0).getTime());
    const tomorrow = startOfLocalDayMs(new Date(2026, 7, 15, 0, 1).getTime());
    expect(formatDayAwareTimestamp(messageAt, "12-hour", today)).not.toContain("yesterday");
    expect(formatDayAwareTimestamp(messageAt, "12-hour", tomorrow)).toContain("yesterday at");
  });

  it("notifies at each local midnight until unsubscribed", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 7, 14, 23, 0));
      const onChange = vi.fn();
      const unsubscribe = subscribeToLocalDayChanges(onChange);
      vi.advanceTimersByTime(59 * 60_000);
      expect(onChange).not.toHaveBeenCalled();
      vi.advanceTimersByTime(60_000);
      expect(onChange).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(24 * 3_600_000);
      expect(onChange).toHaveBeenCalledTimes(2);
      unsubscribe();
      vi.advanceTimersByTime(48 * 3_600_000);
      expect(onChange).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
