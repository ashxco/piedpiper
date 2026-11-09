import { describe, expect, it } from "vitest";

import {
  buildWindowsCommandLine,
  escapeWindowsShellArg,
  hasWindowsShimUnsafeChars,
  resolveSpawnCommand,
  resolveWindowsExecutable,
  WindowsCommandLineError,
} from "./windowsCommand";

const WINDOWS_ENV = {
  PATH: "C:\\Windows\\System32;C:\\Users\\tester\\AppData\\Roaming\\npm",
  PATHEXT: ".COM;.EXE;.BAT;.CMD",
};

const fileSet = (...files: ReadonlyArray<string>) => {
  const set = new Set(files.map((file) => file.toLowerCase()));
  return (filePath: string) => set.has(filePath.toLowerCase());
};

describe("escapeWindowsShellArg", () => {
  it("quotes the argument and caret-escapes cmd.exe metacharacters", () => {
    expect(escapeWindowsShellArg("value & calc")).toBe(String.raw`^"value^ ^&^ calc^"`);
    expect(escapeWindowsShellArg("%PATH%")).toBe(String.raw`^"^%PATH^%^"`);
    expect(escapeWindowsShellArg("x|y<z>^")).toBe(String.raw`^"x^|y^<z^>^^^"`);
    expect(escapeWindowsShellArg("")).toBe(String.raw`^"^"`);
  });

  it("escapes embedded quotes and trailing backslashes for CommandLineToArgvW", () => {
    expect(escapeWindowsShellArg('quote"value')).toBe(String.raw`^"quote\^"value^"`);
    expect(escapeWindowsShellArg("C:\\dir with space\\")).toBe(
      String.raw`^"C:\dir^ with^ space\\^"`,
    );
    expect(escapeWindowsShellArg('slash\\"quote')).toBe(String.raw`^"slash\\\^"quote^"`);
  });
});

describe("buildWindowsCommandLine", () => {
  it("joins the escaped tokens into one line", () => {
    expect(buildWindowsCommandLine("C:\\Program Files\\npm & tools\\vp.cmd", ["run", "a&b"])).toBe(
      [
        String.raw`^"C:\Program^ Files\npm^ ^&^ tools\vp.cmd^"`,
        String.raw`^"run^"`,
        String.raw`^"a^&b^"`,
      ].join(" "),
    );
  });

  it("refuses arguments containing line breaks or other control characters", () => {
    expect(() => buildWindowsCommandLine("gh", ["pr", "create", "--title", "x\ncalc.exe"])).toThrow(
      WindowsCommandLineError,
    );
    expect(() => buildWindowsCommandLine("gh", ["a\rb"])).toThrow(WindowsCommandLineError);
    expect(() => buildWindowsCommandLine("gh", ["a\u0000b"])).toThrow(WindowsCommandLineError);
    expect(() => buildWindowsCommandLine("gh\n", [])).toThrow(WindowsCommandLineError);
  });
});

describe("hasWindowsShimUnsafeChars", () => {
  it("flags double quotes and control characters only", () => {
    expect(hasWindowsShimUnsafeChars('C:\\ws"&calc')).toBe(true);
    expect(hasWindowsShimUnsafeChars("C:\\ws\n")).toBe(true);
    expect(hasWindowsShimUnsafeChars("C:\\dir with space\\foo&bar")).toBe(false);
  });
});

describe("resolveWindowsExecutable", () => {
  it("scans PATH with PATHEXT candidates for bare names", () => {
    const isFile = fileSet("C:\\Users\\tester\\AppData\\Roaming\\npm\\codex.cmd");
    expect(resolveWindowsExecutable("codex", WINDOWS_ENV, isFile)).toBe(
      "C:\\Users\\tester\\AppData\\Roaming\\npm\\codex.cmd",
    );
    expect(resolveWindowsExecutable("missing", WINDOWS_ENV, isFile)).toBeUndefined();
  });

  it("prefers earlier PATH entries and earlier PATHEXT extensions", () => {
    const isFile = fileSet(
      "C:\\Windows\\System32\\gh.cmd",
      "C:\\Users\\tester\\AppData\\Roaming\\npm\\gh.exe",
      "C:\\Windows\\System32\\node.exe",
      "C:\\Windows\\System32\\node.cmd",
    );
    expect(resolveWindowsExecutable("gh", WINDOWS_ENV, isFile)).toBe(
      "C:\\Windows\\System32\\gh.cmd",
    );
    expect(resolveWindowsExecutable("node", WINDOWS_ENV, isFile)).toBe(
      "C:\\Windows\\System32\\node.exe",
    );
  });

  it("checks explicit paths directly and strips quotes around PATH entries", () => {
    const isFile = fileSet("C:\\tools\\claude.cmd", "D:\\bin\\gh.exe");
    expect(resolveWindowsExecutable("C:\\tools\\claude.cmd", WINDOWS_ENV, isFile)).toBe(
      "C:\\tools\\claude.cmd",
    );
    expect(resolveWindowsExecutable("C:\\tools\\other.cmd", WINDOWS_ENV, isFile)).toBeUndefined();
    expect(
      resolveWindowsExecutable("gh", { Path: '"D:\\bin";C:\\x', PATHEXT: "EXE" }, isFile),
    ).toBe("D:\\bin\\gh.exe");
  });

  it("probes each repeated PATH directory once but keeps entries that differ in case", () => {
    const probes: Array<string> = [];
    const isFile = (filePath: string) => {
      probes.push(filePath);
      return false;
    };
    const env = { PATH: 'C:\\bin; C:\\bin ;"C:\\bin";c:\\BIN;C:\\bin', PATHEXT: ".EXE;.CMD" };
    expect(resolveWindowsExecutable("missing", env, isFile)).toBeUndefined();
    expect(probes).toEqual([
      "C:\\bin\\missing.exe",
      "C:\\bin\\missing.cmd",
      "c:\\BIN\\missing.exe",
      "c:\\BIN\\missing.cmd",
    ]);
  });
});

describe("resolveSpawnCommand", () => {
  it("returns the command untouched off Windows", () => {
    for (const platform of ["darwin", "linux"] as const) {
      expect(resolveSpawnCommand("code", ["foo&calc.exe"], { platform, env: WINDOWS_ENV })).toEqual(
        { command: "code", args: ["foo&calc.exe"], shell: false },
      );
    }
  });

  it("runs Windows executables directly without a shell", () => {
    const isFile = fileSet("C:\\Program Files\\GitHub CLI\\gh.exe");
    expect(
      resolveSpawnCommand("gh", ["pr", "create", "--title", "fix & calc.exe | more"], {
        platform: "win32",
        env: { ...WINDOWS_ENV, PATH: `${WINDOWS_ENV.PATH};C:\\Program Files\\GitHub CLI` },
        isFile,
      }),
    ).toEqual({
      command: "C:\\Program Files\\GitHub CLI\\gh.exe",
      args: ["pr", "create", "--title", "fix & calc.exe | more"],
      shell: false,
    });
  });

  it("leaves an unresolved command for a direct spawn so ENOENT surfaces", () => {
    expect(
      resolveSpawnCommand("codex", ["app-server"], {
        platform: "win32",
        env: WINDOWS_ENV,
        isFile: () => false,
      }),
    ).toEqual({ command: "codex", args: ["app-server"], shell: false });
  });

  it("builds one escaped cmd.exe line for Windows command shims", () => {
    const isFile = fileSet("C:\\Program Files\\npm & tools\\vp.cmd");
    const resolved = resolveSpawnCommand(
      "vp",
      ["run", "value & calc", "%PATH%", 'quote"value', "C:\\dir with space\\", "x|y<z>^", ""],
      {
        platform: "win32",
        env: { PATH: "C:\\Program Files\\npm & tools", PATHEXT: ".COM;.EXE;.BAT;.CMD" },
        isFile,
      },
    );

    // No args alongside `shell: true`: Node prints DEP0190 for that pairing.
    expect(resolved).toEqual({
      command: [
        String.raw`^"C:\Program^ Files\npm^ ^&^ tools\vp.cmd^"`,
        String.raw`^"run^"`,
        String.raw`^"value^ ^&^ calc^"`,
        String.raw`^"^%PATH^%^"`,
        String.raw`^"quote\^"value^"`,
        String.raw`^"C:\dir^ with^ space\\^"`,
        String.raw`^"x^|y^<z^>^^^"`,
        String.raw`^"^"`,
      ].join(" "),
      args: [],
      shell: true,
    });
  });

  it("treats explicit .bat paths as shims", () => {
    const resolved = resolveSpawnCommand("C:\\tools\\run.bat", ["a b"], {
      platform: "win32",
      env: WINDOWS_ENV,
      isFile: fileSet("C:\\tools\\run.bat"),
    });
    expect(resolved).toEqual({
      command: String.raw`^"C:\tools\run.bat^" ^"a^ b^"`,
      args: [],
      shell: true,
    });
  });

  it("refuses shim arguments with line breaks but passes them to real executables", () => {
    const env = { PATH: "C:\\bin", PATHEXT: ".EXE;.CMD" };
    expect(() =>
      resolveSpawnCommand("claude", ["--title", "x\ncalc.exe"], {
        platform: "win32",
        env,
        isFile: fileSet("C:\\bin\\claude.cmd"),
      }),
    ).toThrow(WindowsCommandLineError);
    expect(
      resolveSpawnCommand("gh", ["--title", "x\ncalc.exe"], {
        platform: "win32",
        env,
        isFile: fileSet("C:\\bin\\gh.exe"),
      }),
    ).toEqual({ command: "C:\\bin\\gh.exe", args: ["--title", "x\ncalc.exe"], shell: false });
  });
});
