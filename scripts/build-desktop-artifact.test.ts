import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BuildScriptError,
  DESKTOP_ELECTRON_LANGUAGES,
  DESKTOP_FILE_EXCLUSIONS,
  LINUX_FILE_EXCLUSIONS,
  LINUX_ICON_SIZES,
  MAC_FILE_EXCLUSIONS,
  WINDOWS_NATIVE_ASAR_UNPACK_GLOB,
  WINDOWS_NSIS_INCLUDE,
  createBuildConfig,
  resolveMacFileExclusions,
  stageLinuxIconSize,
  stageLinuxIcons,
} from "./build-desktop-artifact.ts";

const repoRoot = join(import.meta.dirname, "..");

const buildConfigFor = (platform: "mac" | "linux" | "win", arch?: "arm64" | "x64" | "universal") =>
  Effect.runPromise(
    createBuildConfig(platform, "dir", "Pied Piper", false, false, undefined, arch).pipe(
      Effect.provide(NodeServices.layer),
    ),
  );

const NODE_PTY_PREBUILDS = "!**/node_modules/node-pty/prebuilds";

describe("createBuildConfig", () => {
  describe("publish", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    const stubRepository = (repository: string) => {
      vi.stubEnv("PIEDPIPER_DESKTOP_UPDATE_REPOSITORY", repository);
      vi.stubEnv("GITHUB_REPOSITORY", "");
    };
    const publishFor = async (mockUpdates: boolean) => {
      const config = await Effect.runPromise(
        createBuildConfig("mac", "dir", "Pied Piper", false, mockUpdates, "4100").pipe(
          Effect.provide(NodeServices.layer),
        ),
      );
      return config.publish;
    };

    it("disables electron-builder's feed inference when no feed is configured", async () => {
      stubRepository("");
      vi.stubEnv("GH_TOKEN", "local-token");

      const publish = await publishFor(false);

      expect(publish).toBeNull();
      expect(JSON.parse(JSON.stringify({ publish }))).toEqual({ publish: null });
    });

    it("uses the GitHub feed when a repository is configured", async () => {
      stubRepository("piedpiper/app");

      expect(await publishFor(false)).toEqual([
        { provider: "github", owner: "piedpiper", repo: "app", releaseType: "release" },
      ]);
    });

    it("uses the mock feed for mock update builds", async () => {
      stubRepository("");

      expect(await publishFor(true)).toEqual([
        { provider: "generic", url: "http://localhost:4100" },
      ]);
    });
  });

  it("drops the Claude SDK platform binaries and extra Electron locales on every platform", async () => {
    for (const platform of ["mac", "linux", "win"] as const) {
      const config = await buildConfigFor(platform);
      expect(config.files).toEqual(expect.arrayContaining([...DESKTOP_FILE_EXCLUSIONS]));
      expect(config.electronLanguages).toEqual([...DESKTOP_ELECTRON_LANGUAGES]);
    }
  });

  it.each([
    ["mac", "arm64", [...MAC_FILE_EXCLUSIONS, `${NODE_PTY_PREBUILDS}/darwin-x64/**/*`]],
    ["mac", "x64", [...MAC_FILE_EXCLUSIONS, `${NODE_PTY_PREBUILDS}/darwin-arm64/**/*`]],
    ["mac", "universal", [...MAC_FILE_EXCLUSIONS]],
    ["mac", undefined, [...MAC_FILE_EXCLUSIONS]],
    ["linux", "x64", [...LINUX_FILE_EXCLUSIONS]],
    ["linux", "arm64", [...LINUX_FILE_EXCLUSIONS]],
    ["win", "x64", []],
    ["win", "arm64", []],
  ] as const)("drops unusable node-pty files for %s/%s", async (platform, arch, expected) => {
    const config = await buildConfigFor(platform, arch);
    expect(config.files).toEqual([...DESKTOP_FILE_EXCLUSIONS, ...expected]);
  });

  it("keeps the prebuilds each platform loads at runtime", () => {
    const excluded = (patterns: ReadonlyArray<string>, directory: string) =>
      patterns.includes(`${NODE_PTY_PREBUILDS}/${directory}/**/*`);
    expect(excluded(resolveMacFileExclusions("arm64"), "darwin-arm64")).toBe(false);
    expect(excluded(resolveMacFileExclusions("x64"), "darwin-x64")).toBe(false);
    expect(excluded(resolveMacFileExclusions("universal"), "darwin-arm64")).toBe(false);
    expect(excluded(resolveMacFileExclusions("universal"), "darwin-x64")).toBe(false);
    expect(LINUX_FILE_EXCLUSIONS).toContain(`${NODE_PTY_PREBUILDS}/darwin-*/**/*`);
    expect(LINUX_FILE_EXCLUSIONS).toContain(`${NODE_PTY_PREBUILDS}/win32-*/**/*`);
  });

  it("keeps the SDK's own JS package while excluding its platform packages", () => {
    const [pattern] = DESKTOP_FILE_EXCLUSIONS;
    expect(pattern).toBe("!**/node_modules/@anthropic-ai/claude-agent-sdk-*/**/*");
    expect(pattern.includes("claude-agent-sdk/")).toBe(false);
  });

  it("uses the static AppImage runtime only for Linux builds", async () => {
    const [mac, linux, win] = await Promise.all([
      buildConfigFor("mac"),
      buildConfigFor("linux"),
      buildConfigFor("win"),
    ]);
    expect(linux.toolsets).toEqual({ appimage: "1.0.3" });
    expect(mac).not.toHaveProperty("toolsets");
    expect(win).not.toHaveProperty("toolsets");
  });

  it("declares local network usage and opts out of one-time-code autofill on macOS", async () => {
    const mac = await buildConfigFor("mac");
    const extendInfo = (mac.mac as { extendInfo?: Record<string, unknown> }).extendInfo;
    expect(extendInfo?.NSLocalNetworkUsageDescription).toBe(
      "Pied Piper connects to devices on your local network for commands run by terminals and coding agents.",
    );
    expect(extendInfo?.NSAutoFillRequiresTextContentTypeForOneTimeCodeOnMac).toBe(true);
  });

  it("points Linux builds at the sized icon directory", async () => {
    const linux = await buildConfigFor("linux");
    expect((linux.linux as { icon?: string }).icon).toBe("icons");
  });

  it("declares camera and microphone usage on macOS", async () => {
    const mac = await buildConfigFor("mac");
    const extendInfo = (mac.mac as { extendInfo?: Record<string, unknown> }).extendInfo;
    expect(extendInfo?.NSCameraUsageDescription).toEqual(expect.any(String));
    expect(extendInfo?.NSMicrophoneUsageDescription).toEqual(expect.any(String));
  });

  it("restores the Start Menu shortcut through an NSIS include on Windows only", async () => {
    const [mac, linux, win] = await Promise.all([
      buildConfigFor("mac"),
      buildConfigFor("linux"),
      buildConfigFor("win"),
    ]);
    expect(win.nsis).toEqual({ include: "apps/desktop/resources/installer.nsh" });
    expect(mac).not.toHaveProperty("nsis");
    expect(linux).not.toHaveProperty("nsis");

    const include = readFileSync(join(repoRoot, WINDOWS_NSIS_INCLUDE), "utf8");
    expect(include).toContain("!macro customInstall");
    expect(include).not.toContain("customUnInstall");
  });

  it("unpacks only native files from the asar on Windows", async () => {
    const [mac, linux, win] = await Promise.all([
      buildConfigFor("mac"),
      buildConfigFor("linux"),
      buildConfigFor("win"),
    ]);
    expect(win.asar).toEqual({ smartUnpack: false });
    expect(win.asarUnpack).toEqual([WINDOWS_NATIVE_ASAR_UNPACK_GLOB]);
    for (const config of [mac, linux]) {
      expect(config).not.toHaveProperty("asar");
      expect(config).not.toHaveProperty("asarUnpack");
    }
    for (const extension of ["node", "dll", "exe"]) {
      expect(WINDOWS_NATIVE_ASAR_UNPACK_GLOB).toContain(`**/*.${extension}`);
    }
  });
});

describe("macOS entitlements", () => {
  const plistPath = join(repoRoot, "apps/desktop/resources/entitlements.mac.plist");

  it("keeps electron-builder's defaults and adds camera and microphone, without passkeys", () => {
    const plist = readFileSync(plistPath, "utf8");
    for (const key of [
      "com.apple.security.cs.allow-jit",
      "com.apple.security.cs.allow-unsigned-executable-memory",
      "com.apple.security.cs.disable-library-validation",
      "com.apple.security.device.camera",
      "com.apple.security.device.audio-input",
    ]) {
      expect(plist).toMatch(new RegExp(`<key>${key.replaceAll(".", "\\.")}</key>\\s*<true/>`));
    }
    expect(plist).not.toContain("associated-domains");
    expect(plist).not.toContain("web-browser.public-key-credential");
    expect(plist).not.toContain("keychain-access-groups");
  });

  it.runIf(process.platform === "darwin")("is a valid plist", () => {
    const result = spawnSync("plutil", ["-lint", plistPath], { encoding: "utf8" });
    expect(result.status, result.stdout).toBe(0);
  });
});

const finishedProcess = (exitCode: number) =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });

const resizeWithExitCodes = (exitCodes: ReadonlyArray<number>) => {
  const calls: Array<{ command: string; args: ReadonlyArray<string> }> = [];
  const spawner = ChildProcessSpawner.make((command) => {
    const { command: name, args } = command as unknown as {
      readonly command: string;
      readonly args: ReadonlyArray<string>;
    };
    calls.push({ command: name, args });
    return Effect.succeed(finishedProcess(exitCodes[calls.length - 1] ?? 0));
  });
  const run = stageLinuxIconSize("source.png", "target.png", 48, false).pipe(
    Effect.scoped,
    Effect.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
  );
  return { calls, run };
};

describe("Linux icon staging", () => {
  it("stops at the first tool that works", async () => {
    const { calls, run } = resizeWithExitCodes([0]);
    await Effect.runPromise(run);
    expect(calls).toEqual([
      { command: "magick", args: ["source.png", "-resize", "48x48", "target.png"] },
    ]);
  });

  it("falls back from magick to convert to sips", async () => {
    const { calls, run } = resizeWithExitCodes([1, 127, 0]);
    await Effect.runPromise(run);
    expect(calls.map(({ command }) => command)).toEqual(["magick", "convert", "sips"]);
    expect(calls[2]?.args).toEqual(["-z", "48", "48", "source.png", "--out", "target.png"]);
  });

  it("names every failed tool and the size when none work", async () => {
    const { run } = resizeWithExitCodes([1, 2, 3]);
    const error = await Effect.runPromise(Effect.flip(run));
    expect(error).toBeInstanceOf(BuildScriptError);
    expect(error.message).toContain("48x48");
    expect(error.message).toContain("Install ImageMagick");
    expect(error.message).toContain("magick: Command exited with non-zero exit code (1)");
    expect(error.message).toContain("convert: Command exited with non-zero exit code (2)");
    expect(error.message).toContain("sips: Command exited with non-zero exit code (3)");
  });

  it.runIf(process.platform === "darwin")(
    "writes each standard size and keeps icon.png",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "pp-linux-icons-"));
      try {
        await Effect.runPromise(
          stageLinuxIcons(dir, false).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
        );
        expect(existsSync(join(dir, "icon.png"))).toBe(true);
        for (const size of LINUX_ICON_SIZES) {
          const png = readFileSync(join(dir, "icons", `${size}x${size}.png`));
          expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([size, size]);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
