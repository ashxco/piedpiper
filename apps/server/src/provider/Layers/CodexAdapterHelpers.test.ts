import {
  ApprovalRequestId,
  EventId,
  type ProviderEvent,
  type ProviderRuntimeEvent,
  ThreadId,
  TurnId,
} from "@piedpiper/contracts";
import { describe, expect, it } from "vitest";

import { buildCodexCapacityRetryWarning } from "../../codex/capacityRetry.ts";
import {
  codexExecServiceTierArgs,
  codexExecServiceTierArgsForOptions,
  makeCodexCompactionDeduper,
  makeCodexFileChangeTracker,
  makeCodexRetryStreakTracker,
  mapToRuntimeEvents,
  resolveCodexServiceTier,
  toUserInputQuestions,
} from "./CodexAdapterHelpers.ts";

const threadId = ThreadId.makeUnsafe("thread-1");

function makeEvent(overrides: Partial<ProviderEvent>): ProviderEvent {
  return {
    id: EventId.makeUnsafe("evt-1"),
    kind: "notification",
    provider: "codex",
    threadId,
    createdAt: "2026-02-10T00:00:00.000Z",
    method: "unknown",
    ...overrides,
  } as ProviderEvent;
}

describe("mapToRuntimeEvents approval requests", () => {
  it("opens a sandbox permission request with its kind and requested paths", () => {
    const [event] = mapToRuntimeEvents(
      makeEvent({
        kind: "request",
        method: "item/permissions/requestApproval",
        requestId: ApprovalRequestId.makeUnsafe("req-1"),
        requestKind: "file-change",
        turnId: TurnId.makeUnsafe("turn-1"),
        payload: {
          threadId: "provider-thread",
          turnId: "turn-1",
          itemId: "item-1",
          permissions: { fileSystem: { read: ["/a"], write: ["/b"] } },
        },
      }),
      threadId,
    );
    expect(event?.type).toBe("request.opened");
    if (event?.type !== "request.opened") return;
    expect(event.payload.requestType).toBe("file_change_approval");
    expect(event.payload.detail).toBe("Access: /a, /b");
  });

  it("reports the root thread's goal with its usage", () => {
    const [event] = mapToRuntimeEvents(
      makeEvent({
        method: "thread/goal/updated",
        payload: {
          threadId: "provider",
          goal: {
            objective: " Ship it ",
            status: "usageLimited",
            tokensUsed: 120,
            tokenBudget: 1000,
            timeUsedSeconds: 30,
          },
        },
      }),
      threadId,
    );
    expect(event).toMatchObject({
      type: "thread.goal.updated",
      payload: {
        goal: {
          objective: "Ship it",
          status: "usage_limited",
          tokensUsed: 120,
          tokenBudget: 1000,
          timeUsedSeconds: 30,
        },
      },
    });
  });

  it.each([
    ["active", "active"],
    ["paused", "paused"],
    ["blocked", "blocked"],
    ["usageLimited", "usage_limited"],
    ["budgetLimited", "budget_limited"],
    ["complete", "complete"],
  ])("maps the goal status %s to %s", (status, expected) => {
    const [event] = mapToRuntimeEvents(
      makeEvent({
        method: "thread/goal/updated",
        payload: { goal: { objective: "Ship it", status } },
      }),
      threadId,
    );
    expect(event).toMatchObject({
      type: "thread.goal.updated",
      payload: { goal: { status: expected } },
    });
  });

  it("reports a cleared goal as null", () => {
    const [event] = mapToRuntimeEvents(
      makeEvent({ method: "thread/goal/cleared", payload: { threadId: "provider" } }),
      threadId,
    );
    expect(event).toMatchObject({ type: "thread.goal.updated", payload: { goal: null } });
  });

  it.each([
    ["an empty objective", { objective: "  ", status: "active" }],
    ["an unknown status", { objective: "Ship it", status: "somethingNew" }],
  ])("does not read %s as a cleared goal", (_label, goal) => {
    expect(
      mapToRuntimeEvents(makeEvent({ method: "thread/goal/updated", payload: { goal } }), threadId),
    ).toEqual([]);
  });

  it("lists glob entries of a permission request in the detail", () => {
    const [event] = mapToRuntimeEvents(
      makeEvent({
        kind: "request",
        method: "item/permissions/requestApproval",
        requestId: ApprovalRequestId.makeUnsafe("req-1"),
        requestKind: "file-change",
        payload: {
          permissions: {
            fileSystem: {
              entries: [{ access: "write", path: { type: "glob_pattern", pattern: "/w/out/**" } }],
            },
          },
        },
      }),
      threadId,
    );
    if (event?.type !== "request.opened") throw new Error("expected request.opened");
    expect(event.payload.detail).toBe("Access: /w/out/**");
  });

  it("prefers the permission reason as detail", () => {
    const [event] = mapToRuntimeEvents(
      makeEvent({
        kind: "request",
        method: "item/permissions/requestApproval",
        requestId: ApprovalRequestId.makeUnsafe("req-1"),
        requestKind: "command",
        payload: { reason: "Needs network access", permissions: { network: { enabled: true } } },
      }),
      threadId,
    );
    if (event?.type !== "request.opened") throw new Error("expected request.opened");
    expect(event.payload.requestType).toBe("command_execution_approval");
    expect(event.payload.detail).toBe("Needs network access");
  });

  it("opens an MCP elicitation with its message as detail", () => {
    const [event] = mapToRuntimeEvents(
      makeEvent({
        kind: "request",
        method: "mcpServer/elicitation/request",
        requestId: ApprovalRequestId.makeUnsafe("req-1"),
        requestKind: "command",
        payload: { serverName: "gmail", mode: "form", message: "Allow ChatGPT to use Gmail?" },
      }),
      threadId,
    );
    if (event?.type !== "request.opened") throw new Error("expected request.opened");
    expect(event.payload.detail).toBe("Allow ChatGPT to use Gmail?");
  });

  it("resolves a Codex-settled approval using the request kind", () => {
    const [event] = mapToRuntimeEvents(
      makeEvent({
        method: "serverRequest/resolved",
        requestId: ApprovalRequestId.makeUnsafe("req-1"),
        requestKind: "file-read",
        payload: { threadId: "provider-thread", requestId: 7 },
      }),
      threadId,
    );
    if (event?.type !== "request.resolved") throw new Error("expected request.resolved");
    expect(event.requestId).toBe("req-1");
    expect(event.payload.requestType).toBe("file_read_approval");
  });

  it("resolves a Codex-settled user-input request", () => {
    const [event] = mapToRuntimeEvents(
      makeEvent({
        method: "item/tool/requestUserInput/resolved",
        requestId: ApprovalRequestId.makeUnsafe("req-2"),
        payload: { threadId: "provider-thread", requestId: 8 },
      }),
      threadId,
    );
    if (event?.type !== "user-input.resolved") throw new Error("expected user-input.resolved");
    expect(event.requestId).toBe("req-2");
    expect(event.payload.answers).toEqual({});
  });
});

describe("file-change approval paths", () => {
  const started = (itemId: string, changes: unknown[]) =>
    makeEvent({
      method: "item/started",
      itemId: itemId as never,
      payload: { item: { type: "fileChange", id: itemId, status: "inProgress", changes } },
    });
  const approval = (itemId: string, payload: Record<string, unknown> = {}) =>
    makeEvent({
      kind: "request",
      method: "item/fileChange/requestApproval",
      requestId: ApprovalRequestId.makeUnsafe("req-1"),
      requestKind: "file-change",
      itemId: itemId as never,
      payload: { itemId, ...payload },
    });
  const openedDetail = (
    tracker: ReturnType<typeof makeCodexFileChangeTracker>,
    event: ProviderEvent,
  ) => {
    const [opened] = mapToRuntimeEvents(event, threadId, tracker.observe(event));
    if (opened?.type !== "request.opened") throw new Error("expected request.opened");
    return opened.payload.detail;
  };

  it("lists the files of the started fileChange item, sorted with moves", () => {
    const tracker = makeCodexFileChangeTracker();
    tracker.observe(
      started("patch-1", [
        { path: "/w/b.ts", kind: { type: "update", move_path: "/w/c.ts" }, diff: "@@ secret" },
        { path: "/w/a.ts", kind: { type: "add" }, diff: "+x" },
      ]),
    );
    expect(openedDetail(tracker, approval("patch-1", { grantRoot: "/w" }))).toBe(
      "add /w/a.ts\nupdate /w/b.ts -> /w/c.ts",
    );
  });

  it("prefers Codex's reason and forgets items once completed or the turn ends", () => {
    const tracker = makeCodexFileChangeTracker();
    tracker.observe(started("patch-1", [{ path: "/w/a.ts", kind: { type: "add" } }]));
    expect(openedDetail(tracker, approval("patch-1", { reason: "Write the file" }))).toBe(
      "Write the file",
    );
    tracker.observe(makeEvent({ method: "item/completed", payload: { item: { id: "patch-1" } } }));
    expect(openedDetail(tracker, approval("patch-1", { grantRoot: "/w" }))).toBe("/w");

    tracker.observe(started("patch-2", [{ path: "/w/d.ts", kind: { type: "delete" } }]));
    tracker.observe(makeEvent({ method: "turn/completed", payload: { turn: { id: "t" } } }));
    expect(openedDetail(tracker, approval("patch-2"))).toBeUndefined();
  });

  it("caps the listed files at 20", () => {
    const tracker = makeCodexFileChangeTracker();
    tracker.observe(
      started(
        "patch-1",
        Array.from({ length: 23 }, (_, index) => ({
          path: `/w/${String(index).padStart(2, "0")}.ts`,
          kind: { type: "add" },
        })),
      ),
    );
    const lines = openedDetail(tracker, approval("patch-1"))?.split("\n") ?? [];
    expect(lines).toHaveLength(21);
    expect(lines.at(-1)).toBe("+3 more");
  });
});

describe("mapToRuntimeEvents approval and item detail", () => {
  const openRequest = (method: string, payload: Record<string, unknown>) => {
    const [event] = mapToRuntimeEvents(
      makeEvent({
        kind: "request",
        method,
        requestId: ApprovalRequestId.makeUnsafe("req-3"),
        requestKind: "file-change",
        payload,
      }),
      threadId,
    );
    if (event?.type !== "request.opened") throw new Error("expected request.opened");
    return event.payload.detail;
  };

  it("lists sorted apply-patch paths, including moves, when the reason is blank", () => {
    expect(
      openRequest("applyPatchApproval", {
        reason: "   ",
        grantRoot: "/repo",
        fileChanges: {
          "src/b.ts": { type: "update", unified_diff: "", move_path: "src/c.ts" },
          "src/a.ts": { type: "add", content: "x" },
          "src/z.ts": { type: "delete", content: "" },
        },
      }),
    ).toBe("add src/a.ts\nupdate src/b.ts -> src/c.ts\ndelete src/z.ts");
  });

  it("caps described apply-patch paths and says how many more there are", () => {
    const fileChanges = Object.fromEntries(
      Array.from({ length: 23 }, (_, index) => [
        `f${String(index).padStart(2, "0")}.ts`,
        { type: "add", content: "" },
      ]),
    );
    const detail = openRequest("applyPatchApproval", { fileChanges });
    const lines = detail?.split("\n") ?? [];
    expect(lines).toHaveLength(21);
    expect(lines[0]).toBe("add f00.ts");
    expect(lines[20]).toBe("+3 more");
  });

  it("prefers a non-blank reason and falls back to the grant root", () => {
    expect(
      openRequest("applyPatchApproval", {
        reason: "Fix the bug",
        fileChanges: { "a.ts": { type: "add" } },
      }),
    ).toBe("Fix the bug");
    expect(openRequest("applyPatchApproval", { reason: "", grantRoot: "/repo" })).toBe("/repo");
    expect(openRequest("item/fileChange/requestApproval", { reason: "", grantRoot: "/repo" })).toBe(
      "/repo",
    );
  });

  it("joins a legacy argv command for exec approvals", () => {
    expect(openRequest("execCommandApproval", { command: ["git", "status"], reason: "" })).toBe(
      "git status",
    );
  });

  it("uses the web search query or url as item detail", () => {
    const itemDetailFor = (item: Record<string, unknown>) => {
      const [event] = mapToRuntimeEvents(
        makeEvent({ method: "item/completed", payload: { item } }),
        threadId,
      );
      if (event?.type !== "item.completed") throw new Error("expected item.completed");
      return event.payload.detail;
    };
    expect(itemDetailFor({ type: "webSearch", id: "ws-1", query: "effect ts layers" })).toBe(
      "effect ts layers",
    );
    expect(
      itemDetailFor({
        type: "webSearch",
        id: "ws-2",
        query: "",
        action: { type: "openPage", url: "https://effect.website" },
      }),
    ).toBe("https://effect.website");
  });
});

describe("mapToRuntimeEvents item completion status", () => {
  const completedStatus = (item: Record<string, unknown>) => {
    const [event] = mapToRuntimeEvents(
      makeEvent({
        method: "item/completed",
        turnId: TurnId.makeUnsafe("turn-1"),
        payload: { threadId: "thread-1", turnId: "turn-1", item },
      }),
      threadId,
    );
    if (event?.type !== "item.completed") throw new Error("expected item.completed");
    return event.payload.status;
  };

  it("keeps failed and declined tool outcomes", () => {
    expect(
      completedStatus({
        type: "commandExecution",
        id: "cmd-1",
        command: "bun test",
        exitCode: 1,
        status: "failed",
      }),
    ).toBe("failed");
    expect(
      completedStatus({
        type: "mcpToolCall",
        id: "mcp-1",
        server: "simulator",
        tool: "build",
        status: "failed",
      }),
    ).toBe("failed");
    expect(
      completedStatus({ type: "fileChange", id: "fc-1", changes: [], status: "declined" }),
    ).toBe("declined");
  });

  it("reports completed for successful or status-less items", () => {
    expect(
      completedStatus({
        type: "commandExecution",
        id: "cmd-2",
        command: "ls",
        status: "completed",
      }),
    ).toBe("completed");
    expect(completedStatus({ type: "commandExecution", id: "cmd-3", command: "ls" })).toBe(
      "completed",
    );
  });
});

describe("mapToRuntimeEvents hook/completed", () => {
  const mapHook = (run: Record<string, unknown>) =>
    mapToRuntimeEvents(
      makeEvent({
        method: "hook/completed",
        turnId: TurnId.makeUnsafe("turn-1"),
        payload: { threadId: "thread-1", turnId: "turn-1", run },
      }),
      threadId,
    );

  it("warns with the reason a hook gave for stopping the turn", () => {
    const [event] = mapHook({
      status: "stopped",
      eventName: "stop",
      source: "user",
      entries: [
        { kind: "warning", text: "ignored" },
        { kind: "stop", text: "  Tests are failing.  " },
        { kind: "stop", text: "Fix lint first." },
      ],
    });
    if (event?.type !== "runtime.warning") throw new Error("expected runtime.warning");
    expect(event.payload.message).toBe("Stop hook (user): Tests are failing.\nFix lint first.");
  });

  it("capitalises Codex's camelCase hook event names", () => {
    const [event] = mapHook({
      status: "stopped",
      eventName: "subagentStop",
      entries: [{ kind: "stop", text: "Done." }],
    });
    if (event?.type !== "runtime.warning") throw new Error("expected runtime.warning");
    expect(event.payload.message).toBe("SubagentStop hook: Done.");
  });

  it("ignores completed hooks and stops without a reason", () => {
    expect(
      mapHook({ status: "completed", eventName: "stop", entries: [{ kind: "stop", text: "x" }] }),
    ).toEqual([]);
    expect(
      mapHook({
        status: "stopped",
        eventName: "preToolUse",
        entries: [{ kind: "stop", text: " " }],
      }),
    ).toEqual([]);
  });
});

describe("context compaction events", () => {
  const compactionItem = (status?: string, turnId = "turn-1") =>
    makeEvent({
      id: EventId.makeUnsafe(`evt-item-${turnId}`),
      method: "item/completed",
      turnId: TurnId.makeUnsafe(turnId),
      payload: { item: { type: "contextCompaction", id: "cmp-1", ...(status ? { status } : {}) } },
    });
  const compactedNotification = (turnId = "turn-1") =>
    makeEvent({
      id: EventId.makeUnsafe(`evt-notification-${turnId}`),
      method: "thread/compacted",
      turnId: TurnId.makeUnsafe(turnId),
      payload: { threadId: "provider-thread", turnId },
    });
  const countCompacted = (
    deduper: ReturnType<typeof makeCodexCompactionDeduper>,
    event: ProviderEvent,
  ) =>
    deduper
      .apply(event, mapToRuntimeEvents(event, threadId))
      .filter(
        (runtimeEvent) =>
          runtimeEvent.type === "thread.state.changed" &&
          runtimeEvent.payload.state === "compacted",
      ).length;

  it("reports the compacted state from the completed item with its own event id", () => {
    const events = mapToRuntimeEvents(compactionItem(), threadId);
    expect(events.map((event) => event.type)).toEqual(["item.completed", "thread.state.changed"]);
    expect(events[1]?.eventId).toBe("evt-item-turn-1:thread-compacted");
    expect(events[1]?.turnId).toBe("turn-1");
  });

  it("does not report a failed compaction item as compacted", () => {
    const events = mapToRuntimeEvents(compactionItem("failed"), threadId);
    expect(events.map((event) => event.type)).toEqual(["item.completed"]);
  });

  it("yields one compacted event for an item and notification in either order", () => {
    const itemFirst = makeCodexCompactionDeduper();
    expect(countCompacted(itemFirst, compactionItem())).toBe(1);
    expect(countCompacted(itemFirst, compactedNotification())).toBe(0);

    const notificationFirst = makeCodexCompactionDeduper();
    expect(countCompacted(notificationFirst, compactedNotification())).toBe(1);
    expect(countCompacted(notificationFirst, compactionItem())).toBe(0);
  });

  it("keeps the item.completed event when only its compacted event is a duplicate", () => {
    const deduper = makeCodexCompactionDeduper();
    deduper.apply(compactedNotification(), mapToRuntimeEvents(compactedNotification(), threadId));
    const item = compactionItem();
    const types = deduper.apply(item, mapToRuntimeEvents(item, threadId)).map((e) => e.type);
    expect(types).toEqual(["item.completed"]);
  });

  it("counts repeated compactions and sources that report alone", () => {
    const paired = makeCodexCompactionDeduper();
    for (let round = 0; round < 2; round++) {
      expect(countCompacted(paired, compactionItem())).toBe(1);
      expect(countCompacted(paired, compactedNotification())).toBe(0);
    }

    const notificationOnly = makeCodexCompactionDeduper();
    expect(countCompacted(notificationOnly, compactedNotification())).toBe(1);
    expect(countCompacted(notificationOnly, compactedNotification())).toBe(1);

    const acrossTurns = makeCodexCompactionDeduper();
    expect(countCompacted(acrossTurns, compactionItem(undefined, "turn-1"))).toBe(1);
    expect(countCompacted(acrossTurns, compactionItem(undefined, "turn-2"))).toBe(1);
  });
});

describe("codexExecServiceTierArgs", () => {
  it("overrides a config-level fast tier only when Fast is explicitly off", () => {
    expect(codexExecServiceTierArgs(true, undefined)).toEqual(["--config", `service_tier="fast"`]);
    expect(codexExecServiceTierArgs(false, true)).toEqual(["--config", `service_tier="default"`]);
    expect(codexExecServiceTierArgs(false, undefined)).toEqual([]);
    expect(codexExecServiceTierArgs(undefined, true)).toEqual([]);
  });
});

describe("Codex reasoning summaries", () => {
  const providerTurnId = TurnId.makeUnsafe("turn-1");
  const reasoningCompleted = (item: Record<string, unknown>) =>
    mapToRuntimeEvents(
      makeEvent({
        method: "item/completed",
        turnId: providerTurnId,
        payload: { turnId: providerTurnId, item: { type: "reasoning", id: "rs_1", ...item } },
      }),
      threadId,
    );

  it("keeps the part index on summary deltas so parts can be separated", () => {
    const [delta] = mapToRuntimeEvents(
      makeEvent({
        method: "item/reasoning/summaryTextDelta",
        turnId: providerTurnId,
        payload: { itemId: "rs_1", delta: "Second part", summaryIndex: 1 },
      }),
      threadId,
    );
    expect(delta).toMatchObject({
      type: "content.delta",
      payload: { streamKind: "reasoning_summary_text", delta: "Second part", summaryIndex: 1 },
    });
  });

  it("joins a completed item's summary parts, as recorded from Codex 0.166", () => {
    const [completed] = reasoningCompleted({
      summary: ["First part", "Second part"],
      content: [],
    });
    expect(completed).toMatchObject({
      type: "item.completed",
      payload: { itemType: "reasoning", detail: "First part\n\nSecond part" },
    });
  });

  it("reads the summary_text objects older CLIs send", () => {
    const [completed] = reasoningCompleted({
      summary: [
        { type: "summary_text", text: "Only part" },
        { type: "summary_text", text: " " },
      ],
    });
    expect(completed).toMatchObject({ payload: { detail: "Only part" } });
  });

  it("gives an empty summary no detail and never shows raw content as the summary", () => {
    const [completed] = reasoningCompleted({ summary: [], content: ["raw thoughts"] });
    expect(completed?.type).toBe("item.completed");
    expect(completed?.payload).not.toHaveProperty("detail");
  });
});

describe("resolveCodexServiceTier", () => {
  it("prefers an explicit tier over the older fastMode", () => {
    expect(resolveCodexServiceTier({ serviceTier: "ultrafast", fastMode: false })).toBe(
      "ultrafast",
    );
    expect(resolveCodexServiceTier({ serviceTier: null, fastMode: true })).toBeNull();
    expect(resolveCodexServiceTier({ serviceTier: "default" })).toBeNull();
    expect(resolveCodexServiceTier({ serviceTier: "priority" })).toBe("fast");
  });

  it("decodes older selections from fastMode", () => {
    expect(resolveCodexServiceTier({ fastMode: true })).toBe("fast");
    expect(resolveCodexServiceTier({ fastMode: false })).toBeNull();
    expect(resolveCodexServiceTier({})).toBeUndefined();
    expect(resolveCodexServiceTier(undefined)).toBeUndefined();
  });
});

describe("codexExecServiceTierArgsForOptions", () => {
  const options = [
    { value: "default", label: "Standard" },
    { value: "ultrafast", label: "Ultrafast", isDefault: true },
  ];

  it("passes a selected tier", () => {
    expect(codexExecServiceTierArgsForOptions({ serviceTier: "ultrafast" }, undefined)).toEqual([
      "--config",
      `service_tier="ultrafast"`,
    ]);
    expect(codexExecServiceTierArgsForOptions({ fastMode: true }, undefined)).toEqual([
      "--config",
      `service_tier="fast"`,
    ]);
  });

  it("overrides for Standard only when another tier is the default", () => {
    const standard = ["--config", `service_tier="default"`];
    expect(
      codexExecServiceTierArgsForOptions({ serviceTier: null }, { serviceTierOptions: options }),
    ).toEqual(standard);
    expect(
      codexExecServiceTierArgsForOptions({ fastMode: false }, { fastModeDefault: true }),
    ).toEqual(standard);
    expect(codexExecServiceTierArgsForOptions({ serviceTier: null }, undefined)).toEqual([]);
    expect(codexExecServiceTierArgsForOptions(undefined, { fastModeDefault: true })).toEqual([]);
  });

  it("drops a saved tier the model no longer offers", () => {
    const listed = { serviceTierOptions: options };
    expect(codexExecServiceTierArgsForOptions({ serviceTier: "fast" }, listed)).toEqual([]);
    expect(codexExecServiceTierArgsForOptions({ serviceTier: "ultrafast" }, listed)).toEqual([
      "--config",
      `service_tier="ultrafast"`,
    ]);
    // Without a tier list there is nothing to check it against.
    expect(codexExecServiceTierArgsForOptions({ serviceTier: "ultrafast" }, {})).toEqual([
      "--config",
      `service_tier="ultrafast"`,
    ]);
  });

  it("drops a tier that would break out of the TOML string", () => {
    expect(codexExecServiceTierArgsForOptions({ serviceTier: `x" y="z` }, undefined)).toEqual([]);
  });
});

describe("mapToRuntimeEvents async questions", () => {
  const asyncQuestion = (item: Record<string, unknown>) =>
    mapToRuntimeEvents(
      makeEvent({
        method: "item/completed",
        turnId: TurnId.makeUnsafe("turn-1"),
        payload: {
          threadId: "provider-1",
          turnId: "turn-1",
          item: { type: "agentMessage", id: "question-1", text: "Which?", ...item },
        },
      }),
      threadId,
    );

  it("maps an async agent message to a message-mode request with stable ids", () => {
    const [event, ...rest] = asyncQuestion({
      delivery: "async",
      questions: [
        { title: " Which package manager? ", options: ["pnpm", "npm", "pnpm", " "] },
        { title: "What should it be named?", options: null },
        { title: " ", options: ["ignored"] },
      ],
    });

    expect(rest).toEqual([]);
    expect(event).toMatchObject({
      type: "user-input.requested",
      eventId: "codex-async:thread-1:question-1",
      requestId: "codex-async:thread-1:question-1",
      turnId: "turn-1",
      payload: {
        responseMode: "message",
        questions: [
          {
            id: "0",
            header: "Question",
            question: "Which package manager?",
            options: [
              { label: "pnpm", description: "pnpm" },
              { label: "npm", description: "npm" },
            ],
          },
          { id: "1", header: "Question", question: "What should it be named?", options: [] },
        ],
      },
    });
  });

  it("keeps ordinary and question-less messages as assistant text", () => {
    expect(asyncQuestion({ delivery: null, questions: null })[0]?.type).toBe("item.completed");
    expect(asyncQuestion({ delivery: "async", questions: [] })[0]?.type).toBe("item.completed");
  });

  it("does not map a blocking tool request as message mode", () => {
    const [event] = mapToRuntimeEvents(
      makeEvent({
        kind: "request",
        method: "item/tool/requestUserInput",
        requestId: ApprovalRequestId.makeUnsafe("request-1"),
        payload: {
          questions: [
            {
              id: "q",
              header: "H",
              question: "Q?",
              options: [{ label: "A", description: "a" }],
            },
          ],
        },
      }),
      threadId,
    );

    expect(event?.type).toBe("user-input.requested");
    expect(event?.payload).not.toHaveProperty("responseMode");
  });
});

describe("mapToRuntimeEvents stopped commands", () => {
  it("keeps a stopped status on a completed command", () => {
    const [event] = mapToRuntimeEvents(
      makeEvent({
        method: "item/completed",
        payload: { item: { type: "commandExecution", id: "command-1", status: "stopped" } },
      }),
      threadId,
    );

    expect(event).toMatchObject({ type: "item.completed", payload: { status: "stopped" } });
  });
});

describe("mapToRuntimeEvents generated images", () => {
  const image = (item: Record<string, unknown>) =>
    mapToRuntimeEvents(
      makeEvent({
        method: "item/completed",
        turnId: TurnId.makeUnsafe("turn-1"),
        payload: { item: { type: "imageGeneration", id: "image-1", ...item } },
      }),
      threadId,
    )[0];

  it("titles the work row and shows the prompt Codex used", () => {
    expect(
      image({ status: "completed", savedPath: "/tmp/a.png", revisedPrompt: "A red fox" }),
    ).toMatchObject({
      type: "item.completed",
      payload: {
        itemType: "image_view",
        status: "completed",
        title: "Generated image",
        detail: "A red fox",
      },
    });
  });

  it("marks a completed item carrying a failure as failed", () => {
    expect(image({ status: "completed", failure: { type: "usageLimitExceeded" } })).toMatchObject({
      payload: { status: "failed", title: "Image generation failed" },
    });
  });

  it("only titles a successful completion as generated", () => {
    const [started] = mapToRuntimeEvents(
      makeEvent({
        method: "item/started",
        payload: { item: { type: "imageGeneration", id: "image-1", status: "inProgress" } },
      }),
      threadId,
    );
    expect(started).toMatchObject({
      type: "item.started",
      payload: { status: "inProgress", title: "Generating image" },
    });
    expect(image({ status: "failed" })).toMatchObject({
      payload: { status: "failed", title: "Image generation failed" },
    });
    expect(image({ status: "stopped" })).toMatchObject({
      payload: { status: "stopped", title: "Image generation stopped" },
    });
  });

  it("leaves image views as they were", () => {
    const [event] = mapToRuntimeEvents(
      makeEvent({
        method: "item/completed",
        payload: { item: { type: "imageView", id: "view-1", path: "/tmp/a.png" } },
      }),
      threadId,
    );
    expect(event).toMatchObject({ payload: { itemType: "image_view", title: "Image view" } });
  });
});

describe("toUserInputQuestions", () => {
  it("keeps a question with null, empty or missing options for a free-text answer", () => {
    for (const options of [null, [], undefined]) {
      expect(
        toUserInputQuestions({
          questions: [{ id: "q", header: "H", question: "What now?", options }],
        }),
      ).toEqual([{ id: "q", header: "H", question: "What now?", options: [] }]);
    }
  });

  it("fills blank fields instead of dropping the question", () => {
    expect(
      toUserInputQuestions({
        questions: [
          { header: "  ", question: "", options: [{ label: "", description: "Only this" }] },
          { id: "b", header: "Pick", options: [{ label: "Yes" }, { description: " " }, null] },
          {},
        ],
      }),
    ).toEqual([
      {
        id: "question-1",
        header: "Question",
        question: "Codex is asking for input.",
        options: [{ label: "Only this", description: "Only this" }],
      },
      {
        id: "b",
        header: "Pick",
        question: "Pick",
        options: [
          { label: "Yes", description: "Yes" },
          { label: "Option 2", description: "Option 2" },
        ],
      },
      { id: "question-3", header: "Question", question: "Codex is asking for input.", options: [] },
    ]);
  });

  it("accepts plain string options", () => {
    expect(
      toUserInputQuestions({
        questions: [{ id: "q", header: "H", question: "Q", options: ["A"] }],
      }),
    ).toEqual([
      {
        id: "q",
        header: "H",
        question: "Q",
        options: [{ label: "A", description: "A" }],
      },
    ]);
  });

  it("returns undefined when there is nothing to ask", () => {
    expect(toUserInputQuestions({ questions: "not an array" })).toBeUndefined();
    expect(toUserInputQuestions({ questions: [] })).toBeUndefined();
    expect(toUserInputQuestions({ questions: [null] })).toBeUndefined();
    expect(toUserInputQuestions(undefined)).toBeUndefined();
  });
});

const detailOf = (events: ReadonlyArray<ProviderRuntimeEvent>) => {
  const warning = events[0];
  if (warning?.type !== "runtime.warning") throw new Error("expected a warning");
  return warning.payload.detail as Record<string, unknown>;
};

describe("a compaction the manager closed as failed", () => {
  it("becomes a failed item with the reason and no compacted state", () => {
    const events = mapToRuntimeEvents(
      makeEvent({
        method: "item/completed",
        turnId: TurnId.makeUnsafe("turn-1"),
        payload: {
          turnId: "turn-1",
          item: { type: "contextCompaction", id: "item-1", status: "failed" },
          message: "boom",
        },
      }),
      threadId,
    );
    expect(events.map((event) => event.type)).toEqual(["item.completed"]);
    expect(events[0]?.payload).toMatchObject({
      itemType: "context_compaction",
      status: "failed",
      detail: "boom",
    });
  });
});

describe("makeCodexRetryStreakTracker", () => {
  const run = (tracker: ReturnType<typeof makeCodexRetryStreakTracker>, event: ProviderEvent) =>
    tracker.apply(event, mapToRuntimeEvents(event, threadId));
  const retry = (id: string, message: string) =>
    makeEvent({
      id: EventId.makeUnsafe(id),
      method: "error",
      turnId: TurnId.makeUnsafe("turn-1"),
      payload: { willRetry: true, error: { message } },
    });

  const toolStarted = makeEvent({
    method: "item/started",
    turnId: TurnId.makeUnsafe("turn-1"),
    payload: { item: { type: "commandExecution", id: "cmd-1", command: "ls" } },
  });

  it("gives every attempt of one streak the same retry id", () => {
    const tracker = makeCodexRetryStreakTracker();
    const details = [
      retry("a", "Reconnecting... 1/5"),
      retry("b", "Reconnecting... 2/5"),
      retry("c", "Reconnecting... 3/5"),
    ].map((event) => detailOf(run(tracker, event)));

    expect(new Set(details.map((detail) => detail.retryId)).size).toBe(1);
    expect(details[2]).toMatchObject({
      kind: "provider_retry",
      state: "retrying",
      willRetry: true,
      error: { message: "Reconnecting... 3/5" },
    });
  });

  it("starts a new streak once Codex made progress", () => {
    const tracker = makeCodexRetryStreakTracker();
    const first = detailOf(run(tracker, retry("a", "Reconnecting... 1/5"))).retryId;
    run(tracker, toolStarted);
    const second = detailOf(run(tracker, retry("b", "Reconnecting... 1/5"))).retryId;
    expect(second).not.toBe(first);
  });

  it("does not end a streak on events that show no progress", () => {
    const tracker = makeCodexRetryStreakTracker();
    const first = detailOf(run(tracker, retry("a", "Reconnecting... 1/5"))).retryId;
    run(tracker, makeEvent({ method: "account/rateLimits/updated", payload: { rateLimits: {} } }));
    expect(detailOf(run(tracker, retry("b", "Reconnecting... 2/5"))).retryId).toBe(first);
  });

  it("keeps threads apart", () => {
    const tracker = makeCodexRetryStreakTracker();
    const first = detailOf(run(tracker, retry("a", "Reconnecting... 1/5"))).retryId;
    const other = {
      ...retry("b", "Reconnecting... 1/5"),
      threadId: ThreadId.makeUnsafe("thread-2"),
    };
    expect(detailOf(run(tracker, other)).retryId).not.toBe(first);
  });

  it("leaves errors and other warnings without a retry id", () => {
    const tracker = makeCodexRetryStreakTracker();
    const first = detailOf(run(tracker, retry("a", "Reconnecting... 1/5"))).retryId;
    const failure = run(
      tracker,
      makeEvent({ method: "error", payload: { error: { message: "Gave up" } } }),
    ).find((event) => event.type === "runtime.error");
    expect(failure?.type).toBe("runtime.error");
    expect(failure?.type === "runtime.error" && failure.payload.detail).not.toHaveProperty(
      "retryId",
    );
    expect(detailOf(run(tracker, retry("b", "Reconnecting... 1/5"))).retryId).not.toBe(first);
  });

  describe("settling the row", () => {
    const settle = (event: ProviderEvent, attempts = 2) => {
      const tracker = makeCodexRetryStreakTracker();
      const retries = Array.from({ length: attempts }, (_, index) =>
        run(tracker, retry(`attempt-${index}`, "Reconnecting...")),
      );
      const retryId = detailOf(retries[0]!).retryId;
      const events = run(tracker, event);
      const [settled, ...rest] = events;
      if (settled?.type !== "runtime.warning") throw new Error("expected a warning");
      return { retryId, settled, rest, tracker };
    };
    const turnEnd = (status: string, error: unknown = null) =>
      makeEvent({
        id: EventId.makeUnsafe("end"),
        method: "turn/completed",
        turnId: TurnId.makeUnsafe("turn-1"),
        payload: { turn: { id: "turn-1", status, error } },
      });

    it("reports recovery on the same row, ahead of the event that showed it", () => {
      const { retryId, settled, rest } = settle(toolStarted);
      expect(settled.payload.message).toBe("Recovered after 2 retries");
      expect(settled.payload.detail).toMatchObject({
        kind: "provider_retry",
        retryId,
        state: "recovered",
        willRetry: false,
      });
      expect(settled.turnId).toBe("turn-1");
      expect(rest.map((event) => event.type)).toEqual(["item.started"]);
    });

    it("reports a stop and a turn that ended without recovering", () => {
      expect(settle(turnEnd("interrupted")).settled.payload).toMatchObject({
        message: "Stopped while retrying",
        detail: { state: "stopped" },
      });
      expect(settle(turnEnd("failed")).settled.payload).toMatchObject({
        message: "Gave up after 2 retries",
        detail: { state: "failed" },
      });
      expect(settle(turnEnd("completed"), 1).settled.payload.message).toBe(
        "Recovered after 1 retry",
      );
    });

    it("says the model stayed at capacity when that is why the retries ran out", () => {
      const tracker = makeCodexRetryStreakTracker();
      run(
        tracker,
        makeEvent({
          id: EventId.makeUnsafe("attempt"),
          method: "error",
          turnId: TurnId.makeUnsafe("turn-1"),
          payload: buildCodexCapacityRetryWarning({ turnId: "turn-1", attempt: 1, delayMs: 2_000 }),
        }),
      );
      const [settled] = run(
        tracker,
        makeEvent({ method: "error", payload: { error: { message: "at capacity" } } }),
      );
      expect(settled?.type === "runtime.warning" && settled.payload.message).toBe(
        "Still at capacity after 1 retry",
      );
    });

    it("settles only once, and not on a stderr line between attempts", () => {
      const tracker = makeCodexRetryStreakTracker();
      const first = detailOf(run(tracker, retry("a", "Reconnecting... 1/5"))).retryId;
      const stderr = makeEvent({
        method: "process/stderr",
        message: "ERROR codex_api: failed to connect to websocket",
      });
      expect(run(tracker, stderr).map((event) => event.type)).toEqual(["runtime.error"]);
      expect(detailOf(run(tracker, retry("b", "Reconnecting... 2/5"))).retryId).toBe(first);

      expect(run(tracker, toolStarted).map((event) => event.type)).toEqual([
        "runtime.warning",
        "item.started",
      ]);
      expect(run(tracker, toolStarted).map((event) => event.type)).toEqual(["item.started"]);
    });
  });
});
