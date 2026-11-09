import { EventId, MessageId, ThreadId, TurnId } from "@piedpiper/contracts";
import { describe, expect, it } from "vitest";

import {
  deriveArmedUsageLimitResume,
  isUsageLimitResumeMessageId,
  type UsageLimitResumeThread,
} from "./usageLimitResume";

const turnId = TurnId.makeUnsafe("turn-1");
const failedAt = "2026-03-01T10:00:00.000Z";
const resetAt = "2026-03-01T15:00:00.000Z";
const nowMs = Date.parse("2026-03-01T11:00:00.000Z");

const limitActivity = (reset: string | null = resetAt) =>
  ({
    id: EventId.makeUnsafe("evt-limit"),
    tone: "error",
    kind: "turn.usage-limit-reached",
    summary: "Usage limit reached",
    payload: { resetAt: reset },
    turnId,
    createdAt: failedAt,
  }) as UsageLimitResumeThread["activities"][number];

const makeThread = (overrides: Partial<UsageLimitResumeThread> = {}): UsageLimitResumeThread => ({
  activities: [limitActivity()],
  archivedAt: null,
  latestTurn: {
    turnId,
    state: "error",
    requestedAt: failedAt,
    startedAt: failedAt,
    completedAt: failedAt,
    assistantMessageId: null,
  },
  messages: [],
  session: {
    provider: "claudeAgent",
    status: "error",
    orchestrationStatus: "error",
    createdAt: failedAt,
    updatedAt: failedAt,
  },
  ...overrides,
});

const derive = (thread: UsageLimitResumeThread, enabled = true, now = nowMs) =>
  deriveArmedUsageLimitResume(thread, enabled, now);

describe("deriveArmedUsageLimitResume", () => {
  it("names the turn and reset while the reset is still ahead", () => {
    expect(derive(makeThread())).toEqual({ turnId, resetAt });
  });

  it("stops holding once the reset is due", () => {
    expect(derive(makeThread(), true, Date.parse(resetAt))).toBeNull();
  });

  it.each<[string, UsageLimitResumeThread]>([
    ["no limit", makeThread({ activities: [] })],
    ["unknown reset", makeThread({ activities: [limitActivity(null)] })],
    ["reset before the failure", makeThread({ activities: [limitActivity(failedAt)] })],
    ["archived", makeThread({ archivedAt: failedAt })],
    [
      "cancelled",
      makeThread({
        activities: [
          limitActivity(),
          {
            ...limitActivity(),
            id: EventId.makeUnsafe("evt-cancel"),
            kind: "turn.usage-limit-resume-cancelled",
            payload: {},
          },
        ],
      }),
    ],
    [
      "newer turn",
      makeThread({
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-2"),
          state: "error",
          requestedAt: failedAt,
          startedAt: failedAt,
          completedAt: failedAt,
          assistantMessageId: null,
        },
      }),
    ],
    [
      "stopped turn",
      makeThread({
        latestTurn: {
          turnId,
          state: "interrupted",
          requestedAt: failedAt,
          startedAt: failedAt,
          completedAt: failedAt,
          assistantMessageId: null,
        },
      }),
    ],
    [
      "newer user message",
      makeThread({
        messages: [
          {
            id: MessageId.makeUnsafe("msg-1"),
            role: "user",
            text: "hi",
            turnId: null,
            createdAt: "2026-03-01T10:30:00.000Z",
            streaming: false,
          },
        ],
      }),
    ],
    [
      "busy session",
      makeThread({
        session: {
          provider: "claudeAgent",
          status: "running",
          orchestrationStatus: "running",
          createdAt: failedAt,
          updatedAt: failedAt,
        },
      }),
    ],
    [
      "pending approval",
      makeThread({
        activities: [
          limitActivity(),
          {
            id: EventId.makeUnsafe("evt-approval"),
            tone: "approval",
            kind: "approval.requested",
            summary: "Approval",
            payload: { requestId: "req-1", requestKind: "command" },
            turnId,
            createdAt: failedAt,
          },
        ],
      }),
    ],
  ])("is not armed: %s", (_label, thread) => {
    expect(derive(thread)).toBeNull();
  });

  it("is not armed with the setting off", () => {
    expect(derive(makeThread(), false)).toBeNull();
  });
});

describe("isUsageLimitResumeMessageId", () => {
  it("recognizes only the server's resume ids", () => {
    expect(isUsageLimitResumeMessageId(`usage-limit-resume:${ThreadId.makeUnsafe("t")}:a:1`)).toBe(
      true,
    );
    expect(isUsageLimitResumeMessageId("message-1")).toBe(false);
  });
});

describe("deriveArmedUsageLimitResume with an open question", () => {
  const question = (responseMode: "message" | "blocking") =>
    ({
      id: EventId.makeUnsafe(`evt-question-${responseMode}`),
      tone: "info",
      kind: "user-input.requested",
      summary: "User input requested",
      payload: {
        requestId: "req-1",
        responseMode,
        questions: [
          { id: "q", header: "H", question: "Q?", options: [{ label: "a", description: "a" }] },
        ],
      },
      turnId,
      createdAt: failedAt,
    }) as UsageLimitResumeThread["activities"][number];

  it("stays armed for a message-mode question, as the server does", () => {
    const thread = makeThread({ activities: [limitActivity(), question("message")] });
    expect(deriveArmedUsageLimitResume(thread, true, nowMs)).not.toBeNull();
  });

  it("stands down for a blocking one", () => {
    const thread = makeThread({ activities: [limitActivity(), question("blocking")] });
    expect(deriveArmedUsageLimitResume(thread, true, nowMs)).toBeNull();
  });
});
