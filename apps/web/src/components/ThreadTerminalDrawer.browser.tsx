import "../index.css";

import type { ThreadId } from "@piedpiper/contracts";
import { type ILink, type ILinkProvider, Terminal } from "@xterm/xterm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

// Without a native API the terminal viewports skip opening a PTY, leaving only drawer layout.
const nativeApiHolder = vi.hoisted(() => ({ api: undefined as unknown }));
vi.mock("~/nativeApi", () => ({
  readNativeApi: () => nativeApiHolder.api,
  ensureNativeApi: () => nativeApiHolder.api,
}));
vi.mock("~/wsRpcClient", () => ({ getWsRpcClient: vi.fn() }));

import ThreadTerminalDrawer from "./ThreadTerminalDrawer";
import { getWsRpcClient } from "~/wsRpcClient";
import { type TerminalContextSelection } from "~/lib/terminalContext";
import { useTerminalStateStore } from "../terminalStateStore";
import { useTerminalTabStateStore } from "../terminalTabStateStore";
import {
  collectWrappedTerminalLinkLine,
  extractTerminalLinks,
  resolveWrappedTerminalLinkRange,
} from "../terminal-links";

const THREAD_ID = "thread-terminal-drawer-test" as ThreadId;

function renderDrawer(
  onHeightChange: (height: number) => void,
  height = 900,
  onCloseTerminal: (terminalId: string) => void = () => undefined,
  onAddTerminalContext: (selection: TerminalContextSelection) => void = () => undefined,
) {
  return render(
    <ThreadTerminalDrawer
      threadId={THREAD_ID}
      cwd="/repo/project"
      height={height}
      terminalIds={["default"]}
      activeTerminalId="default"
      terminalGroups={[{ id: "group-default", terminalIds: ["default"] }]}
      activeTerminalGroupId="group-default"
      focusRequestId={0}
      onSplitTerminal={() => undefined}
      onSplitTerminalVertical={() => undefined}
      onNewTerminal={() => undefined}
      onActiveTerminalChange={() => undefined}
      onCloseTerminal={onCloseTerminal}
      onHeightChange={onHeightChange}
      onAddTerminalContext={onAddTerminalContext}
    />,
  );
}

function drawerHeight(): number {
  const aside = document.querySelector<HTMLElement>("aside.thread-terminal-drawer");
  if (!aside) throw new Error("drawer not rendered");
  return Number.parseInt(aside.style.height, 10);
}

function dispatchPointer(target: Element, type: string, clientY: number) {
  target.dispatchEvent(
    new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, button: 0, clientY }),
  );
}

describe("ThreadTerminalDrawer height", () => {
  beforeEach(async () => {
    await page.viewport(1200, 1400);
    // Synthetic pointer events have no active pointer, so capture calls would throw.
    vi.spyOn(HTMLElement.prototype, "setPointerCapture").mockImplementation(() => undefined);
    vi.spyOn(HTMLElement.prototype, "releasePointerCapture").mockImplementation(() => undefined);
    vi.spyOn(HTMLElement.prototype, "hasPointerCapture").mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("caps the rendered height on window shrink without persisting it", async () => {
    const onHeightChange = vi.fn();
    const screen = await renderDrawer(onHeightChange);
    await vi.waitFor(() => expect(drawerHeight()).toBe(900));

    await page.viewport(1200, 800);
    await vi.waitFor(() => expect(drawerHeight()).toBe(600));
    expect(onHeightChange).not.toHaveBeenCalled();

    await page.viewport(1200, 1400);
    await vi.waitFor(() => expect(drawerHeight()).toBe(900));

    await screen.unmount();
    expect(onHeightChange).not.toHaveBeenCalled();
  });

  it("keeps the stored preference after a zero-net drag while window-capped", async () => {
    const onHeightChange = vi.fn();
    const screen = await renderDrawer(onHeightChange);
    await page.viewport(1200, 800);
    await vi.waitFor(() => expect(drawerHeight()).toBe(600));

    const handle = document.querySelector(".cursor-row-resize");
    if (!handle) throw new Error("resize handle not rendered");
    dispatchPointer(handle, "pointerdown", 300);
    dispatchPointer(handle, "pointermove", 400);
    await vi.waitFor(() => expect(drawerHeight()).toBe(500));
    dispatchPointer(handle, "pointermove", 300);
    await vi.waitFor(() => expect(drawerHeight()).toBe(600));
    dispatchPointer(handle, "pointerup", 300);

    await page.viewport(1200, 1400);
    await vi.waitFor(() => expect(drawerHeight()).toBe(900));

    await screen.unmount();
    expect(onHeightChange).not.toHaveBeenCalled();
  });

  it("persists the dragged height when a drag ends elsewhere", async () => {
    const onHeightChange = vi.fn();
    await renderDrawer(onHeightChange, 400);
    await vi.waitFor(() => expect(drawerHeight()).toBe(400));

    const handle = document.querySelector(".cursor-row-resize");
    if (!handle) throw new Error("resize handle not rendered");
    dispatchPointer(handle, "pointerdown", 500);
    dispatchPointer(handle, "pointermove", 400);
    await vi.waitFor(() => expect(drawerHeight()).toBe(500));
    dispatchPointer(handle, "pointerup", 400);

    expect(onHeightChange).toHaveBeenCalledWith(500);
  });

  it("moves the drawer during a drag and commits once when pointer capture is lost", async () => {
    const onHeightChange = vi.fn();
    await renderDrawer(onHeightChange, 400);
    await vi.waitFor(() => expect(drawerHeight()).toBe(400));

    const handle = document.querySelector(".cursor-row-resize");
    if (!handle) throw new Error("resize handle not rendered");
    dispatchPointer(handle, "pointerdown", 500);
    dispatchPointer(handle, "pointermove", 450);
    expect(drawerHeight()).toBe(450);
    dispatchPointer(handle, "pointermove", 420);
    expect(drawerHeight()).toBe(480);
    expect(onHeightChange).not.toHaveBeenCalled();

    dispatchPointer(handle, "lostpointercapture", 420);
    expect(onHeightChange).toHaveBeenCalledTimes(1);
    expect(onHeightChange).toHaveBeenCalledWith(480);
    await vi.waitFor(() => expect(drawerHeight()).toBe(480));

    // The drag has ended, so later moves no longer resize the drawer.
    dispatchPointer(handle, "pointermove", 300);
    dispatchPointer(handle, "pointerup", 300);
    expect(drawerHeight()).toBe(480);
    expect(onHeightChange).toHaveBeenCalledTimes(1);
  });

  it("keeps the dragged height when a window resize re-renders mid-drag", async () => {
    const onHeightChange = vi.fn();
    await renderDrawer(onHeightChange, 400);
    await vi.waitFor(() => expect(drawerHeight()).toBe(400));

    const handle = document.querySelector(".cursor-row-resize");
    if (!handle) throw new Error("resize handle not rendered");
    dispatchPointer(handle, "pointerdown", 500);
    dispatchPointer(handle, "pointermove", 450);
    expect(drawerHeight()).toBe(450);

    // The window cap drops to 390, so the committed drawerHeight changes under the drag.
    await page.viewport(1200, 520);
    await new Promise((resolve) => window.setTimeout(resolve, 50));
    expect(drawerHeight()).toBe(450);

    dispatchPointer(handle, "pointerup", 450);
    expect(onHeightChange).toHaveBeenCalledWith(450);
  });
});

function fixedHeightBlock(height: number): HTMLElement {
  const element = document.createElement("div");
  element.style.height = `${height}px`;
  return element;
}

describe("ThreadTerminalDrawer in a chat column", () => {
  let composerHeight = 100;

  function renderInColumn(onHeightChange: (height: number) => void, height: number) {
    return render(
      <div data-chat-column style={{ height: 700, display: "flex", flexDirection: "column" }}>
        <header data-chat-header style={{ height: 50, flexShrink: 0 }} />
        <div style={{ flex: 1, minHeight: 0 }}>
          <div
            data-chat-composer-root
            data-testid="composer-root"
            style={{ height: composerHeight }}
          />
        </div>
        <ThreadTerminalDrawer
          threadId={THREAD_ID}
          cwd="/repo/project"
          height={height}
          terminalIds={["default"]}
          activeTerminalId="default"
          terminalGroups={[{ id: "group-default", terminalIds: ["default"] }]}
          activeTerminalGroupId="group-default"
          focusRequestId={0}
          onSplitTerminal={() => undefined}
          onSplitTerminalVertical={() => undefined}
          onNewTerminal={() => undefined}
          onActiveTerminalChange={() => undefined}
          onCloseTerminal={() => undefined}
          onHeightChange={onHeightChange}
          onAddTerminalContext={() => undefined}
        />
      </div>,
    );
  }

  beforeEach(async () => {
    composerHeight = 100;
    await page.viewport(1200, 1400);
  });

  it("follows composer growth without persisting the cap", async () => {
    const onHeightChange = vi.fn();
    const screen = await renderInColumn(onHeightChange, 900);
    await vi.waitFor(() => expect(drawerHeight()).toBe(550));

    const composer = document.querySelector<HTMLElement>('[data-testid="composer-root"]');
    if (!composer) throw new Error("composer stand-in not rendered");
    composer.style.height = "300px";
    await vi.waitFor(() => expect(drawerHeight()).toBe(350));
    composer.style.width = "200px";
    await settle();
    expect(drawerHeight()).toBe(350);

    composer.style.height = "100px";
    await vi.waitFor(() => expect(drawerHeight()).toBe(550));

    await screen.unmount();
    expect(onHeightChange).not.toHaveBeenCalled();
  });

  it("reserves notices and survives a child swap inside the stable composer root", async () => {
    const screen = await renderInColumn(() => undefined, 900);
    await vi.waitFor(() => expect(drawerHeight()).toBe(550));

    const root = document.querySelector<HTMLElement>('[data-testid="composer-root"]');
    if (!root) throw new Error("composer stand-in not rendered");
    const notice = fixedHeightBlock(120);
    const banner = fixedHeightBlock(60);
    root.style.height = "auto";
    root.replaceChildren(notice, banner);
    await vi.waitFor(() => expect(drawerHeight()).toBe(470));

    // The missing-folder banner gives way to the composer inside the same root.
    const composer = fixedHeightBlock(100);
    banner.replaceWith(composer);
    await vi.waitFor(() => expect(drawerHeight()).toBe(430));

    // The composer's top padding changes while a turn runs; the root's content box follows it.
    composer.style.boxSizing = "content-box";
    composer.style.paddingTop = "24px";
    await vi.waitFor(() => expect(drawerHeight()).toBe(406));

    notice.remove();
    await vi.waitFor(() => expect(drawerHeight()).toBe(526));
    await screen.unmount();
  });

  it("stops a drag at the space the composer leaves", async () => {
    const onHeightChange = vi.fn();
    await renderInColumn(onHeightChange, 300);
    await vi.waitFor(() => expect(drawerHeight()).toBe(300));

    vi.spyOn(HTMLElement.prototype, "setPointerCapture").mockImplementation(() => undefined);
    vi.spyOn(HTMLElement.prototype, "releasePointerCapture").mockImplementation(() => undefined);
    vi.spyOn(HTMLElement.prototype, "hasPointerCapture").mockReturnValue(true);
    const handle = document.querySelector(".cursor-row-resize");
    if (!handle) throw new Error("resize handle not rendered");
    dispatchPointer(handle, "pointerdown", 500);
    dispatchPointer(handle, "pointermove", 0);
    expect(drawerHeight()).toBe(550);
    dispatchPointer(handle, "pointerup", 0);
    expect(onHeightChange).toHaveBeenCalledWith(550);
    vi.restoreAllMocks();
  });
});

function paneGrid(): HTMLElement {
  const grid = document.querySelector<HTMLElement>("aside.thread-terminal-drawer .grid");
  if (!grid) throw new Error("pane grid not rendered");
  return grid;
}

describe("ThreadTerminalDrawer split layout", () => {
  function renderSplit(
    splitDirection: "horizontal" | "vertical",
    options: { onSplitTerminalVertical?: () => void } = {},
  ) {
    return render(
      <div style={{ width: 800 }}>
        <ThreadTerminalDrawer
          threadId={THREAD_ID}
          cwd="/repo/project"
          height={400}
          terminalIds={["a", "b", "c"]}
          activeTerminalId="a"
          terminalGroups={[
            { id: "group-a", terminalIds: ["a", "b"], splitDirection },
            { id: "group-c", terminalIds: ["c"] },
          ]}
          activeTerminalGroupId="group-a"
          focusRequestId={0}
          onSplitTerminal={() => undefined}
          onSplitTerminalVertical={options.onSplitTerminalVertical ?? (() => undefined)}
          onNewTerminal={() => undefined}
          onActiveTerminalChange={() => undefined}
          onCloseTerminal={() => undefined}
          onHeightChange={() => undefined}
          onAddTerminalContext={() => undefined}
        />
      </div>,
    );
  }

  beforeEach(async () => {
    await page.viewport(1200, 1400);
  });

  afterEach(() => {
    nativeApiHolder.api = undefined;
    vi.restoreAllMocks();
  });

  it("lays stacked panes out in rows", async () => {
    const screen = await renderSplit("vertical");
    expect(paneGrid().style.gridTemplateRows).toBe("repeat(2, minmax(0px, 1fr))");
    expect(paneGrid().style.gridTemplateColumns).toBe("");
    await screen.unmount();
  });

  it("keeps side-by-side panes in columns", async () => {
    const screen = await renderSplit("horizontal");
    expect(paneGrid().style.gridTemplateColumns).toBe("repeat(2, minmax(0px, 1fr))");
    expect(paneGrid().style.gridTemplateRows).toBe("");
    await screen.unmount();
  });

  it("labels group headers by layout, independent of terminal numbers", async () => {
    const screen = await renderSplit("horizontal");
    const headers = [
      ...document.querySelectorAll<HTMLElement>("aside.thread-terminal-drawer aside button"),
    ]
      .map((button) => button.textContent ?? "")
      .filter((text) => /Single|Side by side|Stacked/.test(text));
    expect(headers).toEqual(["Side by side2", "Single1"]);
    const names = [
      ...document.querySelectorAll<HTMLElement>("aside.thread-terminal-drawer aside button"),
    ]
      .filter((button) => /Single|Side by side|Stacked/.test(button.textContent ?? ""))
      .map((button) => button.getAttribute("aria-label"));
    expect(names).toEqual([
      "Side by side group, 2 terminals: Terminal 1, Terminal 2",
      "Single group, 1 terminal: Terminal 3",
    ]);
    await screen.unmount();
  });

  it("offers a stack action", async () => {
    const onSplitTerminalVertical = vi.fn();
    const screen = await renderSplit("horizontal", { onSplitTerminalVertical });
    document.querySelector<HTMLElement>('button[aria-label="Stack Terminal Below"]')?.click();
    expect(onSplitTerminalVertical).toHaveBeenCalledTimes(1);
    await screen.unmount();
  });

  it("refits a pane and resizes its PTY when the pane changes size without a prop change", async () => {
    const terminals = captureTerminalInstances();
    const resize = vi.fn((_input: { cols: number; rows: number }) => Promise.resolve());
    const stub = createNativeApiStub({ history: "hello\r\n" });
    nativeApiHolder.api = { ...stub, terminal: { ...stub.terminal, resize } };
    const screen = await renderDrawer(() => undefined, 400);
    await vi.waitFor(() => expect(terminalRowsText()).toContain("hello"));
    await settle(60);
    const terminal = terminals.at(-1);
    if (!terminal) throw new Error("terminal not created");
    const initialCols = terminal.cols;
    resize.mockClear();

    const mount = terminal.element?.parentElement;
    if (!mount) throw new Error("terminal mount not found");
    mount.style.width = "50%";
    await vi.waitFor(() => expect(terminal.cols).toBeLessThan(initialCols));
    await vi.waitFor(() =>
      expect(resize).toHaveBeenCalledWith(expect.objectContaining({ cols: terminal.cols })),
    );

    // A zero-size (hidden) pane keeps its dimensions and reports nothing.
    const fittedCols = terminal.cols;
    resize.mockClear();
    mount.style.width = "0px";
    await settle(60);
    expect(terminal.cols).toBe(fittedCols);
    expect(resize).not.toHaveBeenCalled();
    await screen.unmount();
  });

  it("does not refit during a drawer drag", async () => {
    const terminals = captureTerminalInstances();
    const resize = vi.fn((_input: { cols: number; rows: number }) => Promise.resolve());
    const stub = createNativeApiStub({ history: "hello\r\n" });
    nativeApiHolder.api = { ...stub, terminal: { ...stub.terminal, resize } };
    vi.spyOn(HTMLElement.prototype, "setPointerCapture").mockImplementation(() => undefined);
    vi.spyOn(HTMLElement.prototype, "releasePointerCapture").mockImplementation(() => undefined);
    vi.spyOn(HTMLElement.prototype, "hasPointerCapture").mockReturnValue(true);
    const screen = await renderDrawer(() => undefined, 400);
    await vi.waitFor(() => expect(terminalRowsText()).toContain("hello"));
    await settle(60);
    const terminal = terminals.at(-1);
    if (!terminal) throw new Error("terminal not created");
    const initialRows = terminal.rows;
    resize.mockClear();

    const handle = document.querySelector(".cursor-row-resize");
    if (!handle) throw new Error("resize handle not rendered");
    dispatchPointer(handle, "pointerdown", 500);
    dispatchPointer(handle, "pointermove", 300);
    await settle(60);
    expect(terminal.rows).toBe(initialRows);
    expect(resize).not.toHaveBeenCalled();

    dispatchPointer(handle, "pointerup", 300);
    await vi.waitFor(() => expect(terminal.rows).toBeGreaterThan(initialRows));
    await vi.waitFor(() => expect(resize).toHaveBeenCalled());
    await screen.unmount();
  });
});

describe("terminal link ranges against real xterm cells", () => {
  async function linkRangeInXterm(cols: number, data: string, bufferLineNumber = 1) {
    const host = document.createElement("div");
    document.body.append(host);
    const terminal = new Terminal({ cols, rows: 6 });
    terminal.open(host);
    await new Promise<void>((resolve) => terminal.write(data, resolve));
    const buffer = terminal.buffer.active;
    const wrappedLine = collectWrappedTerminalLinkLine(bufferLineNumber, (index) =>
      buffer.getLine(index),
    );
    const match = wrappedLine ? extractTerminalLinks(wrappedLine.text)[0] : undefined;
    const result =
      wrappedLine && match
        ? { text: match.text, range: resolveWrappedTerminalLinkRange(wrappedLine, match) }
        : null;
    terminal.dispose();
    host.remove();
    return result;
  }

  it("places a link after CJK on its cells", async () => {
    expect(await linkRangeInXterm(40, "日本 https://a.io/x")).toEqual({
      text: "https://a.io/x",
      range: { start: { x: 6, y: 1 }, end: { x: 19, y: 1 } },
    });
  });

  it("places a link after a surrogate-pair emoji on its cells", async () => {
    // xterm's default Unicode 6 tables give this emoji one cell.
    expect(await linkRangeInXterm(40, "😀 https://a.io/x")).toEqual({
      text: "https://a.io/x",
      range: { start: { x: 3, y: 1 }, end: { x: 16, y: 1 } },
    });
  });

  it("keeps a combining mark in its base cell", async () => {
    expect(await linkRangeInXterm(40, "e\u0301 https://a.io/x")).toEqual({
      text: "https://a.io/x",
      range: { start: { x: 3, y: 1 }, end: { x: 16, y: 1 } },
    });
  });

  it("ends on the tail of a trailing wide character", async () => {
    expect(await linkRangeInXterm(40, "https://a.io/語")).toEqual({
      text: "https://a.io/語",
      range: { start: { x: 1, y: 1 }, end: { x: 15, y: 1 } },
    });
  });

  it("keeps one link across the pad cell left by a wrapped wide character", async () => {
    // 13 ASCII cells leave one free cell in a 14-column row, so 語 wraps and pads it.
    expect(await linkRangeInXterm(14, "https://a.io/語/x")).toEqual({
      text: "https://a.io/語/x",
      range: { start: { x: 1, y: 1 }, end: { x: 4, y: 2 } },
    });
  });
});

function createNativeApiStub(overrides: {
  history?: string;
  contextMenuShow?: (items: unknown, position: unknown) => Promise<string | null>;
  confirm?: (message: string) => Promise<boolean>;
}) {
  return {
    terminal: {
      open: (input: { threadId: string; terminalId: string; cwd: string }) =>
        Promise.resolve({
          threadId: input.threadId,
          terminalId: input.terminalId,
          cwd: input.cwd,
          status: "running",
          pid: 123,
          history: overrides.history ?? "",
          exitCode: null,
          exitSignal: null,
          updatedAt: new Date().toISOString(),
        }),
      resize: () => Promise.resolve(),
      write: () => Promise.resolve(),
    },
    contextMenu: { show: overrides.contextMenuShow ?? (() => Promise.resolve(null)) },
    dialogs: { confirm: overrides.confirm ?? (() => Promise.resolve(true)) },
    shell: { openExternal: () => Promise.resolve() },
  };
}

function terminalRowsText(): string {
  return document.querySelector("aside.thread-terminal-drawer .xterm-rows")?.textContent ?? "";
}

async function selectFirstTerminalWord() {
  await vi.waitFor(() => expect(terminalRowsText()).toContain("hello"));
  const screenElement = document.querySelector<HTMLElement>(
    "aside.thread-terminal-drawer .xterm-screen",
  );
  if (!screenElement) throw new Error("xterm screen not rendered");
  await userEvent.dblClick(screenElement, { position: { x: 8, y: 6 } });
}

describe("ThreadTerminalDrawer selection menu copy", () => {
  beforeEach(async () => {
    await page.viewport(1200, 1400);
  });

  afterEach(() => {
    nativeApiHolder.api = undefined;
    vi.restoreAllMocks();
  });

  it("copies the raw selection when Copy is picked", async () => {
    const show = vi.fn((_items: unknown, _position: unknown) =>
      Promise.resolve<string | null>("copy"),
    );
    nativeApiHolder.api = createNativeApiStub({
      history: "hello world\r\n",
      contextMenuShow: show,
    });
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    const screen = await renderDrawer(() => undefined, 400);

    await selectFirstTerminalWord();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("hello"));
    expect(show.mock.calls[0]?.[0]).toEqual([
      { id: "copy", label: "Copy" },
      { id: "add-to-chat", label: "Add to chat" },
    ]);
    await screen.unmount();
  });

  it("reports a failed copy in the terminal without throwing", async () => {
    nativeApiHolder.api = createNativeApiStub({
      history: "hello world\r\n",
      contextMenuShow: () => Promise.resolve("copy"),
    });
    const writeText = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockRejectedValue(new Error("Clipboard denied"));
    const screen = await renderDrawer(() => undefined, 400);

    await selectFirstTerminalWord();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalled());
    await vi.waitFor(() => expect(terminalRowsText()).toContain("[terminal]"));
    await screen.unmount();
  });
});

function closeButton(): HTMLElement {
  const button = document.querySelector<HTMLElement>(
    'aside.thread-terminal-drawer button[aria-label^="Close Terminal"]',
  );
  if (!button) throw new Error("close button not rendered");
  return button;
}

describe("ThreadTerminalDrawer close confirmation", () => {
  beforeEach(async () => {
    await page.viewport(1200, 1400);
    useTerminalStateStore.getState().removeTerminalState(THREAD_ID);
  });

  afterEach(() => {
    nativeApiHolder.api = undefined;
    useTerminalStateStore.getState().removeTerminalState(THREAD_ID);
    vi.restoreAllMocks();
  });

  for (const confirmed of [true, false]) {
    it(`closes a running terminal only after the user ${confirmed ? "confirms" : "cancels"}`, async () => {
      const resolvers: Array<(value: boolean) => void> = [];
      const confirm = vi.fn(
        (_message: string) => new Promise<boolean>((resolve) => resolvers.push(resolve)),
      );
      nativeApiHolder.api = createNativeApiStub({ confirm });
      useTerminalStateStore.getState().setTerminalActivity(THREAD_ID, "default", true);
      const onCloseTerminal = vi.fn();
      const screen = await renderDrawer(() => undefined, 400, onCloseTerminal);

      closeButton().click();
      await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
      expect(onCloseTerminal).not.toHaveBeenCalled();

      resolvers[0]?.(confirmed);
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      if (confirmed) {
        expect(onCloseTerminal).toHaveBeenCalledWith("default");
      } else {
        expect(onCloseTerminal).not.toHaveBeenCalled();
      }
      await screen.unmount();
    });
  }

  it("closes an idle terminal without asking", async () => {
    const confirm = vi.fn(() => Promise.resolve(false));
    nativeApiHolder.api = createNativeApiStub({ confirm });
    const onCloseTerminal = vi.fn();
    const screen = await renderDrawer(() => undefined, 400, onCloseTerminal);

    closeButton().click();
    await vi.waitFor(() => expect(onCloseTerminal).toHaveBeenCalledWith("default"));
    expect(confirm).not.toHaveBeenCalled();
    await screen.unmount();
  });
});

const closeLabels = () =>
  Array.from(
    document.querySelectorAll('aside.thread-terminal-drawer button[aria-label^="Close Terminal "]'),
    (button) => button.getAttribute("aria-label"),
  ).filter((label) => /^Close Terminal \d+/.test(label ?? ""));

describe("ThreadTerminalDrawer tab labels", () => {
  beforeEach(async () => {
    await page.viewport(1200, 1400);
    useTerminalTabStateStore.setState({ commandLabelsByThreadId: {} });
  });

  afterEach(() => {
    nativeApiHolder.api = undefined;
    useTerminalTabStateStore.setState({ commandLabelsByThreadId: {} });
  });

  const renderTabs = (terminalIds: string[]) =>
    render(
      <ThreadTerminalDrawer
        threadId={THREAD_ID}
        cwd="/repo/project"
        height={400}
        terminalIds={terminalIds}
        activeTerminalId={terminalIds[0]!}
        terminalGroups={terminalIds.map((id) => ({ id: `group-${id}`, terminalIds: [id] }))}
        activeTerminalGroupId={`group-${terminalIds[0]!}`}
        focusRequestId={0}
        onSplitTerminal={() => undefined}
        onSplitTerminalVertical={() => undefined}
        onNewTerminal={() => undefined}
        onActiveTerminalChange={() => undefined}
        onCloseTerminal={() => undefined}
        onHeightChange={() => undefined}
        onAddTerminalContext={() => undefined}
      />,
    );

  it("keeps a terminal's number after an earlier terminal closes", async () => {
    const screen = await renderTabs(["default", "term-3"]);
    await vi.waitFor(() => expect(closeLabels()).toHaveLength(2));
    expect(closeLabels()[1]).toContain("Terminal 3");
    await screen.unmount();
  });

  it("shows the running command in the tab but the number in the close label", async () => {
    useTerminalTabStateStore.setState({
      commandLabelsByThreadId: { [THREAD_ID]: { "term-3": "vim" } },
    });
    const screen = await renderTabs(["default", "term-3"]);
    await vi.waitFor(() =>
      expect(document.querySelector("aside.thread-terminal-drawer")?.textContent).toContain("vim"),
    );
    expect(closeLabels()[1]).toContain("Terminal 3");
    await screen.unmount();
  });

  it("restores the command label from the snapshot after a reload", async () => {
    const stub = createNativeApiStub({});
    const open = stub.terminal.open;
    nativeApiHolder.api = {
      ...stub,
      terminal: {
        ...stub.terminal,
        open: async (input: { threadId: string; terminalId: string; cwd: string }) => ({
          ...(await open(input)),
          label: "bun run dev",
        }),
      },
    };
    const screen = await renderDrawer(() => undefined, 400);
    await vi.waitFor(() =>
      expect(useTerminalTabStateStore.getState().commandLabelsByThreadId[THREAD_ID]).toEqual({
        default: "bun run dev",
      }),
    );
    await screen.unmount();
  });

  it("is a stop in the F6 cycle", async () => {
    const screen = await renderDrawer(() => undefined, 400);
    const drawer = document.querySelector<HTMLElement>("aside.thread-terminal-drawer");
    expect(drawer?.dataset.workspaceArea).toBe("terminal");
    expect(drawer?.getAttribute("aria-label")).toBe("Terminal");
    await screen.unmount();
  });
});

function terminalHasFocus(): boolean {
  const drawer = document.querySelector("aside.thread-terminal-drawer");
  return drawer?.contains(document.activeElement) ?? false;
}

describe("ThreadTerminalDrawer startup focus", () => {
  let resolveOpen: (() => void) | null = null;

  beforeEach(async () => {
    await page.viewport(1200, 1400);
    resolveOpen = null;
    nativeApiHolder.api = {
      terminal: {
        open: (input: { threadId: string; terminalId: string; cwd: string }) =>
          new Promise((resolve) => {
            resolveOpen = () =>
              resolve({
                threadId: input.threadId,
                terminalId: input.terminalId,
                cwd: input.cwd,
                status: "running",
                pid: 123,
                history: "",
                exitCode: null,
                exitSignal: null,
                updatedAt: new Date().toISOString(),
              });
          }),
        resize: () => Promise.resolve(),
        write: () => Promise.resolve(),
      },
      contextMenu: { show: () => Promise.resolve(null) },
      shell: { openExternal: () => Promise.resolve() },
    };
  });

  afterEach(() => {
    nativeApiHolder.api = undefined;
    document.querySelectorAll("[data-testid=composer-stand-in]").forEach((node) => node.remove());
    vi.restoreAllMocks();
  });

  it("does not pull focus back when the user moved away before the shell opened", async () => {
    const composer = document.createElement("textarea");
    composer.dataset.testid = "composer-stand-in";
    document.body.append(composer);
    const screen = await renderDrawer(() => undefined);
    await vi.waitFor(() => expect(terminalHasFocus()).toBe(true));
    await vi.waitFor(() => expect(resolveOpen).not.toBeNull());

    composer.focus();
    resolveOpen?.();
    await new Promise((resolve) => window.setTimeout(resolve, 50));

    expect(document.activeElement).toBe(composer);
    await screen.unmount();
  });

  it("keeps the terminal focused through startup when focus stayed inside it", async () => {
    const screen = await renderDrawer(() => undefined);
    await vi.waitFor(() => expect(terminalHasFocus()).toBe(true));
    await vi.waitFor(() => expect(resolveOpen).not.toBeNull());

    resolveOpen?.();
    await new Promise((resolve) => window.setTimeout(resolve, 50));

    expect(terminalHasFocus()).toBe(true);
    await screen.unmount();
  });
});

describe("ThreadTerminalDrawer path links", () => {
  beforeEach(async () => {
    await page.viewport(1200, 1400);
  });

  afterEach(() => {
    nativeApiHolder.api = undefined;
    vi.restoreAllMocks();
  });

  it("links URLs and existing paths but not missing ones", async () => {
    const statPath = vi.fn(async ({ path }: { path: string }) => ({
      kind: path.includes("gone") ? ("missing" as const) : ("file" as const),
    }));
    vi.mocked(getWsRpcClient).mockReturnValue({ projects: { statPath } } as never);
    const providers: ILinkProvider[] = [];
    const registerLinkProvider = Terminal.prototype.registerLinkProvider;
    vi.spyOn(Terminal.prototype, "registerLinkProvider").mockImplementation(function (
      this: Terminal,
      provider: ILinkProvider,
    ) {
      providers.push(provider);
      return registerLinkProvider.call(this, provider);
    });
    nativeApiHolder.api = createNativeApiStub({
      history: "/repo/project/gone.ts /repo/project/kept.ts https://example.com/docs\r\n",
    });
    const screen = await renderDrawer(() => undefined, 400);

    await vi.waitFor(() => expect(terminalRowsText()).toContain("https://example.com/docs"));
    const provider = providers.at(-1);
    if (!provider) throw new Error("link provider not registered");
    const links = await new Promise<ILink[] | undefined>((resolve) =>
      provider.provideLinks(1, resolve),
    );
    expect(links?.map((link) => link.text)).toEqual([
      "/repo/project/kept.ts",
      "https://example.com/docs",
    ]);
    await screen.unmount();
  });
});

function captureTerminalInstances(): Terminal[] {
  const terminals: Terminal[] = [];
  const registerLinkProvider = Terminal.prototype.registerLinkProvider;
  vi.spyOn(Terminal.prototype, "registerLinkProvider").mockImplementation(function (
    this: Terminal,
    provider: ILinkProvider,
  ) {
    terminals.push(this);
    return registerLinkProvider.call(this, provider);
  });
  return terminals;
}

function deferredMenu() {
  const pending: Array<(id: string | null) => void> = [];
  const show = vi.fn(
    (_items: unknown, _position: unknown) =>
      new Promise<string | null>((resolve) => {
        pending.push(resolve);
      }),
  );
  return { show, pick: (id: string | null) => pending.pop()?.(id) };
}

function recordTerminalOutput(data: string, sequence?: number) {
  useTerminalStateStore.getState().recordTerminalEvent({
    type: "output",
    threadId: THREAD_ID,
    terminalId: "default",
    createdAt: new Date(Date.now() + 1_000).toISOString(),
    data,
    ...(sequence === undefined ? {} : { sequence }),
  });
}

function settle(ms = 30) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

describe("ThreadTerminalDrawer selection menu during output", () => {
  beforeEach(async () => {
    await page.viewport(1200, 1400);
  });

  afterEach(() => {
    nativeApiHolder.api = undefined;
    vi.restoreAllMocks();
  });

  it("copies the captured text when output arrives while the menu is open", async () => {
    const menu = deferredMenu();
    nativeApiHolder.api = createNativeApiStub({
      history: "hello world\r\n",
      contextMenuShow: menu.show,
    });
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    const screen = await renderDrawer(() => undefined, 400);

    await selectFirstTerminalWord();
    await vi.waitFor(() => expect(menu.show).toHaveBeenCalled());
    recordTerminalOutput("build line\r\n");
    await vi.waitFor(() => expect(terminalRowsText()).toContain("build line"));
    menu.pick("copy");

    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("hello"));
    await screen.unmount();
  });

  it("adds to chat when output arrives while the menu is open", async () => {
    const menu = deferredMenu();
    const onAdd = vi.fn();
    nativeApiHolder.api = createNativeApiStub({
      history: "hello world\r\n",
      contextMenuShow: menu.show,
    });
    const screen = await renderDrawer(
      () => undefined,
      400,
      () => undefined,
      onAdd,
    );

    await selectFirstTerminalWord();
    await vi.waitFor(() => expect(menu.show).toHaveBeenCalled());
    recordTerminalOutput("build line\r\n");
    await vi.waitFor(() => expect(terminalRowsText()).toContain("build line"));
    menu.pick("add-to-chat");

    await vi.waitFor(() => expect(onAdd).toHaveBeenCalledTimes(1));
    expect(onAdd.mock.calls[0]?.[0]).toMatchObject({ text: "hello", lineStart: 1, lineEnd: 1 });
    await screen.unmount();
  });

  it("ignores Add to chat when the selected text changed while the menu was open", async () => {
    const terminals = captureTerminalInstances();
    const menu = deferredMenu();
    const onAdd = vi.fn();
    nativeApiHolder.api = createNativeApiStub({
      history: "hello world\r\n",
      contextMenuShow: menu.show,
    });
    const screen = await renderDrawer(
      () => undefined,
      400,
      () => undefined,
      onAdd,
    );

    await selectFirstTerminalWord();
    await vi.waitFor(() => expect(menu.show).toHaveBeenCalled());
    terminals.at(-1)?.select(6, 0, 5);
    menu.pick("add-to-chat");
    await settle();

    expect(onAdd).not.toHaveBeenCalled();
    await screen.unmount();
  });

  it("ignores the menu pick once the selection was cleared", async () => {
    const terminals = captureTerminalInstances();
    const menu = deferredMenu();
    nativeApiHolder.api = createNativeApiStub({
      history: "hello world\r\n",
      contextMenuShow: menu.show,
    });
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    const screen = await renderDrawer(() => undefined, 400);

    await selectFirstTerminalWord();
    await vi.waitFor(() => expect(menu.show).toHaveBeenCalled());
    terminals.at(-1)?.clearSelection();
    menu.pick("copy");
    await settle();

    expect(writeText).not.toHaveBeenCalled();
    await screen.unmount();
  });

  it("still opens the menu when output arrives during the multi-click delay", async () => {
    const show = vi.fn((_items: unknown, _position: unknown) =>
      Promise.resolve<string | null>(null),
    );
    nativeApiHolder.api = createNativeApiStub({
      history: "hello world\r\n",
      contextMenuShow: show,
    });
    const screen = await renderDrawer(() => undefined, 400);

    await selectFirstTerminalWord();
    recordTerminalOutput("build line\r\n");

    await vi.waitFor(() => expect(show).toHaveBeenCalled());
    await screen.unmount();
  });
});

function rightClick(): MouseEvent {
  const screenElement = document.querySelector<HTMLElement>(
    "aside.thread-terminal-drawer .xterm-screen",
  );
  if (!screenElement) throw new Error("xterm screen not rendered");
  const event = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    button: 2,
    clientX: 40,
    clientY: 40,
  });
  screenElement.dispatchEvent(event);
  return event;
}

/** Synchronous, so the popup is still pending when the caller's next line runs. */
function armSelectionPopup() {
  const screenElement = document.querySelector("aside.thread-terminal-drawer .xterm-screen");
  if (!screenElement) throw new Error("xterm screen not rendered");
  screenElement.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
  window.dispatchEvent(new MouseEvent("mouseup", { button: 0, detail: 2 }));
}

describe("ThreadTerminalDrawer right-click menu", () => {
  beforeEach(async () => {
    await page.viewport(1200, 1400);
  });

  afterEach(() => {
    nativeApiHolder.api = undefined;
    vi.restoreAllMocks();
  });

  async function renderWithMenu(history = "hello world\r\n") {
    const menu = deferredMenu();
    const api = createNativeApiStub({ history, contextMenuShow: menu.show });
    const write = vi.fn(() => Promise.resolve());
    api.terminal.write = write;
    nativeApiHolder.api = api;
    const screen = await renderDrawer(() => undefined, 400);
    await vi.waitFor(() => expect(terminalRowsText()).toContain("hello"));
    return { menu, write, screen };
  }

  it("replaces the native menu and disables selection actions without a selection", async () => {
    const { menu, screen } = await renderWithMenu();

    const event = rightClick();

    expect(event.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(menu.show).toHaveBeenCalled());
    expect(menu.show.mock.calls[0]?.[0]).toEqual([
      { id: "copy", label: "Copy", disabled: true },
      { id: "add-to-chat", label: "Add to chat", disabled: true },
      { id: "paste", label: "Paste" },
      { id: "select-all", label: "Select all" },
      { id: "scroll-to-bottom", label: "Jump to latest" },
    ]);
    expect(menu.show.mock.calls[0]?.[1]).toEqual({ x: 40, y: 40 });
    await screen.unmount();
  });

  it("leaves the right-click to an application that claimed the mouse", async () => {
    const terminals = captureTerminalInstances();
    const { menu, screen } = await renderWithMenu("hello world\r\n\u001b[?1000h");
    await vi.waitFor(() => expect(terminals.at(-1)?.modes.mouseTrackingMode).toBe("vt200"));

    const event = rightClick();

    expect(event.defaultPrevented).toBe(true);
    await settle();
    expect(menu.show).not.toHaveBeenCalled();

    const mount = document.querySelector("aside.thread-terminal-drawer .xterm")?.parentElement;
    if (!mount) throw new Error("terminal mount not rendered");
    mount.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 40,
        clientY: 40,
        shiftKey: true,
      }),
    );
    await vi.waitFor(() => expect(menu.show).toHaveBeenCalledTimes(1));
    await screen.unmount();
  });

  it("pastes the clipboard through xterm, skipping an empty clipboard", async () => {
    const { menu, write, screen } = await renderWithMenu();
    const readText = vi.spyOn(navigator.clipboard, "readText").mockResolvedValue("");

    rightClick();
    await vi.waitFor(() => expect(menu.show).toHaveBeenCalledTimes(1));
    menu.pick("paste");
    await vi.waitFor(() => expect(readText).toHaveBeenCalledTimes(1));
    await settle();
    expect(write).not.toHaveBeenCalled();

    readText.mockResolvedValue("echo pasted");
    rightClick();
    await vi.waitFor(() => expect(menu.show).toHaveBeenCalledTimes(2));
    menu.pick("paste");
    await vi.waitFor(() =>
      expect(write).toHaveBeenCalledWith(expect.objectContaining({ data: "echo pasted" })),
    );
    await screen.unmount();
  });

  it("reports an unreadable clipboard in the terminal", async () => {
    const { menu, screen } = await renderWithMenu();
    vi.spyOn(navigator.clipboard, "readText").mockRejectedValue(new Error("Clipboard denied"));

    rightClick();
    await vi.waitFor(() => expect(menu.show).toHaveBeenCalled());
    menu.pick("paste");

    await vi.waitFor(() => expect(terminalRowsText()).toContain("Clipboard denied"));
    await screen.unmount();
  });

  it("selects everything and jumps to the latest output", async () => {
    const terminals = captureTerminalInstances();
    const { menu, screen } = await renderWithMenu();
    const terminal = terminals.at(-1);
    if (!terminal) throw new Error("terminal not created");

    rightClick();
    await vi.waitFor(() => expect(menu.show).toHaveBeenCalledTimes(1));
    menu.pick("select-all");
    await vi.waitFor(() => expect(terminal.getSelection()).toContain("hello world"));

    const scrollToBottom = vi.spyOn(terminal, "scrollToBottom");
    rightClick();
    await vi.waitFor(() => expect(menu.show).toHaveBeenCalledTimes(2));
    menu.pick("scroll-to-bottom");
    await vi.waitFor(() => expect(scrollToBottom).toHaveBeenCalled());
    await screen.unmount();
  });

  // A loaded machine can let the double-click's popup open before the test's next line runs.
  async function selectWordAndDismissPopup(menu: ReturnType<typeof deferredMenu>) {
    await selectFirstTerminalWord();
    await vi.waitFor(() => expect(menu.show).toHaveBeenCalled());
    menu.pick(null);
    await settle();
    menu.show.mockClear();
  }

  it("supersedes the pending selection popup", async () => {
    const { menu, screen } = await renderWithMenu();
    await selectWordAndDismissPopup(menu);

    armSelectionPopup();
    rightClick();
    await vi.waitFor(() => expect(menu.show).toHaveBeenCalled());
    await settle(350);

    expect(menu.show).toHaveBeenCalledTimes(1);
    expect(menu.show.mock.calls[0]?.[0]).toHaveLength(5);
    await screen.unmount();
  });

  it("supersedes a popup whose timer fired and is waiting for a frame", async () => {
    const { menu, screen } = await renderWithMenu();
    await selectWordAndDismissPopup(menu);

    const frames: FrameRequestCallback[] = [];
    const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((frame) => {
      frames.push(frame);
      return frames.length;
    });
    armSelectionPopup();
    await settle(350);
    expect(frames.length).toBeGreaterThan(0);

    rightClick();
    await vi.waitFor(() => expect(menu.show).toHaveBeenCalled());
    requestFrame.mockRestore();
    for (const frame of frames) frame(performance.now());
    await settle();

    expect(menu.show).toHaveBeenCalledTimes(1);
    expect(menu.show.mock.calls[0]?.[0]).toHaveLength(5);
    await screen.unmount();
  });

  it("uses the captured selection for Copy", async () => {
    const { menu, screen } = await renderWithMenu();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);

    await selectWordAndDismissPopup(menu);
    rightClick();
    await vi.waitFor(() => expect(menu.show).toHaveBeenCalled());
    expect(menu.show.mock.calls[0]?.[0]).toContainEqual({
      id: "copy",
      label: "Copy",
      disabled: false,
    });
    menu.pick("copy");

    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("hello"));
    await screen.unmount();
  });
});

describe("ThreadTerminalDrawer OSC 8 hyperlinks", () => {
  beforeEach(async () => {
    await page.viewport(1200, 1400);
    Object.defineProperty(navigator, "platform", { value: "Linux x86_64", configurable: true });
  });

  afterEach(() => {
    nativeApiHolder.api = undefined;
    Reflect.deleteProperty(navigator, "platform");
    vi.restoreAllMocks();
  });

  async function renderWithLinkHandler() {
    const terminals = captureTerminalInstances();
    const openExternal = vi.fn((_url: string) => Promise.resolve());
    const openInEditor = vi.fn((_path: string, _editor: string) => Promise.resolve());
    const stub = createNativeApiStub({});
    nativeApiHolder.api = {
      ...stub,
      shell: { openExternal, openInEditor },
      server: { getConfig: () => Promise.resolve({ availableEditors: ["cursor"] }) },
    };
    const screen = await renderDrawer(() => undefined, 400);
    await vi.waitFor(() => expect(terminals.at(-1)?.options.linkHandler).toBeTruthy());
    const handler = terminals.at(-1)?.options.linkHandler;
    if (!handler) throw new Error("link handler not installed");
    return { handler, openExternal, openInEditor, screen };
  }

  const range = { start: { x: 1, y: 1 }, end: { x: 5, y: 1 } };

  it("needs the modifier, then opens web links externally", async () => {
    const { handler, openExternal, screen } = await renderWithLinkHandler();
    expect(handler.allowNonHttpProtocols).toBe(true);

    handler.activate(new MouseEvent("click"), "https://example.com/a", range);
    expect(openExternal).not.toHaveBeenCalled();

    handler.activate(new MouseEvent("click", { ctrlKey: true }), "https://example.com/a", range);
    expect(openExternal).toHaveBeenCalledWith("https://example.com/a");
    await screen.unmount();
  });

  it("shows the real target while a link is hovered, and clears it on leave and unmount", async () => {
    const { handler, screen } = await renderWithLinkHandler();
    const mount = document.querySelector<HTMLElement>(
      "aside.thread-terminal-drawer .xterm",
    )?.parentElement;
    if (!mount) throw new Error("terminal mount not rendered");

    handler.hover?.(new MouseEvent("mouseover"), "https://other.example/x", range);
    expect(mount.title).toBe("https://other.example/x");
    handler.leave?.(new MouseEvent("mouseout"), "https://other.example/x", range);
    expect(mount.hasAttribute("title")).toBe(false);

    handler.hover?.(new MouseEvent("mouseover"), "file:///repo/a.ts", range);
    expect(mount.title).toBe("file:///repo/a.ts");
    await screen.unmount();
    expect(mount.hasAttribute("title")).toBe(false);
  });

  it("opens file links in the editor and ignores other schemes", async () => {
    const { handler, openExternal, openInEditor, screen } = await renderWithLinkHandler();

    handler.activate(new MouseEvent("click", { ctrlKey: true }), "file://host/repo/a.ts", range);
    await vi.waitFor(() => expect(openInEditor).toHaveBeenCalled());
    expect(openInEditor.mock.calls[0]?.[0]).toBe("/repo/a.ts");

    handler.activate(new MouseEvent("click", { ctrlKey: true }), "ssh://host/x", range);
    await settle();
    expect(openExternal).not.toHaveBeenCalled();
    expect(openInEditor).toHaveBeenCalledTimes(1);
    await screen.unmount();
  });
});

function snapshotFor(
  input: { threadId: string; terminalId: string; cwd: string },
  overrides: { status?: string; history?: string; sequence?: number } = {},
) {
  return {
    threadId: input.threadId,
    terminalId: input.terminalId,
    cwd: input.cwd,
    status: "running",
    pid: 123,
    history: "",
    exitCode: null,
    exitSignal: null,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("ThreadTerminalDrawer resync", () => {
  beforeEach(async () => {
    await page.viewport(1200, 1400);
  });

  afterEach(() => {
    nativeApiHolder.api = undefined;
    vi.restoreAllMocks();
  });

  type OpenInput = { threadId: string; terminalId: string; cwd: string; resume?: boolean };

  async function renderWithOpen(
    resumeResult: (input: OpenInput) => Promise<unknown>,
    onClose: (terminalId: string) => void = () => undefined,
  ) {
    const terminals = captureTerminalInstances();
    const open = vi.fn((input: OpenInput) =>
      input.resume
        ? resumeResult(input)
        : Promise.resolve(snapshotFor(input, { history: "before\r\n" })),
    );
    const stub = createNativeApiStub({});
    nativeApiHolder.api = { ...stub, terminal: { ...stub.terminal, open } };
    const screen = await renderDrawer(() => undefined, 400, onClose);
    await vi.waitFor(() => expect(terminalRowsText()).toContain("before"));
    return { open, screen, terminals };
  }

  const bumpResync = () => useTerminalStateStore.getState().bumpTerminalResyncEpoch();

  it("reopens with resume once per burst and keeps the terminal instance", async () => {
    const { open, screen, terminals } = await renderWithOpen((input) =>
      Promise.resolve(snapshotFor(input, { history: "after\r\n" })),
    );
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0]?.[0].resume).toBeUndefined();
    const terminal = terminals.at(-1);
    const dispose = terminal ? vi.spyOn(terminal, "dispose") : null;

    bumpResync();
    bumpResync();
    await vi.waitFor(() => expect(terminalRowsText()).toContain("after"));

    expect(open).toHaveBeenCalledTimes(2);
    expect(open.mock.calls[1]?.[0].resume).toBe(true);
    expect(terminalRowsText()).not.toContain("before");
    expect(terminals.at(-1)).toBe(terminal);
    expect(dispose).not.toHaveBeenCalled();
    await screen.unmount();
  });

  it("keeps the last real size when a hidden viewport resumes", async () => {
    const { open, screen, terminals } = await renderWithOpen((input) =>
      Promise.resolve(snapshotFor(input, { history: "after\r\n" })),
    );
    await settle(60);
    const terminal = terminals.at(-1);
    if (!terminal) throw new Error("terminal not created");
    const { cols, rows } = terminal;
    const wrapper = document.querySelector("aside.thread-terminal-drawer")?.parentElement;
    if (!wrapper) throw new Error("drawer wrapper not rendered");
    wrapper.style.display = "none";

    bumpResync();
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(2));

    expect(open.mock.calls[1]?.[0]).toMatchObject({ resume: true, cols, rows });
    expect(terminal.cols).toBe(cols);
    expect(terminal.rows).toBe(rows);
    await screen.unmount();
  });

  it("drops a late output event the snapshot already holds", async () => {
    const { screen } = await renderWithOpen((input) =>
      Promise.resolve(snapshotFor(input, { history: "resumed\r\n", sequence: 10 })),
    );

    bumpResync();
    await vi.waitFor(() => expect(terminalRowsText()).toContain("resumed"));

    recordTerminalOutput("inSnapshotChunk\r\n", 10);
    recordTerminalOutput("freshChunk\r\n", 11);
    await vi.waitFor(() => expect(terminalRowsText()).toContain("freshChunk"));
    expect(terminalRowsText()).not.toContain("inSnapshotChunk");
    await screen.unmount();
  });

  it("does not reopen without a resync", async () => {
    const { open, screen } = await renderWithOpen((input) => Promise.resolve(snapshotFor(input)));
    recordTerminalOutput("more\r\n");
    await settle(250);
    expect(open).toHaveBeenCalledTimes(1);
    await screen.unmount();
  });

  it("closes the tab when the session exited while disconnected", async () => {
    const onClose = vi.fn();
    const { screen } = await renderWithOpen(
      (input) => Promise.resolve(snapshotFor(input, { status: "exited" })),
      onClose,
    );

    bumpResync();

    await vi.waitFor(() => expect(onClose).toHaveBeenCalledWith("default"));
    await screen.unmount();
  });

  it("keeps a tab whose shell failed to start and says so", async () => {
    const onClose = vi.fn();
    const { screen } = await renderWithOpen(
      (input) => Promise.resolve(snapshotFor(input, { status: "error", sequence: 20 })),
      onClose,
    );

    bumpResync();

    await vi.waitFor(() => expect(terminalRowsText()).toContain("Terminal failed to start"));
    await settle();
    expect(onClose).not.toHaveBeenCalled();
    await screen.unmount();
  });

  it("shows the buffered start error instead of a generic one", async () => {
    const onClose = vi.fn();
    const { screen } = await renderWithOpen(
      (input) => Promise.resolve(snapshotFor(input, { status: "error", sequence: 30 })),
      onClose,
    );

    useTerminalStateStore.getState().recordTerminalEvent({
      type: "error",
      threadId: THREAD_ID,
      terminalId: "default",
      createdAt: new Date(Date.now() + 1_000).toISOString(),
      message: "spawn zsh ENOENT",
      sequence: 31,
    });
    bumpResync();

    await vi.waitFor(() => expect(terminalRowsText()).toContain("spawn zsh ENOENT"));
    expect(terminalRowsText()).not.toContain("Terminal failed to start");
    await settle();
    expect(onClose).not.toHaveBeenCalled();
    await screen.unmount();
  });

  it("closes the tab when the terminal was closed while disconnected", async () => {
    const onClose = vi.fn();
    const { screen } = await renderWithOpen(
      () =>
        Promise.reject(Object.assign(new Error("gone"), { _tag: "TerminalSessionLookupError" })),
      onClose,
    );

    bumpResync();

    await vi.waitFor(() => expect(onClose).toHaveBeenCalledWith("default"));
    await screen.unmount();
  });

  it("reports other resume failures and keeps the tab", async () => {
    const onClose = vi.fn();
    const { screen } = await renderWithOpen(() => Promise.reject(new Error("Boom")), onClose);

    bumpResync();

    await vi.waitFor(() => expect(terminalRowsText()).toContain("Boom"));
    expect(onClose).not.toHaveBeenCalled();
    await screen.unmount();
  });
});
