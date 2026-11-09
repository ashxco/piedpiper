import { ThreadId, type NativeApi, type ResolvedKeybindingsConfig } from "@piedpiper/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { createTerminalViewport } from "./terminalViewport";

const disposals: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposals.splice(0).toReversed()) dispose();
});

it("owns the xterm DOM and preserves the mount's focus when disposed", async () => {
  const mount = document.createElement("div");
  mount.tabIndex = -1;
  mount.style.cssText = "width: 800px; height: 320px";
  document.body.append(mount);
  disposals.push(() => mount.remove());
  const resize = vi.fn().mockResolvedValue(undefined);
  const threadId = ThreadId.makeUnsafe("viewport-browser-test");
  const owner = createTerminalViewport(
    mount,
    {
      terminal: {
        open: vi.fn().mockResolvedValue({
          threadId,
          terminalId: "default",
          cwd: "/tmp",
          status: "running",
          pid: 123,
          history: "hello from the terminal",
          exitCode: null,
          exitSignal: null,
          updatedAt: "2026-11-08T00:00:00.000Z",
          sequence: 1,
        }),
        resize,
        write: vi.fn().mockResolvedValue(undefined),
      },
    } as unknown as NativeApi,
    {
      threadId,
      terminalId: "default",
      cwd: "/tmp",
      readKeybindings: () => ({ bindings: [] }) as unknown as ResolvedKeybindingsConfig,
      readTerminalLabel: () => "Terminal 1",
      readAutoFocus: () => false,
      isDrawerDragging: () => false,
      onSessionExited: vi.fn(),
      onAddTerminalContext: vi.fn(),
    },
    { fontSize: 13, fontFamily: "" },
  );
  disposals.push(owner.dispose);
  owner.focus();
  await expect
    .poll(() => mount.querySelector(".xterm-helper-textarea") === document.activeElement)
    .toBe(true);
  await expect.poll(() => mount.textContent).toContain("hello from the terminal");
  owner.fit();
  expect(resize).toHaveBeenCalled();
  owner.dispose();
  expect(mount.querySelector(".xterm")).toBeNull();
  expect(document.activeElement).toBe(mount);
  resize.mockClear();
  owner.fit();
  owner.setFont({ fontSize: 16, fontFamily: "" });
  owner.focus();
  expect(resize).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(mount);
});
