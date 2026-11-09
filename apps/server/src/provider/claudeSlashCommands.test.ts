import { describe, expect, it } from "vitest";

import {
  CLAUDE_COMPACT_COMMAND,
  isClaudeSlashCommandPrompt,
  parseClaudeSlashCommands,
  withClaudeCompactCommand,
} from "./claudeSlashCommands";

describe("isClaudeSlashCommandPrompt", () => {
  it("matches a command word at the start, not a path or plain text", () => {
    expect(isClaudeSlashCommandPrompt("/compact")).toBe(true);
    expect(isClaudeSlashCommandPrompt(" /review the diff")).toBe(true);
    expect(isClaudeSlashCommandPrompt("/usr/bin")).toBe(false);
    expect(isClaudeSlashCommandPrompt("run /compact")).toBe(false);
    expect(isClaudeSlashCommandPrompt("/")).toBe(false);
  });
});

describe("parseClaudeSlashCommands", () => {
  it("keeps plain commands with their description and argument hint", () => {
    expect(
      parseClaudeSlashCommands([
        { name: "deploy", description: " Ship it (project) ", argumentHint: "<env>" },
        { name: "clear", description: "", argumentHint: "  ", builtin: true },
      ]),
    ).toEqual([
      { name: "deploy", description: "Ship it (project)", argumentHint: "<env>" },
      { name: "clear" },
    ]);
  });

  it("excludes what the SDK lists as skills or terminal-only, built-in or not", () => {
    const names = parseClaudeSlashCommands(
      [
        { name: "my-skill" },
        { name: "code-review", builtin: true },
        { name: "color", builtin: true },
        { name: "deploy" },
      ],
      { skills: ["my-skill", "CODE-REVIEW"], terminalCommands: ["color"] },
    ).map((command) => command.name);
    expect(names).toEqual(["deploy"]);
  });

  it("hides advisor, skill and internal commands Pied Piper has no use for", () => {
    const names = parseClaudeSlashCommands(
      [
        "advisor",
        "reload-skills",
        "skill-doctor",
        "workflow-launch-exec",
        "__internal",
        "init",
      ].map((name) => ({ name, builtin: true })),
    ).map((command) => command.name);
    expect(names).toEqual(["init"]);
  });

  it("lists a shared name once, using the built-in row's text and filling gaps", () => {
    expect(
      parseClaudeSlashCommands([
        { name: "Deploy", description: "Project", argumentHint: "<env>" },
        { name: "deploy", description: "Built in", builtin: true },
        { name: "DEPLOY", description: "Later" },
      ]),
    ).toEqual([{ name: "deploy", description: "Built in", argumentHint: "<env>" }]);
  });

  it("skips blank names and tolerates a missing list", () => {
    expect(parseClaudeSlashCommands([{ name: "  " }])).toEqual([]);
    expect(parseClaudeSlashCommands(undefined)).toEqual([]);
  });
});

describe("withClaudeCompactCommand", () => {
  it("adds /compact only when it is missing", () => {
    expect(withClaudeCompactCommand([])).toEqual([CLAUDE_COMPACT_COMMAND]);
    const reported = [{ name: "Compact", description: "Reported" }];
    expect(withClaudeCompactCommand(reported)).toBe(reported);
  });
});
