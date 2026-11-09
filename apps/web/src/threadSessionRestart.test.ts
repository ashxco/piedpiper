import { ThreadId } from "@piedpiper/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { toastManager } from "./components/ui/toast";
import { readNativeApi } from "./nativeApi";
import { useStore } from "./store";
import { restartThreadSession } from "./threadSessionRestart";

vi.mock("./components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("./nativeApi", () => ({ readNativeApi: vi.fn() }));

const threadId = ThreadId.makeUnsafe("thread-1");

const idleThread = {
  session: { status: "ready", orchestrationStatus: "ready" },
  hasPendingApprovals: false,
  hasPendingUserInput: false,
};

function setup(input: { confirmed: boolean; dispatch?: () => Promise<unknown>; thread?: unknown }) {
  const confirm = vi.fn(async (_message: string) => input.confirmed);
  const dispatchCommand = vi.fn(input.dispatch ?? (async () => ({ sequence: 1 })));
  vi.mocked(readNativeApi).mockReturnValue({
    dialogs: { confirm },
    orchestration: { dispatchCommand },
  } as never);
  useStore.setState({
    sidebarThreadsById: { [threadId]: input.thread ?? idleThread },
  } as never);
  return { confirm, dispatchCommand };
}

describe("restartThreadSession", () => {
  beforeEach(() => {
    vi.mocked(toastManager.add).mockClear();
  });

  it("warns about background tasks, stops the session and says the next message restarts it", async () => {
    const { confirm, dispatchCommand } = setup({ confirmed: true });

    await restartThreadSession(threadId);

    expect(confirm.mock.calls[0]?.[0]).toContain("background tasks");
    expect(dispatchCommand).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        type: "thread.session.stop",
        threadId,
        keepUsageLimitResume: true,
      }),
    );
    expect(toastManager.add).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ type: "success", title: "Session will restart" }),
    );
  });

  it("does nothing when the confirmation is declined", async () => {
    const { dispatchCommand } = setup({ confirmed: false });

    await restartThreadSession(threadId);

    expect(dispatchCommand).not.toHaveBeenCalled();
    expect(toastManager.add).not.toHaveBeenCalled();
  });

  it("does not stop a session that became busy during the confirmation", async () => {
    const { dispatchCommand } = setup({
      confirmed: true,
      thread: { ...idleThread, hasPendingApprovals: true },
    });

    await restartThreadSession(threadId);

    expect(dispatchCommand).not.toHaveBeenCalled();
    expect(toastManager.add).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ type: "warning", title: "Session not restarted" }),
    );
  });

  it("reports a failed stop instead of claiming a restart", async () => {
    setup({ confirmed: true, dispatch: () => Promise.reject(new Error("socket closed")) });

    await restartThreadSession(threadId);

    expect(toastManager.add).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ type: "error", description: "socket closed" }),
    );
  });
});
