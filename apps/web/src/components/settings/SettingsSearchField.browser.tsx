import "../../index.css";

import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  useLocation,
} from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { SettingsSearchField } from "./SettingsSearchField";
import { isSettingsCloseKey } from "./settingsCloseKey";
import { revealSettingsTarget, useSettingsSearchTarget } from "./useSettingsSearchTarget";

// Mirrors the settings layout: a window listener closes settings on Escape unless handled.
function Layout({ onClose }: { onClose: () => void }) {
  useSettingsSearchTarget();
  const location = useLocation();
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isSettingsCloseKey(event)) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);
  return (
    <div>
      <SettingsSearchField />
      <output data-testid="location">{`${location.pathname}#${location.hash}`}</output>
      <Outlet />
    </div>
  );
}

// Renders its row a few frames late, as a route that is still mounting does.
function GeneralPage() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => requestAnimationFrame(() => setReady(true)));
    return () => cancelAnimationFrame(frame);
  }, []);
  return ready ? <div id="setting-theme">Theme row</div> : null;
}

async function renderField(initialPath: string) {
  const onClose = vi.fn();
  const rootRoute = createRootRoute({ component: () => <Layout onClose={onClose} /> });
  const routes = [
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/settings/general",
      component: GeneralPage,
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/settings/archived",
      component: () => <div>Archived page</div>,
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/settings/keybindings",
      component: () => <div>Keybindings page</div>,
    }),
  ];
  const router = createRouter({
    routeTree: rootRoute.addChildren(routes),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
  await router.load();
  const screen = await render(<RouterProvider router={router as never} />);
  await expect.element(page.getByRole("combobox", { name: "Search settings" })).toBeInTheDocument();
  return { onClose, router, screen };
}

const scrollSpy = vi.spyOn(Element.prototype, "scrollIntoView");

afterEach(() => {
  scrollSpy.mockClear();
  document.body.innerHTML = "";
});

describe("SettingsSearchField", () => {
  it("clears text on Escape without closing settings, and closes once empty", async () => {
    const { onClose, screen } = await renderField("/settings/general");
    const input = page.getByRole("combobox", { name: "Search settings" });

    await input.fill("theme");
    await expect.element(page.getByRole("option", { name: /Theme/ })).toBeInTheDocument();

    await userEvent.keyboard("{Escape}");
    await expect.element(input).toHaveValue("");
    expect(onClose).not.toHaveBeenCalled();

    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
    await screen.unmount();
  });

  it("keeps settings open when Escape cancels an IME composition", async () => {
    const { onClose, screen } = await renderField("/settings/general");
    const input = page.getByRole("combobox", { name: "Search settings" });
    await input.fill("theme");

    input.element().dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        isComposing: true,
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(onClose).not.toHaveBeenCalled();
    await expect.element(input).toHaveValue("theme");
    await screen.unmount();
  });

  it("adds no history entry for a jump within the current tab", async () => {
    const { router, screen } = await renderField("/settings/general");
    const input = page.getByRole("combobox", { name: "Search settings" });
    await expect.element(page.getByText("Theme row")).toBeInTheDocument();
    const entriesBefore = router.history.length;

    await input.fill("theme");
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(scrollSpy).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(page.getByTestId("location").element().textContent).toBe("/settings/general#"),
    );

    expect(router.history.length).toBe(entriesBefore);
    await screen.unmount();
  });

  it("pulses the target under reduced motion, without a smooth scroll", async () => {
    const matchMedia = vi
      .spyOn(window, "matchMedia")
      .mockReturnValue({ matches: true } as MediaQueryList);
    const target = document.createElement("div");
    document.body.append(target);
    const animate = vi.spyOn(target, "animate");

    revealSettingsTarget(target);

    expect(scrollSpy).toHaveBeenCalledWith({ behavior: "auto", block: "center" });
    expect(animate).toHaveBeenCalledOnce();
    matchMedia.mockRestore();
  });

  it("jumps from another tab to a row that renders late, then clears the hash", async () => {
    const { router, screen } = await renderField("/settings/archived");
    const input = page.getByRole("combobox", { name: "Search settings" });

    await input.fill("dark mode");
    await page.getByRole("option", { name: /Theme/ }).click();

    await vi.waitFor(() => expect(scrollSpy).toHaveBeenCalledOnce());
    await vi.waitFor(() => {
      expect(router.state.location.pathname).toBe("/settings/general");
      expect(router.state.location.hash).toBe("");
    });
    await expect.element(input).toHaveValue("");
    await screen.unmount();
  });

  it("reveals the same result again when it is chosen twice", async () => {
    const { screen } = await renderField("/settings/general");
    const input = page.getByRole("combobox", { name: "Search settings" });
    await expect.element(page.getByText("Theme row")).toBeInTheDocument();

    await input.fill("theme");
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(scrollSpy).toHaveBeenCalledTimes(1));
    await vi.waitFor(async () =>
      expect(page.getByTestId("location").element().textContent).toBe("/settings/general#"),
    );

    await input.fill("theme");
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(scrollSpy).toHaveBeenCalledTimes(2));
    await screen.unmount();
  });

  it("moves through results with the arrow keys", async () => {
    const { router, screen } = await renderField("/settings/general");
    await page.getByRole("combobox", { name: "Search settings" }).fill("hotkeys");
    await expect
      .element(page.getByRole("option", { name: /Keyboard shortcuts/ }))
      .toBeInTheDocument();
    await userEvent.keyboard("{ArrowDown}{ArrowUp}{Enter}");
    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/settings/keybindings"));
    await screen.unmount();
  });

  it("says when nothing matches", async () => {
    const { screen } = await renderField("/settings/general");
    await page.getByRole("combobox", { name: "Search settings" }).fill("zzzz");
    await expect.element(page.getByText("No matching settings")).toBeInTheDocument();
    await screen.unmount();
  });
});
