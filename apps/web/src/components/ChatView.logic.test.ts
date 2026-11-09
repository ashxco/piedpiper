import {
  CommandId,
  DEFAULT_MODEL_BY_PROVIDER,
  EventId,
  MessageId,
  type OrchestrationThreadActivity,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  PROVIDER_SEND_TURN_MAX_TOTAL_IMAGE_BYTES,
  ProjectId,
  type ProviderKind,
  type ServerProvider,
  ThreadId,
  TurnId,
} from "@piedpiper/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../store";
import { detectComposerTrigger } from "../composer-logic";
import type { ComposerImageAttachment } from "../composerDraftStore";
import {
  ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
  IMAGE_ONLY_BOOTSTRAP_PROMPT,
} from "@piedpiper/shared/imageOnlyBootstrapPrompt";
import type { TerminalContextDraft } from "../lib/terminalContext";

import {
  MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
  buildExpiredTerminalContextToastCopy,
  createLocalDispatchSnapshot,
  deriveComposerSendState,
  deriveQaCardMessages,
  hasServerAcknowledgedLocalDispatch,
  buildComposerPdfAttachment,
  chatEmptyStateHeading,
  isComposerMenuOpen,
  dropAsyncAnswerMessagesWithQaCards,
  isComposerPdfFile,
  isPathSuggestionCurrent,
  resolveCompactDisabledReason,
  shouldRestoreComposerAfterFailedSend,
  visiblePathSearchEntries,
  buildComposerOutgoingMessageText,
  buildOptimisticUserMessage,
  buildThreadCreateModelSelection,
  buildTurnStartImageAttachments,
  deriveSendThreadTitle,
  formatOutgoingPrompt,
  resolveUnlockedComposerProvider,
  resolveWorktreeSendPlan,
  reconcileMountedTerminalThreadIds,
  resolvePullRequestSetupRequest,
  buildDraftOptionsAfterBackgroundSend,
  resolveComposerSendFollowUp,
  composerSendFollowUpRequiresModifier,
  getPlanImplementationLengthValidationMessage,
  restorePlanFollowUpComposer,
  serializeComposerImages,
  shouldRefocusComposerOnWindowFocus,
  queuedSendAfterImageFit,
  resolveQueuedSendFollowUp,
  pasteTextToFocusComposer,
  shouldClaimComposerFilePaste,
  shouldRedirectInputToComposer,
  shouldTypeToFocusComposer,
  TYPE_TO_FOCUS_FLOATING_LAYER_SELECTOR,
  waitForStartedServerThread,
  buildCheckpointRevertCommand,
  canInterruptRunningTurn,
  COMPOSER_IMAGE_TOTAL_SIZE_ERROR,
  estimateComposerImageBudgetBytes,
  nextRuntimeModeInCycle,
  takeComposerImagesWithinTotalBudget,
  findReusableProjectScriptTerminal,
  buildSearchableModelOptions,
  ComposerSendCancelledError,
  resolveFailedSendErrorMessage,
  settleWorktreeCreation,
} from "./ChatView.logic";

describe("deriveComposerSendState", () => {
  it("treats a draft holding only review comments as sendable", () => {
    const input = { prompt: "  ", imageCount: 0, terminalContexts: [] };
    expect(deriveComposerSendState(input).hasSendableContent).toBe(false);
    expect(deriveComposerSendState({ ...input, reviewCommentCount: 0 }).hasSendableContent).toBe(
      false,
    );
    expect(deriveComposerSendState({ ...input, reviewCommentCount: 2 }).hasSendableContent).toBe(
      true,
    );
  });

  it("treats expired terminal pills as non-sendable content", () => {
    const state = deriveComposerSendState({
      prompt: "\uFFFC",
      imageCount: 0,
      terminalContexts: [
        {
          id: "ctx-expired",
          threadId: ThreadId.makeUnsafe("thread-1"),
          terminalId: "default",
          terminalLabel: "Terminal 1",
          lineStart: 4,
          lineEnd: 4,
          text: "",
          createdAt: "2026-03-17T12:52:29.000Z",
        },
      ],
    });

    expect(state.trimmedPrompt).toBe("");
    expect(state.sendableTerminalContexts).toEqual([]);
    expect(state.expiredTerminalContextCount).toBe(1);
    expect(state.hasSendableContent).toBe(false);
  });

  it("keeps text sendable while excluding expired terminal pills", () => {
    const state = deriveComposerSendState({
      prompt: `yoo \uFFFC waddup`,
      imageCount: 0,
      terminalContexts: [
        {
          id: "ctx-expired",
          threadId: ThreadId.makeUnsafe("thread-1"),
          terminalId: "default",
          terminalLabel: "Terminal 1",
          lineStart: 4,
          lineEnd: 4,
          text: "",
          createdAt: "2026-03-17T12:52:29.000Z",
        },
      ],
    });

    expect(state.trimmedPrompt).toBe("yoo  waddup");
    expect(state.expiredTerminalContextCount).toBe(1);
    expect(state.hasSendableContent).toBe(true);
  });
});

describe("buildExpiredTerminalContextToastCopy", () => {
  it("formats clear empty-state guidance", () => {
    expect(buildExpiredTerminalContextToastCopy(1, "empty")).toEqual({
      title: "Expired terminal context won't be sent",
      description: "Remove it or re-add it to include terminal output.",
    });
  });

  it("formats omission guidance for sent messages", () => {
    expect(buildExpiredTerminalContextToastCopy(1, "omitted")).toEqual({
      title: "Expired terminal context omitted from message",
      description: "Re-add it if you want that terminal output included.",
    });
  });

  it("uses plural pronouns when several contexts expired", () => {
    expect(buildExpiredTerminalContextToastCopy(2, "empty")).toEqual({
      title: "Expired terminal contexts won't be sent",
      description: "Remove them or re-add them to include terminal output.",
    });
    expect(buildExpiredTerminalContextToastCopy(2, "omitted")).toEqual({
      title: "Expired terminal contexts omitted from message",
      description: "Re-add them if you want that terminal output included.",
    });
  });
});

describe("reconcileMountedTerminalThreadIds", () => {
  it("keeps previously mounted open threads and adds the active open thread", () => {
    expect(
      reconcileMountedTerminalThreadIds({
        currentThreadIds: [
          ThreadId.makeUnsafe("thread-hidden"),
          ThreadId.makeUnsafe("thread-stale"),
        ],
        openThreadIds: [ThreadId.makeUnsafe("thread-hidden"), ThreadId.makeUnsafe("thread-active")],
        activeThreadId: ThreadId.makeUnsafe("thread-active"),
        activeThreadTerminalOpen: true,
      }),
    ).toEqual([ThreadId.makeUnsafe("thread-hidden"), ThreadId.makeUnsafe("thread-active")]);
  });

  it("drops mounted threads once their terminal drawer is no longer open", () => {
    expect(
      reconcileMountedTerminalThreadIds({
        currentThreadIds: [ThreadId.makeUnsafe("thread-closed")],
        openThreadIds: [],
        activeThreadId: ThreadId.makeUnsafe("thread-closed"),
        activeThreadTerminalOpen: false,
      }),
    ).toEqual([]);
  });

  it("keeps only the most recently active hidden terminal threads", () => {
    expect(
      reconcileMountedTerminalThreadIds({
        currentThreadIds: [
          ThreadId.makeUnsafe("thread-1"),
          ThreadId.makeUnsafe("thread-2"),
          ThreadId.makeUnsafe("thread-3"),
        ],
        openThreadIds: [
          ThreadId.makeUnsafe("thread-1"),
          ThreadId.makeUnsafe("thread-2"),
          ThreadId.makeUnsafe("thread-3"),
          ThreadId.makeUnsafe("thread-4"),
        ],
        activeThreadId: ThreadId.makeUnsafe("thread-4"),
        activeThreadTerminalOpen: true,
        maxHiddenThreadCount: 2,
      }),
    ).toEqual([
      ThreadId.makeUnsafe("thread-2"),
      ThreadId.makeUnsafe("thread-3"),
      ThreadId.makeUnsafe("thread-4"),
    ]);
  });

  it("moves the active thread to the end so it is treated as most recently used", () => {
    expect(
      reconcileMountedTerminalThreadIds({
        currentThreadIds: [
          ThreadId.makeUnsafe("thread-a"),
          ThreadId.makeUnsafe("thread-b"),
          ThreadId.makeUnsafe("thread-c"),
        ],
        openThreadIds: [
          ThreadId.makeUnsafe("thread-a"),
          ThreadId.makeUnsafe("thread-b"),
          ThreadId.makeUnsafe("thread-c"),
        ],
        activeThreadId: ThreadId.makeUnsafe("thread-a"),
        activeThreadTerminalOpen: true,
        maxHiddenThreadCount: 2,
      }),
    ).toEqual([
      ThreadId.makeUnsafe("thread-b"),
      ThreadId.makeUnsafe("thread-c"),
      ThreadId.makeUnsafe("thread-a"),
    ]);
  });

  it("defaults to the hidden mounted terminal cap", () => {
    const currentThreadIds = Array.from(
      { length: MAX_HIDDEN_MOUNTED_TERMINAL_THREADS + 2 },
      (_, index) => ThreadId.makeUnsafe(`thread-${index + 1}`),
    );

    expect(
      reconcileMountedTerminalThreadIds({
        currentThreadIds,
        openThreadIds: currentThreadIds,
        activeThreadId: null,
        activeThreadTerminalOpen: false,
      }),
    ).toEqual(currentThreadIds.slice(-MAX_HIDDEN_MOUNTED_TERMINAL_THREADS));
  });
});

const makeThread = (input?: {
  id?: ThreadId;
  latestTurn?: {
    turnId: TurnId;
    state: "running" | "completed";
    requestedAt: string;
    startedAt: string | null;
    completedAt: string | null;
  } | null;
}) => ({
  id: input?.id ?? ThreadId.makeUnsafe("thread-1"),
  codexThreadId: null,
  projectId: ProjectId.makeUnsafe("project-1"),
  title: "Thread",
  modelSelection: { provider: "codex" as const, model: "gpt-5.4" },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  session: null,
  messages: [],
  proposedPlans: [],
  error: null,
  createdAt: "2026-03-29T00:00:00.000Z",
  archivedAt: null,
  updatedAt: "2026-03-29T00:00:00.000Z",
  latestTurn: input?.latestTurn
    ? {
        ...input.latestTurn,
        assistantMessageId: null,
      }
    : null,
  branch: null,
  worktreePath: null,
  turnDiffSummaries: [],
  activities: [],
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  useStore.setState((state) => ({
    ...state,
    projects: [],
    threads: [],
    bootstrapComplete: true,
  }));
});

describe("waitForStartedServerThread", () => {
  it("resolves immediately when the thread is already started", async () => {
    const threadId = ThreadId.makeUnsafe("thread-started");
    useStore.setState((state) => ({
      ...state,
      threads: [
        makeThread({
          id: threadId,
          latestTurn: {
            turnId: TurnId.makeUnsafe("turn-started"),
            state: "running",
            requestedAt: "2026-03-29T00:00:01.000Z",
            startedAt: "2026-03-29T00:00:01.000Z",
            completedAt: null,
          },
        }),
      ],
    }));

    await expect(waitForStartedServerThread(threadId)).resolves.toBe(true);
  });

  it("waits for the thread to start via subscription updates", async () => {
    const threadId = ThreadId.makeUnsafe("thread-wait");
    useStore.setState((state) => ({
      ...state,
      threads: [makeThread({ id: threadId })],
    }));

    const promise = waitForStartedServerThread(threadId, 500);

    useStore.setState((state) => ({
      ...state,
      threads: [
        makeThread({
          id: threadId,
          latestTurn: {
            turnId: TurnId.makeUnsafe("turn-started"),
            state: "running",
            requestedAt: "2026-03-29T00:00:01.000Z",
            startedAt: "2026-03-29T00:00:01.000Z",
            completedAt: null,
          },
        }),
      ],
    }));

    await expect(promise).resolves.toBe(true);
  });

  it("handles the thread starting between the initial read and subscription setup", async () => {
    const threadId = ThreadId.makeUnsafe("thread-race");
    useStore.setState((state) => ({
      ...state,
      threads: [makeThread({ id: threadId })],
    }));

    const originalSubscribe = useStore.subscribe.bind(useStore);
    let raced = false;
    vi.spyOn(useStore, "subscribe").mockImplementation((listener) => {
      if (!raced) {
        raced = true;
        useStore.setState((state) => ({
          ...state,
          threads: [
            makeThread({
              id: threadId,
              latestTurn: {
                turnId: TurnId.makeUnsafe("turn-race"),
                state: "running",
                requestedAt: "2026-03-29T00:00:01.000Z",
                startedAt: "2026-03-29T00:00:01.000Z",
                completedAt: null,
              },
            }),
          ],
        }));
      }
      return originalSubscribe(listener);
    });

    await expect(waitForStartedServerThread(threadId, 500)).resolves.toBe(true);
  });

  it("returns false after the timeout when the thread never starts", async () => {
    vi.useFakeTimers();

    const threadId = ThreadId.makeUnsafe("thread-timeout");
    useStore.setState((state) => ({
      ...state,
      threads: [makeThread({ id: threadId })],
    }));
    const promise = waitForStartedServerThread(threadId, 500);

    await vi.advanceTimersByTimeAsync(500);

    await expect(promise).resolves.toBe(false);
  });
});

describe("hasServerAcknowledgedLocalDispatch", () => {
  const projectId = ProjectId.makeUnsafe("project-1");
  const previousLatestTurn = {
    turnId: TurnId.makeUnsafe("turn-1"),
    state: "completed" as const,
    requestedAt: "2026-03-29T00:00:00.000Z",
    startedAt: "2026-03-29T00:00:01.000Z",
    completedAt: "2026-03-29T00:00:10.000Z",
    assistantMessageId: null,
  };

  const previousSession = {
    provider: "codex" as const,
    status: "ready" as const,
    createdAt: "2026-03-29T00:00:00.000Z",
    updatedAt: "2026-03-29T00:00:10.000Z",
    orchestrationStatus: "idle" as const,
  };

  it("does not clear local dispatch before server state changes", () => {
    const localDispatch = createLocalDispatchSnapshot({
      id: ThreadId.makeUnsafe("thread-1"),
      codexThreadId: null,
      projectId,
      title: "Thread",
      modelSelection: { provider: "codex", model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      session: previousSession,
      messages: [],
      proposedPlans: [],
      error: null,
      createdAt: "2026-03-29T00:00:00.000Z",
      archivedAt: null,
      updatedAt: "2026-03-29T00:00:10.000Z",
      latestTurn: previousLatestTurn,
      branch: null,
      worktreePath: null,
      turnDiffSummaries: [],
      activities: [],
    });

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "ready",
        latestTurn: previousLatestTurn,
        session: previousSession,
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(false);
  });

  it("clears local dispatch when a new turn is already settled", () => {
    const localDispatch = createLocalDispatchSnapshot({
      id: ThreadId.makeUnsafe("thread-1"),
      codexThreadId: null,
      projectId,
      title: "Thread",
      modelSelection: { provider: "codex", model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      session: previousSession,
      messages: [],
      proposedPlans: [],
      error: null,
      createdAt: "2026-03-29T00:00:00.000Z",
      archivedAt: null,
      updatedAt: "2026-03-29T00:00:10.000Z",
      latestTurn: previousLatestTurn,
      branch: null,
      worktreePath: null,
      turnDiffSummaries: [],
      activities: [],
    });

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "ready",
        latestTurn: {
          ...previousLatestTurn,
          turnId: TurnId.makeUnsafe("turn-2"),
          requestedAt: "2026-03-29T00:01:00.000Z",
          startedAt: "2026-03-29T00:01:01.000Z",
          completedAt: "2026-03-29T00:01:30.000Z",
        },
        session: {
          ...previousSession,
          updatedAt: "2026-03-29T00:01:30.000Z",
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });

  it("clears local dispatch when the session changes without an observed running phase", () => {
    const localDispatch = createLocalDispatchSnapshot({
      id: ThreadId.makeUnsafe("thread-1"),
      codexThreadId: null,
      projectId,
      title: "Thread",
      modelSelection: { provider: "codex", model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      session: previousSession,
      messages: [],
      proposedPlans: [],
      error: null,
      createdAt: "2026-03-29T00:00:00.000Z",
      archivedAt: null,
      updatedAt: "2026-03-29T00:00:10.000Z",
      latestTurn: previousLatestTurn,
      branch: null,
      worktreePath: null,
      turnDiffSummaries: [],
      activities: [],
    });

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "ready",
        latestTurn: previousLatestTurn,
        session: {
          ...previousSession,
          updatedAt: "2026-03-29T00:00:11.000Z",
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });
});

const makeComposerImage = (id: string) => {
  const file = new File([id], `${id}.png`, { type: "image/png" });
  return {
    type: "image" as const,
    id,
    name: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
    previewUrl: `blob:${id}`,
    file,
  };
};

describe("serializeComposerImages", () => {
  it("reads only new images and reuses persisted bytes for retained ones", async () => {
    const a = makeComposerImage("a");
    const b = makeComposerImage("b");
    const read = vi.fn(async (file: File) => `data:image/png;base64,${file.name}`);

    const first = await serializeComposerImages([a], [], read);
    expect(first).toEqual([
      {
        id: "a",
        name: "a.png",
        mimeType: "image/png",
        sizeBytes: 1,
        dataUrl: "data:image/png;base64,a.png",
      },
    ]);
    const second = await serializeComposerImages([a, b], first, read);
    expect(second.map((attachment) => attachment.id)).toEqual(["a", "b"]);
    expect(read).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenLastCalledWith(b.file);

    expect(await serializeComposerImages([b], second, read)).toEqual([second[1]]);
    expect(await serializeComposerImages([], second, read)).toEqual([]);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("omits images whose uncached read fails", async () => {
    const read = vi
      .fn<(file: File) => Promise<string>>()
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValueOnce("data:image/png;base64,Yg==");
    const result = await serializeComposerImages(
      [makeComposerImage("a"), makeComposerImage("b")],
      [],
      read,
    );
    expect(result.map((attachment) => attachment.id)).toEqual(["b"]);
  });
});

describe("deriveQaCardMessages", () => {
  const requested: OrchestrationThreadActivity = {
    id: EventId.makeUnsafe("activity-requested"),
    tone: "info",
    kind: "user-input.requested",
    summary: "User input requested",
    payload: {
      requestId: "req-1",
      questions: [{ id: "q1", question: "Which database?" }],
    },
    turnId: null,
    createdAt: "2026-02-27T00:00:00.000Z",
  };
  const resolvedWith = (
    answers: Record<string, string | string[]>,
  ): OrchestrationThreadActivity => ({
    id: EventId.makeUnsafe("activity-resolved"),
    tone: "info",
    kind: "user-input.resolved",
    summary: "User input submitted",
    payload: { requestId: "req-1", answers },
    turnId: null,
    createdAt: "2026-02-27T00:00:01.000Z",
  });

  it("adds a Q&A card for answers the user submitted", () => {
    const cards = deriveQaCardMessages([requested, resolvedWith({ q1: "Postgres" })]);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.text).toBe("[qa-card]\nWhich database?\tPostgres");
  });

  it("joins multi-select answers with a comma and space", () => {
    const cards = deriveQaCardMessages([requested, resolvedWith({ q1: ["Postgres", "Redis"] })]);
    expect(cards[0]?.text).toBe("[qa-card]\nWhich database?\tPostgres, Redis");
  });

  it("adds no card when the request resolved with empty answers", () => {
    expect(deriveQaCardMessages([requested, resolvedWith({})])).toEqual([]);
  });
});

function stubElement(options: {
  tagName: string;
  role?: string;
  isContentEditable?: boolean;
  insideOverlay?: boolean;
}) {
  return {
    tagName: options.tagName,
    isContentEditable: options.isContentEditable ?? false,
    getAttribute: (name: string) => (name === "role" ? (options.role ?? null) : null),
    closest: (selector: string) =>
      options.insideOverlay && selector.includes("dialog") ? ({} as Element) : null,
  };
}

describe("shouldRefocusComposerOnWindowFocus", () => {
  it("refocuses when nothing or the body holds focus", () => {
    expect(shouldRefocusComposerOnWindowFocus(null)).toBe(true);
    expect(shouldRefocusComposerOnWindowFocus(stubElement({ tagName: "BODY" }))).toBe(true);
  });

  it("takes focus back from a plain button", () => {
    expect(shouldRefocusComposerOnWindowFocus(stubElement({ tagName: "BUTTON" }))).toBe(true);
  });

  it("leaves text entry fields alone", () => {
    for (const tagName of ["INPUT", "TEXTAREA", "SELECT"]) {
      expect(shouldRefocusComposerOnWindowFocus(stubElement({ tagName })), tagName).toBe(false);
    }
    expect(
      shouldRefocusComposerOnWindowFocus(stubElement({ tagName: "DIV", isContentEditable: true })),
    ).toBe(false);
    expect(
      shouldRefocusComposerOnWindowFocus(stubElement({ tagName: "DIV", role: "textbox" })),
    ).toBe(false);
  });

  it("leaves focus inside dialogs and popups alone", () => {
    expect(
      shouldRefocusComposerOnWindowFocus(stubElement({ tagName: "BUTTON", insideOverlay: true })),
    ).toBe(false);
  });

  it("only leaves workspace areas and sidebar rows alone under keyboard focus", () => {
    const selectors: string[] = [];
    const element = {
      ...stubElement({ tagName: "DIV" }),
      closest: (selector: string) => {
        selectors.push(selector);
        return null;
      },
    };
    expect(shouldRefocusComposerOnWindowFocus(element)).toBe(true);
    expect(selectors[0]).toContain("[data-workspace-area]:focus-visible");
    expect(selectors[0]).toContain("[data-sidebar-row]:focus-visible");
    expect(selectors[0]).not.toMatch(/\[data-(workspace-area|sidebar-row)\](,|$)/);
  });
});

describe("restorePlanFollowUpComposer", () => {
  const snapshot = {
    prompt: "refine step two",
    terminalContexts: [
      {
        id: "ctx-1",
        threadId: ThreadId.makeUnsafe("thread-1"),
        terminalId: "default",
        terminalLabel: "Terminal 1",
        lineStart: 1,
        lineEnd: 2,
        text: "ls",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  };

  function makeWriters() {
    return {
      writeComposerRefs: vi.fn(),
      writePrompt: vi.fn(),
      writeTerminalContexts: vi.fn(),
      resetCursor: vi.fn(),
    };
  }

  it("restores the prompt, terminal contexts, refs and cursor on the visible thread", () => {
    const writers = makeWriters();

    const restored = restorePlanFollowUpComposer({
      snapshot,
      draftHasUserContent: false,
      threadIsCurrent: true,
      ...writers,
    });

    expect(restored).toBe(true);
    expect(writers.writeComposerRefs).toHaveBeenCalledWith(snapshot);
    expect(writers.writePrompt).toHaveBeenCalledWith("refine step two");
    expect(writers.writeTerminalContexts).toHaveBeenCalledWith(snapshot.terminalContexts);
    expect(writers.resetCursor).toHaveBeenCalledWith({
      cursor: "refine step two".length,
      prompt: "refine step two",
    });
  });

  it("keeps a newer draft typed while the send was in flight", () => {
    const writers = makeWriters();

    const restored = restorePlanFollowUpComposer({
      snapshot,
      draftHasUserContent: true,
      threadIsCurrent: true,
      ...writers,
    });

    expect(restored).toBe(false);
    expect(writers.writeComposerRefs).not.toHaveBeenCalled();
    expect(writers.writePrompt).not.toHaveBeenCalled();
    expect(writers.writeTerminalContexts).not.toHaveBeenCalled();
    expect(writers.resetCursor).not.toHaveBeenCalled();
  });

  it("puts back attached images when the snapshot has them", () => {
    const writers = makeWriters();
    const writeImages = vi.fn();
    const image: ComposerImageAttachment = {
      type: "image",
      id: "img-plan",
      name: "plan.png",
      mimeType: "image/png",
      sizeBytes: 3,
      previewUrl: "blob:plan",
      file: new File(["png"], "plan.png", { type: "image/png" }),
    };

    restorePlanFollowUpComposer({
      snapshot: { ...snapshot, images: [image] },
      draftHasUserContent: false,
      threadIsCurrent: true,
      ...writers,
      writeImages,
    });

    expect(writeImages).toHaveBeenCalledWith([image]);
  });

  it("restores the draft without touching refs or cursor once another thread is on screen", () => {
    const writers = makeWriters();

    restorePlanFollowUpComposer({
      snapshot,
      draftHasUserContent: false,
      threadIsCurrent: false,
      ...writers,
    });

    expect(writers.writePrompt).toHaveBeenCalledWith("refine step two");
    expect(writers.writeTerminalContexts).toHaveBeenCalledWith(snapshot.terminalContexts);
    expect(writers.writeComposerRefs).not.toHaveBeenCalled();
    expect(writers.resetCursor).not.toHaveBeenCalled();
  });
});

const plainKey = (key: string, overrides: Partial<KeyboardEvent> = {}) => ({
  key,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  isComposing: false,
  defaultPrevented: false,
  ...overrides,
});

describe("shouldRedirectInputToComposer", () => {
  const backgroundTarget = { closest: () => null };

  it("only redirects unhandled input on the background with no overlay open", () => {
    const event = { defaultPrevented: false };
    expect(
      shouldRedirectInputToComposer({ event, target: backgroundTarget, floatingLayerOpen: false }),
    ).toBe(true);
    expect(shouldRedirectInputToComposer({ event, target: null, floatingLayerOpen: false })).toBe(
      true,
    );
    expect(
      shouldRedirectInputToComposer({ event, target: backgroundTarget, floatingLayerOpen: true }),
    ).toBe(false);
    expect(
      shouldRedirectInputToComposer({
        event,
        target: { closest: () => ({}) as Element },
        floatingLayerOpen: false,
      }),
    ).toBe(false);
    expect(
      shouldRedirectInputToComposer({
        event: { defaultPrevented: true },
        target: backgroundTarget,
        floatingLayerOpen: false,
      }),
    ).toBe(false);
  });
});

const clipboardEvent = (text: string, files: unknown[] = [], defaultPrevented = false) => ({
  defaultPrevented,
  clipboardData: { files, getData: () => text },
});

describe("pasteTextToFocusComposer", () => {
  const backgroundTarget = { closest: () => null };

  it("returns pasted text, whitespace and all", () => {
    expect(
      pasteTextToFocusComposer({
        event: clipboardEvent("  hello\nworld "),
        target: backgroundTarget,
        floatingLayerOpen: false,
      }),
    ).toBe("  hello\nworld ");
  });

  it("normalizes line endings, as the editor's own paste does", () => {
    expect(
      pasteTextToFocusComposer({
        event: clipboardEvent("a\r\nb\rc\nd"),
        target: backgroundTarget,
        floatingLayerOpen: false,
      }),
    ).toBe("a\nb\nc\nd");
  });

  it("ignores an empty clipboard, a missing one and pasted files", () => {
    for (const event of [
      clipboardEvent(""),
      clipboardEvent("photo.png", [{}]),
      { defaultPrevented: false, clipboardData: null },
    ]) {
      expect(
        pasteTextToFocusComposer({ event, target: backgroundTarget, floatingLayerOpen: false }),
      ).toBeNull();
    }
  });

  it("leaves pastes to excluded targets, open overlays and handled events", () => {
    expect(
      pasteTextToFocusComposer({
        event: clipboardEvent("text"),
        target: { closest: () => ({}) as Element },
        floatingLayerOpen: false,
      }),
    ).toBeNull();
    expect(
      pasteTextToFocusComposer({
        event: clipboardEvent("text"),
        target: backgroundTarget,
        floatingLayerOpen: true,
      }),
    ).toBeNull();
    expect(
      pasteTextToFocusComposer({
        event: clipboardEvent("text", [], true),
        target: backgroundTarget,
        floatingLayerOpen: false,
      }),
    ).toBeNull();
  });
});

describe("shouldClaimComposerFilePaste", () => {
  const pdf = { name: "report.pdf", type: "application/pdf" };
  const png = { name: "shot.png", type: "image/png" };
  const folder = { name: "src" };

  it("always claims folders, whatever the text", () => {
    for (const plainText of ["", "src", "unrelated text"]) {
      expect(shouldClaimComposerFilePaste({ files: [], folders: [folder], plainText })).toBe(true);
    }
  });

  it("claims non-image files when the text is empty or only their names", () => {
    for (const plainText of [
      "",
      "report.pdf",
      "report.pdf\n",
      "/Users/me/report.pdf",
      "C:\\docs\\report.pdf",
    ]) {
      expect(shouldClaimComposerFilePaste({ files: [pdf], folders: [], plainText })).toBe(true);
    }
    expect(
      shouldClaimComposerFilePaste({
        files: [pdf, { name: "b.zip", type: "application/zip" }],
        folders: [],
        plainText: "report.pdf\rb.zip",
      }),
    ).toBe(true);
  });

  it("matches a file name against its text in either Unicode form", () => {
    const composed = "caf\u00e9.pdf";
    const decomposed = "cafe\u0301.pdf";
    for (const [name, plainText] of [
      [composed, decomposed],
      [decomposed, composed],
    ] as const) {
      expect(
        shouldClaimComposerFilePaste({
          files: [{ name, type: "application/pdf" }],
          folders: [],
          plainText,
        }),
      ).toBe(true);
    }
  });

  it("leaves a file paired with real text to the normal paste", () => {
    expect(
      shouldClaimComposerFilePaste({ files: [pdf], folders: [], plainText: "see the report" }),
    ).toBe(false);
    expect(
      shouldClaimComposerFilePaste({
        files: [pdf],
        folders: [],
        plainText: "report.pdf\nand more",
      }),
    ).toBe(false);
  });

  it("leaves plain text and bare images alone but stops a Finder image's name being typed", () => {
    expect(shouldClaimComposerFilePaste({ files: [], folders: [], plainText: "hello" })).toBe(
      false,
    );
    expect(shouldClaimComposerFilePaste({ files: [], folders: [], plainText: "" })).toBe(false);
    expect(shouldClaimComposerFilePaste({ files: [png], folders: [], plainText: "" })).toBe(false);
    expect(shouldClaimComposerFilePaste({ files: [png], folders: [], plainText: "cell" })).toBe(
      false,
    );
    expect(shouldClaimComposerFilePaste({ files: [png], folders: [], plainText: "shot.png" })).toBe(
      true,
    );
  });
});

describe("shouldTypeToFocusComposer", () => {
  const backgroundTarget = { closest: () => null };
  const interactiveTarget = { closest: () => ({}) as Element };

  it("redirects a printable key typed on the page background", () => {
    expect(
      shouldTypeToFocusComposer({
        event: plainKey("h"),
        target: backgroundTarget,
        floatingLayerOpen: false,
      }),
    ).toBe(true);
    expect(
      shouldTypeToFocusComposer({ event: plainKey("é"), target: null, floatingLayerOpen: false }),
    ).toBe(true);
  });

  it("ignores modifiers, composition, named keys and space", () => {
    for (const event of [
      plainKey("k", { metaKey: true }),
      plainKey("k", { ctrlKey: true }),
      plainKey("k", { altKey: true }),
      plainKey("k", { isComposing: true }),
      plainKey("k", { defaultPrevented: true }),
      plainKey("Enter"),
      plainKey("ArrowDown"),
      plainKey(" "),
    ]) {
      expect(
        shouldTypeToFocusComposer({ event, target: backgroundTarget, floatingLayerOpen: false }),
        event.key,
      ).toBe(false);
    }
  });

  it("leaves keys to inputs, buttons, links and open overlays", () => {
    expect(
      shouldTypeToFocusComposer({
        event: plainKey("h"),
        target: interactiveTarget,
        floatingLayerOpen: false,
      }),
    ).toBe(false);
    expect(
      shouldTypeToFocusComposer({
        event: plainKey("h"),
        target: backgroundTarget,
        floatingLayerOpen: true,
      }),
    ).toBe(false);
  });

  it("treats a plain role=menu (the web context-menu fallback) as an open overlay", () => {
    expect(TYPE_TO_FOCUS_FLOATING_LAYER_SELECTOR).toContain('[role="menu"]:not([hidden])');
  });
});

describe("composerSendFollowUpRequiresModifier", () => {
  it("does not depend on the prompt, so mod+Enter is never a background send in modifier modes", () => {
    expect(composerSendFollowUpRequiresModifier("enter")).toBe(false);
    expect(composerSendFollowUpRequiresModifier("mod-enter")).toBe(true);
    expect(composerSendFollowUpRequiresModifier("mod-enter-multiline")).toBe(true);
    expect(
      resolveComposerSendFollowUp({
        command: "composer.sendBackground",
        altKey: false,
        sendRequiresModifier: composerSendFollowUpRequiresModifier("mod-enter-multiline"),
        isDraftThread: true,
      }),
    ).toBeNull();
  });
});

describe("getPlanImplementationLengthValidationMessage", () => {
  it("accepts plans within the limit", () => {
    expect(
      getPlanImplementationLengthValidationMessage("a".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS)),
    ).toBeNull();
  });

  it("asks for a shorter plan instead of telling the user to shorten their prompt", () => {
    const message = getPlanImplementationLengthValidationMessage(
      "a".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS + 2),
    );
    expect(message).toContain("The proposed plan is 2 characters over the");
    expect(message).toContain("Ask the agent to shorten it.");
  });
});

describe("resolveComposerSendFollowUp", () => {
  const base = { altKey: false, sendRequiresModifier: false, isDraftThread: true };

  it("sends a draft in the background on its shortcut", () => {
    expect(resolveComposerSendFollowUp({ ...base, command: "composer.sendBackground" })).toBe(
      "background",
    );
  });

  it("keeps plain mod+Enter a normal send when the send shortcut needs the modifier", () => {
    const requiresModifier = { ...base, sendRequiresModifier: true };
    expect(
      resolveComposerSendFollowUp({ ...requiresModifier, command: "composer.sendBackground" }),
    ).toBeNull();
    expect(
      resolveComposerSendFollowUp({
        ...requiresModifier,
        altKey: true,
        command: "composer.sendBackground",
      }),
    ).toBe("background");
  });

  it("opens a new thread after sending on an existing thread only", () => {
    expect(
      resolveComposerSendFollowUp({
        ...base,
        isDraftThread: false,
        command: "composer.sendAndNewThread",
      }),
    ).toBe("new-thread");
    expect(
      resolveComposerSendFollowUp({ ...base, command: "composer.sendAndNewThread" }),
    ).toBeNull();
    expect(
      resolveComposerSendFollowUp({
        ...base,
        isDraftThread: false,
        command: "composer.sendBackground",
      }),
    ).toBeNull();
    expect(resolveComposerSendFollowUp({ ...base, command: null })).toBeNull();
  });
});

describe("buildDraftOptionsAfterBackgroundSend", () => {
  it("starts the next worktree draft from the same base branch without the old worktree", () => {
    expect(
      buildDraftOptionsAfterBackgroundSend({
        envMode: "worktree",
        branch: "main",
        worktreePath: "/repo/.worktrees/a",
      }),
    ).toEqual({ envMode: "worktree", branch: "main", worktreePath: null });
  });

  it("keeps a local draft on the same branch and checkout", () => {
    expect(
      buildDraftOptionsAfterBackgroundSend({ envMode: "local", branch: "dev", worktreePath: null }),
    ).toEqual({ envMode: "local", branch: "dev", worktreePath: null });
  });
});

describe("visiblePathSearchEntries", () => {
  const empty: string[] = [];
  const data = { entries: ["src/foo.ts"] };

  it("keeps the previous rows while the next search is fetching", () => {
    expect(
      visiblePathSearchEntries({ data, isPlaceholderData: true, isFetching: true }, empty),
    ).toBe(data.entries);
  });

  it("hides placeholder rows that no fetch will replace", () => {
    expect(
      visiblePathSearchEntries({ data, isPlaceholderData: true, isFetching: false }, empty),
    ).toBe(empty);
  });

  it("shows fetched rows and falls back to empty without data", () => {
    expect(
      visiblePathSearchEntries({ data, isPlaceholderData: false, isFetching: false }, empty),
    ).toBe(data.entries);
    expect(
      visiblePathSearchEntries(
        { data: undefined, isPlaceholderData: false, isFetching: false },
        empty,
      ),
    ).toBe(empty);
  });
});

describe("isPathSuggestionCurrent", () => {
  const searchTarget = { cwd: "/repo", query: "alpha" };

  it("allows a file suggestion matching the live search", () => {
    expect(isPathSuggestionCurrent(searchTarget, detectComposerTrigger("@alpha", 6), "/repo")).toBe(
      true,
    );
  });

  it.each([
    ["query", { cwd: "/repo", query: "alphab" }],
    ["cwd", { cwd: "/other-repo", query: "alpha" }],
  ] as const)("rejects a visible file suggestion after the live %s changes", (_change, current) => {
    const prompt = `@${current.query}`;
    expect(
      isPathSuggestionCurrent(
        searchTarget,
        detectComposerTrigger(prompt, prompt.length),
        current.cwd,
      ),
    ).toBe(false);
  });

  it("rejects suggestions that are placeholder data or not for a path trigger", () => {
    expect(isPathSuggestionCurrent(null, detectComposerTrigger("@alpha", 6), "/repo")).toBe(false);
    expect(isPathSuggestionCurrent(searchTarget, null, "/repo")).toBe(false);
    expect(isPathSuggestionCurrent(searchTarget, detectComposerTrigger("/model", 6), "/repo")).toBe(
      false,
    );
  });
});

describe("send preparation", () => {
  const ultrathinkModels = [
    {
      slug: "claude-opus-4-6",
      name: "Claude Opus 4.6",
      isCustom: false,
      capabilities: {
        reasoningEffortLevels: [{ value: "ultrathink", label: "Ultrathink" }],
        supportsFastMode: false,
        supportsThinkingToggle: false,
        contextWindowOptions: [],
        promptInjectedEffortLevels: ["ultrathink"],
      },
    },
  ];
  const terminalContext: TerminalContextDraft = {
    id: "ctx-1",
    threadId: ThreadId.makeUnsafe("thread-1"),
    terminalId: "default",
    terminalLabel: "Terminal 1",
    lineStart: 2,
    lineEnd: 3,
    text: "npm ERR! missing script",
    createdAt: "2026-03-17T12:52:29.000Z",
  };
  const image: ComposerImageAttachment = {
    type: "image",
    id: "img-1",
    name: "shot.png",
    mimeType: "image/png",
    sizeBytes: 12,
    previewUrl: "blob:preview-1",
    file: new File(["png"], "shot.png", { type: "image/png" }),
  };

  it("prefixes prompt-injected effort only for models that take it", () => {
    const base = { provider: "claudeAgent" as const, text: "fix it" };
    expect(
      formatOutgoingPrompt({
        ...base,
        model: "claude-opus-4-6",
        models: ultrathinkModels,
        effort: "ultrathink",
      }),
    ).toBe("Ultrathink:\nfix it");
    expect(
      formatOutgoingPrompt({
        ...base,
        model: "claude-opus-4-6",
        models: ultrathinkModels,
        effort: "high",
      }),
    ).toBe("fix it");
    expect(
      formatOutgoingPrompt({
        ...base,
        model: "other",
        models: ultrathinkModels,
        effort: "ultrathink",
      }),
    ).toBe("fix it");
  });

  it("appends terminal contexts and falls back to the image-only prompt", () => {
    const common = {
      provider: "claudeAgent" as const,
      model: "claude-opus-4-6",
      models: ultrathinkModels,
      effort: null,
    };
    const withContext = buildComposerOutgoingMessageText({
      ...common,
      prompt: "why does this fail?",
      terminalContexts: [terminalContext],
    });
    expect(withContext.startsWith("why does this fail?")).toBe(true);
    expect(withContext).toContain("npm ERR! missing script");
    expect(buildComposerOutgoingMessageText({ ...common, prompt: "", terminalContexts: [] })).toBe(
      IMAGE_ONLY_BOOTSTRAP_PROMPT,
    );
  });

  it("sends review comments alone, and ahead of the terminal block", () => {
    const common = {
      provider: "claudeAgent" as const,
      model: "claude-opus-4-6",
      models: ultrathinkModels,
      effort: null,
    };
    const comment = {
      id: "comment-1",
      sectionId: "uncommitted",
      sectionTitle: "Uncommitted",
      filePath: "src/app.ts",
      startIndex: 0,
      endIndex: 1,
      rangeLabel: "L1",
      text: "rename this",
      diff: "+const a = 1;",
    };
    const commentOnly = buildComposerOutgoingMessageText({
      ...common,
      prompt: "",
      terminalContexts: [],
      reviewComments: [comment],
    });
    expect(commentOnly).toContain("<review_comment");
    expect(commentOnly).toContain("rename this");
    expect(commentOnly).not.toContain(IMAGE_ONLY_BOOTSTRAP_PROMPT);

    const combined = buildComposerOutgoingMessageText({
      ...common,
      prompt: "why does this fail?",
      terminalContexts: [terminalContext],
      reviewComments: [comment],
    });
    const positions = ["why does this fail?", "<review_comment", "<terminal_context>"].map((part) =>
      combined.indexOf(part),
    );
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].toSorted((a, b) => a - b));
  });

  it("only plans a worktree for the first message of a new-worktree thread", () => {
    const base = { isFirstMessage: true, envMode: "worktree" as const, branch: "main" };
    expect(resolveWorktreeSendPlan({ ...base, worktreePath: null })).toEqual({
      shouldCreateWorktree: true,
      baseBranchForWorktree: "main",
    });
    expect(resolveWorktreeSendPlan({ ...base, branch: null, worktreePath: null })).toEqual({
      shouldCreateWorktree: true,
      baseBranchForWorktree: null,
    });
    expect(resolveWorktreeSendPlan({ ...base, worktreePath: "/wt" }).shouldCreateWorktree).toBe(
      false,
    );
    expect(resolveWorktreeSendPlan({ ...base, isFirstMessage: false, worktreePath: null })).toEqual(
      { shouldCreateWorktree: false, baseBranchForWorktree: null },
    );
    expect(resolveWorktreeSendPlan({ ...base, envMode: "local", worktreePath: null })).toEqual({
      shouldCreateWorktree: false,
      baseBranchForWorktree: null,
    });
  });

  it("builds turn attachments with image bytes and optimistic messages with previews", async () => {
    await expect(
      buildTurnStartImageAttachments([image], async (file) => `data:${file.type};base64,cG5n`),
    ).resolves.toEqual([
      {
        type: "image",
        name: "shot.png",
        mimeType: "image/png",
        sizeBytes: 12,
        dataUrl: "data:image/png;base64,cG5n",
      },
    ]);

    const id = MessageId.makeUnsafe("msg-1");
    expect(
      buildOptimisticUserMessage({ id, text: "hi", images: [image], createdAt: "2026-01-01" }),
    ).toEqual({
      id,
      role: "user",
      text: "hi",
      attachments: [
        {
          type: "image",
          id: "img-1",
          name: "shot.png",
          mimeType: "image/png",
          sizeBytes: 12,
          previewUrl: "blob:preview-1",
        },
      ],
      createdAt: "2026-01-01",
      streaming: false,
    });
    expect(
      buildOptimisticUserMessage({ id, text: "hi", images: [], createdAt: "2026-01-01" }),
    ).not.toHaveProperty("attachments");
  });

  it("titles a thread from the prompt, then the first image or terminal context", () => {
    expect(
      deriveSendThreadTitle({ trimmedPrompt: "Fix login", images: [image], terminalContexts: [] }),
    ).toBe("Fix login");
    expect(
      deriveSendThreadTitle({
        trimmedPrompt: "",
        images: [image],
        terminalContexts: [terminalContext],
      }),
    ).toBe("Image: shot.png");
    expect(
      deriveSendThreadTitle({ trimmedPrompt: "", images: [], terminalContexts: [terminalContext] }),
    ).toBe("Terminal 1 lines 2-3");
    const reviewComments = [{ filePath: "src/app.ts", rangeLabel: "L1-L3" }];
    expect(
      deriveSendThreadTitle({
        trimmedPrompt: "",
        images: [],
        terminalContexts: [],
        reviewComments,
      }),
    ).toBe("Comment on src/app.ts L1-L3");
    expect(
      deriveSendThreadTitle({
        trimmedPrompt: "",
        images: [],
        terminalContexts: [terminalContext],
        reviewComments,
      }),
    ).toBe("Terminal 1 lines 2-3");
    expect(
      deriveSendThreadTitle({
        trimmedPrompt: "",
        images: [],
        terminalContexts: [],
        reviewComments: [],
      }),
    ).toBe("New thread");
    expect(deriveSendThreadTitle({ trimmedPrompt: "", images: [], terminalContexts: [] })).toBe(
      "New thread",
    );
    expect(
      deriveSendThreadTitle({ trimmedPrompt: "x".repeat(200), images: [], terminalContexts: [] })
        .length,
    ).toBeLessThan(200);
  });

  it("falls back to the project default model, then the codex default", () => {
    expect(
      buildThreadCreateModelSelection({
        provider: "claudeAgent",
        model: "claude-opus-4-6",
        projectDefaultModel: "claude-sonnet-4-6",
        options: undefined,
      }),
    ).toEqual({ provider: "claudeAgent", model: "claude-opus-4-6" });
    expect(
      buildThreadCreateModelSelection({
        provider: "claudeAgent",
        model: null,
        projectDefaultModel: "claude-sonnet-4-6",
        options: { effort: "high" },
      }),
    ).toEqual({ provider: "claudeAgent", model: "claude-sonnet-4-6", options: { effort: "high" } });
    expect(
      buildThreadCreateModelSelection({
        provider: "codex",
        model: "",
        projectDefaultModel: undefined,
        options: undefined,
      }).model,
    ).toBe(DEFAULT_MODEL_BY_PROVIDER.codex);
  });
});

describe("canInterruptRunningTurn", () => {
  it("allows interrupting only when the phase and session are both running", () => {
    expect(canInterruptRunningTurn({ phase: "running", sessionStatus: "running" })).toBe(true);
    expect(canInterruptRunningTurn({ phase: "running", sessionStatus: "ready" })).toBe(false);
    expect(canInterruptRunningTurn({ phase: "ready", sessionStatus: "running" })).toBe(false);
    expect(canInterruptRunningTurn({ phase: "running", sessionStatus: undefined })).toBe(false);
    expect(canInterruptRunningTurn({ phase: "disconnected", sessionStatus: null })).toBe(false);
  });
});

describe("nextRuntimeModeInCycle", () => {
  it("cycles approval-required -> auto -> full-access -> approval-required", () => {
    expect(nextRuntimeModeInCycle("approval-required")).toBe("auto");
    expect(nextRuntimeModeInCycle("auto")).toBe("full-access");
    expect(nextRuntimeModeInCycle("full-access")).toBe("approval-required");
  });
});

describe("composer image total budget", () => {
  const MIB = 1024 * 1024;

  it("caps each image's estimate at the per-image limit it will be fitted to", () => {
    expect(estimateComposerImageBudgetBytes({ size: 2 * MIB })).toBe(2 * MIB);
    expect(estimateComposerImageBudgetBytes({ size: 50 * MIB })).toBe(10 * MIB);
  });

  // Relative to the shared cap so the cases hold if the server limit changes.
  const TOTAL = PROVIDER_SEND_TURN_MAX_TOTAL_IMAGE_BYTES;

  it("accepts images until the total budget would be exceeded", () => {
    const images = Array.from({ length: 5 }, (_, index) => ({ id: index, sizeBytes: 10 * MIB }));
    const result = takeComposerImagesWithinTotalBudget(TOTAL - 40 * MIB, images);
    expect(result.accepted.map((image) => image.id)).toEqual([0, 1, 2, 3]);
    expect(result.overBudget).toBe(true);
  });

  it("keeps a smaller later image that still fits", () => {
    const result = takeComposerImagesWithinTotalBudget(TOTAL - 5 * MIB, [
      { id: "big", sizeBytes: 6 * MIB },
      { id: "small", sizeBytes: 1 * MIB },
    ]);
    expect(result.accepted.map((image) => image.id)).toEqual(["small"]);
    expect(result.overBudget).toBe(true);
  });

  it("allows exactly the total budget and reports the shared error copy", () => {
    const result = takeComposerImagesWithinTotalBudget(0, [{ sizeBytes: TOTAL }]);
    expect(result).toEqual({ accepted: [{ sizeBytes: TOTAL }], overBudget: false });
    expect(COMPOSER_IMAGE_TOTAL_SIZE_ERROR).toBe(
      `Images can total up to ${TOTAL / MIB} MiB per message. Use smaller images or send fewer at once.`,
    );
  });
});

describe("buildCheckpointRevertCommand", () => {
  const base = {
    commandId: CommandId.makeUnsafe("command-1"),
    threadId: ThreadId.makeUnsafe("thread-1"),
    turnCount: 2,
    createdAt: "2026-01-01T00:00:00.000Z",
  };

  it("omits restoreFiles when files are restored", () => {
    expect(buildCheckpointRevertCommand({ ...base, restoreFiles: true })).toEqual({
      type: "thread.checkpoint.revert",
      ...base,
    });
  });

  it("sends restoreFiles false to keep file changes", () => {
    expect(buildCheckpointRevertCommand({ ...base, restoreFiles: false })).toEqual({
      type: "thread.checkpoint.revert",
      ...base,
      restoreFiles: false,
    });
  });
});

const providerSnapshot = (
  kind: ProviderKind,
  overrides: Partial<ServerProvider> = {},
): ServerProvider => ({
  provider: kind,
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-01-01T00:00:00.000Z",
  models: [],
  ...overrides,
});

describe("resolveUnlockedComposerProvider", () => {
  const snapshot = providerSnapshot;
  const claudeMissing = snapshot("claudeAgent", {
    installed: false,
    version: null,
    status: "error",
    auth: { status: "unknown" },
  });
  const providers = [claudeMissing, snapshot("codex")];

  it("defaults to an installed provider when nothing was chosen", () => {
    expect(
      resolveUnlockedComposerProvider({ providers, draftProvider: null, threadProvider: null }),
    ).toBe("codex");
  });

  it("keeps Claude while the provider list is empty", () => {
    expect(
      resolveUnlockedComposerProvider({ providers: [], draftProvider: null, threadProvider: null }),
    ).toBe("claudeAgent");
  });

  it("prefers the draft choice over the thread or project provider", () => {
    expect(
      resolveUnlockedComposerProvider({
        providers: [snapshot("claudeAgent"), snapshot("codex")],
        draftProvider: "codex",
        threadProvider: "claudeAgent",
      }),
    ).toBe("codex");
    expect(
      resolveUnlockedComposerProvider({
        providers: [snapshot("claudeAgent"), snapshot("codex")],
        draftProvider: null,
        threadProvider: "claudeAgent",
      }),
    ).toBe("claudeAgent");
  });
});

describe("queuedSendAfterImageFit", () => {
  it("drops a send queued on the thread whose image failed to fit", () => {
    expect(
      queuedSendAfterImageFit({ queuedThreadId: "a", fitThreadId: "a", fitFailed: true }),
    ).toBeNull();
  });

  it("keeps the queue when the fit succeeded or belongs to another thread", () => {
    expect(
      queuedSendAfterImageFit({ queuedThreadId: "a", fitThreadId: "a", fitFailed: false }),
    ).toBe("a");
    expect(
      queuedSendAfterImageFit({ queuedThreadId: "b", fitThreadId: "a", fitFailed: true }),
    ).toBe("b");
    expect(
      queuedSendAfterImageFit({ queuedThreadId: null, fitThreadId: "a", fitFailed: true }),
    ).toBeNull();
  });
});

describe("resolveQueuedSendFollowUp", () => {
  it("keeps the follow-up for a send held only for image fits", () => {
    expect(resolveQueuedSendFollowUp({ isRunning: false, followUp: "background" })).toEqual({
      followUp: "background",
      droppedFollowUp: false,
    });
  });

  it("drops a new-thread follow-up queued mid-turn and reports it", () => {
    expect(resolveQueuedSendFollowUp({ isRunning: true, followUp: "new-thread" })).toEqual({
      followUp: null,
      droppedFollowUp: true,
    });
    expect(resolveQueuedSendFollowUp({ isRunning: true, followUp: null })).toEqual({
      followUp: null,
      droppedFollowUp: false,
    });
  });
});

describe("shouldRestoreComposerAfterFailedSend", () => {
  const base = {
    turnStartSucceeded: false,
    movesToRetryDraft: false,
    threadIsCurrent: true,
    draftHasUserContent: true,
    liveComposerEmpty: true,
  };

  it.each([
    ["turn already started", { turnStartSucceeded: true }, false],
    ["visible thread with an empty composer", {}, true],
    ["visible thread where the user typed again", { liveComposerEmpty: false }, false],
    [
      "thread no longer visible, empty draft",
      { threadIsCurrent: false, draftHasUserContent: false },
      true,
    ],
    ["thread no longer visible, draft has content", { threadIsCurrent: false }, false],
    [
      "moving to a retry draft ignores the live composer",
      { movesToRetryDraft: true, draftHasUserContent: false, liveComposerEmpty: false },
      true,
    ],
    ["moving to a retry draft with content", { movesToRetryDraft: true }, false],
  ] as const)("%s", (_label, overrides, expected) => {
    expect(shouldRestoreComposerAfterFailedSend({ ...base, ...overrides })).toBe(expected);
  });
});

describe("findReusableProjectScriptTerminal", () => {
  const terminalIds = ["term-1", "term-2", "term-3"];

  it.each([
    {
      name: "reuses the idle active terminal",
      runningTerminalIds: ["term-2"],
      allowOtherTerminals: true,
      expected: "term-1",
    },
    {
      name: "falls back to another idle terminal when the active one is busy",
      runningTerminalIds: ["term-1", "term-2"],
      allowOtherTerminals: true,
      expected: "term-3",
    },
    {
      name: "finds nothing when every terminal is busy",
      runningTerminalIds: terminalIds,
      allowOtherTerminals: true,
      expected: null,
    },
    {
      name: "does not leave a busy active terminal when a cwd or worktree was passed",
      runningTerminalIds: ["term-1"],
      allowOtherTerminals: false,
      expected: null,
    },
  ])("$name", ({ expected, ...input }) => {
    expect(
      findReusableProjectScriptTerminal({ baseTerminalId: "term-1", terminalIds, ...input }),
    ).toBe(expected);
  });

  it("still reuses an idle active terminal when a cwd or worktree was passed", () => {
    expect(
      findReusableProjectScriptTerminal({
        baseTerminalId: "term-1",
        terminalIds,
        runningTerminalIds: [],
        allowOtherTerminals: false,
      }),
    ).toBe("term-1");
  });
});

describe("isComposerMenuOpen", () => {
  it("stays closed with no trigger", () => {
    expect(isComposerMenuOpen(null, 3)).toBe(false);
  });

  it("stays closed for a slash trigger with nothing to offer", () => {
    expect(isComposerMenuOpen({ kind: "slash-command" }, 0)).toBe(false);
    expect(isComposerMenuOpen({ kind: "slash-command" }, 1)).toBe(true);
  });

  it("keeps other menus open while they have no items, for their empty message", () => {
    expect(isComposerMenuOpen({ kind: "path" }, 0)).toBe(true);
    expect(isComposerMenuOpen({ kind: "slash-model" }, 0)).toBe(true);
  });
});

describe("resolveCompactDisabledReason", () => {
  const idle = {
    isRunning: false,
    hasPendingRequest: false,
    hasPlanFollowUp: false,
    hasDraft: false,
  };

  it("allows compaction when nothing blocks it", () => {
    expect(resolveCompactDisabledReason(idle)).toBeNull();
  });

  it("gives each reason", () => {
    expect(resolveCompactDisabledReason({ ...idle, isRunning: true })).toBe(
      "Wait for the current turn to finish",
    );
    expect(resolveCompactDisabledReason({ ...idle, hasPendingRequest: true })).toBe(
      "Answer the pending request first",
    );
    expect(resolveCompactDisabledReason({ ...idle, hasPlanFollowUp: true })).toBe(
      "Finish the plan follow-up first",
    );
    expect(resolveCompactDisabledReason({ ...idle, hasDraft: true })).toBe(
      "Send or clear your draft before compacting",
    );
  });

  it("reports the most blocking reason first", () => {
    expect(
      resolveCompactDisabledReason({
        isRunning: true,
        hasPendingRequest: true,
        hasPlanFollowUp: true,
        hasDraft: true,
      }),
    ).toBe("Wait for the current turn to finish");
    expect(
      resolveCompactDisabledReason({
        isRunning: false,
        hasPendingRequest: true,
        hasPlanFollowUp: true,
        hasDraft: true,
      }),
    ).toBe("Answer the pending request first");
    expect(resolveCompactDisabledReason({ ...idle, hasPlanFollowUp: true, hasDraft: true })).toBe(
      "Finish the plan follow-up first",
    );
  });
});

describe("PDF composer attachments", () => {
  const pdfFile = new File(["%PDF-1.7"], "spec.pdf", { type: "application/pdf" });

  it("recognises a PDF by MIME type or name", () => {
    expect(isComposerPdfFile({ name: "a.bin", type: "application/pdf" })).toBe(true);
    expect(isComposerPdfFile({ name: "SPEC.PDF", type: "" })).toBe(true);
    expect(isComposerPdfFile({ name: "shot.png", type: "image/png" })).toBe(false);
  });

  it("gives a draft PDF no preview and a real PDF type", () => {
    const untyped = buildComposerPdfAttachment(
      "pdf-1",
      new File(["%PDF-1.7"], "spec.pdf", { type: "" }),
    );
    expect(untyped.previewUrl).toBe("");
    expect(untyped.mimeType).toBe("application/pdf");
    expect(untyped.file.type).toBe("application/pdf");
    expect(untyped.sizeBytes).toBe(8);
  });

  it("sends a PDF as a file attachment and an image as an image", async () => {
    const attachments = await buildTurnStartImageAttachments(
      [
        buildComposerPdfAttachment("pdf-1", pdfFile),
        {
          type: "image",
          id: "image-1",
          name: "shot.png",
          mimeType: "image/png",
          sizeBytes: 3,
          previewUrl: "blob:shot",
          file: new File(["png"], "shot.png", { type: "image/png" }),
        },
      ],
      async () => "data:;base64,AA==",
    );
    expect(attachments).toEqual([
      {
        type: "file",
        name: "spec.pdf",
        mimeType: "application/pdf",
        sizeBytes: 8,
        dataUrl: "data:;base64,AA==",
      },
      {
        type: "image",
        name: "shot.png",
        mimeType: "image/png",
        sizeBytes: 3,
        dataUrl: "data:;base64,AA==",
      },
    ]);
  });

  it("shows a sent PDF as a file in the optimistic message", () => {
    const message = buildOptimisticUserMessage({
      id: MessageId.makeUnsafe("message-pdf"),
      text: "read this",
      images: [buildComposerPdfAttachment("pdf-1", pdfFile)],
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(message.attachments).toEqual([
      {
        type: "file",
        id: "pdf-1",
        name: "spec.pdf",
        mimeType: "application/pdf",
        sizeBytes: 8,
      },
    ]);
  });

  it("titles a PDF-only send after the document", () => {
    expect(
      deriveSendThreadTitle({
        trimmedPrompt: "",
        images: [{ name: "spec.pdf" }],
        terminalContexts: [],
      }),
    ).toBe("PDF: spec.pdf");
  });

  it("keeps a PDF out of persisted draft storage", async () => {
    await expect(
      serializeComposerImages(
        [buildComposerPdfAttachment("pdf-1", pdfFile)],
        [],
        async () => "data:;base64,AA==",
      ),
    ).resolves.toEqual([]);
  });
});

describe("settleWorktreeCreation", () => {
  const created = { worktree: { branch: "b", path: "/p" } };

  it("returns the worktree when creation succeeds", async () => {
    await expect(settleWorktreeCreation(Promise.resolve(created), () => null)).resolves.toEqual({
      status: "created",
      result: created,
    });
  });

  it("surfaces a real failure with its own message", async () => {
    const failure = new Error("branch already exists");
    const settled = settleWorktreeCreation(Promise.reject(failure), () => null);
    await expect(settled).rejects.toBe(failure);
    expect(resolveFailedSendErrorMessage(failure)).toBe("branch already exists");
  });

  it("turns an aborted creation into a cancel that reports no error", async () => {
    const settled = settleWorktreeCreation(
      Promise.reject(new Error("interrupted")),
      () => "cancel",
    );
    const error = await settled.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ComposerSendCancelledError);
    expect(resolveFailedSendErrorMessage(error)).toBeNull();
  });

  it("lets a send carry on locally without an error", async () => {
    await expect(
      settleWorktreeCreation(Promise.reject(new Error("interrupted")), () => "work-locally"),
    ).resolves.toEqual({ status: "work-locally" });
  });

  it("keeps a worktree that finished before the abort landed", async () => {
    await expect(settleWorktreeCreation(Promise.resolve(created), () => "cancel")).resolves.toEqual(
      { status: "created", result: created },
    );
  });

  it("falls back to a generic message for a non-Error failure", () => {
    expect(resolveFailedSendErrorMessage("nope")).toBe("Failed to send message.");
  });
});

describe("buildSearchableModelOptions", () => {
  const modelOptionsByProvider = {
    claudeAgent: [{ slug: "claude-opus-4-6", name: "Claude Opus" }],
    codex: [{ slug: "gpt-5.4", name: "GPT-5.4" }],
  };
  const enabled = [
    { provider: "claudeAgent" as const, enabled: true },
    { provider: "codex" as const, enabled: true },
  ];
  const slugs = (input: Partial<Parameters<typeof buildSearchableModelOptions>[0]>) =>
    buildSearchableModelOptions({
      modelOptionsByProvider,
      lockedProvider: null,
      providerStatuses: enabled,
      ...input,
    }).map((option) => option.slug);

  it("offers both providers, labelled and lowercased for search", () => {
    expect(slugs({})).toEqual(["claude-opus-4-6", "gpt-5.4"]);
    const [claude] = buildSearchableModelOptions({
      modelOptionsByProvider,
      lockedProvider: null,
      providerStatuses: enabled,
    });
    expect(claude).toMatchObject({
      provider: "claudeAgent",
      searchName: "claude opus",
      searchProvider: claude!.providerLabel.toLowerCase(),
    });
  });

  it("keeps a locked thread on its own provider", () => {
    expect(slugs({ lockedProvider: "codex" })).toEqual(["gpt-5.4"]);
    expect(slugs({ lockedProvider: "claudeAgent" })).toEqual(["claude-opus-4-6"]);
  });

  it("leaves out a disabled provider, but not one with no status yet", () => {
    expect(
      slugs({
        providerStatuses: [
          { provider: "claudeAgent", enabled: true },
          { provider: "codex", enabled: false },
        ],
      }),
    ).toEqual(["claude-opus-4-6"]);
    expect(slugs({ providerStatuses: [] })).toEqual(["claude-opus-4-6", "gpt-5.4"]);
  });
});

describe("resolvePullRequestSetupRequest", () => {
  const prepared = {
    targetThreadId: ThreadId.makeUnsafe("thread-pr"),
    worktreePath: "/repo/worktrees/pr-1",
    scriptId: "setup",
  };
  const request = {
    threadId: prepared.targetThreadId,
    worktreePath: prepared.worktreePath,
    scriptId: prepared.scriptId,
  };

  it("skips setup for a reused worktree that did not move", () => {
    expect(resolvePullRequestSetupRequest({ ...prepared, checkoutChanged: false })).toBeNull();
  });

  it.each([true, undefined])("runs setup when checkoutChanged is %s", (checkoutChanged) => {
    expect(resolvePullRequestSetupRequest({ ...prepared, checkoutChanged })).toEqual(request);
  });

  it.each([{ targetThreadId: null }, { worktreePath: null }, { scriptId: null }])(
    "has nothing to run without %o",
    (missing) => {
      expect(
        resolvePullRequestSetupRequest({ ...prepared, ...missing, checkoutChanged: true }),
      ).toBeNull();
    },
  );
});

const message = (id: string) =>
  ({
    id,
    role: "user",
    text: "x",
    createdAt: "2026-01-01T00:00:00.000Z",
    streaming: false,
  }) as never;

describe("dropAsyncAnswerMessagesWithQaCards", () => {
  it("removes an answer's message once its card exists, and nothing else", () => {
    const messages = [message("async-answer:r1"), message("async-answer:r2"), message("plain")];
    const result = dropAsyncAnswerMessagesWithQaCards(messages, [message("qa-r1")]);
    expect(result.map((entry) => (entry as { id: string }).id)).toEqual([
      "async-answer:r2",
      "plain",
    ]);
  });

  it("returns the same array when nothing is removed", () => {
    const messages = [message("async-answer:r1")];
    expect(dropAsyncAnswerMessagesWithQaCards(messages, [])).toBe(messages);
    expect(dropAsyncAnswerMessagesWithQaCards(messages, [message("qa-other")])).toBe(messages);
  });
});

describe("formatOutgoingPrompt and slash commands", () => {
  const models = [
    {
      slug: "claude-opus-4-6",
      name: "Opus",
      isCustom: false,
      capabilities: {
        reasoningEffortLevels: [],
        supportsFastMode: false,
        supportsThinkingToggle: false,
        contextWindowOptions: [],
        promptInjectedEffortLevels: ["ultrathink"],
      },
    },
  ] as never;
  const format = (text: string) =>
    formatOutgoingPrompt({
      provider: "claudeAgent",
      model: "claude-opus-4-6",
      models,
      effort: "ultrathink",
      text,
    });

  it("leaves a slash command unprefixed, so Claude still expands it", () => {
    expect(format("/compact")).toBe("/compact");
    expect(format("  /review the diff")).toBe("  /review the diff");
  });

  it("still prefixes a path and plain text", () => {
    expect(format("/usr/bin is odd")).toMatch(/^Ultrathink:/);
    expect(format("hello")).toMatch(/^Ultrathink:/);
  });
});

describe("buildComposerOutgoingMessageText for an attachment-only send", () => {
  const base = {
    prompt: "",
    terminalContexts: [],
    provider: "codex",
    model: null,
    models: [],
    effort: null,
  } as const;

  it("does not tell the model a PDF is an image", () => {
    expect(buildComposerOutgoingMessageText({ ...base, hasNonImageAttachment: true })).toBe(
      ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
    );
    expect(buildComposerOutgoingMessageText({ ...base })).toBe(IMAGE_ONLY_BOOTSTRAP_PROMPT);
  });
});

describe("chatEmptyStateHeading", () => {
  const project = (name: string, archivedAt: string | null) => ({
    id: ProjectId.makeUnsafe(name),
    name,
    archivedAt,
  });

  it("names the first project that is not archived", () => {
    expect(
      chatEmptyStateHeading([project("old", "2026-01-01T00:00:00.000Z"), project("live", null)]),
    ).toBe("Let's pipe some code in live");
  });

  it("names no project when every project is archived", () => {
    expect(chatEmptyStateHeading([project("old", "2026-01-01T00:00:00.000Z")])).toBe(
      "Let's pipe some code in",
    );
    expect(chatEmptyStateHeading([])).toBe("Let's pipe some code in");
  });
});
