import {
  type CommandId,
  EventId,
  type OrchestrationCommand,
  type ThreadId,
} from "@piedpiper/contracts";

// An opening fence may sit at any indentation, since fences inside list
// items are indented past the marker. A closing fence may be indented at most
// three spaces more than its opener. Deeper lines are content in the block.
const MARKDOWN_FENCE_PATTERN = /^( *)(`{3,}|~{3,})/;
// CommonMark blank lines hold only spaces and tabs. Other whitespace, such as
// a no-break space, is paragraph content.
const BLANK_LINE_PATTERN = /^[ \t]*$/;
// A bullet or ordered marker followed by whitespace, at any indentation so
// nested items count. The trailing space is required, so a partial `-` or
// `1.` never matches before the model finishes the marker.
const LIST_ITEM_START_PATTERN = /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]/;
// A section title: an ATX heading, or a line of only bold text, which models
// often use as a heading.
const SECTION_TITLE_PATTERN = /^ {0,3}(?:#{1,6}(?:[ \t]|$)|\*\*(?:[^*]|\*(?!\*))+\*\*:?$)/;
// An unindented ATX heading ends the paragraph or list above it, even with no
// blank line between them. A bold line would continue the paragraph instead.
const TOP_LEVEL_HEADING_PATTERN = /^#{1,6}(?:[ \t]|$)/;

/**
 * Splits buffered assistant text at the last blank line, closing code fence,
 * or list item start that is not inside an open fenced code block. `ready` is
 * safe to deliver now because the markdown before it will not change shape as
 * more text arrives. `rest` stays buffered until the next boundary or
 * completion. Only fully terminated lines count, so a trailing partial line
 * never leaks; a list item start is the one lookahead that may sit on the
 * partial line, since tight lists have no blank lines between items and would
 * otherwise land all at once.
 *
 * A section title holds the boundary until a content line follows it, so a
 * title never lands alone and waits above a block that is still streaming.
 */
export function splitBufferedAssistantText(text: string): { ready: string; rest: string } {
  let openFence: { marker: string; indent: number } | null = null;
  let boundary = -1;
  let lineStart = 0;
  let titleAwaitingContent = false;
  for (;;) {
    const newline = text.indexOf("\n", lineStart);
    const line = text
      .slice(lineStart, newline === -1 ? text.length : newline)
      .replace(/[ \t\r]+$/, "");
    if (
      openFence === null &&
      lineStart > 0 &&
      !titleAwaitingContent &&
      LIST_ITEM_START_PATTERN.test(line)
    ) {
      boundary = lineStart;
    }
    if (newline === -1) {
      break;
    }
    const fenceMatch = MARKDOWN_FENCE_PATTERN.exec(line);
    if (fenceMatch) {
      const indent = fenceMatch[1]!.length;
      const marker = fenceMatch[2]!;
      if (openFence === null) {
        openFence = { marker, indent };
        titleAwaitingContent = false;
      } else if (
        marker[0] === openFence.marker[0] &&
        marker.length >= openFence.marker.length &&
        indent <= openFence.indent + 3 &&
        line.length === indent + marker.length
      ) {
        // CommonMark: a closing fence carries no info string.
        openFence = null;
        boundary = newline + 1;
      }
    } else if (openFence === null && BLANK_LINE_PATTERN.test(line) && lineStart > 0) {
      if (!titleAwaitingContent) {
        boundary = newline + 1;
      }
    } else if (openFence === null) {
      if (lineStart > 0 && !titleAwaitingContent && TOP_LEVEL_HEADING_PATTERN.test(line)) {
        boundary = lineStart;
      }
      titleAwaitingContent = SECTION_TITLE_PATTERN.test(line);
    }
    lineStart = newline + 1;
  }
  if (boundary === -1) {
    return { ready: "", rest: text };
  }
  return { ready: text.slice(0, boundary), rest: text.slice(boundary) };
}

/** Within one timestamp, a start comes before its completion, wherever the rows sit. */
const TASK_LIFECYCLE_ORDER: Readonly<Record<string, number>> = {
  "task.started": 0,
  "task.completed": 1,
};

/**
 * Ids of tasks with a `task.started` and no `task.completed`. Activities can sort out of emit
 * order within one timestamp, so a completion closes its task wherever it sits.
 */
export function openTaskIdsInActivities(
  activities: ReadonlyArray<{
    readonly kind: string;
    readonly payload?: unknown;
    readonly createdAt?: string;
  }>,
): ReadonlyArray<string> {
  const lifecycle = activities
    .filter((activity) => activity.kind === "task.started" || activity.kind === "task.completed")
    .map((activity, index) => ({ activity, index }))
    .toSorted(
      (left, right) =>
        (left.activity.createdAt ?? "").localeCompare(right.activity.createdAt ?? "") ||
        TASK_LIFECYCLE_ORDER[left.activity.kind]! - TASK_LIFECYCLE_ORDER[right.activity.kind]! ||
        left.index - right.index,
    );
  // A fold, not a set difference: Claude can restart a settled task id.
  const open = new Set<string>();
  for (const { activity } of lifecycle) {
    const taskId = (activity.payload as { readonly taskId?: unknown } | null | undefined)?.taskId;
    if (typeof taskId !== "string") continue;
    if (activity.kind === "task.started") open.add(taskId);
    else open.delete(taskId);
  }
  return [...open];
}

/** Commands closing every task left open, for when the Claude process that ran them is gone. */
export function settleOpenTasksCommands(input: {
  readonly threadId: ThreadId;
  readonly activities: ReadonlyArray<{
    readonly kind: string;
    readonly payload?: unknown;
    readonly createdAt?: string;
  }>;
  readonly createdAt: string;
  readonly commandId: () => CommandId;
}): ReadonlyArray<Extract<OrchestrationCommand, { type: "thread.activity.append" }>> {
  return openTaskIdsInActivities(input.activities).map((taskId) => ({
    type: "thread.activity.append",
    commandId: input.commandId(),
    threadId: input.threadId,
    activity: {
      id: EventId.makeUnsafe(crypto.randomUUID()),
      createdAt: input.createdAt,
      tone: "info",
      kind: "task.completed",
      summary: "Task stopped",
      payload: { taskId, status: "stopped" },
      // No turn, so this survives a later revert of the turn it closes in.
      turnId: null,
    },
    createdAt: input.createdAt,
  }));
}
