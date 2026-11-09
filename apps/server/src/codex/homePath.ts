import * as OS from "node:os";
import * as NodePath from "node:path";

/** Expands a leading `~` so CODEX_HOME is never handed to codex as a workspace-relative path. */
export function expandCodexHomePath(input: string, homeDir: string = OS.homedir()): string {
  const trimmed = input.trim();
  if (trimmed === "~") {
    return homeDir;
  }
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return NodePath.join(homeDir, trimmed.slice(2));
  }
  return trimmed;
}

/** Env entries to spread into a codex child process for an optional configured home path. */
export function codexHomeEnv(homePath: string | undefined): { CODEX_HOME?: string } {
  const expanded = homePath ? expandCodexHomePath(homePath) : "";
  return expanded ? { CODEX_HOME: expanded } : {};
}
