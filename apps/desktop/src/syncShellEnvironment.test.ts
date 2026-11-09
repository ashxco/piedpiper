import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import type { ShellEnvironmentReader } from "@piedpiper/shared/shell";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LOGIN_SHELL_ENV_NAMES,
  createShellEnvironmentSync,
  readEnvironmentFromLoginShellAsync,
  readEnvironmentFromLoginShellCandidatesAsync,
  readShellEnvironmentCache,
  shellEnvironmentCacheKey,
  syncShellEnvironment,
  writeShellEnvironmentCache,
} from "./syncShellEnvironment";

const noop = () => undefined;

describe("syncShellEnvironment", () => {
  it("merges the login shell PATH ahead of inherited entries and fills SSH_AUTH_SOCK on macOS", () => {
    const env: NodeJS.ProcessEnv = {
      SHELL: "/bin/zsh",
      PATH: "/Users/test/.local/bin:/usr/bin",
      LANG: "en_US.UTF-8",
    };
    const readEnvironment = vi.fn(() => ({
      PATH: "/opt/homebrew/bin:/usr/bin",
      SSH_AUTH_SOCK: "/tmp/secretive.sock",
    }));

    syncShellEnvironment(env, {
      platform: "darwin",
      readEnvironment,
      userShell: "/bin/zsh",
      readLaunchctlPath: noop,
    });

    expect(readEnvironment).toHaveBeenCalledTimes(1);
    expect(readEnvironment.mock.calls[0]?.slice(0, 2)).toEqual(["/bin/zsh", LOGIN_SHELL_ENV_NAMES]);
    expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin:/Users/test/.local/bin");
    expect(env.SSH_AUTH_SOCK).toBe("/tmp/secretive.sock");
  });

  it("preserves an inherited SSH_AUTH_SOCK value", () => {
    const env: NodeJS.ProcessEnv = {
      SHELL: "/bin/zsh",
      PATH: "/usr/bin",
      SSH_AUTH_SOCK: "/tmp/inherited.sock",
    };
    const readEnvironment = vi.fn(() => ({
      PATH: "/opt/homebrew/bin:/usr/bin",
      SSH_AUTH_SOCK: "/tmp/login-shell.sock",
    }));

    syncShellEnvironment(env, { platform: "darwin", readEnvironment, readLaunchctlPath: noop });

    expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin");
    expect(env.SSH_AUTH_SOCK).toBe("/tmp/inherited.sock");
  });

  it("preserves inherited values when the login shell omits them", () => {
    const env: NodeJS.ProcessEnv = {
      SHELL: "/bin/zsh",
      PATH: "/usr/bin",
      SSH_AUTH_SOCK: "/tmp/inherited.sock",
    };
    const readEnvironment = vi.fn(() => ({ PATH: "/opt/homebrew/bin:/usr/bin" }));

    syncShellEnvironment(env, { platform: "darwin", readEnvironment, readLaunchctlPath: noop });

    expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin");
    expect(env.SSH_AUTH_SOCK).toBe("/tmp/inherited.sock");
  });

  it("hydrates PATH and missing SSH_AUTH_SOCK from the login shell on linux", () => {
    const env: NodeJS.ProcessEnv = {
      SHELL: "/bin/zsh",
      PATH: "/usr/bin",
    };
    const readEnvironment = vi.fn(() => ({
      PATH: "/home/linuxbrew/.linuxbrew/bin:/usr/bin",
      SSH_AUTH_SOCK: "/tmp/secretive.sock",
    }));
    const readLaunchctlPath = vi.fn(noop);

    syncShellEnvironment(env, { platform: "linux", readEnvironment, readLaunchctlPath });

    expect(readEnvironment.mock.calls[0]?.slice(0, 2)).toEqual(["/bin/zsh", LOGIN_SHELL_ENV_NAMES]);
    expect(readLaunchctlPath).not.toHaveBeenCalled();
    expect(env.PATH).toBe("/home/linuxbrew/.linuxbrew/bin:/usr/bin");
    expect(env.SSH_AUTH_SOCK).toBe("/tmp/secretive.sock");
  });

  it("tries the next shell after a timed-out probe and falls back to launchctl on macOS", () => {
    const env: NodeJS.ProcessEnv = {
      SHELL: "/opt/homebrew/bin/nu",
      PATH: "/usr/bin",
    };
    const readEnvironment = vi
      .fn<(shell: string, names: ReadonlyArray<string>) => Partial<Record<string, string>>>()
      .mockImplementationOnce(() => {
        throw new Error("spawnSync /opt/homebrew/bin/nu ETIMEDOUT");
      })
      .mockImplementationOnce(() => ({}))
      .mockImplementationOnce(() => ({}));
    const readLaunchctlPath = vi.fn(() => "/opt/homebrew/bin:/usr/bin");
    const logWarning = vi.fn();

    syncShellEnvironment(env, {
      platform: "darwin",
      readEnvironment,
      readLaunchctlPath,
      userShell: "/bin/zsh",
      logWarning,
    });

    expect(readEnvironment.mock.calls.map(([shell]) => shell)).toEqual([
      "/opt/homebrew/bin/nu",
      "/bin/zsh",
      "/bin/bash",
    ]);
    expect(readLaunchctlPath).toHaveBeenCalledTimes(1);
    expect(logWarning).toHaveBeenCalledWith(
      "Failed to read login shell environment from /opt/homebrew/bin/nu.",
      expect.any(Error),
    );
    expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin");
  });

  it("keeps the inherited PATH and warns when every source fails", () => {
    const env: NodeJS.ProcessEnv = { SHELL: "/bin/zsh", PATH: "/usr/bin:/bin" };
    const readEnvironment = vi.fn(() => {
      throw new Error("ETIMEDOUT");
    });
    const logWarning = vi.fn();

    syncShellEnvironment(env, {
      platform: "darwin",
      readEnvironment,
      readLaunchctlPath: noop,
      userShell: "/bin/zsh",
      logWarning,
    });

    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(logWarning).toHaveBeenCalledWith(
      "No login shell or launchctl PATH was found; keeping the inherited PATH.",
    );
  });

  it("imports __MISE_DIFF only alongside a shell PATH and CA trust vars only when unset", () => {
    const env: NodeJS.ProcessEnv = {
      SHELL: "/bin/zsh",
      PATH: "/usr/bin",
      SSL_CERT_DIR: "/etc/inherited-certs",
    };
    const readEnvironment = vi.fn(() => ({
      PATH: "/Users/test/.local/share/mise/shims:/usr/bin",
      __MISE_DIFF: "mise-diff-blob",
      SSL_CERT_FILE: "/opt/homebrew/etc/ca-certificates/cert.pem",
      SSL_CERT_DIR: "/opt/homebrew/etc/certs",
      NODE_EXTRA_CA_CERTS: "/Users/test/corp-root.pem",
    }));

    syncShellEnvironment(env, { platform: "linux", readEnvironment });

    expect(env.__MISE_DIFF).toBe("mise-diff-blob");
    expect(env.SSL_CERT_FILE).toBe("/opt/homebrew/etc/ca-certificates/cert.pem");
    expect(env.SSL_CERT_DIR).toBe("/etc/inherited-certs");
    expect(env.NODE_EXTRA_CA_CERTS).toBe("/Users/test/corp-root.pem");
  });

  it("imports JAVA_HOME from the login shell only when the process has none", () => {
    const readEnvironment = vi.fn(() => ({
      PATH: "/usr/bin",
      JAVA_HOME: "/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home",
    }));
    expect(LOGIN_SHELL_ENV_NAMES).toContain("JAVA_HOME");

    const guiEnv: NodeJS.ProcessEnv = { SHELL: "/bin/zsh", PATH: "/usr/bin" };
    syncShellEnvironment(guiEnv, { platform: "darwin", readEnvironment, readLaunchctlPath: noop });
    expect(guiEnv.JAVA_HOME).toBe("/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home");

    const terminalEnv: NodeJS.ProcessEnv = {
      SHELL: "/bin/zsh",
      PATH: "/usr/bin",
      JAVA_HOME: "/usr/lib/jvm/java-21",
    };
    syncShellEnvironment(terminalEnv, { platform: "linux", readEnvironment });
    expect(terminalEnv.JAVA_HOME).toBe("/usr/lib/jvm/java-21");
  });

  it("imports the telemetry opt-out from the login shell unless the process already set it", () => {
    const readEnvironment = vi.fn(() => ({
      PATH: "/usr/bin",
      PIEDPIPER_TELEMETRY_ENABLED: "false",
    }));

    const guiEnv: NodeJS.ProcessEnv = { SHELL: "/bin/zsh", PATH: "/usr/bin" };
    syncShellEnvironment(guiEnv, { platform: "darwin", readEnvironment, readLaunchctlPath: noop });
    expect(LOGIN_SHELL_ENV_NAMES).toContain("PIEDPIPER_TELEMETRY_ENABLED");
    expect(guiEnv.PIEDPIPER_TELEMETRY_ENABLED).toBe("false");

    const terminalEnv: NodeJS.ProcessEnv = {
      SHELL: "/bin/zsh",
      PATH: "/usr/bin",
      PIEDPIPER_TELEMETRY_ENABLED: "true",
    };
    syncShellEnvironment(terminalEnv, { platform: "linux", readEnvironment });
    expect(terminalEnv.PIEDPIPER_TELEMETRY_ENABLED).toBe("true");
  });

  it("does not import __MISE_DIFF when PATH came from launchctl instead of the shell", () => {
    const env: NodeJS.ProcessEnv = { SHELL: "/bin/zsh", PATH: "/usr/bin" };
    const readEnvironment = vi.fn(() => ({ __MISE_DIFF: "stale" }));

    syncShellEnvironment(env, {
      platform: "darwin",
      readEnvironment,
      readLaunchctlPath: () => "/opt/homebrew/bin",
      userShell: "/bin/zsh",
      logWarning: noop,
    });

    expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin");
    expect(env.__MISE_DIFF).toBeUndefined();
  });

  it("imports the login shell locale on macOS when the process has none", () => {
    const env: NodeJS.ProcessEnv = { SHELL: "/bin/zsh", PATH: "/usr/bin" };
    const readEnvironment = vi.fn(() => ({
      PATH: "/usr/bin",
      LANG: "de_DE.UTF-8",
      LC_CTYPE: "de_DE.UTF-8",
    }));

    syncShellEnvironment(env, { platform: "darwin", readEnvironment, readLaunchctlPath: noop });

    expect(env.LANG).toBe("de_DE.UTF-8");
    expect(env.LC_CTYPE).toBe("de_DE.UTF-8");
    expect(env.LC_ALL).toBeUndefined();
  });

  it("falls back to a UTF-8 LC_CTYPE on macOS when neither process nor shell set a locale", () => {
    const env: NodeJS.ProcessEnv = { SHELL: "/bin/zsh", PATH: "/usr/bin" };
    const readEnvironment = vi.fn(() => ({ PATH: "/usr/bin" }));

    syncShellEnvironment(env, { platform: "darwin", readEnvironment, readLaunchctlPath: noop });

    expect(env.LC_CTYPE).toBe("en_US.UTF-8");
    expect(env.LANG).toBeUndefined();
  });

  it("leaves an inherited locale group untouched and never adds a locale on linux", () => {
    const darwinEnv: NodeJS.ProcessEnv = { SHELL: "/bin/zsh", PATH: "/usr/bin", LC_ALL: "C" };
    const readEnvironment = vi.fn(() => ({ PATH: "/usr/bin", LANG: "en_US.UTF-8" }));

    syncShellEnvironment(darwinEnv, {
      platform: "darwin",
      readEnvironment,
      readLaunchctlPath: noop,
    });
    expect(darwinEnv.LC_ALL).toBe("C");
    expect(darwinEnv.LANG).toBeUndefined();
    expect(darwinEnv.LC_CTYPE).toBeUndefined();

    const linuxEnv: NodeJS.ProcessEnv = { SHELL: "/bin/bash", PATH: "/usr/bin" };
    syncShellEnvironment(linuxEnv, { platform: "linux", readEnvironment });
    expect(linuxEnv.LANG).toBeUndefined();
    expect(linuxEnv.LC_CTYPE).toBeUndefined();
  });

  it("takes every imported variable from the one shell that supplied PATH", () => {
    const env: NodeJS.ProcessEnv = { SHELL: "/opt/homebrew/bin/nu", PATH: "/usr/bin" };
    const readEnvironment = vi
      .fn<(shell: string, names: ReadonlyArray<string>) => Partial<Record<string, string>>>()
      .mockImplementationOnce(() => ({
        SSH_AUTH_SOCK: "/tmp/nu.sock",
        __MISE_DIFF: "nu-diff",
        NODE_EXTRA_CA_CERTS: "/tmp/nu.pem",
      }))
      .mockImplementationOnce(() => ({ PATH: "/opt/homebrew/bin:/usr/bin" }));

    syncShellEnvironment(env, {
      platform: "darwin",
      readEnvironment,
      readLaunchctlPath: noop,
      userShell: "/bin/zsh",
    });

    expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin");
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
    expect(env.__MISE_DIFF).toBeUndefined();
    expect(env.NODE_EXTRA_CA_CERTS).toBeUndefined();
  });

  it("stops probing further shells once the probe budget is spent", () => {
    const env: NodeJS.ProcessEnv = { SHELL: "/opt/homebrew/bin/fish", PATH: "/usr/bin" };
    let clock = 0;
    const readEnvironment = vi.fn<ShellEnvironmentReader>(() => {
      clock += 5000;
      throw new Error("ETIMEDOUT");
    });
    const readLaunchctlPath = vi.fn(() => "/opt/homebrew/bin");

    syncShellEnvironment(env, {
      platform: "darwin",
      readEnvironment,
      readLaunchctlPath,
      userShell: "/bin/zsh",
      probeBudgetMs: 8000,
      now: () => clock,
      logWarning: noop,
    });

    expect(readEnvironment.mock.calls.map(([shell]) => shell)).toEqual([
      "/opt/homebrew/bin/fish",
      "/bin/zsh",
    ]);
    expect(readLaunchctlPath).toHaveBeenCalledTimes(1);
    expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin");
  });

  it("does nothing outside macOS and linux", () => {
    const env: NodeJS.ProcessEnv = {
      SHELL: "C:/Program Files/Git/bin/bash.exe",
      PATH: "C:\\Windows\\System32",
      SSH_AUTH_SOCK: "/tmp/inherited.sock",
    };
    const readEnvironment = vi.fn(() => ({
      PATH: "/usr/local/bin:/usr/bin",
      SSH_AUTH_SOCK: "/tmp/secretive.sock",
    }));

    syncShellEnvironment(env, { platform: "win32", readEnvironment });

    expect(readEnvironment).not.toHaveBeenCalled();
    expect(env.PATH).toBe("C:\\Windows\\System32");
    expect(env.SSH_AUTH_SOCK).toBe("/tmp/inherited.sock");
  });
});

describe("cached shell environment", () => {
  let dir: string | null = null;
  const makeCachePath = () => {
    dir = FS.mkdtempSync(Path.join(OS.tmpdir(), "pp-shell-env-"));
    return Path.join(dir, "nested", "shell-environment.json");
  };
  afterEach(() => {
    if (dir) FS.rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it("round-trips the cache only for a matching key and drops unknown or empty values", () => {
    const cachePath = makeCachePath();
    const key = shellEnvironmentCacheKey({ SHELL: "/bin/zsh" }, "darwin", "/Users/test");
    writeShellEnvironmentCache(cachePath, key, { PATH: "/opt/homebrew/bin", JAVA_HOME: "/jdk" });

    expect(readShellEnvironmentCache(cachePath, key)).toEqual({
      PATH: "/opt/homebrew/bin",
      JAVA_HOME: "/jdk",
    });
    const otherShell = shellEnvironmentCacheKey({ SHELL: "/bin/bash" }, "darwin", "/Users/test");
    expect(readShellEnvironmentCache(cachePath, otherShell)).toBeNull();
    const otherZdotdir = shellEnvironmentCacheKey(
      { SHELL: "/bin/zsh", ZDOTDIR: "/Users/test/.config/zsh" },
      "darwin",
      "/Users/test",
    );
    expect(readShellEnvironmentCache(cachePath, otherZdotdir)).toBeNull();
    expect(FS.readdirSync(Path.dirname(cachePath))).toEqual(["shell-environment.json"]);

    FS.writeFileSync(cachePath, "{not json");
    expect(readShellEnvironmentCache(cachePath, key)).toBeNull();
  });

  it("probes on a cache miss, then applies the cache synchronously on the next launch", async () => {
    const cachePath = makeCachePath();
    const readEnvironment = vi.fn(async () => ({
      PATH: "/opt/homebrew/bin:/usr/bin",
      JAVA_HOME: "/jdk",
    }));
    const firstEnv: NodeJS.ProcessEnv = { SHELL: "/bin/zsh", PATH: "/usr/bin", LANG: "C" };
    const first = createShellEnvironmentSync({
      cachePath,
      env: firstEnv,
      platform: "linux",
      home: "/home/test",
      readEnvironment,
    });
    expect(first.applyCached()).toBe(false);
    expect(firstEnv.PATH).toBe("/usr/bin");
    await expect(first.refresh()).resolves.toEqual({ changed: true, hydrated: true });
    expect(firstEnv.PATH).toBe("/opt/homebrew/bin:/usr/bin");

    const secondEnv: NodeJS.ProcessEnv = { SHELL: "/bin/zsh", PATH: "/usr/bin", LANG: "C" };
    const second = createShellEnvironmentSync({
      cachePath,
      env: secondEnv,
      platform: "linux",
      home: "/home/test",
      readEnvironment,
    });
    expect(second.applyCached()).toBe(true);
    expect(secondEnv.PATH).toBe("/opt/homebrew/bin:/usr/bin");
    expect(secondEnv.JAVA_HOME).toBe("/jdk");
    await expect(second.refresh()).resolves.toEqual({ changed: false, hydrated: true });
  });

  it("replaces stale cached entries with the refreshed ones instead of accumulating them", async () => {
    const cachePath = makeCachePath();
    const key = shellEnvironmentCacheKey({ SHELL: "/bin/zsh" }, "linux", "/home/test");
    writeShellEnvironmentCache(cachePath, key, { PATH: "/old/bin", JAVA_HOME: "/old-jdk" });
    const env: NodeJS.ProcessEnv = { SHELL: "/bin/zsh", PATH: "/usr/bin" };
    const sync = createShellEnvironmentSync({
      cachePath,
      env,
      platform: "linux",
      home: "/home/test",
      readEnvironment: async () => ({ PATH: "/new/bin" }),
    });

    expect(sync.applyCached()).toBe(true);
    expect(env.PATH).toBe("/old/bin:/usr/bin");
    await expect(sync.refresh()).resolves.toEqual({ changed: true, hydrated: true });
    expect(env.PATH).toBe("/new/bin:/usr/bin");
    expect(env.JAVA_HOME).toBeUndefined();
    expect(readShellEnvironmentCache(cachePath, key)).toEqual({ PATH: "/new/bin" });
  });

  it("keeps the cached environment when the background probe fails", async () => {
    const cachePath = makeCachePath();
    const key = shellEnvironmentCacheKey({ SHELL: "/bin/zsh" }, "darwin", "/Users/test");
    writeShellEnvironmentCache(cachePath, key, { PATH: "/opt/homebrew/bin" });
    const env: NodeJS.ProcessEnv = { SHELL: "/bin/zsh", PATH: "/usr/bin", LANG: "C" };
    const readLaunchctlPath = vi.fn(() => "/launchctl/bin");
    const sync = createShellEnvironmentSync({
      cachePath,
      env,
      platform: "darwin",
      home: "/Users/test",
      userShell: "/bin/zsh",
      readEnvironment: async () => {
        throw new Error("ETIMEDOUT");
      },
      readLaunchctlPath,
      logWarning: noop,
    });

    expect(sync.applyCached()).toBe(true);
    await expect(sync.refresh()).resolves.toEqual({ changed: false, hydrated: true });
    expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin");
    expect(readLaunchctlPath).not.toHaveBeenCalled();
    expect(readShellEnvironmentCache(cachePath, key)).toEqual({ PATH: "/opt/homebrew/bin" });
  });

  it("falls back to launchctl without caching when nothing was cached and the probe fails", async () => {
    const cachePath = makeCachePath();
    const env: NodeJS.ProcessEnv = { SHELL: "/bin/zsh", PATH: "/usr/bin", LANG: "C" };
    const sync = createShellEnvironmentSync({
      cachePath,
      env,
      platform: "darwin",
      home: "/Users/test",
      userShell: "/bin/zsh",
      readEnvironment: async () => ({}),
      readLaunchctlPath: () => "/launchctl/bin",
      logWarning: noop,
    });

    expect(sync.applyCached()).toBe(false);
    // Only a launchctl PATH, so the backend must still run its own login-shell probe.
    await expect(sync.refresh()).resolves.toEqual({ changed: true, hydrated: false });
    expect(env.PATH).toBe("/launchctl/bin:/usr/bin");
    expect(FS.existsSync(cachePath)).toBe(false);
  });

  it("is a ready no-op on platforms without a login shell probe", async () => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    const readEnvironment = vi.fn(async () => ({ PATH: "/usr/local/bin" }));
    const sync = createShellEnvironmentSync({
      cachePath: "/nonexistent/shell-environment.json",
      env,
      platform: "freebsd",
      readEnvironment,
    });
    expect(sync.applyCached()).toBe(true);
    await expect(sync.refresh()).resolves.toEqual({ changed: false, hydrated: true });
    expect(readEnvironment).not.toHaveBeenCalled();
    expect(env.PATH).toBe("/usr/bin");
  });

  it("reports an unhydrated env when every probe fails and nothing was cached", async () => {
    const env: NodeJS.ProcessEnv = { SHELL: "/bin/zsh", PATH: "/usr/bin" };
    const sync = createShellEnvironmentSync({
      cachePath: makeCachePath(),
      env,
      platform: "linux",
      home: "/home/test",
      readEnvironment: async () => {
        throw new Error("ETIMEDOUT");
      },
      logWarning: noop,
    });
    expect(sync.applyCached()).toBe(false);
    await expect(sync.refresh()).resolves.toEqual({ changed: false, hydrated: false });
  });

  it("probes from the inherited env rather than the cached one", async () => {
    const cachePath = makeCachePath();
    const key = shellEnvironmentCacheKey({ SHELL: "/bin/zsh" }, "linux", "/home/test");
    writeShellEnvironmentCache(cachePath, key, { PATH: "/cached/bin", JAVA_HOME: "/cached-jdk" });
    const env: NodeJS.ProcessEnv = { SHELL: "/bin/zsh", PATH: "/usr/bin", HOME: "/home/test" };
    const probeEnvs: Array<NodeJS.ProcessEnv | undefined> = [];
    const sync = createShellEnvironmentSync({
      cachePath,
      env,
      platform: "linux",
      home: "/home/test",
      readEnvironment: async (_shell, _names, _timeoutMs, probeEnv) => {
        probeEnvs.push(probeEnv);
        return { PATH: "/usr/bin" };
      },
    });
    expect(sync.applyCached()).toBe(true);
    expect(env.JAVA_HOME).toBe("/cached-jdk");
    await sync.refresh();
    expect(probeEnvs[0]?.PATH).toBe("/usr/bin");
    expect(probeEnvs[0]?.HOME).toBe("/home/test");
    expect(probeEnvs[0]).not.toHaveProperty("JAVA_HOME");
  });

  it.skipIf(process.platform === "win32")(
    "does not ask for a restart when only per-shell PATH symlinks differ",
    async () => {
      const cachePath = makeCachePath();
      const root = Path.dirname(Path.dirname(cachePath));
      const nodeBin = Path.join(root, "node-versions", "v22", "bin");
      FS.mkdirSync(nodeBin, { recursive: true });
      const multishell = (id: string) => {
        const link = Path.join(root, "fnm_multishells", id);
        FS.mkdirSync(Path.dirname(link), { recursive: true });
        FS.symlinkSync(Path.dirname(nodeBin), link);
        return Path.join(link, "bin");
      };
      const key = shellEnvironmentCacheKey({ SHELL: "/bin/zsh" }, "linux", "/home/test");
      const cachedPath = `${multishell("100_1")}:/usr/bin`;
      writeShellEnvironmentCache(cachePath, key, { PATH: cachedPath });
      const env: NodeJS.ProcessEnv = { SHELL: "/bin/zsh", PATH: "/usr/bin" };
      const freshPath = `${multishell("200_2")}:/usr/bin`;
      const sync = createShellEnvironmentSync({
        cachePath,
        env,
        platform: "linux",
        home: "/home/test",
        readEnvironment: async () => ({ PATH: freshPath }),
      });
      expect(sync.applyCached()).toBe(true);
      await expect(sync.refresh()).resolves.toEqual({ changed: false, hydrated: true });
      expect(env.PATH).toBe(freshPath);
      expect(readShellEnvironmentCache(cachePath, key)?.PATH).toBe(cachedPath);
    },
  );

  it("reuses a cached agent socket only while it still exists", () => {
    const cachePath = makeCachePath();
    const key = shellEnvironmentCacheKey({ SHELL: "/bin/zsh" }, "linux", "/home/test");
    const socket = Path.join(Path.dirname(Path.dirname(cachePath)), "agent.sock");
    FS.writeFileSync(socket, "");
    writeShellEnvironmentCache(cachePath, key, { PATH: "/usr/bin", SSH_AUTH_SOCK: socket });
    expect(readShellEnvironmentCache(cachePath, key)?.SSH_AUTH_SOCK).toBe(socket);
    FS.rmSync(socket);
    expect(readShellEnvironmentCache(cachePath, key)).toEqual({ PATH: "/usr/bin" });
  });

  it("leaves Windows PATH repair to the backend", async () => {
    const env: NodeJS.ProcessEnv = { Path: "C:\\Windows" };
    const readEnvironment = vi.fn(async () => ({ PATH: "/usr/bin" }));
    const sync = createShellEnvironmentSync({
      cachePath: "/nonexistent/shell-environment.json",
      env,
      platform: "win32",
      readEnvironment,
    });
    expect(sync.applyCached()).toBe(true);
    await expect(sync.refresh()).resolves.toEqual({ changed: false, hydrated: true });
    expect(readEnvironment).not.toHaveBeenCalled();
    expect(env).toEqual({ Path: "C:\\Windows" });
  });

  it("stops async probing once the shared budget is spent", async () => {
    let clock = 0;
    const readEnvironment = vi.fn(
      async (_shell: string, _names: ReadonlyArray<string>, timeoutMs: number) => {
        clock += timeoutMs;
        throw new Error("ETIMEDOUT");
      },
    );
    await expect(
      readEnvironmentFromLoginShellCandidatesAsync(["/a", "/b", "/c"], ["PATH"], {
        readEnvironment,
        budgetMs: 8000,
        now: () => clock,
      }),
    ).resolves.toEqual({});
    expect(readEnvironment.mock.calls.map(([shell, , timeoutMs]) => [shell, timeoutMs])).toEqual([
      ["/a", 5000],
      ["/b", 3000],
    ]);
  });
});

describe.skipIf(process.platform === "win32")("readEnvironmentFromLoginShellAsync", () => {
  let dir: string | null = null;
  const writeShell = (script: string) => {
    dir = FS.mkdtempSync(Path.join(OS.tmpdir(), "pp-shell-probe-"));
    const shellPath = Path.join(dir, "fake-shell");
    FS.writeFileSync(shellPath, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    return shellPath;
  };
  afterEach(() => {
    if (dir) FS.rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it("runs the capture command and parses the requested variables", async () => {
    const shell = writeShell('shift\nPATH=/probe/bin:/usr/bin:/bin JAVA_HOME=/probe/jdk eval "$1"');
    await expect(
      readEnvironmentFromLoginShellAsync(
        shell,
        ["PATH", "JAVA_HOME", "PIEDPIPER_PROBE_UNSET_VAR"],
        5000,
      ),
    ).resolves.toEqual({ PATH: "/probe/bin:/usr/bin:/bin", JAVA_HOME: "/probe/jdk" });
  });

  it("kills a hung probe and the children it started at the timeout", async () => {
    const shell = writeShell(`sleep 30 &\necho $! > "$(dirname "$0")/child.pid"\nwait`);
    await expect(readEnvironmentFromLoginShellAsync(shell, ["PATH"], 300)).rejects.toThrow(
      /timed out/,
    );
    const childPid = Number(FS.readFileSync(Path.join(Path.dirname(shell), "child.pid"), "utf8"));
    await vi.waitFor(() => expect(() => process.kill(childPid, 0)).toThrow());
  });

  it("runs the probe with the env it is given", async () => {
    const shell = writeShell('shift\neval "$1"');
    await expect(
      readEnvironmentFromLoginShellAsync(shell, ["PATH", "JAVA_HOME"], 5000, {
        PATH: "/usr/bin:/bin",
      }),
    ).resolves.toEqual({ PATH: "/usr/bin:/bin" });
  });

  it("drops a cached-only PATH entry once the real probe refreshes", async () => {
    const shell = writeShell('shift\neval "$1"');
    const cachePath = Path.join(Path.dirname(shell), "shell-environment.json");
    const env: NodeJS.ProcessEnv = { SHELL: shell, PATH: "/usr/bin:/bin" };
    const key = shellEnvironmentCacheKey(env, "linux", "/home/test");
    writeShellEnvironmentCache(cachePath, key, { PATH: "/removed/bin:/usr/bin:/bin" });
    const sync = createShellEnvironmentSync({
      cachePath,
      env,
      platform: "linux",
      home: "/home/test",
    });
    expect(sync.applyCached()).toBe(true);
    expect(env.PATH).toBe("/removed/bin:/usr/bin:/bin");
    await expect(sync.refresh()).resolves.toEqual({ changed: true, hydrated: true });
    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(readShellEnvironmentCache(cachePath, key)?.PATH).toBe("/usr/bin:/bin");
  });
});
