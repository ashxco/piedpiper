import { describe, expect, it } from "vitest";

import { PtySpawnError } from "../Services/PTY";
import {
  defaultShellResolver,
  isRetryableShellSpawnError,
  resolveShellCandidates,
} from "./ShellResolver";

describe("defaultShellResolver", () => {
  it("defaults to PowerShell 7 on Windows and ignores ComSpec", () => {
    expect(defaultShellResolver("win32", { ComSpec: "C:\\Windows\\system32\\cmd.exe" })).toBe(
      "pwsh.exe",
    );
  });

  it("uses SHELL elsewhere", () => {
    expect(defaultShellResolver("linux", { SHELL: "/usr/bin/fish" })).toBe("/usr/bin/fish");
    expect(defaultShellResolver("linux", {})).toBe("bash");
  });
});

describe("resolveShellCandidates", () => {
  it("falls back from PowerShell 7 through cmd to Windows PowerShell", () => {
    expect(
      resolveShellCandidates(() => "pwsh.exe", "win32", {
        ComSpec: "D:\\Tools\\cmd.exe",
        SystemRoot: "E:\\Win",
      }),
    ).toEqual([
      { shell: "pwsh.exe", args: ["-NoLogo"] },
      { shell: "D:\\Tools\\cmd.exe" },
      { shell: "E:\\Win\\System32\\cmd.exe" },
      { shell: "cmd.exe" },
      { shell: "E:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", args: ["-NoLogo"] },
      { shell: "powershell.exe", args: ["-NoLogo"] },
    ]);
  });

  it("tries a requested Windows shell first and skips a missing ComSpec", () => {
    const candidates = resolveShellCandidates(() => "C:\\Git\\bin\\bash.exe", "win32", {
      windir: "C:\\WinDir",
    });
    expect(candidates[0]).toEqual({ shell: "C:\\Git\\bin\\bash.exe" });
    expect(candidates.map((candidate) => candidate.shell)).toEqual([
      "C:\\Git\\bin\\bash.exe",
      "pwsh.exe",
      "C:\\WinDir\\System32\\cmd.exe",
      "cmd.exe",
      "C:\\WinDir\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      "powershell.exe",
    ]);
  });

  it("assumes C:\\Windows when the system root variables are unset", () => {
    expect(
      resolveShellCandidates(() => "pwsh.exe", "win32", {}).map((candidate) => candidate.shell),
    ).toContain("C:\\Windows\\System32\\cmd.exe");
  });

  it("keeps the POSIX chain and reads SHELL from the given env", () => {
    expect(resolveShellCandidates(() => "/bin/fish -l", "linux", { SHELL: "/bin/dash" })).toEqual([
      { shell: "/bin/fish" },
      { shell: "/bin/dash" },
      { shell: "/bin/zsh", args: ["-o", "nopromptsp"] },
      { shell: "/bin/bash" },
      { shell: "/bin/sh" },
      { shell: "zsh", args: ["-o", "nopromptsp"] },
      { shell: "bash" },
      { shell: "sh" },
    ]);
  });
});

describe("isRetryableShellSpawnError", () => {
  const spawnError = (message: string) => new PtySpawnError({ adapter: "node-pty", message });

  it.each([
    "File not found: pwsh.exe",
    "Cannot create process, error code: 2",
    "posix_spawnp failed.",
  ])("retries after %s", (message) => {
    expect(isRetryableShellSpawnError(spawnError(message))).toBe(true);
  });

  it("does not retry an unrelated failure", () => {
    expect(isRetryableShellSpawnError(spawnError("Out of memory"))).toBe(false);
  });
});
