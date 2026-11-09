import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { PassThrough } from "node:stream";
import { ApprovalRequestId, ThreadId, TurnId } from "@piedpiper/contracts";

import {
  buildCodexInitializeParams,
  CodexAppServerManager,
  classifyCodexStderrLine,
  CODEX_THREAD_IN_USE_MESSAGE,
  isArchivedThreadError,
  isRecoverableThreadResumeError,
  normalizeCodexModelSlug,
  readCodexAccountSnapshot,
  resolveCodexModelForAccount,
} from "./codexAppServerManager";
import * as protocolHelpers from "./codex/protocolHelpers";
import type { CodexSessionContext } from "./codex/sessionState";
import { appendCodexStderrTail, codexStderrExcerpt } from "./codex/parsing";

const noop = (): void => undefined;

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  spawnMock.mockImplementation(actual.spawn);
  return { ...actual, spawn: spawnMock };
});

const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);

function createSendTurnHarness() {
  const manager = new CodexAppServerManager();
  const context = {
    session: {
      provider: "codex",
      status: "ready",
      threadId: "thread_1",
      runtimeMode: "full-access",
      model: "gpt-5.3-codex",
      resumeCursor: { threadId: "thread_1" },
      createdAt: "2026-02-10T00:00:00.000Z",
      updatedAt: "2026-02-10T00:00:00.000Z",
    },
    account: {
      type: "unknown",
      planType: null,
      sparkEnabled: true,
    },
    collabReceiverTurns: new Map(),
  };

  const requireSession = vi
    .spyOn(
      manager as unknown as { requireSession: (sessionId: string) => unknown },
      "requireSession",
    )
    .mockReturnValue(context);
  const sendRequest = vi
    .spyOn(
      manager as unknown as { sendRequest: (...args: unknown[]) => Promise<unknown> },
      "sendRequest",
    )
    .mockResolvedValue({
      turn: {
        id: "turn_1",
      },
    });
  const updateSession = vi
    .spyOn(manager as unknown as { updateSession: (...args: unknown[]) => void }, "updateSession")
    .mockImplementation(() => {});

  return { manager, context, requireSession, sendRequest, updateSession };
}

function createThreadControlHarness() {
  const manager = new CodexAppServerManager();
  const context = {
    session: {
      provider: "codex",
      status: "ready",
      threadId: "thread_1",
      runtimeMode: "full-access",
      model: "gpt-5.3-codex",
      resumeCursor: { threadId: "thread_1" },
      createdAt: "2026-02-10T00:00:00.000Z",
      updatedAt: "2026-02-10T00:00:00.000Z",
    },
    collabReceiverTurns: new Map(),
  };

  const requireSession = vi
    .spyOn(
      manager as unknown as { requireSession: (sessionId: string) => unknown },
      "requireSession",
    )
    .mockReturnValue(context);
  const sendRequest = vi.spyOn(
    manager as unknown as { sendRequest: (...args: unknown[]) => Promise<unknown> },
    "sendRequest",
  );
  const updateSession = vi
    .spyOn(manager as unknown as { updateSession: (...args: unknown[]) => void }, "updateSession")
    .mockImplementation(() => {});

  return { manager, context, requireSession, sendRequest, updateSession };
}

function createPendingUserInputHarness() {
  const manager = new CodexAppServerManager();
  const context = {
    session: {
      provider: "codex",
      status: "ready",
      threadId: "thread_1",
      runtimeMode: "full-access",
      model: "gpt-5.3-codex",
      resumeCursor: { threadId: "thread_1" },
      createdAt: "2026-02-10T00:00:00.000Z",
      updatedAt: "2026-02-10T00:00:00.000Z",
    },
    pendingUserInputs: new Map([
      [
        ApprovalRequestId.makeUnsafe("req-user-input-1"),
        {
          requestId: ApprovalRequestId.makeUnsafe("req-user-input-1"),
          jsonRpcId: 42,
          threadId: asThreadId("thread_1"),
        },
      ],
    ]),
    collabReceiverTurns: new Map(),
  };

  const requireSession = vi
    .spyOn(
      manager as unknown as { requireSession: (sessionId: string) => unknown },
      "requireSession",
    )
    .mockReturnValue(context);
  const writeMessage = vi
    .spyOn(manager as unknown as { writeMessage: (...args: unknown[]) => void }, "writeMessage")
    .mockImplementation(() => {});
  const emitEvent = vi
    .spyOn(manager as unknown as { emitEvent: (...args: unknown[]) => void }, "emitEvent")
    .mockImplementation(() => {});

  return { manager, context, requireSession, writeMessage, emitEvent };
}

function createCollabNotificationHarness() {
  const manager = new CodexAppServerManager();
  const context = {
    session: {
      provider: "codex",
      status: "running",
      threadId: asThreadId("thread_1"),
      runtimeMode: "full-access",
      model: "gpt-5.3-codex",
      activeTurnId: "turn_parent",
      resumeCursor: { threadId: "provider_parent" },
      createdAt: "2026-02-10T00:00:00.000Z",
      updatedAt: "2026-02-10T00:00:00.000Z",
    },
    account: {
      type: "unknown",
      planType: null,
      sparkEnabled: true,
    },
    pending: new Map(),
    pendingApprovals: new Map(),
    pendingUserInputs: new Map(),
    collabReceiverTurns: new Map<string, string>(),
    nextRequestId: 1,
    stopping: false,
  };

  const emitEvent = vi
    .spyOn(manager as unknown as { emitEvent: (...args: unknown[]) => void }, "emitEvent")
    .mockImplementation(() => {});
  const updateSession = vi
    .spyOn(manager as unknown as { updateSession: (...args: unknown[]) => void }, "updateSession")
    .mockImplementation(() => {});

  return { manager, context, emitEvent, updateSession };
}

interface FakeChild extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  killed: boolean;
  pid: number;
  kill: () => boolean;
}

function createFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.pid = 4242;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  return child;
}

type ManagerInternals = {
  sessions: Map<ThreadId, unknown>;
  attachProcessListeners: (context: unknown) => void;
  sendRequest: (context: unknown, method: string, params: unknown) => Promise<unknown>;
};

function createProcessHarness(threadId = "thread_1") {
  const manager = new CodexAppServerManager();
  const child = createFakeChild();
  const context = {
    session: {
      provider: "codex",
      status: "ready",
      threadId: asThreadId(threadId),
      runtimeMode: "full-access",
      model: "gpt-5.3-codex",
      resumeCursor: { threadId: "provider_1" },
      createdAt: "2026-02-10T00:00:00.000Z",
      updatedAt: "2026-02-10T00:00:00.000Z",
    },
    account: { type: "unknown", planType: null, sparkEnabled: true },
    child,
    output: readline.createInterface({ input: child.stdout }),
    pending: new Map(),
    pendingApprovals: new Map(),
    pendingUserInputs: new Map(),
    collabReceiverTurns: new Map(),
    nextRequestId: 1,
    stopping: false,
  };
  const internals = manager as unknown as ManagerInternals;
  internals.sessions.set(asThreadId(threadId), context);
  internals.attachProcessListeners(context);
  const events: Array<{ method: string; kind: string; message?: string }> = [];
  manager.on("event", (event) => {
    events.push({
      method: event.method,
      kind: event.kind,
      ...(event.message ? { message: event.message } : {}),
    });
  });
  return { manager, internals, child, context, events };
}

describe("classifyCodexStderrLine", () => {
  it("ignores empty lines", () => {
    expect(classifyCodexStderrLine("   ")).toBeNull();
  });

  it("ignores non-error structured codex logs", () => {
    const line =
      "2026-02-08T04:24:19.241256Z  WARN codex_core::features: unknown feature key in config: skills";
    expect(classifyCodexStderrLine(line)).toBeNull();
  });

  it("ignores known benign rollout path errors", () => {
    const line =
      "\u001b[2m2026-02-08T04:24:20.085687Z\u001b[0m \u001b[31mERROR\u001b[0m \u001b[2mcodex_core::rollout::list\u001b[0m: state db missing rollout path for thread 019c3b6c-46b8-7b70-ad23-82f824d161fb";
    expect(classifyCodexStderrLine(line)).toBeNull();
  });

  it("keeps unknown structured errors", () => {
    const line = "2026-02-08T04:24:20.085687Z ERROR codex_core::runtime: unrecoverable failure";
    expect(classifyCodexStderrLine(line)).toEqual({
      message: line,
    });
  });

  it("keeps plain stderr messages", () => {
    const line = "fatal: permission denied";
    expect(classifyCodexStderrLine(line)).toEqual({
      message: line,
    });
  });
});

describe("codexStderrExcerpt", () => {
  it("prefers the last error-looking line over trailing stack frames", () => {
    const tail = [
      "file:///x/codex.js:12",
      "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'x'",
      "    at packageResolve (node:internal/modules/esm/resolve:1)",
    ].join("\n");
    expect(codexStderrExcerpt(tail)).toBe("Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'x'");
    expect(codexStderrExcerpt("loading config\nfatal: bad config.toml\nbye")).toBe(
      "fatal: bad config.toml",
    );
  });

  it("falls back to the last non-empty line and ignores blank output", () => {
    expect(codexStderrExcerpt("starting\n  killed by OOM  \n\n")).toBe("killed by OOM");
    expect(codexStderrExcerpt("\n \n")).toBeUndefined();
  });

  it("caps the stored tail and the excerpt length", () => {
    const tail = appendCodexStderrTail("a".repeat(8_000), "b".repeat(500));
    expect(tail).toHaveLength(8_192);
    expect(tail.endsWith("b".repeat(500))).toBe(true);
    expect(codexStderrExcerpt(`Error: ${"x".repeat(1_000)}`)).toHaveLength(512);
  });
});

describe("process stderr events", () => {
  it("emits classified stderr lines as notifications", () => {
    const manager = new CodexAppServerManager();
    const emitEvent = vi
      .spyOn(manager as unknown as { emitEvent: (...args: unknown[]) => void }, "emitEvent")
      .mockImplementation(() => {});

    (
      manager as unknown as {
        emitNotificationEvent: (
          context: { session: { threadId: ThreadId } },
          method: string,
          message: string,
        ) => void;
      }
    ).emitNotificationEvent(
      {
        session: {
          threadId: asThreadId("thread-1"),
        },
      },
      "process/stderr",
      "fatal: permission denied",
    );

    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "notification",
        method: "process/stderr",
        threadId: "thread-1",
        message: "fatal: permission denied",
      }),
    );
  });
});

describe("normalizeCodexModelSlug", () => {
  it("maps 5.3 aliases to gpt-5.3-codex", () => {
    expect(normalizeCodexModelSlug("5.3")).toBe("gpt-5.3-codex");
    expect(normalizeCodexModelSlug("gpt-5.3")).toBe("gpt-5.3-codex");
  });

  it("prefers codex id when model differs", () => {
    expect(normalizeCodexModelSlug("gpt-5.3", "gpt-5.3-codex")).toBe("gpt-5.3-codex");
  });

  it("keeps non-aliased models as-is", () => {
    expect(normalizeCodexModelSlug("gpt-5.2-codex")).toBe("gpt-5.2-codex");
    expect(normalizeCodexModelSlug("gpt-5.2")).toBe("gpt-5.2");
  });
});

describe("isRecoverableThreadResumeError", () => {
  it("matches not-found resume errors", () => {
    expect(
      isRecoverableThreadResumeError(new Error("thread/resume failed: thread not found")),
    ).toBe(true);
  });

  it("matches a missing rollout for a known thread id", () => {
    expect(
      isRecoverableThreadResumeError(
        new Error(
          "thread/resume failed: no rollout found for thread id 019fdf74-aaa9-7950-b252-7cc7a8650470",
        ),
      ),
    ).toBe(true);
  });

  it("ignores non-resume errors", () => {
    expect(
      isRecoverableThreadResumeError(new Error("thread/start failed: permission denied")),
    ).toBe(false);
  });

  it("does not treat archived or active-writer resume errors as recoverable", () => {
    expect(
      isRecoverableThreadResumeError(
        new Error("thread/resume failed: session abc is archived; rollout not found in sessions"),
      ),
    ).toBe(false);
    expect(
      isRecoverableThreadResumeError(
        new Error("thread/resume failed: thread abc not found: already has an active writer"),
      ),
    ).toBe(false);
  });

  it("ignores non-recoverable resume errors", () => {
    expect(
      isRecoverableThreadResumeError(
        new Error("thread/resume failed: timed out waiting for server"),
      ),
    ).toBe(false);
  });
});

describe("isArchivedThreadError", () => {
  it("matches Codex archived-session errors", () => {
    expect(isArchivedThreadError(new Error("thread/resume failed: session abc is archived"))).toBe(
      true,
    );
    expect(isArchivedThreadError("run `codex unarchive abc` first")).toBe(true);
    expect(isArchivedThreadError(new Error("thread/resume failed: thread not found"))).toBe(false);
  });
});

describe("readCodexAccountSnapshot", () => {
  it("disables spark for chatgpt plus accounts", () => {
    expect(
      readCodexAccountSnapshot({
        type: "chatgpt",
        email: "plus@example.com",
        planType: "plus",
      }),
    ).toEqual({
      type: "chatgpt",
      planType: "plus",
      sparkEnabled: false,
    });
  });

  it("keeps spark enabled for chatgpt pro accounts", () => {
    expect(
      readCodexAccountSnapshot({
        type: "chatgpt",
        email: "pro@example.com",
        planType: "pro",
      }),
    ).toEqual({
      type: "chatgpt",
      planType: "pro",
      sparkEnabled: true,
    });
  });

  it("disables spark for api key accounts", () => {
    expect(
      readCodexAccountSnapshot({
        type: "apiKey",
      }),
    ).toEqual({
      type: "apiKey",
      planType: null,
      sparkEnabled: false,
    });
  });

  it("disables spark for unknown chatgpt plans", () => {
    expect(
      readCodexAccountSnapshot({
        type: "chatgpt",
        email: "unknown@example.com",
      }),
    ).toEqual({
      type: "chatgpt",
      planType: "unknown",
      sparkEnabled: false,
    });
  });
});

describe("resolveCodexModelForAccount", () => {
  it("falls back from spark to default for unsupported chatgpt plans", () => {
    expect(
      resolveCodexModelForAccount("gpt-5.3-codex-spark", {
        type: "chatgpt",
        planType: "plus",
        sparkEnabled: false,
      }),
    ).toBe("gpt-5.3-codex");
  });

  it("keeps spark for supported plans", () => {
    expect(
      resolveCodexModelForAccount("gpt-5.3-codex-spark", {
        type: "chatgpt",
        planType: "pro",
        sparkEnabled: true,
      }),
    ).toBe("gpt-5.3-codex-spark");
  });

  it("falls back from spark to default for api key auth", () => {
    expect(
      resolveCodexModelForAccount("gpt-5.3-codex-spark", {
        type: "apiKey",
        planType: null,
        sparkEnabled: false,
      }),
    ).toBe("gpt-5.3-codex");
  });
});

describe("startSession", () => {
  it("enables Codex experimental api capabilities during initialize", () => {
    expect(buildCodexInitializeParams()).toEqual({
      clientInfo: {
        name: "piedpiper_desktop",
        title: "Pied Piper Desktop",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: ["turn/diff/updated"],
      },
    });
  });

  it("emits session/startFailed when resolving cwd throws before process launch", async () => {
    const manager = new CodexAppServerManager();
    const events: Array<{ method: string; kind: string; message?: string }> = [];
    manager.on("event", (event) => {
      events.push({
        method: event.method,
        kind: event.kind,
        ...(event.message ? { message: event.message } : {}),
      });
    });

    const processCwd = vi.spyOn(process, "cwd").mockImplementation(() => {
      throw new Error("cwd missing");
    });
    try {
      await expect(
        manager.startSession({
          threadId: asThreadId("thread-1"),
          provider: "codex",
          binaryPath: "codex",
          runtimeMode: "full-access",
        }),
      ).rejects.toThrow("cwd missing");
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        method: "session/startFailed",
        kind: "error",
        message: "cwd missing",
      });
    } finally {
      processCwd.mockRestore();
      manager.stopAll();
    }
  });

  it("fails fast with an upgrade message when codex is below the minimum supported version", async () => {
    const manager = new CodexAppServerManager();
    const events: Array<{ method: string; kind: string; message?: string }> = [];
    manager.on("event", (event) => {
      events.push({
        method: event.method,
        kind: event.kind,
        ...(event.message ? { message: event.message } : {}),
      });
    });

    const versionCheck = vi
      .spyOn(protocolHelpers, "assertSupportedCodexCliVersion")
      .mockImplementation(() => {
        throw new Error(
          "Codex CLI v0.36.0 is too old for Pied Piper. Upgrade to v0.37.0 or newer and restart Pied Piper.",
        );
      });

    try {
      await expect(
        manager.startSession({
          threadId: asThreadId("thread-1"),
          provider: "codex",
          binaryPath: "codex",
          runtimeMode: "full-access",
        }),
      ).rejects.toThrow(
        "Codex CLI v0.36.0 is too old for Pied Piper. Upgrade to v0.37.0 or newer and restart Pied Piper.",
      );
      expect(versionCheck).toHaveBeenCalledTimes(1);
      expect(events).toEqual([
        {
          method: "session/startFailed",
          kind: "error",
          message:
            "Codex CLI v0.36.0 is too old for Pied Piper. Upgrade to v0.37.0 or newer and restart Pied Piper.",
        },
      ]);
    } finally {
      versionCheck.mockRestore();
      manager.stopAll();
    }
  });

  it("disposes an existing session before starting a replacement for the same thread", async () => {
    const manager = new CodexAppServerManager();
    const existingContext = {
      session: {
        provider: "codex",
        status: "ready",
        threadId: asThreadId("thread-1"),
        runtimeMode: "full-access",
        createdAt: "2026-02-10T00:00:00.000Z",
        updatedAt: "2026-02-10T00:00:00.000Z",
      },
    };
    const internals = manager as unknown as ManagerInternals & {
      disposeSession: (context: unknown, options?: { emitLifecycleEvent?: boolean }) => void;
    };
    internals.sessions.set(asThreadId("thread-1"), existingContext);

    const disposeSession = vi.spyOn(internals, "disposeSession").mockImplementation(() => {});
    const processCwd = vi.spyOn(process, "cwd").mockImplementation(() => {
      throw new Error("cwd missing");
    });

    try {
      await expect(
        manager.startSession({
          threadId: asThreadId("thread-1"),
          provider: "codex",
          binaryPath: "codex",
          runtimeMode: "full-access",
        }),
      ).rejects.toThrow("cwd missing");

      expect(disposeSession).toHaveBeenCalledWith(existingContext, { emitLifecycleEvent: false });
    } finally {
      disposeSession.mockRestore();
      processCwd.mockRestore();
      internals.sessions.clear();
    }
  });

  it("continues the replacement start when disposing the existing session fails", async () => {
    const manager = new CodexAppServerManager();
    const existingContext = { session: { threadId: asThreadId("thread-1"), status: "ready" } };
    const internals = manager as unknown as ManagerInternals & {
      disposeSession: (context: unknown, options?: { emitLifecycleEvent?: boolean }) => void;
    };
    internals.sessions.set(asThreadId("thread-1"), existingContext);

    const disposeSession = vi.spyOn(internals, "disposeSession").mockImplementation(() => {
      throw new Error("dispose failed");
    });
    const processCwd = vi.spyOn(process, "cwd").mockImplementation(() => {
      throw new Error("cwd missing");
    });

    try {
      await expect(
        manager.startSession({
          threadId: asThreadId("thread-1"),
          provider: "codex",
          binaryPath: "codex",
          runtimeMode: "full-access",
        }),
      ).rejects.toThrow("cwd missing");
      expect(disposeSession).toHaveBeenCalledTimes(1);
    } finally {
      disposeSession.mockRestore();
      processCwd.mockRestore();
      internals.sessions.clear();
    }
  });

  it("keeps an overlapping replacement start alive when the superseded start fails", async () => {
    const manager = new CodexAppServerManager();
    const internals = manager as unknown as ManagerInternals;
    const events: Array<{ method: string; kind: string; message?: string }> = [];
    manager.on("event", (event) => {
      events.push({
        method: event.method,
        kind: event.kind,
        ...(event.message ? { message: event.message } : {}),
      });
    });
    const secondChild = createFakeChild();
    spawnMock.mockClear();
    spawnMock.mockReturnValueOnce(secondChild);
    const versionCheck = vi
      .spyOn(protocolHelpers, "assertSupportedCodexCliVersion")
      .mockResolvedValue(undefined);
    const threadId = asThreadId("thread-1");
    const startInput = {
      threadId,
      provider: "codex" as const,
      binaryPath: "codex",
      runtimeMode: "full-access" as const,
      cwd: os.tmpdir(),
    };

    try {
      const firstStart = manager.startSession(startInput);
      const firstStartResult = firstStart.catch((error: unknown) => error);
      const secondStart = manager.startSession(startInput);
      const secondStartResult = secondStart.catch((error: unknown) => error);

      await vi.waitFor(() => {
        expect((internals.sessions.get(threadId) as { child?: unknown })?.child).toBe(secondChild);
      });
      // The superseded start is cancelled during its version check, before it spawns anything.
      expect(String(await firstStartResult)).toContain(
        "Codex session was stopped before it became ready.",
      );
      expect(spawnMock).toHaveBeenCalledTimes(1);

      expect(secondChild.killed).toBe(false);
      expect((internals.sessions.get(threadId) as { child?: unknown })?.child).toBe(secondChild);
      expect(events.map((event) => event.method)).not.toContain("session/startFailed");
      expect(events.map((event) => event.method)).not.toContain("session/closed");
      expect(events.map((event) => event.method)).not.toContain("session/exited");

      manager.stopSession(threadId);
      expect(String(await secondStartResult)).toContain("initialize failed");
    } finally {
      versionCheck.mockRestore();
      manager.stopAll();
    }
  });

  it("does not spawn app-server when the session is stopped during the version check", async () => {
    const manager = new CodexAppServerManager();
    const events: Array<{ method: string; kind: string }> = [];
    manager.on("event", (event) => {
      events.push({ method: event.method, kind: event.kind });
    });
    let finishVersionCheck: () => void = () => {};
    const versionCheck = vi
      .spyOn(protocolHelpers, "assertSupportedCodexCliVersion")
      .mockImplementation(
        () =>
          new Promise<string | undefined>((resolve) => {
            finishVersionCheck = () => resolve(undefined);
          }),
      );
    spawnMock.mockClear();
    const threadId = asThreadId("thread-1");

    try {
      for (const stop of [() => manager.stopSession(threadId), () => manager.stopAll()]) {
        const start = manager.startSession({
          threadId,
          provider: "codex",
          binaryPath: "codex",
          runtimeMode: "full-access",
          cwd: os.tmpdir(),
        });
        await vi.waitFor(() => expect(versionCheck).toHaveBeenCalled());
        versionCheck.mockClear();
        stop();
        finishVersionCheck();

        await expect(start).rejects.toThrow("Codex session was stopped before it became ready.");
      }
      expect(spawnMock).not.toHaveBeenCalled();
      expect(manager.hasSession(threadId)).toBe(false);
      expect(events.map((event) => event.method)).not.toContain("session/startFailed");
    } finally {
      versionCheck.mockRestore();
      manager.stopAll();
    }
  });

  it.each([
    ["an explicit Standard", { serviceTier: null }, null],
    ["a catalog tier", { serviceTier: "ultrafast" }, "ultrafast"],
    ["no tier", {}, undefined],
  ])("sends %s with thread/start and thread/resume", async (_label, tierInput, expected) => {
    const manager = new CodexAppServerManager();
    const versionCheck = vi
      .spyOn(protocolHelpers, "assertSupportedCodexCliVersion")
      .mockResolvedValue(undefined);
    const threadOpens: Array<{ method: string; params: Record<string, unknown> }> = [];
    const spawnRespondingChild = () => {
      const child = createFakeChild();
      readline.createInterface({ input: child.stdin }).on("line", (line) => {
        const message = JSON.parse(line) as {
          id?: number;
          method?: string;
          params?: Record<string, unknown>;
        };
        if (message.id === undefined || !message.method) return;
        if (message.method.startsWith("thread/")) {
          threadOpens.push({ method: message.method, params: message.params ?? {} });
        }
        const result = message.method.startsWith("thread/")
          ? { thread: { id: "provider-thread" } }
          : {};
        child.stdout.write(`${JSON.stringify({ id: message.id, result })}\n`);
      });
      return child;
    };
    spawnMock.mockImplementationOnce(spawnRespondingChild);
    spawnMock.mockImplementationOnce(spawnRespondingChild);
    const startInput = {
      threadId: asThreadId("thread-1"),
      provider: "codex" as const,
      binaryPath: "codex",
      runtimeMode: "full-access" as const,
      cwd: os.tmpdir(),
      ...tierInput,
    };

    try {
      const session = await manager.startSession(startInput);
      manager.stopSession(session.threadId);
      await manager.startSession({ ...startInput, resumeCursor: session.resumeCursor });

      expect(threadOpens.map((open) => open.method)).toEqual(["thread/start", "thread/resume"]);
      for (const open of threadOpens) {
        expect("serviceTier" in open.params).toBe(expected !== undefined);
        expect(open.params.serviceTier).toBe(expected);
      }
    } finally {
      versionCheck.mockRestore();
      manager.stopAll();
    }
  });

  it("sends the thread config with thread/start and thread/resume", async () => {
    const manager = new CodexAppServerManager();
    const versionCheck = vi
      .spyOn(protocolHelpers, "assertSupportedCodexCliVersion")
      .mockResolvedValue(undefined);
    const threadOpens: Array<{ method: string; params: Record<string, unknown> }> = [];
    const spawnRespondingChild = () => {
      const child = createFakeChild();
      readline.createInterface({ input: child.stdin }).on("line", (line) => {
        const message = JSON.parse(line) as {
          id?: number;
          method?: string;
          params?: Record<string, unknown>;
        };
        if (message.id === undefined || !message.method) return;
        if (message.method.startsWith("thread/")) {
          threadOpens.push({ method: message.method, params: message.params ?? {} });
        }
        const result = message.method.startsWith("thread/")
          ? { thread: { id: "provider-thread" } }
          : {};
        child.stdout.write(`${JSON.stringify({ id: message.id, result })}\n`);
      });
      return child;
    };
    spawnMock.mockImplementationOnce(spawnRespondingChild);
    spawnMock.mockImplementationOnce(spawnRespondingChild);
    const startInput = {
      threadId: asThreadId("thread-1"),
      provider: "codex" as const,
      binaryPath: "codex",
      runtimeMode: "full-access" as const,
      cwd: os.tmpdir(),
    };

    try {
      const session = await manager.startSession(startInput);
      manager.stopSession(session.threadId);
      await manager.startSession({ ...startInput, resumeCursor: session.resumeCursor });

      const expectedConfig = {
        "tools.update_plan.enabled": true,
        "features.concurrent_reasoning_summaries": true,
        mcp_optional_startup_grace_ms: 10_000,
      };
      expect(threadOpens.map((open) => open.method)).toEqual(["thread/start", "thread/resume"]);
      for (const open of threadOpens) {
        expect(open.params.config).toEqual(expectedConfig);
      }
      expect(threadOpens[0]?.params.excludeTurns).toBeUndefined();
      expect(threadOpens[1]?.params.excludeTurns).toBe(true);
    } finally {
      versionCheck.mockRestore();
      manager.stopAll();
    }
  });

  it("sends approvalsReviewer on thread open only when the Codex CLI supports it", async () => {
    const manager = new CodexAppServerManager();
    const versionCheck = vi.spyOn(protocolHelpers, "assertSupportedCodexCliVersion");
    const threadOpens: Array<{ method: string; params: Record<string, unknown> }> = [];
    const spawnRespondingChild = () => {
      const child = createFakeChild();
      readline.createInterface({ input: child.stdin }).on("line", (line) => {
        const message = JSON.parse(line) as {
          id?: number;
          method?: string;
          params?: Record<string, unknown>;
        };
        if (message.id === undefined || !message.method) return;
        if (message.method.startsWith("thread/")) {
          threadOpens.push({ method: message.method, params: message.params ?? {} });
        }
        const result = message.method.startsWith("thread/")
          ? { thread: { id: "provider-thread" } }
          : {};
        child.stdout.write(`${JSON.stringify({ id: message.id, result })}\n`);
      });
      return child;
    };
    for (let index = 0; index < 4; index += 1) {
      spawnMock.mockImplementationOnce(spawnRespondingChild);
    }
    const startInput = {
      threadId: asThreadId("thread-1"),
      provider: "codex" as const,
      binaryPath: "codex",
      cwd: os.tmpdir(),
    };
    const autoUnsupportedEvents: Array<string | undefined> = [];
    manager.on("event", (event) => {
      if (event.method === "session/autoModeUnsupported") {
        autoUnsupportedEvents.push(event.message);
      }
    });

    try {
      versionCheck.mockResolvedValue("0.124.0");
      const session = await manager.startSession({ ...startInput, runtimeMode: "auto" });
      manager.stopSession(session.threadId);
      await manager.startSession({
        ...startInput,
        runtimeMode: "full-access",
        resumeCursor: session.resumeCursor,
      });
      manager.stopSession(session.threadId);
      await manager.startSession({
        ...startInput,
        runtimeMode: "approval-required",
        resumeCursor: session.resumeCursor,
      });
      manager.stopSession(session.threadId);
      versionCheck.mockResolvedValue("0.123.0");
      await manager.startSession({ ...startInput, runtimeMode: "auto" });

      expect(threadOpens.map((open) => open.method)).toEqual([
        "thread/start",
        "thread/resume",
        "thread/resume",
        "thread/start",
      ]);
      expect(threadOpens[0]?.params).toMatchObject({
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        approvalsReviewer: "auto_review",
      });
      expect(threadOpens[1]?.params).toMatchObject({
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        approvalsReviewer: "user",
      });
      expect(threadOpens[2]?.params).toMatchObject({
        approvalPolicy: "untrusted",
        sandbox: "read-only",
        approvalsReviewer: "user",
      });
      expect(threadOpens[3]?.params).toMatchObject({
        approvalPolicy: "untrusted",
        sandbox: "read-only",
      });
      expect(threadOpens[3]?.params).not.toHaveProperty("approvalsReviewer");
      // Only the old CLI with Auto warns that it runs as Supervised.
      expect(autoUnsupportedEvents).toEqual([
        "Auto needs Codex CLI 0.124.0 or newer; running as Supervised.",
      ]);
    } finally {
      versionCheck.mockRestore();
      manager.stopAll();
    }
  });

  const spawnScriptedChild = (
    requests: Array<{ method: string; params: Record<string, unknown> }>,
    respond: (method: string, attempt: number) => { result?: unknown; error?: unknown },
  ) => {
    const attempts = new Map<string, number>();
    const child = createFakeChild();
    readline.createInterface({ input: child.stdin }).on("line", (line) => {
      const message = JSON.parse(line) as {
        id?: number;
        method?: string;
        params?: Record<string, unknown>;
      };
      if (message.id === undefined || !message.method) return;
      const attempt = (attempts.get(message.method) ?? 0) + 1;
      attempts.set(message.method, attempt);
      if (message.method.startsWith("thread/")) {
        requests.push({ method: message.method, params: message.params ?? {} });
      }
      child.stdout.write(
        `${JSON.stringify({ id: message.id, ...respond(message.method, attempt) })}\n`,
      );
    });
    return child;
  };

  it("unarchives a thread archived in another Codex client and retries the resume", async () => {
    const manager = new CodexAppServerManager();
    const versionCheck = vi
      .spyOn(protocolHelpers, "assertSupportedCodexCliVersion")
      .mockResolvedValue(undefined);
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    spawnMock.mockImplementationOnce(() =>
      spawnScriptedChild(requests, (method, attempt) => {
        if (method === "thread/resume" && attempt === 1) {
          return {
            error: {
              code: -32600,
              message:
                "session 019fdf74-aaa9 is archived. Run `codex unarchive 019fdf74-aaa9` to restore it.",
            },
          };
        }
        return method.startsWith("thread/")
          ? { result: { thread: { id: "provider-thread" } } }
          : { result: {} };
      }),
    );

    try {
      const session = await manager.startSession({
        threadId: asThreadId("thread-1"),
        provider: "codex",
        binaryPath: "codex",
        runtimeMode: "full-access",
        cwd: os.tmpdir(),
        resumeCursor: { threadId: "provider-thread" },
      });
      expect(requests.map((request) => request.method)).toEqual([
        "thread/resume",
        "thread/unarchive",
        "thread/resume",
      ]);
      expect(requests[1]?.params).toEqual({ threadId: "provider-thread" });
      expect(session.resumeCursor).toEqual({ threadId: "provider-thread" });
    } finally {
      versionCheck.mockRestore();
      manager.stopAll();
    }
  });

  it("explains an active-writer conflict instead of starting a new thread", async () => {
    const manager = new CodexAppServerManager();
    const events: Array<{ method: string; message?: string }> = [];
    manager.on("event", (event) => {
      events.push({ method: event.method, ...(event.message ? { message: event.message } : {}) });
    });
    const versionCheck = vi
      .spyOn(protocolHelpers, "assertSupportedCodexCliVersion")
      .mockResolvedValue(undefined);
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    spawnMock.mockImplementationOnce(() =>
      spawnScriptedChild(requests, (method) =>
        method === "thread/resume"
          ? {
              error: {
                code: -32600,
                message: "thread provider-thread not found: already has an active writer",
              },
            }
          : { result: {} },
      ),
    );

    try {
      await expect(
        manager.startSession({
          threadId: asThreadId("thread-1"),
          provider: "codex",
          binaryPath: "codex",
          runtimeMode: "full-access",
          cwd: os.tmpdir(),
          resumeCursor: { threadId: "provider-thread" },
        }),
      ).rejects.toThrow(CODEX_THREAD_IN_USE_MESSAGE);
      expect(requests.map((request) => request.method)).toEqual(["thread/resume"]);
      expect(events).toContainEqual({
        method: "session/threadResumeFailed",
        message: CODEX_THREAD_IN_USE_MESSAGE,
      });
    } finally {
      versionCheck.mockRestore();
      manager.stopAll();
    }
  });

  it("appends launch arguments to the chat session's app-server spawn", async () => {
    const manager = new CodexAppServerManager();
    const child = createFakeChild();
    spawnMock.mockClear();
    spawnMock.mockReturnValueOnce(child);
    const versionCheck = vi
      .spyOn(protocolHelpers, "assertSupportedCodexCliVersion")
      .mockResolvedValue(undefined);

    try {
      const start = manager.startSession({
        threadId: asThreadId("thread-1"),
        provider: "codex",
        binaryPath: "codex",
        runtimeMode: "full-access",
        cwd: os.tmpdir(),
        launchArgs: `--enable foo --config model="gpt 5"`,
      });
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
      child.emit("exit", 1, null);
      await start.catch(() => undefined);

      const args = spawnMock.mock.calls[0]?.[1] as ReadonlyArray<string>;
      expect(args.slice(-5)).toEqual(["app-server", "--enable", "foo", "--config", "model=gpt 5"]);
    } finally {
      versionCheck.mockRestore();
      manager.stopAll();
    }
  });

  it("reports startFailed without session/closed when the child exits during start", async () => {
    const manager = new CodexAppServerManager();
    const events: Array<{ method: string; kind: string }> = [];
    manager.on("event", (event) => {
      events.push({ method: event.method, kind: event.kind });
    });
    const child = createFakeChild();
    spawnMock.mockReturnValueOnce(child);
    const versionCheck = vi
      .spyOn(protocolHelpers, "assertSupportedCodexCliVersion")
      .mockResolvedValue(undefined);

    try {
      const start = manager.startSession({
        threadId: asThreadId("thread-1"),
        provider: "codex",
        binaryPath: "codex",
        runtimeMode: "full-access",
        cwd: os.tmpdir(),
      });
      const internals = manager as unknown as ManagerInternals;
      await vi.waitFor(() => {
        expect((internals.sessions.get(asThreadId("thread-1")) as { child?: unknown })?.child).toBe(
          child,
        );
      });
      child.emit("exit", 1, null);

      await expect(start).rejects.toThrow(
        "initialize failed: codex app-server exited (code=1, signal=null).",
      );
      const methods = events.map((event) => event.method);
      expect(methods).toContain("session/exited");
      expect(methods).toContain("session/startFailed");
      expect(methods).not.toContain("session/closed");
      expect(manager.hasSession(asThreadId("thread-1"))).toBe(false);
    } finally {
      versionCheck.mockRestore();
      manager.stopAll();
    }
  });
});

describe("session disposal and process exit", () => {
  it("stopSession kills the child, rejects pending requests and emits session/closed", async () => {
    const { manager, internals, child, context, events } = createProcessHarness();
    const pending = internals.sendRequest(context, "turn/start", {});

    manager.stopSession(asThreadId("thread_1"));

    await expect(pending).rejects.toThrow(
      "turn/start failed: Session stopped before request completed.",
    );
    expect(child.killed).toBe(true);
    expect(context.pending.size).toBe(0);
    expect(manager.hasSession(asThreadId("thread_1"))).toBe(false);
    expect(events).toContainEqual({
      method: "session/closed",
      kind: "session",
      message: "Session stopped",
    });
  });

  it("rejects pending requests with a clear error when the app-server exits", async () => {
    const { manager, internals, child, context, events } = createProcessHarness();
    context.pendingApprovals.set("req-1", { requestId: "req-1" });
    const pending = internals.sendRequest(context, "thread/read", {});

    child.emit("exit", 1, null);

    await expect(pending).rejects.toThrow(
      "thread/read failed: codex app-server exited (code=1, signal=null).",
    );
    expect(context.pending.size).toBe(0);
    expect(context.pendingApprovals.size).toBe(0);
    expect(manager.hasSession(asThreadId("thread_1"))).toBe(false);
    expect(events).toContainEqual({
      method: "session/exited",
      kind: "session",
      message: "codex app-server exited (code=1, signal=null).",
    });
  });

  it("says why the app-server exited using the stderr that arrives around the exit", async () => {
    const { internals, child, context, events } = createProcessHarness();
    const pending = internals.sendRequest(context, "turn/start", {});

    child.stderr.write("node:internal/modules/cjs/loader:1228\n  throw err;\n");
    child.emit("exit", 1, null);
    // Stderr still flushing after "exit" is included in the reason.
    child.stderr.end(
      "\u001b[31mError: Cannot find module '@openai/codex-darwin-arm64'\u001b[0m\n    at Module._resolveFilename\n",
    );

    const expected =
      "codex app-server exited (code=1, signal=null): Error: Cannot find module '@openai/codex-darwin-arm64'";
    await expect(pending).rejects.toThrow(`turn/start failed: ${expected}`);
    expect((context.session as { lastError?: string }).lastError).toBe(expected);
    expect(events).toContainEqual({ method: "session/exited", kind: "session", message: expected });
  });

  it("does not evict a replacement session when a stale child exits", () => {
    const { manager, internals, child, context } = createProcessHarness();
    const replacement = { session: { ...context.session } };
    internals.sessions.set(asThreadId("thread_1"), replacement);

    child.emit("exit", null, "SIGKILL");

    expect(internals.sessions.get(asThreadId("thread_1"))).toBe(replacement);
    expect(manager.hasSession(asThreadId("thread_1"))).toBe(true);
    internals.sessions.clear();
  });

  it("stays quiet when a disposed session's child exits afterwards", () => {
    const { manager, internals, child, context, events } = createProcessHarness();
    manager.stopSession(asThreadId("thread_1"));
    const replacement = { session: { ...context.session } };
    internals.sessions.set(asThreadId("thread_1"), replacement);
    events.length = 0;

    child.emit("exit", 0, null);

    expect(events).toEqual([]);
    expect(internals.sessions.get(asThreadId("thread_1"))).toBe(replacement);
    internals.sessions.clear();
  });

  it("cleans up the pending entry and timer when the request write fails", async () => {
    vi.useFakeTimers();
    try {
      const { internals, child, context } = createProcessHarness();
      child.stdin.end();

      await expect(internals.sendRequest(context, "turn/start", {})).rejects.toThrow(
        "turn/start failed: Cannot write to codex app-server stdin.",
      );
      expect(context.pending.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports instead of throwing when replying to a server request fails", async () => {
    const { child, events } = createProcessHarness();
    child.stdin.end();

    child.stdout.write(`${JSON.stringify({ id: 7, method: "unsupported/thing", params: {} })}\n`);

    await vi.waitFor(() => {
      expect(events).toContainEqual({
        method: "protocol/handlerError",
        kind: "error",
        message: "Cannot write to codex app-server stdin.",
      });
    });
    expect(events).toContainEqual(
      expect.objectContaining({ method: "unsupported/thing", kind: "request" }),
    );
  });

  it("surfaces stdin stream errors and fails pending requests instead of crashing", async () => {
    vi.useFakeTimers();
    try {
      const { child, context, events, internals } = createProcessHarness();
      const pending = internals.sendRequest(context, "thread/read", {});

      child.stdin.emit("error", new Error("write EPIPE"));

      await expect(pending).rejects.toThrow("thread/read failed: write EPIPE");
      expect(vi.getTimerCount()).toBe(0);
      expect(context.session.status).toBe("error");
      expect(events).toContainEqual({
        method: "process/stdinError",
        kind: "error",
        message: "write EPIPE",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores stdin errors and handler failures that arrive after the child exited", async () => {
    const { child, events } = createProcessHarness();
    child.emit("exit", 1, null);
    events.length = 0;

    child.stdin.emit("error", new Error("write EPIPE"));
    child.stdin.end();
    child.stdout.write(`${JSON.stringify({ id: 9, method: "unsupported/thing", params: {} })}\n`);
    await vi.waitFor(() => {
      expect(events).toContainEqual(
        expect.objectContaining({ method: "unsupported/thing", kind: "request" }),
      );
    });

    expect(events.map((event) => event.method)).not.toContain("process/stdinError");
    expect(events.map((event) => event.method)).not.toContain("protocol/handlerError");
  });

  it("fails pending requests when the child process errors without exiting", async () => {
    vi.useFakeTimers();
    try {
      const { child, context, events, internals } = createProcessHarness();
      const pending = internals.sendRequest(context, "initialize", {});

      child.emit("error", new Error("spawn EACCES"));

      await expect(pending).rejects.toThrow("initialize failed: spawn EACCES");
      expect(vi.getTimerCount()).toBe(0);
      expect(events).toContainEqual({
        method: "process/error",
        kind: "error",
        message: "spawn EACCES",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects new requests immediately once the session is stopping", async () => {
    vi.useFakeTimers();
    try {
      const { manager, internals, context } = createProcessHarness();
      manager.stopSession(asThreadId("thread_1"));

      await expect(internals.sendRequest(context, "thread/start", {})).rejects.toThrow(
        "thread/start failed: Session stopped before request completed.",
      );
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("sendTurn", () => {
  it("passes localImage attachments by path to turn/start", async () => {
    const { manager, context, sendRequest } = createSendTurnHarness();

    await manager.sendTurn({
      threadId: asThreadId("thread_1"),
      input: "Inspect this image",
      attachments: [{ type: "localImage", path: "/tmp/attachments/img.png" }],
    });

    expect(sendRequest).toHaveBeenCalledWith(context, "turn/start", {
      threadId: "thread_1",
      summary: "detailed",
      input: [
        { type: "text", text: "Inspect this image", text_elements: [] },
        { type: "localImage", path: "/tmp/attachments/img.png" },
      ],
      model: "gpt-5.3-codex",
    });
  });

  it("sends text and image user input items to turn/start", async () => {
    const { manager, context, requireSession, sendRequest, updateSession } =
      createSendTurnHarness();

    const result = await manager.sendTurn({
      threadId: asThreadId("thread_1"),
      input: "Inspect this image",
      attachments: [
        {
          type: "image",
          url: "data:image/png;base64,AAAA",
        },
      ],
      model: "gpt-5.3",
      serviceTier: "fast",
      effort: "high",
    });

    expect(result).toEqual({
      threadId: "thread_1",
      turnId: "turn_1",
      resumeCursor: { threadId: "thread_1" },
    });
    expect(requireSession).toHaveBeenCalledWith("thread_1");
    expect(sendRequest).toHaveBeenCalledWith(context, "turn/start", {
      threadId: "thread_1",
      summary: "detailed",
      input: [
        {
          type: "text",
          text: "Inspect this image",
          text_elements: [],
        },
        {
          type: "image",
          url: "data:image/png;base64,AAAA",
        },
      ],
      model: "gpt-5.3-codex",
      serviceTier: "fast",
      effort: "high",
    });
    expect(updateSession).toHaveBeenCalledWith(context, {
      status: "running",
      activeTurnId: "turn_1",
      resumeCursor: { threadId: "thread_1" },
    });
  });

  it.each([
    ["an explicit Standard", { serviceTier: null }, null],
    ["a catalog tier", { serviceTier: "ultrafast" }, "ultrafast"],
  ])("sends %s with turn/start", async (_label, tierInput, expected) => {
    const { manager, context, sendRequest } = createSendTurnHarness();

    await manager.sendTurn({
      threadId: asThreadId("thread_1"),
      input: "Hello",
      ...tierInput,
    });

    expect(sendRequest).toHaveBeenCalledWith(
      context,
      "turn/start",
      expect.objectContaining({ serviceTier: expected }),
    );
  });

  it("leaves serviceTier off turn/start when no tier is given", async () => {
    const { manager, sendRequest } = createSendTurnHarness();

    await manager.sendTurn({ threadId: asThreadId("thread_1"), input: "Hello" });

    const params = sendRequest.mock.calls.find((call) => call[1] === "turn/start")?.[2];
    expect(params).toBeDefined();
    expect(params).not.toHaveProperty("serviceTier");
  });

  it("supports image-only turns", async () => {
    const { manager, context, sendRequest } = createSendTurnHarness();

    await manager.sendTurn({
      threadId: asThreadId("thread_1"),
      attachments: [
        {
          type: "image",
          url: "data:image/png;base64,BBBB",
        },
      ],
    });

    expect(sendRequest).toHaveBeenCalledWith(context, "turn/start", {
      threadId: "thread_1",
      summary: "detailed",
      input: [
        {
          type: "image",
          url: "data:image/png;base64,BBBB",
        },
      ],
      model: "gpt-5.3-codex",
    });
  });

  it("passes Codex plan mode as a collaboration preset on turn/start", async () => {
    const { manager, context, sendRequest } = createSendTurnHarness();

    await manager.sendTurn({
      threadId: asThreadId("thread_1"),
      input: "Plan the work",
      interactionMode: "plan",
    });

    expect(sendRequest).toHaveBeenCalledWith(context, "turn/start", {
      threadId: "thread_1",
      summary: "detailed",
      input: [
        {
          type: "text",
          text: "Plan the work",
          text_elements: [],
        },
      ],
      model: "gpt-5.3-codex",
      collaborationMode: {
        mode: "plan",
        settings: {
          model: "gpt-5.3-codex",
        },
      },
    });
  });

  it("passes Codex default mode as a collaboration preset on turn/start", async () => {
    const { manager, context, sendRequest } = createSendTurnHarness();

    await manager.sendTurn({
      threadId: asThreadId("thread_1"),
      input: "PLEASE IMPLEMENT THIS PLAN:\n- step 1",
      interactionMode: "default",
    });

    expect(sendRequest).toHaveBeenCalledWith(context, "turn/start", {
      threadId: "thread_1",
      summary: "detailed",
      input: [
        {
          type: "text",
          text: "PLEASE IMPLEMENT THIS PLAN:\n- step 1",
          text_elements: [],
        },
      ],
      model: "gpt-5.3-codex",
      collaborationMode: {
        mode: "default",
        settings: {
          model: "gpt-5.3-codex",
        },
      },
    });
  });

  it("keeps the session model when interaction mode is set without an explicit model", async () => {
    const { manager, context, sendRequest } = createSendTurnHarness();
    context.session.model = "gpt-5.2-codex";

    await manager.sendTurn({
      threadId: asThreadId("thread_1"),
      input: "Plan this with my current session model",
      interactionMode: "plan",
    });

    expect(sendRequest).toHaveBeenCalledWith(context, "turn/start", {
      threadId: "thread_1",
      summary: "detailed",
      input: [
        {
          type: "text",
          text: "Plan this with my current session model",
          text_elements: [],
        },
      ],
      model: "gpt-5.2-codex",
      collaborationMode: {
        mode: "plan",
        settings: {
          model: "gpt-5.2-codex",
        },
      },
    });
  });

  it("sends a chosen reasoning effort and no collaboration mode without an interaction mode", async () => {
    const { manager, context, sendRequest } = createSendTurnHarness();

    await manager.sendTurn({
      threadId: asThreadId("thread_1"),
      input: "Think hard",
      interactionMode: "plan",
      effort: "high",
    });
    await manager.sendTurn({ threadId: asThreadId("thread_1"), input: "No mode" });

    expect(sendRequest).toHaveBeenNthCalledWith(1, context, "turn/start", {
      threadId: "thread_1",
      summary: "detailed",
      input: [{ type: "text", text: "Think hard", text_elements: [] }],
      model: "gpt-5.3-codex",
      effort: "high",
      collaborationMode: {
        mode: "plan",
        settings: { model: "gpt-5.3-codex", reasoning_effort: "high" },
      },
    });
    expect(sendRequest).toHaveBeenNthCalledWith(2, context, "turn/start", {
      threadId: "thread_1",
      summary: "detailed",
      input: [{ type: "text", text: "No mode", text_elements: [] }],
      model: "gpt-5.3-codex",
    });
  });

  it("runs Spark on plans not known to lack it and reroutes it on plans that do", async () => {
    const { manager, context, sendRequest } = createSendTurnHarness();
    const sentModel = async (planType: string) => {
      Object.assign(context, {
        account: readCodexAccountSnapshot({ type: "chatgpt", planType }),
      });
      sendRequest.mockClear();
      await manager.sendTurn({
        threadId: asThreadId("thread_1"),
        input: "Go",
        model: "gpt-5.3-codex-spark",
      });
      return (sendRequest.mock.calls[0]?.[2] as { model?: string } | undefined)?.model;
    };

    expect(await sentModel("self_serve_business_prolite")).toBe("gpt-5.3-codex-spark");
    expect(await sentModel("promax")).toBe("gpt-5.3-codex-spark");
    expect(await sentModel("plus")).toBe("gpt-5.3-codex");
  });

  it("rejects empty turn input", async () => {
    const { manager } = createSendTurnHarness();

    await expect(
      manager.sendTurn({
        threadId: asThreadId("thread_1"),
      }),
    ).rejects.toThrow("Turn input must include text or attachments.");
  });
});

const userTurn = (id: string) => ({ id, items: [{ type: "userMessage" }], itemsView: "summary" });

const mockThreadHistory = (
  sendRequest: ReturnType<typeof createThreadControlHarness>["sendRequest"],
  pages: Record<string, { data: unknown[]; nextCursor: string | null }>,
) => {
  sendRequest.mockImplementation(async (...args: unknown[]) => {
    const [, method, params] = args as [unknown, string, { cursor?: string | null }];
    if (method === "thread/read") {
      return { thread: { id: "thread_1", historyMode: "paginated", turns: [] } };
    }
    if (method === "thread/turns/list") {
      return pages[params.cursor ?? "start"];
    }
    return { thread: { id: "thread_1", turns: [] } };
  });
};

const threadRead = (historyMode: string) => ({ thread: { id: "thread_1", historyMode } });

describe("thread checkpoint control", () => {
  it("reads thread turns from thread/read", async () => {
    const { manager, context, requireSession, sendRequest } = createThreadControlHarness();
    sendRequest.mockResolvedValue({
      thread: {
        id: "thread_1",
        turns: [
          {
            id: "turn_1",
            items: [{ type: "userMessage", content: [{ type: "text", text: "hello" }] }],
          },
        ],
      },
    });

    const result = await manager.readThread(asThreadId("thread_1"));

    expect(requireSession).toHaveBeenCalledWith("thread_1");
    expect(sendRequest).toHaveBeenCalledWith(context, "thread/read", {
      threadId: "thread_1",
      includeTurns: true,
    });
    expect(result).toEqual({
      threadId: "thread_1",
      turns: [
        {
          id: "turn_1",
          items: [{ type: "userMessage", content: [{ type: "text", text: "hello" }] }],
        },
      ],
    });
  });

  it("reads thread turns from flat thread/read responses", async () => {
    const { manager, context, sendRequest } = createThreadControlHarness();
    sendRequest.mockResolvedValue({
      threadId: "thread_1",
      turns: [
        {
          id: "turn_1",
          items: [{ type: "userMessage", content: [{ type: "text", text: "hello" }] }],
        },
      ],
    });

    const result = await manager.readThread(asThreadId("thread_1"));

    expect(sendRequest).toHaveBeenCalledWith(context, "thread/read", {
      threadId: "thread_1",
      includeTurns: true,
    });
    expect(result).toEqual({
      threadId: "thread_1",
      turns: [
        {
          id: "turn_1",
          items: [{ type: "userMessage", content: [{ type: "text", text: "hello" }] }],
        },
      ],
    });
  });

  it("starts compaction via thread/compact/start on the provider thread", async () => {
    const { manager, context, sendRequest } = createThreadControlHarness();
    context.session.resumeCursor = { threadId: "provider_thread_1" };
    sendRequest.mockImplementation(async () => {
      (
        manager as unknown as { handleServerNotification: (...args: unknown[]) => void }
      ).handleServerNotification(context, {
        method: "turn/started",
        params: { threadId: "provider_thread_1", turn: { id: "compaction-turn" } },
      });
      return {};
    });

    await manager.compactThread(asThreadId("thread_1"));

    expect(sendRequest).toHaveBeenCalledWith(context, "thread/compact/start", {
      threadId: "provider_thread_1",
    });
  });

  it("refuses to compact while a turn is running", async () => {
    const { manager, context, sendRequest } = createThreadControlHarness();
    Object.assign(context.session, { activeTurnId: "turn_1" });

    await expect(manager.compactThread(asThreadId("thread_1"))).rejects.toThrow(
      "Context compaction is unavailable while a turn is running.",
    );
    expect(sendRequest).not.toHaveBeenCalled();
  });

  it("explains that an older CLI cannot compact", async () => {
    const { manager, sendRequest } = createThreadControlHarness();
    sendRequest.mockRejectedValue(
      new Error("thread/compact/start failed: Invalid request: unknown variant"),
    );

    await expect(manager.compactThread(asThreadId("thread_1"))).rejects.toThrow(
      "This Codex CLI cannot compact on demand. Update Codex and try again.",
    );
  });

  it.each([
    { numTurns: 1, beforeTurnId: "t3" },
    { numTurns: 2, beforeTurnId: "t2" },
    { numTurns: 5, beforeTurnId: "t1" },
  ])(
    "reverts a paginated thread by $numTurns turns before $beforeTurnId",
    async ({ numTurns, beforeTurnId }) => {
      const { manager, context, sendRequest, updateSession } = createThreadControlHarness();
      mockThreadHistory(sendRequest, {
        start: { data: [userTurn("t3"), userTurn("t2"), userTurn("t1")], nextCursor: null },
      });

      const result = await manager.rollbackThread(asThreadId("thread_1"), numTurns);

      expect(sendRequest).toHaveBeenCalledWith(context, "thread/read", {
        threadId: "thread_1",
        includeTurns: false,
      });
      expect(sendRequest).toHaveBeenCalledWith(context, "thread/revert", {
        threadId: "thread_1",
        beforeTurnId,
      });
      expect(sendRequest).not.toHaveBeenCalledWith(context, "thread/rollback", expect.anything());
      expect(updateSession).toHaveBeenCalledWith(context, {
        status: "ready",
        activeTurnId: undefined,
      });
      expect(result).toEqual({ threadId: "thread_1", turns: [] });
    },
  );

  it("pages newest first across several pages of a paginated thread", async () => {
    const { manager, context, sendRequest } = createThreadControlHarness();
    mockThreadHistory(sendRequest, {
      start: { data: [userTurn("t4"), userTurn("t3")], nextCursor: "page-2" },
      "page-2": { data: [userTurn("t2"), userTurn("t1")], nextCursor: null },
    });

    const result = await manager.rollbackThread(asThreadId("thread_1"), 3);

    expect(sendRequest).toHaveBeenCalledWith(context, "thread/turns/list", {
      threadId: "thread_1",
      cursor: null,
      limit: 100,
      sortDirection: "desc",
      itemsView: "summary",
    });
    expect(sendRequest).toHaveBeenCalledWith(
      context,
      "thread/turns/list",
      expect.objectContaining({ cursor: "page-2" }),
    );
    expect(sendRequest).toHaveBeenCalledWith(context, "thread/revert", {
      threadId: "thread_1",
      beforeTurnId: "t2",
    });
    expect(result).toEqual({ threadId: "thread_1", turns: [] });
  });

  it("stops paging once the revert point is found", async () => {
    const { manager, context, sendRequest } = createThreadControlHarness();
    mockThreadHistory(sendRequest, {
      start: { data: [userTurn("t4"), userTurn("t3")], nextCursor: "page-2" },
      "page-2": { data: [userTurn("t2"), userTurn("t1")], nextCursor: null },
    });

    await manager.rollbackThread(asThreadId("thread_1"), 2);

    expect(sendRequest).not.toHaveBeenCalledWith(
      context,
      "thread/turns/list",
      expect.objectContaining({ cursor: "page-2" }),
    );
    expect(sendRequest).toHaveBeenCalledWith(context, "thread/revert", {
      threadId: "thread_1",
      beforeTurnId: "t3",
    });
  });

  it("keeps a compaction this session saw fail out of the turn before it", async () => {
    const { manager, context, sendRequest } = createThreadControlHarness();
    Object.assign(context, { compactionTurnIds: new Set(["failed-compaction"]) });
    mockThreadHistory(sendRequest, {
      start: {
        data: [
          { id: "failed-compaction", items: [], status: "failed" },
          { ...userTurn("t1"), status: "failed" },
        ],
        nextCursor: null,
      },
    });

    await manager.rollbackThread(asThreadId("thread_1"), 1);

    expect(sendRequest).toHaveBeenCalledWith(context, "thread/revert", {
      threadId: "thread_1",
      beforeTurnId: "failed-compaction",
    });
  });

  it("stops on a repeated cursor instead of paging forever and leaves the thread alone", async () => {
    const { manager, context, sendRequest, updateSession } = createThreadControlHarness();
    mockThreadHistory(sendRequest, {
      start: { data: [userTurn("t2")], nextCursor: "loop" },
      loop: { data: [userTurn("t1")], nextCursor: "loop" },
    });

    await expect(manager.rollbackThread(asThreadId("thread_1"), 9)).rejects.toThrow(
      "Codex thread history pagination repeated a cursor.",
    );
    expect(sendRequest).not.toHaveBeenCalledWith(context, "thread/revert", expect.anything());
    expect(updateSession).not.toHaveBeenCalled();
  });

  it("does not call thread/revert when the paginated thread has no turns", async () => {
    const { manager, context, sendRequest } = createThreadControlHarness();
    mockThreadHistory(sendRequest, { start: { data: [], nextCursor: null } });

    const result = await manager.rollbackThread(asThreadId("thread_1"), 1);

    expect(sendRequest).not.toHaveBeenCalledWith(context, "thread/revert", expect.anything());
    expect(result).toEqual({ threadId: "thread_1", turns: [] });
  });

  it("rolls back legacy threads via thread/rollback and resets session running state", async () => {
    const { manager, context, sendRequest, updateSession } = createThreadControlHarness();
    sendRequest.mockResolvedValue({
      thread: {
        id: "thread_1",
        turns: [],
      },
    });

    const result = await manager.rollbackThread(asThreadId("thread_1"), 2);

    expect(sendRequest).toHaveBeenCalledWith(context, "thread/rollback", {
      threadId: "thread_1",
      numTurns: 2,
    });
    expect(updateSession).toHaveBeenCalledWith(context, {
      status: "ready",
      activeTurnId: undefined,
    });
    expect(result).toEqual({
      threadId: "thread_1",
      turns: [],
    });
  });

  it("explains that a current CLI cannot rewind a legacy thread", async () => {
    const { manager, sendRequest, updateSession } = createThreadControlHarness();
    sendRequest.mockImplementation(async (...args: unknown[]) => {
      if (args[1] === "thread/read") {
        return { thread: { id: "thread_1", historyMode: "legacy", turns: [] } };
      }
      throw new Error("thread/rollback failed: Invalid request: unknown variant `thread/rollback`");
    });

    await expect(manager.rollbackThread(asThreadId("thread_1"), 1)).rejects.toThrow(
      "too old for this Codex CLI to rewind",
    );
    expect(updateSession).not.toHaveBeenCalled();
  });

  it("counts retried native turns on a legacy thread after a restart forgot them", async () => {
    const { manager, context, sendRequest } = createThreadControlHarness();
    sendRequest.mockImplementation(async (...args: unknown[]) => {
      if (args[1] === "thread/read") {
        return {
          thread: {
            id: "thread_1",
            turns: [
              { id: "t1", items: [{ type: "userMessage" }] },
              { id: "t2", items: [{ type: "userMessage" }] },
              { id: "retry", items: [{ type: "agentMessage" }] },
            ],
          },
        };
      }
      return { thread: { id: "thread_1", turns: [] } };
    });

    await manager.rollbackThread(asThreadId("thread_1"), 1);

    expect(sendRequest).toHaveBeenCalledWith(context, "thread/rollback", {
      threadId: "thread_1",
      numTurns: 2,
    });
  });

  it("falls back to the raw count when a legacy thread's history cannot be read", async () => {
    const { manager, context, sendRequest } = createThreadControlHarness();
    let reads = 0;
    sendRequest.mockImplementation(async (...args: unknown[]) => {
      if (args[1] === "thread/read" && ++reads === 2) throw new Error("thread/read failed");
      return { thread: { id: "thread_1", turns: [] } };
    });

    await manager.rollbackThread(asThreadId("thread_1"), 3);

    expect(sendRequest).toHaveBeenCalledWith(context, "thread/rollback", {
      threadId: "thread_1",
      numTurns: 3,
    });
  });

  describe("canRollbackThread", () => {
    it("says yes for a paginated thread without touching it", async () => {
      const { manager, context, sendRequest } = createThreadControlHarness();
      sendRequest.mockResolvedValue(threadRead("paginated"));

      await expect(manager.canRollbackThread(asThreadId("thread_1"))).resolves.toBe(true);
      expect(sendRequest).not.toHaveBeenCalledWith(context, "thread/rollback", expect.anything());
    });

    it("says no for a legacy thread on a CLI without thread/rollback", async () => {
      const { manager, sendRequest } = createThreadControlHarness();
      sendRequest.mockImplementation(async (...args: unknown[]) => {
        if (args[1] === "thread/read") return threadRead("legacy");
        throw new Error("thread/rollback failed: unknown variant `thread/rollback`");
      });

      await expect(manager.canRollbackThread(asThreadId("thread_1"))).resolves.toBe(false);
    });

    it("says yes when the empty probe is only refused for its count", async () => {
      const { manager, context, sendRequest } = createThreadControlHarness();
      sendRequest.mockImplementation(async (...args: unknown[]) => {
        if (args[1] === "thread/read") return threadRead("legacy");
        throw new Error("thread/rollback failed: numTurns must be >= 1");
      });

      await expect(manager.canRollbackThread(asThreadId("thread_1"))).resolves.toBe(true);
      expect(sendRequest).toHaveBeenCalledWith(context, "thread/rollback", {
        threadId: "thread_1",
        numTurns: 0,
      });
    });
  });

  it("counts retried native turns when rolling back a legacy thread", async () => {
    const { manager, context, sendRequest } = createThreadControlHarness();
    Object.assign(context, {
      capacityRetryTurns: new Map([["retry", TurnId.makeUnsafe("t2")]]),
    });
    sendRequest.mockImplementation(async (...args: unknown[]) => {
      if (args[1] === "thread/read") {
        return {
          thread: {
            id: "thread_1",
            turns: [
              { id: "t1", items: [{ type: "userMessage" }] },
              { id: "t2", items: [{ type: "userMessage" }] },
              { id: "retry", items: [{ type: "agentMessage" }] },
            ],
          },
        };
      }
      return { thread: { id: "thread_1", turns: [] } };
    });

    await manager.rollbackThread(asThreadId("thread_1"), 1);

    expect(sendRequest).toHaveBeenCalledWith(context, "thread/rollback", {
      threadId: "thread_1",
      numTurns: 2,
    });
  });
});

describe("respondToUserInput", () => {
  it("serializes canonical answers to Codex native answer objects", async () => {
    const { manager, context, requireSession, writeMessage, emitEvent } =
      createPendingUserInputHarness();

    await manager.respondToUserInput(
      asThreadId("thread_1"),
      ApprovalRequestId.makeUnsafe("req-user-input-1"),
      {
        scope: "All request methods",
        compat: "Keep current envelope",
      },
    );

    expect(requireSession).toHaveBeenCalledWith("thread_1");
    expect(writeMessage).toHaveBeenCalledWith(context, {
      id: 42,
      result: {
        answers: {
          scope: { answers: ["All request methods"] },
          compat: { answers: ["Keep current envelope"] },
        },
      },
    });
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "item/tool/requestUserInput/answered",
        payload: {
          requestId: "req-user-input-1",
          answers: {
            scope: { answers: ["All request methods"] },
            compat: { answers: ["Keep current envelope"] },
          },
        },
      }),
    );
  });

  it("preserves explicit empty multi-select answers", async () => {
    const { manager, context, requireSession, writeMessage, emitEvent } =
      createPendingUserInputHarness();

    await manager.respondToUserInput(
      asThreadId("thread_1"),
      ApprovalRequestId.makeUnsafe("req-user-input-1"),
      {
        scope: [],
      },
    );

    expect(requireSession).toHaveBeenCalledWith("thread_1");
    expect(writeMessage).toHaveBeenCalledWith(context, {
      id: 42,
      result: {
        answers: {
          scope: { answers: [] },
        },
      },
    });
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "item/tool/requestUserInput/answered",
        payload: {
          requestId: "req-user-input-1",
          answers: {
            scope: { answers: [] },
          },
        },
      }),
    );
  });

  it("tracks file-read approval requests with the correct method", () => {
    const manager = new CodexAppServerManager();
    const context = {
      session: {
        sessionId: "sess_1",
        provider: "codex",
        status: "ready",
        threadId: asThreadId("thread_1"),
        resumeCursor: { threadId: "thread_1" },
        createdAt: "2026-02-10T00:00:00.000Z",
        updatedAt: "2026-02-10T00:00:00.000Z",
      },
      pendingApprovals: new Map(),
      pendingUserInputs: new Map(),
      collabReceiverTurns: new Map(),
    };
    type ApprovalRequestContext = {
      session: typeof context.session;
      pendingApprovals: typeof context.pendingApprovals;
      pendingUserInputs: typeof context.pendingUserInputs;
    };

    (
      manager as unknown as {
        handleServerRequest: (
          context: ApprovalRequestContext,
          request: Record<string, unknown>,
        ) => void;
      }
    ).handleServerRequest(context, {
      jsonrpc: "2.0",
      id: 42,
      method: "item/fileRead/requestApproval",
      params: {},
    });

    const request = Array.from(context.pendingApprovals.values())[0];
    expect(request?.requestKind).toBe("file-read");
    expect(request?.method).toBe("item/fileRead/requestApproval");
  });
});

describe("collab child conversation routing", () => {
  it("rewrites child notification turn ids onto the parent turn", () => {
    const { manager, context, emitEvent } = createCollabNotificationHarness();

    (
      manager as unknown as {
        handleServerNotification: (context: unknown, notification: Record<string, unknown>) => void;
      }
    ).handleServerNotification(context, {
      method: "item/completed",
      params: {
        item: {
          type: "collabAgentToolCall",
          id: "call_collab_1",
          receiverThreadIds: ["child_provider_1"],
        },
        threadId: "provider_parent",
        turnId: "turn_parent",
      },
    });

    (
      manager as unknown as {
        handleServerNotification: (context: unknown, notification: Record<string, unknown>) => void;
      }
    ).handleServerNotification(context, {
      method: "item/agentMessage/delta",
      params: {
        threadId: "child_provider_1",
        turnId: "turn_child_1",
        itemId: "msg_child_1",
        delta: "working",
      },
    });

    expect(emitEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        method: "item/agentMessage/delta",
        turnId: "turn_parent",
        itemId: "msg_child_1",
      }),
    );
  });

  it("suppresses child lifecycle notifications so they cannot replace the parent turn", () => {
    const { manager, context, emitEvent, updateSession } = createCollabNotificationHarness();

    (
      manager as unknown as {
        handleServerNotification: (context: unknown, notification: Record<string, unknown>) => void;
      }
    ).handleServerNotification(context, {
      method: "item/completed",
      params: {
        item: {
          type: "collabAgentToolCall",
          id: "call_collab_1",
          receiverThreadIds: ["child_provider_1"],
        },
        threadId: "provider_parent",
        turnId: "turn_parent",
      },
    });
    emitEvent.mockClear();
    updateSession.mockClear();

    (
      manager as unknown as {
        handleServerNotification: (context: unknown, notification: Record<string, unknown>) => void;
      }
    ).handleServerNotification(context, {
      method: "turn/started",
      params: {
        threadId: "child_provider_1",
        turn: { id: "turn_child_1" },
      },
    });

    (
      manager as unknown as {
        handleServerNotification: (context: unknown, notification: Record<string, unknown>) => void;
      }
    ).handleServerNotification(context, {
      method: "turn/completed",
      params: {
        threadId: "child_provider_1",
        turn: { id: "turn_child_1", status: "completed" },
      },
    });

    (
      manager as unknown as {
        handleServerNotification: (context: unknown, notification: Record<string, unknown>) => void;
      }
    ).handleServerNotification(context, {
      method: "hook/completed",
      params: {
        threadId: "child_provider_1",
        turnId: "turn_child_1",
        run: { status: "stopped", eventName: "stop", entries: [{ kind: "stop", text: "x" }] },
      },
    });

    expect(emitEvent).not.toHaveBeenCalled();
    expect(updateSession).not.toHaveBeenCalled();
  });

  it("rewrites child approval requests onto the parent turn", () => {
    const { manager, context, emitEvent } = createCollabNotificationHarness();

    (
      manager as unknown as {
        handleServerNotification: (context: unknown, notification: Record<string, unknown>) => void;
      }
    ).handleServerNotification(context, {
      method: "item/completed",
      params: {
        item: {
          type: "collabAgentToolCall",
          id: "call_collab_1",
          receiverThreadIds: ["child_provider_1"],
        },
        threadId: "provider_parent",
        turnId: "turn_parent",
      },
    });
    emitEvent.mockClear();

    (
      manager as unknown as {
        handleServerRequest: (context: unknown, request: Record<string, unknown>) => void;
      }
    ).handleServerRequest(context, {
      id: 42,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "child_provider_1",
        turnId: "turn_child_1",
        itemId: "call_child_1",
        command: "bun install",
      },
    });

    expect(Array.from(context.pendingApprovals.values())[0]).toEqual(
      expect.objectContaining({
        turnId: "turn_parent",
        itemId: "call_child_1",
      }),
    );
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "item/commandExecution/requestApproval",
        turnId: "turn_parent",
        itemId: "call_child_1",
      }),
    );
  });
});

describe.skipIf(!process.env.CODEX_BINARY_PATH)("startSession live Codex resume", () => {
  it("keeps prior thread history when resuming with a changed runtime mode", async () => {
    const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "codex-live-resume-"));
    writeFileSync(path.join(workspaceDir, "README.md"), "hello\n", "utf8");

    const manager = new CodexAppServerManager();

    try {
      const firstSession = await manager.startSession({
        threadId: asThreadId("thread-live"),
        provider: "codex",
        cwd: workspaceDir,
        runtimeMode: "full-access",
        binaryPath: process.env.CODEX_BINARY_PATH!,
        ...(process.env.CODEX_HOME_PATH ? { homePath: process.env.CODEX_HOME_PATH } : {}),
      });

      const firstTurn = await manager.sendTurn({
        threadId: firstSession.threadId,
        input: `Reply with exactly the word ALPHA ${randomUUID()}`,
      });

      expect(firstTurn.threadId).toBe(firstSession.threadId);

      await vi.waitFor(
        async () => {
          const snapshot = await manager.readThread(firstSession.threadId);
          expect(snapshot.turns.length).toBeGreaterThan(0);
        },
        { timeout: 120_000, interval: 1_000 },
      );

      const firstSnapshot = await manager.readThread(firstSession.threadId);
      const originalThreadId = firstSnapshot.threadId;
      const originalTurnCount = firstSnapshot.turns.length;

      manager.stopSession(firstSession.threadId);

      const resumedSession = await manager.startSession({
        threadId: firstSession.threadId,
        provider: "codex",
        cwd: workspaceDir,
        runtimeMode: "approval-required",
        resumeCursor: firstSession.resumeCursor,
        binaryPath: process.env.CODEX_BINARY_PATH!,
        ...(process.env.CODEX_HOME_PATH ? { homePath: process.env.CODEX_HOME_PATH } : {}),
      });

      expect(resumedSession.threadId).toBe(originalThreadId);

      const resumedSnapshotBeforeTurn = await manager.readThread(resumedSession.threadId);
      expect(resumedSnapshotBeforeTurn.threadId).toBe(originalThreadId);
      expect(resumedSnapshotBeforeTurn.turns.length).toBeGreaterThanOrEqual(originalTurnCount);

      await manager.sendTurn({
        threadId: resumedSession.threadId,
        input: `Reply with exactly the word BETA ${randomUUID()}`,
      });

      await vi.waitFor(
        async () => {
          const snapshot = await manager.readThread(resumedSession.threadId);
          expect(snapshot.turns.length).toBeGreaterThan(originalTurnCount);
        },
        { timeout: 120_000, interval: 1_000 },
      );
    } finally {
      manager.stopAll();
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  }, 180_000);
});

function captureProtocol(harness: ReturnType<typeof createProcessHarness>) {
  const written: Array<Record<string, unknown>> = [];
  harness.child.stdin.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) {
      if (line.trim()) written.push(JSON.parse(line) as Record<string, unknown>);
    }
  });
  const emitted: Array<{
    method: string;
    kind: string;
    requestId?: string;
    requestKind?: string;
    textDelta?: string;
    turnId?: string;
  }> = [];
  harness.manager.on("event", (event) => {
    emitted.push({
      method: event.method,
      kind: event.kind,
      ...(event.turnId ? { turnId: event.turnId } : {}),
      ...(event.requestId ? { requestId: event.requestId } : {}),
      ...(event.requestKind ? { requestKind: event.requestKind } : {}),
      ...(event.textDelta ? { textDelta: event.textDelta } : {}),
    });
  });
  const receive = (message: unknown) => harness.child.stdout.write(`${JSON.stringify(message)}\n`);
  return { written, emitted, receive };
}

describe("memory consolidation threads", () => {
  it("keeps memory-consolidation traffic out of the session and chat", async () => {
    const harness = createProcessHarness();
    const { emitted, written, receive } = captureProtocol(harness);
    try {
      receive({
        method: "thread/started",
        params: { thread: { id: "memory-thread", threadSource: "memory_consolidation" } },
      });
      receive({
        method: "turn/started",
        params: { threadId: "memory-thread", turn: { id: "memory-turn" } },
      });
      receive({
        method: "item/agentMessage/delta",
        params: { threadId: "memory-thread", turnId: "memory-turn", itemId: "m", delta: "secret" },
      });
      receive({
        id: 41,
        method: "item/commandExecution/requestApproval",
        params: { threadId: "memory-thread", turnId: "memory-turn", itemId: "m" },
      });
      receive({
        method: "item/agentMessage/delta",
        params: { threadId: "provider_1", turnId: "turn-1", itemId: "r", delta: "visible" },
      });

      await vi.waitFor(() => expect(emitted.some((e) => e.textDelta === "visible")).toBe(true));
      expect(emitted.some((e) => e.textDelta === "secret")).toBe(false);
      expect(emitted.map((e) => e.method)).not.toContain("thread/started");
      expect(emitted.map((e) => e.method)).not.toContain("item/commandExecution/requestApproval");
      expect(harness.context.session.resumeCursor).toEqual({ threadId: "provider_1" });
      expect((harness.context.session as { activeTurnId?: string }).activeTurnId).toBeUndefined();
      expect(harness.context.pendingApprovals.size).toBe(0);
      expect(written).toEqual([expect.objectContaining({ id: 41, error: expect.anything() })]);
    } finally {
      harness.manager.stopAll();
    }
  });

  it("ignores thread/started for other threads once the cursor is established", async () => {
    const harness = createProcessHarness();
    const { emitted, receive } = captureProtocol(harness);
    try {
      receive({ method: "thread/started", params: { thread: { id: "other-thread" } } });
      receive({ method: "thread/started", params: { thread: { id: "provider_1" } } });
      await vi.waitFor(() => expect(emitted.map((e) => e.method)).toEqual(["thread/started"]));
      expect(harness.context.session.resumeCursor).toEqual({ threadId: "provider_1" });
    } finally {
      harness.manager.stopAll();
    }
  });
});

describe("Codex-settled server requests", () => {
  it("frees the pending approval and emits its request id on serverRequest/resolved", async () => {
    const harness = createProcessHarness();
    const { emitted, receive } = captureProtocol(harness);
    try {
      receive({
        id: 7,
        method: "item/commandExecution/requestApproval",
        params: { threadId: "provider_1", turnId: "turn-1", itemId: "item-1", command: "ls" },
      });
      await vi.waitFor(() => expect(harness.context.pendingApprovals.size).toBe(1));
      const [requestId] = [...harness.context.pendingApprovals.keys()];

      // A string id must not match the numeric JSON-RPC id.
      receive({
        method: "serverRequest/resolved",
        params: { threadId: "provider_1", requestId: "7" },
      });
      receive({
        method: "serverRequest/resolved",
        params: { threadId: "provider_1", requestId: 7 },
      });

      await vi.waitFor(() =>
        expect(emitted.filter((e) => e.method === "serverRequest/resolved")).toHaveLength(2),
      );
      expect(harness.context.pendingApprovals.size).toBe(0);
      const resolved = emitted.filter((e) => e.method === "serverRequest/resolved");
      expect(resolved[0]?.requestId).toBeUndefined();
      expect(resolved[1]).toMatchObject({ requestId, requestKind: "command" });
    } finally {
      harness.manager.stopAll();
    }
  });

  it("frees a pending user-input request settled by Codex", async () => {
    const harness = createProcessHarness();
    const { emitted, receive } = captureProtocol(harness);
    try {
      receive({
        id: "ui-1",
        method: "item/tool/requestUserInput",
        params: {
          questions: [{ id: "q1" }],
          threadId: "provider_1",
          turnId: "turn-1",
          itemId: "item-1",
        },
      });
      await vi.waitFor(() => expect(harness.context.pendingUserInputs.size).toBe(1));
      const [requestId] = [...harness.context.pendingUserInputs.keys()];
      receive({
        method: "serverRequest/resolved",
        params: { threadId: "provider_1", requestId: "ui-1" },
      });
      await vi.waitFor(() =>
        expect(emitted).toContainEqual(
          expect.objectContaining({ method: "item/tool/requestUserInput/resolved", requestId }),
        ),
      );
      expect(harness.context.pendingUserInputs.size).toBe(0);
    } finally {
      harness.manager.stopAll();
    }
  });
});

const closeStdout = (child: FakeChild) => {
  child.stdout.end();
  child.stdout.resume();
};

describe("transport loss", () => {
  it("ends the session soon after stdout closes while the process keeps running", async () => {
    const { manager, internals, child, context, events } = createProcessHarness();
    const pending = internals.sendRequest(context, "turn/start", {});

    closeStdout(child);

    await expect(pending).rejects.toThrow(
      "turn/start failed: codex app-server closed its output stream.",
    );
    expect(child.killed).toBe(true);
    expect(manager.hasSession(asThreadId("thread_1"))).toBe(false);
    expect(events.filter((event) => event.method === "session/exited")).toEqual([
      {
        method: "session/exited",
        kind: "session",
        message: "codex app-server closed its output stream.",
      },
    ]);
  });

  it("does not end the session before the grace period", async () => {
    vi.useFakeTimers();
    try {
      const { manager, child, events } = createProcessHarness();
      child.stdout.emit("close");
      await vi.advanceTimersByTimeAsync(249);
      expect(manager.hasSession(asThreadId("thread_1"))).toBe(true);
      expect(events).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(manager.hasSession(asThreadId("thread_1"))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets a process exit during the grace period report the session end once", async () => {
    vi.useFakeTimers();
    try {
      const { child, events } = createProcessHarness();
      child.stdout.emit("close");
      child.stderr.end("boom\n");
      child.emit("exit", 1, null);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(events.filter((event) => event.method === "session/exited")).toEqual([
        expect.objectContaining({ message: expect.stringContaining("code=1") }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores an exit arriving after stdout close ended the session", async () => {
    vi.useFakeTimers();
    try {
      const { child, events } = createProcessHarness();
      child.stdout.emit("close");
      await vi.advanceTimersByTimeAsync(250);
      child.emit("exit", null, "SIGTERM");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(events.filter((event) => event.method === "session/exited")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stays quiet when the session was stopped", async () => {
    vi.useFakeTimers();
    try {
      const { manager, child, events } = createProcessHarness();
      child.stdout.emit("close");
      manager.stopSession(asThreadId("thread_1"));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(events.map((event) => event.method)).not.toContain("session/exited");
      expect(events.filter((event) => event.method === "session/closed")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ends the session on an oversized line without quoting it", async () => {
    const { manager, internals, child, context, events } = createProcessHarness();
    const pending = internals.sendRequest(context, "turn/start", {});

    child.stdout.emit("data", Buffer.alloc(128 * 1024 * 1024 + 1, 0x78));

    const error = await pending.catch((cause: Error) => cause);
    expect((error as Error).message).toBe(
      "turn/start failed: codex app-server sent a message over 128 MB.",
    );
    expect(child.killed).toBe(true);
    expect(manager.hasSession(asThreadId("thread_1"))).toBe(false);
    expect(events.map((event) => event.method)).toEqual(["session/exited"]);
    expect(events[0]?.message).toBe("codex app-server sent a message over 128 MB.");
  });
});

const send = (harness: ReturnType<typeof createProcessHarness>, params: unknown) => {
  const written: Array<Record<string, unknown>> = [];
  harness.child.stdin.on("data", (chunk: Buffer) => {
    written.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
  });
  harness.child.stdout.write(
    `${JSON.stringify({ id: 42, method: "item/tool/requestUserInput", params })}\n`,
  );
  return written;
};

describe("malformed requestUserInput", () => {
  it.each([[{ questions: "text" }], [{ questions: [] }], [{ questions: [null] }], [{}]])(
    "answers %j with a JSON-RPC error instead of waiting forever",
    async (params) => {
      const harness = createProcessHarness();
      const written = send(harness, params);

      await vi.waitFor(() => {
        expect(written).toEqual([
          {
            id: 42,
            error: { code: -32602, message: "requestUserInput needs at least one question." },
          },
        ]);
      });
      expect(harness.context.pendingUserInputs.size).toBe(0);
      expect(harness.events).toEqual([]);
    },
  );

  it("still surfaces a question with blank fields", async () => {
    const harness = createProcessHarness();
    const written = send(harness, { questions: [{ options: null }] });

    await vi.waitFor(() => {
      expect(harness.events.map((event) => event.method)).toEqual(["item/tool/requestUserInput"]);
    });
    expect(harness.context.pendingUserInputs.size).toBe(1);
    expect(written).toEqual([]);
  });
});

describe("generated image bytes", () => {
  it("never reach provider events", async () => {
    const harness = createProcessHarness();
    const payloads: unknown[] = [];
    harness.manager.on("event", (event) => payloads.push(event.payload));

    harness.child.stdout.write(
      `${JSON.stringify({
        method: "item/completed",
        params: {
          turnId: "turn-1",
          item: {
            type: "imageGeneration",
            id: "image-1",
            status: "completed",
            result: "aW1hZ2UtYnl0ZXM=",
            savedPath: "/tmp/a.png",
          },
        },
      })}\n`,
    );

    await vi.waitFor(() => expect(payloads).toHaveLength(1));
    expect(JSON.stringify(payloads[0])).not.toContain("aW1hZ2UtYnl0ZXM=");
    expect(JSON.stringify(payloads[0])).toContain("/tmp/a.png");
  });
});

describe("sandbox permission and MCP elicitation requests", () => {
  it("prompts for a permission request and answers with the granted profile", async () => {
    const harness = createProcessHarness();
    const { emitted, written, receive } = captureProtocol(harness);
    const permissions = { fileSystem: { write: ["/tmp/out"] } };
    try {
      receive({
        id: 9,
        method: "item/permissions/requestApproval",
        params: { threadId: "provider_1", turnId: "turn-1", itemId: "item-1", permissions },
      });
      await vi.waitFor(() => expect(harness.context.pendingApprovals.size).toBe(1));
      expect(written).toEqual([]);
      const request = emitted.find((e) => e.method === "item/permissions/requestApproval");
      expect(request).toMatchObject({ kind: "request", requestKind: "file-change" });

      await harness.manager.respondToRequest(
        asThreadId("thread_1"),
        ApprovalRequestId.makeUnsafe(request!.requestId!),
        "acceptForSession",
      );
      await vi.waitFor(() => expect(written).toHaveLength(1));
      expect(written[0]).toEqual({ id: 9, result: { permissions, scope: "session" } });
    } finally {
      harness.manager.stopAll();
    }
  });

  it("answers a declined permission request with an empty grant", async () => {
    const harness = createProcessHarness();
    const { emitted, written, receive } = captureProtocol(harness);
    try {
      receive({
        id: 10,
        method: "item/permissions/requestApproval",
        params: { threadId: "provider_1", permissions: { network: { enabled: true } } },
      });
      await vi.waitFor(() => expect(harness.context.pendingApprovals.size).toBe(1));
      const request = emitted.find((e) => e.method === "item/permissions/requestApproval");
      await harness.manager.respondToRequest(
        asThreadId("thread_1"),
        ApprovalRequestId.makeUnsafe(request!.requestId!),
        "decline",
      );
      await vi.waitFor(() => expect(written).toHaveLength(1));
      expect(written[0]).toEqual({ id: 10, result: { permissions: {} } });
    } finally {
      harness.manager.stopAll();
    }
  });

  it("prompts for an MCP elicitation and answers with an elicitation action", async () => {
    const harness = createProcessHarness();
    const { emitted, written, receive } = captureProtocol(harness);
    try {
      (harness.context.session as { activeTurnId?: TurnId }).activeTurnId =
        TurnId.makeUnsafe("turn-active");
      receive({
        id: 11,
        method: "mcpServer/elicitation/request",
        params: {
          threadId: "provider_1",
          serverName: "gmail",
          mode: "form",
          message: "Allow ChatGPT to use Gmail?",
          requestedSchema: { type: "object", properties: {} },
        },
      });
      await vi.waitFor(() => expect(harness.context.pendingApprovals.size).toBe(1));
      const request = emitted.find((e) => e.method === "mcpServer/elicitation/request");
      // No turnId on the wire: the card is attributed to the running turn.
      expect(request?.turnId).toBe("turn-active");
      expect([...harness.context.pendingApprovals.values()][0]?.turnId).toBe("turn-active");
      await harness.manager.respondToRequest(
        asThreadId("thread_1"),
        ApprovalRequestId.makeUnsafe(request!.requestId!),
        "accept",
      );
      await vi.waitFor(() => expect(written).toHaveLength(1));
      expect(written[0]).toEqual({ id: 11, result: { action: "accept", content: {} } });
    } finally {
      harness.manager.stopAll();
    }
  });

  it("declines an MCP elicitation it cannot satisfy without prompting", async () => {
    const harness = createProcessHarness();
    const { emitted, written, receive } = captureProtocol(harness);
    try {
      receive({
        id: 12,
        method: "mcpServer/elicitation/request",
        params: { threadId: "provider_1", serverName: "x", mode: "url", message: "Open link" },
      });
      await vi.waitFor(() => expect(written).toHaveLength(1));
      expect(written[0]).toEqual({ id: 12, result: { action: "decline" } });
      expect(harness.context.pendingApprovals.size).toBe(0);
      expect(emitted.map((e) => e.method)).not.toContain("mcpServer/elicitation/request");
    } finally {
      harness.manager.stopAll();
    }
  });
});

const approvalRequest = (id: number, kind: "commandExecution" | "fileChange") => ({
  id,
  method: `item/${kind}/requestApproval`,
  params: { threadId: "provider_1", turnId: "turn-1", itemId: `item-${id}` },
});

const command = (id: number, extra: Record<string, unknown>) => ({
  id,
  method: "item/commandExecution/requestApproval",
  params: { threadId: "provider_1", turnId: "turn-1", itemId: `c${id}`, ...extra },
});

describe("session-wide approvals", () => {
  it("auto-approves later requests of a kind allowed for the session", async () => {
    const harness = createProcessHarness();
    const { emitted, written, receive } = captureProtocol(harness);
    try {
      receive(approvalRequest(1, "commandExecution"));
      await vi.waitFor(() => expect(harness.context.pendingApprovals.size).toBe(1));
      const first = emitted.find((e) => e.kind === "request");
      await harness.manager.respondToRequest(
        asThreadId("thread_1"),
        ApprovalRequestId.makeUnsafe(first!.requestId!),
        "acceptForSession",
      );
      await vi.waitFor(() => expect(written).toHaveLength(1));

      receive(approvalRequest(2, "commandExecution"));
      await vi.waitFor(() => expect(written).toHaveLength(2));
      expect(written[1]).toEqual({ id: 2, result: { decision: "acceptForSession" } });
      expect(harness.context.pendingApprovals.size).toBe(0);
      expect(emitted.filter((e) => e.kind === "request")).toHaveLength(1);

      // Only commands were allowed, so a file change still prompts.
      receive(approvalRequest(3, "fileChange"));
      await vi.waitFor(() => expect(harness.context.pendingApprovals.size).toBe(1));
      expect(written).toHaveLength(2);
    } finally {
      harness.manager.stopAll();
    }
  });

  it("still prompts for an escalated command after a plain one was allowed", async () => {
    const harness = createProcessHarness();
    const { emitted, written, receive } = captureProtocol(harness);
    try {
      receive(command(1, { command: "ls" }));
      await vi.waitFor(() => expect(harness.context.pendingApprovals.size).toBe(1));
      await harness.manager.respondToRequest(
        asThreadId("thread_1"),
        ApprovalRequestId.makeUnsafe(emitted.find((e) => e.kind === "request")!.requestId!),
        "acceptForSession",
      );

      receive(command(2, { command: "ls -la" }));
      await vi.waitFor(() =>
        expect(written).toContainEqual({ id: 2, result: { decision: "acceptForSession" } }),
      );

      // Codex passes the model's justification as `reason` when it asks to leave the sandbox.
      receive(command(3, { command: "touch file", reason: "needs write" }));
      await vi.waitFor(() => expect(harness.context.pendingApprovals.size).toBe(1));
      expect(written.map((message) => message.id)).not.toContain(3);
    } finally {
      harness.manager.stopAll();
    }
  });

  it("keeps prompting for subagent conversations after the parent allows a kind", async () => {
    const harness = createProcessHarness();
    const { emitted, written, receive } = captureProtocol(harness);
    try {
      receive(approvalRequest(1, "commandExecution"));
      await vi.waitFor(() => expect(harness.context.pendingApprovals.size).toBe(1));
      await harness.manager.respondToRequest(
        asThreadId("thread_1"),
        ApprovalRequestId.makeUnsafe(emitted.find((e) => e.kind === "request")!.requestId!),
        "acceptForSession",
      );
      await vi.waitFor(() => expect(written).toHaveLength(1));

      receive({ ...approvalRequest(2, "commandExecution"), params: { threadId: "child_1" } });
      await vi.waitFor(() => expect(harness.context.pendingApprovals.size).toBe(1));
      expect(written).toHaveLength(1);
    } finally {
      harness.manager.stopAll();
    }
  });

  it("keeps prompting after a one-time accept or a session-wide permission grant", async () => {
    const harness = createProcessHarness();
    const { emitted, written, receive } = captureProtocol(harness);
    try {
      receive(approvalRequest(1, "commandExecution"));
      await vi.waitFor(() => expect(harness.context.pendingApprovals.size).toBe(1));
      await harness.manager.respondToRequest(
        asThreadId("thread_1"),
        ApprovalRequestId.makeUnsafe(emitted.find((e) => e.kind === "request")!.requestId!),
        "accept",
      );
      receive({
        id: 2,
        method: "item/permissions/requestApproval",
        params: { threadId: "provider_1", permissions: { network: { enabled: true } } },
      });
      await vi.waitFor(() => expect(harness.context.pendingApprovals.size).toBe(1));
      await harness.manager.respondToRequest(
        asThreadId("thread_1"),
        ApprovalRequestId.makeUnsafe(emitted.filter((e) => e.kind === "request")[1]!.requestId!),
        "acceptForSession",
      );

      receive(approvalRequest(3, "commandExecution"));
      await vi.waitFor(() => expect(harness.context.pendingApprovals.size).toBe(1));
      expect(written.map((message) => message.id)).toEqual([1, 2]);
    } finally {
      harness.manager.stopAll();
    }
  });
});

let answerStart: (value: unknown) => void = noop;

describe("capacity retries", () => {
  const CAPACITY_ERROR = {
    message: "Selected model is at capacity. Please try a different model.",
    codexErrorInfo: "serverOverloaded",
  };

  function createCapacityHarness() {
    vi.useFakeTimers();
    const harness = createProcessHarness();
    const internals = harness.manager as unknown as {
      handleStdoutLine: (context: unknown, line: string) => void;
    };
    const emitted: Array<{ method: string; turnId?: string; payload?: any; requestId?: string }> =
      [];
    harness.manager.on("event", (event) => emitted.push(event as (typeof emitted)[number]));
    const turnStarts: Array<{ input: unknown; [key: string]: unknown }> = [];
    const interrupts: unknown[] = [];
    const sendRequest = vi
      .spyOn(
        harness.manager as unknown as { sendRequest: (...args: unknown[]) => Promise<unknown> },
        "sendRequest",
      )
      .mockImplementation(async (...args: unknown[]) => {
        const [, method, params] = args as [unknown, string, { input: unknown }];
        if (method === "turn/interrupt") {
          interrupts.push(params);
          return {};
        }
        if (method === "turn/start") {
          turnStarts.push(params);
          return { turn: { id: `native-${turnStarts.length}` } };
        }
        return {};
      });
    const notify = (method: string, params: Record<string, unknown>) =>
      internals.handleStdoutLine(
        harness.context,
        JSON.stringify({ method, params: { threadId: "provider_1", ...params } }),
      );
    const capacityError = (turnId: string) =>
      notify("error", { turnId, willRetry: false, error: CAPACITY_ERROR });
    const completed = (turnId: string, status: string, error: unknown = null) =>
      notify("turn/completed", { turn: { id: turnId, status, error } });
    const overload = (turnId: string) => {
      capacityError(turnId);
      completed(turnId, "failed", CAPACITY_ERROR);
    };
    const send = () =>
      harness.manager.sendTurn({
        threadId: asThreadId("thread_1"),
        input: "hello",
        model: "gpt-5.3-codex",
      });
    const warnings = () =>
      emitted.filter((event) => event.method === "error" && event.payload?.willRetry === true);
    const terminalEvents = () =>
      emitted.filter(
        (event) =>
          event.method === "turn/completed" ||
          (event.method === "error" && event.payload?.willRetry === false),
      );
    return {
      ...harness,
      emitted,
      turnStarts,
      interrupts,
      sendRequest,
      notify,
      capacityError,
      completed,
      overload,
      send,
      warnings,
      terminalEvents,
    };
  }
  type CapacityHarness = ReturnType<typeof createCapacityHarness>;

  const withCapacityHarness = (run: (harness: CapacityHarness) => Promise<void>) => async () => {
    const harness = createCapacityHarness();
    try {
      await run(harness);
    } finally {
      harness.manager.stopAll();
      vi.useRealTimers();
    }
  };

  it(
    "continues with empty input under the same turn id and hides the failure",
    withCapacityHarness(async (h) => {
      const { turnId } = await h.send();
      expect(turnId).toBe("native-1");
      h.notify("turn/started", { turn: { id: "native-1" } });
      h.overload("native-1");

      expect(h.terminalEvents()).toEqual([]);
      expect(h.warnings()).toHaveLength(1);
      expect(h.warnings()[0]).toMatchObject({
        turnId: "native-1",
        payload: {
          error: { message: "The model is at capacity. Retrying in 2s (attempt 1 of 5)." },
        },
      });
      expect(h.context.session).toMatchObject({ status: "running", activeTurnId: "native-1" });
      expect(h.turnStarts).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(1_999);
      expect(h.turnStarts).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.turnStarts[1]).toMatchObject({
        threadId: "provider_1",
        input: [],
        model: "gpt-5.3-codex",
        summary: "detailed",
      });

      const startsBefore = h.emitted.filter((event) => event.method === "turn/started").length;
      h.notify("turn/started", { turn: { id: "native-2" } });
      h.notify("item/agentMessage/delta", { turnId: "native-2", itemId: "m1", delta: "hi" });
      h.completed("native-2", "completed");

      expect(h.emitted.filter((event) => event.method === "turn/started")).toHaveLength(
        startsBefore,
      );
      expect(h.emitted.find((event) => event.method === "item/agentMessage/delta")?.turnId).toBe(
        "native-1",
      );
      expect(h.terminalEvents()).toHaveLength(1);
      expect(h.terminalEvents()[0]).toMatchObject({
        method: "turn/completed",
        turnId: "native-1",
      });
      expect(h.context.session.status).toBe("ready");
      expect(h.manager.listSessions()[0]?.activeTurnId).toBeUndefined();
      expect(h.warnings()).toHaveLength(1);
    }),
  );

  it(
    "retries when only turn/completed reports the capacity failure",
    withCapacityHarness(async (h) => {
      await h.send();
      h.completed("native-1", "failed", CAPACITY_ERROR);
      expect(h.terminalEvents()).toEqual([]);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(h.turnStarts[1]?.input).toEqual([]);
    }),
  );

  it(
    "uses an earlier error's code when turn/completed does not classify the failure",
    withCapacityHarness(async (h) => {
      await h.send();
      h.capacityError("native-1");
      h.completed("native-1", "failed", { message: "failed" });
      expect(h.terminalEvents()).toEqual([]);
      expect(h.warnings()).toHaveLength(1);
    }),
  );

  it(
    "routes approval requests from a retried turn to the logical turn",
    withCapacityHarness(async (h) => {
      await h.send();
      h.overload("native-1");
      await vi.advanceTimersByTimeAsync(2_000);
      (
        h.manager as unknown as { handleStdoutLine: (context: unknown, line: string) => void }
      ).handleStdoutLine(
        h.context,
        JSON.stringify({
          id: 9,
          method: "item/commandExecution/requestApproval",
          params: { threadId: "provider_1", turnId: "native-2", itemId: "i1", command: "ls" },
        }),
      );
      expect(
        h.emitted.find((event) => event.method === "item/commandExecution/requestApproval")?.turnId,
      ).toBe("native-1");
    }),
  );

  it(
    "backs off and releases the real failure once retries run out",
    withCapacityHarness(async (h) => {
      await h.send();
      const delays = [2_000, 4_000, 8_000, 16_000, 30_000];
      for (const [index, delay] of delays.entries()) {
        h.overload(`native-${index + 1}`);
        expect(h.terminalEvents()).toEqual([]);
        expect(h.warnings()).toHaveLength(index + 1);
        await vi.advanceTimersByTimeAsync(delay - 1);
        expect(h.turnStarts).toHaveLength(index + 1);
        await vi.advanceTimersByTimeAsync(1);
        expect(h.turnStarts).toHaveLength(index + 2);
      }
      h.overload("native-6");

      expect(h.turnStarts).toHaveLength(6);
      expect(h.terminalEvents().map((event) => [event.method, event.turnId])).toEqual([
        ["error", "native-1"],
        ["turn/completed", "native-1"],
      ]);
      expect(h.context.session).toMatchObject({
        status: "error",
        lastError: CAPACITY_ERROR.message,
      });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(h.turnStarts).toHaveLength(6);
    }),
  );

  it(
    "keeps a send during a retry's turn/start apart from that retry's late turn/started",
    withCapacityHarness(async (h) => {
      await h.send();
      h.notify("turn/started", { turn: { id: "native-1" } });
      h.overload("native-1");

      let answerRetry: (value: unknown) => void = noop;
      h.sendRequest.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            answerRetry = resolve;
          }),
      );
      await vi.advanceTimersByTimeAsync(2_000);

      const nextSend = h.send();
      answerRetry({ turn: { id: "old-retry" } });
      await vi.advanceTimersByTimeAsync(0);
      h.notify("turn/started", { turn: { id: "old-retry" } });

      const { turnId } = await nextSend;
      expect(turnId).toBe("native-2");
      expect(h.context.session).toMatchObject({ activeTurnId: "native-2" });
    }),
  );

  it(
    "ends a retry turn that starts after its turn/start timed out, without showing it",
    withCapacityHarness(async (h) => {
      await h.send();
      h.notify("turn/started", { turn: { id: "native-1" } });
      h.overload("native-1");

      h.sendRequest.mockImplementationOnce(() =>
        Promise.reject(new Error("Timed out waiting for turn/start.")),
      );
      await vi.advanceTimersByTimeAsync(2_000);
      expect(h.terminalEvents().map((event) => event.method)).toEqual(["error", "turn/completed"]);
      const shown = h.emitted.length;

      h.notify("turn/started", { turn: { id: "late-retry" } });
      await vi.advanceTimersByTimeAsync(0);
      expect(h.interrupts).toEqual([{ threadId: "provider_1", turnId: "late-retry" }]);

      h.notify("item/started", { turnId: "late-retry", item: { type: "agentMessage", id: "m" } });
      h.completed("late-retry", "interrupted");
      expect(h.emitted).toHaveLength(shown);
      expect(h.context.session.status).toBe("error");

      // The next send owns whatever starts next.
      await h.send();
      h.notify("turn/started", { turn: { id: "native-3" } });
      expect(h.emitted.some((event) => event.turnId === "native-3")).toBe(true);
    }),
  );

  it(
    "does not treat a later turn as a retry that a rejected turn/start abandoned",
    withCapacityHarness(async (h) => {
      await h.send();
      h.overload("native-1");
      h.sendRequest.mockImplementationOnce(() => Promise.reject(new Error("turn/start rejected")));
      await vi.advanceTimersByTimeAsync(2_000);

      h.notify("turn/started", { turn: { id: "unrelated" } });
      expect(h.interrupts).toEqual([]);
      expect(h.emitted.some((event) => event.turnId === "unrelated")).toBe(true);
    }),
  );

  it(
    "gives each new user turn its own retry budget",
    withCapacityHarness(async (h) => {
      await h.send();
      h.overload("native-1");
      await vi.advanceTimersByTimeAsync(2_000);
      h.overload("native-2");
      await vi.advanceTimersByTimeAsync(4_000);
      h.completed("native-3", "completed");

      const { turnId } = await h.send();
      expect(turnId).toBe("native-4");
      h.overload("native-4");
      expect(h.warnings().at(-1)?.payload.error.message).toContain("Retrying in 2s (attempt 1 of");
      expect(h.warnings().at(-1)?.turnId).toBe("native-4");
    }),
  );

  it(
    "ends as interrupted when stopped during the wait, and a second Stop does nothing",
    withCapacityHarness(async (h) => {
      await h.send();
      h.overload("native-1");

      await h.manager.interruptTurn(asThreadId("thread_1"), TurnId.makeUnsafe("native-1"));
      expect(h.terminalEvents()).toHaveLength(1);
      expect(h.terminalEvents()[0]).toMatchObject({
        method: "turn/completed",
        turnId: "native-1",
        payload: { turn: { status: "interrupted", error: null } },
      });
      expect(h.context.session.status).toBe("ready");

      await h.manager.interruptTurn(asThreadId("thread_1"), TurnId.makeUnsafe("native-1"));
      await h.manager.interruptTurn(asThreadId("thread_1"));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(h.turnStarts).toHaveLength(1);
      expect(h.interrupts).toEqual([]);
      expect(h.terminalEvents()).toHaveLength(1);
    }),
  );

  it(
    "interrupts the native turn when Stop lands while the retry is starting",
    withCapacityHarness(async (h) => {
      await h.send();
      h.overload("native-1");

      h.sendRequest.mockImplementationOnce(() => new Promise((resolve) => (answerStart = resolve)));
      await vi.advanceTimersByTimeAsync(2_000);

      const stop = h.manager.interruptTurn(asThreadId("thread_1"), TurnId.makeUnsafe("native-1"));
      expect(h.interrupts).toEqual([]);
      answerStart({ turn: { id: "native-2" } });
      await stop;

      expect(h.interrupts).toEqual([{ threadId: "provider_1", turnId: "native-2" }]);
    }),
  );

  it(
    "translates Stop on a running retry to its native turn",
    withCapacityHarness(async (h) => {
      await h.send();
      h.overload("native-1");
      await vi.advanceTimersByTimeAsync(2_000);
      await h.manager.interruptTurn(asThreadId("thread_1"), TurnId.makeUnsafe("native-1"));
      expect(h.interrupts).toEqual([{ threadId: "provider_1", turnId: "native-2" }]);
    }),
  );

  it(
    "does not retry when the capacity failure answers a Stop",
    withCapacityHarness(async (h) => {
      await h.send();
      await h.manager.interruptTurn(asThreadId("thread_1"));
      h.overload("native-1");

      expect(h.warnings()).toEqual([]);
      expect(h.terminalEvents()).toHaveLength(1);
      expect(h.terminalEvents()[0]).toMatchObject({
        payload: { turn: { status: "interrupted" } },
      });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(h.turnStarts).toHaveLength(1);
    }),
  );

  it(
    "releases the held failure when the retry's turn/start is rejected",
    withCapacityHarness(async (h) => {
      await h.send();
      h.overload("native-1");
      h.sendRequest.mockRejectedValueOnce(new Error("turn/start failed: nope"));
      await vi.advanceTimersByTimeAsync(2_000);

      expect(h.terminalEvents().map((event) => event.method)).toEqual(["error", "turn/completed"]);
      expect(h.context.session.status).toBe("error");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(h.warnings()).toHaveLength(1);
    }),
  );

  it(
    "treats a user send during the wait as replacing the retry",
    withCapacityHarness(async (h) => {
      await h.send();
      h.overload("native-1");

      const { turnId } = await h.send();

      expect(turnId).toBe("native-2");
      expect(h.terminalEvents()[0]).toMatchObject({
        turnId: "native-1",
        payload: { turn: { status: "interrupted" } },
      });
      expect(h.turnStarts[1]?.input).toEqual([{ type: "text", text: "hello", text_elements: [] }]);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(h.turnStarts).toHaveLength(2);
      expect(h.manager.listSessions()[0]?.activeTurnId).toBe("native-2");
    }),
  );

  it(
    "cancels the wait when the session stops",
    withCapacityHarness(async (h) => {
      await h.send();
      h.overload("native-1");
      h.manager.stopSession(asThreadId("thread_1"));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(h.turnStarts).toHaveLength(1);
    }),
  );

  it(
    "ends the wait before a rollback rewinds the thread",
    withCapacityHarness(async (h) => {
      await h.send();
      h.overload("native-1");
      await h.manager.rollbackThread(asThreadId("thread_1"), 1).catch(() => undefined);
      expect(h.terminalEvents()[0]).toMatchObject({
        payload: { turn: { status: "interrupted" } },
      });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(h.turnStarts).toHaveLength(1);
    }),
  );

  it(
    "never retries a /compact turn",
    withCapacityHarness(async (h) => {
      await h.manager.sendTurn({ threadId: asThreadId("thread_1"), input: " /Compact " });
      h.overload("native-1");
      expect(h.warnings()).toEqual([]);
      expect(h.terminalEvents().map((event) => event.method)).toEqual(["error", "turn/completed"]);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(h.turnStarts).toHaveLength(1);
    }),
  );

  it(
    "never retries a failed subagent turn",
    withCapacityHarness(async (h) => {
      await h.send();
      h.context.collabReceiverTurns.set("child-thread", TurnId.makeUnsafe("native-1"));
      h.notify("turn/completed", {
        threadId: "child-thread",
        turn: { id: "child-turn", status: "failed", error: CAPACITY_ERROR },
      });
      h.notify("error", {
        threadId: "child-thread",
        turnId: "child-turn",
        willRetry: false,
        error: CAPACITY_ERROR,
      });
      expect(h.warnings()).toEqual([]);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(h.turnStarts).toHaveLength(1);
      expect(h.manager.listSessions()[0]?.activeTurnId).toBe("native-1");
    }),
  );

  it(
    "passes other failures straight through",
    withCapacityHarness(async (h) => {
      await h.send();
      const usageLimit = { message: "limit", codexErrorInfo: "usageLimitExceeded" };
      h.notify("error", { turnId: "native-1", willRetry: false, error: usageLimit });
      h.completed("native-1", "failed", usageLimit);
      expect(h.warnings()).toEqual([]);
      expect(h.terminalEvents().map((event) => event.method)).toEqual(["error", "turn/completed"]);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(h.turnStarts).toHaveLength(1);
    }),
  );

  it(
    "leaves Codex's own retries alone",
    withCapacityHarness(async (h) => {
      await h.send();
      h.notify("error", { turnId: "native-1", willRetry: true, error: CAPACITY_ERROR });
      expect(h.warnings()).toHaveLength(1);
      h.completed("native-1", "completed");
      expect(h.terminalEvents().map((event) => event.method)).toEqual(["turn/completed"]);
      expect(h.context.session.status).toBe("ready");
    }),
  );
});

describe("Stop ends the stopped turn's commands", () => {
  function createCommandHarness(
    respond: (method: string, params: Record<string, unknown>) => unknown = () => ({
      terminated: true,
    }),
  ) {
    const harness = createProcessHarness();
    const internals = harness.manager as unknown as {
      handleStdoutLine: (context: unknown, line: string) => void;
    };
    const emitted: Array<{ method: string; itemId?: string; turnId?: string; payload?: any }> = [];
    harness.manager.on("event", (event) => emitted.push(event as (typeof emitted)[number]));
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    vi.spyOn(
      harness.manager as unknown as { sendRequest: (...args: unknown[]) => Promise<unknown> },
      "sendRequest",
    ).mockImplementation(async (...args: unknown[]) => {
      const [, method, params] = args as [unknown, string, Record<string, unknown>];
      requests.push({ method, params });
      return method === "turn/interrupt" ? {} : respond(method, params);
    });
    const notify = (method: string, params: Record<string, unknown>) =>
      internals.handleStdoutLine(
        harness.context,
        JSON.stringify({ method, params: { threadId: "provider_1", ...params } }),
      );
    const startCommand = (
      turnId: string,
      id: string,
      overrides: Record<string, unknown> = {},
      threadId = "provider_1",
    ) =>
      notify("item/started", {
        threadId,
        turnId,
        item: {
          type: "commandExecution",
          id,
          command: "sleep 100",
          processId: `process-${id}`,
          status: "inProgress",
          ...overrides,
        },
      });
    const completeCommand = (turnId: string, id: string, status: string) =>
      notify("item/completed", {
        turnId,
        item: { type: "commandExecution", id, command: "sleep 100", status },
      });
    const completeTurn = (turnId: string, status: string) =>
      notify("turn/completed", { turn: { id: turnId, status, error: null } });
    const terminated = () =>
      requests
        .filter((request) => request.method === "thread/backgroundTerminals/terminate")
        .map((request) => request.params);
    const completions = () => emitted.filter((event) => event.method === "item/completed");
    return {
      ...harness,
      emitted,
      requests,
      notify,
      startCommand,
      completeCommand,
      completeTurn,
      terminated,
      completions,
      stop: (turnId: string) =>
        harness.manager.interruptTurn(asThreadId("thread_1"), TurnId.makeUnsafe(turnId)),
    };
  }

  it("terminates running commands along with the interrupt", async () => {
    const h = createCommandHarness();
    h.startCommand("turn-1", "a");
    h.startCommand("turn-1", "b");
    h.startCommand("turn-1", "done");
    h.completeCommand("turn-1", "done", "completed");

    await h.stop("turn-1");

    expect(h.requests.map((request) => request.method)).toContain("turn/interrupt");
    expect(h.terminated()).toEqual([
      { threadId: "provider_1", processId: "process-a" },
      { threadId: "provider_1", processId: "process-b" },
    ]);
  });

  it("targets the conversation that owns a child thread's command", async () => {
    const h = createCommandHarness();
    h.notify("item/started", {
      turnId: "turn-1",
      item: { type: "collabAgentToolCall", id: "spawn", receiverThreadIds: ["child_1"] },
    });
    h.startCommand("child-turn", "child-command", {}, "child_1");

    await h.stop("turn-1");

    expect(h.terminated()).toEqual([{ threadId: "child_1", processId: "process-child-command" }]);
  });

  it("leaves a command from an earlier turn running", async () => {
    const h = createCommandHarness();
    h.startCommand("turn-1", "dev-server");
    h.completeTurn("turn-1", "completed");
    h.startCommand("turn-2", "tests");

    await h.stop("turn-2");

    expect(h.terminated()).toEqual([{ threadId: "provider_1", processId: "process-tests" }]);
    h.completeTurn("turn-2", "interrupted");
    expect(h.completions().map((event) => event.itemId)).toEqual(["tests"]);
  });

  it("terminates a command that starts or reports its process after Stop", async () => {
    const h = createCommandHarness();
    h.startCommand("turn-1", "known-later", { processId: null });
    await h.stop("turn-1");
    expect(h.terminated()).toEqual([]);

    h.notify("item/commandExecution/terminalInteraction", {
      turnId: "turn-1",
      itemId: "known-later",
      processId: "process-known-later",
      stdin: "",
    });
    h.startCommand("turn-1", "late");

    expect(h.terminated().map((params) => params.processId)).toEqual([
      "process-known-later",
      "process-late",
    ]);
  });

  it("confirms through the list when Codex does not report termination", async () => {
    const pages: Record<string, unknown> = {
      first: { data: [{ processId: "other" }], nextCursor: "next" },
      next: { data: [], nextCursor: null },
    };
    const h = createCommandHarness((method, params) =>
      method === "thread/backgroundTerminals/list"
        ? pages[params.cursor === undefined ? "first" : String(params.cursor)]
        : { terminated: false },
    );
    h.startCommand("turn-1", "a");

    await h.stop("turn-1");

    expect(
      h.requests
        .filter((request) => request.method === "thread/backgroundTerminals/list")
        .map((request) => request.params),
    ).toEqual([{ threadId: "provider_1" }, { threadId: "provider_1", cursor: "next" }]);
  });

  it.each([
    ["an older CLI", "thread/backgroundTerminals/terminate failed: method not found"],
    ["an unloaded thread", "thread not found: provider_1"],
    ["another failure", "Timed out waiting for thread/backgroundTerminals/terminate."],
  ])("never fails Stop on %s", async (_name, message) => {
    const h = createCommandHarness(() => {
      throw new Error(message);
    });
    h.startCommand("turn-1", "a");

    await expect(h.stop("turn-1")).resolves.toBeUndefined();
    expect(h.requests.map((request) => request.method)).toContain("turn/interrupt");
  });

  it("does not fail Stop when a terminal stays listed", async () => {
    const h = createCommandHarness((method) =>
      method === "thread/backgroundTerminals/list"
        ? { data: [{ processId: "process-a" }], nextCursor: null }
        : { terminated: false },
    );
    h.startCommand("turn-1", "a");

    await expect(h.stop("turn-1")).resolves.toBeUndefined();
  });

  it("marks a terminated command stopped instead of failed", async () => {
    const h = createCommandHarness();
    h.startCommand("turn-1", "a");
    h.completeCommand("turn-1", "unrelated", "failed");
    expect(h.completions()[0]?.payload.item.status).toBe("failed");

    await h.stop("turn-1");
    h.completeCommand("turn-1", "a", "failed");

    expect(h.completions()[1]?.payload.item.status).toBe("stopped");
  });

  it("closes orphaned commands before the turn ends and drops their late completion", async () => {
    const h = createCommandHarness();
    h.startCommand("turn-1", "orphan");
    await h.stop("turn-1");

    h.completeTurn("turn-1", "interrupted");

    expect(
      h.emitted
        .filter((event) => event.method === "item/completed" || event.method === "turn/completed")
        .map((event) => event.method),
    ).toEqual(["item/completed", "turn/completed"]);
    expect(h.completions()[0]).toMatchObject({
      itemId: "orphan",
      turnId: "turn-1",
      payload: { item: { id: "orphan", command: "sleep 100", status: "stopped" } },
    });

    h.completeCommand("turn-1", "orphan", "failed");
    expect(h.completions()).toHaveLength(1);
  });

  it("does not touch a turn that ended on its own", () => {
    const h = createCommandHarness();
    h.startCommand("turn-1", "server");

    h.completeTurn("turn-1", "completed");
    h.completeCommand("turn-1", "server", "failed");

    expect(h.terminated()).toEqual([]);
    expect(h.completions().map((event) => event.payload.item.status)).toEqual(["failed"]);
  });

  it("terminates a process reported after the stopped turn closed its row", async () => {
    const h = createCommandHarness();
    h.startCommand("turn-1", "slow", { processId: null });
    await h.stop("turn-1");
    h.completeTurn("turn-1", "interrupted");
    expect(h.completions()[0]?.payload.item.status).toBe("stopped");
    expect(h.terminated()).toEqual([]);

    const report = () =>
      h.notify("item/commandExecution/terminalInteraction", {
        turnId: "turn-1",
        itemId: "slow",
        processId: "process-slow",
        stdin: "",
      });
    report();
    report();

    expect(h.terminated()).toEqual([{ threadId: "provider_1", processId: "process-slow" }]);
  });

  it("marks commands stopped when Stop arrives before turn/start is answered", async () => {
    const h = createCommandHarness();
    Object.assign(h.context, { account: { type: "unknown", planType: null, sparkEnabled: true } });
    let answerStart: (value: unknown) => void = noop;
    vi.mocked(
      (h.manager as unknown as { sendRequest: (...args: unknown[]) => Promise<unknown> })
        .sendRequest,
    ).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answerStart = resolve;
        }),
    );
    const sent = h.manager.sendTurn({ threadId: asThreadId("thread_1"), input: "hi" });
    await new Promise((resolve) => setImmediate(resolve));
    const stopped = h.manager.interruptTurn(asThreadId("thread_1"));

    answerStart({ turn: { id: "turn-1" } });
    await sent;
    await stopped;
    expect(h.requests).toContainEqual({
      method: "turn/interrupt",
      params: { threadId: "provider_1", turnId: "turn-1" },
    });

    h.startCommand("turn-1", "late");
    expect(h.terminated()).toEqual([{ threadId: "provider_1", processId: "process-late" }]);
    h.completeCommand("turn-1", "late", "failed");
    expect(h.completions()[0]?.payload.item.status).toBe("stopped");
  });

  it.each([
    { turnStatus: "failed", rowStatus: "failed" },
    { turnStatus: "interrupted", rowStatus: "stopped" },
  ])(
    "closes open rows of a turn that ended $turnStatus without Stop, terminating nothing",
    ({ turnStatus, rowStatus }) => {
      const h = createCommandHarness();
      h.startCommand("turn-1", "a", { processId: null });
      h.completeTurn("turn-1", turnStatus);

      expect(h.completions().map((event) => event.payload.item.status)).toEqual([rowStatus]);
      h.notify("item/commandExecution/terminalInteraction", {
        turnId: "turn-1",
        itemId: "a",
        processId: "process-a",
        stdin: "",
      });
      h.completeCommand("turn-1", "a", "completed");

      expect(h.terminated()).toEqual([]);
      expect(h.completions()).toHaveLength(1);
    },
  );

  it("forgets the stop when the interrupt fails", async () => {
    const h = createCommandHarness();
    vi.mocked(
      (h.manager as unknown as { sendRequest: (...args: unknown[]) => Promise<unknown> })
        .sendRequest,
    ).mockImplementation(async (...args: unknown[]) => {
      if (args[1] === "turn/interrupt") throw new Error("interrupt failed");
      return { terminated: true };
    });
    h.startCommand("turn-1", "a");

    await expect(h.stop("turn-1")).rejects.toThrow("interrupt failed");
    h.completeCommand("turn-1", "a", "failed");

    expect(h.completions()[0]?.payload.item.status).toBe("failed");
  });
});

// Recorded from CLI 0.166 against a failing model endpoint.
const failCompaction = (h: {
  readonly notify: (method: string, params: Record<string, unknown>) => void;
}) => {
  const error = { message: "boom", codexErrorInfo: "other" };
  h.notify("error", { turnId: "c-turn", willRetry: false, error });
  h.notify("turn/completed", { turn: { id: "c-turn", status: "failed", error } });
};

describe("compaction turns", () => {
  function createCompactionHarness(accept: () => unknown = () => ({})) {
    vi.useFakeTimers();
    const harness = createProcessHarness();
    const internals = harness.manager as unknown as {
      handleStdoutLine: (context: unknown, line: string) => void;
    };
    const emitted: Array<{ method: string; itemId?: string; turnId?: string; payload?: any }> = [];
    harness.manager.on("event", (event) => emitted.push(event as (typeof emitted)[number]));
    vi.spyOn(
      harness.manager as unknown as { sendRequest: (...args: unknown[]) => Promise<unknown> },
      "sendRequest",
    ).mockImplementation(async () => accept());
    const notify = (method: string, params: Record<string, unknown>) =>
      internals.handleStdoutLine(
        harness.context,
        JSON.stringify({ method, params: { threadId: "provider_1", ...params } }),
      );
    const compact = () => harness.manager.compactThread(asThreadId("thread_1"));
    const start = async () => {
      const compacting = compact();
      await vi.advanceTimersByTimeAsync(0);
      notify("turn/started", { turn: { id: "c-turn", status: "inProgress" } });
      await compacting;
    };
    const startItem = () =>
      notify("item/started", {
        turnId: "c-turn",
        item: { type: "contextCompaction", id: "c-item" },
      });
    const ofMethod = (method: string) => emitted.filter((event) => event.method === method);
    const context = harness.context as unknown as CodexSessionContext;
    return { ...harness, context, emitted, notify, compact, start, startItem, ofMethod };
  }
  type CompactionHarness = ReturnType<typeof createCompactionHarness>;

  const withHarness =
    (run: (h: CompactionHarness) => Promise<void>, accept?: () => unknown) => async () => {
      const h = createCompactionHarness(accept);
      try {
        await run(h);
      } finally {
        h.manager.stopAll();
        vi.useRealTimers();
      }
    };

  it(
    "settles to ready when an accepted compaction fails, reporting through its row",
    withHarness(async (h) => {
      await h.start();
      h.startItem();
      expect(h.context.session).toMatchObject({ status: "running", activeTurnId: "c-turn" });

      failCompaction(h);

      expect(h.context.session).toMatchObject({ status: "ready", activeTurnId: undefined });
      expect(h.context.session.lastError).toBeUndefined();
      expect(h.ofMethod("error")).toEqual([]);
      expect(h.ofMethod("item/completed")).toMatchObject([
        {
          itemId: "c-item",
          turnId: "c-turn",
          payload: {
            item: { type: "contextCompaction", id: "c-item", status: "failed" },
            message: "boom",
          },
        },
      ]);
      expect(h.ofMethod("turn/completed")).toMatchObject([
        { turnId: "c-turn", payload: { turn: { status: "completed", error: null } } },
      ]);
    }),
  );

  it(
    "still reports a compaction that failed before its item started",
    withHarness(async (h) => {
      await h.start();
      failCompaction(h);
      expect(h.ofMethod("item/completed")).toMatchObject([
        {
          itemId: "c-turn:compaction",
          payload: { item: { type: "contextCompaction", status: "failed" }, message: "boom" },
        },
      ]);
    }),
  );

  it(
    "closes an open row when the compaction is stopped",
    withHarness(async (h) => {
      await h.start();
      h.startItem();
      h.notify("turn/completed", { turn: { id: "c-turn", status: "interrupted", error: null } });

      expect(h.context.session.status).toBe("ready");
      expect(h.ofMethod("item/completed")).toMatchObject([
        { itemId: "c-item", payload: { item: { status: "failed" } } },
      ]);
      expect(h.ofMethod("turn/completed")).toMatchObject([
        { payload: { turn: { status: "interrupted" } } },
      ]);
    }),
  );

  it(
    "adds nothing to a compaction that succeeds",
    withHarness(async (h) => {
      await h.start();
      h.startItem();
      h.notify("item/completed", {
        turnId: "c-turn",
        item: { type: "contextCompaction", id: "c-item" },
      });
      h.notify("turn/completed", { turn: { id: "c-turn", status: "completed", error: null } });

      expect(h.ofMethod("item/completed")).toHaveLength(1);
      expect(h.ofMethod("item/completed")[0]?.payload.item).not.toHaveProperty("status");
      expect(h.context.session.status).toBe("ready");
      expect(h.context.compactionTurn).toBeUndefined();
    }),
  );

  it(
    "resolves when turn/started arrived ahead of the response",
    withHarness(async (h) => {
      const accepting = vi.mocked(
        (h.manager as unknown as { sendRequest: (...args: unknown[]) => Promise<unknown> })
          .sendRequest,
      );
      accepting.mockImplementationOnce(async () => {
        h.notify("turn/started", { turn: { id: "early" } });
        return {};
      });
      await h.compact();
      expect(h.context.compactionTurn).toMatchObject({ nativeTurnId: "early" });
      expect(h.context.compactionTurnIds).toEqual(new Set(["early"]));
    }),
  );

  it(
    "leaves errors of a later user turn alone",
    withHarness(async (h) => {
      await h.start();
      h.notify("turn/completed", { turn: { id: "c-turn", status: "completed", error: null } });
      h.notify("turn/started", { turn: { id: "user-turn" } });
      const error = { message: "boom", codexErrorInfo: "other" };
      h.notify("error", { turnId: "user-turn", willRetry: false, error });
      h.notify("turn/completed", { turn: { id: "user-turn", status: "failed", error } });

      expect(h.context.session).toMatchObject({ status: "error", lastError: "boom" });
      expect(h.ofMethod("error")).toHaveLength(1);
    }),
  );

  it(
    "fails the request when Codex accepts it but never starts the turn",
    withHarness(async (h) => {
      const compacting = h.compact();
      const rejected = expect(compacting).rejects.toThrow("never started");
      await vi.advanceTimersByTimeAsync(20_000);
      await rejected;
    }),
  );

  it(
    "fails the wait when the session ends first",
    withHarness(async (h) => {
      const compacting = h.compact();
      const rejected = expect(compacting).rejects.toThrow("Session ended");
      await vi.advanceTimersByTimeAsync(0);
      h.manager.stopSession(asThreadId("thread_1"));
      await rejected;
    }),
  );
});

describe("subagent reasoning", () => {
  it("stays out of the parent's turn", () => {
    const { manager, context, emitEvent } = createCollabNotificationHarness();
    const handle = (method: string, params: Record<string, unknown>) =>
      (
        manager as unknown as {
          handleServerNotification: (context: unknown, notification: unknown) => void;
        }
      ).handleServerNotification(context, { method, params });
    context.collabReceiverTurns.set("child", "turn_parent");
    const child = { threadId: "child", turnId: "child-turn", itemId: "r" };

    handle("item/started", { ...child, item: { type: "reasoning", id: "r" } });
    handle("item/reasoning/summaryPartAdded", { ...child, summaryIndex: 0 });
    handle("item/reasoning/summaryTextDelta", { ...child, delta: "thinking" });
    handle("item/completed", { ...child, item: { type: "reasoning", id: "r" } });
    expect(emitEvent).not.toHaveBeenCalled();

    handle("item/started", { threadId: "child", item: { type: "commandExecution", id: "c" } });
    expect(emitEvent).toHaveBeenCalledTimes(1);
  });
});

const providerGoal = (status: string, objective = "Ship it") => ({
  threadId: "provider_1",
  objective,
  status,
  tokenBudget: null,
  tokensUsed: 0,
  timeUsedSeconds: 0,
});

describe("Codex goals", () => {
  const GRACE_MS = 5_000;
  const CAPACITY_ERROR = {
    message: "Selected model is at capacity. Please try a different model.",
    codexErrorInfo: "serverOverloaded",
  };

  function createGoalHarness() {
    vi.useFakeTimers();
    const harness = createProcessHarness();
    const context = harness.context as unknown as CodexSessionContext;
    const internals = harness.manager as unknown as {
      handleStdoutLine: (context: unknown, line: string) => void;
    };
    const emitted: Array<{ method: string; turnId?: string; payload?: any }> = [];
    harness.manager.on("event", (event) => emitted.push(event as (typeof emitted)[number]));
    const requests: Array<{ method: string; params: any }> = [];
    let turnStarts = 0;
    const sendRequest = vi
      .spyOn(
        harness.manager as unknown as { sendRequest: (...args: unknown[]) => Promise<unknown> },
        "sendRequest",
      )
      .mockImplementation(async (...args: unknown[]) => {
        const [, method, params] = args as [unknown, string, any];
        requests.push({ method, params });
        if (method === "turn/start") {
          turnStarts += 1;
          return { turn: { id: `native-${turnStarts}` } };
        }
        if (method === "thread/goal/set") {
          return { goal: providerGoal(params.status, params.objective) };
        }
        if (method === "thread/goal/clear") return { cleared: true };
        if (method === "thread/goal/get") return { goal: null };
        return {};
      });
    const notify = (method: string, params: Record<string, unknown>) =>
      internals.handleStdoutLine(
        harness.context,
        JSON.stringify({ method, params: { threadId: "provider_1", ...params } }),
      );
    const started = (turnId: string) => notify("turn/started", { turn: { id: turnId } });
    const completed = (turnId: string, status = "completed") =>
      notify("turn/completed", { turn: { id: turnId, status, error: null } });
    const goalUpdated = (status: string) =>
      notify("thread/goal/updated", { turnId: null, goal: providerGoal(status) });
    const send = () =>
      harness.manager.sendTurn({ threadId: asThreadId("thread_1"), input: "Ship it" });
    const goalRequest = (request: Parameters<CodexAppServerManager["runGoalRequest"]>[1]) =>
      harness.manager.runGoalRequest(asThreadId("thread_1"), request);
    const stop = () => harness.manager.interruptTurn(asThreadId("thread_1"));
    const eventsNamed = (method: string) => emitted.filter((event) => event.method === method);
    const requestsNamed = (method: string) => requests.filter((entry) => entry.method === method);
    /** Leaves the next request unanswered until the test settles it. */
    const deferNextRequest = () => {
      let resolve!: (value: unknown) => void;
      let reject!: (error: Error) => void;
      const pending = new Promise<unknown>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
      });
      sendRequest.mockImplementationOnce(() => pending);
      return { resolve, reject };
    };
    /** Answers the first turn/start in one stdout chunk with the turn's start and completion. */
    const answerTurnStartInOneChunk = () => {
      sendRequest.mockRestore();
      harness.child.stdin.on("data", (chunk: Buffer) => {
        const message = JSON.parse(chunk.toString()) as { id: number; method: string };
        if (message.method !== "turn/start") return;
        const threadId = "provider_1";
        harness.child.stdout.write(
          [
            { method: "turn/started", params: { threadId, turn: { id: "native-1" } } },
            { id: message.id, result: { turn: { id: "native-1" } } },
            {
              method: "turn/completed",
              params: { threadId, turn: { id: "native-1", status: "completed", error: null } },
            },
          ]
            .map((line) => `${JSON.stringify(line)}\n`)
            .join(""),
        );
      });
    };
    return {
      ...harness,
      context,
      emitted,
      requests,
      sendRequest,
      deferNextRequest,
      answerTurnStartInOneChunk,
      notify,
      started,
      completed,
      goalUpdated,
      send,
      goalRequest,
      stop,
      eventsNamed,
      requestsNamed,
    };
  }
  type GoalHarness = ReturnType<typeof createGoalHarness>;

  const withGoalHarness = (run: (harness: GoalHarness) => Promise<void>) => async () => {
    const harness = createGoalHarness();
    try {
      await run(harness);
    } finally {
      harness.manager.stopAll();
      vi.useRealTimers();
    }
  };

  it(
    "settles after the grace period when one chunk carries a goal turn's start, response and end",
    withGoalHarness(async (h) => {
      h.answerTurnStartInOneChunk();
      h.goalUpdated("active");

      await expect(h.send()).resolves.toMatchObject({ turnId: "native-1" });
      expect(h.context.turnRun?.goalHold).toBe(true);
      expect(h.eventsNamed("turn/completed")).toEqual([]);
      expect(h.context.session).toMatchObject({ status: "running", activeTurnId: "native-1" });

      await vi.advanceTimersByTimeAsync(GRACE_MS);

      expect(h.eventsNamed("turn/completed")).toHaveLength(1);
      expect(h.context.session.status).toBe("ready");
      expect(h.context.session.activeTurnId).toBeUndefined();
    }),
  );

  it(
    "continues into the next goal turn when one chunk carried the last one's start, response and end",
    withGoalHarness(async (h) => {
      h.answerTurnStartInOneChunk();
      h.goalUpdated("active");
      await h.send();

      h.started("goal-2");
      await vi.advanceTimersByTimeAsync(GRACE_MS * 2);

      expect(h.eventsNamed("turn/started")).toHaveLength(1);
      expect(h.eventsNamed("turn/completed")).toEqual([]);
      expect(h.context.turnRun?.nativeTurnId).toBe("goal-2");

      h.goalUpdated("complete");
      h.completed("goal-2");
      expect(h.eventsNamed("turn/completed")).toHaveLength(1);
      expect(h.eventsNamed("turn/completed")[0]?.turnId).toBe("native-1");
    }),
  );

  it(
    "keeps a goal hold when a capacity retry's start, response and end land together",
    withGoalHarness(async (h) => {
      await h.send();
      h.started("native-1");
      h.goalUpdated("active");
      h.notify("turn/completed", {
        turn: { id: "native-1", status: "failed", error: CAPACITY_ERROR },
      });
      const retry = h.deferNextRequest();
      await vi.advanceTimersByTimeAsync(2_000);

      h.started("native-2");
      retry.resolve({ turn: { id: "native-2" } });
      h.completed("native-2");
      await vi.advanceTimersByTimeAsync(0);

      expect(h.context.turnRun?.goalHold).toBe(true);
      expect(h.eventsNamed("turn/completed")).toEqual([]);

      await vi.advanceTimersByTimeAsync(GRACE_MS);
      expect(h.eventsNamed("turn/completed")).toHaveLength(1);
      expect(h.eventsNamed("turn/completed")[0]?.turnId).toBe("native-1");
      expect(h.context.session.status).toBe("ready");
    }),
  );

  it(
    "counts capacity failures per goal turn, not across the goal",
    withGoalHarness(async (h) => {
      await h.send();
      h.started("native-1");
      h.goalUpdated("active");
      let current = "native-1";
      for (let round = 2; round <= 8; round += 1) {
        h.notify("turn/completed", {
          turn: { id: current, status: "failed", error: CAPACITY_ERROR },
        });
        const warning = h.eventsNamed("error").at(-1);
        expect(warning?.payload.error.message).toContain("Retrying in 2s (attempt 1 of 5)");
        await vi.advanceTimersByTimeAsync(2_000);
        h.completed(`native-${round}`);
        current = `goal-${round}`;
        h.started(current);
      }

      expect(h.eventsNamed("error")).toHaveLength(7);
      expect(h.eventsNamed("turn/completed")).toEqual([]);
    }),
  );

  it(
    "does not blame a later goal turn's failure on a capacity error an earlier one recovered from",
    withGoalHarness(async (h) => {
      await h.send();
      h.started("native-1");
      h.goalUpdated("active");
      h.notify("error", { turnId: "native-1", willRetry: true, error: CAPACITY_ERROR });
      h.completed("native-1");
      h.started("goal-2");

      h.completed("goal-2", "failed");
      await vi.advanceTimersByTimeAsync(GRACE_MS);

      expect(h.requestsNamed("turn/start")).toHaveLength(1);
      expect(h.eventsNamed("turn/completed")[0]?.payload.turn.status).toBe("failed");
      expect(h.eventsNamed("error").map((event) => event.payload.willRetry)).toEqual([true]);
    }),
  );

  it(
    "reports a held turn's final error when its goal ends there, and not on a later turn",
    withGoalHarness(async (h) => {
      await h.send();
      h.started("native-1");
      h.goalUpdated("active");
      h.notify("error", { turnId: "native-1", willRetry: false, error: CAPACITY_ERROR });
      h.completed("native-1");
      expect(h.eventsNamed("error")).toEqual([]);

      h.goalUpdated("complete");

      expect(h.eventsNamed("error")).toHaveLength(1);
      expect(h.eventsNamed("turn/completed")).toHaveLength(1);
      expect(h.context.session.status).toBe("ready");

      await h.send();
      h.started("native-2");
      h.goalUpdated("active");
      h.notify("error", { turnId: "native-2", willRetry: false, error: CAPACITY_ERROR });
      h.completed("native-2");
      h.started("goal-3");
      h.goalUpdated("complete");
      h.completed("goal-3");

      expect(h.eventsNamed("error")).toHaveLength(1);
      expect(h.eventsNamed("turn/completed")).toHaveLength(2);
    }),
  );

  it(
    "keeps one running turn across the turns of an active goal",
    withGoalHarness(async (h) => {
      await h.send();
      h.started("native-1");
      h.goalUpdated("active");
      h.completed("native-1");

      expect(h.eventsNamed("turn/completed")).toEqual([]);
      expect(h.context.session.status).toBe("running");

      h.started("goal-2");
      expect(h.eventsNamed("turn/started")).toHaveLength(1);
      h.notify("item/started", { turnId: "goal-2", item: { type: "agentMessage", id: "m2" } });
      expect(h.eventsNamed("item/started")[0]?.turnId).toBe("native-1");

      await vi.advanceTimersByTimeAsync(GRACE_MS * 2);
      expect(h.eventsNamed("turn/completed")).toEqual([]);

      h.goalUpdated("complete");
      h.completed("goal-2");
      expect(h.eventsNamed("turn/completed")).toHaveLength(1);
      expect(h.eventsNamed("turn/completed")[0]?.turnId).toBe("native-1");
      expect(h.context.session.status).toBe("ready");
      expect(h.context.session.activeTurnId).toBeUndefined();
    }),
  );

  it(
    "lets a goal's later turns rewind with the user turn they continue",
    withGoalHarness(async (h) => {
      await h.send();
      h.started("native-1");
      h.goalUpdated("active");
      h.completed("native-1");
      h.started("goal-2");
      h.goalUpdated("complete");
      h.completed("goal-2");
      h.sendRequest.mockImplementation(async (...args: unknown[]) =>
        args[1] === "thread/read"
          ? {
              thread: {
                id: "provider_1",
                turns: [
                  { id: "older", items: [{ type: "userMessage" }] },
                  { id: "native-1", items: [{ type: "userMessage" }] },
                  { id: "goal-2", items: [{ type: "agentMessage" }] },
                ],
              },
            }
          : { thread: { id: "provider_1", turns: [] } },
      );

      await h.manager.rollbackThread(asThreadId("thread_1"), 1);

      expect(h.sendRequest).toHaveBeenCalledWith(h.context, "thread/rollback", {
        threadId: "provider_1",
        numTurns: 2,
      });
    }),
  );

  it(
    "settles the turn at once when the goal stops being active",
    withGoalHarness(async (h) => {
      await h.send();
      h.started("native-1");
      h.goalUpdated("active");
      h.completed("native-1");
      h.goalUpdated("complete");

      expect(h.eventsNamed("turn/completed")).toHaveLength(1);
      expect(h.eventsNamed("turn/completed")[0]?.payload.turn.status).toBe("completed");
      expect(h.context.session.status).toBe("ready");
    }),
  );

  it(
    "pauses the goal and settles when Codex does not continue in time",
    withGoalHarness(async (h) => {
      await h.send();
      h.started("native-1");
      h.goalUpdated("active");
      h.completed("native-1");

      await vi.advanceTimersByTimeAsync(GRACE_MS);

      expect(h.requestsNamed("thread/goal/set").at(-1)?.params.status).toBe("paused");
      expect(h.eventsNamed("turn/completed")).toHaveLength(1);
      expect(h.context.session.status).toBe("ready");
    }),
  );

  it(
    "pauses an active goal on Stop alongside the interrupt",
    withGoalHarness(async (h) => {
      await h.send();
      h.started("native-1");
      h.goalUpdated("active");
      await h.stop();

      expect(h.requests.map((entry) => entry.method).slice(-2)).toEqual([
        "thread/goal/set",
        "turn/interrupt",
      ]);
      expect(h.requestsNamed("thread/goal/set")[0]?.params).toEqual({
        threadId: "provider_1",
        status: "paused",
      });

      h.completed("native-1", "completed");
      expect(h.eventsNamed("turn/completed")).toHaveLength(1);
    }),
  );

  it(
    "still stops the turn when pausing the goal fails",
    withGoalHarness(async (h) => {
      await h.send();
      h.started("native-1");
      h.goalUpdated("active");
      h.sendRequest.mockRejectedValueOnce(new Error("thread/goal/set failed: nope"));

      await expect(h.stop()).resolves.toBeUndefined();

      expect(h.requestsNamed("turn/interrupt")).toHaveLength(1);
    }),
  );

  it(
    "ends a held goal run as stopped",
    withGoalHarness(async (h) => {
      await h.send();
      h.started("native-1");
      h.goalUpdated("active");
      h.completed("native-1");
      await h.stop();

      expect(h.eventsNamed("turn/completed")[0]?.payload.turn.status).toBe("interrupted");
      expect(h.context.session.status).toBe("ready");
      expect(h.requestsNamed("thread/goal/set").at(-1)?.params.status).toBe("paused");
    }),
  );

  it(
    "ends unseen a goal turn that races a Stop, and pauses the goal",
    withGoalHarness(async (h) => {
      await h.send();
      h.started("native-1");
      h.goalUpdated("active");
      h.completed("native-1");
      await h.stop();
      const eventCount = h.emitted.length;
      h.requests.length = 0;

      h.started("late");
      h.notify("item/started", { turnId: "late", item: { type: "agentMessage", id: "m" } });
      await vi.advanceTimersByTimeAsync(0);
      h.completed("late", "interrupted");

      expect(h.requests.map((entry) => entry.method)).toEqual([
        "thread/goal/set",
        "turn/interrupt",
      ]);
      expect(h.requests[1]?.params).toEqual({ threadId: "provider_1", turnId: "late" });
      expect(h.emitted).toHaveLength(eventCount);
      expect(h.context.session.activeTurnId).toBeUndefined();
    }),
  );

  it(
    "takes a send racing the next goal turn as a turn of its own",
    withGoalHarness(async (h) => {
      await h.send();
      h.started("native-1");
      h.goalUpdated("active");
      h.completed("native-1");

      const { turnId } = await h.send();

      expect(h.eventsNamed("turn/completed")).toHaveLength(1);
      expect(h.eventsNamed("turn/completed")[0]?.turnId).toBe("native-1");
      expect(h.eventsNamed("turn/completed")[0]?.payload.turn.status).toBe("completed");
      expect(turnId).toBe("native-2");
      h.started("native-2");
      expect(h.eventsNamed("turn/started").at(-1)?.turnId).toBe("native-2");
      expect(h.context.session.activeTurnId).toBe("native-2");
    }),
  );

  it(
    "binds a send to the goal turn Codex started first, as Codex steers it in",
    withGoalHarness(async (h) => {
      h.goalUpdated("paused");
      let resolveStart: ((value: unknown) => void) | undefined;
      h.sendRequest.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveStart = resolve;
          }),
      );
      const sending = h.send();
      await vi.advanceTimersByTimeAsync(0);
      h.started("goal-1");
      resolveStart?.({ turn: { id: "goal-1" } });

      await expect(sending).resolves.toMatchObject({ turnId: "goal-1" });
      expect(h.context.session.activeTurnId).toBe("goal-1");
      h.completed("goal-1");
      expect(h.eventsNamed("turn/completed")[0]?.turnId).toBe("goal-1");
      expect(h.context.session.status).toBe("ready");
    }),
  );

  it(
    "takes the turn Codex starts after answering an activation as the thread's next",
    withGoalHarness(async (h) => {
      h.goalUpdated("paused");
      await h.goalRequest({ type: "set", status: "active" });
      h.goalUpdated("active");

      h.started("resumed");
      expect(h.eventsNamed("turn/started").at(-1)?.turnId).toBe("resumed");
      expect(h.context.session.activeTurnId).toBe("resumed");
      expect(h.requestsNamed("turn/interrupt")).toEqual([]);

      h.goalUpdated("complete");
      h.completed("resumed");
      expect(h.context.session.status).toBe("ready");
      expect(h.context.turnRun).toBeUndefined();
    }),
  );

  it(
    "takes the turn Codex starts before answering an activation as the thread's next",
    withGoalHarness(async (h) => {
      h.goalUpdated("paused");
      const set = h.deferNextRequest();
      const activation = h.goalRequest({ type: "set", status: "active" });

      h.started("resumed");
      expect(h.eventsNamed("turn/started").at(-1)?.turnId).toBe("resumed");
      expect(h.context.session.activeTurnId).toBe("resumed");

      set.resolve({ goal: providerGoal("active") });
      await activation;

      expect(h.context.turnRun?.logicalTurnId).toBe("resumed");
      expect(h.requestsNamed("turn/interrupt")).toEqual([]);
      expect(h.requestsNamed("thread/goal/set")).toEqual([]);

      h.goalUpdated("complete");
      h.completed("resumed");
      expect(h.context.session.status).toBe("ready");
      expect(h.context.turnRun).toBeUndefined();
    }),
  );

  it(
    "holds a turn that ends while its activation is unanswered, then continues the goal",
    withGoalHarness(async (h) => {
      h.goalUpdated("paused");
      const set = h.deferNextRequest();
      const activation = h.goalRequest({ type: "set", status: "active" });
      h.started("resumed");
      h.completed("resumed");
      expect(h.context.turnRun?.goalHold).toBe(true);
      expect(h.eventsNamed("turn/completed")).toEqual([]);

      set.resolve({ goal: providerGoal("active") });
      await activation;
      expect(h.context.turnRun?.goalHold).toBe(true);

      h.started("goal-2");
      expect(h.eventsNamed("turn/started")).toHaveLength(1);
      h.goalUpdated("complete");
      h.completed("goal-2");
      expect(h.eventsNamed("turn/completed")).toHaveLength(1);
      expect(h.eventsNamed("turn/completed")[0]?.turnId).toBe("resumed");
    }),
  );

  it(
    "settles a held turn when its activation fails",
    withGoalHarness(async (h) => {
      h.goalUpdated("paused");
      const set = h.deferNextRequest();
      const activation = h.goalRequest({ type: "set", status: "active" });
      h.started("resumed");
      h.completed("resumed");

      set.reject(new Error("thread/goal/set failed: nope"));
      await expect(activation).rejects.toThrow("nope");

      expect(h.eventsNamed("turn/completed")).toHaveLength(1);
      expect(h.context.turnRun).toBeUndefined();
      expect(h.context.session.status).toBe("ready");
    }),
  );

  it(
    "settles a held turn when its activation does not leave the goal active",
    withGoalHarness(async (h) => {
      h.goalUpdated("paused");
      const set = h.deferNextRequest();
      const activation = h.goalRequest({ type: "set", status: "active" });
      h.started("resumed");
      h.completed("resumed");
      expect(h.context.turnRun?.goalHold).toBe(true);

      set.resolve({ goal: providerGoal("paused") });
      await activation;

      expect(h.eventsNamed("turn/completed")).toHaveLength(1);
      expect(h.context.turnRun).toBeUndefined();
    }),
  );

  it(
    "ends unseen a turn racing a Stop during activation, and pauses the goal",
    withGoalHarness(async (h) => {
      const set = h.deferNextRequest();
      const activation = h.goalRequest({ type: "set", status: "active" });

      await h.stop();
      expect(h.requestsNamed("thread/goal/set").map((entry) => entry.params.status)).toEqual([
        "paused",
      ]);

      h.started("racing");
      expect(h.eventsNamed("turn/started")).toEqual([]);
      expect(h.requestsNamed("turn/interrupt")[0]?.params).toEqual({
        threadId: "provider_1",
        turnId: "racing",
      });
      expect(h.context.turnRun).toBeUndefined();

      set.resolve({ goal: providerGoal("active") });
      await activation;

      h.started("late");
      expect(h.eventsNamed("turn/started")).toEqual([]);
      expect(h.requestsNamed("turn/interrupt")[1]?.params.turnId).toBe("late");
      expect(h.context.session.activeTurnId).toBeUndefined();
    }),
  );

  it(
    "counts a resumed goal's first turn as a turn of its own when rewinding",
    withGoalHarness(async (h) => {
      await h.goalRequest({ type: "set", status: "active" });
      h.started("resumed");
      h.goalUpdated("complete");
      h.completed("resumed");
      h.sendRequest.mockImplementation(async (...args: unknown[]) =>
        args[1] === "thread/read"
          ? {
              thread: {
                id: "provider_1",
                turns: [
                  { id: "older", items: [{ type: "userMessage" }] },
                  { id: "resumed", items: [{ type: "agentMessage" }] },
                ],
              },
            }
          : { thread: { id: "provider_1", turns: [] } },
      );

      await h.manager.rollbackThread(asThreadId("thread_1"), 1);

      expect(h.sendRequest).toHaveBeenCalledWith(h.context, "thread/rollback", {
        threadId: "provider_1",
        numTurns: 1,
      });
    }),
  );

  it(
    "ends unseen a goal turn nothing owns, such as one on a resumed thread",
    withGoalHarness(async (h) => {
      h.goalUpdated("active");
      h.started("orphan");

      expect(h.eventsNamed("turn/started")).toEqual([]);
      expect(h.requestsNamed("turn/interrupt")[0]?.params.turnId).toBe("orphan");
      expect(h.requestsNamed("thread/goal/set")[0]?.params.status).toBe("paused");
    }),
  );

  it(
    "leaves a turn alone when no goal is involved",
    withGoalHarness(async (h) => {
      h.started("unprompted");
      expect(h.eventsNamed("turn/started")).toHaveLength(1);
      expect(h.requestsNamed("turn/interrupt")).toEqual([]);
    }),
  );

  it(
    "reports only the root thread's goal, without a turn, and no repeats",
    withGoalHarness(async (h) => {
      h.notify("thread/goal/updated", {
        threadId: "subagent",
        turnId: null,
        goal: providerGoal("active", "Not mine"),
      });
      expect(h.eventsNamed("thread/goal/updated")).toEqual([]);
      expect(h.context.goalStatus).toBeUndefined();

      h.notify("thread/goal/updated", { turnId: "native-1", goal: providerGoal("paused") });
      h.notify("thread/goal/updated", { turnId: "native-1", goal: providerGoal("paused") });
      expect(h.eventsNamed("thread/goal/updated")).toHaveLength(1);
      expect(h.eventsNamed("thread/goal/updated")[0]?.turnId).toBeUndefined();

      h.notify("thread/goal/cleared", {});
      expect(h.eventsNamed("thread/goal/cleared")).toHaveLength(1);
      expect(h.context.goalStatus).toBeNull();
    }),
  );

  it(
    "answers goal requests and reports what a read finds",
    withGoalHarness(async (h) => {
      h.sendRequest.mockImplementationOnce(async () => ({ goal: providerGoal("paused") }));
      await expect(h.goalRequest({ type: "get" })).resolves.toEqual({
        goal: expect.objectContaining({ objective: "Ship it", status: "paused" }),
      });
      expect(h.eventsNamed("thread/goal/updated")).toHaveLength(1);

      await expect(
        h.goalRequest({ type: "set", objective: "Next", status: "paused" }),
      ).resolves.toMatchObject({ goal: { objective: "Next", status: "paused" } });
      expect(h.requestsNamed("thread/goal/set")[0]?.params).toEqual({
        threadId: "provider_1",
        objective: "Next",
        status: "paused",
      });

      await expect(h.goalRequest({ type: "clear" })).resolves.toEqual({
        goal: null,
        cleared: true,
      });
      expect(h.eventsNamed("thread/goal/cleared")).toHaveLength(1);
    }),
  );

  it(
    "names an update when a CLI has no goal API",
    withGoalHarness(async (h) => {
      h.sendRequest.mockRejectedValueOnce(
        new Error("thread/goal/get failed: Invalid request: unknown variant `thread/goal/get`"),
      );

      await expect(h.goalRequest({ type: "get" })).rejects.toThrow(
        "This Codex CLI cannot use /goal. Update Codex and try again.",
      );
    }),
  );

  it(
    "refuses an objective Codex would reject, counting characters not code units",
    withGoalHarness(async (h) => {
      await expect(
        h.goalRequest({ type: "set", objective: "x".repeat(4_001), status: "paused" }),
      ).rejects.toThrow("The goal objective is 4001 characters; Codex supports at most 4000.");
      expect(h.requestsNamed("thread/goal/set")).toEqual([]);

      await expect(
        h.goalRequest({ type: "set", objective: "😀".repeat(4_000), status: "paused" }),
      ).resolves.toBeDefined();
    }),
  );
});
