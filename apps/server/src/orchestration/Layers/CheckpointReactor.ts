import {
  type CheckpointRef,
  CommandId,
  EventId,
  MessageId,
  type ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type ProviderRuntimeEvent,
} from "@piedpiper/contracts";
import { Cause, Effect, FileSystem, Layer, Option, Path, PubSub } from "effect";
import { makeDrainableWorker } from "@piedpiper/shared/DrainableWorker";

import { isGitImport, parseTurnDiffFilesFromNumstat } from "../../checkpointing/Diffs.ts";
import {
  checkpointRefForThreadTurn,
  resolveThreadWorkspaceCwd,
} from "../../checkpointing/Utils.ts";
import { CheckpointStore } from "../../checkpointing/Services/CheckpointStore.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { CheckpointReactor, type CheckpointReactorShape } from "../Services/CheckpointReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { RuntimeReceiptBus } from "../Services/RuntimeReceiptBus.ts";
import { settleOpenTasksCommands } from "./ProviderRuntimeIngestionHelpers.ts";
import { CheckpointStoreError } from "../../checkpointing/Errors.ts";
import { OrchestrationDispatchError } from "../Errors.ts";
import { isGitRepository } from "../../git/Utils.ts";
import { GitManager } from "../../git/Services/GitManager.ts";
import { WorkspaceEntries } from "../../workspace/Services/WorkspaceEntries.ts";

type ReactorInput =
  | {
      readonly source: "runtime";
      readonly event: ProviderRuntimeEvent;
    }
  | {
      readonly source: "domain";
      readonly event: OrchestrationEvent;
    };

function toTurnId(value: string | undefined): TurnId | null {
  return value === undefined ? null : TurnId.makeUnsafe(String(value));
}

function sameId(left: string | null | undefined, right: string | null | undefined): boolean {
  if (left === null || left === undefined || right === null || right === undefined) {
    return false;
  }
  return left === right;
}

function checkpointStatusFromRuntime(status: string | undefined): "ready" | "missing" | "error" {
  switch (status) {
    case "failed":
      return "error";
    case "cancelled":
    case "interrupted":
      return "missing";
    case "completed":
    default:
      return "ready";
  }
}

const serverCommandId = (tag: string): CommandId =>
  CommandId.makeUnsafe(`server:${tag}:${crypto.randomUUID()}`);

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;
  const checkpointStore = yield* CheckpointStore;
  const receiptBus = yield* RuntimeReceiptBus;
  const workspaceEntries = yield* WorkspaceEntries;
  // Optional so reactor-only harnesses need no git status stack; server.ts provides it.
  const gitManager = yield* Effect.serviceOption(GitManager);
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // Last runtime turn.started per thread, so an abort can be matched after the session clears it.
  const startedTurns = new Map<ThreadId, TurnId>();

  const appendRevertFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly turnCount: number;
    readonly detail: string;
    readonly createdAt: string;
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: serverCommandId("checkpoint-revert-failure"),
      threadId: input.threadId,
      activity: {
        id: EventId.makeUnsafe(crypto.randomUUID()),
        tone: "error",
        kind: "checkpoint.revert.failed",
        summary: "Checkpoint revert failed",
        payload: {
          turnCount: input.turnCount,
          detail: input.detail,
        },
        turnId: null,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });

  const appendCaptureFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId | null;
    readonly detail: string;
    readonly createdAt: string;
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: serverCommandId("checkpoint-capture-failure"),
      threadId: input.threadId,
      activity: {
        id: EventId.makeUnsafe(crypto.randomUUID()),
        tone: "error",
        kind: "checkpoint.capture.failed",
        summary: "Checkpoint capture failed",
        payload: {
          detail: input.detail,
        },
        turnId: input.turnId,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });

  const resolveSessionRuntimeForThread = Effect.fn("resolveSessionRuntimeForThread")(function* (
    threadId: ThreadId,
  ): Effect.fn.Return<Option.Option<{ readonly threadId: ThreadId; readonly cwd: string }>> {
    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.get(threadId);

    const sessions = yield* providerService.listSessions();

    const findSessionWithCwd = (
      session: (typeof sessions)[number] | undefined,
    ): Option.Option<{ readonly threadId: ThreadId; readonly cwd: string }> => {
      if (!session?.cwd) {
        return Option.none();
      }
      return Option.some({ threadId: session.threadId, cwd: session.cwd });
    };

    if (thread) {
      const projectedSession = sessions.find((session) => session.threadId === thread.id);
      const fromProjected = findSessionWithCwd(projectedSession);
      if (Option.isSome(fromProjected)) {
        return fromProjected;
      }
    }

    return Option.none();
  });

  const isGitWorkspace = (cwd: string) => isGitRepository(cwd);

  // Resolves the workspace CWD for checkpoint operations, preferring the
  // active provider session CWD and falling back to the thread/project config.
  // Returns undefined when no CWD can be determined or the workspace is not
  // a git repository.
  const resolveCheckpointCwd = Effect.fn("resolveCheckpointCwd")(function* (input: {
    readonly threadId: ThreadId;
    readonly thread: { readonly projectId: ProjectId; readonly worktreePath: string | null };
    readonly projects: ReadonlyMap<ProjectId, { readonly workspaceRoot: string }>;
    readonly preferSessionRuntime: boolean;
  }): Effect.fn.Return<string | undefined> {
    const fromSession = yield* resolveSessionRuntimeForThread(input.threadId);
    const fromThread = resolveThreadWorkspaceCwd({
      thread: input.thread,
      projects: input.projects,
    });

    const cwd = input.preferSessionRuntime
      ? (Option.match(fromSession, {
          onNone: () => undefined,
          onSome: (runtime) => runtime.cwd,
        }) ?? fromThread)
      : (fromThread ??
        Option.match(fromSession, {
          onNone: () => undefined,
          onSome: (runtime) => runtime.cwd,
        }));

    if (!cwd) {
      return undefined;
    }
    if (!(yield* isGitWorkspace(cwd))) {
      return undefined;
    }
    return cwd;
  });

  // Shared tail for both capture paths: creates the git checkpoint ref, diffs
  // it against the previous turn, then dispatches the domain events to update
  // the orchestration read model.
  const captureAndDispatchCheckpoint = Effect.fn("captureAndDispatchCheckpoint")(function* (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly thread: {
      readonly messages: ReadonlyArray<{
        readonly id: MessageId;
        readonly role: string;
        readonly text: string;
        readonly turnId: TurnId | null;
      }>;
    };
    readonly cwd: string;
    readonly turnCount: number;
    readonly status: "ready" | "missing" | "error";
    readonly assistantMessageId: MessageId | undefined;
    readonly createdAt: string;
  }) {
    const fromTurnCount = Math.max(0, input.turnCount - 1);
    const fromCheckpointRef = checkpointRefForThreadTurn(input.threadId, fromTurnCount);
    const targetCheckpointRef = checkpointRefForThreadTurn(input.threadId, input.turnCount);

    // A transient lookup failure must not skip the capture; treat it as a missing baseline.
    const fromCheckpointExists = yield* checkpointStore
      .hasCheckpointRef({
        cwd: input.cwd,
        checkpointRef: fromCheckpointRef,
      })
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("checkpoint capture previous ref lookup failed", {
            threadId: input.threadId,
            checkpointRef: fromCheckpointRef,
            category: error._tag,
          }).pipe(Effect.as(false)),
        ),
      );
    if (!fromCheckpointExists) {
      yield* Effect.logWarning("checkpoint capture missing pre-turn baseline", {
        threadId: input.threadId,
        turnId: input.turnId,
        fromTurnCount,
      });
    }

    // An unsupported workspace (e.g. one its repo ignores) has no checkpoint, which is not an error.
    const captured = yield* checkpointStore
      .captureCheckpoint({
        cwd: input.cwd,
        checkpointRef: targetCheckpointRef,
      })
      .pipe(
        Effect.as(true),
        Effect.catchTag("CheckpointUnsupportedError", () => Effect.succeed(false)),
      );
    const status = captured ? input.status : "missing";

    // Invalidate the workspace entry cache so the @-mention file picker
    // reflects files created or deleted during this turn.
    yield* workspaceEntries.invalidate(input.cwd);

    const refs = {
      cwd: input.cwd,
      fromCheckpointRef,
      toCheckpointRef: targetCheckpointRef,
    };
    // Git may have been initialized during this turn, leaving no pre-turn snapshot to diff against.
    const summarySource: Effect.Effect<
      readonly [string, ReadonlySet<string> | null],
      CheckpointStoreError
    > =
      captured && fromCheckpointExists
        ? Effect.all([
            checkpointStore.diffCheckpoints({
              ...refs,
              fallbackFromToHead: false,
              format: "numstat",
            }),
            // A pull or rebase can change thousands of files the turn did not write.
            checkpointStore.listAuthoredPaths(refs).pipe(
              Effect.catch((error) =>
                Effect.logWarning("checkpoint authored paths unavailable", {
                  threadId: input.threadId,
                  turnId: input.turnId,
                  detail: error.message,
                }).pipe(Effect.as(null)),
              ),
            ),
          ])
        : Effect.succeed(["", null]);
    const files = yield* summarySource.pipe(
      Effect.map(([numstat, authoredPaths]) =>
        parseTurnDiffFilesFromNumstat(numstat)
          .filter((file) => !isGitImport(file, authoredPaths))
          .map((file) => ({
            path: file.path,
            kind: "modified" as const,
            additions: file.additions,
            deletions: file.deletions,
          })),
      ),
      Effect.tapError((error) =>
        appendCaptureFailureActivity({
          threadId: input.threadId,
          turnId: input.turnId,
          detail: `Checkpoint captured, but turn diff summary is unavailable: ${error.message}`,
          createdAt: input.createdAt,
        }),
      ),
      Effect.catch((error) =>
        Effect.logWarning("failed to derive checkpoint file summary", {
          threadId: input.threadId,
          turnId: input.turnId,
          turnCount: input.turnCount,
          detail: error.message,
        }).pipe(Effect.as([])),
      ),
    );

    const turnMessages = input.thread.messages.filter(
      (entry) => entry.role === "assistant" && entry.turnId === input.turnId,
    );
    // A text-less generated image must not take the turn's pointer from its reply.
    const assistantMessageId =
      input.assistantMessageId ??
      turnMessages.findLast((entry) => entry.text.trim().length > 0)?.id ??
      turnMessages.at(-1)?.id ??
      MessageId.makeUnsafe(`assistant:${input.turnId}`);

    yield* orchestrationEngine.dispatch({
      type: "thread.turn.diff.complete",
      commandId: serverCommandId("checkpoint-turn-diff-complete"),
      threadId: input.threadId,
      turnId: input.turnId,
      completedAt: input.createdAt,
      checkpointRef: targetCheckpointRef,
      status,
      files,
      assistantMessageId,
      checkpointTurnCount: input.turnCount,
      createdAt: input.createdAt,
    });
    yield* receiptBus.publish({
      type: "checkpoint.diff.finalized",
      threadId: input.threadId,
      turnId: input.turnId,
      checkpointTurnCount: input.turnCount,
      checkpointRef: targetCheckpointRef,
      status,
      createdAt: input.createdAt,
    });
    yield* receiptBus.publish({
      type: "turn.processing.quiesced",
      threadId: input.threadId,
      turnId: input.turnId,
      checkpointTurnCount: input.turnCount,
      createdAt: input.createdAt,
    });

    if (!captured) {
      return;
    }
    yield* orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: serverCommandId("checkpoint-captured-activity"),
      threadId: input.threadId,
      activity: {
        id: EventId.makeUnsafe(crypto.randomUUID()),
        tone: "info",
        kind: "checkpoint.captured",
        summary: "Checkpoint captured",
        payload: {
          turnCount: input.turnCount,
          status,
        },
        turnId: input.turnId,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
  });

  const captureBaseline = (cwd: string, checkpointRef: CheckpointRef) =>
    checkpointStore.captureCheckpoint({ cwd, checkpointRef }).pipe(
      Effect.as(true),
      Effect.catchTag("CheckpointUnsupportedError", () => Effect.succeed(false)),
    );

  // Captures the files left by a completed or aborted turn.
  const captureCheckpointFromTurnCompletion = Effect.fn("captureCheckpointFromTurnCompletion")(
    function* (event: Extract<ProviderRuntimeEvent, { type: "turn.completed" | "turn.aborted" }>) {
      const turnId = toTurnId(event.turnId);
      if (!turnId) {
        return;
      }

      const readModel = yield* orchestrationEngine.getReadModel();
      const thread = readModel.threads.get(event.threadId);
      if (!thread) {
        return;
      }

      // When a primary turn is active, only that turn may produce completion checkpoints.
      if (thread.session?.activeTurnId && !sameId(thread.session.activeTurnId, turnId)) {
        return;
      }

      const checkpointCwd = yield* resolveCheckpointCwd({
        threadId: thread.id,
        thread,
        projects: readModel.projects,
        preferSessionRuntime: true,
      });
      if (!checkpointCwd) {
        return;
      }

      // Before the checkpoint event, so the client refetch it triggers sees a PR the turn opened.
      if (event.type === "turn.completed" && thread.branch !== null && Option.isSome(gitManager)) {
        yield* gitManager.value.refreshMissingPullRequest({
          cwd: checkpointCwd,
          branch: thread.branch,
        });
      }

      // Only skip if a real (non-placeholder) checkpoint already exists for this turn.
      // ProviderRuntimeIngestion inserts "missing" placeholders on turn.diff.updated while the
      // turn is still editing; the real capture happens here once the turn has finished.
      if (
        thread.checkpoints.some(
          (checkpoint) => checkpoint.turnId === turnId && checkpoint.status !== "missing",
        )
      ) {
        return;
      }

      // If a placeholder checkpoint exists for this turn, reuse its turn count
      // instead of incrementing past it.
      const existingPlaceholder = thread.checkpoints.find(
        (checkpoint) => checkpoint.turnId === turnId && checkpoint.status === "missing",
      );
      const currentTurnCount = thread.checkpoints.reduce(
        (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
        0,
      );
      const nextTurnCount = existingPlaceholder
        ? existingPlaceholder.checkpointTurnCount
        : currentTurnCount + 1;

      yield* captureAndDispatchCheckpoint({
        threadId: thread.id,
        turnId,
        thread,
        cwd: checkpointCwd,
        turnCount: nextTurnCount,
        status:
          event.type === "turn.aborted"
            ? "ready"
            : checkpointStatusFromRuntime(event.payload.state),
        assistantMessageId: existingPlaceholder?.assistantMessageId ?? undefined,
        createdAt: event.createdAt,
      });
    },
  );

  const ensurePreTurnBaselineFromTurnStart = Effect.fn("ensurePreTurnBaselineFromTurnStart")(
    function* (event: Extract<ProviderRuntimeEvent, { type: "turn.started" }>) {
      const turnId = toTurnId(event.turnId);
      if (!turnId) {
        return;
      }

      const readModel = yield* orchestrationEngine.getReadModel();
      const thread = readModel.threads.get(event.threadId);
      if (!thread) {
        return;
      }

      const checkpointCwd = yield* resolveCheckpointCwd({
        threadId: thread.id,
        thread,
        projects: readModel.projects,
        preferSessionRuntime: false,
      });
      if (!checkpointCwd) {
        return;
      }

      const currentTurnCount = thread.checkpoints.reduce(
        (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
        0,
      );
      const baselineCheckpointRef = checkpointRefForThreadTurn(thread.id, currentTurnCount);
      const baselineExists = yield* checkpointStore.hasCheckpointRef({
        cwd: checkpointCwd,
        checkpointRef: baselineCheckpointRef,
      });
      if (baselineExists) {
        return;
      }

      const captured = yield* captureBaseline(checkpointCwd, baselineCheckpointRef);
      if (!captured) {
        return;
      }
      yield* receiptBus.publish({
        type: "checkpoint.baseline.captured",
        threadId: thread.id,
        checkpointTurnCount: currentTurnCount,
        checkpointRef: baselineCheckpointRef,
        createdAt: event.createdAt,
      });
    },
  );

  const ensurePreTurnBaselineFromDomainTurnStart = Effect.fn(
    "ensurePreTurnBaselineFromDomainTurnStart",
  )(function* (
    event: Extract<
      OrchestrationEvent,
      { type: "thread.turn-start-requested" | "thread.message-sent" }
    >,
  ) {
    if (event.type === "thread.message-sent") {
      if (
        event.payload.role !== "user" ||
        event.payload.streaming ||
        event.payload.turnId !== null
      ) {
        return;
      }
    }

    const threadId = event.payload.threadId;
    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.get(threadId);
    if (!thread) {
      return;
    }

    const checkpointCwd = yield* resolveCheckpointCwd({
      threadId,
      thread,
      projects: readModel.projects,
      preferSessionRuntime: false,
    });
    if (!checkpointCwd) {
      return;
    }

    const currentTurnCount = thread.checkpoints.reduce(
      (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
      0,
    );
    const baselineCheckpointRef = checkpointRefForThreadTurn(threadId, currentTurnCount);
    const baselineExists = yield* checkpointStore.hasCheckpointRef({
      cwd: checkpointCwd,
      checkpointRef: baselineCheckpointRef,
    });
    if (baselineExists) {
      return;
    }

    const captured = yield* captureBaseline(checkpointCwd, baselineCheckpointRef);
    if (!captured) {
      return;
    }
    yield* receiptBus.publish({
      type: "checkpoint.baseline.captured",
      threadId,
      checkpointTurnCount: currentTurnCount,
      checkpointRef: baselineCheckpointRef,
      createdAt: event.occurredAt,
    });
  });

  // Checkpoints hold the whole checkout, so restoring a cwd another thread or live session
  // also works in (same dir, parent or nested) would erase that thread's uncommitted work.
  const isRestoreWorkspaceIsolated = Effect.fn("isRestoreWorkspaceIsolated")(function* (
    threadId: ThreadId,
    cwd: string,
  ) {
    const canonicalCwd = yield* fileSystem.realPath(cwd).pipe(Effect.option);
    if (Option.isNone(canonicalCwd)) {
      return false;
    }
    const readModel = yield* orchestrationEngine.getReadModel();
    const candidates = new Set<string>();
    for (const other of readModel.threads.values()) {
      if (other.id === threadId || other.deletedAt !== null) continue;
      const otherCwd = resolveThreadWorkspaceCwd({ thread: other, projects: readModel.projects });
      if (otherCwd !== undefined) candidates.add(otherCwd);
    }
    for (const session of yield* providerService.listSessions()) {
      if (session.threadId !== threadId && session.status !== "closed" && session.cwd) {
        candidates.add(session.cwd);
      }
    }
    const isWithin = (parent: string, child: string) => {
      const relative = path.relative(parent, child);
      return (
        relative === "" ||
        (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
      );
    };
    for (const candidate of candidates) {
      // A vanished workspace holds no work to lose; any other failure counts as shared.
      const resolved = yield* fileSystem
        .realPath(candidate)
        .pipe(
          Effect.catch((error) =>
            Effect.succeed(error.reason._tag === "NotFound" ? null : (false as const)),
          ),
        );
      if (resolved === false) return false;
      if (resolved === null) continue;
      if (isWithin(canonicalCwd.value, resolved) || isWithin(resolved, canonicalCwd.value)) {
        return false;
      }
    }
    return true;
  });

  const handleRevertRequested = Effect.fn("handleRevertRequested")(function* (
    event: Extract<OrchestrationEvent, { type: "thread.checkpoint-revert-requested" }>,
  ) {
    const now = new Date().toISOString();

    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.get(event.payload.threadId);
    if (!thread) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: "Thread was not found in read model.",
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    const sessionRuntime = yield* resolveSessionRuntimeForThread(event.payload.threadId);
    if (Option.isNone(sessionRuntime)) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: "No active provider session with workspace cwd is bound to this thread.",
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }
    // A keep-files rewind touches only the conversation, so it works outside git and in shared workspaces.
    const restoreFiles = event.payload.restoreFiles !== false;
    if (restoreFiles && !(yield* isGitWorkspace(sessionRuntime.value.cwd))) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: "Checkpoints are unavailable because this project is not a git repository.",
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    const currentTurnCount = thread.checkpoints.reduce(
      (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
      0,
    );

    if (event.payload.turnCount > currentTurnCount) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: `Checkpoint turn count ${event.payload.turnCount} exceeds current turn count ${currentTurnCount}.`,
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    const rolledBackTurns = Math.max(0, currentTurnCount - event.payload.turnCount);
    // A rewind that cannot work must not discard workspace changes first. An error here says
    // nothing either way, so it does not block the revert.
    if (rolledBackTurns > 0) {
      const canRollback = yield* providerService
        .canRollbackConversation({ threadId: sessionRuntime.value.threadId })
        .pipe(Effect.catch(() => Effect.succeed(true)));
      if (!canRollback) {
        yield* appendRevertFailureActivity({
          threadId: event.payload.threadId,
          turnCount: event.payload.turnCount,
          detail:
            "This conversation is too old for this CLI to rewind, so nothing was changed. Start a new thread to continue from here.",
          createdAt: now,
        }).pipe(Effect.catch(() => Effect.void));
        return;
      }
    }

    if (restoreFiles) {
      if (!(yield* isRestoreWorkspaceIsolated(thread.id, sessionRuntime.value.cwd))) {
        yield* appendRevertFailureActivity({
          threadId: event.payload.threadId,
          turnCount: event.payload.turnCount,
          detail:
            "Restoring files requires a workspace no other thread uses. Another thread shares this workspace, so restoring could erase its changes.",
          createdAt: now,
        }).pipe(Effect.catch(() => Effect.void));
        return;
      }

      const targetCheckpointRef =
        event.payload.turnCount === 0
          ? checkpointRefForThreadTurn(event.payload.threadId, 0)
          : thread.checkpoints.find(
              (checkpoint) => checkpoint.checkpointTurnCount === event.payload.turnCount,
            )?.checkpointRef;

      if (!targetCheckpointRef) {
        yield* appendRevertFailureActivity({
          threadId: event.payload.threadId,
          turnCount: event.payload.turnCount,
          detail: `Checkpoint ref for turn ${event.payload.turnCount} is unavailable in read model.`,
          createdAt: now,
        }).pipe(Effect.catch(() => Effect.void));
        return;
      }

      const restored = yield* checkpointStore.restoreCheckpoint({
        cwd: sessionRuntime.value.cwd,
        checkpointRef: targetCheckpointRef,
        fallbackToHead: event.payload.turnCount === 0,
      });
      if (!restored) {
        yield* appendRevertFailureActivity({
          threadId: event.payload.threadId,
          turnCount: event.payload.turnCount,
          detail: `Filesystem checkpoint is unavailable for turn ${event.payload.turnCount}.`,
          createdAt: now,
        }).pipe(Effect.catch(() => Effect.void));
        return;
      }

      // Invalidate the workspace entry cache so the @-mention file picker
      // reflects the reverted filesystem state.
      yield* workspaceEntries.invalidate(sessionRuntime.value.cwd);
    }

    if (rolledBackTurns > 0) {
      const rewound = yield* providerService
        .rollbackConversation({
          threadId: sessionRuntime.value.threadId,
          numTurns: rolledBackTurns,
        })
        .pipe(
          Effect.as(true),
          Effect.catch((error) =>
            restoreFiles
              ? appendRevertFailureActivity({
                  threadId: event.payload.threadId,
                  turnCount: event.payload.turnCount,
                  detail: `Files were restored to turn ${event.payload.turnCount}, but the conversation could not be rewound: ${error.message}`,
                  createdAt: now,
                }).pipe(
                  Effect.catch(() => Effect.void),
                  Effect.as(false),
                )
              : Effect.fail(error),
          ),
        );
      if (!rewound) {
        return;
      }
    }

    const staleCheckpointRefs = thread.checkpoints
      .filter((checkpoint) => checkpoint.checkpointTurnCount > event.payload.turnCount)
      .map((checkpoint) => checkpoint.checkpointRef);

    if (
      staleCheckpointRefs.length > 0 &&
      (restoreFiles || (yield* isGitWorkspace(sessionRuntime.value.cwd)))
    ) {
      yield* checkpointStore.deleteCheckpointRefs({
        cwd: sessionRuntime.value.cwd,
        checkpointRefs: staleCheckpointRefs,
      });
    }

    yield* orchestrationEngine
      .dispatch({
        type: "thread.revert.complete",
        commandId: serverCommandId("checkpoint-revert-complete"),
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        createdAt: now,
      })
      .pipe(
        Effect.catch((error) =>
          appendRevertFailureActivity({
            threadId: event.payload.threadId,
            turnCount: event.payload.turnCount,
            detail: error.message,
            createdAt: now,
          }),
        ),
        Effect.asVoid,
      );

    // A task started in a kept turn may have completed in a reverted one, which took the
    // completion along. These stay open for up to 6h otherwise. A rollback that could not trim
    // the history keeps the CLI, so tasks it still reports are running and will end on their own.
    const liveTasks =
      rolledBackTurns > 0 && thread.session?.providerName === "claudeAgent"
        ? yield* (
            providerService.countLiveBackgroundTasks?.({
              threadId: sessionRuntime.value.threadId,
              provider: "claudeAgent",
            }) ?? Effect.succeed(0)
          )
        : null;
    if (liveTasks === 0) {
      const reverted = (yield* orchestrationEngine.getReadModel()).threads.get(
        event.payload.threadId,
      );
      yield* Effect.forEach(
        settleOpenTasksCommands({
          threadId: event.payload.threadId,
          activities: reverted?.activities ?? [],
          createdAt: now,
          commandId: () => serverCommandId("checkpoint-revert-settle-task"),
        }),
        (command) => orchestrationEngine.dispatch(command),
        { discard: true },
      ).pipe(
        Effect.catch((error) =>
          Effect.logWarning("failed to settle background tasks after a revert", {
            threadId: event.payload.threadId,
            detail: error.message,
          }),
        ),
      );
    }
  });

  const processDomainEvent = Effect.fn("processDomainEvent")(function* (event: OrchestrationEvent) {
    if (event.type === "thread.turn-start-requested" || event.type === "thread.message-sent") {
      yield* ensurePreTurnBaselineFromDomainTurnStart(event);
      return;
    }

    if (event.type === "thread.checkpoint-revert-requested") {
      yield* handleRevertRequested(event).pipe(
        Effect.catch((error) =>
          appendRevertFailureActivity({
            threadId: event.payload.threadId,
            turnCount: event.payload.turnCount,
            detail: error.message,
            createdAt: new Date().toISOString(),
          }),
        ),
      );
      return;
    }
  });

  const processRuntimeEvent = Effect.fn("processRuntimeEvent")(function* (
    event: ProviderRuntimeEvent,
  ) {
    if (event.type === "turn.started") {
      const startedTurnId = toTurnId(event.turnId);
      if (startedTurnId) {
        startedTurns.set(event.threadId, startedTurnId);
      }
      yield* ensurePreTurnBaselineFromTurnStart(event);
      return;
    }

    if (event.type === "turn.completed" || event.type === "turn.aborted") {
      const turnId = toTurnId(event.turnId);
      const isTrackedTurn = sameId(startedTurns.get(event.threadId), turnId);
      if (isTrackedTurn) {
        startedTurns.delete(event.threadId);
      }
      if (event.type === "turn.aborted" && !isTrackedTurn) {
        const readModel = yield* orchestrationEngine.getReadModel();
        const activeTurnId = readModel.threads.get(event.threadId)?.session?.activeTurnId;
        // Aborts for auxiliary or unknown turns must not snapshot the primary turn's files.
        if (!sameId(activeTurnId, turnId)) {
          return;
        }
      }
      yield* captureCheckpointFromTurnCompletion(event).pipe(
        Effect.catch((error) =>
          appendCaptureFailureActivity({
            threadId: event.threadId,
            turnId,
            detail: error.message,
            createdAt: new Date().toISOString(),
          }).pipe(Effect.catch(() => Effect.void)),
        ),
      );
      return;
    }
  });

  const processInput = (
    input: ReactorInput,
  ): Effect.Effect<void, CheckpointStoreError | OrchestrationDispatchError, never> =>
    input.source === "domain" ? processDomainEvent(input.event) : processRuntimeEvent(input.event);

  const processInputSafely = (input: ReactorInput) =>
    processInput(input).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("checkpoint reactor failed to process input", {
          source: input.source,
          eventType: input.event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processInputSafely);

  const start: CheckpointReactorShape["start"] = Effect.fn("start")(function* () {
    // Subscribe synchronously BEFORE forking the consumer loops. PubSub.subscribe
    // returns a scoped Dequeue that is fully attached to the PubSub by the time
    // this Effect resolves, so events published in the gap between fork dispatch
    // and the loop's first take are guaranteed to be queued. The previous
    // Stream.runForEach pattern subscribed lazily inside the forked fiber and
    // dropped events in that gap — see comment in processDomainEvent below.
    const domainEventQueue = yield* orchestrationEngine.subscribeDomainEvents();
    const runtimeEventQueue = yield* providerService.subscribeEvents();

    yield* Effect.forkScoped(
      Effect.forever(
        PubSub.take(domainEventQueue).pipe(
          Effect.flatMap((event) => {
            if (
              event.type !== "thread.turn-start-requested" &&
              event.type !== "thread.message-sent" &&
              event.type !== "thread.checkpoint-revert-requested"
            ) {
              return Effect.void;
            }
            return worker.enqueue({ source: "domain", event });
          }),
        ),
      ),
    );

    yield* Effect.forkScoped(
      Effect.forever(
        PubSub.take(runtimeEventQueue).pipe(
          Effect.flatMap((event) => {
            if (
              event.type !== "turn.started" &&
              event.type !== "turn.completed" &&
              event.type !== "turn.aborted"
            ) {
              return Effect.void;
            }
            return worker.enqueue({ source: "runtime", event });
          }),
        ),
      ),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies CheckpointReactorShape;
});

export const CheckpointReactorLive = Layer.effect(CheckpointReactor, make);
