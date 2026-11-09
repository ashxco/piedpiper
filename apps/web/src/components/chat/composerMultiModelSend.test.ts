import {
  type ModelSelection,
  ProjectId,
  type ProjectScript,
  type ServerProvider,
  ThreadId,
} from "@piedpiper/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type ComposerImageAttachment,
  composerDraftHasUserContent,
  useComposerDraftStore,
} from "../../composerDraftStore";
import {
  ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
  IMAGE_ONLY_BOOTSTRAP_PROMPT,
} from "@piedpiper/shared/imageOnlyBootstrapPrompt";
import { toastManager } from "../ui/toast";
import {
  planComposerMultiModelSend,
  runComposerMultiModelSend,
  sendComposerMultiModel,
} from "./composerMultiModelSend";
import {
  readComposerMultiModelSelections,
  setComposerMultiModelSelections,
  useComposerMultiModelStore,
} from "./composerMultiModelStore";
import { useReviewCommentDraftStore } from "../../reviewCommentDraftStore";
import type { ReviewCommentContext } from "../../reviewCommentContext";

vi.mock("../ui/toast", () => ({
  toastManager: { add: vi.fn(() => "toast-id"), update: vi.fn(), close: vi.fn() },
}));

const OPUS: ModelSelection = {
  provider: "claudeAgent",
  model: "claude-opus-4-6",
  options: { effort: "high" },
};
const GPT: ModelSelection = { provider: "codex", model: "gpt-5.4" };

function provider(
  kind: ServerProvider["provider"],
  enabled = true,
  overrides: Partial<ServerProvider> = {},
): ServerProvider {
  return {
    provider: kind,
    enabled,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [],
    ...overrides,
  };
}
const PROVIDERS = [provider("claudeAgent"), provider("codex")];
const THREAD_ID = ThreadId.makeUnsafe("thread-draft");
const SETUP_SCRIPT: ProjectScript = {
  id: "setup",
  name: "Setup",
  command: "bun install",
  icon: "configure",
  runOnWorktreeCreate: true,
};

const REVIEW_COMMENT: ReviewCommentContext = {
  id: "comment-1",
  sectionId: "section-1",
  sectionTitle: "Uncommitted",
  filePath: "src/a.ts",
  startIndex: 3,
  endIndex: 3,
  rangeLabel: "line 3",
  text: "needs a guard",
  diff: "+const a = 1;",
};

const planBase = {
  isGitRepo: true,
  baseBranch: "main",
  selections: [OPUS, GPT],
  primarySelection: OPUS,
  providers: PROVIDERS,
  prompt: "do it",
  trimmedPrompt: "do it",
  images: [],
  terminalContexts: [],
};

describe("planComposerMultiModelSend", () => {
  it("builds a target per selection", () => {
    const plan = planComposerMultiModelSend(planBase);
    expect(plan).toMatchObject({ ok: true, title: "do it", baseBranch: "main" });
    if (!plan.ok) throw new Error(plan.error);
    expect(plan.targets.map((target) => target.selection.model)).toEqual([OPUS.model, GPT.model]);
    expect(plan.targets.every((target) => target.text === "do it")).toBe(true);
  });

  it("rejects a project that is not a Git repository", () => {
    expect(planComposerMultiModelSend({ ...planBase, isGitRepo: false })).toMatchObject({
      ok: false,
      error: "Sending to several models needs a Git project.",
    });
  });

  it("rejects a missing base branch and an empty selection", () => {
    expect(planComposerMultiModelSend({ ...planBase, baseBranch: null }).ok).toBe(false);
    expect(planComposerMultiModelSend({ ...planBase, selections: [] }).ok).toBe(false);
  });

  it("rejects a disabled provider before anything is sent", () => {
    expect(
      planComposerMultiModelSend({
        ...planBase,
        providers: [provider("claudeAgent"), provider("codex", false)],
      }),
    ).toMatchObject({ ok: false, error: "Codex is disabled in settings." });
  });

  it.each([
    ["missing", [provider("claudeAgent")], "Codex is not available."],
    [
      "not installed",
      [provider("claudeAgent"), provider("codex", true, { installed: false })],
      "Codex is not installed.",
    ],
    [
      "in an error state",
      [provider("claudeAgent"), provider("codex", true, { status: "error" })],
      "Codex is not available.",
    ],
    [
      "in an error state with a message",
      [provider("claudeAgent"), provider("codex", true, { status: "error", message: "No auth." })],
      "No auth.",
    ],
    [
      "reported disabled",
      [provider("claudeAgent"), provider("codex", true, { status: "disabled" })],
      "Codex is not available.",
    ],
  ])("rejects a provider that is %s", (_label, providers, error) => {
    expect(planComposerMultiModelSend({ ...planBase, providers })).toMatchObject({
      ok: false,
      error,
    });
  });

  it("allows a provider in a warning state", () => {
    const providers = [provider("claudeAgent"), provider("codex", true, { status: "warning" })];
    expect(planComposerMultiModelSend({ ...planBase, providers }).ok).toBe(true);
  });

  it("sends review comments to every target, even with no prompt text", () => {
    const plan = planComposerMultiModelSend({
      ...planBase,
      prompt: "",
      trimmedPrompt: "",
      reviewComments: [REVIEW_COMMENT],
    });
    if (!plan.ok) throw new Error(plan.error);
    expect(plan.targets).toHaveLength(2);
    for (const target of plan.targets) expect(target.text).toContain("needs a guard");
    expect(plan.title).toBe(`Comment on ${REVIEW_COMMENT.filePath} ${REVIEW_COMMENT.rangeLabel}`);
  });

  it.each([
    ["a PDF", [{ name: "a.pdf", mimeType: "application/pdf" }], ATTACHMENT_ONLY_BOOTSTRAP_PROMPT],
    [
      "a PDF beside an image",
      [
        { name: "a.png", mimeType: "image/png" },
        { name: "a.pdf", mimeType: "application/pdf" },
      ],
      ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
    ],
    ["only images", [{ name: "a.png", mimeType: "image/png" }], IMAGE_ONLY_BOOTSTRAP_PROMPT],
  ])(
    "describes %s accurately to every target when there is no text",
    (_label, images, expected) => {
      const plan = planComposerMultiModelSend({
        ...planBase,
        prompt: "",
        trimmedPrompt: "",
        images,
      });
      if (!plan.ok) throw new Error(plan.error);
      expect(plan.targets).toHaveLength(2);
      for (const target of plan.targets) expect(target.text).toBe(expected);
    },
  );

  it("rejects over-limit text", () => {
    expect(planComposerMultiModelSend({ ...planBase, prompt: "x".repeat(2_000_000) }).ok).toBe(
      false,
    );
  });
});

function makeDeps(options?: {
  failTurnForModel?: string;
  failCreateForModel?: string;
  failSetup?: boolean;
}) {
  const commands: Array<Record<string, unknown>> = [];
  const dispatchCommand = vi.fn(async (command: Record<string, unknown>) => {
    commands.push(command);
    const selection = command.modelSelection as ModelSelection | undefined;
    if (command.type === "thread.turn.start" && selection?.model === options?.failTurnForModel) {
      throw new Error("turn failed");
    }
    if (command.type === "thread.create" && selection?.model === options?.failCreateForModel) {
      throw new Error("create failed");
    }
    return { sequence: 1 };
  });
  let worktreeCount = 0;
  let activeCreates = 0;
  let maxActiveCreates = 0;
  const createWorktree = vi.fn(async () => {
    activeCreates += 1;
    maxActiveCreates = Math.max(maxActiveCreates, activeCreates);
    await Promise.resolve();
    activeCreates -= 1;
    worktreeCount += 1;
    return { worktree: { branch: `branch-${worktreeCount}`, path: `/wt/${worktreeCount}` } };
  });
  const api = {
    orchestration: { dispatchCommand },
    terminal: {
      open: vi.fn(async () => {
        if (options?.failSetup) throw new Error("no shell");
        return {} as never;
      }),
      write: vi.fn(async () => undefined),
    },
    git: { removeWorktree: vi.fn(async () => undefined) },
  };
  return {
    commands,
    createWorktree,
    readMaxActiveCreates: () => maxActiveCreates,
    api: api as unknown as Parameters<typeof runComposerMultiModelSend>[0]["api"],
    removeWorktree: api.git.removeWorktree,
    terminalOpen: api.terminal.open,
    terminalWrite: api.terminal.write,
  };
}

const runBase = {
  title: "do it",
  baseBranch: "main",
  attachments: [],
  project: { id: ProjectId.makeUnsafe("project-1"), cwd: "/repo", scripts: [SETUP_SCRIPT] },
  runtimeMode: "approval-required" as const,
  interactionMode: "default" as const,
  targets: [
    { selection: OPUS, text: "do it" },
    { selection: GPT, text: "do it" },
  ],
};

describe("runComposerMultiModelSend", () => {
  it("makes a worktree, thread, setup run and turn for each selection", async () => {
    const deps = makeDeps();
    const result = await runComposerMultiModelSend({ ...runBase, ...deps });

    expect(result.started).toHaveLength(2);
    expect(result.failed).toEqual([]);
    expect(deps.createWorktree).toHaveBeenCalledTimes(2);
    expect(deps.readMaxActiveCreates()).toBe(1);
    const creates = deps.commands.filter((command) => command.type === "thread.create");
    const turns = deps.commands.filter((command) => command.type === "thread.turn.start");
    expect(creates).toHaveLength(2);
    expect(turns).toHaveLength(2);
    expect(new Set(creates.map((command) => command.threadId)).size).toBe(2);
    expect(new Set(creates.map((command) => command.worktreePath))).toEqual(
      new Set(["/wt/1", "/wt/2"]),
    );
    expect(deps.terminalOpen).toHaveBeenCalledTimes(2);
    expect(deps.terminalWrite).toHaveBeenCalledTimes(2);
    expect(deps.removeWorktree).not.toHaveBeenCalled();
  });

  it("deletes the orphaned thread and worktree of a failed turn only", async () => {
    const deps = makeDeps({ failTurnForModel: GPT.model });
    const result = await runComposerMultiModelSend({ ...runBase, ...deps });

    expect(result.started).toHaveLength(1);
    expect(result.failed).toEqual([{ selection: GPT, message: "turn failed" }]);
    const failedTurn = deps.commands.find(
      (command) =>
        command.type === "thread.turn.start" &&
        (command.modelSelection as ModelSelection).model === GPT.model,
    );
    const deletes = deps.commands.filter((command) => command.type === "thread.delete");
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.threadId).toBe(failedTurn?.threadId);
    expect(deps.removeWorktree).toHaveBeenCalledTimes(1);
    expect(deps.removeWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/repo", force: true }),
    );
  });

  it("still deletes the thread when thread.create rejects, since it may have been applied", async () => {
    const deps = makeDeps({ failCreateForModel: GPT.model });
    const result = await runComposerMultiModelSend({ ...runBase, ...deps });

    expect(result.failed.map((failure) => failure.selection)).toEqual([GPT]);
    const failedCreate = deps.commands.find(
      (command) =>
        command.type === "thread.create" &&
        (command.modelSelection as ModelSelection).model === GPT.model,
    );
    const deletes = deps.commands.filter((command) => command.type === "thread.delete");
    expect(deletes.map((command) => command.threadId)).toEqual([failedCreate?.threadId]);
    expect(deps.removeWorktree).toHaveBeenCalledTimes(1);
  });

  it("deletes nothing when the worktree never existed", async () => {
    const deps = makeDeps();
    deps.createWorktree.mockImplementationOnce(async () => {
      throw new Error("locked");
    });
    await runComposerMultiModelSend({ ...runBase, ...deps });

    expect(deps.commands.some((command) => command.type === "thread.delete")).toBe(false);
  });

  it("still starts the turn when the setup script cannot run", async () => {
    const deps = makeDeps({ failSetup: true });
    const result = await runComposerMultiModelSend({
      ...runBase,
      ...deps,
      targets: [{ selection: GPT, text: "do it" }],
    });

    expect(result.started).toHaveLength(1);
    expect(result.setupFailures).toEqual([{ selection: GPT, message: "no shell" }]);
  });

  it("keeps later worktrees coming after one fails to create", async () => {
    const deps = makeDeps();
    deps.createWorktree.mockImplementationOnce(async () => {
      throw new Error("locked");
    });
    const result = await runComposerMultiModelSend({ ...runBase, ...deps });

    expect(result.failed).toEqual([{ selection: OPUS, message: "locked" }]);
    expect(result.started).toHaveLength(1);
    expect(deps.removeWorktree).not.toHaveBeenCalled();
  });
});

const newBranches = (deps: ReturnType<typeof makeDeps>) =>
  (deps.createWorktree.mock.calls as unknown as Array<[{ newBranch: string }]>).map(
    ([input]) => input.newBranch,
  );

const threadIds = (deps: ReturnType<typeof makeDeps>) =>
  deps.commands.filter((command) => command.type === "thread.create").map((c) => c.threadId);

describe("sendComposerMultiModel", () => {
  beforeEach(() => {
    vi.mocked(toastManager.add).mockClear();
    vi.mocked(toastManager.close).mockClear();
    vi.mocked(toastManager.update).mockClear();
  });
  beforeEach(() => {
    useComposerDraftStore.getState().setProjectDraftThreadId(runBase.project.id, THREAD_ID);
    setComposerMultiModelSelections(THREAD_ID, planBase.selections);
  });
  afterEach(() => {
    useComposerDraftStore.getState().clearComposerContent(THREAD_ID);
    useComposerDraftStore.getState().clearDraftThread(THREAD_ID);
    useComposerMultiModelStore.setState({ selectionsByThreadId: {} });
    useReviewCommentDraftStore.getState().clearComments(THREAD_ID);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function restoreToastOnClick() {
    const toast = vi
      .mocked(toastManager.add)
      .mock.calls.map(([added]) => added)
      .find((added) => added.actionProps?.children === "Restore prompt");
    return toast?.actionProps?.onClick as unknown as (() => void) | undefined;
  }

  function makeInput(deps: ReturnType<typeof makeDeps>, overrides?: { isThreadCurrent?: boolean }) {
    return {
      ...planBase,
      threadId: THREAD_ID,
      project: runBase.project,
      runtimeMode: runBase.runtimeMode,
      interactionMode: runBase.interactionMode,
      api: deps.api,
      createWorktree: deps.createWorktree,
      isThreadCurrent: () => overrides?.isThreadCurrent ?? true,
      reportError: vi.fn(),
      clearComposer: vi.fn(() => useComposerDraftStore.getState().clearComposerContent(THREAD_ID)),
      onComposerRestored: vi.fn(),
      openDraft: vi.fn(),
      onComposerReleased: vi.fn(),
    };
  }

  it("rejects before clearing the composer", async () => {
    const deps = makeDeps();
    const input = { ...makeInput(deps), isGitRepo: false };
    await expect(sendComposerMultiModel(input)).resolves.toBeNull();

    expect(input.reportError).toHaveBeenCalledWith(
      "Sending to several models needs a Git project.",
    );
    expect(input.clearComposer).not.toHaveBeenCalled();
    expect(input.onComposerReleased).toHaveBeenCalledTimes(1);
    expect(deps.createWorktree).not.toHaveBeenCalled();
  });

  it("clears and releases the composer before the threads finish", async () => {
    const deps = makeDeps();
    const input = makeInput(deps);
    let releasedBeforeWorktree = false;
    deps.createWorktree.mockImplementationOnce(async () => {
      releasedBeforeWorktree = input.onComposerReleased.mock.calls.length === 1;
      return { worktree: { branch: "b", path: "/wt/b" } };
    });
    const result = await sendComposerMultiModel(input);

    expect(releasedBeforeWorktree).toBe(true);
    expect(result?.started).toHaveLength(2);
    expect(input.clearComposer).toHaveBeenCalledTimes(1);
    expect(toastManager.add).toHaveBeenCalledWith({ type: "success", title: "Started 2 threads" });
  });

  it("shows a progress toast from the moment the composer clears until the threads settle", async () => {
    const deps = makeDeps();
    const input = makeInput(deps);
    let closedDuringRun = true;
    deps.createWorktree.mockImplementationOnce(async () => {
      closedDuringRun = vi.mocked(toastManager.close).mock.calls.length > 0;
      expect(toastManager.add).toHaveBeenCalledWith({
        type: "loading",
        title: "Preparing 2 worktrees...",
        timeout: 0,
      });
      return { worktree: { branch: "b", path: "/wt/b" } };
    });
    await sendComposerMultiModel(input);

    expect(closedDuringRun).toBe(false);
    expect(toastManager.close).toHaveBeenCalledTimes(1);
  });

  it("shows no progress toast for a rejected send", async () => {
    const deps = makeDeps();
    await sendComposerMultiModel({ ...makeInput(deps), isGitRepo: false });

    expect(toastManager.add).not.toHaveBeenCalled();
  });

  it("revokes the sent image previews once the send settles", async () => {
    vi.stubGlobal(
      "FileReader",
      class {
        result = "data:image/png;base64,eA==";
        private onLoad = () => {};
        addEventListener(type: string, listener: () => void) {
          if (type === "load") this.onLoad = listener;
        }
        readAsDataURL() {
          this.onLoad();
        }
      },
    );
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:clone");
    const image = {
      type: "image",
      id: "image-1",
      name: "a.png",
      mimeType: "image/png",
      sizeBytes: 1,
      previewUrl: "blob:original",
      file: new File(["x"], "a.png", { type: "image/png" }),
    } as ComposerImageAttachment;
    const deps = makeDeps({ failTurnForModel: GPT.model });
    deps.createWorktree.mockImplementationOnce(async () => {
      expect(revoke).not.toHaveBeenCalled();
      return { worktree: { branch: "b", path: "/wt/b" } };
    });
    await sendComposerMultiModel({ ...makeInput(deps), images: [image] });

    expect(revoke).toHaveBeenCalledWith("blob:original");
    expect(create).toHaveBeenCalledTimes(1);
    expect(
      useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.images[0]?.previewUrl,
    ).toBe("blob:clone");
  });

  it("clears review comments on send and returns them if a target fails", async () => {
    useReviewCommentDraftStore.getState().addComment(THREAD_ID, REVIEW_COMMENT);
    const deps = makeDeps({ failTurnForModel: GPT.model });
    let commentsDuringRun: number | undefined;
    deps.createWorktree.mockImplementationOnce(async () => {
      commentsDuringRun =
        useReviewCommentDraftStore.getState().commentsByThreadId[THREAD_ID]?.length ?? 0;
      return { worktree: { branch: "b", path: "/wt/b" } };
    });
    await sendComposerMultiModel({ ...makeInput(deps), reviewComments: [REVIEW_COMMENT] });

    expect(commentsDuringRun).toBe(0);
    expect(useReviewCommentDraftStore.getState().commentsByThreadId[THREAD_ID]).toEqual([
      REVIEW_COMMENT,
    ]);
  });

  it("uses the toast when the draft became a thread during the send", async () => {
    const deps = makeDeps({ failTurnForModel: GPT.model });
    const input = makeInput(deps);
    deps.createWorktree.mockImplementationOnce(async () => {
      useComposerDraftStore.getState().clearDraftThread(THREAD_ID);
      return { worktree: { branch: "b", path: "/wt/b" } };
    });
    await sendComposerMultiModel(input);

    expect(input.onComposerRestored).not.toHaveBeenCalled();
    expect(readComposerMultiModelSelections(THREAD_ID)).toEqual(planBase.selections);

    restoreToastOnClick()?.();
    expect(toastManager.update).toHaveBeenCalledWith("toast-id", {
      description: "That draft is gone, so the prompt has nowhere to return to.",
    });
    expect(input.onComposerRestored).not.toHaveBeenCalled();
  });

  it("uses the toast when the selection changed during the send", async () => {
    const deps = makeDeps({ failTurnForModel: GPT.model });
    const input = makeInput(deps);
    deps.createWorktree.mockImplementationOnce(async () => {
      setComposerMultiModelSelections(THREAD_ID, null);
      return { worktree: { branch: "b", path: "/wt/b" } };
    });
    await sendComposerMultiModel(input);

    expect(input.onComposerRestored).not.toHaveBeenCalled();
    expect(readComposerMultiModelSelections(THREAD_ID)).toBeNull();
    expect(restoreToastOnClick()).toBeDefined();
  });

  it("restores the prompt and keeps only the failed selections", async () => {
    const deps = makeDeps({ failTurnForModel: GPT.model });
    const input = makeInput(deps);
    useComposerDraftStore.getState().setPrompt(THREAD_ID, "do it");
    await sendComposerMultiModel(input);

    expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt).toBe("do it");
    expect(input.onComposerRestored).toHaveBeenCalledWith("do it");
    expect(readComposerMultiModelSelections(THREAD_ID)?.map((entry) => entry.model)).toEqual([
      GPT.model,
    ]);
  });

  it("retries only the failed model, in a new worktree and thread", async () => {
    const failing = makeDeps({ failTurnForModel: GPT.model });
    useComposerDraftStore.getState().setPrompt(THREAD_ID, "do it");
    await sendComposerMultiModel(makeInput(failing));
    vi.mocked(toastManager.add).mockClear();

    const retry = makeDeps();
    const restoredPrompt = useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt;
    expect(restoredPrompt).toBe("do it");
    const result = await sendComposerMultiModel({
      ...makeInput(retry),
      selections: readComposerMultiModelSelections(THREAD_ID)!,
      prompt: restoredPrompt!,
      trimmedPrompt: restoredPrompt!,
    });

    expect(result?.started).toHaveLength(1);
    expect(result?.failed).toEqual([]);
    expect(retry.createWorktree).toHaveBeenCalledTimes(1);
    const sentModels = (type: string) =>
      retry.commands
        .filter((command) => command.type === type)
        .map((command) => (command.modelSelection as ModelSelection).model);
    expect(sentModels("thread.create")).toEqual([GPT.model]);
    expect(sentModels("thread.turn.start")).toEqual([GPT.model]);
    expect(threadIds(failing)).not.toContain(threadIds(retry)[0]);
    expect(newBranches(failing)).not.toContain(newBranches(retry)[0]);
    expect(toastManager.add).toHaveBeenCalledWith({ type: "success", title: "Started 1 thread" });
    expect(vi.mocked(toastManager.add).mock.calls.some(([toast]) => toast.type === "error")).toBe(
      false,
    );
  });

  it("offers a Restore prompt toast rather than overwriting a newer draft", async () => {
    const deps = makeDeps({ failTurnForModel: GPT.model });
    const input = makeInput(deps);
    deps.createWorktree.mockImplementationOnce(async () => {
      useComposerDraftStore.getState().setPrompt(THREAD_ID, "newer prompt");
      return { worktree: { branch: "b", path: "/wt/b" } };
    });
    await sendComposerMultiModel(input);

    expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt).toBe(
      "newer prompt",
    );
    const restoreToast = vi
      .mocked(toastManager.add)
      .mock.calls.map(([toast]) => toast)
      .find((toast) => toast.actionProps?.children === "Restore prompt");
    expect(restoreToast).toBeDefined();
    const onClick = restoreToast?.actionProps?.onClick as unknown as () => void;

    vi.mocked(toastManager.close).mockClear();
    onClick();
    expect(toastManager.update).toHaveBeenCalled();
    expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt).toBe(
      "newer prompt",
    );

    useComposerDraftStore.getState().clearComposerContent(THREAD_ID);
    onClick();
    expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt).toBe("do it");
    expect(input.openDraft).toHaveBeenCalledTimes(1);
    expect(toastManager.close).toHaveBeenCalledWith("toast-id");
  });

  it("uses the toast after the user leaves the draft, even when it is empty", async () => {
    const deps = makeDeps({ failTurnForModel: GPT.model });
    const input = makeInput(deps, { isThreadCurrent: false });
    await sendComposerMultiModel(input);

    expect(composerDraftHasUserContent(THREAD_ID)).toBe(false);
    expect(input.onComposerRestored).not.toHaveBeenCalled();
    expect(
      vi
        .mocked(toastManager.add)
        .mock.calls.some(([toast]) => toast.actionProps?.children === "Restore prompt"),
    ).toBe(true);
  });
});
