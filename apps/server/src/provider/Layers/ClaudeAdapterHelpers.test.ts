import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem } from "effect";
import { describe, expect, it, vi } from "vitest";

import type { SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  type ChatAttachment,
  type ProviderSendTurnInput,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  ThreadId,
} from "@piedpiper/contracts";

import { attachmentRelativePath } from "../../attachmentStore.ts";
import { type ClaudeAttachmentBudget, makeClaudeAttachmentBudget } from "../pdfDocumentBudget.ts";

import {
  applyClaudeTaskToolResult,
  buildUserMessageWithPdfBudgetEffect,
  claudeCompactPreservedMessageIds,
  claudeRateLimitCompletionFields,
  readAssistantRateLimitWindow,
  claudeAuthFailureMessage,
  claudeWritesUpdatesAsThinking,
  streamKindFromDeltaType,
  buildPromptText,
  claudeFocusRequestedPanePlugin,
  claudeApiRetryingMessage,
  claudeApiRetrySettledMessage,
  claudePermissionDowngradeNotice,
  claudePermissionModeFallbacks,
  isClaudePermissionModeRefusal,
  isClaudePermissionModeUnanswered,
  requestClaudePermissionMode,
  CLAUDE_AUTH_FAILURE_MESSAGE,
  CLAUDE_CONTEXT_WINDOW_FULL_MESSAGE,
  classifyRequestType,
  classifyToolItemType,
  claudeApprovalDetail,
  claudeApprovalPresentation,
  claudeCompactBoundaryContextUsage,
  claudeContextWindowForApiModel,
  claudeOpenToolStatusForTurn,
  claudeReportedContextWindowForModel,
  claudeReportedContextWindows,
  claudeLaunchExtraArgs,
  type ClaudeLaunchExtraArgs,
  claudeGoalDeferringWorkCount,
  claudeLiveBackgroundWorkCount,
  readClaudeLaunchAppendFile,
  readClaudeLaunchSettings,
  parseClaudeLaunchSettings,
  claudeMcpElicitationAcceptance,
  claudeMcpElicitationDetail,
  claudeRequestContextUsage,
  type ClaudeTaskEntry,
  mergeClaudeStreamUsage,
  planStepsFromClaudeTasks,
  describeClaudeUsageLimit,
  effectiveClaudeApprovalDecision,
  extractPlanStepsFromTodoInput,
  isClaudeUsageLimitBlocking,
  isSubagentMessage,
  isTodoTool,
  normalizeClaudeTokenUsage,
  normalizeSupportedClaudeImageMimeType,
  parentToolUseIdFromMessage,
  resolveClaudeResultContextWindow,
  resultOutcome,
  sanitizeToolResultForPersistence,
  summarizeToolRequest,
  ToolInputStreamExtractor,
  titleForTool,
  toolInputStreamField,
  claudeTaskStoreDirectory,
  readClaudeTaskStore,
} from "./ClaudeAdapterHelpers.ts";

describe("claudeCompactPreservedMessageIds", () => {
  const preservedIds = (metadata: Record<string, unknown>) => [
    ...claudeCompactPreservedMessageIds({
      compact_metadata: { trigger: "manual", pre_tokens: 1, ...metadata },
    } as Parameters<typeof claudeCompactPreservedMessageIds>[0]),
  ];
  const segment = { head_uuid: "head", anchor_uuid: "anchor", tail_uuid: "tail" };

  it("prefers the preserved messages list over the segment", () => {
    expect(
      preservedIds({
        preserved_segment: segment,
        preserved_messages: { anchor_uuid: "anchor", uuids: ["kept"] },
      }),
    ).toEqual(["kept"]);
  });

  it("treats a boundary without compact metadata as preserving nothing", () => {
    expect([
      ...claudeCompactPreservedMessageIds(
        {} as Parameters<typeof claudeCompactPreservedMessageIds>[0],
      ),
    ]).toEqual([]);
  });

  it("falls back to the segment's ends, never its anchor", () => {
    expect(preservedIds({ preserved_segment: segment })).toEqual(["head", "tail"]);
  });

  it("keeps nothing when the compaction summarized everything", () => {
    expect(preservedIds({})).toEqual([]);
  });
});

describe("claudeFocusRequestedPanePlugin", () => {
  const panes = [{ id: "pane-1", title: "Blast Radius", plugin: "blast-radius", rows: 10 }];
  const frame = (fields: Record<string, unknown>) => ({
    type: "system",
    subtype: "ui_panes",
    panes,
    ...fields,
  });

  it("names the plugin behind the requested pane, or the pane when it has none", () => {
    expect(claudeFocusRequestedPanePlugin(frame({ focus_requested_id: "pane-1" }))).toBe(
      "blast-radius",
    );
    expect(claudeFocusRequestedPanePlugin(frame({ focus_requested_id: "other" }))).toBe("other");
    expect(claudeFocusRequestedPanePlugin(frame({ focus_requested_id: "x", panes: null }))).toBe(
      "x",
    );
  });

  it("ignores passive panes and other frames", () => {
    expect(claudeFocusRequestedPanePlugin(frame({ focus_requested_id: null }))).toBeUndefined();
    expect(claudeFocusRequestedPanePlugin(frame({}))).toBeUndefined();
    expect(
      claudeFocusRequestedPanePlugin({ subtype: "ui_invalidate", focus_requested_id: "pane-1" }),
    ).toBeUndefined();
  });
});

describe("Claude MCP tool classification", () => {
  it.each([
    "mcp__files__delete_file",
    "mcp__shell__run_command",
    "mcp__agents__create_agent",
    "mcp__claude_ai_Notion__notion-create-pages",
    "mcp__docs__search_view",
  ])("classifies %s as an MCP call with a dynamic approval", (toolName) => {
    expect(classifyToolItemType(toolName)).toBe("mcp_tool_call");
    expect(classifyRequestType(toolName)).toBe("dynamic_tool_call");
    expect(toolInputStreamField(toolName)).toBeUndefined();
  });

  it.each([
    ["Bash", "command_execution", "command_execution_approval"],
    ["PowerShell", "command_execution", "command_execution_approval"],
    ["Edit", "file_change", "file_change_approval"],
    ["Write", "file_change", "file_change_approval"],
    ["NotebookEdit", "file_change", "file_change_approval"],
    ["Task", "collab_agent_tool_call", "dynamic_tool_call"],
    ["Agent", "collab_agent_tool_call", "dynamic_tool_call"],
    ["WebSearch", "web_search", "dynamic_tool_call"],
    ["Read", "dynamic_tool_call", "file_read_approval"],
    ["Grep", "dynamic_tool_call", "file_read_approval"],
    ["Glob", "dynamic_tool_call", "file_read_approval"],
    ["ListMcpResourcesTool", "mcp_tool_call", "dynamic_tool_call"],
    ["ReadMcpResourceTool", "mcp_tool_call", "dynamic_tool_call"],
  ] as const)("classifies %s by what it does", (toolName, itemType, requestType) => {
    expect(classifyToolItemType(toolName)).toBe(itemType);
    expect(classifyRequestType(toolName)).toBe(requestType);
  });

  it.each([
    "TodoWrite",
    "TaskCreate",
    "TaskUpdate",
    "TaskStop",
    "TaskOutput",
    "CronCreate",
    "CronDelete",
    "TeamCreate",
    "TeamDelete",
    "SendMessage",
    "KillShell",
    "BashOutput",
    "Monitor",
    "WebFetch",
    "ToolSearch",
    "SomeFutureEditorTool",
  ])("keeps %s away from the command, file and search types", (toolName) => {
    expect(classifyToolItemType(toolName)).toBe("dynamic_tool_call");
    expect(classifyRequestType(toolName)).toBe("dynamic_tool_call");
    expect(toolInputStreamField(toolName)).toBeUndefined();
  });

  it("titles MCP calls with the humanized tool and server", () => {
    expect(titleForTool("mcp_tool_call", "mcp__claude_ai_Firecrawl__firecrawl_scrape")).toBe(
      "firecrawl scrape (Firecrawl)",
    );
    expect(titleForTool("mcp_tool_call", "mcp__my-server__do_thing")).toBe("do thing (my server)");
    expect(titleForTool("command_execution", "Bash")).toBe("Command run");
    expect(titleForTool("mcp_tool_call")).toBe("MCP tool call");
  });
});

describe("toolInputStreamField", () => {
  it("streams only what the edit, write and bash preview cards show", () => {
    expect(toolInputStreamField("Write")).toBe("content");
    expect(toolInputStreamField("WRITE")).toBe("content");
    expect(toolInputStreamField("Edit")).toBe("new_string");
    expect(toolInputStreamField("Bash")).toBe("command");
    expect(toolInputStreamField("PowerShell")).toBe("command");
  });

  it.each(["Read", "Glob", "WebFetch", "NotebookEdit", "TodoWrite", "TaskCreate", "CronCreate"])(
    "streams nothing for %s",
    (toolName) => {
      expect(toolInputStreamField(toolName)).toBeUndefined();
    },
  );
});

describe("claudeContextWindowForApiModel", () => {
  it.each([
    ["claude-opus-5-5", 1_000_000],
    ["claude-sonnet-5-5", 1_000_000],
    ["claude-haiku-5-5", 1_000_000],
    ["claude-fable-5-1", 1_000_000],
    ["claude-opus-4-6", 200_000],
    ["claude-opus-4-6[1m]", 1_000_000],
    ["claude-sonnet-4-6", 200_000],
    ["claude-sonnet-4-6[1m]", 1_000_000],
    ["claude-haiku-4-5", 200_000],
    ["my-proxy-model[1m]", 1_000_000],
  ])("knows %s", (model, window) => {
    expect(claudeContextWindowForApiModel(model)).toBe(window);
  });

  it.each([undefined, null, "", "  ", "my-proxy-model", "constructor"])(
    "knows nothing about %s",
    (model) => {
      expect(claudeContextWindowForApiModel(model)).toBeUndefined();
    },
  );
});

describe("buildPromptText", () => {
  const turn = (input: string) =>
    ({
      threadId: "thread-1",
      input,
      attachments: [],
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-opus-5-5",
        options: { effort: "ultrathink" },
      },
    }) as unknown as ProviderSendTurnInput;

  it("keeps a slash command first, since Ultrathink before it would stop it running", () => {
    expect(buildPromptText(turn("/compact"))).toBe("/compact");
    expect(buildPromptText(turn("  /review the diff "))).toBe("/review the diff");
    expect(buildPromptText(turn("/goal clear"))).toBe("/goal clear");
  });

  it("still prefixes ordinary text and a path", () => {
    expect(buildPromptText(turn("explain this"))).toBe("Ultrathink:\nexplain this");
    expect(buildPromptText(turn("/usr/bin is missing"))).toBe("Ultrathink:\n/usr/bin is missing");
  });
});

describe("resolveClaudeResultContextWindow", () => {
  const usage = {
    "my-proxy-model": { contextWindow: 300_000 },
    "claude-opus-4-6": { contextWindow: 1_000_000 },
    subagent: { contextWindow: 2_000_000 },
    broken: { contextWindow: "big" },
  };

  it("prefers this model's report, then the table, then the largest report", () => {
    expect(resolveClaudeResultContextWindow("claude-opus-4-6", usage)).toBe(1_000_000);
    expect(resolveClaudeResultContextWindow("claude-haiku-4-5", usage)).toBe(200_000);
    expect(
      resolveClaudeResultContextWindow("claude-opus-5-5", {
        "claude-opus-5-5": { contextWindow: 200_000 },
      }),
    ).toBe(200_000);
    expect(
      resolveClaudeResultContextWindow("claude-opus-5-5[1m]", {
        "claude-opus-5-5": { contextWindow: 200_000 },
      }),
    ).toBe(1_000_000);
    expect(resolveClaudeResultContextWindow("my-proxy-model", usage)).toBe(300_000);
    expect(resolveClaudeResultContextWindow("my-proxy-model[1m]", usage)).toBe(1_000_000);
    expect(resolveClaudeResultContextWindow("other-model", usage)).toBe(2_000_000);
    expect(resolveClaudeResultContextWindow(undefined, usage)).toBe(2_000_000);
    expect(resolveClaudeResultContextWindow("other-model", undefined)).toBeUndefined();
  });

  it("reads reports per model and ignores malformed entries", () => {
    const reported = claudeReportedContextWindows(usage);
    expect(reported.has("broken")).toBe(false);
    expect(claudeReportedContextWindowForModel(reported, "my-proxy-model")).toBe(300_000);
    expect(claudeReportedContextWindowForModel(reported, "absent")).toBeUndefined();
    expect(claudeReportedContextWindows(null).size).toBe(0);
  });
});

describe("claudeApprovalDetail", () => {
  const prompt = { title: "Claude wants to edit a.ts", description: "It will change one line" };

  it("prefers the command, then the title, the description, the file and the raw input", () => {
    expect(
      claudeApprovalDetail({ toolName: "Bash", toolInput: { command: "ls -la" }, ...prompt }),
    ).toBe("Bash: ls -la");
    expect(
      claudeApprovalDetail({ toolName: "Edit", toolInput: { file_path: "/a.ts" }, ...prompt }),
    ).toBe("Claude wants to edit a.ts");
    expect(
      claudeApprovalDetail({
        toolName: "Edit",
        toolInput: { file_path: "/a.ts" },
        description: prompt.description,
      }),
    ).toBe("It will change one line");
    expect(claudeApprovalDetail({ toolName: "Edit", toolInput: { file_path: "/a.ts" } })).toBe(
      "Edit: /a.ts",
    );
    expect(claudeApprovalDetail({ toolName: "Other", toolInput: { a: 1 } })).toBe('Other: {"a":1}');
  });

  it("keeps every argument of an untitled MCP call, not just its path", () => {
    expect(
      claudeApprovalDetail({
        toolName: "mcp__fs__delete",
        toolInput: { path: "/data", recursive: true },
      }),
    ).toBe('mcp__fs__delete: {"path":"/data","recursive":true}');
  });

  it("skips a blank title and a blank command", () => {
    expect(
      claudeApprovalDetail({
        toolName: "Write",
        toolInput: { command: "  ", file_path: "/a.ts" },
        title: "  \u001b[2m ",
      }),
    ).toBe("Write: /a.ts");
  });

  it("names the notebook a NotebookEdit changes", () => {
    expect(
      claudeApprovalDetail({ toolName: "NotebookEdit", toolInput: { notebook_path: "/n.ipynb" } }),
    ).toBe("NotebookEdit: /n.ipynb");
  });

  it("does not mistake a Grep search scope for the file", () => {
    expect(
      claudeApprovalDetail({ toolName: "Grep", toolInput: { pattern: "x", path: "/src" } }),
    ).toBe('Grep: {"pattern":"x","path":"/src"}');
    expect(claudeApprovalDetail({ toolName: "LS", toolInput: { path: "/src" } })).toBe("LS: /src");
  });

  it("keeps MCP arguments under the title", () => {
    expect(
      claudeApprovalDetail({
        toolName: "mcp__db__drop",
        toolInput: { table: "users" },
        title: "Claude wants to drop a table",
      }),
    ).toBe('Claude wants to drop a table\nmcp__db__drop: {"table":"users"}');
    expect(
      claudeApprovalDetail({ toolName: "mcp__db__ping", toolInput: {}, title: "Ping the db" }),
    ).toBe("Ping the db");
  });

  it("strips terminal escapes and control characters", () => {
    expect(
      claudeApprovalDetail({
        toolName: "Edit",
        toolInput: {},
        title: "\u001b[1mClaude\u001b[0m wants\u0007 to edit",
      }),
    ).toBe("Claude wants to edit");
    expect(
      claudeApprovalDetail({ toolName: "Bash", toolInput: { command: "ls\u0000\u001b[31m -l" } }),
    ).toBe("Bash: ls -l");
  });

  it("leaves the work-log summary as raw input", () => {
    expect(summarizeToolRequest("Edit", { file_path: "/a.ts" })).toBe(
      'Edit: {"file_path":"/a.ts"}',
    );
  });
});

describe("claudeOpenToolStatusForTurn", () => {
  it("closes open tools as stopped only when the turn was stopped", () => {
    expect(claudeOpenToolStatusForTurn("completed")).toBe("completed");
    expect(claudeOpenToolStatusForTurn("failed")).toBe("failed");
    expect(claudeOpenToolStatusForTurn("interrupted")).toBe("stopped");
    expect(claudeOpenToolStatusForTurn("cancelled")).toBe("stopped");
  });
});

describe("parentToolUseIdFromMessage", () => {
  it("reads the frame's parent call, treating empty and missing as the root agent", () => {
    const frame = (parent: unknown) => ({ parent_tool_use_id: parent }) as unknown as SDKMessage;
    expect(parentToolUseIdFromMessage(frame("toolu-1"))).toBe("toolu-1");
    expect(parentToolUseIdFromMessage(frame(null))).toBeNull();
    expect(parentToolUseIdFromMessage(frame(""))).toBeNull();
    expect(parentToolUseIdFromMessage({} as unknown as SDKMessage)).toBeNull();
  });
});

describe("ToolInputStreamExtractor", () => {
  it("returns the full delta when called once with a complete buffer", () => {
    const extractor = new ToolInputStreamExtractor("content");
    const result = extractor.update('{"content":"hello world"}');
    expect(result).toBe("hello world");
    expect(extractor.done).toBe(true);
    expect(extractor.filePath).toBeUndefined();
  });

  it("accumulates incremental deltas across multiple update calls", () => {
    const extractor = new ToolInputStreamExtractor("content");
    let collected = "";
    const buffers = [
      '{"con',
      '{"content',
      '{"content":"hel',
      '{"content":"hello',
      '{"content":"hello wor',
      '{"content":"hello world',
      '{"content":"hello world"',
      '{"content":"hello world"}',
    ];
    for (const buf of buffers) {
      const delta = extractor.update(buf);
      if (delta !== null) {
        collected += delta;
      }
    }
    expect(collected).toBe("hello world");
    expect(extractor.done).toBe(true);
  });

  it("decodes single-character escapes", () => {
    const extractor = new ToolInputStreamExtractor("content");
    const result = extractor.update('{"content":"line1\\nline2\\ttab\\\\back\\"quote"}');
    expect(result).toBe('line1\nline2\ttab\\back"quote');
    expect(extractor.done).toBe(true);
  });

  it("decodes \\uXXXX escapes", () => {
    const extractor = new ToolInputStreamExtractor("content");
    const result = extractor.update('{"content":"caf\\u00e9"}');
    expect(result).toBe("café");
    expect(extractor.done).toBe(true);
  });

  it("pauses on chunk boundary inside a \\uXXXX escape", () => {
    const extractor = new ToolInputStreamExtractor("content");

    const first = extractor.update('{"content":"\\u00');
    // We may get nothing yet, or only literal characters before the escape.
    expect(first === null || first === "").toBe(true);
    expect(extractor.done).toBe(false);

    const second = extractor.update('{"content":"\\u00e9"}');
    // The second call must complete the escape and emit the decoded char
    // (plus consume the closing quote).
    expect(second).toBe("é");
    expect(extractor.done).toBe(true);
  });

  it("does not consume a trailing backslash at the buffer boundary", () => {
    const extractor = new ToolInputStreamExtractor("content");

    const first = extractor.update('{"content":"hello\\');
    expect(first).toBe("hello");
    expect(extractor.done).toBe(false);

    const second = extractor.update('{"content":"hello\\nworld"}');
    expect(second).toBe("\nworld");
    expect(extractor.done).toBe(true);
  });

  it("emits malformed \\uXXXX escapes verbatim", () => {
    const extractor = new ToolInputStreamExtractor("content");
    const result = extractor.update('{"content":"\\uZZZZ"}');
    expect(result).toBe("\\uZZZZ");
    expect(extractor.done).toBe(true);
  });

  it("captures filePath when 'path' precedes the target field", () => {
    const extractor = new ToolInputStreamExtractor("content");
    const result = extractor.update('{"path":"file.ts","content":"x"}');
    expect(result).toBe("x");
    expect(extractor.filePath).toBe("file.ts");
    expect(extractor.done).toBe(true);
  });

  it("waits for path value to be complete before populating filePath", () => {
    const extractor = new ToolInputStreamExtractor("content");

    // Path is incomplete (no closing quote) and target field is not present.
    const first = extractor.update('{"path":"file.ts');
    expect(first).toBeNull();
    expect(extractor.filePath).toBeUndefined();
    expect(extractor.done).toBe(false);

    const second = extractor.update('{"path":"file.ts","content":"x"}');
    expect(second).toBe("x");
    expect(extractor.filePath).toBe("file.ts");
    expect(extractor.done).toBe(true);
  });

  it("flips done after consuming the closing quote", () => {
    const extractor = new ToolInputStreamExtractor("command");
    expect(extractor.done).toBe(false);
    const result = extractor.update('{"command":"ls -la"}');
    expect(result).toBe("ls -la");
    expect(extractor.done).toBe(true);
    // Subsequent updates should be no-ops.
    expect(extractor.update('{"command":"ls -la"}')).toBeNull();
  });

  it("returns null and does not crash when target field is absent", () => {
    const extractor = new ToolInputStreamExtractor("content");
    expect(extractor.update('{"other":"value"}')).toBeNull();
    expect(extractor.done).toBe(false);
    expect(extractor.filePath).toBeUndefined();
  });

  it("leaves filePath undefined when no 'path' key is present", () => {
    const extractor = new ToolInputStreamExtractor("content");
    const result = extractor.update('{"content":"x"}');
    expect(result).toBe("x");
    expect(extractor.filePath).toBeUndefined();
    expect(extractor.done).toBe(true);
  });

  it("decodes escapes inside the path value", () => {
    const extractor = new ToolInputStreamExtractor("content");
    const result = extractor.update('{"path":"a\\nb","content":"y"}');
    expect(result).toBe("y");
    expect(extractor.filePath).toBe("a\nb");
    expect(extractor.done).toBe(true);
  });

  it("handles streaming append after the value start has been located", () => {
    const extractor = new ToolInputStreamExtractor("new_string");

    const a = extractor.update('{"old_string":"foo","new_string":"bar');
    expect(a).toBe("bar");

    const b = extractor.update('{"old_string":"foo","new_string":"bar baz');
    expect(b).toBe(" baz");

    const c = extractor.update('{"old_string":"foo","new_string":"bar baz"}');
    expect(c).toBeNull();
    expect(extractor.done).toBe(true);
  });

  it("handles a path value that contains an escaped quote", () => {
    const extractor = new ToolInputStreamExtractor("content");
    const result = extractor.update('{"path":"a\\"b","content":"x"}');
    expect(result).toBe("x");
    expect(extractor.filePath).toBe('a"b');
    expect(extractor.done).toBe(true);
  });
});

describe("resultOutcome", () => {
  const success = (fields: Record<string, unknown>) =>
    ({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "",
      stop_reason: null,
      ...fields,
    }) as unknown as SDKResultMessage;
  const errored = (fields: Record<string, unknown>) =>
    ({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: [],
      stop_reason: null,
      ...fields,
    }) as unknown as SDKResultMessage;

  it("reports a full context window, not a usage limit, for blocking_limit and prompt_too_long", () => {
    for (const terminalReason of ["blocking_limit", "prompt_too_long"]) {
      expect(resultOutcome(success({ terminal_reason: terminalReason }))).toEqual({
        status: "failed",
        errorMessage: CLAUDE_CONTEXT_WINDOW_FULL_MESSAGE,
      });
    }
    expect(resultOutcome(success({ terminal_reason: "blocking_limit" }), "limit hint")).toEqual({
      status: "failed",
      errorMessage: "limit hint",
    });
  });

  it("keeps ordinary success results completed", () => {
    expect(resultOutcome(success({ terminal_reason: "completed" }))).toEqual({
      status: "completed",
      errorMessage: undefined,
    });
  });

  it.each([
    "blocking_limit",
    "rapid_refill_breaker",
    "prompt_too_long",
    "image_error",
    "model_error",
    "malformed_tool_use_exhausted",
    "budget_exhausted",
    "structured_output_retry_exhausted",
    "tool_deferred_unavailable",
    "turn_setup_failed",
  ])("fails a success-tagged result with dead-turn terminal reason %s", (terminalReason) => {
    const outcome = resultOutcome(success({ terminal_reason: terminalReason }));
    expect(outcome.status).toBe("failed");
    expect(outcome.errorMessage).toEqual(expect.any(String));
  });

  it("fails a success-tagged 529 overload", () => {
    expect(resultOutcome(success({ api_error_status: 529 }))).toEqual({
      status: "failed",
      errorMessage: "Claude API is overloaded (529). Try again shortly.",
    });
  });

  it("prefers the CLI's 'API Error:' text for success-tagged api_error results", () => {
    expect(
      resultOutcome(success({ terminal_reason: "api_error", result: " API Error: 400 bad " })),
    ).toEqual({ status: "failed", errorMessage: "API Error: 400 bad" });
    expect(resultOutcome(success({ terminal_reason: "api_error" })).errorMessage).toBe(
      "Claude gave up after repeated API errors.",
    );
  });

  it("uses the failure hint for api_error and success-tagged is_error results", () => {
    expect(
      resultOutcome(success({ terminal_reason: "api_error" }), CLAUDE_AUTH_FAILURE_MESSAGE),
    ).toEqual({ status: "failed", errorMessage: CLAUDE_AUTH_FAILURE_MESSAGE });
    expect(resultOutcome(success({ is_error: true }), "hint")).toEqual({
      status: "failed",
      errorMessage: "hint",
    });
    expect(resultOutcome(success({ is_error: true })).status).toBe("completed");
  });

  it("treats aborted terminal reasons as interrupted and hides ede_diagnostic errors", () => {
    expect(
      resultOutcome(
        errored({ terminal_reason: "aborted_streaming", errors: ["[ede_diagnostic] x"] }),
      ),
    ).toEqual({ status: "interrupted", errorMessage: undefined });
  });

  it("keeps the listed error for an unknown terminal reason", () => {
    expect(
      resultOutcome(errored({ terminal_reason: "future_reason", errors: ["Provider detail"] })),
    ).toEqual({ status: "failed", errorMessage: "Provider detail" });
  });
});

describe("isClaudeUsageLimitBlocking", () => {
  it("blocks only rejected windows without overage", () => {
    expect(isClaudeUsageLimitBlocking({ status: "rejected" })).toBe(true);
    expect(isClaudeUsageLimitBlocking({ status: "allowed" })).toBe(false);
    expect(isClaudeUsageLimitBlocking({ status: "allowed_warning" })).toBe(false);
    expect(isClaudeUsageLimitBlocking({ status: "rejected", overageStatus: "allowed" })).toBe(
      false,
    );
    expect(
      isClaudeUsageLimitBlocking({ status: "rejected", overageStatus: "allowed_warning" }),
    ).toBe(false);
    expect(isClaudeUsageLimitBlocking({ status: "rejected", isUsingOverage: true })).toBe(false);
    expect(isClaudeUsageLimitBlocking({ status: "rejected", overageInUse: true })).toBe(false);
    expect(isClaudeUsageLimitBlocking({ status: "rejected", overageStatus: "rejected" })).toBe(
      true,
    );
  });
});

describe("isSubagentMessage", () => {
  it("is true only for frames carrying a parent tool use id", () => {
    const frame = (parentToolUseId: unknown) =>
      ({ type: "assistant", parent_tool_use_id: parentToolUseId }) as unknown as SDKMessage;
    expect(isSubagentMessage(frame("task-1"))).toBe(true);
    expect(isSubagentMessage(frame(null))).toBe(false);
    expect(isSubagentMessage(frame(undefined))).toBe(false);
    expect(isSubagentMessage({ type: "result" } as unknown as SDKMessage)).toBe(false);
  });
});

describe("describeClaudeUsageLimit", () => {
  it("names the window and the remaining wait", () => {
    expect(
      describeClaudeUsageLimit(
        { status: "rejected", rateLimitType: "seven_day", resetsAt: 3_600 + 90 * 60 },
        3_600_000,
      ),
    ).toBe(
      "Claude usage limit reached. This turn is paused until the 7-day limit resets in 1h 30m.",
    );
  });

  it("omits an implausible or past reset time", () => {
    expect(describeClaudeUsageLimit({ status: "rejected", resetsAt: 1 }, 10_000_000)).toBe(
      "Claude usage limit reached. This turn is paused until the limit resets.",
    );
  });
});

describe("TodoWrite plan helpers", () => {
  it("recognizes TodoWrite tool names", () => {
    expect(isTodoTool("TodoWrite")).toBe(true);
    expect(isTodoTool("mcp__x__todowrite")).toBe(true);
    expect(isTodoTool("Write")).toBe(false);
  });

  it("maps todos to plan steps and returns null when there are none", () => {
    expect(
      extractPlanStepsFromTodoInput({
        todos: [
          { content: " Plan ", status: "completed" },
          { content: "Build", status: "in_progress" },
          { status: "pending" },
          null,
        ],
      }),
    ).toEqual([
      { step: "Plan", status: "completed" },
      { step: "Build", status: "inProgress" },
      { step: "Task", status: "pending" },
    ]);
    expect(extractPlanStepsFromTodoInput({ todos: [] })).toBeNull();
    expect(extractPlanStepsFromTodoInput({})).toBeNull();
    expect(extractPlanStepsFromTodoInput(undefined)).toBeNull();
  });
});

describe("normalizeClaudeTokenUsage", () => {
  it("clamps used tokens to the context window and keeps the processed total", () => {
    expect(normalizeClaudeTokenUsage({ total_tokens: 535_000 }, 200_000)).toEqual({
      usedTokens: 200_000,
      lastUsedTokens: 200_000,
      totalProcessedTokens: 535_000,
      maxTokens: 200_000,
    });
  });

  it("leaves usage within the window unchanged", () => {
    expect(normalizeClaudeTokenUsage({ total_tokens: 1_000 }, 200_000)).toEqual({
      usedTokens: 1_000,
      lastUsedTokens: 1_000,
      maxTokens: 200_000,
    });
  });
});

describe("normalizeSupportedClaudeImageMimeType", () => {
  it("accepts supported image types regardless of casing", () => {
    expect(normalizeSupportedClaudeImageMimeType("image/png")).toBe("image/png");
    expect(normalizeSupportedClaudeImageMimeType("IMAGE/JPEG")).toBe("image/jpeg");
    expect(normalizeSupportedClaudeImageMimeType(" image/WebP ")).toBe("image/webp");
  });

  it("rejects image types Claude cannot read", () => {
    expect(normalizeSupportedClaudeImageMimeType("image/heic")).toBeNull();
    expect(normalizeSupportedClaudeImageMimeType("image/bmp")).toBeNull();
    expect(normalizeSupportedClaudeImageMimeType("image/svg+xml")).toBeNull();
  });
});

describe("summarizeToolRequest", () => {
  it("never splits an emoji at the command or serialized-input cut", () => {
    const command = `${"a".repeat(399)}\u{1F600}tail`;
    expect(summarizeToolRequest("Bash", { command })).toBe(`Bash: ${"a".repeat(399)}`);

    const value = `${"b".repeat(386)}\u{1F600}${"c".repeat(20)}`;
    const summary = summarizeToolRequest("Edit", { value });
    // `{"value":"` is 10 code units, so the emoji's high surrogate would sit at index 396.
    expect(summary).toBe(`Edit: {"value":"${"b".repeat(386)}...`);
  });
});

describe("sanitizeToolResultForPersistence", () => {
  it("never splits an emoji at the text cap", () => {
    const sanitized = sanitizeToolResultForPersistence(
      { type: "tool_result", tool_use_id: "t", content: "abc\u{1F600}def" },
      4,
    );
    expect(sanitized.content).toBe("abc\u2026 [truncated 5 characters]");
  });

  it("replaces Anthropic and MCP image bodies with mimeType-only placeholders", () => {
    const data = "A".repeat(200_000);
    expect(
      sanitizeToolResultForPersistence({
        type: "tool_result",
        tool_use_id: "tool-1",
        content: [
          { type: "text", text: "captured" },
          { type: "image", source: { type: "base64", media_type: "image/png", data } },
          { type: "image", data, mimeType: "image/jpeg" },
        ],
      }),
    ).toEqual({
      type: "tool_result",
      tool_use_id: "tool-1",
      content: [
        { type: "text", text: "captured" },
        { type: "image", mimeType: "image/png" },
        { type: "image", mimeType: "image/jpeg" },
      ],
    });
  });

  it("caps text across the whole block and keeps short results intact", () => {
    expect(
      sanitizeToolResultForPersistence({ type: "tool_result", tool_use_id: "t", content: "ok" }),
    ).toEqual({ type: "tool_result", tool_use_id: "t", content: "ok" });

    const sanitized = sanitizeToolResultForPersistence(
      {
        type: "tool_result",
        tool_use_id: "t",
        is_error: true,
        content: [
          { type: "text", text: "x".repeat(6) },
          { type: "text", text: "y".repeat(10) },
        ],
      },
      10,
    );
    expect(sanitized).toEqual({
      type: "tool_result",
      tool_use_id: "t",
      is_error: true,
      content: [
        { type: "text", text: "xxxxxx" },
        { type: "text", text: "yyyy\u2026 [truncated 6 characters]" },
      ],
    });
  });

  it("sanitizes deeply nested images and text and omits structure past the depth limit", () => {
    let nested: unknown = {
      leaf: { type: "image", data: "A".repeat(1_000), mimeType: "image/png" },
    };
    for (let index = 0; index < 12; index += 1) nested = { child: nested, note: "x".repeat(20) };
    const sanitized = sanitizeToolResultForPersistence(
      { type: "tool_result", tool_use_id: "t", content: nested },
      50,
    );
    const serialized = JSON.stringify(sanitized);
    expect(serialized).not.toContain("AAAA");
    expect(serialized).toContain('"[omitted]"');
    expect(serialized.length).toBeLessThan(1_000);
  });
});

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

describe("Claude context usage helpers", () => {
  it("measures the latest request, preferring the last usage iteration", () => {
    expect(
      claudeRequestContextUsage(
        {
          input_tokens: 10,
          cache_creation_input_tokens: 20,
          cache_read_input_tokens: 70,
          output_tokens: 5,
        },
        200_000,
        5_000,
      ),
    ).toEqual({
      usedTokens: 105,
      lastUsedTokens: 105,
      totalProcessedTokens: 5_000,
      inputTokens: 100,
      outputTokens: 5,
      maxTokens: 200_000,
    });
    expect(
      claudeRequestContextUsage({
        input_tokens: 999,
        output_tokens: 1,
        iterations: [{ input_tokens: 5 }, { input_tokens: 40, output_tokens: 2 }],
      }),
    ).toEqual({ usedTokens: 42, lastUsedTokens: 42, inputTokens: 40, outputTokens: 2 });
    expect(claudeRequestContextUsage({ input_tokens: 0, output_tokens: 3 })).toBeUndefined();
  });

  it("merges message_delta usage over message_start usage, keeping fields the delta leaves null", () => {
    expect(
      mergeClaudeStreamUsage(
        { input_tokens: 4, cache_read_input_tokens: 100, output_tokens: 1 },
        { input_tokens: null, cache_read_input_tokens: null, output_tokens: 50 },
      ),
    ).toEqual({ input_tokens: 4, cache_read_input_tokens: 100, output_tokens: 50 });
  });

  it("reads the post-compaction size from compact_boundary metadata", () => {
    expect(
      claudeCompactBoundaryContextUsage(
        { compact_metadata: { trigger: "auto", pre_tokens: 180_000, post_tokens: 9_000 } },
        200_000,
      ),
    ).toEqual({ usedTokens: 9_000, lastUsedTokens: 9_000, maxTokens: 200_000 });
    expect(
      claudeCompactBoundaryContextUsage({ compact_metadata: { trigger: "manual", pre_tokens: 1 } }),
    ).toBeUndefined();
  });
});

const request = (requestedSchema?: Record<string, unknown>, mode?: "form" | "url") => ({
  serverName: "deploy",
  message: "Deploy to production?",
  ...(mode ? { mode } : {}),
  ...(requestedSchema ? { requestedSchema } : {}),
});

describe("claudeMcpElicitationAcceptance", () => {
  it("fills a consent form without trusting schema defaults", () => {
    expect(
      claudeMcpElicitationAcceptance(
        request({
          type: "object",
          properties: {
            decision: { type: "string", enum: ["approve", "deny"] },
            persist: { type: "boolean", title: "Always allow", default: true },
            scope: { type: "string", default: "all-repos" },
          },
          required: ["decision"],
        }),
      ),
    ).toEqual({ action: "accept", content: { decision: "approve", persist: false } });
  });

  it("picks the one-time choice however the server spells it, never a broader grant", () => {
    const choose = (options: ReadonlyArray<string>) =>
      claudeMcpElicitationAcceptance(
        request({
          type: "object",
          properties: { decision: { type: "string", enum: options } },
          required: ["decision"],
        }),
      )?.content?.decision;
    expect(choose(["allow_all", "allow_once"])).toBe("allow_once");
    expect(choose(["allow_and_remember", "allow_this_time"])).toBe("allow_this_time");
    expect(choose(["Allow once only", "deny"])).toBe("Allow once only");
    expect(choose(["approve_all_tools", "deny"])).toBeUndefined();
    expect(
      claudeMcpElicitationAcceptance(
        request({
          type: "object",
          properties: {
            decision: { oneOf: [{ const: "allow_all_repos" }, { const: "approve" }] },
          },
          required: ["decision"],
        }),
      ),
    ).toEqual({ action: "accept", content: { decision: "approve" } });
  });

  it("declines what the approval card cannot answer", () => {
    expect(claudeMcpElicitationAcceptance(request(undefined, "url"))).toBeUndefined();
    expect(claudeMcpElicitationAcceptance(request())).toBeUndefined();
    expect(
      claudeMcpElicitationAcceptance(
        request({
          type: "object",
          properties: { reason: { type: "string" } },
          required: ["reason"],
        }),
      ),
    ).toBeUndefined();
  });

  it("labels the card with the server's display name", () => {
    expect(claudeMcpElicitationDetail({ ...request(), displayName: "Deployer" })).toBe(
      "Deployer: Deploy to production?",
    );
    expect(claudeMcpElicitationDetail(request())).toBe("deploy: Deploy to production?");
  });
});

describe("claudeApprovalPresentation", () => {
  it("strips terminal escapes from the reason and flags a forbidden standing grant", () => {
    expect(
      claudeApprovalPresentation({
        detail: "Bash: rm -rf build",
        callbackOptions: {
          decisionReason: "  \u001b[33mMatched ask rule Bash(rm:*)\u001b[39m ",
          suppressAlwaysAllowRule: true,
        },
      }),
    ).toEqual({ reason: "Matched ask rule Bash(rm:*)", noStandingGrant: true });
  });

  it("omits an empty reason or one that repeats the detail", () => {
    expect(
      claudeApprovalPresentation({ detail: "Bash: ls", callbackOptions: { decisionReason: "  " } }),
    ).toEqual({});
    expect(
      claudeApprovalPresentation({
        detail: "Bash: ls",
        callbackOptions: { decisionReason: "Bash: ls", suppressAlwaysAllowRule: false },
      }),
    ).toEqual({});
  });
});

describe("effectiveClaudeApprovalDecision", () => {
  it("downgrades a session grant only when Claude forbids a standing grant", () => {
    expect(effectiveClaudeApprovalDecision("acceptForSession", true)).toBe("accept");
    expect(effectiveClaudeApprovalDecision("acceptForSession", undefined)).toBe("acceptForSession");
    expect(effectiveClaudeApprovalDecision("decline", true)).toBe("decline");
  });
});

const parsed = (input: Partial<ClaudeLaunchExtraArgs>): ClaudeLaunchExtraArgs => ({
  extraArgs: {},
  ignored: [],
  additionalDirectories: [],
  ...input,
});

describe("claudeLaunchExtraArgs", () => {
  it("keeps an apostrophe escape inside a flag's value", () => {
    expect(claudeLaunchExtraArgs(String.raw`--append-system-prompt don\'t --chrome`)).toEqual(
      parsed({ appendSystemPrompt: "don't", extraArgs: { chrome: null } }),
    );
  });

  it("returns no extra args for an empty setting", () => {
    expect(claudeLaunchExtraArgs("")).toEqual(parsed({}));
    expect(claudeLaunchExtraArgs(undefined)).toEqual(parsed({}));
  });

  it("forwards long flags with and without values", () => {
    expect(claudeLaunchExtraArgs("--chrome --mcp-debug --add-dir ../shared --foo=bar")).toEqual(
      parsed({
        extraArgs: { chrome: null, "mcp-debug": null, foo: "bar" },
        additionalDirectories: ["../shared"],
      }),
    );
  });

  it("drops flags the SDK sets itself and bare values", () => {
    expect(
      claudeLaunchExtraArgs("--model opus --chrome --permission-mode=plan --resume abc stray"),
    ).toEqual(
      parsed({
        extraArgs: { chrome: null },
        ignored: ["--model", "--permission-mode", "--resume", "stray"],
      }),
    );
  });

  it("drops the SDK's protocol and session flags", () => {
    expect(
      claudeLaunchExtraArgs("--no-session-persistence --sdk-url ws://x --session-mirror --chrome"),
    ).toEqual(
      parsed({
        extraArgs: { chrome: null },
        ignored: ["--no-session-persistence", "--sdk-url", "--session-mirror"],
      }),
    );
  });

  it("never takes a short flag as the previous flag's value", () => {
    expect(claudeLaunchExtraArgs("--chrome -c")).toEqual(
      parsed({ extraArgs: { chrome: null }, ignored: ["-c"] }),
    );
    expect(claudeLaunchExtraArgs("--add-dir -r --resume")).toEqual(
      parsed({ ignored: ["--add-dir", "-r", "--resume"] }),
    );
    expect(claudeLaunchExtraArgs("--max-turns=-1")).toEqual(
      parsed({ extraArgs: { "max-turns": "-1" } }),
    );
  });

  it("reports a bare word after a known value-less flag", () => {
    expect(claudeLaunchExtraArgs("--chrome stray --mcp-debug other")).toEqual(
      parsed({ extraArgs: { chrome: null, "mcp-debug": null }, ignored: ["stray", "other"] }),
    );
  });

  it("keeps quoted values with spaces", () => {
    expect(claudeLaunchExtraArgs(`--add-dir "my dir" --=x`)).toEqual(
      parsed({ additionalDirectories: ["my dir"], ignored: ["--=x"] }),
    );
  });

  it("collects every --add-dir form", () => {
    expect(claudeLaunchExtraArgs("--add-dir a --add-dir b c --add-dir=d e --chrome")).toEqual(
      parsed({
        additionalDirectories: ["a", "b", "c", "d"],
        extraArgs: { chrome: null },
        ignored: ["e"],
      }),
    );
    expect(claudeLaunchExtraArgs(`--add-dir= --add-dir ""`)).toEqual(
      parsed({ ignored: ["--add-dir", "--add-dir"] }),
    );
  });

  it("stops at a bare -- and reports the rest as ignored", () => {
    expect(claudeLaunchExtraArgs("--chrome -- --add-dir x --settings y")).toEqual(
      parsed({
        extraArgs: { chrome: null },
        ignored: ["--add-dir", "x", "--settings", "y"],
      }),
    );
    expect(claudeLaunchExtraArgs("--add-dir a -- b")).toEqual(
      parsed({ additionalDirectories: ["a"], ignored: ["b"] }),
    );
  });

  it("takes --append-system-prompt out of the CLI flags, last one winning", () => {
    expect(
      claudeLaunchExtraArgs(`--append-system-prompt "first" --append-system-prompt=second`),
    ).toEqual(parsed({ appendSystemPrompt: "second" }));
  });

  it("takes a dash-led --append-system-prompt value, which never reaches the CLI flags", () => {
    expect(claudeLaunchExtraArgs(`--append-system-prompt "- Be brief" --chrome`)).toEqual(
      parsed({ appendSystemPrompt: "- Be brief", extraArgs: { chrome: null } }),
    );
  });

  it("reports an append flag without a value", () => {
    expect(claudeLaunchExtraArgs("--append-system-prompt --chrome")).toEqual(
      parsed({ appendFlagMissingValue: "--append-system-prompt", extraArgs: { chrome: null } }),
    );
    expect(claudeLaunchExtraArgs("--append-system-prompt")).toEqual(
      parsed({ appendFlagMissingValue: "--append-system-prompt" }),
    );
    for (const launchArgs of ["--append-system-prompt-file", "--append-system-prompt-file="]) {
      expect(claudeLaunchExtraArgs(launchArgs)).toEqual(
        parsed({ appendFlagMissingValue: "--append-system-prompt-file" }),
      );
    }
  });

  it("takes --append-system-prompt-file out of the CLI flags, last one winning", () => {
    expect(
      claudeLaunchExtraArgs(
        "--append-system-prompt-file a.md --append-system-prompt-file=b.md --chrome",
      ),
    ).toEqual(parsed({ appendSystemPromptFile: "b.md", extraArgs: { chrome: null } }));
  });

  it("takes --settings out of the CLI flags, empty when it has no value", () => {
    expect(claudeLaunchExtraArgs(`--settings '{"a": 1}' --chrome`)).toEqual(
      parsed({ settingsArg: `{"a": 1}`, extraArgs: { chrome: null } }),
    );
    expect(claudeLaunchExtraArgs("--settings=extra.json")).toEqual(
      parsed({ settingsArg: "extra.json" }),
    );
    expect(claudeLaunchExtraArgs("--settings")).toEqual(parsed({ settingsArg: "" }));
  });

  it("still ignores permission flags", () => {
    expect(
      claudeLaunchExtraArgs("--dangerously-skip-permissions --permission-mode plan").ignored,
    ).toEqual(["--dangerously-skip-permissions", "--permission-mode"]);
  });
});

describe("parseClaudeLaunchSettings", () => {
  it("accepts only one JSON object", () => {
    expect(parseClaudeLaunchSettings(`{"a":1}`)).toEqual({ a: 1 });
    for (const text of ["[1]", "null", "1", `"a"`, "{", ""]) {
      expect(parseClaudeLaunchSettings(text)).toBeUndefined();
    }
  });
});

describe("launch argument files", () => {
  const withDir = <A, E>(
    use: (dir: string, fileSystem: FileSystem.FileSystem) => Effect.Effect<A, E>,
  ) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "claude-launch-file-"));
    return Effect.runPromise(
      Effect.service(FileSystem.FileSystem).pipe(
        Effect.flatMap((fileSystem) => use(dir, fileSystem)),
        Effect.provide(NodeServices.layer),
        Effect.ensuring(Effect.sync(() => rmSync(dir, { recursive: true, force: true }))),
      ),
    );
  };

  it("expands a leading ~ in a --settings path, which no shell does here", async () => {
    await withDir((dir, fileSystem) =>
      Effect.gen(function* () {
        writeFileSync(path.join(dir, "fast.json"), `{"model":"fast"}`);
        vi.stubEnv("HOME", dir);
        const settings = yield* readClaudeLaunchSettings({
          settingsArg: "~/fast.json",
          cwd: "/elsewhere",
          fileSystem,
        });
        expect(settings).toEqual({ model: "fast" });
      }).pipe(Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs()))),
    );
  });

  it("reads an append file against the cwd, trimming one trailing newline", async () => {
    await withDir((dir, fileSystem) =>
      Effect.gen(function* () {
        writeFileSync(path.join(dir, "rules.md"), "Be brief.\n\n");
        const text = yield* readClaudeLaunchAppendFile({
          fileArg: "rules.md",
          cwd: dir,
          fileSystem,
        });
        expect(text).toBe("Be brief.\n");
      }),
    );
  });
});

describe("claudeGoalDeferringWorkCount", () => {
  const count = (input: {
    readonly live?: ReadonlyArray<string>;
    readonly roster?: ReadonlyArray<string>;
    readonly types?: Record<string, string>;
  }) =>
    claudeGoalDeferringWorkCount({
      liveTaskIds: new Set(input.live ?? []),
      backgroundRoster: input.roster && new Set(input.roster),
      taskTypes: new Map(Object.entries(input.types ?? {})),
    });

  it("counts a subagent the level leaves out, such as an ambient one", () => {
    expect(count({ live: ["a"], roster: [], types: { a: "local_agent" } })).toBe(1);
    expect(count({ live: ["a"], roster: [] })).toBe(1);
  });

  it("does not count a task type Claude's goal check ignores", () => {
    expect(count({ live: ["m"], roster: ["m"], types: { m: "mcp_task" } })).toBe(0);
  });

  it("counts a shell through the level once there is one", () => {
    const types = { s: "local_bash" };
    expect(count({ live: ["s"], types })).toBe(1);
    expect(count({ live: ["s"], roster: [], types })).toBe(0);
    expect(count({ roster: ["s"], types })).toBe(1);
  });
});

describe("claudeLiveBackgroundWorkCount", () => {
  const liveTaskIds = new Set(["listed", "unlisted"]);

  it("uses the bookends until the first level", () => {
    for (const turnActive of [true, false]) {
      expect(
        claudeLiveBackgroundWorkCount({ liveTaskIds, backgroundRoster: undefined, turnActive }),
      ).toBe(2);
    }
  });

  it("counts the roster alone between turns", () => {
    expect(
      claudeLiveBackgroundWorkCount({
        liveTaskIds,
        backgroundRoster: new Set(["listed"]),
        turnActive: false,
      }),
    ).toBe(1);
    expect(
      claudeLiveBackgroundWorkCount({
        liveTaskIds,
        backgroundRoster: new Set(),
        turnActive: false,
      }),
    ).toBe(0);
  });

  it("adds ids off the roster during a turn, without counting one twice", () => {
    expect(
      claudeLiveBackgroundWorkCount({
        liveTaskIds,
        backgroundRoster: new Set(["listed", "only-in-level"]),
        turnActive: true,
      }),
    ).toBe(3);
  });
});

describe("claudeApiRetryingMessage", () => {
  const status = {
    attempt: 2,
    maxRetries: 10,
    errorStatus: 529,
    error: "overloaded",
    explainedByUsageLimit: false,
  };

  it("names the cause and the attempt", () => {
    expect(claudeApiRetryingMessage(status)).toBe("Claude API overloaded (529), retry 2 of 10");
    expect(claudeApiRetryingMessage({ ...status, errorStatus: 503, error: "server_error" })).toBe(
      "Claude API server error (503), retry 2 of 10",
    );
    expect(claudeApiRetryingMessage({ ...status, errorStatus: null, error: "unknown" })).toBe(
      "Claude API error, retry 2 of 10",
    );
  });

  it("has its own wording when the API sent no response", () => {
    expect(
      claudeApiRetryingMessage({
        ...status,
        attempt: 1,
        maxRetries: 1,
        errorStatus: null,
        error: "unknown",
        noResponseWaitedMs: 30_400,
      }),
    ).toBe("Claude API sent no response after 30s, retry 1 of 1");
  });

  it("only counts when a usage limit already explains the wait", () => {
    const limited = {
      ...status,
      errorStatus: 429,
      error: "rate_limit",
      explainedByUsageLimit: true,
    };
    expect(claudeApiRetryingMessage(limited)).toBe("Claude API retry 2 of 10");
    expect(claudeApiRetrySettledMessage(limited, "failed")).toBe(
      "Claude API gave up at retry 2 of 10",
    );
  });

  it("settles on the outcome", () => {
    expect(claudeApiRetrySettledMessage(status, "recovered")).toBe(
      "Claude API recovered after 2 retries",
    );
    expect(claudeApiRetrySettledMessage({ ...status, attempt: 1 }, "recovered")).toBe(
      "Claude API recovered after 1 retry",
    );
    expect(claudeApiRetrySettledMessage(status, "failed")).toBe(
      "Claude API overloaded (529), gave up at retry 2 of 10",
    );
    expect(claudeApiRetrySettledMessage(status, "stopped")).toBe(
      "Claude API overloaded (529), stopped at retry 2 of 10",
    );
  });
});

const refusal = (message: string) => new Error(message);

const answering = (answers: ReadonlyArray<Error | undefined>) => {
  const calls: string[] = [];
  let next = 0;
  const setMode = async (mode: string) => {
    calls.push(mode);
    const answer = answers[next++];
    if (answer) throw answer;
  };
  return { calls, setMode };
};

describe("Claude permission mode fallbacks", () => {
  it("only steps permissive modes down", () => {
    expect(claudePermissionModeFallbacks("bypassPermissions")).toEqual([
      "bypassPermissions",
      "auto",
      "default",
    ]);
    expect(claudePermissionModeFallbacks("auto")).toEqual(["auto", "default"]);
    expect(claudePermissionModeFallbacks("default")).toEqual(["default"]);
    expect(claudePermissionModeFallbacks("plan")).toEqual(["plan"]);
  });

  it("recognizes only the CLI's refusal of that mode", () => {
    expect(
      isClaudePermissionModeRefusal(
        refusal("Cannot set permission mode to auto: auto mode is unavailable for this model"),
        "auto",
      ),
    ).toBe(true);
    expect(
      isClaudePermissionModeRefusal(
        refusal(
          "Cannot set permission mode to bypassPermissions because it is disabled by settings",
        ),
        "bypassPermissions",
      ),
    ).toBe(true);
    expect(isClaudePermissionModeRefusal(refusal("Control channel closed"), "auto")).toBe(false);
    expect(
      isClaudePermissionModeRefusal(refusal("Cannot set permission mode to auto"), "default"),
    ).toBe(false);
    expect(
      isClaudePermissionModeRefusal(
        refusal("Cannot set permission mode: must be one of x"),
        "auto",
      ),
    ).toBe(false);
  });

  it("tells the CLI's not-yet-known answer apart from a refusal", () => {
    const unanswered = refusal(
      "Cannot set permission mode to auto: auto mode availability is not known yet \u00b7 ask again",
    );
    expect(isClaudePermissionModeUnanswered(unanswered, "auto")).toBe(true);
    expect(isClaudePermissionModeUnanswered(unanswered, "default")).toBe(false);
    expect(
      isClaudePermissionModeUnanswered(
        refusal("Cannot set permission mode to auto: auto mode is unavailable for this model"),
        "auto",
      ),
    ).toBe(false);
  });

  it("asks again when Claude has no answer, then reports what it heard", async () => {
    const askAgain = refusal(
      "Cannot set permission mode to auto: auto mode availability is not known yet \u00b7 ask again",
    );

    const retried = answering([askAgain, undefined]);
    await expect(requestClaudePermissionMode(retried.setMode, "auto")).resolves.toBe("accepted");
    expect(retried.calls).toEqual(["auto", "auto"]);

    const silent = answering([askAgain, askAgain, askAgain, undefined]);
    await expect(requestClaudePermissionMode(silent.setMode, "auto")).resolves.toBe("unanswered");
    expect(silent.calls).toEqual(["auto", "auto", "auto"]);

    const refused = answering([refusal("Cannot set permission mode to auto")]);
    await expect(requestClaudePermissionMode(refused.setMode, "auto")).resolves.toBe("refused");
    expect(refused.calls).toEqual(["auto"]);

    const broken = answering([refusal("Control channel closed")]);
    await expect(requestClaudePermissionMode(broken.setMode, "auto")).rejects.toThrow(
      "Control channel closed",
    );
  });

  it("gives a notice only when running below the request", () => {
    expect(claudePermissionDowngradeNotice("auto", "default")).toBe(
      "Auto is unavailable for this session, so Claude will ask for approvals.",
    );
    expect(claudePermissionDowngradeNotice("auto", "default", true)).toBe(
      "Auto could not be confirmed for this turn, so Claude will ask for approvals.",
    );
    expect(claudePermissionDowngradeNotice("bypassPermissions", "default", true)).toContain(
      "Full access is unavailable",
    );
    expect(claudePermissionDowngradeNotice("auto", "auto", true)).toBeUndefined();
    expect(claudePermissionDowngradeNotice("bypassPermissions", "auto")).toContain("using Auto");
    expect(claudePermissionDowngradeNotice("bypassPermissions", "default")).toContain("approvals");
    expect(claudePermissionDowngradeNotice("auto", "auto")).toBeUndefined();
    expect(claudePermissionDowngradeNotice("auto", "plan")).toBeUndefined();
    expect(claudePermissionDowngradeNotice(undefined, "default")).toBeUndefined();
  });
});

describe("streamKindFromDeltaType", () => {
  it("reports thinking as summaries, kept apart from raw reasoning at ingestion", () => {
    expect(streamKindFromDeltaType("thinking_delta")).toBe("reasoning_summary_text");
    expect(streamKindFromDeltaType("text_delta")).toBe("assistant_text");
  });
});

const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

describe("claudeRateLimitCompletionFields", () => {
  const fields = (input: {
    readonly status?: "failed" | "completed" | "interrupted";
    readonly rejected?: ReadonlyArray<readonly [string, number | null]>;
    readonly limited?: boolean;
    readonly assistantWindow?: { readonly type: string; readonly resetsAt: number | null };
    readonly authenticationFailed?: boolean;
    readonly result?: unknown;
  }) =>
    claudeRateLimitCompletionFields({
      status: input.status ?? "failed",
      rejectedRateLimitTypes: new Map(input.rejected ?? []),
      latestAssistantRateLimited: input.limited ?? false,
      assistantRateLimitWindow: input.assistantWindow,
      authenticationFailed: input.authenticationFailed,
      result: input.result as SDKResultMessage | undefined,
    });

  it("is empty unless a failed turn hit a limit", () => {
    expect(fields({})).toEqual({});
    expect(fields({ status: "completed", rejected: [["five_hour", 100]] })).toEqual({});
    expect(fields({ status: "interrupted", limited: true })).toEqual({});
  });

  it("takes the latest reset and leaves unknown out of the names", () => {
    expect(
      fields({
        rejected: [
          ["five_hour", 100],
          ["seven_day", 900],
        ],
      }),
    ).toEqual({ rateLimitResetAt: iso(900), rateLimitTypes: ["five_hour", "seven_day"] });
    expect(fields({ rejected: [["unknown", 100]] })).toEqual({
      rateLimitResetAt: iso(100),
      rateLimitTypes: [],
    });
  });

  it("answers null for a limit with no credible reset", () => {
    expect(fields({ limited: true }).rateLimitResetAt).toBeNull();
    for (const bad of [null, Number.NaN, Number.POSITIVE_INFINITY, 0, -5, 1e30]) {
      expect(
        fields({
          rejected: [
            ["five_hour", 100],
            ["seven_day", bad],
          ],
        }).rateLimitResetAt,
      ).toBeNull();
    }
  });

  it("adds an assistant frame's window only when no event named that type", () => {
    expect(fields({ assistantWindow: { type: "seven_day", resetsAt: 900 } })).toEqual({
      rateLimitResetAt: iso(900),
      rateLimitTypes: ["seven_day"],
    });
    expect(
      fields({
        rejected: [["five_hour", 100]],
        assistantWindow: { type: "seven_day", resetsAt: 900 },
      }),
    ).toEqual({ rateLimitResetAt: iso(900), rateLimitTypes: ["five_hour", "seven_day"] });
    expect(
      fields({
        rejected: [["five_hour", 900]],
        assistantWindow: { type: "five_hour", resetsAt: 100 },
      }),
    ).toEqual({ rateLimitResetAt: iso(900), rateLimitTypes: ["five_hour"] });
  });

  it.each([
    ["an auth failure", { authenticationFailed: true }],
    ["a 403", { result: { api_error_status: 403, terminal_reason: "api_error" } }],
    ["a 500", { result: { api_error_status: 500, terminal_reason: "api_error" } }],
    ["max turns", { result: { terminal_reason: "max_turns" } }],
  ])("is empty for %s after a rejected window", (_name, input) => {
    expect(fields({ rejected: [["five_hour", 100]], limited: true, ...input })).toEqual({});
  });

  it.each([
    ["no reason", {}],
    ["null reason", { terminal_reason: null }],
    ["api_error", { terminal_reason: "api_error" }],
    ["blocking_limit", { terminal_reason: "blocking_limit" }],
    ["a 429", { api_error_status: 429, terminal_reason: "api_error" }],
    ["a null status", { api_error_status: null }],
  ])("keeps the fields for %s", (_name, result) => {
    expect(fields({ rejected: [["five_hour", 100]], result })).toEqual({
      rateLimitResetAt: iso(100),
      rateLimitTypes: ["five_hour"],
    });
  });
});

const frame = (info: unknown) => ({ api_error_params: { rate_limit_info: info } });

describe("readAssistantRateLimitWindow", () => {
  it("reads a blocking window", () => {
    expect(
      readAssistantRateLimitWindow(
        frame({ status: "rejected", rateLimitType: "seven_day", resetsAt: 900 }),
      ),
    ).toEqual({ type: "seven_day", resetsAt: 900 });
    expect(readAssistantRateLimitWindow(frame({ status: "rejected" }))).toEqual({
      type: "unknown",
      resetsAt: null,
    });
  });

  it("ignores windows overage covers and malformed payloads", () => {
    for (const info of [
      { status: "allowed", rateLimitType: "seven_day", resetsAt: 900 },
      { status: "rejected", overageStatus: "allowed", resetsAt: 900 },
      { status: "rejected", overageInUse: true, resetsAt: 900 },
      {},
      3,
      null,
    ]) {
      expect(readAssistantRateLimitWindow(frame(info))).toBeUndefined();
    }
    for (const message of [
      undefined,
      {},
      { api_error_params: "text" },
      { api_error_params: null },
    ]) {
      expect(readAssistantRateLimitWindow(message)).toBeUndefined();
    }
  });
});

describe("claudeWritesUpdatesAsThinking", () => {
  it.each([
    ["claude-opus-5-5", true],
    ["claude-fable-5-1", true],
    ["claude-opus-5-5-20270101", true],
    ["claude-opus-6", true],
    ["us.anthropic.claude-sonnet-5-5-v1:0", true],
    ["claude-opus-5", false],
    ["claude-opus-5-20260101", false],
    ["claude-sonnet-4-6", false],
    ["claude-3-5-sonnet-20241022", false],
    ["<synthetic>", false],
  ])("%s -> %s", (model, expected) => {
    expect(claudeWritesUpdatesAsThinking(model)).toBe(expected);
  });
});

describe("claudeAuthFailureMessage", () => {
  it("keeps the plain login for the default directory", () => {
    expect(claudeAuthFailureMessage(undefined)).toBe(CLAUDE_AUTH_FAILURE_MESSAGE);
  });

  it("points a configured directory's login at that directory", () => {
    const message = claudeAuthFailureMessage("/accounts/work");
    expect(message).toContain("/accounts/work");
    expect(message).toContain("CLAUDE_CONFIG_DIR");
    expect(message).toContain("claude auth login");
  });
});

const pdfAt = (id: string) => ({
  type: "file" as const,
  id: `thread-pdf-attachment-${id}2345678-1234-1234-1234-123456789abc`,
  name: `${id}.pdf`,
  mimeType: "application/pdf" as const,
  sizeBytes: 5,
});

describe("buildUserMessageWithPdfBudgetEffect", () => {
  const image = {
    type: "image" as const,
    id: "thread-pdf-attachment-12345678-1234-1234-1234-123456789abc",
    name: "a.png",
    mimeType: "image/png",
    sizeBytes: 3,
  };

  const reservationFor = (documentIndexes: ReadonlyArray<number>) => {
    const calls: Array<{
      readonly textBytes: number;
      readonly imageBytes: ReadonlyArray<number>;
      readonly pdfCount: number;
    }> = [];
    let rollbacks = 0;
    const budget = {
      ...makeClaudeAttachmentBudget(),
      reserve: (input: {
        readonly textBytes: number;
        readonly imageBytes: ReadonlyArray<number>;
        readonly pdfs: ReadonlyArray<Uint8Array>;
      }) => {
        calls.push({
          textBytes: input.textBytes,
          imageBytes: input.imageBytes,
          pdfCount: input.pdfs.length,
        });
        return {
          documentIndexes: new Set(documentIndexes),
          commit: () => undefined,
          rollback: () => {
            rollbacks += 1;
          },
        };
      },
    };
    return { budget, calls, rollbacks: () => rollbacks };
  };
  const run = (
    attachmentsDir: string,
    attachments: ReadonlyArray<ChatAttachment>,
    budget: ClaudeAttachmentBudget,
  ) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        return yield* buildUserMessageWithPdfBudgetEffect(
          {
            threadId: ThreadId.makeUnsafe("thread-pdf"),
            input: "/review it",
            attachments: [...attachments],
          },
          { fileSystem, attachmentsDir, pdfBudget: budget },
        );
      }).pipe(Effect.provide(NodeServices.layer)),
    );
  const withDir = async (test: (dir: string) => Promise<void>) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "claude-pdf-message-"));
    try {
      await test(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const write = (dir: string, attachment: ChatAttachment, bytes: Uint8Array) =>
    writeFileSync(path.join(dir, attachmentRelativePath(attachment)), bytes);

  it("keeps attachment order, skips PDFs the budget refuses and ends on the text", () =>
    withDir(async (dir) => {
      const first = pdfAt("1");
      const second = pdfAt("2");
      write(dir, first, Buffer.from("%PDF-"));
      write(dir, image, Uint8Array.from([1, 2, 3]));
      write(dir, second, Buffer.from("%PDF-"));
      const { budget, calls } = reservationFor([1]);

      const { message } = await run(dir, [first, image, second], budget);

      const content = message.message.content as ReadonlyArray<{ readonly type: string }>;
      expect(content.map((block) => block.type)).toEqual(["image", "document", "text"]);
      expect(calls).toEqual([
        {
          textBytes: Buffer.byteLength(JSON.stringify({ type: "text", text: "/review it" })),
          imageBytes: [3],
          pdfCount: 2,
        },
      ]);
    }));

  it("leaves an unreadable or oversized PDF out of the reservation", () =>
    withDir(async (dir) => {
      const oversized = pdfAt("3");
      write(dir, oversized, Buffer.alloc(PROVIDER_SEND_TURN_MAX_FILE_BYTES + 1));
      const { budget, calls } = reservationFor([]);

      const { message } = await run(dir, [pdfAt("4"), oversized], budget);

      expect(calls[0]?.pdfCount).toBe(0);
      const content = message.message.content as ReadonlyArray<{ readonly type: string }>;
      expect(content.map((block) => block.type)).toEqual(["text"]);
    }));

  it("reserves nothing when an image cannot be read", () =>
    withDir(async (dir) => {
      const { budget, calls } = reservationFor([]);
      await expect(run(dir, [image], budget)).rejects.toThrow();
      expect(calls).toEqual([]);
    }));

  it("rolls the reservation back when the blocks cannot be built", () =>
    withDir(async (dir) => {
      const pdf = pdfAt("5");
      write(dir, pdf, Buffer.from("%PDF-"));
      const { budget, rollbacks } = reservationFor([]);
      const reserving = {
        ...budget,
        reserve: (input: Parameters<typeof budget.reserve>[0]) => {
          const reservation = budget.reserve(input);
          return {
            ...reservation,
            documentIndexes: {
              has: () => {
                throw new Error("boom");
              },
            } as unknown as ReadonlySet<number>,
          };
        },
      };
      await expect(run(dir, [pdf], reserving)).rejects.toThrow();
      expect(rollbacks()).toBe(1);
    }));
});
