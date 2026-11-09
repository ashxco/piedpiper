import "../../index.css";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { ComposerStashMenu } from "./ComposerStashMenu";
import { usePromptStashStore, type PromptStashEntry } from "../../promptStashStore";

const entry: PromptStashEntry = {
  id: "saved",
  prompt: "Review this patch",
  attachments: [],
  terminalContexts: [],
  reviewComments: [],
  modelSelection: { provider: "claudeAgent", model: "claude-opus-4-6" },
  provider: "claudeAgent",
  runtimeMode: "auto",
  interactionMode: "default",
  freshContext: false,
};
afterEach(() => {
  usePromptStashStore.setState({ entries: [] });
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith("piedpiper:prompt-stash:")) localStorage.removeItem(key);
  }
});

it("restores a saved prompt only into an empty composer", async () => {
  usePromptStashStore.setState({ entries: [entry] });
  const onRestore = vi.fn();
  const props = {
    provider: "claudeAgent" as const,
    open: true,
    onOpenChange: () => {},
    disabled: false,
    onStash: vi.fn(),
    onRestore,
    onError: vi.fn(),
  };
  const screen = await render(<ComposerStashMenu {...props} hasContent />);
  const item = screen.getByRole("menuitem", { name: entry.prompt });
  await expect.element(item).toHaveAttribute("aria-disabled", "true");
  await screen.rerender(<ComposerStashMenu {...props} hasContent={false} />);
  await item.click();
  expect(onRestore).toHaveBeenCalledWith(entry);
  await screen.unmount();
});

it("keeps prompts for a different provider out of the current queue", async () => {
  usePromptStashStore.setState({ entries: [entry] });
  const screen = await render(
    <ComposerStashMenu
      provider="codex"
      open
      onOpenChange={() => {}}
      disabled={false}
      hasContent={false}
      onStash={() => {}}
      onRestore={() => {}}
      onError={() => {}}
    />,
  );
  await expect.element(screen.getByRole("menuitem", { name: "No stashed prompts" })).toBeVisible();
  await expect.element(screen.getByText(entry.prompt)).not.toBeInTheDocument();
  await screen.unmount();
});

it("synchronizes saved prompts and deletions between open windows", async () => {
  const frame = document.createElement("iframe");
  frame.srcdoc = `<script type="module">
    import { usePromptStashStore } from "/src/promptStashStore.ts";
    window.stash = usePromptStashStore;
  </script>`;
  document.body.append(frame);
  const peer = () => (frame.contentWindow as Window & { stash?: typeof usePromptStashStore }).stash;
  try {
    await vi.waitFor(() => expect(peer()).toBeDefined());
    usePromptStashStore.getState().add(entry);
    await vi.waitFor(() => expect(peer()?.getState().entries).toEqual([entry]));
    peer()!
      .getState()
      .add({ ...entry, id: "peer", prompt: "Saved in another window" });
    await vi.waitFor(() =>
      expect(
        usePromptStashStore
          .getState()
          .entries.map((item) => item.id)
          .toSorted(),
      ).toEqual(["peer", "saved"]),
    );
    usePromptStashStore.getState().remove(entry.id);
    await vi.waitFor(() =>
      expect(
        peer()
          ?.getState()
          .entries.map((item) => item.id),
      ).toEqual(["peer"]),
    );
    peer()!.getState().remove("peer");
    await vi.waitFor(() => expect(usePromptStashStore.getState().entries).toEqual([]));
  } finally {
    frame.remove();
  }
});
