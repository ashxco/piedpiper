import * as Path from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildClaudeChildEnv,
  resolveClaudeConfigDir,
  resolveClaudeSdkExecutablePath,
} from "./ClaudeExecutable.ts";

const NPM_DIR = "C:\\Users\\dev\\AppData\\Roaming\\npm";
const NPM_PACKAGE_EXE = `${NPM_DIR}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;
const NPM_PACKAGE_CLI = `${NPM_DIR}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`;
const ENV = { PATH: `C:\\Windows\\System32;${NPM_DIR}`, PATHEXT: ".COM;.EXE;.BAT;.CMD" };

function resolveOnWindows(binaryPath: string, files: ReadonlyArray<string>) {
  const existing = new Set(files);
  return resolveClaudeSdkExecutablePath(binaryPath, {
    platform: "win32",
    env: ENV,
    isFile: (filePath) => existing.has(filePath),
  });
}

describe("resolveClaudeSdkExecutablePath", () => {
  it("returns the configured path unchanged off Windows", () => {
    expect(
      resolveClaudeSdkExecutablePath("claude", {
        platform: "darwin",
        isFile: () => {
          throw new Error("must not probe off Windows");
        },
      }),
    ).toBe("claude");
  });

  it("resolves a bare name to a native executable on PATH", () => {
    const nativeBinary = `${NPM_DIR}\\claude.exe`;
    expect(resolveOnWindows("claude", [nativeBinary])).toBe(nativeBinary);
  });

  it("follows an npm .cmd shim to the packaged native binary", () => {
    expect(
      resolveOnWindows("claude", [`${NPM_DIR}\\claude.cmd`, NPM_PACKAGE_EXE, NPM_PACKAGE_CLI]),
    ).toBe(NPM_PACKAGE_EXE);
  });

  it("follows an explicit mixed-case shim path", () => {
    expect(
      resolveOnWindows(`${NPM_DIR}\\claude.CMD`, [`${NPM_DIR}\\claude.CMD`, NPM_PACKAGE_EXE]),
    ).toBe(NPM_PACKAGE_EXE);
  });

  it("falls back to cli.js when the package ships no native binary", () => {
    expect(resolveOnWindows("claude", [`${NPM_DIR}\\claude.cmd`, NPM_PACKAGE_CLI])).toBe(
      NPM_PACKAGE_CLI,
    );
  });

  it("returns the configured path when the shim has no known package entry", () => {
    expect(resolveOnWindows("claude", [`${NPM_DIR}\\claude.cmd`])).toBe("claude");
  });

  it("reports the unresolved shim so callers can log why spawning may fail", () => {
    const reported: Array<string> = [];
    const shim = `${NPM_DIR}\\claude.cmd`;
    const result = resolveClaudeSdkExecutablePath("claude", {
      platform: "win32",
      env: ENV,
      isFile: (filePath) => filePath === shim,
      onUnresolvedShim: (shimPath) => reported.push(shimPath),
    });
    expect(result).toBe("claude");
    expect(reported).toEqual([shim]);
  });

  it("does not report a shim that resolved to a package entry", () => {
    const reported: Array<string> = [];
    resolveClaudeSdkExecutablePath("claude", {
      platform: "win32",
      env: ENV,
      isFile: (filePath) => filePath === `${NPM_DIR}\\claude.cmd` || filePath === NPM_PACKAGE_EXE,
      onUnresolvedShim: (shimPath) => reported.push(shimPath),
    });
    expect(reported).toEqual([]);
  });

  it("returns the configured path when nothing is found on PATH", () => {
    expect(resolveOnWindows("claude", [])).toBe("claude");
  });
});

describe("buildClaudeChildEnv", () => {
  it("drops the launching Claude Code session's identity vars but keeps Claude config vars", () => {
    expect(
      buildClaudeChildEnv({
        PATH: "/usr/bin",
        CLAUDECODE: "1",
        CLAUDE_CODE_SESSION_ID: "host-session",
        claude_code_messaging_socket: "/tmp/host-claude.sock",
        CLAUDE_CODE_MESSAGING_TOKEN: "secret",
        CLAUDE_EFFORT: "high",
        CLAUDE_PID: "123",
        CLAUDE_CODE_ENTRYPOINT: "claude-desktop",
        CLAUDE_CONFIG_DIR: "/home/dev/.claude",
        CLAUDE_CODE_USE_BEDROCK: "1",
        ELECTRON_RUN_AS_NODE: "1",
        PIEDPIPER_PORT: "3773",
      }),
    ).toEqual({
      PATH: "/usr/bin",
      CLAUDE_CODE_ENTRYPOINT: "claude-desktop",
      CLAUDE_CONFIG_DIR: "/home/dev/.claude",
      CLAUDE_CODE_USE_BEDROCK: "1",
    });
  });

  it("adds the configured config directory, expanded, and leaves HOME alone", () => {
    expect(
      buildClaudeChildEnv({ HOME: "/home/dev", CLAUDE_CONFIG_DIR: "/old" }, { homePath: "/work" }),
    ).toEqual({ HOME: "/home/dev", CLAUDE_CONFIG_DIR: "/work" });
    expect(buildClaudeChildEnv({ CLAUDE_CONFIG_DIR: "/old" }, { homePath: "" })).toEqual({
      CLAUDE_CONFIG_DIR: "/old",
    });
  });
});

describe("resolveClaudeConfigDir", () => {
  it("expands a home-relative path and always returns an absolute one", () => {
    expect(resolveClaudeConfigDir("~/claude-work", "/home/dev")).toBe("/home/dev/claude-work");
    expect(resolveClaudeConfigDir("~", "/home/dev")).toBe("/home/dev");
    expect(resolveClaudeConfigDir("/accounts/work/")).toBe("/accounts/work");
    expect(Path.isAbsolute(resolveClaudeConfigDir("relative/dir") ?? "")).toBe(true);
  });

  it("is undefined when unset, so Claude keeps its own default", () => {
    expect(resolveClaudeConfigDir("")).toBeUndefined();
    expect(resolveClaudeConfigDir("   ")).toBeUndefined();
    expect(resolveClaudeConfigDir(undefined)).toBeUndefined();
  });
});
