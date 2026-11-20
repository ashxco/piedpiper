import { describe, expect, it } from "vitest";

import { getTimestampFormatOptions, timestampLocale } from "../../timestampFormat";
import { formatTimelineRowTimestampTooltip } from "./MessagesTimeline.rowTimestamp";

describe("formatTimelineRowTimestampTooltip", () => {
  it("includes the full date and seconds", () => {
    const iso = "2026-03-17T19:12:28.000Z";
    const text = formatTimelineRowTimestampTooltip(iso, "24-hour");
    const date = new Date(iso);
    expect(text).toContain(String(date.getFullYear()));
    expect(text).toContain(String(date.getDate()));
    expect(text).toContain(String(date.getSeconds()).padStart(2, "0"));
  });

  it("formats with the shared timestamp locale", () => {
    const iso = "2026-03-17T19:12:28.000Z";
    const expected = new Intl.DateTimeFormat(timestampLocale, {
      weekday: "short",
      year: "numeric",
      month: "short",
      day: "numeric",
      ...getTimestampFormatOptions("locale", true),
    }).format(new Date(iso));
    expect(formatTimelineRowTimestampTooltip(iso, "locale")).toBe(expected);
  });

  it("returns an empty string for invalid timestamps", () => {
    expect(formatTimelineRowTimestampTooltip("not a date", "locale")).toBe("");
  });
});

describe("formatTimelineRowTimestampTooltip after a system time zone change", () => {
  it("follows the new zone", () => {
    const iso = "2026-10-31T20:00:00.000Z";
    const previous = process.env.TZ;
    const expectedIn = (timeZone: string) =>
      new Intl.DateTimeFormat(timestampLocale, {
        weekday: "short",
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
        timeZone,
      }).format(new Date(iso));
    try {
      process.env.TZ = "America/New_York";
      expect(formatTimelineRowTimestampTooltip(iso, "24-hour")).toBe(
        expectedIn("America/New_York"),
      );
      process.env.TZ = "Asia/Bangkok";
      expect(formatTimelineRowTimestampTooltip(iso, "24-hour")).toBe(expectedIn("Asia/Bangkok"));
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });
});
