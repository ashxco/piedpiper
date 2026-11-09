import {
  EventId,
  MessageId,
  THREAD_USAGE_LIMIT_ACTIVITY_KIND,
  THREAD_USAGE_LIMIT_RESUME_CANCELLED_ACTIVITY_KIND,
  ThreadId,
  TurnId,
  type OrchestrationThreadActivity,
} from "@piedpiper/contracts";
import { describe, expect, it } from "vitest";

import {
  decideUsageLimitResume,
  isRetriableUsageLimitRefusal,
  USAGE_LIMIT_RESUME_MAX_OVERDUE_MS,
  type UsageLimitResumePhase,
  type UsageLimitResumeThread,
} from "./usageLimitResume.ts";

const threadId = ThreadId.makeUnsafe("thread-1");
const turnId = TurnId.makeUnsafe("turn-1");
const failedAt = "2026-03-01T10:00:00.000Z";
const failedMs = Date.parse(failedAt);
const resetAt = "2026-03-01T15:00:00.000Z";
const resetMs = Date.parse(resetAt);
const resumeMessageId = MessageId.makeUnsafe(`usage-limit-resume:thread-1:turn-1:${resetMs}`);

const activity = (
  kind: string,
  payload: unknown,
  overrides: Partial<OrchestrationThreadActivity> = {},
): OrchestrationThreadActivity => ({
  id: EventId.makeUnsafe(`activity-${kind}`),
  tone: "info",
  kind,
  summary: kind,
  payload,
  turnId,
  createdAt: failedAt,
  ...overrides,
});

const limitActivity = (reset: string | null = resetAt) =>
  activity(THREAD_USAGE_LIMIT_ACTIVITY_KIND, { resetAt: reset });

const makeThread = (overrides: Partial<UsageLimitResumeThread> = {}): UsageLimitResumeThread => ({
  activities: [limitActivity()],
  archivedAt: null,
  deletedAt: null,
  latestTurn: {
    turnId,
    state: "error",
    requestedAt: "2026-03-01T09:00:00.000Z",
    startedAt: "2026-03-01T09:00:00.000Z",
    completedAt: failedAt,
    assistantMessageId: null,
  },
  messages: [],
  session: {
    threadId,
    status: "error",
    providerName: "claudeAgent",
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: "limit",
    updatedAt: failedAt,
  },
  ...overrides,
});

const decide = (
  thread: UsageLimitResumeThread,
  options: {
    readonly enabled?: boolean;
    readonly nowMs?: number;
    readonly phase?: UsageLimitResumePhase;
  } = {},
) =>
  decideUsageLimitResume({
    threadId,
    thread,
    enabled: options.enabled ?? true,
    nowMs: options.nowMs ?? failedMs + 1000,
    phase: options.phase ?? "arming",
  });

const userMessage = (id: string, createdAt: string) => ({
  id: MessageId.makeUnsafe(id),
  role: "user" as const,
  text: "hello",
  turnId: null,
  streaming: false,
  createdAt,
  updatedAt: createdAt,
});

describe("decideUsageLimitResume", () => {
  it("waits for a future reset, then sends once it is due", () => {
    expect(decide(makeThread())).toEqual({ action: "wait", dueAtMs: resetMs, turnId });
    expect(decide(makeThread(), { nowMs: resetMs, phase: "firing" })).toEqual({
      action: "send",
      messageId: resumeMessageId,
      turnId,
      resend: false,
    });
  });

  it.each<[string, UsageLimitResumeThread, boolean, string]>([
    ["no limit", makeThread({ activities: [] }), true, "no-limit"],
    ["setting off", makeThread(), false, "disabled"],
    ["archived", makeThread({ archivedAt: failedAt }), true, "archived"],
    ["deleted", makeThread({ deletedAt: failedAt }), true, "archived"],
    ["unknown reset", makeThread({ activities: [limitActivity(null)] }), true, "unknown-reset"],
    [
      "reset before the failure",
      makeThread({ activities: [limitActivity("2026-03-01T09:59:59.000Z")] }),
      true,
      "reset-not-after-failure",
    ],
    [
      "reset equal to the failure",
      makeThread({ activities: [limitActivity(failedAt)] }),
      true,
      "reset-not-after-failure",
    ],
    [
      "cancelled by the user or a Stop",
      makeThread({
        activities: [
          limitActivity(),
          activity(THREAD_USAGE_LIMIT_RESUME_CANCELLED_ACTIVITY_KIND, {}),
        ],
      }),
      true,
      "cancelled",
    ],
    [
      "newer turn",
      makeThread({
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-2"),
          state: "completed",
          requestedAt: failedAt,
          startedAt: failedAt,
          completedAt: failedAt,
          assistantMessageId: null,
        },
      }),
      true,
      "newer-turn",
    ],
    [
      "newer user message",
      makeThread({ messages: [userMessage("msg-new", "2026-03-01T10:00:01.000Z")] }),
      true,
      "newer-message",
    ],
    [
      "session running",
      makeThread({
        session: {
          threadId,
          status: "running",
          providerName: "claudeAgent",
          runtimeMode: "full-access",
          activeTurnId: TurnId.makeUnsafe("turn-2"),
          lastError: null,
          updatedAt: failedAt,
        },
      }),
      true,
      "busy",
    ],
    [
      "pending approval",
      makeThread({
        activities: [
          activity(
            "approval.requested",
            { requestId: "req-1" },
            { createdAt: "2026-03-01T09:30:00.000Z" },
          ),
          limitActivity(),
        ],
      }),
      true,
      "pending-request",
    ],
  ])("refuses: %s", (_label, thread, enabled, reason) => {
    expect(decide(thread, { enabled })).toEqual({ action: "none", reason });
  });

  it("refuses a turn the user stopped", () => {
    const base = makeThread();
    expect(decide({ ...base, latestTurn: { ...base.latestTurn!, state: "interrupted" } })).toEqual({
      action: "none",
      reason: "stopped",
    });
  });

  it("ignores a stale request from before the turn and an older user message", () => {
    const thread = makeThread({
      activities: [
        activity(
          "approval.requested",
          { requestId: "req-old" },
          { createdAt: "2026-03-01T08:00:00.000Z" },
        ),
        limitActivity(),
      ],
      messages: [userMessage("msg-old", "2026-03-01T09:00:00.000Z")],
    });
    expect(decide(thread).action).toBe("wait");
  });

  it("refuses to arm an overdue limit but still fires one armed in time", () => {
    const lateMs = resetMs + USAGE_LIMIT_RESUME_MAX_OVERDUE_MS + 1;
    expect(decide(makeThread(), { nowMs: lateMs })).toEqual({ action: "none", reason: "overdue" });
    expect(decide(makeThread(), { nowMs: lateMs, phase: "restart" })).toEqual({
      action: "none",
      reason: "overdue",
    });
    expect(decide(makeThread(), { nowMs: lateMs, phase: "firing" }).action).toBe("send");
    expect(decide(makeThread(), { nowMs: lateMs - 2 }).action).toBe("send");
  });

  it("only treats an in-flight run or an open request as retriable", () => {
    expect(isRetriableUsageLimitRefusal("busy")).toBe(true);
    expect(isRetriableUsageLimitRefusal("pending-request")).toBe(true);
    for (const reason of [
      "cancelled",
      "stopped",
      "newer-turn",
      "already-sent",
      "overdue",
    ] as const) {
      expect(isRetriableUsageLimitRefusal(reason)).toBe(false);
    }
  });

  it("refuses an overdue limit at arming even when it is also busy, so it never stays armed", () => {
    const lateMs = resetMs + USAGE_LIMIT_RESUME_MAX_OVERDUE_MS + 1;
    const base = makeThread();
    const busy = { ...base, session: { ...base.session!, status: "running" as const } };
    expect(decide(busy, { nowMs: lateMs })).toEqual({ action: "none", reason: "overdue" });
    expect(decide(busy, { nowMs: lateMs, phase: "firing" })).toEqual({
      action: "none",
      reason: "busy",
    });
  });

  it("sends a limit that reset while the server was down", () => {
    expect(decide(makeThread(), { nowMs: resetMs + 1000, phase: "restart" }).action).toBe("send");
  });

  describe("once its message exists", () => {
    const sentAt = "2026-03-01T15:00:30.000Z";
    const sent = makeThread({
      messages: [userMessage(resumeMessageId, sentAt)],
    });
    const nowMs = Date.parse(sentAt) + 1000;

    it("does not send again while the server keeps running", () => {
      expect(decide(sent, { nowMs })).toEqual({ action: "none", reason: "already-sent" });
      expect(decide(sent, { nowMs, phase: "firing" })).toEqual({
        action: "none",
        reason: "already-sent",
      });
    });

    it("resends under the same message id after a restart lost the turn", () => {
      const stuckStarting = {
        ...sent,
        session: { ...sent.session!, status: "starting" as const },
      };
      for (const thread of [sent, stuckStarting]) {
        expect(decide(thread, { nowMs, phase: "restart" })).toEqual({
          action: "send",
          messageId: resumeMessageId,
          turnId,
          resend: true,
        });
      }
    });

    it.each(["provider.turn.start.failed", "provider.turn.start.failed.missing-cwd"])(
      "does not resend after the provider refused the turn: %s",
      (kind) => {
        const failed = {
          ...sent,
          activities: [
            limitActivity(),
            activity(kind, { detail: "no" }, { createdAt: "2026-03-01T15:00:31.000Z" }),
          ],
        };
        expect(decide(failed, { nowMs, phase: "restart" })).toEqual({
          action: "none",
          reason: "already-sent",
        });
      },
    );

    it("does not resend past a turn that did start", () => {
      const base = sent.latestTurn!;
      const newer = {
        ...sent,
        latestTurn: { ...base, turnId: TurnId.makeUnsafe("turn-2"), state: "running" as const },
      };
      expect(decide(newer, { nowMs, phase: "restart" })).toEqual({
        action: "none",
        reason: "newer-turn",
      });
    });
  });
});
