import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { removeLocalStorageItem } from "~/hooks/useLocalStorage";
import {
  persistSidebarOpen,
  readStoredSidebarOpen,
  SidebarContent,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuSubButton,
  SidebarProvider,
  useSidebar,
} from "./sidebar";

function renderSidebarButton(className?: string) {
  return renderToStaticMarkup(
    <SidebarProvider>
      <SidebarMenuButton className={className}>Projects</SidebarMenuButton>
    </SidebarProvider>,
  );
}

describe("sidebar interactive cursors", () => {
  it("uses a pointer cursor for menu buttons by default", () => {
    const html = renderSidebarButton();

    expect(html).toContain('data-slot="sidebar-menu-button"');
    expect(html).toContain("cursor-pointer");
  });

  it("lets project drag handles override the default pointer cursor", () => {
    const html = renderSidebarButton("cursor-grab");

    expect(html).toContain("cursor-grab");
    expect(html).not.toContain("cursor-pointer");
  });

  it("uses a pointer cursor for menu actions", () => {
    const html = renderToStaticMarkup(
      <SidebarMenuAction aria-label="Create thread">
        <span>+</span>
      </SidebarMenuAction>,
    );

    expect(html).toContain('data-slot="sidebar-menu-action"');
    expect(html).toContain("cursor-pointer");
  });

  it("uses a pointer cursor for submenu buttons", () => {
    const html = renderToStaticMarkup(
      <SidebarMenuSubButton render={<button type="button" />}>Show more</SidebarMenuSubButton>,
    );

    expect(html).toContain('data-slot="sidebar-menu-sub-button"');
    expect(html).toContain("cursor-pointer");
  });
});

describe("sidebar content scrolling", () => {
  it("opts out of scroll anchoring so a pinned row does not move the viewport", () => {
    const html = renderToStaticMarkup(<SidebarContent>Threads</SidebarContent>);

    expect(html).toContain("[overflow-anchor:none]");
  });
});

describe("sidebar open state persistence", () => {
  const storageKey = "test_sidebar_open";

  function SidebarStateProbe() {
    const { state } = useSidebar();
    return <span data-state={state} />;
  }

  function renderWithStorageKey(key: string | undefined) {
    return renderToStaticMarkup(
      <SidebarProvider defaultOpen {...(key ? { storageKey: key } : {})}>
        <SidebarStateProbe />
      </SidebarProvider>,
    );
  }

  it("restores a persisted collapsed state on mount", () => {
    persistSidebarOpen(storageKey, false);
    try {
      expect(readStoredSidebarOpen(storageKey)).toBe(false);
      expect(renderWithStorageKey(storageKey)).toContain('data-state="collapsed"');
    } finally {
      removeLocalStorageItem(storageKey);
    }
  });

  it("falls back to defaultOpen when nothing is stored or no key is given", () => {
    removeLocalStorageItem(storageKey);
    expect(readStoredSidebarOpen(storageKey)).toBeNull();
    expect(renderWithStorageKey(storageKey)).toContain('data-state="expanded"');
    expect(renderWithStorageKey(undefined)).toContain('data-state="expanded"');
  });
});
