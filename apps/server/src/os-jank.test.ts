import type { ShellEnvironmentReader } from "@piedpiper/shared/shell";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect } from "effect";
import { isAbsolute } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  expandHomePathForPlatform,
  fixPath,
  hydratePosixHome,
  resolveBaseDir,
  resolveUserHomeDir,
} from "./os-jank";

const noop = () => undefined;
const readJavaHomeShellEnvironment = () => ({
  PATH: "/opt/homebrew/bin:/usr/bin",
  JAVA_HOME: "/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home",
});

describe("fixPath", () => {
  it("merges the login shell PATH ahead of inherited entries on linux", () => {
    const env: NodeJS.ProcessEnv = {
      SHELL: "/bin/zsh",
      PATH: "/Users/test/.local/bin:/usr/bin",
    };
    const readPath = vi.fn(() => "/opt/homebrew/bin:/usr/bin");

    fixPath({ env, platform: "linux", readPath, userShell: "/bin/zsh" });

    expect(readPath).toHaveBeenCalledTimes(1);
    expect(readPath).toHaveBeenCalledWith("/bin/zsh");
    expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin:/Users/test/.local/bin");
  });

  it("tries the next shell after a failed probe and falls back to launchctl on macOS", () => {
    const env: NodeJS.ProcessEnv = {
      SHELL: "/opt/homebrew/bin/nu",
      PATH: "/usr/bin",
    };
    const readPath = vi
      .fn<(shell: string) => string | undefined>()
      .mockImplementationOnce(() => {
        throw new Error("spawnSync /opt/homebrew/bin/nu ETIMEDOUT");
      })
      .mockImplementation(() => undefined);
    const readLaunchctlPath = vi.fn(() => "/opt/homebrew/bin:/usr/bin");
    const logWarning = vi.fn();

    fixPath({
      env,
      platform: "darwin",
      readPath,
      readLaunchctlPath,
      userShell: "/bin/zsh",
      logWarning,
    });

    expect(readPath.mock.calls.map(([shell]) => shell)).toEqual([
      "/opt/homebrew/bin/nu",
      "/bin/zsh",
      "/bin/bash",
    ]);
    expect(readLaunchctlPath).toHaveBeenCalledTimes(1);
    expect(logWarning).toHaveBeenCalledWith(
      "Failed to read PATH from login shell /opt/homebrew/bin/nu.",
      expect.any(Error),
    );
    expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin");
  });

  it("keeps the inherited PATH and warns when no source provides one", () => {
    const env: NodeJS.ProcessEnv = { SHELL: "/bin/zsh", PATH: "/usr/bin:/bin" };
    const logWarning = vi.fn();

    fixPath({
      env,
      platform: "darwin",
      readPath: () => {
        throw new Error("ETIMEDOUT");
      },
      readLaunchctlPath: noop,
      userShell: "/bin/zsh",
      logWarning,
    });

    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(logWarning).toHaveBeenCalledWith(
      "No login shell or launchctl PATH was found; keeping the inherited PATH.",
    );
  });

  it("forwards __MISE_DIFF only when PATH came from the login shell", () => {
    const env: NodeJS.ProcessEnv = { SHELL: "/bin/zsh", PATH: "/usr/bin" };
    const readEnvironment = vi.fn(() => ({
      PATH: "/Users/test/.local/share/mise/shims:/usr/bin",
      __MISE_DIFF: "mise-diff-blob",
    }));

    fixPath({ env, platform: "linux", readEnvironment, userShell: "/bin/zsh" });

    expect(readEnvironment.mock.calls[0]?.slice(0, 2)).toEqual([
      "/bin/zsh",
      ["PATH", "__MISE_DIFF", "JAVA_HOME"],
    ]);
    expect(env.PATH).toBe("/Users/test/.local/share/mise/shims:/usr/bin");
    expect(env.__MISE_DIFF).toBe("mise-diff-blob");

    const launchctlEnv: NodeJS.ProcessEnv = { SHELL: "/bin/zsh", PATH: "/usr/bin" };
    fixPath({
      env: launchctlEnv,
      platform: "darwin",
      readEnvironment: () => ({ __MISE_DIFF: "stale" }),
      readLaunchctlPath: () => "/opt/homebrew/bin",
      userShell: "/bin/zsh",
      logWarning: noop,
    });
    expect(launchctlEnv.PATH).toBe("/opt/homebrew/bin:/usr/bin");
    expect(launchctlEnv.__MISE_DIFF).toBeUndefined();
  });

  it("imports JAVA_HOME from the login shell only when it is unset", () => {
    const readEnvironment = readJavaHomeShellEnvironment;

    const env: NodeJS.ProcessEnv = { SHELL: "/bin/zsh", PATH: "/usr/bin" };
    fixPath({ env, platform: "darwin", readEnvironment, userShell: "/bin/zsh" });
    expect(env.JAVA_HOME).toBe("/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home");

    const inherited: NodeJS.ProcessEnv = {
      SHELL: "/bin/zsh",
      PATH: "/usr/bin",
      JAVA_HOME: "/Library/Java/JavaVirtualMachines/custom/Contents/Home",
    };
    fixPath({ env: inherited, platform: "darwin", readEnvironment, userShell: "/bin/zsh" });
    expect(inherited.JAVA_HOME).toBe("/Library/Java/JavaVirtualMachines/custom/Contents/Home");
  });

  it("stops probing further shells once the probe budget is spent", () => {
    const env: NodeJS.ProcessEnv = { SHELL: "/opt/homebrew/bin/fish", PATH: "/usr/bin" };
    let clock = 0;
    const readEnvironment = vi.fn<ShellEnvironmentReader>(() => {
      clock += 5000;
      throw new Error("ETIMEDOUT");
    });
    const readLaunchctlPath = vi.fn(() => "/opt/homebrew/bin");

    fixPath({
      env,
      platform: "darwin",
      readEnvironment,
      readLaunchctlPath,
      userShell: "/bin/zsh",
      probeBudgetMs: 8000,
      now: () => clock,
      logWarning: noop,
    });

    expect(readEnvironment.mock.calls.map((call) => [call[0], call[3]])).toEqual([
      ["/opt/homebrew/bin/fish", 5000],
      ["/bin/zsh", 3000],
    ]);
    expect(readLaunchctlPath).toHaveBeenCalledTimes(1);
    expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin");
  });

  it("does nothing outside macOS and linux even when SHELL is set", () => {
    const env: NodeJS.ProcessEnv = {
      SHELL: "C:/Program Files/Git/bin/bash.exe",
      PATH: "C:\\Windows\\System32",
    };
    const readPath = vi.fn(() => "/usr/local/bin:/usr/bin");

    fixPath({ env, platform: "win32", readPath });

    expect(readPath).not.toHaveBeenCalled();
    expect(env.PATH).toBe("C:\\Windows\\System32");
  });
});

describe("hydratePosixHome", () => {
  it("fills a missing or blank HOME from the user account", () => {
    const missing: NodeJS.ProcessEnv = {};
    hydratePosixHome(missing, () => "/home/svc");
    expect(missing.HOME).toBe("/home/svc");

    const blank: NodeJS.ProcessEnv = { HOME: " " };
    hydratePosixHome(blank, () => "/home/svc");
    expect(blank.HOME).toBe("/home/svc");
  });

  it("keeps an explicitly configured HOME without looking up the account", () => {
    const env: NodeJS.ProcessEnv = { HOME: "/custom/home" };
    const resolveHomeDir = vi.fn(() => "/home/svc");

    hydratePosixHome(env, resolveHomeDir);

    expect(resolveHomeDir).not.toHaveBeenCalled();
    expect(env.HOME).toBe("/custom/home");
  });

  it("fixPath warns and still hydrates PATH when the account lookup throws", () => {
    const env: NodeJS.ProcessEnv = { SHELL: "/bin/zsh", PATH: "/usr/bin" };
    const logWarning = vi.fn();

    fixPath({
      env,
      platform: "linux",
      readPath: () => "/opt/bin:/usr/bin",
      userShell: "/bin/zsh",
      resolveHomeDir: () => {
        throw new Error("no passwd entry");
      },
      logWarning,
    });

    expect(env.HOME).toBeUndefined();
    expect(logWarning).toHaveBeenCalledWith(
      "Failed to hydrate HOME from the user account.",
      expect.any(Error),
    );
    expect(env.PATH).toBe("/opt/bin:/usr/bin");
  });

  it("fixPath leaves HOME alone outside macOS and linux", () => {
    const env: NodeJS.ProcessEnv = {};
    fixPath({ env, platform: "win32", resolveHomeDir: () => "/home/svc" });
    expect(env.HOME).toBeUndefined();
  });
});

describe("resolveUserHomeDir", () => {
  it("falls back to the account home only when HOME resolves blank", () => {
    expect(
      resolveUserHomeDir(
        () => "/home/me",
        () => "/home/svc",
      ),
    ).toBe("/home/me");
    expect(
      resolveUserHomeDir(
        () => "",
        () => "/home/svc",
      ),
    ).toBe("/home/svc");
    expect(
      resolveUserHomeDir(
        () => "",
        () => {
          throw new Error("no passwd entry");
        },
      ),
    ).toBe("");
  });

  it.skipIf(process.platform === "win32")(
    "keeps the default base dir absolute when HOME is set but empty",
    async () => {
      const previous = process.env.HOME;
      process.env.HOME = "";
      try {
        const baseDir = await Effect.runPromise(
          resolveBaseDir(undefined).pipe(Effect.provide(NodeServices.layer)),
        );
        expect(isAbsolute(baseDir)).toBe(true);
        expect(baseDir.endsWith(".piedpiper")).toBe(true);
      } finally {
        if (previous === undefined) delete process.env.HOME;
        else process.env.HOME = previous;
      }
    },
  );
});

describe("expandHomePathForPlatform", () => {
  it("expands a leading ~/ and keeps a position suffix", () => {
    expect(expandHomePathForPlatform("~", "linux", "/home/me")).toBe("/home/me");
    expect(expandHomePathForPlatform("~/a.ts:3:1", "linux", "/home/me")).toBe("/home/me/a.ts:3:1");
    expect(expandHomePathForPlatform("~/a.ts", "darwin", "/Users/me/")).toBe("/Users/me/a.ts");
  });

  it("uses Windows separators on Windows and treats ~\\ as home only there", () => {
    expect(expandHomePathForPlatform("~/a/b.ts:3", "win32", "C:\\Users\\me")).toBe(
      "C:\\Users\\me\\a\\b.ts:3",
    );
    expect(expandHomePathForPlatform("~\\a.ts", "win32", "C:\\Users\\me")).toBe(
      "C:\\Users\\me\\a.ts",
    );
    expect(expandHomePathForPlatform("~\\a.ts", "linux", "/home/me")).toBe("~\\a.ts");
  });

  it("stays inside home when the rest starts with another slash", () => {
    expect(expandHomePathForPlatform("~//host/share", "win32", "C:\\Users\\me")).toBe(
      "C:\\Users\\me\\host\\share",
    );
  });

  it("leaves other paths and an unknown home alone", () => {
    for (const input of ["/tmp/a", "a/b", "foo~/x", "~other/x"]) {
      expect(expandHomePathForPlatform(input, "linux", "/home/me")).toBe(input);
    }
    expect(expandHomePathForPlatform("~/a", "linux", " ")).toBe("~/a");
  });

  it("resolves home only for a tilde path and survives a resolver that throws", () => {
    const throwing = vi.fn((): string => {
      throw new Error("no home");
    });
    for (const input of ["/abs/path", "a/b", "~other/x", "~\\a"]) {
      expect(expandHomePathForPlatform(input, "linux", throwing)).toBe(input);
    }
    expect(throwing).not.toHaveBeenCalled();
    for (const input of ["~", "~/a"]) {
      expect(expandHomePathForPlatform(input, "linux", throwing)).toBe(input);
    }
    expect(throwing).toHaveBeenCalledTimes(2);
  });
});
