import "../../index.css";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { useSidebarVisibilityAnnouncer } from "../../hooks/useSidebarVisibilityAnnouncer";
import { ANNOUNCE_FOCUS_SETTLE_MS } from "../../lib/announce";
import { SidebarProvider, useSidebar } from "../ui/sidebar";

function Toggles() {
  useSidebarVisibilityAnnouncer();
  const { open, setOpen, toggleSidebar } = useSidebar();
  return (
    <>
      <button type="button" onClick={toggleSidebar}>
        toggle
      </button>
      <button type="button" aria-pressed={open} onClick={() => setOpen(!open)}>
        set-open
      </button>
    </>
  );
}

const spoken = () =>
  Array.from(document.querySelectorAll("[data-announcer]"), (region) => region.textContent).join(
    "",
  );
const settle = () => new Promise((resolve) => setTimeout(resolve, ANNOUNCE_FOCUS_SETTLE_MS + 50));

describe("useSidebarVisibilityAnnouncer", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(async () => {
    await page.viewport(1280, 800);
  });

  it("announces desktop toggles but not the initial state", async () => {
    await page.viewport(1280, 800);
    await render(
      <SidebarProvider>
        <Toggles />
      </SidebarProvider>,
    );
    await settle();
    expect(spoken()).toBe("");

    await page.getByRole("button", { name: "toggle" }).click();
    await vi.waitFor(() => expect(spoken()).toBe("Sidebar hidden"));
    await page.getByRole("button", { name: "toggle" }).click();
    await vi.waitFor(() => expect(spoken()).toBe("Sidebar shown"));
  });

  it("stays silent on mobile", async () => {
    await page.viewport(400, 800);
    const spokenBefore = spoken();
    const screen = await render(
      <SidebarProvider>
        <Toggles />
      </SidebarProvider>,
    );
    await page.getByRole("button", { name: "toggle" }).click();
    await page.getByRole("button", { name: "set-open" }).click();
    expect(
      screen.container.querySelector('button[aria-pressed="false"]')?.textContent?.trim(),
    ).toBe("set-open");
    await settle();
    expect(spoken()).toBe(spokenBefore);
  });
});
