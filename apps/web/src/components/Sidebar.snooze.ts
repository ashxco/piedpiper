import type { ContextMenuItem, ThreadId } from "@piedpiper/contracts";

import type { ThreadNotificationKind } from "../threadNotifications";
import { parseTimestampDate, timestampLocale } from "../timestampFormat";
import type { SidebarThreadSummary } from "../types";
import type { ThreadSnooze } from "../uiStateStore";

/**
 * Pure rules for snoozing a sidebar thread. A snooze only changes where the row is shown: the
 * thread keeps running, and a request for the user or a fresh failure brings it back early.
 */

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
const EVENING_HOUR = 18;
const MORNING_HOUR = 9;
// Short enough that a changed clock or a slept machine is noticed even without a focus event.
const SNOOZE_TIMER_MAX_DELAY_MS = HOUR_MS;
// Fire just past the wake time so the comparison against it has already flipped.
const SNOOZE_TIMER_SLACK_MS = 50;
// Long enough for a session to start; a send that never starts a turn must not block snoozing.
const QUEUED_TURN_START_GRACE_MS = 2 * 60 * 1_000;

export type SnoozePresetId = "hour" | "evening" | "tomorrow" | "next-week";

export interface SnoozePreset {
  readonly id: SnoozePresetId;
  readonly label: string;
  /** Menu-row time column; complements the label instead of repeating it. */
  readonly whenLabel: string;
  readonly snoozedUntil: string;
}

/** The summary fields that decide whether a snooze still holds. */
export type ThreadSnoozeShell = Pick<
  SidebarThreadSummary,
  "hasPendingApprovals" | "hasPendingUserInput" | "latestTurn" | "latestUserMessageAt" | "session"
> & {
  /** When the newest blocking question was asked, once the summary carries it. */
  readonly pendingUserInputAt?: string | null | undefined;
  /** Newest message the user sent themselves, once the summary carries it; server resends don't count. */
  readonly latestManualUserMessageAt?: string | null | undefined;
};

function timeOfDayLabel(date: Date): string {
  return date.toLocaleTimeString(timestampLocale, { hour: "numeric", minute: "2-digit" });
}

function atHour(base: Date, hour: number): Date {
  const next = new Date(base);
  next.setHours(hour, 0, 0, 0);
  return next;
}

// Calendar-day advance: adding 24h lands on the wrong local day across a DST change.
function addDays(base: Date, days: number): Date {
  const next = new Date(base);
  next.setDate(next.getDate() + days);
  return next;
}

/**
 * Presets in local time. "This evening" needs more than an hour of runway, and a preset landing
 * on the same moment as an earlier one is dropped (on Sunday, next Monday is also tomorrow).
 */
export function resolveSnoozePresets(now: Date): ReadonlyArray<SnoozePreset> {
  const inAnHour = new Date(now.getTime() + HOUR_MS);
  const evening = atHour(now, EVENING_HOUR);
  const tomorrow = atHour(addDays(now, 1), MORNING_HOUR);
  // A full week out when today is Monday.
  const nextWeek = atHour(addDays(now, (1 - now.getDay() + 7) % 7 || 7), MORNING_HOUR);
  const candidates: SnoozePreset[] = [
    {
      id: "hour",
      label: "In 1 hour",
      whenLabel: timeOfDayLabel(inAnHour),
      snoozedUntil: inAnHour.toISOString(),
    },
    ...(evening.getTime() - now.getTime() > HOUR_MS
      ? [
          {
            id: "evening" as const,
            label: "This evening",
            whenLabel: timeOfDayLabel(evening),
            snoozedUntil: evening.toISOString(),
          },
        ]
      : []),
    {
      id: "tomorrow",
      label: "Tomorrow",
      whenLabel: timeOfDayLabel(tomorrow),
      snoozedUntil: tomorrow.toISOString(),
    },
    {
      id: "next-week",
      label: "Next week",
      whenLabel: `${nextWeek.toLocaleDateString(timestampLocale, { weekday: "short" })} ${timeOfDayLabel(nextWeek)}`,
      snoozedUntil: nextWeek.toISOString(),
    },
  ];
  const seenWakeTimes = new Set<string>();
  return candidates.filter((preset) => {
    if (seenWakeTimes.has(preset.snoozedUntil)) return false;
    seenWakeTimes.add(preset.snoozedUntil);
    return true;
  });
}

/** Row id of a project's "Snoozed" toggle, the keyboard parent of its shelf rows. */
export function sidebarSnoozedShelfRowId(projectRowId: string): string {
  return `${projectRowId}:snoozed`;
}

export type ThreadSnoozeMenuItemId = `snooze-${SnoozePresetId}` | "wake";

/** Flat items for the native context menu, which has no submenus. */
export function buildThreadSnoozeMenuItems(input: {
  readonly presets: ReadonlyArray<SnoozePreset>;
  readonly snoozed: boolean;
  readonly canSnooze: boolean;
  /** Selected threads the items apply to; absent for a single thread's menu. */
  readonly count?: number;
}): ContextMenuItem<ThreadSnoozeMenuItemId>[] {
  if (input.snoozed) return [{ id: "wake", label: "Wake now" }];
  const verb = input.count === undefined ? "Snooze" : `Snooze (${input.count})`;
  return input.presets.map((preset) => ({
    id: `snooze-${preset.id}` as const,
    label: `${verb}: ${preset.label} (${preset.whenLabel})`,
    disabled: !input.canSnooze,
  }));
}

/** The wake time a clicked native menu item stands for; null when it is not a snooze preset. */
export function resolveSnoozeMenuPick(
  clicked: string | null,
  presets: ReadonlyArray<SnoozePreset>,
): string | null {
  return presets.find((preset) => `snooze-${preset.id}` === clicked)?.snoozedUntil ?? null;
}

/** Compact "wakes in" label for snoozed rows; rounds up so it never reads "0m" while hidden. */
export function snoozeWakeLabel(snoozedUntil: string, nowMs: number): string {
  const wake = parseTimestampDate(snoozedUntil);
  if (wake === null) return "now";
  const remainingMs = wake.getTime() - nowMs;
  if (remainingMs <= 0) return "now";
  if (remainingMs < HOUR_MS) return `${Math.max(1, Math.ceil(remainingMs / 60_000))}m`;
  if (remainingMs < DAY_MS) return `${Math.ceil(remainingMs / HOUR_MS)}h`;
  return `${Math.ceil(remainingMs / DAY_MS)}d`;
}

// Counts local calendar days, so a 23-hour or 25-hour DST day still reads as one day.
function localDayNumber(date: Date): number {
  return Math.round(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS);
}

/** Wake time for toasts and tooltips: "17:30" today, "tomorrow 9:00", "Mon 9:00", "Apr 20, 9:00". */
export function snoozeWakeDescription(snoozedUntil: string, nowMs: number): string {
  const wake = parseTimestampDate(snoozedUntil);
  if (wake === null) return "";
  const time = timeOfDayLabel(wake);
  const dayDelta = localDayNumber(wake) - localDayNumber(new Date(nowMs));
  if (dayDelta === 0) return time;
  if (dayDelta === 1) return `tomorrow ${time}`;
  if (dayDelta > 0 && dayDelta < 7) {
    return `${wake.toLocaleDateString(timestampLocale, { weekday: "short" })} ${time}`;
  }
  return `${wake.toLocaleDateString(timestampLocale, { month: "short", day: "numeric" })}, ${time}`;
}

function isAfter(left: string | null | undefined, right: string): boolean {
  if (!left) return false;
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  return !Number.isNaN(leftMs) && !Number.isNaN(rightMs) && leftMs > rightMs;
}

function failureEdgeAt(thread: ThreadSnoozeShell): string | null {
  const session = thread.session;
  if (thread.latestTurn?.state === "error") {
    return thread.latestTurn.completedAt ?? session?.updatedAt ?? null;
  }
  return session?.status === "error" ? session.updatedAt : null;
}

/**
 * Only a request for the user or a fresh failure ends a snooze early. A completed turn never
 * does: a snoozed long-running thread keeps working and stays hidden until its timer.
 */
export function threadRaisedHandWhileSnoozed(
  thread: ThreadSnoozeShell,
  snooze: ThreadSnooze,
): boolean {
  if (thread.hasPendingApprovals) return true;
  if (
    thread.hasPendingUserInput &&
    (!snooze.questionPendingAtSnooze || isAfter(thread.pendingUserInputAt, snooze.snoozedAt))
  ) {
    return true;
  }
  return isAfter(failureEdgeAt(thread), snooze.snoozedAt);
}

/** Sending to the thread re-engages it, so the snooze is over for good. */
export function threadSentSinceSnooze(
  thread: Pick<ThreadSnoozeShell, "latestUserMessageAt" | "latestManualUserMessageAt">,
  snooze: ThreadSnooze,
): boolean {
  const sentAt =
    thread.latestManualUserMessageAt === undefined
      ? thread.latestUserMessageAt
      : thread.latestManualUserMessageAt;
  return isAfter(sentAt, snooze.snoozedAt);
}

/** Hidden in the shelf: wake time ahead and nothing raised. Malformed data never hides a thread. */
export function effectiveSnoozed(
  thread: ThreadSnoozeShell | undefined,
  snooze: ThreadSnooze | undefined,
  nowMs: number,
): boolean {
  if (!thread || !snooze) return false;
  const wakeAtMs = Date.parse(snooze.snoozedUntil);
  if (Number.isNaN(wakeAtMs) || wakeAtMs <= nowMs) return false;
  if (threadSentSinceSnooze(thread, snooze)) return false;
  return !threadRaisedHandWhileSnoozed(thread, snooze);
}

/** Why a no-longer-hidden thread came back; compared to the last visit for the "woke" marker. */
export function threadWakeEdgeAt(thread: ThreadSnoozeShell, snooze: ThreadSnooze): string {
  if (!threadRaisedHandWhileSnoozed(thread, snooze)) return snooze.snoozedUntil;
  const questionAt = thread.hasPendingUserInput ? thread.pendingUserInputAt : null;
  // Approvals carry no time of their own, and the session time moves on metadata writes.
  const approvalAt = thread.hasPendingApprovals ? thread.session?.updatedAt : null;
  let edge: string | null = null;
  for (const at of [failureEdgeAt(thread), questionAt, approvalAt]) {
    if (at && isAfter(at, snooze.snoozedAt) && (edge === null || isAfter(at, edge))) edge = at;
  }
  return edge ?? thread.session?.updatedAt ?? snooze.snoozedAt;
}

function hasVisitedSince(lastVisitedAt: string | undefined, at: string): boolean {
  if (!lastVisitedAt) return false;
  const visitedMs = Date.parse(lastVisitedAt);
  const atMs = Date.parse(at);
  return !Number.isNaN(visitedMs) && !Number.isNaN(atMs) && visitedMs >= atMs;
}

/**
 * A woken thread keeps a marker on its row until it is visited, as unread state does. Visit times
 * only track settled turns, so a raised-hand wake is acknowledged through `wakeSeenAt` instead.
 */
export function hasUnseenThreadWake(
  thread: ThreadSnoozeShell,
  snooze: ThreadSnooze,
  lastVisitedAt: string | undefined,
): boolean {
  const edge = threadWakeEdgeAt(thread, snooze);
  return !hasVisitedSince(lastVisitedAt, edge) && !hasVisitedSince(snooze.wakeSeenAt, edge);
}

function isAtOrAfter(left: string | null | undefined, right: string): boolean {
  return left === right || isAfter(left, right);
}

/** Sent, but no turn has picked the message up yet. Bounded, so a lost send cannot block forever. */
function hasQueuedTurnStart(
  thread: Pick<ThreadSnoozeShell, "latestTurn" | "latestUserMessageAt" | "session">,
  nowMs: number,
): boolean {
  if (thread.session?.orchestrationStatus === "starting") return true;
  const sentAt = thread.latestUserMessageAt;
  if (!sentAt) return false;
  const sentAtMs = Date.parse(sentAt);
  if (Number.isNaN(sentAtMs) || nowMs - sentAtMs >= QUEUED_TURN_START_GRACE_MS) return false;
  const turn = thread.latestTurn;
  return !(
    turn &&
    [turn.requestedAt, turn.startedAt, turn.completedAt].some((at) => isAtOrAfter(at, sentAt))
  );
}

export type ThreadSnoozeBlock = "pending-approval" | "queued-turn";

/**
 * A pending approval would wake the thread at once, and a turn about to start was just asked for,
 * so offering to hide either would be a lie.
 */
export function resolveThreadSnoozeBlock(
  thread: Pick<
    ThreadSnoozeShell,
    "hasPendingApprovals" | "latestTurn" | "latestUserMessageAt" | "session"
  >,
  nowMs: number = Date.now(),
): ThreadSnoozeBlock | null {
  if (thread.hasPendingApprovals) return "pending-approval";
  return hasQueuedTurnStart(thread, nowMs) ? "queued-turn" : null;
}

export function canSnoozeThread(
  thread: Parameters<typeof resolveThreadSnoozeBlock>[0],
  nowMs: number = Date.now(),
): boolean {
  return resolveThreadSnoozeBlock(thread, nowMs) === null;
}

export function createThreadSnooze(
  thread: Pick<ThreadSnoozeShell, "hasPendingUserInput">,
  snoozedUntil: string,
  nowMs: number,
): ThreadSnooze {
  return {
    snoozedUntil,
    snoozedAt: new Date(nowMs).toISOString(),
    questionPendingAtSnooze: thread.hasPendingUserInput,
  };
}

/** Splits a sorted list before pin ordering and the preview limit see it; order is preserved. */
export function partitionSnoozedThreads<T extends { readonly id: ThreadId }>(
  threads: readonly T[],
  isSnoozed: (threadId: ThreadId) => boolean,
): { readonly awake: T[]; readonly snoozed: T[] } {
  const awake: T[] = [];
  const snoozed: T[] = [];
  for (const thread of threads) {
    (isSnoozed(thread.id) ? snoozed : awake).push(thread);
  }
  return { awake, snoozed };
}

/** The shelf reads soonest wake first: what comes back next is its question. Unknown times go last. */
export function sortSnoozedThreadsByWake<T extends { readonly id: ThreadId }>(
  threads: readonly T[],
  wakeAt: (threadId: ThreadId) => string | undefined,
): T[] {
  const wakeMs = (thread: T) => {
    const parsed = Date.parse(wakeAt(thread.id) ?? "");
    return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
  };
  return threads.toSorted((left, right) => {
    const leftMs = wakeMs(left);
    const rightMs = wakeMs(right);
    return leftMs === rightMs ? 0 : leftMs - rightMs;
  });
}

/**
 * Delay for the single timer behind all snoozes, or null when none is still ahead of `nowMs`.
 * `nowMs` is the clock value the UI last rendered with, so a wake the timer slept through fires
 * at once; `realNowMs` measures how long is really left.
 */
export function resolveSnoozeTimerDelayMs(
  snoozes: Readonly<Record<string, ThreadSnooze>>,
  nowMs: number,
  realNowMs: number = nowMs,
): number | null {
  let earliest: number | null = null;
  for (const snooze of Object.values(snoozes)) {
    const wakeAtMs = Date.parse(snooze.snoozedUntil);
    if (Number.isNaN(wakeAtMs) || wakeAtMs <= nowMs) continue;
    if (earliest === null || wakeAtMs < earliest) earliest = wakeAtMs;
  }
  if (earliest === null) return null;
  return Math.min(
    Math.max(0, earliest - realNowMs) + SNOOZE_TIMER_SLACK_MS,
    SNOOZE_TIMER_MAX_DELAY_MS,
  );
}

/**
 * Drops snoozes that are finished: the user sent to the thread, or the timer passed and the wake
 * has been seen. Clears the question flag once that question is gone, so the next one wakes, and
 * records a raised-hand wake as seen once the thread is open. Returns `snoozes` itself when nothing
 * changed.
 */
export function reconcileThreadSnoozes(
  snoozes: Readonly<Record<string, ThreadSnooze>>,
  input: {
    readonly threadsById: Readonly<Record<string, ThreadSnoozeShell | undefined>>;
    readonly lastVisitedAtById: Readonly<Record<string, string | undefined>>;
    readonly routeThreadId: ThreadId | null;
    readonly nowMs: number;
  },
): Record<string, ThreadSnooze> {
  let next: Record<string, ThreadSnooze> | null = null;
  const edit = () => (next ??= { ...snoozes });
  for (const [threadId, snooze] of Object.entries(snoozes)) {
    const thread = input.threadsById[threadId];
    if (!thread) continue;
    if (threadSentSinceSnooze(thread, snooze)) {
      delete edit()[threadId];
      continue;
    }
    const wakeAtMs = Date.parse(snooze.snoozedUntil);
    const timerElapsed = Number.isNaN(wakeAtMs) || wakeAtMs <= input.nowMs;
    if (
      timerElapsed &&
      (threadId === input.routeThreadId ||
        !hasUnseenThreadWake(thread, snooze, input.lastVisitedAtById[threadId]))
    ) {
      delete edit()[threadId];
      continue;
    }
    const questionCleared = snooze.questionPendingAtSnooze && !thread.hasPendingUserInput;
    const wakeEdge =
      threadId === input.routeThreadId &&
      !effectiveSnoozed(thread, snooze, input.nowMs) &&
      hasUnseenThreadWake(thread, snooze, input.lastVisitedAtById[threadId])
        ? threadWakeEdgeAt(thread, snooze)
        : null;
    if (questionCleared || (wakeEdge !== null && wakeEdge !== snooze.wakeSeenAt)) {
      edit()[threadId] = {
        ...snooze,
        ...(questionCleared ? { questionPendingAtSnooze: false } : {}),
        ...(wakeEdge !== null ? { wakeSeenAt: wakeEdge } : {}),
      };
    }
  }
  return next ?? (snoozes as Record<string, ThreadSnooze>);
}

/** Finished work stays quiet while a thread is snoozed; approvals, questions and failures do not. */
export function shouldSuppressSnoozedThreadNotification(input: {
  readonly kind: ThreadNotificationKind;
  readonly thread: ThreadSnoozeShell | undefined;
  readonly snooze: ThreadSnooze | undefined;
  readonly nowMs: number;
}): boolean {
  return input.kind === "completed" && effectiveSnoozed(input.thread, input.snooze, input.nowMs);
}
