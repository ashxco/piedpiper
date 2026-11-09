import "../index.css";

import type { ProjectId, ResolvedKeybindingsConfig, ThreadId } from "@piedpiper/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

const mocks = vi.hoisted(() => ({
  activeThread: { current: undefined as { projectId: string } | undefined },
  addProjectFromPath: vi.fn(async () => undefined),
  confirm: vi.fn(async () => true),
  dispatchCommand: vi.fn(async () => ({ sequence: 1 })),
  handleNewThread: vi.fn(async () => undefined),
  navigate: vi.fn(async () => undefined),
  pickAndAddProject: vi.fn(async () => true),
  routeThreadId: { current: null as string | null },
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useLocation: (options: { select: (location: { pathname: string }) => unknown }) =>
    options.select({ pathname: "/" }),
  useNavigate: () => mocks.navigate,
  useParams: (options: { select: (params: { threadId?: string }) => unknown }) =>
    options.select(mocks.routeThreadId.current ? { threadId: mocks.routeThreadId.current } : {}),
}));

vi.mock("~/hooks/useHandleNewThread", () => ({
  useHandleNewThread: () => ({
    activeDraftThread: null,
    activeThread: mocks.activeThread.current,
    defaultProjectId: "project-1",
    handleNewThread: mocks.handleNewThread,
    routeThreadId: mocks.routeThreadId.current,
  }),
}));

vi.mock("~/hooks/useAddProjectFromPath", () => ({
  useAddProjectFromPath: () => ({
    addProjectFromPath: mocks.addProjectFromPath,
    isAddingProject: false,
    pickAndAddProject: mocks.pickAndAddProject,
  }),
}));

vi.mock("~/hooks/useSettings", () => ({
  useSettings: (select: (settings: Record<string, string>) => unknown) =>
    select({ sidebarThreadSortOrder: "updated_at", defaultThreadEnvMode: "local" }),
}));

vi.mock("~/rpc/serverState", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../rpc/serverState")>()),
  useServerKeybindings: (): ResolvedKeybindingsConfig => [
    {
      command: "commandPalette.toggle",
      shortcut: {
        key: "k",
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        modKey: true,
      },
      whenAst: { type: "not", node: { type: "identifier", name: "terminalFocus" } },
    },
  ],
}));

vi.mock("~/nativeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../nativeApi")>()),
  readNativeApi: () => ({
    dialogs: { confirm: mocks.confirm },
    orchestration: { dispatchCommand: mocks.dispatchCommand },
  }),
}));

import { useCommandPaletteStore } from "../commandPaletteStore";
import { useStore } from "../store";
import type { Project, SidebarThreadSummary } from "../types";
import { CommandPalette } from "./CommandPalette";
import { RECENT_THREAD_LIMIT } from "./CommandPalette.logic";
import { ALERT_DIALOG_OPEN_ATTRIBUTE } from "./ui/alert-dialog-open-flag";

const PROJECT_ID = "project-1" as ProjectId;
const initialStoreState = useStore.getState();

function thread(id: string, overrides: Partial<SidebarThreadSummary> = {}): SidebarThreadSummary {
  return {
    id: id as ThreadId,
    projectId: PROJECT_ID,
    title: id,
    interactionMode: "default",
    session: null,
    createdAt: "2026-03-01T00:00:00.000Z",
    archivedAt: null,
    updatedAt: "2026-03-01T00:00:00.000Z",
    latestTurn: null,
    branch: null,
    worktreePath: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

const ARCHIVED_PROJECT = {
  id: "project-archived" as ProjectId,
  name: "Aviato",
  cwd: "/repo/aviato",
  defaultModelSelection: null,
  scripts: [],
  archivedAt: "2026-03-01T00:00:00.000Z",
};

function seedStore(threads: SidebarThreadSummary[], extraProjects: Project[] = []) {
  useStore.setState({
    threadIdsByProjectId: Object.fromEntries(
      threads.map((entry) => [
        entry.projectId,
        threads.filter((other) => other.projectId === entry.projectId).map((other) => other.id),
      ]),
    ),
    projects: [
      {
        id: PROJECT_ID,
        name: "Pied Piper",
        cwd: "/repo/pied-piper",
        defaultModelSelection: null,
        scripts: [],
      },
      {
        id: "project-2" as ProjectId,
        name: "Hooli",
        cwd: "/repo/hooli",
        defaultModelSelection: null,
        scripts: [],
      },
      ...extraProjects,
    ],
    sidebarThreadsById: Object.fromEntries(threads.map((entry) => [entry.id, entry])),
  });
}

function pressPaletteChord() {
  const isMac = navigator.platform.toLowerCase().includes("mac");
  const event = new KeyboardEvent("keydown", {
    key: "k",
    metaKey: isMac,
    ctrlKey: !isMac,
    bubbles: true,
    cancelable: true,
  });
  window.dispatchEvent(event);
  return event;
}

const palette = () => document.querySelector('[data-testid="command-palette"]');
const rows = () => [...document.querySelectorAll('[data-slot="command-item"]')];
const rowTitles = () => rows().map((row) => row.querySelector("span span")?.textContent ?? "");
const highlighted = () =>
  document.querySelector('[data-slot="command-item"][data-highlighted] span span')?.textContent;
const groupLabels = () =>
  [...document.querySelectorAll('[data-slot="command-group-label"]')].map((el) => el.textContent);

async function openPalette() {
  pressPaletteChord();
  await vi.waitFor(() => expect(rows().length).toBeGreaterThan(0));
  await vi.waitFor(() =>
    expect(document.activeElement).toBe(page.getByLabelText("Command palette search").element()),
  );
}

describe("CommandPalette", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.activeThread.current = undefined;
    mocks.routeThreadId.current = null;
    seedStore([
      thread("Fix login", { branch: "fix/login", updatedAt: "2026-03-03T00:00:00.000Z" }),
      thread("Compression bench", { updatedAt: "2026-03-02T00:00:00.000Z" }),
      thread("Archived work", {
        archivedAt: "2026-03-02T00:00:00.000Z",
        updatedAt: "2026-03-04T00:00:00.000Z",
      }),
    ]);
  });

  afterEach(() => {
    useCommandPaletteStore.getState().setOpen(false);
    useStore.setState(initialStoreState);
  });

  it("renders nothing until opened, then toggles with the chord and closes on Escape", async () => {
    const screen = await render(<CommandPalette />);
    expect(palette()).toBeNull();

    await openPalette();
    expect(groupLabels()).toEqual(["Actions", "Recent threads"]);
    expect(rowTitles()).toContain("Fix login");
    expect(rowTitles()).not.toContain("Archived work");

    pressPaletteChord();
    await vi.waitFor(() => expect(palette()).toBeNull());

    await openPalette();
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(palette()).toBeNull());
    await screen.unmount();
  });

  it("claims the chord under a confirmation dialog without opening", async () => {
    const screen = await render(<CommandPalette />);
    document.documentElement.setAttribute(ALERT_DIALOG_OPEN_ATTRIBUTE, "");
    try {
      expect(pressPaletteChord().defaultPrevented).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(palette()).toBeNull();
      expect(useCommandPaletteStore.getState().open).toBe(false);
    } finally {
      document.documentElement.removeAttribute(ALERT_DIALOG_OPEN_ATTRIBUTE);
      await screen.unmount();
    }
  });

  it("finds a thread by branch and opens it with Enter", async () => {
    const screen = await render(<CommandPalette />);
    await openPalette();

    await userEvent.keyboard("fix/login");
    await vi.waitFor(() => expect(rowTitles()).toEqual(["Fix login"]));
    await userEvent.keyboard("{Enter}");

    await vi.waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledWith({
        to: "/$threadId",
        params: { threadId: "Fix login" },
      }),
    );
    await vi.waitFor(() => expect(palette()).toBeNull());
    await screen.unmount();
  });

  it("selects the matched row when Enter follows the typing at once", async () => {
    const screen = await render(<CommandPalette />);
    await openPalette();

    await userEvent.keyboard("fix/login{Enter}");

    await vi.waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledWith({
        to: "/$threadId",
        params: { threadId: "Fix login" },
      }),
    );
    expect(mocks.handleNewThread).not.toHaveBeenCalled();
    await screen.unmount();
  });

  it("runs an action once when Enter lands again during the closing transition", async () => {
    const screen = await render(<CommandPalette />);
    await openPalette();

    await userEvent.keyboard("fix/login");
    await vi.waitFor(() => expect(rowTitles()).toEqual(["Fix login"]));
    await userEvent.keyboard("{Enter}{Enter}");

    await vi.waitFor(() => expect(palette()).toBeNull());
    expect(mocks.navigate).toHaveBeenCalledTimes(1);
    await screen.unmount();
  });

  it("opens a project's latest thread when it is found by path", async () => {
    seedStore([
      thread("Hooli old", { projectId: "project-2" as ProjectId }),
      thread("Hooli new", {
        projectId: "project-2" as ProjectId,
        updatedAt: "2026-03-02T00:00:00.000Z",
      }),
    ]);
    const screen = await render(<CommandPalette />);
    await openPalette();

    await userEvent.keyboard("/repo/hooli");
    await vi.waitFor(() => expect(groupLabels()).toEqual(["Projects"]));
    await userEvent.keyboard("{Enter}");

    await vi.waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledWith({
        to: "/$threadId",
        params: { threadId: "Hooli new" },
      }),
    );
    expect(mocks.handleNewThread).not.toHaveBeenCalled();
    await screen.unmount();
  });

  it("starts a thread when the project found by path has none", async () => {
    const screen = await render(<CommandPalette />);
    await openPalette();

    await userEvent.keyboard("/repo/hooli");
    await vi.waitFor(() => expect(groupLabels()).toEqual(["Projects"]));
    await userEvent.keyboard("{Enter}");

    await vi.waitFor(() =>
      expect(mocks.handleNewThread).toHaveBeenCalledWith("project-2", { envMode: "local" }),
    );
    expect(mocks.navigate).not.toHaveBeenCalled();
    await screen.unmount();
  });

  it("offers no archived project, and only the threads the sidebar still lists", async () => {
    const workingProject = { ...ARCHIVED_PROJECT, id: "project-working" as ProjectId };
    seedStore(
      [
        thread("Aviato idle", { projectId: ARCHIVED_PROJECT.id }),
        thread("Aviato asking", { projectId: workingProject.id, hasPendingUserInput: true }),
      ],
      [ARCHIVED_PROJECT, workingProject],
    );
    const screen = await render(<CommandPalette />);
    await openPalette();
    expect(rowTitles()).toContain("Aviato asking");
    expect(rowTitles()).not.toContain("Aviato idle");

    await userEvent.keyboard("aviato");
    await vi.waitFor(() => expect(groupLabels()).toEqual(["Threads"]));
    expect(rowTitles()).toEqual(["Aviato asking"]);

    await userEvent.fill(page.getByLabelText("Command palette search"), ">new thread in.");
    await vi.waitFor(() => expect(rowTitles()).toEqual(["New thread in..."]));
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(rowTitles()).toEqual(["Pied Piper", "Hooli"]));
    await screen.unmount();
  });

  it("falls back to the default project from a thread in an archived project", async () => {
    mocks.activeThread.current = { projectId: ARCHIVED_PROJECT.id };
    seedStore([], [ARCHIVED_PROJECT]);
    const screen = await render(<CommandPalette />);
    await openPalette();

    expect(rowTitles()).toContain("New thread in Pied Piper");
    expect(rowTitles()).not.toContain("New thread in Aviato");
    await screen.unmount();
  });

  it("limits results to actions after >", async () => {
    const screen = await render(<CommandPalette />);
    await openPalette();

    await userEvent.keyboard(">");
    await vi.waitFor(() => expect(groupLabels()).toEqual(["Actions"]));
    expect(rowTitles()).toEqual([
      "New thread in Pied Piper",
      "New thread in...",
      "Add project",
      "Open file picker",
      "Open settings",
      "Virtual Office",
    ]);
    await screen.unmount();
  });

  it("starts a thread through the New thread in... submenu and backs out with Backspace", async () => {
    const screen = await render(<CommandPalette />);
    await openPalette();

    await userEvent.keyboard(">new thread in.");
    await vi.waitFor(() => expect(rowTitles()).toEqual(["New thread in..."]));
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(rowTitles()).toEqual(["Pied Piper", "Hooli"]));
    const input = page.getByLabelText("Command palette search").element() as HTMLInputElement;
    expect(input.value).toBe("");

    await userEvent.keyboard("{Backspace}");
    await vi.waitFor(() => expect(groupLabels()).toEqual(["Actions", "Recent threads"]));

    await userEvent.click(page.getByText("New thread in...", { exact: true }));
    await vi.waitFor(() => expect(rowTitles()).toEqual(["Pied Piper", "Hooli"]));
    await userEvent.keyboard("hooli");
    await vi.waitFor(() => expect(rowTitles()).toEqual(["Hooli"]));
    await userEvent.keyboard("{Enter}");

    await vi.waitFor(() =>
      expect(mocks.handleNewThread).toHaveBeenCalledWith("project-2", { envMode: "local" }),
    );
    await screen.unmount();
  });

  it("stays in the submenu when a held Backspace repeats past the empty query", async () => {
    const screen = await render(<CommandPalette />);
    await openPalette();
    await userEvent.keyboard(">new thread in.");
    await vi.waitFor(() => expect(rowTitles()).toEqual(["New thread in..."]));
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(rowTitles()).toEqual(["Pied Piper", "Hooli"]));

    const input = page.getByLabelText("Command palette search").element();
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Backspace", repeat: true, bubbles: true }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(rowTitles()).toEqual(["Pied Piper", "Hooli"]);
    await screen.unmount();
  });

  it("adds a project from a typed path outside the desktop app", async () => {
    const screen = await render(<CommandPalette />);
    await openPalette();

    await userEvent.keyboard(">add project");
    await vi.waitFor(() => expect(rowTitles()).toEqual(["Add project"]));
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(rows()).toEqual([]));

    await userEvent.keyboard("/repo/new");
    await vi.waitFor(() => expect(rowTitles()).toEqual(["Add /repo/new"]));
    await userEvent.keyboard("{Enter}");

    await vi.waitFor(() => expect(mocks.addProjectFromPath).toHaveBeenCalledWith("/repo/new"));
    await screen.unmount();
  });

  it("keeps the order pinned while open and refreshes it on the next open", async () => {
    const screen = await render(<CommandPalette />);
    await openPalette();
    const threadTitles = () =>
      rowTitles().filter((title) => title === "Fix login" || title === "Compression bench");
    expect(threadTitles()).toEqual(["Fix login", "Compression bench"]);

    useStore.setState((state) => ({
      sidebarThreadsById: {
        ...state.sidebarThreadsById,
        "Compression bench": thread("Compression bench", {
          updatedAt: "2026-03-05T00:00:00.000Z",
        }),
      },
    }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(threadTitles()).toEqual(["Fix login", "Compression bench"]);

    pressPaletteChord();
    await vi.waitFor(() => expect(palette()).toBeNull());
    await openPalette();
    expect(threadTitles()).toEqual(["Compression bench", "Fix login"]);
    await screen.unmount();
  });

  it("keeps the rows and highlight in place when the session starts a turn while open", async () => {
    const liveSession = {
      provider: "claudeAgent" as const,
      status: "ready" as const,
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
      orchestrationStatus: "ready" as const,
    };
    mocks.routeThreadId.current = "live";
    seedStore([
      thread("live", { session: liveSession, updatedAt: "2026-03-03T00:00:00.000Z" }),
      thread("other", { updatedAt: "2026-03-02T00:00:00.000Z" }),
    ]);
    const screen = await render(<CommandPalette />);
    await openPalette();
    expect(rowTitles()).toContain("Restart session");

    await userEvent.keyboard(`{ArrowDown>${rowTitles().indexOf("other")}/}`);
    await vi.waitFor(() => expect(highlighted()).toBe("other"));

    useStore.setState((state) => ({
      sidebarThreadsById: {
        ...state.sidebarThreadsById,
        live: thread("live", {
          session: { ...liveSession, status: "running", orchestrationStatus: "running" },
          updatedAt: "2026-03-03T00:00:00.000Z",
        }),
      },
    }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(rowTitles()).toContain("Restart session");
    expect(highlighted()).toBe("other");

    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledWith({
        to: "/$threadId",
        params: { threadId: "other" },
      }),
    );
    await screen.unmount();
  });

  it("offers Restart session only for an idle live session, and confirms first", async () => {
    mocks.routeThreadId.current = "live";
    seedStore([
      thread("live", {
        session: {
          provider: "claudeAgent",
          status: "ready",
          createdAt: "2026-03-01T00:00:00.000Z",
          updatedAt: "2026-03-01T00:00:00.000Z",
          orchestrationStatus: "ready",
        },
      }),
    ]);
    const screen = await render(<CommandPalette />);
    await openPalette();

    await userEvent.keyboard("restart");
    await vi.waitFor(() => expect(rowTitles()).toEqual(["Restart session"]));
    await userEvent.keyboard("{Enter}");

    await vi.waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(mocks.dispatchCommand).toHaveBeenCalledWith(
        expect.objectContaining({ type: "thread.session.stop", threadId: "live" }),
      ),
    );
    await screen.unmount();
  });

  it("hides Restart session while no session is running", async () => {
    mocks.routeThreadId.current = "idle";
    seedStore([thread("idle")]);
    const screen = await render(<CommandPalette />);
    await openPalette();
    expect(rowTitles()).not.toContain("Restart session");
    await screen.unmount();
  });

  it("scrolls a long list inside the viewport", async () => {
    seedStore(
      Array.from({ length: RECENT_THREAD_LIMIT + 4 }, (_, index) => thread(`Thread ${index}`)),
    );
    const screen = await render(<CommandPalette />);
    await openPalette();

    const popup = palette()!.getBoundingClientRect();
    expect(popup.bottom).toBeLessThanOrEqual(window.innerHeight);
    const viewport = document.querySelector<HTMLElement>(
      '[data-testid="command-palette"] [data-slot="scroll-area-viewport"]',
    )!;
    expect(viewport.scrollHeight).toBeGreaterThan(viewport.clientHeight);
    expect(viewport.getBoundingClientRect().bottom).toBeLessThanOrEqual(popup.bottom);
    await screen.unmount();
  });
});
