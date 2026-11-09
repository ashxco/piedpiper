import * as Schema from "effect/Schema";
import {
  ProjectId,
  ThreadId,
  type ModelSelection,
  type ProviderModelOptions,
} from "@piedpiper/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  COMPOSER_DRAFT_STORAGE_KEY,
  clearPromotedDraftThread,
  clearPromotedDraftThreads,
  type ComposerImageAttachment,
  composerDraftHasUserContent,
  discardComposerDraftContent,
  moveFailedFirstSendToDraftThread,
  selectThreadHasUnsentDraft,
  useComposerDraftStore,
  deriveEffectiveComposerModelState,
} from "./composerDraftStore";
import { removeLocalStorageItem, setLocalStorageItem } from "./hooks/useLocalStorage";
import { partializeComposerDraftStoreState } from "./lib/composerDraftPersistence";
import {
  INLINE_TERMINAL_CONTEXT_PLACEHOLDER,
  insertInlineTerminalContextPlaceholder,
  type TerminalContextDraft,
} from "./lib/terminalContext";
import { createDebouncedStorage, createDeferredStorage } from "./lib/storage";
import { useReviewCommentDraftStore } from "./reviewCommentDraftStore";

function makeImage(input: {
  id: string;
  previewUrl: string;
  name?: string;
  mimeType?: string;
  sizeBytes?: number;
  lastModified?: number;
}): ComposerImageAttachment {
  const name = input.name ?? "image.png";
  const mimeType = input.mimeType ?? "image/png";
  const sizeBytes = input.sizeBytes ?? 4;
  const lastModified = input.lastModified ?? 1_700_000_000_000;
  const file = new File([new Uint8Array(sizeBytes).fill(1)], name, {
    type: mimeType,
    lastModified,
  });
  return {
    type: "image",
    id: input.id,
    name,
    mimeType,
    sizeBytes: file.size,
    previewUrl: input.previewUrl,
    file,
  };
}

function makeTerminalContext(input: {
  id: string;
  text?: string;
  terminalId?: string;
  terminalLabel?: string;
  lineStart?: number;
  lineEnd?: number;
}): TerminalContextDraft {
  return {
    id: input.id,
    threadId: ThreadId.makeUnsafe("thread-dedupe"),
    terminalId: input.terminalId ?? "default",
    terminalLabel: input.terminalLabel ?? "Terminal 1",
    lineStart: input.lineStart ?? 4,
    lineEnd: input.lineEnd ?? 5,
    text: input.text ?? "git status\nOn branch main",
    createdAt: "2026-03-13T12:00:00.000Z",
  };
}

function resetComposerDraftStore() {
  useComposerDraftStore.setState({
    draftsByThreadId: {},
    draftThreadsByThreadId: {},
    projectDraftThreadIdByProjectId: {},
    stickyModelSelectionByProvider: {},
    stickyActiveProvider: null,
  });
}

function modelSelection(
  provider: "codex" | "claudeAgent",
  model: string,
  options?: ModelSelection["options"],
): ModelSelection {
  return {
    provider,
    model,
    ...(options ? { options } : {}),
  } as ModelSelection;
}

function providerModelOptions(options: ProviderModelOptions): ProviderModelOptions {
  return options;
}

describe("composerDraftStore addImages", () => {
  const threadId = ThreadId.makeUnsafe("thread-dedupe");
  let originalRevokeObjectUrl: typeof URL.revokeObjectURL;
  let revokeSpy: ReturnType<typeof vi.fn<(url: string) => void>>;

  beforeEach(() => {
    resetComposerDraftStore();
    originalRevokeObjectUrl = URL.revokeObjectURL;
    revokeSpy = vi.fn();
    URL.revokeObjectURL = revokeSpy;
  });

  afterEach(() => {
    URL.revokeObjectURL = originalRevokeObjectUrl;
  });

  it("deduplicates identical images in one batch by file signature", () => {
    const first = makeImage({
      id: "img-1",
      previewUrl: "blob:first",
      name: "same.png",
      mimeType: "image/png",
      sizeBytes: 12,
      lastModified: 12345,
    });
    const duplicate = makeImage({
      id: "img-2",
      previewUrl: "blob:duplicate",
      name: "same.png",
      mimeType: "image/png",
      sizeBytes: 12,
      lastModified: 12345,
    });

    useComposerDraftStore.getState().addImages(threadId, [first, duplicate]);

    const draft = useComposerDraftStore.getState().draftsByThreadId[threadId];
    expect(draft?.images.map((image) => image.id)).toEqual(["img-1"]);
    expect(revokeSpy).toHaveBeenCalledWith("blob:duplicate");
  });

  it("deduplicates against existing images across calls by file signature", () => {
    const first = makeImage({
      id: "img-a",
      previewUrl: "blob:a",
      name: "same.png",
      mimeType: "image/png",
      sizeBytes: 9,
      lastModified: 777,
    });
    const duplicateLater = makeImage({
      id: "img-b",
      previewUrl: "blob:b",
      name: "same.png",
      mimeType: "image/png",
      sizeBytes: 9,
      lastModified: 999,
    });

    useComposerDraftStore.getState().addImage(threadId, first);
    useComposerDraftStore.getState().addImage(threadId, duplicateLater);

    const draft = useComposerDraftStore.getState().draftsByThreadId[threadId];
    expect(draft?.images.map((image) => image.id)).toEqual(["img-a"]);
    expect(revokeSpy).toHaveBeenCalledWith("blob:b");
  });

  it("does not revoke blob URLs that are still used by an accepted duplicate image", () => {
    const first = makeImage({
      id: "img-shared",
      previewUrl: "blob:shared",
    });
    const duplicateSameUrl = makeImage({
      id: "img-shared",
      previewUrl: "blob:shared",
    });

    useComposerDraftStore.getState().addImages(threadId, [first, duplicateSameUrl]);

    const draft = useComposerDraftStore.getState().draftsByThreadId[threadId];
    expect(draft?.images.map((image) => image.id)).toEqual(["img-shared"]);
    expect(revokeSpy).not.toHaveBeenCalledWith("blob:shared");
  });
});

describe("composerDraftStore clearComposerContent", () => {
  const threadId = ThreadId.makeUnsafe("thread-clear");
  let originalRevokeObjectUrl: typeof URL.revokeObjectURL;
  let revokeSpy: ReturnType<typeof vi.fn<(url: string) => void>>;

  beforeEach(() => {
    resetComposerDraftStore();
    originalRevokeObjectUrl = URL.revokeObjectURL;
    revokeSpy = vi.fn();
    URL.revokeObjectURL = revokeSpy;
  });

  afterEach(() => {
    URL.revokeObjectURL = originalRevokeObjectUrl;
  });

  it("does not revoke blob preview URLs when clearing composer content", () => {
    const first = makeImage({
      id: "img-optimistic",
      previewUrl: "blob:optimistic",
    });
    useComposerDraftStore.getState().addImage(threadId, first);

    useComposerDraftStore.getState().clearComposerContent(threadId);

    const draft = useComposerDraftStore.getState().draftsByThreadId[threadId];
    expect(draft).toBeUndefined();
    expect(revokeSpy).not.toHaveBeenCalledWith("blob:optimistic");
  });
});

describe("unsent draft marker", () => {
  const threadId = ThreadId.makeUnsafe("thread-unsent");
  let originalRevokeObjectUrl: typeof URL.revokeObjectURL;
  let revokeSpy: ReturnType<typeof vi.fn<(url: string) => void>>;

  beforeEach(() => {
    resetComposerDraftStore();
    originalRevokeObjectUrl = URL.revokeObjectURL;
    revokeSpy = vi.fn();
    URL.revokeObjectURL = revokeSpy;
  });

  afterEach(() => {
    URL.revokeObjectURL = originalRevokeObjectUrl;
  });

  it("flags threads with typed text, images or terminal contexts, but not settings alone", () => {
    const hasDraft = () => selectThreadHasUnsentDraft(useComposerDraftStore.getState(), threadId);
    expect(hasDraft()).toBe(false);
    useComposerDraftStore.getState().setRuntimeMode(threadId, "approval-required");
    expect(hasDraft()).toBe(false);
    useComposerDraftStore.getState().setPrompt(threadId, "half a thought");
    expect(hasDraft()).toBe(true);
    useComposerDraftStore.getState().setPrompt(threadId, "");
    useComposerDraftStore
      .getState()
      .addImage(threadId, makeImage({ id: "img-1", previewUrl: "blob:draft" }));
    expect(hasDraft()).toBe(true);
    expect(
      selectThreadHasUnsentDraft(useComposerDraftStore.getState(), ThreadId.makeUnsafe("other")),
    ).toBe(false);
  });

  it("only changes when a draft appears or disappears, not on every keystroke", () => {
    const changes: boolean[] = [];
    let previous = selectThreadHasUnsentDraft(useComposerDraftStore.getState(), threadId);
    const unsubscribe = useComposerDraftStore.subscribe((state) => {
      const next = selectThreadHasUnsentDraft(state, threadId);
      if (next !== previous) changes.push(next);
      previous = next;
    });
    for (const prompt of ["h", "he", "hel", "hello", ""]) {
      useComposerDraftStore.getState().setPrompt(threadId, prompt);
    }
    unsubscribe();
    expect(changes).toEqual([true, false]);
  });

  it("discards the draft content and revokes image preview URLs", () => {
    useComposerDraftStore.getState().setPrompt(threadId, "draft");
    useComposerDraftStore
      .getState()
      .addImage(threadId, makeImage({ id: "img-2", previewUrl: "blob:discard" }));

    discardComposerDraftContent(threadId);

    expect(selectThreadHasUnsentDraft(useComposerDraftStore.getState(), threadId)).toBe(false);
    expect(revokeSpy).toHaveBeenCalledWith("blob:discard");
  });
});

describe("composerDraftStore syncPersistedAttachments", () => {
  const threadId = ThreadId.makeUnsafe("thread-sync-persisted");

  beforeEach(() => {
    removeLocalStorageItem(COMPOSER_DRAFT_STORAGE_KEY);
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
      stickyModelSelectionByProvider: {},
      stickyActiveProvider: null,
    });
  });

  afterEach(() => {
    removeLocalStorageItem(COMPOSER_DRAFT_STORAGE_KEY);
  });

  it("treats malformed persisted draft storage as empty", async () => {
    const image = makeImage({
      id: "img-persisted",
      previewUrl: "blob:persisted",
    });
    useComposerDraftStore.getState().addImage(threadId, image);
    setLocalStorageItem(
      COMPOSER_DRAFT_STORAGE_KEY,
      {
        version: 2,
        state: {
          draftsByThreadId: {
            [threadId]: {
              attachments: "not-an-array",
            },
          },
        },
      },
      Schema.Unknown,
    );

    useComposerDraftStore.getState().syncPersistedAttachments(threadId, [
      {
        id: image.id,
        name: image.name,
        mimeType: image.mimeType,
        sizeBytes: image.sizeBytes,
        dataUrl: image.previewUrl,
      },
    ]);
    await Promise.resolve();

    expect(
      useComposerDraftStore.getState().draftsByThreadId[threadId]?.persistedAttachments,
    ).toEqual([]);
    expect(
      useComposerDraftStore.getState().draftsByThreadId[threadId]?.nonPersistedImageIds,
    ).toEqual([image.id]);
  });
});

describe("composerDraftStore terminal contexts", () => {
  const threadId = ThreadId.makeUnsafe("thread-dedupe");

  beforeEach(() => {
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
      stickyModelSelectionByProvider: {},
      stickyActiveProvider: null,
    });
  });

  it("deduplicates identical terminal contexts by selection signature", () => {
    const first = makeTerminalContext({ id: "ctx-1" });
    const duplicate = makeTerminalContext({ id: "ctx-2" });

    useComposerDraftStore.getState().addTerminalContexts(threadId, [first, duplicate]);

    const draft = useComposerDraftStore.getState().draftsByThreadId[threadId];
    expect(draft?.terminalContexts.map((context) => context.id)).toEqual(["ctx-1"]);
  });

  it("caps oversized terminal selections when they are added", () => {
    useComposerDraftStore
      .getState()
      .addTerminalContext(
        threadId,
        makeTerminalContext({ id: "ctx-big", text: "z".repeat(200_000) }),
      );

    const text =
      useComposerDraftStore.getState().draftsByThreadId[threadId]?.terminalContexts[0]?.text;
    expect(text?.length).toBe(64_000);
    expect(text?.endsWith("… truncated …")).toBe(true);
  });

  it("clears terminal contexts when clearing composer content", () => {
    useComposerDraftStore
      .getState()
      .addTerminalContext(threadId, makeTerminalContext({ id: "ctx-1" }));

    useComposerDraftStore.getState().clearComposerContent(threadId);

    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toBeUndefined();
  });

  it("inserts terminal contexts at the requested inline prompt position", () => {
    const firstInsertion = insertInlineTerminalContextPlaceholder("alpha beta", 6);
    const secondInsertion = insertInlineTerminalContextPlaceholder(firstInsertion.prompt, 0);

    expect(
      useComposerDraftStore
        .getState()
        .insertTerminalContext(
          threadId,
          firstInsertion.prompt,
          makeTerminalContext({ id: "ctx-1" }),
          firstInsertion.contextIndex,
        ),
    ).toBe(true);
    expect(
      useComposerDraftStore.getState().insertTerminalContext(
        threadId,
        secondInsertion.prompt,
        makeTerminalContext({
          id: "ctx-2",
          terminalLabel: "Terminal 2",
          lineStart: 9,
          lineEnd: 10,
        }),
        secondInsertion.contextIndex,
      ),
    ).toBe(true);

    const draft = useComposerDraftStore.getState().draftsByThreadId[threadId];
    expect(draft?.prompt).toBe(
      `${INLINE_TERMINAL_CONTEXT_PLACEHOLDER} alpha ${INLINE_TERMINAL_CONTEXT_PLACEHOLDER} beta`,
    );
    expect(draft?.terminalContexts.map((context) => context.id)).toEqual(["ctx-2", "ctx-1"]);
  });

  it("omits terminal context text from persisted drafts", () => {
    useComposerDraftStore
      .getState()
      .addTerminalContext(threadId, makeTerminalContext({ id: "ctx-persist" }));

    const persistedState = partializeComposerDraftStoreState(
      useComposerDraftStore.getState(),
    ) as unknown as {
      draftsByThreadId?: Record<string, { terminalContexts?: Array<Record<string, unknown>> }>;
    };

    expect(
      persistedState.draftsByThreadId?.[threadId]?.terminalContexts?.[0],
      "Expected terminal context metadata to be persisted.",
    ).toMatchObject({
      id: "ctx-persist",
      terminalId: "default",
      terminalLabel: "Terminal 1",
      lineStart: 4,
      lineEnd: 5,
    });
    expect(
      persistedState.draftsByThreadId?.[threadId]?.terminalContexts?.[0]?.text,
    ).toBeUndefined();
  });

  it("hydrates persisted terminal contexts without in-memory snapshot text", () => {
    const persistApi = useComposerDraftStore.persist as unknown as {
      getOptions: () => {
        merge: (
          persistedState: unknown,
          currentState: ReturnType<typeof useComposerDraftStore.getState>,
        ) => ReturnType<typeof useComposerDraftStore.getState>;
      };
    };
    const mergedState = persistApi.getOptions().merge(
      {
        draftsByThreadId: {
          [threadId]: {
            prompt: INLINE_TERMINAL_CONTEXT_PLACEHOLDER,
            attachments: [],
            terminalContexts: [
              {
                id: "ctx-rehydrated",
                threadId,
                createdAt: "2026-03-13T12:00:00.000Z",
                terminalId: "default",
                terminalLabel: "Terminal 1",
                lineStart: 4,
                lineEnd: 5,
              },
            ],
          },
        },
        draftThreadsByThreadId: {},
        projectDraftThreadIdByProjectId: {},
      },
      useComposerDraftStore.getInitialState(),
    );

    expect(mergedState.draftsByThreadId[threadId]?.terminalContexts).toMatchObject([
      {
        id: "ctx-rehydrated",
        terminalId: "default",
        terminalLabel: "Terminal 1",
        lineStart: 4,
        lineEnd: 5,
        text: "",
      },
    ]);
  });

  it("sanitizes malformed persisted drafts during merge", () => {
    const persistApi = useComposerDraftStore.persist as unknown as {
      getOptions: () => {
        merge: (
          persistedState: unknown,
          currentState: ReturnType<typeof useComposerDraftStore.getState>,
        ) => ReturnType<typeof useComposerDraftStore.getState>;
      };
    };
    const mergedState = persistApi.getOptions().merge(
      {
        draftsByThreadId: {
          [threadId]: {
            prompt: "",
            attachments: "not-an-array",
            terminalContexts: "not-an-array",
            provider: "bogus-provider",
            modelOptions: "not-an-object",
          },
        },
        draftThreadsByThreadId: "not-an-object",
        projectDraftThreadIdByProjectId: "not-an-object",
      },
      useComposerDraftStore.getInitialState(),
    );

    expect(mergedState.draftsByThreadId[threadId]).toBeUndefined();
    expect(mergedState.draftThreadsByThreadId).toEqual({});
    expect(mergedState.projectDraftThreadIdByProjectId).toEqual({});
  });
});

describe("composerDraftStore project draft thread mapping", () => {
  const projectId = ProjectId.makeUnsafe("project-a");
  const otherProjectId = ProjectId.makeUnsafe("project-b");
  const threadId = ThreadId.makeUnsafe("thread-a");
  const otherThreadId = ThreadId.makeUnsafe("thread-b");

  beforeEach(() => {
    resetComposerDraftStore();
  });

  it("stores and reads project draft thread ids via actions", () => {
    const store = useComposerDraftStore.getState();
    expect(store.getDraftThreadByProjectId(projectId)).toBeNull();
    expect(store.getDraftThread(threadId)).toBeNull();

    store.setProjectDraftThreadId(projectId, threadId, {
      branch: "feature/test",
      worktreePath: "/tmp/worktree-test",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(useComposerDraftStore.getState().getDraftThreadByProjectId(projectId)).toEqual({
      threadId,
      projectId,
      branch: "feature/test",
      worktreePath: "/tmp/worktree-test",
      envMode: "worktree",
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(useComposerDraftStore.getState().getDraftThread(threadId)).toEqual({
      projectId,
      branch: "feature/test",
      worktreePath: "/tmp/worktree-test",
      envMode: "worktree",
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("clears only matching project draft mapping entries", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, threadId);
    store.setPrompt(threadId, "hello");

    store.clearProjectDraftThreadById(projectId, otherThreadId);
    expect(useComposerDraftStore.getState().getDraftThreadByProjectId(projectId)?.threadId).toBe(
      threadId,
    );

    store.clearProjectDraftThreadById(projectId, threadId);
    expect(useComposerDraftStore.getState().getDraftThreadByProjectId(projectId)).toBeNull();
    expect(useComposerDraftStore.getState().getDraftThread(threadId)).toBeNull();
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toBeUndefined();
  });

  it("clears project draft mapping by project id", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, threadId);
    store.setPrompt(threadId, "hello");
    store.clearProjectDraftThreadId(projectId);
    expect(useComposerDraftStore.getState().getDraftThreadByProjectId(projectId)).toBeNull();
    expect(useComposerDraftStore.getState().getDraftThread(threadId)).toBeNull();
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toBeUndefined();
  });

  it("clears orphaned composer drafts when remapping a project to a new draft thread", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, threadId);
    store.setPrompt(threadId, "orphan me");

    store.setProjectDraftThreadId(projectId, otherThreadId);

    expect(useComposerDraftStore.getState().getDraftThreadByProjectId(projectId)?.threadId).toBe(
      otherThreadId,
    );
    expect(useComposerDraftStore.getState().getDraftThread(threadId)).toBeNull();
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toBeUndefined();
  });

  it("keeps composer drafts when the thread is still mapped by another project", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, threadId);
    store.setProjectDraftThreadId(otherProjectId, threadId);
    store.setPrompt(threadId, "keep me");

    store.clearProjectDraftThreadId(projectId);

    expect(useComposerDraftStore.getState().getDraftThreadByProjectId(projectId)).toBeNull();
    expect(
      useComposerDraftStore.getState().getDraftThreadByProjectId(otherProjectId)?.threadId,
    ).toBe(threadId);
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.prompt).toBe("keep me");
  });

  it("clears draft registration independently", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, threadId);
    store.setPrompt(threadId, "remove me");
    store.clearDraftThread(threadId);
    expect(useComposerDraftStore.getState().getDraftThreadByProjectId(projectId)).toBeNull();
    expect(useComposerDraftStore.getState().getDraftThread(threadId)).toBeNull();
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toBeUndefined();
  });

  it("clears a deleted thread's diff comments with its draft", () => {
    const comment = {
      id: "comment-1",
      sectionId: "turn-1",
      sectionTitle: "Turn 1",
      filePath: "src/app.ts",
      startIndex: 1,
      endIndex: 1,
      rangeLabel: "line 11",
      text: "Rename this",
      diff: "+new line",
    };
    useReviewCommentDraftStore.getState().addComment(threadId, comment);

    useComposerDraftStore.getState().clearDraftThread(threadId);

    expect(useReviewCommentDraftStore.getState().commentsByThreadId[threadId]).toBeUndefined();
  });

  it("clears a promoted draft by thread id", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, threadId);

    clearPromotedDraftThread(threadId);

    expect(useComposerDraftStore.getState().getDraftThreadByProjectId(projectId)).toBeNull();
    expect(useComposerDraftStore.getState().getDraftThread(threadId)).toBeNull();
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toBeUndefined();
  });

  it("keeps composer content typed after the first send when the draft thread is promoted", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, threadId);
    store.setPrompt(threadId, "first message");
    // Sending clears the composer; the user then types before thread.created arrives.
    store.clearComposerContent(threadId);
    store.setPrompt(threadId, "typed after send");

    clearPromotedDraftThread(threadId);

    expect(useComposerDraftStore.getState().getDraftThreadByProjectId(projectId)).toBeNull();
    expect(useComposerDraftStore.getState().getDraftThread(threadId)).toBeNull();
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.prompt).toBe(
      "typed after send",
    );
  });

  it("drops a model-only composer record when the draft thread is promoted", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, threadId);
    store.setModelSelection(threadId, modelSelection("codex", "gpt-5.4"));
    store.setPrompt(threadId, "first message");
    store.clearComposerContent(threadId);
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toBeDefined();

    clearPromotedDraftThread(threadId);

    expect(useComposerDraftStore.getState().getDraftThread(threadId)).toBeNull();
    expect(useComposerDraftStore.getState().getDraftThreadByProjectId(projectId)).toBeNull();
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toBeUndefined();
  });

  it("finalizePromotedDraftThread is a no-op without draft metadata and keeps content", () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(threadId, "server thread text");
    const before = useComposerDraftStore.getState();

    store.finalizePromotedDraftThread(threadId);

    expect(useComposerDraftStore.getState()).toBe(before);
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.prompt).toBe(
      "server thread text",
    );
  });

  it("does not clear composer drafts for existing server threads during promotion cleanup", () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(threadId, "keep me");

    clearPromotedDraftThread(threadId);

    expect(useComposerDraftStore.getState().getDraftThread(threadId)).toBeNull();
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.prompt).toBe("keep me");
  });

  it("clears promoted drafts from an iterable of server thread ids", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, threadId);
    store.setPrompt(threadId, "promote me");
    store.setProjectDraftThreadId(otherProjectId, otherThreadId);
    store.setPrompt(otherThreadId, "keep me");

    clearPromotedDraftThreads([threadId]);

    expect(useComposerDraftStore.getState().getDraftThread(threadId)).toBeNull();
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.prompt).toBe("promote me");
    expect(
      useComposerDraftStore.getState().getDraftThreadByProjectId(otherProjectId)?.threadId,
    ).toBe(otherThreadId);
    expect(useComposerDraftStore.getState().draftsByThreadId[otherThreadId]?.prompt).toBe(
      "keep me",
    );
  });

  it("keeps existing server-thread composer drafts during iterable promotion cleanup", () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(threadId, "keep me");

    clearPromotedDraftThreads([threadId]);

    expect(useComposerDraftStore.getState().getDraftThread(threadId)).toBeNull();
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.prompt).toBe("keep me");
  });

  it("updates branch context on an existing draft thread", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, threadId, {
      branch: "main",
      worktreePath: null,
    });
    store.setDraftThreadContext(threadId, {
      branch: "feature/next",
      worktreePath: "/tmp/feature-next",
    });
    expect(useComposerDraftStore.getState().getDraftThreadByProjectId(projectId)?.threadId).toBe(
      threadId,
    );
    expect(useComposerDraftStore.getState().getDraftThread(threadId)).toMatchObject({
      projectId,
      branch: "feature/next",
      worktreePath: "/tmp/feature-next",
      envMode: "worktree",
    });
  });

  it("preserves existing branch and worktree when setProjectDraftThreadId receives undefined", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, threadId, {
      branch: "main",
      worktreePath: "/tmp/main-worktree",
    });
    const runtimeUndefinedOptions = {
      branch: undefined,
      worktreePath: undefined,
    } as unknown as {
      branch?: string | null;
      worktreePath?: string | null;
    };
    store.setProjectDraftThreadId(projectId, threadId, runtimeUndefinedOptions);

    expect(useComposerDraftStore.getState().getDraftThread(threadId)).toMatchObject({
      projectId,
      branch: "main",
      worktreePath: "/tmp/main-worktree",
      envMode: "worktree",
    });
  });

  it("preserves worktree env mode without a worktree path", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, threadId, {
      branch: "feature/base",
      worktreePath: null,
      envMode: "worktree",
    });
    const runtimeUndefinedOptions = {
      branch: undefined,
      worktreePath: undefined,
      envMode: undefined,
    } as unknown as {
      branch?: string | null;
      worktreePath?: string | null;
      envMode?: "local" | "worktree";
    };
    store.setProjectDraftThreadId(projectId, threadId, runtimeUndefinedOptions);

    expect(useComposerDraftStore.getState().getDraftThread(threadId)).toMatchObject({
      projectId,
      branch: "feature/base",
      worktreePath: null,
      envMode: "worktree",
    });
  });

  it("skips a promoting draft for project reuse and restores it once the flag clears", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, threadId, { branch: "main" });
    store.setDraftThreadPromoting(threadId, true);

    expect(useComposerDraftStore.getState().getDraftThreadByProjectId(projectId)).toBeNull();
    expect(
      useComposerDraftStore
        .getState()
        .getDraftThreadByProjectId(projectId, { includePromoting: true })?.threadId,
    ).toBe(threadId);
    expect(useComposerDraftStore.getState().getDraftThread(threadId)?.promoting).toBe(true);

    store.setDraftThreadPromoting(threadId, false);
    expect(useComposerDraftStore.getState().getDraftThreadByProjectId(projectId)).toEqual(
      expect.objectContaining({ threadId, branch: "main" }),
    );
    expect(useComposerDraftStore.getState().getDraftThread(threadId)).not.toHaveProperty(
      "promoting",
    );
  });

  it("keeps a promoting draft when a fresh draft takes over the project", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, threadId);
    store.setPrompt(threadId, "in flight");
    store.setDraftThreadPromoting(threadId, true);

    store.clearProjectDraftThreadId(projectId);
    store.setProjectDraftThreadId(projectId, otherThreadId);

    const state = useComposerDraftStore.getState();
    expect(state.getDraftThreadByProjectId(projectId)?.threadId).toBe(otherThreadId);
    expect(state.getDraftThread(threadId)?.promoting).toBe(true);
    expect(state.draftsByThreadId[threadId]?.prompt).toBe("in flight");

    // A failed send leaves the draft unmapped while the fresh draft owns the project.
    store.setDraftThreadPromoting(threadId, false);
    expect(useComposerDraftStore.getState().getDraftThreadByProjectId(projectId)?.threadId).toBe(
      otherThreadId,
    );
    expect(useComposerDraftStore.getState().getDraftThread(threadId)).not.toBeNull();
  });

  it("drops a promoting draft once the server thread is finalized", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, threadId);
    store.setDraftThreadPromoting(threadId, true);

    clearPromotedDraftThreads([threadId]);

    expect(useComposerDraftStore.getState().getDraftThread(threadId)).toBeNull();
    expect(
      useComposerDraftStore.getState().getDraftThreadByProjectId(projectId, {
        includePromoting: true,
      }),
    ).toBeNull();
  });
});

describe("moveFailedFirstSendToDraftThread", () => {
  const projectId = ProjectId.makeUnsafe("project-a");
  const failedThreadId = ThreadId.makeUnsafe("thread-failed");
  const retryThreadId = ThreadId.makeUnsafe("thread-retry");
  const draftThread = {
    createdAt: "2026-01-01T00:00:00.000Z",
    runtimeMode: "full-access" as const,
    interactionMode: "plan" as const,
    branch: "main",
    worktreePath: null,
    envMode: "worktree" as const,
  };

  beforeEach(() => {
    resetComposerDraftStore();
  });

  it("restores the unsent message into a new draft thread that survives thread.deleted cleanup", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, failedThreadId, draftThread);
    // Send clears composer content and thread.created finalizes the draft before the failure.
    store.clearComposerContent(failedThreadId);
    clearPromotedDraftThread(failedThreadId);

    const image = makeImage({ id: "img-1", previewUrl: "blob:img-1" });
    const context = makeTerminalContext({ id: "ctx-1" });
    const prompt = `${INLINE_TERMINAL_CONTEXT_PLACEHOLDER} retry this`;
    moveFailedFirstSendToDraftThread({
      fromThreadId: failedThreadId,
      toThreadId: retryThreadId,
      projectId,
      draftThread,
      restore: { prompt, images: [image], terminalContexts: [context] },
    });
    // The rollback's thread.deleted event lands after the restore.
    const revokeSpy = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    useComposerDraftStore.getState().clearDraftThread(failedThreadId);

    const state = useComposerDraftStore.getState();
    expect(revokeSpy).not.toHaveBeenCalled();
    revokeSpy.mockRestore();
    expect(state.draftsByThreadId[failedThreadId]).toBeUndefined();
    expect(state.getDraftThreadByProjectId(projectId)).toMatchObject({
      threadId: retryThreadId,
      branch: "main",
      envMode: "worktree",
      interactionMode: "plan",
    });
    const retryDraft = state.draftsByThreadId[retryThreadId];
    expect(retryDraft?.prompt).toBe(prompt);
    expect(retryDraft?.images.map((entry) => entry.id)).toEqual(["img-1"]);
    expect(retryDraft?.terminalContexts).toEqual([{ ...context, threadId: retryThreadId }]);
  });

  it("moves diff comments so the rollback's cleanup does not lose them", () => {
    const comment = {
      id: "comment-1",
      sectionId: "turn-1",
      sectionTitle: "Turn 1",
      filePath: "src/app.ts",
      startIndex: 1,
      endIndex: 1,
      rangeLabel: "line 11",
      text: "Rename this",
      diff: "+new line",
    };
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, failedThreadId, draftThread);
    useReviewCommentDraftStore.getState().addComment(failedThreadId, comment);

    moveFailedFirstSendToDraftThread({
      fromThreadId: failedThreadId,
      toThreadId: retryThreadId,
      projectId,
      draftThread,
      restore: null,
    });
    useComposerDraftStore.getState().clearDraftThread(failedThreadId);

    const { commentsByThreadId } = useReviewCommentDraftStore.getState();
    expect(commentsByThreadId[failedThreadId]).toBeUndefined();
    expect(commentsByThreadId[retryThreadId]).toEqual([comment]);
    useReviewCommentDraftStore.getState().clearComments(retryThreadId);
  });

  it("keeps text typed during the failed send instead of overwriting it", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, failedThreadId, draftThread);
    store.setModelSelection(failedThreadId, modelSelection("codex", "gpt-5.4"));
    store.setPrompt(failedThreadId, "typed while sending");

    moveFailedFirstSendToDraftThread({
      fromThreadId: failedThreadId,
      toThreadId: retryThreadId,
      projectId,
      draftThread,
      restore: null,
    });
    useComposerDraftStore.getState().clearDraftThread(failedThreadId);

    const state = useComposerDraftStore.getState();
    expect(state.draftsByThreadId[retryThreadId]?.prompt).toBe("typed while sending");
    expect(state.draftsByThreadId[retryThreadId]?.modelSelectionByProvider.codex?.model).toBe(
      "gpt-5.4",
    );
    expect(state.getDraftThread(failedThreadId)).toBeNull();
    expect(state.getDraftThread(retryThreadId)?.projectId).toBe(projectId);
  });

  it("does not delete another draft thread that took over the project mapping", () => {
    const otherThreadId = ThreadId.makeUnsafe("thread-other-draft");
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, failedThreadId, draftThread);
    store.clearComposerContent(failedThreadId);
    clearPromotedDraftThread(failedThreadId);
    // The user opens a new draft for the project and starts typing before turn.start fails.
    store.setProjectDraftThreadId(projectId, otherThreadId, draftThread);
    store.setPrompt(otherThreadId, "unrelated draft");
    store.addImages(otherThreadId, [makeImage({ id: "img-other", previewUrl: "blob:other" })]);
    const revokeSpy = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    moveFailedFirstSendToDraftThread({
      fromThreadId: failedThreadId,
      toThreadId: retryThreadId,
      projectId,
      draftThread,
      restore: { prompt: "retry this", images: [], terminalContexts: [] },
    });
    useComposerDraftStore.getState().clearDraftThread(failedThreadId);

    const state = useComposerDraftStore.getState();
    expect(revokeSpy).not.toHaveBeenCalled();
    revokeSpy.mockRestore();
    expect(state.projectDraftThreadIdByProjectId[projectId]).toBe(otherThreadId);
    expect(state.getDraftThread(otherThreadId)?.projectId).toBe(projectId);
    expect(state.draftsByThreadId[otherThreadId]?.prompt).toBe("unrelated draft");
    expect(state.draftsByThreadId[otherThreadId]?.images.map((entry) => entry.id)).toEqual([
      "img-other",
    ]);
    expect(state.getDraftThread(retryThreadId)).toMatchObject({ projectId, branch: "main" });
    expect(state.draftsByThreadId[retryThreadId]?.prompt).toBe("retry this");
  });
});

describe("composerDraftHasUserContent", () => {
  beforeEach(() => {
    resetComposerDraftStore();
  });

  it("reports whether a thread's own draft has user content", () => {
    const threadId = ThreadId.makeUnsafe("thread-content");
    expect(composerDraftHasUserContent(threadId)).toBe(false);
    useComposerDraftStore.getState().setPrompt(threadId, "hello");
    expect(composerDraftHasUserContent(threadId)).toBe(true);
    useComposerDraftStore.getState().setPrompt(threadId, "");
    expect(composerDraftHasUserContent(threadId)).toBe(false);
  });
});

describe("composerDraftStore modelSelection", () => {
  const threadId = ThreadId.makeUnsafe("thread-model-options");

  beforeEach(() => {
    resetComposerDraftStore();
  });

  it("stores a model selection in the draft", () => {
    const store = useComposerDraftStore.getState();
    store.setModelSelection(
      threadId,
      modelSelection("codex", "gpt-5.3-codex", {
        reasoningEffort: "xhigh",
        fastMode: true,
      }),
    );

    expect(
      useComposerDraftStore.getState().draftsByThreadId[threadId]?.modelSelectionByProvider.codex,
    ).toEqual(
      modelSelection("codex", "gpt-5.3-codex", {
        reasoningEffort: "xhigh",
        fastMode: true,
      }),
    );
  });

  it("keeps default-only model selections on the draft", () => {
    const store = useComposerDraftStore.getState();
    store.setModelSelection(threadId, modelSelection("codex", "gpt-5.4"));

    expect(
      useComposerDraftStore.getState().draftsByThreadId[threadId]?.modelSelectionByProvider.codex,
    ).toEqual(modelSelection("codex", "gpt-5.4"));
  });

  it("replaces only the targeted provider options on the current model selection", () => {
    const store = useComposerDraftStore.getState();

    store.setModelSelection(
      threadId,
      modelSelection("claudeAgent", "claude-opus-4-6", {
        effort: "max",
        fastMode: true,
      }),
    );
    store.setStickyModelSelection(
      modelSelection("claudeAgent", "claude-opus-4-6", {
        effort: "max",
        fastMode: true,
      }),
    );

    store.setProviderModelOptions(
      threadId,
      "claudeAgent",
      {
        thinking: false,
      },
      { persistSticky: true },
    );

    expect(
      useComposerDraftStore.getState().draftsByThreadId[threadId]?.modelSelectionByProvider
        .claudeAgent,
    ).toEqual(
      modelSelection("claudeAgent", "claude-opus-4-6", {
        thinking: false,
      }),
    );
    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider.claudeAgent).toEqual(
      modelSelection("claudeAgent", "claude-opus-4-6", {
        thinking: false,
      }),
    );
  });

  it("keeps explicit default-state overrides on the selection", () => {
    const store = useComposerDraftStore.getState();

    store.setModelSelection(
      threadId,
      modelSelection("claudeAgent", "claude-opus-4-6", {
        effort: "max",
      }),
    );

    store.setProviderModelOptions(threadId, "claudeAgent", {
      thinking: true,
    });

    expect(
      useComposerDraftStore.getState().draftsByThreadId[threadId]?.modelSelectionByProvider
        .claudeAgent,
    ).toEqual(
      modelSelection("claudeAgent", "claude-opus-4-6", {
        thinking: true,
      }),
    );
    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider).toEqual({});
  });

  it("keeps explicit off/default codex overrides on the selection", () => {
    const store = useComposerDraftStore.getState();

    store.setModelSelection(threadId, modelSelection("codex", "gpt-5.4", { fastMode: true }));

    store.setProviderModelOptions(threadId, "codex", {
      reasoningEffort: "high",
      fastMode: false,
    });

    expect(
      useComposerDraftStore.getState().draftsByThreadId[threadId]?.modelSelectionByProvider.codex,
    ).toEqual(
      modelSelection("codex", "gpt-5.4", {
        reasoningEffort: "high",
        fastMode: false,
      }),
    );
  });

  it("updates only the draft when sticky persistence is omitted", () => {
    const store = useComposerDraftStore.getState();

    store.setStickyModelSelection(
      modelSelection("claudeAgent", "claude-opus-4-6", { effort: "max" }),
    );
    store.setModelSelection(
      threadId,
      modelSelection("claudeAgent", "claude-opus-4-6", { effort: "max" }),
    );

    store.setProviderModelOptions(threadId, "claudeAgent", {
      thinking: false,
    });

    expect(
      useComposerDraftStore.getState().draftsByThreadId[threadId]?.modelSelectionByProvider
        .claudeAgent,
    ).toEqual(
      modelSelection("claudeAgent", "claude-opus-4-6", {
        thinking: false,
      }),
    );
    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider.claudeAgent).toEqual(
      modelSelection("claudeAgent", "claude-opus-4-6", { effort: "max" }),
    );
  });

  it("does not clear other provider options when setting options for a single provider", () => {
    const store = useComposerDraftStore.getState();

    // Set options for both providers
    store.setModelOptions(
      threadId,
      providerModelOptions({
        codex: { fastMode: true },
        claudeAgent: { effort: "max" },
      }),
    );

    // Now set options for only codex — claudeAgent should be untouched
    store.setModelOptions(threadId, providerModelOptions({ codex: { reasoningEffort: "xhigh" } }));

    const draft = useComposerDraftStore.getState().draftsByThreadId[threadId];
    expect(draft?.modelSelectionByProvider.codex?.options).toEqual({ reasoningEffort: "xhigh" });
    expect(draft?.modelSelectionByProvider.claudeAgent?.options).toEqual({ effort: "max" });
  });

  it("preserves other provider options when switching the active model selection", () => {
    const store = useComposerDraftStore.getState();

    store.setModelOptions(
      threadId,
      providerModelOptions({
        codex: { fastMode: true },
        claudeAgent: { effort: "max" },
      }),
    );

    store.setModelSelection(threadId, modelSelection("claudeAgent", "claude-opus-4-6"));

    const draft = useComposerDraftStore.getState().draftsByThreadId[threadId];
    expect(draft?.modelSelectionByProvider.claudeAgent).toEqual(
      modelSelection("claudeAgent", "claude-opus-4-6", { effort: "max" }),
    );
    expect(draft?.modelSelectionByProvider.codex?.options).toEqual({ fastMode: true });
    expect(draft?.activeProvider).toBe("claudeAgent");
  });

  it("creates the first sticky snapshot from provider option changes", () => {
    const store = useComposerDraftStore.getState();

    store.setModelSelection(threadId, modelSelection("codex", "gpt-5.4"));

    store.setProviderModelOptions(
      threadId,
      "codex",
      {
        fastMode: true,
      },
      { persistSticky: true },
    );

    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider.codex).toEqual(
      modelSelection("codex", "gpt-5.4", {
        fastMode: true,
      }),
    );
  });

  it("updates only the draft when sticky persistence is disabled", () => {
    const store = useComposerDraftStore.getState();

    store.setStickyModelSelection(
      modelSelection("claudeAgent", "claude-opus-4-6", { effort: "max" }),
    );
    store.setModelSelection(
      threadId,
      modelSelection("claudeAgent", "claude-opus-4-6", { effort: "max" }),
    );

    store.setProviderModelOptions(
      threadId,
      "claudeAgent",
      {
        thinking: false,
      },
      { persistSticky: false },
    );

    expect(
      useComposerDraftStore.getState().draftsByThreadId[threadId]?.modelSelectionByProvider
        .claudeAgent,
    ).toEqual(
      modelSelection("claudeAgent", "claude-opus-4-6", {
        thinking: false,
      }),
    );
    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider.claudeAgent).toEqual(
      modelSelection("claudeAgent", "claude-opus-4-6", { effort: "max" }),
    );
  });
});

describe("composerDraftStore setModelSelection", () => {
  const threadId = ThreadId.makeUnsafe("thread-model");

  beforeEach(() => {
    resetComposerDraftStore();
  });

  it("keeps explicit model overrides instead of coercing to null", () => {
    const store = useComposerDraftStore.getState();

    store.setModelSelection(threadId, modelSelection("codex", "gpt-5.3-codex"));

    expect(
      useComposerDraftStore.getState().draftsByThreadId[threadId]?.modelSelectionByProvider.codex,
    ).toEqual(modelSelection("codex", "gpt-5.3-codex"));
  });
});

describe("composerDraftStore sticky composer settings", () => {
  beforeEach(() => {
    resetComposerDraftStore();
  });

  it("stores a sticky model selection", () => {
    const store = useComposerDraftStore.getState();

    store.setStickyModelSelection(
      modelSelection("codex", "gpt-5.3-codex", {
        reasoningEffort: "medium",
        fastMode: true,
      }),
    );

    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider.codex).toEqual(
      modelSelection("codex", "gpt-5.3-codex", {
        reasoningEffort: "medium",
        fastMode: true,
      }),
    );
    expect(useComposerDraftStore.getState().stickyActiveProvider).toBe("codex");
  });

  it("normalizes empty sticky model options by dropping selection options", () => {
    const store = useComposerDraftStore.getState();

    store.setStickyModelSelection(modelSelection("codex", "gpt-5.4"));

    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider.codex).toEqual(
      modelSelection("codex", "gpt-5.4"),
    );
    expect(useComposerDraftStore.getState().stickyActiveProvider).toBe("codex");
  });

  it("keeps remembered sticky options when only the model changes", () => {
    const store = useComposerDraftStore.getState();

    store.setStickyModelSelection(
      modelSelection("codex", "gpt-5.3-codex", { reasoningEffort: "high", fastMode: true }),
    );
    store.setStickyModelSelection(modelSelection("codex", "gpt-5.4"));

    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider.codex).toEqual(
      modelSelection("codex", "gpt-5.4", { reasoningEffort: "high", fastMode: true }),
    );
  });

  it("replaces sticky options when the update carries its own options", () => {
    const store = useComposerDraftStore.getState();

    store.setStickyModelSelection(
      modelSelection("codex", "gpt-5.3-codex", { reasoningEffort: "high", fastMode: true }),
    );
    store.setStickyModelSelection(modelSelection("codex", "gpt-5.4", { reasoningEffort: "low" }));

    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider.codex).toEqual(
      modelSelection("codex", "gpt-5.4", { reasoningEffort: "low" }),
    );
  });

  it("applies sticky activeProvider to new drafts", () => {
    const store = useComposerDraftStore.getState();
    const threadId = ThreadId.makeUnsafe("thread-sticky-active-provider");

    store.setStickyModelSelection(modelSelection("claudeAgent", "claude-opus-4-6"));
    store.applyStickyState(threadId);

    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toMatchObject({
      modelSelectionByProvider: {
        claudeAgent: modelSelection("claudeAgent", "claude-opus-4-6"),
      },
      activeProvider: "claudeAgent",
    });
  });
});

describe("composerDraftStore provider-scoped option updates", () => {
  const threadId = ThreadId.makeUnsafe("thread-provider");

  beforeEach(() => {
    resetComposerDraftStore();
  });

  it("retains off-provider option memory without changing the active selection", () => {
    const store = useComposerDraftStore.getState();
    store.setModelSelection(
      threadId,
      modelSelection("codex", "gpt-5.3-codex", {
        reasoningEffort: "medium",
      }),
    );
    store.setProviderModelOptions(threadId, "claudeAgent", { effort: "max" });
    const draft = useComposerDraftStore.getState().draftsByThreadId[threadId];
    expect(draft?.modelSelectionByProvider.codex).toEqual(
      modelSelection("codex", "gpt-5.3-codex", { reasoningEffort: "medium" }),
    );
    expect(draft?.modelSelectionByProvider.claudeAgent?.options).toEqual({ effort: "max" });
    expect(draft?.activeProvider).toBe("codex");
  });
});

describe("composerDraftStore runtime and interaction settings", () => {
  const threadId = ThreadId.makeUnsafe("thread-settings");

  beforeEach(() => {
    resetComposerDraftStore();
  });

  it("stores runtime mode overrides in the composer draft", () => {
    const store = useComposerDraftStore.getState();

    store.setRuntimeMode(threadId, "approval-required");

    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.runtimeMode).toBe(
      "approval-required",
    );
  });

  it("stores the Auto runtime mode in the composer draft", () => {
    useComposerDraftStore.getState().setRuntimeMode(threadId, "auto");

    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.runtimeMode).toBe("auto");
  });

  it("stores interaction mode overrides in the composer draft", () => {
    const store = useComposerDraftStore.getState();

    store.setInteractionMode(threadId, "plan");

    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.interactionMode).toBe(
      "plan",
    );
  });

  it("removes empty settings-only drafts when overrides are cleared", () => {
    const store = useComposerDraftStore.getState();

    store.setRuntimeMode(threadId, "approval-required");
    store.setInteractionMode(threadId, "plan");
    store.setRuntimeMode(threadId, null);
    store.setInteractionMode(threadId, null);

    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// createDebouncedStorage
// ---------------------------------------------------------------------------

function createMockStorage() {
  const store = new Map<string, string>();
  return {
    getItem: vi.fn((name: string) => store.get(name) ?? null),
    setItem: vi.fn((name: string, value: string) => {
      store.set(name, value);
    }),
    removeItem: vi.fn((name: string) => {
      store.delete(name);
    }),
  };
}

describe("createDebouncedStorage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("delegates getItem immediately", () => {
    const base = createMockStorage();
    base.getItem.mockReturnValueOnce("value");
    const storage = createDebouncedStorage(base);

    expect(storage.getItem("key")).toBe("value");
    expect(base.getItem).toHaveBeenCalledWith("key");
  });

  it("does not write to base storage until the debounce fires", () => {
    const base = createMockStorage();
    const storage = createDebouncedStorage(base);

    storage.setItem("key", "v1");
    expect(base.setItem).not.toHaveBeenCalled();

    vi.advanceTimersByTime(299);
    expect(base.setItem).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(base.setItem).toHaveBeenCalledWith("key", "v1");
  });

  it("only writes the last value when setItem is called rapidly", () => {
    const base = createMockStorage();
    const storage = createDebouncedStorage(base);

    storage.setItem("key", "v1");
    storage.setItem("key", "v2");
    storage.setItem("key", "v3");

    vi.advanceTimersByTime(300);
    expect(base.setItem).toHaveBeenCalledTimes(1);
    expect(base.setItem).toHaveBeenCalledWith("key", "v3");
  });

  it("removeItem drops the captured value so flush writes nothing afterwards", () => {
    const base = createMockStorage();
    const storage = createDebouncedStorage(base);

    storage.setItem("key", "v1");
    storage.removeItem("key");
    storage.flush();
    vi.advanceTimersByTime(300);

    expect(base.setItem).not.toHaveBeenCalled();
  });

  it("removeItem cancels a pending setItem write", () => {
    const base = createMockStorage();
    const storage = createDebouncedStorage(base);

    storage.setItem("key", "v1");
    storage.removeItem("key");

    vi.advanceTimersByTime(300);
    expect(base.setItem).not.toHaveBeenCalled();
    expect(base.removeItem).toHaveBeenCalledWith("key");
  });

  it("flush writes the pending value immediately", () => {
    const base = createMockStorage();
    const storage = createDebouncedStorage(base);

    storage.setItem("key", "v1");
    expect(base.setItem).not.toHaveBeenCalled();

    storage.flush();
    expect(base.setItem).toHaveBeenCalledWith("key", "v1");

    // Timer should be cancelled; no duplicate write.
    vi.advanceTimersByTime(300);
    expect(base.setItem).toHaveBeenCalledTimes(1);
  });

  it("flush is a no-op when nothing is pending", () => {
    const base = createMockStorage();
    const storage = createDebouncedStorage(base);

    storage.flush();
    expect(base.setItem).not.toHaveBeenCalled();
  });

  it("flush after removeItem is a no-op", () => {
    const base = createMockStorage();
    const storage = createDebouncedStorage(base);

    storage.setItem("key", "v1");
    storage.removeItem("key");
    storage.flush();

    expect(base.setItem).not.toHaveBeenCalled();
  });

  it("setItem works normally after removeItem cancels a pending write", () => {
    const base = createMockStorage();
    const storage = createDebouncedStorage(base);

    storage.setItem("key", "v1");
    storage.removeItem("key");
    storage.setItem("key", "v2");

    vi.advanceTimersByTime(300);
    expect(base.setItem).toHaveBeenCalledTimes(1);
    expect(base.setItem).toHaveBeenCalledWith("key", "v2");
  });
});

// ---------------------------------------------------------------------------
// Deferred composer draft serialization
// ---------------------------------------------------------------------------

describe("composer draft persistence", () => {
  const threadId = ThreadId.makeUnsafe("thread-deferred");
  const heavyThreadId = ThreadId.makeUnsafe("thread-heavy");

  beforeEach(async () => {
    await useComposerDraftStore.persist.clearStorage();
    resetComposerDraftStore();
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await useComposerDraftStore.persist.clearStorage();
    resetComposerDraftStore();
  });

  it("defers the draft walk and JSON serialization until the debounce fires", async () => {
    useComposerDraftStore.getState().setPrompt(heavyThreadId, "keep this image");
    const attachments = [
      {
        id: "heavy-image",
        name: "image.png",
        mimeType: "image/png",
        sizeBytes: 4096,
        dataUrl: `data:image/png;base64,${"AQID".repeat(1024)}`,
      },
    ];
    let attachmentReads = 0;
    useComposerDraftStore.setState((state) => ({
      draftsByThreadId: {
        ...state.draftsByThreadId,
        [heavyThreadId]: {
          ...state.draftsByThreadId[heavyThreadId]!,
          get persistedAttachments() {
            attachmentReads += 1;
            return attachments;
          },
        },
      },
    }));
    attachmentReads = 0;
    const stringify = vi.spyOn(JSON, "stringify");
    try {
      for (let index = 1; index <= 20; index++) {
        useComposerDraftStore.getState().setPrompt(threadId, `Draft ${index}`);
      }
      expect(attachmentReads).toBe(0);
      expect(stringify).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(300);
      expect(attachmentReads).toBe(1);
      expect(stringify).toHaveBeenCalledTimes(1);

      resetComposerDraftStore();
      await useComposerDraftStore.persist.rehydrate();
      expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.prompt).toBe("Draft 20");
      expect(
        useComposerDraftStore.getState().draftsByThreadId[heavyThreadId]?.persistedAttachments,
      ).toEqual(attachments);
    } finally {
      stringify.mockRestore();
    }
  });

  it("drops a pending write when storage is cleared", async () => {
    useComposerDraftStore.getState().setPrompt(threadId, "never persisted");
    await useComposerDraftStore.persist.clearStorage();
    await vi.advanceTimersByTimeAsync(300);

    resetComposerDraftStore();
    await useComposerDraftStore.persist.rehydrate();
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toBeUndefined();
  });
});

describe("createDeferredStorage", () => {
  const serialize = vi.fn((value: string) => `s:${value}`);

  beforeEach(() => {
    vi.useFakeTimers();
    serialize.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("neither serializes nor writes until the debounce fires", () => {
    const base = createMockStorage();
    const storage = createDeferredStorage(base, serialize);

    storage.setItem("key", "v1");
    storage.setItem("key", "v2");
    expect(serialize).not.toHaveBeenCalled();
    expect(base.setItem).not.toHaveBeenCalled();

    vi.advanceTimersByTime(300);
    expect(serialize).toHaveBeenCalledTimes(1);
    expect(base.setItem).toHaveBeenCalledTimes(1);
    expect(base.setItem).toHaveBeenCalledWith("key", "s:v2");
  });

  it("flush serializes and writes the pending value immediately", () => {
    const base = createMockStorage();
    const storage = createDeferredStorage(base, serialize);

    storage.setItem("key", "v1");
    storage.flush();
    expect(base.setItem).toHaveBeenCalledWith("key", "s:v1");

    vi.advanceTimersByTime(300);
    expect(serialize).toHaveBeenCalledTimes(1);
    expect(base.setItem).toHaveBeenCalledTimes(1);
  });

  it("delegates getItem to the base storage immediately", () => {
    const base = createMockStorage();
    base.setItem("key", "stored");
    base.setItem.mockClear();
    const storage = createDeferredStorage(base, serialize);

    expect(storage.getItem("key")).toBe("stored");
    expect(base.getItem).toHaveBeenCalledWith("key");
  });

  it("flush is a no-op when nothing is pending", () => {
    const base = createMockStorage();
    const storage = createDeferredStorage(base, serialize);

    storage.flush();
    expect(serialize).not.toHaveBeenCalled();
    expect(base.setItem).not.toHaveBeenCalled();
  });

  it("setItem writes normally after removeItem cancels a pending write", () => {
    const base = createMockStorage();
    const storage = createDeferredStorage(base, serialize);

    storage.setItem("key", "v1");
    storage.removeItem("key");
    storage.setItem("key", "v2");
    vi.advanceTimersByTime(300);

    expect(base.setItem).toHaveBeenCalledTimes(1);
    expect(base.setItem).toHaveBeenCalledWith("key", "s:v2");
  });

  it("removeItem drops the pending value so a later flush writes nothing", () => {
    const base = createMockStorage();
    const storage = createDeferredStorage(base, serialize);

    storage.setItem("key", "v1");
    storage.removeItem("key");
    storage.flush();
    vi.advanceTimersByTime(300);

    expect(base.removeItem).toHaveBeenCalledWith("key");
    expect(serialize).not.toHaveBeenCalled();
    expect(base.setItem).not.toHaveBeenCalled();
  });
});

describe("deriveEffectiveComposerModelState and an old CLI", () => {
  const providers = [
    {
      provider: "claudeAgent",
      enabled: true,
      installed: true,
      status: "ready",
      models: [{ slug: "claude-sonnet-4-6", name: "Sonnet", isCustom: false, capabilities: null }],
      updateRequiredModels: [{ slug: "claude-opus-5-5", name: "Opus 5.5", minVersion: "2.1.280" }],
    },
  ] as never;

  it("falls back to a runnable model for a thread created with a gated one", () => {
    const { selectedModel } = deriveEffectiveComposerModelState({
      draft: null,
      providers,
      selectedProvider: "claudeAgent",
      threadModelSelection: { provider: "claudeAgent", model: "claude-opus-5-5" },
      projectModelSelection: null,
      settings: {} as never,
    });
    expect(selectedModel).toBe("claude-sonnet-4-6");
  });

  it("keeps a model the CLI can run", () => {
    const { selectedModel } = deriveEffectiveComposerModelState({
      draft: null,
      providers,
      selectedProvider: "claudeAgent",
      threadModelSelection: { provider: "claudeAgent", model: "claude-sonnet-4-6" },
      projectModelSelection: null,
      settings: {} as never,
    });
    expect(selectedModel).toBe("claude-sonnet-4-6");
  });
});
