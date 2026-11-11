import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent } from "electron";

interface AppWindow {
  isDestroyed(): boolean;
  readonly webContents: { readonly id: number; readonly mainFrame: unknown };
}

/** IPC belongs to the current application frame, including after a window is recreated. */
export function guardDesktopIpc(
  ipc: Pick<IpcMain, "on" | "handle">,
  getWindow: () => AppWindow | null,
): Pick<IpcMain, "on" | "handle"> {
  const trusted = (event: IpcMainEvent | IpcMainInvokeEvent): boolean => {
    const window = getWindow();
    return (
      window !== null &&
      !window.isDestroyed() &&
      event.sender.id === window.webContents.id &&
      event.senderFrame != null &&
      event.senderFrame === window.webContents.mainFrame
    );
  };

  return {
    handle(channel, listener) {
      ipc.handle(channel, (event, ...args) => {
        if (!trusted(event)) throw new Error(`Rejected untrusted desktop IPC: ${channel}`);
        return listener(event, ...args);
      });
    },
    on(channel, listener) {
      return ipc.on(channel, (event: IpcMainEvent, ...args: unknown[]) => {
        if (!trusted(event)) {
          event.returnValue = undefined;
          return;
        }
        listener(event, ...args);
      });
    },
  };
}
