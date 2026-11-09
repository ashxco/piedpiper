import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readClaudeSettingsEnv } from "./claudeSettingsEnv";

describe("readClaudeSettingsEnv", () => {
  const roots: string[] = [];
  const makeDirs = () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "claude-settings-env-"));
    roots.push(root);
    const homeDir = path.join(root, "home");
    const managedDir = path.join(root, "managed");
    mkdirSync(path.join(homeDir, ".claude"), { recursive: true });
    mkdirSync(path.join(managedDir, "managed-settings.d"), { recursive: true });
    return { root, homeDir, managedDir, environment: {} };
  };
  const writeEnv = (filePath: string, env: unknown) =>
    writeFileSync(filePath, JSON.stringify({ env }));

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("reads ~/.claude/settings.json by default", async () => {
    const dirs = makeDirs();
    writeEnv(path.join(dirs.homeDir, ".claude", "settings.json"), {
      ANTHROPIC_BASE_URL: "https://a",
    });
    await expect(readClaudeSettingsEnv(dirs)).resolves.toEqual({ ANTHROPIC_BASE_URL: "https://a" });
  });

  it("prefers the configured directory, then CLAUDE_CONFIG_DIR", async () => {
    const dirs = makeDirs();
    const configured = path.join(dirs.root, "configured");
    const fromEnv = path.join(dirs.root, "from-env");
    mkdirSync(configured);
    mkdirSync(fromEnv);
    writeEnv(path.join(dirs.homeDir, ".claude", "settings.json"), { WHICH: "home" });
    writeEnv(path.join(configured, "settings.json"), { WHICH: "configured" });
    writeEnv(path.join(fromEnv, "settings.json"), { WHICH: "env" });
    const environment = { CLAUDE_CONFIG_DIR: fromEnv };
    await expect(readClaudeSettingsEnv({ ...dirs, environment })).resolves.toEqual({
      WHICH: "env",
    });
    await expect(
      readClaudeSettingsEnv({ ...dirs, environment, homePath: configured }),
    ).resolves.toEqual({ WHICH: "configured" });
  });

  it("lets managed settings and their sorted drop-ins win", async () => {
    const dirs = makeDirs();
    writeEnv(path.join(dirs.homeDir, ".claude", "settings.json"), {
      A: "user",
      B: "user",
      C: "user",
    });
    writeEnv(path.join(dirs.managedDir, "managed-settings.json"), { B: "managed", C: "managed" });
    const dropIns = path.join(dirs.managedDir, "managed-settings.d");
    writeEnv(path.join(dropIns, "20-late.json"), { C: "late" });
    writeEnv(path.join(dropIns, "10-early.json"), { C: "early" });
    writeFileSync(path.join(dropIns, "ignored.txt"), JSON.stringify({ env: { C: "text" } }));
    writeEnv(path.join(dropIns, ".90-hidden.json"), { C: "hidden" });
    await expect(readClaudeSettingsEnv(dirs)).resolves.toEqual({
      A: "user",
      B: "managed",
      C: "late",
    });
  });

  it.each([
    ["malformed JSON", "{ nope"],
    ["a non-object file", "[1, 2]"],
    ["null", "null"],
    ["an array env", '{"env":["x"]}'],
  ])("tolerates %s", async (_label, contents) => {
    const dirs = makeDirs();
    writeFileSync(path.join(dirs.homeDir, ".claude", "settings.json"), contents);
    writeEnv(path.join(dirs.managedDir, "managed-settings.json"), { KEPT: "yes" });
    await expect(readClaudeSettingsEnv(dirs)).resolves.toEqual({ KEPT: "yes" });
  });

  it("keeps only string values and an empty override", async () => {
    const dirs = makeDirs();
    writeEnv(path.join(dirs.homeDir, ".claude", "settings.json"), {
      ANTHROPIC_BASE_URL: "",
      ENABLED: 1,
    });
    await expect(readClaudeSettingsEnv(dirs)).resolves.toEqual({ ANTHROPIC_BASE_URL: "" });
  });

  it("returns nothing when no file exists", async () => {
    const dirs = makeDirs();
    rmSync(dirs.managedDir, { recursive: true });
    await expect(readClaudeSettingsEnv(dirs)).resolves.toEqual({});
  });
});
