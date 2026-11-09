import "../index.css";

import { ProjectId, type ServerProvider, ThreadId } from "@piedpiper/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@piedpiper/contracts/settings";
import { useRef } from "react";
import { page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useComposerDraftStore } from "../composerDraftStore";
import { getCustomModelOptionsByProvider } from "../modelSelection";
import {
  ComposerMenuFocusContext,
  type ComposerMenuFocusTarget,
} from "./ChatView.composerMenuFocus";
import { ProviderModelPicker } from "./chat/ProviderModelPicker";
import { TraitsPicker } from "./chat/TraitsPicker";

const THREAD_ID = ThreadId.makeUnsafe("thread-composer-menu-focus");
const PROJECT_ID = ProjectId.makeUnsafe("project-composer-menu-focus");

const CLAUDE_MODELS: ServerProvider["models"] = [
  {
    slug: "claude-opus-4-6",
    name: "Claude Opus 4.6",
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
    },
  },
  {
    slug: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [{ value: "high", label: "High", isDefault: true }],
      supportsFastMode: false,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    },
  },
];

const PROVIDERS: ReadonlyArray<ServerProvider> = [
  {
    provider: "claudeAgent",
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: CLAUDE_MODELS,
  },
];

function InComposer(props: { children: React.ReactNode }) {
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const targetRef = useRef<ComposerMenuFocusTarget>({
    focusAtEnd: () => editorRef.current?.focus(),
  });
  return (
    <ComposerMenuFocusContext value={targetRef}>
      <textarea aria-label="editor" ref={editorRef} />
      {props.children}
    </ComposerMenuFocusContext>
  );
}

async function expectEditorFocused(): Promise<void> {
  await vi.waitFor(() => {
    expect(document.activeElement?.getAttribute("aria-label")).toBe("editor");
  });
}

describe("composer pickers return focus to the prompt", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
    });
  });

  it("TraitsPicker on Escape", async () => {
    useComposerDraftStore.setState({
      draftThreadsByThreadId: {
        [THREAD_ID]: {
          projectId: PROJECT_ID,
          createdAt: "2026-01-01T00:00:00.000Z",
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          envMode: "local",
        },
      },
    });
    const screen = await render(
      <InComposer>
        <TraitsPicker
          provider="claudeAgent"
          models={CLAUDE_MODELS}
          threadId={THREAD_ID}
          model="claude-opus-4-6"
          prompt=""
          modelOptions={undefined}
          onPromptChange={vi.fn()}
        />
      </InComposer>,
    );
    try {
      await page.getByRole("button").click();
      await expect.element(page.getByRole("menu")).toBeVisible();
      await vi.waitFor(() => {
        expect(document.activeElement?.closest('[data-slot="menu-popup"]')).not.toBeNull();
      });
      await userEvent.keyboard("{Escape}");
      await expectEditorFocused();
    } finally {
      await screen.unmount();
    }
  });

  it("ProviderModelPicker after picking a model", async () => {
    const onProviderModelChange = vi.fn();
    const screen = await render(
      <InComposer>
        <ProviderModelPicker
          provider="claudeAgent"
          model="claude-opus-4-6"
          lockedProvider={null}
          providers={PROVIDERS}
          modelOptionsByProvider={getCustomModelOptionsByProvider(
            DEFAULT_UNIFIED_SETTINGS,
            PROVIDERS,
            "claudeAgent",
            "claude-opus-4-6",
          )}
          onProviderModelChange={onProviderModelChange}
        />
      </InComposer>,
    );
    try {
      document.querySelector<HTMLElement>('[data-chat-provider-model-picker="true"]')?.click();
      await page.getByRole("option", { name: "Claude Sonnet 4.6" }).click();
      await vi.waitFor(() => expect(onProviderModelChange).toHaveBeenCalledOnce());
      await expectEditorFocused();
    } finally {
      await screen.unmount();
    }
  });
});
