import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem } from "effect";
import { describe, expect, it } from "vitest";
import {
  type ClaudeTaskEntry,
  applyClaudeTaskToolResult,
  claudeTaskStoreDirectory,
  readClaudeTaskStore,
  planStepsFromClaudeTasks,
} from "./ClaudeTasks.ts";

describe("Claude task store", () => {
  it("resolves the store under CLAUDE_CONFIG_DIR or ~/.claude with a sanitized list id", () => {
    expect(
      claudeTaskStoreDirectory({ env: {}, homeDir: "/home/u", cwd: undefined, sessionId: "a.b" }),
    ).toBe(path.join("/home/u", ".claude", "tasks", "a-b"));
    expect(
      claudeTaskStoreDirectory({
        env: { CLAUDE_CONFIG_DIR: "cfg", CLAUDE_CODE_TASK_LIST_ID: "shared" },
        homeDir: "/home/u",
        cwd: "/repo",
        sessionId: "s",
      }),
    ).toBe(path.resolve("/repo", "cfg", "tasks", "shared"));
  });

  it("reads tasks in id order, skipping internal and malformed files", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "claude-task-store-"));
    try {
      writeFileSync(
        path.join(dir, "10.json"),
        JSON.stringify({ id: "10", subject: "Last", status: "in_progress" }),
      );
      writeFileSync(
        path.join(dir, "2.json"),
        JSON.stringify({ id: "2", subject: "First", status: "pending" }),
      );
      writeFileSync(
        path.join(dir, "3.json"),
        JSON.stringify({
          id: "3",
          subject: "Hidden",
          status: "pending",
          metadata: { _internal: true },
        }),
      );
      writeFileSync(path.join(dir, "4.json"), "{not json");
      writeFileSync(path.join(dir, ".lock"), "");
      const read = (directory: string) =>
        Effect.runPromise(
          Effect.flatMap(FileSystem.FileSystem.asEffect(), (fileSystem) =>
            readClaudeTaskStore(fileSystem, directory),
          ).pipe(Effect.provide(NodeServices.layer)),
        );
      expect(Array.from((await read(dir)) ?? [])).toEqual([
        ["2", { subject: "First", status: "pending" }],
        ["10", { subject: "Last", status: "inProgress" }],
      ]);
      expect(await read(path.join(dir, "missing"))).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("applyClaudeTaskToolResult", () => {
  it("creates, updates, deletes and lists tasks from structured results", () => {
    const tasks = new Map<string, ClaudeTaskEntry>();
    expect(
      applyClaudeTaskToolResult(
        tasks,
        "TaskCreate",
        { subject: "Write tests" },
        { task: { id: "1", subject: "Write tests" } },
      ),
    ).toBe(true);
    applyClaudeTaskToolResult(tasks, "TaskCreate", { subject: "Ship" }, { task: { id: "2" } });
    expect(
      applyClaudeTaskToolResult(
        tasks,
        "TaskUpdate",
        { taskId: "1", status: "in_progress" },
        { success: true, taskId: "1" },
      ),
    ).toBe(true);
    expect(planStepsFromClaudeTasks(tasks)).toEqual([
      { step: "Write tests", status: "inProgress" },
      { step: "Ship", status: "pending" },
    ]);

    // Unchanged, failed and unknown-task updates leave the map alone.
    expect(
      applyClaudeTaskToolResult(tasks, "TaskUpdate", { taskId: "1", status: "in_progress" }, {}),
    ).toBe(false);
    expect(
      applyClaudeTaskToolResult(
        tasks,
        "TaskUpdate",
        { taskId: "1", status: "completed" },
        { success: false },
      ),
    ).toBe(false);
    expect(
      applyClaudeTaskToolResult(tasks, "TaskUpdate", { taskId: "9", status: "completed" }, {}),
    ).toBe(false);

    expect(
      applyClaudeTaskToolResult(tasks, "TaskUpdate", { taskId: "2", status: "deleted" }, {}),
    ).toBe(true);
    expect([...tasks.keys()]).toEqual(["1"]);

    expect(
      applyClaudeTaskToolResult(
        tasks,
        "TaskList",
        {},
        {
          tasks: [
            { id: "1", subject: "Write tests", status: "completed" },
            { id: "3", subject: "Docs", status: "pending" },
          ],
        },
      ),
    ).toBe(true);
    expect(planStepsFromClaudeTasks(tasks)).toEqual([
      { step: "Write tests", status: "completed" },
      { step: "Docs", status: "pending" },
    ]);
    expect(applyClaudeTaskToolResult(tasks, "Read", {}, {})).toBe(false);
  });

  it("applies the text results subagents receive", () => {
    const tasks = new Map<string, ClaudeTaskEntry>();
    expect(
      applyClaudeTaskToolResult(
        tasks,
        "TaskCreate",
        { subject: "ignored" },
        "Task #3 created successfully: Audit migrations",
      ),
    ).toBe(true);
    expect(
      applyClaudeTaskToolResult(
        tasks,
        "TaskUpdate",
        { taskId: "3", status: "completed" },
        "Updated task #3 status",
      ),
    ).toBe(true);
    expect(
      applyClaudeTaskToolResult(
        tasks,
        "TaskUpdate",
        { taskId: "3", status: "pending" },
        "Task not found",
      ),
    ).toBe(false);
    expect(planStepsFromClaudeTasks(tasks)).toEqual([
      { step: "Audit migrations", status: "completed" },
    ]);
  });
});
