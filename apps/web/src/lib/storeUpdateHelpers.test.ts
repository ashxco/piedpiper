import {
  EventId,
  type OrchestrationThreadActivity,
  THREAD_MODEL_SWITCH_ACTIVITY_KIND,
  THREAD_REASONING_ACTIVITY_KIND,
} from "@piedpiper/contracts";
import { describe, expect, it } from "vitest";

import {
  appendThreadActivity,
  capThreadActivities,
  MAX_THREAD_ACTIVITIES,
  MAX_THREAD_REASONING_ACTIVITIES,
} from "./storeUpdateHelpers";

function userInputActivity(
  id: string,
  kind: "user-input.requested" | "user-input.resolved",
  payload: Record<string, unknown>,
): OrchestrationThreadActivity {
  return { ...activity(0, kind), id: EventId.makeUnsafe(id), tone: "info", payload };
}

function activity(index: number, kind = "tool.completed"): OrchestrationThreadActivity {
  return {
    id: EventId.makeUnsafe(`activity-${String(index).padStart(5, "0")}`),
    tone: kind === THREAD_MODEL_SWITCH_ACTIVITY_KIND ? "info" : "tool",
    kind,
    summary: kind,
    payload: {},
    turnId: null,
    sequence: index,
    createdAt: `2026-01-01T00:00:00.000Z`,
  };
}

describe("appendThreadActivity", () => {
  it("keeps model-switch dividers when tool activity pushes past the cap", () => {
    let activities: OrchestrationThreadActivity[] = [];
    activities = appendThreadActivity(activities, activity(0, THREAD_MODEL_SWITCH_ACTIVITY_KIND));
    for (let index = 1; index <= MAX_THREAD_ACTIVITIES + 50; index += 1) {
      activities = appendThreadActivity(activities, activity(index));
    }

    expect(activities.filter((entry) => entry.kind === THREAD_MODEL_SWITCH_ACTIVITY_KIND)).toEqual([
      expect.objectContaining({ id: "activity-00000" }),
    ]);
    expect(
      activities.filter((entry) => entry.kind !== THREAD_MODEL_SWITCH_ACTIVITY_KIND),
    ).toHaveLength(MAX_THREAD_ACTIVITIES);
    expect(activities.at(-1)?.id).toBe(
      `activity-${String(MAX_THREAD_ACTIVITIES + 50).padStart(5, "0")}`,
    );
  });

  it("caps thinking rows while appending, before the 500-row window fills", () => {
    let activities: OrchestrationThreadActivity[] = [];
    for (let index = 0; index < MAX_THREAD_REASONING_ACTIVITIES + 50; index += 1) {
      activities = appendThreadActivity(
        activities,
        activity(index, THREAD_REASONING_ACTIVITY_KIND),
      );
    }

    expect(activities).toHaveLength(MAX_THREAD_REASONING_ACTIVITIES);
    expect(activities[0]?.id).toBe("activity-00050");
  });

  it("lets a dropped thinking row be re-delivered as a fresh append", () => {
    let activities: OrchestrationThreadActivity[] = [];
    for (let index = 0; index < MAX_THREAD_REASONING_ACTIVITIES + 1; index += 1) {
      activities = appendThreadActivity(
        activities,
        activity(index, THREAD_REASONING_ACTIVITY_KIND),
      );
    }
    const redelivered = {
      ...activity(0, THREAD_REASONING_ACTIVITY_KIND),
      sequence: MAX_THREAD_REASONING_ACTIVITIES + 1,
    };

    expect(appendThreadActivity(activities, redelivered).at(-1)?.id).toBe("activity-00000");
  });

  it("keeps an open non-blocking question through a long turn", () => {
    let activities = appendThreadActivity(
      [],
      userInputActivity("question", "user-input.requested", {
        requestId: "open",
        responseMode: "message",
      }),
    );
    for (let index = 1; index <= MAX_THREAD_ACTIVITIES + 10; index += 1) {
      activities = appendThreadActivity(activities, activity(index));
    }

    expect(activities[0]?.id).toBe("question");
    expect(activities).toHaveLength(MAX_THREAD_ACTIVITIES + 1);
  });
});

describe("capThreadActivities", () => {
  it("gives thinking blocks their own window so they never evict tool rows", () => {
    const activities = [
      ...Array.from({ length: MAX_THREAD_ACTIVITIES }, (_, index) => activity(index)),
      ...Array.from({ length: 250 }, (_, index) =>
        activity(MAX_THREAD_ACTIVITIES + index, THREAD_REASONING_ACTIVITY_KIND),
      ),
    ];

    const capped = capThreadActivities(activities);

    expect(capped.filter((entry) => entry.kind === "tool.completed")).toHaveLength(
      MAX_THREAD_ACTIVITIES,
    );
    const thoughts = capped.filter((entry) => entry.kind === THREAD_REASONING_ACTIVITY_KIND);
    expect(thoughts).toHaveLength(MAX_THREAD_REASONING_ACTIVITIES);
    expect(thoughts[0]?.sequence).toBe(MAX_THREAD_ACTIVITIES + 50);
    expect(capThreadActivities(activities.slice(-150))).toHaveLength(150);
  });

  it("keeps open non-blocking questions and held answers past the activity window", () => {
    const message = { responseMode: "message" };
    const activities = [
      userInputActivity("question", "user-input.requested", { requestId: "open", ...message }),
      userInputActivity("answered-question", "user-input.requested", {
        requestId: "r",
        ...message,
      }),
      userInputActivity("held", "user-input.resolved", { requestId: "r", held: true, ...message }),
      userInputActivity("dismissed-question", "user-input.requested", {
        requestId: "d",
        ...message,
      }),
      userInputActivity("dismissed", "user-input.resolved", { requestId: "d", ...message }),
      userInputActivity("blocking", "user-input.requested", { requestId: "b" }),
      userInputActivity("answered", "user-input.resolved", { requestId: "b" }),
      ...Array.from({ length: MAX_THREAD_ACTIVITIES }, (_, index) => activity(index)),
    ];

    const ids = capThreadActivities(activities).map((entry) => entry.id as string);

    expect(ids).toHaveLength(MAX_THREAD_ACTIVITIES + 2);
    expect(ids.slice(0, 2)).toEqual(["question", "held"]);
  });

  it("lets a question age out when its resolution sorts before it", () => {
    const activities = [
      userInputActivity("early-answer", "user-input.resolved", { requestId: "early" }),
      userInputActivity("early-question", "user-input.requested", {
        requestId: "early",
        responseMode: "message",
      }),
      ...Array.from({ length: MAX_THREAD_ACTIVITIES }, (_, index) => activity(index)),
    ];

    const ids = capThreadActivities(activities).map((entry) => entry.id as string);

    expect(ids).not.toContain("early-question");
  });
});
