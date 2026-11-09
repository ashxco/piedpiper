import {
  type ModelSelection,
  type NativeApi,
  PROVIDER_DISPLAY_NAMES,
  type ProjectId,
  type ProjectScript,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ServerProvider,
  type ThreadId,
} from "@piedpiper/contracts";

import {
  type ComposerImageAttachment,
  composerDraftHasUserContent,
  useComposerDraftStore,
} from "../../composerDraftStore";
import type { TerminalContextDraft } from "../../lib/terminalContext";
import type { ReviewCommentContext } from "../../reviewCommentContext";
import { useReviewCommentDraftStore } from "../../reviewCommentDraftStore";
import { newCommandId, newMessageId, newThreadId } from "../../lib/utils";
import {
  projectScriptRuntimeEnv,
  projectScriptTerminalInput,
  setupProjectScript,
} from "../../projectScripts";
import { getProviderModels } from "../../providerModels";
import { DEFAULT_THREAD_TERMINAL_ID } from "../../types";
import {
  buildComposerOutgoingMessageText,
  buildTemporaryWorktreeBranchName,
  buildTurnStartImageAttachments,
  cloneComposerImageForRetry,
  deriveSendThreadTitle,
  revokeBlobPreviewUrl,
  type TurnStartImageAttachment,
} from "../ChatView.logic";
import { toastManager } from "../ui/toast";
import { getComposerPromptLengthValidationMessage } from "./composerSubmission";
import {
  isSameComposerModel,
  readComposerMultiModelSelections,
  setComposerMultiModelSelections,
} from "./composerMultiModelStore";
import { getComposerProviderState } from "./composerProviderRegistry";

export interface ComposerMultiModelTarget {
  selection: ModelSelection;
  text: string;
}

export type ComposerMultiModelPlan =
  | { ok: true; title: string; baseBranch: string; targets: ComposerMultiModelTarget[] }
  | { ok: false; error: string };

/** Why a provider cannot take a send, or null. A warning state still works, so it passes. */
function composerMultiModelProviderProblem(
  provider: ServerProvider["provider"],
  status: ServerProvider | undefined,
): string | null {
  const name = PROVIDER_DISPLAY_NAMES[provider];
  if (!status) return `${name} is not available.`;
  if (!status.enabled) return `${name} is disabled in settings.`;
  if (!status.installed) return `${name} is not installed.`;
  if (status.status === "error" || status.status === "disabled") {
    return status.message ?? `${name} is not available.`;
  }
  return null;
}

/** Validates every selection up front, so a rejected send leaves the composer untouched. */
export function planComposerMultiModelSend(input: {
  isGitRepo: boolean;
  baseBranch: string | null;
  selections: ReadonlyArray<ModelSelection>;
  /** The composer's own selection; carries the effort and other options set in the footer. */
  primarySelection: ModelSelection;
  providers: ReadonlyArray<ServerProvider>;
  prompt: string;
  trimmedPrompt: string;
  images: ReadonlyArray<Pick<ComposerImageAttachment, "name" | "mimeType">>;
  terminalContexts: ReadonlyArray<TerminalContextDraft>;
  reviewComments?: ReadonlyArray<ReviewCommentContext> | undefined;
}): ComposerMultiModelPlan {
  if (!input.isGitRepo) {
    return { ok: false, error: "Sending to several models needs a Git project." };
  }
  if (!input.baseBranch) {
    return { ok: false, error: "Check out a branch before sending to several models." };
  }
  if (input.selections.length === 0) {
    return { ok: false, error: "Select at least one model." };
  }
  const targets: ComposerMultiModelTarget[] = [];
  for (const candidate of input.selections) {
    const { provider, model } = candidate;
    const providerProblem = composerMultiModelProviderProblem(
      provider,
      input.providers.find((entry) => entry.provider === provider),
    );
    if (providerProblem) return { ok: false, error: providerProblem };
    const selection = isSameComposerModel(candidate, input.primarySelection)
      ? input.primarySelection
      : candidate;
    const models = getProviderModels(input.providers, provider);
    const providerState = getComposerProviderState({
      provider,
      model,
      models,
      prompt: input.prompt,
      modelOptions: selection.options ? { [provider]: selection.options } : undefined,
    });
    const text = buildComposerOutgoingMessageText({
      prompt: input.prompt,
      terminalContexts: input.terminalContexts,
      reviewComments: input.reviewComments ?? [],
      hasNonImageAttachment: input.images.some(
        (attachment) => !attachment.mimeType.startsWith("image/"),
      ),
      provider,
      model,
      models,
      effort: providerState.promptEffort,
    });
    const lengthError = getComposerPromptLengthValidationMessage(text);
    if (lengthError) return { ok: false, error: lengthError };
    targets.push({
      selection: {
        provider,
        model,
        ...(providerState.modelOptionsForDispatch
          ? { options: providerState.modelOptionsForDispatch }
          : {}),
      } as ModelSelection,
      text,
    });
  }
  return {
    ok: true,
    title: deriveSendThreadTitle({
      trimmedPrompt: input.trimmedPrompt,
      images: input.images,
      terminalContexts: input.terminalContexts,
      reviewComments: input.reviewComments,
    }),
    baseBranch: input.baseBranch,
    targets,
  };
}

type MultiModelApi = {
  orchestration: Pick<NativeApi["orchestration"], "dispatchCommand">;
  terminal: Pick<NativeApi["terminal"], "open" | "write">;
  git: Pick<NativeApi["git"], "removeWorktree">;
};

interface CreatedWorktree {
  worktree: { branch: string; path: string };
}

/** Runs a project script in a thread other than the visible one, so it opens no UI. */
export async function runProjectScriptForThread(
  api: Pick<MultiModelApi, "terminal">,
  input: { threadId: ThreadId; script: ProjectScript; projectCwd: string; worktreePath: string },
): Promise<void> {
  await api.terminal.open({
    threadId: input.threadId,
    terminalId: DEFAULT_THREAD_TERMINAL_ID,
    cwd: input.worktreePath,
    env: projectScriptRuntimeEnv({
      project: { cwd: input.projectCwd },
      worktreePath: input.worktreePath,
    }),
  });
  await api.terminal.write({
    threadId: input.threadId,
    terminalId: DEFAULT_THREAD_TERMINAL_ID,
    data: projectScriptTerminalInput(input.script.command, { shellHistory: "suppress" }),
  });
}

export interface ComposerMultiModelResult {
  started: ThreadId[];
  failed: Array<{ selection: ModelSelection; message: string }>;
  setupFailures: Array<{ selection: ModelSelection; message: string }>;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/** Starts one thread per target. A failed target removes what it created, so a retry starts clean. */
export async function runComposerMultiModelSend(input: {
  targets: ReadonlyArray<ComposerMultiModelTarget>;
  title: string;
  baseBranch: string;
  attachments: ReadonlyArray<TurnStartImageAttachment>;
  project: { id: ProjectId; cwd: string; scripts: ProjectScript[] };
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  api: MultiModelApi;
  createWorktree: (input: {
    cwd: string;
    branch: string;
    newBranch: string;
  }) => Promise<CreatedWorktree>;
}): Promise<ComposerMultiModelResult> {
  const { api, project } = input;
  const result: ComposerMultiModelResult = { started: [], failed: [], setupFailures: [] };
  const setupScript = setupProjectScript(project.scripts);
  // Worktrees are created one at a time: concurrent `git worktree add` can contend on repo locks.
  let worktreeQueue: Promise<unknown> = Promise.resolve();
  const createWorktreeInTurn = (): Promise<CreatedWorktree> => {
    const created = worktreeQueue.then(() =>
      input.createWorktree({
        cwd: project.cwd,
        branch: input.baseBranch,
        newBranch: buildTemporaryWorktreeBranchName(),
      }),
    );
    worktreeQueue = created.catch(() => undefined);
    return created;
  };

  await Promise.all(
    input.targets.map(async ({ selection, text }) => {
      const threadId = newThreadId();
      const createdAt = new Date().toISOString();
      let worktreePath: string | null = null;
      let threadCreateSent = false;
      try {
        const { worktree } = await createWorktreeInTurn();
        worktreePath = worktree.path;
        // Set first: a rejected dispatch may still have been applied, as on a dropped socket.
        threadCreateSent = true;
        await api.orchestration.dispatchCommand({
          type: "thread.create",
          commandId: newCommandId(),
          threadId,
          projectId: project.id,
          title: input.title,
          modelSelection: selection,
          runtimeMode: input.runtimeMode,
          interactionMode: input.interactionMode,
          branch: worktree.branch,
          worktreePath: worktree.path,
          createdAt,
        });
        if (setupScript) {
          // A failed setup script leaves a usable worktree, as it does for a single thread.
          await runProjectScriptForThread(api, {
            threadId,
            script: setupScript,
            projectCwd: project.cwd,
            worktreePath: worktree.path,
          }).catch((error: unknown) => {
            result.setupFailures.push({
              selection,
              message: errorMessage(error, `Failed to run script "${setupScript.name}".`),
            });
          });
        }
        await api.orchestration.dispatchCommand({
          type: "thread.turn.start",
          commandId: newCommandId(),
          threadId,
          message: {
            messageId: newMessageId(),
            role: "user",
            text,
            attachments: [...input.attachments],
          },
          modelSelection: selection,
          titleSeed: input.title,
          runtimeMode: input.runtimeMode,
          interactionMode: input.interactionMode,
          createdAt,
        });
        result.started.push(threadId);
      } catch (error) {
        result.failed.push({ selection, message: errorMessage(error, "Failed to send message.") });
        if (threadCreateSent) {
          await api.orchestration
            .dispatchCommand({ type: "thread.delete", commandId: newCommandId(), threadId })
            .catch(() => undefined);
        }
        if (worktreePath) {
          await api.git
            .removeWorktree({ cwd: project.cwd, path: worktreePath, force: true })
            .catch(() => undefined);
        }
      }
    }),
  );
  return result;
}

/** Sends the composer's content to several models; the draft composer stays open for the next prompt. */
export async function sendComposerMultiModel(input: {
  threadId: ThreadId;
  isGitRepo: boolean;
  baseBranch: string | null;
  selections: ReadonlyArray<ModelSelection>;
  primarySelection: ModelSelection;
  providers: ReadonlyArray<ServerProvider>;
  project: { id: ProjectId; cwd: string; scripts: ProjectScript[] };
  prompt: string;
  trimmedPrompt: string;
  images: ReadonlyArray<ComposerImageAttachment>;
  terminalContexts: ReadonlyArray<TerminalContextDraft>;
  reviewComments?: ReadonlyArray<ReviewCommentContext> | undefined;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  api: MultiModelApi;
  createWorktree: (input: {
    cwd: string;
    branch: string;
    newBranch: string;
  }) => Promise<CreatedWorktree>;
  isThreadCurrent: () => boolean;
  reportError: (message: string | null) => void;
  /** Clears the composer's on-screen state as well as the draft. */
  clearComposer: () => void;
  /** Called once the draft holds the prompt again, to sync on-screen state. */
  onComposerRestored: (prompt: string) => void;
  openDraft: () => void;
  /** Called once the threads own the work, so the composer can take another prompt. */
  onComposerReleased: () => void;
}): Promise<ComposerMultiModelResult | null> {
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    input.onComposerReleased();
  };
  try {
    const plan = planComposerMultiModelSend(input);
    if (!plan.ok) {
      input.reportError(plan.error);
      return null;
    }
    let attachments: TurnStartImageAttachment[];
    try {
      attachments = await buildTurnStartImageAttachments(input.images);
    } catch (error) {
      input.reportError(errorMessage(error, "Failed to read images."));
      return null;
    }
    input.reportError(null);
    input.clearComposer();
    if (input.reviewComments?.length) {
      useReviewCommentDraftStore.getState().clearComments(input.threadId);
    }
    release();
    const worktreeCount = plan.targets.length;
    // Nothing else shows while the worktrees are made: the composer is empty and no thread exists yet.
    const preparingToastId = toastManager.add({
      type: "loading",
      title: `Preparing ${worktreeCount} ${worktreeCount === 1 ? "worktree" : "worktrees"}...`,
      timeout: 0,
    });
    try {
      let result: ComposerMultiModelResult;
      try {
        result = await runComposerMultiModelSend({ ...input, ...plan, attachments });
      } finally {
        toastManager.close(preparingToastId);
      }
      reportComposerMultiModelResult(input, result);
      return result;
    } finally {
      // Nothing else owns these once the draft drops them; a restore makes its own from the files.
      for (const image of input.images) revokeBlobPreviewUrl(image.previewUrl);
    }
  } finally {
    release();
  }
}

function reportComposerMultiModelResult(
  input: Pick<
    Parameters<typeof sendComposerMultiModel>[0],
    | "threadId"
    | "prompt"
    | "images"
    | "terminalContexts"
    | "reviewComments"
    | "selections"
    | "isThreadCurrent"
    | "onComposerRestored"
    | "openDraft"
  >,
  result: ComposerMultiModelResult,
): void {
  const { threadId } = input;
  if (result.started.length > 0) {
    toastManager.add({
      type: "success",
      title: `Started ${result.started.length} ${result.started.length === 1 ? "thread" : "threads"}`,
    });
  }
  for (const { selection, message } of result.setupFailures) {
    toastManager.add({
      type: "warning",
      title: `Setup script did not start for ${selection.model}`,
      description: message,
    });
  }
  for (const { selection, message } of result.failed) {
    toastManager.add({
      type: "error",
      title: `Could not start ${selection.model}`,
      description: message,
    });
  }
  if (result.failed.length === 0) return;

  const restore = () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(threadId, input.prompt);
    store.addImages(threadId, input.images.map(cloneComposerImageForRetry));
    store.setTerminalContexts(threadId, [...input.terminalContexts]);
    if (input.reviewComments?.length) {
      useReviewCommentDraftStore.getState().restoreComments(threadId, input.reviewComments);
    }
    // Only the failed models stay selected, so retrying cannot start a second copy of the others.
    setComposerMultiModelSelections(
      threadId,
      result.failed.map((failure) => failure.selection),
    );
    input.onComposerRestored(input.prompt);
  };
  const draftExists = () => useComposerDraftStore.getState().getDraftThread(threadId) !== null;
  if (
    input.isThreadCurrent() &&
    draftExists() &&
    readComposerMultiModelSelections(threadId) === input.selections &&
    !composerDraftHasUserContent(threadId)
  ) {
    restore();
    return;
  }
  // The user moved on while the worktrees were prepared; never overwrite what they have since typed
  // or selected, and never write into a draft their own send has since turned into a thread.
  const toastId = toastManager.add({
    type: "error",
    title: "A prompt could not be sent",
    description: "Restore it to send it again to the models that failed.",
    timeout: 0,
    actionProps: {
      children: "Restore prompt",
      onClick: () => {
        if (!draftExists()) {
          toastManager.update(toastId, {
            description: "That draft is gone, so the prompt has nowhere to return to.",
          });
          return;
        }
        if (composerDraftHasUserContent(threadId)) {
          toastManager.update(toastId, {
            description: "Send or clear that draft's current prompt before restoring.",
          });
          return;
        }
        restore();
        input.openDraft();
        toastManager.close(toastId);
      },
    },
  });
}
