import { describe, expect, it } from "vitest";

import {
  commandForProjectScriptSafe,
  nextProjectScriptId,
  primaryProjectScript,
  projectScriptCwd,
  projectScriptRuntimeEnv,
  projectScriptTerminalInput,
  projectScriptIdFromCommand,
  setupProjectScript,
} from "./projectScripts";

describe("projectScripts helpers", () => {
  it("builds and parses script run commands", () => {
    const command = commandForProjectScriptSafe("lint")!;
    expect(command).toBe("script.lint.run");
    expect(projectScriptIdFromCommand(command)).toBe("lint");
    expect(projectScriptIdFromCommand("terminal.toggle")).toBeNull();
  });

  it("does not throw for script ids that cannot form a keybinding command", () => {
    expect(commandForProjectScriptSafe("lint")).toBe("script.lint.run");
    expect(commandForProjectScriptSafe("Foo_Bar")).toBeNull();
    expect(() => commandForProjectScriptSafe("Foo_Bar")).not.toThrow();
    expect(projectScriptIdFromCommand("script.Foo_Bar.run")).toBeNull();
  });

  it("slugifies and dedupes project script ids", () => {
    expect(nextProjectScriptId("Run Tests", [])).toBe("run-tests");
    expect(nextProjectScriptId("Run Tests", ["run-tests"])).toBe("run-tests-2");
    expect(nextProjectScriptId("!!!", [])).toBe("script");
  });

  it("resolves primary and setup scripts", () => {
    const scripts = [
      {
        id: "setup",
        name: "Setup",
        command: "bun install",
        icon: "configure" as const,
        runOnWorktreeCreate: true,
      },
      {
        id: "test",
        name: "Test",
        command: "bun test",
        icon: "test" as const,
        runOnWorktreeCreate: false,
      },
    ];

    expect(primaryProjectScript(scripts)?.id).toBe("test");
    expect(setupProjectScript(scripts)?.id).toBe("setup");
  });

  it("builds default runtime env for scripts", () => {
    const env = projectScriptRuntimeEnv({
      project: { cwd: "/repo" },
      worktreePath: "/repo/worktree-a",
    });

    expect(env).toMatchObject({
      PIEDPIPER_PROJECT_ROOT: "/repo",
      PIEDPIPER_WORKTREE_PATH: "/repo/worktree-a",
    });
  });

  it("allows overriding runtime env values", () => {
    const env = projectScriptRuntimeEnv({
      project: { cwd: "/repo" },
      extraEnv: {
        PIEDPIPER_PROJECT_ROOT: "/custom-root",
        CUSTOM_FLAG: "1",
      },
    });

    expect(env.PIEDPIPER_PROJECT_ROOT).toBe("/custom-root");
    expect(env.CUSTOM_FLAG).toBe("1");
    expect(env.PIEDPIPER_WORKTREE_PATH).toBeUndefined();
  });

  it("prefers the worktree path for script cwd resolution", () => {
    expect(
      projectScriptCwd({
        project: { cwd: "/repo" },
        worktreePath: "/repo/worktree-a",
      }),
    ).toBe("/repo/worktree-a");
    expect(
      projectScriptCwd({
        project: { cwd: "/repo" },
        worktreePath: null,
      }),
    ).toBe("/repo");
  });

  it("prefixes script terminal input with a space to keep it out of shell history", () => {
    expect(projectScriptTerminalInput("bun run dev")).toBe(" bun run dev\r");
    expect(projectScriptTerminalInput("bun run dev", { shellHistory: "suppress" })).toBe(
      " bun run dev\r",
    );
  });

  it("keeps user-run commands in shell history when asked to preserve it", () => {
    expect(projectScriptTerminalInput("ls -la", { shellHistory: "preserve" })).toBe("ls -la\r");
  });
});
