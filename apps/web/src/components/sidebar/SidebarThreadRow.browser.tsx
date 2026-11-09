import "../../index.css";

import type { GitStatusResult, NativeApi, ProjectId, ThreadId } from "@piedpiper/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Profiler, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { invalidateGitStatusQuery } from "../../lib/gitReactQuery";
import { __resetNativeApiForTests } from "../../nativeApi";
import { useStore } from "../../store";
import { selectThreadTerminalState, useTerminalStateStore } from "../../terminalStateStore";
import { useThreadSelectionStore } from "../../threadSelectionStore";
import {
  beginThreadTitleRegeneration,
  clearThreadTitleRegenerations,
} from "../../threadTitleRegenerationStore";
import { useUiStateStore } from "../../uiStateStore";
import { SidebarProvider } from "../ui/sidebar";
import type { SidebarThreadSummary, Thread } from "../../types";
import { reconcileThreadSnoozes } from "../Sidebar.snooze";
import { undoLatestThreadAction } from "./threadUndo";
import { SidebarThreadRow, type SidebarThreadRowProps } from "./SidebarThreadRow";

const THREAD_ID = "thread-rename-test" as ThreadId;

function makeSummary(title: string, branch: string | null = null): SidebarThreadSummary {
  return {
    id: THREAD_ID,
    projectId: "project-1" as ProjectId,
    title,
    interactionMode: "default",
    session: null,
    createdAt: "2026-03-04T12:00:00.000Z",
    archivedAt: null,
    latestTurn: null,
    branch,
    worktreePath: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

function setThreadTitle(title: string) {
  useStore.setState({ sidebarThreadsById: { [THREAD_ID]: makeSummary(title) } });
}

const noop = () => {};
const noopAsync = async () => {};

function Harness(props: {
  commitRename: SidebarThreadRowProps["commitRename"];
  renamingThreadId?: ThreadId | null;
  navigateToThread?: SidebarThreadRowProps["navigateToThread"];
  handleThreadClick?: SidebarThreadRowProps["handleThreadClick"];
  routeThreadId?: ThreadId | null;
  projectCwd?: string | null;
  queryClient?: QueryClient;
  sidebarDefaultOpen?: boolean;
  startRenameThread?: SidebarThreadRowProps["startRenameThread"];
  handleThreadContextMenu?: SidebarThreadRowProps["handleThreadContextMenu"];
  cancelRename?: SidebarThreadRowProps["cancelRename"];
  snoozed?: boolean;
}) {
  const [renamingTitle, setRenamingTitle] = useState("New thread");
  const [ownQueryClient] = useState(() => new QueryClient());
  return (
    <QueryClientProvider client={props.queryClient ?? ownQueryClient}>
      <SidebarProvider defaultOpen={props.sidebarDefaultOpen ?? true} mobileBreakpoint={1}>
        <ul>
          <SidebarThreadRow
            threadId={THREAD_ID}
            orderedProjectThreadIds={[THREAD_ID]}
            routeThreadId={props.routeThreadId ?? null}
            showThreadJumpHints={false}
            jumpLabel={null}
            renamingThreadId={
              props.renamingThreadId === undefined ? THREAD_ID : props.renamingThreadId
            }
            renamingTitle={renamingTitle}
            renamingOriginalTitle="New thread"
            setRenamingTitle={setRenamingTitle}
            renamingInputRef={{ current: null }}
            renamingCommittedRef={{ current: false }}
            handleThreadClick={props.handleThreadClick ?? noop}
            navigateToThread={props.navigateToThread ?? noop}
            handleMultiSelectContextMenu={noopAsync}
            handleThreadContextMenu={props.handleThreadContextMenu ?? noopAsync}
            clearSelection={noop}
            commitRename={props.commitRename}
            cancelRename={props.cancelRename ?? noop}
            attemptArchiveThread={noopAsync}
            startRenameThread={props.startRenameThread ?? noop}
            attemptDeleteThread={noopAsync}
            openPrLink={noop}
            projectCwd={props.projectCwd ?? null}
            {...(props.snoozed === undefined ? {} : { snoozed: props.snoozed })}
          />
        </ul>
      </SidebarProvider>
    </QueryClientProvider>
  );
}

describe("SidebarThreadRow rename", () => {
  afterEach(() => {
    useStore.setState({ sidebarThreadsById: {} });
    document.body.innerHTML = "";
  });

  it("commits against the title captured at rename start, not a newer generated title", async () => {
    setThreadTitle("New thread");
    const commitRename = vi.fn(async () => {});
    const screen = await render(<Harness commitRename={commitRename} />);

    setThreadTitle("Generated title");
    const input = screen.container.querySelector("input");
    expect(input).not.toBeNull();
    await vi.waitFor(() => expect(document.activeElement).toBe(input));
    input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    await vi.waitFor(() => expect(commitRename).toHaveBeenCalledTimes(1));
    expect(commitRename).toHaveBeenCalledWith(THREAD_ID, "New thread", "New thread");
  });

  it("ignores the Enter that confirms an IME candidate", async () => {
    setThreadTitle("New thread");
    const commitRename = vi.fn(async () => {});
    const screen = await render(<Harness commitRename={commitRename} />);

    const input = screen.container.querySelector("input");
    expect(input).not.toBeNull();
    expect(input!.getAttribute("dir")).toBe("auto");
    await vi.waitFor(() => expect(document.activeElement).toBe(input));
    input!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }),
    );
    input!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", keyCode: 229, bubbles: true }),
    );
    expect(commitRename).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(input);

    input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await vi.waitFor(() => expect(commitRename).toHaveBeenCalledTimes(1));
  });
});

describe("SidebarThreadRow pinning", () => {
  afterEach(() => {
    useStore.setState({ sidebarThreadsById: {} });
    useUiStateStore.getState().setThreadPinned(THREAD_ID, false);
    document.body.innerHTML = "";
  });

  it("shows a pin on pinned rows that unpins the thread when clicked", async () => {
    setThreadTitle("Reference thread");
    const screen = await render(<Harness commitRename={noopAsync} renamingThreadId={null} />);
    expect(screen.container.querySelector(`[data-testid="thread-unpin-${THREAD_ID}"]`)).toBeNull();

    useUiStateStore.getState().setThreadPinned(THREAD_ID, true);
    await vi.waitFor(() =>
      expect(
        screen.container.querySelector(`[data-testid="thread-unpin-${THREAD_ID}"]`),
      ).not.toBeNull(),
    );

    screen.container
      .querySelector<HTMLButtonElement>(`[data-testid="thread-unpin-${THREAD_ID}"]`)!
      .click();

    expect(useUiStateStore.getState().pinnedThreadIds).not.toContain(THREAD_ID);
  });

  it("unpins from the keyboard without opening the thread", async () => {
    setThreadTitle("Reference thread");
    useUiStateStore.getState().setThreadPinned(THREAD_ID, true);
    const navigateToThread = vi.fn();
    const screen = await render(
      <Harness
        commitRename={noopAsync}
        renamingThreadId={null}
        navigateToThread={navigateToThread}
      />,
    );
    const button = await vi.waitFor(() => {
      const element = screen.container.querySelector<HTMLButtonElement>(
        `[data-testid="thread-unpin-${THREAD_ID}"]`,
      );
      expect(element).not.toBeNull();
      return element!;
    });

    button.focus();
    await userEvent.keyboard("{Enter}");

    expect(useUiStateStore.getState().pinnedThreadIds).not.toContain(THREAD_ID);
    expect(navigateToThread).not.toHaveBeenCalled();
  });
});

describe("SidebarThreadRow running terminal", () => {
  afterEach(() => {
    useStore.setState({ sidebarThreadsById: {} });
    useTerminalStateStore.getState().removeTerminalState(THREAD_ID);
    document.body.innerHTML = "";
  });

  it("opens the thread's drawer on the running terminal without selecting the row", async () => {
    setThreadTitle("Dev server");
    const terminalStore = useTerminalStateStore.getState();
    terminalStore.newTerminal(THREAD_ID, "term-2");
    terminalStore.setActiveTerminal(THREAD_ID, "default");
    terminalStore.setTerminalActivity(THREAD_ID, "term-2", true);
    const navigateToThread = vi.fn();
    const handleThreadClick = vi.fn();
    const screen = await render(
      <Harness
        commitRename={noopAsync}
        renamingThreadId={null}
        navigateToThread={navigateToThread}
        handleThreadClick={handleThreadClick}
      />,
    );

    const button = await vi.waitFor(() => {
      const element = screen.container.querySelector<HTMLButtonElement>(
        `[data-testid="thread-terminal-${THREAD_ID}"]`,
      );
      expect(element).not.toBeNull();
      return element!;
    });
    expect(button.getAttribute("aria-label")).toContain("Terminal process running");
    button.click();

    const terminalState = selectThreadTerminalState(
      useTerminalStateStore.getState().terminalStateByThreadId,
      THREAD_ID,
    );
    expect(terminalState.terminalOpen).toBe(true);
    expect(terminalState.activeTerminalId).toBe("term-2");
    expect(navigateToThread).toHaveBeenCalledWith(THREAD_ID);
    expect(handleThreadClick).not.toHaveBeenCalled();
  });
});

describe("SidebarThreadRow title tooltip", () => {
  afterEach(() => {
    useStore.setState({ sidebarThreadsById: {} });
    document.body.innerHTML = "";
  });

  it("renders the title as a tooltip trigger", async () => {
    setThreadTitle("A very long thread title that the sidebar truncates");
    const screen = await render(<Harness commitRename={noopAsync} renamingThreadId={null} />);

    const title = screen.container.querySelector(`[data-testid="thread-title-${THREAD_ID}"]`);
    expect(title?.getAttribute("data-slot")).toBe("tooltip-trigger");
    expect(title?.getAttribute("dir")).toBe("ltr");
    expect(title?.textContent).toBe("A very long thread title that the sidebar truncates");
  });
});

describe("SidebarThreadRow title hover card", () => {
  afterEach(async () => {
    // Unmount first: clearing the body under an open portal breaks React's removal.
    await cleanup();
    useStore.setState({ sidebarThreadsById: {}, threads: [] });
    document.body.innerHTML = "";
  });

  const hoverCard = async (summary: SidebarThreadSummary) => {
    useStore.setState({
      sidebarThreadsById: { [THREAD_ID]: summary },
      threads: [
        {
          id: THREAD_ID,
          modelSelection: { provider: "claudeAgent", model: "claude-test-model" },
        } as unknown as Thread,
      ],
    });
    const screen = await render(<Harness commitRename={noopAsync} renamingThreadId={null} />);
    await userEvent.hover(screen.getByTestId(`thread-title-${THREAD_ID}`));
    return vi.waitFor(
      () => {
        const card = document.querySelector(`[data-testid="thread-title-card-${THREAD_ID}"]`);
        expect(card).not.toBeNull();
        return card as HTMLElement;
      },
      { timeout: 3_000 },
    );
  };

  it("shows the branch, model and failure reason", async () => {
    const card = await hoverCard({
      ...makeSummary("Fix login", "feature/login"),
      session: {
        provider: "claudeAgent",
        status: "error",
        createdAt: "2026-03-04T12:00:00.000Z",
        updatedAt: "2026-03-04T12:00:00.000Z",
        lastError: "The provider exited unexpectedly",
        orchestrationStatus: "error",
      },
    });
    expect(card.textContent).toContain("Fix login");
    expect(card.textContent).toContain("feature/login");
    expect(card.textContent).toContain("claude-test-model");
    expect(card.textContent).toContain("The provider exited unexpectedly");
  });

  it("clicks and double-clicks inside the card neither open nor rename the thread", async () => {
    const handleThreadClick = vi.fn();
    const startRenameThread = vi.fn();
    useStore.setState({
      sidebarThreadsById: { [THREAD_ID]: makeSummary("Fix login", "feature/login") },
    });
    const screen = await render(
      <Harness
        commitRename={noopAsync}
        renamingThreadId={null}
        handleThreadClick={handleThreadClick}
        startRenameThread={startRenameThread}
      />,
    );
    await userEvent.hover(screen.getByTestId(`thread-title-${THREAD_ID}`));
    const card = await vi.waitFor(
      () => {
        const found = document.querySelector<HTMLElement>(
          `[data-testid="thread-title-card-${THREAD_ID}"]`,
        );
        expect(found).not.toBeNull();
        return found!;
      },
      { timeout: 3_000 },
    );
    card.click();
    card.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    expect(handleThreadClick).not.toHaveBeenCalled();
    expect(startRenameThread).not.toHaveBeenCalled();

    const row = screen.container.querySelector<HTMLElement>(
      `[data-testid="thread-row-${THREAD_ID}"]`,
    )!;
    row.click();
    expect(handleThreadClick).toHaveBeenCalledOnce();
    row.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    expect(startRenameThread).toHaveBeenCalledWith(THREAD_ID);
  });

  it("shows only the title and model for a thread with no branch or failure", async () => {
    const card = await hoverCard(makeSummary("Plain thread"));
    expect(card.textContent).toBe("Plain threadclaude-test-model");
  });
});

const held = (init: KeyboardEventInit) =>
  new KeyboardEvent("keydown", { bubbles: true, cancelable: true, repeat: true, ...init });

describe("SidebarThreadRow keyboard", () => {
  afterEach(async () => {
    // Unmount first: clearing the body under an open portal breaks React's removal.
    await cleanup();
    useStore.setState({ sidebarThreadsById: {} });
    useThreadSelectionStore.getState().clearSelection();
    document.body.innerHTML = "";
  });

  const renderRow = async (overrides: Partial<Parameters<typeof Harness>[0]> = {}) => {
    setThreadTitle("Keyboard thread");
    const navigateToThread = vi.fn();
    const startRenameThread = vi.fn();
    const handleThreadContextMenu = vi.fn(async () => {});
    const screen = await render(
      <Harness
        commitRename={noopAsync}
        renamingThreadId={null}
        navigateToThread={navigateToThread}
        startRenameThread={startRenameThread}
        handleThreadContextMenu={handleThreadContextMenu}
        {...overrides}
      />,
    );
    const row = screen.container.querySelector<HTMLElement>(
      `[data-testid="thread-row-${THREAD_ID}"]`,
    )!;
    return { screen, row, navigateToThread, startRenameThread, handleThreadContextMenu };
  };

  it("opens the thread for Enter and Space on the row itself", async () => {
    const { row, navigateToThread } = await renderRow();
    row.focus();
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard(" ");
    expect(navigateToThread).toHaveBeenCalledTimes(2);
  });

  it("ignores auto-repeat from a held key", async () => {
    const { row, navigateToThread, handleThreadContextMenu } = await renderRow();
    row.focus();
    const enter = held({ key: "Enter" });
    row.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
    row.dispatchEvent(held({ key: " " }));
    row.dispatchEvent(held({ key: "F10", shiftKey: true }));
    expect(navigateToThread).not.toHaveBeenCalled();
    expect(handleThreadContextMenu).not.toHaveBeenCalled();
  });

  it("does not open the thread for Enter on the menu button or a menu item", async () => {
    const { screen, navigateToThread } = await renderRow();
    const trigger = screen.container.querySelector<HTMLButtonElement>(
      `[data-testid="thread-menu-${THREAD_ID}"]`,
    )!;
    trigger.focus();
    await userEvent.keyboard("{Enter}");
    const item = await vi.waitFor(() => {
      const found = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
        (element) => element.textContent === "Pin",
      );
      expect(found).toBeDefined();
      return found!;
    });
    item.focus();
    await userEvent.keyboard("{Enter}");
    expect(navigateToThread).not.toHaveBeenCalled();
    useUiStateStore.getState().setThreadPinned(THREAD_ID, false);
  });

  it("starts a rename with a bare F2 on the row, not with a modifier or from the input", async () => {
    const { row, startRenameThread } = await renderRow();
    row.focus();
    await userEvent.keyboard("{Shift>}{F2}{/Shift}");
    expect(startRenameThread).not.toHaveBeenCalled();
    await userEvent.keyboard("{F2}");
    expect(startRenameThread).toHaveBeenCalledWith(THREAD_ID);
  });

  it("does not restart a rename for F2 pressed inside the rename input", async () => {
    const { screen, startRenameThread } = await renderRow({ renamingThreadId: THREAD_ID });
    const input = screen.container.querySelector("input")!;
    await vi.waitFor(() => expect(document.activeElement).toBe(input));
    await userEvent.keyboard("{F2}");
    expect(startRenameThread).not.toHaveBeenCalled();
  });

  it("opens the row menu once for Shift+F10 even if a native contextmenu follows", async () => {
    const { row, handleThreadContextMenu, navigateToThread } = await renderRow();
    row.focus();
    await userEvent.keyboard("{Shift>}{F10}{/Shift}");
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    expect(handleThreadContextMenu).toHaveBeenCalledOnce();
    expect(navigateToThread).not.toHaveBeenCalled();
  });

  it("ignores a right-click that bubbled from a portaled menu", async () => {
    const { screen, handleThreadContextMenu } = await renderRow();
    screen.container
      .querySelector<HTMLButtonElement>(`[data-testid="thread-menu-${THREAD_ID}"]`)!
      .click();
    const item = await vi.waitFor(() => {
      const found = document.querySelector<HTMLElement>('[role="menuitem"]');
      expect(found).not.toBeNull();
      return found!;
    });
    item.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    expect(handleThreadContextMenu).not.toHaveBeenCalled();
  });

  it("returns focus to the row after a rename ends from the keyboard", async () => {
    setThreadTitle("Keyboard thread");
    function RenameHarness() {
      const [renaming, setRenaming] = useState(true);
      return (
        <Harness
          commitRename={noopAsync}
          renamingThreadId={renaming ? THREAD_ID : null}
          cancelRename={() => setRenaming(false)}
        />
      );
    }
    const screen = await render(<RenameHarness />);
    const input = screen.container.querySelector("input")!;
    await vi.waitFor(() => expect(document.activeElement).toBe(input));
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() =>
      expect(document.activeElement?.getAttribute("data-testid")).toBe(`thread-row-${THREAD_ID}`),
    );
  });

  it("leaves focus alone when the user moved it before a slow rename resolved", async () => {
    setThreadTitle("Keyboard thread");
    let finishCommit: () => void = noop;
    function RenameHarness() {
      const [renaming, setRenaming] = useState(true);
      return (
        <>
          <button type="button" data-testid="elsewhere">
            Elsewhere
          </button>
          <Harness
            commitRename={() =>
              new Promise<void>((resolve) => {
                finishCommit = () => {
                  setRenaming(false);
                  resolve();
                };
              })
            }
            renamingThreadId={renaming ? THREAD_ID : null}
          />
        </>
      );
    }
    const screen = await render(<RenameHarness />);
    const input = screen.container.querySelector("input")!;
    await vi.waitFor(() => expect(document.activeElement).toBe(input));
    await userEvent.keyboard("{Enter}");
    const elsewhere = screen.container.querySelector<HTMLElement>('[data-testid="elsewhere"]')!;
    elsewhere.focus();
    finishCommit();
    await vi.waitFor(() => expect(screen.container.querySelector("input")).toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(document.activeElement).toBe(elsewhere);
  });
});

const findMenuItem = (text: string) =>
  Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((element) =>
    element.textContent?.startsWith(text),
  );

describe("SidebarThreadRow snooze", () => {
  const SNOOZE = {
    snoozedUntil: "2099-01-01T09:00:00.000Z",
    snoozedAt: "2026-03-04T12:00:00.000Z",
    questionPendingAtSnooze: false,
  };

  afterEach(async () => {
    await cleanup();
    useStore.setState({ sidebarThreadsById: {} });
    useUiStateStore.setState({ snoozedThreadsById: {} });
    document.body.innerHTML = "";
  });

  const openMenu = async (container: Element) => {
    container.querySelector<HTMLButtonElement>(`[data-testid="thread-menu-${THREAD_ID}"]`)!.click();
    await vi.waitFor(() => expect(document.querySelector('[role="menuitem"]')).not.toBeNull());
  };

  it("snoozes from the row menu, and Undo restores the row", async () => {
    setThreadTitle("Snoozable");
    const screen = await render(<Harness commitRename={noopAsync} renamingThreadId={null} />);
    await openMenu(screen.container);
    findMenuItem("Snooze")!.click();
    const preset = await vi.waitFor(() => {
      const found = findMenuItem("Tomorrow");
      expect(found).toBeDefined();
      return found!;
    });
    preset.click();
    await vi.waitFor(() =>
      expect(useUiStateStore.getState().snoozedThreadsById[THREAD_ID]).toBeDefined(),
    );
    expect(undoLatestThreadAction()).toBe(true);
    await vi.waitFor(() =>
      expect(useUiStateStore.getState().snoozedThreadsById[THREAD_ID]).toBeUndefined(),
    );
  });

  it("offers Wake now and shows the wake label on a shelf row", async () => {
    setThreadTitle("Sleeping");
    useUiStateStore.setState({ snoozedThreadsById: { [THREAD_ID]: SNOOZE } });
    const screen = await render(
      <Harness commitRename={noopAsync} renamingThreadId={null} snoozed />,
    );
    const row = screen.container.querySelector(`[data-testid="thread-row-${THREAD_ID}"]`);
    expect(row?.getAttribute("aria-label")).toContain("Snoozed");
    expect(row?.textContent).toMatch(/\d+d/);
    await openMenu(screen.container);
    findMenuItem("Wake now")!.click();
    await vi.waitFor(() =>
      expect(useUiStateStore.getState().snoozedThreadsById[THREAD_ID]).toBeUndefined(),
    );
  });

  // What the sidebar's reconcile effect does for the thread on the route.
  const visitThread = () => {
    const { snoozedThreadsById, setSnoozedThreads } = useUiStateStore.getState();
    setSnoozedThreads(
      reconcileThreadSnoozes(snoozedThreadsById, {
        threadsById: useStore.getState().sidebarThreadsById,
        lastVisitedAtById: {},
        routeThreadId: THREAD_ID,
        nowMs: Date.now(),
      }),
    );
  };

  it("marks a timer-woken row until it has been visited", async () => {
    setThreadTitle("Woken");
    const elapsed = { ...SNOOZE, snoozedUntil: "2026-03-05T09:00:00.000Z" };
    useUiStateStore.setState({ snoozedThreadsById: { [THREAD_ID]: elapsed } });
    const screen = await render(<Harness commitRename={noopAsync} renamingThreadId={null} />);
    const marker = () => screen.container.querySelector(`[data-testid="thread-woke-${THREAD_ID}"]`);
    expect(marker()).not.toBeNull();
    visitThread();
    await vi.waitFor(() => expect(marker()).toBeNull());
  });

  it("clears a raised-hand marker after a visit, though the snooze still runs", async () => {
    useStore.setState({
      sidebarThreadsById: {
        [THREAD_ID]: {
          ...makeSummary("Failed while snoozed"),
          session: {
            provider: "claudeAgent",
            status: "error",
            createdAt: "2026-03-04T12:00:00.000Z",
            updatedAt: "2026-03-05T09:00:00.000Z",
            lastError: "boom",
            orchestrationStatus: "error",
          },
        },
      },
    });
    useUiStateStore.setState({ snoozedThreadsById: { [THREAD_ID]: SNOOZE } });
    const screen = await render(<Harness commitRename={noopAsync} renamingThreadId={null} />);
    const marker = () => screen.container.querySelector(`[data-testid="thread-woke-${THREAD_ID}"]`);
    expect(marker()).not.toBeNull();
    visitThread();
    await vi.waitFor(() => expect(marker()).toBeNull());
    expect(useUiStateStore.getState().snoozedThreadsById[THREAD_ID]).toBeDefined();
  });

  it("disables Snooze while the turn just sent has not started", async () => {
    useStore.setState({
      sidebarThreadsById: {
        [THREAD_ID]: { ...makeSummary("Sent"), latestUserMessageAt: new Date().toISOString() },
      },
    });
    const screen = await render(<Harness commitRename={noopAsync} renamingThreadId={null} />);
    await openMenu(screen.container);
    expect(findMenuItem("Snooze")?.hasAttribute("data-disabled")).toBe(true);
  });
});

describe("SidebarThreadRow accessibility", () => {
  afterEach(() => {
    useStore.setState({ sidebarThreadsById: {} });
    document.body.innerHTML = "";
  });

  it("names the row by its title and marks the open thread as the current page", async () => {
    setThreadTitle("Fix login");
    const screen = await render(
      <Harness commitRename={noopAsync} renamingThreadId={null} routeThreadId={THREAD_ID} />,
    );
    const row = screen.container.querySelector(`[data-testid="thread-row-${THREAD_ID}"]`);
    expect(row?.getAttribute("aria-label")).toBe("Fix login");
    expect(row?.getAttribute("aria-current")).toBe("page");
  });
});

describe("SidebarThreadRow title regeneration", () => {
  beforeEach(() => {
    setThreadTitle("A title");
    clearThreadTitleRegenerations();
  });
  afterEach(() => {
    clearThreadTitleRegenerations();
    useStore.setState({ sidebarThreadsById: {} });
    document.body.innerHTML = "";
  });

  it("dims the title and announces the run only while it is pending", async () => {
    const screen = await render(<Harness commitRename={noopAsync} renamingThreadId={null} />);
    const row = () =>
      screen.container.querySelector<HTMLElement>(`[data-testid="thread-row-${THREAD_ID}"]`)!;
    const title = () =>
      screen.container.querySelector<HTMLElement>(`[data-testid="thread-title-${THREAD_ID}"]`)!;
    const status = () => screen.container.querySelector('[role="status"]');
    expect(row().hasAttribute("aria-busy")).toBe(false);
    const liveRegion = status();
    expect(liveRegion?.textContent).toBe("");

    beginThreadTitleRegeneration(THREAD_ID);
    await vi.waitFor(() => expect(row().getAttribute("aria-busy")).toBe("true"));
    expect(row().getAttribute("aria-label")).toContain("Regenerating title");
    expect(title().className).toContain("opacity-60");
    expect(status()).toBe(liveRegion);
    expect(liveRegion?.textContent).toBe("Regenerating title");
    expect(row().contains(liveRegion)).toBe(false);

    clearThreadTitleRegenerations();
    await vi.waitFor(() => expect(row().hasAttribute("aria-busy")).toBe(false));
    expect(title().className).toContain("opacity-100");
    expect(status()).toBe(liveRegion);
    expect(liveRegion?.textContent).toBe("");
  });
});

describe("SidebarThreadRow unsent draft", () => {
  afterEach(() => {
    useStore.setState({ sidebarThreadsById: {} });
    useComposerDraftStore.getState().clearComposerContent(THREAD_ID);
    document.body.innerHTML = "";
  });

  it("marks an inactive row holding a draft and discards it from the row menu", async () => {
    setThreadTitle("Draft thread");
    useComposerDraftStore.getState().setPrompt(THREAD_ID, "half-written idea");
    const screen = await render(<Harness commitRename={noopAsync} renamingThreadId={null} />);

    await vi.waitFor(() =>
      expect(
        screen.container.querySelector('[data-testid="thread-unsent-draft-marker"]'),
      ).not.toBeNull(),
    );

    screen.container
      .querySelector<HTMLButtonElement>(`[data-testid="thread-menu-${THREAD_ID}"]`)!
      .click();
    const discard = await vi.waitFor(() => {
      const item = Array.from(document.querySelectorAll('[role="menuitem"]')).find(
        (element) => element.textContent === "Discard draft",
      );
      expect(item).toBeDefined();
      return item as HTMLElement;
    });
    discard.click();

    await vi.waitFor(() =>
      expect(
        screen.container.querySelector('[data-testid="thread-unsent-draft-marker"]'),
      ).toBeNull(),
    );
    expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt ?? "").toBe("");
  });

  it("shows no marker on the active row", async () => {
    setThreadTitle("Draft thread");
    useComposerDraftStore.getState().setPrompt(THREAD_ID, "half-written idea");
    const screen = await render(
      <Harness commitRename={noopAsync} renamingThreadId={null} routeThreadId={THREAD_ID} />,
    );
    expect(screen.container.querySelector('[data-testid="thread-unsent-draft-marker"]')).toBeNull();
  });
});

describe("SidebarThreadRow git status lease", () => {
  const CWD = "/repo";
  type ObserverCallback = (entries: { isIntersecting: boolean }[]) => void;
  let observerCallback: ObserverCallback | null = null;
  const status =
    vi.fn<(input: { cwd: string; refreshUpstream?: boolean }) => Promise<GitStatusResult>>();

  function statusResult(prNumber: number): GitStatusResult {
    return {
      branch: "feature",
      hasWorkingTreeChanges: false,
      workingTree: { files: [], insertions: 0, deletions: 0 },
      hasUpstream: true,
      aheadCount: 0,
      behindCount: 0,
      pr: {
        number: prNumber,
        title: "Lease PR",
        url: `https://github.com/acme/repo/pull/${prNumber}`,
        baseBranch: "main",
        headBranch: "feature",
        state: "open",
      },
    } as unknown as GitStatusResult;
  }

  beforeEach(() => {
    observerCallback = null;
    status.mockReset();
    status.mockResolvedValue(statusResult(1));
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: ObserverCallback) {
          observerCallback = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    window.nativeApi = { git: { status } } as unknown as NativeApi;
    __resetNativeApiForTests();
    useStore.setState({
      sidebarThreadsById: { [THREAD_ID]: makeSummary("Lease thread", "feature") },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete window.nativeApi;
    __resetNativeApiForTests();
    useStore.setState({ sidebarThreadsById: {} });
    document.body.innerHTML = "";
  });

  const setNearViewport = (isIntersecting: boolean) => {
    observerCallback!([{ isIntersecting }]);
  };

  const renderLeaseRow = (extra: { routeThreadId?: ThreadId; queryClient?: QueryClient } = {}) =>
    render(
      <Harness commitRename={noopAsync} renamingThreadId={null} projectCwd={CWD} {...extra} />,
    );

  it("does not read git status for a row outside the viewport", async () => {
    await renderLeaseRow();
    await vi.waitFor(() => expect(observerCallback).not.toBeNull());
    setNearViewport(false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(status).not.toHaveBeenCalled();
  });

  it("reads status once near the viewport and shows the PR badge", async () => {
    const screen = await renderLeaseRow();
    await vi.waitFor(() => expect(observerCallback).not.toBeNull());
    setNearViewport(true);
    await vi.waitFor(() =>
      expect(status).toHaveBeenCalledWith({ cwd: CWD, refreshUpstream: false }),
    );
    await vi.waitFor(() =>
      expect(screen.container.querySelector('button[aria-label*="PR"]')).not.toBeNull(),
    );
  });

  it("does not open the thread for Enter on the PR badge", async () => {
    const navigateToThread = vi.fn();
    const screen = await render(
      <Harness
        commitRename={noopAsync}
        renamingThreadId={null}
        projectCwd={CWD}
        navigateToThread={navigateToThread}
      />,
    );
    await vi.waitFor(() => expect(observerCallback).not.toBeNull());
    setNearViewport(true);
    const badge = await vi.waitFor(() => {
      const found = screen.container.querySelector<HTMLButtonElement>('button[aria-label*="PR"]');
      expect(found).not.toBeNull();
      return found!;
    });
    badge.focus();
    await userEvent.keyboard("{Enter}");
    expect(navigateToThread).not.toHaveBeenCalled();
  });

  it("warns on the title card when the checkout moved off the thread's branch", async () => {
    useStore.setState({
      sidebarThreadsById: { [THREAD_ID]: makeSummary("Moved", "feature/own") },
    });
    const screen = await render(
      <Harness commitRename={noopAsync} renamingThreadId={null} projectCwd={CWD} />,
    );
    await vi.waitFor(() => expect(observerCallback).not.toBeNull());
    setNearViewport(true);
    await vi.waitFor(() =>
      expect(status).toHaveBeenCalledWith({ cwd: CWD, refreshUpstream: false }),
    );
    await userEvent.hover(screen.getByTestId(`thread-title-${THREAD_ID}`));
    await vi.waitFor(
      () => {
        const card = document.querySelector(`[data-testid="thread-title-card-${THREAD_ID}"]`);
        expect(card?.textContent).toContain("Checkout is on");
        expect(card?.textContent).toContain("feature");
      },
      { timeout: 3_000 },
    );
    await cleanup();
  });

  it("always leases the open thread", async () => {
    await renderLeaseRow({ routeThreadId: THREAD_ID });
    await vi.waitFor(() =>
      expect(status).toHaveBeenCalledWith({ cwd: CWD, refreshUpstream: false }),
    );
  });

  it("does not read git status for a thread without a branch", async () => {
    useStore.setState({ sidebarThreadsById: { [THREAD_ID]: makeSummary("Lease thread", null) } });
    await renderLeaseRow();
    await vi.waitFor(() => expect(observerCallback).not.toBeNull());
    setNearViewport(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(status).not.toHaveBeenCalled();
  });

  it("does not poll while the whole sidebar is collapsed", async () => {
    await render(
      <Harness
        commitRename={noopAsync}
        renamingThreadId={null}
        projectCwd={CWD}
        sidebarDefaultOpen={false}
      />,
    );
    await vi.waitFor(() => expect(observerCallback).not.toBeNull());
    setNearViewport(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(status).not.toHaveBeenCalled();
  });

  it("releases with a real observer while the list is hidden during search", async () => {
    vi.unstubAllGlobals();
    const container = document.createElement("div");
    container.style.display = "none";
    document.body.append(container);
    await render(<Harness commitRename={noopAsync} renamingThreadId={null} projectCwd={CWD} />, {
      container,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(status).not.toHaveBeenCalled();

    container.style.display = "";
    await vi.waitFor(() =>
      expect(status).toHaveBeenCalledWith({ cwd: CWD, refreshUpstream: false }),
    );
  });

  it("keeps a released row's badge and refreshes only leased rows on invalidation", async () => {
    const queryClient = new QueryClient();
    const screen = await renderLeaseRow({ queryClient });
    await vi.waitFor(() => expect(observerCallback).not.toBeNull());
    setNearViewport(true);
    const badge = () => screen.container.querySelector('button[aria-label*="PR"]');
    await vi.waitFor(() => expect(badge()).not.toBeNull());

    // A visible row refreshes when a finished turn invalidates its status.
    status.mockResolvedValue(statusResult(2));
    await invalidateGitStatusQuery(queryClient, CWD);
    await vi.waitFor(() => expect(status).toHaveBeenCalledTimes(2));

    setNearViewport(false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(badge()).not.toBeNull();

    await invalidateGitStatusQuery(queryClient, CWD);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(status).toHaveBeenCalledTimes(2);
    expect(badge()).not.toBeNull();

    // Scrolling back picks up the invalidation the released row missed.
    setNearViewport(true);
    await vi.waitFor(() => expect(status).toHaveBeenCalledTimes(3));
  });

  it("does not re-render for a status change that keeps the branch and PR", async () => {
    const queryClient = new QueryClient();
    const onRender = vi.fn();
    const screen = await render(
      <Profiler id="row" onRender={onRender}>
        <Harness
          commitRename={noopAsync}
          renamingThreadId={null}
          projectCwd={CWD}
          queryClient={queryClient}
        />
      </Profiler>,
    );
    await vi.waitFor(() => expect(observerCallback).not.toBeNull());
    setNearViewport(true);
    await vi.waitFor(() =>
      expect(screen.container.querySelector('button[aria-label*="PR"]')).not.toBeNull(),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    onRender.mockClear();

    status.mockResolvedValue({
      ...statusResult(1),
      hasWorkingTreeChanges: true,
      workingTree: { files: [], insertions: 3, deletions: 1 },
    } as GitStatusResult);
    await invalidateGitStatusQuery(queryClient, CWD);
    await vi.waitFor(() => expect(status).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(onRender).not.toHaveBeenCalled();

    // A PR change does reach the row.
    status.mockResolvedValue(statusResult(2));
    await invalidateGitStatusQuery(queryClient, CWD);
    await vi.waitFor(() =>
      expect(
        screen.container.querySelector('button[aria-label*="PR"]')?.getAttribute("aria-label"),
      ).toContain("#2"),
    );
    expect(onRender).toHaveBeenCalled();
  });
});
