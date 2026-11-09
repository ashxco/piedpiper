import {
  type OrchestrationSessionStatus,
  type ProjectId,
  THREAD_GOAL_ACTIVITY_KIND,
  THREAD_MODEL_SWITCH_ACTIVITY_KIND,
  THREAD_REASONING_ACTIVITY_KIND,
  type ThreadId,
} from "@piedpiper/contracts";

import { type ChatMessage, type Project, type Thread } from "../types";

export const MAX_THREAD_MESSAGES = 2_000;
export const MAX_THREAD_CHECKPOINTS = 500;
export const MAX_THREAD_PROPOSED_PLANS = 200;
export const MAX_THREAD_ACTIVITIES = 500;
/** Model-switch dividers get their own, larger window, as on the server (capThreadActivities). */
export const MAX_THREAD_MODEL_SWITCH_ACTIVITIES = 2_000;
/** Thinking blocks get their own window, as on the server, so they never evict tool rows. */
export const MAX_THREAD_REASONING_ACTIVITIES = 200;

/** Goal rows get a small window of their own, so a long goal run cannot evict its Clear button. */
export const MAX_THREAD_GOAL_ACTIVITIES = 20;

function activityPayloadField(activity: Thread["activities"][number], field: string): unknown {
  return (activity.payload as Record<string, unknown> | null | undefined)?.[field];
}

/**
 * Keeps the newest activities: 500 of other kinds, 2,000 model-switch dividers, 200 thinking blocks
 * and 20 goal rows, plus the start of every task still running, every open non-blocking question
 * and every held answer, as on the server.
 */
export function capThreadActivities(activities: Thread["activities"]): Thread["activities"] {
  if (activities.length <= MAX_THREAD_REASONING_ACTIVITIES) return activities;
  // A resolution closes its request wherever it sorts, as in derivePendingUserInputs.
  const resolvedRequestIds = new Set<unknown>();
  for (const activity of activities) {
    if (activity.kind === "user-input.resolved") {
      resolvedRequestIds.add(activityPayloadField(activity, "requestId"));
    }
  }
  let keptOthers = 0;
  let keptSwitches = 0;
  let keptReasoning = 0;
  let keptGoals = 0;
  const kept: Thread["activities"][number][] = [];
  // Walked newest first, so a start seen before any completion of its id is still running.
  const completedTaskIds = new Set<unknown>();
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index]!;
    if (activity.kind === "task.completed") {
      completedTaskIds.add(activityPayloadField(activity, "taskId"));
    } else if (activity.kind === "task.started") {
      // A running task's start cannot be recovered: task.progress does not reopen it.
      if (!completedTaskIds.delete(activityPayloadField(activity, "taskId"))) {
        kept.push(activity);
        continue;
      }
    }
    // Evicting a held answer would let a queued send race the server's delivery of it.
    const isHeldAnswer =
      activity.kind === "user-input.resolved" && activityPayloadField(activity, "held") === true;
    const isOpenNonBlockingQuestion =
      activity.kind === "user-input.requested" &&
      activityPayloadField(activity, "responseMode") === "message" &&
      !resolvedRequestIds.has(activityPayloadField(activity, "requestId"));
    if (isHeldAnswer || isOpenNonBlockingQuestion) {
      kept.push(activity);
      continue;
    }
    if (activity.kind === THREAD_MODEL_SWITCH_ACTIVITY_KIND) {
      if (keptSwitches >= MAX_THREAD_MODEL_SWITCH_ACTIVITIES) continue;
      keptSwitches += 1;
    } else if (activity.kind === THREAD_REASONING_ACTIVITY_KIND) {
      if (keptReasoning >= MAX_THREAD_REASONING_ACTIVITIES) continue;
      keptReasoning += 1;
    } else if (activity.kind === THREAD_GOAL_ACTIVITY_KIND) {
      if (keptGoals >= MAX_THREAD_GOAL_ACTIVITIES) continue;
      keptGoals += 1;
    } else {
      if (keptOthers >= MAX_THREAD_ACTIVITIES) continue;
      keptOthers += 1;
    }
    kept.push(activity);
  }
  return kept.length === activities.length ? activities : kept.toReversed();
}
const EMPTY_THREAD_IDS: ThreadId[] = [];

export function updateThread(
  threads: Thread[],
  threadId: ThreadId,
  updater: (t: Thread) => Thread,
): Thread[] {
  let changed = false;
  const next = threads.map((t) => {
    if (t.id !== threadId) return t;
    const updated = updater(t);
    if (updated !== t) changed = true;
    return updated;
  });
  return changed ? next : threads;
}

export function updateProject(
  projects: Project[],
  projectId: ProjectId,
  updater: (project: Project) => Project,
): Project[] {
  let changed = false;
  const next = projects.map((project) => {
    if (project.id !== projectId) {
      return project;
    }
    const updated = updater(project);
    if (updated !== project) {
      changed = true;
    }
    return updated;
  });
  return changed ? next : projects;
}

export function appendThreadIdByProjectId(
  threadIdsByProjectId: Record<string, ThreadId[]>,
  projectId: ProjectId,
  threadId: ThreadId,
): Record<string, ThreadId[]> {
  const existingThreadIds = threadIdsByProjectId[projectId] ?? EMPTY_THREAD_IDS;
  if (existingThreadIds.includes(threadId)) {
    return threadIdsByProjectId;
  }
  return {
    ...threadIdsByProjectId,
    [projectId]: [...existingThreadIds, threadId],
  };
}

export function removeThreadIdByProjectId(
  threadIdsByProjectId: Record<string, ThreadId[]>,
  projectId: ProjectId,
  threadId: ThreadId,
): Record<string, ThreadId[]> {
  const existingThreadIds = threadIdsByProjectId[projectId] ?? EMPTY_THREAD_IDS;
  if (!existingThreadIds.includes(threadId)) {
    return threadIdsByProjectId;
  }
  const nextThreadIds = existingThreadIds.filter(
    (existingThreadId) => existingThreadId !== threadId,
  );
  if (nextThreadIds.length === existingThreadIds.length) {
    return threadIdsByProjectId;
  }
  if (nextThreadIds.length === 0) {
    const nextThreadIdsByProjectId = { ...threadIdsByProjectId };
    delete nextThreadIdsByProjectId[projectId];
    return nextThreadIdsByProjectId;
  }
  return {
    ...threadIdsByProjectId,
    [projectId]: nextThreadIds,
  };
}

export function buildThreadIdsByProjectId(
  threads: ReadonlyArray<Thread>,
): Record<string, ThreadId[]> {
  const threadIdsByProjectId: Record<string, ThreadId[]> = {};
  for (const thread of threads) {
    const existingThreadIds = threadIdsByProjectId[thread.projectId] ?? EMPTY_THREAD_IDS;
    threadIdsByProjectId[thread.projectId] = [...existingThreadIds, thread.id];
  }
  return threadIdsByProjectId;
}

/** Mirrors the server projector: the state a still-running turn settles with when its session leaves "running". */
export function settledTurnStateForSessionStatus(
  status: OrchestrationSessionStatus,
): "completed" | "interrupted" | "error" | null {
  switch (status) {
    case "idle":
    case "ready":
      return "completed";
    case "error":
      return "error";
    case "interrupted":
    case "stopped":
      return "interrupted";
    case "starting":
    case "running":
      return null;
  }
}

export function checkpointStatusToLatestTurnState(status: "ready" | "missing" | "error") {
  if (status === "error") {
    return "error" as const;
  }
  if (status === "missing") {
    return "interrupted" as const;
  }
  return "completed" as const;
}

function compareActivities(
  left: Thread["activities"][number],
  right: Thread["activities"][number],
): number {
  if (left.sequence !== undefined && right.sequence !== undefined) {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
  } else if (left.sequence !== undefined) {
    return 1;
  } else if (right.sequence !== undefined) {
    return -1;
  }

  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

// Id index per reducer-produced activities array. Presence also proves the array
// is compareActivities-sorted, which snapshot-loaded arrays are not.
const activityIdIndex = new WeakMap<ReadonlyArray<Thread["activities"][number]>, Set<string>>();

/**
 * Append one activity. Live streams arrive in order, so an unseen id that sorts
 * at or after the tail appends without re-filtering and re-sorting the whole
 * history; re-delivered, out-of-order and un-indexed arrays fall back to that.
 */
export function appendThreadActivity(
  activities: Thread["activities"],
  activity: Thread["activities"][number],
): Thread["activities"] {
  const next = { ...activity };
  const ids = activityIdIndex.get(activities);
  const last = activities.at(-1);
  if (
    ids !== undefined &&
    !ids.has(next.id) &&
    (last === undefined || compareActivities(last, next) <= 0)
  ) {
    let appended = [...activities, next];
    activityIdIndex.delete(activities);
    ids.add(next.id);
    if (appended.length > MAX_THREAD_REASONING_ACTIVITIES) {
      const capped = capThreadActivities(appended);
      if (capped !== appended) {
        const keptIds = new Set(capped.map((entry) => entry.id));
        for (const entry of appended) {
          if (!keptIds.has(entry.id)) ids.delete(entry.id);
        }
        appended = [...capped];
      }
    }
    activityIdIndex.set(appended, ids);
    return appended;
  }
  const sorted = capThreadActivities(
    [...activities.filter((entry) => entry.id !== next.id), next].toSorted(compareActivities),
  );
  activityIdIndex.set(sorted, new Set(sorted.map((entry) => entry.id)));
  return sorted;
}

/** Merge a thread.message-sent payload into the message it updates. */
function mergeStreamedMessage(entry: ChatMessage, message: ChatMessage): ChatMessage {
  return {
    ...entry,
    text: message.streaming
      ? `${entry.text}${message.text}`
      : message.text.length > 0
        ? message.text
        : entry.text,
    streaming: message.streaming,
    ...(message.turnId !== undefined ? { turnId: message.turnId } : {}),
    ...(message.streaming
      ? entry.completedAt !== undefined
        ? { completedAt: entry.completedAt }
        : {}
      : message.completedAt !== undefined
        ? { completedAt: message.completedAt }
        : {}),
    ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
  };
}

/** Upsert a streamed message; the streaming message is almost always the tail. */
export function upsertStreamedMessage(
  messages: ReadonlyArray<ChatMessage>,
  message: ChatMessage,
): ChatMessage[] {
  const lastIndex = messages.length - 1;
  const existingIndex =
    lastIndex >= 0 && messages[lastIndex]?.id === message.id
      ? lastIndex
      : messages.findIndex((entry) => entry.id === message.id);
  if (existingIndex === -1) {
    const appended = [...messages, message];
    return appended.length > MAX_THREAD_MESSAGES ? appended.slice(-MAX_THREAD_MESSAGES) : appended;
  }
  const next = messages.slice();
  next[existingIndex] = mergeStreamedMessage(messages[existingIndex]!, message);
  return next.length > MAX_THREAD_MESSAGES ? next.slice(-MAX_THREAD_MESSAGES) : next;
}

export function readActivityProviderItemId(
  activity: Pick<Thread["activities"][number], "payload">,
): string | null {
  const payload = activity.payload;
  if (!payload || typeof payload !== "object") return null;
  const providerItemId = (payload as Record<string, unknown>).providerItemId;
  return typeof providerItemId === "string" && providerItemId.length > 0 ? providerItemId : null;
}

export function buildLatestTurn(params: {
  previous: Thread["latestTurn"];
  turnId: NonNullable<Thread["latestTurn"]>["turnId"];
  state: NonNullable<Thread["latestTurn"]>["state"];
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  assistantMessageId: NonNullable<Thread["latestTurn"]>["assistantMessageId"];
  sourceProposedPlan?: Thread["pendingSourceProposedPlan"];
}): NonNullable<Thread["latestTurn"]> {
  const resolvedPlan =
    params.previous?.turnId === params.turnId
      ? params.previous.sourceProposedPlan
      : params.sourceProposedPlan;
  const previous = params.previous;
  // Reuse the previous object so per-token streaming updates don't churn latestTurn consumers.
  if (
    previous &&
    previous.turnId === params.turnId &&
    previous.state === params.state &&
    previous.requestedAt === params.requestedAt &&
    previous.startedAt === params.startedAt &&
    previous.completedAt === params.completedAt &&
    previous.assistantMessageId === params.assistantMessageId &&
    previous.sourceProposedPlan === resolvedPlan
  ) {
    return previous;
  }
  return {
    turnId: params.turnId,
    state: params.state,
    requestedAt: params.requestedAt,
    startedAt: params.startedAt,
    completedAt: params.completedAt,
    assistantMessageId: params.assistantMessageId,
    ...(resolvedPlan ? { sourceProposedPlan: resolvedPlan } : {}),
  };
}

export function rebindTurnDiffSummariesForAssistantMessage(
  turnDiffSummaries: ReadonlyArray<Thread["turnDiffSummaries"][number]>,
  turnId: Thread["turnDiffSummaries"][number]["turnId"],
  assistantMessageId: NonNullable<Thread["latestTurn"]>["assistantMessageId"],
): Thread["turnDiffSummaries"] {
  let changed = false;
  const nextSummaries = turnDiffSummaries.map((summary) => {
    if (summary.turnId !== turnId || summary.assistantMessageId === assistantMessageId) {
      return summary;
    }
    changed = true;
    return {
      ...summary,
      assistantMessageId: assistantMessageId ?? undefined,
    };
  });
  return changed ? nextSummaries : (turnDiffSummaries as Thread["turnDiffSummaries"]);
}
