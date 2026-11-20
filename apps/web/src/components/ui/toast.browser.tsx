import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { AnchoredToastProvider, ToastProvider } from "./toast";

describe("toast viewports", () => {
  it("exposes one Notifications landmark when both toast providers mount", async () => {
    const rootRoute = createRootRoute({
      component: () => (
        <ToastProvider>
          <AnchoredToastProvider>{null}</AnchoredToastProvider>
        </ToastProvider>
      ),
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([
        createRoute({ getParentRoute: () => rootRoute, path: "/" }),
      ]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    const screen = await render(<RouterProvider router={router} />);

    const notifications = page.getByRole("region", { name: "Notifications" });
    await expect.element(notifications.first()).toBeInTheDocument();
    expect(
      notifications.elements(),
      "only the corner toast viewport should be a Notifications landmark",
    ).toHaveLength(1);
    await expect.element(notifications).toHaveAttribute("data-slot", "toast-viewport");

    const anchoredViewport = document.querySelector("[data-slot=toast-viewport-anchored]");
    expect(anchoredViewport).not.toBeNull();
    expect(anchoredViewport).toHaveAttribute("aria-live", "polite");
    await screen.unmount();
  });
});
