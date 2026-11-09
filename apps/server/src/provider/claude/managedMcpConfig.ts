/** Where an administrator's Claude Code configuration lives on each platform. */
export function claudeManagedConfigDir(platform: NodeJS.Platform): string {
  return platform === "darwin"
    ? "/Library/Application Support/ClaudeCode"
    : platform === "win32"
      ? "C:\\Program Files\\ClaudeCode"
      : "/etc/claude-code";
}

/** Where Claude Code looks for an administrator's `managed-mcp.json` on each platform. */
export function claudeManagedMcpConfigPath(platform: NodeJS.Platform): string {
  return `${claudeManagedConfigDir(platform)}${platform === "win32" ? "\\" : "/"}managed-mcp.json`;
}

/**
 * MCP isolation flags for noninteractive Claude runs. Claude refuses `--strict-mcp-config` next to a
 * managed-mcp.json, which already keeps user and project MCP servers out on its own.
 */
export function claudeMcpIsolationArgs(managedMcpConfig: boolean): ReadonlyArray<string> {
  return managedMcpConfig ? [] : ["--strict-mcp-config"];
}
