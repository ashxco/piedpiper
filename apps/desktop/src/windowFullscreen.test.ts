import { describe, expect, it, vi } from "vitest";

import {
  WINDOW_FULLSCREEN_STATE_CHANNEL,
  forwardWindowFullscreenState,
  type FullscreenStateWindow,
} from "./windowFullscreen";

function makeWindow() {
  const listeners = new Map<string, () => void>();
  let destroyed = false;
  const send = vi.fn();
  const window: FullscreenStateWindow = {
    on: (event, listener) => listeners.set(event, listener),
    isDestroyed: () => destroyed,
    webContents: { send },
  };
  return {
    window,
    send,
    emit: (event: string) => listeners.get(event)?.(),
    destroy: () => {
      destroyed = true;
    },
  };
}

describe("forwardWindowFullscreenState", () => {
  it("publishes enter and leave fullscreen to the renderer", () => {
    const fake = makeWindow();
    forwardWindowFullscreenState(fake.window);
    fake.emit("enter-full-screen");
    fake.emit("leave-full-screen");
    expect(fake.send.mock.calls).toEqual([
      [WINDOW_FULLSCREEN_STATE_CHANNEL, true],
      [WINDOW_FULLSCREEN_STATE_CHANNEL, false],
    ]);
  });

  it("skips destroyed windows", () => {
    const fake = makeWindow();
    forwardWindowFullscreenState(fake.window);
    fake.destroy();
    fake.emit("enter-full-screen");
    expect(fake.send).not.toHaveBeenCalled();
  });
});
