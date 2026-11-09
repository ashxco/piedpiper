import {
  type ChatAttachment as ContractChatAttachment,
  type ChatFileAttachment as ContractChatFileAttachment,
  type OrchestrationCheckpointSummary,
  type OrchestrationMessage,
  type OrchestrationProposedPlan,
  type OrchestrationSession,
  type OrchestrationSessionStatus,
  type OrchestrationThread,
  type OrchestrationReadModel,
  type ProviderKind,
  USAGE_LIMIT_RESUME_MESSAGE_ID_PREFIX,
} from "@piedpiper/contracts";
import { withResolvedModelSlug } from "@piedpiper/shared/model";

import { appendAuthToken } from "../rpc/authToken";
import {
  derivePendingApprovals,
  derivePendingUserInputs,
  findLatestProposedPlan,
  hasActionableProposedPlan,
  isPendingUserInputAwaitingUser,
} from "../session-logic";
import {
  type ChatAttachment,
  type ChatMessage,
  type Project,
  type SidebarThreadSummary,
  type Thread,
} from "../types";
import { deriveHasLiveBackgroundTask } from "./backgroundTaskLiveness";
import { isRestartContinuationMessageId } from "./restartContinuation";

function toLegacySessionStatus(
  status: OrchestrationSessionStatus,
): "connecting" | "ready" | "running" | "error" | "closed" {
  switch (status) {
    case "starting":
      return "connecting";
    case "running":
      return "running";
    case "error":
      return "error";
    case "ready":
    case "interrupted":
      return "ready";
    case "idle":
    case "stopped":
      return "closed";
  }
}

function toLegacyProvider(providerName: string | null): ProviderKind {
  if (providerName === "codex" || providerName === "claudeAgent") {
    return providerName;
  }
  return "claudeAgent";
}

function resolveWsHttpOrigin(): string {
  if (typeof window === "undefined") return "";
  const bridgeWsUrl = window.desktopBridge?.getWsUrl?.();
  const envWsUrl = import.meta.env.VITE_WS_URL as string | undefined;
  const wsCandidate =
    typeof bridgeWsUrl === "string" && bridgeWsUrl.length > 0
      ? bridgeWsUrl
      : typeof envWsUrl === "string" && envWsUrl.length > 0
        ? envWsUrl
        : null;
  if (!wsCandidate) return window.location.origin;
  try {
    const wsUrl = new URL(wsCandidate);
    const protocol =
      wsUrl.protocol === "wss:" ? "https:" : wsUrl.protocol === "ws:" ? "http:" : wsUrl.protocol;
    return `${protocol}//${wsUrl.host}`;
  } catch {
    return window.location.origin;
  }
}

function toAttachmentPreviewUrl(rawUrl: string): string {
  if (rawUrl.startsWith("/")) {
    // `<img>` requests cannot set headers and desktop mode writes no auth
    // cookie, so the token travels as a query parameter.
    return appendAuthToken(`${resolveWsHttpOrigin()}${rawUrl}`);
  }
  return rawUrl;
}

function attachmentPreviewRoutePath(attachmentId: string): string {
  return `/attachments/${encodeURIComponent(attachmentId)}`;
}

export function mapProjectScripts(
  scripts: ReadonlyArray<Project["scripts"][number]>,
): Project["scripts"] {
  return scripts.map((script) => ({ ...script }));
}

export function mapSession(session: OrchestrationSession): Thread["session"] {
  return {
    provider: toLegacyProvider(session.providerName),
    status: toLegacySessionStatus(session.status),
    orchestrationStatus: session.status,
    activeTurnId: session.activeTurnId ?? undefined,
    createdAt: session.updatedAt,
    updatedAt: session.updatedAt,
    ...(session.lastError ? { lastError: session.lastError } : {}),
  };
}

export function mapMessageAttachment(
  attachment: ContractChatAttachment | ContractChatFileAttachment,
): ChatAttachment {
  const fields = {
    id: attachment.id,
    name: attachment.name,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
  };
  if (attachment.type === "file") return { type: "file", ...fields };
  return {
    type: "image",
    ...fields,
    previewUrl: toAttachmentPreviewUrl(attachmentPreviewRoutePath(attachment.id)),
  };
}

export function mapMessage(message: OrchestrationMessage): ChatMessage {
  const attachments = message.attachments?.map(mapMessageAttachment);

  return {
    id: message.id,
    role: message.role,
    text: message.text,
    turnId: message.turnId,
    createdAt: message.createdAt,
    streaming: message.streaming,
    ...(message.streaming ? {} : { completedAt: message.updatedAt }),
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
  };
}

export function mapProposedPlan(
  proposedPlan: OrchestrationProposedPlan,
): Thread["proposedPlans"][number] {
  return {
    id: proposedPlan.id,
    turnId: proposedPlan.turnId,
    planMarkdown: proposedPlan.planMarkdown,
    implementedAt: proposedPlan.implementedAt,
    implementationThreadId: proposedPlan.implementationThreadId,
    createdAt: proposedPlan.createdAt,
    updatedAt: proposedPlan.updatedAt,
  };
}

export function mapTurnDiffSummary(
  checkpoint: OrchestrationCheckpointSummary,
): Thread["turnDiffSummaries"][number] {
  return {
    turnId: checkpoint.turnId,
    completedAt: checkpoint.completedAt,
    status: checkpoint.status,
    assistantMessageId: checkpoint.assistantMessageId ?? undefined,
    checkpointTurnCount: checkpoint.checkpointTurnCount,
    checkpointRef: checkpoint.checkpointRef,
    files: checkpoint.files.map((file) => ({ ...file })),
    ...(checkpoint.filesTotal === undefined ? {} : { filesTotal: checkpoint.filesTotal }),
    ...(checkpoint.additionsTotal === undefined
      ? {}
      : { additionsTotal: checkpoint.additionsTotal }),
    ...(checkpoint.deletionsTotal === undefined
      ? {}
      : { deletionsTotal: checkpoint.deletionsTotal }),
  };
}

export function mapThread(thread: OrchestrationThread): Thread {
  return {
    id: thread.id,
    codexThreadId: null,
    projectId: thread.projectId,
    title: thread.title,
    modelSelection: withResolvedModelSlug(thread.modelSelection),
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    ...(thread.systemPrompt != null ? { systemPrompt: thread.systemPrompt } : {}),
    session: thread.session ? mapSession(thread.session) : null,
    messages: thread.messages.map(mapMessage),
    proposedPlans: thread.proposedPlans.map(mapProposedPlan),
    error: thread.session?.lastError ?? null,
    createdAt: thread.createdAt,
    archivedAt: thread.archivedAt,
    updatedAt: thread.updatedAt,
    latestTurn: thread.latestTurn,
    pendingSourceProposedPlan: thread.latestTurn?.sourceProposedPlan,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    turnDiffSummaries: thread.checkpoints.map(mapTurnDiffSummary),
    activities: thread.activities.map((activity) => ({ ...activity })),
  };
}

export function mapProject(project: OrchestrationReadModel["projects"][number]): Project {
  return {
    id: project.id,
    name: project.title,
    cwd: project.workspaceRoot,
    defaultModelSelection: project.defaultModelSelection
      ? withResolvedModelSlug(project.defaultModelSelection)
      : null,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    archivedAt: project.archivedAt ?? null,
    faviconPath: project.faviconPath ?? null,
    scripts: mapProjectScripts(project.scripts),
  };
}

/** False for what the server sent itself: a restart continuation or a usage-limit resume. */
function isManualUserMessage(message: Thread["messages"][number]): boolean {
  return (
    !isRestartContinuationMessageId(message.id) &&
    !message.id.startsWith(USAGE_LIMIT_RESUME_MESSAGE_ID_PREFIX)
  );
}

function getLatestUserMessageAt(
  messages: ReadonlyArray<Thread["messages"][number]>,
  counts?: (message: Thread["messages"][number]) => boolean,
): string | null {
  let latestUserMessageAt: string | null = null;

  for (const message of messages) {
    if (message.role !== "user" || counts?.(message) === false) {
      continue;
    }
    if (latestUserMessageAt === null || message.createdAt > latestUserMessageAt) {
      latestUserMessageAt = message.createdAt;
    }
  }

  return latestUserMessageAt;
}

export interface SidebarThreadSummaryReuse {
  previousThread: Thread;
  previousSummary: SidebarThreadSummary;
  /** Set when the update only upserted this message, so latestUserMessageAt can fold it in. */
  upsertedMessageId?: Thread["messages"][number]["id"];
}

function foldLatestUserMessageAt(
  previous: SidebarThreadSummaryReuse,
  messages: Thread["messages"],
  options?: {
    readonly latest: string | null;
    readonly counts: (message: Thread["messages"][number]) => boolean;
  },
): string | null | undefined {
  const tail = messages.at(-1);
  const previousMessages = previous.previousThread.messages;
  if (
    previous.upsertedMessageId === undefined ||
    tail === undefined ||
    tail.id !== previous.upsertedMessageId ||
    // The retention cap evicted the head, which may have held the latest user message.
    (previousMessages.length > 0 && previousMessages[0] !== messages[0])
  ) {
    return undefined;
  }
  const latest = options ? options.latest : previous.previousSummary.latestUserMessageAt;
  return tail.role === "user" &&
    (options?.counts(tail) ?? true) &&
    (latest === null || tail.createdAt > latest)
    ? tail.createdAt
    : latest;
}

/**
 * Build the sidebar projection of a thread. With `reuse`, derived fields whose
 * source arrays are reference-identical to the previous thread are copied from
 * the previous summary, so a streaming message delta never re-sorts activities
 * or re-scans proposed plans.
 */
export function buildSidebarThreadSummary(
  thread: Thread,
  reuse?: SidebarThreadSummaryReuse,
): SidebarThreadSummary {
  const previous =
    reuse !== undefined &&
    reuse.previousThread.id === thread.id &&
    reuse.previousSummary.id === thread.id
      ? reuse
      : undefined;
  const foldedLatestUserMessageAt =
    previous === undefined
      ? undefined
      : previous.previousThread.messages === thread.messages
        ? previous.previousSummary.latestUserMessageAt
        : foldLatestUserMessageAt(previous, thread.messages);
  const latestUserMessageAt =
    foldedLatestUserMessageAt === undefined
      ? getLatestUserMessageAt(thread.messages)
      : foldedLatestUserMessageAt;
  const previousManualUserMessageAt =
    previous === undefined
      ? undefined
      : previous.previousThread.messages === thread.messages
        ? previous.previousSummary.latestManualUserMessageAt
        : foldLatestUserMessageAt(previous, thread.messages, {
            latest: previous.previousSummary.latestManualUserMessageAt ?? null,
            counts: isManualUserMessage,
          });
  const latestManualUserMessageAt =
    previousManualUserMessageAt === undefined
      ? getLatestUserMessageAt(thread.messages, isManualUserMessage)
      : previousManualUserMessageAt;
  const reusePendingFlags =
    previous !== undefined && previous.previousThread.activities === thread.activities;
  const sessionIsWorking =
    thread.session?.orchestrationStatus === "running" ||
    thread.session?.orchestrationStatus === "starting";
  // A settled session leaves a message-mode question waiting on the user, with the same activities.
  const reusePendingInput =
    reusePendingFlags &&
    previous !== undefined &&
    previous.previousThread.session?.orchestrationStatus === thread.session?.orchestrationStatus;
  const hasPendingApprovals =
    reusePendingFlags && previous !== undefined
      ? previous.previousSummary.hasPendingApprovals
      : derivePendingApprovals(thread.activities).length > 0;
  const awaitedUserInputs =
    reusePendingInput && previous !== undefined
      ? null
      : derivePendingUserInputs(thread.activities).filter((question) =>
          isPendingUserInputAwaitingUser(question, sessionIsWorking),
        );
  const hasPendingUserInput =
    awaitedUserInputs === null
      ? (previous as SidebarThreadSummaryReuse).previousSummary.hasPendingUserInput
      : awaitedUserInputs.length > 0;
  const pendingUserInputAt =
    awaitedUserInputs === null
      ? (previous as SidebarThreadSummaryReuse).previousSummary.pendingUserInputAt
      : awaitedUserInputs.reduce<string | null>(
          (latest, question) =>
            latest === null || question.createdAt > latest ? question.createdAt : latest,
          null,
        );
  // The result depends on the provider, and a session can arrive after its activities.
  const hasLiveBackgroundTask =
    reusePendingFlags &&
    previous !== undefined &&
    previous.previousThread.session?.provider === thread.session?.provider
      ? previous.previousSummary.hasLiveBackgroundTask === true
      : deriveHasLiveBackgroundTask(thread.activities, thread.session?.provider, Date.now());
  const latestTurnId = thread.latestTurn?.turnId ?? null;
  const actionablePlan =
    previous !== undefined &&
    previous.previousThread.proposedPlans === thread.proposedPlans &&
    (previous.previousThread.latestTurn?.turnId ?? null) === latestTurnId
      ? previous.previousSummary.hasActionableProposedPlan
      : hasActionableProposedPlan(findLatestProposedPlan(thread.proposedPlans, latestTurnId));
  return {
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    interactionMode: thread.interactionMode,
    session: thread.session,
    createdAt: thread.createdAt,
    archivedAt: thread.archivedAt,
    updatedAt: thread.updatedAt,
    latestTurn: thread.latestTurn,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    latestUserMessageAt,
    latestManualUserMessageAt,
    hasPendingApprovals,
    hasPendingUserInput,
    pendingUserInputAt,
    hasActionableProposedPlan: actionablePlan,
    hasLiveBackgroundTask,
  };
}

export function sidebarThreadSummariesEqual(
  left: SidebarThreadSummary | undefined,
  right: SidebarThreadSummary,
): boolean {
  return (
    left !== undefined &&
    left.id === right.id &&
    left.projectId === right.projectId &&
    left.title === right.title &&
    left.interactionMode === right.interactionMode &&
    left.session === right.session &&
    left.createdAt === right.createdAt &&
    left.archivedAt === right.archivedAt &&
    left.updatedAt === right.updatedAt &&
    left.latestTurn === right.latestTurn &&
    left.branch === right.branch &&
    left.worktreePath === right.worktreePath &&
    left.latestUserMessageAt === right.latestUserMessageAt &&
    left.latestManualUserMessageAt === right.latestManualUserMessageAt &&
    left.hasPendingApprovals === right.hasPendingApprovals &&
    left.hasPendingUserInput === right.hasPendingUserInput &&
    left.pendingUserInputAt === right.pendingUserInputAt &&
    left.hasActionableProposedPlan === right.hasActionableProposedPlan &&
    left.hasLiveBackgroundTask === right.hasLiveBackgroundTask
  );
}

export function buildSidebarThreadsById(
  threads: ReadonlyArray<Thread>,
): Record<string, SidebarThreadSummary> {
  return Object.fromEntries(
    threads.map((thread) => [thread.id, buildSidebarThreadSummary(thread)]),
  );
}
