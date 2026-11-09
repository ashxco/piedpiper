import type { ResolvedKeybindingsConfig, ThreadId } from "@piedpiper/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useCommandPaletteStore } from "../../commandPaletteStore";
import { useFilePickerStore } from "../../filePickerStore";
import { useSidebarThreadJumpKeybindings } from "../../hooks/useSidebarThreadJumpKeybindings";

const THREAD_A = "thread-a" as ThreadId;
const THREAD_B = "thread-b" as ThreadId;

const shortcut = (key: string) => ({
  key,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  modKey: true,
});

const KEYBINDINGS: ResolvedKeybindingsConfig = [
  { command: "thread.next", shortcut: shortcut("j") },
  { command: "thread.jump.1", shortcut: shortcut("1") },
];

function Harness(props: {
  navigateToThread: (threadId: ThreadId) => void;
  updateThreadJumpHintsVisibility?: (visible: boolean) => void;
}) {
  useSidebarThreadJumpKeybindings({
    keybindings: KEYBINDINGS,
    platform: "MacIntel",
    routeTerminalOpen: false,
    routeThreadId: THREAD_A,
    orderedSidebarThreadIds: [THREAD_A, THREAD_B],
    threadJumpThreadIds: [THREAD_B],
    navigateToThread: props.navigateToThread,
    updateThreadJumpHintsVisibility: props.updateThreadJumpHintsVisibility ?? (() => {}),
  });
  return (
    <>
      <button data-testid="outside">Outside</button>
      <div role="alertdialog">
        <button data-testid="cancel">Cancel</button>
      </div>
    </>
  );
}

function press(target: Element, key: string) {
  const event = new KeyboardEvent("keydown", {
    key,
    metaKey: true,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
}

describe("useSidebarThreadJumpKeybindings with a confirmation open", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("consumes traversal and jump chords without navigating behind the dialog", async () => {
    const navigateToThread = vi.fn();
    const screen = await render(<Harness navigateToThread={navigateToThread} />);
    const cancel = screen.container.querySelector('[data-testid="cancel"]')!;

    expect(press(cancel, "j").defaultPrevented).toBe(true);
    expect(press(cancel, "1").defaultPrevented).toBe(true);
    expect(navigateToThread).not.toHaveBeenCalled();
  });

  it("leaves Tab, Enter and Escape to the dialog", async () => {
    const screen = await render(<Harness navigateToThread={vi.fn()} />);
    const cancel = screen.container.querySelector('[data-testid="cancel"]')!;
    for (const key of ["Tab", "Enter", "Escape"]) {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      cancel.dispatchEvent(event);
      expect(event.defaultPrevented, key).toBe(false);
    }
  });

  it("still navigates from outside a dialog", async () => {
    const navigateToThread = vi.fn();
    const screen = await render(<Harness navigateToThread={navigateToThread} />);
    press(screen.container.querySelector('[data-testid="outside"]')!, "j");
    expect(navigateToThread).toHaveBeenCalledWith(THREAD_B);
  });
});

describe("useSidebarThreadJumpKeybindings inside a shortcut recorder", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("does not navigate or request hints, and leaves the chord to the recorder", async () => {
    const navigateToThread = vi.fn();
    const updateHints = vi.fn();
    const screen = await render(
      <Harness navigateToThread={navigateToThread} updateThreadJumpHintsVisibility={updateHints} />,
    );
    const recorder = screen.container.querySelector('[data-testid="outside"]')!;
    recorder.setAttribute("data-keybinding-capture", "");

    const jump = press(recorder, "1");
    const next = press(recorder, "j");
    recorder.dispatchEvent(new KeyboardEvent("keyup", { key: "k", metaKey: true, bubbles: true }));

    expect(navigateToThread).not.toHaveBeenCalled();
    expect(jump.defaultPrevented).toBe(false);
    expect(next.defaultPrevented).toBe(false);
    expect(updateHints).toHaveBeenCalled();
    expect(updateHints).not.toHaveBeenCalledWith(true);
  });
});

describe.each([
  ["command palette", () => useCommandPaletteStore.setState({ open: true })],
  ["file picker", () => useFilePickerStore.setState({ open: true })],
])("useSidebarThreadJumpKeybindings with the %s open", (_name, openSurface) => {
  afterEach(() => {
    useCommandPaletteStore.setState({ open: false });
    useFilePickerStore.setState({ open: false });
    document.body.innerHTML = "";
  });

  it("does not navigate, and keeps the jump hints hidden", async () => {
    const navigateToThread = vi.fn();
    const updateHints = vi.fn();
    const screen = await render(
      <Harness navigateToThread={navigateToThread} updateThreadJumpHintsVisibility={updateHints} />,
    );
    openSurface();
    const outside = screen.container.querySelector('[data-testid="outside"]')!;

    const jump = press(outside, "1");
    const next = press(outside, "j");
    // Releasing K with mod still held, right after mod+K opened the palette.
    outside.dispatchEvent(new KeyboardEvent("keyup", { key: "k", metaKey: true, bubbles: true }));

    expect(navigateToThread).not.toHaveBeenCalled();
    expect(jump.defaultPrevented).toBe(false);
    expect(next.defaultPrevented).toBe(false);
    expect(updateHints).toHaveBeenCalled();
    expect(updateHints).not.toHaveBeenCalledWith(true);
  });
});
