import { ThreadId } from "@piedpiper/contracts";
import { describe, expect, it } from "vitest";

import type { ThreadSnooze } from "../uiStateStore";
import { getVisibleSidebarThreadIds } from "./Sidebar.logic";
import {
  buildThreadSnoozeMenuItems,
  canSnoozeThread,
  createThreadSnooze,
  effectiveSnoozed,
  hasUnseenThreadWake,
  partitionSnoozedThreads,
  reconcileThreadSnoozes,
  resolveSnoozeMenuPick,
  resolveSnoozePresets,
  resolveSnoozeTimerDelayMs,
  resolveThreadSnoozeBlock,
  shouldSuppressSnoozedThreadNotification,
  snoozeWakeDescription,
  snoozeWakeLabel,
  sortSnoozedThreadsByWake,
  threadRaisedHandWhileSnoozed,
  threadSentSinceSnooze,
  threadWakeEdgeAt,
  type ThreadSnoozeShell,
} from "./Sidebar.snooze";

// Local-time constructor so preset maths is timezone-stable in tests.
function localDate(year: number, month: number, day: number, hour: number, minute = 0): Date {
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

const SNOOZED_AT = "2026-04-10T09:00:00.000Z";
const BEFORE_SNOOZE = "2026-04-10T08:00:00.000Z";
const AFTER_SNOOZE = "2026-04-10T10:00:00.000Z";
const NOW_MS = Date.parse("2026-04-10T12:00:00.000Z");
const FUTURE_WAKE = "2026-04-11T09:00:00.000Z";
const PAST_WAKE = "2026-04-10T11:00:00.000Z";

function makeSnooze(overrides: Partial<ThreadSnooze> = {}): ThreadSnooze {
  return {
    snoozedUntil: FUTURE_WAKE,
    snoozedAt: SNOOZED_AT,
    questionPendingAtSnooze: false,
    ...overrides,
  };
}

function makeThread(overrides: Partial<ThreadSnoozeShell> = {}): ThreadSnoozeShell {
  return {
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    latestTurn: null,
    latestUserMessageAt: BEFORE_SNOOZE,
    session: null,
    ...overrides,
  };
}

function makeTurn(state: "completed" | "error", completedAt: string) {
  return {
    state,
    completedAt,
    requestedAt: completedAt,
    startedAt: completedAt,
  } as unknown as NonNullable<ThreadSnoozeShell["latestTurn"]>;
}

function makeSession(status: "error" | "running", updatedAt: string) {
  return { status, updatedAt } as unknown as NonNullable<ThreadSnoozeShell["session"]>;
}

describe("resolveSnoozePresets", () => {
  it("offers hour, evening, tomorrow and next week in the morning", () => {
    // Wednesday.
    const presets = resolveSnoozePresets(localDate(2026, 4, 8, 10));
    expect(presets.map((preset) => preset.id)).toEqual([
      "hour",
      "evening",
      "tomorrow",
      "next-week",
    ]);
    const until = (id: string) =>
      new Date(presets.find((preset) => preset.id === id)!.snoozedUntil);
    expect(until("evening").getHours()).toBe(18);
    expect(until("tomorrow").getDate()).toBe(9);
    expect(until("tomorrow").getHours()).toBe(9);
    expect(until("next-week").getDay()).toBe(1);
    expect(until("next-week").getDate()).toBe(13);
  });

  it("drops the evening preset once it is within an hour or past", () => {
    for (const hour of [17, 21]) {
      expect(
        resolveSnoozePresets(localDate(2026, 4, 8, hour, 30)).map((preset) => preset.id),
      ).toEqual(["hour", "tomorrow", "next-week"]);
    }
  });

  it("puts next week a full week out on a Monday", () => {
    const presets = resolveSnoozePresets(localDate(2026, 4, 6, 10));
    const nextWeek = new Date(presets.find((preset) => preset.id === "next-week")!.snoozedUntil);
    expect(nextWeek.getDate()).toBe(13);
  });

  it("de-duplicates wake times: on Sunday next Monday is also tomorrow", () => {
    const ids = resolveSnoozePresets(localDate(2026, 4, 5, 10)).map((preset) => preset.id);
    expect(ids).toEqual(["hour", "evening", "tomorrow"]);
  });

  it("uses calendar days, not 24 hours, across a DST change", () => {
    // Works in any zone: the morning preset is always 9:00 on the next local date.
    for (const start of [localDate(2026, 3, 7, 23, 30), localDate(2026, 10, 24, 23, 30)]) {
      const tomorrow = new Date(
        resolveSnoozePresets(start).find((preset) => preset.id === "tomorrow")!.snoozedUntil,
      );
      expect(tomorrow.getDate()).toBe(start.getDate() + 1);
      expect(tomorrow.getHours()).toBe(9);
      expect(tomorrow.getMinutes()).toBe(0);
    }
  });
});

describe("native snooze menu items", () => {
  const presets = resolveSnoozePresets(localDate(2026, 4, 8, 10));

  it("lists the presets, disabled while the thread cannot be snoozed", () => {
    const items = buildThreadSnoozeMenuItems({ presets, snoozed: false, canSnooze: false });
    expect(items.map((item) => item.id)).toEqual([
      "snooze-hour",
      "snooze-evening",
      "snooze-tomorrow",
      "snooze-next-week",
    ]);
    expect(items.every((item) => item.disabled)).toBe(true);
  });

  it("names the selection size in a multi-select menu", () => {
    const items = buildThreadSnoozeMenuItems({
      presets,
      snoozed: false,
      canSnooze: true,
      count: 3,
    });
    expect(items[0]?.label).toMatch(/^Snooze \(3\): In 1 hour/);
    expect(items.every((item) => !item.disabled)).toBe(true);
  });

  it("offers only Wake now on a snoozed thread", () => {
    expect(buildThreadSnoozeMenuItems({ presets, snoozed: true, canSnooze: true })).toEqual([
      { id: "wake", label: "Wake now" },
    ]);
  });

  it("maps a click back to its wake time, ignoring other items", () => {
    const tomorrow = presets.find((preset) => preset.id === "tomorrow")!;
    expect(resolveSnoozeMenuPick("snooze-tomorrow", presets)).toBe(tomorrow.snoozedUntil);
    expect(resolveSnoozeMenuPick("rename", presets)).toBeNull();
    expect(resolveSnoozeMenuPick(null, presets)).toBeNull();
  });
});

describe("snooze labels", () => {
  const now = localDate(2026, 4, 8, 10);
  const nowMs = now.getTime();

  it("rounds the wake label up through minutes, hours and days", () => {
    const inMs = (ms: number) => new Date(nowMs + ms).toISOString();
    expect(snoozeWakeLabel(inMs(30 * 60_000), nowMs)).toBe("30m");
    expect(snoozeWakeLabel(inMs(1_000), nowMs)).toBe("1m");
    expect(snoozeWakeLabel(inMs(90 * 60_000), nowMs)).toBe("2h");
    expect(snoozeWakeLabel(inMs(26 * 3_600_000), nowMs)).toBe("2d");
    expect(snoozeWakeLabel(inMs(-1_000), nowMs)).toBe("now");
    expect(snoozeWakeLabel("not-a-date", nowMs)).toBe("now");
  });

  it("describes today by time, the next day as tomorrow, and the week by weekday", () => {
    const describeAt = (date: Date) => snoozeWakeDescription(date.toISOString(), nowMs);
    expect(describeAt(localDate(2026, 4, 8, 18))).not.toContain("tomorrow");
    expect(describeAt(localDate(2026, 4, 9, 9))).toContain("tomorrow");
    expect(describeAt(localDate(2026, 4, 13, 9))).toMatch(/Mon/);
    expect(describeAt(localDate(2026, 4, 20, 9))).toMatch(/Apr/);
    expect(snoozeWakeDescription("not-a-date", nowMs)).toBe("");
  });
});

describe("effectiveSnoozed", () => {
  it("holds until the timer, and is off with no snooze or a malformed one", () => {
    expect(effectiveSnoozed(makeThread(), makeSnooze(), NOW_MS)).toBe(true);
    expect(effectiveSnoozed(makeThread(), makeSnooze({ snoozedUntil: PAST_WAKE }), NOW_MS)).toBe(
      false,
    );
    expect(effectiveSnoozed(makeThread(), undefined, NOW_MS)).toBe(false);
    expect(effectiveSnoozed(undefined, makeSnooze(), NOW_MS)).toBe(false);
    expect(effectiveSnoozed(makeThread(), makeSnooze({ snoozedUntil: "soon" }), NOW_MS)).toBe(
      false,
    );
  });

  it("wakes for a pending approval", () => {
    expect(effectiveSnoozed(makeThread({ hasPendingApprovals: true }), makeSnooze(), NOW_MS)).toBe(
      false,
    );
  });

  it("wakes for a new question but not one already pending when snoozed", () => {
    const thread = makeThread({ hasPendingUserInput: true });
    expect(effectiveSnoozed(thread, makeSnooze(), NOW_MS)).toBe(false);
    expect(effectiveSnoozed(thread, makeSnooze({ questionPendingAtSnooze: true }), NOW_MS)).toBe(
      true,
    );
  });

  it("wakes for a failure after the snooze but not one the user already saw", () => {
    const failedAt = (at: string) =>
      makeThread({ latestTurn: makeTurn("error", at), session: makeSession("error", at) });
    expect(effectiveSnoozed(failedAt(AFTER_SNOOZE), makeSnooze(), NOW_MS)).toBe(false);
    expect(effectiveSnoozed(failedAt(BEFORE_SNOOZE), makeSnooze(), NOW_MS)).toBe(true);
    expect(
      effectiveSnoozed(
        makeThread({ session: makeSession("error", AFTER_SNOOZE) }),
        makeSnooze(),
        NOW_MS,
      ),
    ).toBe(false);
  });

  it("does not wake for a turn completing after the snooze", () => {
    expect(
      effectiveSnoozed(
        makeThread({ latestTurn: makeTurn("completed", AFTER_SNOOZE) }),
        makeSnooze(),
        NOW_MS,
      ),
    ).toBe(true);
  });

  it("ends once the user sends to the thread", () => {
    expect(
      effectiveSnoozed(makeThread({ latestUserMessageAt: AFTER_SNOOZE }), makeSnooze(), NOW_MS),
    ).toBe(false);
  });
});

describe("hasUnseenThreadWake", () => {
  it("keeps an unseen marker until a visit at or after the wake", () => {
    const snooze = makeSnooze({ snoozedUntil: PAST_WAKE });
    expect(hasUnseenThreadWake(makeThread(), snooze, undefined)).toBe(true);
    expect(hasUnseenThreadWake(makeThread(), snooze, BEFORE_SNOOZE)).toBe(true);
    expect(hasUnseenThreadWake(makeThread(), snooze, PAST_WAKE)).toBe(false);
  });

  it("clears after a raised-hand wake is seen, and returns for a newer one", () => {
    const failed = makeThread({
      session: {
        provider: "claudeAgent",
        status: "error",
        createdAt: SNOOZED_AT,
        updatedAt: AFTER_SNOOZE,
        orchestrationStatus: "error",
      },
    });
    expect(hasUnseenThreadWake(failed, makeSnooze(), BEFORE_SNOOZE)).toBe(true);
    const seen = makeSnooze({ wakeSeenAt: AFTER_SNOOZE });
    expect(hasUnseenThreadWake(failed, seen, BEFORE_SNOOZE)).toBe(false);
    const failedAgain = makeThread({
      session: { ...failed.session!, updatedAt: NEW_VISIT },
    });
    expect(hasUnseenThreadWake(failedAgain, seen, BEFORE_SNOOZE)).toBe(true);
  });

  describe("question wakes", () => {
    const LATER_METADATA = "2026-04-10T11:30:00.000Z";
    const session = {
      provider: "claudeAgent",
      status: "ready",
      createdAt: SNOOZED_AT,
      updatedAt: LATER_METADATA,
      orchestrationStatus: "stopped",
    } as const;
    const seen = makeSnooze({ wakeSeenAt: AFTER_SNOOZE });

    it("dates the wake from the question, so a session metadata write cannot bring it back", () => {
      const asked = makeThread({
        hasPendingUserInput: true,
        pendingUserInputAt: AFTER_SNOOZE,
        session,
      });
      expect(threadWakeEdgeAt(asked, makeSnooze())).toBe(AFTER_SNOOZE);
      expect(hasUnseenThreadWake(asked, seen, BEFORE_SNOOZE)).toBe(false);
    });

    it("returns for a newer question", () => {
      const askedAgain = makeThread({
        hasPendingUserInput: true,
        pendingUserInputAt: PAST_WAKE,
        session,
      });
      expect(hasUnseenThreadWake(askedAgain, seen, BEFORE_SNOOZE)).toBe(true);
    });

    it("uses whichever of a fresh question and failure came last", () => {
      const failedAt = PAST_WAKE;
      const failure = { latestTurn: makeTurn("error", failedAt) };
      expect(
        threadWakeEdgeAt(
          makeThread({
            ...failure,
            hasPendingUserInput: true,
            pendingUserInputAt: AFTER_SNOOZE,
          }),
          makeSnooze(),
        ),
      ).toBe(failedAt);
      expect(
        threadWakeEdgeAt(
          makeThread({
            ...failure,
            hasPendingUserInput: true,
            pendingUserInputAt: LATER_METADATA,
          }),
          makeSnooze(),
        ),
      ).toBe(LATER_METADATA);
    });

    it("ignores the time of a question that is no longer pending", () => {
      const answered = makeThread({
        hasPendingApprovals: true,
        hasPendingUserInput: false,
        pendingUserInputAt: AFTER_SNOOZE,
        session,
      });
      expect(threadWakeEdgeAt(answered, makeSnooze())).toBe(LATER_METADATA);
    });

    it("returns for an approval that arrives after the question was seen", () => {
      const both = makeThread({
        hasPendingApprovals: true,
        hasPendingUserInput: true,
        pendingUserInputAt: AFTER_SNOOZE,
        session,
      });
      expect(threadWakeEdgeAt(both, makeSnooze())).toBe(LATER_METADATA);
      expect(hasUnseenThreadWake(both, seen, BEFORE_SNOOZE)).toBe(true);
    });

    it("keeps the question's time when it is newer than the pending approval's session time", () => {
      const both = makeThread({
        hasPendingApprovals: true,
        hasPendingUserInput: true,
        pendingUserInputAt: PAST_WAKE,
        session: { ...session, updatedAt: AFTER_SNOOZE },
      });
      expect(threadWakeEdgeAt(both, makeSnooze())).toBe(PAST_WAKE);
      expect(hasUnseenThreadWake(both, seen, BEFORE_SNOOZE)).toBe(true);
    });
  });
});

describe("newer question", () => {
  const pending = { hasPendingUserInput: true };

  it("stays snoozed for the question it was snoozed over, and wakes for a newer one", () => {
    const snooze = makeSnooze({ questionPendingAtSnooze: true });
    expect(threadRaisedHandWhileSnoozed(makeThread(pending), snooze)).toBe(false);
    expect(
      threadRaisedHandWhileSnoozed(
        makeThread({ ...pending, pendingUserInputAt: BEFORE_SNOOZE }),
        snooze,
      ),
    ).toBe(false);
    expect(
      threadRaisedHandWhileSnoozed(
        makeThread({ ...pending, pendingUserInputAt: AFTER_SNOOZE }),
        snooze,
      ),
    ).toBe(true);
  });
});

describe("threadSentSinceSnooze", () => {
  it("counts every user message until the summary separates the user's own", () => {
    expect(
      threadSentSinceSnooze(makeThread({ latestUserMessageAt: AFTER_SNOOZE }), makeSnooze()),
    ).toBe(true);
  });

  it("does not let a server resend end the snooze", () => {
    const resent = makeThread({
      latestUserMessageAt: AFTER_SNOOZE,
      latestManualUserMessageAt: BEFORE_SNOOZE,
    });
    expect(threadSentSinceSnooze(resent, makeSnooze())).toBe(false);
    expect(effectiveSnoozed(resent, makeSnooze(), NOW_MS)).toBe(true);
    expect(
      threadSentSinceSnooze(
        makeThread({ latestUserMessageAt: AFTER_SNOOZE, latestManualUserMessageAt: null }),
        makeSnooze(),
      ),
    ).toBe(false);
    expect(
      threadSentSinceSnooze(
        makeThread({ latestUserMessageAt: AFTER_SNOOZE, latestManualUserMessageAt: AFTER_SNOOZE }),
        makeSnooze(),
      ),
    ).toBe(true);
  });
});

describe("snooze creation", () => {
  it("refuses a thread already waiting on an approval", () => {
    expect(canSnoozeThread(makeThread({ hasPendingApprovals: true }))).toBe(false);
    expect(canSnoozeThread(makeThread({ hasPendingUserInput: true }))).toBe(true);
  });

  it("refuses a turn that was just asked for, until it starts or the grace runs out", () => {
    const sentAt = new Date(NOW_MS - 30_000).toISOString();
    const queued = makeThread({ latestUserMessageAt: sentAt });
    expect(canSnoozeThread(queued, NOW_MS)).toBe(false);
    expect(resolveThreadSnoozeBlock(queued, NOW_MS)).toBe("queued-turn");
    // An older turn does not count as picking the message up.
    expect(
      canSnoozeThread({ ...queued, latestTurn: makeTurn("completed", BEFORE_SNOOZE) }, NOW_MS),
    ).toBe(false);
    const started = new Date(NOW_MS - 20_000).toISOString();
    expect(canSnoozeThread({ ...queued, latestTurn: makeTurn("completed", started) }, NOW_MS)).toBe(
      true,
    );
    expect(canSnoozeThread(queued, NOW_MS + 2 * 60_000)).toBe(true);
    expect(canSnoozeThread(makeThread({ latestUserMessageAt: null }), NOW_MS)).toBe(true);
  });

  it("refuses a session that is still starting", () => {
    const starting = makeThread({
      latestUserMessageAt: null,
      session: {
        provider: "claudeAgent",
        status: "connecting",
        createdAt: SNOOZED_AT,
        updatedAt: SNOOZED_AT,
        orchestrationStatus: "starting",
      },
    });
    expect(canSnoozeThread(starting, NOW_MS)).toBe(false);
  });

  it("records whether a question was already pending", () => {
    expect(
      createThreadSnooze(makeThread({ hasPendingUserInput: true }), FUTURE_WAKE, NOW_MS),
    ).toEqual({
      snoozedUntil: FUTURE_WAKE,
      snoozedAt: new Date(NOW_MS).toISOString(),
      questionPendingAtSnooze: true,
    });
  });
});

describe("partitionSnoozedThreads", () => {
  const ids = ["a", "b", "c", "d"].map((id) => ({ id: ThreadId.makeUnsafe(id) }));

  it("splits in order, and snoozed threads leave the jump and traversal list", () => {
    const snoozedIds = new Set<string>(["b", "d"]);
    const { awake, snoozed } = partitionSnoozedThreads(ids, (id) => snoozedIds.has(id));
    expect(awake.map((thread) => thread.id)).toEqual(["a", "c"]);
    expect(snoozed.map((thread) => thread.id)).toEqual(["b", "d"]);
    expect(
      getVisibleSidebarThreadIds([
        { shouldShowThreadPanel: true, renderedThreadIds: awake.map((thread) => thread.id) },
      ]),
    ).toEqual(["a", "c"]);
  });
});

describe("sortSnoozedThreadsByWake", () => {
  it("puts the soonest wake first and unknown times last, keeping ties in order", () => {
    const threads = ["late", "unknown", "soon", "soon-too"].map((id) => ({
      id: ThreadId.makeUnsafe(id),
    }));
    const wakes: Record<string, string | undefined> = {
      late: FUTURE_WAKE,
      soon: PAST_WAKE,
      "soon-too": PAST_WAKE,
    };
    expect(sortSnoozedThreadsByWake(threads, (id) => wakes[id]).map((thread) => thread.id)).toEqual(
      ["soon", "soon-too", "late", "unknown"],
    );
  });
});

describe("resolveSnoozeTimerDelayMs", () => {
  it("targets the earliest wake still ahead, past the wake moment", () => {
    const delay = resolveSnoozeTimerDelayMs(
      {
        far: makeSnooze({ snoozedUntil: new Date(NOW_MS + 50 * 60_000).toISOString() }),
        near: makeSnooze({ snoozedUntil: new Date(NOW_MS + 60_000).toISOString() }),
        past: makeSnooze({ snoozedUntil: PAST_WAKE }),
      },
      NOW_MS,
    );
    expect(delay).toBeGreaterThan(60_000);
    expect(delay).toBeLessThan(61_000);
  });

  it("is null with nothing ahead, and capped for a far-off wake", () => {
    expect(resolveSnoozeTimerDelayMs({}, NOW_MS)).toBeNull();
    expect(
      resolveSnoozeTimerDelayMs({ past: makeSnooze({ snoozedUntil: PAST_WAKE }) }, NOW_MS),
    ).toBeNull();
    const farOff = new Date(NOW_MS + 90 * 24 * 3_600_000).toISOString();
    expect(
      resolveSnoozeTimerDelayMs({ far: makeSnooze({ snoozedUntil: farOff }) }, NOW_MS),
    ).toBeLessThanOrEqual(3_600_000);
  });

  it("fires at once for a wake the timer slept through", () => {
    const wake = new Date(NOW_MS + 1_000).toISOString();
    const delay = resolveSnoozeTimerDelayMs(
      { due: makeSnooze({ snoozedUntil: wake }) },
      NOW_MS,
      NOW_MS + 60_000,
    );
    expect(delay).toBeLessThan(1_000);
  });
});

describe("reconcileThreadSnoozes", () => {
  const reconcile = (
    snooze: ThreadSnooze,
    thread: ThreadSnoozeShell | undefined,
    options: { lastVisitedAt?: string; route?: boolean } = {},
  ) =>
    reconcileThreadSnoozes(
      { t: snooze },
      {
        threadsById: { t: thread },
        lastVisitedAtById: { t: options.lastVisitedAt },
        routeThreadId: options.route ? ThreadId.makeUnsafe("t") : null,
        nowMs: NOW_MS,
      },
    );

  it("returns the same object when nothing changed", () => {
    const snoozes = { t: makeSnooze() };
    expect(
      reconcileThreadSnoozes(snoozes, {
        threadsById: { t: makeThread() },
        lastVisitedAtById: {},
        routeThreadId: null,
        nowMs: NOW_MS,
      }),
    ).toBe(snoozes);
  });

  it("clears the snooze when the user sent to the thread", () => {
    expect(reconcile(makeSnooze(), makeThread({ latestUserMessageAt: AFTER_SNOOZE }))).toEqual({});
  });

  it("keeps an elapsed snooze until its wake is seen, then drops it", () => {
    const elapsed = makeSnooze({ snoozedUntil: PAST_WAKE });
    expect(reconcile(elapsed, makeThread())).toEqual({ t: elapsed });
    expect(reconcile(elapsed, makeThread(), { lastVisitedAt: NEW_VISIT })).toEqual({});
    expect(reconcile(elapsed, makeThread(), { route: true })).toEqual({});
  });

  it("records a raised-hand wake as seen while the thread is open, once", () => {
    const failed = makeThread({ latestTurn: makeTurn("error", AFTER_SNOOZE) });
    const snooze = makeSnooze();
    expect(reconcile(snooze, failed)).toEqual({ t: snooze });
    const seen = reconcile(snooze, failed, { route: true });
    expect(seen.t?.wakeSeenAt).toBe(AFTER_SNOOZE);
    expect(hasUnseenThreadWake(failed, seen.t!, undefined)).toBe(false);
    const snoozes = { t: seen.t! };
    expect(
      reconcileThreadSnoozes(snoozes, {
        threadsById: { t: failed },
        lastVisitedAtById: {},
        routeThreadId: ThreadId.makeUnsafe("t"),
        nowMs: NOW_MS,
      }),
    ).toBe(snoozes);
  });

  it("keeps an elapsed snooze when an approval follows a seen question", () => {
    const elapsed = makeSnooze({ snoozedUntil: PAST_WAKE, wakeSeenAt: AFTER_SNOOZE });
    const both = makeThread({
      hasPendingApprovals: true,
      hasPendingUserInput: true,
      pendingUserInputAt: AFTER_SNOOZE,
      session: makeSession("running", PAST_WAKE),
    });
    expect(reconcile(elapsed, both)).toEqual({ t: elapsed });
  });

  it("does not mark a still-hidden thread as seen just because it is open", () => {
    const snooze = makeSnooze();
    expect(reconcile(snooze, makeThread(), { route: true })).toEqual({ t: snooze });
  });

  it("keeps an unloaded thread's snooze", () => {
    const snooze = makeSnooze();
    expect(reconcile(snooze, undefined)).toEqual({ t: snooze });
  });

  it("clears the question flag once answered, so the next question wakes", () => {
    const snooze = makeSnooze({ questionPendingAtSnooze: true });
    const next = reconcile(snooze, makeThread());
    expect(next.t?.questionPendingAtSnooze).toBe(false);
    expect(effectiveSnoozed(makeThread({ hasPendingUserInput: true }), next.t, NOW_MS)).toBe(false);
  });
});

const NEW_VISIT = "2026-04-10T11:30:00.000Z";

describe("shouldSuppressSnoozedThreadNotification", () => {
  it("silences completed only, and only while snoozed", () => {
    const input = { thread: makeThread(), snooze: makeSnooze(), nowMs: NOW_MS };
    expect(shouldSuppressSnoozedThreadNotification({ ...input, kind: "completed" })).toBe(true);
    expect(shouldSuppressSnoozedThreadNotification({ ...input, kind: "failed" })).toBe(false);
    expect(shouldSuppressSnoozedThreadNotification({ ...input, kind: "approval" })).toBe(false);
    expect(shouldSuppressSnoozedThreadNotification({ ...input, kind: "input" })).toBe(false);
    expect(
      shouldSuppressSnoozedThreadNotification({ ...input, snooze: undefined, kind: "completed" }),
    ).toBe(false);
  });
});
