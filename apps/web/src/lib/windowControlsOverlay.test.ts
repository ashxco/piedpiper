import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { syncDocumentWindowControlsOverlayClass } from "./windowControlsOverlay";

function stubDocument() {
  const classes = new Set<string>();
  vi.stubGlobal("document", {
    documentElement: {
      classList: {
        toggle: (name: string, force: boolean) => {
          if (force) classes.add(name);
          else classes.delete(name);
        },
      },
    },
  });
  return classes;
}

function stubOverlay(visible: boolean) {
  const listeners = new Set<EventListener>();
  const overlay = {
    visible,
    addEventListener: (_type: string, listener: EventListener) => listeners.add(listener),
    removeEventListener: (_type: string, listener: EventListener) => listeners.delete(listener),
    emit: () => {
      for (const listener of listeners) listener(new Event("geometrychange"));
    },
    listenerCount: () => listeners.size,
  };
  vi.stubGlobal("navigator", { windowControlsOverlay: overlay });
  return overlay;
}

describe("syncDocumentWindowControlsOverlayClass", () => {
  let classes: Set<string>;

  beforeEach(() => {
    classes = stubDocument();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not add the class where the overlay API is missing", () => {
    vi.stubGlobal("navigator", {});
    syncDocumentWindowControlsOverlayClass();
    expect(classes.has("wco")).toBe(false);
  });

  it("adds the class while the overlay is visible", () => {
    stubOverlay(true);
    syncDocumentWindowControlsOverlayClass();
    expect(classes.has("wco")).toBe(true);
  });

  it("follows geometry changes and stops after cleanup", () => {
    const overlay = stubOverlay(false);
    const cleanup = syncDocumentWindowControlsOverlayClass();
    expect(classes.has("wco")).toBe(false);

    overlay.visible = true;
    overlay.emit();
    expect(classes.has("wco")).toBe(true);

    cleanup();
    expect(overlay.listenerCount()).toBe(0);
  });
});
