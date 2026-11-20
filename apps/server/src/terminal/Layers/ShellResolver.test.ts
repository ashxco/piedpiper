import { describe, expect, it } from "vitest";

import { PtySpawnError } from "../Services/PTY";
import {
  defaultShellResolver,
  shellCandidateFromCommand,
  isRetryableShellSpawnError,
  normalizeShellCommand,
  resolveShellCandidates,
} from "./ShellResolver";

const POWERSHELL_ARGS = [
  "-NoLogo",
  "-NoExit",
  "-Command",
  "[Console]::OutputEncoding = $OutputEncoding = [System.Text.UTF8Encoding]::new()",
];

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
      { shell: "pwsh.exe", args: POWERSHELL_ARGS },
      { shell: "D:\\Tools\\cmd.exe" },
      { shell: "E:\\Win\\System32\\cmd.exe" },
      { shell: "cmd.exe" },
      {
        shell: "E:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        args: POWERSHELL_ARGS,
      },
      { shell: "powershell.exe", args: POWERSHELL_ARGS },
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

describe("normalizeShellCommand", () => {
  const noFiles = () => false;

  it("keeps missing or quoted shell paths that contain spaces", () => {
    expect(normalizeShellCommand("/Users/Jane Doe/.local/bin/fish", "darwin", noFiles)).toBe(
      "/Users/Jane Doe/.local/bin/fish",
    );
    expect(normalizeShellCommand('"/opt/my -shell/fish" -l', "darwin", noFiles)).toBe(
      "/opt/my -shell/fish",
    );
    expect(normalizeShellCommand("'/opt/my shell/fish'", "darwin", noFiles)).toBe(
      "/opt/my shell/fish",
    );
  });

  it("prefers the longest existing file when spaces precede a dash", () => {
    const existing = "/Users/Jane -Doe Smith/.local/bin/fish";
    expect(
      normalizeShellCommand(`${existing} -l`, "darwin", (candidate) => candidate === existing),
    ).toBe(existing);
  });

  it("drops flags after a plain shell path", () => {
    expect(normalizeShellCommand("/bin/bash -l", "linux", noFiles)).toBe("/bin/bash");
    expect(normalizeShellCommand("zsh", "linux", noFiles)).toBe("zsh");
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

it("starts Bash as a login shell only on macOS", () => {
  expect(shellCandidateFromCommand("/bin/bash", "darwin")).toEqual({
    shell: "/bin/bash",
    args: ["-l"],
  });
  expect(shellCandidateFromCommand("/bin/bash", "linux")).toEqual({ shell: "/bin/bash" });
});
