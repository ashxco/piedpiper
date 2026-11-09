import {
  EventId,
  MessageId,
  ThreadId,
  TurnId,
  type OrchestrationSessionStatus,
  type OrchestrationThreadActivity,
  THREAD_GOAL_ACTIVITY_KIND,
  THREAD_REASONING_ACTIVITY_KIND,
  THREAD_USAGE_LIMIT_ACTIVITY_KIND,
  THREAD_USAGE_LIMIT_RESUME_CANCELLED_ACTIVITY_KIND,
} from "@piedpiper/contracts";
import { describe, expect, it } from "vitest";

import {
  deriveQaCardMessages,
  dropAsyncAnswerMessagesWithQaCards,
} from "./components/ChatView.logic";
import {
  deriveCompletionDividerBeforeEntryId,
  deriveActiveWorkStartedAt,
  deriveActivePlanState,
  derivePendingApprovals,
  derivePendingUserInputs,
  hasHeldAnswerAwaitingDelivery,
  isPendingUserInputAwaitingUser,
  deriveTimelineEntries,
  deriveWorkLogEntries,
  extractWorkLogToolLifecycleStatus,
  findLatestProposedPlan,
  formatDuration,
  formatWorkingTimer,
  findSidebarProposedPlan,
  hasActionableProposedPlan,
  hasToolActivityForTurn,
  canDismissPendingUserInput,
  isBlockingPendingUserInput,
  isLatestTurnSettled,
} from "./session-logic";

function makeActivity(overrides: {
  id?: string;
  createdAt?: string;
  kind?: string;
  summary?: string;
  tone?: OrchestrationThreadActivity["tone"];
  payload?: Record<string, unknown>;
  turnId?: string;
  sequence?: number;
}): OrchestrationThreadActivity {
  const payload = overrides.payload ?? {};
  return {
    id: EventId.makeUnsafe(overrides.id ?? crypto.randomUUID()),
    createdAt: overrides.createdAt ?? "2026-02-23T00:00:00.000Z",
    kind: overrides.kind ?? "tool.started",
    summary: overrides.summary ?? "Tool call",
    tone: overrides.tone ?? "tool",
    payload,
    turnId: overrides.turnId ? TurnId.makeUnsafe(overrides.turnId) : null,
    ...(overrides.sequence !== undefined ? { sequence: overrides.sequence } : {}),
  };
}

describe("derivePendingApprovals", () => {
  it("tracks open approvals and removes resolved ones", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "approval-open",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "approval.requested",
        summary: "Command approval requested",
        tone: "approval",
        payload: {
          requestId: "req-1",
          requestKind: "command",
          detail: "bun run lint",
        },
      }),
      makeActivity({
        id: "approval-close",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "approval.resolved",
        summary: "Approval resolved",
        tone: "info",
        payload: { requestId: "req-2" },
      }),
      makeActivity({
        id: "approval-closed-request",
        createdAt: "2026-02-23T00:00:01.500Z",
        kind: "approval.requested",
        summary: "File-change approval requested",
        tone: "approval",
        payload: { requestId: "req-2", requestKind: "file-change" },
      }),
    ];

    expect(derivePendingApprovals(activities)).toEqual([
      {
        requestId: "req-1",
        requestKind: "command",
        createdAt: "2026-02-23T00:00:01.000Z",
        detail: "bun run lint",
      },
    ]);
  });

  it("maps canonical requestType payloads into pending approvals", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "approval-open-request-type",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "approval.requested",
        summary: "Command approval requested",
        tone: "approval",
        payload: {
          requestId: "req-request-type",
          requestType: "command_execution_approval",
          detail: "pwd",
        },
      }),
    ];

    expect(derivePendingApprovals(activities)).toEqual([
      {
        requestId: "req-request-type",
        requestKind: "command",
        createdAt: "2026-02-23T00:00:01.000Z",
        requestType: "command_execution_approval",
        detail: "pwd",
      },
    ]);
  });

  it("maps dynamic_tool_call approvals to command approvals and keeps the requestType", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "approval-open-dynamic-tool",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "approval.requested",
        summary: "Tool approval requested",
        tone: "approval",
        payload: {
          requestId: "req-dynamic-tool",
          requestType: "dynamic_tool_call",
          detail: "WebFetch",
        },
      }),
    ];

    expect(derivePendingApprovals(activities)).toEqual([
      {
        requestId: "req-dynamic-tool",
        requestKind: "command",
        createdAt: "2026-02-23T00:00:01.000Z",
        requestType: "dynamic_tool_call",
        detail: "WebFetch",
      },
    ]);
  });

  it("clears stale pending approvals when provider reports unknown pending request", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "approval-open-stale",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "approval.requested",
        summary: "Command approval requested",
        tone: "approval",
        payload: {
          requestId: "req-stale-1",
          requestKind: "command",
        },
      }),
      makeActivity({
        id: "approval-failed-stale",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "provider.approval.respond.failed",
        summary: "Provider approval response failed",
        tone: "error",
        payload: {
          requestId: "req-stale-1",
          detail: "Unknown pending permission request: req-stale-1",
        },
      }),
    ];

    expect(derivePendingApprovals(activities)).toEqual([]);
  });

  it("clears stale pending approvals when the backend marks them stale after restart", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "approval-open-stale-restart",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "approval.requested",
        summary: "Command approval requested",
        tone: "approval",
        payload: {
          requestId: "req-stale-restart-1",
          requestKind: "command",
        },
      }),
      makeActivity({
        id: "approval-failed-stale-restart",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "provider.approval.respond.failed",
        summary: "Provider approval response failed",
        tone: "error",
        payload: {
          requestId: "req-stale-restart-1",
          detail:
            "Stale pending approval request: req-stale-restart-1. Provider callback state does not survive app restarts or recovered sessions. Restart the turn to continue.",
        },
      }),
    ];

    expect(derivePendingApprovals(activities)).toEqual([]);
  });
});

describe("isPendingUserInputAwaitingUser", () => {
  it("counts a blocking question always, and a message-mode one only once nothing runs", () => {
    expect(isPendingUserInputAwaitingUser({ responseMode: "blocking" }, true)).toBe(true);
    expect(isPendingUserInputAwaitingUser({ responseMode: "blocking" }, false)).toBe(true);
    expect(isPendingUserInputAwaitingUser({}, true)).toBe(true);
    expect(isPendingUserInputAwaitingUser({ responseMode: "message" }, true)).toBe(false);
    expect(isPendingUserInputAwaitingUser({ responseMode: "message" }, false)).toBe(true);
  });
});

describe("hasHeldAnswerAwaitingDelivery", () => {
  const held = makeActivity({
    id: "held",
    createdAt: "2026-02-23T00:00:01.000Z",
    kind: "user-input.resolved",
    summary: "User input submitted",
    tone: "info",
    payload: { requestId: "r", held: true },
  });
  const thread = (overrides: object) =>
    ({
      activities: [held],
      archivedAt: null,
      latestTurn: { state: "completed" },
      session: { orchestrationStatus: "ready" },
      ...overrides,
    }) as never;

  it("waits on a held answer the server will deliver", () => {
    expect(hasHeldAnswerAwaitingDelivery(thread({}))).toBe(true);
    expect(hasHeldAnswerAwaitingDelivery(thread({ activities: [] }))).toBe(false);
  });

  it.each([
    ["archived", { archivedAt: "2026-02-23T00:00:02.000Z" }],
    ["interrupted", { latestTurn: { state: "interrupted" } }],
    ["failed", { latestTurn: { state: "error" } }],
    ["stopped", { session: { orchestrationStatus: "stopped" } }],
    ["session errored", { session: { orchestrationStatus: "error" } }],
    ["session interrupted", { session: { orchestrationStatus: "interrupted" } }],
    ["without a session", { session: null }],
  ])("does not wait on it when %s, as the server does not deliver there", (_name, overrides) => {
    expect(hasHeldAnswerAwaitingDelivery(thread(overrides))).toBe(false);
  });
});

describe("derivePendingUserInputs", () => {
  it("does not reopen a question whose replayed request sorts after its resolution", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "resolved",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "user-input.resolved",
        summary: "User input submitted",
        tone: "info",
        payload: { requestId: "req-replayed", answers: {} },
      }),
      makeActivity({
        id: "replayed",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "user-input.requested",
        summary: "User input requested",
        tone: "info",
        payload: {
          requestId: "req-replayed",
          questions: [
            {
              id: "q",
              header: "H",
              question: "Q?",
              options: [{ label: "a", description: "a" }],
            },
          ],
        },
      }),
    ];
    expect(derivePendingUserInputs(activities)).toEqual([]);
  });

  it("tracks open structured prompts and removes resolved ones", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "user-input-open",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "user-input.requested",
        summary: "User input requested",
        tone: "info",
        payload: {
          requestId: "req-user-input-1",
          questions: [
            {
              id: "sandbox_mode",
              header: "Sandbox",
              question: "Which mode should be used?",
              options: [
                {
                  label: "workspace-write",
                  description: "Allow workspace writes only",
                },
              ],
            },
          ],
        },
      }),
      makeActivity({
        id: "user-input-resolved",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "user-input.resolved",
        summary: "User input submitted",
        tone: "info",
        payload: {
          requestId: "req-user-input-2",
          answers: {
            sandbox_mode: "workspace-write",
          },
        },
      }),
      makeActivity({
        id: "user-input-open-2",
        createdAt: "2026-02-23T00:00:01.500Z",
        kind: "user-input.requested",
        summary: "User input requested",
        tone: "info",
        payload: {
          requestId: "req-user-input-2",
          questions: [
            {
              id: "approval",
              header: "Approval",
              question: "Continue?",
              options: [
                {
                  label: "yes",
                  description: "Continue execution",
                },
              ],
            },
          ],
        },
      }),
    ];

    expect(derivePendingUserInputs(activities)).toEqual([
      {
        requestId: "req-user-input-1",
        createdAt: "2026-02-23T00:00:01.000Z",
        questions: [
          {
            id: "sandbox_mode",
            header: "Sandbox",
            question: "Which mode should be used?",
            options: [
              {
                label: "workspace-write",
                description: "Allow workspace writes only",
              },
            ],
          },
        ],
      },
    ]);
  });

  it("clears stale pending user-input prompts when the provider reports an orphaned request", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "user-input-open-stale",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "user-input.requested",
        summary: "User input requested",
        tone: "info",
        payload: {
          requestId: "req-user-input-stale-1",
          questions: [
            {
              id: "sandbox_mode",
              header: "Sandbox",
              question: "Which mode should be used?",
              options: [
                {
                  label: "workspace-write",
                  description: "Allow workspace writes only",
                },
              ],
            },
          ],
        },
      }),
      makeActivity({
        id: "user-input-failed-stale",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "provider.user-input.respond.failed",
        summary: "Provider user input response failed",
        tone: "error",
        payload: {
          requestId: "req-user-input-stale-1",
          detail:
            "Stale pending user-input request: req-user-input-stale-1. Provider callback state does not survive app restarts or recovered sessions. Restart the turn to continue.",
        },
      }),
    ];

    expect(derivePendingUserInputs(activities)).toEqual([]);
  });

  it("keeps option previews and the multi-select flag", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "user-input-preview",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "user-input.requested",
        summary: "User input requested",
        tone: "info",
        payload: {
          requestId: "req-user-input-preview",
          questions: [
            {
              id: "layout",
              header: "Layout",
              question: "Which layouts?",
              multiSelect: true,
              options: [
                { label: "Grid", description: "Cards in a grid", preview: "```\n[ ][ ]\n```" },
                { label: "List", description: "Rows", preview: 42 },
              ],
            },
          ],
        },
      }),
    ];

    expect(derivePendingUserInputs(activities)[0]?.questions).toEqual([
      {
        id: "layout",
        header: "Layout",
        question: "Which layouts?",
        multiSelect: true,
        options: [
          { label: "Grid", description: "Cards in a grid", preview: "```\n[ ][ ]\n```" },
          { label: "List", description: "Rows" },
        ],
      },
    ]);
  });
});

describe("free-text and non-blocking questions", () => {
  const request = (payload: Record<string, unknown>, options: unknown = []) =>
    makeActivity({
      id: "free-text-question",
      createdAt: "2026-02-23T00:00:01.000Z",
      kind: "user-input.requested",
      tone: "info",
      payload: {
        requestId: "req-free-text",
        questions: [{ id: "q", header: "Q", question: "What next?", options }],
        ...payload,
      },
    });

  it("keeps a question with no options so the panel can take a typed answer", () => {
    const [pending] = derivePendingUserInputs([request({})]);
    expect(pending?.questions).toEqual([
      { id: "q", header: "Q", question: "What next?", options: [] },
    ]);
  });

  it("still drops a question whose options are not an array", () => {
    expect(derivePendingUserInputs([request({}, null)])).toEqual([]);
  });

  it("carries the message response mode, which leaves the thread working", () => {
    const [pending] = derivePendingUserInputs([request({ responseMode: "message" })]);
    expect(pending?.responseMode).toBe("message");
    expect(isBlockingPendingUserInput(pending!)).toBe(false);
  });

  it("treats a question with no mode, or a blocking one, as blocking", () => {
    const [unmarked] = derivePendingUserInputs([request({})]);
    expect(unmarked).not.toHaveProperty("responseMode");
    expect(isBlockingPendingUserInput(unmarked!)).toBe(true);
    const [blocking] = derivePendingUserInputs([request({ responseMode: "blocking" })]);
    expect(isBlockingPendingUserInput(blocking!)).toBe(true);
  });

  it("closes a message-mode question on its resolved activity", () => {
    expect(
      derivePendingUserInputs([
        request({ responseMode: "message" }),
        makeActivity({
          id: "free-text-answered",
          createdAt: "2026-02-23T00:00:02.000Z",
          kind: "user-input.resolved",
          tone: "info",
          payload: { requestId: "req-free-text", responseMode: "message", answers: { q: "go" } },
        }),
      ]),
    ).toEqual([]);
  });
});

describe("deriveWorkLogEntries provider retries", () => {
  const retry = (id: string, second: number, retryId: string, message: string) =>
    makeActivity({
      id,
      createdAt: `2026-02-23T00:00:0${second}.000Z`,
      kind: "runtime.warning",
      summary: message,
      tone: "info",
      payload: { message, detail: { kind: "provider_retry", retryId, state: "retrying" } },
    });

  it("shows one retry streak as one row with the latest attempt", () => {
    const entries = deriveWorkLogEntries(
      [
        retry("retry-1", 1, "a", "Claude API overloaded (529), retry 1 of 10"),
        retry("retry-2", 2, "a", "Claude API overloaded (529), retry 2 of 10"),
        retry("retry-3", 3, "a", "Claude API overloaded (529), retry 3 of 10"),
      ],
      undefined,
    );
    expect(entries.map((entry) => entry.label)).toEqual([
      "Claude API overloaded (529), retry 3 of 10",
    ]);
  });

  it("keeps separate streaks apart and leaves errors and plain warnings alone", () => {
    const entries = deriveWorkLogEntries(
      [
        retry("codex-1", 1, "turn-1", "Reconnecting... 1/5"),
        makeActivity({
          id: "plain-warning",
          createdAt: "2026-02-23T00:00:02.000Z",
          kind: "runtime.warning",
          summary: "Plain warning",
          tone: "info",
          payload: { message: "Plain warning" },
        }),
        retry("codex-2", 3, "turn-1", "Reconnecting... 2/5"),
        retry("codex-3", 4, "turn-1", "Reconnecting... 3/5"),
        makeActivity({
          id: "runtime-error",
          createdAt: "2026-02-23T00:00:05.000Z",
          kind: "runtime.error",
          summary: "Stream disconnected",
          tone: "error",
          payload: { message: "Stream disconnected" },
        }),
        retry("codex-4", 6, "turn-2", "Reconnecting... 1/5"),
      ],
      undefined,
    );
    expect(entries.map((entry) => entry.label)).toEqual([
      "Plain warning",
      "Reconnecting... 3/5",
      "Stream disconnected",
      "Reconnecting... 1/5",
    ]);
  });
});

describe("deriveWorkLogEntries goal updates", () => {
  it("leaves goal reports to the row above the composer", () => {
    expect(
      deriveWorkLogEntries(
        [
          makeActivity({
            id: "goal-update",
            kind: THREAD_GOAL_ACTIVITY_KIND,
            summary: "Goal updated",
            tone: "info",
            payload: { goal: { objective: "Ship it", status: "active" } },
          }),
        ],
        undefined,
      ),
    ).toEqual([]);
  });
});

describe("deriveActivePlanState", () => {
  it("returns the latest plan update for the active turn", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "plan-old",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "turn.plan.updated",
        summary: "Plan updated",
        tone: "info",
        turnId: "turn-1",
        payload: {
          explanation: "Initial plan",
          plan: [{ step: "Inspect code", status: "pending" }],
        },
      }),
      makeActivity({
        id: "plan-latest",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "turn.plan.updated",
        summary: "Plan updated",
        tone: "info",
        turnId: "turn-1",
        payload: {
          explanation: "Refined plan",
          plan: [{ step: "Implement Codex user input", status: "inProgress" }],
        },
      }),
    ];

    expect(deriveActivePlanState(activities, TurnId.makeUnsafe("turn-1"))).toEqual({
      createdAt: "2026-02-23T00:00:02.000Z",
      turnId: "turn-1",
      explanation: "Refined plan",
      steps: [{ step: "Implement Codex user input", status: "inProgress" }],
    });
  });
});

describe("findLatestProposedPlan", () => {
  it("prefers the latest proposed plan for the active turn", () => {
    expect(
      findLatestProposedPlan(
        [
          {
            id: "plan:thread-1:turn:turn-1",
            turnId: TurnId.makeUnsafe("turn-1"),
            planMarkdown: "# Older",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-02-23T00:00:01.000Z",
            updatedAt: "2026-02-23T00:00:01.000Z",
          },
          {
            id: "plan:thread-1:turn:turn-1",
            turnId: TurnId.makeUnsafe("turn-1"),
            planMarkdown: "# Latest",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-02-23T00:00:01.000Z",
            updatedAt: "2026-02-23T00:00:02.000Z",
          },
          {
            id: "plan:thread-1:turn:turn-2",
            turnId: TurnId.makeUnsafe("turn-2"),
            planMarkdown: "# Different turn",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-02-23T00:00:03.000Z",
            updatedAt: "2026-02-23T00:00:03.000Z",
          },
        ],
        TurnId.makeUnsafe("turn-1"),
      ),
    ).toEqual({
      id: "plan:thread-1:turn:turn-1",
      turnId: "turn-1",
      planMarkdown: "# Latest",
      implementedAt: null,
      implementationThreadId: null,
      createdAt: "2026-02-23T00:00:01.000Z",
      updatedAt: "2026-02-23T00:00:02.000Z",
    });
  });

  it("falls back to the most recently updated proposed plan", () => {
    const latestPlan = findLatestProposedPlan(
      [
        {
          id: "plan:thread-1:turn:turn-1",
          turnId: TurnId.makeUnsafe("turn-1"),
          planMarkdown: "# First",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: "2026-02-23T00:00:01.000Z",
          updatedAt: "2026-02-23T00:00:01.000Z",
        },
        {
          id: "plan:thread-1:turn:turn-2",
          turnId: TurnId.makeUnsafe("turn-2"),
          planMarkdown: "# Latest",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: "2026-02-23T00:00:02.000Z",
          updatedAt: "2026-02-23T00:00:03.000Z",
        },
      ],
      null,
    );

    expect(latestPlan?.planMarkdown).toBe("# Latest");
  });
});

describe("hasActionableProposedPlan", () => {
  it("returns true for an unimplemented proposed plan", () => {
    expect(
      hasActionableProposedPlan({
        id: "plan-1",
        turnId: TurnId.makeUnsafe("turn-1"),
        planMarkdown: "# Plan",
        implementedAt: null,
        implementationThreadId: null,
        createdAt: "2026-02-23T00:00:00.000Z",
        updatedAt: "2026-02-23T00:00:01.000Z",
      }),
    ).toBe(true);
  });

  it("returns false for a proposed plan already implemented elsewhere", () => {
    expect(
      hasActionableProposedPlan({
        id: "plan-1",
        turnId: TurnId.makeUnsafe("turn-1"),
        planMarkdown: "# Plan",
        implementedAt: "2026-02-23T00:00:02.000Z",
        implementationThreadId: ThreadId.makeUnsafe("thread-implement"),
        createdAt: "2026-02-23T00:00:00.000Z",
        updatedAt: "2026-02-23T00:00:02.000Z",
      }),
    ).toBe(false);
  });
});

describe("findSidebarProposedPlan", () => {
  it("prefers the running turn source proposed plan when available on the same thread", () => {
    expect(
      findSidebarProposedPlan({
        threads: [
          {
            id: ThreadId.makeUnsafe("thread-1"),
            proposedPlans: [
              {
                id: "plan-1",
                turnId: TurnId.makeUnsafe("turn-plan"),
                planMarkdown: "# Source plan",
                implementedAt: "2026-02-23T00:00:03.000Z",
                implementationThreadId: ThreadId.makeUnsafe("thread-2"),
                createdAt: "2026-02-23T00:00:01.000Z",
                updatedAt: "2026-02-23T00:00:02.000Z",
              },
            ],
          },
          {
            id: ThreadId.makeUnsafe("thread-2"),
            proposedPlans: [
              {
                id: "plan-2",
                turnId: TurnId.makeUnsafe("turn-other"),
                planMarkdown: "# Latest elsewhere",
                implementedAt: null,
                implementationThreadId: null,
                createdAt: "2026-02-23T00:00:04.000Z",
                updatedAt: "2026-02-23T00:00:05.000Z",
              },
            ],
          },
        ],
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-implementation"),
          sourceProposedPlan: {
            threadId: ThreadId.makeUnsafe("thread-1"),
            planId: "plan-1",
          },
        },
        latestTurnSettled: false,
        threadId: ThreadId.makeUnsafe("thread-1"),
      }),
    ).toEqual({
      id: "plan-1",
      turnId: "turn-plan",
      planMarkdown: "# Source plan",
      implementedAt: "2026-02-23T00:00:03.000Z",
      implementationThreadId: "thread-2",
      createdAt: "2026-02-23T00:00:01.000Z",
      updatedAt: "2026-02-23T00:00:02.000Z",
    });
  });

  it("falls back to the latest proposed plan once the turn is settled", () => {
    expect(
      findSidebarProposedPlan({
        threads: [
          {
            id: ThreadId.makeUnsafe("thread-1"),
            proposedPlans: [
              {
                id: "plan-1",
                turnId: TurnId.makeUnsafe("turn-plan"),
                planMarkdown: "# Older",
                implementedAt: null,
                implementationThreadId: null,
                createdAt: "2026-02-23T00:00:01.000Z",
                updatedAt: "2026-02-23T00:00:02.000Z",
              },
              {
                id: "plan-2",
                turnId: TurnId.makeUnsafe("turn-latest"),
                planMarkdown: "# Latest",
                implementedAt: null,
                implementationThreadId: null,
                createdAt: "2026-02-23T00:00:03.000Z",
                updatedAt: "2026-02-23T00:00:04.000Z",
              },
            ],
          },
        ],
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-implementation"),
          sourceProposedPlan: {
            threadId: ThreadId.makeUnsafe("thread-1"),
            planId: "plan-1",
          },
        },
        latestTurnSettled: true,
        threadId: ThreadId.makeUnsafe("thread-1"),
      })?.planMarkdown,
    ).toBe("# Latest");
  });
});

describe("deriveWorkLogEntries", () => {
  it("omits tool started entries and keeps completed entries", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-complete",
        createdAt: "2026-02-23T00:00:03.000Z",
        summary: "Tool call complete",
        kind: "tool.completed",
      }),
      makeActivity({
        id: "tool-start",
        createdAt: "2026-02-23T00:00:02.000Z",
        summary: "Tool call",
        kind: "tool.started",
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries.map((entry) => entry.id)).toEqual(["tool-complete"]);
  });

  it("omits task start and completion lifecycle entries", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "task-start",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "task.started",
        summary: "default task started",
        tone: "info",
      }),
      makeActivity({
        id: "task-progress",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "task.progress",
        summary: "Updating files",
        tone: "info",
      }),
      makeActivity({
        id: "task-complete",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "task.completed",
        summary: "Task completed",
        tone: "info",
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries.map((entry) => entry.id)).toEqual(["task-progress"]);
  });

  it("filters by turn id when provided", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({ id: "turn-1", turnId: "turn-1", summary: "Tool call", kind: "tool.started" }),
      makeActivity({
        id: "turn-2",
        turnId: "turn-2",
        summary: "Tool call complete",
        kind: "tool.completed",
      }),
      makeActivity({ id: "no-turn", summary: "Checkpoint captured", tone: "info" }),
    ];

    const entries = deriveWorkLogEntries(activities, TurnId.makeUnsafe("turn-2"));
    expect(entries.map((entry) => entry.id)).toEqual(["turn-2"]);
  });

  it("omits checkpoint captured info entries", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "checkpoint",
        createdAt: "2026-02-23T00:00:01.000Z",
        summary: "Checkpoint captured",
        tone: "info",
      }),
      makeActivity({
        id: "tool-complete",
        createdAt: "2026-02-23T00:00:02.000Z",
        summary: "Ran command",
        tone: "tool",
        kind: "tool.completed",
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries.map((entry) => entry.id)).toEqual(["tool-complete"]);
  });

  it("omits ExitPlanMode lifecycle entries once the plan card is shown", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "exit-plan-updated",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          detail: 'ExitPlanMode: {"allowedPrompts":[{"tool":"Bash","prompt":"run tests"}]}',
        },
      }),
      makeActivity({
        id: "exit-plan-completed",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Tool call",
        payload: {
          detail: "ExitPlanMode: {}",
        },
      }),
      makeActivity({
        id: "real-work-log",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          detail: "Bash: bun test",
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries.map((entry) => entry.id)).toEqual(["real-work-log"]);
  });

  it("orders work log by activity sequence when present", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "second",
        createdAt: "2026-02-23T00:00:03.000Z",
        sequence: 2,
        summary: "Tool call complete",
        kind: "tool.completed",
      }),
      makeActivity({
        id: "first",
        createdAt: "2026-02-23T00:00:04.000Z",
        sequence: 1,
        summary: "Tool call complete",
        kind: "tool.completed",
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries.map((entry) => entry.id)).toEqual(["first", "second"]);
  });

  it("extracts command text for command tool activities", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "command-tool",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          data: {
            item: {
              command: ["bun", "run", "lint"],
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry?.command).toBe("bun run lint");
  });

  it("keeps compact Codex tool metadata used for icons and labels", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-with-metadata",
        kind: "tool.completed",
        summary: "bash",
        payload: {
          itemType: "command_execution",
          title: "bash",
          status: "completed",
          detail: '{ "dev": "vite dev --port 3000" } <exited with exit code 0>',
          data: {
            item: {
              command: ["bun", "run", "dev"],
              result: {
                content: '{ "dev": "vite dev --port 3000" } <exited with exit code 0>',
                exitCode: 0,
              },
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry).toMatchObject({
      command: "bun run dev",
      detail: '{ "dev": "vite dev --port 3000" }',
      itemType: "command_execution",
      toolTitle: "bash",
    });
  });

  it("extracts changed file paths for file-change tool activities", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "file-tool",
        kind: "tool.completed",
        summary: "File change",
        payload: {
          itemType: "file_change",
          data: {
            item: {
              changes: [
                { path: "apps/web/src/components/ChatView.tsx" },
                { filename: "apps/web/src/session-logic.ts" },
              ],
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry?.changedFiles).toEqual([
      "apps/web/src/components/ChatView.tsx",
      "apps/web/src/session-logic.ts",
    ]);
  });

  it("collapses repeated lifecycle updates for the same tool call into one entry", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-update-1",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "tool-update-2",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
          data: {
            item: {
              command: ["sed", "-n", "1,40p", "/tmp/app.ts"],
            },
          },
        },
      }),
      makeActivity({
        id: "tool-complete",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "tool.completed",
        summary: "Tool call completed",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "tool-complete",
      createdAt: "2026-02-23T00:00:03.000Z",
      label: "Tool call completed",
      detail: 'Read: {"file_path":"/tmp/app.ts"}',
      command: "sed -n 1,40p /tmp/app.ts",
      itemType: "dynamic_tool_call",
      toolTitle: "Tool call",
    });
  });

  it("keeps separate tool entries when an identical call starts after the prior one completed", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-1-update",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "tool-1-complete",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Tool call completed",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "tool-2-update",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "tool-2-complete",
        createdAt: "2026-02-23T00:00:04.000Z",
        kind: "tool.completed",
        summary: "Tool call completed",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);

    expect(entries.map((entry) => entry.id)).toEqual(["tool-1-complete", "tool-2-complete"]);
  });

  it("collapses tool lifecycle rows that share a providerItemId", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-update-pid-1",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          providerItemId: "tool-use-abc",
          detail: "first detail",
        },
      }),
      makeActivity({
        id: "tool-complete-pid-1",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Tool call completed",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          providerItemId: "tool-use-abc",
          detail: "second detail",
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "tool-complete-pid-1",
      providerItemId: "tool-use-abc",
    });
  });

  it("does not collapse a providerItemId-tagged entry with a sibling that lacks one", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-update-no-pid",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: "shared detail",
        },
      }),
      makeActivity({
        id: "tool-complete-with-pid",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Tool call completed",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          providerItemId: "tool-use-zzz",
          detail: "shared detail",
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);

    expect(entries.map((entry) => entry.id)).toEqual([
      "tool-update-no-pid",
      "tool-complete-with-pid",
    ]);
  });

  it("collapses same-timestamp lifecycle rows even when completed sorts before updated by id", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "z-update-earlier",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "a-complete-same-timestamp",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "z-update-same-timestamp",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe("a-complete-same-timestamp");
  });
});

describe("deriveTimelineEntries", () => {
  it("includes proposed plans alongside messages and work entries in chronological order", () => {
    const entries = deriveTimelineEntries(
      [
        {
          id: MessageId.makeUnsafe("message-1"),
          role: "assistant",
          text: "hello",
          createdAt: "2026-02-23T00:00:01.000Z",
          streaming: false,
        },
      ],
      [
        {
          id: "plan:thread-1:turn:turn-1",
          turnId: TurnId.makeUnsafe("turn-1"),
          planMarkdown: "# Ship it",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: "2026-02-23T00:00:02.000Z",
          updatedAt: "2026-02-23T00:00:02.000Z",
        },
      ],
      [
        {
          id: "work-1",
          createdAt: "2026-02-23T00:00:03.000Z",
          label: "Ran tests",
          tone: "tool",
        },
      ],
    );

    expect(entries.map((entry) => entry.kind)).toEqual(["message", "proposed-plan", "work"]);
    expect(entries[1]).toMatchObject({
      kind: "proposed-plan",
      proposedPlan: {
        planMarkdown: "# Ship it",
        implementedAt: null,
        implementationThreadId: null,
      },
    });
  });

  it("anchors the completion divider to latestTurn.assistantMessageId before timestamp fallback", () => {
    const entries = deriveTimelineEntries(
      [
        {
          id: MessageId.makeUnsafe("assistant-earlier"),
          role: "assistant",
          text: "progress update",
          createdAt: "2026-02-23T00:00:01.000Z",
          streaming: false,
        },
        {
          id: MessageId.makeUnsafe("assistant-final"),
          role: "assistant",
          text: "final answer",
          createdAt: "2026-02-23T00:00:01.000Z",
          streaming: false,
        },
      ],
      [],
      [],
    );

    expect(
      deriveCompletionDividerBeforeEntryId(entries, {
        assistantMessageId: MessageId.makeUnsafe("assistant-final"),
        startedAt: "2026-02-23T00:00:00.000Z",
        completedAt: "2026-02-23T00:00:02.000Z",
      }),
    ).toBe("assistant-final");
  });
});

describe("deriveWorkLogEntries context window handling", () => {
  it("excludes context window updates from the work log", () => {
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "context-1",
          turnId: "turn-1",
          kind: "context-window.updated",
          summary: "Context window updated",
          tone: "info",
        }),
        makeActivity({
          id: "tool-1",
          turnId: "turn-1",
          kind: "tool.completed",
          summary: "Ran command",
          tone: "tool",
        }),
      ],
      TurnId.makeUnsafe("turn-1"),
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.label).toBe("Ran command");
  });

  it("keeps context compaction activities as normal work log entries", () => {
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "compaction-1",
          turnId: "turn-1",
          kind: "context-compaction",
          summary: "Context compacted",
          tone: "info",
        }),
      ],
      TurnId.makeUnsafe("turn-1"),
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.label).toBe("Context compacted");
  });

  it.each([
    [
      "both counts",
      { compact_metadata: { pre_tokens: 180_000, post_tokens: 12_000 } },
      " 180k → 12k tokens",
    ],
    ["no post_tokens", { compact_metadata: { trigger: "auto", pre_tokens: 180_000 } }, ""],
    ["zero post_tokens", { compact_metadata: { pre_tokens: 180_000, post_tokens: 0 } }, ""],
    [
      "non-numeric counts",
      { compact_metadata: { pre_tokens: "180000", post_tokens: "12000" } },
      "",
    ],
    ["a Codex-style string detail", "Conversation history compacted", ""],
    ["a Codex-style object detail", { threadId: "thread-1", turnId: "turn-1" }, ""],
  ])("labels a compaction with %s", (_name, detail, suffix) => {
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "compaction-1",
          turnId: "turn-1",
          kind: "context-compaction",
          summary: "Context compacted",
          tone: "info",
          payload: { state: "compacted", detail },
        }),
      ],
      TurnId.makeUnsafe("turn-1"),
    );

    expect(entries[0]?.label).toBe(`Context compacted${suffix}`);
  });
});

describe("hasToolActivityForTurn", () => {
  it("returns false when turn id is missing", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({ id: "tool-1", turnId: "turn-1", kind: "tool.completed", tone: "tool" }),
    ];

    expect(hasToolActivityForTurn(activities, undefined)).toBe(false);
    expect(hasToolActivityForTurn(activities, null)).toBe(false);
  });

  it("returns true only for matching tool activity in the target turn", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({ id: "tool-1", turnId: "turn-1", kind: "tool.completed", tone: "tool" }),
      makeActivity({ id: "info-1", turnId: "turn-2", kind: "turn.completed", tone: "info" }),
    ];

    expect(hasToolActivityForTurn(activities, TurnId.makeUnsafe("turn-1"))).toBe(true);
    expect(hasToolActivityForTurn(activities, TurnId.makeUnsafe("turn-2"))).toBe(false);
  });
});

describe("isLatestTurnSettled", () => {
  const latestTurn = {
    turnId: TurnId.makeUnsafe("turn-1"),
    startedAt: "2026-02-27T21:10:00.000Z",
    completedAt: "2026-02-27T21:10:06.000Z",
  } as const;

  it("returns false while the same turn is still active in a running session", () => {
    expect(
      isLatestTurnSettled(latestTurn, {
        orchestrationStatus: "running",
        activeTurnId: TurnId.makeUnsafe("turn-1"),
      }),
    ).toBe(false);
  });

  it("returns false while any turn is running to avoid stale latest-turn banners", () => {
    expect(
      isLatestTurnSettled(latestTurn, {
        orchestrationStatus: "running",
        activeTurnId: TurnId.makeUnsafe("turn-2"),
      }),
    ).toBe(false);
  });

  it("returns true once the session is no longer running that turn", () => {
    expect(
      isLatestTurnSettled(latestTurn, {
        orchestrationStatus: "ready",
        activeTurnId: undefined,
      }),
    ).toBe(true);
  });

  it("returns false when turn timestamps are incomplete", () => {
    expect(
      isLatestTurnSettled(
        {
          turnId: TurnId.makeUnsafe("turn-1"),
          startedAt: null,
          completedAt: "2026-02-27T21:10:06.000Z",
        },
        null,
      ),
    ).toBe(false);
  });
});

describe("deriveActiveWorkStartedAt", () => {
  const latestTurn = {
    turnId: TurnId.makeUnsafe("turn-1"),
    startedAt: "2026-02-27T21:10:00.000Z",
    completedAt: "2026-02-27T21:10:06.000Z",
  } as const;

  it("prefers the in-flight turn start when the latest turn is not settled", () => {
    expect(
      deriveActiveWorkStartedAt(
        latestTurn,
        {
          orchestrationStatus: "running",
          activeTurnId: TurnId.makeUnsafe("turn-1"),
        },
        "2026-02-27T21:11:00.000Z",
      ),
    ).toBe("2026-02-27T21:10:00.000Z");
  });

  it("falls back to sendStartedAt once the latest turn is settled", () => {
    expect(
      deriveActiveWorkStartedAt(
        latestTurn,
        {
          orchestrationStatus: "ready",
          activeTurnId: undefined,
        },
        "2026-02-27T21:11:00.000Z",
      ),
    ).toBe("2026-02-27T21:11:00.000Z");
  });

  it("uses sendStartedAt for a fresh send after the prior turn completed", () => {
    expect(
      deriveActiveWorkStartedAt(
        {
          turnId: TurnId.makeUnsafe("turn-1"),
          startedAt: "2026-02-27T21:10:00.000Z",
          completedAt: "2026-02-27T21:10:06.000Z",
        },
        null,
        "2026-02-27T21:11:00.000Z",
      ),
    ).toBe("2026-02-27T21:11:00.000Z");
  });
});

describe("deriveWorkLogEntries entry identity", () => {
  it("reuses entries for unchanged and already-collapsed activities across deltas", () => {
    const completedStart = makeActivity({
      id: "done-start",
      createdAt: "2026-02-23T00:00:01.000Z",
      kind: "tool.started",
      payload: { providerItemId: "done" },
    });
    const completedEnd = makeActivity({
      id: "done-end",
      createdAt: "2026-02-23T00:00:02.000Z",
      kind: "tool.completed",
      payload: { providerItemId: "done" },
    });
    const runningStart = makeActivity({
      id: "running-start",
      createdAt: "2026-02-23T00:00:03.000Z",
      kind: "tool.started",
      payload: { providerItemId: "running" },
    });
    const runningUpdate = makeActivity({
      id: "running-update",
      createdAt: "2026-02-23T00:00:04.000Z",
      kind: "tool.updated",
      payload: { providerItemId: "running" },
    });
    const runningEnd = makeActivity({
      id: "running-end",
      createdAt: "2026-02-23T00:00:05.000Z",
      kind: "tool.completed",
      payload: { providerItemId: "running" },
    });

    const first = deriveWorkLogEntries([completedStart, completedEnd, runningStart], undefined);
    const second = deriveWorkLogEntries(
      [completedStart, completedEnd, runningStart, runningUpdate],
      undefined,
    );
    const third = deriveWorkLogEntries(
      [completedStart, completedEnd, runningStart, runningUpdate, runningEnd],
      undefined,
    );

    expect(second[0]).toBe(first[0]);
    expect(third[0]).toBe(first[0]);
    expect(first[0]?.inProgress).toBeUndefined();
    expect(first[1]?.inProgress).toBe(true);
    expect(second[1]).not.toBe(first[1]);
    expect(second[1]?.inProgress).toBe(true);
    expect(third[1]?.id).toBe("running-end");
    expect(third[1]?.inProgress).toBeUndefined();
    expect(deriveWorkLogEntries([completedStart, completedEnd, runningStart], undefined)).toEqual(
      first,
    );
    expect(Object.keys(third[1] ?? {})).not.toContain("activityKind");
    expect(Object.keys(third[1] ?? {})).not.toContain("collapseKey");
  });
});

describe("formatDuration", () => {
  it.each([
    [0, "1ms"],
    [250, "250ms"],
    [999.4, "999ms"],
    [999.6, "1s"],
    [1_500, "1.5s"],
    [2_000, "2s"],
    [2_500, "2.5s"],
    [9_940, "9.9s"],
    [9_960, "10s"],
    [59_600, "1m"],
    [119_600, "2m"],
    [9_950, "10s"],
    [22_000, "22s"],
    [59_499, "59s"],
    [59_500, "1m"],
    [60_000, "1m"],
    [65_000, "1m 5s"],
    [119_500, "2m"],
    [3_599_499, "59m 59s"],
    [3_599_500, "1h"],
    [3_600_000, "1h"],
    [3_601_000, "1h 1s"],
    [3_661_000, "1h 1m 1s"],
    [25_190_000, "6h 59m 50s"],
    [90_061_000, "25h 1m 1s"],
  ])("formats %d ms as %s", (durationMs, expected) => {
    expect(formatDuration(durationMs)).toBe(expected);
  });

  it.each([-1, NaN, Infinity])("handles invalid duration %s", (durationMs) => {
    expect(formatDuration(durationMs)).toBe("0ms");
  });
});

describe("formatWorkingTimer", () => {
  const start = "2026-01-01T00:00:00.000Z";
  const at = (ms: number) => new Date(Date.parse(start) + ms).toISOString();

  it.each([
    [0, "0s"],
    [9_999, "9s"],
    [59_999, "59s"],
    [60_000, "1m"],
    [25_190_900, "6h 59m 50s"],
  ])("formats %d ms elapsed as %s", (elapsedMs, expected) => {
    expect(formatWorkingTimer(start, at(elapsedMs))).toBe(expected);
  });

  it("returns null for invalid timestamps", () => {
    expect(formatWorkingTimer("nope", at(0))).toBeNull();
  });
});

describe("deriveWorkLogEntries runtime diagnostics", () => {
  const retainedMessage =
    "ERROR codex_core::codex: failed to load skill /repo/.agent/skills/scaffolding/SKILL.md: invalid YAML: mapping va...";
  const warningSummary = "ERROR codex_core::codex: failed to load skill /repo/.agent/sk...";

  it("uses the error message as detail under a generic label", () => {
    const [entry] = deriveWorkLogEntries(
      [
        makeActivity({
          kind: "runtime.error",
          tone: "error",
          summary: "Runtime error",
          payload: { message: retainedMessage },
        }),
      ],
      undefined,
    );
    expect(entry).toMatchObject({ label: "Runtime error", detail: retainedMessage });
  });

  it("replaces a truncated label with the full warning message instead of repeating it", () => {
    const [entry] = deriveWorkLogEntries(
      [
        makeActivity({
          kind: "runtime.warning",
          tone: "info",
          summary: warningSummary,
          payload: { message: retainedMessage },
        }),
      ],
      undefined,
    );
    expect(entry?.label).toBe(retainedMessage);
    expect(entry?.detail).toBeUndefined();
  });

  it("shows a long runtime error once when its summary is the message cut to a title", () => {
    const message = `Claude Code process exited unexpectedly: ${"stderr line ".repeat(20).trim()}`;
    const summary = `${message.slice(0, 117)}...`;
    const [entry] = deriveWorkLogEntries(
      [
        makeActivity({
          kind: "runtime.error",
          tone: "error",
          summary,
          payload: { message },
        }),
      ],
      undefined,
    );
    expect(message.length).toBeGreaterThan(200);
    expect(entry?.label).toBe(message);
    expect(entry?.detail).toBeUndefined();
  });

  it("keeps an existing detail", () => {
    const [entry] = deriveWorkLogEntries(
      [
        makeActivity({
          kind: "runtime.warning",
          tone: "info",
          summary: "Runtime warning",
          payload: { message: retainedMessage, detail: "Run claude auth login." },
        }),
      ],
      undefined,
    );
    expect(entry?.detail).toBe("Run claude auth login.");
  });

  it("does not repeat a short message already shown as the label", () => {
    const [entry] = deriveWorkLogEntries(
      [
        makeActivity({
          kind: "runtime.warning",
          tone: "info",
          summary: "Reconnecting... 2/5",
          payload: { message: "Reconnecting...  2/5\n" },
        }),
      ],
      undefined,
    );
    expect(entry?.label).toBe("Reconnecting... 2/5");
    expect(entry?.detail).toBeUndefined();
  });

  it("ignores messages on unrelated activities", () => {
    const [entry] = deriveWorkLogEntries(
      [
        makeActivity({
          kind: "tool.completed",
          summary: "Read file",
          payload: { message: retainedMessage },
        }),
      ],
      undefined,
    );
    expect(entry?.detail).toBeUndefined();
  });
});

describe("deriveWorkLogEntries shell wrapper commands", () => {
  function commandEntry(command: unknown, id = "command-tool") {
    const [entry] = deriveWorkLogEntries(
      [
        makeActivity({
          id,
          kind: "tool.completed",
          summary: "Ran command",
          payload: { itemType: "command_execution", data: { item: { command } } },
        }),
      ],
      undefined,
    );
    return entry;
  }

  it.each([
    ['/bin/zsh -lc "rg foo src"', "rg foo src"],
    ["bash -c 'bun run lint'", "bun run lint"],
    ["/usr/bin/sh -c ls", "ls"],
    ["cmd.exe /c dir", "dir"],
    ["\"C:\\Program Files\\PowerShell\\7\\pwsh.exe\" -Command 'bun run lint'", "bun run lint"],
    [
      "powershell.exe -NoLogo -NoProfile -Command 'rg -n -F \"new Date()\" .'",
      'rg -n -F "new Date()" .',
    ],
  ])("unwraps %s", (raw, expected) => {
    const entry = commandEntry(raw);
    expect(entry?.command).toBe(expected);
    expect(entry?.rawCommand).toBe(raw);
  });

  it("unwraps argv-style wrappers and quotes parts that contain spaces", () => {
    const entry = commandEntry([
      "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      "-Command",
      "rg -n foo .",
    ]);
    expect(entry?.command).toBe("rg -n foo .");
    expect(entry?.rawCommand).toBe(
      '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command "rg -n foo ."',
    );
  });

  it.each([
    ["bash -l -c 'bun test'", "bun test"],
    ["bash --noprofile -c ls", "ls"],
    ['cmd.exe /d /s /c "dir /b"', "dir /b"],
    ["/bin/bash -lc 'echo '\"'\"'hi'\"'\"''", "echo 'hi'"],
    ['/bin/zsh -lc "echo \\"hi\\""', 'echo "hi"'],
  ])("unwraps and unescapes %s", (raw, expected) => {
    const entry = commandEntry(raw);
    expect(entry?.command).toBe(expected);
    expect(entry?.rawCommand).toBe(raw);
  });

  it("unwraps argv-style POSIX wrappers without leaving escaped quotes", () => {
    const entry = commandEntry(["/bin/bash", "-lc", 'echo "hi"']);
    expect(entry?.command).toBe('echo "hi"');
    expect(entry?.rawCommand).toBe('/bin/bash -lc "echo \\"hi\\""');
  });

  it("leaves argv-style shell script invocations unchanged", () => {
    const entry = commandEntry(["bash", "run.sh", "-c", "3"]);
    expect(entry?.command).toBe("bash run.sh -c 3");
    expect(entry?.rawCommand).toBeUndefined();
  });

  it.each(["bash script.sh", "rg -c foo", "zsh", "bash run.sh -c 3 tests", "bash -C foo.sh"])(
    "leaves %s unchanged",
    (raw) => {
      const entry = commandEntry(raw);
      expect(entry?.command).toBe(raw);
      expect(entry?.rawCommand).toBeUndefined();
    },
  );

  it("keeps the raw command when lifecycle entries merge", () => {
    const raw = '/bin/zsh -lc "rg foo"';
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "cmd-updated",
          createdAt: "2026-02-23T00:00:01.000Z",
          kind: "tool.updated",
          summary: "Ran command",
          payload: {
            itemType: "command_execution",
            providerItemId: "item-1",
            data: { item: { command: raw } },
          },
        }),
        makeActivity({
          id: "cmd-completed",
          createdAt: "2026-02-23T00:00:02.000Z",
          kind: "tool.completed",
          summary: "Ran command",
          payload: { itemType: "command_execution", providerItemId: "item-1" },
        }),
      ],
      undefined,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ command: "rg foo", rawCommand: raw });
  });
});

describe("stale pending request wording", () => {
  it("closes a Codex user-input request reported without the hyphen", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "codex-input-open",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "user-input.requested",
        tone: "info",
        payload: {
          requestId: "req-1",
          questions: [
            {
              id: "q",
              header: "Q",
              question: "Pick one",
              options: [{ label: "a", description: "A" }],
            },
          ],
        },
      }),
      makeActivity({
        id: "codex-input-failed",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "provider.user-input.respond.failed",
        tone: "error",
        payload: { requestId: "req-1", detail: "Unknown pending user input request: req-1" },
      }),
    ];
    expect(derivePendingUserInputs(activities)).toEqual([]);
  });
});

describe("questions left open by a restart", () => {
  const question = makeActivity({
    id: "restart-input-open",
    createdAt: "2026-02-23T00:00:01.000Z",
    kind: "user-input.requested",
    tone: "info",
    payload: {
      requestId: "req-1",
      questions: [
        {
          id: "q",
          header: "Q",
          question: "Pick one",
          options: [{ label: "a", description: "A" }],
        },
      ],
    },
  });

  it("stays answerable through a failure that does not report a lost request", () => {
    const pending = derivePendingUserInputs([
      question,
      makeActivity({
        id: "restart-input-no-session",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "provider.user-input.respond.failed",
        tone: "error",
        payload: {
          requestId: "req-1",
          detail: "No active provider session is bound to this thread.",
        },
      }),
    ]);
    expect(pending.map((input) => input.requestId)).toEqual(["req-1"]);
  });

  it("closes on the recorded answer and adds no work log row", () => {
    const activities = [
      question,
      makeActivity({
        id: "restart-input-answered",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "user-input.resolved",
        tone: "info",
        payload: { requestId: "req-1", answers: { q: "a" } },
      }),
    ];
    expect(derivePendingUserInputs(activities)).toEqual([]);
    expect(deriveWorkLogEntries(activities, undefined)).toEqual([]);
  });

  it("shows a recorded answer once, as a card in place of the message that carries it", () => {
    const answerMessage = (id: string) =>
      ({
        id: MessageId.makeUnsafe(id),
        role: "user",
        text: "Pick one\na",
        createdAt: "2026-02-23T00:00:03.000Z",
        streaming: false,
      }) as const;
    const cards = deriveQaCardMessages([
      question,
      makeActivity({
        id: "restart-input-answered-message",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "user-input.resolved",
        tone: "info",
        payload: { requestId: "req-1", responseMode: "message", answers: { q: "a" } },
      }),
    ]);
    expect(cards.map((card) => card.text)).toEqual(["[qa-card]\nPick one\ta"]);

    const messages = dropAsyncAnswerMessagesWithQaCards(
      [answerMessage("async-answer:req-1"), answerMessage("plain")],
      cards,
    );
    expect(messages.map((message) => message.id)).toEqual(["plain"]);
  });

  it("stays closed when the resolved row sorts before its request, as on the server", () => {
    const resolvedEarlier = makeActivity({
      id: "restart-input-answered-early",
      createdAt: "2026-02-23T00:00:00.500Z",
      kind: "user-input.resolved",
      tone: "info",
      payload: { requestId: "req-1", responseMode: "message", answers: { q: "a" } },
    });
    expect(derivePendingUserInputs([question, resolvedEarlier])).toEqual([]);
    expect(derivePendingUserInputs([resolvedEarlier, question])).toEqual([]);
  });

  it("leaves other questions open when one request is resolved out of order", () => {
    const pending = derivePendingUserInputs([
      makeActivity({
        id: "restart-input-other-answered",
        createdAt: "2026-02-23T00:00:00.500Z",
        kind: "user-input.resolved",
        tone: "info",
        payload: { requestId: "req-other", answers: { q: "a" } },
      }),
      question,
    ]);
    expect(pending.map((input) => input.requestId)).toEqual(["req-1"]);
  });

  it("still reopens on a request re-sent after a stale failure", () => {
    const pending = derivePendingUserInputs([
      question,
      makeActivity({
        id: "restart-input-stale",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "provider.user-input.respond.failed",
        tone: "error",
        payload: { requestId: "req-1", detail: "Stale pending user-input request: req-1" },
      }),
      makeActivity({
        id: "restart-input-reasked",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "user-input.requested",
        tone: "info",
        payload: question.payload as Record<string, unknown>,
      }),
    ]);
    expect(pending.map((input) => input.requestId)).toEqual(["req-1"]);
  });
});

describe("canDismissPendingUserInput", () => {
  const session = (orchestrationStatus: OrchestrationSessionStatus, activeTurnId?: string) => ({
    orchestrationStatus,
    activeTurnId: activeTurnId ? TurnId.makeUnsafe(activeTurnId) : undefined,
  });

  it("always offers it for a non-blocking question", () => {
    expect(canDismissPendingUserInput({ responseMode: "message" }, session("running", "t"))).toBe(
      true,
    );
  });

  it.each([
    ["no session", null, true],
    ["a stopped session", session("stopped"), true],
    ["a session that errored", session("error"), true],
    ["a running turn", session("running", "t"), false],
    ["a session that is starting", session("starting"), false],
    ["a ready session, whose provider may still hold the callback", session("ready"), false],
    ["a stopped status with a turn still recorded", session("stopped", "t"), false],
  ])("for a blocking question with %s returns %s", (_name, value, expected) => {
    expect(canDismissPendingUserInput({}, value)).toBe(expected);
    expect(canDismissPendingUserInput({ responseMode: "blocking" }, value)).toBe(expected);
  });
});

describe("pending approval reason and standing grant", () => {
  it("copies the permission reason and the no-standing-grant flag", () => {
    const [approval] = derivePendingApprovals([
      makeActivity({
        kind: "approval.requested",
        tone: "approval",
        payload: {
          requestId: "req-1",
          requestKind: "command",
          detail: "rm -rf build",
          reason: "Matched ask rule Bash(rm:*)",
          noStandingGrant: true,
        },
      }),
    ]);
    expect(approval).toMatchObject({
      reason: "Matched ask rule Bash(rm:*)",
      noStandingGrant: true,
    });
  });

  it("leaves both fields out when the payload has none", () => {
    const [approval] = derivePendingApprovals([
      makeActivity({
        kind: "approval.requested",
        tone: "approval",
        payload: {
          requestId: "req-1",
          requestKind: "command",
          reason: "  ",
          noStandingGrant: false,
        },
      }),
    ]);
    expect(approval).not.toHaveProperty("reason");
    expect(approval).not.toHaveProperty("noStandingGrant");
  });
});

describe("deriveActivePlanState earlier unfinished plans", () => {
  function plan(id: string, turnId: string, statuses: string[], createdAt: string) {
    return makeActivity({
      id,
      createdAt,
      kind: "turn.plan.updated",
      tone: "info",
      turnId,
      payload: { plan: statuses.map((status, index) => ({ step: `Step ${index}`, status })) },
    });
  }

  it("keeps an unfinished plan from an earlier turn only when asked", () => {
    const activities = [plan("p1", "turn-1", ["completed", "inProgress"], "2026-02-23T00:00:01Z")];
    const latestTurnId = TurnId.makeUnsafe("turn-2");
    expect(
      deriveActivePlanState(activities, latestTurnId, { keepUnfinishedEarlierPlan: true }),
    ).toMatchObject({ turnId: "turn-1", createdAt: "2026-02-23T00:00:01Z" });
    expect(deriveActivePlanState(activities, latestTurnId)).toBeNull();
  });

  it("drops an earlier plan once every step is completed", () => {
    const activities = [plan("p1", "turn-1", ["completed", "completed"], "2026-02-23T00:00:01Z")];
    expect(
      deriveActivePlanState(activities, TurnId.makeUnsafe("turn-2"), {
        keepUnfinishedEarlierPlan: true,
      }),
    ).toBeNull();
  });

  it("keeps an interrupted turn's unfinished TodoWrite plan until a new plan arrives", () => {
    // Claude CLI todos are session-scoped, so an interrupted turn's list stays visible.
    const interrupted = plan(
      "todo-1",
      "turn-1",
      ["completed", "inProgress"],
      "2026-02-23T00:00:01Z",
    );
    expect(
      deriveActivePlanState([interrupted], TurnId.makeUnsafe("turn-3"), {
        keepUnfinishedEarlierPlan: true,
      }),
    ).toMatchObject({
      turnId: "turn-1",
      steps: [{ status: "completed" }, { status: "inProgress" }],
    });

    const replacement = plan("todo-2", "turn-2", ["pending"], "2026-02-23T00:00:02Z");
    expect(
      deriveActivePlanState([interrupted, replacement], TurnId.makeUnsafe("turn-3"), {
        keepUnfinishedEarlierPlan: true,
      }),
    ).toMatchObject({ turnId: "turn-2", steps: [{ status: "pending" }] });
  });

  it("orders plan snapshots by sequence while ignoring unrelated activities", () => {
    const activities = Object.freeze([
      makeActivity({
        id: "completed",
        createdAt: "2026-02-23T00:00:05.000Z",
        kind: "turn.plan.updated",
        turnId: "turn-1",
        sequence: 3,
        payload: { plan: [{ step: "Check", status: "completed" }] },
      }),
      makeActivity({ id: "tool", kind: "tool.completed", sequence: 4 }),
      makeActivity({
        id: "started",
        createdAt: "2026-02-23T00:00:00.000Z",
        kind: "turn.plan.updated",
        turnId: "turn-1",
        sequence: 1,
        payload: { plan: [{ step: "Check", status: "inProgress" }] },
      }),
      makeActivity({ id: "context", kind: "context-window.updated", sequence: 2 }),
    ]);

    expect(deriveActivePlanState(activities, TurnId.makeUnsafe("turn-1"))?.steps).toEqual([
      { step: "Check", status: "completed" },
    ]);
    expect(activities[0]?.id).toBe("completed");
    expect(deriveActivePlanState([makeActivity({ kind: "tool.completed" })], undefined)).toBeNull();
  });

  it("prefers the latest turn's own plan", () => {
    const activities = [
      plan("p1", "turn-1", ["inProgress"], "2026-02-23T00:00:01Z"),
      plan("p2", "turn-2", ["completed"], "2026-02-23T00:00:02Z"),
      plan("p3", "turn-1", ["pending"], "2026-02-23T00:00:03Z"),
    ];
    expect(
      deriveActivePlanState(activities, TurnId.makeUnsafe("turn-2"), {
        keepUnfinishedEarlierPlan: true,
      }),
    ).toMatchObject({ turnId: "turn-2", steps: [{ status: "completed" }] });
  });
});

describe("deriveWorkLogEntries free-text rows", () => {
  it("keeps task progress and runtime warnings that mention user input", () => {
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "task-progress",
          createdAt: "2026-02-23T00:00:01.000Z",
          kind: "task.progress",
          tone: "info",
          summary: "User input validation audit",
          payload: { detail: "Checking AskUserQuestion handling" },
        }),
        makeActivity({
          id: "runtime-warning",
          createdAt: "2026-02-23T00:00:02.000Z",
          kind: "runtime.warning",
          tone: "info",
          summary: "Tool AskUserQuestion was denied: User input unavailable",
          payload: { detail: "Tool AskUserQuestion was denied" },
        }),
      ],
      undefined,
    );
    expect(entries.map((entry) => entry.id)).toEqual(["task-progress", "runtime-warning"]);
  });
});

describe("deriveWorkLogEntries tool status", () => {
  function lifecycle(kind: string, createdAt: string, payload: Record<string, unknown> = {}) {
    return makeActivity({
      id: `${kind}-${createdAt}`,
      createdAt,
      kind,
      summary: "Run tests",
      payload: { itemType: "dynamic_tool_call", providerItemId: "item-1", ...payload },
    });
  }

  it("reads failed and declined statuses from completed tool calls", () => {
    expect(
      deriveWorkLogEntries(
        [lifecycle("tool.completed", "2026-02-23T00:00:01Z", { status: "failed" })],
        undefined,
      ),
    ).toMatchObject([{ toolStatus: "failed" }]);
    expect(
      deriveWorkLogEntries(
        [lifecycle("tool.completed", "2026-02-23T00:00:01Z", { status: "declined" })],
        undefined,
      ),
    ).toMatchObject([{ toolStatus: "declined" }]);
  });

  it("treats a completed tool call without a status as completed", () => {
    expect(
      extractWorkLogToolLifecycleStatus({ kind: "tool.completed", payload: { itemType: "x" } }),
    ).toBe("completed");
    expect(
      extractWorkLogToolLifecycleStatus({ kind: "tool.updated", payload: {} }),
    ).toBeUndefined();
    expect(
      extractWorkLogToolLifecycleStatus({ kind: "runtime.error", payload: { status: "failed" } }),
    ).toBeUndefined();
  });

  it("lets a later successful completion clear an earlier failed update", () => {
    const [entry] = deriveWorkLogEntries(
      [
        lifecycle("tool.started", "2026-02-23T00:00:01Z"),
        lifecycle("tool.updated", "2026-02-23T00:00:02Z", { status: "failed" }),
        lifecycle("tool.completed", "2026-02-23T00:00:03Z"),
      ],
      undefined,
    );
    expect(entry?.toolStatus).toBe("completed");
  });

  it("keeps a failed completion's status through the merge", () => {
    const [entry] = deriveWorkLogEntries(
      [
        lifecycle("tool.updated", "2026-02-23T00:00:01Z", { status: "inProgress" }),
        lifecycle("tool.completed", "2026-02-23T00:00:02Z", { status: "failed" }),
      ],
      undefined,
    );
    expect(entry).toMatchObject({ toolStatus: "failed" });
    expect(entry?.inProgress).toBeUndefined();
  });
});

describe("deriveWorkLogEntries bookkeeping rows", () => {
  it("drops empty Claude system message warnings and keeps readable ones", () => {
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "empty",
          kind: "runtime.warning",
          tone: "info",
          summary: "Claude system message 'background_tasks_changed' (no displayable text content)",
        }),
        makeActivity({
          id: "reconnecting",
          kind: "runtime.warning",
          tone: "info",
          summary: "Reconnecting... 2/5",
        }),
      ],
      undefined,
    );
    expect(entries.map((entry) => entry.id)).toEqual(["reconnecting"]);
  });

  it("never shows usage limit bookkeeping activities", () => {
    expect(
      deriveWorkLogEntries(
        [
          makeActivity({
            kind: THREAD_USAGE_LIMIT_ACTIVITY_KIND,
            tone: "error",
            summary: "Usage limit reached",
          }),
          makeActivity({
            kind: THREAD_USAGE_LIMIT_RESUME_CANCELLED_ACTIVITY_KIND,
            tone: "info",
            summary: "Resume cancelled",
          }),
        ],
        undefined,
      ),
    ).toEqual([]);
  });

  it("keeps the turn id on every row, including merged tool lifecycle rows", () => {
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "tool-updated",
          createdAt: "2026-02-23T00:00:01.000Z",
          kind: "tool.updated",
          summary: "Read file",
          turnId: "turn-1",
          payload: { providerItemId: "item-1", itemType: "dynamic_tool_call" },
        }),
        makeActivity({
          id: "tool-completed",
          createdAt: "2026-02-23T00:00:02.000Z",
          kind: "tool.completed",
          summary: "Read file",
          turnId: "turn-1",
          payload: { providerItemId: "item-1", itemType: "dynamic_tool_call" },
        }),
        makeActivity({
          id: "notice",
          createdAt: "2026-02-23T00:00:03.000Z",
          kind: "runtime.warning",
          tone: "info",
          summary: "Reconnecting... 2/5",
          turnId: "turn-2",
        }),
      ],
      undefined,
    );
    expect(entries.map((entry) => entry.turnId)).toEqual(["turn-1", "turn-2"]);
  });
});

describe("deriveWorkLogEntries context compaction", () => {
  function compaction(id: string, kind: string, createdAt: string, payload = {}) {
    return makeActivity({
      id,
      createdAt,
      kind,
      tone: kind.endsWith("failed") ? "error" : "info",
      summary:
        kind === "context-compaction.started"
          ? "Compacting context"
          : kind === "context-compaction.failed"
            ? "Context compaction failed"
            : "Context compacted",
      payload,
    });
  }

  it("shows a running compaction as an in-progress row", () => {
    const entries = deriveWorkLogEntries(
      [compaction("c1", "context-compaction.started", "2026-02-23T00:00:01Z")],
      undefined,
    );
    expect(entries).toMatchObject([
      { label: "Compacting context", inProgress: true, isContextCompaction: true },
    ]);
  });

  it("marks settled compaction rows without treating them as running", () => {
    const compacted = deriveWorkLogEntries(
      [compaction("c1", "context-compaction", "2026-02-23T00:00:01Z")],
      undefined,
    );
    expect(compacted[0]?.isContextCompaction).toBe(true);
    expect(compacted[0]?.inProgress).toBeUndefined();
    const failed = deriveWorkLogEntries(
      [compaction("c2", "context-compaction.failed", "2026-02-23T00:00:01Z")],
      undefined,
    );
    expect(failed[0]?.isContextCompaction).toBe(true);
    expect(failed[0]?.inProgress).toBeUndefined();
  });

  it("shows only the compacted row once compaction succeeds", () => {
    const entries = deriveWorkLogEntries(
      [
        compaction("c1", "context-compaction.started", "2026-02-23T00:00:01Z", {
          providerItemId: "cmp-1",
        }),
        compaction("c2", "context-compaction.completed", "2026-02-23T00:00:02Z", {
          providerItemId: "cmp-1",
        }),
        compaction("c3", "context-compaction", "2026-02-23T00:00:02Z"),
      ],
      undefined,
    );
    expect(entries.map((entry) => entry.label)).toEqual(["Context compacted"]);
  });

  it("replaces the running row with the failure and its detail", () => {
    const entries = deriveWorkLogEntries(
      [
        compaction("c1", "context-compaction.started", "2026-02-23T00:00:01Z"),
        compaction("c2", "context-compaction.failed", "2026-02-23T00:00:02Z", {
          detail: "Prompt too long",
        }),
      ],
      undefined,
    );
    expect(entries).toMatchObject([
      { label: "Context compaction failed", tone: "error", detail: "Prompt too long" },
    ]);
  });

  it("never shows model switch activities", () => {
    expect(
      deriveWorkLogEntries(
        [makeActivity({ kind: "turn.model-switched", tone: "info", summary: "Model switched" })],
        undefined,
      ),
    ).toEqual([]);
  });
});

describe("deriveWorkLogEntries reasoning", () => {
  const thought = (id: string, status: string) =>
    makeActivity({
      id,
      kind: THREAD_REASONING_ACTIVITY_KIND,
      tone: "thinking",
      summary: "Thought",
      payload: { stream: "summary", status, detail: "Some thinking" },
    });

  it("leaves no row for a thought promoted to assistant text", () => {
    expect(
      deriveWorkLogEntries(
        [thought("kept", "completed"), thought("promoted", "promoted")],
        undefined,
      ).map((entry) => entry.id),
    ).toEqual(["kept"]);
  });
});

describe("deriveWorkLogEntries expandable tool data", () => {
  function toolActivity(
    id: string,
    kind: OrchestrationThreadActivity["kind"],
    payload: Record<string, unknown>,
  ): OrchestrationThreadActivity {
    return makeActivity({ id, kind, tone: "tool", summary: "Ran tool", payload });
  }

  it("keeps an MCP tool's whole input and its result summary across the lifecycle", () => {
    const input = { query: "x".repeat(600), limit: 3 };
    const [entry] = deriveWorkLogEntries(
      [
        toolActivity("a1", "tool.updated", {
          itemType: "mcp_tool_call",
          providerItemId: "tool-1",
          data: { toolName: "mcp__s__m", input },
        }),
        toolActivity("a2", "tool.completed", {
          itemType: "mcp_tool_call",
          providerItemId: "tool-1",
          data: { toolName: "mcp__s__m", result: { content: "Found 3 results" } },
        }),
      ],
      undefined,
    );
    expect(entry?.toolInput).toBe(input);
    expect(entry?.toolResultSummary).toBe("Found 3 results");
  });

  it("reads the result of a failed Codex tool from its projected item", () => {
    const [entry] = deriveWorkLogEntries(
      [
        toolActivity("a1", "tool.completed", {
          itemType: "mcp_tool_call",
          providerItemId: "tool-1",
          status: "failed",
          data: {
            item: {
              type: "mcpToolCall",
              id: "tool-1",
              status: "failed",
              result: { content: "server gone" },
            },
          },
        }),
      ],
      undefined,
    );
    expect(entry?.toolResultSummary).toBe("server gone");
  });

  it("reads a Codex tool call's arguments from its item", () => {
    const args = { query: "needle" };
    const [entry] = deriveWorkLogEntries(
      [
        toolActivity("a1", "tool.updated", {
          itemType: "mcp_tool_call",
          providerItemId: "tool-1",
          data: { item: { type: "mcpToolCall", id: "tool-1", tool: "m", arguments: args } },
        }),
      ],
      undefined,
    );
    expect(entry?.toolInput).toBe(args);
  });

  it("uses a Codex subagent's prompt as its input, as that call has no arguments", () => {
    const derive = (itemType: string, item: Record<string, unknown>) =>
      deriveWorkLogEntries(
        [toolActivity("a1", "tool.updated", { itemType, providerItemId: "t", data: { item } })],
        undefined,
      )[0]?.toolInput;
    const collab = "collab_agent_tool_call";
    expect(derive(collab, { prompt: " Audit it " })).toEqual({ prompt: "Audit it" });
    expect(derive(collab, { prompt: "   " })).toBeUndefined();
    expect(derive(collab, { prompt: null })).toBeUndefined();
    expect(derive("mcp_tool_call", { prompt: "Audit it" })).toBeUndefined();
  });

  it("leaves tools with a preview card without a copy of their input", () => {
    const [entry] = deriveWorkLogEntries(
      [
        toolActivity("a1", "tool.updated", {
          itemType: "command_execution",
          data: { toolName: "Bash", input: { command: "ls" } },
        }),
      ],
      undefined,
    );
    expect(entry?.toolInput).toBeUndefined();
  });
});
