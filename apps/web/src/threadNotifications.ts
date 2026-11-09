import type { ThreadId } from "@piedpiper/contracts";
import type { NotificationMode } from "@piedpiper/contracts/settings";

import { isLatestTurnSettled } from "./session-logic";
import type { SidebarThreadSummary } from "./types";

export type ThreadNotificationKind = "completed" | "failed" | "approval" | "input";

export interface ThreadNotificationEvent {
  readonly threadId: ThreadId;
  readonly threadTitle: string;
  readonly kind: ThreadNotificationKind;
}

/** Per-thread memory used to detect transitions between store updates. */
export interface ThreadNotificationSnapshot {
  readonly attention: string | null;
  /** The latest settled, completed turn; a change fires "completed" once per turn. */
  readonly completedTurnId: string | null;
}

export type ThreadNotificationSnapshots = ReadonlyMap<ThreadId, ThreadNotificationSnapshot>;

type NotifiableThread = Pick<
  SidebarThreadSummary,
  | "id"
  | "title"
  | "archivedAt"
  | "latestTurn"
  | "session"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
>;

export const THREAD_NOTIFICATION_TITLES: Record<ThreadNotificationKind, string> = {
  completed: "Thread completed",
  failed: "Thread failed",
  approval: "Approval needed",
  input: "Input needed",
};

export function hasNotificationSound(mode: NotificationMode): boolean {
  return mode === "sound" || mode === "notifications-and-sound";
}

export function hasSystemNotifications(mode: NotificationMode): boolean {
  return mode === "notifications" || mode === "notifications-and-sound";
}

// A turn can read as finished while its session still runs (a server snapshot, a newer turn
// starting); only a settled turn counts.
function isThreadTurnSettled(thread: NotifiableThread): boolean {
  return isLatestTurnSettled(thread.latestTurn, thread.session ?? null);
}

function resolveAttentionKind(thread: NotifiableThread): "approval" | "input" | "failed" | null {
  if (thread.hasPendingApprovals) return "approval";
  if (thread.hasPendingUserInput) return "input";
  if (thread.latestTurn?.state === "error" && isThreadTurnSettled(thread)) return "failed";
  return null;
}

function snapshotThread(
  thread: NotifiableThread,
  prior: ThreadNotificationSnapshot | undefined,
): ThreadNotificationSnapshot {
  const attentionKind = resolveAttentionKind(thread);
  const attention = attentionKind ? `${thread.latestTurn?.turnId ?? ""}:${attentionKind}` : null;
  const completedTurnId =
    thread.latestTurn?.state === "completed" && isThreadTurnSettled(thread)
      ? thread.latestTurn.turnId
      : (prior?.completedTurnId ?? null);
  return { attention, completedTurnId };
}

/**
 * Compares threads against the previous snapshots and returns the transitions worth
 * announcing. Pass `null` as `previous` on the first run to seed without firing.
 */
export function diffThreadNotifications(
  previous: ThreadNotificationSnapshots | null,
  threads: Iterable<NotifiableThread>,
): { next: Map<ThreadId, ThreadNotificationSnapshot>; events: ThreadNotificationEvent[] } {
  const next = new Map<ThreadId, ThreadNotificationSnapshot>();
  const events: ThreadNotificationEvent[] = [];
  for (const thread of threads) {
    const prior = previous?.get(thread.id);
    const snapshot = snapshotThread(thread, prior);
    next.set(thread.id, snapshot);
    if (!prior || thread.archivedAt !== null) continue;

    const attentionKind = resolveAttentionKind(thread);
    let kind: ThreadNotificationKind | null = null;
    if (attentionKind && snapshot.attention !== prior.attention) {
      kind = attentionKind;
    } else if (
      attentionKind === null &&
      snapshot.completedTurnId !== null &&
      snapshot.completedTurnId !== prior.completedTurnId
    ) {
      kind = "completed";
    }
    if (kind) events.push({ threadId: thread.id, threadTitle: thread.title, kind });
  }
  return { next, events };
}

export interface ThreadNotificationDelivery {
  readonly toast: boolean;
  readonly system: boolean;
  readonly sound: boolean;
  readonly badge: boolean;
}

const NO_DELIVERY: ThreadNotificationDelivery = {
  toast: false,
  system: false,
  sound: false,
  badge: false,
};

/** Decides how to surface one event: a toast while you look at another thread, otherwise a system notification and badge. */
export function resolveThreadNotificationDelivery(input: {
  mode: NotificationMode;
  windowFocused: boolean;
  isActiveThread: boolean;
}): ThreadNotificationDelivery {
  if (input.mode === "off") return NO_DELIVERY;
  if (input.windowFocused && input.isActiveThread) return NO_DELIVERY;
  const sound = hasNotificationSound(input.mode);
  if (input.windowFocused) {
    return { toast: true, system: false, sound, badge: false };
  }
  const system = hasSystemNotifications(input.mode);
  return { toast: false, system, sound, badge: true };
}

export function isWindowFocused(): boolean {
  return document.visibilityState === "visible" && document.hasFocus();
}

/** Handles a system notification click; window.focus() alone cannot raise a hidden Electron window. */
export function revealWindowAndOpenThread(openThread: () => void): void {
  window.focus();
  try {
    void Promise.resolve(window.desktopBridge?.revealWindow?.()).catch(() => undefined);
  } catch {
    // A failed reveal must still open the thread.
  }
  openThread();
}

export function requestThreadNotificationPermission(): void {
  if (typeof Notification === "undefined" || Notification.permission !== "default") return;
  void Notification.requestPermission().catch(() => undefined);
}

/** Shows the count on the dock/taskbar (desktop) or app badge (installed web app). */
export function setThreadNotificationBadge(count: number): void {
  try {
    const bridge = window.desktopBridge;
    if (bridge) {
      void Promise.resolve(bridge.setBadgeCount?.(count)).catch(() => undefined);
      return;
    }
    if (count > 0) {
      void navigator.setAppBadge?.(count).catch(() => undefined);
    } else {
      void navigator.clearAppBadge?.().catch(() => undefined);
    }
  } catch {
    // Badging is best effort.
  }
}

let audioContext: AudioContext | undefined;

/** Must run from a user gesture so browsers allow later playback in the background. */
export function unlockNotificationAudio(): void {
  try {
    audioContext ??= new AudioContext();
    void audioContext.resume().catch(() => undefined);
  } catch {
    // No WebAudio support.
  }
}

type NotificationTone = "completed" | "attention";

const TONES: Record<NotificationTone, ReadonlyArray<number>> = {
  completed: [660, 880],
  attention: [880, 880],
};

const NOTE_SPACING_SECONDS = 0.14;
const NOTE_ATTACK_SECONDS = 0.015;
const NOTE_DECAY_SECONDS = 0.22;
const NOTE_STOP_SECONDS = 0.24;
const NOTE_PEAK_GAIN = 0.18;
const NOTE_SILENT_GAIN = 0.0001;

/** When each tone's current playback ends, on the audio context's clock. */
const playingUntil = new Map<NotificationTone, number>();

/**
 * Plays a short synthesized two-note chime; false when audio is still locked or unavailable.
 * Threads finishing together share one chime, because overlapping copies add up in volume. That
 * still returns true, so their system notifications stay silent; each tone keeps its own slot, so
 * an attention alert is heard over a completion.
 */
export function playThreadNotificationSound(kind: ThreadNotificationKind): boolean {
  const context = audioContext;
  if (!context || context.state !== "running") return false;
  const tone: NotificationTone = kind === "completed" ? "completed" : "attention";
  const start = context.currentTime;
  if (start < (playingUntil.get(tone) ?? 0)) return true;
  const notes = TONES[tone];
  notes.forEach((frequency, index) => {
    const noteStart = start + index * NOTE_SPACING_SECONDS;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(NOTE_SILENT_GAIN, noteStart);
    gain.gain.exponentialRampToValueAtTime(NOTE_PEAK_GAIN, noteStart + NOTE_ATTACK_SECONDS);
    gain.gain.exponentialRampToValueAtTime(NOTE_SILENT_GAIN, noteStart + NOTE_DECAY_SECONDS);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(noteStart);
    oscillator.stop(noteStart + NOTE_STOP_SECONDS);
  });
  playingUntil.set(tone, start + (notes.length - 1) * NOTE_SPACING_SECONDS + NOTE_STOP_SECONDS);
  return true;
}
