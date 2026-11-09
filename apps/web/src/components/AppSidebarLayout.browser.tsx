import "../index.css";

import type { ResolvedKeybindingsConfig } from "@piedpiper/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const mocks = vi.hoisted(() => ({ back: vi.fn() }));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useParams: (options: { select: (params: Record<string, string>) => unknown }) =>
    options.select({}),
  useRouter: () => ({ history: { back: mocks.back } }),
}));

vi.mock("~/rpc/serverState", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../rpc/serverState")>()),
  useServerKeybindings: (): ResolvedKeybindingsConfig => [
    {
      command: "navigation.back",
      shortcut: {
        key: "[",
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        modKey: true,
      },
    },
  ],
}));

import { useCommandPaletteStore } from "../commandPaletteStore";
import { useFilePickerStore } from "../filePickerStore";
import { AppShellShortcuts } from "./AppSidebarLayout";
import { SidebarProvider } from "./ui/sidebar";

function pressBack(): KeyboardEvent {
  const isMac = navigator.platform.toLowerCase().includes("mac");
  const event = new KeyboardEvent("keydown", {
    key: "[",
    metaKey: isMac,
    ctrlKey: !isMac,
    bubbles: true,
    cancelable: true,
  });
  window.dispatchEvent(event);
  return event;
}

describe("AppShellShortcuts", () => {
  beforeEach(() => {
    mocks.back.mockClear();
  });

  afterEach(() => {
    useCommandPaletteStore.getState().setOpen(false);
    useFilePickerStore.getState().setOpen(false);
  });

  it("navigates when the palette is closed", async () => {
    const screen = await render(
      <SidebarProvider>
        <AppShellShortcuts />
      </SidebarProvider>,
    );

    expect(pressBack().defaultPrevented).toBe(true);
    expect(mocks.back).toHaveBeenCalledTimes(1);
    await screen.unmount();
  });

  it.each([
    ["palette", () => useCommandPaletteStore.getState().setOpen(true)],
    ["file picker", () => useFilePickerStore.getState().setOpen(true)],
  ])("stands down behind the open %s, still claiming the browser's chord", async (_name, open) => {
    const screen = await render(
      <SidebarProvider>
        <AppShellShortcuts />
      </SidebarProvider>,
    );
    open();

    expect(pressBack().defaultPrevented).toBe(true);
    expect(mocks.back).not.toHaveBeenCalled();
    await screen.unmount();
  });
});
