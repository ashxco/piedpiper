/**
 * Mirrors a Claude `/goal` from the SDK transcript. Claude reports it only as synthetic command
 * output and Stop hook feedback, unversioned CLI text, so each parser ignores what it cannot read.
 */
import { type SDKMessage, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { ProviderGoal } from "@piedpiper/contracts";
import { Schema } from "effect";

const GOAL_SET_PREFIX = "Goal set: ";
const GOAL_CLEARED_PREFIX = "Goal cleared: ";
const GOAL_ACTIVE_PREFIX = "Goal active: ";
const GOAL_ACTIVE =
  /^Goal active: ([\s\S]+?) \((?:not yet evaluated|(\d+) turns?)\)(?:\nLast check: ([\s\S]+))?$/u;
const GOAL_ACTIVE_STATE = /^\((?:not yet evaluated|(\d+) turns?)\)(?:\nLast check: ([\s\S]+))?$/u;
const GOAL_NOT_SET_REPLY = "No goal set";

const SYNTHETIC_MODEL = "<synthetic>";

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .flatMap((part: { readonly type?: unknown; readonly text?: unknown }) =>
            part?.type === "text" && typeof part.text === "string" ? [part.text] : [],
          )
          .join("")
      : "";

/** Text of a root synthetic reply, the form the CLI prints local command output in. */
function rootSyntheticReplyText(message: SDKMessage): string | undefined {
  if (
    message.type !== "assistant" ||
    message.parent_tool_use_id !== null ||
    message.message?.model !== SYNTHETIC_MODEL
  ) {
    return undefined;
  }
  return textOf(message.message?.content).trim();
}

/** Reads a `/goal` status reply; the objective can itself look like a status, so a known one goes first. */
function parseClaudeGoalActive(
  reply: string,
  current: ProviderGoal | null,
): { objective: string; checks: string | undefined; lastCheck: string | undefined } | undefined {
  if (current) {
    const prefix = `${GOAL_ACTIVE_PREFIX}${current.objective} `;
    const known = reply.startsWith(prefix)
      ? GOAL_ACTIVE_STATE.exec(reply.slice(prefix.length))
      : null;
    if (known) return { objective: current.objective, checks: known[1], lastCheck: known[2] };
  }
  const active = GOAL_ACTIVE.exec(reply);
  return active?.[1] === undefined
    ? undefined
    : { objective: active[1], checks: active[2], lastCheck: active[3] };
}

/** The goal after one SDK frame, or undefined when the frame says nothing about it. */
export function nextClaudeGoal(
  current: ProviderGoal | null,
  message: SDKMessage,
): ProviderGoal | null | undefined {
  const reply = rootSyntheticReplyText(message);
  if (reply !== undefined) {
    if (reply.startsWith(GOAL_SET_PREFIX)) {
      const objective = reply.slice(GOAL_SET_PREFIX.length).trim();
      return objective.length === 0 ? undefined : { objective, status: "active", checks: 0 };
    }
    if (reply.startsWith(GOAL_CLEARED_PREFIX) || reply.startsWith(GOAL_NOT_SET_REPLY)) return null;
    const active = parseClaudeGoalActive(reply, current);
    if (active === undefined) return undefined;
    return {
      ...(current?.objective === active.objective ? current : {}),
      objective: active.objective,
      status: "active",
      checks: Number(active.checks ?? 0),
      ...(active.lastCheck === undefined ? {} : { lastCheck: active.lastCheck.trim() }),
    };
  }
  // The CLI drops a goal on an error it cannot retry and says so only in this warning.
  if (
    message.type === "system" &&
    message.subtype === "informational" &&
    message.content?.startsWith("Goal cleared after ")
  ) {
    return null;
  }
  if (
    message.type !== "user" ||
    message.parent_tool_use_id !== null ||
    message.isSynthetic !== true ||
    current === null
  ) {
    return undefined;
  }
  // Each unmet evaluator check comes back as feedback naming the objective.
  const prefix = `Stop hook feedback:\n[${current.objective}]: `;
  const text = textOf(message.message?.content);
  if (!text.startsWith(prefix)) return undefined;
  return {
    ...current,
    status: "active",
    checks: (current.checks ?? 0) + 1,
    lastCheck: text.slice(prefix.length).trim(),
  };
}

/** The CLI confirms a goal change as a synthetic reply; the goal row shows that change instead. */
export function isClaudeGoalAcknowledgement(message: SDKMessage): boolean {
  const reply = rootSyntheticReplyText(message);
  // Clearing a goal the check already removed answers exactly this; the usage hint stays visible.
  return (
    reply !== undefined &&
    (reply.startsWith(GOAL_SET_PREFIX) ||
      reply.startsWith(GOAL_CLEARED_PREFIX) ||
      reply === GOAL_NOT_SET_REPLY)
  );
}

/** Real model output on the main thread; a turn without it never reached the goal's Stop check. */
export function isClaudeGoalModelOutput(message: SDKMessage): boolean {
  return (
    message.type === "assistant" &&
    message.parent_tool_use_id === null &&
    message.message?.model !== SYNTHETIC_MODEL
  );
}

/**
 * Whether a finished turn means the goal passed. Completion has no frame of its own: with a goal
 * set Claude ends a turn by itself only after the Stop check passes, and it defers that check while
 * background work runs. SDK mode reports neither an evaluator timeout nor an "impossible" verdict,
 * and both end the turn the same way, so those read as complete.
 */
export function claudeGoalMetByTurn(input: {
  readonly goal: ProviderGoal | null;
  readonly sawModelOutput: boolean;
  readonly turnCompleted: boolean;
  readonly result: SDKResultMessage | undefined;
  readonly liveBackgroundWork: number;
}): boolean {
  const { goal, result } = input;
  return (
    goal?.status === "active" &&
    input.sawModelOutput &&
    input.turnCompleted &&
    result !== undefined &&
    (result.terminal_reason === undefined || result.terminal_reason === "completed") &&
    input.liveBackgroundWork === 0
  );
}

const providerGoalsEqual = Schema.toEquivalence(Schema.NullOr(ProviderGoal));

export const claudeGoalsEqual = (a: ProviderGoal | null, b: ProviderGoal | null): boolean =>
  providerGoalsEqual(a, b);

const decodeProviderGoal = Schema.decodeUnknownOption(ProviderGoal);

/** Reads the goal a resume cursor kept across a session restart. */
export function readClaudeGoal(value: unknown): ProviderGoal | undefined {
  const goal = decodeProviderGoal(value);
  return goal._tag === "Some" ? goal.value : undefined;
}
