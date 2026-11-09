import { EventId, type ProviderEvent, ThreadId, TurnId } from "@piedpiper/contracts";
import { describe, expect, it } from "vitest";

import { mapToRuntimeEvents } from "./CodexAdapterHelpers.ts";
import {
  codexAccountUsageLimits,
  codexRateLimitsToWindows,
  codexUsageLimitMessage,
  codexUsageLimitReset,
  isCodexUsageLimitError,
  makeCodexUsageLimitTracker,
  mergeCodexRateLimits,
  readCodexRateLimitsResponse,
} from "./CodexUsageLimits.ts";

const at = "2026-01-01T00:00:00.000Z";
const atSeconds = Date.parse(at) / 1000;
const threadId = ThreadId.makeUnsafe("thread-1");
const providerSentence = "You've hit your usage limit. Purchase more credits to continue.";

function makeEvent(method: string, payload: unknown): ProviderEvent {
  return {
    id: EventId.makeUnsafe(`evt-${method}`),
    kind: "notification",
    provider: "codex",
    threadId,
    turnId: TurnId.makeUnsafe("turn-1"),
    createdAt: at,
    method,
    payload,
  } as ProviderEvent;
}

describe("codexUsageLimitMessage", () => {
  it("names the exhausted window that resets last and the workspace's missing credits", () => {
    expect(
      codexUsageLimitMessage(
        {
          limitId: "codex",
          rateLimitReachedType: "workspace_owner_credits_depleted",
          primary: { usedPercent: 40, resetsAt: atSeconds + 3_600, windowDurationMins: 300 },
          secondary: {
            usedPercent: 100,
            resetsAt: atSeconds + 5 * 86_400 + 5 * 3_600,
            windowDurationMins: 10_080,
          },
        },
        at,
      ),
    ).toBe(
      "Codex usage limit reached. The weekly limit resets in 5d 5h. The workspace has no credits to continue sooner: ask your workspace owner to add credits, or send the message again once the limit resets.",
    );
  });

  it("points a reached spend cap at the workspace owner", () => {
    expect(
      codexUsageLimitMessage(
        {
          rateLimitReachedType: "workspace_member_usage_limit_reached",
          primary: { usedPercent: 100, resetsAt: atSeconds + 3 * 3_600 + 20 * 60 },
        },
        at,
      ),
    ).toBe(
      "Codex usage limit reached. The session limit resets in 3h 20m. The workspace spend limit is reached: ask your workspace owner to raise it, or send the message again once the limit resets.",
    );
  });

  it("says only what it knows without a snapshot or with an already-reset window", () => {
    const fallback = "Codex usage limit reached. Send the message again once the limit resets.";
    expect(codexUsageLimitMessage(undefined, at)).toBe(fallback);
    expect(
      codexUsageLimitMessage({ primary: { usedPercent: 100, resetsAt: atSeconds - 60 } }, at),
    ).toBe(fallback);
  });
});

describe("mergeCodexRateLimits", () => {
  it("keeps windows a sparse update does not carry", () => {
    expect(
      mergeCodexRateLimits(
        { limitId: "codex", primary: { usedPercent: 100, resetsAt: 1, windowDurationMins: 300 } },
        { rateLimitReachedType: "rate_limit_reached" },
      ),
    ).toEqual({
      limitId: "codex",
      rateLimitReachedType: "rate_limit_reached",
      primary: { usedPercent: 100, resetsAt: 1, windowDurationMins: 300 },
    });
  });

  it("ignores a model-specific snapshot", () => {
    const main = { limitId: "codex", primary: { usedPercent: 100 } };
    expect(mergeCodexRateLimits(main, { limitId: "spark", primary: { usedPercent: 3 } })).toBe(
      main,
    );
  });
});

describe("makeCodexUsageLimitTracker", () => {
  const run = (tracker: ReturnType<typeof makeCodexUsageLimitTracker>, event: ProviderEvent) =>
    tracker.apply(event, mapToRuntimeEvents(event, threadId));

  it("replaces the doubled provider sentence with one message naming the window", () => {
    const tracker = makeCodexUsageLimitTracker();
    run(
      tracker,
      makeEvent("account/rateLimits/updated", {
        rateLimits: {
          limitId: "codex",
          secondary: {
            usedPercent: 100,
            resetsAt: atSeconds + 2 * 86_400,
            windowDurationMins: 10_080,
          },
        },
      }),
    );
    run(
      tracker,
      makeEvent("account/rateLimits/updated", {
        rateLimits: { rateLimitReachedType: "rate_limit_reached" },
      }),
    );

    const errorEvents = run(
      tracker,
      makeEvent("error", {
        error: { message: providerSentence, codexErrorInfo: "usageLimitExceeded" },
        willRetry: false,
      }),
    );
    expect(errorEvents).toEqual([]);

    const completed = run(
      tracker,
      makeEvent("turn/completed", {
        turn: {
          id: "turn-1",
          status: "failed",
          error: { message: providerSentence, codexErrorInfo: "usageLimitExceeded" },
        },
      }),
    );
    const expected =
      "Codex usage limit reached. The weekly limit resets in 2d. Send the message again once the limit resets.";
    expect(completed.map((event) => event.type)).toEqual(["runtime.error", "turn.completed"]);
    const [error, turn] = completed;
    if (error?.type !== "runtime.error" || turn?.type !== "turn.completed")
      throw new Error("shape");
    expect(error.payload.message).toBe(expected);
    expect(error.payload.detail).toBe(providerSentence);
    expect(turn.payload.errorMessage).toBe(expected);
    expect(turn.payload.rateLimitResetAt).toBe(
      new Date((atSeconds + 2 * 86_400) * 1000).toISOString(),
    );
    expect(turn.payload.rateLimitTypes).toEqual(["rate_limit_reached"]);
  });

  it("marks a usage-limit stop with an unknown reset when no snapshot arrived", () => {
    const tracker = makeCodexUsageLimitTracker();
    const completed = run(
      tracker,
      makeEvent("turn/completed", {
        turn: {
          id: "turn-1",
          status: "failed",
          error: { message: providerSentence, codexErrorInfo: "usageLimitExceeded" },
        },
      }),
    );
    const turn = completed.find((event) => event.type === "turn.completed");
    if (turn?.type !== "turn.completed") throw new Error("shape");
    expect(turn.payload.rateLimitResetAt).toBeNull();
    expect(turn.payload).not.toHaveProperty("rateLimitTypes");
  });

  it("leaves the reset fields absent on a failure that is not a usage limit", () => {
    const tracker = makeCodexUsageLimitTracker();
    run(
      tracker,
      makeEvent("account/rateLimits/updated", {
        rateLimits: {
          limitId: "codex",
          rateLimitReachedType: "rate_limit_reached",
          primary: { usedPercent: 100, resetsAt: atSeconds + 3_600 },
        },
      }),
    );
    const completed = run(
      tracker,
      makeEvent("turn/completed", {
        turn: { id: "turn-1", status: "failed", error: { message: "Model crashed." } },
      }),
    );
    const turn = completed.find((event) => event.type === "turn.completed");
    if (turn?.type !== "turn.completed") throw new Error("shape");
    expect(turn.payload).not.toHaveProperty("rateLimitResetAt");
    expect(turn.payload).not.toHaveProperty("rateLimitTypes");
  });

  it("leaves other errors and failures untouched", () => {
    const tracker = makeCodexUsageLimitTracker();
    const otherError = run(
      tracker,
      makeEvent("error", { error: { message: "boom", codexErrorInfo: "internalServerError" } }),
    );
    expect(otherError.map((event) => event.type)).toEqual(["runtime.error"]);
    const completed = run(
      tracker,
      makeEvent("turn/completed", {
        turn: { id: "turn-1", status: "failed", error: { message: "boom" } },
      }),
    );
    expect(completed.map((event) => event.type)).toEqual(["turn.completed"]);
    if (completed[0]?.type !== "turn.completed") throw new Error("shape");
    expect(completed[0].payload.errorMessage).toBe("boom");
  });

  it("treats 429 retry exhaustion and rate-limit errors as usage limits", () => {
    expect(
      isCodexUsageLimitError({
        codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 429 } },
      }),
    ).toBe(true);
    expect(isCodexUsageLimitError({ codexErrorInfo: "rateLimitExceeded" })).toBe(true);
    expect(isCodexUsageLimitError({ codexErrorInfo: { usageLimitExceeded: {} } })).toBe(true);
    expect(
      isCodexUsageLimitError({
        codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 500 } },
      }),
    ).toBe(false);
    expect(isCodexUsageLimitError({ codexErrorInfo: { responseTooManyFailedAttempts: {} } })).toBe(
      false,
    );
  });

  it("rewrites a 429 exhaustion whose completion repeats the cause", () => {
    const tracker = makeCodexUsageLimitTracker();
    const exhausted = {
      message: "exceeded retry limit, last status: 429 Too Many Requests",
      codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 429 } },
    };
    expect(run(tracker, makeEvent("error", { error: exhausted, willRetry: false }))).toEqual([]);
    const completed = run(
      tracker,
      makeEvent("turn/completed", { turn: { id: "turn-1", status: "failed", error: exhausted } }),
    );
    expect(completed.map((event) => event.type)).toEqual(["runtime.error", "turn.completed"]);
    if (completed[0]?.type !== "runtime.error") throw new Error("shape");
    expect(completed[0].payload.message).toBe(
      "Codex usage limit reached. Send the message again once the limit resets.",
    );
    expect(completed[0].payload.detail).toBe(exhausted.message);
  });

  it("rewrites a completion without error info after a suppressed 429 notification", () => {
    const tracker = makeCodexUsageLimitTracker();
    const message = "exceeded retry limit, last status: 429 Too Many Requests";
    expect(
      run(
        tracker,
        makeEvent("error", {
          error: {
            message,
            codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 429 } },
          },
          willRetry: false,
        }),
      ),
    ).toEqual([]);
    const completed = run(
      tracker,
      makeEvent("turn/completed", { turn: { id: "turn-1", status: "failed", error: null } }),
    );
    expect(completed.map((event) => event.type)).toEqual(["runtime.error", "turn.completed"]);
    if (completed[0]?.type !== "runtime.error" || completed[1]?.type !== "turn.completed") {
      throw new Error("shape");
    }
    expect(completed[0].payload.detail).toBe(message);
    expect(completed[1].payload.errorMessage).toBe(completed[0].payload.message);
  });

  it("lets an explicit non-limit cause on the completion win over the notification", () => {
    const tracker = makeCodexUsageLimitTracker();
    run(
      tracker,
      makeEvent("error", {
        error: {
          message: "429",
          codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 429 } },
        },
        willRetry: false,
      }),
    );
    const completed = run(
      tracker,
      makeEvent("turn/completed", {
        turn: {
          id: "turn-1",
          status: "failed",
          error: {
            message: "server error",
            codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 500 } },
          },
        },
      }),
    );
    expect(completed.map((event) => event.type)).toEqual(["turn.completed"]);
  });

  it("shows a subagent's limit error and never pins it on the main turn", () => {
    const tracker = makeCodexUsageLimitTracker();
    run(tracker, makeEvent("turn/started", { threadId: "provider-main", turn: { id: "turn-1" } }));
    const childError = run(
      tracker,
      makeEvent("error", {
        threadId: "provider-child",
        error: { message: "429", codexErrorInfo: "rateLimitExceeded" },
        willRetry: false,
      }),
    );
    expect(childError.map((event) => event.type)).toEqual(["runtime.error"]);

    const completed = run(
      tracker,
      makeEvent("turn/completed", {
        threadId: "provider-main",
        turn: { id: "turn-1", status: "failed", error: null },
      }),
    );
    expect(completed.map((event) => event.type)).toEqual(["turn.completed"]);

    // The main conversation's own limit error is still suppressed and rewritten.
    run(tracker, makeEvent("turn/started", { threadId: "provider-main", turn: { id: "turn-2" } }));
    expect(
      run(
        tracker,
        makeEvent("error", {
          threadId: "provider-main",
          error: { message: "429", codexErrorInfo: "rateLimitExceeded" },
          willRetry: false,
        }),
      ),
    ).toEqual([]);
    const mainCompleted = run(
      tracker,
      makeEvent("turn/completed", {
        threadId: "provider-main",
        turn: { id: "turn-2", status: "failed", error: null },
      }),
    );
    expect(mainCompleted.map((event) => event.type)).toEqual(["runtime.error", "turn.completed"]);
  });

  it("forgets the snapshot when the session closes", () => {
    const tracker = makeCodexUsageLimitTracker();
    run(
      tracker,
      makeEvent("account/rateLimits/updated", {
        rateLimits: { primary: { usedPercent: 100, resetsAt: atSeconds + 600 } },
      }),
    );
    tracker.apply(makeEvent("session/closed", undefined), []);
    const [error] = run(
      tracker,
      makeEvent("turn/completed", {
        turn: {
          status: "failed",
          error: { message: providerSentence, codexErrorInfo: "usageLimitExceeded" },
        },
      }),
    );
    if (error?.type !== "runtime.error") throw new Error("shape");
    expect(error.payload.message).toBe(
      "Codex usage limit reached. Send the message again once the limit resets.",
    );
  });
});

describe("codexUsageLimitReset", () => {
  const exhausted = (hours: number) => ({
    usedPercent: 100,
    resetsAt: atSeconds + hours * 3_600,
  });
  const iso = (hours: number) => new Date((atSeconds + hours * 3_600) * 1000).toISOString();

  it("knows nothing without a snapshot", () => {
    expect(codexUsageLimitReset(undefined)).toEqual({ resetAt: null, limitTypes: [] });
  });

  it("is unknown when no window is exhausted", () => {
    expect(
      codexUsageLimitReset({
        primary: { usedPercent: 99, resetsAt: atSeconds + 3_600 },
        rateLimitReachedType: "rate_limit_reached",
      }),
    ).toEqual({ resetAt: null, limitTypes: ["rate_limit_reached"] });
  });

  it("is unknown when any exhausted window has no reset", () => {
    expect(
      codexUsageLimitReset({
        primary: exhausted(1),
        secondary: { usedPercent: 100 },
      }).resetAt,
    ).toBeNull();
  });

  it("takes the latest reset of the exhausted windows and ignores the others", () => {
    expect(codexUsageLimitReset({ primary: exhausted(1), secondary: exhausted(48) }).resetAt).toBe(
      iso(48),
    );
    expect(
      codexUsageLimitReset({
        primary: exhausted(1),
        secondary: { usedPercent: 40, resetsAt: atSeconds + 48 * 3_600 },
      }).resetAt,
    ).toBe(iso(1));
  });

  it("names the limit type only when the snapshot reports one", () => {
    expect(codexUsageLimitReset({ primary: exhausted(1) }).limitTypes).toEqual([]);
    expect(
      codexUsageLimitReset({ primary: exhausted(1), rateLimitReachedType: null }).limitTypes,
    ).toEqual([]);
    expect(
      codexUsageLimitReset({ primary: exhausted(1), rateLimitReachedType: "rate_limit_reached" })
        .limitTypes,
    ).toEqual(["rate_limit_reached"]);
  });
});

describe("codexRateLimitsToWindows", () => {
  it("maps reported durations, percentages and epoch-second resets", () => {
    expect(
      codexRateLimitsToWindows({
        primary: { usedPercent: 12, resetsAt: atSeconds + 60, windowDurationMins: 300 },
        secondary: { usedPercent: 140, resetsAt: atSeconds + 120, windowDurationMins: 10_080 },
      }),
    ).toEqual([
      {
        id: "primary",
        kind: "session",
        label: "Session",
        usedPercent: 12,
        windowDurationMins: 300,
        resetsAt: "2026-01-01T00:01:00.000Z",
      },
      {
        id: "secondary",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 100,
        windowDurationMins: 10_080,
        resetsAt: "2026-01-01T00:02:00.000Z",
      },
    ]);
  });

  it("falls back by position and plan when no duration is reported", () => {
    expect(
      codexRateLimitsToWindows({ primary: { usedPercent: 1 }, secondary: { usedPercent: 2 } }).map(
        (window) => window.kind,
      ),
    ).toEqual(["session", "weekly"]);
    expect(
      codexRateLimitsToWindows({ planType: "free", primary: { usedPercent: 1 } }).map(
        (window) => window.kind,
      ),
    ).toEqual(["monthly"]);
  });

  it("skips windows without a usage figure", () => {
    expect(codexRateLimitsToWindows({ primary: null, secondary: { resetsAt: atSeconds } })).toEqual(
      [],
    );
  });
});

describe("readCodexRateLimitsResponse", () => {
  it("prefers the codex bucket over the single-bucket view", () => {
    expect(
      readCodexRateLimitsResponse({
        rateLimits: { limitId: "codex_spark", primary: { usedPercent: 90 } },
        rateLimitsByLimitId: { codex: { limitId: "codex", primary: { usedPercent: 10 } } },
      })?.primary?.usedPercent,
    ).toBe(10);
  });

  it("reads the single-bucket view from CLIs without buckets", () => {
    expect(
      readCodexRateLimitsResponse({ rateLimits: { primary: { usedPercent: 20 } } })?.primary
        ?.usedPercent,
    ).toBe(20);
  });
});

describe("codexAccountUsageLimits", () => {
  const readAt = "2026-01-01T00:05:00.000Z";

  it("reports an API key account as unsupported", () => {
    expect(codexAccountUsageLimits({ type: "apiKey" }, at)).toEqual({
      checkedAt: at,
      windows: [],
      unavailable: { reason: "unsupported" },
    });
  });

  it("reports a failed account probe and a failed usage read as probe failures", () => {
    expect(codexAccountUsageLimits(undefined, at)?.unavailable?.reason).toBe("probeFailed");
    expect(
      codexAccountUsageLimits(
        { type: "chatgpt", rateLimits: { readAt, failure: "Codex could not read usage." } },
        at,
      ),
    ).toEqual({
      checkedAt: readAt,
      windows: [],
      unavailable: { reason: "probeFailed", message: "Codex could not read usage." },
    });
  });

  it("dates windows by when they were read, which a cached probe can predate", () => {
    const limits = codexAccountUsageLimits(
      {
        type: "chatgpt",
        rateLimits: { readAt, response: { rateLimits: { primary: { usedPercent: 5 } } } },
      },
      "2026-01-01T00:09:00.000Z",
    );
    expect(limits?.checkedAt).toBe(readAt);
    expect(limits?.windows.map((window) => window.id)).toEqual(["primary"]);
    expect(limits?.unavailable).toBeUndefined();
  });

  it("knows nothing about a signed-out account", () => {
    expect(codexAccountUsageLimits({ type: "unknown" }, at)).toBeUndefined();
  });
});
