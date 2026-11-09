import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { describe, expect, it } from "vitest";

import { isWindowsCommandNotFound, resolveProcessSpawnCommand, runProcess } from "./processRunner";

describe("runProcess", () => {
  it("fails when output exceeds max buffer in default mode", async () => {
    await expect(
      runProcess("node", ["-e", "process.stdout.write('x'.repeat(2048))"], { maxBufferBytes: 128 }),
    ).rejects.toThrow("exceeded stdout buffer limit");
  });

  it("truncates output when outputMode is truncate", async () => {
    const result = await runProcess("node", ["-e", "process.stdout.write('x'.repeat(2048))"], {
      maxBufferBytes: 128,
      outputMode: "truncate",
    });

    expect(result.code).toBe(0);
    expect(result.stdout.length).toBeLessThanOrEqual(128);
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stderrTruncated).toBe(false);
  });

  it("passes shell metacharacters and empty arguments to the host child verbatim (cross-platform guard)", async () => {
    const args = ["foo&calc.exe", "a | b > c", "%PATH%", 'say "hi"', "", "trailing\\"];
    const result = await runProcess("node", [
      "-e",
      "process.stdout.write(JSON.stringify(process.argv.slice(1)))",
      ...args,
    ]);

    expect(JSON.parse(result.stdout)).toEqual(args);
  });

  it("reports a missing command as not found", async () => {
    await expect(runProcess(`piedpiper-no-such-command-${Date.now()}`, [])).rejects.toThrow(
      "Command not found",
    );
  });

  it("normalizes a synchronous spawn throw from a file cwd", async () => {
    const dir = FS.mkdtempSync(Path.join(OS.tmpdir(), "piedpiper-process-runner-"));
    const fileCwd = Path.join(dir, "not-a-directory");
    FS.writeFileSync(fileCwd, "");
    try {
      await expect(runProcess("node", ["-e", ""], { cwd: fileCwd })).rejects.toThrow(
        /^Failed to run node -e : /,
      );
    } finally {
      FS.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveProcessSpawnCommand on win32", () => {
  const shimPath = "C:\\Users\\tester\\AppData\\Roaming\\npm\\gh.cmd";
  const win32Shim = {
    platform: "win32" as const,
    env: { PATH: "C:\\Users\\tester\\AppData\\Roaming\\npm", PATHEXT: ".EXE;.CMD" },
    isFile: (filePath: string) => filePath === shimPath,
  };

  it("resolves and escapes Windows command shims before spawning", () => {
    expect(
      resolveProcessSpawnCommand("gh", ["pr", "list", "--head", "feature & release"], win32Shim),
    ).toEqual({
      command: [
        `^"${shimPath}^"`,
        '^"pr^"',
        '^"list^"',
        '^"--head^"',
        '^"feature^ ^&^ release^"',
      ].join(" "),
      args: [],
      shell: true,
    });
  });

  it("passes quotes through unchanged to a real Windows executable", () => {
    const exePath = "C:\\Program Files\\GitHub CLI\\gh.exe";
    expect(
      resolveProcessSpawnCommand("gh", ["--title", 'x" & calc & "'], {
        platform: "win32",
        env: { PATH: "C:\\Program Files\\GitHub CLI" },
        isFile: (filePath) => filePath === exePath,
      }),
    ).toEqual({ command: exePath, args: ["--title", 'x" & calc & "'], shell: false });
  });

  it("rejects quotes and line breaks in shim arguments without spawning", async () => {
    for (const unsafe of ['x" & calc & "', "line\ncalc"]) {
      await expect(
        runProcess("gh", ["pr", "create", "--title", unsafe], win32Shim),
      ).rejects.toThrow(/Cannot run .*gh(\.cmd)? through cmd\.exe/);
    }
  });
});

const withPlatform = (platform: NodeJS.Platform, run: () => void) => {
  const originalPlatform = process.platform;
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    run();
  } finally {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  }
};

describe("isWindowsCommandNotFound", () => {
  it("matches localized cmd.exe messages on Windows", () => {
    withPlatform("win32", () => {
      for (const stderr of [
        "'claude' is not recognized as an internal or external command,",
        '"claude" wird nicht als interner oder externer Befehl, betriebsfähiges Programm oder Batch-Datei erkannt.',
        "'claude' n'est pas reconnu en tant que commande interne ou externe,",
        '"claude" no se reconoce como un comando interno o externo,',
        "'claude' non è riconosciuto come comando interno o esterno,",
        "'claude' não é reconhecido como um comando interno",
      ]) {
        expect(isWindowsCommandNotFound(1, stderr)).toBe(true);
      }
      expect(isWindowsCommandNotFound(1, "some other failure")).toBe(false);
    });
  });

  it("never matches off Windows", () => {
    withPlatform("linux", () => {
      expect(
        isWindowsCommandNotFound(1, "is not recognized as an internal or external command"),
      ).toBe(false);
    });
  });
});
