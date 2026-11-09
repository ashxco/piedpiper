import "../index.css";

import {
  ApprovalRequestId,
  type ResolvedKeybindingsConfig,
  type ThreadId,
} from "@piedpiper/contracts";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { useSidebarThreadJumpKeybindings } from "../hooks/useSidebarThreadJumpKeybindings";
import { useSidebarThreadPinShortcut } from "../hooks/useSidebarThreadPinShortcut";
import { useStore } from "../store";
import type { SidebarThreadSummary } from "../types";
import { useUiStateStore } from "../uiStateStore";
import { ComposerPendingUserInputPanel } from "./chat/ComposerPendingUserInputPanel";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./ui/alert-dialog";

const THREAD_A = "thread-guard-a" as ThreadId;
const THREAD_B = "thread-guard-b" as ThreadId;

const KEYBINDINGS: ResolvedKeybindingsConfig = [
  {
    command: "thread.next",
    shortcut: {
      key: "j",
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      modKey: true,
    },
  },
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
  },
];

function pressChord(target: EventTarget, key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", {
    key,
    metaKey: true,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}

function JumpHarness(props: { navigateToThread: (threadId: ThreadId) => void }) {
  const [open, setOpen] = useState(true);
  useSidebarThreadJumpKeybindings({
    keybindings: KEYBINDINGS,
    platform: "MacIntel",
    routeTerminalOpen: false,
    routeThreadId: THREAD_A,
    orderedSidebarThreadIds: [THREAD_A, THREAD_B],
    threadJumpThreadIds: [THREAD_B],
    navigateToThread: props.navigateToThread,
    updateThreadJumpHintsVisibility: () => {},
  });
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogPopup>
        <AlertDialogTitle>Delete thread?</AlertDialogTitle>
        <AlertDialogClose>Cancel</AlertDialogClose>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

describe("shortcuts behind a real confirmation dialog", () => {
  it("do not navigate after a click outside the popup moved focus to the body", async () => {
    const navigateToThread = vi.fn();
    const screen = await render(<JumpHarness navigateToThread={navigateToThread} />);
    await expect.element(page.getByRole("alertdialog")).toBeInTheDocument();

    await page
      .elementLocator(document.querySelector('[data-slot="alert-dialog-viewport"]')!)
      .click({ position: { x: 4, y: 4 } });
    await expect.element(page.getByRole("alertdialog")).toBeInTheDocument();
    await expect.poll(() => document.activeElement).toBe(document.body);

    expect(pressChord(document.body, "j").defaultPrevented).toBe(true);
    expect(navigateToThread).not.toHaveBeenCalled();

    await page.getByRole("button", { name: "Cancel" }).click();
    await expect.poll(() => document.querySelector('[role="alertdialog"]')).toBeNull();
    pressChord(document.body, "j");
    expect(navigateToThread).toHaveBeenCalledWith(THREAD_B);
    await screen.unmount();
  });
});

function PinHarness() {
  useSidebarThreadPinShortcut({
    keybindings: KEYBINDINGS,
    platform: "MacIntel",
    routeTerminalOpen: false,
    routeThreadId: THREAD_A,
  });
  return (
    <div role="alertdialog">
      <button data-testid="cancel">Cancel</button>
    </div>
  );
}

describe("the pin shortcut inside a confirmation", () => {
  beforeEach(() => {
    useStore.setState({
      sidebarThreadsById: { [THREAD_A]: { archivedAt: null } as SidebarThreadSummary },
    });
    useUiStateStore.getState().setThreadPinned(THREAD_A, false);
  });

  afterEach(() => {
    useStore.setState({ sidebarThreadsById: {} });
    useUiStateStore.getState().setThreadPinned(THREAD_A, false);
  });

  it("claims the chord without toggling the pin", async () => {
    const screen = await render(<PinHarness />);
    const cancel = document.querySelector('[data-testid="cancel"]')!;

    expect(pressChord(cancel, "p", { shiftKey: true }).defaultPrevented).toBe(true);
    expect(useUiStateStore.getState().pinnedThreadIds).not.toContain(THREAD_A);
    await screen.unmount();
  });
});

describe("pending question option keys inside a confirmation", () => {
  it("leaves them to the dialog", async () => {
    const onSelectOption = vi.fn();
    const screen = await render(
      <>
        <ComposerPendingUserInputPanel
          pendingUserInputs={[
            {
              requestId: ApprovalRequestId.makeUnsafe("request-guard"),
              createdAt: "2026-04-02T20:00:00.000Z",
              questions: [
                {
                  id: "q-1",
                  header: "Approach",
                  question: "Which approach?",
                  options: [
                    { label: "Alpha", description: "First" },
                    { label: "Beta", description: "Second" },
                  ],
                },
              ],
            },
          ]}
          respondingRequestIds={[]}
          answers={{}}
          questionIndex={0}
          onSelectOption={onSelectOption}
          onCustomAnswer={vi.fn()}
          onAdvance={vi.fn()}
        />
        <div role="alertdialog">
          <button data-testid="cancel">Cancel</button>
        </div>
      </>,
    );
    const cancel = document.querySelector('[data-testid="cancel"]')!;

    expect(pressChord(cancel, "a", { metaKey: false }).defaultPrevented).toBe(false);
    expect(pressChord(cancel, "2", { metaKey: false }).defaultPrevented).toBe(false);
    expect(onSelectOption).not.toHaveBeenCalled();

    pressChord(document.body, "a", { metaKey: false });
    expect(onSelectOption).toHaveBeenCalledWith("q-1", "Alpha");
    await screen.unmount();
  });
});
