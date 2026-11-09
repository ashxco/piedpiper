import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertSupportedCodexCliVersion,
  buildCodexApprovalResponse,
  evaluateCodexCliVersionCheck,
  codexSessionAllowanceKey,
  hasCodexSessionAllowance,
  hasCodexUserInputQuestions,
  isCodexRevertPlanSettled,
  planCodexThreadRevert,
  readCodexTurnsPage,
  readRequestedPermissionPaths,
  requestKindForMethod,
  shouldSuppressChildConversationNotification,
  shouldSuppressMemoryConsolidationMessage,
  toMcpElicitationResponse,
} from "./protocolHelpers";
import { supportsCodexApprovalsReviewer } from "../provider/codexCliVersion";

const tempDirs: string[] = [];

function makeFakeCodex(script: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "codex-version-check-"));
  tempDirs.push(dir);
  const binaryPath = path.join(dir, "codex");
  writeFileSync(binaryPath, `#!/bin/sh\n${script}\n`, "utf8");
  chmodSync(binaryPath, 0o755);
  return binaryPath;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("evaluateCodexCliVersionCheck", () => {
  it("reports a missing binary", () => {
    expect(() =>
      evaluateCodexCliVersionCheck("codex", {
        error: new Error("spawn codex ENOENT"),
        status: null,
        stdout: "",
        stderr: "",
      }),
    ).toThrow(
      "Could not start Codex CLI (`codex`). Check `providers.codex.binaryPath` in the server's settings.json. Installing the ChatGPT or Codex desktop app may not add codex to PATH.",
    );
  });

  it("reports a non-zero exit with stderr detail", () => {
    expect(() =>
      evaluateCodexCliVersionCheck("codex", { status: 2, stdout: "", stderr: "boom" }),
    ).toThrow("Codex CLI version check failed. boom");
  });

  it("rejects versions below the minimum", () => {
    expect(() =>
      evaluateCodexCliVersionCheck("codex", { status: 0, stdout: "codex-cli 0.36.0", stderr: "" }),
    ).toThrow("too old");
  });

  it("accepts supported versions", () => {
    expect(() =>
      evaluateCodexCliVersionCheck("codex", { status: 0, stdout: "codex-cli 0.99.0", stderr: "" }),
    ).not.toThrow();
  });

  it("returns the parsed version, or undefined when it cannot be read", () => {
    expect(
      evaluateCodexCliVersionCheck("codex", { status: 0, stdout: "codex-cli 0.124.0", stderr: "" }),
    ).toBe("0.124.0");
    expect(
      evaluateCodexCliVersionCheck("codex", { status: 0, stdout: "codex-cli", stderr: "" }),
    ).toBeUndefined();
  });
});

describe("supportsCodexApprovalsReviewer", () => {
  it("requires a known version of at least 0.124.0", () => {
    expect(supportsCodexApprovalsReviewer(undefined)).toBe(false);
    expect(supportsCodexApprovalsReviewer("0.123.9")).toBe(false);
    expect(supportsCodexApprovalsReviewer("0.124.0-alpha.1")).toBe(false);
    expect(supportsCodexApprovalsReviewer("0.124.0")).toBe(true);
    expect(supportsCodexApprovalsReviewer("0.166.0")).toBe(true);
  });
});

describe.skipIf(process.platform === "win32")("assertSupportedCodexCliVersion", () => {
  it("runs asynchronously without blocking the event loop", async () => {
    const binaryPath = makeFakeCodex('sleep 0.2\necho "codex-cli 0.99.0"');
    let ticked = false;
    const timer = setTimeout(() => {
      ticked = true;
    }, 10);
    const check = assertSupportedCodexCliVersion({ binaryPath, cwd: os.tmpdir() });
    expect(check).toBeInstanceOf(Promise);
    await check;
    clearTimeout(timer);
    expect(ticked).toBe(true);
  });

  it("rejects an unsupported version", async () => {
    const binaryPath = makeFakeCodex('echo "codex-cli 0.36.0"');
    await expect(assertSupportedCodexCliVersion({ binaryPath, cwd: os.tmpdir() })).rejects.toThrow(
      "too old",
    );
  });

  it("rejects a missing binary", async () => {
    await expect(
      assertSupportedCodexCliVersion({
        binaryPath: path.join(os.tmpdir(), "definitely-missing-codex-binary"),
        cwd: os.tmpdir(),
      }),
    ).rejects.toThrow("Make sure the configured executable exists and can be run.");
  });
});

describe("shouldSuppressMemoryConsolidationMessage", () => {
  it("suppresses memory consolidation threads but not other subagents", () => {
    const ids = new Set<string>();
    expect(
      shouldSuppressMemoryConsolidationMessage(ids, "thread/started", {
        thread: { id: "mem", threadSource: "memory_consolidation" },
      }),
    ).toBe(true);
    expect(
      shouldSuppressMemoryConsolidationMessage(ids, "thread/started", {
        thread: { id: "legacy-mem", source: { subAgent: "memory_consolidation" } },
      }),
    ).toBe(true);
    expect(
      shouldSuppressMemoryConsolidationMessage(ids, "thread/started", {
        thread: { id: "review", source: { subAgent: "review" } },
      }),
    ).toBe(false);
    expect(
      shouldSuppressMemoryConsolidationMessage(ids, "item/agentMessage/delta", {
        threadId: "mem",
        delta: "x",
      }),
    ).toBe(true);
    expect(
      shouldSuppressMemoryConsolidationMessage(ids, "serverRequest/resolved", {
        threadId: "mem",
        requestId: 1,
      }),
    ).toBe(false);
    expect(
      shouldSuppressMemoryConsolidationMessage(ids, "item/agentMessage/delta", {
        threadId: "root",
        delta: "x",
      }),
    ).toBe(false);
  });

  it("forgets a memory thread after it closes", () => {
    const ids = new Set<string>();
    shouldSuppressMemoryConsolidationMessage(ids, "thread/started", {
      thread: { id: "mem", threadSource: "memory_consolidation" },
    });
    expect(
      shouldSuppressMemoryConsolidationMessage(ids, "thread/closed", { threadId: "mem" }),
    ).toBe(true);
    expect(
      shouldSuppressMemoryConsolidationMessage(ids, "item/agentMessage/delta", { threadId: "mem" }),
    ).toBe(false);
  });
});

describe("requestKindForMethod", () => {
  it("classifies permission requests by the access they ask for", () => {
    const method = "item/permissions/requestApproval";
    expect(requestKindForMethod(method, { permissions: { fileSystem: { write: ["/a"] } } })).toBe(
      "file-change",
    );
    expect(requestKindForMethod(method, { permissions: { fileSystem: { read: ["/a"] } } })).toBe(
      "file-read",
    );
    const entries = (...list: Array<Record<string, unknown>>) => ({
      permissions: { fileSystem: { entries: list } },
    });
    expect(
      requestKindForMethod(
        method,
        entries(
          { access: "read", path: { type: "path", path: "/w/src" } },
          { access: "write", path: { type: "glob_pattern", pattern: "/w/out/**" } },
        ),
      ),
    ).toBe("file-change");
    expect(
      requestKindForMethod(
        method,
        entries({ access: "read", path: { type: "glob_pattern", pattern: "/w/docs/**" } }),
      ),
    ).toBe("file-read");
    // Classified by access even when the path cannot be described.
    expect(requestKindForMethod(method, entries({ access: "write", path: { type: "x" } }))).toBe(
      "file-change",
    );
    expect(requestKindForMethod(method, { permissions: { network: { enabled: true } } })).toBe(
      "command",
    );
    expect(requestKindForMethod("mcpServer/elicitation/request")).toBe("command");
    expect(requestKindForMethod("item/tool/call")).toBeUndefined();
  });
});

describe("readRequestedPermissionPaths", () => {
  it("describes path, glob, special and legacy string entries", () => {
    expect(
      readRequestedPermissionPaths({
        permissions: {
          fileSystem: {
            read: ["/legacy"],
            entries: [
              { access: "read", path: { type: "path", path: "/w/src" } },
              { access: "write", path: { type: "glob_pattern", pattern: "/w/out/**" } },
              { access: "write", path: { type: "special", value: { kind: "project_roots" } } },
              { access: "read", path: "/plain" },
            ],
          },
        },
      }),
    ).toEqual({
      read: ["/legacy", "/w/src", "/plain"],
      write: ["/w/out/**", '{"kind":"project_roots"}'],
      requestsRead: true,
      requestsWrite: true,
    });
  });
});

describe("toMcpElicitationResponse", () => {
  const form = {
    mode: "form",
    message: "Allow?",
    requestedSchema: {
      type: "object",
      properties: {
        choice: { type: "string", enum: ["allow_once", "allow_session", "deny"] },
      },
      required: ["choice"],
    },
  };

  it("passes decline and cancel through", () => {
    expect(toMcpElicitationResponse(form, "decline")).toEqual({ action: "decline" });
    expect(toMcpElicitationResponse(form, "cancel")).toEqual({ action: "cancel" });
  });

  it("fills the matching option for accept and accept-for-session", () => {
    expect(toMcpElicitationResponse(form, "accept")).toEqual({
      action: "accept",
      content: { choice: "allow_once" },
    });
    expect(toMcpElicitationResponse(form, "acceptForSession")).toEqual({
      action: "accept",
      _meta: { persist: "session" },
      content: { choice: "allow_session" },
    });
  });

  it("does not pick a negated option as the approval", () => {
    const negated = {
      mode: "form",
      requestedSchema: {
        properties: { choice: { type: "string", enum: ["disallow", "do_not_allow", "allow"] } },
        required: ["choice"],
      },
    };
    expect(toMcpElicitationResponse(negated, "accept")).toEqual({
      action: "accept",
      content: { choice: "allow" },
    });
  });

  it.each(["allow_once", "allow_this_time", "allow_once_only"])(
    "picks the one-time option %s over a broader grant listed first",
    (once) => {
      const ordered = {
        mode: "form",
        requestedSchema: {
          properties: { choice: { type: "string", enum: ["allow_all", once, "deny"] } },
          required: ["choice"],
        },
      };
      expect(toMcpElicitationResponse(ordered, "accept")).toEqual({
        action: "accept",
        content: { choice: once },
      });
    },
  );

  it("never accepts a broad grant as the one-time answer", () => {
    for (const options of [
      ["allow_all", "deny"],
      ["approve_all_tools", "deny"],
    ]) {
      expect(
        toMcpElicitationResponse(
          {
            mode: "form",
            requestedSchema: {
              properties: { choice: { type: "string", enum: options } },
              required: ["choice"],
            },
          },
          "accept",
        ),
      ).toEqual({ action: "decline" });
    }
  });

  it("declines url-mode and unfillable forms", () => {
    expect(toMcpElicitationResponse({ mode: "url" }, "accept")).toEqual({ action: "decline" });
    expect(
      toMcpElicitationResponse(
        {
          mode: "form",
          requestedSchema: { properties: { name: { type: "string" } }, required: ["name"] },
        },
        "accept",
      ),
    ).toEqual({ action: "decline" });
  });
});

describe("buildCodexApprovalResponse", () => {
  it("approves an elicitation once for accept-for-session when no session option exists", () => {
    const form = {
      mode: "form",
      requestedSchema: {
        properties: { decision: { type: "string", enum: ["allow", "deny"] } },
        required: ["decision"],
      },
    };
    expect(
      buildCodexApprovalResponse("mcpServer/elicitation/request", form, "acceptForSession"),
    ).toEqual({
      action: "accept",
      _meta: { persist: "session" },
      content: { decision: "allow" },
    });
    expect(
      buildCodexApprovalResponse(
        "mcpServer/elicitation/request",
        { mode: "url" },
        "acceptForSession",
      ),
    ).toEqual({ action: "decline" });
  });
});

const userTurn = (id: string) => ({ id, items: [{ type: "userMessage" }] });

const retryTurn = (id: string) => ({ id, items: [{ type: "agentMessage" }] });

describe("planCodexThreadRevert", () => {
  const newestFirst = [userTurn("t3"), userTurn("t2"), userTurn("t1")];

  it("rewinds to the turn that starts the removed range", () => {
    expect(planCodexThreadRevert(newestFirst, 1)).toEqual({ removedTurns: 1, beforeTurnId: "t3" });
    expect(planCodexThreadRevert(newestFirst, 2)).toEqual({ removedTurns: 2, beforeTurnId: "t2" });
  });

  it("removes everything when more turns are requested than exist", () => {
    expect(planCodexThreadRevert(newestFirst, 9)).toEqual({ removedTurns: 3, beforeTurnId: "t1" });
  });

  it("has nothing to rewind in an empty history", () => {
    expect(planCodexThreadRevert([], 1)).toEqual({ removedTurns: 0 });
  });

  it("removes retry turns together with the user turn they continue", () => {
    const turns = [retryTurn("r2"), { id: "r1", items: [] }, userTurn("t2"), userTurn("t1")];
    expect(planCodexThreadRevert(turns, 1)).toEqual({ removedTurns: 3, beforeTurnId: "t2" });
  });

  it("removes a goal's later turns with the user turn they continue", () => {
    const turns = [
      { id: "g2", status: "completed", items: [{ type: "agentMessage" }] },
      { id: "g1", status: "completed", items: [{ type: "userMessage" }] },
      userTurn("t2"),
      userTurn("t1"),
    ];
    expect(planCodexThreadRevert(turns, 1, { retryTurnIds: new Set(["g2", "g1"]) })).toEqual({
      removedTurns: 3,
      beforeTurnId: "t2",
    });
  });

  it("counts a goal's first turn as its own, though it has no user message", () => {
    const turns = [
      { id: "resumed", status: "completed", items: [{ type: "agentMessage" }] },
      userTurn("t1"),
    ];
    expect(planCodexThreadRevert(turns, 1, { goalTurnIds: new Set(["resumed"]) })).toEqual({
      removedTurns: 1,
      beforeTurnId: "resumed",
    });
  });

  it("counts raw turns when the listing shows no user messages to go by", () => {
    const notLoaded = [
      { id: "t2", items: [], itemsView: "notLoaded" },
      { id: "t1", items: [], itemsView: "notLoaded" },
    ];
    expect(planCodexThreadRevert(notLoaded, 1)).toEqual({ removedTurns: 1, beforeTurnId: "t2" });
    expect(
      planCodexThreadRevert(
        [
          { id: "t2", items: [] },
          { id: "t1", items: [] },
        ],
        1,
      ),
    ).toEqual({
      removedTurns: 1,
      beforeTurnId: "t2",
    });
  });
});

describe("planCodexThreadRevert with compactions", () => {
  // Checked on CLI 0.166: a summary listing shows a compaction as a turn with no items.
  const compaction = { id: "c", items: [], status: "completed" };
  const turns = [userTurn("u3"), compaction, userTurn("u2"), userTurn("u1")];

  it.each([
    { numTurns: 1, removedTurns: 1, beforeTurnId: "u3" },
    { numTurns: 2, removedTurns: 2, beforeTurnId: "c" },
    { numTurns: 3, removedTurns: 3, beforeTurnId: "u2" },
  ])("counts a compaction as its own turn for $numTurns", ({ numTurns, ...plan }) => {
    expect(planCodexThreadRevert(turns, numTurns)).toEqual(plan);
  });

  it("removes only the compaction when that is the newest turn", () => {
    expect(planCodexThreadRevert([compaction, userTurn("u2"), userTurn("u1")], 1)).toEqual({
      removedTurns: 1,
      beforeTurnId: "c",
    });
  });

  it("recognizes the compaction item in a full listing", () => {
    const full = { id: "c", items: [{ type: "contextCompaction" }] };
    expect(planCodexThreadRevert([full, userTurn("u1")], 1)).toEqual({
      removedTurns: 1,
      beforeTurnId: "c",
    });
  });

  it("tells a failed compaction from a failed retry by the turn before it", () => {
    const failedRetry = { id: "r", items: [], status: "failed" };
    const failedUser = { ...userTurn("u2"), status: "failed" };
    expect(planCodexThreadRevert([failedRetry, failedUser, userTurn("u1")], 1)).toEqual({
      removedTurns: 2,
      beforeTurnId: "u2",
    });
    const failedCompaction = { id: "c", items: [], status: "failed" };
    const finishedUser = { ...userTurn("u1"), status: "completed" };
    expect(planCodexThreadRevert([failedCompaction, finishedUser], 1)).toEqual({
      removedTurns: 1,
      beforeTurnId: "c",
    });
  });

  it("trusts what this session saw over what a listing suggests", () => {
    const silentRetry = { id: "r", items: [], status: "completed" };
    const failedUser = { ...userTurn("u2"), status: "failed" };
    expect(
      planCodexThreadRevert([silentRetry, failedUser], 1, { retryTurnIds: new Set(["r"]) }),
    ).toEqual({ removedTurns: 2, beforeTurnId: "u2" });
    const failedCompaction = { id: "c", items: [], status: "failed" };
    expect(
      planCodexThreadRevert([failedCompaction, failedUser], 1, {
        compactionTurnIds: new Set(["c"]),
      }),
    ).toEqual({ removedTurns: 1, beforeTurnId: "c" });
  });
});

describe("isCodexRevertPlanSettled", () => {
  it("settles once the target turn is on a listed page", () => {
    const turns = [userTurn("t3"), userTurn("t2")];
    expect(isCodexRevertPlanSettled(turns, 2)).toBe(true);
    expect(isCodexRevertPlanSettled(turns, 3)).toBe(false);
  });

  it("keeps paging while no turn shows a user message to count by", () => {
    expect(isCodexRevertPlanSettled([{ id: "r", items: [{ type: "agentMessage" }] }], 1)).toBe(
      false,
    );
  });

  it("settles on raw counts when items were not loaded", () => {
    const notLoaded = { id: "t", items: [], itemsView: "notLoaded" };
    expect(isCodexRevertPlanSettled([notLoaded], 1)).toBe(true);
  });
});

describe("hasCodexSessionAllowance", () => {
  const plain = { threadId: "conv" };
  const escalated = { threadId: "conv", reason: "needs write" };

  it("does not let a plain grant cover an escalated request", () => {
    const allowed = new Set([codexSessionAllowanceKey("command", plain)]);
    expect(hasCodexSessionAllowance(allowed, "command", plain)).toBe(true);
    expect(hasCodexSessionAllowance(allowed, "command", escalated)).toBe(false);
    expect(hasCodexSessionAllowance(allowed, "command", { threadId: "other" })).toBe(false);
    expect(hasCodexSessionAllowance(allowed, "file-change", plain)).toBe(false);
    expect(hasCodexSessionAllowance(undefined, "command", plain)).toBe(false);
  });

  it("lets an escalated grant cover both", () => {
    const allowed = new Set([codexSessionAllowanceKey("command", escalated)]);
    expect(hasCodexSessionAllowance(allowed, "command", escalated)).toBe(true);
    expect(hasCodexSessionAllowance(allowed, "command", plain)).toBe(true);
  });
});

describe("shouldSuppressChildConversationNotification", () => {
  it.each([
    "item/reasoning/summaryTextDelta",
    "item/reasoning/summaryPartAdded",
    "item/reasoning/textDelta",
  ])("drops a subagent's %s", (method) => {
    expect(shouldSuppressChildConversationNotification(method)).toBe(true);
  });

  it("drops a subagent's reasoning items but keeps its other items", () => {
    const reasoning = { item: { type: "reasoning", id: "r" } };
    const command = { item: { type: "commandExecution", id: "c" } };
    expect(shouldSuppressChildConversationNotification("item/started", reasoning)).toBe(true);
    expect(shouldSuppressChildConversationNotification("item/completed", reasoning)).toBe(true);
    expect(shouldSuppressChildConversationNotification("item/started", command)).toBe(false);
  });
});

describe("readCodexTurnsPage", () => {
  it("reads turns and treats a null or missing cursor as the last page", () => {
    expect(
      readCodexTurnsPage({
        data: [{ id: "t1", items: [{ type: "userMessage" }], itemsView: "summary" }, { items: [] }],
        nextCursor: "next",
      }),
    ).toEqual({
      turns: [{ id: "t1", items: [{ type: "userMessage" }], itemsView: "summary" }],
      nextCursor: "next",
    });
    expect(readCodexTurnsPage({ data: [], nextCursor: null }).nextCursor).toBeNull();
    expect(readCodexTurnsPage({ data: [] }).nextCursor).toBeNull();
  });

  it("rejects a response without turns", () => {
    expect(() => readCodexTurnsPage({ thread: {} })).toThrow(/did not include turns/);
  });
});

describe("hasCodexUserInputQuestions", () => {
  it("needs an array with at least one object", () => {
    expect(hasCodexUserInputQuestions({ questions: [{}] })).toBe(true);
    expect(hasCodexUserInputQuestions({ questions: [null, { id: "a" }] })).toBe(true);
    expect(hasCodexUserInputQuestions({ questions: [] })).toBe(false);
    expect(hasCodexUserInputQuestions({ questions: [null, "text"] })).toBe(false);
    expect(hasCodexUserInputQuestions({ questions: "text" })).toBe(false);
    expect(hasCodexUserInputQuestions({ questions: { id: "a" } })).toBe(false);
    expect(hasCodexUserInputQuestions({})).toBe(false);
    expect(hasCodexUserInputQuestions(undefined)).toBe(false);
  });
});
