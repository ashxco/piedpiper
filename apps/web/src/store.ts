import {
  retainThreadMessagesAfterRevert,
  retainThreadItemsAfterRevert,
} from "@piedpiper/shared/threadRevert";
import {
  type OrchestrationEvent,
  type OrchestrationReadModel,
  ThreadId,
  type ToolInputPreviewEvent,
} from "@piedpiper/contracts";
import { withResolvedModelSlug } from "@piedpiper/shared/model";
import { create } from "zustand";

import {
  buildSidebarThreadSummary,
  buildSidebarThreadsById,
  mapMessage,
  mapProject,
  mapProjectScripts,
  mapProposedPlan,
  mapSession,
  mapThread,
  mapTurnDiffSummary,
  sidebarThreadSummariesEqual,
} from "./lib/storeDataMapping";
import { appendLiveCommandOutput, LIVE_COMMAND_OUTPUT_FIELD } from "./lib/liveCommandOutput";
import {
  MAX_THREAD_CHECKPOINTS,
  MAX_THREAD_MESSAGES,
  MAX_THREAD_PROPOSED_PLANS,
  appendThreadActivity,
  appendThreadIdByProjectId,
  buildLatestTurn,
  buildThreadIdsByProjectId,
  checkpointStatusToLatestTurnState,
  readActivityProviderItemId,
  rebindTurnDiffSummariesForAssistantMessage,
  removeThreadIdByProjectId,
  settledTurnStateForSessionStatus,
  updateProject,
  upsertStreamedMessage,
} from "./lib/storeUpdateHelpers";
import {
  type Project,
  type SidebarThreadSummary,
  type Thread,
  type ToolInputStream,
} from "./types";

// ── State ────────────────────────────────────────────────────────────

export interface AppState {
  projects: Project[];
  threads: Thread[];
  sidebarThreadsById: Record<string, SidebarThreadSummary>;
  threadIdsByProjectId: Record<string, ThreadId[]>;
  userRenamedThreadIds: Set<string>;
  bootstrapComplete: boolean;
  toolInputPreviews: Record<string, Record<string, ToolInputStream>>;
}

const initialState: AppState = {
  projects: [],
  threads: [],
  sidebarThreadsById: {},
  threadIdsByProjectId: {},
  userRenamedThreadIds: new Set(),
  bootstrapComplete: false,
  toolInputPreviews: {},
};

// ── State transition helpers ─────────────────────────────────────────

function isSessionRunningTurn(thread: Thread, turnId: string | null): boolean {
  return (
    thread.session?.orchestrationStatus === "running" && thread.session.activeTurnId === turnId
  );
}

function updateThreadState(
  state: AppState,
  threadId: ThreadId,
  updater: (thread: Thread) => Thread,
  upsertedMessageId?: Thread["messages"][number]["id"],
): AppState {
  const index = state.threads.findIndex((thread) => thread.id === threadId);
  const previousThread = index === -1 ? undefined : state.threads[index];
  if (previousThread === undefined) {
    return state;
  }
  const updatedThread = updater(previousThread);
  if (updatedThread === previousThread) {
    return state;
  }
  const threads = state.threads.slice();
  threads[index] = updatedThread;

  const previousSummary = state.sidebarThreadsById[threadId];
  const nextSummary = buildSidebarThreadSummary(
    updatedThread,
    previousSummary === undefined
      ? undefined
      : {
          previousThread,
          previousSummary,
          ...(upsertedMessageId !== undefined ? { upsertedMessageId } : {}),
        },
  );
  const sidebarThreadsById = sidebarThreadSummariesEqual(previousSummary, nextSummary)
    ? state.sidebarThreadsById
    : {
        ...state.sidebarThreadsById,
        [threadId]: nextSummary,
      };

  if (sidebarThreadsById === state.sidebarThreadsById) {
    return {
      ...state,
      threads,
    };
  }

  return {
    ...state,
    threads,
    sidebarThreadsById,
  };
}

// ── Tool input preview helpers ────────────────────────────────────────

export function applyToolInputPreviewBatch(
  state: AppState,
  batch: ReadonlyArray<ToolInputPreviewEvent>,
): AppState {
  if (batch.length === 0) {
    return state;
  }

  let nextPreviews: Record<string, Record<string, ToolInputStream>> | null = null;
  let completedItemKeys: Set<string> | null = null;
  for (const event of batch) {
    if (!event.itemId) continue;
    const threadId = event.threadId;
    const itemId = event.itemId;
    const source = nextPreviews ?? state.toolInputPreviews;
    const threadBucket = source[threadId];
    const existing = threadBucket?.[itemId];
    if (existing === undefined) {
      // rAF-buffered deltas can land after tool.completed cleared the entry;
      // re-creating it would show a truncated tail in place of the static preview.
      const key = `${threadId}\u0000${itemId}`;
      if (completedItemKeys?.has(key) || isToolItemCompleted(state, threadId, itemId)) {
        (completedItemKeys ??= new Set()).add(key);
        continue;
      }
    }
    // Bash streams its command preview under the same item id; live output replaces that text.
    const text =
      event.fieldName === LIVE_COMMAND_OUTPUT_FIELD
        ? appendLiveCommandOutput(
            existing?.fieldName === LIVE_COMMAND_OUTPUT_FIELD ? existing.text : "",
            event.delta,
          )
        : existing
          ? `${existing.text}${event.delta}`
          : event.delta;
    const updatedAt = Date.now();
    // Sticky: meta fields (filePath, oldString) may not be present on every
    // delta — keep whatever the most recent event provided, or fall back to
    // the previously-captured value so they don't disappear mid-stream.
    const filePath = event.filePath ?? existing?.filePath;
    const oldString = event.oldString ?? existing?.oldString;
    const nextEntry: ToolInputStream = {
      toolName: event.toolName,
      fieldName: event.fieldName,
      ...(filePath !== undefined ? { filePath } : {}),
      ...(oldString !== undefined ? { oldString } : {}),
      text,
      updatedAt,
    };
    if (nextPreviews === null) {
      nextPreviews = { ...state.toolInputPreviews };
    }
    nextPreviews[threadId] = {
      ...(nextPreviews[threadId] ?? threadBucket),
      [itemId]: nextEntry,
    };
  }

  if (nextPreviews === null) {
    return state;
  }

  return { ...state, toolInputPreviews: nextPreviews };
}

function isToolItemCompleted(state: AppState, threadId: string, itemId: string): boolean {
  const thread = state.threads.find((entry) => entry.id === threadId);
  if (thread === undefined) return false;
  for (let index = thread.activities.length - 1; index >= 0; index -= 1) {
    const activity = thread.activities[index]!;
    if (activity.kind === "tool.completed" && readActivityProviderItemId(activity) === itemId) {
      return true;
    }
  }
  return false;
}

export function clearThreadPreviews(state: AppState, threadId: string): AppState {
  if (!Object.hasOwn(state.toolInputPreviews, threadId)) {
    return state;
  }
  const nextPreviews = { ...state.toolInputPreviews };
  delete nextPreviews[threadId];
  return { ...state, toolInputPreviews: nextPreviews };
}

export function clearItemPreview(state: AppState, threadId: string, itemId: string): AppState {
  const threadBucket = state.toolInputPreviews[threadId];
  if (!threadBucket || !Object.hasOwn(threadBucket, itemId)) {
    return state;
  }
  const nextThreadBucket = { ...threadBucket };
  delete nextThreadBucket[itemId];
  const nextPreviews = { ...state.toolInputPreviews };
  if (Object.keys(nextThreadBucket).length === 0) {
    delete nextPreviews[threadId];
  } else {
    nextPreviews[threadId] = nextThreadBucket;
  }
  return { ...state, toolInputPreviews: nextPreviews };
}

// ── Pure state transition functions ────────────────────────────────────

export function syncServerReadModel(state: AppState, readModel: OrchestrationReadModel): AppState {
  const projects = readModel.projects
    .filter((project) => project.deletedAt === null)
    .map(mapProject);
  const threads = readModel.threads.filter((thread) => thread.deletedAt === null).map(mapThread);
  const sidebarThreadsById = buildSidebarThreadsById(threads);
  const threadIdsByProjectId = buildThreadIdsByProjectId(threads);
  return {
    ...state,
    projects,
    threads,
    sidebarThreadsById,
    threadIdsByProjectId,
    bootstrapComplete: true,
  };
}

export function applyOrchestrationEvent(state: AppState, event: OrchestrationEvent): AppState {
  switch (event.type) {
    case "project.created": {
      const existingIndex = state.projects.findIndex(
        (project) =>
          project.id === event.payload.projectId || project.cwd === event.payload.workspaceRoot,
      );
      const nextProject = mapProject({
        id: event.payload.projectId,
        title: event.payload.title,
        workspaceRoot: event.payload.workspaceRoot,
        defaultModelSelection: event.payload.defaultModelSelection,
        scripts: event.payload.scripts,
        faviconPath: event.payload.faviconPath ?? null,
        createdAt: event.payload.createdAt,
        updatedAt: event.payload.updatedAt,
        archivedAt: null,
        deletedAt: null,
      });
      const projects =
        existingIndex >= 0
          ? state.projects.map((project, index) =>
              index === existingIndex ? nextProject : project,
            )
          : [...state.projects, nextProject];
      return { ...state, projects };
    }

    case "project.meta-updated": {
      const projects = updateProject(state.projects, event.payload.projectId, (project) => ({
        ...project,
        ...(event.payload.title !== undefined ? { name: event.payload.title } : {}),
        ...(event.payload.workspaceRoot !== undefined ? { cwd: event.payload.workspaceRoot } : {}),
        ...(event.payload.defaultModelSelection !== undefined
          ? {
              defaultModelSelection: event.payload.defaultModelSelection
                ? withResolvedModelSlug(event.payload.defaultModelSelection)
                : null,
            }
          : {}),
        ...(event.payload.scripts !== undefined
          ? { scripts: mapProjectScripts(event.payload.scripts) }
          : {}),
        ...(event.payload.archivedAt !== undefined ? { archivedAt: event.payload.archivedAt } : {}),
        ...(event.payload.faviconPath !== undefined
          ? { faviconPath: event.payload.faviconPath }
          : {}),
        updatedAt: event.payload.updatedAt,
      }));
      return projects === state.projects ? state : { ...state, projects };
    }

    case "project.deleted": {
      const deletedProjectId = event.payload.projectId;
      const projects = state.projects.filter((project) => project.id !== deletedProjectId);
      if (projects.length === state.projects.length) return state;
      const deletedThreadIds = new Set(
        state.threads.filter((t) => t.projectId === deletedProjectId).map((t) => t.id),
      );
      if (deletedThreadIds.size === 0) {
        const { [deletedProjectId]: _removed, ...threadIdsByProjectId } =
          state.threadIdsByProjectId;
        return { ...state, projects, threadIdsByProjectId };
      }
      const threads = state.threads.filter((thread) => !deletedThreadIds.has(thread.id));
      const sidebarThreadsById = { ...state.sidebarThreadsById };
      const toolInputPreviews = { ...state.toolInputPreviews };
      for (const threadId of deletedThreadIds) {
        delete sidebarThreadsById[threadId];
        delete toolInputPreviews[threadId];
      }
      const { [deletedProjectId]: _, ...threadIdsByProjectId } = state.threadIdsByProjectId;
      return {
        ...state,
        projects,
        threads,
        sidebarThreadsById,
        threadIdsByProjectId,
        toolInputPreviews,
      };
    }

    case "thread.created": {
      const existing = state.threads.find((thread) => thread.id === event.payload.threadId);
      const nextThread = mapThread({
        id: event.payload.threadId,
        projectId: event.payload.projectId,
        title: event.payload.title,
        modelSelection: event.payload.modelSelection,
        runtimeMode: event.payload.runtimeMode,
        interactionMode: event.payload.interactionMode,
        ...(event.payload.systemPrompt != null ? { systemPrompt: event.payload.systemPrompt } : {}),
        branch: event.payload.branch,
        worktreePath: event.payload.worktreePath,
        latestTurn: null,
        createdAt: event.payload.createdAt,
        updatedAt: event.payload.updatedAt,
        archivedAt: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
      });
      const threads = existing
        ? state.threads.map((thread) => (thread.id === nextThread.id ? nextThread : thread))
        : [...state.threads, nextThread];
      const nextSummary = buildSidebarThreadSummary(nextThread);
      const previousSummary = state.sidebarThreadsById[nextThread.id];
      const sidebarThreadsById = sidebarThreadSummariesEqual(previousSummary, nextSummary)
        ? state.sidebarThreadsById
        : {
            ...state.sidebarThreadsById,
            [nextThread.id]: nextSummary,
          };
      const nextThreadIdsByProjectId =
        existing !== undefined && existing.projectId !== nextThread.projectId
          ? removeThreadIdByProjectId(state.threadIdsByProjectId, existing.projectId, existing.id)
          : state.threadIdsByProjectId;
      const threadIdsByProjectId = appendThreadIdByProjectId(
        nextThreadIdsByProjectId,
        nextThread.projectId,
        nextThread.id,
      );
      return {
        ...state,
        threads,
        sidebarThreadsById,
        threadIdsByProjectId,
      };
    }

    case "thread.deleted": {
      const threads = state.threads.filter((thread) => thread.id !== event.payload.threadId);
      if (threads.length === state.threads.length) {
        return state;
      }
      const deletedThread = state.threads.find((thread) => thread.id === event.payload.threadId);
      const sidebarThreadsById = { ...state.sidebarThreadsById };
      delete sidebarThreadsById[event.payload.threadId];
      const threadIdsByProjectId = deletedThread
        ? removeThreadIdByProjectId(
            state.threadIdsByProjectId,
            deletedThread.projectId,
            deletedThread.id,
          )
        : state.threadIdsByProjectId;
      const baseNext: AppState = {
        ...state,
        threads,
        sidebarThreadsById,
        threadIdsByProjectId,
      };
      return clearThreadPreviews(baseNext, event.payload.threadId);
    }

    case "thread.archived": {
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        archivedAt: event.payload.archivedAt,
        updatedAt: event.payload.updatedAt,
      }));
    }

    case "thread.unarchived": {
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        archivedAt: null,
        updatedAt: event.payload.updatedAt,
      }));
    }

    case "thread.meta-updated": {
      const isUserRenamed = state.userRenamedThreadIds.has(event.payload.threadId);
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        ...(event.payload.title !== undefined && !isUserRenamed
          ? { title: event.payload.title }
          : {}),
        ...(event.payload.modelSelection !== undefined
          ? { modelSelection: withResolvedModelSlug(event.payload.modelSelection) }
          : {}),
        ...(event.payload.branch !== undefined ? { branch: event.payload.branch } : {}),
        ...(event.payload.worktreePath !== undefined
          ? { worktreePath: event.payload.worktreePath }
          : {}),
        updatedAt: event.payload.updatedAt,
      }));
    }

    case "thread.runtime-mode-set": {
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        runtimeMode: event.payload.runtimeMode,
        updatedAt: event.payload.updatedAt,
      }));
    }

    case "thread.interaction-mode-set": {
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        interactionMode: event.payload.interactionMode,
        updatedAt: event.payload.updatedAt,
      }));
    }

    case "thread.turn-start-requested": {
      return updateThreadState(state, event.payload.threadId, (thread) => ({
        ...thread,
        ...(event.payload.modelSelection !== undefined
          ? { modelSelection: withResolvedModelSlug(event.payload.modelSelection) }
          : {}),
        runtimeMode: event.payload.runtimeMode,
        interactionMode: event.payload.interactionMode,
        pendingSourceProposedPlan: event.payload.sourceProposedPlan,
        updatedAt: event.occurredAt,
      }));
    }

    case "thread.turn-interrupt-requested": {
      const cleared = clearThreadPreviews(state, event.payload.threadId);
      if (event.payload.turnId === undefined) {
        return cleared;
      }
      return updateThreadState(cleared, event.payload.threadId, (thread) => {
        const latestTurn = thread.latestTurn;
        if (latestTurn === null || latestTurn.turnId !== event.payload.turnId) {
          return thread;
        }
        return {
          ...thread,
          latestTurn: buildLatestTurn({
            previous: latestTurn,
            turnId: event.payload.turnId,
            state: "interrupted",
            requestedAt: latestTurn.requestedAt,
            startedAt: latestTurn.startedAt ?? event.payload.createdAt,
            completedAt: latestTurn.completedAt ?? event.payload.createdAt,
            assistantMessageId: latestTurn.assistantMessageId,
          }),
          updatedAt: event.occurredAt,
        };
      });
    }

    case "thread.message-sent": {
      return updateThreadState(
        state,
        event.payload.threadId,
        (thread) => {
          const message = mapMessage({
            id: event.payload.messageId,
            role: event.payload.role,
            text: event.payload.text,
            ...(event.payload.attachments !== undefined
              ? { attachments: event.payload.attachments }
              : {}),
            turnId: event.payload.turnId,
            streaming: event.payload.streaming,
            createdAt: event.payload.createdAt,
            updatedAt: event.payload.updatedAt,
          });
          const cappedMessages = upsertStreamedMessage(thread.messages, message);
          // A late image must not take the turn's pointers from the reply.
          const isAttachmentOnly =
            event.payload.text.trim().length === 0 && (event.payload.attachments?.length ?? 0) > 0;
          // The server keeps the first pointer on any turn, so an older turn's summary stays put too.
          const keepsTurnReply =
            isAttachmentOnly &&
            (thread.latestTurn?.turnId === event.payload.turnId
              ? thread.latestTurn.assistantMessageId !== null
              : thread.turnDiffSummaries.some(
                  (summary) =>
                    summary.turnId === event.payload.turnId &&
                    summary.assistantMessageId !== undefined,
                ));
          const turnDiffSummaries =
            event.payload.role === "assistant" && event.payload.turnId !== null && !keepsTurnReply
              ? rebindTurnDiffSummariesForAssistantMessage(
                  thread.turnDiffSummaries,
                  event.payload.turnId,
                  event.payload.messageId,
                )
              : thread.turnDiffSummaries;
          // A finished message only settles the turn once the session stops running it.
          const settlesTurn =
            !event.payload.streaming && !isSessionRunningTurn(thread, event.payload.turnId);
          // Checked before streaming: a failed turn's buffered text still arrives after the failure.
          const stickyState =
            thread.latestTurn?.turnId === event.payload.turnId &&
            (thread.latestTurn.state === "error" || thread.latestTurn.state === "interrupted")
              ? thread.latestTurn.state
              : null;
          const latestTurn: Thread["latestTurn"] =
            event.payload.role === "assistant" &&
            event.payload.turnId !== null &&
            (thread.latestTurn === null || thread.latestTurn.turnId === event.payload.turnId)
              ? buildLatestTurn({
                  previous: thread.latestTurn,
                  turnId: event.payload.turnId,
                  state: stickyState ?? (settlesTurn ? "completed" : "running"),
                  requestedAt:
                    thread.latestTurn?.turnId === event.payload.turnId
                      ? thread.latestTurn.requestedAt
                      : event.payload.createdAt,
                  startedAt:
                    thread.latestTurn?.turnId === event.payload.turnId
                      ? (thread.latestTurn.startedAt ?? event.payload.createdAt)
                      : event.payload.createdAt,
                  sourceProposedPlan: thread.pendingSourceProposedPlan,
                  completedAt:
                    stickyState !== null
                      ? (thread.latestTurn?.completedAt ?? event.payload.updatedAt)
                      : settlesTurn
                        ? isAttachmentOnly
                          ? (thread.latestTurn?.completedAt ?? event.payload.updatedAt)
                          : event.payload.updatedAt
                        : thread.latestTurn?.turnId === event.payload.turnId
                          ? (thread.latestTurn.completedAt ?? null)
                          : null,
                  assistantMessageId:
                    keepsTurnReply && thread.latestTurn?.assistantMessageId
                      ? thread.latestTurn.assistantMessageId
                      : event.payload.messageId,
                })
              : thread.latestTurn;
          return {
            ...thread,
            messages: cappedMessages,
            turnDiffSummaries,
            latestTurn,
            updatedAt: event.occurredAt,
          };
        },
        event.payload.messageId,
      );
    }

    case "thread.session-set": {
      const sessionStatus = event.payload.session.status;
      const baseState =
        sessionStatus === "stopped" || sessionStatus === "error"
          ? clearThreadPreviews(state, event.payload.threadId)
          : state;
      const settledTurnState = settledTurnStateForSessionStatus(sessionStatus);
      return updateThreadState(baseState, event.payload.threadId, (thread) => ({
        ...thread,
        session: mapSession(event.payload.session),
        error: event.payload.session.lastError ?? null,
        latestTurn:
          event.payload.session.status === "running" && event.payload.session.activeTurnId !== null
            ? buildLatestTurn({
                previous: thread.latestTurn,
                turnId: event.payload.session.activeTurnId,
                state: "running",
                requestedAt:
                  thread.latestTurn?.turnId === event.payload.session.activeTurnId
                    ? thread.latestTurn.requestedAt
                    : event.payload.session.updatedAt,
                startedAt:
                  thread.latestTurn?.turnId === event.payload.session.activeTurnId
                    ? (thread.latestTurn.startedAt ?? event.payload.session.updatedAt)
                    : event.payload.session.updatedAt,
                completedAt: null,
                assistantMessageId:
                  thread.latestTurn?.turnId === event.payload.session.activeTurnId
                    ? thread.latestTurn.assistantMessageId
                    : null,
                sourceProposedPlan: thread.pendingSourceProposedPlan,
              })
            : thread.latestTurn?.state === "running" && settledTurnState !== null
              ? {
                  ...thread.latestTurn,
                  state: settledTurnState,
                  completedAt: event.payload.session.updatedAt,
                }
              : thread.latestTurn,
        updatedAt: event.occurredAt,
      }));
    }

    case "thread.session-stop-requested": {
      const cleared = clearThreadPreviews(state, event.payload.threadId);
      return updateThreadState(cleared, event.payload.threadId, (thread) =>
        thread.session === null
          ? thread
          : {
              ...thread,
              session: {
                ...thread.session,
                status: "closed",
                orchestrationStatus: "stopped",
                activeTurnId: undefined,
                updatedAt: event.payload.createdAt,
              },
              updatedAt: event.occurredAt,
            },
      );
    }

    case "thread.proposed-plan-upserted": {
      return updateThreadState(state, event.payload.threadId, (thread) => {
        const proposedPlan = mapProposedPlan(event.payload.proposedPlan);
        const proposedPlans = [
          ...thread.proposedPlans.filter((entry) => entry.id !== proposedPlan.id),
          proposedPlan,
        ]
          .toSorted(
            (left, right) =>
              left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
          )
          .slice(-MAX_THREAD_PROPOSED_PLANS);
        return {
          ...thread,
          proposedPlans,
          updatedAt: event.occurredAt,
        };
      });
    }

    case "thread.turn-diff-completed": {
      return updateThreadState(state, event.payload.threadId, (thread) => {
        const checkpoint = mapTurnDiffSummary({
          turnId: event.payload.turnId,
          checkpointTurnCount: event.payload.checkpointTurnCount,
          checkpointRef: event.payload.checkpointRef,
          status: event.payload.status,
          files: event.payload.files,
          ...(event.payload.filesTotal === undefined
            ? {}
            : { filesTotal: event.payload.filesTotal }),
          ...(event.payload.additionsTotal === undefined
            ? {}
            : { additionsTotal: event.payload.additionsTotal }),
          ...(event.payload.deletionsTotal === undefined
            ? {}
            : { deletionsTotal: event.payload.deletionsTotal }),
          assistantMessageId: event.payload.assistantMessageId,
          completedAt: event.payload.completedAt,
        });
        const existing = thread.turnDiffSummaries.find(
          (entry) => entry.turnId === checkpoint.turnId,
        );
        if (existing && existing.status !== "missing" && checkpoint.status === "missing") {
          return thread;
        }
        const turnDiffSummaries = [
          ...thread.turnDiffSummaries.filter((entry) => entry.turnId !== checkpoint.turnId),
          checkpoint,
        ]
          .toSorted(
            (left, right) =>
              (left.checkpointTurnCount ?? Number.MAX_SAFE_INTEGER) -
              (right.checkpointTurnCount ?? Number.MAX_SAFE_INTEGER),
          )
          .slice(-MAX_THREAD_CHECKPOINTS);
        // A checkpoint taken mid-run is recorded, but only the session ending settles the turn.
        const latestTurn =
          !isSessionRunningTurn(thread, event.payload.turnId) &&
          (thread.latestTurn === null || thread.latestTurn.turnId === event.payload.turnId)
            ? buildLatestTurn({
                previous: thread.latestTurn,
                turnId: event.payload.turnId,
                state:
                  thread.latestTurn?.turnId === event.payload.turnId &&
                  (thread.latestTurn.state === "error" ||
                    (thread.latestTurn.state === "interrupted" &&
                      // A "missing" placeholder diff also maps to "interrupted"; let the real capture replace it.
                      existing?.status !== "missing"))
                    ? thread.latestTurn.state
                    : checkpointStatusToLatestTurnState(event.payload.status),
                requestedAt: thread.latestTurn?.requestedAt ?? event.payload.completedAt,
                startedAt: thread.latestTurn?.startedAt ?? event.payload.completedAt,
                completedAt: event.payload.completedAt,
                assistantMessageId: event.payload.assistantMessageId,
                sourceProposedPlan: thread.pendingSourceProposedPlan,
              })
            : thread.latestTurn;
        return {
          ...thread,
          turnDiffSummaries,
          latestTurn,
          updatedAt: event.occurredAt,
        };
      });
    }

    case "thread.reverted": {
      const cleared = clearThreadPreviews(state, event.payload.threadId);
      return updateThreadState(cleared, event.payload.threadId, (thread) => {
        const turnDiffSummaries = thread.turnDiffSummaries
          .filter(
            (entry) =>
              entry.checkpointTurnCount !== undefined &&
              entry.checkpointTurnCount <= event.payload.turnCount,
          )
          .toSorted(
            (left, right) =>
              (left.checkpointTurnCount ?? Number.MAX_SAFE_INTEGER) -
              (right.checkpointTurnCount ?? Number.MAX_SAFE_INTEGER),
          )
          .slice(-MAX_THREAD_CHECKPOINTS);
        const retainedTurnIds = new Set(turnDiffSummaries.map((entry) => entry.turnId));
        const messages = retainThreadMessagesAfterRevert(
          thread.messages,
          retainedTurnIds,
          event.payload.turnCount,
        ).slice(-MAX_THREAD_MESSAGES);
        const proposedPlans = retainThreadItemsAfterRevert(
          thread.proposedPlans,
          retainedTurnIds,
        ).slice(-MAX_THREAD_PROPOSED_PLANS);
        const activities = retainThreadItemsAfterRevert(thread.activities, retainedTurnIds);
        const latestCheckpoint = turnDiffSummaries.at(-1) ?? null;

        return {
          ...thread,
          turnDiffSummaries,
          messages,
          proposedPlans,
          activities,
          pendingSourceProposedPlan: undefined,
          latestTurn:
            latestCheckpoint === null
              ? null
              : {
                  turnId: latestCheckpoint.turnId,
                  state: checkpointStatusToLatestTurnState(
                    (latestCheckpoint.status ?? "ready") as "ready" | "missing" | "error",
                  ),
                  requestedAt: latestCheckpoint.completedAt,
                  startedAt: latestCheckpoint.completedAt,
                  completedAt: latestCheckpoint.completedAt,
                  assistantMessageId: latestCheckpoint.assistantMessageId ?? null,
                },
          updatedAt: event.occurredAt,
        };
      });
    }

    case "thread.activity-appended": {
      const activity = event.payload.activity;
      // The timeline falls back to the activity's static preview once the tool
      // completes, so the live stream entry would only pile up across turns.
      const completedItemId =
        activity.kind === "tool.completed" ? readActivityProviderItemId(activity) : null;
      const baseState =
        completedItemId === null
          ? state
          : clearItemPreview(state, event.payload.threadId, completedItemId);
      return updateThreadState(baseState, event.payload.threadId, (thread) => ({
        ...thread,
        activities: appendThreadActivity(thread.activities, activity),
        updatedAt: event.occurredAt,
      }));
    }

    case "thread.approval-response-requested":
    case "thread.user-input-response-requested":
      return state;
  }

  return state;
}

export function applyOrchestrationEvents(
  state: AppState,
  events: ReadonlyArray<OrchestrationEvent>,
): AppState {
  if (events.length === 0) {
    return state;
  }
  return events.reduce((nextState, event) => applyOrchestrationEvent(nextState, event), state);
}

export function setError(state: AppState, threadId: ThreadId, error: string | null): AppState {
  return updateThreadState(state, threadId, (t) => {
    if (t.error === error) return t;
    return { ...t, error };
  });
}

export function setThreadBranch(
  state: AppState,
  threadId: ThreadId,
  branch: string | null,
  worktreePath: string | null,
): AppState {
  return updateThreadState(state, threadId, (t) => {
    if (t.branch === branch && t.worktreePath === worktreePath) return t;
    const cwdChanged = t.worktreePath !== worktreePath;
    return {
      ...t,
      branch,
      worktreePath,
      ...(cwdChanged ? { session: null } : {}),
    };
  });
}

// ── Zustand store ────────────────────────────────────────────────────

interface AppStore extends AppState {
  syncServerReadModel: (readModel: OrchestrationReadModel) => void;
  applyOrchestrationEvent: (event: OrchestrationEvent) => void;
  applyOrchestrationEvents: (events: ReadonlyArray<OrchestrationEvent>) => void;
  setError: (threadId: ThreadId, error: string | null) => void;
  setThreadBranch: (threadId: ThreadId, branch: string | null, worktreePath: string | null) => void;
  /** Pass the title: while the flag is set, the rename's own event is dropped like any other. */
  markThreadUserRenamed: (threadId: ThreadId, title?: string) => void;
  clearThreadUserRenamed: (threadId: ThreadId) => void;
  applyToolInputPreviewBatch: (batch: ReadonlyArray<ToolInputPreviewEvent>) => void;
  clearThreadPreviews: (threadId: string) => void;
  clearItemPreview: (threadId: string, itemId: string) => void;
}

/**
 * Rebuilds the summaries still showing a live background task, so the silence bound applies in a
 * client left open: nothing else re-derives a thread that has stopped getting events.
 */
export function refreshLiveBackgroundTaskSummaries(state: AppState): AppState {
  let sidebarThreadsById = state.sidebarThreadsById;
  for (const thread of state.threads) {
    const previous = state.sidebarThreadsById[thread.id];
    if (previous?.hasLiveBackgroundTask !== true) continue;
    const next = buildSidebarThreadSummary(thread);
    if (sidebarThreadSummariesEqual(previous, next)) continue;
    if (sidebarThreadsById === state.sidebarThreadsById) {
      sidebarThreadsById = { ...state.sidebarThreadsById };
    }
    sidebarThreadsById[thread.id] = next;
  }
  return sidebarThreadsById === state.sidebarThreadsById ? state : { ...state, sidebarThreadsById };
}

const BACKGROUND_TASK_REFRESH_INTERVAL_MS = 5 * 60 * 1_000;

export const useStore = create<AppStore>((set) => ({
  ...initialState,
  syncServerReadModel: (readModel) => set((state) => syncServerReadModel(state, readModel)),
  applyOrchestrationEvent: (event) => set((state) => applyOrchestrationEvent(state, event)),
  applyOrchestrationEvents: (events) => set((state) => applyOrchestrationEvents(state, events)),
  setError: (threadId, error) => set((state) => setError(state, threadId, error)),
  setThreadBranch: (threadId, branch, worktreePath) =>
    set((state) => setThreadBranch(state, threadId, branch, worktreePath)),
  markThreadUserRenamed: (threadId, title) =>
    set((state) => {
      const renamed =
        title === undefined
          ? state
          : updateThreadState(state, threadId, (thread) =>
              thread.title === title ? thread : { ...thread, title },
            );
      return {
        ...renamed,
        userRenamedThreadIds: new Set(state.userRenamedThreadIds).add(threadId),
      };
    }),
  clearThreadUserRenamed: (threadId) =>
    set((state) => {
      if (!state.userRenamedThreadIds.has(threadId)) return state;
      const userRenamedThreadIds = new Set(state.userRenamedThreadIds);
      userRenamedThreadIds.delete(threadId);
      return { userRenamedThreadIds };
    }),
  applyToolInputPreviewBatch: (batch) => set((state) => applyToolInputPreviewBatch(state, batch)),
  clearThreadPreviews: (threadId) => set((state) => clearThreadPreviews(state, threadId)),
  clearItemPreview: (threadId, itemId) => set((state) => clearItemPreview(state, threadId, itemId)),
}));

/** Coarse on purpose; returns the stop function. */
export function startLiveBackgroundTaskRefresh(): () => void {
  const timer = setInterval(() => {
    useStore.setState((state) => refreshLiveBackgroundTaskSummaries(state));
  }, BACKGROUND_TASK_REFRESH_INTERVAL_MS);
  return () => clearInterval(timer);
}
