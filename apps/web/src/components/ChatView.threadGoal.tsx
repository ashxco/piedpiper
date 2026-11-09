import {
  type OrchestrationThreadActivity,
  type ProviderGoal,
  type ProviderGoalStatus,
  THREAD_GOAL_ACTIVITY_KIND,
  ThreadGoalActivityPayload,
} from "@piedpiper/contracts";
import { Schema } from "effect";
import { TargetIcon } from "lucide-react";

import { formatContextWindowTokens } from "../lib/contextWindow";
import { formatDuration } from "../session-logic";
import { Alert, AlertAction, AlertDescription } from "./ui/alert";
import { Button } from "./ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

const decodeGoalPayload = Schema.decodeUnknownOption(ThreadGoalActivityPayload);

/** The goal from the latest report; a cleared goal reports null. */
export function deriveThreadGoal(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ProviderGoal | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (activity?.kind !== THREAD_GOAL_ACTIVITY_KIND) continue;
    const payload = decodeGoalPayload(activity.payload);
    if (payload._tag === "Some") return payload.value.goal;
  }
  return null;
}

const GOAL_STATUS_LABELS: Record<ProviderGoalStatus, string> = {
  active: "Active",
  paused: "Paused",
  blocked: "Blocked",
  usage_limited: "Usage limited",
  budget_limited: "Budget limited",
  complete: "Complete",
};

function goalTokenUsage(goal: ProviderGoal): string | null {
  const used = goal.tokensUsed ?? 0;
  if (typeof goal.tokenBudget === "number") {
    return `${formatContextWindowTokens(used)} / ${formatContextWindowTokens(goal.tokenBudget)} tokens`;
  }
  return used > 0 ? `${formatContextWindowTokens(used)} tokens` : null;
}

/** Status, check count, usage and last check as one line of row details. */
export function threadGoalDetails(goal: ProviderGoal): string {
  const parts = [GOAL_STATUS_LABELS[goal.status]];
  if (goal.checks !== undefined) {
    parts.push(`${goal.checks} ${goal.checks === 1 ? "check" : "checks"}`);
  }
  const tokenUsage = goalTokenUsage(goal);
  if (tokenUsage) parts.push(tokenUsage);
  if (goal.timeUsedSeconds !== undefined && goal.timeUsedSeconds > 0) {
    parts.push(formatDuration(goal.timeUsedSeconds * 1_000));
  }
  const lastCheck = goal.lastCheck?.trim();
  if (lastCheck) parts.push(lastCheck);
  return parts.join(" · ");
}

export function ThreadGoalRow(props: {
  goal: ProviderGoal;
  clearDisabled: boolean;
  onClear: () => void;
}) {
  const { goal, clearDisabled, onClear } = props;
  return (
    <div className="mx-auto w-full max-w-(--chat-composer-max-width) pb-2">
      <Alert variant="info" className="py-2">
        <TargetIcon />
        <AlertDescription className="min-w-0 flex-row items-baseline gap-1.5 text-xs">
          <Tooltip>
            <TooltipTrigger
              render={<span className="min-w-0 truncate font-medium text-foreground" />}
            >
              {goal.objective}
            </TooltipTrigger>
            <TooltipPopup className="max-w-96 whitespace-pre-wrap">{goal.objective}</TooltipPopup>
          </Tooltip>
          <span className="max-w-1/2 shrink-0 truncate">{threadGoalDetails(goal)}</span>
        </AlertDescription>
        <AlertAction className="items-center">
          <Button size="xs" variant="ghost" disabled={clearDisabled} onClick={onClear}>
            Clear
          </Button>
        </AlertAction>
      </Alert>
    </div>
  );
}
