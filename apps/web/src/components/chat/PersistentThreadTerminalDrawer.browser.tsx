import type { ThreadId } from "@piedpiper/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const nativeApiHolder = vi.hoisted(() => ({ api: undefined as unknown }));
vi.mock("~/nativeApi", () => ({ readNativeApi: () => nativeApiHolder.api }));
vi.mock("~/storeSelectors", () => ({
  useThreadById: () => ({ projectId: "project-1", worktreePath: null }),
  useProjectById: () => ({ cwd: "/repo" }),
}));
vi.mock("~/components/ThreadTerminalDrawer", () => ({
  default: (props: { onNewTerminal: () => void; onCloseTerminal: (id: string) => void }) => (
    <div>
      <button type="button" data-testid="new" onClick={props.onNewTerminal} />
      <button type="button" data-testid="close" onClick={() => props.onCloseTerminal("term-2")} />
    </div>
  ),
}));

import { selectThreadTerminalState, useTerminalStateStore } from "../../terminalStateStore";
import { useTerminalTabStateStore } from "../../terminalTabStateStore";
import { PersistentThreadTerminalDrawer } from "./PersistentThreadTerminalDrawer";

const THREAD_ID = "thread-persistent-drawer-test" as ThreadId;

const terminalIds = () =>
  selectThreadTerminalState(useTerminalStateStore.getState().terminalStateByThreadId, THREAD_ID)
    .terminalIds;
const closingIds = () =>
  useTerminalTabStateStore.getState().closingTerminalIdsByThreadId[THREAD_ID];
const clickTestId = (id: string) =>
  document.querySelector<HTMLElement>(`[data-testid="${id}"]`)?.click();

const renderDrawer = () =>
  render(
    <PersistentThreadTerminalDrawer
      threadId={THREAD_ID}
      visible
      focusRequestId={0}
      splitShortcutLabel={undefined}
      splitVerticalShortcutLabel={undefined}
      newShortcutLabel={undefined}
      closeShortcutLabel={undefined}
      onAddTerminalContext={() => undefined}
    />,
  );

describe("PersistentThreadTerminalDrawer terminal ids", () => {
  beforeEach(() => {
    useTerminalStateStore.getState().removeTerminalState(THREAD_ID);
    useTerminalStateStore.getState().setTerminalOpen(THREAD_ID, true);
    useTerminalTabStateStore.setState({ closingTerminalIdsByThreadId: {} });
  });

  afterEach(() => {
    nativeApiHolder.api = undefined;
    useTerminalStateStore.getState().removeTerminalState(THREAD_ID);
    useTerminalTabStateStore.setState({ closingTerminalIdsByThreadId: {} });
  });

  it("numbers new terminals with the lowest free id", async () => {
    const screen = await renderDrawer();
    clickTestId("new");
    clickTestId("new");
    expect(terminalIds()).toEqual(["default", "term-2", "term-3"]);
    await screen.unmount();
  });

  it("reserves a closing id until the server has closed it", async () => {
    let finishClose: (() => void) | undefined;
    nativeApiHolder.api = {
      terminal: {
        close: () => new Promise<void>((resolve) => (finishClose = resolve)),
        write: () => Promise.resolve(),
        clear: () => Promise.resolve(),
      },
    };
    const screen = await renderDrawer();
    clickTestId("new");
    clickTestId("close");
    expect(closingIds()).toEqual(["term-2"]);

    clickTestId("new");
    expect(terminalIds()).toEqual(["default", "term-3"]);

    await vi.waitFor(() => expect(finishClose).toBeDefined());
    finishClose?.();
    await vi.waitFor(() => expect(closingIds()).toBeUndefined());
    clickTestId("new");
    expect(terminalIds()).toEqual(["default", "term-3", "term-2"]);
    await screen.unmount();
  });

  it("releases the id after the exit fallback when close fails", async () => {
    const write = vi.fn(() => Promise.resolve());
    nativeApiHolder.api = {
      terminal: { close: () => Promise.reject(new Error("gone")), write },
    };
    const screen = await renderDrawer();
    clickTestId("new");
    clickTestId("close");
    await vi.waitFor(() => expect(closingIds()).toBeUndefined());
    expect(write).toHaveBeenCalledWith({
      threadId: THREAD_ID,
      terminalId: "term-2",
      data: "exit\n",
    });
    await screen.unmount();
  });
});
