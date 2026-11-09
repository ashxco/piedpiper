import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { Schema } from "effect";

import {
  getLocalStorageItem,
  removeLocalStorageItem,
  setLocalStorageItem,
} from "~/hooks/useLocalStorage";
import {
  persistSidebarOpen,
  readStoredSidebarOpen,
  Sidebar,
  SidebarContent,
  SidebarProvider,
  SidebarRail,
  useSidebar,
} from "./sidebar";

const STORAGE_KEY = "test_sidebar_open_browser";

function SidebarToggleProbe() {
  const { state, openMobile, toggleSidebar } = useSidebar();
  return (
    <button
      type="button"
      data-state={state}
      data-open-mobile={String(openMobile)}
      onClick={toggleSidebar}
    >
      Toggle sidebar
    </button>
  );
}

function renderSidebar() {
  return render(
    <SidebarProvider defaultOpen storageKey={STORAGE_KEY}>
      <SidebarToggleProbe />
    </SidebarProvider>,
  );
}

afterEach(() => {
  removeLocalStorageItem(STORAGE_KEY);
});

describe("SidebarProvider open state persistence", () => {
  it("persists a desktop toggle and restores it after remount", async () => {
    await page.viewport(1200, 800);
    removeLocalStorageItem(STORAGE_KEY);
    const first = await renderSidebar();
    const toggle = page.getByRole("button", { name: "Toggle sidebar" });
    await expect.element(toggle).toHaveAttribute("data-state", "expanded");

    await userEvent.click(toggle);

    await expect.element(toggle).toHaveAttribute("data-state", "collapsed");
    expect(readStoredSidebarOpen(STORAGE_KEY)).toBe(false);

    await first.unmount();
    await renderSidebar();
    await expect
      .element(page.getByRole("button", { name: "Toggle sidebar" }))
      .toHaveAttribute("data-state", "collapsed");
  });

  it("leaves the stored desktop state alone when toggling on mobile", async () => {
    await page.viewport(400, 800);
    persistSidebarOpen(STORAGE_KEY, true);
    await renderSidebar();
    const toggle = page.getByRole("button", { name: "Toggle sidebar" });
    await expect.element(toggle).toHaveAttribute("data-open-mobile", "false");

    await userEvent.click(toggle);

    await expect.element(toggle).toHaveAttribute("data-open-mobile", "true");
    expect(readStoredSidebarOpen(STORAGE_KEY)).toBe(true);
  });
});

function sidebarWrapper() {
  return document.querySelector('[data-slot="sidebar-wrapper"]');
}

describe("SidebarProvider mobileBreakpoint", () => {
  function renderWithBreakpoint() {
    return render(
      <SidebarProvider defaultOpen storageKey={STORAGE_KEY} mobileBreakpoint={848}>
        <SidebarToggleProbe />
      </SidebarProvider>,
    );
  }

  it("uses sheet mode below a custom breakpoint wider than md", async () => {
    await page.viewport(820, 800);
    await renderWithBreakpoint();
    const toggle = page.getByRole("button", { name: "Toggle sidebar" });
    const wrapper = sidebarWrapper;
    expect(wrapper()?.getAttribute("data-sidebar-mobile")).toBe("true");

    await userEvent.click(toggle);

    await expect.element(toggle).toHaveAttribute("data-open-mobile", "true");
    await expect.element(toggle).toHaveAttribute("data-state", "expanded");
  });

  it("closes an open sheet when the window widens past the breakpoint", async () => {
    await page.viewport(820, 800);
    await renderWithBreakpoint();
    const toggle = page.getByRole("button", { name: "Toggle sidebar" });
    await userEvent.click(toggle);
    await expect.element(toggle).toHaveAttribute("data-open-mobile", "true");

    await page.viewport(1200, 800);

    await expect.element(toggle).toHaveAttribute("data-open-mobile", "false");
    expect(
      document.querySelector('[data-slot="sidebar-wrapper"]')?.getAttribute("data-sidebar-mobile"),
    ).toBe("false");
  });
});

function FocusFixture({ open }: { open: boolean }) {
  return (
    <SidebarProvider open={open}>
      <Sidebar collapsible="offcanvas">
        <button type="button">Thread row</button>
      </Sidebar>
      <button type="button" data-sidebar="trigger" style={{ display: "none" }}>
        Hidden header toggle
      </button>
      <button type="button" data-sidebar="trigger">
        External toggle
      </button>
      <button type="button">Content control</button>
    </SidebarProvider>
  );
}

function sidebarRoot(): HTMLElement {
  const node = document.querySelector<HTMLElement>('[data-slot="sidebar"]');
  if (!node) throw new Error("Missing sidebar root");
  return node;
}

describe("collapsed offcanvas sidebar focus", () => {
  it("makes the collapsed sidebar inert and moves focus to the outside toggle", async () => {
    await page.viewport(1200, 800);
    const screen = await render(<FocusFixture open />);
    const row = page.getByRole("button", { name: "Thread row" }).element() as HTMLElement;
    row.focus();
    expect(document.activeElement).toBe(row);
    expect(sidebarRoot().hasAttribute("inert")).toBe(false);

    await screen.rerender(<FocusFixture open={false} />);

    expect(sidebarRoot().hasAttribute("inert")).toBe(true);
    expect(document.activeElement).toBe(
      page.getByRole("button", { name: "External toggle" }).element(),
    );

    await screen.rerender(<FocusFixture open />);

    expect(sidebarRoot().hasAttribute("inert")).toBe(false);
    row.focus();
    expect(document.activeElement).toBe(row);
  });

  it("leaves focus in the main content when the sidebar collapses", async () => {
    await page.viewport(1200, 800);
    const screen = await render(<FocusFixture open />);
    const content = page.getByRole("button", { name: "Content control" }).element() as HTMLElement;
    content.focus();

    await screen.rerender(<FocusFixture open={false} />);

    expect(document.activeElement).toBe(content);
  });
});

describe("SidebarRail double-click width reset", () => {
  const WIDTH_KEY = "test_sidebar_width_browser";

  afterEach(() => {
    removeLocalStorageItem(WIDTH_KEY);
  });

  it("clears the stored width and restores the default without collapsing", async () => {
    await page.viewport(1200, 800);
    setLocalStorageItem(WIDTH_KEY, 420, Schema.Finite);
    const onResize = vi.fn();
    await render(
      <SidebarProvider defaultOpen>
        <Sidebar collapsible="offcanvas" resizable={{ storageKey: WIDTH_KEY, onResize }}>
          <SidebarRail />
        </Sidebar>
      </SidebarProvider>,
    );
    const wrapper = document.querySelector<HTMLElement>('[data-slot="sidebar-wrapper"]');
    await expect.poll(() => wrapper?.style.getPropertyValue("--sidebar-width")).toBe("420px");

    await userEvent.dblClick(page.getByRole("button", { name: "Resize Sidebar" }));

    expect(getLocalStorageItem(WIDTH_KEY, Schema.Finite)).toBeNull();
    expect(wrapper?.style.getPropertyValue("--sidebar-width")).toBe("19rem");
    expect(onResize).toHaveBeenLastCalledWith(304);
    expect(document.querySelector('[data-slot="sidebar"]')?.getAttribute("data-state")).toBe(
      "expanded",
    );
  });
});

const DRAG_WIDTH_KEY = "test_sidebar_drag_width_browser";

function DragFixture({
  open = true,
  onResize,
}: {
  open?: boolean;
  onResize?: (width: number) => void;
}) {
  return (
    <SidebarProvider open={open}>
      <Sidebar
        collapsible="offcanvas"
        resizable={{ storageKey: DRAG_WIDTH_KEY, ...(onResize ? { onResize } : {}) }}
      >
        <SidebarRail />
      </Sidebar>
    </SidebarProvider>
  );
}

function query(slot: string): HTMLElement {
  const node = document.querySelector<HTMLElement>(`[data-slot="${slot}"]`);
  if (!node) throw new Error(`Missing ${slot}`);
  return node;
}

function firePointer(
  type: string,
  clientX: number,
  target: Element = query("sidebar-rail"),
  pointerId = 1,
) {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: type === "pointerup" ? 0 : 1,
      clientX,
      pointerId,
      pointerType: "mouse",
    }),
  );
}

describe("SidebarRail drag resize", () => {
  afterEach(() => {
    removeLocalStorageItem(DRAG_WIDTH_KEY);
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
  });

  it("restyles only the sidebar during a drag and commits the release position", async () => {
    await page.viewport(1200, 800);
    await render(<DragFixture />);
    const wrapper = query("sidebar-wrapper");
    const startWidth = query("sidebar-container").getBoundingClientRect().width;
    const before = wrapper.style.getPropertyValue("--sidebar-width");

    firePointer("pointerdown", 300);
    expect(document.body.style.cursor).toBe("col-resize");
    firePointer("pointermove", 340);
    await expect.poll(() => query("sidebar-container").style.width).toBe(`${startWidth + 40}px`);
    expect(query("sidebar-gap").style.width).toBe(`${startWidth + 40}px`);
    expect(wrapper.style.getPropertyValue("--sidebar-width")).toBe(before);

    // Released before the next frame: the stored width still matches the release point.
    firePointer("pointermove", 360);
    firePointer("pointerup", 380);

    expect(wrapper.style.getPropertyValue("--sidebar-width")).toBe(`${startWidth + 80}px`);
    expect(getLocalStorageItem(DRAG_WIDTH_KEY, Schema.Finite)).toBe(startWidth + 80);
    expect(query("sidebar-container").style.width).toBe("");
    expect(query("sidebar-gap").style.width).toBe("");
    expect(document.body.style.cursor).toBe("");
    expect(document.body.style.userSelect).toBe("");
  });

  it("ignores a second pointerdown while a drag is active", async () => {
    await page.viewport(1200, 800);
    await render(<DragFixture />);
    const startWidth = query("sidebar-container").getBoundingClientRect().width;

    firePointer("pointerdown", 300);
    firePointer("pointerdown", 360);
    firePointer("pointerup", 320);

    expect(getLocalStorageItem(DRAG_WIDTH_KEY, Schema.Finite)).toBe(startWidth + 20);
  });

  it("ends the drag and clears the body styles when the window loses focus", async () => {
    await page.viewport(1200, 800);
    await render(<DragFixture />);

    firePointer("pointerdown", 300);
    expect(document.body.style.cursor).toBe("col-resize");
    window.dispatchEvent(new Event("blur"));

    expect(document.body.style.cursor).toBe("");
    expect(document.body.style.userSelect).toBe("");
    expect(query("sidebar-container").style.width).toBe("");
  });

  it("keeps the newest pointer position when the window blurs before the next frame", async () => {
    await page.viewport(1200, 800);
    await render(<DragFixture />);
    const startWidth = query("sidebar-container").getBoundingClientRect().width;

    firePointer("pointerdown", 300);
    firePointer("pointermove", 360);
    window.dispatchEvent(new Event("blur"));

    expect(getLocalStorageItem(DRAG_WIDTH_KEY, Schema.Finite)).toBe(startWidth + 60);
  });

  it("ends the drag once when pointer capture is lost", async () => {
    await page.viewport(1200, 800);
    const onResize = vi.fn();
    await render(<DragFixture onResize={onResize} />);
    const startWidth = query("sidebar-container").getBoundingClientRect().width;

    firePointer("pointerdown", 300);
    firePointer("pointermove", 330);
    firePointer("lostpointercapture", 330);

    expect(document.body.style.cursor).toBe("");
    expect(document.body.style.userSelect).toBe("");
    expect(query("sidebar-container").style.width).toBe("");
    expect(query("sidebar-gap").style.width).toBe("");
    expect(onResize).toHaveBeenCalledTimes(1);
    expect(onResize).toHaveBeenCalledWith(startWidth + 30);
  });

  it("undoes the drag setup when pointer capture cannot be taken", async () => {
    await page.viewport(1200, 800);
    const onResize = vi.fn();
    await render(<DragFixture onResize={onResize} />);

    // No active pointer has this id, so setPointerCapture throws.
    firePointer("pointerdown", 300, query("sidebar-rail"), 4242);

    expect(document.body.style.cursor).toBe("");
    expect(query("sidebar-container").style.width).toBe("");
    expect(query("sidebar-container").style.transitionDuration).toBe("");
    window.dispatchEvent(new Event("blur"));
    expect(onResize).not.toHaveBeenCalled();
  });

  it("cancels an active drag when the sidebar collapses", async () => {
    await page.viewport(1200, 800);
    const screen = await render(<DragFixture />);
    const wrapper = query("sidebar-wrapper");
    const before = wrapper.style.getPropertyValue("--sidebar-width");

    firePointer("pointerdown", 300);
    firePointer("pointermove", 360);
    await expect.poll(() => query("sidebar-container").style.width).not.toBe("");

    await screen.rerender(<DragFixture open={false} />);

    expect(query("sidebar-container").style.width).toBe("");
    expect(query("sidebar-gap").style.width).toBe("");
    expect(wrapper.style.getPropertyValue("--sidebar-width")).toBe(before);
    expect(getLocalStorageItem(DRAG_WIDTH_KEY, Schema.Finite)).toBeNull();
    expect(document.body.style.cursor).toBe("");
  });
});

function LandmarkFixture() {
  return (
    <SidebarProvider defaultOpen>
      <Sidebar collapsible="offcanvas" role="navigation" aria-label="Threads">
        <SidebarContent>
          <button type="button">Thread row</button>
        </SidebarContent>
      </Sidebar>
      <SidebarToggleProbe />
    </SidebarProvider>
  );
}

describe("Sidebar accessibility", () => {
  it("exposes the desktop sidebar as a navigation landmark without an extra tab stop", async () => {
    await page.viewport(1200, 800);
    await render(<LandmarkFixture />);

    await expect.element(page.getByRole("navigation", { name: "Threads" })).toBeInTheDocument();
    const viewport = document.querySelector(
      '[data-slot="sidebar"] [data-slot="scroll-area-viewport"]',
    );
    expect(viewport?.getAttribute("tabindex")).toBe("-1");
  });

  it("passes the landmark props to the mobile sidebar element", async () => {
    await page.viewport(400, 800);
    await render(<LandmarkFixture />);

    await userEvent.click(page.getByRole("button", { name: "Toggle sidebar" }));

    await expect.element(page.getByRole("navigation", { name: "Threads" })).toBeInTheDocument();
  });
});
