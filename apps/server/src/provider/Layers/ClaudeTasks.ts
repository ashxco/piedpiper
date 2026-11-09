import * as Path from "node:path";
import type { RuntimePlanStep } from "@piedpiper/contracts";
import { Effect, type FileSystem } from "effect";

export interface ClaudeTaskEntry {
  readonly subject: string;
  readonly status: RuntimePlanStep["status"];
}

const CLAUDE_TASK_TOOL_NAMES: ReadonlySet<string> = new Set([
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
]);

export function isClaudeTaskTool(toolName: string): boolean {
  return CLAUDE_TASK_TOOL_NAMES.has(toolName);
}

function claudeTaskField(value: unknown, key: string): unknown {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function claudeTaskString(value: unknown, key: string): string | undefined {
  const field = claudeTaskField(value, key);
  if (typeof field === "number" && Number.isFinite(field)) return String(field);
  return typeof field === "string" && field.trim().length > 0 ? field.trim() : undefined;
}

function claudeTaskStatus(value: unknown): RuntimePlanStep["status"] | undefined {
  switch (value) {
    case "pending":
      return "pending";
    case "in_progress":
      return "inProgress";
    case "completed":
      return "completed";
    default:
      return undefined;
  }
}

/**
 * Applies a successful TaskCreate/TaskUpdate/TaskList call to a session's task map in place.
 * `result` is the structured `tool_use_result`, or the text result subagents get
 * ("Task #3 created successfully: <subject>", "Updated task #3 ..."). TaskList replaces the map,
 * a `deleted` status removes the task. Returns whether the map changed.
 */
export function applyClaudeTaskToolResult(
  tasks: Map<string, ClaudeTaskEntry>,
  toolName: string,
  input: unknown,
  result: unknown,
): boolean {
  if (toolName === "TaskList") {
    const listed = claudeTaskField(result, "tasks");
    if (!Array.isArray(listed)) return false;
    const next = new Map<string, ClaudeTaskEntry>();
    for (const task of listed) {
      const id = claudeTaskString(task, "id");
      const subject = claudeTaskString(task, "subject");
      const status = claudeTaskStatus(claudeTaskField(task, "status"));
      if (id !== undefined && subject !== undefined && status !== undefined) {
        next.set(id, { subject, status });
      }
    }
    if (next.size === 0 && tasks.size === 0) return false;
    tasks.clear();
    for (const [id, task] of next) tasks.set(id, task);
    return true;
  }
  if (toolName === "TaskCreate") {
    const created = claudeTaskField(result, "task");
    const fromText =
      typeof result === "string"
        ? /^Task #(\S+) created successfully: (.+)$/s.exec(result.trim())
        : null;
    const id = claudeTaskString(created, "id") ?? fromText?.[1];
    const subject =
      claudeTaskString(created, "subject") ??
      fromText?.[2]?.trim() ??
      claudeTaskString(input, "subject");
    if (id === undefined || subject === undefined) return false;
    tasks.set(id, { subject, status: "pending" });
    return true;
  }
  if (
    toolName !== "TaskUpdate" ||
    claudeTaskField(result, "success") === false ||
    (typeof result === "string" && !result.trim().startsWith("Updated task #"))
  ) {
    return false;
  }
  const id = claudeTaskString(input, "taskId") ?? claudeTaskString(result, "taskId");
  const task = id === undefined ? undefined : tasks.get(id);
  if (id === undefined || task === undefined) return false;
  const nativeStatus = claudeTaskField(input, "status");
  if (nativeStatus === "deleted") {
    tasks.delete(id);
    return true;
  }
  const subject = claudeTaskString(input, "subject") ?? task.subject;
  const status = claudeTaskStatus(nativeStatus) ?? task.status;
  if (subject === task.subject && status === task.status) return false;
  tasks.set(id, { subject, status });
  return true;
}

/** Claude's on-disk task list directory for a session (`<config>/tasks/<list id>`). */
export function claudeTaskStoreDirectory(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homeDir: string;
  readonly cwd: string | undefined;
  readonly sessionId: string;
}): string {
  const configDirOverride = input.env.CLAUDE_CONFIG_DIR?.trim();
  const configDir = configDirOverride
    ? Path.resolve(input.cwd ?? ".", configDirOverride)
    : Path.join(input.homeDir, ".claude");
  const listId = input.env.CLAUDE_CODE_TASK_LIST_ID?.trim() || input.sessionId;
  return Path.join(configDir, "tasks", listId.replace(/[^a-zA-Z0-9_-]/g, "-"));
}

/** One `<n>.json` file of Claude's task store, or undefined for internal or malformed tasks. */
export function parseClaudeTaskStoreFile(
  contents: string,
): (ClaudeTaskEntry & { readonly id: string }) | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return undefined;
  }
  const id = claudeTaskString(parsed, "id");
  const subject = claudeTaskString(parsed, "subject");
  const status = claudeTaskStatus(claudeTaskField(parsed, "status"));
  const metadata = claudeTaskField(parsed, "metadata");
  if (id === undefined || subject === undefined || status === undefined) return undefined;
  if (claudeTaskField(metadata, "_internal")) return undefined;
  return { id, subject, status };
}

/** Reads Claude's persisted task list in id order; undefined when the store is missing or unreadable. */
export const readClaudeTaskStore = Effect.fn("readClaudeTaskStore")(
  function* (fileSystem: FileSystem.FileSystem, directory: string) {
    const names = (yield* fileSystem.readDirectory(directory))
      .filter((name) => /^\d+\.json$/.test(name))
      .toSorted((left, right) => Number.parseInt(left, 10) - Number.parseInt(right, 10));
    const tasks = new Map<string, ClaudeTaskEntry>();
    for (const name of names) {
      const contents = yield* fileSystem
        .readFileString(Path.join(directory, name))
        .pipe(Effect.orElseSucceed(() => ""));
      const task = parseClaudeTaskStoreFile(contents);
      if (task) tasks.set(task.id, { subject: task.subject, status: task.status });
    }
    return tasks;
  },
  Effect.orElseSucceed((): Map<string, ClaudeTaskEntry> | undefined => undefined),
);

export function planStepsFromClaudeTasks(
  tasks: ReadonlyMap<string, ClaudeTaskEntry>,
): RuntimePlanStep[] {
  return Array.from(tasks.values(), (task) => ({ step: task.subject, status: task.status }));
}
