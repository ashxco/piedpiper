import type { ResolvedKeybindingsConfig } from "@piedpiper/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  handleTerminalCustomKeyEvent,
  isTerminalEventInSnapshot,
  isTerminalRightClickClaimedByApplication,
  isTerminalSessionGoneError,
  resolveTerminalSelectionActionPosition,
  selectPendingTerminalEventEntries,
  selectTerminalEventEntriesAfterSnapshot,
  shouldHandleTerminalSelectionMouseUp,
  terminalContextMenuItems,
  terminalSelectionActionDelayForClickCount,
  terminalSelectionMenuItems,
  type TerminalBufferTarget,
} from "./terminalViewportHelpers";
import {
  normalizePreferredDrawerHeight,
  resolveRenderedDrawerHeight,
  resolveTerminalDrawerMaxHeight,
  terminalGroupHeader,
  terminalGroupHeaderAccessibleName,
} from "./ThreadTerminalDrawer";

const sequencedOutput = (id: number, createdAt: string, sequence?: number) => ({
  id,
  event: {
    threadId: "thread-1",
    terminalId: "default",
    createdAt,
    type: "output" as const,
    data: `chunk-${id}`,
    ...(sequence === undefined ? {} : { sequence }),
  },
});
const SNAPSHOT_STAMP = "2026-04-02T20:00:00.500Z";
const entryIds = (entries: ReadonlyArray<{ id: number }>) => entries.map((entry) => entry.id);

describe("resolveTerminalDrawerMaxHeight", () => {
  it("keeps the window cap outside a chat column", () => {
    expect(resolveTerminalDrawerMaxHeight({ viewportHeight: 800 })).toBe(600);
    expect(resolveTerminalDrawerMaxHeight({ viewportHeight: 200 })).toBe(180);
  });

  it("leaves room for the header and composer in a short window", () => {
    const maxHeight = resolveTerminalDrawerMaxHeight({
      viewportHeight: 480,
      chatColumnHeight: 480,
      headerHeight: 52,
      composerHeight: 180,
    });
    expect(maxHeight).toBe(248);
    expect(resolveRenderedDrawerHeight(900, maxHeight)).toBe(248);
  });

  it("uses the smaller of the window cap and the free space", () => {
    expect(
      resolveTerminalDrawerMaxHeight({
        viewportHeight: 1000,
        chatColumnHeight: 1000,
        headerHeight: 52,
        composerHeight: 100,
      }),
    ).toBe(750);
  });

  it("keeps a usable floor when the controls fill the column", () => {
    expect(
      resolveTerminalDrawerMaxHeight({
        viewportHeight: 300,
        chatColumnHeight: 300,
        headerHeight: 52,
        composerHeight: 400,
      }),
    ).toBe(120);
  });
});

describe("terminalGroupHeader", () => {
  it("names the layout of each group and never a number", () => {
    const headers = [
      { id: "group-a", terminalIds: ["a", "b"] },
      { id: "group-c", terminalIds: ["c"] },
      { id: "group-d", terminalIds: ["d", "e", "f"], splitDirection: "vertical" as const },
      { id: "group-g", terminalIds: ["g"], splitDirection: "vertical" as const },
    ].map(terminalGroupHeader);
    expect(headers.map(({ label, count }) => [label, count])).toEqual([
      ["Side by side", 2],
      ["Single", 1],
      ["Stacked", 3],
      ["Single", 1],
    ]);
  });
});

describe("resolveTerminalSelectionActionPosition", () => {
  it("prefers the selection rect over the last pointer position", () => {
    expect(
      resolveTerminalSelectionActionPosition({
        bounds: { left: 100, top: 50, width: 500, height: 220 },
        selectionRect: { right: 260, bottom: 140 },
        pointer: { x: 520, y: 200 },
        viewport: { width: 1024, height: 768 },
      }),
    ).toEqual({
      x: 260,
      y: 144,
    });
  });

  it("falls back to the pointer position when no selection rect is available", () => {
    expect(
      resolveTerminalSelectionActionPosition({
        bounds: { left: 100, top: 50, width: 500, height: 220 },
        selectionRect: null,
        pointer: { x: 180, y: 130 },
        viewport: { width: 1024, height: 768 },
      }),
    ).toEqual({
      x: 180,
      y: 130,
    });
  });

  it("clamps the pointer fallback into the terminal drawer bounds", () => {
    expect(
      resolveTerminalSelectionActionPosition({
        bounds: { left: 100, top: 50, width: 500, height: 220 },
        selectionRect: null,
        pointer: { x: 720, y: 340 },
        viewport: { width: 1024, height: 768 },
      }),
    ).toEqual({
      x: 600,
      y: 270,
    });

    expect(
      resolveTerminalSelectionActionPosition({
        bounds: { left: 100, top: 50, width: 500, height: 220 },
        selectionRect: null,
        pointer: { x: 40, y: 20 },
        viewport: { width: 1024, height: 768 },
      }),
    ).toEqual({
      x: 100,
      y: 50,
    });
  });

  it("delays multi-click selection actions so triple-click selection can complete", () => {
    expect(terminalSelectionActionDelayForClickCount(1)).toBe(0);
    expect(terminalSelectionActionDelayForClickCount(2)).toBe(260);
    expect(terminalSelectionActionDelayForClickCount(3)).toBe(260);
  });

  it("only handles mouseup when the selection gesture started in the terminal", () => {
    expect(shouldHandleTerminalSelectionMouseUp(true, 0)).toBe(true);
    expect(shouldHandleTerminalSelectionMouseUp(false, 0)).toBe(false);
    expect(shouldHandleTerminalSelectionMouseUp(true, 1)).toBe(false);
  });

  it("treats an event as held by the snapshot only when both sequences say so", () => {
    const output = (sequence?: number) =>
      sequencedOutput(1, "2026-04-02T20:00:00.000Z", sequence).event;
    expect(isTerminalEventInSnapshot(output(9), 10)).toBe(true);
    expect(isTerminalEventInSnapshot(output(10), 10)).toBe(true);
    expect(isTerminalEventInSnapshot(output(11), 10)).toBe(false);
    expect(isTerminalEventInSnapshot(output(), 10)).toBe(false);
    expect(isTerminalEventInSnapshot(output(9), undefined)).toBe(false);
  });

  it.each([
    { mode: "none", modifier: {}, claimed: false },
    { mode: "vt200", modifier: {}, claimed: true },
    { mode: "any", modifier: {}, claimed: true },
    { mode: "vt200", modifier: { shiftKey: true }, claimed: false },
    { mode: "vt200", modifier: { ctrlKey: true }, claimed: false },
    { mode: "vt200", modifier: { metaKey: true }, claimed: false },
  ])(
    "right-click in mouse mode $mode with $modifier: claimed is $claimed",
    ({ mode, modifier, claimed }) => {
      expect(
        isTerminalRightClickClaimedByApplication(mode, {
          shiftKey: false,
          ctrlKey: false,
          metaKey: false,
          ...modifier,
        }),
      ).toBe(claimed);
    },
  );

  it("names group headers by the terminals they hold", () => {
    expect(terminalGroupHeaderAccessibleName({ label: "Single", count: 1 }, ["Terminal 3"])).toBe(
      "Single group, 1 terminal: Terminal 3",
    );
    expect(
      terminalGroupHeaderAccessibleName({ label: "Stacked", count: 2 }, [
        "Terminal 1",
        "Terminal 2",
      ]),
    ).toBe("Stacked group, 2 terminals: Terminal 1, Terminal 2");
  });

  it("replays only terminal events newer than the open snapshot", () => {
    expect(
      selectTerminalEventEntriesAfterSnapshot(
        [
          {
            id: 1,
            event: {
              threadId: "thread-1",
              terminalId: "default",
              createdAt: "2026-04-02T20:00:00.000Z",
              type: "output",
              data: "before",
            },
          },
          {
            id: 2,
            event: {
              threadId: "thread-1",
              terminalId: "default",
              createdAt: "2026-04-02T20:00:01.000Z",
              type: "output",
              data: "after",
            },
          },
        ],
        "2026-04-02T20:00:00.500Z",
      ).map((entry) => entry.id),
    ).toEqual([2]);
  });

  describe("with sequences", () => {
    it("does not replay a chunk already in the snapshot even with a newer timestamp", () => {
      expect(
        entryIds(
          selectTerminalEventEntriesAfterSnapshot(
            [sequencedOutput(1, "2026-04-02T20:00:00.600Z", 41)],
            SNAPSHOT_STAMP,
            41,
          ),
        ),
      ).toEqual([]);
    });

    it("replays a newer chunk stamped the same as the snapshot", () => {
      expect(
        entryIds(
          selectTerminalEventEntriesAfterSnapshot(
            [sequencedOutput(1, SNAPSHOT_STAMP, 42)],
            SNAPSHOT_STAMP,
            41,
          ),
        ),
      ).toEqual([1]);
    });

    it("falls back to timestamps when either side has no sequence", () => {
      const entries = [
        sequencedOutput(1, "2026-04-02T20:00:00.000Z"),
        sequencedOutput(2, "2026-04-02T20:00:01.000Z"),
      ];
      expect(
        entryIds(selectTerminalEventEntriesAfterSnapshot(entries, SNAPSHOT_STAMP, 41)),
      ).toEqual([2]);
      expect(
        entryIds(
          selectTerminalEventEntriesAfterSnapshot(
            [
              sequencedOutput(1, "2026-04-02T20:00:00.000Z", 40),
              sequencedOutput(2, "2026-04-02T20:00:01.000Z", 41),
            ],
            SNAPSHOT_STAMP,
          ),
        ),
      ).toEqual([2]);
    });

    it("does not replay a buffered event from an older session", () => {
      expect(
        entryIds(
          selectTerminalEventEntriesAfterSnapshot(
            [
              sequencedOutput(1, "2026-04-02T20:00:09.000Z", 1_000),
              sequencedOutput(2, SNAPSHOT_STAMP, 5_001),
            ],
            SNAPSHOT_STAMP,
            5_000,
          ),
        ),
      ).toEqual([2]);
    });
  });

  it("applies only terminal events that have not already been consumed", () => {
    expect(
      selectPendingTerminalEventEntries(
        [
          {
            id: 1,
            event: {
              threadId: "thread-1",
              terminalId: "default",
              createdAt: "2026-04-02T20:00:00.000Z",
              type: "output",
              data: "one",
            },
          },
          {
            id: 2,
            event: {
              threadId: "thread-1",
              terminalId: "default",
              createdAt: "2026-04-02T20:00:01.000Z",
              type: "output",
              data: "two",
            },
          },
        ],
        1,
      ).map((entry) => entry.id),
    ).toEqual([2]);
  });
});

describe("handleTerminalCustomKeyEvent", () => {
  const modShortcut = (key: string, shiftKey = false) => ({
    key,
    metaKey: false,
    ctrlKey: false,
    shiftKey,
    altKey: false,
    modKey: true,
  });
  const keybindings: ResolvedKeybindingsConfig = [
    { command: "terminal.toggle", shortcut: modShortcut("j") },
    {
      command: "terminal.close",
      shortcut: modShortcut("w"),
      whenAst: { type: "identifier", name: "terminalFocus" },
    },
  ];

  function keyEvent(overrides: {
    type?: string;
    key: string;
    metaKey?: boolean;
    ctrlKey?: boolean;
    shiftKey?: boolean;
    repeat?: boolean;
  }) {
    return {
      type: "keydown",
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      ...overrides,
    };
  }

  it("hands app shortcuts back to the page without sending terminal input", () => {
    for (const key of ["j", "w"]) {
      const sendInput = vi.fn();
      const event = keyEvent({ key, metaKey: true });
      expect(handleTerminalCustomKeyEvent(event, keybindings, sendInput, "MacIntel")).toBe(false);
      expect(sendInput).not.toHaveBeenCalled();
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(event.stopPropagation).not.toHaveBeenCalled();
    }
  });

  it("swallows auto-repeated close shortcuts so a held Cmd+W cannot cascade", () => {
    const sendInput = vi.fn();
    const event = keyEvent({ key: "w", metaKey: true, repeat: true });
    expect(handleTerminalCustomKeyEvent(event, keybindings, sendInput, "MacIntel")).toBe(false);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
    expect(sendInput).not.toHaveBeenCalled();
  });

  it("leaves Ctrl+Arrow to xterm on Linux", () => {
    const sendInput = vi.fn();
    const event = keyEvent({ key: "ArrowLeft", ctrlKey: true });
    expect(handleTerminalCustomKeyEvent(event, keybindings, sendInput, "Linux")).toBe(true);
    expect(sendInput).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("lets xterm handle plain keys", () => {
    const sendInput = vi.fn();
    expect(
      handleTerminalCustomKeyEvent(keyEvent({ key: "a" }), keybindings, sendInput, "MacIntel"),
    ).toBe(true);
    expect(sendInput).not.toHaveBeenCalled();
  });

  function selectionTarget(initialSelection: string, copied = true) {
    let current = initialSelection;
    const target = {
      hasSelection: vi.fn(() => current.length > 0),
      getSelection: vi.fn(() => current),
      clearSelection: vi.fn(() => {
        current = "";
      }),
      copyText: vi.fn(async (_text: string) => copied),
    };
    return target;
  }

  it("copies the selection with Ctrl+C on Linux and clears it so the next Ctrl+C interrupts", async () => {
    const sendInput = vi.fn();
    const target = selectionTarget("npm run dev");
    const event = keyEvent({ key: "c", ctrlKey: true });
    expect(handleTerminalCustomKeyEvent(event, keybindings, sendInput, "Linux", target)).toBe(
      false,
    );
    expect(event.preventDefault).toHaveBeenCalled();
    expect(target.copyText).toHaveBeenCalledWith("npm run dev");
    await vi.waitFor(() => expect(target.clearSelection).toHaveBeenCalled());

    const interrupt = keyEvent({ key: "c", ctrlKey: true });
    expect(handleTerminalCustomKeyEvent(interrupt, keybindings, sendInput, "Linux", target)).toBe(
      true,
    );
    expect(interrupt.preventDefault).not.toHaveBeenCalled();
    expect(target.copyText).toHaveBeenCalledTimes(1);
  });

  it("copies without clearing for Ctrl+Shift+C and Ctrl+Insert", async () => {
    for (const overrides of [
      { key: "C", ctrlKey: true, shiftKey: true },
      { key: "Insert", ctrlKey: true },
    ]) {
      const target = selectionTarget("output");
      expect(
        handleTerminalCustomKeyEvent(keyEvent(overrides), keybindings, vi.fn(), "Win32", target),
      ).toBe(false);
      expect(target.copyText).toHaveBeenCalledWith("output");
      await Promise.resolve();
      await Promise.resolve();
      expect(target.clearSelection).not.toHaveBeenCalled();
    }
  });

  it("clears the selection after a failed plain Ctrl+C copy so the next one interrupts", async () => {
    const failing = selectionTarget("output", false);
    handleTerminalCustomKeyEvent(
      keyEvent({ key: "c", ctrlKey: true }),
      keybindings,
      vi.fn(),
      "Linux",
      failing,
    );
    await vi.waitFor(() => expect(failing.clearSelection).toHaveBeenCalled());
    const interrupt = keyEvent({ key: "c", ctrlKey: true });
    expect(handleTerminalCustomKeyEvent(interrupt, keybindings, vi.fn(), "Linux", failing)).toBe(
      true,
    );
    expect(failing.copyText).toHaveBeenCalledTimes(1);
  });

  it("keeps the selection when a Ctrl+Shift+C copy fails", async () => {
    const failing = selectionTarget("output", false);
    handleTerminalCustomKeyEvent(
      keyEvent({ key: "C", ctrlKey: true, shiftKey: true }),
      keybindings,
      vi.fn(),
      "Linux",
      failing,
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(failing.clearSelection).not.toHaveBeenCalled();
  });

  it("ignores keyup and macOS for the copy shortcut", async () => {
    const target = selectionTarget("output");
    expect(
      handleTerminalCustomKeyEvent(
        keyEvent({ type: "keyup", key: "c", ctrlKey: true }),
        keybindings,
        vi.fn(),
        "Linux",
        target,
      ),
    ).toBe(true);
    expect(
      handleTerminalCustomKeyEvent(
        keyEvent({ key: "c", ctrlKey: true }),
        keybindings,
        vi.fn(),
        "MacIntel",
        target,
      ),
    ).toBe(true);
    expect(target.copyText).not.toHaveBeenCalled();
  });

  it("sends delete-to-line-start and clear sequences for terminal-owned shortcuts", () => {
    const sendInput = vi.fn();
    const deleteEvent = keyEvent({ key: "Backspace", metaKey: true });
    expect(handleTerminalCustomKeyEvent(deleteEvent, keybindings, sendInput, "MacIntel")).toBe(
      false,
    );
    expect(deleteEvent.preventDefault).toHaveBeenCalled();
    expect(sendInput).toHaveBeenLastCalledWith("\u0015", "Failed to delete terminal input");

    expect(
      handleTerminalCustomKeyEvent(
        keyEvent({ key: "l", ctrlKey: true }),
        keybindings,
        sendInput,
        "Linux",
      ),
    ).toBe(false);
    expect(sendInput).toHaveBeenLastCalledWith("\u000c", "Failed to clear terminal");
  });
});

describe("terminal drawer height", () => {
  it("keeps the stored preference above the window cap and only caps the rendered height", () => {
    expect(normalizePreferredDrawerHeight(900)).toBe(900);
    expect(resolveRenderedDrawerHeight(900, 450)).toBe(450);
    expect(resolveRenderedDrawerHeight(900, 1200)).toBe(900);
  });

  it("normalizes invalid or too-small stored heights", () => {
    expect(normalizePreferredDrawerHeight(Number.NaN)).toBeGreaterThanOrEqual(180);
    expect(normalizePreferredDrawerHeight(20)).toBe(180);
    expect(normalizePreferredDrawerHeight(300.6)).toBe(301);
  });
});

describe("terminal menus", () => {
  it("offers only the selection actions in the post-selection popup", () => {
    expect(terminalSelectionMenuItems().map((item) => item.id)).toEqual(["copy", "add-to-chat"]);
  });

  it("disables the selection actions in the right-click menu without a selection", () => {
    const disabledIds = (hasSelection: boolean) =>
      terminalContextMenuItems({ hasSelection })
        .filter((item) => item.disabled === true)
        .map((item) => item.id);
    expect(disabledIds(false)).toEqual(["copy", "add-to-chat"]);
    expect(disabledIds(true)).toEqual([]);
    expect(terminalContextMenuItems({ hasSelection: false }).map((item) => item.id)).toEqual([
      "copy",
      "add-to-chat",
      "paste",
      "select-all",
      "scroll-to-bottom",
    ]);
  });
});

describe("isTerminalSessionGoneError", () => {
  it("only matches the lookup error a closed terminal resumes into", () => {
    expect(isTerminalSessionGoneError({ _tag: "TerminalSessionLookupError" })).toBe(true);
    expect(isTerminalSessionGoneError({ _tag: "TerminalCwdError" })).toBe(false);
    expect(isTerminalSessionGoneError(new Error("Transport disposed"))).toBe(false);
    expect(isTerminalSessionGoneError(null)).toBe(false);
  });
});

describe("handleTerminalCustomKeyEvent buffer shortcuts", () => {
  function setup(platform: string, alternateScreen = false) {
    const buffer: TerminalBufferTarget = {
      isAlternateScreen: () => alternateScreen,
      selectAll: vi.fn(),
      scrollToTop: vi.fn(),
      scrollToBottom: vi.fn(),
    };
    const press = (overrides: {
      key: string;
      metaKey?: boolean;
      ctrlKey?: boolean;
      shiftKey?: boolean;
    }) =>
      handleTerminalCustomKeyEvent(
        {
          type: "keydown",
          metaKey: false,
          ctrlKey: false,
          shiftKey: false,
          altKey: false,
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
          ...overrides,
        },
        [],
        vi.fn(),
        platform,
        undefined,
        buffer,
      );
    return { buffer, press };
  }

  it("selects all with Ctrl+Shift+A on Linux and leaves Ctrl+A to the shell", () => {
    const { buffer, press } = setup("Linux x86_64");
    expect(press({ key: "A", ctrlKey: true, shiftKey: true })).toBe(false);
    expect(buffer.selectAll).toHaveBeenCalledTimes(1);
    expect(press({ key: "a", ctrlKey: true })).toBe(true);
    expect(buffer.selectAll).toHaveBeenCalledTimes(1);
  });

  it("leaves Cmd+A to xterm on macOS", () => {
    const { buffer, press } = setup("MacIntel");
    expect(press({ key: "a", metaKey: true })).toBe(true);
    expect(buffer.selectAll).not.toHaveBeenCalled();
  });

  it("jumps through scrollback with the platform modifier", () => {
    const mac = setup("MacIntel");
    expect(mac.press({ key: "Home", metaKey: true, shiftKey: true })).toBe(false);
    expect(mac.buffer.scrollToTop).toHaveBeenCalledTimes(1);
    expect(mac.press({ key: "End", metaKey: true, shiftKey: true })).toBe(false);
    expect(mac.buffer.scrollToBottom).toHaveBeenCalledTimes(1);

    const windows = setup("Win32");
    expect(windows.press({ key: "End", ctrlKey: true, shiftKey: true })).toBe(false);
    expect(windows.buffer.scrollToBottom).toHaveBeenCalledTimes(1);
  });

  it("passes the jumps through in the alternate screen but still selects all", () => {
    const { buffer, press } = setup("Linux x86_64", true);
    expect(press({ key: "Home", ctrlKey: true, shiftKey: true })).toBe(true);
    expect(press({ key: "End", ctrlKey: true, shiftKey: true })).toBe(true);
    expect(buffer.scrollToTop).not.toHaveBeenCalled();
    expect(buffer.scrollToBottom).not.toHaveBeenCalled();
    expect(press({ key: "A", ctrlKey: true, shiftKey: true })).toBe(false);
    expect(buffer.selectAll).toHaveBeenCalledTimes(1);
  });
});
