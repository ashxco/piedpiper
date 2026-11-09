import { MessageId, ProjectId, ThreadId } from "@piedpiper/contracts";
import { describe, expect, it, vi } from "vitest";
import { ComposerSendCancelledError } from "../ChatView.logic";
import {
  runComposerSingleSend,
  type ComposerSingleSendEffects,
  type ComposerSingleSendInput,
} from "./composerSingleSend";

const selection = { provider: "claudeAgent", model: "claude-opus-4-6" } as const;
const setupScript = {
  id: "setup",
  name: "Setup",
  command: "bun install",
  icon: "configure",
  runOnWorktreeCreate: true,
} as const;

function input(): ComposerSingleSendInput {
  return {
    thread: {
      id: ThreadId.makeUnsafe("draft"),
      createdAt: "2026-01-01T00:00:00.000Z",
      branch: "main",
      worktreePath: null,
      isServer: false,
      isLocalDraft: true,
      isFirstMessage: true,
    },
    project: { id: ProjectId.makeUnsafe("project"), scripts: [setupScript] },
    message: {
      id: MessageId.makeUnsafe("message"),
      text: "Fix the bug",
      title: "Fix the bug",
      createdAt: "2026-01-02T00:00:00.000Z",
      attachments: Promise.resolve([]),
    },
    settings: { modelSelection: selection, runtimeMode: "auto", interactionMode: "default" },
    threadCreateModelSelection: selection,
    persistModelSelection: true,
    worktree: { baseBranch: "main", localBranch: "checkout" },
  };
}

function effects() {
  const order: string[] = [];
  return {
    order,
    dispatchCommand: vi.fn<ComposerSingleSendEffects["dispatchCommand"]>(async (command) => {
      order.push(command.type);
      return { sequence: 1 };
    }),
    prepareWorktree: vi.fn<ComposerSingleSendEffects["prepareWorktree"]>(async () => {
      order.push("worktree");
      return { status: "created", result: { worktree: { branch: "feature", path: "/wt" } } };
    }),
    updateThreadContext: vi.fn<ComposerSingleSendEffects["updateThreadContext"]>(() => {
      order.push("context");
    }),
    runProjectScript: vi.fn<ComposerSingleSendEffects["runProjectScript"]>(async () => {
      order.push("setup");
    }),
    persistSettings: vi.fn<ComposerSingleSendEffects["persistSettings"]>(async () => {
      order.push("settings");
    }),
    onReadyToSend: vi.fn(() => order.push("ready")),
  };
}

describe("runComposerSingleSend", () => {
  it("promotes a draft, runs worktree setup, and sends with the captured settings", async () => {
    const send = input();
    const deps = effects();
    expect(await runComposerSingleSend(send, deps)).toEqual({ status: "sent" });
    expect(deps.order).toEqual([
      "worktree",
      "context",
      "thread.create",
      "setup",
      "ready",
      "thread.turn.start",
    ]);
    expect(deps.prepareWorktree).toHaveBeenCalledWith("main");
    expect(deps.dispatchCommand).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        type: "thread.create",
        branch: "feature",
        worktreePath: "/wt",
        createdAt: send.thread.createdAt,
      }),
    );
    expect(deps.runProjectScript).toHaveBeenCalledWith(setupScript, {
      worktreePath: "/wt",
      cwd: "/wt",
      rememberAsLastInvoked: false,
    });
    expect(deps.dispatchCommand).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "thread.turn.start",
        threadId: send.thread.id,
        ...send.settings,
        createdAt: send.message.createdAt,
        message: {
          messageId: send.message.id,
          role: "user",
          text: send.message.text,
          attachments: [],
        },
      }),
    );
  });

  it("continues the same send locally without running worktree setup", async () => {
    const send = input();
    const deps = effects();
    deps.prepareWorktree.mockResolvedValue({ status: "work-locally" });
    expect(await runComposerSingleSend(send, deps)).toEqual({ status: "sent" });
    expect(deps.updateThreadContext).toHaveBeenCalledWith(
      { branch: "checkout", worktreePath: null },
      true,
    );
    expect(deps.dispatchCommand).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        type: "thread.create",
        branch: "checkout",
        worktreePath: null,
      }),
    );
    expect(deps.runProjectScript).not.toHaveBeenCalled();
  });

  it("syncs an existing thread's worktree before setup, title, and settings", async () => {
    const send = input();
    send.thread.isServer = true;
    send.thread.isLocalDraft = false;
    const deps = effects();
    expect(await runComposerSingleSend(send, deps)).toEqual({ status: "sent" });
    expect(deps.order).toEqual([
      "worktree",
      "thread.meta.update",
      "context",
      "setup",
      "thread.meta.update",
      "settings",
      "ready",
      "thread.turn.start",
    ]);
    expect(deps.persistSettings).toHaveBeenCalledWith({
      threadId: send.thread.id,
      createdAt: send.message.createdAt,
      ...send.settings,
    });
  });

  it("sends in an existing checkout without creating a worktree or replacing its title", async () => {
    const send = input();
    send.thread = { ...send.thread, isServer: true, isLocalDraft: false, isFirstMessage: false };
    send.worktree.baseBranch = null;
    send.persistModelSelection = false;
    const deps = effects();
    expect(await runComposerSingleSend(send, deps)).toEqual({ status: "sent" });
    expect(deps.order).toEqual(["settings", "ready", "thread.turn.start"]);
    expect(deps.persistSettings.mock.calls[0]?.[0]).not.toHaveProperty("modelSelection");
  });

  it.each(["worktree", "thread.create", "setup", "thread.turn.start"])(
    "reports whether draft promotion finished when %s fails",
    async (step) => {
      const error = new Error(step);
      const deps = effects();
      if (step === "worktree") deps.prepareWorktree.mockRejectedValue(error);
      else if (step === "setup") deps.runProjectScript.mockRejectedValue(error);
      else
        deps.dispatchCommand.mockImplementation(async (command) => {
          if (command.type === step) throw error;
          return { sequence: 1 };
        });
      expect(await runComposerSingleSend(input(), deps)).toEqual({
        status: "failed",
        error,
        createdServerThread: step === "setup" || step === "thread.turn.start",
      });
      // Composer recovery decides how and where to restore the draft before deleting the thread.
      expect(
        deps.dispatchCommand.mock.calls.some(([command]) => command.type === "thread.delete"),
      ).toBe(false);
    },
  );

  it("preserves a user cancellation for silent composer recovery without dispatching", async () => {
    const deps = effects();
    const error = new ComposerSendCancelledError();
    deps.prepareWorktree.mockRejectedValue(error);
    expect(await runComposerSingleSend(input(), deps)).toEqual({
      status: "failed",
      error,
      createdServerThread: false,
    });
    expect(deps.dispatchCommand).not.toHaveBeenCalled();
  });

  it("observes an early attachment rejection while worktree creation is still pending", async () => {
    const send = input();
    const deps = effects();
    const error = new Error("could not read attachment");
    send.message.attachments = Promise.reject(error);
    let finish!: (value: Awaited<ReturnType<ComposerSingleSendEffects["prepareWorktree"]>>) => void;
    deps.prepareWorktree.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const result = runComposerSingleSend(send, deps);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(deps.dispatchCommand).not.toHaveBeenCalled();
    finish({ status: "work-locally" });
    expect(await result).toEqual({ status: "failed", error, createdServerThread: true });
    expect(deps.dispatchCommand.mock.calls.map(([command]) => command.type)).toEqual([
      "thread.create",
    ]);
  });
});
