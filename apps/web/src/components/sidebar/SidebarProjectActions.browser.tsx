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
import { userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { __resetNativeApiForTests } from "../../nativeApi";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { resetServerStateForTests, setServerConfigSnapshot } from "../../rpc/serverState";
import { useStore } from "../../store";
import type { Project, SidebarThreadSummary } from "../../types";
import Sidebar from "../Sidebar";
import { toastManager } from "../ui/toast";
import { SidebarProvider } from "../ui/sidebar";

const PROJECT_ID = "project-actions" as ProjectId;
const THREAD_A = "thread-actions-a" as ThreadId;
const THREAD_B = "thread-actions-b" as ThreadId;
const CLIENT_SETTINGS_KEY = "piedpiper:client-settings:v1";
const KEYBINDINGS: ResolvedKeybindingsConfig = [];

function summary(id: ThreadId): SidebarThreadSummary {
  return {
    id,
    projectId: PROJECT_ID,
    title: id,
    interactionMode: "default",
    session: null,
    createdAt: "2026-03-04T12:00:00.000Z",
    updatedAt: "2026-03-04T12:00:00.000Z",
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

const projectTitle = () =>
  document.querySelector<HTMLButtonElement>(
    `[data-sidebar-row][aria-expanded]:not([data-testid^="snoozed-shelf-"])`,
  );

const openRemove = (title: HTMLElement) =>
  title.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));

const pointer = (type: string, clientX: number, clientY: number) =>
  new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    isPrimary: true,
    button: 0,
    clientX,
    clientY,
  });

describe("Sidebar project actions", () => {
  let unmount: (() => Promise<void>) | null = null;
  const dispatchCommand = vi.fn(async (_command: { type: string; threadId?: ThreadId }) => ({
    sequence: 1,
  }));

  async function mountSidebar() {
    const rootRoute = createRootRoute({ component: () => <Sidebar /> });
    const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/" });
    const router = createRouter({
      routeTree: rootRoute.addChildren([indexRoute]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    const screen = await render(
      <AppAtomRegistryProvider>
        <QueryClientProvider client={new QueryClient()}>
          <SidebarProvider>
            <RouterProvider router={router} />
          </SidebarProvider>
        </QueryClientProvider>
      </AppAtomRegistryProvider>,
    );
    unmount = () => screen.unmount();
    await vi.waitFor(() => expect(projectTitle()).not.toBeNull());
    return projectTitle()!;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    dispatchCommand.mockImplementation(async () => ({ sequence: 1 }));
    window.nativeApi = {
      git: { status: vi.fn(async () => ({ branch: "main", pr: null })) },
      contextMenu: { show: vi.fn(async () => "delete") },
      dialogs: { confirm: vi.fn(async () => true) },
      orchestration: { dispatchCommand },
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
          cwd: "/repo-actions",
          scripts: [],
          archivedAt: null,
        } as unknown as Project,
      ],
      threadIdsByProjectId: { [PROJECT_ID]: [THREAD_A, THREAD_B] },
      sidebarThreadsById: { [THREAD_A]: summary(THREAD_A), [THREAD_B]: summary(THREAD_B) },
    });
  });

  afterEach(async () => {
    await unmount?.();
    unmount = null;
    delete window.nativeApi;
    __resetNativeApiForTests();
    resetServerStateForTests();
    useStore.setState({ projects: [], threadIdsByProjectId: {}, sidebarThreadsById: {} });
    localStorage.removeItem(CLIENT_SETTINGS_KEY);
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  const dispatchedTypes = () => dispatchCommand.mock.calls.map(([command]) => command.type);

  describe("right-click Remove", () => {
    it("deletes the threads and then the project", async () => {
      openRemove(await mountSidebar());
      await vi.waitFor(() =>
        expect(dispatchedTypes()).toEqual(["thread.delete", "thread.delete", "project.delete"]),
      );
    });

    it("keeps the project and reports the error when a thread fails to delete", async () => {
      const toast = vi.spyOn(toastManager, "add").mockReturnValue("toast");
      dispatchCommand.mockImplementation(async (command) => {
        if (command.threadId === THREAD_A) throw new Error("thread stuck");
        return { sequence: 1 };
      });
      openRemove(await mountSidebar());

      await vi.waitFor(() =>
        expect(toast).toHaveBeenCalledWith({
          type: "error",
          title: 'Failed to remove "Repo"',
          description: "thread stuck",
        }),
      );
      expect(dispatchedTypes()).toEqual(["thread.delete", "thread.delete"]);
    });
  });

  it("lets the first arrow key toggle a project after a mouse drag", async () => {
    localStorage.setItem(
      CLIENT_SETTINGS_KEY,
      JSON.stringify({ sidebarProjectSortOrder: "manual" }),
    );
    const title = await mountSidebar();
    const { left, top } = title.getBoundingClientRect();
    title.dispatchEvent(pointer("pointerdown", left + 4, top + 4));
    document.dispatchEvent(pointer("pointermove", left + 4, top + 30));
    // The sensor only reports a drag end once the drag start has rendered.
    await new Promise((resolve) => setTimeout(resolve, 50));
    document.dispatchEvent(pointer("pointerup", left + 4, top + 30));
    // dnd-kit keeps swallowing clicks at document capture for a moment after the release.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const before = title.getAttribute("aria-expanded");
    title.focus();
    await userEvent.keyboard(before === "true" ? "{ArrowLeft}" : "{ArrowRight}");
    await vi.waitFor(() =>
      expect(projectTitle()?.getAttribute("aria-expanded")).toBe(
        before === "true" ? "false" : "true",
      ),
    );
  });
});
