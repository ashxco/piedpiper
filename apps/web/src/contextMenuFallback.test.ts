import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { showContextMenuFallback } from "./contextMenuFallback";

type Listener = (event: { type: string; key?: string; preventDefault: () => void }) => void;

class FakeElement {
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  style: Record<string, string> = {};
  className = "";
  disabled = false;
  type = "";
  textContent = "";
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  private readonly listeners = new Map<string, Listener[]>();

  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  }

  focus() {
    setActiveElement(this);
  }

  get isConnected() {
    return this.parent !== null;
  }

  appendChild(child: FakeElement) {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  remove() {
    if (!this.parent) return;
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }

  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  removeEventListener(type: string, listener: Listener) {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((existing) => existing !== listener),
    );
  }

  dispatch(type: string, key?: string) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ type, ...(key !== undefined ? { key } : {}), preventDefault: () => undefined });
    }
  }

  getBoundingClientRect() {
    return { right: 0, bottom: 0, width: 0, height: 0 };
  }
}

let body: FakeElement;
let documentElement: FakeElement;
let activeElement: FakeElement | null = null;
let pendingFrame: (() => void) | undefined;

function setActiveElement(element: FakeElement | null) {
  activeElement = element;
}

beforeEach(() => {
  body = new FakeElement();
  documentElement = new FakeElement();
  activeElement = null;
  vi.stubGlobal("document", {
    body,
    get activeElement() {
      return activeElement;
    },
    createElement: () => new FakeElement(),
    addEventListener: documentElement.addEventListener.bind(documentElement),
    removeEventListener: documentElement.removeEventListener.bind(documentElement),
  });
  vi.stubGlobal("window", { innerWidth: 1_000, innerHeight: 1_000 });
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
    pendingFrame = callback;
    return 0;
  });
});

afterEach(() => {
  pendingFrame = undefined;
  vi.unstubAllGlobals();
});

function findButton(label: string): FakeElement {
  const button = body.children
    .flatMap((child) => child.children)
    .find((child) => child.textContent === label);
  if (!button) throw new Error(`Expected a "${label}" button`);
  return button;
}

describe("showContextMenuFallback", () => {
  it("ignores a click from the gesture that opened the menu", async () => {
    const selection = showContextMenuFallback([{ id: "rename", label: "Rename" }]);
    const renameButton = findButton("Rename");

    renameButton.dispatch("click");
    expect(body.children).toHaveLength(2);

    pendingFrame?.();
    renameButton.dispatch("click");

    await expect(selection).resolves.toBe("rename");
    expect(body.children).toHaveLength(0);
  });

  it("ignores an overlay mousedown until the menu has rendered", async () => {
    const selection = showContextMenuFallback([{ id: "delete", label: "Delete" }]);
    const overlay = body.children[0]!;

    overlay.dispatch("mousedown");
    expect(body.children).toHaveLength(2);

    pendingFrame?.();
    overlay.dispatch("mousedown");

    await expect(selection).resolves.toBeNull();
  });

  it("is a keyboard menu: focuses items, moves with arrows and restores focus", async () => {
    const opener = new FakeElement();
    body.appendChild(opener);
    opener.focus();
    const selection = showContextMenuFallback([
      { id: "rename", label: "Rename" },
      { id: "pin", label: "Pin", disabled: true },
      { id: "delete", label: "Delete" },
    ]);
    const menu = body.children.find((child) => child.attributes.role === "menu");
    expect(menu).toBeDefined();
    expect(findButton("Rename").attributes.role).toBe("menuitem");
    expect(activeElement).toBe(findButton("Rename"));

    documentElement.dispatch("keydown", "ArrowDown");
    expect(activeElement).toBe(findButton("Delete"));
    documentElement.dispatch("keydown", "ArrowDown");
    expect(activeElement).toBe(findButton("Rename"));
    documentElement.dispatch("keydown", "End");
    expect(activeElement).toBe(findButton("Delete"));
    documentElement.dispatch("keydown", "Home");
    expect(activeElement).toBe(findButton("Rename"));

    documentElement.dispatch("keydown", "Escape");
    await expect(selection).resolves.toBeNull();
    expect(activeElement).toBe(opener);
  });
});
