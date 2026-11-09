import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThreadId } from "@piedpiper/contracts";
import { usePromptStashStore, type PromptStashEntry } from "./promptStashStore";

const entry: PromptStashEntry = {
  id: "saved",
  prompt: "Review this selection",
  attachments: [],
  terminalContexts: [
    {
      id: "terminal-selection",
      threadId: ThreadId.makeUnsafe("source"),
      createdAt: "2026-11-08",
      terminalId: "t1",
      terminalLabel: "Terminal",
      lineStart: 1,
      lineEnd: 2,
      text: "Keep this output",
    },
  ],
  reviewComments: [],
  provider: "claudeAgent",
  modelSelection: { provider: "claudeAgent", model: "claude-opus-4-6" },
  runtimeMode: "auto",
  interactionMode: "default",
  freshContext: true,
};
const legacyKey = "piedpiper:prompt-stash:v1";
let data: Map<string, string>;
let storage: Storage;
beforeEach(() => {
  data = new Map();
  storage = {
    get length() {
      return data.size;
    },
    key: (index) => [...data.keys()][index] ?? null,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
    clear: () => data.clear(),
  };
  vi.stubGlobal("localStorage", storage);
  usePromptStashStore.setState({ entries: [] });
});
afterEach(() => vi.unstubAllGlobals());

async function openWindow() {
  vi.resetModules();
  return (await import("./promptStashStore")).usePromptStashStore;
}

describe("prompt stash persistence", () => {
  it("preserves attachments, context and settings after reopening", async () => {
    usePromptStashStore.getState().add(entry);
    const reopened = await openWindow();
    expect(reopened.getState().entries).toEqual([entry]);
    reopened.getState().remove(entry.id);
    expect((await openWindow()).getState().entries).toEqual([]);
  });

  it("keeps existing entries when saving or removing fails", () => {
    usePromptStashStore.getState().add(entry);
    vi.spyOn(storage, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    vi.spyOn(storage, "removeItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(() => usePromptStashStore.getState().add({ ...entry, id: "new" })).toThrow("quota");
    expect(() => usePromptStashStore.getState().remove(entry.id)).toThrow("denied");
    expect(usePromptStashStore.getState().entries).toEqual([entry]);
  });

  it("preserves saves from two windows with stale in-memory lists", async () => {
    const first = await openWindow();
    const second = await openWindow();
    expect(first).not.toBe(second);
    first.getState().add({ ...entry, id: "first" });
    second.getState().add({ ...entry, id: "second" });
    expect(
      (await openWindow())
        .getState()
        .entries.map((item) => item.id)
        .toSorted(),
    ).toEqual(["first", "second"]);
    first.getState().remove("first");
    expect((await openWindow()).getState().entries.map((item) => item.id)).toEqual(["second"]);
    second.getState().add({ ...entry, id: "third" });
    expect(
      (await openWindow())
        .getState()
        .entries.map((item) => item.id)
        .toSorted(),
    ).toEqual(["second", "third"]);
  });

  it("preserves interleaved writes even when both windows read before either writes", async () => {
    const first = await openWindow();
    const second = await openWindow();
    const setItem = storage.setItem;
    vi.spyOn(storage, "setItem").mockImplementationOnce((key, value) => {
      second.getState().add({ ...entry, id: "second" });
      setItem(key, value);
    });
    first.getState().add({ ...entry, id: "first" });
    expect(
      (await openWindow())
        .getState()
        .entries.map((item) => item.id)
        .toSorted(),
    ).toEqual(["first", "second"]);
  });

  it("reads legacy prompts and never resurrects a deleted one from another window", async () => {
    data.set(legacyKey, JSON.stringify([entry, { ...entry, id: "other-legacy" }]));
    const first = await openWindow();
    const second = await openWindow();
    expect(first.getState().entries).toHaveLength(2);
    first.getState().remove(entry.id);
    expect(JSON.parse(data.get(legacyKey)!)).toEqual([{ ...entry, id: "other-legacy" }]);
    second.getState().remove(entry.id);
    // A cleanup in another window finishes late with a snapshot that still contained this entry.
    data.set(legacyKey, JSON.stringify([entry, { ...entry, id: "other-legacy" }]));
    second.getState().add({ ...entry, id: "new" });
    second.getState().remove("other-legacy");
    expect((await openWindow()).getState().entries.map((item) => item.id)).toEqual(["new"]);
  });

  it("checks capacity against persisted entries, not a stale window", async () => {
    const first = await openWindow();
    const second = await openWindow();
    for (let index = 0; index < 20; index++) first.getState().add({ ...entry, id: String(index) });
    expect(() => second.getState().add(entry)).toThrow("Restore or delete");
    first.getState().remove("0");
    second.getState().add(entry);
    expect((await openWindow()).getState().entries).toHaveLength(20);
  });

  it("does not overwrite anything when storage cannot be read", () => {
    usePromptStashStore.getState().add(entry);
    vi.spyOn(storage, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    const write = vi.spyOn(storage, "setItem");
    expect(() => usePromptStashStore.getState().add({ ...entry, id: "new" })).toThrow("denied");
    expect(write).not.toHaveBeenCalled();
    expect(usePromptStashStore.getState().entries).toEqual([entry]);
  });
});
