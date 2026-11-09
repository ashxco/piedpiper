import type {
  MessageId,
  ModelSelection,
  NativeApi,
  ProjectId,
  ProjectScript,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
} from "@piedpiper/contracts";
import { newCommandId } from "../../lib/utils";
import { setupProjectScript } from "../../projectScripts";
import type { TurnStartImageAttachment, WorktreeCreationOutcome } from "../ChatView.logic";

interface SendSettings {
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
}

export interface ComposerSingleSendInput {
  freshContext?: boolean;
  thread: {
    id: ThreadId;
    createdAt: string;
    branch: string | null;
    worktreePath: string | null;
    isServer: boolean;
    isLocalDraft: boolean;
    isFirstMessage: boolean;
  };
  project: { id: ProjectId; scripts: ProjectScript[] };
  message: {
    id: MessageId;
    text: string;
    title: string;
    createdAt: string;
    attachments: Promise<TurnStartImageAttachment[]>;
  };
  settings: SendSettings;
  threadCreateModelSelection: ModelSelection;
  persistModelSelection: boolean;
  worktree: { baseBranch: string | null; localBranch: string | null };
}

interface ThreadContext {
  branch: string | null;
  worktreePath: string | null;
}

export interface ComposerSingleSendEffects {
  dispatchCommand: NativeApi["orchestration"]["dispatchCommand"];
  prepareWorktree: (
    baseBranch: string,
  ) => Promise<WorktreeCreationOutcome<{ worktree: { branch: string; path: string } }>>;
  updateThreadContext: (context: ThreadContext, workedLocally: boolean) => void;
  runProjectScript: (
    script: ProjectScript,
    options: { worktreePath: string | null; rememberAsLastInvoked: false; cwd?: string },
  ) => Promise<void>;
  persistSettings: (
    input: Omit<SendSettings, "modelSelection"> & {
      threadId: ThreadId;
      createdAt: string;
      modelSelection?: ModelSelection;
    },
  ) => Promise<void>;
  onReadyToSend: () => void;
}

export type ComposerSingleSendResult =
  | { status: "sent" }
  | { status: "failed"; error: unknown; createdServerThread: boolean };

/** Executes a captured send. Recovery stays with the composer that owns its draft and previews. */
export async function runComposerSingleSend(
  input: ComposerSingleSendInput,
  effects: ComposerSingleSendEffects,
): Promise<ComposerSingleSendResult> {
  const { thread, project, message, settings } = input;
  const { dispatchCommand } = effects;
  let context: ThreadContext = { branch: thread.branch, worktreePath: thread.worktreePath };
  let workedLocally = false;
  let createdServerThread = false;
  // Reading attachments overlaps worktree creation. Observe early failures even if another step
  // fails first; awaiting the original promise below still reports its error to recovery.
  void message.attachments.catch(() => undefined);
  try {
    if (input.worktree.baseBranch) {
      const outcome = await effects.prepareWorktree(input.worktree.baseBranch);
      workedLocally = outcome.status === "work-locally";
      if (outcome.status === "work-locally") {
        context = { branch: input.worktree.localBranch ?? thread.branch, worktreePath: null };
      } else {
        context = {
          branch: outcome.result.worktree.branch,
          worktreePath: outcome.result.worktree.path,
        };
        if (thread.isServer) {
          await dispatchCommand({
            type: "thread.meta.update",
            commandId: newCommandId(),
            threadId: thread.id,
            ...context,
          });
        }
      }
      effects.updateThreadContext(context, workedLocally);
    }

    if (thread.isLocalDraft) {
      await dispatchCommand({
        type: "thread.create",
        commandId: newCommandId(),
        threadId: thread.id,
        projectId: project.id,
        title: message.title,
        ...settings,
        modelSelection: input.threadCreateModelSelection,
        ...context,
        createdAt: thread.createdAt,
      });
      createdServerThread = true;
    }

    const setupScript =
      input.worktree.baseBranch && !workedLocally ? setupProjectScript(project.scripts) : null;
    if (setupScript && (thread.isServer || createdServerThread)) {
      await effects.runProjectScript(setupScript, {
        worktreePath: context.worktreePath,
        rememberAsLastInvoked: false,
        ...(context.worktreePath ? { cwd: context.worktreePath } : {}),
      });
    }
    if (thread.isFirstMessage && thread.isServer) {
      await dispatchCommand({
        type: "thread.meta.update",
        commandId: newCommandId(),
        threadId: thread.id,
        title: message.title,
      });
    }
    if (thread.isServer) {
      await effects.persistSettings({
        threadId: thread.id,
        createdAt: message.createdAt,
        runtimeMode: settings.runtimeMode,
        interactionMode: settings.interactionMode,
        ...(input.persistModelSelection ? { modelSelection: settings.modelSelection } : {}),
      });
    }
    effects.onReadyToSend();
    const attachments = await message.attachments;
    await dispatchCommand({
      type: "thread.turn.start",
      commandId: newCommandId(),
      threadId: thread.id,
      message: {
        messageId: message.id,
        role: "user",
        text: message.text,
        attachments,
      },
      ...settings,
      ...(input.freshContext ? { freshContext: true } : {}),
      titleSeed: message.title,
      createdAt: message.createdAt,
    });
    return { status: "sent" };
  } catch (error) {
    return { status: "failed", error, createdServerThread };
  }
}
