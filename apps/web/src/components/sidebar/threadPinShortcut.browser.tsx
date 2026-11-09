import type { ResolvedKeybindingsConfig, ThreadId } from "@piedpiper/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { useCommandPaletteStore } from "../../commandPaletteStore";
import { useFilePickerStore } from "../../filePickerStore";
import { useSidebarThreadPinShortcut } from "../../hooks/useSidebarThreadPinShortcut";
import { useStore } from "../../store";
import type { SidebarThreadSummary } from "../../types";
import { useUiStateStore } from "../../uiStateStore";

const THREAD_ID = "thread-pin-shortcut" as ThreadId;
const DRAFT_ID = "thread-pin-shortcut-draft" as ThreadId;

const KEYBINDINGS: ResolvedKeybindingsConfig = [
  {
    command: "thread.pin",
    shortcut: {
      key: "p",
      metaKey: false,
      ctrlKey: false,
      shiftKey: true,
      altKey: false,
      modKey: true,
    },
    whenAst: { type: "not", node: { type: "identifier", name: "terminalFocus" } },
  },
];

function Harness(props: { threadId: ThreadId | null }) {
  useSidebarThreadPinShortcut({
    keybindings: KEYBINDINGS,
    platform: "MacIntel",
    routeTerminalOpen: false,
    routeThreadId: props.threadId,
  });
  return <input data-testid="composer" />;
}

function SecondMount(props: { threadId: ThreadId }) {
  useSidebarThreadPinShortcut({
    keybindings: KEYBINDINGS,
    platform: "MacIntel",
    routeTerminalOpen: false,
    routeThreadId: props.threadId,
  });
  return null;
}

function pressPin(init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: "p",
    metaKey: true,
    shiftKey: true,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  document.querySelector('[data-testid="composer"]')!.dispatchEvent(event);
  return event;
}

function isPinned(threadId: ThreadId): boolean {
  return useUiStateStore.getState().pinnedThreadIds.includes(threadId);
}

describe("useSidebarThreadPinShortcut", () => {
  beforeEach(() => {
    useStore.setState({
      sidebarThreadsById: { [THREAD_ID]: { archivedAt: null } as SidebarThreadSummary },
    });
    useUiStateStore.getState().setThreadPinned(THREAD_ID, false);
    useUiStateStore.getState().setThreadPinned(DRAFT_ID, false);
  });

  afterEach(() => {
    useStore.setState({ sidebarThreadsById: {} });
    useUiStateStore.getState().setThreadPinned(THREAD_ID, false);
    document.body.innerHTML = "";
  });

  it("toggles the pin of the thread on screen and claims the chord", async () => {
    const screen = await render(<Harness threadId={THREAD_ID} />);

    expect(pressPin().defaultPrevented).toBe(true);
    expect(isPinned(THREAD_ID)).toBe(true);

    pressPin();
    expect(isPinned(THREAD_ID)).toBe(false);

    await screen.unmount();
  });

  it("ignores key repeat so holding the chord does not flicker the pin", async () => {
    const screen = await render(<Harness threadId={THREAD_ID} />);

    expect(pressPin({ repeat: true }).defaultPrevented).toBe(true);
    expect(isPinned(THREAD_ID)).toBe(false);

    await screen.unmount();
  });

  it("does not pin a draft or an archived thread", async () => {
    const screen = await render(<Harness threadId={DRAFT_ID} />);

    expect(pressPin().defaultPrevented).toBe(true);
    expect(isPinned(DRAFT_ID)).toBe(false);
    await screen.unmount();

    useStore.setState({
      sidebarThreadsById: {
        [THREAD_ID]: { archivedAt: "2026-03-04T12:00:00.000Z" } as SidebarThreadSummary,
      },
    });
    const archived = await render(<Harness threadId={THREAD_ID} />);
    pressPin();
    expect(isPinned(THREAD_ID)).toBe(false);
    await archived.unmount();
  });

  it("leaves the chord to a shortcut recorder", async () => {
    const screen = await render(<Harness threadId={THREAD_ID} />);
    const recorder = document.querySelector('[data-testid="composer"]')!;
    recorder.setAttribute("data-keybinding-capture", "");
    const seenByRecorder: boolean[] = [];
    recorder.addEventListener("keydown", (event) => seenByRecorder.push(event.defaultPrevented));

    expect(pressPin().defaultPrevented).toBe(false);
    expect(seenByRecorder).toEqual([false]);
    expect(isPinned(THREAD_ID)).toBe(false);

    await screen.unmount();
  });

  it("claims the chord but keeps the pin while the command palette is open", async () => {
    const screen = await render(<Harness threadId={THREAD_ID} />);
    useCommandPaletteStore.getState().setOpen(true);
    try {
      expect(pressPin().defaultPrevented).toBe(true);
      expect(isPinned(THREAD_ID)).toBe(false);
    } finally {
      useCommandPaletteStore.getState().setOpen(false);
    }
    await screen.unmount();
  });

  it("claims the chord but keeps the pin while the file picker is open", async () => {
    const screen = await render(<Harness threadId={THREAD_ID} />);
    useFilePickerStore.getState().setOpen(true);
    try {
      expect(pressPin().defaultPrevented).toBe(true);
      expect(isPinned(THREAD_ID)).toBe(false);
    } finally {
      useFilePickerStore.getState().setOpen(false);
    }
    await screen.unmount();
  });

  it("toggles once when mounted twice", async () => {
    const screen = await render(
      <>
        <Harness threadId={THREAD_ID} />
        <SecondMount threadId={THREAD_ID} />
      </>,
    );

    pressPin();
    expect(isPinned(THREAD_ID)).toBe(true);

    await screen.unmount();
  });

  it("leaves other chords alone", async () => {
    const screen = await render(<Harness threadId={THREAD_ID} />);

    expect(pressPin({ key: "o" }).defaultPrevented).toBe(false);
    expect(isPinned(THREAD_ID)).toBe(false);

    await screen.unmount();
  });
});
