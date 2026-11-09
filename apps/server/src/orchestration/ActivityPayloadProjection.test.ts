import { EventId, TurnId, type OrchestrationThreadActivity } from "@piedpiper/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  projectActivityPayload,
  projectSnapshotActivities,
  projectToolLifecycleData,
  summarizeToolTextOutput,
} from "./ActivityPayloadProjection.ts";

const makeActivity = (
  id: string,
  kind: OrchestrationThreadActivity["kind"],
  payload: unknown,
  turnId: string | null = "turn-1",
  summary = "Tool",
): OrchestrationThreadActivity => ({
  id: EventId.makeUnsafe(id),
  tone: "tool",
  kind,
  summary,
  payload,
  turnId: turnId === null ? null : TurnId.makeUnsafe(turnId),
  createdAt: "2026-04-08T00:00:00.000Z",
});

describe("projectToolLifecycleData", () => {
  it("keeps toolName and input and summarizes a Claude tool_result", () => {
    const data = {
      toolName: "Bash",
      input: { command: "ls -la", description: "List files" },
      result: {
        type: "tool_result",
        tool_use_id: "toolu_1",
        content: [{ type: "text", text: `\n\ntotal 42\n${"drwxr-xr-x line\n".repeat(500)}` }],
      },
    };
    expect(projectToolLifecycleData(data)).toEqual({
      toolName: "Bash",
      input: { command: "ls -la", description: "List files" },
      result: { content: "total 42" },
    });
  });

  it("keeps the error flag and precomputes changed files from the result", () => {
    expect(
      projectToolLifecycleData({
        toolName: "Edit",
        input: { file_path: "/repo/a.ts", old_string: "a", new_string: "b" },
        result: { content: "x".repeat(200), is_error: true, files: [{ path: "/repo/a.ts" }] },
      }),
    ).toEqual({
      toolName: "Edit",
      input: { file_path: "/repo/a.ts", old_string: "a", new_string: "b" },
      result: { content: `${"x".repeat(81)}...`, is_error: true },
      files: [{ path: "/repo/a.ts" }],
    });
  });

  it("keeps a Codex call's arguments under the size cap, idempotently", () => {
    const project = (data: unknown) =>
      projectActivityPayload({
        id: "activity-1",
        tone: "tool",
        kind: "tool.completed",
        summary: "Tool",
        payload: { data },
        turnId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      } as never).payload as { data: { item: Record<string, unknown> } };
    const small = {
      item: { type: "mcpToolCall", id: "i", tool: "search", arguments: { query: "cats" } },
    };
    const once = project(small);
    expect(once.data.item.arguments).toEqual({ query: "cats" });
    expect(project(once.data).data.item.arguments).toEqual({ query: "cats" });
    expect(
      project({
        item: { type: "mcpToolCall", id: "i", arguments: { blob: "x".repeat(20_001) } },
      }).data.item,
    ).not.toHaveProperty("arguments");
  });

  it("keeps a Codex subagent's prompt under the size cap, idempotently", () => {
    const project = (data: unknown) =>
      projectActivityPayload({
        id: "activity-1",
        tone: "tool",
        kind: "tool.completed",
        summary: "Tool",
        payload: { data },
        turnId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      } as never).payload as { data: { item: Record<string, unknown> } };
    const small = { item: { type: "collabAgentToolCall", id: "i", prompt: "Audit it" } };
    const once = project(small);
    expect(once.data.item.prompt).toBe("Audit it");
    expect(project(once.data).data.item.prompt).toBe("Audit it");
    expect(
      project({ item: { type: "collabAgentToolCall", id: "i", prompt: "x".repeat(20_001) } }).data
        .item,
    ).not.toHaveProperty("prompt");
  });

  it("keeps Codex command fields and changed paths but drops output and diffs", () => {
    const data = {
      threadId: "t",
      item: {
        type: "commandExecution",
        id: "item-1",
        command: "bun run test",
        aggregatedOutput: "lots of output\n".repeat(1000),
        changes: [{ path: "src/a.ts", kind: "update", diff: "@@ -1 +1 @@\n-a\n+b" }],
      },
    };
    expect(projectToolLifecycleData(data)).toEqual({
      item: { type: "commandExecution", id: "item-1", command: "bun run test" },
      files: [{ path: "src/a.ts" }],
    });
  });

  it.each([
    {
      name: "an MCP error message",
      item: { type: "mcpToolCall", id: "i", status: "failed", error: { message: "server gone" } },
      content: "server gone",
    },
    {
      name: "a failed command's output",
      item: {
        type: "commandExecution",
        id: "i",
        status: "failed",
        aggregatedOutput: "\nnpm ERR! missing script\nmore output\n",
      },
      content: "npm ERR! missing script",
    },
    {
      name: "a failed dynamic tool's content items",
      item: {
        type: "dynamicToolCall",
        id: "i",
        success: false,
        contentItems: [
          { type: "inputImage", imageUrl: "x" },
          { type: "inputText", text: "denied" },
        ],
      },
      content: "denied",
    },
  ])("keeps $name as the result summary, idempotently", ({ item, content }) => {
    const once = projectToolLifecycleData({ item }) as { item: Record<string, unknown> };
    expect(once.item.result).toEqual({ content });
    for (const raw of ["error", "aggregatedOutput", "contentItems", "success"]) {
      expect(once.item).not.toHaveProperty(raw);
    }
    expect(projectToolLifecycleData(once)).toEqual(once);
  });

  it("adds no failure text to a call that succeeded or already has a result", () => {
    const project = (item: Record<string, unknown>) =>
      (projectToolLifecycleData({ item }) as { item: Record<string, unknown> }).item.result;
    expect(
      project({ type: "commandExecution", status: "completed", aggregatedOutput: "fine" }),
    ).toBeUndefined();
    expect(
      project({ type: "mcpToolCall", status: "completed", error: null, result: "kept" }),
    ).toEqual({ content: "kept" });
    expect(
      project({ type: "dynamicToolCall", success: true, contentItems: [{ text: "ok" }] }),
    ).toBeUndefined();
    expect(project({ type: "mcpToolCall", result: "kept", error: { message: "ignored" } })).toEqual(
      { content: "kept" },
    );
  });

  it("is idempotent", () => {
    const data = {
      toolName: "Write",
      input: { file_path: "/repo/b.ts", content: "hello" },
      result: { content: "File created successfully at: /repo/b.ts" },
      item: { result: { command: "x", stdout: "out" } },
      files: [{ path: "/repo/b.ts" }],
    };
    const once = projectToolLifecycleData(data);
    expect(projectToolLifecycleData(once)).toEqual(once);
  });

  it("never cuts the summary inside an emoji at the length limit", () => {
    const summary = summarizeToolTextOutput(`${"a".repeat(80)}😀${"b".repeat(10)}`);
    expect(summary).toBe(`${"a".repeat(80)}...`);
  });

  it("summarizes fenced or blank output", () => {
    expect(summarizeToolTextOutput("```\n\n```")).toBe("2 lines");
    expect(summarizeToolTextOutput("   ")).toBeNull();
  });

  it("skips a fence and normalizes whitespace in the first line", () => {
    expect(summarizeToolTextOutput(`\`\`\`\n  actual\tresult  \n${"x".repeat(5000)}`)).toBe(
      "actual result",
    );
  });

  it("reads CRLF line endings", () => {
    expect(summarizeToolTextOutput("\r\n \t \r\nfirst\r\nsecond\r\n")).toBe("first");
    expect(summarizeToolTextOutput("```\r\n \t \n```\n")).toBe("2 lines");
  });

  it("does not count a lone fence as lines", () => {
    expect(summarizeToolTextOutput("```")).toBeNull();
    expect(summarizeToolTextOutput("```\n   \n")).toBeNull();
  });

  it("stops at the first meaningful line of a large output", () => {
    const indexOf = vi.spyOn(String.prototype, "indexOf");
    try {
      expect(summarizeToolTextOutput(`first\n${"line\n".repeat(10_000)}`)).toBe("first");
      expect(indexOf).toHaveBeenCalledTimes(1);
    } finally {
      indexOf.mockRestore();
    }
  });
});

describe("projectActivityPayload", () => {
  it("only touches tool lifecycle rows", () => {
    const plan = makeActivity("a", "turn.plan.updated", { data: { result: "keep" } });
    expect(projectActivityPayload(plan)).toBe(plan);
  });
});

describe("projectSnapshotActivities", () => {
  it("drops tool.updated rows superseded by a later completion of the same call in the turn", () => {
    const activities = [
      makeActivity("start", "tool.started", { providerItemId: "toolu_1" }),
      makeActivity("upd-1", "tool.updated", { providerItemId: "toolu_1" }),
      makeActivity("other", "tool.updated", { providerItemId: "toolu_2" }),
      makeActivity("upd-2", "tool.updated", { providerItemId: "toolu_1" }),
      makeActivity("done", "tool.completed", {
        providerItemId: "toolu_1",
        data: { toolName: "Read", input: { file_path: "/a" }, result: { content: "x\ny" } },
      }),
      // Same id in another turn: its completion cannot supersede rows here.
      makeActivity("next-turn", "tool.updated", { providerItemId: "toolu_1" }, "turn-2"),
    ];
    const projected = projectSnapshotActivities(activities);
    expect(projected.map((activity) => activity.id)).toEqual([
      "start",
      "other",
      "done",
      "next-turn",
    ]);
    expect((projected[2]?.payload as Record<string, unknown> | undefined)?.data).toEqual({
      toolName: "Read",
      input: { file_path: "/a" },
      result: { content: "x" },
    });
  });

  it("keeps an update that comes after the completion and falls back to the label identity", () => {
    const activities = [
      makeActivity(
        "upd",
        "tool.updated",
        { itemType: "command_execution", detail: "ls" },
        "turn-1",
        "Ran command",
      ),
      makeActivity(
        "done",
        "tool.completed",
        { itemType: "command_execution", detail: "ls", data: { item: { command: "ls" } } },
        "turn-1",
        "Ran command complete",
      ),
      makeActivity(
        "late",
        "tool.updated",
        { itemType: "command_execution", detail: "ls" },
        "turn-1",
        "Ran command",
      ),
      makeActivity("anon", "tool.updated", {}, "turn-1", ""),
    ];
    expect(projectSnapshotActivities(activities).map((activity) => activity.id)).toEqual([
      "done",
      "late",
      "anon",
    ]);
  });

  it("keeps updates whose completion has no data (legacy rows)", () => {
    const activities = [
      makeActivity("start", "tool.started", { providerItemId: "toolu_1", data: { input: {} } }),
      makeActivity("upd", "tool.updated", {
        providerItemId: "toolu_1",
        status: "failed",
        data: { toolName: "Edit", input: { file_path: "/a" } },
      }),
      makeActivity("done", "tool.completed", { providerItemId: "toolu_1" }),
    ];
    expect(projectSnapshotActivities(activities).map((activity) => activity.id)).toEqual([
      "start",
      "upd",
      "done",
    ]);
  });

  it("keeps only the latest resolvable context-window row per turn", () => {
    const usage = (id: string, usedTokens: unknown, turnId: string) =>
      makeActivity(id, "context-window.updated", { usedTokens }, turnId);
    const activities = [
      usage("c1", 100, "turn-1"),
      usage("c2", 200, "turn-1"),
      usage("bad", -1, "turn-1"),
      usage("c3", 300, "turn-2"),
      usage("c4", 50, "turn-3"),
      usage("zero", 0, "turn-3"),
    ];
    expect(projectSnapshotActivities(activities).map((activity) => activity.id)).toEqual([
      "c2",
      "bad",
      "c3",
      "zero",
    ]);
  });
});
