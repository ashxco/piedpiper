import { describe, expect, it } from "vitest";
import { EventId, MessageId, type OrchestrationThreadActivity, TurnId } from "@piedpiper/contracts";
import { CHANGED_FILES_MORE_BUTTON_HEIGHT_PX } from "../../lib/checkpointFileTotals";
import { type TurnDiffSummary } from "../../types";
import { type TimelineEntry, type WorkLogEntry } from "../../session-logic";
import {
  HIDDEN_WORK_ROW_ID,
  buildToolCallExpandedBody,
  formatExpandedToolFilePath,
  isWorkEntryInRunningTurn,
  isWorkEntryLive,
  resolveStreamingWorkGroupThought,
  computeMessageDurationStart,
  deriveMessagesTimelineRows,
  deriveModelSwitchByMessageId,
  deriveModelSwitchLabelByMessageId,
  estimateMessagesTimelineRowHeight,
  findFirstConversationMessageRowIndex,
  formatModelSwitchLabel,
  formatToolInputJson,
  hiddenWorkLogEntriesIndicateFailure,
  isWorkEntryHiddenByToolCallVisibility,
  resolveMessageRowTurnDiffSummary,
  workLogEntriesEndInToolFailure,
  isPreviewEligibleWorkEntry,
  isWorkGroupScrolledToEnd,
  normalizeCompactToolLabel,
  resolveLiveWorkGroupEntry,
  resolvePinnedWorkGroupEntries,
  shouldFollowWorkGroupAppend,
  shouldPreserveAssistantLineBreaks,
  shouldRenderUserMessageAsMarkdown,
  shouldSummarizeWorkGroup,
  summarizeToolGroup,
  withVisibleControlCharacters,
  workEntryPreviewDuplicatesHeading,
  workGroupConsumesUpwardScroll,
  type MessagesTimelineRow,
} from "./MessagesTimeline.logic";

describe("computeMessageDurationStart", () => {
  it("returns message createdAt when there is no preceding user message", () => {
    const result = computeMessageDurationStart([
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:05Z",
        completedAt: "2026-01-01T00:00:10Z",
      },
    ]);
    expect(result).toEqual(new Map([["a1", "2026-01-01T00:00:05Z"]]));
  });

  it("uses the user message createdAt for the first assistant response", () => {
    const result = computeMessageDurationStart([
      { id: "u1", role: "user", createdAt: "2026-01-01T00:00:00Z" },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        completedAt: "2026-01-01T00:00:30Z",
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
      ]),
    );
  });

  it("uses the previous assistant completedAt for subsequent assistant responses", () => {
    const result = computeMessageDurationStart([
      { id: "u1", role: "user", createdAt: "2026-01-01T00:00:00Z" },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        completedAt: "2026-01-01T00:00:30Z",
      },
      {
        id: "a2",
        role: "assistant",
        createdAt: "2026-01-01T00:00:55Z",
        completedAt: "2026-01-01T00:00:55Z",
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
        ["a2", "2026-01-01T00:00:30Z"],
      ]),
    );
  });

  it("does not advance the boundary for a streaming message without completedAt", () => {
    const result = computeMessageDurationStart([
      { id: "u1", role: "user", createdAt: "2026-01-01T00:00:00Z" },
      { id: "a1", role: "assistant", createdAt: "2026-01-01T00:00:30Z" },
      {
        id: "a2",
        role: "assistant",
        createdAt: "2026-01-01T00:00:55Z",
        completedAt: "2026-01-01T00:00:55Z",
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
        ["a2", "2026-01-01T00:00:00Z"],
      ]),
    );
  });

  it("resets the boundary on a new user message", () => {
    const result = computeMessageDurationStart([
      { id: "u1", role: "user", createdAt: "2026-01-01T00:00:00Z" },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        completedAt: "2026-01-01T00:00:30Z",
      },
      { id: "u2", role: "user", createdAt: "2026-01-01T00:01:00Z" },
      {
        id: "a2",
        role: "assistant",
        createdAt: "2026-01-01T00:01:20Z",
        completedAt: "2026-01-01T00:01:20Z",
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
        ["u2", "2026-01-01T00:01:00Z"],
        ["a2", "2026-01-01T00:01:00Z"],
      ]),
    );
  });

  it("handles system messages without affecting the boundary", () => {
    const result = computeMessageDurationStart([
      { id: "u1", role: "user", createdAt: "2026-01-01T00:00:00Z" },
      { id: "s1", role: "system", createdAt: "2026-01-01T00:00:01Z" },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        completedAt: "2026-01-01T00:00:30Z",
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["s1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
      ]),
    );
  });

  it("returns empty map for empty input", () => {
    expect(computeMessageDurationStart([])).toEqual(new Map());
  });
});

describe("normalizeCompactToolLabel", () => {
  it("removes trailing completion wording from command labels", () => {
    expect(normalizeCompactToolLabel("Ran command complete")).toBe("Ran command");
  });

  it("removes trailing completion wording from other labels", () => {
    expect(normalizeCompactToolLabel("Read file completed")).toBe("Read file");
  });
});

describe("deriveMessagesTimelineRows tool call visibility", () => {
  function messageEntry(id: string, role: "user" | "assistant", createdAt: string): TimelineEntry {
    return {
      id,
      kind: "message",
      createdAt,
      message: { id: MessageId.makeUnsafe(id), role, text: id, createdAt, streaming: false },
    };
  }
  function workEntry(id: string, createdAt: string, overrides: Partial<WorkLogEntry> = {}) {
    const entry: WorkLogEntry = { id, createdAt, label: `Tool ${id}`, tone: "tool", ...overrides };
    return { id, kind: "work", createdAt, entry } satisfies TimelineEntry;
  }
  const entries: TimelineEntry[] = [
    messageEntry("u1", "user", "2026-01-01T00:00:00Z"),
    workEntry("w1", "2026-01-01T00:00:01Z"),
    workEntry("w2", "2026-01-01T00:00:02Z", { tone: "error", label: "Runtime error" }),
    workEntry("w3", "2026-01-01T00:00:03Z", { itemType: "command_execution", command: "ls" }),
    messageEntry("a1", "assistant", "2026-01-01T00:00:04Z"),
    workEntry("w4", "2026-01-01T00:00:05Z", { tone: "info", label: "Context compacted" }),
    workEntry("w5", "2026-01-01T00:00:06Z", { toolName: "Read" }),
  ];

  it("keeps every row when tool calls are shown", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: entries,
      completionDividerBeforeEntryId: null,
      toolCallVisibility: "showAll",
      activeTurnInProgress: true,
    });
    expect(rows.map((row) => row.id)).toEqual(["u1", "w1", "w3", "a1", "w4"]);
  });

  it("hides tool rows but keeps messages, errors and info rows", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: entries,
      completionDividerBeforeEntryId: "a1",
      toolCallVisibility: "hideAll",
    });
    expect(rows.map((row) => [row.kind, row.id])).toEqual([
      ["message", "u1"],
      ["work", "w2"],
      ["message", "a1"],
      ["work", "w4"],
    ]);
    expect(rows[2]).toMatchObject({ showCompletionDivider: true });
  });

  it("shows one working row for the trailing hidden tool calls of a running turn", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: entries,
      completionDividerBeforeEntryId: null,
      toolCallVisibility: "hideAll",
      activeTurnInProgress: true,
    });
    const last = rows.at(-1);
    expect(last).toMatchObject({ kind: "hidden-work", id: HIDDEN_WORK_ROW_ID });
    expect(last?.kind === "hidden-work" && last.latestEntry?.id).toBe("w5");
    expect(last && estimateMessagesTimelineRowHeight(last, { timelineWidthPx: null })).toBe(44);
  });

  it("drops the working row once a visible row follows the hidden calls", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [...entries, messageEntry("a2", "assistant", "2026-01-01T00:00:07Z")],
      completionDividerBeforeEntryId: null,
      toolCallVisibility: "hideAll",
      activeTurnInProgress: true,
    });
    expect(rows.some((row) => row.kind === "hidden-work")).toBe(false);
  });

  it("never hides error entries", () => {
    const error: WorkLogEntry = { id: "e", createdAt: "", label: "Failed", tone: "error" };
    expect(isWorkEntryHiddenByToolCallVisibility(error, "hideAll")).toBe(false);
    expect(isWorkEntryHiddenByToolCallVisibility({ ...error, tone: "tool" }, "hideAll")).toBe(true);
    expect(isWorkEntryHiddenByToolCallVisibility({ ...error, tone: "tool" }, "showAll")).toBe(
      false,
    );
  });

  it("keeps runtime warnings and other info rows visible", () => {
    const warning: WorkLogEntry = {
      id: "warn",
      createdAt: "",
      label: "Reconnecting... 2/5",
      tone: "info",
    };
    expect(isWorkEntryHiddenByToolCallVisibility(warning, "hideAll")).toBe(false);
    expect(
      isWorkEntryHiddenByToolCallVisibility({ ...warning, label: "Context compacted" }, "hideAll"),
    ).toBe(false);
    expect(
      isWorkEntryHiddenByToolCallVisibility(
        { ...warning, itemType: "command_execution" },
        "hideAll",
      ),
    ).toBe(true);
    expect(isWorkEntryHiddenByToolCallVisibility({ ...warning, tone: "thinking" }, "hideAll")).toBe(
      true,
    );
  });
});

describe("deriveMessagesTimelineRows hide successful and zen", () => {
  const turnId = TurnId.makeUnsafe("turn-1");
  function workEntry(id: string, createdAt: string, overrides: Partial<WorkLogEntry> = {}) {
    const entry: WorkLogEntry = { id, createdAt, label: id, tone: "tool", ...overrides };
    return { id, kind: "work", createdAt, entry } satisfies TimelineEntry;
  }
  function assistant(
    id: string,
    createdAt: string,
    overrides: { streaming?: boolean; turnId?: TurnId | null } = {},
  ): TimelineEntry {
    return {
      id,
      kind: "message",
      createdAt,
      message: {
        id: MessageId.makeUnsafe(id),
        role: "assistant",
        text: id,
        createdAt,
        streaming: overrides.streaming ?? false,
        turnId: overrides.turnId === undefined ? turnId : overrides.turnId,
      },
    };
  }
  const settledTurn: TimelineEntry[] = [
    workEntry("t1", "2026-01-01T00:00:01Z", { toolStatus: "completed" }),
    assistant("a1", "2026-01-01T00:00:02Z"),
    workEntry("t2", "2026-01-01T00:00:03Z", { toolStatus: "failed" }),
    assistant("a2", "2026-01-01T00:00:04Z"),
  ];

  it("hides successful calls and clears a failure a hidden success retried", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        workEntry("failed", "2026-01-01T00:00:01Z", { toolStatus: "failed" }),
        workEntry("retried", "2026-01-01T00:00:02Z", { toolStatus: "completed" }),
        workEntry("running", "2026-01-01T00:00:03Z", { toolStatus: "inProgress" }),
      ],
      completionDividerBeforeEntryId: null,
      toolCallVisibility: "hideSuccessful",
    });
    expect(rows.map((row) => row.id)).toEqual(["failed"]);
    expect(rows[0]).toMatchObject({
      kind: "work",
      hasFailure: false,
      groupedEntries: [{ id: "failed" }, { id: "running" }],
    });
  });

  it.each(["failed", "stopped"] as const)(
    "estimates a %s Edit as a compact row rather than a preview",
    (toolStatus) => {
      const heightFor = (status: WorkLogEntry["toolStatus"]) => {
        const [row] = deriveMessagesTimelineRows({
          timelineEntries: [
            workEntry("edit", "2026-01-01T00:00:01Z", {
              itemType: "file_change",
              ...(status ? { toolStatus: status } : {}),
            }),
          ],
          completionDividerBeforeEntryId: null,
        });
        return row && estimateMessagesTimelineRowHeight(row, { timelineWidthPx: null });
      };
      expect(heightFor(toolStatus)).toBe(60);
      expect(heightFor("completed")).toBe(228);
    },
  );

  it("keeps a failure nothing retried flagged under hide successful", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [workEntry("failed", "2026-01-01T00:00:01Z", { toolStatus: "failed" })],
      completionDividerBeforeEntryId: null,
      toolCallVisibility: "hideSuccessful",
    });
    expect(rows[0]).toMatchObject({ kind: "work", hasFailure: true });
  });

  it("shows only a settled turn's last reply under zen", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: settledTurn,
      completionDividerBeforeEntryId: null,
      toolCallVisibility: "zen",
    });
    expect(rows.map((row) => row.id)).toEqual(["a2"]);
    expect(rows[0]).toMatchObject({ absorbedMessageIds: ["a1"] });
  });

  it("keeps the divider and changed files on the message zen shows", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: settledTurn,
      completionDividerBeforeEntryId: "a1",
      toolCallVisibility: "zen",
    });
    const row = rows[0];
    expect(row).toMatchObject({ id: "a2", showCompletionDivider: true });
    if (row?.kind !== "message") throw new Error("expected a message row");

    const summary: TurnDiffSummary = {
      turnId,
      completedAt: "2026-01-01T00:00:05Z",
      files: [{ path: "src/a.ts", additions: 1, deletions: 0 }],
    };
    const summaries = new Map([[MessageId.makeUnsafe("a1"), summary]]);
    expect(resolveMessageRowTurnDiffSummary(row, summaries)).toBe(summary);
    expect(resolveMessageRowTurnDiffSummary(row, new Map())).toBeUndefined();
    const withCard = estimateMessagesTimelineRowHeight(row, {
      timelineWidthPx: null,
      turnDiffSummaryByAssistantMessageId: summaries,
    });
    const withoutCard = estimateMessagesTimelineRowHeight(row, { timelineWidthPx: null });
    expect(withCard).toBeGreaterThan(withoutCard);
  });

  it("stands in with an entryless working row while zen hides running text", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [assistant("a1", "2026-01-01T00:00:02Z", { streaming: true })],
      completionDividerBeforeEntryId: null,
      toolCallVisibility: "zen",
      activeTurnInProgress: true,
      activeTurnId: turnId,
    });
    expect(rows).toEqual([
      {
        kind: "hidden-work",
        id: HIDDEN_WORK_ROW_ID,
        createdAt: "2026-01-01T00:00:02Z",
        latestEntry: null,
      },
    ]);
    const row = rows[0];
    expect(row && estimateMessagesTimelineRowHeight(row, { timelineWidthPx: null })).toBe(44);
  });

  it("does not add a working row once the turn has stopped", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [workEntry("t1", "2026-01-01T00:00:01Z", { toolStatus: "completed" })],
      completionDividerBeforeEntryId: null,
      toolCallVisibility: "zen",
    });
    expect(rows).toEqual([]);
  });
});

describe("deriveMessagesTimelineRows turn folds", () => {
  const turnId = TurnId.makeUnsafe("turn-1");
  const workItem: TimelineEntry = {
    id: "t1",
    kind: "work",
    createdAt: "2026-01-01T00:00:01Z",
    entry: {
      id: "t1",
      createdAt: "2026-01-01T00:00:01Z",
      label: "t1",
      tone: "tool",
      toolStatus: "completed",
      turnId,
    },
  };
  const reply: TimelineEntry = {
    id: "a1",
    kind: "message",
    createdAt: "2026-01-01T00:00:02Z",
    message: {
      id: MessageId.makeUnsafe("a1"),
      role: "assistant",
      text: "a1",
      createdAt: "2026-01-01T00:00:02Z",
      completedAt: "2026-01-01T00:00:03Z",
      streaming: false,
      turnId,
    },
  };
  const latestTurn = {
    turnId,
    state: "completed" as const,
    startedAt: "2026-01-01T00:00:00Z",
    completedAt: "2026-01-01T00:03:00Z",
  };

  it("folds a settled turn and moves the duration off its terminal message", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [workItem, reply],
      completionDividerBeforeEntryId: "a1",
      latestTurn,
    });
    expect(rows.map((row) => [row.kind, row.id])).toEqual([
      ["turn-fold", "turn-fold:turn-1"],
      ["message", "a1"],
    ]);
    expect(rows[0]).toMatchObject({ label: "Worked for 3m", expanded: false });
    expect(rows[1]).toMatchObject({ showCompletionDivider: false });
    expect(rows[0] && estimateMessagesTimelineRowHeight(rows[0], { timelineWidthPx: null })).toBe(
      40,
    );
  });

  it("shows the folded entries under an expanded fold", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [workItem, reply],
      completionDividerBeforeEntryId: null,
      latestTurn,
      expandedWorkGroups: { "turn-fold:turn-1": true },
    });
    expect(rows.map((row) => row.kind)).toEqual(["turn-fold", "work", "message"]);
    expect(rows[0]).toMatchObject({ expanded: true });
  });

  it("does not fold a turn that is still running", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [workItem, reply],
      completionDividerBeforeEntryId: null,
      latestTurn,
      activeTurnInProgress: true,
      activeTurnId: turnId,
    });
    expect(rows.map((row) => row.kind)).toEqual(["work", "message"]);
  });

  it("does not fold when the caller passes no latest turn", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [workItem, reply],
      completionDividerBeforeEntryId: "a1",
    });
    expect(rows.map((row) => row.kind)).toEqual(["work", "message"]);
    expect(rows[1]).toMatchObject({ showCompletionDivider: true });
  });
});

describe("work group row with thinking entries", () => {
  it("adds no work log header for a thought beside tool calls", () => {
    const groupedEntries: WorkLogEntry[] = [
      { id: "t", createdAt: "2026-01-01T00:00:00Z", label: "Thought", tone: "thinking" },
      { id: "w", createdAt: "2026-01-01T00:00:01Z", label: "Read", tone: "tool" },
    ];
    const row: MessagesTimelineRow = {
      kind: "work",
      id: "group",
      createdAt: "2026-01-01T00:00:00Z",
      groupedEntries,
      hasFailure: false,
    };
    // Chrome plus two compact rows and no 26px header.
    expect(estimateMessagesTimelineRowHeight(row, { timelineWidthPx: null })).toBe(92);
  });
});

function tool(id: string, toolStatus?: WorkLogEntry["toolStatus"]): WorkLogEntry {
  return {
    id,
    createdAt: "2026-01-01T00:00:00Z",
    label: id,
    tone: "tool",
    ...(toolStatus ? { toolStatus } : {}),
  };
}
function timeline(entries: WorkLogEntry[]): TimelineEntry[] {
  return entries.map((entry) => ({
    id: entry.id,
    kind: "work",
    createdAt: entry.createdAt,
    entry,
  }));
}

describe("work log tool failures", () => {
  it("flags a group whose last tool attempt failed", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: timeline([tool("t1"), tool("t2", "failed")]),
      completionDividerBeforeEntryId: null,
    });
    expect(rows).toMatchObject([{ kind: "work", hasFailure: true }]);
  });

  it("does not flag a failure that a later tool call followed", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: timeline([tool("t1", "declined"), tool("t2", "completed")]),
      completionDividerBeforeEntryId: null,
    });
    expect(rows).toMatchObject([{ kind: "work", hasFailure: false }]);
  });

  it("ignores non-tool rows after the last tool attempt", () => {
    const info: WorkLogEntry = { id: "i", createdAt: "", label: "Context compacted", tone: "info" };
    expect(workLogEntriesEndInToolFailure([tool("t1", "failed"), info])).toBe(true);
  });

  it("flags hidden entries only when the latest visible tool attempt also failed", () => {
    expect(hiddenWorkLogEntriesIndicateFailure([tool("h", "failed")], [tool("v", "failed")])).toBe(
      true,
    );
    expect(hiddenWorkLogEntriesIndicateFailure([tool("h", "failed")], [tool("v")])).toBe(false);
    expect(hiddenWorkLogEntriesIndicateFailure([tool("h")], [tool("v", "failed")])).toBe(false);
  });

  it("flags the toggle when the group's last tool call failed behind a non-tool tail", () => {
    const infos: WorkLogEntry[] = Array.from({ length: 6 }, (_, index) => ({
      id: `info-${index}`,
      createdAt: "",
      label: "Note",
      tone: "info",
    }));
    expect(hiddenWorkLogEntriesIndicateFailure([tool("h", "failed")], infos)).toBe(true);
  });

  it.each([
    [["failed", "completed", "info"], false],
    [["failed", "info", "completed"], false],
    [["error", "info", "completed"], false],
    [["completed", "failed", "info"], true],
    [["failed", "info", "failed"], true],
    [["completed", "info", "failed"], false],
  ] as const)("mixed work group %j hides a failure: %s", (statuses, expected) => {
    const entries: WorkLogEntry[] = statuses.map((status, index) => {
      if (status === "info" || status === "error") {
        return { id: `${status}-${index}`, createdAt: "", label: status, tone: status };
      }
      return tool(`tool-${index}`, status);
    });
    expect(hiddenWorkLogEntriesIndicateFailure(entries.slice(0, -1), entries.slice(-1))).toBe(
      expected,
    );
  });
});

describe("workEntryPreviewDuplicatesHeading", () => {
  it("drops a task.progress preview that repeats its title", () => {
    expect(
      workEntryPreviewDuplicatesHeading("Typecheck mobile app", "Typecheck  mobile app "),
    ).toBe(true);
    expect(workEntryPreviewDuplicatesHeading("Typecheck mobile...", "Typecheck mobile app")).toBe(
      true,
    );
    expect(workEntryPreviewDuplicatesHeading("Typecheck mobile app", "Run vitest")).toBe(false);
  });
});

describe("context compaction rows", () => {
  const running: TimelineEntry = {
    id: "c1",
    kind: "work",
    createdAt: "2026-01-01T00:00:00Z",
    entry: {
      id: "c1",
      createdAt: "2026-01-01T00:00:00Z",
      label: "Compacting context",
      tone: "info",
      inProgress: true,
      isContextCompaction: true,
    },
  };

  it("keeps a running compaction row only while the turn runs", () => {
    expect(
      deriveMessagesTimelineRows({
        timelineEntries: [running],
        completionDividerBeforeEntryId: null,
        activeTurnInProgress: true,
      }),
    ).toHaveLength(1);
    expect(
      deriveMessagesTimelineRows({
        timelineEntries: [running],
        completionDividerBeforeEntryId: null,
        activeTurnInProgress: false,
      }),
    ).toHaveLength(0);
  });

  it("hides an earlier turn's open compaction row while a newer turn runs", () => {
    const earlier: TimelineEntry = {
      ...running,
      entry: { ...running.entry, turnId: TurnId.makeUnsafe("turn-1") },
    } as TimelineEntry;
    expect(
      deriveMessagesTimelineRows({
        timelineEntries: [earlier],
        completionDividerBeforeEntryId: null,
        activeTurnInProgress: true,
        activeTurnId: TurnId.makeUnsafe("turn-2"),
      }),
    ).toHaveLength(0);
    expect(
      deriveMessagesTimelineRows({
        timelineEntries: [earlier],
        completionDividerBeforeEntryId: null,
        activeTurnInProgress: true,
        activeTurnId: TurnId.makeUnsafe("turn-1"),
      }),
    ).toHaveLength(1);
  });
});

describe("model switch dividers", () => {
  const opus = { provider: "claudeAgent", model: "claude-opus-4-6" } as const;
  const sonnet = { provider: "claudeAgent", model: "claude-sonnet-4-6" } as const;
  const names: Record<string, string> = {
    "claude-opus-4-6": "Opus 4.6",
    "claude-sonnet-4-6": "Sonnet 4.6",
  };
  const modelName = (selection: { model: string }) => names[selection.model] ?? selection.model;
  const messageId = MessageId.makeUnsafe("u2");

  function switchActivity(payload: unknown, kind = "turn.model-switched") {
    return {
      id: EventId.makeUnsafe(`activity-${kind}`),
      tone: "info",
      kind,
      summary: "Model switched",
      payload,
      turnId: null,
      createdAt: "2026-01-01T00:00:00Z",
    } as OrchestrationThreadActivity;
  }

  it("labels a model change with display names", () => {
    expect(formatModelSwitchLabel({ messageId, from: opus, to: sonnet }, modelName)).toBe(
      "Opus 4.6 → Sonnet 4.6",
    );
  });

  it("uses effort display labels when a resolver is given", () => {
    const effortLabels: Record<string, string> = { high: "High", low: "Low" };
    expect(
      formatModelSwitchLabel(
        {
          messageId,
          from: { ...opus, options: { effort: "high" } },
          to: { ...opus, options: { effort: "low" } },
        },
        modelName,
        (_selection, value) => effortLabels[value] ?? value,
      ),
    ).toBe("effort High → Low");
  });

  it("labels an effort-only change", () => {
    expect(
      formatModelSwitchLabel(
        {
          messageId,
          from: { ...opus, options: { effort: "high" } },
          to: { ...opus, options: { effort: "low" } },
        },
        modelName,
      ),
    ).toBe("effort high → low");
  });

  it("combines model and effort changes", () => {
    expect(
      formatModelSwitchLabel(
        {
          messageId,
          from: { ...opus, options: { effort: "high" } },
          to: { ...sonnet, options: { effort: "low" } },
        },
        modelName,
      ),
    ).toBe("Opus 4.6 high → Sonnet 4.6 low");
  });

  it("returns null when nothing visible changed", () => {
    expect(
      formatModelSwitchLabel(
        { messageId, from: { ...opus, options: { effort: "high" } }, to: opus },
        modelName,
      ),
    ).toBeNull();
  });

  it("keys valid switch activities by message id and attaches labels to user rows", () => {
    const activities = [
      switchActivity({ messageId: "u2", from: opus, to: sonnet }),
      switchActivity({ messageId: "u3" }),
      switchActivity({ messageId: "u4", from: opus, to: sonnet }, "turn.plan.updated"),
    ];
    expect([...deriveModelSwitchByMessageId(activities).keys()]).toEqual(["u2"]);
    const labels = deriveModelSwitchLabelByMessageId(activities, modelName);
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "u2",
          kind: "message",
          createdAt: "2026-01-01T00:00:00Z",
          message: {
            id: messageId,
            role: "user",
            text: "hi",
            createdAt: "2026-01-01T00:00:00Z",
            streaming: false,
          },
        },
      ],
      completionDividerBeforeEntryId: null,
      modelSwitchLabelByMessageId: labels,
    });
    expect(rows).toMatchObject([{ kind: "message", modelSwitchLabel: "Opus 4.6 → Sonnet 4.6" }]);
  });
});

describe("estimateMessagesTimelineRowHeight changed-files cards", () => {
  const messageId = MessageId.makeUnsafe("a-files");
  const [row] = deriveMessagesTimelineRows({
    timelineEntries: [
      {
        id: "a-files",
        kind: "message",
        createdAt: "2026-01-01T00:00:01Z",
        message: {
          id: messageId,
          role: "assistant",
          text: "Done.",
          createdAt: "2026-01-01T00:00:01Z",
          completedAt: "2026-01-01T00:00:02Z",
          streaming: false,
        },
      } as TimelineEntry,
    ],
    completionDividerBeforeEntryId: null,
  });
  const summary = {
    turnId: "turn-files" as never,
    completedAt: "2026-01-01T00:00:02Z",
    files: Array.from({ length: 12 }, (_, index) => ({
      path: `src/dir-${index}/file.ts`,
      additions: 1,
      deletions: 0,
    })),
  };
  const turnDiffSummaryByAssistantMessageId = new Map([[messageId, summary]]);

  it("reserves the more-files button only on an expanded capped card", () => {
    const uncapped = estimateMessagesTimelineRowHeight(row!, {
      timelineWidthPx: 800,
      turnDiffSummaryByAssistantMessageId,
    });
    const capped = new Map([[messageId, { ...summary, filesTotal: 450 }]]);
    expect(
      estimateMessagesTimelineRowHeight(row!, {
        timelineWidthPx: 800,
        turnDiffSummaryByAssistantMessageId: capped,
      }),
    ).toBe(uncapped + CHANGED_FILES_MORE_BUTTON_HEIGHT_PX);
    const collapsedHeight = (summaries: typeof turnDiffSummaryByAssistantMessageId) =>
      estimateMessagesTimelineRowHeight(row!, {
        timelineWidthPx: 800,
        turnDiffSummaryByAssistantMessageId: summaries,
        isChangedFilesExpanded: () => false,
      });
    expect(collapsedHeight(capped)).toBe(collapsedHeight(turnDiffSummaryByAssistantMessageId));
  });

  it("estimates a restart continuation as one notice line, however long its prompt", () => {
    const [noticeRow] = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "restart",
          kind: "message",
          createdAt: "2026-01-01T00:00:01Z",
          message: {
            id: MessageId.makeUnsafe("message:restart-continuation:turn-1"),
            role: "user",
            text: "A long continuation prompt\n".repeat(40),
            createdAt: "2026-01-01T00:00:01Z",
            streaming: false,
          },
        } as TimelineEntry,
      ],
      completionDividerBeforeEntryId: null,
    });
    expect(estimateMessagesTimelineRowHeight(noticeRow!, { timelineWidthPx: 800 })).toBe(36);
  });

  it("uses a fixed compact height for collapsed cards", () => {
    const expanded = estimateMessagesTimelineRowHeight(row!, {
      timelineWidthPx: 800,
      turnDiffSummaryByAssistantMessageId,
    });
    const collapsed = estimateMessagesTimelineRowHeight(row!, {
      timelineWidthPx: 800,
      turnDiffSummaryByAssistantMessageId,
      isChangedFilesExpanded: () => false,
    });
    expect(collapsed).toBeLessThan(expanded);
    expect(
      estimateMessagesTimelineRowHeight(row!, {
        timelineWidthPx: 800,
        turnDiffSummaryByAssistantMessageId,
        isChangedFilesExpanded: () => true,
      }),
    ).toBe(expanded);
  });
});

function ranToolEntry(overrides: Partial<WorkLogEntry> = {}): WorkLogEntry {
  return {
    id: "work-1",
    createdAt: "2026-01-01T00:00:00Z",
    label: "Ran tool",
    tone: "tool",
    ...overrides,
  };
}

describe("buildToolCallExpandedBody", () => {
  it("returns null when the body would add nothing to the label", () => {
    expect(buildToolCallExpandedBody(ranToolEntry(), "Ran tool")).toBeNull();
    expect(buildToolCallExpandedBody(ranToolEntry({ detail: "Ran tool" }), "Ran tool")).toBeNull();
    expect(
      buildToolCallExpandedBody(ranToolEntry({ command: "rg foo" }), "Ran command - rg foo"),
    ).toBeNull();
    expect(
      buildToolCallExpandedBody(ranToolEntry({ detail: "short note" }), "Ran tool - short note"),
    ).toBeNull();
  });

  it("keeps a long command the label contains, as the row's width cuts it off", () => {
    const longCommand = `rg ${"needle ".repeat(30)}--hidden`;
    expect(
      buildToolCallExpandedBody(
        ranToolEntry({ command: longCommand, detail: longCommand }),
        `Ran command - ${longCommand}`,
      ),
    ).toMatchObject({ command: longCommand, detail: null });
  });

  it("drops a subagent's detail when it only repeats the prompt in its input", () => {
    const prompt = `Audit the module. ${"Then check its callers. ".repeat(20)}`.trim();
    const cut = buildToolCallExpandedBody(
      ranToolEntry({ toolInput: { prompt }, detail: `${prompt.slice(0, 177)}...` }),
      "Agent",
    );
    expect(cut).toMatchObject({ input: { prompt }, detail: null });
    const whole = buildToolCallExpandedBody(
      ranToolEntry({ toolInput: { prompt: "Audit" }, detail: "Audit" }),
      "Agent",
    );
    expect(whole).toMatchObject({ detail: null });
    // Only the same text counts: an uncut detail that merely starts the prompt is something else.
    const other = buildToolCallExpandedBody(
      ranToolEntry({ toolInput: { prompt: "Audit the module" }, detail: "Audit" }),
      "Agent",
    );
    expect(other?.detail).toBe("Audit");
  });

  it("shows a failed Bash row's full command from its static preview", () => {
    const fullCommand = `bun test ${"x".repeat(200)}`;
    const body = buildToolCallExpandedBody(
      ranToolEntry({
        toolName: "Bash",
        toolStatus: "failed",
        command: "bun test",
        detail: `Bash: ${fullCommand.slice(0, 50)}...`,
        staticPreview: { toolName: "Bash", fieldName: "command", text: fullCommand, updatedAt: 0 },
      }),
      "Ran bun test",
    );
    expect(body?.command).toBe(fullCommand);
    // The detail only repeats the shortened command, and a command is not an Edit preview.
    expect(body?.detail).toBeNull();
    expect(body?.preview).toBeNull();
  });

  it("drops a detail that repeats the command or the tool's serialized input", () => {
    expect(
      buildToolCallExpandedBody(ranToolEntry({ command: "ls -la", detail: "ls -la" }), "Ran ls")
        ?.detail,
    ).toBeNull();
    expect(
      buildToolCallExpandedBody(
        ranToolEntry({ toolName: "mcp__s__m", toolInput: { a: 1 }, detail: 'mcp__s__m: {"a":1}' }),
        "Ran s: m",
      )?.detail,
    ).toBeNull();
  });

  it("keeps real output that merely appears in the command", () => {
    expect(
      buildToolCallExpandedBody(
        ranToolEntry({ command: "rm missing.txt", detail: "missing" }),
        "Ran rm missing.txt",
      )?.detail,
    ).toBe("missing");
    expect(
      buildToolCallExpandedBody(
        ranToolEntry({ command: "rm missing.txt", detail: "rm missing.txt" }),
        "Ran command",
      )?.detail,
    ).toBeNull();
    expect(
      buildToolCallExpandedBody(
        ranToolEntry({ command: "rm missing.txt", detail: "rm miss..." }),
        "Ran command",
      )?.detail,
    ).toBeNull();
  });

  it("keeps a detail that says something new", () => {
    expect(
      buildToolCallExpandedBody(
        ranToolEntry({ command: "ls", detail: "Permission denied: the folder is locked" }),
        "Ran ls",
      )?.detail,
    ).toBe("Permission denied: the folder is locked");
  });

  it("includes MCP input without serializing it", () => {
    const toolInput = { query: "needle", nested: { limit: 3 } };
    const body = buildToolCallExpandedBody(
      ranToolEntry({ toolName: "mcp__s__m", toolInput }),
      "Ran s: m",
    );
    expect(body?.input).toBe(toolInput);
    expect(formatToolInputJson(toolInput)).toBe(JSON.stringify(toolInput, null, 2));
    expect(buildToolCallExpandedBody(ranToolEntry({ toolInput: {} }), "Ran tool")).toBeNull();
  });

  it("caps huge input and says it was cut", () => {
    const json = formatToolInputJson({ content: "x".repeat(50_000) });
    expect(json.length).toBeLessThan(21_000);
    expect(json.endsWith("… truncated")).toBe(true);
  });

  it("labels the kept output line separately and keeps an Edit preview", () => {
    const staticPreview = {
      toolName: "Edit",
      fieldName: "new_string",
      filePath: "src/a.ts",
      oldString: "a",
      text: "b",
      updatedAt: 0,
    };
    const body = buildToolCallExpandedBody(
      ranToolEntry({ staticPreview, toolResultSummary: "String not found" }),
      "Edited a.ts",
    );
    expect(body?.preview).toBe(staticPreview);
    expect(body?.resultSummary).toBe("String not found");
  });

  it("lists every changed file, but not a lone file the label already names", () => {
    const changedFiles = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts"];
    expect(
      buildToolCallExpandedBody(ranToolEntry({ changedFiles }), "Edited files")?.changedFiles,
    ).toEqual(changedFiles);
    expect(
      buildToolCallExpandedBody(
        ranToolEntry({ changedFiles: ["/repo/src/a.ts"] }),
        "Edited src/a.ts",
      ),
    ).toBeNull();
  });
});

function thoughtEntry(label: string, turnId: TurnId): WorkLogEntry {
  return { id: `${label}-${turnId}`, createdAt: "", label, tone: "thinking", turnId };
}

function userTable(rows: number): string {
  return `|a|b|c|\n|-|-|-|\n${"|1|2|3|\n".repeat(rows)}`;
}

describe("formatExpandedToolFilePath", () => {
  it("shortens a path inside the workspace and keeps any other in full", () => {
    expect(formatExpandedToolFilePath("/repo/src/a.ts", "/repo")).toBe("/src/a.ts");
    expect(formatExpandedToolFilePath("/elsewhere/a.ts", "/repo")).toBe("/elsewhere/a.ts");
    expect(formatExpandedToolFilePath("src/a.ts", undefined)).toBe("src/a.ts");
  });
});

describe("work group live state", () => {
  const running = TurnId.makeUnsafe("turn-running");
  const stopped = TurnId.makeUnsafe("turn-stopped");

  it("is live only while working and only for the running turn", () => {
    expect(isWorkEntryLive({ inProgress: true, turnId: running }, true, running)).toBe(true);
    expect(isWorkEntryLive({ inProgress: true, turnId: stopped }, true, running)).toBe(false);
    expect(isWorkEntryLive({ inProgress: true, turnId: running }, false, running)).toBe(false);
    expect(isWorkEntryLive({ turnId: running }, true, running)).toBe(false);
  });

  it("reads a thought block from an older turn as not running", () => {
    expect(isWorkEntryInRunningTurn({ turnId: stopped }, true, running)).toBe(false);
    expect(isWorkEntryInRunningTurn({ turnId: running }, true, running)).toBe(true);
    expect(isWorkEntryInRunningTurn({}, true, running)).toBe(true);
    expect(isWorkEntryInRunningTurn({ turnId: running }, false, running)).toBe(false);
  });

  it("does not revive an old turn's entry before a fresh send has a turn id", () => {
    expect(isWorkEntryLive({ inProgress: true, turnId: stopped }, true, null)).toBe(false);
  });

  it("treats an entry without a turn id as the running one", () => {
    expect(isWorkEntryLive({ inProgress: true }, true, null)).toBe(true);
  });

  it("names the running turn's latest call and skips a stopped turn's", () => {
    const staleEntry = toolEntry("Grep", { inProgress: true, turnId: stopped });
    const liveEntry = toolEntry("Read", { inProgress: true, turnId: running });
    expect(resolveLiveWorkGroupEntry([staleEntry], true, running)).toBeNull();
    expect(resolveLiveWorkGroupEntry([liveEntry, staleEntry], true, running)).toBe(liveEntry);
    expect(resolveLiveWorkGroupEntry([liveEntry], false, running)).toBeNull();
  });

  it("finds the thinking block still streaming, not a finished or stale one", () => {
    const streaming = thoughtEntry("Thinking", running);
    expect(
      resolveStreamingWorkGroupThought(
        [toolEntry("Read"), streaming, toolEntry("Grep")],
        true,
        running,
      ),
    ).toBe(streaming);
    expect(resolveStreamingWorkGroupThought([streaming], false, running)).toBeNull();
    expect(
      resolveStreamingWorkGroupThought([thoughtEntry("Thought", running)], true, running),
    ).toBeNull();
    expect(
      resolveStreamingWorkGroupThought([thoughtEntry("Thinking", stopped)], true, running),
    ).toBeNull();
  });
});

describe("withVisibleControlCharacters", () => {
  it("replaces control characters with their pictures", () => {
    expect(withVisibleControlCharacters("a\u001b[0m\tb\nc\u007f")).toBe(
      "a\u241b[0m\u2409b\u240ac\u2421",
    );
  });

  it("escapes C1 controls, bidi overrides and line separators, which have no pictures", () => {
    expect(withVisibleControlCharacters("a\u0085b\u202ec\u2067d\u2028e")).toBe(
      "a\\u{85}b\\u{202e}c\\u{2067}d\\u{2028}e",
    );
    expect(withVisibleControlCharacters("a\u202eb", { keepLineBreaks: true })).toBe("a\\u{202e}b");
  });

  it("leaves right-to-left text and other non-control characters alone", () => {
    expect(withVisibleControlCharacters("שלום – ok\u200d")).toBe("שלום – ok\u200d");
  });

  it("can keep line breaks for multi-line text", () => {
    expect(withVisibleControlCharacters("a\n\tb\u0007", { keepLineBreaks: true })).toBe(
      "a\n\tb\u2407",
    );
  });
});

function toolEntry(toolName: string, overrides: Partial<WorkLogEntry> = {}): WorkLogEntry {
  return { id: toolName, createdAt: "", label: toolName, tone: "tool", toolName, ...overrides };
}

function unnamedToolEntry(id: string, overrides: Partial<WorkLogEntry> = {}): WorkLogEntry {
  return { id, createdAt: "", label: id, tone: "tool", ...overrides };
}

const entry = (overrides: Partial<WorkLogEntry>): WorkLogEntry => ({
  id: "w",
  createdAt: "",
  label: "Tool",
  tone: "tool",
  ...overrides,
});

describe("summarizeToolGroup", () => {
  const read = (path: string) => toolEntry("Read", { toolBriefInput: { file_path: path } });

  it("names up to two actions in the order they happened", () => {
    expect(
      summarizeToolGroup([
        read("/a"),
        toolEntry("Grep"),
        read("/b"),
        toolEntry("Glob"),
        read("/c"),
        read("/d"),
      ]).label,
    ).toBe("Read 4 files and searched code 2 times");
  });

  it("uses singular wording for one", () => {
    expect(summarizeToolGroup([read("/a"), toolEntry("WebSearch")]).label).toBe(
      "Read 1 file and searched the web 1 time",
    );
  });

  it("folds the actions that do not fit into a count", () => {
    expect(
      summarizeToolGroup([
        read("/a"),
        toolEntry("Grep"),
        toolEntry("WebSearch"),
        toolEntry("WebSearch"),
        toolEntry("WebFetch"),
      ]).label,
    ).toBe("Read 1 file, searched code 1 time, and performed 3 other actions");
  });

  it("gives changes priority over lookups, and lookups over other tools", () => {
    expect(
      summarizeToolGroup([
        toolEntry("WebFetch"),
        read("/a"),
        toolEntry("Grep"),
        toolEntry("Other", { requestKind: "command" }),
      ]).label,
    ).toBe("Read 1 file, ran 1 command, and performed 2 other actions");
  });

  it("counts other tools on their own", () => {
    expect(summarizeToolGroup([toolEntry("WebFetch"), toolEntry("ToolSearch")]).label).toBe(
      "Used 2 tools",
    );
  });

  it("counts files by distinct path", () => {
    expect(summarizeToolGroup([read("/a"), read("/a"), read("/b")]).label).toBe("Read 2 files");
    expect(
      summarizeToolGroup([
        unnamedToolEntry("a", { changedFiles: ["/a", "/b"] }),
        unnamedToolEntry("b", { changedFiles: ["/b"] }),
        toolEntry("Other", { requestKind: "file-change" }),
      ]).label,
    ).toBe("Changed 3 files");
  });

  it("does not take a path in a named tool's input for an edit", () => {
    expect(
      summarizeToolGroup([
        toolEntry("LS", { changedFiles: ["/a"] }),
        toolEntry("mcp__fs__read_text_file", { changedFiles: ["/b"] }),
      ]),
    ).toMatchObject({ label: "Used 2 tools", soleAction: "other" });
  });

  it.each(["file_change", "dynamic_tool_call"] as const)(
    "does not count TodoWrite as a changed file (%s)",
    (itemType) => {
      const todo = toolEntry("TodoWrite", { itemType });
      expect(summarizeToolGroup([todo, read("/a")]).label).toBe("Used 1 tool and read 1 file");
      expect(isPreviewEligibleWorkEntry(todo)).toBe(false);
    },
  );

  it("still counts Edit as a changed file", () => {
    expect(isPreviewEligibleWorkEntry(toolEntry("Edit", { itemType: "file_change" }))).toBe(true);
  });

  it("classifies Codex entries without a tool name", () => {
    expect(
      summarizeToolGroup([entry({ requestKind: "file-read" }), entry({ itemType: "image_view" })])
        .label,
    ).toBe("Read 2 files");
    expect(summarizeToolGroup([entry({ itemType: "web_search" })]).label).toBe(
      "Searched the web 1 time",
    );
    expect(summarizeToolGroup([entry({ itemType: "mcp_tool_call" })]).label).toBe("Used 1 tool");
  });

  it("treats an MCP tool as other even when its name looks like a built-in", () => {
    expect(summarizeToolGroup([toolEntry("mcp__files__read_file")]).label).toBe("Used 1 tool");
  });

  it("leaves thinking and notices out of the counts", () => {
    expect(
      summarizeToolGroup([
        read("/a"),
        { id: "t", createdAt: "", label: "Thinking", tone: "thinking" },
        { id: "i", createdAt: "", label: "Compacted", tone: "info" },
      ]).label,
    ).toBe("Read 1 file");
  });

  it("reports failed and declined calls", () => {
    const summary = summarizeToolGroup([
      toolEntry("Read", { toolStatus: "failed" }),
      toolEntry("Grep", { toolStatus: "declined" }),
      toolEntry("Glob", { toolStatus: "completed" }),
    ]);
    expect(summary.failureNote).toBe("1 failed, 1 declined");
    expect(summarizeToolGroup([read("/a")]).failureNote).toBeNull();
  });

  it("exposes the action only when the group has one", () => {
    expect(summarizeToolGroup([read("/a"), read("/b")]).soleAction).toBe("read");
    expect(summarizeToolGroup([read("/a"), toolEntry("Grep")]).soleAction).toBeNull();
  });
});

describe("work group helpers", () => {
  it("summarizes from two tool calls", () => {
    expect(shouldSummarizeWorkGroup([toolEntry("Read")])).toBe(false);
    expect(
      shouldSummarizeWorkGroup([
        toolEntry("Read"),
        { id: "t", createdAt: "", label: "Thinking", tone: "thinking" },
      ]),
    ).toBe(false);
    expect(shouldSummarizeWorkGroup([toolEntry("Read"), toolEntry("Grep")])).toBe(true);
  });

  it("pins errors and notices, capped to the latest ones", () => {
    const error: WorkLogEntry = { id: "e", createdAt: "", label: "Failed", tone: "error" };
    const info: WorkLogEntry = { id: "i", createdAt: "", label: "Compacted", tone: "info" };
    expect(resolvePinnedWorkGroupEntries([toolEntry("Read"), error, info])).toEqual([error, info]);
    expect(resolvePinnedWorkGroupEntries(Array.from({ length: 9 }, () => info))).toHaveLength(6);
  });

  it("finds the latest call in progress", () => {
    const first = toolEntry("Read", { inProgress: true });
    const second = toolEntry("Grep", { inProgress: true });
    expect(resolveLiveWorkGroupEntry([first, second, toolEntry("Glob")], true, null)).toBe(second);
    expect(resolveLiveWorkGroupEntry([toolEntry("Read")], true, null)).toBeNull();
  });

  it("follows appended calls only for a reader at the end", () => {
    const follow = (previousCount: number, nextCount: number, wasAtEnd: boolean) =>
      shouldFollowWorkGroupAppend({ previousCount, nextCount, wasAtEnd });
    expect(follow(3, 4, true)).toBe(true);
    expect(follow(3, 4, false)).toBe(false);
    // A status update on an existing call changes nothing in the count.
    expect(follow(3, 3, true)).toBe(false);
  });

  it("measures the end of the scroll area with a pixel of tolerance", () => {
    const metrics = { scrollHeight: 500, clientHeight: 200 };
    expect(isWorkGroupScrolledToEnd({ ...metrics, scrollTop: 299.5 })).toBe(true);
    expect(isWorkGroupScrolledToEnd({ ...metrics, scrollTop: 290 })).toBe(false);
  });

  it("keeps an upward scroll inside only while the group or a nested result can move", () => {
    const group = { scrollTop: 0, parentElement: { scrollTop: 900, parentElement: null } };
    const row = { scrollTop: 0, parentElement: group };
    expect(workGroupConsumesUpwardScroll(row, group)).toBe(false);
    expect(workGroupConsumesUpwardScroll({ scrollTop: 10, parentElement: group }, group)).toBe(
      true,
    );
    expect(workGroupConsumesUpwardScroll({ ...group, scrollTop: 10 }, group)).toBe(true);
  });
});

const work = (id: string, entry: Partial<WorkLogEntry>): TimelineEntry => ({
  id,
  kind: "work",
  createdAt: "2026-01-01T00:00:00Z",
  entry: { id, createdAt: "2026-01-01T00:00:00Z", label: id, tone: "tool", ...entry },
});

describe("deriveMessagesTimelineRows work group ids", () => {
  const message = (id: string): TimelineEntry => ({
    id,
    kind: "message",
    createdAt: "2026-01-01T00:00:00Z",
    message: {
      id: MessageId.makeUnsafe(id),
      role: "assistant",
      text: id,
      createdAt: "2026-01-01T00:00:00Z",
      streaming: false,
    },
  });
  const rowIds = (timelineEntries: TimelineEntry[]) =>
    deriveMessagesTimelineRows({ timelineEntries, completionDividerBeforeEntryId: null }).map(
      (row) => row.id,
    );

  it("keeps a group's id when its first call's lifecycle replaces the entry id", () => {
    const started = rowIds([work("activity-1", { providerItemId: "call-1" })]);
    const completed = rowIds([work("activity-2", { providerItemId: "call-1" })]);
    expect(started).toEqual(completed);
  });

  it("falls back to the entry id when a call opens a second group", () => {
    expect(
      rowIds([
        work("activity-1", { providerItemId: "call-1" }),
        message("a1"),
        work("activity-2", { providerItemId: "call-1" }),
      ]),
    ).toEqual(["work-group:call-1", "a1", "activity-2"]);
  });

  // The server emits dynamic_tool_call; older stored activities say file_change.
  it.each(["file_change", "dynamic_tool_call"] as const)(
    "groups TodoWrite with the calls around it (%s)",
    (itemType) => {
      const rows = deriveMessagesTimelineRows({
        timelineEntries: [
          work("w1", { toolName: "Read" }),
          work("w2", { toolName: "TodoWrite", itemType }),
          work("w3", { toolName: "Grep" }),
        ],
        completionDividerBeforeEntryId: null,
      });
      expect(rows).toHaveLength(1);
    },
  );

  it("still gives Bash and Edit their own rows", () => {
    expect(
      rowIds([
        work("w1", { toolName: "Read" }),
        work("w2", { toolName: "Bash", itemType: "command_execution" }),
        work("w3", { toolName: "Edit", itemType: "file_change" }),
        work("w4", { toolName: "Grep" }),
      ]),
    ).toEqual(["w1", "w2", "w3", "w4"]);
  });

  it("leaves nothing to summarize when tool calls are hidden", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        work("w1", { toolName: "Read" }),
        work("w2", { toolName: "Grep" }),
        work("w3", { tone: "error" }),
      ],
      completionDividerBeforeEntryId: null,
      toolCallVisibility: "hideAll",
    });
    expect(rows.map((row) => row.id)).toEqual(["w3"]);
    const row = rows[0];
    expect(row?.kind === "work" && shouldSummarizeWorkGroup(row.groupedEntries)).toBe(false);
  });
});

describe("estimateMessagesTimelineRowHeight for a summarized group", () => {
  const entries = Array.from({ length: 20 }, () => toolEntry("Read"));
  const row = {
    kind: "work" as const,
    id: "group",
    createdAt: "",
    groupedEntries: entries,
    hasFailure: false,
  };

  it("is one line collapsed, and capped by the scroll area expanded", () => {
    expect(estimateMessagesTimelineRowHeight(row, { timelineWidthPx: 800 })).toBe(44);
    expect(
      estimateMessagesTimelineRowHeight(row, {
        timelineWidthPx: 800,
        expandedWorkGroups: { group: true },
      }),
    ).toBe(44 + 18 + 288);
  });

  it("makes room for pinned rows", () => {
    expect(
      estimateMessagesTimelineRowHeight(
        {
          ...row,
          groupedEntries: [
            ...entries,
            { id: "e", createdAt: "", label: "Failed", tone: "error" as const },
          ],
        },
        { timelineWidthPx: 800 },
      ),
    ).toBe(44 + 30);
  });

  it("makes room for a thought still streaming, but not a finished one", () => {
    const withThought = (label: string) =>
      estimateMessagesTimelineRowHeight(
        {
          ...row,
          groupedEntries: [
            ...entries,
            { id: "t", createdAt: "", label, tone: "thinking" as const },
          ],
        },
        { timelineWidthPx: 800 },
      );
    expect(withThought("Thinking")).toBe(44 + 30);
    expect(withThought("Thought")).toBe(44);
  });
});

describe("shouldRenderUserMessageAsMarkdown", () => {
  it("keeps a very long paste as plain text", () => {
    expect(shouldRenderUserMessageAsMarkdown("a".repeat(40_000))).toBe(true);
    expect(shouldRenderUserMessageAsMarkdown("a".repeat(100_000))).toBe(false);
  });

  it("keeps a table-shaped paste as plain text, whatever its length", () => {
    expect(shouldRenderUserMessageAsMarkdown(userTable(100))).toBe(true);
    const longTable = userTable(4_950);
    expect(longTable.length).toBeLessThan(40_000);
    expect(shouldRenderUserMessageAsMarkdown(longTable)).toBe(false);
  });
});

describe("shouldPreserveAssistantLineBreaks", () => {
  it.each([
    ["a plain header", "★ Insight ─────────────\nfirst\nsecond"],
    ["a backticked header", "`★ Insight ─────────────`\nfirst\nsecond"],
    ["a backticked bare header", "`★ Insight`\nfirst"],
    ["a header after other text", "Done.\n\n`★ Insight ───`\nfirst"],
  ])("is true for %s", (_name, text) => {
    expect(shouldPreserveAssistantLineBreaks(text)).toBe(true);
  });

  it.each([
    ["a normal paragraph", "first line\nsecond line"],
    ["a mid-line mention", "See the ★ Insight block"],
    ["a longer word", "★ Insightful"],
    ["empty text", ""],
  ])("is false for %s", (_name, text) => {
    expect(shouldPreserveAssistantLineBreaks(text)).toBe(false);
  });
});

describe("findFirstConversationMessageRowIndex", () => {
  const messageRow = (id: string, role: "user" | "assistant" | "system") =>
    ({
      kind: "message",
      id,
      createdAt: "2026-01-01T00:00:00Z",
      durationStart: "2026-01-01T00:00:00Z",
      showCompletionDivider: false,
      message: {
        id: MessageId.makeUnsafe(id),
        role,
        text: id,
        createdAt: "2026-01-01T00:00:00Z",
        streaming: false,
      },
    }) as const;
  const workRow: MessagesTimelineRow = {
    kind: "work",
    id: "work",
    createdAt: "2026-01-01T00:00:00Z",
    groupedEntries: [],
    hasFailure: false,
  };

  it("skips work rows and system messages", () => {
    expect(
      findFirstConversationMessageRowIndex([
        workRow,
        messageRow("system", "system"),
        messageRow("user", "user"),
        messageRow("assistant", "assistant"),
      ]),
    ).toBe(2);
  });

  it("is null without a conversation message", () => {
    expect(findFirstConversationMessageRowIndex([])).toBeNull();
    expect(findFirstConversationMessageRowIndex([workRow, messageRow("s", "system")])).toBeNull();
  });
});
