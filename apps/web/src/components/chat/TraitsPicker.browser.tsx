import "../../index.css";

import {
  type ModelSelection,
  ClaudeModelOptions,
  CodexModelOptions,
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  type ServerProvider,
  ThreadId,
} from "@piedpiper/contracts";
import { page } from "vitest/browser";
import { useCallback } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { TraitsPicker } from "./TraitsPicker";
import {
  COMPOSER_DRAFT_STORAGE_KEY,
  ComposerThreadDraftState,
  useComposerDraftStore,
  useComposerThreadDraft,
  useEffectiveComposerModelState,
} from "../../composerDraftStore";
import { DEFAULT_CLIENT_SETTINGS } from "@piedpiper/contracts/settings";

// ── Claude TraitsPicker tests ─────────────────────────────────────────

const CLAUDE_THREAD_ID = ThreadId.makeUnsafe("thread-claude-traits");
const TEST_PROVIDERS: ReadonlyArray<ServerProvider> = [
  {
    provider: "codex",
    enabled: true,
    installed: true,
    version: "0.1.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [
      {
        slug: "gpt-5.4",
        name: "GPT-5.4",
        isCustom: false,
        capabilities: {
          reasoningEffortLevels: [
            { value: "xhigh", label: "Extra High" },
            { value: "high", label: "High", isDefault: true },
          ],
          supportsFastMode: true,
          supportsThinkingToggle: false,
          contextWindowOptions: [],
          promptInjectedEffortLevels: [],
        },
      },
    ],
  },
  {
    provider: "claudeAgent",
    enabled: true,
    installed: true,
    version: "0.1.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [
      {
        slug: "claude-opus-4-6",
        name: "Claude Opus 4.6",
        isCustom: false,
        capabilities: {
          reasoningEffortLevels: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High", isDefault: true },
            { value: "max", label: "Max" },
            { value: "ultrathink", label: "Ultrathink" },
          ],
          supportsFastMode: true,
          supportsThinkingToggle: false,
          contextWindowOptions: [],
          promptInjectedEffortLevels: ["ultrathink"],
        },
      },
      {
        slug: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        isCustom: false,
        capabilities: {
          reasoningEffortLevels: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High", isDefault: true },
            { value: "ultrathink", label: "Ultrathink" },
          ],
          supportsFastMode: false,
          supportsThinkingToggle: false,
          contextWindowOptions: [],
          promptInjectedEffortLevels: ["ultrathink"],
        },
      },
      {
        slug: "claude-sonnet-5-5",
        name: "Claude Sonnet 5.5",
        isCustom: false,
        capabilities: {
          reasoningEffortLevels: [
            { value: "medium", label: "Medium" },
            { value: "high", label: "High", isDefault: true },
          ],
          supportsFastMode: false,
          supportsThinkingToggle: false,
          contextWindowOptions: [],
          promptInjectedEffortLevels: [],
          supportsUltracode: true,
        },
      },
      {
        slug: "claude-haiku-4-5",
        name: "Claude Haiku 4.5",
        isCustom: false,
        capabilities: {
          reasoningEffortLevels: [],
          supportsFastMode: false,
          supportsThinkingToggle: true,
          contextWindowOptions: [],
          promptInjectedEffortLevels: [],
        },
      },
    ],
  },
];

function ClaudeTraitsPickerHarness(props: {
  model: string;
  fallbackModelSelection: ModelSelection | null;
  triggerVariant?: "ghost" | "outline";
}) {
  const prompt = useComposerThreadDraft(CLAUDE_THREAD_ID).prompt;
  const setPrompt = useComposerDraftStore((store) => store.setPrompt);
  const { modelOptions, selectedModel } = useEffectiveComposerModelState({
    threadId: CLAUDE_THREAD_ID,
    providers: TEST_PROVIDERS,
    selectedProvider: "claudeAgent",
    threadModelSelection: props.fallbackModelSelection,
    projectModelSelection: null,
    settings: {
      ...DEFAULT_SERVER_SETTINGS,
      ...DEFAULT_CLIENT_SETTINGS,
    },
  });
  const handlePromptChange = useCallback(
    (nextPrompt: string) => {
      setPrompt(CLAUDE_THREAD_ID, nextPrompt);
    },
    [setPrompt],
  );

  return (
    <TraitsPicker
      provider="claudeAgent"
      models={TEST_PROVIDERS[1]!.models}
      threadId={CLAUDE_THREAD_ID}
      model={selectedModel ?? props.model}
      prompt={prompt}
      modelOptions={modelOptions?.claudeAgent}
      onPromptChange={handlePromptChange}
      triggerVariant={props.triggerVariant}
    />
  );
}

async function mountClaudePicker(props?: {
  model?: string;
  prompt?: string;
  options?: ClaudeModelOptions;
  fallbackModelOptions?: {
    effort?: "low" | "medium" | "high" | "max" | "ultrathink";
    thinking?: boolean;
    fastMode?: boolean;
  } | null;
  skipDraftModelOptions?: boolean;
  triggerVariant?: "ghost" | "outline";
}) {
  const model = props?.model ?? "claude-opus-4-6";
  const claudeOptions = !props?.skipDraftModelOptions ? props?.options : undefined;
  const draftsByThreadId: Record<ThreadId, ComposerThreadDraftState> = {
    [CLAUDE_THREAD_ID]: {
      prompt: props?.prompt ?? "",
      images: [],
      nonPersistedImageIds: [],
      persistedAttachments: [],
      terminalContexts: [],
      modelSelectionByProvider: props?.skipDraftModelOptions
        ? {}
        : {
            claudeAgent: {
              provider: "claudeAgent",
              model,
              ...(claudeOptions && Object.keys(claudeOptions).length > 0
                ? { options: claudeOptions }
                : {}),
            },
          },
      activeProvider: "claudeAgent",
      runtimeMode: null,
      interactionMode: null,
    },
  };
  useComposerDraftStore.setState({
    draftsByThreadId,
    draftThreadsByThreadId: {},
    projectDraftThreadIdByProjectId: {},
  });
  const host = document.createElement("div");
  document.body.append(host);
  const fallbackModelSelection =
    props?.fallbackModelOptions !== undefined
      ? ({
          provider: "claudeAgent",
          model,
          ...(props.fallbackModelOptions ? { options: props.fallbackModelOptions } : {}),
        } satisfies ModelSelection)
      : null;
  const screen = await render(
    <ClaudeTraitsPickerHarness
      model={model}
      fallbackModelSelection={fallbackModelSelection}
      {...(props?.triggerVariant ? { triggerVariant: props.triggerVariant } : {})}
    />,
    { container: host },
  );

  const cleanup = async () => {
    await screen.unmount();
    host.remove();
  };

  return {
    [Symbol.asyncDispose]: cleanup,
    cleanup,
  };
}

describe("TraitsPicker (Claude)", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
      stickyModelSelectionByProvider: {},
    });
  });

  it("shows fast mode controls for Opus", async () => {
    await using _ = await mountClaudePicker();

    await page.getByRole("button").click();

    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain("Fast Mode");
      expect(text).toContain("off");
      expect(text).toContain("on");
    });
  });

  it("hides fast mode controls for non-Opus models", async () => {
    await using _ = await mountClaudePicker({ model: "claude-sonnet-4-6" });

    await page.getByRole("button").click();

    await vi.waitFor(() => {
      expect(document.body.textContent ?? "").not.toContain("Fast Mode");
    });
  });

  it("offers Ultracode with a token warning on a supporting model", async () => {
    await using _ = await mountClaudePicker({ model: "claude-sonnet-5-5" });

    await page.getByRole("button").click();

    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain("Ultracode");
      expect(text).toContain("far more tokens");
    });
    expect(document.querySelector("button")?.textContent).not.toContain("Ultracode");
  });

  it("hides Ultracode on an unsupported model even when the draft has it on", async () => {
    await using _ = await mountClaudePicker({
      model: "claude-opus-4-6",
      options: { effort: "high", ultracode: true },
    });

    expect(document.querySelector("button")?.textContent).not.toContain("Ultracode");
    await page.getByRole("button").click();

    await vi.waitFor(() => {
      expect(document.body.textContent ?? "").toContain("Fast Mode");
    });
    expect(document.body.textContent ?? "").not.toContain("far more tokens");
  });

  it("keeps the effort and shows Ultracode in the trigger after turning it on", async () => {
    await using _ = await mountClaudePicker({
      model: "claude-sonnet-5-5",
      options: { effort: "medium" },
    });

    await page.getByRole("button").click();
    await page.getByRole("menuitemradio", { name: "on" }).click();

    expect(
      useComposerDraftStore.getState().stickyModelSelectionByProvider.claudeAgent,
    ).toMatchObject({ options: { effort: "medium", ultracode: true } });
    await vi.waitFor(() => {
      expect(document.querySelector("button")?.textContent).toContain("Medium · Ultracode");
    });
  });

  it("turns Ultracode off without changing the effort", async () => {
    await using _ = await mountClaudePicker({
      model: "claude-sonnet-5-5",
      options: { effort: "medium", ultracode: true },
    });

    expect(document.querySelector("button")?.textContent).toContain("Ultracode");
    await page.getByRole("button").click();
    await page.getByRole("menuitemradio", { name: "off" }).click();

    expect(
      useComposerDraftStore.getState().stickyModelSelectionByProvider.claudeAgent,
    ).toMatchObject({ options: { effort: "medium", ultracode: false } });
  });

  it("shows only the provided effort options", async () => {
    await using _ = await mountClaudePicker({
      model: "claude-sonnet-4-6",
    });

    await page.getByRole("button").click();

    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain("Low");
      expect(text).toContain("Medium");
      expect(text).toContain("High");
      expect(text).not.toContain("Max");
      expect(text).toContain("Ultrathink");
    });
  });

  it("shows a th  inking on/off dropdown for Haiku", async () => {
    await using _ = await mountClaudePicker({
      model: "claude-haiku-4-5",
      options: { thinking: true },
    });

    await vi.waitFor(() => {
      expect(document.body.textContent ?? "").toContain("Thinking On");
    });
    await page.getByRole("button").click();

    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain("Thinking");
      expect(text).toContain("On (default)");
      expect(text).toContain("Off");
    });
  });

  it("shows prompt-controlled Ultrathink state with selectable effort controls", async () => {
    await using _ = await mountClaudePicker({
      model: "claude-opus-4-6",
      options: { effort: "high" },
      prompt: "Ultrathink:\nInvestigate this",
    });

    await vi.waitFor(() => {
      expect(document.body.textContent ?? "").toContain("Ultrathink");
      expect(document.body.textContent ?? "").not.toContain("Ultrathink · Prompt");
    });
    await page.getByRole("button").click();

    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain("Effort");
      expect(text).not.toContain("ultrathink");
    });
  });

  it("warns when ultrathink appears in prompt body text", async () => {
    await using _ = await mountClaudePicker({
      model: "claude-opus-4-6",
      options: { effort: "high" },
      prompt: "Ultrathink:\nplease ultrathink about this problem",
    });

    await page.getByRole("button").click();

    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain(
        'Your prompt contains "ultrathink" in the text. Remove it to change effort.',
      );
    });
  });

  it("persists sticky claude model options when traits change", async () => {
    await using _ = await mountClaudePicker({
      model: "claude-opus-4-6",
      options: { effort: "medium", fastMode: false },
    });

    await page.getByRole("button").click();
    await page.getByRole("menuitemradio", { name: "Max" }).click();

    expect(
      useComposerDraftStore.getState().stickyModelSelectionByProvider.claudeAgent,
    ).toMatchObject({
      provider: "claudeAgent",
      options: {
        effort: "max",
      },
    });
  });

  it("closes the menu after picking an option", async () => {
    await using _ = await mountClaudePicker({
      model: "claude-opus-4-6",
      options: { effort: "medium", fastMode: false },
    });

    await page.getByRole("button").click();
    await page.getByRole("menuitemradio", { name: "High" }).click();

    await vi.waitFor(() => {
      expect(document.querySelector('[role="menuitemradio"]')).toBeNull();
    });
  });

  it("edits the live prompt through onPromptEdit without receiving the prompt", async () => {
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
    });
    const onPromptEdit = vi.fn<(edit: (prompt: string) => string) => void>();
    const screen = await render(
      <TraitsPicker
        provider="claudeAgent"
        models={TEST_PROVIDERS[1]!.models}
        threadId={CLAUDE_THREAD_ID}
        model="claude-opus-4-6"
        modelOptions={{ effort: "high" }}
        promptUltrathink="prefix"
        onPromptEdit={onPromptEdit}
      />,
    );
    await vi.waitFor(() => expect(document.body.textContent ?? "").toContain("Ultrathink"));

    await page.getByRole("button").click();
    await page.getByRole("menuitemradio", { name: "Low" }).click();

    expect(onPromptEdit).toHaveBeenCalledTimes(1);
    const edit = onPromptEdit.mock.calls[0]![0];
    expect(edit("Ultrathink:\nFix the latest bug")).toBe("Fix the latest bug");
    await screen.unmount();
  });

  it("disables effort changes when promptUltrathink reports the word in the body", async () => {
    const screen = await render(
      <TraitsPicker
        provider="claudeAgent"
        models={TEST_PROVIDERS[1]!.models}
        threadId={CLAUDE_THREAD_ID}
        model="claude-opus-4-6"
        modelOptions={{ effort: "high" }}
        promptUltrathink="body"
        onPromptEdit={vi.fn()}
      />,
    );

    await page.getByRole("button").click();
    await vi.waitFor(() => {
      expect(document.body.textContent ?? "").toContain(
        'Your prompt contains "ultrathink" in the text. Remove it to change effort.',
      );
    });
    await screen.unmount();
  });

  it("accepts outline trigger styling", async () => {
    await using _ = await mountClaudePicker({
      triggerVariant: "outline",
    });

    const button = document.querySelector("button");
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error("Expected traits trigger button to be rendered.");
    }
    expect(button.className).toContain("border-input");
    expect(button.className).toContain("bg-popover");
  });
});

// ── Codex TraitsPicker tests ──────────────────────────────────────────

// The fixture model, not DEFAULT_MODEL_BY_PROVIDER: the picker renders nothing for a
// model that is absent from the provider's model list.
const CODEX_TEST_MODEL = TEST_PROVIDERS[0]!.models[0]!.slug;

async function mountCodexPicker(props: {
  model?: string;
  options?: CodexModelOptions;
  models?: ReadonlyArray<ServerProvider["models"][number]>;
}) {
  const threadId = ThreadId.makeUnsafe("thread-codex-traits");
  const model = props.model ?? CODEX_TEST_MODEL;
  const draftsByThreadId: Record<ThreadId, ComposerThreadDraftState> = {
    [threadId]: {
      prompt: "",
      images: [],
      nonPersistedImageIds: [],
      persistedAttachments: [],
      terminalContexts: [],
      modelSelectionByProvider: {
        codex: {
          provider: "codex",
          model,
          ...(props.options ? { options: props.options } : {}),
        },
      },
      activeProvider: "codex",
      runtimeMode: null,
      interactionMode: null,
    },
  };

  useComposerDraftStore.setState({
    draftsByThreadId,
    draftThreadsByThreadId: {},
    projectDraftThreadIdByProjectId: {
      [ProjectId.makeUnsafe("project-codex-traits")]: threadId,
    },
  });
  const host = document.createElement("div");
  document.body.append(host);
  const screen = await render(
    <TraitsPicker
      provider="codex"
      models={props.models ?? TEST_PROVIDERS[0]!.models}
      threadId={threadId}
      model={model}
      prompt=""
      modelOptions={props.options}
      onPromptChange={() => {}}
    />,
    { container: host },
  );

  const cleanup = async () => {
    await screen.unmount();
    host.remove();
  };

  return {
    [Symbol.asyncDispose]: cleanup,
    cleanup,
  };
}

const triggerText = () => document.querySelector("button")?.textContent ?? "";

const compactIconSvg = () => document.querySelector("[data-composer-control-compact-icon] svg")!;

describe("TraitsPicker icon-only trigger", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  const opus = TEST_PROVIDERS[1]!.models[0]!;
  const withoutTraits = {
    ...opus,
    capabilities: {
      ...opus.capabilities!,
      reasoningEffortLevels: [],
      supportsFastMode: false,
      promptInjectedEffortLevels: [],
    },
  };
  const mountIconOnly = (
    models: ReadonlyArray<ServerProvider["models"][number]>,
    modelOptions: ClaudeModelOptions,
  ) =>
    render(
      <TraitsPicker
        provider="claudeAgent"
        models={models}
        threadId={CLAUDE_THREAD_ID}
        model={opus.slug}
        modelOptions={modelOptions}
        prompt=""
        onPromptChange={() => {}}
        iconOnly
      />,
    );

  it("names its purpose and value", async () => {
    await mountIconOnly([opus], { effort: "high" });
    expect(document.querySelector("button")?.getAttribute("aria-label")).toBe("Effort: High");
  });

  it("still has a name when the model has no traits to show", async () => {
    await mountIconOnly([withoutTraits], {});
    expect(document.querySelector("button")?.getAttribute("aria-label")).toBe("Model options");
  });

  it("shows the fast icon at the gauge's size when fast mode is on", async () => {
    const gaugeScreen = await mountIconOnly([opus], { effort: "high", fastMode: false });
    expect(compactIconSvg().getAttribute("class")).toContain("lucide-gauge");
    const gaugeWidth = compactIconSvg().getBoundingClientRect().width;
    await gaugeScreen.unmount();

    await mountIconOnly([opus], { effort: "high", fastMode: true });
    expect(compactIconSvg().getAttribute("class")).toContain("lucide-zap");
    expect(compactIconSvg().getBoundingClientRect().width).toBe(gaugeWidth);
    expect(document.querySelector("button")?.getAttribute("aria-label")).toBe(
      "Effort: High · Fast",
    );
  });
});

describe("TraitsPicker allowUltracode", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  const sonnetFive = TEST_PROVIDERS[1]!.models.find((model) => model.slug === "claude-sonnet-5-5")!;

  it("offers no Ultracode control or label where the choice has no effect", async () => {
    const screen = await render(
      <TraitsPicker
        provider="claudeAgent"
        models={[sonnetFive]}
        model={sonnetFive.slug}
        modelOptions={{ effort: "high", ultracode: true }}
        allowUltracode={false}
        prompt=""
        onPromptChange={() => {}}
        onModelOptionsChange={() => {}}
      />,
    );
    expect(document.querySelector("button")?.textContent).not.toContain("Ultracode");

    await page.getByRole("button").click();
    await vi.waitFor(() => expect(document.querySelector('[role="menuitemradio"]')).not.toBeNull());
    expect(document.body.textContent).not.toContain("Ultracode");
    await screen.unmount();
  });

  it("offers it by default", async () => {
    await render(
      <TraitsPicker
        provider="claudeAgent"
        models={[sonnetFive]}
        model={sonnetFive.slug}
        modelOptions={{ effort: "high", ultracode: true }}
        prompt=""
        onPromptChange={() => {}}
        onModelOptionsChange={() => {}}
      />,
    );
    expect(document.querySelector("button")?.textContent).toContain("Ultracode");
  });
});

describe("TraitsPicker (Codex)", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    localStorage.removeItem(COMPOSER_DRAFT_STORAGE_KEY);
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
      stickyModelSelectionByProvider: {},
    });
  });

  it("shows fast mode controls", async () => {
    await using _ = await mountCodexPicker({
      options: { fastMode: false },
    });

    await page.getByRole("button").click();

    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain("Fast Mode");
      expect(text).toContain("off");
      expect(text).toContain("on");
    });
  });

  it("shows Fast in the trigger label when fast mode is active", async () => {
    await using _ = await mountCodexPicker({
      options: { fastMode: true },
    });

    await vi.waitFor(() => {
      expect(document.body.textContent ?? "").toContain("High · Fast");
    });
  });

  it("shows only the provided effort options", async () => {
    await using _ = await mountCodexPicker({
      options: { fastMode: false },
    });

    await page.getByRole("button").click();

    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain("Extra High");
      expect(text).toContain("High");
      expect(text).not.toContain("Low");
      expect(text).not.toContain("Medium");
    });
  });

  it("persists sticky codex model options when traits change", async () => {
    await using _ = await mountCodexPicker({
      options: { fastMode: false },
    });

    await page.getByRole("button").click();
    await page.getByRole("menuitemradio", { name: "on" }).click();

    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider.codex).toMatchObject({
      provider: "codex",
      options: { fastMode: true },
    });
  });

  describe("service tiers", () => {
    const tieredModels = (defaultValue = "default") =>
      TEST_PROVIDERS[0]!.models.map((entry) =>
        Object.assign({}, entry, {
          capabilities: Object.assign({}, entry.capabilities!, {
            serviceTierOptions: [
              { value: "default", label: "Standard" },
              { value: "fast", label: "Fast", description: "Faster responses" },
              { value: "ultrafast", label: "Ultrafast" },
            ].map((option) =>
              option.value === defaultValue
                ? Object.assign({}, option, { isDefault: true })
                : option,
            ),
          }),
        }),
      );

    it("replaces the Fast Mode toggle with the catalog's tiers", async () => {
      await using _ = await mountCodexPicker({ models: tieredModels() });
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("Service Tier");
        expect(text).toContain("Faster responses");
        expect(text).not.toContain("Fast Mode");
      });
    });

    it("hides the tier for Standard and shows the label of a faster tier", async () => {
      const standard = await mountCodexPicker({ models: tieredModels() });
      await vi.waitFor(() => expect(triggerText()).toContain("High"));
      expect(triggerText()).not.toContain("Standard");
      await standard.cleanup();

      await using _ = await mountCodexPicker({
        models: tieredModels(),
        options: { serviceTier: "ultrafast" },
      });
      await vi.waitFor(() => expect(triggerText()).toContain("High · Ultrafast"));
    });

    it("decodes the older fastMode flag for the trigger and the selected row", async () => {
      await using _ = await mountCodexPicker({
        models: tieredModels(),
        options: { fastMode: true },
      });
      await vi.waitFor(() => expect(triggerText()).toContain("High · Fast"));

      await page.getByRole("button").click();
      await expect
        .element(page.getByRole("menuitemradio", { name: "Fast" }).first())
        .toHaveAttribute("aria-checked", "true");
    });

    it("stores a chosen tier and drops fastMode, with Standard stored as null", async () => {
      const threadOptions = () =>
        useComposerDraftStore.getState().draftsByThreadId[
          ThreadId.makeUnsafe("thread-codex-traits")
        ]?.modelSelectionByProvider.codex?.options;
      await using _ = await mountCodexPicker({
        models: tieredModels(),
        options: { fastMode: true },
      });

      await page.getByRole("button").click();
      await page.getByRole("menuitemradio", { name: "Ultrafast" }).click();
      await vi.waitFor(() => expect(threadOptions()).toEqual({ serviceTier: "ultrafast" }));

      await page.getByRole("button").click();
      await page.getByRole("menuitemradio", { name: "Standard" }).click();
      await vi.waitFor(() => expect(threadOptions()).toEqual({ serviceTier: null }));
    });

    it("keeps the toggle on a model without tiers and clears a tier stored elsewhere", async () => {
      await using _ = await mountCodexPicker({ options: { serviceTier: null } });
      await page.getByRole("button").click();
      await page.getByRole("menuitemradio", { name: "on" }).click();

      await vi.waitFor(() => {
        const options =
          useComposerDraftStore.getState().draftsByThreadId[
            ThreadId.makeUnsafe("thread-codex-traits")
          ]?.modelSelectionByProvider.codex?.options;
        expect(options).toEqual({ fastMode: true });
      });
    });
  });

  it("defaults Fast to on when the Codex config sets a fast service tier", async () => {
    const models = TEST_PROVIDERS[0]!.models.map((entry) =>
      Object.assign({}, entry, {
        capabilities: Object.assign({}, entry.capabilities!, { fastModeDefault: true }),
      }),
    );
    const picker = await mountCodexPicker({ models });
    await vi.waitFor(() => {
      expect(document.body.textContent ?? "").toContain("High · Fast");
    });
    await picker.cleanup();

    await using _ = await mountCodexPicker({ models, options: { fastMode: false } });
    await vi.waitFor(() => {
      expect(document.body.textContent ?? "").toContain("High");
    });
    expect(document.body.textContent ?? "").not.toContain("Fast");
  });
});
