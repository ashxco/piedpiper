import { type TimestampFormat } from "@piedpiper/contracts/settings";

export function getTimestampFormatOptions(
  timestampFormat: TimestampFormat,
  includeSeconds: boolean,
): Intl.DateTimeFormatOptions {
  const baseOptions: Intl.DateTimeFormatOptions = {
    hour: "numeric",
    minute: "2-digit",
    ...(includeSeconds ? { second: "2-digit" } : {}),
  };

  if (timestampFormat === "locale") {
    return baseOptions;
  }

  return {
    ...baseOptions,
    hour12: timestampFormat === "12-hour",
  };
}

/**
 * The locale to format dates and times in, given what the host reports. Undefined means the
 * runtime default, which is right in a browser and for a tag `Intl` rejects: every timestamp
 * goes through here, so a bad tag must fall back rather than throw.
 */
export function resolveTimestampLocale(
  systemLocale: string | null | undefined,
): string | undefined {
  const tag = systemLocale?.trim();
  if (!tag) return undefined;
  try {
    Intl.DateTimeFormat.supportedLocalesOf([tag]);
    return tag;
  } catch {
    return undefined;
  }
}

function readHostSystemLocale(): string | null {
  if (typeof window === "undefined") return null;
  try {
    // Optional, since an older desktop shell can host this client.
    return window.desktopBridge?.getSystemLocale?.() ?? null;
  } catch {
    return null;
  }
}

/** Packaged desktop builds pin the runtime default to en-US, so the host's locale goes first. */
export const timestampLocale = resolveTimestampLocale(readHostSystemLocale());

const timestampFormatterCache = new Map<string, Intl.DateTimeFormat>();

function getTimestampFormatter(
  timestampFormat: TimestampFormat,
  includeSeconds: boolean,
): Intl.DateTimeFormat {
  const cacheKey = `${timestampFormat}:${includeSeconds ? "seconds" : "minutes"}`;
  const cachedFormatter = timestampFormatterCache.get(cacheKey);
  if (cachedFormatter) {
    return cachedFormatter;
  }

  const formatter = new Intl.DateTimeFormat(
    timestampLocale,
    getTimestampFormatOptions(timestampFormat, includeSeconds),
  );
  timestampFormatterCache.set(cacheKey, formatter);
  return formatter;
}

/** Parses an ISO timestamp, returning null instead of an Invalid Date. */
export function parseTimestampDate(isoDate: string): Date | null {
  const date = new Date(isoDate);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatTimestamp(isoDate: string, timestampFormat: TimestampFormat): string {
  const date = parseTimestampDate(isoDate);
  if (!date) return "";
  return getTimestampFormatter(timestampFormat, true).format(date);
}

export function formatShortTimestamp(isoDate: string, timestampFormat: TimestampFormat): string {
  const date = parseTimestampDate(isoDate);
  if (!date) return "";
  return getTimestampFormatter(timestampFormat, false).format(date);
}

const SECOND_MS = 1_000;
const JUST_NOW_MS = 5_000;
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

const numericDateFormatter = new Intl.DateTimeFormat(timestampLocale, {
  month: "numeric",
  day: "numeric",
});
const numericDateWithYearFormatter = new Intl.DateTimeFormat(timestampLocale, {
  month: "numeric",
  day: "numeric",
  year: "numeric",
});

/**
 * Chat timestamp that adds the date once the message is no longer from today:
 * today `12:34 PM`, yesterday `yesterday at 12:34 PM`, older `8/13 12:34 PM`,
 * with the year once the calendar year differs. Boundaries are local calendar days.
 */
export function formatDayAwareTimestamp(
  isoDate: string,
  timestampFormat: TimestampFormat,
  nowMs: number = Date.now(),
): string {
  const date = parseTimestampDate(isoDate);
  if (!date) return "";
  const time = getTimestampFormatter(timestampFormat, false).format(date);

  const now = new Date(nowMs);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfMessageDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  // Round so DST-shifted 23/25 hour days still count as whole days.
  const dayDiff = Math.round((startOfToday - startOfMessageDay) / DAY_MS);

  if (dayDiff <= 0) return time;
  if (dayDiff === 1) return `yesterday at ${time}`;
  const dateFormatter =
    date.getFullYear() === now.getFullYear() ? numericDateFormatter : numericDateWithYearFormatter;
  return `${dateFormatter.format(date)} ${time}`;
}

/** Start of the local calendar day containing `nowMs`. */
export function startOfLocalDayMs(nowMs: number = Date.now()): number {
  const now = new Date(nowMs);
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

/** Milliseconds until the next local midnight, capped at a day so DST shifts only wake early. */
export function msUntilNextLocalDay(nowMs: number = Date.now()): number {
  const now = new Date(nowMs);
  const nextDayMs = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
  return Math.max(1, Math.min(nextDayMs - nowMs, DAY_MS));
}

/** Calls `onChange` at each local midnight; returns an unsubscribe. */
export function subscribeToLocalDayChanges(onChange: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    timer = setTimeout(() => {
      onChange();
      schedule();
    }, msUntilNextLocalDay());
  };
  schedule();
  return () => clearTimeout(timer);
}

export type RelativeTimeParts = { value: string; suffix: string | null };

/** Compact rows (the sidebar) read "just now" for the first minute instead of ticking seconds. */
export const COARSE_JUST_NOW_MS = MINUTE_MS;

function relativeTimeUnitMs(elapsedMs: number, justNowMs: number): number {
  if (elapsedMs < justNowMs) return justNowMs;
  if (elapsedMs < MINUTE_MS) return SECOND_MS;
  if (elapsedMs < HOUR_MS) return MINUTE_MS;
  if (elapsedMs < DAY_MS) return HOUR_MS;
  return DAY_MS;
}

/**
 * Elapsed time floored to the precision `formatRelativeTime` shows, so two
 * instants with the same label return the same number. Null for an invalid date.
 */
export function relativeTimeElapsedMs(
  isoDate: string,
  nowMs: number = Date.now(),
  justNowMs: number = JUST_NOW_MS,
): number | null {
  const date = parseTimestampDate(isoDate);
  if (!date) return null;
  const elapsedMs = Math.max(0, nowMs - date.getTime());
  const unitMs = relativeTimeUnitMs(elapsedMs, justNowMs);
  return Math.floor(elapsedMs / unitMs) * unitMs;
}

/** Milliseconds until the `formatRelativeTime` label for `isoDate` next changes. */
export function msUntilRelativeTimeChange(
  isoDate: string,
  nowMs: number = Date.now(),
  justNowMs: number = JUST_NOW_MS,
): number | null {
  const date = parseTimestampDate(isoDate);
  if (!date) return null;
  const elapsedMs = Math.max(0, nowMs - date.getTime());
  const unitMs = relativeTimeUnitMs(elapsedMs, justNowMs);
  const nextChangeMs = date.getTime() + (Math.floor(elapsedMs / unitMs) + 1) * unitMs;
  // Cap so a far-future timestamp never overflows setTimeout; waking early just re-schedules.
  return Math.min(nextChangeMs - nowMs, DAY_MS);
}

/** Formats an elapsed duration as `{ value: "20s", suffix: "ago" }` or "just now". */
export function formatRelativeElapsed(
  elapsedMs: number,
  justNowMs: number = JUST_NOW_MS,
): RelativeTimeParts {
  if (elapsedMs < justNowMs) return { value: "just now", suffix: null };
  const seconds = Math.floor(Math.max(0, elapsedMs) / 1000);
  if (seconds < 60) return { value: `${seconds}s`, suffix: "ago" };
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return { value: `${minutes}m`, suffix: "ago" };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { value: `${hours}h`, suffix: "ago" };
  const days = Math.floor(hours / 24);
  return { value: `${days}d`, suffix: "ago" };
}

export function formatRelativeTimeParts(parts: RelativeTimeParts): string {
  return parts.suffix ? `${parts.value} ${parts.suffix}` : parts.value;
}

/**
 * Format a relative time string from an ISO date.
 * Returns `{ value: "20s", suffix: "ago" }` or `{ value: "just now", suffix: null }`
 * so callers can style the numeric portion independently.
 * An unparseable timestamp yields `{ value: "", suffix: null }`.
 * Inside React render prefer `useRelativeTimeState` or `<RelativeTime>`, which keep counting.
 */
export function formatRelativeTime(
  isoDate: string,
  nowMs: number = Date.now(),
  justNowMs: number = JUST_NOW_MS,
): RelativeTimeParts {
  const elapsedMs = relativeTimeElapsedMs(isoDate, nowMs, justNowMs);
  return elapsedMs === null
    ? { value: "", suffix: null }
    : formatRelativeElapsed(elapsedMs, justNowMs);
}

export function formatRelativeTimeLabel(
  isoDate: string,
  nowMs: number = Date.now(),
  justNowMs: number = JUST_NOW_MS,
) {
  return formatRelativeTimeParts(formatRelativeTime(isoDate, nowMs, justNowMs));
}

/** Calls `onChange` each time the relative label for `isoDate` changes; returns an unsubscribe. */
export function subscribeToRelativeTimeChanges(
  isoDate: string | null,
  onChange: () => void,
  justNowMs: number = JUST_NOW_MS,
): () => void {
  if (isoDate === null) return () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    const delayMs = msUntilRelativeTimeChange(isoDate, Date.now(), justNowMs);
    if (delayMs === null) return;
    timer = setTimeout(() => {
      onChange();
      schedule();
    }, delayMs);
  };
  schedule();
  return () => clearTimeout(timer);
}
