import { sliceSurrogateSafe } from "@piedpiper/shared/String";

import { type WorkLogEntry } from "../../session-logic";

/** What a tool does, for counting it in a one-line group summary. */
export type ToolAction = "read" | "edit" | "command" | "code-search" | "web-search" | "other";

function isReadToolName(tool: string): boolean {
  return tool === "read" || tool.includes("read_file") || tool === "view";
}

function isWriteToolName(tool: string): boolean {
  return tool === "write" || tool === "create_file" || tool === "createfile";
}

function isEditToolName(tool: string): boolean {
  return (
    tool === "edit" ||
    tool === "multiedit" ||
    tool === "str_replace" ||
    tool === "str_replace_editor" ||
    tool.includes("replace") ||
    tool.includes("patch")
  );
}

function isCommandToolName(tool: string): boolean {
  return (
    tool === "bash" || tool === "shell" || tool.includes("command") || tool.includes("terminal")
  );
}

function isGrepToolName(tool: string): boolean {
  return tool === "grep" || tool.includes("search_files");
}

function isWebSearchToolName(tool: string): boolean {
  return tool === "websearch" || tool === "web_search";
}

function isNotebookEditToolName(tool: string): boolean {
  return tool === "notebookedit" || tool === "notebook_edit";
}

/** TodoWrite maintains the plan and edits no file; older stored activities record it as a file change. */
export function isTodoToolName(toolName: string): boolean {
  return toolName.toLowerCase().includes("todo");
}

/** Classifies a raw provider tool name by the same rules as the friendly labels. */
export function classifyToolName(toolName: string): ToolAction {
  const tool = toolName.toLowerCase();
  // MCP tools come first so names like mcp__shell__run_command are not matched as built-ins.
  if (tool.startsWith("mcp__") || isTodoToolName(tool)) return "other";
  if (isReadToolName(tool)) return "read";
  if (isWriteToolName(tool) || isEditToolName(tool) || isNotebookEditToolName(tool)) return "edit";
  if (isCommandToolName(tool)) return "command";
  if (tool === "glob" || isGrepToolName(tool)) return "code-search";
  if (isWebSearchToolName(tool)) return "web-search";
  return "other";
}

/** The file a tool call names in its brief input, if any. */
export function toolBriefFilePath(
  briefInput: Readonly<Record<string, string | number | boolean>> | undefined,
): string | undefined {
  for (const key of ["file_path", "path", "notebook_path"]) {
    const value = briefInput?.[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

/**
 * Build a human-friendly action label for a work-log entry. Uses
 * `toolName` + `toolBriefInput` to render verbs like "Reading <path>",
 * "Searching for <pattern>", etc. Returns `null` when there isn't enough
 * data and the caller should fall back to the legacy heading rendering.
 */
export function buildFriendlyToolText(input: {
  workEntry: WorkLogEntry;
  workspaceRoot: string | undefined;
}): string | null {
  const { workEntry, workspaceRoot } = input;
  const isInProgress = workEntry.inProgress === true;
  const toolNameRaw = workEntry.toolName;
  if (!toolNameRaw) return null;
  const tool = toolNameRaw.toLowerCase();
  const briefInput = workEntry.toolBriefInput ?? {};
  const stringField = (key: string): string | undefined =>
    typeof briefInput[key] === "string" ? (briefInput[key] as string) : undefined;
  const filePath = toolBriefFilePath(briefInput);
  const displayPath = filePath ? makeDisplayPath(filePath, workspaceRoot) : undefined;

  // MCP tools come first so names like mcp__shell__run_command are not matched as built-ins.
  if (tool.startsWith("mcp__")) {
    const parts = toolNameRaw.split("__");
    const rawServer = parts[1] ?? "";
    // Matches the server's parseClaudeMcpToolName: a bare "claude_ai_" keeps its name.
    const server = rawServer.replace(/^claude_ai_/, "") || rawServer;
    const method = parts.slice(2).join("__");
    const label = method ? `${server}: ${method}` : server;
    return isInProgress ? `Running ${label}` : `Ran ${label}`;
  }

  if (isReadToolName(tool)) {
    return verbWithPath(isInProgress ? "Reading" : "Read", displayPath, "file");
  }
  if (isWriteToolName(tool)) {
    return verbWithPath(isInProgress ? "Creating" : "Created", displayPath, "file");
  }
  if (isEditToolName(tool)) {
    return verbWithPath(isInProgress ? "Editing" : "Edited", displayPath, "file");
  }
  if (isCommandToolName(tool)) {
    const command = stringField("command");
    if (command) {
      const oneLine = command.split("\n")[0]?.trim() ?? command;
      const trimmed = oneLine.length > 80 ? `${sliceSurrogateSafe(oneLine, 80)}…` : oneLine;
      return `${isInProgress ? "Running" : "Ran"} \`${trimmed}\``;
    }
    return isInProgress ? "Running command" : "Ran command";
  }
  if (tool === "glob") {
    const pattern = stringField("pattern");
    return pattern
      ? `${isInProgress ? "Searching for" : "Searched for"} ${pattern}`
      : isInProgress
        ? "Searching files"
        : "Searched files";
  }
  if (isGrepToolName(tool)) {
    const pattern = stringField("pattern") ?? stringField("query");
    return pattern
      ? `${isInProgress ? "Searching for" : "Searched for"} "${pattern}"`
      : isInProgress
        ? "Searching content"
        : "Searched content";
  }
  if (isWebSearchToolName(tool)) {
    const query = stringField("query");
    return query
      ? `${isInProgress ? "Searching the web for" : "Searched the web for"} "${query}"`
      : isInProgress
        ? "Searching the web"
        : "Searched the web";
  }
  if (tool === "webfetch" || tool === "web_fetch" || tool === "fetch") {
    const url = stringField("url");
    return url
      ? `${isInProgress ? "Fetching" : "Fetched"} ${url}`
      : isInProgress
        ? "Fetching URL"
        : "Fetched URL";
  }
  if (tool === "todowrite" || tool.includes("todo")) {
    return isInProgress ? "Updating todos" : "Updated todos";
  }
  if (tool === "task" || tool.includes("subagent") || tool.includes("agent")) {
    const description = stringField("description") ?? stringField("prompt");
    if (description) {
      const oneLine = description.split("\n")[0]?.trim() ?? description;
      const trimmed = oneLine.length > 80 ? `${sliceSurrogateSafe(oneLine, 80)}…` : oneLine;
      return `${isInProgress ? "Running subagent:" : "Subagent:"} ${trimmed}`;
    }
    return isInProgress ? "Running subagent" : "Subagent finished";
  }
  if (tool === "toolsearch") {
    const query = stringField("query");
    return query
      ? `${isInProgress ? "Looking up tool:" : "Found tool:"} ${query}`
      : isInProgress
        ? "Looking up tools"
        : "Looked up tools";
  }
  if (isNotebookEditToolName(tool)) {
    return verbWithPath(isInProgress ? "Editing notebook" : "Edited notebook", displayPath, "cell");
  }
  if (tool === "skill") {
    const skillName = stringField("skill") ?? stringField("name");
    return skillName
      ? `${isInProgress ? "Running skill:" : "Ran skill:"} ${skillName}`
      : isInProgress
        ? "Running skill"
        : "Ran skill";
  }
  if (tool === "enterplanmode" || tool === "exitplanmode") {
    return tool === "enterplanmode"
      ? isInProgress
        ? "Entering plan mode"
        : "Entered plan mode"
      : isInProgress
        ? "Exiting plan mode"
        : "Exited plan mode";
  }
  if (tool === "askuserquestion") {
    return isInProgress ? "Asking a question" : "Asked a question";
  }
  if (tool === "monitor") {
    return isInProgress ? "Monitoring process" : "Monitored process";
  }
  if (tool === "croncreate" || tool === "crondelete" || tool === "cronlist") {
    return tool === "cronlist"
      ? isInProgress
        ? "Listing schedules"
        : "Listed schedules"
      : tool === "croncreate"
        ? isInProgress
          ? "Creating schedule"
          : "Created schedule"
        : isInProgress
          ? "Deleting schedule"
          : "Deleted schedule";
  }
  // Generic fallback — capitalize the tool name as a verb-ish label.
  const capitalized = `${toolNameRaw.charAt(0).toUpperCase()}${toolNameRaw.slice(1)}`;
  return displayPath ? `${capitalized} ${displayPath}` : capitalized;
}

function verbWithPath(verb: string, displayPath: string | undefined, fallback: string): string {
  return displayPath ? `${verb} ${displayPath}` : `${verb} ${fallback}…`;
}

/**
 * Render a file path relative to the active workspace root. Files inside
 * the workspace get a leading-slash style (e.g. `/src/foo.ts`); files
 * outside fall back to their basename so we don't leak full system paths
 * into the UI.
 */
export function makeDisplayPath(filePath: string, workspaceRoot: string | undefined): string {
  if (workspaceRoot && workspaceRoot.length > 0) {
    const normalizedRoot = workspaceRoot.endsWith("/") ? workspaceRoot : `${workspaceRoot}/`;
    if (filePath === workspaceRoot) {
      return "/";
    }
    if (filePath.startsWith(normalizedRoot)) {
      return `/${filePath.slice(normalizedRoot.length)}`;
    }
  }
  const segments = filePath.split("/").filter((segment) => segment.length > 0);
  return segments.length > 0 ? (segments[segments.length - 1] ?? filePath) : filePath;
}
