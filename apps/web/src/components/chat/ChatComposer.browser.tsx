import { useComposerDraftStore } from "../../composerDraftStore";
import "../../index.css";

import { type ServerProvider, ThreadId } from "@piedpiper/contracts";
import { createRef } from "react";
import { page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { readNativeApi } from "~/nativeApi";
import { useReviewCommentDraftStore } from "~/reviewCommentDraftStore";
import {
  addPreparingComposerImages,
  readPreparingComposerImages,
  removePreparingComposerImages,
} from "../ChatView.preparingImages";
import type { ComposerPromptEditorHandle } from "../ComposerPromptEditor";
import { ChatComposer, type ChatComposerProps } from "./ChatComposer";
import { getComposerProviderState } from "./composerProviderRegistry";
import {
  setComposerMultiModelSelections,
  useComposerMultiModelStore,
} from "./composerMultiModelStore";
import {
  beginThreadStop,
  STOP_UNRESPONSIVE_AFTER_MS,
  useComposerThreadStopStore,
} from "./composerThreadStop";

vi.mock("~/nativeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/nativeApi")>()),
  readNativeApi: vi.fn(),
}));

const THREAD_ID = ThreadId.makeUnsafe("thread-composer-footer");
// Vitest's own default, which the tests that set no viewport rely on.
const DEFAULT_TEST_VIEWPORT = { width: 414, height: 896 };

const PROPOSED_PLAN = {
  id: "plan-composer-footer",
  turnId: null,
  planMarkdown: "# Plan",
  implementedAt: null,
  implementationThreadId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
} as NonNullable<ChatComposerProps["activeProposedPlan"]>;

const REVIEW_COMMENT = {
  id: "comment-composer-footer",
  sectionId: "uncommitted",
  sectionTitle: "Uncommitted",
  filePath: "src/app.ts",
  startIndex: 0,
  endIndex: 1,
  rangeLabel: "L1",
  text: "rename this variable",
  diff: "+const a = 1;",
};

const MODELS: ServerProvider["models"] = [
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
    models: MODELS,
  },
];

function composerProps(overrides: Partial<ChatComposerProps> = {}): ChatComposerProps {
  return {
    threadId: THREAD_ID,
    projectId: undefined,
    missingCwd: null,
    onMissingCwdResolved: () => {},
    isWorking: false,
    isSendQueued: false,
    workingLabel: null,
    activeWorkStartedAt: null,
    activeContextWindow: null,
    phase: "ready",
    isConnecting: false,
    isSendBusy: false,
    isPreparingWorktree: false,
    selectedProvider: "claudeAgent",
    lockedProvider: null,
    selectedModelForPicker: "claude-opus-4-6",
    selectedModel: "claude-opus-4-6",
    selectedProviderModels: MODELS,
    composerModelOptions: null,
    providerStatuses: PROVIDERS,
    modelOptionsByProvider: { claudeAgent: MODELS, codex: [] },
    composerProviderState: getComposerProviderState({
      provider: "claudeAgent",
      model: "claude-opus-4-6",
      models: MODELS,
      prompt: "",
      modelOptions: undefined,
    }),
    onProviderModelSelect: () => {},
    onTraitsPromptChange: () => {},
    composerCursor: 0,
    composerTerminalContexts: [],
    composerEditorRef: createRef<ComposerPromptEditorHandle>(),
    onPromptChange: () => {},
    onComposerCommandKey: () => false,
    onComposerPaste: () => {},
    removeComposerTerminalContextFromDraft: () => {},
    composerMenuOpen: false,
    composerMenuItems: [],
    activeComposerMenuItem: null,
    composerTriggerKind: null,
    isComposerMenuLoading: false,
    composerHighlightedItemId: null,
    onComposerMenuItemHighlighted: () => {},
    onSelectComposerItem: () => {},
    composerImages: [],
    nonPersistedComposerImageIdSet: new Set(),
    onRemoveComposerImage: () => {},
    onExpandImage: () => {},
    activePendingApproval: null,
    pendingApprovals: [],
    respondingRequestIds: [],
    onRespondToApproval: async () => {},
    isComposerApprovalState: false,
    activePendingUserInput: null,
    pendingUserInputs: [],
    activePendingDraftAnswers: {},
    activePendingQuestionIndex: 0,
    activePendingProgress: null,
    activePendingIsResponding: false,
    activePendingResolvedAnswers: null,
    onSelectActivePendingUserInputOption: () => {},
    onAdvanceActivePendingUserInput: () => {},
    onPreviousActivePendingUserInputQuestion: () => {},
    showPlanFollowUpPrompt: false,
    activeProposedPlan: null,
    runtimeMode: "full-access",
    interactionMode: "default",
    toggleInteractionMode: () => {},
    handleRuntimeModeChange: () => {},
    togglePlanSidebar: () => {},
    planSidebarOpen: false,
    activePlan: null,
    sidebarProposedPlan: null,
    onSend: () => {},
    onInterrupt: () => {},
    onImplementPlanInNewThread: () => {},
    resolvedTheme: "dark",
    hasComposerHeader: false,
    scheduleStickToBottom: () => {},
    onFileDrop: () => {},
    ...overrides,
  };
}

async function mountComposer(width: number, overrides: Partial<ChatComposerProps> = {}) {
  const host = document.createElement("div");
  host.style.width = `${width}px`;
  document.body.append(host);
  const screen = await render(<ChatComposer {...composerProps(overrides)} />, { container: host });
  return {
    cleanup: async () => {
      await screen.unmount();
      host.remove();
    },
  };
}

function footer() {
  return document.querySelector<HTMLElement>('[data-chat-composer-footer="true"]')!;
}

function expectRectInside(inner: HTMLElement, outer: HTMLElement, label: string) {
  const innerBox = inner.getBoundingClientRect();
  const outerBox = outer.getBoundingClientRect();
  expect(innerBox.left, `${label} left`).toBeGreaterThanOrEqual(outerBox.left - 0.5);
  expect(innerBox.right, `${label} right`).toBeLessThanOrEqual(outerBox.right + 0.5);
}

const leadingStrip = () => footer().firstElementChild as HTMLElement;
const actionsCluster = () =>
  footer().querySelector<HTMLElement>('[data-chat-composer-actions="right"]')!;
const overflowTrigger = () =>
  document.querySelector<HTMLElement>('[aria-label="More composer controls"]')!;
const editorPlaceholder = () =>
  document.querySelector("[aria-placeholder]")?.getAttribute("aria-placeholder");
const shortWorktreeLabel = () =>
  Array.from(actionsCluster().querySelectorAll<HTMLElement>('span[aria-hidden="true"]')).find(
    (element) => element.textContent === "Preparing...",
  )!;
const hiddenBlockCount = () =>
  document.querySelectorAll("[data-composer-footer-block][inert]").length;

describe("ChatComposer footer", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    useComposerThreadStopStore.setState({ requestsByThreadId: {} });
    useComposerMultiModelStore.setState({ selectionsByThreadId: {} });
    vi.mocked(readNativeApi).mockReset();
  });

  const planFollowUp = { showPlanFollowUpPrompt: true, activePlan: {} };

  it("keeps the overflow menu in the strip when every control has collapsed", async () => {
    const mounted = await mountComposer(320, planFollowUp);
    try {
      await vi.waitFor(() => expect(hiddenBlockCount()).toBe(4));
      expectRectInside(overflowTrigger(), leadingStrip(), "overflow trigger");
      expectRectInside(leadingStrip(), footer(), "leading strip");
    } finally {
      await mounted.cleanup();
    }
  });

  it("scrolls to the overflow menu when even that does not fit", async () => {
    const mounted = await mountComposer(230, planFollowUp);
    try {
      await vi.waitFor(() => expect(hiddenBlockCount()).toBe(4));
      const strip = leadingStrip();
      expect(getComputedStyle(strip).overflowX).toBe("auto");
      expect(strip.scrollWidth).toBeGreaterThan(strip.clientWidth);

      strip.scrollLeft = strip.scrollWidth;
      await vi.waitFor(() =>
        expectRectInside(overflowTrigger(), strip, "scrolled overflow trigger"),
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("does not scroll while there are still controls to collapse", async () => {
    const mounted = await mountComposer(900, planFollowUp);
    try {
      await vi.waitFor(() => expect(hiddenBlockCount()).toBe(0));
      expect(getComputedStyle(leadingStrip()).overflowX).toBe("hidden");
    } finally {
      await mounted.cleanup();
    }
  });

  it.each([320, 375])("keeps the unresponsive stop row inside a %ipx footer", async (width) => {
    beginThreadStop(THREAD_ID, null, Date.now() - STOP_UNRESPONSIVE_AFTER_MS);
    const mounted = await mountComposer(width, { phase: "running", isWorking: true });
    try {
      const forceStop = await vi.waitFor(() => {
        const button = Array.from(footer().querySelectorAll("button")).find(
          (candidate) => candidate.textContent === "Force stop",
        );
        expect(button).toBeDefined();
        return button!;
      });
      await vi.waitFor(() =>
        expect(actionsCluster().dataset.chatComposerPrimaryActionsCompact).toBe("true"),
      );
      await vi.waitFor(() => expectRectInside(actionsCluster(), footer(), "actions"));
      expectRectInside(forceStop, footer(), "Force stop");
      expect(footer().textContent).toContain("Stopping");
      expect(getComputedStyle(leadingStrip()).display).not.toBe("none");
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps focus on the button when Stop is pressed from the keyboard", async () => {
    const mounted = await mountComposer(900, {
      phase: "running",
      isWorking: true,
      onInterrupt: () => beginThreadStop(THREAD_ID, null),
    });
    try {
      const stop = document.querySelector<HTMLButtonElement>('[aria-label="Stop generation"]')!;
      stop.focus();
      await userEvent.keyboard("{Enter}");
      await vi.waitFor(() => expect(stop.getAttribute("aria-disabled")).toBe("true"));
      expect(stop.isConnected).toBe(true);
      expect(document.activeElement).toBe(stop);
      expect(document.querySelector('[role="status"]:not(.sr-only)')).toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });

  it("sends Force stop once, and allows a retry after the dispatch fails", async () => {
    const dispatchCommand = vi.fn<(command: unknown) => Promise<unknown>>();
    dispatchCommand.mockRejectedValueOnce(new Error("offline"));
    dispatchCommand.mockResolvedValue({ sequence: 1 });
    vi.mocked(readNativeApi).mockReturnValue({
      orchestration: { dispatchCommand },
    } as unknown as ReturnType<typeof readNativeApi>);
    beginThreadStop(THREAD_ID, null, Date.now() - STOP_UNRESPONSIVE_AFTER_MS);
    const mounted = await mountComposer(900, { phase: "running", isWorking: true });
    try {
      const forceStop = () =>
        Array.from(footer().querySelectorAll("button")).find((candidate) =>
          candidate.textContent?.startsWith("Force stop"),
        )!;
      await vi.waitFor(() => expect(forceStop()).toBeDefined());

      forceStop().click();
      expect(dispatchCommand).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => expect(forceStop().textContent).toBe("Force stop"));

      forceStop().click();
      await vi.waitFor(() => expect(forceStop().textContent).toBe("Force stopping..."));
      expect(forceStop().getAttribute("aria-disabled")).toBe("true");
      forceStop().click();
      expect(dispatchCommand).toHaveBeenCalledTimes(2);
    } finally {
      await mounted.cleanup();
    }
  });

  it("offers Refine, not Implement, for a plan follow-up holding only review comments", async () => {
    const buttonLabels = () =>
      Array.from(actionsCluster().querySelectorAll("button")).map((button) => button.textContent);
    const mounted = await mountComposer(900, {
      showPlanFollowUpPrompt: true,
      activeProposedPlan: PROPOSED_PLAN,
    });
    try {
      await vi.waitFor(() => expect(buttonLabels()).toContain("Implement"));
      expect(editorPlaceholder()).toContain("leave this blank to implement it");
      useReviewCommentDraftStore.getState().addComment(THREAD_ID, REVIEW_COMMENT);
      await vi.waitFor(() => expect(buttonLabels()).toEqual(["Refine"]));
      expect(editorPlaceholder()).toBe("Add feedback to send with your comments");
      expect(
        document.querySelector('[aria-label="Implementation actions"]'),
        "Implement in a New Thread would leave the comments behind",
      ).toBeNull();
    } finally {
      useReviewCommentDraftStore.getState().clearComments(THREAD_ID);
      await mounted.cleanup();
    }
  });

  it.each([296, 351])("keeps the worktree progress row inside a %ipx footer", async (width) => {
    await page.viewport(width + 24, 800);
    const mounted = await mountComposer(width, {
      isPreparingWorktree: true,
      isSendBusy: true,
      worktreeProgress: { percent: 100 },
      onCancelPreparingWorktree: () => {},
      onWorkLocallyInstead: () => {},
    });
    try {
      await vi.waitFor(() => expectRectInside(actionsCluster(), footer(), "actions"));
      const status = footer().querySelector('[role="status"]')!;
      expect(status.textContent).toBe("Preparing worktree...");
      expect(status.getBoundingClientRect().width).toBeLessThanOrEqual(1);
      expect(footer().textContent).toContain("100%");
    } finally {
      await mounted.cleanup();
      await page.viewport(DEFAULT_TEST_VIEWPORT.width, DEFAULT_TEST_VIEWPORT.height);
    }
  });

  it.each([296, 351])(
    "names the worktree step before any percent in a %ipx footer",
    async (width) => {
      await page.viewport(width + 24, 800);
      const mounted = await mountComposer(width, {
        isPreparingWorktree: true,
        isSendBusy: true,
        worktreeProgress: null,
        onCancelPreparingWorktree: () => {},
        onWorkLocallyInstead: () => {},
      });
      try {
        await vi.waitFor(() => expectRectInside(actionsCluster(), footer(), "actions"));
        expect(footer().querySelector('[role="status"]')?.textContent).toBe(
          "Preparing worktree...",
        );
        expect(shortWorktreeLabel().getBoundingClientRect().width).toBeGreaterThan(1);
        expect(
          footer().querySelector('[role="status"]')!.getBoundingClientRect().width,
        ).toBeLessThanOrEqual(1);
        expect(footer().textContent).not.toContain("%");
      } finally {
        await mounted.cleanup();
        await page.viewport(DEFAULT_TEST_VIEWPORT.width, DEFAULT_TEST_VIEWPORT.height);
      }
    },
  );

  it("names the worktree step beside its percent on a wide screen", async () => {
    await page.viewport(1000, 800);
    const mounted = await mountComposer(900, {
      isPreparingWorktree: true,
      isSendBusy: true,
      worktreeProgress: { percent: 40 },
    });
    try {
      const status = footer().querySelector('[role="status"]')!;
      expect(status.getBoundingClientRect().width).toBeGreaterThan(1);
      expect(footer().textContent).toContain("40%");
    } finally {
      await mounted.cleanup();
      await page.viewport(DEFAULT_TEST_VIEWPORT.width, DEFAULT_TEST_VIEWPORT.height);
    }
  });

  it("hides the short worktree name beside the full label on a wide screen", async () => {
    await page.viewport(1000, 800);
    const mounted = await mountComposer(900, {
      isPreparingWorktree: true,
      isSendBusy: true,
      worktreeProgress: null,
    });
    try {
      expect(
        footer().querySelector('[role="status"]')!.getBoundingClientRect().width,
      ).toBeGreaterThan(1);
      expect(shortWorktreeLabel().getBoundingClientRect().width).toBe(0);
    } finally {
      await mounted.cleanup();
      await page.viewport(DEFAULT_TEST_VIEWPORT.width, DEFAULT_TEST_VIEWPORT.height);
    }
  });

  it("says where a multi-model send will run", async () => {
    setComposerMultiModelSelections(THREAD_ID, [
      { provider: "claudeAgent", model: "claude-opus-4-6" },
      { provider: "codex", model: "gpt-5-codex" },
    ]);
    const mounted = await mountComposer(900, {
      multiModelEnabled: true,
      multiModelBaseBranch: "main",
    });
    try {
      expect(document.querySelector("[data-composer-multi-model-notice]")?.textContent).toBe(
        "Sends to 2 models, each in a new worktree from main",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows no notice for a single model", async () => {
    const mounted = await mountComposer(900, { multiModelEnabled: true });
    try {
      expect(document.querySelector("[data-composer-multi-model-notice]")).toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps a tile's thumbnail node when its image leaves the preparing store for the draft", async () => {
    const pixel =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==";
    addPreparingComposerImages(THREAD_ID, [
      { id: "shot", name: "shot.png", previewUrl: `${pixel}#source` },
    ]);
    const screen = await render(<ChatComposer {...composerProps()} />);
    try {
      const img = await vi.waitFor(() => {
        const found = document.querySelector<HTMLImageElement>('[role="status"] img');
        expect(found).not.toBeNull();
        return found!;
      });

      removePreparingComposerImages(
        THREAD_ID,
        new Set(readPreparingComposerImages(THREAD_ID).map((image) => image.id)),
      );
      await screen.rerender(
        <ChatComposer
          {...composerProps({
            composerImages: [
              {
                type: "image",
                id: "shot",
                name: "shot.png",
                mimeType: "image/png",
                sizeBytes: 1,
                previewUrl: `${pixel}#fitted`,
                file: new File(["x"], "shot.png", { type: "image/png" }),
              },
            ],
          })}
        />,
      );

      await vi.waitFor(() => expect(document.querySelector('[role="status"] img')).toBeNull());
      expect(document.querySelector('img[alt="shot.png"]')).toBe(img);
      expect(img.getAttribute("src")).toBe(`${pixel}#fitted`);
    } finally {
      await screen.unmount();
    }
  });
});

it("keeps the editor and actions reachable in a 400 by 360 window", async () => {
  await page.viewport(400, 360);
  useComposerDraftStore.getState().setPrompt(THREAD_ID, "Long prompt\n".repeat(80));
  const mounted = await mountComposer(400, {
    freshContext: true,
    onCancelFreshContext: () => {},
    onStashPrompt: () => {},
    onRestorePrompt: () => {},
    onStashError: () => {},
  });
  try {
    const editor = document.querySelector<HTMLElement>('[role="textbox"]')!;
    const form = document.querySelector<HTMLElement>("[data-chat-composer-form]")!;
    expect(editor.getBoundingClientRect().height).toBeLessThanOrEqual(92);
    expect(form.getBoundingClientRect().height).toBeLessThan(300);
    expectRectInside(actionsCluster(), footer(), "actions");
    expect(footer().getBoundingClientRect().bottom).toBeLessThanOrEqual(360);
  } finally {
    await mounted.cleanup();
    useComposerDraftStore.getState().setPrompt(THREAD_ID, "");
    await page.viewport(DEFAULT_TEST_VIEWPORT.width, DEFAULT_TEST_VIEWPORT.height);
  }
});
