import { describe, expect, it, vi } from "vitest";
import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent } from "electron";
import { guardDesktopIpc } from "./trustedIpc";

describe("desktop IPC ownership", () => {
  it("rejects guests and subframes and follows the current window", async () => {
    const invoke = new Map<string, Parameters<IpcMain["handle"]>[1]>();
    const listeners = new Map<string, (event: IpcMainEvent) => void>();
    const ipc = {
      handle: (channel: string, listener: Parameters<IpcMain["handle"]>[1]) => {
        invoke.set(channel, listener);
      },
      on: (channel: string, listener: (event: IpcMainEvent) => void) => {
        listeners.set(channel, listener);
        return ipc;
      },
    } as unknown as Pick<IpcMain, "handle" | "on">;
    const frame = {};
    let window: { isDestroyed(): boolean; webContents: { id: number; mainFrame: unknown } } | null =
      {
        isDestroyed: () => false,
        webContents: { id: 1, mainFrame: frame },
      };
    const guarded = guardDesktopIpc(ipc, () => window);
    const handler = vi.fn(() => "accepted");
    guarded.handle("invoke", handler);
    guarded.on("sync", handler);
    const event = (id: number, senderFrame: unknown) =>
      ({ sender: { id }, senderFrame }) as IpcMainInvokeEvent;
    expect(await invoke.get("invoke")!(event(1, frame))).toBe("accepted");
    for (const rejected of [event(2, frame), event(1, {}), event(1, null)]) {
      expect(() => invoke.get("invoke")!(rejected)).toThrow("untrusted");
      listeners.get("sync")!(rejected as IpcMainEvent);
    }
    window = null;
    expect(() => invoke.get("invoke")!(event(1, frame))).toThrow("untrusted");
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
