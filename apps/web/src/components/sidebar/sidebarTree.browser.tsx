import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import { installSidebarTree } from "../../lib/sidebarTree";

function setup() {
  const root = document.createElement("div");
  document.body.append(root);
  let dispose: (() => void) | undefined;
  const row = (id: string, parent?: string) => {
    const element = document.createElement("button");
    element.dataset.sidebarRow = id;
    if (parent) element.dataset.sidebarParent = parent;
    element.textContent = id;
    root.append(element);
    return element;
  };
  cleanups.push(() => {
    dispose?.();
    root.remove();
  });
  return {
    root,
    row,
    install: () => {
      dispose = installSidebarTree(root);
    },
  };
}

function press(target: HTMLElement, key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("sidebar keyboard navigation", () => {
  it("moves focus without activating rows, clamps at the ends, and keeps rows in the Tab order", () => {
    const tree = setup();
    const first = tree.row("first");
    const second = tree.row("second");
    const last = tree.row("last");
    const activate = vi.fn();
    tree.root.addEventListener("click", activate);
    tree.install();
    first.focus();
    press(first, "ArrowDown");
    expect(document.activeElement).toBe(second);
    press(second, "End");
    expect(document.activeElement).toBe(last);
    press(last, "ArrowDown");
    expect(document.activeElement).toBe(last);
    press(last, "Home");
    expect(document.activeElement).toBe(first);
    press(first, "ArrowUp");
    expect(document.activeElement).toBe(first);
    expect(activate).not.toHaveBeenCalled();
    expect([first.tabIndex, second.tabIndex, last.tabIndex]).toEqual([0, 0, 0]);
  });

  it("expands a group before entering its first child and returns to the parent", () => {
    const tree = setup();
    const group = tree.row("project");
    group.setAttribute("aria-expanded", "false");
    group.addEventListener("click", () => {
      const expanded = group.getAttribute("aria-expanded") === "true";
      group.setAttribute("aria-expanded", String(!expanded));
      if (expanded) tree.root.querySelector('[data-sidebar-row="thread"]')?.remove();
      else tree.row("thread", "project");
    });
    tree.install();
    group.focus();
    press(group, "ArrowRight");
    expect(group.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(group);
    press(group, "ArrowRight");
    const child = document.activeElement as HTMLElement;
    expect(child.dataset.sidebarRow).toBe("thread");
    press(child, "ArrowLeft");
    expect(document.activeElement).toBe(group);
    press(group, "ArrowLeft");
    expect(group.getAttribute("aria-expanded")).toBe("false");
  });

  it("leaves modified arrows, rename inputs and inner buttons alone", () => {
    const tree = setup();
    const first = tree.row("first");
    const second = tree.row("second");
    const inner = document.createElement("input");
    second.append(inner);
    const action = document.createElement("button");
    first.after(action);
    tree.install();

    first.focus();
    expect(press(first, "ArrowDown", { shiftKey: true }).defaultPrevented).toBe(false);
    expect(press(first, "ArrowDown", { metaKey: true }).defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(first);

    inner.focus();
    expect(press(inner, "ArrowUp").defaultPrevented).toBe(false);
    expect(press(inner, "Home").defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(inner);

    action.focus();
    expect(press(action, "ArrowDown").defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(action);
  });

  it("skips disabled rows and leaves other keys to the row", () => {
    const tree = setup();
    const first = tree.row("first");
    tree.row("loading").disabled = true;
    const third = tree.row("third");
    tree.install();
    first.focus();
    press(first, "ArrowDown");
    expect(document.activeElement).toBe(third);
    expect(press(third, "Enter").defaultPrevented).toBe(false);
  });

  it("follows a focused row that remounted, and keeps the scroll position", async () => {
    const tree = setup();
    Object.assign(tree.root.style, { height: "100px", overflow: "auto" });
    const moving = tree.row("moving");
    for (let index = 0; index < 20; index++) tree.row(`row-${index}`).style.display = "block";
    tree.install();
    moving.focus();
    moving.remove();
    const remounted = tree.row("moving");
    await vi.waitFor(() => expect(document.activeElement).toBe(remounted));
    expect(tree.root.scrollTop).toBe(0);
  });

  it("falls back to the parent and then a neighbour when the focused row is gone", async () => {
    const tree = setup();
    const parent = tree.row("project");
    const child = tree.row("thread", "project");
    const other = tree.row("other");
    tree.install();
    child.focus();
    child.remove();
    await vi.waitFor(() => expect(document.activeElement).toBe(parent));

    other.focus();
    other.remove();
    await vi.waitFor(() => expect(document.activeElement).toBe(parent));
  });

  it("does not pull focus back after a click outside the rows", async () => {
    const tree = setup();
    const first = tree.row("first");
    tree.install();
    const text = document.createElement("p");
    text.textContent = "Chat text";
    document.body.append(text);
    cleanups.push(() => text.remove());
    const spacer = document.createElement("div");
    spacer.textContent = "Empty list space";
    tree.root.append(spacer);
    for (const target of [text, spacer]) {
      first.focus();
      await userEvent.click(target);
      expect(document.activeElement).toBe(document.body);
      tree.row(`second-${target.tagName}`);
      await Promise.resolve();
      expect(document.activeElement).toBe(document.body);
    }
  });
});
