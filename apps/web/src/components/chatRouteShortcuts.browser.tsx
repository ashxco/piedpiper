import "../index.css";

import { ThreadId } from "@piedpiper/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const { handleNewThreadSpy, shortcutCommand } = vi.hoisted(() => ({
  handleNewThreadSpy: vi.fn(),
  shortcutCommand: { current: null as string | null },
}));

vi.mock("@tanstack/react-router", () => ({
  Outlet: () => null,
  createFileRoute: () => (options: Record<string, unknown>) => ({ options }),
  useNavigate: () => vi.fn(),
  useParams: () => undefined,
}));
vi.mock("~/hooks/useHandleNewThread", () => ({
  useHandleNewThread: () => ({
    activeDraftThread: null,
    activeThread: null,
    defaultProjectId: "project-1",
    handleNewThread: handleNewThreadSpy,
    routeThreadId: null,
  }),
}));
vi.mock("~/keybindings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/keybindings")>()),
  resolveShortcutCommand: () => shortcutCommand.current,
}));

import { useCommandPaletteStore } from "../commandPaletteStore";
import { useFilePickerStore } from "../filePickerStore";
import { Route } from "../routes/_chat";
import { useThreadSelectionStore } from "../threadSelectionStore";

const ChatRouteLayout = (Route as unknown as { options: { component: () => React.JSX.Element } })
  .options.component;

const THREAD_ID = ThreadId.makeUnsafe("thread-1");

function pressKey(target: EventTarget, key: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

describe("chat route shortcuts", () => {
  let dialogButton: HTMLButtonElement;

  beforeEach(() => {
    useThreadSelectionStore.setState({ selectedThreadIds: new Set([THREAD_ID]) });
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "alertdialog");
    dialogButton = document.createElement("button");
    dialog.append(dialogButton);
    document.body.append(dialog);
  });

  afterEach(() => {
    dialogButton.parentElement?.remove();
    useThreadSelectionStore.setState({ selectedThreadIds: new Set() });
    useFilePickerStore.getState().setOpen(false);
    useCommandPaletteStore.getState().setOpen(false);
    handleNewThreadSpy.mockReset();
    shortcutCommand.current = null;
  });

  it("swallows new-thread chords pressed inside a confirmation dialog", async () => {
    await render(<ChatRouteLayout />);
    shortcutCommand.current = "chat.new";
    expect(pressKey(dialogButton, "n").defaultPrevented).toBe(true);
    shortcutCommand.current = "chat.newLocal";
    expect(pressKey(dialogButton, "n").defaultPrevented).toBe(true);
    expect(handleNewThreadSpy).not.toHaveBeenCalled();

    pressKey(document.body, "n");
    expect(handleNewThreadSpy).toHaveBeenCalledTimes(1);
  });

  it("leaves Escape to the dialog without clearing the selection behind it", async () => {
    await render(<ChatRouteLayout />);
    expect(pressKey(dialogButton, "Escape").defaultPrevented).toBe(false);
    expect(useThreadSelectionStore.getState().selectedThreadIds.size).toBe(1);

    pressKey(document.body, "Escape");
    expect(useThreadSelectionStore.getState().selectedThreadIds.size).toBe(0);
  });

  it.each([
    ["file picker", () => useFilePickerStore.getState().setOpen(true)],
    ["command palette", () => useCommandPaletteStore.getState().setOpen(true)],
  ])("stands down behind the %s", async (_name, openSurface) => {
    await render(<ChatRouteLayout />);
    openSurface();

    shortcutCommand.current = "chat.new";
    expect(pressKey(document.body, "n").defaultPrevented).toBe(false);
    shortcutCommand.current = "chat.newLocal";
    expect(pressKey(document.body, "n").defaultPrevented).toBe(false);
    expect(handleNewThreadSpy).not.toHaveBeenCalled();

    shortcutCommand.current = null;
    expect(pressKey(document.body, "Escape").defaultPrevented).toBe(false);
    expect(useThreadSelectionStore.getState().selectedThreadIds.size).toBe(1);
  });
});
