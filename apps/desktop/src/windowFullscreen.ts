export const GET_WINDOW_FULLSCREEN_STATE_CHANNEL = "desktop:get-window-fullscreen-state";
export const WINDOW_FULLSCREEN_STATE_CHANNEL = "desktop:window-fullscreen-state";

export interface FullscreenStateWindow {
  on(event: "enter-full-screen" | "leave-full-screen", listener: () => void): unknown;
  isDestroyed(): boolean;
  readonly webContents: { send(channel: string, ...args: unknown[]): void };
}

/** Pushes native fullscreen changes to the renderer so it can drop the traffic-light inset. */
export function forwardWindowFullscreenState(window: FullscreenStateWindow): void {
  const publish = (fullscreen: boolean) => {
    if (window.isDestroyed()) return;
    window.webContents.send(WINDOW_FULLSCREEN_STATE_CHANNEL, fullscreen);
  };
  window.on("enter-full-screen", () => publish(true));
  window.on("leave-full-screen", () => publish(false));
}
