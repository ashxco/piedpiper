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
