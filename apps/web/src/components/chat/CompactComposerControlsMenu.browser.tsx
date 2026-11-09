import { DEFAULT_MODEL_BY_PROVIDER, ModelSelection, ThreadId } from "@piedpiper/contracts";
import "../../index.css";

import { useRef } from "react";
import { page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import {
  ComposerMenuFocusContext,
  type ComposerMenuFocusTarget,
} from "../ChatView.composerMenuFocus";
import { CompactComposerControlsMenu } from "./CompactComposerControlsMenu";
import { TraitsMenuContent } from "./TraitsPicker";
import { useComposerDraftStore } from "../../composerDraftStore";

async function mountMenu(props?: { modelSelection?: ModelSelection; prompt?: string }) {
  const threadId = ThreadId.makeUnsafe("thread-compact-menu");
  const provider = props?.modelSelection?.provider ?? "claudeAgent";
  const draftsByThreadId = {} as ReturnType<
    typeof useComposerDraftStore.getState
  >["draftsByThreadId"];
  const model = props?.modelSelection?.model ?? DEFAULT_MODEL_BY_PROVIDER[provider];

  draftsByThreadId[threadId] = {
    prompt: props?.prompt ?? "",
    images: [],
    nonPersistedImageIds: [],
    persistedAttachments: [],
    terminalContexts: [],
    modelSelectionByProvider: {
      [provider]: {
        provider,
        model,
        ...(props?.modelSelection?.options ? { options: props.modelSelection.options } : {}),
      },
    },
    activeProvider: provider,
    runtimeMode: null,
    interactionMode: null,
  };
  useComposerDraftStore.setState({
    draftsByThreadId,
    draftThreadsByThreadId: {},
    projectDraftThreadIdByProjectId: {},
  });
  const host = document.createElement("div");
  document.body.append(host);
  const onPromptChange = vi.fn();
  const providerOptions = props?.modelSelection?.options;
  const models =
    provider === "claudeAgent"
      ? [
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
        ]
      : [
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
        ];
  const screen = await render(
    <CompactComposerControlsMenu
      activePlan={false}
      interactionMode="default"
      planSidebarOpen={false}
      runtimeMode="approval-required"
      traitsMenuContent={
        <TraitsMenuContent
          provider={provider}
          models={models}
          threadId={threadId}
          model={model}
          prompt={props?.prompt ?? ""}
          modelOptions={providerOptions}
          onPromptChange={onPromptChange}
        />
      }
      onToggleInteractionMode={vi.fn()}
      onTogglePlanSidebar={vi.fn()}
      onRuntimeModeChange={vi.fn()}
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

describe("CompactComposerControlsMenu", () => {
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
    await using _ = await mountMenu({
      modelSelection: { provider: "claudeAgent", model: "claude-opus-4-6" },
    });

    await page.getByLabelText("More composer controls").click();

    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain("Fast Mode");
      expect(text).toContain("off");
      expect(text).toContain("on");
    });
  });

  it("hides fast mode controls for non-Opus Claude models", async () => {
    await using _ = await mountMenu({
      modelSelection: { provider: "claudeAgent", model: "claude-sonnet-4-6" },
    });

    await page.getByLabelText("More composer controls").click();

    await vi.waitFor(() => {
      expect(document.body.textContent ?? "").not.toContain("Fast Mode");
    });
  });

  it("shows only the provided effort options", async () => {
    await using _ = await mountMenu({
      modelSelection: { provider: "claudeAgent", model: "claude-sonnet-4-6" },
    });

    await page.getByLabelText("More composer controls").click();

    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain("Low");
      expect(text).toContain("Medium");
      expect(text).toContain("High");
      expect(text).not.toContain("Max");
      expect(text).toContain("Ultrathink");
    });
  });

  it("shows a Claude thinking on/off section for Haiku", async () => {
    await using _ = await mountMenu({
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-haiku-4-5",
        options: { thinking: true },
      },
    });

    await page.getByLabelText("More composer controls").click();

    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain("Thinking");
      expect(text).toContain("On (default)");
      expect(text).toContain("Off");
    });
  });

  it("shows prompt-controlled Ultrathink state with selectable effort controls", async () => {
    await using _ = await mountMenu({
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-opus-4-6",
        options: { effort: "high" },
      },
      prompt: "Ultrathink:\nInvestigate this",
    });

    await page.getByLabelText("More composer controls").click();

    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain("Effort");
      expect(text).not.toContain("ultrathink");
    });
  });

  it("warns when ultrathink appears in prompt body text", async () => {
    await using _ = await mountMenu({
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-opus-4-6",
        options: { effort: "high" },
      },
      prompt: "Ultrathink:\nplease ultrathink about this problem",
    });

    await page.getByLabelText("More composer controls").click();

    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain(
        'Your prompt contains "ultrathink" in the text. Remove it to change effort.',
      );
    });
  });

  it("closes the compact menu after picking an effort level", async () => {
    await using _ = await mountMenu({
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-opus-4-6",
        options: { effort: "high" },
      },
    });

    await page.getByLabelText("More composer controls").click();
    await page.getByRole("menuitemradio", { name: "Low" }).click();

    await vi.waitFor(() => {
      expect(document.querySelector('[role="menuitemradio"]')).toBeNull();
    });
  });

  it("lists only the controls the footer hid", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <CompactComposerControlsMenu
        activePlan={false}
        interactionMode="default"
        planSidebarOpen={false}
        runtimeMode="approval-required"
        showInteractionMode={false}
        onToggleInteractionMode={vi.fn()}
        onTogglePlanSidebar={vi.fn()}
        onRuntimeModeChange={vi.fn()}
      />,
      { container: host },
    );

    try {
      await page.getByLabelText("More composer controls").click();
      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("Access");
        expect(text).not.toContain("Mode");
        expect(text).not.toContain("Show plan sidebar");
        expect(document.querySelectorAll('[role="separator"]')).toHaveLength(0);
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("separates the sections it does list", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <CompactComposerControlsMenu
        activePlan
        interactionMode="default"
        planSidebarOpen={false}
        runtimeMode="approval-required"
        showInteractionMode={false}
        onToggleInteractionMode={vi.fn()}
        onTogglePlanSidebar={vi.fn()}
        onRuntimeModeChange={vi.fn()}
      />,
      { container: host },
    );

    try {
      await page.getByLabelText("More composer controls").click();
      await vi.waitFor(() => {
        expect(document.body.textContent ?? "").toContain("Show plan sidebar");
        expect(document.querySelectorAll('[role="separator"]')).toHaveLength(1);
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("picks the Auto runtime mode directly", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const onRuntimeModeChange = vi.fn();
    const screen = await render(
      <CompactComposerControlsMenu
        activePlan={false}
        interactionMode="default"
        planSidebarOpen={false}
        runtimeMode="approval-required"
        onToggleInteractionMode={vi.fn()}
        onTogglePlanSidebar={vi.fn()}
        onRuntimeModeChange={onRuntimeModeChange}
      />,
      { container: host },
    );

    try {
      await page.getByLabelText("More composer controls").click();
      await page.getByRole("menuitemradio", { name: "Auto" }).click();
      expect(onRuntimeModeChange).toHaveBeenCalledWith("auto");
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("returns focus to the prompt on Escape inside the composer", async () => {
    function InComposer() {
      const editorRef = useRef<HTMLTextAreaElement>(null);
      const targetRef = useRef<ComposerMenuFocusTarget>({
        focusAtEnd: () => editorRef.current?.focus(),
      });
      return (
        <ComposerMenuFocusContext value={targetRef}>
          <textarea aria-label="editor" ref={editorRef} />
          <CompactComposerControlsMenu
            activePlan={false}
            interactionMode="default"
            planSidebarOpen={false}
            runtimeMode="approval-required"
            onToggleInteractionMode={vi.fn()}
            onTogglePlanSidebar={vi.fn()}
            onRuntimeModeChange={vi.fn()}
          />
        </ComposerMenuFocusContext>
      );
    }
    const screen = await render(<InComposer />);
    try {
      await page.getByRole("button", { name: "More composer controls" }).click();
      await expect.element(page.getByRole("menuitemradio", { name: "Plan" })).toBeVisible();
      await vi.waitFor(() => {
        expect(document.activeElement?.closest('[data-slot="menu-popup"]')).not.toBeNull();
      });
      await userEvent.keyboard("{Escape}");
      await vi.waitFor(() => {
        expect(document.activeElement?.getAttribute("aria-label")).toBe("editor");
      });
    } finally {
      await screen.unmount();
    }
  });
});
