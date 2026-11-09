import { ThreadId } from "@piedpiper/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { confirmMock, readNativeApiMock } = vi.hoisted(() => {
  const confirmMock = vi.fn<(message: string) => Promise<boolean>>();
  const readNativeApiMock =
    vi.fn<() => { dialogs: { confirm: (message: string) => Promise<boolean> } } | undefined>();
  return { confirmMock, readNativeApiMock };
});

vi.mock("./nativeApi", () => ({ readNativeApi: readNativeApiMock }));

import {
  confirmTerminalCloseIfRunning,
  isTerminalCloseConfirmPending,
  terminalCloseConfirmationMessage,
} from "./terminalCloseConfirmation";
import { useTerminalStateStore } from "./terminalStateStore";

const THREAD_ID = ThreadId.makeUnsafe("thread-1");

describe("confirmTerminalCloseIfRunning", () => {
  beforeEach(() => {
    confirmMock.mockReset();
    readNativeApiMock.mockReset();
    readNativeApiMock.mockReturnValue({ dialogs: { confirm: confirmMock } });
    useTerminalStateStore.setState({
      terminalStateByThreadId: {},
      terminalEventEntriesByKey: {},
      nextTerminalEventId: 1,
    });
  });

  it("closes idle terminals without prompting", async () => {
    await expect(
      confirmTerminalCloseIfRunning({ threadId: THREAD_ID, terminalId: "default" }),
    ).resolves.toBe(true);
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it("prompts for a running terminal and tracks pending state until it settles", async () => {
    useTerminalStateStore.getState().setTerminalActivity(THREAD_ID, "default", true);
    let settle: ((value: boolean) => void) | undefined;
    confirmMock.mockImplementation(() => new Promise<boolean>((resolve) => (settle = resolve)));

    const confirmation = confirmTerminalCloseIfRunning({
      threadId: THREAD_ID,
      terminalId: "default",
      terminalLabel: "Terminal 1",
    });
    expect(isTerminalCloseConfirmPending()).toBe(true);
    expect(confirmMock).toHaveBeenCalledWith(terminalCloseConfirmationMessage("Terminal 1"));

    settle?.(false);
    await expect(confirmation).resolves.toBe(false);
    expect(isTerminalCloseConfirmPending()).toBe(false);
  });

  it("treats a failed dialog as a cancel", async () => {
    useTerminalStateStore.getState().setTerminalActivity(THREAD_ID, "default", true);
    confirmMock.mockRejectedValue(new Error("dialog failed"));

    await expect(
      confirmTerminalCloseIfRunning({ threadId: THREAD_ID, terminalId: "default" }),
    ).resolves.toBe(false);
    expect(isTerminalCloseConfirmPending()).toBe(false);
  });
});
