/** Label for a background interval setting, where 0 or less means off. */
export function formatIntervalLabel(ms: number): string {
  if (ms <= 0) return "Off";
  if (ms % 3_600_000 === 0) {
    const hours = ms / 3_600_000;
    return `Every ${hours} hour${hours === 1 ? "" : "s"}`;
  }
  if (ms % 60_000 === 0) {
    const minutes = ms / 60_000;
    return `Every ${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  const seconds = Math.round(ms / 100) / 10;
  return `Every ${seconds} second${seconds === 1 ? "" : "s"}`;
}

// Absolute (`/…`, `C:\…`, `\\server\…`) or home-relative (`~`). The server does the
// real expansion and validation; this only catches obvious typos before saving.
const ABSOLUTE_OR_HOME_PATH_PATTERN = /^(?:~(?:[/\\]|$)|\/|[A-Za-z]:[/\\]|\\\\)/;

/** Validator for an optional directory setting. Empty is allowed and keeps the default. */
export function validateAbsoluteOrHomePath(value: string): string | null {
  if (value === "" || ABSOLUTE_OR_HOME_PATH_PATTERN.test(value)) return null;
  return "Enter an absolute path, or one that starts with ~.";
}
