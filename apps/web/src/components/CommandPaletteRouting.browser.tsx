import "../index.css";

import type { ProjectId, ThreadId } from "@piedpiper/contracts";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { useCommandPaletteStore } from "../commandPaletteStore";
import { useStore } from "../store";
import type { SidebarThreadSummary } from "../types";
import { CommandPalette } from "./CommandPalette";

const initialStoreState = useStore.getState();

function thread(id: string): SidebarThreadSummary {
  return {
    id: id as ThreadId,
    projectId: "project-1" as ProjectId,
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
  };
}

function makeRouter() {
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <CommandPalette />
        <Outlet />
      </>
    ),
  });
  const routeTree = rootRoute.addChildren([
    createRoute({ getParentRoute: () => rootRoute, path: "/" }),
    createRoute({ getParentRoute: () => rootRoute, path: "/$threadId" }),
  ]);
  return createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
}

describe("CommandPalette with the real router", () => {
  afterEach(() => {
    useCommandPaletteStore.getState().setOpen(false);
    useStore.setState(initialStoreState);
  });

  it("moves to the thread chosen from search", async () => {
    useStore.setState({
      projects: [
        {
          id: "project-1" as ProjectId,
          name: "Pied Piper",
          cwd: "/repo/pied-piper",
          defaultModelSelection: null,
          scripts: [],
        },
      ],
      sidebarThreadsById: { "fix-login": thread("fix-login") },
    });
    const router = makeRouter();
    // The generated route tree types this router's parent; the test tree is its own.
    const screen = await render(<RouterProvider router={router as never} />);
    await vi.waitFor(() => expect(router.state.status).toBe("idle"));

    useCommandPaletteStore.getState().setOpen(true);
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(page.getByLabelText("Command palette search").element()),
    );
    await userEvent.keyboard("fix-login{Enter}");

    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/fix-login"));
    await vi.waitFor(() => expect(useCommandPaletteStore.getState().open).toBe(false));
    await screen.unmount();
  });
});
