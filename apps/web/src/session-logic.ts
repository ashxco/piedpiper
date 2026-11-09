import {
  ApprovalRequestId,
  isToolLifecycleItemType,
  THREAD_GOAL_ACTIVITY_KIND,
  THREAD_MODEL_SWITCH_ACTIVITY_KIND,
  THREAD_REASONING_ACTIVITY_KIND,
  THREAD_USAGE_LIMIT_ACTIVITY_KIND,
  THREAD_USAGE_LIMIT_RESUME_CANCELLED_ACTIVITY_KIND,
  type OrchestrationLatestTurn,
  type OrchestrationThreadActivity,
  type OrchestrationProposedPlanId,
  type ProviderKind,
  type ToolLifecycleItemType,
  type UserInputQuestion,
  type ThreadId,
  type TurnId,
} from "@piedpiper/contracts";

import { formatContextWindowTokens } from "./lib/contextWindow";
import { isNoContentRuntimeWarning } from "./lib/noContentRuntimeWarning";
import { dropSupersededProviderRetryActivities } from "./lib/providerRetryActivities";
import type {
  ChatMessage,
  ProposedPlan,
  SessionPhase,
  Thread,
  ThreadSession,
  ToolInputStream,
  TurnDiffSummary,
} from "./types";

export type ProviderPickerKind = ProviderKind;

export interface WorkLogEntry {
  id: string;
  createdAt: string;
  label: string;
  detail?: string;
  command?: string;
  /** The command as the provider sent it, when `command` was unwrapped from a shell wrapper. */
  rawCommand?: string;
  changedFiles?: ReadonlyArray<string>;
  tone: "thinking" | "tool" | "info" | "error";
  toolTitle?: string;
  itemType?: ToolLifecycleItemType;
  requestKind?: PendingApproval["requestKind"];
  /**
   * Provider-stable item id (Claude SDK's tool_use id, Codex's item id).
   * Used to match streaming tool-input previews to the correct work log
   * row and as the primary key for collapsing tool.updated lifecycle
   * entries — two distinct tool calls with the same shape no longer
   * incorrectly merge.
   */
  providerItemId?: string;
  /**
   * Static reconstruction of the streaming tool-input preview, derived
   * from the durable activity payload (`payload.data.input`). Lets old
   * threads continue showing their diff panels after a restart, when
   * the in-memory live preview is gone.
   */
  staticPreview?: ToolInputStream;
  /**
   * The provider tool name (e.g. "Read", "Glob", "Bash") extracted from
   * `payload.data.toolName`. Used by the timeline to render friendly
   * per-tool action labels ("Reading <path>", etc.).
   */
  toolName?: string;
  /**
   * Scalar fields from `payload.data.input` extracted into a compact
   * record. Long strings (> 500 chars) are dropped so file contents and
   * other bulky fields don't bloat the work-log entry.
   */
  toolBriefInput?: Readonly<Record<string, string | number | boolean>>;
  /**
   * The whole `payload.data.input` of an MCP, dynamic or subagent tool, by reference; these tools
   * have no preview card, so expanding their compact row shows it.
   */
  toolInput?: Readonly<Record<string, unknown>>;
  /** The server's one-line summary of the tool's output (at most 84 characters). */
  toolResultSummary?: string;
  /**
   * `true` while the tool is still running (latest activity in the
   * collapsed lifecycle is `tool.started` / `tool.updated`). Used to
   * shimmer the friendly action text.
   */
  inProgress?: boolean;
  /**
   * Provider lifecycle status of a tool call (`payload.status`); a `tool.completed`
   * without one (older threads) counts as completed.
   */
  toolStatus?: WorkLogToolLifecycleStatus;
  /** Set on every compaction row; only the in-progress one is limited to its running turn. */
  isContextCompaction?: boolean;
  /** The turn this row belongs to; turn folds group by it and a newer turn hides stale compaction. */
  turnId?: TurnId;
}

export type WorkLogToolLifecycleStatus =
  | "inProgress"
  | "completed"
  | "failed"
  | "declined"
  | "stopped";

interface DerivedWorkLogEntry extends WorkLogEntry {
  activityKind: OrchestrationThreadActivity["kind"];
  collapseKey?: string;
}

interface WorkLogEntryMeta {
  activityKind: OrchestrationThreadActivity["kind"];
  collapseKey?: string;
}

// Derived rows are cached per activity (and per merged pair) so unchanged rows keep their
// identity across streaming deltas and memoized timeline rows can skip re-rendering.
const workLogEntryByActivity = new WeakMap<OrchestrationThreadActivity, WorkLogEntry>();
const workLogEntryMeta = new WeakMap<WorkLogEntry, WorkLogEntryMeta>();
const mergedWorkLogEntries = new WeakMap<WorkLogEntry, WeakMap<WorkLogEntry, WorkLogEntry>>();

export interface PendingApproval {
  requestId: ApprovalRequestId;
  requestKind: "command" | "file-read" | "file-change";
  createdAt: string;
  /** The provider's raw request type (e.g. "dynamic_tool_call" for MCP tool approvals). */
  requestType?: string;
  detail?: string;
  /** Why the provider asked (Claude's permission decision reason). */
  reason?: string;
  /** The provider forbids an "always allow this session" grant for this request. */
  noStandingGrant?: boolean;
}

export interface PendingUserInput {
  requestId: ApprovalRequestId;
  createdAt: string;
  questions: ReadonlyArray<UserInputQuestion>;
  /** "message": non-blocking, answered by a follow-up message while the turn keeps working. */
  responseMode?: "blocking" | "message";
}

/** Whether the thread is waiting on this question; a non-blocking one leaves it working. */
export function isBlockingPendingUserInput(input: Pick<PendingUserInput, "responseMode">): boolean {
  return input.responseMode !== "message";
}

/** A message-mode question waits on the user too, once no turn is running to answer around. */
export function isPendingUserInputAwaitingUser(
  input: Pick<PendingUserInput, "responseMode">,
  sessionIsWorking: boolean,
): boolean {
  return isBlockingPendingUserInput(input) || !sessionIsWorking;
}

/**
 * Whether the server is about to send a held answer as its own turn, so a queued send must wait
 * for it. The server does not auto-deliver in the excluded states, so nothing can wait on it there.
 */
export function hasHeldAnswerAwaitingDelivery(
  thread: Pick<Thread, "activities" | "latestTurn" | "session" | "archivedAt">,
): boolean {
  if (
    thread.archivedAt !== null ||
    thread.session === null ||
    thread.session.orchestrationStatus === "stopped" ||
    thread.session.orchestrationStatus === "error" ||
    thread.session.orchestrationStatus === "interrupted" ||
    thread.latestTurn?.state === "interrupted" ||
    thread.latestTurn?.state === "error"
  ) {
    return false;
  }
  return thread.activities.some(
    (activity) =>
      activity.kind === "user-input.resolved" &&
      (activity.payload as { readonly held?: unknown } | null | undefined)?.held === true,
  );
}

export interface ActivePlanState {
  createdAt: string;
  turnId: TurnId | null;
  explanation?: string | null;
  steps: Array<{
    step: string;
    status: "pending" | "inProgress" | "completed";
  }>;
}

export interface LatestProposedPlanState {
  id: OrchestrationProposedPlanId;
  createdAt: string;
  updatedAt: string;
  turnId: TurnId | null;
  planMarkdown: string;
  implementedAt: string | null;
  implementationThreadId: ThreadId | null;
}

export type TimelineEntry =
  | {
      id: string;
      kind: "message";
      createdAt: string;
      message: ChatMessage;
    }
  | {
      id: string;
      kind: "proposed-plan";
      createdAt: string;
      proposedPlan: ProposedPlan;
    }
  | {
      id: string;
      kind: "work";
      createdAt: string;
      entry: WorkLogEntry;
    };

export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "0ms";
  const roundedMs = Math.round(durationMs);
  if (roundedMs < 1_000) return `${Math.max(1, roundedMs)}ms`;
  // Choose each unit from the rounded value so 999.6ms reads "1s" and 2000ms reads "2s", not "2.0s".
  const tenths = Math.round(durationMs / 100) / 10;
  if (tenths < 10) return `${tenths}s`;
  const totalSeconds = Math.round(durationMs / 1_000);
  // Choose the unit after rounding so 59.5 seconds never renders as "60s".
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0) parts.push(`${seconds}s`);
  return parts.join(" ");
}

/** Live working timer: whole seconds that tick once a second, then the shared formatter. */
export function formatWorkingTimer(startIso: string, endIso: string): string | null {
  const startedAtMs = Date.parse(startIso);
  const endedAtMs = Date.parse(endIso);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs)) return null;
  const elapsedSeconds = Math.max(0, Math.floor((endedAtMs - startedAtMs) / 1_000));
  if (elapsedSeconds < 60) return `${elapsedSeconds}s`;
  return formatDuration(elapsedSeconds * 1_000);
}

export function formatElapsed(startIso: string, endIso: string | undefined): string | null {
  if (!endIso) return null;
  const startedAt = Date.parse(startIso);
  const endedAt = Date.parse(endIso);
  if (Number.isNaN(startedAt) || Number.isNaN(endedAt) || endedAt < startedAt) {
    return null;
  }
  return formatDuration(endedAt - startedAt);
}

type LatestTurnTiming = Pick<OrchestrationLatestTurn, "turnId" | "startedAt" | "completedAt">;
type SessionActivityState = Pick<ThreadSession, "orchestrationStatus" | "activeTurnId">;

export function isLatestTurnSettled(
  latestTurn: LatestTurnTiming | null,
  session: SessionActivityState | null,
): boolean {
  if (!latestTurn?.startedAt) return false;
  if (!latestTurn.completedAt) return false;
  if (!session) return true;
  if (session.orchestrationStatus === "running") return false;
  return true;
}

export function deriveActiveWorkStartedAt(
  latestTurn: LatestTurnTiming | null,
  session: SessionActivityState | null,
  sendStartedAt: string | null,
): string | null {
  if (!isLatestTurnSettled(latestTurn, session)) {
    return latestTurn?.startedAt ?? sendStartedAt;
  }
  return sendStartedAt;
}

function requestKindFromRequestType(requestType: unknown): PendingApproval["requestKind"] | null {
  switch (requestType) {
    case "command_execution_approval":
    case "exec_command_approval":
    case "dynamic_tool_call":
      return "command";
    case "file_read_approval":
      return "file-read";
    case "file_change_approval":
    case "apply_patch_approval":
      return "file-change";
    default:
      return null;
  }
}

function isStalePendingRequestFailureDetail(detail: string | undefined): boolean {
  // Hyphens fold to spaces so Codex's "user input" and Claude's "user-input" wording both match.
  const normalized = detail?.toLowerCase().replace(/[-\s]+/g, " ");
  if (!normalized) {
    return false;
  }
  return (
    normalized.includes("stale pending approval request") ||
    normalized.includes("stale pending user input request") ||
    normalized.includes("unknown pending approval request") ||
    normalized.includes("unknown pending permission request") ||
    normalized.includes("unknown pending user input request")
  );
}

export function derivePendingApprovals(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): PendingApproval[] {
  const openByRequestId = new Map<ApprovalRequestId, PendingApproval>();
  const ordered = [...activities].toSorted(compareActivitiesByOrder);

  for (const activity of ordered) {
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    const requestId =
      payload && typeof payload.requestId === "string"
        ? ApprovalRequestId.makeUnsafe(payload.requestId)
        : null;
    const requestKind =
      payload &&
      (payload.requestKind === "command" ||
        payload.requestKind === "file-read" ||
        payload.requestKind === "file-change")
        ? payload.requestKind
        : payload
          ? requestKindFromRequestType(payload.requestType)
          : null;
    const detail = payload && typeof payload.detail === "string" ? payload.detail : undefined;

    if (activity.kind === "approval.requested" && requestId && requestKind) {
      const reason =
        typeof payload?.reason === "string" && payload.reason.trim().length > 0
          ? payload.reason
          : undefined;
      const requestType =
        typeof payload?.requestType === "string" && payload.requestType.length > 0
          ? payload.requestType
          : undefined;
      openByRequestId.set(requestId, {
        requestId,
        requestKind,
        createdAt: activity.createdAt,
        ...(requestType ? { requestType } : {}),
        ...(detail ? { detail } : {}),
        ...(reason ? { reason } : {}),
        ...(payload?.noStandingGrant === true ? { noStandingGrant: true } : {}),
      });
      continue;
    }

    if (activity.kind === "approval.resolved" && requestId) {
      openByRequestId.delete(requestId);
      continue;
    }

    if (
      activity.kind === "provider.approval.respond.failed" &&
      requestId &&
      isStalePendingRequestFailureDetail(detail)
    ) {
      openByRequestId.delete(requestId);
      continue;
    }
  }

  return [...openByRequestId.values()].toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}

function parseUserInputQuestions(
  payload: Record<string, unknown> | null,
): ReadonlyArray<UserInputQuestion> | null {
  const questions = payload?.questions;
  if (!Array.isArray(questions)) {
    return null;
  }
  const parsed = questions
    .map<UserInputQuestion | null>((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const question = entry as Record<string, unknown>;
      if (
        typeof question.id !== "string" ||
        typeof question.header !== "string" ||
        typeof question.question !== "string" ||
        !Array.isArray(question.options)
      ) {
        return null;
      }
      const options = question.options
        .map<UserInputQuestion["options"][number] | null>((option) => {
          if (!option || typeof option !== "object") return null;
          const optionRecord = option as Record<string, unknown>;
          if (
            typeof optionRecord.label !== "string" ||
            typeof optionRecord.description !== "string"
          ) {
            return null;
          }
          return {
            label: optionRecord.label,
            description: optionRecord.description,
            ...(typeof optionRecord.preview === "string" && optionRecord.preview.trim().length > 0
              ? { preview: optionRecord.preview }
              : {}),
          };
        })
        .filter((option): option is UserInputQuestion["options"][number] => option !== null);
      // A question with no options stays: the panel's custom answer input answers it.
      return {
        id: question.id,
        header: question.header,
        question: question.question,
        options,
        ...(question.multiSelect === true ? { multiSelect: true } : {}),
      };
    })
    .filter((question): question is UserInputQuestion => question !== null);
  return parsed.length > 0 ? parsed : null;
}

export function derivePendingUserInputs(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): PendingUserInput[] {
  const openByRequestId = new Map<ApprovalRequestId, PendingUserInput>();
  // Collected first, like readUserInputRequestState on the server, so a replayed request row that
  // sorts after its resolution cannot reopen a question the server would reject.
  const resolvedRequestIds = new Set<ApprovalRequestId>();
  for (const activity of activities) {
    const resolvedId = (activity.payload as { readonly requestId?: unknown } | null | undefined)
      ?.requestId;
    if (activity.kind === "user-input.resolved" && typeof resolvedId === "string") {
      resolvedRequestIds.add(ApprovalRequestId.makeUnsafe(resolvedId));
    }
  }
  const ordered = [...activities].toSorted(compareActivitiesByOrder);

  for (const activity of ordered) {
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    const requestId =
      payload && typeof payload.requestId === "string"
        ? ApprovalRequestId.makeUnsafe(payload.requestId)
        : null;
    const detail = payload && typeof payload.detail === "string" ? payload.detail : undefined;

    if (activity.kind === "user-input.requested" && requestId) {
      if (resolvedRequestIds.has(requestId)) continue;
      const questions = parseUserInputQuestions(payload);
      if (!questions) {
        continue;
      }
      openByRequestId.set(requestId, {
        requestId,
        createdAt: activity.createdAt,
        questions,
        ...(payload?.responseMode === "blocking" || payload?.responseMode === "message"
          ? { responseMode: payload.responseMode }
          : {}),
      });
      continue;
    }

    if (activity.kind === "user-input.resolved" && requestId) {
      resolvedRequestIds.add(requestId);
      continue;
    }

    if (
      activity.kind === "provider.user-input.respond.failed" &&
      requestId &&
      isStalePendingRequestFailureDetail(detail)
    ) {
      openByRequestId.delete(requestId);
    }
  }

  // Same rule as the server: a resolution closes the request wherever it sorts.
  return [...openByRequestId.values()]
    .filter((input) => !resolvedRequestIds.has(input.requestId))
    .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
}

/**
 * Whether the panel can offer Dismiss: a non-blocking question always can, and a blocking one can
 * only once nothing is waiting on it (a restart left it open with no live turn to stop).
 */
export function canDismissPendingUserInput(
  input: Pick<PendingUserInput, "responseMode">,
  session: Pick<ThreadSession, "orchestrationStatus" | "activeTurnId"> | null | undefined,
): boolean {
  if (!isBlockingPendingUserInput(input)) return true;
  if (!session) return true;
  return (
    !session.activeTurnId &&
    (session.orchestrationStatus === "stopped" || session.orchestrationStatus === "error")
  );
}

export function deriveActivePlanState(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  latestTurnId: TurnId | undefined,
  options?: {
    /** When the latest turn has no plan, keep showing an earlier turn's plan until it is done. */
    readonly keepUnfinishedEarlierPlan?: boolean;
  },
): ActivePlanState | null {
  const planActivities = activities
    .filter((activity) => activity.kind === "turn.plan.updated")
    .toSorted(compareActivitiesByOrder);
  const latestTurnPlan = latestTurnId
    ? planActivities.findLast((activity) => activity.turnId === latestTurnId)
    : planActivities.at(-1);
  if (latestTurnPlan) {
    return parseActivePlanActivity(latestTurnPlan);
  }
  if (!options?.keepUnfinishedEarlierPlan) {
    return null;
  }
  const earlierPlan = planActivities.at(-1);
  const parsed = earlierPlan ? parseActivePlanActivity(earlierPlan) : null;
  return parsed && parsed.steps.some((step) => step.status !== "completed") ? parsed : null;
}

function parseActivePlanActivity(latest: OrchestrationThreadActivity): ActivePlanState | null {
  const payload =
    latest.payload && typeof latest.payload === "object"
      ? (latest.payload as Record<string, unknown>)
      : null;
  const rawPlan = payload?.plan;
  if (!Array.isArray(rawPlan)) {
    return null;
  }
  const steps = rawPlan
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const record = entry as Record<string, unknown>;
      if (typeof record.step !== "string") {
        return null;
      }
      const status =
        record.status === "completed" || record.status === "inProgress" ? record.status : "pending";
      return {
        step: record.step,
        status,
      };
    })
    .filter(
      (
        step,
      ): step is {
        step: string;
        status: "pending" | "inProgress" | "completed";
      } => step !== null,
    );
  if (steps.length === 0) {
    return null;
  }
  return {
    createdAt: latest.createdAt,
    turnId: latest.turnId,
    ...(payload && "explanation" in payload
      ? { explanation: payload.explanation as string | null }
      : {}),
    steps,
  };
}

export function findLatestProposedPlan(
  proposedPlans: ReadonlyArray<ProposedPlan>,
  latestTurnId: TurnId | string | null | undefined,
): LatestProposedPlanState | null {
  if (latestTurnId) {
    const matchingTurnPlan = [...proposedPlans]
      .filter((proposedPlan) => proposedPlan.turnId === latestTurnId)
      .toSorted(
        (left, right) =>
          left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id),
      )
      .at(-1);
    if (matchingTurnPlan) {
      return toLatestProposedPlanState(matchingTurnPlan);
    }
  }

  const latestPlan = [...proposedPlans]
    .toSorted(
      (left, right) =>
        left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id),
    )
    .at(-1);
  if (!latestPlan) {
    return null;
  }

  return toLatestProposedPlanState(latestPlan);
}

export function findSidebarProposedPlan(input: {
  threads: ReadonlyArray<Pick<Thread, "id" | "proposedPlans">>;
  latestTurn: Pick<OrchestrationLatestTurn, "turnId" | "sourceProposedPlan"> | null;
  latestTurnSettled: boolean;
  threadId: ThreadId | string | null | undefined;
}): LatestProposedPlanState | null {
  const activeThreadPlans =
    input.threads.find((thread) => thread.id === input.threadId)?.proposedPlans ?? [];

  if (!input.latestTurnSettled) {
    const sourceProposedPlan = input.latestTurn?.sourceProposedPlan;
    if (sourceProposedPlan) {
      const sourcePlan = input.threads
        .find((thread) => thread.id === sourceProposedPlan.threadId)
        ?.proposedPlans.find((plan) => plan.id === sourceProposedPlan.planId);
      if (sourcePlan) {
        return toLatestProposedPlanState(sourcePlan);
      }
    }
  }

  return findLatestProposedPlan(activeThreadPlans, input.latestTurn?.turnId ?? null);
}

export function hasActionableProposedPlan(
  proposedPlan: LatestProposedPlanState | Pick<ProposedPlan, "implementedAt"> | null,
): boolean {
  return proposedPlan !== null && proposedPlan.implementedAt === null;
}

export function deriveWorkLogEntries(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  latestTurnId: TurnId | undefined,
): WorkLogEntry[] {
  const ordered = dropSupersededProviderRetryActivities(
    [...activities].toSorted(compareActivitiesByOrder),
  );

  /** Activity kinds that never appear in the work log. */
  const SKIP_KINDS: ReadonlySet<OrchestrationThreadActivity["kind"]> = new Set([
    "task.started",
    "task.completed",
    "context-window.updated",
    "provider.turn.start.failed.missing-cwd",
    "user-input.requested",
    "user-input.resolved",
    // Success shows only the existing "Context compacted" row.
    "context-compaction.completed",
    THREAD_MODEL_SWITCH_ACTIVITY_KIND,
    // The goal row above the composer shows these.
    THREAD_GOAL_ACTIVITY_KIND,
    // Bookkeeping for auto-resume; the thread error already tells the user about the limit.
    THREAD_USAGE_LIMIT_ACTIVITY_KIND,
    THREAD_USAGE_LIMIT_RESUME_CANCELLED_ACTIVITY_KIND,
  ]);
  const settledCompactionStartIds = findSettledContextCompactionStartIds(ordered);

  const entries = ordered
    .filter((activity) => {
      if (latestTurnId && activity.turnId !== latestTurnId) return false;
      if (SKIP_KINDS.has(activity.kind)) return false;
      if (settledCompactionStartIds.has(activity.id)) return false;
      if (activity.summary === "Checkpoint captured") return false;
      if (isNoContentRuntimeWarning(activity)) return false;
      if (isPlanBoundaryToolActivity(activity)) return false;
      // Its text shows as an assistant message instead.
      if (
        activity.kind === THREAD_REASONING_ACTIVITY_KIND &&
        (activity.payload as { status?: unknown } | null | undefined)?.status === "promoted"
      ) {
        return false;
      }

      // Suppress AskUserQuestion / "User input" tool lifecycle noise. Only tool rows are matched
      // by text: task.progress and runtime warnings/errors carry free provider text.
      const isToolLifecycle =
        activity.kind === "tool.started" ||
        activity.kind === "tool.updated" ||
        activity.kind === "tool.completed";
      if (
        isToolLifecycle &&
        (activity.summary?.includes("AskUserQuestion") || activity.summary?.includes("User input"))
      ) {
        return false;
      }
      const p = activity.payload as Record<string, unknown> | undefined;
      const d = p?.data as Record<string, unknown> | undefined;
      if (d?.toolName === "AskUserQuestion") return false;
      if (
        isToolLifecycle &&
        typeof p?.detail === "string" &&
        p.detail.includes("AskUserQuestion")
      ) {
        return false;
      }

      return true;
    })
    .map(toCachedWorkLogEntry);
  return collapseWorkLogEntries(entries);
}

const CONTEXT_COMPACTION_SETTLED_KINDS: ReadonlySet<OrchestrationThreadActivity["kind"]> = new Set([
  "context-compaction.completed",
  "context-compaction.failed",
  "context-compaction",
]);

/** Ids of "Compacting context" activities that a later compaction result has closed. */
function findSettledContextCompactionStartIds(
  ordered: ReadonlyArray<OrchestrationThreadActivity>,
): Set<string> {
  const settled = new Set<string>();
  let open: Array<{ id: string; providerItemId: string | undefined }> = [];
  for (const activity of ordered) {
    if (activity.kind === "context-compaction.started") {
      open.push({ id: activity.id, providerItemId: extractPayloadProviderItemId(activity) });
      continue;
    }
    if (!CONTEXT_COMPACTION_SETTLED_KINDS.has(activity.kind) || open.length === 0) continue;
    const providerItemId = extractPayloadProviderItemId(activity);
    const matched = providerItemId
      ? open.filter((entry) => entry.providerItemId === providerItemId)
      : [];
    // Without an id match, a later result closes every compaction started before it.
    const closing = matched.length > 0 ? matched : open;
    for (const entry of closing) settled.add(entry.id);
    open = open.filter((entry) => !closing.includes(entry));
  }
  return settled;
}

function extractPayloadProviderItemId(activity: OrchestrationThreadActivity): string | undefined {
  const payload = asRecord(activity.payload);
  return typeof payload?.providerItemId === "string" && payload.providerItemId.length > 0
    ? payload.providerItemId
    : undefined;
}

function toCachedWorkLogEntry(activity: OrchestrationThreadActivity): WorkLogEntry {
  const cached = workLogEntryByActivity.get(activity);
  if (cached) return cached;
  const { activityKind, collapseKey, ...entry } = toDerivedWorkLogEntry(activity);
  if (isInProgressActivityKind(activityKind)) {
    entry.inProgress = true;
  }
  if (activity.turnId) entry.turnId = activity.turnId;
  if (activityKind === "context-compaction.started") entry.inProgress = true;
  if (
    activityKind === "context-compaction.started" ||
    activityKind === "context-compaction" ||
    activityKind === "context-compaction.failed"
  ) {
    entry.isContextCompaction = true;
  }
  workLogEntryByActivity.set(activity, entry);
  workLogEntryMeta.set(entry, collapseKey ? { activityKind, collapseKey } : { activityKind });
  return entry;
}

function isInProgressActivityKind(kind: OrchestrationThreadActivity["kind"]): boolean {
  return kind === "tool.started" || kind === "tool.updated";
}

function collapseWorkLogEntries(entries: ReadonlyArray<WorkLogEntry>): WorkLogEntry[] {
  const collapsed: WorkLogEntry[] = [];
  for (const entry of entries) {
    const previous = collapsed.at(-1);
    const previousMeta = previous ? workLogEntryMeta.get(previous) : undefined;
    const nextMeta = workLogEntryMeta.get(entry);
    if (
      previous &&
      previousMeta &&
      nextMeta &&
      shouldCollapseToolLifecycleEntries(
        { ...previous, ...previousMeta },
        { ...entry, ...nextMeta },
      )
    ) {
      collapsed[collapsed.length - 1] = mergeCachedWorkLogEntries(
        previous,
        previousMeta,
        entry,
        nextMeta,
      );
      continue;
    }
    collapsed.push(entry);
  }
  return collapsed;
}

function mergeCachedWorkLogEntries(
  previous: WorkLogEntry,
  previousMeta: WorkLogEntryMeta,
  next: WorkLogEntry,
  nextMeta: WorkLogEntryMeta,
): WorkLogEntry {
  let byNext = mergedWorkLogEntries.get(previous);
  const cached = byNext?.get(next);
  if (cached) return cached;
  const {
    activityKind,
    collapseKey,
    inProgress: _inProgress,
    ...rest
  } = mergeDerivedWorkLogEntries({ ...previous, ...previousMeta }, { ...next, ...nextMeta });
  const merged: WorkLogEntry = rest;
  if (isInProgressActivityKind(activityKind)) {
    merged.inProgress = true;
  }
  if (!byNext) {
    byNext = new WeakMap();
    mergedWorkLogEntries.set(previous, byNext);
  }
  byNext.set(next, merged);
  workLogEntryMeta.set(merged, collapseKey ? { activityKind, collapseKey } : { activityKind });
  return merged;
}

function isPlanBoundaryToolActivity(activity: OrchestrationThreadActivity): boolean {
  if (activity.kind !== "tool.updated" && activity.kind !== "tool.completed") {
    return false;
  }

  const payload =
    activity.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  return typeof payload?.detail === "string" && payload.detail.startsWith("ExitPlanMode:");
}

/** "Context compacted 180k → 12k tokens" when Claude's compact boundary reports both counts. */
function deriveContextCompactionLabel(
  summary: string,
  payload: Record<string, unknown> | null,
): string {
  const metadata = asRecord(asRecord(payload?.detail)?.compact_metadata);
  const preTokens = metadata?.pre_tokens;
  const postTokens = metadata?.post_tokens;
  if (
    typeof preTokens !== "number" ||
    typeof postTokens !== "number" ||
    !Number.isFinite(preTokens) ||
    !Number.isFinite(postTokens) ||
    preTokens <= 0 ||
    postTokens <= 0
  ) {
    return summary;
  }
  return `${summary} ${formatContextWindowTokens(preTokens)} → ${formatContextWindowTokens(postTokens)} tokens`;
}

function toDerivedWorkLogEntry(activity: OrchestrationThreadActivity): DerivedWorkLogEntry {
  const payload =
    activity.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  const { command, rawCommand } = extractToolCommand(payload);
  const changedFiles = extractChangedFiles(payload);
  const title = extractToolTitle(payload);
  const entry: DerivedWorkLogEntry = {
    id: activity.id,
    createdAt: activity.createdAt,
    label:
      activity.kind === "context-compaction"
        ? deriveContextCompactionLabel(activity.summary, payload)
        : activity.summary,
    tone: activity.tone === "approval" ? "info" : activity.tone,
    activityKind: activity.kind,
  };
  const itemType = extractWorkLogItemType(payload);
  const requestKind = extractWorkLogRequestKind(payload);
  const providerItemId =
    payload && typeof payload.providerItemId === "string" && payload.providerItemId.length > 0
      ? payload.providerItemId
      : undefined;
  if (payload && typeof payload.detail === "string" && payload.detail.length > 0) {
    const detail = stripTrailingExitCode(payload.detail).output;
    if (detail) {
      entry.detail = detail;
    }
  }
  if (!entry.detail && (activity.kind === "runtime.error" || activity.kind === "runtime.warning")) {
    const message = typeof payload?.message === "string" ? payload.message.trim() : "";
    const normalizedMessage = normalizeDiagnosticText(message);
    const normalizedLabel = normalizeDiagnosticText(activity.summary);
    if (
      message &&
      normalizedLabel.endsWith("...") &&
      normalizedMessage.startsWith(normalizedLabel.slice(0, -3))
    ) {
      // The label is the message cut to a title; show the whole message once instead of prefix + repeat.
      entry.label = message.replace(/\s+/g, " ");
    } else if (message && normalizedMessage !== normalizedLabel) {
      entry.detail = message;
    }
  }
  if (command) {
    entry.command = command;
  }
  if (rawCommand) {
    entry.rawCommand = rawCommand;
  }
  if (changedFiles.length > 0) {
    entry.changedFiles = changedFiles;
  }
  if (title) {
    entry.toolTitle = title;
  }
  if (itemType) {
    entry.itemType = itemType;
  }
  if (requestKind) {
    entry.requestKind = requestKind;
  }
  if (providerItemId) {
    entry.providerItemId = providerItemId;
  }
  const staticPreview = buildStaticToolInputStream(payload);
  if (staticPreview) {
    entry.staticPreview = staticPreview;
  }
  const toolName = extractToolName(payload);
  if (toolName) {
    entry.toolName = toolName;
  }
  const toolBriefInput = extractToolBriefInput(payload);
  if (toolBriefInput) {
    entry.toolBriefInput = toolBriefInput;
  }
  const toolInput = extractExpandableToolInput(payload, itemType);
  if (toolInput) {
    entry.toolInput = toolInput;
  }
  const toolResultSummary = extractToolResultSummary(payload);
  if (toolResultSummary) {
    entry.toolResultSummary = toolResultSummary;
  }
  const toolStatus = extractWorkLogToolLifecycleStatus(activity);
  if (toolStatus) {
    entry.toolStatus = toolStatus;
  }
  const collapseKey = deriveToolLifecycleCollapseKey(entry);
  if (collapseKey) {
    entry.collapseKey = collapseKey;
  }
  return entry;
}

/** `payload.status` of a tool lifecycle activity; a `tool.completed` without one is completed. */
export function extractWorkLogToolLifecycleStatus(
  activity: Pick<OrchestrationThreadActivity, "kind" | "payload">,
): WorkLogToolLifecycleStatus | undefined {
  if (!isLifecycleActivityKind(activity.kind)) return undefined;
  const status = asRecord(activity.payload)?.status;
  switch (status) {
    case "inProgress":
    case "completed":
    case "failed":
    case "declined":
    case "stopped":
      return status;
  }
  return activity.kind === "tool.completed" ? "completed" : undefined;
}

/** A failed or declined tool call; the timeline marks these rows. */
export function isFailedWorkLogToolStatus(status: WorkLogToolLifecycleStatus | undefined): boolean {
  return status === "failed" || status === "declined";
}

function mergeWorkLogToolStatus(
  previous: WorkLogToolLifecycleStatus | undefined,
  next: WorkLogToolLifecycleStatus | undefined,
): WorkLogToolLifecycleStatus | undefined {
  if (!next) return previous;
  // A late progress update must not hide a terminal result.
  if (next === "inProgress" && previous && previous !== "inProgress") return previous;
  return next;
}

function normalizeDiagnosticText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Reconstruct a streaming tool-input preview from the durable activity
 * payload so old threads keep their diff panels after the in-memory live
 * preview is gone (e.g. after a desktop restart). Reads `data.input` —
 * which the adapter populates on every `tool.updated` runtime event — and
 * picks the streaming-eligible field (content / new_string / command).
 */
const TOOL_BRIEF_INPUT_MAX_VALUE_LENGTH = 500;

function extractToolName(payload: Record<string, unknown> | null): string | undefined {
  if (!payload) return undefined;
  const data = payload.data;
  if (!data || typeof data !== "object") return undefined;
  const dataRecord = data as Record<string, unknown>;
  return typeof dataRecord.toolName === "string" && dataRecord.toolName.length > 0
    ? dataRecord.toolName
    : undefined;
}

function extractExpandableToolInput(
  payload: Record<string, unknown> | null,
  itemType: ToolLifecycleItemType | undefined,
): Readonly<Record<string, unknown>> | undefined {
  if (
    itemType !== "mcp_tool_call" &&
    itemType !== "dynamic_tool_call" &&
    itemType !== "collab_agent_tool_call"
  ) {
    return undefined;
  }
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  // Claude reports `input`; Codex nests the call under `item` with its `arguments`.
  const input = asRecord(data?.input) ?? asRecord(item?.arguments);
  if (input) return input;
  // A Codex subagent call has no arguments, only the prompt it was given.
  const prompt = itemType === "collab_agent_tool_call" ? asTrimmedString(item?.prompt) : null;
  return prompt ? { prompt } : undefined;
}

function extractToolResultSummary(payload: Record<string, unknown> | null): string | undefined {
  const data = asRecord(payload?.data);
  for (const result of [data?.result, asRecord(data?.item)?.result]) {
    const summary = asTrimmedString(asRecord(result)?.content);
    if (summary) return summary;
  }
  return undefined;
}

function extractToolBriefInput(
  payload: Record<string, unknown> | null,
): Readonly<Record<string, string | number | boolean>> | undefined {
  if (!payload) return undefined;
  const data = payload.data;
  if (!data || typeof data !== "object") return undefined;
  const input = (data as Record<string, unknown>).input;
  if (!input || typeof input !== "object") return undefined;
  const result: Record<string, string | number | boolean> = {};
  let captured = false;
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value === "string") {
      if (value.length > TOOL_BRIEF_INPUT_MAX_VALUE_LENGTH) continue;
      result[key] = value;
      captured = true;
    } else if (typeof value === "number" || typeof value === "boolean") {
      result[key] = value;
      captured = true;
    }
  }
  return captured ? result : undefined;
}

function buildStaticToolInputStream(
  payload: Record<string, unknown> | null,
): ToolInputStream | undefined {
  if (!payload) return undefined;
  const data = payload.data;
  if (!data || typeof data !== "object") return undefined;
  const dataRecord = data as Record<string, unknown>;
  const toolName = typeof dataRecord.toolName === "string" ? dataRecord.toolName : undefined;
  const input = dataRecord.input;
  if (!toolName || !input || typeof input !== "object") return undefined;
  const inputRecord = input as Record<string, unknown>;

  const filePath =
    typeof inputRecord.file_path === "string"
      ? inputRecord.file_path
      : typeof inputRecord.path === "string"
        ? inputRecord.path
        : undefined;

  let fieldName: string;
  let text: string;
  let oldString: string | undefined;

  if (typeof inputRecord.new_string === "string") {
    fieldName = "new_string";
    text = inputRecord.new_string;
    if (typeof inputRecord.old_string === "string") {
      oldString = inputRecord.old_string;
    }
  } else if (typeof inputRecord.content === "string") {
    fieldName = "content";
    text = inputRecord.content;
  } else if (typeof inputRecord.command === "string") {
    fieldName = "command";
    text = inputRecord.command;
  } else {
    return undefined;
  }

  return {
    toolName,
    fieldName,
    ...(filePath !== undefined ? { filePath } : {}),
    ...(oldString !== undefined ? { oldString } : {}),
    text,
    updatedAt: 0,
  };
}

function isLifecycleActivityKind(kind: OrchestrationThreadActivity["kind"]): boolean {
  return kind === "tool.started" || kind === "tool.updated" || kind === "tool.completed";
}

function shouldCollapseToolLifecycleEntries(
  previous: DerivedWorkLogEntry,
  next: DerivedWorkLogEntry,
): boolean {
  if (!isLifecycleActivityKind(previous.activityKind)) {
    return false;
  }
  if (!isLifecycleActivityKind(next.activityKind)) {
    return false;
  }
  if (previous.activityKind === "tool.completed") {
    return false;
  }
  return previous.collapseKey !== undefined && previous.collapseKey === next.collapseKey;
}

function mergeDerivedWorkLogEntries(
  previous: DerivedWorkLogEntry,
  next: DerivedWorkLogEntry,
): DerivedWorkLogEntry {
  const changedFiles = mergeChangedFiles(previous.changedFiles, next.changedFiles);
  const detail = next.detail ?? previous.detail;
  const command = next.command ?? previous.command;
  const rawCommand = next.rawCommand ?? previous.rawCommand;
  const toolTitle = next.toolTitle ?? previous.toolTitle;
  const itemType = next.itemType ?? previous.itemType;
  const requestKind = next.requestKind ?? previous.requestKind;
  const collapseKey = next.collapseKey ?? previous.collapseKey;
  // Always take providerItemId from next when present — the freshest
  // event in the lifecycle wins.
  const providerItemId = next.providerItemId ?? previous.providerItemId;
  // Static preview only lives on `tool.updated` activities (which are the
  // only ones that carry the `data.input` payload). Prefer the freshest
  // one when present, but fall back to the earlier one so the merged
  // entry doesn't lose the preview when the lifecycle ends with a
  // `tool.completed` (which has no `data`).
  const staticPreview = next.staticPreview ?? previous.staticPreview;
  // Same sticky treatment for the friendly action fields — only
  // `tool.updated` carries `data`, so the trailing `tool.completed`
  // would otherwise wipe them out.
  const toolName = next.toolName ?? previous.toolName;
  const toolBriefInput = next.toolBriefInput ?? previous.toolBriefInput;
  const toolInput = next.toolInput ?? previous.toolInput;
  const toolResultSummary = next.toolResultSummary ?? previous.toolResultSummary;
  const { toolStatus: _previousToolStatus, ...previousRest } = previous;
  const { toolStatus: _nextToolStatus, ...nextRest } = next;
  const toolStatus = mergeWorkLogToolStatus(previous.toolStatus, next.toolStatus);
  return {
    ...previousRest,
    ...nextRest,
    ...(toolStatus ? { toolStatus } : {}),
    ...(detail ? { detail } : {}),
    ...(command ? { command } : {}),
    ...(rawCommand ? { rawCommand } : {}),
    ...(changedFiles.length > 0 ? { changedFiles } : {}),
    ...(toolTitle ? { toolTitle } : {}),
    ...(itemType ? { itemType } : {}),
    ...(requestKind ? { requestKind } : {}),
    ...(collapseKey ? { collapseKey } : {}),
    ...(providerItemId ? { providerItemId } : {}),
    ...(staticPreview ? { staticPreview } : {}),
    ...(toolName ? { toolName } : {}),
    ...(toolBriefInput ? { toolBriefInput } : {}),
    ...(toolInput ? { toolInput } : {}),
    ...(toolResultSummary ? { toolResultSummary } : {}),
  };
}

function mergeChangedFiles(
  previous: ReadonlyArray<string> | undefined,
  next: ReadonlyArray<string> | undefined,
): string[] {
  const merged = [...(previous ?? []), ...(next ?? [])];
  if (merged.length === 0) {
    return [];
  }
  return [...new Set(merged)];
}

function deriveToolLifecycleCollapseKey(entry: DerivedWorkLogEntry): string | undefined {
  if (
    entry.activityKind !== "tool.started" &&
    entry.activityKind !== "tool.updated" &&
    entry.activityKind !== "tool.completed"
  ) {
    return undefined;
  }
  // Prefer the provider's stable item id when available — two distinct
  // tool calls with the same shape (label/detail/itemType) used to merge
  // because the legacy key was content-derived. The id-based key is
  // exact and never collides.
  if (entry.providerItemId) {
    return `pid:${entry.providerItemId}`;
  }
  const normalizedLabel = normalizeCompactToolLabel(entry.toolTitle ?? entry.label);
  const detail = entry.detail?.trim() ?? "";
  const itemType = entry.itemType ?? "";
  if (normalizedLabel.length === 0 && detail.length === 0 && itemType.length === 0) {
    return undefined;
  }
  return [itemType, normalizedLabel, detail].join("\u001f");
}

function normalizeCompactToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}

function toLatestProposedPlanState(proposedPlan: ProposedPlan): LatestProposedPlanState {
  return {
    id: proposedPlan.id,
    createdAt: proposedPlan.createdAt,
    updatedAt: proposedPlan.updatedAt,
    turnId: proposedPlan.turnId,
    planMarkdown: proposedPlan.planMarkdown,
    implementedAt: proposedPlan.implementedAt,
    implementationThreadId: proposedPlan.implementationThreadId,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function trimMatchingOuterQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith("'") && trimmed.endsWith("'")) ||
      (trimmed.startsWith('"') && trimmed.endsWith('"')))
  ) {
    const unquoted = trimmed.slice(1, -1).trim();
    return unquoted.length > 0 ? unquoted : trimmed;
  }
  return trimmed;
}

function executableBasename(value: string): string | null {
  const trimmed = trimMatchingOuterQuotes(value);
  const last = trimmed.replace(/\\/g, "/").split("/").at(-1)?.trim() ?? "";
  return last.length > 0 ? last.toLowerCase() : null;
}

function splitExecutableAndRest(value: string): { executable: string; rest: string } | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    const closeIndex = trimmed.indexOf(trimmed.charAt(0), 1);
    if (closeIndex <= 0) return null;
    return {
      executable: trimmed.slice(0, closeIndex + 1),
      rest: trimmed.slice(closeIndex + 1).trim(),
    };
  }
  const firstWhitespace = trimmed.search(/\s/);
  if (firstWhitespace < 0) return { executable: trimmed, rest: "" };
  return {
    executable: trimmed.slice(0, firstWhitespace),
    rest: trimmed.slice(firstWhitespace).trim(),
  };
}

type ShellWrapperKind = "posix" | "powershell" | "cmd";

const SHELL_WRAPPER_KIND_BY_EXECUTABLE: ReadonlyMap<string, ShellWrapperKind> = new Map([
  ["bash", "posix"],
  ["sh", "posix"],
  ["zsh", "posix"],
  ["pwsh", "powershell"],
  ["pwsh.exe", "powershell"],
  ["powershell", "powershell"],
  ["powershell.exe", "powershell"],
  ["cmd", "cmd"],
  ["cmd.exe", "cmd"],
]);

// The wrapper flag must come before the first non-option argument (`bash run.sh -c x` runs a script).
const SHELL_WRAPPER_PREFIX_PATTERNS: Record<ShellWrapperKind, RegExp> = {
  posix: /^(?:--?[A-Za-z][\w-]*\s+)*?-l?c\s+/,
  powershell: /^(?:-ExecutionPolicy\s+\S+\s+|-[A-Za-z]+\s+)*?-Command\s+/i,
  cmd: /^(?:\/[A-Za-z](?::\S*)?\s+)*?\/c\s+/i,
};

const SHELL_WRAPPER_OPTION_PATTERNS: Record<ShellWrapperKind, RegExp> = {
  posix: /^--?[A-Za-z][\w-]*$/,
  powershell: /^-[A-Za-z]+$/,
  cmd: /^\/[A-Za-z](?::\S*)?$/,
};

const SHELL_WRAPPER_FLAG_PATTERNS: Record<ShellWrapperKind, RegExp> = {
  posix: /^-l?c$/,
  powershell: /^-Command$/i,
  cmd: /^\/c$/i,
};

function shellWrapperKind(executable: string): ShellWrapperKind | null {
  const shell = executableBasename(executable);
  return shell ? (SHELL_WRAPPER_KIND_BY_EXECUTABLE.get(shell) ?? null) : null;
}

/** Dequotes a single POSIX shell word (`'it'"'"'s'` -> `it's`); null when it is not exactly one word. */
function parsePosixShellWord(value: string): string | null {
  let output = "";
  let index = 0;
  while (index < value.length) {
    const char = value.charAt(index);
    if (char === "'") {
      const close = value.indexOf("'", index + 1);
      if (close < 0) return null;
      output += value.slice(index + 1, close);
      index = close + 1;
    } else if (char === '"') {
      index += 1;
      while (index < value.length && value.charAt(index) !== '"') {
        const next = value.charAt(index + 1);
        if (value.charAt(index) === "\\" && '"\\$`'.includes(next) && next !== "") {
          output += next;
          index += 2;
        } else {
          output += value.charAt(index);
          index += 1;
        }
      }
      if (index >= value.length) return null;
      index += 1;
    } else if (char === "\\") {
      if (index + 1 >= value.length) return null;
      output += value.charAt(index + 1);
      index += 2;
    } else if (/\s/.test(char)) {
      return null;
    } else {
      output += char;
      index += 1;
    }
  }
  return output;
}

function unquoteWrappedScript(value: string, kind: ShellWrapperKind): string {
  if (kind === "posix") {
    const word = parsePosixShellWord(value.trim());
    if (word !== null && word.trim().length > 0) return word.trim();
  }
  return trimMatchingOuterQuotes(value);
}

/** `/bin/zsh -lc "rg foo"` -> `rg foo`; anything that is not a known wrapper is returned as is. */
export function unwrapShellCommandWrapper(value: string): string {
  const split = splitExecutableAndRest(value);
  if (!split || split.rest.length === 0) return value;
  const kind = shellWrapperKind(split.executable);
  if (!kind) return value;
  const match = SHELL_WRAPPER_PREFIX_PATTERNS[kind].exec(split.rest);
  if (!match) return value;
  const command = unquoteWrappedScript(split.rest.slice(match[0].length), kind);
  return command.length > 0 ? command : value;
}

/** Argv form: the script is the element after the wrapper flag, used verbatim (no re-quoting). */
function unwrapShellCommandArgv(parts: ReadonlyArray<string>): string | null {
  const [executable, ...args] = parts;
  const kind = executable ? shellWrapperKind(executable) : null;
  if (!kind) return null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (SHELL_WRAPPER_FLAG_PATTERNS[kind].test(arg)) {
      const script = args[index + 1]?.trim();
      return script && script.length > 0 ? script : null;
    }
    if (kind === "powershell" && /^-ExecutionPolicy$/i.test(arg)) {
      index += 1;
      continue;
    }
    if (!SHELL_WRAPPER_OPTION_PATTERNS[kind].test(arg)) return null;
  }
  return null;
}

function formatCommandArrayPart(value: string): string {
  return /[\s"'`]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

function formatCommandValue(value: unknown): { command: string; rawCommand: string | null } | null {
  const direct = asTrimmedString(value);
  if (direct) {
    const command = unwrapShellCommandWrapper(direct);
    return { command, rawCommand: command === direct ? null : direct };
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const parts = value
    .map((entry) => asTrimmedString(entry))
    .filter((entry): entry is string => entry !== null);
  if (parts.length === 0) return null;
  const joined = parts.map(formatCommandArrayPart).join(" ");
  const script = unwrapShellCommandArgv(parts);
  return script ? { command: script, rawCommand: joined } : { command: joined, rawCommand: null };
}

function extractToolCommand(payload: Record<string, unknown> | null): {
  command: string | null;
  rawCommand: string | null;
} {
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  const itemResult = asRecord(item?.result);
  const itemInput = asRecord(item?.input);
  for (const candidate of [item?.command, itemInput?.command, itemResult?.command, data?.command]) {
    const formatted = formatCommandValue(candidate);
    if (formatted) return formatted;
  }
  return { command: null, rawCommand: null };
}

function extractToolTitle(payload: Record<string, unknown> | null): string | null {
  return asTrimmedString(payload?.title);
}

function stripTrailingExitCode(value: string): {
  output: string | null;
  exitCode?: number | undefined;
} {
  const trimmed = value.trim();
  const match = /^(?<output>[\s\S]*?)(?:\s*<exited with exit code (?<code>\d+)>)\s*$/i.exec(
    trimmed,
  );
  if (!match?.groups) {
    return {
      output: trimmed.length > 0 ? trimmed : null,
    };
  }
  const exitCode = Number.parseInt(match.groups.code ?? "", 10);
  const normalizedOutput = match.groups.output?.trim() ?? "";
  return {
    output: normalizedOutput.length > 0 ? normalizedOutput : null,
    ...(Number.isInteger(exitCode) ? { exitCode } : {}),
  };
}

function extractWorkLogItemType(
  payload: Record<string, unknown> | null,
): WorkLogEntry["itemType"] | undefined {
  if (typeof payload?.itemType === "string" && isToolLifecycleItemType(payload.itemType)) {
    return payload.itemType;
  }
  return undefined;
}

function extractWorkLogRequestKind(
  payload: Record<string, unknown> | null,
): WorkLogEntry["requestKind"] | undefined {
  if (
    payload?.requestKind === "command" ||
    payload?.requestKind === "file-read" ||
    payload?.requestKind === "file-change"
  ) {
    return payload.requestKind;
  }
  return requestKindFromRequestType(payload?.requestType) ?? undefined;
}

function pushChangedFile(target: string[], seen: Set<string>, value: unknown) {
  const normalized = asTrimmedString(value);
  if (!normalized || seen.has(normalized)) {
    return;
  }
  seen.add(normalized);
  target.push(normalized);
}

function collectChangedFiles(value: unknown, target: string[], seen: Set<string>, depth: number) {
  if (depth > 4 || target.length >= 12) {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectChangedFiles(entry, target, seen, depth + 1);
      if (target.length >= 12) {
        return;
      }
    }
    return;
  }

  const record = asRecord(value);
  if (!record) {
    return;
  }

  pushChangedFile(target, seen, record.path);
  pushChangedFile(target, seen, record.filePath);
  pushChangedFile(target, seen, record.relativePath);
  pushChangedFile(target, seen, record.filename);
  pushChangedFile(target, seen, record.newPath);
  pushChangedFile(target, seen, record.oldPath);

  for (const nestedKey of [
    "item",
    "result",
    "input",
    "data",
    "changes",
    "files",
    "edits",
    "patch",
    "patches",
    "operations",
  ]) {
    if (!(nestedKey in record)) {
      continue;
    }
    collectChangedFiles(record[nestedKey], target, seen, depth + 1);
    if (target.length >= 12) {
      return;
    }
  }
}

function extractChangedFiles(payload: Record<string, unknown> | null): string[] {
  const changedFiles: string[] = [];
  const seen = new Set<string>();
  collectChangedFiles(asRecord(payload?.data), changedFiles, seen, 0);
  return changedFiles;
}

export function compareActivitiesByOrder(
  left: OrchestrationThreadActivity,
  right: OrchestrationThreadActivity,
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

  const createdAtComparison = left.createdAt.localeCompare(right.createdAt);
  if (createdAtComparison !== 0) {
    return createdAtComparison;
  }

  const lifecycleRankComparison =
    compareActivityLifecycleRank(left.kind) - compareActivityLifecycleRank(right.kind);
  if (lifecycleRankComparison !== 0) {
    return lifecycleRankComparison;
  }

  return left.id.localeCompare(right.id);
}

function compareActivityLifecycleRank(kind: string): number {
  if (kind.endsWith(".started") || kind === "tool.started") {
    return 0;
  }
  if (kind.endsWith(".progress") || kind.endsWith(".updated")) {
    return 1;
  }
  if (kind.endsWith(".completed") || kind.endsWith(".resolved")) {
    return 2;
  }
  return 1;
}

export function hasToolActivityForTurn(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  turnId: TurnId | null | undefined,
): boolean {
  if (!turnId) return false;
  return activities.some((activity) => activity.turnId === turnId && activity.tone === "tool");
}

export function deriveTimelineEntries(
  messages: ChatMessage[],
  proposedPlans: ProposedPlan[],
  workEntries: WorkLogEntry[],
): TimelineEntry[] {
  const messageRows: TimelineEntry[] = messages.map((message) => ({
    id: message.id,
    kind: "message",
    createdAt: message.createdAt,
    message,
  }));
  const proposedPlanRows: TimelineEntry[] = proposedPlans.map((proposedPlan) => ({
    id: proposedPlan.id,
    kind: "proposed-plan",
    createdAt: proposedPlan.createdAt,
    proposedPlan,
  }));
  const workRows: TimelineEntry[] = workEntries.map((entry) => ({
    id: entry.id,
    kind: "work",
    createdAt: entry.createdAt,
    entry,
  }));
  return [...messageRows, ...proposedPlanRows, ...workRows].toSorted((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
}

export function deriveCompletionDividerBeforeEntryId(
  timelineEntries: ReadonlyArray<TimelineEntry>,
  latestTurn: Pick<
    OrchestrationLatestTurn,
    "assistantMessageId" | "startedAt" | "completedAt"
  > | null,
): string | null {
  if (!latestTurn?.startedAt || !latestTurn.completedAt) {
    return null;
  }

  if (latestTurn.assistantMessageId) {
    const exactMatch = timelineEntries.find(
      (timelineEntry) =>
        timelineEntry.kind === "message" &&
        timelineEntry.message.role === "assistant" &&
        timelineEntry.message.id === latestTurn.assistantMessageId,
    );
    if (exactMatch) {
      return exactMatch.id;
    }
  }

  const turnStartedAt = Date.parse(latestTurn.startedAt);
  const turnCompletedAt = Date.parse(latestTurn.completedAt);
  if (Number.isNaN(turnStartedAt) || Number.isNaN(turnCompletedAt)) {
    return null;
  }

  let inRangeMatch: string | null = null;
  let fallbackMatch: string | null = null;
  for (const timelineEntry of timelineEntries) {
    if (timelineEntry.kind !== "message" || timelineEntry.message.role !== "assistant") {
      continue;
    }
    const messageAt = Date.parse(timelineEntry.message.createdAt);
    if (Number.isNaN(messageAt) || messageAt < turnStartedAt) {
      continue;
    }
    fallbackMatch = timelineEntry.id;
    if (messageAt <= turnCompletedAt) {
      inRangeMatch = timelineEntry.id;
    }
  }
  return inRangeMatch ?? fallbackMatch;
}

export function inferCheckpointTurnCountByTurnId(
  summaries: TurnDiffSummary[],
): Record<TurnId, number> {
  const sorted = [...summaries].toSorted((a, b) => a.completedAt.localeCompare(b.completedAt));
  const result: Record<TurnId, number> = {};
  for (let index = 0; index < sorted.length; index += 1) {
    const summary = sorted[index];
    if (!summary) continue;
    result[summary.turnId] = index + 1;
  }
  return result;
}

export function derivePhase(session: ThreadSession | null): SessionPhase {
  if (!session || session.status === "closed") return "disconnected";
  if (session.status === "connecting") return "connecting";
  if (session.status === "running") return "running";
  return "ready";
}
