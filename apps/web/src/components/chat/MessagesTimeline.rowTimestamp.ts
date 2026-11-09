import { type TimestampFormat } from "@piedpiper/contracts/settings";
import {
  getTimestampFormatOptions,
  parseTimestampDate,
  timestampLocale,
} from "../../timestampFormat";

const tooltipFormatterCache = new Map<TimestampFormat, Intl.DateTimeFormat>();

/** Full date and time with seconds, for the tooltip on hover-revealed row timestamps. */
export function formatTimelineRowTimestampTooltip(
  isoDate: string,
  timestampFormat: TimestampFormat,
): string {
  const date = parseTimestampDate(isoDate);
  if (!date) return "";
  let formatter = tooltipFormatterCache.get(timestampFormat);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(timestampLocale, {
      weekday: "short",
      year: "numeric",
      month: "short",
      day: "numeric",
      ...getTimestampFormatOptions(timestampFormat, true),
    });
    tooltipFormatterCache.set(timestampFormat, formatter);
  }
  return formatter.format(date);
}
