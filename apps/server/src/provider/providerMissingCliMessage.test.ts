import { describe, expect, it } from "vitest";

import {
  formatMissingClaudeCliMessage,
  formatMissingCodexCliMessage,
} from "./providerMissingCliMessage";

describe("formatMissingCodexCliMessage", () => {
  it.each([
    "codex",
    "/Applications/Custom App.app/Contents/Resources/codex",
    "C:\\Tools\\codex.exe",
  ])("names the configured command and where to change it: %s", (binaryPath) => {
    const message = formatMissingCodexCliMessage(binaryPath);
    expect(message).toContain(`\`${binaryPath}\``);
    expect(message).toContain("providers.codex.binaryPath");
    expect(message.includes("ChatGPT or Codex desktop app")).toBe(binaryPath === "codex");
    expect(message.includes("Make sure the configured executable exists")).toBe(
      binaryPath !== "codex",
    );
  });
});

describe("formatMissingClaudeCliMessage", () => {
  it("points at the Claude binary path setting", () => {
    expect(formatMissingClaudeCliMessage("claude")).toBe(
      "Could not start Claude Agent CLI (`claude`). Check Settings → General → Providers → Claude → Claude binary path. Install Claude Code or make sure claude is on PATH.",
    );
    expect(formatMissingClaudeCliMessage("/opt/claude")).toContain(
      "Make sure the configured executable exists and can be run.",
    );
  });
});
