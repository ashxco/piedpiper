const MAX_BADGE_COUNT = 9999;

/** Coerces an untrusted renderer value to a whole, non-negative dock/taskbar badge count. */
export function normalizeBadgeCount(value: unknown): number {
  const count = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(count) || count <= 0) return 0;
  return Math.min(Math.floor(count), MAX_BADGE_COUNT);
}
