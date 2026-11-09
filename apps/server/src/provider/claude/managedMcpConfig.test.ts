import { describe, expect, it } from "vitest";

import { claudeManagedMcpConfigPath, claudeMcpIsolationArgs } from "./managedMcpConfig.ts";

describe("claudeManagedMcpConfigPath", () => {
  it("uses Claude Code's per-platform managed-mcp.json location", () => {
    expect(claudeManagedMcpConfigPath("darwin")).toBe(
      "/Library/Application Support/ClaudeCode/managed-mcp.json",
    );
    expect(claudeManagedMcpConfigPath("win32")).toBe(
      "C:\\Program Files\\ClaudeCode\\managed-mcp.json",
    );
    expect(claudeManagedMcpConfigPath("linux")).toBe("/etc/claude-code/managed-mcp.json");
  });
});

describe("claudeMcpIsolationArgs", () => {
  it("omits --strict-mcp-config when a managed-mcp.json exists", () => {
    expect(claudeMcpIsolationArgs(false)).toEqual(["--strict-mcp-config"]);
    expect(claudeMcpIsolationArgs(true)).toEqual([]);
  });
});
