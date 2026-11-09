import "../../index.css";
import "@xterm/xterm/css/xterm.css";

import type { ResolvedKeybindingsConfig, ServerConfig } from "@piedpiper/contracts";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router";
import { Terminal } from "@xterm/xterm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { useCommandPaletteStore } from "../../commandPaletteStore";
import { useFilePickerStore } from "../../filePickerStore";
import {
  createWorkspaceFocusController,
  moveWorkspaceFocus,
  startWorkspaceFocus,
  workspaceAreaProps,
} from "../../lib/workspaceFocus";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { resetServerStateForTests, setServerConfigSnapshot } from "../../rpc/serverState";
import { AppShellShortcuts } from "../AppSidebarLayout";
import { shouldRefocusComposerOnWindowFocus } from "../ChatView.logic";
import { SidebarProvider } from "../ui/sidebar";

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function setup() {
  const root = document.createElement("div");
  document.body.append(root);
  const controller = createWorkspaceFocusController(document);
  cleanups.push(() => {
    controller.dispose();
    root.remove();
  });
  const area = (name: string, order: number) => {
    const element = document.createElement("section");
    element.dataset.workspaceArea = name;
    element.dataset.workspaceOrder = String(order);
    element.tabIndex = -1;
    const button = document.createElement("button");
    button.textContent = name;
    element.append(button);
    root.append(element);
    return { element, button };
  };
  const append = (html: string) => {
    root.insertAdjacentHTML("beforeend", html);
    return root.lastElementChild as HTMLElement;
  };
  return { area, append, controller, root };
}

describe("workspace area focus", () => {
  it("describes an area for the F6 cycle", () => {
    expect(workspaceAreaProps("composer", 2, "Message input")).toEqual({
      "data-workspace-area": "composer",
      "data-workspace-order": 2,
      "aria-label": "Message input",
      role: "region",
      tabIndex: -1,
    });
  });

  it("cycles in workspace order in both directions, independent of DOM order", () => {
    const fixture = setup();
    const panel = fixture.area("panel", 3);
    const sidebar = fixture.area("sidebar", 0);
    const conversation = fixture.area("conversation", 1);
    const composer = fixture.area("composer", 2);
    sidebar.button.focus();
    fixture.controller.move(1);
    // The conversation takes focus itself rather than its first button.
    expect(document.activeElement).toBe(conversation.element);
    fixture.controller.move(1);
    expect(document.activeElement).toBe(composer.button);
    fixture.controller.move(1);
    expect(document.activeElement).toBe(panel.button);
    fixture.controller.move(1);
    expect(document.activeElement).toBe(sidebar.button);
    fixture.controller.move(-1);
    expect(document.activeElement).toBe(panel.button);
  });

  it("skips hidden, inert and collapsed-sidebar areas", () => {
    const fixture = setup();
    const composer = fixture.area("composer", 2);
    const hidden = fixture.area("conversation", 1);
    const inert = fixture.area("terminal", 4);
    const collapsed = fixture.append('<div data-slot="sidebar" data-state="collapsed"></div>');
    const sidebar = fixture.area("sidebar", 0);
    collapsed.append(sidebar.element);
    hidden.element.hidden = true;
    inert.element.inert = true;
    composer.button.focus();
    expect(fixture.controller.move(1)).toBe(true);
    expect(document.activeElement).toBe(composer.button);
  });

  it("restores the last focused control and falls back when it is removed", () => {
    const fixture = setup();
    fixture.area("sidebar", 0);
    const composer = fixture.area("composer", 2);
    const remembered = document.createElement("button");
    remembered.textContent = "remembered";
    composer.element.append(remembered);
    remembered.focus();
    fixture.controller.move(-1);
    fixture.controller.move(1);
    expect(document.activeElement).toBe(remembered);
    fixture.controller.move(-1);
    remembered.remove();
    fixture.controller.move(1);
    expect(document.activeElement).toBe(composer.button);
  });

  it("prefers the active sidebar row and the composer editor over the first button", () => {
    const fixture = setup();
    const sidebar = fixture.area("sidebar", 0);
    const row = document.createElement("div");
    row.tabIndex = 0;
    row.textContent = "Open thread";
    row.dataset.sidebarRow = "thread";
    row.setAttribute("aria-current", "page");
    sidebar.element.append(row);
    const composer = fixture.area("composer", 2);
    const editor = document.createElement("div");
    editor.contentEditable = "true";
    editor.textContent = "draft";
    composer.element.append(editor);
    sidebar.button.blur();
    fixture.controller.move(1);
    expect(document.activeElement).toBe(row);
    fixture.controller.move(1);
    expect(document.activeElement).toBe(editor);
  });

  it("keeps focus inside a dialog or an open popup", () => {
    const fixture = setup();
    fixture.area("sidebar", 0);
    fixture.area("panel", 3);
    const dialog = fixture.append('<div role="alertdialog" tabindex="-1">Confirm</div>');
    dialog.focus();
    expect(fixture.controller.move(1)).toBe(false);
    expect(document.activeElement).toBe(dialog);
    dialog.remove();

    const popup = fixture.append(
      '<div role="listbox" data-slot="select-popup"><button role="option">Choice</button></div>',
    );
    const choice = popup.querySelector("button")!;
    choice.focus();
    expect(fixture.controller.move(1)).toBe(false);
    expect(document.activeElement).toBe(choice);
  });

  it("keeps moving while a closed sheet, notification or unfocused hover popup is on the page", () => {
    const fixture = setup();
    const composer = fixture.area("composer", 2);
    const terminal = fixture.area("terminal", 4);
    fixture.append('<div role="dialog" data-closed="" aria-modal="true">Diff</div>');
    fixture.append('<div role="dialog" aria-modal="false" tabindex="0">Update available</div>');
    fixture.append('<div data-slot="popover-popup">New split terminal</div>');
    composer.button.focus();
    expect(fixture.controller.move(1)).toBe(true);
    expect(document.activeElement).toBe(terminal.button);
  });

  it("brings a restored control back into view inside its own list", () => {
    const fixture = setup();
    const sidebar = fixture.area("sidebar", 0);
    const list = document.createElement("div");
    list.style.cssText = "height: 50px; overflow-y: auto";
    const spacer = document.createElement("div");
    spacer.style.height = "400px";
    const row = document.createElement("button");
    row.textContent = "Last thread";
    list.append(spacer, row);
    sidebar.element.append(list);
    const composer = fixture.area("composer", 2);
    row.focus();
    fixture.controller.move(1);
    expect(document.activeElement).toBe(composer.button);
    list.scrollTop = 0;
    fixture.controller.move(-1);
    expect(document.activeElement).toBe(row);
    expect(list.scrollTop).toBeGreaterThan(0);
  });

  it("does not scroll the conversation to an old control", () => {
    const fixture = setup();
    const conversation = fixture.area("conversation", 1);
    const timeline = document.createElement("div");
    timeline.style.cssText = "height: 50px; overflow-y: auto";
    const copy = document.createElement("button");
    copy.textContent = "Copy";
    const filler = document.createElement("div");
    filler.style.height = "400px";
    timeline.append(copy, filler);
    conversation.element.append(timeline);
    const composer = fixture.area("composer", 2);
    copy.focus();
    fixture.controller.move(1);
    expect(document.activeElement).toBe(composer.button);
    timeline.scrollTop = 300;
    fixture.controller.move(-1);
    expect(document.activeElement).toBe(conversation.element);
    expect(timeline.scrollTop).toBe(300);
  });

  it("does nothing before it is started and after it stops", () => {
    const fixture = setup();
    const sidebar = fixture.area("sidebar", 0);
    fixture.area("composer", 2);
    sidebar.button.focus();
    expect(moveWorkspaceFocus(1)).toBe(false);
    const stop = startWorkspaceFocus();
    expect(moveWorkspaceFocus(1)).toBe(true);
    stop();
    expect(moveWorkspaceFocus(1)).toBe(false);
  });
});

describe("F6 and xterm", () => {
  it("leaves the terminal without writing to it, and returns to its input", async () => {
    const fixture = setup();
    const stop = startWorkspaceFocus();
    cleanups.push(stop);
    const composer = fixture.area("composer", 2);
    const terminalArea = fixture.area("terminal", 4);
    const host = document.createElement("div");
    host.style.cssText = "width: 400px; height: 200px";
    terminalArea.element.append(host);
    const terminal = new Terminal({ cols: 40, rows: 8 });
    cleanups.push(() => terminal.dispose());
    terminal.open(host);
    const written = vi.fn();
    terminal.onData(written);

    // Mirrors the app shell's capture listener.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "F6") return;
      event.preventDefault();
      event.stopPropagation();
      moveWorkspaceFocus(event.shiftKey ? -1 : 1);
    };
    window.addEventListener("keydown", onKeyDown, true);
    cleanups.push(() => window.removeEventListener("keydown", onKeyDown, true));

    composer.button.focus();
    await userEvent.keyboard("{F6}");
    expect(document.activeElement).toBe(terminal.textarea);

    await userEvent.keyboard("{F6}");
    expect(document.activeElement).toBe(composer.button);
    expect(written).not.toHaveBeenCalled();

    await userEvent.keyboard("{Shift>}{F6}{/Shift}");
    expect(document.activeElement).toBe(terminal.textarea);
    expect(written).not.toHaveBeenCalled();
  });
});

describe("window refocus and real focus", () => {
  it("yields a mouse-focused row or area to the composer and keeps a keyboard-focused one", async () => {
    const fixture = setup();
    const area = fixture.append(
      '<section data-workspace-area="conversation" tabindex="-1" style="height: 40px">Chat</section>',
    );
    const clicked = fixture.append(
      '<div data-sidebar-row="clicked" role="button" tabindex="0">Clicked row</div>',
    );
    const tabbed = fixture.append(
      '<div data-sidebar-row="tabbed" role="button" tabindex="0">Tabbed row</div>',
    );

    await userEvent.click(clicked);
    expect(document.activeElement).toBe(clicked);
    expect(shouldRefocusComposerOnWindowFocus(document.activeElement)).toBe(true);

    await userEvent.tab();
    expect(document.activeElement).toBe(tabbed);
    expect(shouldRefocusComposerOnWindowFocus(document.activeElement)).toBe(false);

    await userEvent.click(area);
    expect(document.activeElement).toBe(area);
    expect(shouldRefocusComposerOnWindowFocus(document.activeElement)).toBe(true);

    // Focus moved by key press counts as keyboard focus for an area too.
    await userEvent.keyboard("{Shift}");
    area.focus();
    expect(shouldRefocusComposerOnWindowFocus(document.activeElement)).toBe(false);
  });
});

const f6 = (command: string, shiftKey: boolean) => ({
  command,
  shortcut: { key: "f6", metaKey: false, ctrlKey: false, shiftKey, altKey: false, modKey: false },
});

describe("F6 through the app shell", () => {
  const KEYBINDINGS = [
    f6("workspace.focusNext", false),
    f6("workspace.focusPrevious", true),
  ] as unknown as ResolvedKeybindingsConfig;

  const mountShell = async () => {
    setServerConfigSnapshot({
      keybindings: KEYBINDINGS,
      availableEditors: [],
      providers: [],
      issues: [],
    } as unknown as ServerConfig);
    const rootRoute = createRootRoute({
      component: () => (
        <>
          <AppShellShortcuts />
          <span data-testid="shell-mounted" />
        </>
      ),
    });
    const router = createRouter({
      routeTree: rootRoute,
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    const screen = await render(
      <AppAtomRegistryProvider>
        <SidebarProvider>
          <RouterProvider router={router} />
        </SidebarProvider>
      </AppAtomRegistryProvider>,
    );
    cleanups.push(() => {
      void screen.unmount();
      resetServerStateForTests();
    });
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="shell-mounted"]')).not.toBeNull(),
    );
  };

  it("cycles real areas in both directions, out of the terminal too", async () => {
    await mountShell();
    const root = document.createElement("div");
    document.body.append(root);
    cleanups.push(() => root.remove());
    const area = (name: string, order: number) => {
      const element = document.createElement("section");
      element.dataset.workspaceArea = name;
      element.dataset.workspaceOrder = String(order);
      element.tabIndex = -1;
      const control = document.createElement("button");
      control.textContent = name;
      element.append(control);
      root.append(element);
      return control;
    };
    const composer = area("composer", 2);
    const terminalArea = area("terminal", 4).parentElement!;
    terminalArea.querySelector("button")!.remove();
    const host = document.createElement("div");
    host.style.cssText = "width: 400px; height: 200px";
    terminalArea.append(host);
    const terminal = new Terminal({ cols: 40, rows: 8 });
    cleanups.push(() => terminal.dispose());
    terminal.open(host);
    const written = vi.fn();
    terminal.onData(written);

    composer.focus();
    await userEvent.keyboard("{F6}");
    expect(document.activeElement).toBe(terminal.textarea);
    await userEvent.keyboard("{Shift>}{F6}{/Shift}");
    expect(document.activeElement).toBe(composer);
    expect(written).not.toHaveBeenCalled();
  });

  it("consumes the key without moving focus out of a confirmation dialog", async () => {
    await mountShell();
    const root = document.createElement("div");
    document.body.append(root);
    cleanups.push(() => root.remove());
    root.innerHTML = `
      <section data-workspace-area="composer" data-workspace-order="2" tabindex="-1"><button>Composer</button></section>
      <div role="alertdialog"><button data-testid="cancel">Cancel</button></div>`;
    const cancel = root.querySelector<HTMLElement>('[data-testid="cancel"]')!;
    cancel.focus();
    const event = new KeyboardEvent("keydown", {
      key: "F6",
      bubbles: true,
      cancelable: true,
    });
    cancel.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(cancel);
  });

  it.each([
    ["command palette", useCommandPaletteStore],
    ["file picker", useFilePickerStore],
  ])("leaves focus in the %s, and moves again once it closes", async (_name, surface) => {
    await mountShell();
    const root = document.createElement("div");
    document.body.append(root);
    cleanups.push(() => {
      surface.setState({ open: false });
      root.remove();
    });
    root.innerHTML = `
      <section data-workspace-area="sidebar" data-workspace-order="0" tabindex="-1"><button>Sidebar</button></section>
      <section data-workspace-area="composer" data-workspace-order="2" tabindex="-1"><button data-testid="composer">Composer</button></section>
      <input aria-label="Surface search" />`;
    const search = root.querySelector<HTMLElement>('[aria-label="Surface search"]')!;
    search.focus();
    surface.setState({ open: true });

    const event = new KeyboardEvent("keydown", { key: "F6", bubbles: true, cancelable: true });
    search.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(search);

    surface.setState({ open: false });
    root.querySelector<HTMLElement>('[data-testid="composer"]')!.focus();
    await userEvent.keyboard("{Shift>}{F6}{/Shift}");
    expect(document.activeElement?.textContent).toBe("Sidebar");
  });
});
