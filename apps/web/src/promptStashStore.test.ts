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
beforeEach(() => {
  usePromptStashStore.setState({ entries: [] });
});
afterEach(() => vi.unstubAllGlobals());
describe("prompt stash persistence", () => {
  it("preserves context text and settings across storage serialization", () => {
    const setItem = vi.fn();
    vi.stubGlobal("localStorage", { setItem });
    usePromptStashStore.getState().add(entry);
    expect(JSON.parse(setItem.mock.calls[0]![1])).toEqual([entry]);
    expect(usePromptStashStore.getState().entries).toEqual([entry]);
    usePromptStashStore.getState().remove(entry.id);
    expect(usePromptStashStore.getState().entries).toEqual([]);
  });
  it("keeps existing entries when saving or removing fails", () => {
    vi.stubGlobal("localStorage", {
      setItem: () => {
        throw new Error("quota");
      },
    });
    usePromptStashStore.setState({ entries: [entry] });
    expect(() => usePromptStashStore.getState().add({ ...entry, id: "new" })).toThrow("quota");
    expect(() => usePromptStashStore.getState().remove(entry.id)).toThrow("quota");
    expect(usePromptStashStore.getState().entries).toEqual([entry]);
  });
});
