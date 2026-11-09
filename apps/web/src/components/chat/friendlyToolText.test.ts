import { describe, expect, it } from "vitest";

import { type WorkLogEntry } from "../../session-logic";
import {
  buildFriendlyToolText,
  classifyToolName,
  isTodoToolName,
  toolBriefFilePath,
} from "./friendlyToolText";

function text(toolName: string, overrides: Partial<WorkLogEntry> = {}) {
  return buildFriendlyToolText({
    workEntry: { id: "w", createdAt: "", label: toolName, tone: "tool", toolName, ...overrides },
    workspaceRoot: undefined,
  });
}

describe("buildFriendlyToolText MCP tools", () => {
  it("labels MCP tools by server and method even when the name looks like a built-in", () => {
    expect(text("mcp__shell__run_command", { toolBriefInput: { command: "ls" } })).toBe(
      "Ran shell: run_command",
    );
    expect(text("mcp__docs__str_replace_text")).toBe("Ran docs: str_replace_text");
    expect(text("mcp__files__read_file", { inProgress: true })).toBe("Running files: read_file");
  });

  it("drops the claude.ai connector prefix from the server name", () => {
    expect(text("mcp__claude_ai_Notion__notion-create-pages")).toBe(
      "Ran Notion: notion-create-pages",
    );
  });

  it("never leaves an empty server name for a bare claude_ai server", () => {
    expect(text("mcp__claude_ai___search")).toBe("Ran claude_ai: _search");
  });

  it("keeps built-in tool labels", () => {
    expect(text("Bash", { toolBriefInput: { command: "ls" } })).toBe("Ran `ls`");
    expect(text("Edit")).toBe("Edited file…");
  });
});

describe("buildFriendlyToolText truncation", () => {
  it("does not split an emoji at the 80-character cut", () => {
    const emoji = "\u{1F600}";
    const command = `${"a".repeat(79)}${emoji}tail`;
    const result = text("Bash", { toolBriefInput: { command } });
    expect(result).toBe(`Ran \`${"a".repeat(79)}…\``);
    expect(result).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(text("Task", { toolBriefInput: { description: command } })).toBe(
      `Subagent: ${"a".repeat(79)}…`,
    );
  });
});

describe("classifyToolName", () => {
  it.each([
    ["Read", "read"],
    ["view", "read"],
    ["Write", "edit"],
    ["Edit", "edit"],
    ["MultiEdit", "edit"],
    ["NotebookEdit", "edit"],
    ["Bash", "command"],
    ["Glob", "code-search"],
    ["Grep", "code-search"],
    ["WebSearch", "web-search"],
    ["WebFetch", "other"],
    ["TodoWrite", "other"],
    ["mcp__shell__run_command", "other"],
  ] as const)("classifies %s as %s", (toolName, action) => {
    expect(classifyToolName(toolName)).toBe(action);
  });

  it("recognizes todo tools", () => {
    expect(isTodoToolName("TodoWrite")).toBe(true);
    expect(isTodoToolName("Write")).toBe(false);
  });

  it("reads the file a call names", () => {
    expect(toolBriefFilePath({ notebook_path: "/n.ipynb" })).toBe("/n.ipynb");
    expect(toolBriefFilePath({ file_path: "/a", path: "/b" })).toBe("/a");
    expect(toolBriefFilePath({ path: 3 })).toBeUndefined();
    expect(toolBriefFilePath(undefined)).toBeUndefined();
  });
});
