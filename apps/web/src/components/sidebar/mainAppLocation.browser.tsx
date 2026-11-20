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

import {
  MainAppLocationTracker,
  resetMainAppLocationForTests,
  useNavigateToMainApp,
} from "./mainAppLocation";

function CloseSettings() {
  const navigateToMainApp = useNavigateToMainApp();
  return (
    <button type="button" onClick={() => void navigateToMainApp()}>
      Close settings
    </button>
  );
}

function makeRouter() {
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <MainAppLocationTracker />
        <Outlet />
      </>
    ),
  });
  const routeTree = rootRoute.addChildren([
    createRoute({ getParentRoute: () => rootRoute, path: "/" }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/settings/general",
      component: CloseSettings,
    }),
    createRoute({ getParentRoute: () => rootRoute, path: "/$threadId" }),
  ]);
  return createRouter({ routeTree, history: createMemoryHistory({ initialEntries: ["/"] }) });
}

describe("closing Settings", () => {
  afterEach(() => resetMainAppLocationForTests());

  it("leaves no stop on Settings for history back or forward", async () => {
    const router = makeRouter();
    await render(<RouterProvider router={router} />);
    const at = (pathname: string) =>
      vi.waitFor(() => expect(router.state.location.pathname).toBe(pathname));

    await router.navigate({ to: "/$threadId", params: { threadId: "thread-one" } });
    await router.navigate({ to: "/$threadId", params: { threadId: "thread-two" } });
    await router.navigate({ to: "/settings/general" });
    await userEvent.click(page.getByRole("button", { name: "Close settings" }));
    await at("/thread-two");

    router.history.forward();
    await at("/thread-two");
    router.history.back();
    await at("/thread-one");
    router.history.forward();
    await at("/thread-two");
    router.history.forward();
    await at("/thread-two");
  });
});
