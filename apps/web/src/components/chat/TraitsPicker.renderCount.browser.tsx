import "../../index.css";

import { type ServerProviderModel, ThreadId } from "@piedpiper/contracts";
import { type ComponentProps, useCallback, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import {
  type ChatComposerOpenMenu,
  createComposerMenuOpenChangeHandlers,
} from "./composerControlMenu";
import { readPromptUltrathink, TraitsPicker } from "./TraitsPicker";

const menuRenders = vi.hoisted(() => ({ count: 0 }));

vi.mock("~/components/ui/menu", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/components/ui/menu")>();
  function CountingMenu(props: ComponentProps<typeof actual.Menu>) {
    menuRenders.count += 1;
    return <actual.Menu {...props} />;
  }
  return { ...actual, Menu: CountingMenu };
});

const THREAD_ID = ThreadId.makeUnsafe("thread-traits-render-count");
const MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [
        { value: "low", label: "Low" },
        { value: "high", label: "High", isDefault: true },
        { value: "ultrathink", label: "Ultrathink" },
      ],
      supportsFastMode: false,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: ["ultrathink"],
    },
  },
];
const MODEL_OPTIONS = { effort: "high" } as const;

// Mirrors ChatComposer: the prompt lives in the parent, the picker only sees derived ultrathink state.
function ComposerTraitsHarness() {
  // Opted out of the compiler so only stable props, not cached closures, keep the picker from re-rendering.
  "use no memo";
  const [prompt, setPrompt] = useState("");
  const [openMenu, setOpenMenu] = useState<ChatComposerOpenMenu | null>(null);
  const [menuOpenChangeHandlers] = useState(() =>
    createComposerMenuOpenChangeHandlers(setOpenMenu),
  );
  const onPromptEdit = useCallback(
    (edit: (current: string) => string) => setPrompt((current) => edit(current)),
    [],
  );
  return (
    <>
      <input
        aria-label="Prompt"
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
      />
      <TraitsPicker
        provider="claudeAgent"
        threadId={THREAD_ID}
        models={MODELS}
        model="claude-opus-4-6"
        modelOptions={MODEL_OPTIONS}
        promptUltrathink={readPromptUltrathink(prompt)}
        onPromptEdit={onPromptEdit}
        open={openMenu === "effort"}
        onOpenChange={menuOpenChangeHandlers.effort}
      />
    </>
  );
}

describe("TraitsPicker render count", () => {
  it("does not re-render while typing keeps the ultrathink state unchanged", async () => {
    const screen = await render(<ComposerTraitsHarness />);
    await vi.waitFor(() => expect(menuRenders.count).toBeGreaterThan(0));
    const rendersBeforeTyping = menuRenders.count;

    await userEvent.type(page.getByLabelText("Prompt"), "fix the bug");

    await vi.waitFor(() =>
      expect((document.querySelector("input") as HTMLInputElement).value).toBe("fix the bug"),
    );
    expect(menuRenders.count).toBe(rendersBeforeTyping);

    await userEvent.type(page.getByLabelText("Prompt"), " ultrathink");
    await vi.waitFor(() => expect(menuRenders.count).toBeGreaterThan(rendersBeforeTyping));
    await screen.unmount();
  });
});
