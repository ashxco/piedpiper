import "../../index.css";

import type {
  NativeApi,
  ProjectId,
  ResolvedKeybindingsConfig,
  ServerConfig,
  ThreadId,
} from "@piedpiper/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { __resetNativeApiForTests } from "../../nativeApi";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { resetServerStateForTests, setServerConfigSnapshot } from "../../rpc/serverState";
import { useStore } from "../../store";
import type { Project, SidebarThreadSummary } from "../../types";
import { useUiStateStore, type ThreadSnooze } from "../../uiStateStore";
import Sidebar from "../Sidebar";
import { SidebarProvider } from "../ui/sidebar";
import { snoozeThreadWithUndo } from "./threadSnoozeActions";
import { undoLatestThreadAction } from "./threadUndo";

const PROJECT_ID = "project-1" as ProjectId;
const AWAKE = "thread-awake" as ThreadId;
const SOONER = "thread-sooner" as ThreadId;
const LATER = "thread-later" as ThreadId;

const KEYBINDINGS: ResolvedKeybindingsConfig = [
  {
    command: "thread.jump.1",
    shortcut: {
      key: "1",
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      modKey: true,
    },
  },
];

const FAR_WAKE = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
const NEAR_WAKE = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const SNOOZED_AT = new Date(Date.now() - 60 * 60 * 1000).toISOString();

function snooze(snoozedUntil: string): ThreadSnooze {
  return { snoozedUntil, snoozedAt: SNOOZED_AT, questionPendingAtSnooze: false };
}

function summary(id: ThreadId, updatedAt: string): SidebarThreadSummary {
  return {
    id,
    projectId: PROJECT_ID,
    title: id,
    interactionMode: "default",
    session: null,
    createdAt: "2026-03-04T12:00:00.000Z",
    updatedAt,
    archivedAt: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

async function mountSidebar(initialThreadId: ThreadId) {
  const rootRoute = createRootRoute({ component: () => <Sidebar /> });
  const threadRoute = createRoute({ getParentRoute: () => rootRoute, path: "/$threadId" });
  const router = createRouter({
    routeTree: rootRoute.addChildren([threadRoute]),
    history: createMemoryHistory({ initialEntries: [`/${initialThreadId}`] }),
  });
  const queryClient = new QueryClient();
  const screen = await render(
    <AppAtomRegistryProvider>
      <QueryClientProvider client={queryClient}>
        <SidebarProvider>
          <RouterProvider router={router} />
        </SidebarProvider>
      </QueryClientProvider>
    </AppAtomRegistryProvider>,
  );
  await vi.waitFor(() =>
    expect(document.querySelector(`[data-testid="snoozed-shelf-${PROJECT_ID}"]`)).not.toBeNull(),
  );
  return {
    screen,
    router,
    routeThreadId: () => router.state.location.pathname.slice(1),
  };
}

const row = (threadId: ThreadId) =>
  document.querySelector<HTMLElement>(`[data-testid="thread-row-${threadId}"]`);
const shelf = () =>
  document.querySelector<HTMLElement>(`[data-testid="snoozed-shelf-${PROJECT_ID}"]`);

describe("Sidebar snooze wiring", () => {
  let mounted: Awaited<ReturnType<typeof mountSidebar>> | null = null;

  beforeEach(() => {
    window.nativeApi = {
      git: { status: vi.fn(async () => ({ branch: "main", pr: null })) },
    } as unknown as NativeApi;
    __resetNativeApiForTests();
    setServerConfigSnapshot({
      keybindings: KEYBINDINGS,
      availableEditors: [],
      providers: [],
      issues: [],
    } as unknown as ServerConfig);
    useStore.setState({
      projects: [
        {
          id: PROJECT_ID,
          name: "Repo",
          cwd: "/repo",
          scripts: [],
          archivedAt: null,
        } as unknown as Project,
      ],
      threadIdsByProjectId: { [PROJECT_ID]: [AWAKE, LATER, SOONER] },
      sidebarThreadsById: {
        [AWAKE]: summary(AWAKE, "2026-03-04T12:00:00.000Z"),
        // Newest in the list, so sort order alone would put it first in the shelf.
        [LATER]: summary(LATER, "2026-03-06T12:00:00.000Z"),
        [SOONER]: summary(SOONER, "2026-03-05T12:00:00.000Z"),
      },
    });
    useUiStateStore.setState({
      snoozedThreadsById: { [LATER]: snooze(FAR_WAKE), [SOONER]: snooze(NEAR_WAKE) },
    });
  });

  afterEach(async () => {
    await mounted?.screen.unmount();
    mounted = null;
    delete window.nativeApi;
    __resetNativeApiForTests();
    resetServerStateForTests();
    useStore.setState({ projects: [], threadIdsByProjectId: {}, sidebarThreadsById: {} });
    useUiStateStore.setState({ snoozedThreadsById: {} });
    document.body.innerHTML = "";
  });

  it("counts the shelf, keeps its rows collapsed, and orders them soonest wake first", async () => {
    mounted = await mountSidebar(AWAKE);
    expect(shelf()?.textContent).toContain("Snoozed (2)");
    expect(row(AWAKE)).not.toBeNull();
    expect(row(SOONER)).toBeNull();

    shelf()!.click();
    await vi.waitFor(() => expect(row(SOONER)).not.toBeNull());
    const shelfRows = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid^="thread-row-"]'),
    ).map((element) => element.dataset.testid);
    expect(shelfRows).toEqual([
      `thread-row-${AWAKE}`,
      `thread-row-${SOONER}`,
      `thread-row-${LATER}`,
    ]);
  });

  it("gives a jump shortcut to awake threads only", async () => {
    // The route holds the shelf open; sort order alone would give the newest thread the shortcut.
    mounted = await mountSidebar(SOONER);
    await vi.waitFor(() => expect(row(LATER)).not.toBeNull());
    const isMac = /mac/i.test(navigator.platform);
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "1",
        metaKey: isMac,
        ctrlKey: !isMac,
        bubbles: true,
        cancelable: true,
      }),
    );
    await vi.waitFor(() => expect(mounted?.routeThreadId()).toBe(AWAKE));
  });

  it("clears the snooze once the user sends to the thread", async () => {
    mounted = await mountSidebar(AWAKE);
    useStore.setState((state) => ({
      sidebarThreadsById: {
        ...state.sidebarThreadsById,
        [SOONER]: {
          ...state.sidebarThreadsById[SOONER]!,
          latestUserMessageAt: new Date().toISOString(),
        },
      },
    }));
    await vi.waitFor(() =>
      expect(useUiStateStore.getState().snoozedThreadsById[SOONER]).toBeUndefined(),
    );
    expect(row(SOONER)).not.toBeNull();
    expect(shelf()?.textContent).toContain("Snoozed (1)");
  });

  it("wakes the row for a pending approval and marks the wake seen when opened", async () => {
    mounted = await mountSidebar(AWAKE);
    useStore.setState((state) => ({
      sidebarThreadsById: {
        ...state.sidebarThreadsById,
        [SOONER]: { ...state.sidebarThreadsById[SOONER]!, hasPendingApprovals: true },
      },
    }));
    await vi.waitFor(() => expect(row(SOONER)).not.toBeNull());
    expect(document.querySelector(`[data-testid="thread-woke-${SOONER}"]`)).not.toBeNull();

    await mounted.router.navigate({ to: "/$threadId", params: { threadId: SOONER } } as never);
    await vi.waitFor(() =>
      expect(useUiStateStore.getState().snoozedThreadsById[SOONER]?.wakeSeenAt).toBeDefined(),
    );
    await mounted.router.navigate({ to: "/$threadId", params: { threadId: AWAKE } } as never);
    await vi.waitFor(() => expect(mounted?.routeThreadId()).toBe(AWAKE));
    expect(document.querySelector(`[data-testid="thread-woke-${SOONER}"]`)).toBeNull();
  });

  it("moves on from the open thread when it is snoozed, and Undo brings it back", async () => {
    useUiStateStore.setState({ snoozedThreadsById: { [SOONER]: snooze(NEAR_WAKE) } });
    mounted = await mountSidebar(AWAKE);
    snoozeThreadWithUndo(AWAKE, NEAR_WAKE);
    await vi.waitFor(() => expect(mounted?.routeThreadId()).toBe(LATER));
    expect(useUiStateStore.getState().snoozedThreadsById[AWAKE]).toBeDefined();

    expect(undoLatestThreadAction()).toBe(true);
    await vi.waitFor(() => expect(mounted?.routeThreadId()).toBe(AWAKE));
    expect(useUiStateStore.getState().snoozedThreadsById[AWAKE]).toBeUndefined();
  });

  it("stays on the open thread when every other one is snoozed", async () => {
    useUiStateStore.setState({
      snoozedThreadsById: { [SOONER]: snooze(NEAR_WAKE), [LATER]: snooze(FAR_WAKE) },
    });
    mounted = await mountSidebar(AWAKE);
    snoozeThreadWithUndo(AWAKE, NEAR_WAKE);
    await vi.waitFor(() => expect(shelf()?.textContent).toContain("Snoozed (3)"));
    expect(mounted.routeThreadId()).toBe(AWAKE);
    expect(row(AWAKE)).not.toBeNull();
    undoLatestThreadAction();
  });
});
