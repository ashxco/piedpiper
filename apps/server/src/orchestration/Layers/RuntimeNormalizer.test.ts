import { describe, expect, it } from "vitest";

import {
  EventId,
  ProviderItemId,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@piedpiper/contracts";

import { runtimeEventToActivities, truncateDetail } from "./RuntimeNormalizer";

const baseStamps = {
  eventId: EventId.makeUnsafe("evt-1"),
  provider: "claudeAgent" as const,
  createdAt: "2026-04-08T00:00:00.000Z",
  threadId: ThreadId.makeUnsafe("thread-1"),
  turnId: TurnId.makeUnsafe("turn-1"),
};

describe("runtimeEventToActivities — usage limits", () => {
  const completed = (payload: object): ProviderRuntimeEvent => ({
    type: "turn.completed",
    ...baseStamps,
    payload: { state: "failed", ...payload },
  });

  it("records the reset and limit types of a turn stopped by a usage limit", () => {
    const [activity] = runtimeEventToActivities(
      completed({
        rateLimitResetAt: "2026-04-08T05:00:00.000Z",
        rateLimitTypes: ["five_hour"],
      }),
    );
    expect(activity?.kind).toBe("turn.usage-limit-reached");
    expect(activity?.tone).toBe("error");
    expect(activity?.turnId).toBe("turn-1");
    expect(activity?.payload).toEqual({
      resetAt: "2026-04-08T05:00:00.000Z",
      limitTypes: ["five_hour"],
    });
  });

  it("records an unknown reset as null", () => {
    const [activity] = runtimeEventToActivities(completed({ rateLimitResetAt: null }));
    expect(activity?.payload).toEqual({ resetAt: null });
  });

  it("records nothing for a turn that did not hit a limit", () => {
    expect(runtimeEventToActivities(completed({ errorMessage: "boom" }))).toEqual([]);
  });
});

describe("runtimeEventToActivities — tool lifecycle", () => {
  it("forwards data (toolName + input) on item.started so the frontend can build friendly action labels", () => {
    const event: ProviderRuntimeEvent = {
      type: "item.started",
      ...baseStamps,
      itemId: RuntimeItemId.makeUnsafe("toolu_abc"),
      payload: {
        itemType: "dynamic_tool_call",
        status: "inProgress",
        title: "Tool call",
        detail: "Read: {}",
        data: {
          toolName: "Read",
          input: {},
        },
      },
      providerRefs: { providerItemId: ProviderItemId.makeUnsafe("toolu_abc") },
    };

    const [activity] = runtimeEventToActivities(event);
    expect(activity).toBeDefined();
    expect(activity?.kind).toBe("tool.started");
    const payload = activity?.payload as Record<string, unknown> | undefined;
    expect(payload).toBeDefined();
    expect(payload?.data).toEqual({ toolName: "Read", input: {} });
  });

  it("forwards data on item.updated", () => {
    const event: ProviderRuntimeEvent = {
      type: "item.updated",
      ...baseStamps,
      itemId: RuntimeItemId.makeUnsafe("toolu_abc"),
      payload: {
        itemType: "dynamic_tool_call",
        status: "inProgress",
        title: "Tool call",
        detail: 'Read: {"file_path":"/foo"}',
        data: {
          toolName: "Read",
          input: { file_path: "/foo" },
        },
      },
      providerRefs: { providerItemId: ProviderItemId.makeUnsafe("toolu_abc") },
    };

    const [activity] = runtimeEventToActivities(event);
    const payload = activity?.payload as Record<string, unknown> | undefined;
    expect(payload?.data).toEqual({ toolName: "Read", input: { file_path: "/foo" } });
  });
});

describe("runtimeEventToActivities — tool payload slimming", () => {
  it("carries slimmed data on item.completed with the tool output summarized", () => {
    const event: ProviderRuntimeEvent = {
      type: "item.completed",
      ...baseStamps,
      itemId: RuntimeItemId.makeUnsafe("toolu_abc"),
      payload: {
        itemType: "command_execution",
        status: "completed",
        title: "Ran command",
        data: {
          toolName: "Bash",
          input: { command: "cat big.log" },
          result: { type: "tool_result", content: `first line\n${"noise\n".repeat(5000)}` },
        },
      },
    };

    const [activity] = runtimeEventToActivities(event);
    expect((activity?.payload as Record<string, unknown> | undefined)?.data).toEqual({
      toolName: "Bash",
      input: { command: "cat big.log" },
      result: { content: "first line" },
    });
  });
});

describe("runtimeEventToActivities — tool status", () => {
  it("carries the provider's terminal status on tool.completed", () => {
    const completed = (status: "completed" | "failed" | "declined" | undefined) =>
      runtimeEventToActivities({
        type: "item.completed",
        ...baseStamps,
        itemId: RuntimeItemId.makeUnsafe("toolu_status"),
        payload: {
          itemType: "command_execution",
          ...(status ? { status } : {}),
          title: "Ran command",
        },
      })[0]?.payload as Record<string, unknown> | undefined;

    expect(completed("failed")?.status).toBe("failed");
    expect(completed("declined")?.status).toBe("declined");
    expect(completed("completed")?.status).toBe("completed");
    expect(completed(undefined)).not.toHaveProperty("status");
  });
});

describe("runtimeEventToActivities — approval requests", () => {
  it("classifies dynamic tool call approvals as command requests", () => {
    const opened: ProviderRuntimeEvent = {
      type: "request.opened",
      ...baseStamps,
      requestId: RuntimeRequestId.makeUnsafe("req-1"),
      payload: { requestType: "dynamic_tool_call", detail: "WebFetch" },
    };
    const resolved: ProviderRuntimeEvent = {
      type: "request.resolved",
      ...baseStamps,
      eventId: EventId.makeUnsafe("evt-2"),
      requestId: RuntimeRequestId.makeUnsafe("req-1"),
      payload: { requestType: "dynamic_tool_call", decision: "accept" },
    };

    const [openedActivity] = runtimeEventToActivities(opened);
    const [resolvedActivity] = runtimeEventToActivities(resolved);
    expect(openedActivity?.kind).toBe("approval.requested");
    expect((openedActivity?.payload as Record<string, unknown> | undefined)?.requestKind).toBe(
      "command",
    );
    expect((resolvedActivity?.payload as Record<string, unknown> | undefined)?.requestKind).toBe(
      "command",
    );
  });

  it("keeps the full approval detail instead of truncating it", () => {
    const detail = [
      "Edit files:",
      ...Array.from({ length: 20 }, (_, index) => `/repo/src/some/deep/path/file-${index}.ts`),
      "+3 more",
    ].join("\n");
    const event: ProviderRuntimeEvent = {
      type: "request.opened",
      ...baseStamps,
      requestId: RuntimeRequestId.makeUnsafe("req-2"),
      payload: { requestType: "file_change_approval", detail },
    };

    const [activity] = runtimeEventToActivities(event);
    expect((activity?.payload as Record<string, unknown> | undefined)?.detail).toBe(detail);
  });

  it("carries Claude's permission reason and no-standing-grant flag", () => {
    const opened = (extra: Record<string, unknown>) =>
      runtimeEventToActivities({
        type: "request.opened",
        ...baseStamps,
        requestId: RuntimeRequestId.makeUnsafe("req-3"),
        payload: { requestType: "command_execution_approval", detail: "rm -rf build", ...extra },
      } as ProviderRuntimeEvent)[0]?.payload as Record<string, unknown> | undefined;

    expect(opened({ reason: "Matched ask rule Bash(rm:*)", noStandingGrant: true })).toMatchObject({
      reason: "Matched ask rule Bash(rm:*)",
      noStandingGrant: true,
    });
    const plain = opened({ noStandingGrant: false });
    expect(plain).not.toHaveProperty("reason");
    expect(plain).not.toHaveProperty("noStandingGrant");
  });
});

describe("runtimeEventToActivities — context compaction", () => {
  const compaction = (
    type: "item.started" | "item.completed",
    payload: Record<string, unknown>,
  ): ProviderRuntimeEvent =>
    ({
      type,
      ...baseStamps,
      itemId: RuntimeItemId.makeUnsafe("compact-uuid"),
      payload: { itemType: "context_compaction", ...payload },
    }) as ProviderRuntimeEvent;

  it("records a running compaction", () => {
    const [activity] = runtimeEventToActivities(
      compaction("item.started", { status: "inProgress", title: "Compacting context" }),
    );
    expect(activity).toMatchObject({
      kind: "context-compaction.started",
      tone: "info",
      summary: "Compacting context",
      payload: { providerItemId: "compact-uuid", status: "inProgress" },
      turnId: "turn-1",
    });
  });

  it("records a failed compaction with its error detail", () => {
    const [activity] = runtimeEventToActivities(
      compaction("item.completed", {
        status: "failed",
        title: "Context compaction failed",
        detail: "Prompt too long",
      }),
    );
    expect(activity).toMatchObject({
      kind: "context-compaction.failed",
      tone: "error",
      summary: "Context compaction failed",
      payload: { providerItemId: "compact-uuid", status: "failed", detail: "Prompt too long" },
    });
  });

  it("closes a successful compaction without a status", () => {
    const [activity] = runtimeEventToActivities(
      compaction("item.completed", { status: "completed", title: "Compacting context" }),
    );
    expect(activity).toMatchObject({
      kind: "context-compaction.completed",
      summary: "Context compacted",
      payload: { providerItemId: "compact-uuid" },
    });
    expect(activity?.payload).not.toHaveProperty("status");
  });
});

describe("truncateDetail", () => {
  it("never splits an emoji at the cut", () => {
    const value = `${"a".repeat(6)}\u{1F600}${"b".repeat(10)}`;
    // limit - 3 = 7 lands between the emoji's two code units.
    expect(truncateDetail(value, 10)).toBe(`${"a".repeat(6)}...`);
  });
});

describe("runtimeEventToActivities — runtime errors", () => {
  it("keeps a long usage-limit message whole", () => {
    const message =
      "Codex usage limit reached. The monthly limit resets in 29d 23h. The workspace has no credits to continue sooner: ask your workspace owner to add credits, or send the message again once the limit resets.";
    expect(message.length).toBeGreaterThan(180);
    const event: ProviderRuntimeEvent = {
      type: "runtime.error",
      ...baseStamps,
      payload: { message },
    };

    const [activity] = runtimeEventToActivities(event);
    expect(activity?.kind).toBe("runtime.error");
    expect((activity?.payload as Record<string, unknown> | undefined)?.message).toBe(message);
  });
});

describe("runtimeEventToActivities — readable titles", () => {
  it("titles runtime warnings with a one-line message and keeps the message in the payload", () => {
    const message = `Tool Bash was denied:\n  ${"x".repeat(200)}`;
    const event: ProviderRuntimeEvent = {
      type: "runtime.warning",
      ...baseStamps,
      payload: { message },
    };

    const [activity] = runtimeEventToActivities(event);
    expect(activity?.summary.startsWith("Tool Bash was denied: xxx")).toBe(true);
    expect(activity?.summary).not.toContain("\n");
    expect(activity?.summary.length).toBe(120);
    expect((activity?.payload as Record<string, unknown> | undefined)?.message).toBe(
      `${message.slice(0, 177)}...`,
    );
  });

  it("falls back to generic titles for blank warning and error messages", () => {
    const warning: ProviderRuntimeEvent = {
      type: "runtime.warning",
      ...baseStamps,
      payload: { message: "  " },
    };
    const error: ProviderRuntimeEvent = {
      type: "runtime.error",
      ...baseStamps,
      payload: { message: "" },
    };
    expect(runtimeEventToActivities(warning)[0]?.summary).toBe("Runtime warning");
    expect(runtimeEventToActivities(error)[0]?.summary).toBe("Runtime error");
    expect(
      runtimeEventToActivities({ ...error, payload: { message: "Session crashed" } })[0]?.summary,
    ).toBe("Session crashed");
  });

  it("titles Claude task progress with the task description", () => {
    const event: ProviderRuntimeEvent = {
      type: "task.progress",
      ...baseStamps,
      payload: {
        taskId: RuntimeTaskId.makeUnsafe("task-1"),
        description: "Typecheck mobile app",
        summary: "Running tsc across the mobile workspace.",
      },
    };

    const [activity] = runtimeEventToActivities(event);
    const payload = activity?.payload as Record<string, unknown>;
    expect(activity?.summary).toBe("Typecheck mobile app");
    expect(payload.title).toBe("Typecheck mobile app");
    expect(payload.detail).toBe("Running tsc across the mobile workspace.");
  });

  it("gives every tick of a Claude task the same row id, scoped to the thread", () => {
    const tick = (eventId: string, thread: string, taskId: string): ProviderRuntimeEvent => ({
      type: "task.progress",
      ...baseStamps,
      eventId: EventId.makeUnsafe(eventId),
      threadId: ThreadId.makeUnsafe(thread),
      payload: { taskId: RuntimeTaskId.makeUnsafe(taskId), description: "Typecheck" },
    });

    const idOf = (event: ProviderRuntimeEvent) => runtimeEventToActivities(event)[0]?.id;
    expect(idOf(tick("evt-a", "thread-1", "task-1"))).toBe("task-progress:thread-1:task-1");
    expect(idOf(tick("evt-b", "thread-1", "task-1"))).toBe("task-progress:thread-1:task-1");
    expect(idOf(tick("evt-c", "thread-1", "task-2"))).toBe("task-progress:thread-1:task-2");
    expect(idOf(tick("evt-d", "thread-2", "task-1"))).toBe("task-progress:thread-2:task-1");
  });

  it("keeps per-event rows for Codex, whose task id is the turn", () => {
    const event: ProviderRuntimeEvent = {
      type: "task.progress",
      ...baseStamps,
      eventId: EventId.makeUnsafe("evt-codex-tick"),
      provider: "codex",
      payload: { taskId: RuntimeTaskId.makeUnsafe("turn-task"), description: "Thinking" },
    };

    expect(runtimeEventToActivities(event)[0]?.id).toBe("evt-codex-tick");
  });

  it("keeps 'Reasoning update' for Codex, whose description is the reasoning text", () => {
    const event: ProviderRuntimeEvent = {
      type: "task.progress",
      ...baseStamps,
      provider: "codex",
      payload: {
        taskId: RuntimeTaskId.makeUnsafe("task-2"),
        description: "Thinking about which files to read first",
      },
    };

    const [activity] = runtimeEventToActivities(event);
    expect(activity?.summary).toBe("Reasoning update");
    expect((activity?.payload as Record<string, unknown> | undefined)?.title).toBeUndefined();
  });
});

describe("runtimeEventToActivities — goals", () => {
  const goalEvent = (goal: object | null): ProviderRuntimeEvent =>
    ({
      type: "thread.goal.updated",
      ...baseStamps,
      payload: { goal },
    }) as ProviderRuntimeEvent;

  it("records the reported goal", () => {
    const goal = { objective: "Ship it", status: "active" };
    const [activity] = runtimeEventToActivities(goalEvent(goal));
    expect(activity?.kind).toBe("goal.updated");
    expect(activity?.summary).toBe("Goal updated");
    expect(activity?.payload).toEqual({ goal });
    expect(activity?.turnId).toBe("turn-1");
  });

  it("records a cleared goal", () => {
    const [activity] = runtimeEventToActivities(goalEvent(null));
    expect(activity?.summary).toBe("Goal cleared");
    expect(activity?.payload).toEqual({ goal: null });
  });
});

describe("runtimeEventToActivities — question response mode", () => {
  const requested = (payload: object): ProviderRuntimeEvent =>
    ({
      type: "user-input.requested",
      ...baseStamps,
      requestId: RuntimeRequestId.makeUnsafe("req-1"),
      payload: { questions: [], ...payload },
    }) as ProviderRuntimeEvent;

  it("keeps the mode of a non-blocking question", () => {
    const [activity] = runtimeEventToActivities(requested({ responseMode: "message" }));
    expect(activity?.payload).toEqual({
      requestId: "req-1",
      questions: [],
      responseMode: "message",
    });
  });

  it("adds no mode to an ordinary question", () => {
    const [activity] = runtimeEventToActivities(requested({}));
    expect(activity?.payload).toEqual({ requestId: "req-1", questions: [] });
  });
});
