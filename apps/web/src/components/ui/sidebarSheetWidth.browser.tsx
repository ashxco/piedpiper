import "../../index.css";

import { afterEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { useState } from "react";

import { removeLocalStorageItem } from "~/hooks/useLocalStorage";
import { Sidebar, SidebarProvider, useSidebar } from "./sidebar";

const STORAGE_KEY = "test_sidebar_sheet_width";

function SheetContent() {
  const [wide, setWide] = useState(false);
  return (
    <button type="button" onClick={() => setWide(true)}>
      {wide ? "x".repeat(400) : "Grow"}
    </button>
  );
}

function OpenSheetButton() {
  const { setOpenMobile } = useSidebar();
  return (
    <button type="button" onClick={() => setOpenMobile(true)}>
      Open sheet
    </button>
  );
}

async function openSheet() {
  const screen = await render(
    <SidebarProvider defaultOpen storageKey={STORAGE_KEY} mobileBreakpoint={848}>
      <OpenSheetButton />
      <Sidebar>
        <SheetContent />
      </Sidebar>
    </SidebarProvider>,
  );
  await userEvent.click(page.getByRole("button", { name: "Open sheet" }));
  await expect.element(page.getByRole("button", { name: "Grow" })).toBeVisible();
  return screen;
}

function sheetWidth(): number {
  const sheet = document.querySelector('[data-slot="sidebar"][data-mobile="true"]');
  if (!sheet) throw new Error("Expected the sidebar sheet");
  return sheet.getBoundingClientRect().width;
}

afterEach(() => {
  removeLocalStorageItem(STORAGE_KEY);
});

describe("narrow-window sidebar sheet", () => {
  it("leaves a gap beside the sheet on a small window", async () => {
    await page.viewport(360, 800);
    const { unmount } = await openSheet();
    expect(sheetWidth()).toBe(360 - 12);
    await unmount();
  });

  it("caps the sheet width just below the breakpoint", async () => {
    await page.viewport(820, 800);
    const { unmount } = await openSheet();
    expect(sheetWidth()).toBe(384);
    await unmount();
  });

  it("keeps its width as the content grows", async () => {
    await page.viewport(600, 800);
    const { unmount } = await openSheet();
    const before = sheetWidth();

    await userEvent.click(page.getByRole("button", { name: "Grow" }));
    await expect.element(page.getByRole("button", { name: /^x+$/ })).toBeVisible();

    expect(sheetWidth()).toBe(before);
    await unmount();
  });
});
