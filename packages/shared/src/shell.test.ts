import { describe, expect, it, vi } from "vitest";

import {
  applyWindowsEnvironmentPatch,
  buildLoginShellEnvironmentCaptureCommand,
  buildWindowsEnvironmentProbeArgs,
  clearGitExecutableCache,
  ExecFileSyncLike,
  extractPathFromShellOutput,
  findFileOnPath,
  isNushell,
  preferGitForWindowsBinary,
  resolveGitExecutable,
  resolveGitExecutableCached,
  listLoginShellCandidates,
  mergePathEntries,
  readEnvironmentFromLoginShell,
  readEnvironmentFromLoginShellCandidates,
  readPathFromLaunchctl,
  readPathFromLoginShell,
  resolveKnownWindowsCliDirs,
  resolveLoginShell,
  resolveWindowsEnvironment,
  runWindowsShellProbe,
  setWindowsPath,
  ShellEnvironmentReader,
  WindowsShellProbeRunner,
} from "./shell";

const LOGIN_SHELL_PROBE_OPTIONS = {
  encoding: "utf8",
  timeout: 5000,
  killSignal: "SIGKILL",
  detached: true,
  stdio: ["ignore", "pipe", "ignore"],
} as const;

describe("extractPathFromShellOutput", () => {
  it("extracts the path between capture markers", () => {
    expect(
      extractPathFromShellOutput(
        "__PIEDPIPER_PATH_START__\n/opt/homebrew/bin:/usr/bin\n__PIEDPIPER_PATH_END__\n",
      ),
    ).toBe("/opt/homebrew/bin:/usr/bin");
  });

  it("ignores shell startup noise around the capture markers", () => {
    expect(
      extractPathFromShellOutput(
        "Welcome to fish\n__PIEDPIPER_PATH_START__\n/opt/homebrew/bin:/usr/bin\n__PIEDPIPER_PATH_END__\nBye\n",
      ),
    ).toBe("/opt/homebrew/bin:/usr/bin");
  });

  it("returns null when the markers are missing", () => {
    expect(extractPathFromShellOutput("/opt/homebrew/bin /usr/bin")).toBeNull();
  });
});

describe("readPathFromLoginShell", () => {
  it("uses a shell-agnostic printenv PATH probe", () => {
    const execFile = vi.fn<ExecFileSyncLike>(
      () => "__PIEDPIPER_ENV_PATH_START__\n/a:/b\n__PIEDPIPER_ENV_PATH_END__\n",
    );

    expect(readPathFromLoginShell("/opt/homebrew/bin/fish", execFile)).toBe("/a:/b");
    expect(execFile).toHaveBeenCalledTimes(1);

    const firstCall = execFile.mock.calls[0];
    expect(firstCall).toBeDefined();
    if (!firstCall) {
      throw new Error("Expected execFile to be called");
    }

    const [shell, args, options] = firstCall;
    expect(shell).toBe("/opt/homebrew/bin/fish");
    expect(args).toHaveLength(2);
    expect(args?.[0]).toBe("-ilc");
    expect(args?.[1]).toContain("printenv PATH || true");
    expect(args?.[1]).toContain("__PIEDPIPER_ENV_PATH_START__");
    expect(args?.[1]).toContain("__PIEDPIPER_ENV_PATH_END__");
    expect(options).toEqual(LOGIN_SHELL_PROBE_OPTIONS);
  });

  it("force-kills a hung probe and keeps it off the inherited TTY", () => {
    const execFile = vi.fn<ExecFileSyncLike>(
      () => "__PIEDPIPER_ENV_PATH_START__\n/a\n__PIEDPIPER_ENV_PATH_END__\n",
    );

    readPathFromLoginShell("/bin/zsh", execFile);

    const options = execFile.mock.calls[0]?.[2];
    expect(options?.killSignal).toBe("SIGKILL");
    expect(options?.detached).toBe(true);
    expect(options?.stdio).toEqual(["ignore", "pipe", "ignore"]);
  });

  it("propagates a timed-out probe so callers can try the next shell", () => {
    const execFile = vi.fn<ExecFileSyncLike>(() => {
      throw Object.assign(new Error("spawnSync /bin/zsh ETIMEDOUT"), { code: "ETIMEDOUT" });
    });

    expect(() => readPathFromLoginShell("/bin/zsh", execFile)).toThrow(/ETIMEDOUT/);
  });
});

describe("readPathFromLaunchctl", () => {
  it("returns a trimmed PATH value from launchctl", () => {
    const execFile = vi.fn<ExecFileSyncLike>(() => "  /opt/homebrew/bin:/usr/bin  \n");

    expect(readPathFromLaunchctl(execFile)).toBe("/opt/homebrew/bin:/usr/bin");
    expect(execFile).toHaveBeenCalledWith("/bin/launchctl", ["getenv", "PATH"], {
      encoding: "utf8",
      timeout: 2000,
      killSignal: "SIGKILL",
    });
  });

  it("returns undefined when launchctl is unavailable or has no PATH", () => {
    const failing = vi.fn<ExecFileSyncLike>(() => {
      throw new Error("spawn /bin/launchctl ENOENT");
    });
    expect(readPathFromLaunchctl(failing)).toBeUndefined();

    const empty = vi.fn<ExecFileSyncLike>(() => "\n");
    expect(readPathFromLaunchctl(empty)).toBeUndefined();
  });
});

describe("readEnvironmentFromLoginShell", () => {
  it("extracts multiple environment variables from a login shell command", () => {
    const execFile = vi.fn<ExecFileSyncLike>(() =>
      [
        "__PIEDPIPER_ENV_PATH_START__",
        "/a:/b",
        "__PIEDPIPER_ENV_PATH_END__",
        "__PIEDPIPER_ENV_SSH_AUTH_SOCK_START__",
        "/tmp/secretive.sock",
        "__PIEDPIPER_ENV_SSH_AUTH_SOCK_END__",
      ].join("\n"),
    );

    expect(readEnvironmentFromLoginShell("/bin/zsh", ["PATH", "SSH_AUTH_SOCK"], execFile)).toEqual({
      PATH: "/a:/b",
      SSH_AUTH_SOCK: "/tmp/secretive.sock",
    });
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it("omits environment variables that are missing or empty", () => {
    const execFile = vi.fn<ExecFileSyncLike>(() =>
      [
        "__PIEDPIPER_ENV_PATH_START__",
        "/a:/b",
        "__PIEDPIPER_ENV_PATH_END__",
        "__PIEDPIPER_ENV_SSH_AUTH_SOCK_START__",
        "__PIEDPIPER_ENV_SSH_AUTH_SOCK_END__",
      ].join("\n"),
    );

    expect(readEnvironmentFromLoginShell("/bin/zsh", ["PATH", "SSH_AUTH_SOCK"], execFile)).toEqual({
      PATH: "/a:/b",
    });
  });

  it("preserves surrounding whitespace in captured values", () => {
    const execFile = vi.fn<ExecFileSyncLike>(() =>
      [
        "__PIEDPIPER_ENV_CUSTOM_VAR_START__",
        "  padded value  ",
        "__PIEDPIPER_ENV_CUSTOM_VAR_END__",
      ].join("\n"),
    );

    expect(readEnvironmentFromLoginShell("/bin/zsh", ["CUSTOM_VAR"], execFile)).toEqual({
      CUSTOM_VAR: "  padded value  ",
    });
  });

  it("rejects variable names that could inject shell syntax", () => {
    const execFile = vi.fn<ExecFileSyncLike>(() => "");

    expect(() => readEnvironmentFromLoginShell("/bin/zsh", ["PATH; rm -rf /"], execFile)).toThrow(
      /Unsupported environment variable name/,
    );
    expect(execFile).not.toHaveBeenCalled();
  });
});

describe("buildLoginShellEnvironmentCaptureCommand", () => {
  it("detects Nushell by its exact executable name", () => {
    expect(isNushell("/opt/homebrew/bin/nu")).toBe(true);
    expect(isNushell("/usr/local/bin/nushell")).toBe(true);
    expect(isNushell("C:\\Program Files\\nu\\bin\\NU.EXE")).toBe(true);
    expect(isNushell("/usr/bin/nuke")).toBe(false);
    expect(isNushell("/bin/zsh")).toBe(false);
  });

  it("emits POSIX syntax for sh-family shells", () => {
    const command = buildLoginShellEnvironmentCaptureCommand("/bin/zsh", ["SSH_AUTH_SOCK"]);
    expect(command).toBe(
      "printf '%s\\n' '__PIEDPIPER_ENV_SSH_AUTH_SOCK_START__'; printenv SSH_AUTH_SOCK || true; " +
        "printf '%s\\n' '__PIEDPIPER_ENV_SSH_AUTH_SOCK_END__'",
    );
  });

  it("emits Nushell syntax that honours ENV_CONVERSIONS and list PATHs", () => {
    const command = buildLoginShellEnvironmentCaptureCommand("/opt/homebrew/bin/nu", [
      "PATH",
      "__MISE_DIFF",
    ]);
    expect(command).not.toContain("printf");
    expect(command).not.toContain("printenv");
    expect(command).toContain("print '__PIEDPIPER_ENV_PATH_START__'");
    expect(command).toContain("print '__PIEDPIPER_ENV___MISE_DIFF_END__'");
    expect(command).toContain("$env.ENV_CONVERSIONS?.PATH?.to_string? != null");
    expect(command).toContain("str join (char esep)");
    expect(command).toContain("path expand --no-symlink");
    expect(command).toContain("$env.__MISE_DIFF? | default ''");
  });

  it("passes the Nushell command to the probe and parses its markers", () => {
    const execFile = vi.fn<ExecFileSyncLike>(() =>
      [
        "startup noise",
        "__PIEDPIPER_ENV_PATH_START__",
        "/nu/bin:/usr/bin",
        "__PIEDPIPER_ENV_PATH_END__",
      ].join("\n"),
    );
    expect(readEnvironmentFromLoginShell("/opt/homebrew/bin/nu", ["PATH"], execFile)).toEqual({
      PATH: "/nu/bin:/usr/bin",
    });
    const args = execFile.mock.calls[0]?.[1];
    expect(args?.[0]).toBe("-ilc");
    expect(args?.[1]).toContain("print '__PIEDPIPER_ENV_PATH_START__'");
  });

  it("rejects unsafe variable names for Nushell too", () => {
    expect(() => buildLoginShellEnvironmentCaptureCommand("/usr/bin/nu", ["PATH }"])).toThrow(
      /Unsupported environment variable name/,
    );
  });
});

describe("readEnvironmentFromLoginShellCandidates", () => {
  it("passes the probe timeout through to execFile", () => {
    const execFile = vi.fn<ExecFileSyncLike>(() => "");
    readEnvironmentFromLoginShell("/bin/zsh", ["PATH"], execFile, 1234);
    expect(execFile.mock.calls[0]?.[2].timeout).toBe(1234);
  });

  it("returns the first shell that reports PATH without merging earlier results", () => {
    const readEnvironment = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("ETIMEDOUT");
      })
      .mockImplementationOnce(() => ({ __MISE_DIFF: "stale" }))
      .mockImplementationOnce(() => ({ PATH: "/a" }));
    const onProbeError = vi.fn();

    expect(
      readEnvironmentFromLoginShellCandidates(["/a/nu", "/bin/zsh", "/bin/bash"], ["PATH"], {
        readEnvironment,
        onProbeError,
      }),
    ).toEqual({ PATH: "/a" });
    expect(onProbeError).toHaveBeenCalledWith("/a/nu", expect.any(Error));
  });

  it("clamps each probe to the remaining budget and stops once it is spent", () => {
    let clock = 0;
    const readEnvironment = vi.fn<ShellEnvironmentReader>(() => {
      clock += 4000;
      return {};
    });

    expect(
      readEnvironmentFromLoginShellCandidates(["/a", "/b", "/c", "/d"], ["PATH"], {
        readEnvironment,
        budgetMs: 10_000,
        now: () => clock,
      }),
    ).toEqual({});
    expect(readEnvironment.mock.calls.map((call) => [call[0], call[3]])).toEqual([
      ["/a", 5000],
      ["/b", 5000],
      ["/c", 2000],
    ]);
  });
});

describe("resolveLoginShell", () => {
  it("prefers the trimmed $SHELL and falls back to the platform default", () => {
    expect(resolveLoginShell("darwin", " /opt/homebrew/bin/fish ")).toBe("/opt/homebrew/bin/fish");
    expect(resolveLoginShell("darwin", "  ")).toBe("/bin/zsh");
    expect(resolveLoginShell("linux", undefined)).toBe("/bin/bash");
    expect(resolveLoginShell("win32", undefined)).toBeUndefined();
  });
});

describe("listLoginShellCandidates", () => {
  it("returns $SHELL, the passwd shell, then zsh and bash on macOS without duplicates", () => {
    expect(listLoginShellCandidates("darwin", " /opt/homebrew/bin/nu ", "/bin/zsh")).toEqual([
      "/opt/homebrew/bin/nu",
      "/bin/zsh",
      "/bin/bash",
    ]);
  });

  it("orders the platform fallbacks for linux and skips blank shells", () => {
    expect(listLoginShellCandidates("linux", undefined, "")).toEqual(["/bin/bash", "/bin/zsh"]);
    expect(listLoginShellCandidates("linux", "  ", "/usr/bin/fish")).toEqual([
      "/usr/bin/fish",
      "/bin/bash",
      "/bin/zsh",
    ]);
  });

  it("returns nothing on unsupported platforms without a shell hint", () => {
    expect(listLoginShellCandidates("win32", undefined, "")).toEqual([]);
  });
});

describe("mergePathEntries", () => {
  it("prefers login-shell PATH entries and keeps inherited extras", () => {
    expect(
      mergePathEntries("/opt/homebrew/bin:/usr/bin", "/Users/test/.local/bin:/usr/bin", "darwin"),
    ).toBe("/opt/homebrew/bin:/usr/bin:/Users/test/.local/bin");
  });

  it("drops blank entries and deduplicates within a single PATH", () => {
    expect(mergePathEntries("/a::/b:/a: /c ", undefined, "linux")).toBe("/a:/b:/c");
  });

  it("falls back to the inherited PATH when the preferred one is missing", () => {
    expect(mergePathEntries(undefined, "/usr/bin:/bin", "darwin")).toBe("/usr/bin:/bin");
    expect(mergePathEntries(undefined, undefined, "darwin")).toBeUndefined();
  });

  it("uses the platform-specific delimiter", () => {
    expect(
      mergePathEntries("C:\\tools;C:\\Windows", "C:\\Windows;C:\\Users\\me\\bin", "win32"),
    ).toBe("C:\\tools;C:\\Windows;C:\\Users\\me\\bin");
  });
});

const filesIn =
  (...files: string[]) =>
  (filePath: string) =>
    files.includes(filePath);

describe("resolveGitExecutable", () => {
  it("replaces the macOS xcrun shim with the git xcrun finds", () => {
    const locateXcodeGit = vi.fn(() => "/Library/Developer/CommandLineTools/usr/bin/git");
    expect(
      resolveGitExecutable({
        platform: "darwin",
        env: { PATH: "/usr/local/nope:/usr/bin:/bin", DEVELOPER_DIR: "/dev" },
        isFile: filesIn("/usr/bin/git", "/Library/Developer/CommandLineTools/usr/bin/git"),
        locateXcodeGit,
      }),
    ).toBe("/Library/Developer/CommandLineTools/usr/bin/git");
    expect(locateXcodeGit).toHaveBeenCalledWith({
      PATH: "/usr/local/nope:/usr/bin:/bin",
      DEVELOPER_DIR: "/dev",
    });
  });

  it("keeps a git the user put ahead of the macOS shim", () => {
    const locateXcodeGit = vi.fn(() => "/Library/Developer/CommandLineTools/usr/bin/git");
    expect(
      resolveGitExecutable({
        platform: "darwin",
        env: { PATH: "/opt/homebrew/bin:/usr/bin" },
        isFile: filesIn("/opt/homebrew/bin/git", "/usr/bin/git"),
        locateXcodeGit,
      }),
    ).toBe("git");
    expect(locateXcodeGit).not.toHaveBeenCalled();
  });

  it("falls back to plain git when xcrun fails or names a missing binary", () => {
    const base = { platform: "darwin" as const, env: { PATH: "/usr/bin" } };
    expect(
      resolveGitExecutable({
        ...base,
        isFile: filesIn("/usr/bin/git"),
        locateXcodeGit: () => undefined,
      }),
    ).toBe("git");
    expect(
      resolveGitExecutable({
        ...base,
        isFile: filesIn("/usr/bin/git"),
        locateXcodeGit: () => "/Applications/Xcode.app/Contents/Developer/usr/bin/git",
      }),
    ).toBe("git");
  });

  it("swaps the Git for Windows launcher for the real git.exe", () => {
    expect(
      resolveGitExecutable({
        platform: "win32",
        env: { Path: 'C:\\Windows\\system32;"C:\\Program Files\\Git\\cmd"' },
        isFile: filesIn(
          "C:\\Program Files\\Git\\cmd\\git.exe",
          "C:\\Program Files\\Git\\mingw64\\bin\\git.exe",
        ),
      }),
    ).toBe("C:\\Program Files\\Git\\mingw64\\bin\\git.exe");
  });

  it("keeps the Windows launcher when MSYSTEM is set or no real binary exists", () => {
    const isFile = filesIn(
      "C:\\Git\\cmd\\git.exe",
      "C:\\Git\\ucrt64\\bin\\git.exe",
      "C:\\Other\\git.exe",
    );
    expect(
      resolveGitExecutable({
        platform: "win32",
        env: { PATH: "C:\\Git\\cmd", MSYSTEM: "MINGW64" },
        isFile,
      }),
    ).toBe("git");
    expect(resolveGitExecutable({ platform: "win32", env: { PATH: "C:\\Other" }, isFile })).toBe(
      "git",
    );
    expect(preferGitForWindowsBinary("C:\\Git\\cmd\\git.exe", {}, isFile)).toBe(
      "C:\\Git\\ucrt64\\bin\\git.exe",
    );
  });

  it("swaps the portable bin launcher and the clangarm64 build", () => {
    expect(
      preferGitForWindowsBinary(
        "D:\\PortableGit\\bin\\git.exe",
        {},
        filesIn("D:\\PortableGit\\bin\\git.exe", "D:\\PortableGit\\mingw64\\bin\\git.exe"),
      ),
    ).toBe("D:\\PortableGit\\mingw64\\bin\\git.exe");
    expect(
      preferGitForWindowsBinary(
        "C:\\Git\\cmd\\git.exe",
        {},
        filesIn("C:\\Git\\cmd\\git.exe", "C:\\Git\\clangarm64\\bin\\git.exe"),
      ),
    ).toBe("C:\\Git\\clangarm64\\bin\\git.exe");
  });

  it("leaves other launchers and shims untouched", () => {
    const isFile = () => true;
    expect(preferGitForWindowsBinary("C:\\Git\\cmd\\gitk.exe", {}, isFile)).toBe(
      "C:\\Git\\cmd\\gitk.exe",
    );
    expect(preferGitForWindowsBinary("C:\\Users\\me\\scoop\\shims\\git.exe", {}, isFile)).toBe(
      "C:\\Users\\me\\scoop\\shims\\git.exe",
    );
  });

  it("does no lookup on Linux", () => {
    const isFile = vi.fn(() => true);
    expect(resolveGitExecutable({ platform: "linux", env: { PATH: "/usr/bin" }, isFile })).toBe(
      "git",
    );
    expect(isFile).not.toHaveBeenCalled();
  });

  it("finds the first PATH entry holding the file and skips relative entries", () => {
    expect(
      findFileOnPath("git", "darwin", { PATH: "bin:/a:/b" }, filesIn("bin/git", "/b/git")),
    ).toBe("/b/git");
  });
});

describe("resolveGitExecutableCached", () => {
  it("runs xcrun once per PATH and looks again when the cached binary disappears", () => {
    clearGitExecutableCache();
    const files = new Set(["/usr/bin/git", "/CLT/usr/bin/git"]);
    const isFile = (filePath: string) => files.has(filePath);
    const locateXcodeGit = vi.fn(() =>
      files.has("/CLT/usr/bin/git") ? "/CLT/usr/bin/git" : undefined,
    );
    const options = {
      platform: "darwin" as const,
      env: { PATH: "/usr/bin" },
      isFile,
      locateXcodeGit,
    };

    expect(resolveGitExecutableCached(options)).toBe("/CLT/usr/bin/git");
    expect(resolveGitExecutableCached(options)).toBe("/CLT/usr/bin/git");
    expect(locateXcodeGit).toHaveBeenCalledTimes(1);

    files.delete("/CLT/usr/bin/git");
    expect(resolveGitExecutableCached(options)).toBe("git");
    expect(resolveGitExecutableCached(options)).toBe("git");
    expect(locateXcodeGit).toHaveBeenCalledTimes(2);
    clearGitExecutableCache();
  });

  it("retries a failed xcrun lookup and follows a new xcode-select choice once the entry expires", () => {
    clearGitExecutableCache();
    let clock = 0;
    let located: string | undefined;
    const locateXcodeGit = vi.fn(() => located);
    const options = {
      platform: "darwin" as const,
      env: { PATH: "/usr/bin" },
      isFile: filesIn("/usr/bin/git", "/Xcode/usr/bin/git", "/XcodeBeta/usr/bin/git"),
      locateXcodeGit,
      now: () => clock,
    };

    expect(resolveGitExecutableCached(options)).toBe("git");
    located = "/Xcode/usr/bin/git";
    clock = 29_000;
    expect(resolveGitExecutableCached(options)).toBe("git");
    expect(locateXcodeGit).toHaveBeenCalledTimes(1);

    clock = 30_000;
    expect(resolveGitExecutableCached(options)).toBe("/Xcode/usr/bin/git");
    located = "/XcodeBeta/usr/bin/git";
    clock = 60_000;
    expect(resolveGitExecutableCached(options)).toBe("/XcodeBeta/usr/bin/git");
    expect(locateXcodeGit).toHaveBeenCalledTimes(3);
    clearGitExecutableCache();
  });

  it("keeps launcher swaps apart for environments with and without MSYSTEM", () => {
    clearGitExecutableCache();
    const isFile = filesIn("C:\\Git\\cmd\\git.exe", "C:\\Git\\mingw64\\bin\\git.exe");
    const base = { platform: "win32" as const, isFile };

    expect(resolveGitExecutableCached({ ...base, env: { PATH: "C:\\Git\\cmd" } })).toBe(
      "C:\\Git\\mingw64\\bin\\git.exe",
    );
    expect(
      resolveGitExecutableCached({ ...base, env: { PATH: "C:\\Git\\cmd", MSYSTEM: "MINGW64" } }),
    ).toBe("git");
    clearGitExecutableCache();
  });
});

describe("mergePathEntries on Windows", () => {
  it("deduplicates case-insensitively and ignores wrapping quotes", () => {
    expect(mergePathEntries("C:\\Tools;C:\\Node", '"c:\\tools";C:\\NODE;C:\\Extra', "win32")).toBe(
      "C:\\Tools;C:\\Node;C:\\Extra",
    );
  });
});

describe("Windows environment helpers", () => {
  it("lists the well-known CLI install dirs", () => {
    expect(
      resolveKnownWindowsCliDirs({
        APPDATA: "C:\\Users\\a\\AppData\\Roaming",
        LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local",
        USERPROFILE: "C:\\Users\\a",
      }),
    ).toEqual([
      "C:\\Users\\a\\AppData\\Roaming\\npm",
      "C:\\Users\\a\\AppData\\Local\\Programs\\nodejs",
      "C:\\Users\\a\\AppData\\Local\\Volta\\bin",
      "C:\\Users\\a\\AppData\\Local\\pnpm",
      "C:\\Users\\a\\.bun\\bin",
      "C:\\Users\\a\\scoop\\shims",
      "C:\\Users\\a\\.local\\bin",
    ]);
    expect(resolveKnownWindowsCliDirs({})).toEqual([]);
  });

  it("keeps a single PATH spelling", () => {
    const env: NodeJS.ProcessEnv = { Path: "C:\\Old", Other: "x" };
    setWindowsPath(env, "C:\\New");
    expect(env).toEqual({ PATH: "C:\\New", Other: "x" });
  });

  it("applies a patch and reports whether anything changed", () => {
    const env: NodeJS.ProcessEnv = { Path: "C:\\Same" };
    expect(applyWindowsEnvironmentPatch(env, { PATH: "C:\\Same" })).toBe(false);
    expect(applyWindowsEnvironmentPatch(env, { PATH: "C:\\New", FNM_DIR: "C:\\fnm" })).toBe(true);
    expect(env).toEqual({ PATH: "C:\\New", FNM_DIR: "C:\\fnm" });
  });

  it("builds registry and profile probes", () => {
    const registryArgs = buildWindowsEnvironmentProbeArgs(["PATH"], {
      scope: "registry",
      loadProfile: false,
    });
    expect(registryArgs.slice(0, 4)).toEqual([
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
    ]);
    expect(registryArgs[4]).toContain("GetEnvironmentVariable('PATH', 'Machine')");
    expect(registryArgs[4]).toContain("GetEnvironmentVariable('PATH', 'User')");

    const profileArgs = buildWindowsEnvironmentProbeArgs(["FNM_DIR"], {
      scope: "process",
      loadProfile: true,
    });
    expect(profileArgs).not.toContain("-NoProfile");
    expect(profileArgs.at(-1)).toContain("GetEnvironmentVariable('FNM_DIR')");
    expect(() =>
      buildWindowsEnvironmentProbeArgs(["PATH; rm"], { scope: "process", loadProfile: false }),
    ).toThrow("Unsupported environment variable name");
  });
});

const windowsProbeOutput = (values: Record<string, string>) =>
  Object.entries(values)
    .map(
      ([name, value]) =>
        `__PIEDPIPER_ENV_${name}_START__\r\n${value}\r\n__PIEDPIPER_ENV_${name}_END__\r\n`,
    )
    .join("");

describe("resolveWindowsEnvironment", () => {
  const env: NodeJS.ProcessEnv = {
    Path: "C:\\Windows;C:\\Stale",
    APPDATA: "C:\\Users\\a\\AppData\\Roaming",
  };

  it("adds the persisted PATH and known CLI dirs without a profile probe when node resolves", async () => {
    const calls: Array<{ shell: string; args: ReadonlyArray<string> }> = [];
    const runProbe: WindowsShellProbeRunner = async (shell, args) => {
      calls.push({ shell, args });
      return windowsProbeOutput({ PATH: "c:\\windows;C:\\Program Files\\GitHub CLI" });
    };

    const patch = await resolveWindowsEnvironment(env, {
      runProbe,
      commandAvailable: () => true,
    });

    expect(patch).toEqual({
      PATH: "c:\\windows;C:\\Program Files\\GitHub CLI;C:\\Stale;C:\\Users\\a\\AppData\\Roaming\\npm",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toContain("-NoProfile");
  });

  it("falls back to a profile-loading probe for PATH and fnm when node is missing", async () => {
    const runProbe: WindowsShellProbeRunner = async (shell, args) => {
      if (shell === "pwsh.exe") {
        throw Object.assign(new Error("spawn pwsh.exe ENOENT"), { code: "ENOENT" });
      }
      return args.includes("-NoProfile")
        ? windowsProbeOutput({ PATH: "C:\\Windows" })
        : windowsProbeOutput({
            PATH: "C:\\fnm\\multishell\\1;C:\\Windows",
            FNM_DIR: "C:\\fnm",
            FNM_MULTISHELL_PATH: "C:\\fnm\\multishell\\1",
          });
    };
    const shellsTried: string[] = [];
    const patch = await resolveWindowsEnvironment(env, {
      runProbe: (shell, args, timeoutMs) => {
        shellsTried.push(shell);
        return runProbe(shell, args, timeoutMs);
      },
      commandAvailable: () => false,
    });

    expect(patch).toEqual({
      PATH: "C:\\fnm\\multishell\\1;C:\\Windows;C:\\Stale;C:\\Users\\a\\AppData\\Roaming\\npm",
      FNM_DIR: "C:\\fnm",
      FNM_MULTISHELL_PATH: "C:\\fnm\\multishell\\1",
    });
    // The missing pwsh is not retried for the profile probe.
    expect(shellsTried).toEqual(["pwsh.exe", "powershell.exe", "powershell.exe"]);
  });

  it("keeps the inherited PATH plus known dirs when every probe fails, within the budget", async () => {
    let clock = 0;
    const timeouts: number[] = [];
    const errors: string[] = [];
    const patch = await resolveWindowsEnvironment(env, {
      runProbe: async (_shell, _args, timeoutMs) => {
        timeouts.push(timeoutMs);
        clock += timeoutMs;
        throw new Error("timed out");
      },
      commandAvailable: () => false,
      budgetMs: 7000,
      now: () => clock,
      onProbeError: (shell) => errors.push(shell),
    });

    expect(patch).toEqual({ PATH: "C:\\Windows;C:\\Stale;C:\\Users\\a\\AppData\\Roaming\\npm" });
    expect(timeouts).toEqual([5000, 2000]);
    expect(errors).toEqual(["pwsh.exe", "powershell.exe"]);
  });

  it("runs the profile probe with the repaired PATH", async () => {
    const probeEnvs: Array<string | undefined> = [];
    await resolveWindowsEnvironment(env, {
      runProbe: async (_shell, args, _timeoutMs, probeEnv) => {
        probeEnvs.push(probeEnv?.PATH ?? probeEnv?.Path);
        return args.includes("-NoProfile")
          ? windowsProbeOutput({ PATH: "C:\\Users\\a\\fnm" })
          : windowsProbeOutput({ PATH: "C:\\Windows" });
      },
      commandAvailable: () => false,
    });

    expect(probeEnvs).toEqual([
      "C:\\Windows;C:\\Stale",
      "C:\\Users\\a\\fnm;C:\\Windows;C:\\Stale;C:\\Users\\a\\AppData\\Roaming\\npm",
    ]);
  });

  it("gives up on a probe that never settles once the budget is spent", async () => {
    const startedAt = Date.now();
    const patch = await resolveWindowsEnvironment(env, {
      runProbe: () => new Promise<string>(() => {}),
      commandAvailable: () => false,
      budgetMs: 100,
    });

    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(patch).toEqual({ PATH: "C:\\Windows;C:\\Stale;C:\\Users\\a\\AppData\\Roaming\\npm" });
  });
});

describe("runWindowsShellProbe", () => {
  it.skipIf(process.platform === "win32")(
    "settles on its own timer while a child process keeps stdout open",
    async () => {
      const startedAt = Date.now();
      // The shell exits at once but leaves a background sleep holding the stdout pipe.
      const output = await runWindowsShellProbe("/bin/sh", ["-c", "echo ready; sleep 5 &"], 5_000);
      expect(output).toBe("ready\n");
      expect(Date.now() - startedAt).toBeLessThan(3_000);
    },
  );

  it.skipIf(process.platform === "win32")("rejects after the timeout", async () => {
    await expect(runWindowsShellProbe("/bin/sh", ["-c", "sleep 30"], 100)).rejects.toThrow(
      "timed out",
    );
  });

  it.skipIf(process.platform === "win32")("passes the given environment", async () => {
    const output = await runWindowsShellProbe("/bin/sh", ["-c", 'printf "$PROBE_VALUE"'], 5_000, {
      PROBE_VALUE: "from-env",
      PATH: process.env.PATH,
    });
    expect(output).toBe("from-env");
  });
});
