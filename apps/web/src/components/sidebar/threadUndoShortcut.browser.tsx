import type { ResolvedKeybindingsConfig } from "@piedpiper/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { useCommandPaletteStore } from "../../commandPaletteStore";
import { useFilePickerStore } from "../../filePickerStore";
import { useSidebarThreadUndoShortcut } from "../../hooks/useSidebarThreadUndoShortcut";
import { toastManager } from "../ui/toast";
import { showThreadUndoToast, undoLatestThreadAction } from "./threadUndo";

const KEYBINDINGS: ResolvedKeybindingsConfig = [
  {
    command: "thread.undo",
    shortcut: {
      key: "z",
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      modKey: true,
    },
    whenAst: {
      type: "and",
      left: { type: "not", node: { type: "identifier", name: "terminalFocus" } },
      right: { type: "not", node: { type: "identifier", name: "editableFocus" } },
    },
  },
];

function Harness(props: { onEditorKeyDown: (event: React.KeyboardEvent) => void }) {
  useSidebarThreadUndoShortcut({
    keybindings: KEYBINDINGS,
    platform: "MacIntel",
    routeTerminalOpen: false,
  });
  return (
    <div
      data-testid="editor"
      contentEditable
      suppressContentEditableWarning
      onKeyDown={props.onEditorKeyDown}
    >
      <p>
        <br />
      </p>
    </div>
  );
}

describe("useSidebarThreadUndoShortcut", () => {
  afterEach(() => {
    while (undoLatestThreadAction()) {
      // Drain undos left by a failing test.
    }
    useCommandPaletteStore.setState({ open: false });
    useFilePickerStore.setState({ open: false });
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("undoes from an empty composer before the editor claims mod+z", async () => {
    vi.spyOn(toastManager, "add").mockReturnValue("toast");
    vi.spyOn(toastManager, "close").mockImplementation(() => undefined);
    const undo = vi.fn(() => Promise.resolve());
    showThreadUndoToast({ title: "Thread archived", failureTitle: "x", undo });
    const editorKeyDown = vi.fn((event: React.KeyboardEvent) => event.preventDefault());
    const screen = await render(<Harness onEditorKeyDown={editorKeyDown} />);

    const editor = screen.container.querySelector<HTMLElement>('[data-testid="editor"]')!;
    editor.focus();
    await userEvent.keyboard("{Meta>}z{/Meta}");

    expect(undo).toHaveBeenCalledOnce();
    expect(editorKeyDown.mock.calls.map(([event]) => event.key)).not.toContain("z");
  });

  it("leaves mod+z to an editor that has text", async () => {
    vi.spyOn(toastManager, "add").mockReturnValue("toast");
    const undo = vi.fn(() => Promise.resolve());
    showThreadUndoToast({ title: "Thread archived", failureTitle: "x", undo });
    const editorKeyDown = vi.fn((event: React.KeyboardEvent) => event.preventDefault());
    const screen = await render(<Harness onEditorKeyDown={editorKeyDown} />);

    const editor = screen.container.querySelector<HTMLElement>('[data-testid="editor"]')!;
    editor.querySelector("p")!.textContent = "draft";
    editor.focus();
    await userEvent.keyboard("{Meta>}z{/Meta}");

    expect(undo).not.toHaveBeenCalled();
    expect(editorKeyDown.mock.calls.map(([event]) => event.key)).toContain("z");
  });

  it.each([
    ["command palette", () => useCommandPaletteStore.setState({ open: true })],
    ["file picker", () => useFilePickerStore.setState({ open: true })],
  ])("leaves mod+z to the %s's search box while it is open", async (_name, openSurface) => {
    vi.spyOn(toastManager, "add").mockReturnValue("toast");
    const undo = vi.fn(() => Promise.resolve());
    showThreadUndoToast({ title: "Thread archived", failureTitle: "x", undo });
    const screen = await render(<Harness onEditorKeyDown={() => {}} />);
    openSurface();

    const event = new KeyboardEvent("keydown", {
      key: "z",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    screen.container.dispatchEvent(event);

    expect(undo).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("leaves mod+z to a shortcut recorder even when its field is empty", async () => {
    vi.spyOn(toastManager, "add").mockReturnValue("toast");
    const undo = vi.fn(() => Promise.resolve());
    showThreadUndoToast({ title: "Thread archived", failureTitle: "x", undo });
    const screen = await render(<Harness onEditorKeyDown={() => {}} />);
    const recorder = document.createElement("input");
    recorder.setAttribute("data-keybinding-capture", "");
    screen.container.append(recorder);
    const seenByRecorder = vi.fn();
    recorder.addEventListener("keydown", seenByRecorder);
    recorder.focus();

    await userEvent.keyboard("{Meta>}z{/Meta}");

    expect(undo).not.toHaveBeenCalled();
    expect(seenByRecorder.mock.calls.map(([event]) => event.key)).toContain("z");
  });

  it("consumes mod+z inside a confirmation without undoing behind it", async () => {
    vi.spyOn(toastManager, "add").mockReturnValue("toast");
    vi.spyOn(toastManager, "close").mockImplementation(() => undefined);
    const undo = vi.fn(() => Promise.resolve());
    showThreadUndoToast({ title: "Thread archived", failureTitle: "x", undo });
    const screen = await render(<Harness onEditorKeyDown={() => {}} />);
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "alertdialog");
    const cancel = document.createElement("button");
    dialog.append(cancel);
    screen.container.append(dialog);
    cancel.focus();

    const event = new KeyboardEvent("keydown", {
      key: "z",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    cancel.dispatchEvent(event);

    expect(undo).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });
});
