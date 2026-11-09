import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { assertSuccess } from "@effect/vitest/utils";
import { FileSystem, Path, Effect } from "effect";

import { EDITORS } from "@piedpiper/contracts";

import {
  type DirectoryEntries,
  type DirectoryListings,
  type LinuxProbeRunner,
  type OpenInEditorInput,
  editorSpawnOptions,
  isCommandAvailable,
  isNetworkPath,
  isPathInsideAnyRoot,
  launchDetached,
  launchEditor,
  makeCachedEditorDiscovery,
  resolveAvailableEditors,
  resolveAvailableEditorsForConfig,
  resolveEditorCommand,
  requireFileManagerFolder,
  resolveEditorLaunch,
  resolveEditorSpawnCommand,
  resolveLaunchEnv,
  runLinuxProbe,
  tryRevealLinuxItem,
} from "./open";

// POSIX install tests rely on the executable bit, which Windows hosts ignore.
const windowsHost = process.platform === "win32";

// Keeps launch expectations independent of the editors installed on the test host.
const NO_INSTALLED_EDITORS = {
  env: { PATH: "" },
  systemRoot: "/nonexistent-piedpiper-system-root",
};

it.layer(NodeServices.layer)("resolveEditorLaunch", (it) => {
  it.effect("returns commands for command-based editors", () =>
    Effect.gen(function* () {
      const antigravityLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "antigravity" },
        "darwin",
        NO_INSTALLED_EDITORS,
      );
      assert.deepEqual(antigravityLaunch, {
        command: "antigravity-ide",
        args: ["/tmp/workspace"],
      });

      const kiroLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/open.ts:71:5", editor: "kiro" },
        "darwin",
        NO_INSTALLED_EDITORS,
      );
      assert.deepEqual(kiroLaunch, {
        command: "kiro",
        args: ["ide", "--goto", "/tmp/workspace/src/open.ts:71:5"],
      });

      const pycharmLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/open.ts:71:5", editor: "pycharm" },
        "darwin",
        NO_INSTALLED_EDITORS,
      );
      assert.deepEqual(pycharmLaunch, {
        command: "pycharm",
        args: ["--line", "71", "--column", "4", "/tmp/workspace/src/open.ts"],
      });

      const cursorLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "cursor" },
        "darwin",
        NO_INSTALLED_EDITORS,
      );
      assert.deepEqual(cursorLaunch, {
        command: "cursor",
        args: ["--classic", "/tmp/workspace"],
      });

      const traeLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "trae" },
        "darwin",
        NO_INSTALLED_EDITORS,
      );
      assert.deepEqual(traeLaunch, {
        command: "trae",
        args: ["/tmp/workspace"],
      });

      const vscodeLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "vscode" },
        "darwin",
        NO_INSTALLED_EDITORS,
      );
      assert.deepEqual(vscodeLaunch, {
        command: "code",
        args: ["/tmp/workspace"],
      });

      const vscodeInsidersLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "vscode-insiders" },
        "darwin",
        NO_INSTALLED_EDITORS,
      );
      assert.deepEqual(vscodeInsidersLaunch, {
        command: "code-insiders",
        args: ["/tmp/workspace"],
      });

      const vscodiumLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "vscodium" },
        "darwin",
        NO_INSTALLED_EDITORS,
      );
      assert.deepEqual(vscodiumLaunch, {
        command: "codium",
        args: ["/tmp/workspace"],
      });

      const zedLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "zed" },
        "darwin",
        NO_INSTALLED_EDITORS,
      );
      assert.deepEqual(zedLaunch, {
        command: "zed",
        args: ["/tmp/workspace"],
      });

      const ideaLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "idea" },
        "darwin",
        NO_INSTALLED_EDITORS,
      );
      assert.deepEqual(ideaLaunch, {
        command: "idea",
        args: ["/tmp/workspace"],
      });
    }),
  );

  it.effect("applies launch-style-specific navigation arguments", () =>
    Effect.gen(function* () {
      const lineOnly = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/AGENTS.md:48", editor: "cursor" },
        "darwin",
        NO_INSTALLED_EDITORS,
      );
      assert.deepEqual(lineOnly, {
        command: "cursor",
        args: ["--classic", "--goto", "/tmp/workspace/AGENTS.md:48"],
      });

      const lineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/open.ts:71:5", editor: "cursor" },
        "darwin",
        NO_INSTALLED_EDITORS,
      );
      assert.deepEqual(lineAndColumn, {
        command: "cursor",
        args: ["--classic", "--goto", "/tmp/workspace/src/open.ts:71:5"],
      });

      const traeLineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/open.ts:71:5", editor: "trae" },
        "darwin",
        NO_INSTALLED_EDITORS,
      );
      assert.deepEqual(traeLineAndColumn, {
        command: "trae",
        args: ["--goto", "/tmp/workspace/src/open.ts:71:5"],
      });

      const vscodeLineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/open.ts:71:5", editor: "vscode" },
        "darwin",
        NO_INSTALLED_EDITORS,
      );
      assert.deepEqual(vscodeLineAndColumn, {
        command: "code",
        args: ["--goto", "/tmp/workspace/src/open.ts:71:5"],
      });

      const vscodeInsidersLineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/open.ts:71:5", editor: "vscode-insiders" },
        "darwin",
        NO_INSTALLED_EDITORS,
      );
      assert.deepEqual(vscodeInsidersLineAndColumn, {
        command: "code-insiders",
        args: ["--goto", "/tmp/workspace/src/open.ts:71:5"],
      });

      const vscodiumLineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/open.ts:71:5", editor: "vscodium" },
        "darwin",
        NO_INSTALLED_EDITORS,
      );
      assert.deepEqual(vscodiumLineAndColumn, {
        command: "codium",
        args: ["--goto", "/tmp/workspace/src/open.ts:71:5"],
      });

      const zedLineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/open.ts:71:5", editor: "zed" },
        "darwin",
        NO_INSTALLED_EDITORS,
      );
      assert.deepEqual(zedLineAndColumn, {
        command: "zed",
        args: ["/tmp/workspace/src/open.ts:71:5"],
      });

      const zedLineOnly = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/AGENTS.md:48", editor: "zed" },
        "darwin",
        NO_INSTALLED_EDITORS,
      );
      assert.deepEqual(zedLineOnly, {
        command: "zed",
        args: ["/tmp/workspace/AGENTS.md:48"],
      });

      const ideaLineOnly = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/AGENTS.md:48", editor: "idea" },
        "darwin",
        NO_INSTALLED_EDITORS,
      );
      assert.deepEqual(ideaLineOnly, {
        command: "idea",
        args: ["--line", "48", "/tmp/workspace/AGENTS.md"],
      });

      const ideaLineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/open.ts:71:5", editor: "idea" },
        "darwin",
        NO_INSTALLED_EDITORS,
      );
      assert.deepEqual(ideaLineAndColumn, {
        command: "idea",
        args: ["--line", "71", "--column", "4", "/tmp/workspace/src/open.ts"],
      });

      const ideaFirstColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/open.ts:3:1", editor: "idea" },
        "darwin",
        NO_INSTALLED_EDITORS,
      );
      assert.deepEqual(ideaFirstColumn, {
        command: "idea",
        args: ["--line", "3", "--column", "0", "/tmp/workspace/src/open.ts"],
      });
    }),
  );

  it.effect("maps file-manager editor to OS open commands", () =>
    Effect.gen(function* () {
      const launch1 = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "file-manager" },
        "darwin",
        NO_INSTALLED_EDITORS,
      );
      assert.deepEqual(launch1, {
        command: "open",
        args: ["/tmp/workspace"],
      });

      const launch2 = yield* resolveEditorLaunch(
        { cwd: "C:\\workspace", editor: "file-manager" },
        "win32",
        NO_INSTALLED_EDITORS,
      );
      assert.deepEqual(launch2, {
        command: "explorer",
        args: ["C:\\workspace"],
      });

      const forwardSlashLaunch = yield* resolveEditorLaunch(
        { cwd: "C:/workspace", editor: "file-manager" },
        "win32",
        NO_INSTALLED_EDITORS,
      );
      assert.deepEqual(forwardSlashLaunch, {
        command: "explorer",
        args: ["C:\\workspace"],
      });

      const posixForwardSlashLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "file-manager" },
        "darwin",
        NO_INSTALLED_EDITORS,
      );
      assert.deepEqual(posixForwardSlashLaunch.args, ["/tmp/workspace"]);

      const launch3 = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "file-manager" },
        "linux",
        NO_INSTALLED_EDITORS,
      );
      assert.deepEqual(launch3, {
        command: "xdg-open",
        args: ["/tmp/workspace"],
      });
    }),
  );
});

const decodeScript = (args: ReadonlyArray<string>) =>
  Buffer.from(args.at(-1) ?? "", "base64").toString("utf16le");

describe("requireFileManagerFolder", () => {
  const check = (input: { editor: "file-manager" | "vscode"; reveal?: boolean }, exists: boolean) =>
    requireFileManagerFolder({ cwd: "/gone/project", ...input } as never, {
      platform: "linux",
      exists: () => exists,
    }).pipe(
      Effect.flip,
      Effect.map((error) => error.message),
    );

  it.effect("reports a folder that is gone instead of a silent no-op", () =>
    Effect.gen(function* () {
      assert.equal(
        yield* check({ editor: "file-manager" }, false),
        "Project folder not found: /gone/project",
      );
    }),
  );

  it.effect("passes a folder that is there, a reveal and an editor", () =>
    Effect.gen(function* () {
      const passes = (
        input: { editor: "file-manager" | "vscode"; reveal?: boolean },
        exists: boolean,
      ) =>
        requireFileManagerFolder({ cwd: "/gone/project", ...input } as never, {
          platform: "linux",
          exists: () => exists,
        });
      yield* passes({ editor: "file-manager" }, true);
      yield* passes({ editor: "file-manager", reveal: true }, false);
      yield* passes({ editor: "vscode" }, false);
    }),
  );
});

it.layer(NodeServices.layer)("file-manager reveal", (it) => {
  it.effect("selects the file without its :line:col suffix on each platform", () =>
    Effect.gen(function* () {
      const reveal = (cwd: string, platform: NodeJS.Platform) =>
        resolveEditorLaunch(
          { cwd, editor: "file-manager", reveal: true },
          platform,
          NO_INSTALLED_EDITORS,
        );

      assert.deepEqual(yield* reveal("/tmp/ws/src/a.ts:12:3", "darwin"), {
        command: "open",
        args: ["-R", "/tmp/ws/src/a.ts"],
      });
      const windows = yield* reveal("C:/ws dir/src/a.ts:12", "win32");
      assert.deepEqual(windows.fallback, {
        command: "explorer",
        args: ['/select,"C:\\ws dir\\src\\a.ts"'],
        windowsVerbatimArguments: true,
      });
      assert.deepEqual(yield* reveal("/tmp/ws/src/a.ts:12", "linux"), {
        command: "xdg-open",
        args: ["/tmp/ws/src"],
      });
    }),
  );

  it.effect("refuses a Windows reveal whose path would break the verbatim quoting", () =>
    Effect.gen(function* () {
      const result = yield* resolveEditorLaunch(
        { cwd: 'C:\\ws\\a" & calc & ".ts', editor: "file-manager", reveal: true },
        "win32",
        NO_INSTALLED_EDITORS,
      ).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
    }),
  );

  const windowsReveal = (cwd: string, env: NodeJS.ProcessEnv = { PATH: "" }) =>
    resolveEditorLaunch({ cwd, editor: "file-manager", reveal: true }, "win32", {
      env,
      systemRoot: NO_INSTALLED_EDITORS.systemRoot,
    });

  it.effect("reveals on Windows through an attached PowerShell that honors the shell verb", () =>
    Effect.gen(function* () {
      const launch = yield* windowsReveal("C:\\ws dir\\a.ts:3");
      assert.equal(
        launch.command,
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      );
      assert.deepEqual(launch.args.slice(0, -1), [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
      ]);
      assert.equal(launch.detached, false);
      assert.deepEqual(launch.unsetEnv, ["PSModulePath"]);
      assert.equal(
        decodeScript(launch.args),
        "$ProgressPreference = 'SilentlyContinue'; $folderVerb = (Get-ItemProperty -LiteralPath 'Registry::HKEY_CLASSES_ROOT\\Directory\\shell' -ErrorAction SilentlyContinue).'(default)'; if ($folderVerb -and $folderVerb -ne 'none') { Invoke-Item -LiteralPath 'C:\\ws dir' } else { Start-Process 'explorer.exe' -ArgumentList ('/select,\"' + 'C:\\ws dir\\a.ts' + '\"') }",
      );
    }),
  );

  it.effect("uses the configured Windows folder for PowerShell", () =>
    Effect.gen(function* () {
      const launch = yield* windowsReveal("D:\\a.ts", { SYSTEMROOT: "D:\\Win" });
      assert.equal(launch.command, "D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    }),
  );

  it.effect("opens a sensible parent for drive roots and UNC shares", () =>
    Effect.gen(function* () {
      const parentOf = function* (cwd: string) {
        const script = decodeScript((yield* windowsReveal(cwd)).args);
        return /Invoke-Item -LiteralPath '([^']*)'/.exec(script)?.[1];
      };
      assert.equal(yield* parentOf("C:\\"), "C:\\");
      assert.equal(yield* parentOf("C:\\a.ts"), "C:\\");
      assert.equal(yield* parentOf("\\\\host\\share\\a.ts"), "\\\\host\\share\\");
      assert.equal(yield* parentOf("//host/share/dir/a.ts"), "\\\\host\\share\\dir");
    }),
  );

  it.effect("keeps PowerShell quote characters inside the path literal", () =>
    Effect.gen(function* () {
      const script = decodeScript((yield* windowsReveal("C:\\it's\\Bob\u2019s; calc.ts")).args);
      assert.include(script, "'C:\\it''s\\Bob\u2019\u2019s; calc.ts'");
      assert.include(script, "Invoke-Item -LiteralPath 'C:\\it''s'");
    }),
  );

  // The manual Windows check as one command; the bogus module path stands in for a pwsh 7 parent.
  for (const folderVerb of ["none", "", "open"]) {
    it.skipIf(!windowsHost)(
      `runs the reveal through real PowerShell (folder verb: ${folderVerb || "empty"})`,
      async () => {
        const { mkdtemp, readFile, rm, writeFile } = await import("node:fs/promises");
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");
        const dir = await mkdtemp(join(tmpdir(), "piedpiper-reveal-smoke-"));
        try {
          const outputPath = join(dir, "argv.txt");
          const stagingPath = join(dir, "argv.tmp");
          const recorderPath = join(dir, "recorder.cmd");
          await writeFile(
            recorderPath,
            `@echo off\r\n>"${stagingPath}" echo(%*\r\nmove /y "${stagingPath}" "${outputPath}" >nul\r\n`,
          );
          const recorderLiteral = `'${recorderPath.replaceAll("'", "''")}'`;
          // Controls the association without touching the host registry or its file manager.
          const stubs = `function Get-ItemProperty { [CmdletBinding()] param([string]$LiteralPath); if ($LiteralPath -ne 'Registry::HKEY_CLASSES_ROOT\\Directory\\shell') { throw 'Unexpected registry path' }; @{ '(default)' = '${folderVerb}' } }; function Invoke-Item { param([string]$LiteralPath); Start-Process ${recorderLiteral} -ArgumentList ('"' + $LiteralPath + '"') }; `;

          const target = "C:/workspace with spaces/author's media/clip.mp4";
          const launch = await Effect.runPromise(windowsReveal(target, process.env));
          const script = decodeScript(launch.args).replace("'explorer.exe'", recorderLiteral);
          await Effect.runPromise(
            launchDetached(
              {
                ...launch,
                args: [
                  ...launch.args.slice(0, -1),
                  Buffer.from(stubs + script, "utf16le").toString("base64"),
                ],
              },
              {
                platform: "win32",
                env: { ...process.env, PSModulePath: "C:\\piedpiper-no-such-modules" },
              },
            ),
          );

          const deadline = Date.now() + 20_000;
          let recorded: string | undefined;
          while (recorded === undefined && Date.now() < deadline) {
            recorded = await readFile(outputPath, "utf8").catch(() => undefined);
            if (recorded === undefined) await new Promise((resolve) => setTimeout(resolve, 50));
          }
          assert.equal(
            recorded?.trim(),
            folderVerb === "open"
              ? `"C:\\workspace with spaces\\author's media"`
              : `/select,"${target.replaceAll("/", "\\")}"`,
          );
        } finally {
          // The recorder's cmd.exe can hold the directory for a moment after publishing its output.
          await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
        }
      },
      30_000,
    );
  }

  it.effect("ignores reveal for code editors", () =>
    Effect.gen(function* () {
      const launch = yield* resolveEditorLaunch(
        { cwd: "/tmp/ws/a.ts:3", editor: "vscode", reveal: true },
        "darwin",
        NO_INSTALLED_EDITORS,
      );
      assert.deepEqual(launch, { command: "code", args: ["--goto", "/tmp/ws/a.ts:3"] });
    }),
  );
});

it.layer(NodeServices.layer)("launchDetached", (it) => {
  it.effect("resolves when command can be spawned", () =>
    Effect.gen(function* () {
      const result = yield* launchDetached({
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
      }).pipe(Effect.result);
      assertSuccess(result, undefined);
    }),
  );

  it.effect("rejects when command does not exist", () =>
    Effect.gen(function* () {
      const result = yield* launchDetached({
        command: `piedpiper-no-such-command-${Date.now()}`,
        args: [],
      }).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
    }),
  );

  it.effect("starts the fallback when the command is missing", () =>
    Effect.gen(function* () {
      const result = yield* launchDetached({
        command: `piedpiper-no-such-command-${Date.now()}`,
        args: [],
        fallback: { command: process.execPath, args: ["-e", "process.exit(0)"] },
      }).pipe(Effect.result);
      assertSuccess(result, undefined);
    }),
  );

  it.effect("reports the fallback's failure when both launches fail", () =>
    Effect.gen(function* () {
      const result = yield* launchDetached({
        command: "piedpiper-no-such-first",
        args: [],
        fallback: { command: "piedpiper-no-such-second", args: [] },
      }).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.include(result.failure.message, "piedpiper-no-such-second");
      }
    }),
  );

  it.effect("removes a launch's unsetEnv variables in any casing and keeps the rest", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "piedpiper-open-unset-env-" });
      const outPath = path.join(dir, "env.json");

      yield* launchDetached(
        {
          command: process.execPath,
          args: [
            "-e",
            "require('node:fs').writeFileSync(process.argv[1], JSON.stringify(process.env))",
            outPath,
          ],
          unsetEnv: ["PSModulePath"],
        },
        {
          env: {
            ...process.env,
            PSModulePath: "C:\\pwsh7\\Modules",
            psmodulepath: "C:\\pwsh7\\Modules",
            OPEN_TEST_KEEP: "visible",
          },
        },
      );

      const childEnv = yield* Effect.tryPromise(async () => {
        const { readFile } = await import("node:fs/promises");
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          try {
            return JSON.parse(await readFile(outPath, "utf8")) as NodeJS.ProcessEnv;
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
        }
        throw new Error("launched process did not write its environment");
      });

      const keys = Object.keys(childEnv).map((key) => key.toUpperCase());
      assert.notInclude(keys, "PSMODULEPATH");
      assert.equal(childEnv.OPEN_TEST_KEEP, "visible");
    }),
  );

  it.effect("does not pass ELECTRON_RUN_AS_NODE or PIEDPIPER_* to launched processes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "piedpiper-open-env-" });
      const outPath = path.join(dir, "env.json");

      yield* launchDetached(
        {
          command: process.execPath,
          args: [
            "-e",
            "require('node:fs').writeFileSync(process.argv[1], JSON.stringify(process.env))",
            outPath,
          ],
        },
        {
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: "1",
            PIEDPIPER_AUTH_TOKEN: "secret",
            PIEDPIPER_PORT: "4242",
            PIEDPIPER_OPEN_TEST_KEEP: "visible",
          },
        },
      );

      const childEnv = yield* Effect.tryPromise(async () => {
        const { readFile } = await import("node:fs/promises");
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          try {
            return JSON.parse(await readFile(outPath, "utf8")) as NodeJS.ProcessEnv;
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
        }
        throw new Error("launched process did not write its environment");
      });

      assert.equal(childEnv.ELECTRON_RUN_AS_NODE, undefined);
      assert.equal(childEnv.PIEDPIPER_AUTH_TOKEN, undefined);
      assert.equal(childEnv.PIEDPIPER_PORT, undefined);
      assert.equal(childEnv.PIEDPIPER_OPEN_TEST_KEEP, undefined);
      // The child serializes the real key casing (`Path` on Windows), so compare case-insensitively.
      const pathOf = (env: NodeJS.ProcessEnv) =>
        Object.entries(env).find(([key]) => key.toUpperCase() === "PATH")?.[1];
      assert.equal(pathOf(childEnv), pathOf(process.env));
    }),
  );

  it.effect("refuses quotes and line breaks in the target when the editor is a Windows shim", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "piedpiper-open-shim-" });
      // Not executable on this host: the win32 availability check must go by PATHEXT alone.
      yield* fs.writeFileString(path.join(dir, "code.cmd"), "@echo off\r\n");
      yield* fs.chmod(path.join(dir, "code.cmd"), 0o644);
      const options = {
        env: { PATH: dir },
        platform: "win32" as const,
        isFile: (filePath: string) => filePath.toLowerCase().endsWith("code.cmd"),
      };

      for (const target of ['C:\\ws"&calc.exe', "C:\\ws\ncalc.exe"]) {
        const result = yield* launchDetached({ command: "code.cmd", args: [target] }, options).pipe(
          Effect.result,
        );
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") {
          assert.match(result.failure.message, /line breaks or double quotes/);
        }
      }
    }),
  );
});

describe("network path guard", () => {
  it("detects UNC-style targets", () => {
    assert.isTrue(isNetworkPath("\\\\attacker\\share\\x.md"));
    assert.isTrue(isNetworkPath("//attacker/share/x.md"));
    assert.isTrue(isNetworkPath("/\\attacker/share"));
    assert.isFalse(isNetworkPath("/Users/me/project"));
    assert.isFalse(isNetworkPath("C:\\work\\project"));
  });

  it("allows network targets only inside a known root", () => {
    const roots = ["\\\\server\\share\\project"];
    assert.isTrue(isPathInsideAnyRoot("\\\\server\\share\\project", roots));
    assert.isTrue(isPathInsideAnyRoot("//SERVER/share/project/src/a.ts:12:3", roots));
    assert.isFalse(isPathInsideAnyRoot("\\\\server\\share\\project-other\\a.ts", roots));
    assert.isFalse(isPathInsideAnyRoot("\\\\server\\share\\project\\..\\secret", roots));
    assert.isFalse(isPathInsideAnyRoot("\\\\attacker\\share\\x.md", ["/Users/me/project"]));
  });
});

describe("resolveEditorSpawnCommand on win32", () => {
  const target = "C:\\Users\\jö\\R&D (100%)\\naïve ^file!.ts:3:7";

  it("starts a Windows command shim for unicode paths with cmd metacharacters", () => {
    const shimPath = "C:\\Tools\\code.cmd";
    const spawnCommand = resolveEditorSpawnCommand(
      { command: "code", args: ["--goto", target] },
      {
        platform: "win32",
        env: { PATH: "C:\\Tools" },
        isFile: (filePath) => filePath === shimPath,
      },
    );
    assert.deepEqual(spawnCommand, {
      command: [
        '^"C:\\Tools\\code.cmd^"',
        '^"--goto^"',
        '^"C:\\Users\\jö\\R^&D^ ^(100^%^)\\naïve^ ^^file^!.ts:3:7^"',
      ].join(" "),
      args: [],
      shell: true,
    });
  });

  it("passes line breaks and quotes unchanged to editors started without a shell", () => {
    const exePath = "C:\\Tools\\code.exe";
    const args = ["--goto", 'C:\\ws\nnext"line.ts'];
    assert.deepEqual(
      resolveEditorSpawnCommand(
        { command: "code", args },
        {
          platform: "win32",
          env: { PATH: "C:\\Tools" },
          isFile: (filePath) => filePath === exePath,
        },
      ),
      { command: exePath, args, shell: false },
    );
  });
});

it("resolveLaunchEnv strips ELECTRON_RUN_AS_NODE and PIEDPIPER_* while keeping other variables", () => {
  const env = resolveLaunchEnv({
    PATH: "/usr/bin",
    HOME: "/home/user",
    ELECTRON_RUN_AS_NODE: "1",
    electron_run_as_node: "1",
    PIEDPIPER_HOME: "/home/user/.piedpiper",
    piedpiper_mode: "desktop",
    PIEDPIPERISH: "kept",
  });
  assert.deepEqual(env, { PATH: "/usr/bin", HOME: "/home/user", PIEDPIPERISH: "kept" });
});

it.layer(NodeServices.layer)("isCommandAvailable", (it) => {
  it.effect("resolves win32 commands with PATHEXT", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "piedpiper-open-test-" });
      yield* fs.writeFileString(path.join(dir, "code.CMD"), "@echo off\r\n");
      const env = {
        PATH: dir,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      } satisfies NodeJS.ProcessEnv;
      const result = yield* Effect.tryPromise(() =>
        isCommandAvailable("code", { platform: "win32", env }),
      );
      assert.equal(result, true);
    }),
  );

  it.effect("returns false when a command is not on PATH", () =>
    Effect.gen(function* () {
      const env = {
        PATH: "",
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      } satisfies NodeJS.ProcessEnv;
      const result = yield* Effect.tryPromise(() =>
        isCommandAvailable("definitely-not-installed", { platform: "win32", env }),
      );
      assert.equal(result, false);
    }),
  );

  it.effect("does not treat bare files without executable extension as available on win32", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "piedpiper-open-test-" });
      yield* fs.writeFileString(path.join(dir, "npm"), "echo nope\r\n");
      const env = {
        PATH: dir,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      } satisfies NodeJS.ProcessEnv;
      const result = yield* Effect.tryPromise(() =>
        isCommandAvailable("npm", { platform: "win32", env }),
      );
      assert.equal(result, false);
    }),
  );

  it.effect("appends PATHEXT for commands with non-executable extensions on win32", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "piedpiper-open-test-" });
      yield* fs.writeFileString(path.join(dir, "my.tool.CMD"), "@echo off\r\n");
      const env = {
        PATH: dir,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      } satisfies NodeJS.ProcessEnv;
      const result = yield* Effect.tryPromise(() =>
        isCommandAvailable("my.tool", { platform: "win32", env }),
      );
      assert.equal(result, true);
    }),
  );

  it.effect("uses platform-specific PATH delimiter for platform overrides", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const firstDir = yield* fs.makeTempDirectoryScoped({ prefix: "piedpiper-open-test-" });
      const secondDir = yield* fs.makeTempDirectoryScoped({ prefix: "piedpiper-open-test-" });
      yield* fs.writeFileString(path.join(firstDir, "code.CMD"), "@echo off\r\n");
      yield* fs.writeFileString(path.join(secondDir, "code.CMD"), "MZ");
      const env = {
        PATH: `${firstDir};${secondDir}`,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      } satisfies NodeJS.ProcessEnv;
      const result = yield* Effect.tryPromise(() =>
        isCommandAvailable("code", { platform: "win32", env }),
      );
      assert.equal(result, true);
    }),
  );
});

it.layer(NodeServices.layer)("home-relative targets", (it) => {
  const launchFor = (
    cwd: string,
    editor: OpenInEditorInput["editor"],
    platform: NodeJS.Platform = "darwin",
    extra: { readonly reveal?: boolean } = {},
    homeDir = platform === "win32" ? "C:\\Users\\me" : "/Users/me",
  ) =>
    resolveEditorLaunch({ cwd, editor, ...extra }, platform, {
      ...NO_INSTALLED_EDITORS,
      homeDir,
    });

  it.effect("expands ~/ for editors and keeps the position", () =>
    Effect.gen(function* () {
      assert.deepEqual((yield* launchFor("~/a dir/b.ts:12:3", "vscode")).args, [
        "--goto",
        "/Users/me/a dir/b.ts:12:3",
      ]);
      assert.deepEqual((yield* launchFor("~/b.ts:12:3", "zed")).args, ["/Users/me/b.ts:12:3"]);
      assert.deepEqual((yield* launchFor("~/b.ts:12:3", "idea")).args, [
        "--line",
        "12",
        "--column",
        "2",
        "/Users/me/b.ts",
      ]);
    }),
  );

  it.effect("expands ~/ for the file manager and reveal", () =>
    Effect.gen(function* () {
      assert.deepEqual((yield* launchFor("~/ws", "file-manager")).args, ["/Users/me/ws"]);
      assert.deepEqual(
        (yield* launchFor("~/ws/a.ts:4", "file-manager", "darwin", { reveal: true })).args,
        ["-R", "/Users/me/ws/a.ts"],
      );
      assert.deepEqual(
        (yield* launchFor("~/ws/a.ts:4", "file-manager", "linux", { reveal: true }, "/home/me"))
          .args,
        ["/home/me/ws"],
      );
      assert.deepEqual((yield* launchFor("~/ws/a b", "file-manager", "win32")).args, [
        "C:\\Users\\me\\ws\\a b",
      ]);
      assert.deepEqual((yield* launchFor("~\\ws", "file-manager", "win32")).args, [
        "C:\\Users\\me\\ws",
      ]);
    }),
  );

  it.effect("leaves other paths alone", () =>
    Effect.gen(function* () {
      for (const cwd of ["/tmp/a.ts", "relative/a.ts", "foo~/x", "~other/x", "~\\x"]) {
        assert.deepEqual((yield* launchFor(cwd, "zed")).args, [cwd]);
      }
    }),
  );
});

it.layer(NodeServices.layer)("resolveAvailableEditors", (it) => {
  it.effect("returns installed editors for command launches", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "piedpiper-editors-" });

      yield* fs.writeFileString(path.join(dir, "trae.CMD"), "@echo off\r\n");
      yield* fs.writeFileString(path.join(dir, "code-insiders.CMD"), "@echo off\r\n");
      yield* fs.writeFileString(path.join(dir, "codium.CMD"), "@echo off\r\n");
      yield* fs.writeFileString(path.join(dir, "kiro.CMD"), "@echo off\r\n");
      yield* fs.writeFileString(path.join(dir, "pycharm.CMD"), "@echo off\r\n");
      yield* fs.writeFileString(path.join(dir, "explorer.CMD"), "MZ");
      const editors = yield* Effect.tryPromise(() =>
        resolveAvailableEditors("win32", {
          PATH: dir,
          PATHEXT: ".COM;.EXE;.BAT;.CMD",
        }),
      );
      assert.deepEqual(editors, [
        "trae",
        "vscode-insiders",
        "vscodium",
        "kiro",
        "pycharm",
        "file-manager",
      ]);
    }),
  );
});

describe("makeCachedEditorDiscovery", () => {
  it("shares one cold scan and reuses fresh results", async () => {
    let calls = 0;
    const discover = makeCachedEditorDiscovery(async () => {
      calls += 1;
      return ["vscode"] as const;
    });
    const [first, second] = await Promise.all([discover(), discover()]);
    assert.deepStrictEqual(first, ["vscode"]);
    assert.deepStrictEqual(second, ["vscode"]);
    assert.deepStrictEqual(await discover(), ["vscode"]);
    assert.strictEqual(calls, 1);
  });

  it("serves the stale list while one background refresh runs", async () => {
    let clock = 0;
    let calls = 0;
    let release: (() => void) | undefined;
    const discover = makeCachedEditorDiscovery(
      async () => {
        calls += 1;
        if (calls === 1) return ["vscode"] as const;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return ["cursor"] as const;
      },
      { ttlMs: 1_000, now: () => clock },
    );
    assert.deepStrictEqual(await discover(), ["vscode"]);
    clock = 2_000;
    assert.deepStrictEqual(await discover(), ["vscode"]);
    assert.deepStrictEqual(await discover(), ["vscode"]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.strictEqual(calls, 2);
    release?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepStrictEqual(await discover(), ["cursor"]);
  });

  it("keeps the last list when a refresh fails and retries a failed cold scan", async () => {
    let clock = 0;
    let calls = 0;
    const discover = makeCachedEditorDiscovery(
      async () => {
        calls += 1;
        if (calls === 1) throw new Error("boom");
        if (calls === 3) throw new Error("refresh boom");
        return ["zed"] as const;
      },
      { ttlMs: 1_000, now: () => clock },
    );
    await discover().then(
      () => assert.fail("expected the cold scan to fail"),
      () => undefined,
    );
    assert.deepStrictEqual(await discover(), ["zed"]);
    clock = 5_000;
    assert.deepStrictEqual(await discover(), ["zed"]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.strictEqual(calls, 3);
    assert.deepStrictEqual(await discover(), ["zed"]);
  });

  it("starts a new refresh once a hung refresh times out", async () => {
    let clock = 0;
    let calls = 0;
    const discover = makeCachedEditorDiscovery(
      async () => {
        calls += 1;
        if (calls === 1) return ["vscode"] as const;
        if (calls === 2) return new Promise<ReadonlyArray<"cursor">>(() => {});
        return ["cursor"] as const;
      },
      { ttlMs: 1_000, now: () => clock, refreshTimeoutMs: 20 },
    );
    assert.deepStrictEqual(await discover(), ["vscode"]);
    clock = 2_000;
    assert.deepStrictEqual(await discover(), ["vscode"]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepStrictEqual(await discover(), ["vscode"]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.strictEqual(calls, 2);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.deepStrictEqual(await discover(), ["vscode"]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.strictEqual(calls, 3);
    assert.deepStrictEqual(await discover(), ["cursor"]);
  });
});

describe("resolveAvailableEditorsForConfig", () => {
  it.live("degrades to an empty list when discovery stalls", () =>
    Effect.gen(function* () {
      const editors = yield* resolveAvailableEditorsForConfig(() => new Promise(() => {}), 10);
      assert.deepStrictEqual(editors, []);
    }),
  );

  it.effect("degrades to an empty list when discovery fails", () =>
    Effect.gen(function* () {
      const editors = yield* resolveAvailableEditorsForConfig(() =>
        Promise.reject(new Error("boom")),
      );
      assert.deepStrictEqual(editors, []);
    }),
  );
});

const makeExecutable = async (root: string, relativePath: string, mode = 0o755) => {
  const { chmod, mkdir, writeFile } = await import("node:fs/promises");
  const { dirname, join } = await import("node:path");
  const filePath = join(root, relativePath);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, "#!/bin/sh\n");
  await chmod(filePath, mode);
  return filePath;
};
const makeTempDir = async () => {
  const { mkdtemp, realpath } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  return realpath(await mkdtemp(join(tmpdir(), "piedpiper-editor-installs-")));
};

describe("editor install locations", () => {
  const launchFor = (
    cwd: string,
    editor: OpenInEditorInput["editor"],
    platform: NodeJS.Platform,
    lookup: { env: NodeJS.ProcessEnv; systemRoot: string },
  ) => Effect.runPromise(resolveEditorLaunch({ cwd, editor }, platform, lookup));

  for (const { platform, installPath, editor, args } of [
    {
      platform: "darwin",
      installPath: "Applications/Cursor.app/Contents/Resources/app/bin/cursor",
      editor: "cursor",
      args: ["--classic", "--goto", "/ws/file.ts:12:4"],
    },
    {
      platform: "darwin",
      installPath: "Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
      editor: "vscode",
      args: ["--goto", "/ws/file.ts:12:4"],
    },
    {
      platform: "darwin",
      installPath: "Applications/IntelliJ IDEA CE.app/Contents/MacOS/idea",
      editor: "idea",
      args: ["--line", "12", "--column", "3", "/ws/file.ts"],
    },
    {
      platform: "darwin",
      installPath: "Applications/Zed.app/Contents/MacOS/cli",
      editor: "zed",
      args: ["/ws/file.ts:12:4"],
    },
    {
      platform: "linux",
      installPath: ".local/share/JetBrains/Toolbox/scripts/idea",
      editor: "idea",
      args: ["--line", "12", "--column", "3", "/ws/file.ts"],
    },
    {
      platform: "linux",
      installPath: ".local/bin/zed",
      editor: "zed",
      args: ["/ws/file.ts:12:4"],
    },
    {
      platform: "darwin",
      installPath: "Applications/Antigravity IDE.app/Contents/Resources/app/bin/antigravity-ide",
      editor: "antigravity",
      args: ["--goto", "/ws/file.ts:12:4"],
    },
    {
      platform: "linux",
      installPath: ".local/bin/antigravity-ide",
      editor: "antigravity",
      args: ["--goto", "/ws/file.ts:12:4"],
    },
    {
      platform: "darwin",
      installPath: "Applications/PyCharm CE.app/Contents/MacOS/pycharm",
      editor: "pycharm",
      args: ["--line", "12", "--column", "3", "/ws/file.ts"],
    },
    {
      platform: "linux",
      installPath: ".local/share/JetBrains/Toolbox/scripts/rustrover",
      editor: "rustrover",
      args: ["--line", "12", "--column", "3", "/ws/file.ts"],
    },
  ] as const) {
    it.skipIf(windowsHost)(
      `discovers and launches ${editor} outside PATH on ${platform}`,
      async () => {
        const home = await makeTempDir();
        const executable = await makeExecutable(home, installPath);
        const lookup = { env: { HOME: home, PATH: "" }, systemRoot: `${home}/system` };

        const editors = await resolveAvailableEditors(platform, lookup.env, lookup);
        assert.include(editors, editor);
        assert.deepEqual(await launchFor("/ws/file.ts:12:4", editor, platform, lookup), {
          command: executable,
          args: [...args],
        });
      },
    );
  }

  it.skipIf(windowsHost)(
    "finds system-wide installs under /Applications and /snap/bin",
    async () => {
      const root = await makeTempDir();
      const cursor = await makeExecutable(
        root,
        "Applications/Cursor.app/Contents/Resources/app/bin/code",
      );
      const codium = await makeExecutable(root, "snap/bin/codium");
      const env = { PATH: "" };
      assert.equal(
        (await launchFor("/ws", "cursor", "darwin", { env, systemRoot: root })).command,
        cursor,
      );
      assert.equal(
        (await launchFor("/ws", "vscodium", "linux", { env, systemRoot: root })).command,
        codium,
      );
    },
  );

  it("launches a Program Files .cmd shim through the Windows quoting", async () => {
    const localAppData = await makeTempDir();
    const shim = await makeExecutable(localAppData, "Programs/Microsoft VS Code/bin/code.cmd");
    const lookup = { env: { LOCALAPPDATA: localAppData, PATH: "" }, systemRoot: localAppData };

    assert.include(await resolveAvailableEditors("win32", lookup.env, lookup), "vscode");
    const launch = await launchFor("/ws with spaces/a.ts:1", "vscode", "win32", lookup);
    assert.equal(launch.command, shim);
    const spawnCommand = resolveEditorSpawnCommand(launch, {
      platform: "win32",
      env: lookup.env,
      isFile: (filePath) => filePath === shim,
    });
    assert.equal(spawnCommand?.shell, true);
    assert.include(spawnCommand?.command ?? "", "code.cmd^");
    assert.include(spawnCommand?.command ?? "", '^"/ws^ with^ spaces/a.ts:1^"');
  });

  it("launches Cursor's Program Files .cmd shim with --classic first", async () => {
    const localAppData = await makeTempDir();
    const shim = await makeExecutable(localAppData, "Programs/cursor/resources/app/bin/cursor.cmd");
    const lookup = { env: { LOCALAPPDATA: localAppData, PATH: "" }, systemRoot: localAppData };
    const launch = await launchFor("C:\\ws with spaces\\a.ts:12:4", "cursor", "win32", lookup);
    assert.deepEqual(launch, {
      command: shim,
      args: ["--classic", "--goto", "C:\\ws with spaces\\a.ts:12:4"],
    });
    const spawnCommand = resolveEditorSpawnCommand(launch, {
      platform: "win32",
      env: lookup.env,
      isFile: (filePath) => filePath === shim,
    });
    assert.equal(spawnCommand?.shell, true);
    const command = spawnCommand?.command ?? "";
    const classic = command.indexOf('^"--classic^"');
    assert.isAbove(classic, command.indexOf("cursor.cmd"));
    assert.isAbove(command.indexOf('^"--goto^"'), classic);
    assert.include(command, '^"C:\\ws^ with^ spaces\\a.ts:12:4^"');
  });

  it.skipIf(windowsHost)("launches a bundled Kiro without the ide subcommand", async () => {
    const home = await makeTempDir();
    const mac = await makeExecutable(home, "Applications/Kiro.app/Contents/Resources/app/bin/kiro");
    const linux = await makeExecutable(home, ".local/bin/kiro");
    const lookup = { env: { HOME: home, PATH: "" }, systemRoot: `${home}/system` };
    assert.deepEqual(await launchFor("/ws/a.ts:3", "kiro", "darwin", lookup), {
      command: mac,
      args: ["--goto", "/ws/a.ts:3"],
    });
    assert.deepEqual(await launchFor("/ws/a.ts:3", "kiro", "linux", lookup), {
      command: linux,
      args: ["ide", "--goto", "/ws/a.ts:3"],
    });

    const localAppData = await makeTempDir();
    const shim = await makeExecutable(localAppData, "Programs/Kiro/bin/kiro.cmd");
    const winLookup = { env: { LOCALAPPDATA: localAppData, PATH: "" }, systemRoot: localAppData };
    assert.deepEqual(await launchFor("/ws", "kiro", "win32", winLookup), {
      command: shim,
      args: ["/ws"],
    });
  });

  it.skipIf(windowsHost)("does not report the agy CLI as the Antigravity IDE", async () => {
    const home = await makeTempDir();
    await makeExecutable(home, ".local/bin/agy");
    await makeExecutable(home, "Applications/Antigravity.app/Contents/Resources/app/bin/agy");
    for (const platform of ["darwin", "linux"] as const) {
      const lookup = {
        env: { HOME: home, PATH: `${home}/.local/bin` },
        systemRoot: `${home}/system`,
      };
      assert.notInclude(await resolveAvailableEditors(platform, lookup.env, lookup), "antigravity");
    }

    const localAppData = await makeTempDir();
    await makeExecutable(localAppData, "Programs/Antigravity/bin/agy.cmd");
    const winLookup = {
      env: {
        LOCALAPPDATA: localAppData,
        PATH: `${localAppData}/Programs/Antigravity/bin`,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      },
      systemRoot: localAppData,
    };
    assert.isTrue(await isCommandAvailable("agy", { platform: "win32", env: winLookup.env }));
    assert.notInclude(
      await resolveAvailableEditors("win32", winLookup.env, winLookup),
      "antigravity",
    );
  });

  it("finds a JetBrains Rider install on Windows", async () => {
    const programFiles = await makeTempDir();
    const exe = await makeExecutable(
      programFiles,
      "JetBrains/JetBrains Rider 2026.1/bin/rider64.exe",
    );
    const lookup = { env: { ProgramFiles: programFiles, PATH: "" }, systemRoot: programFiles };
    assert.equal((await launchFor("/ws", "rider", "win32", lookup)).command, exe);
  });

  it("finds a versioned JetBrains install on Windows", async () => {
    const programFiles = await makeTempDir();
    const exe = await makeExecutable(programFiles, "JetBrains/IntelliJ IDEA 2026.2/bin/idea64.exe");
    const lookup = { env: { ProgramFiles: programFiles, PATH: "" }, systemRoot: programFiles };
    assert.equal((await launchFor("/ws", "idea", "win32", lookup)).command, exe);
  });

  it("picks the exact or newest JetBrains install regardless of directory order", async () => {
    const programFiles = await makeTempDir();
    await makeExecutable(programFiles, "JetBrains/IntelliJ IDEA 2025.3/bin/idea64.exe");
    await makeExecutable(programFiles, "JetBrains/IntelliJ IDEA 2026.2/bin/idea64.exe");
    const newest = await makeExecutable(
      programFiles,
      "JetBrains/IntelliJ IDEA 2026.10/bin/idea64.exe",
    );
    const lookup = { env: { ProgramFiles: programFiles, PATH: "" }, systemRoot: programFiles };
    assert.equal((await launchFor("/ws", "idea", "win32", lookup)).command, newest);

    const home = await makeTempDir();
    await makeExecutable(home, "Applications/IntelliJ IDEA CE.app/Contents/MacOS/idea");
    const exact = await makeExecutable(home, "Applications/IntelliJ IDEA.app/Contents/MacOS/idea");
    const macLookup = { env: { HOME: home, PATH: "" }, systemRoot: `${home}/system` };
    assert.equal((await launchFor("/ws", "idea", "darwin", macLookup)).command, exact);
  });

  it("reads each JetBrains install root once per scan", async () => {
    const programFiles = await makeTempDir();
    class CountingEntries extends Map<string, Promise<ReadonlyArray<string>>> {
      reads: string[] = [];
      override set(key: string, value: Promise<ReadonlyArray<string>>) {
        this.reads.push(key);
        return super.set(key, value);
      }
    }
    const entries = new CountingEntries();
    const env = {
      PATH: "",
      ProgramFiles: programFiles,
      ProgramW6432: `${programFiles.toUpperCase()}\\`,
    };
    for (const id of ["idea", "pycharm", "rider"] as const) {
      const editor = EDITORS.find((candidate) => candidate.id === id)!;
      assert.isNull(
        await resolveEditorCommand(editor, {
          platform: "win32",
          env,
          entries: entries as DirectoryEntries,
          systemRoot: programFiles,
        }),
      );
    }
    assert.equal(entries.reads.length, 2);
  });

  it.skipIf(windowsHost)(
    "ignores non-executable bundle files and prefers a PATH launcher",
    async () => {
      const home = await makeTempDir();
      const bundled = await makeExecutable(
        home,
        "Applications/Cursor.app/Contents/Resources/app/bin/cursor",
        0o644,
      );
      const lookup = { env: { HOME: home, PATH: `${home}/bin` }, systemRoot: `${home}/system` };
      assert.notInclude(await resolveAvailableEditors("darwin", lookup.env, lookup), "cursor");

      const { chmod } = await import("node:fs/promises");
      await chmod(bundled, 0o755);
      await makeExecutable(home, "bin/cursor");
      assert.equal((await launchFor("/ws", "cursor", "darwin", lookup)).command, "cursor");
    },
  );
});

const setupZedCommands = async (names: ReadonlyArray<string>) => {
  const { chmod, mkdtemp, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "piedpiper-zed-"));
  for (const name of names) {
    await writeFile(join(dir, name), "#!/bin/sh\n");
    await chmod(join(dir, name), 0o755);
  }
  return { env: { PATH: dir }, systemRoot: join(dir, "system") };
};

describe("zed command aliases", () => {
  it.skipIf(windowsHost)("discovers and launches zeditor when zed is not installed", async () => {
    const lookup = await setupZedCommands(["zeditor"]);
    assert.include(await resolveAvailableEditors("darwin", lookup.env, lookup), "zed");
    const launch = await Effect.runPromise(
      resolveEditorLaunch({ cwd: "/ws", editor: "zed" }, "darwin", lookup),
    );
    assert.deepEqual(launch, { command: "zeditor", args: ["/ws"] });
  });

  it.skipIf(windowsHost)("prefers zeditor over the OpenZFS zed on Linux only", async () => {
    const lookup = await setupZedCommands(["zed", "zeditor"]);
    const linux = await Effect.runPromise(
      resolveEditorLaunch({ cwd: "/ws", editor: "zed" }, "linux", lookup),
    );
    assert.equal(linux.command, "zeditor");
    const darwin = await Effect.runPromise(
      resolveEditorLaunch({ cwd: "/ws", editor: "zed" }, "darwin", lookup),
    );
    assert.equal(darwin.command, "zed");
  });

  const zedLaunch = (lookup: { env: NodeJS.ProcessEnv; systemRoot: string }) =>
    Effect.runPromise(resolveEditorLaunch({ cwd: "/ws", editor: "zed" }, "linux", lookup));

  it.skipIf(windowsHost)("prefers the Zed bundle over a zed on PATH on macOS", async () => {
    const root = await makeTempDir();
    const cli = await makeExecutable(root, "Applications/Zed.app/Contents/MacOS/cli");
    await makeExecutable(root, "zfs/bin/zed");
    const lookup = {
      env: { HOME: root, PATH: `${root}/zfs/bin` },
      systemRoot: `${root}/system`,
    };
    assert.include(await resolveAvailableEditors("darwin", lookup.env, lookup), "zed");
    for (const cwd of ["/ws with spaces/", "/ws with spaces/file.ts:12:4"]) {
      const launch = await Effect.runPromise(
        resolveEditorLaunch({ cwd, editor: "zed" }, "darwin", lookup),
      );
      assert.deepEqual(launch, { command: cli, args: [cwd] });
    }
  });

  it.skipIf(windowsHost)("keeps a PATH zed linked into a Zed bundle on macOS", async () => {
    const { mkdir, symlink } = await import("node:fs/promises");
    const root = await makeTempDir();
    await makeExecutable(root, "Applications/Zed.app/Contents/MacOS/cli");
    const preview = await makeExecutable(root, "Applications/Zed Preview.app/Contents/MacOS/cli");
    await makeExecutable(root, "zfs/bin/zed");
    await mkdir(`${root}/bin`, { recursive: true });
    await symlink(preview, `${root}/bin/zed`);
    // An unrelated zed earlier on PATH must not win over the link further along.
    const lookup = {
      env: { HOME: root, PATH: `${root}/zfs/bin:${root}/bin` },
      systemRoot: `${root}/system`,
    };
    const launch = await Effect.runPromise(
      resolveEditorLaunch({ cwd: "/ws", editor: "zed" }, "darwin", lookup),
    );
    assert.deepEqual(launch, { command: `${root}/bin/zed`, args: ["/ws"] });
  });

  it.skipIf(windowsHost)("does not mistake the OpenZFS zed for the editor on Linux", async () => {
    const root = await makeTempDir();
    await makeExecutable(root, "sbin/zed");
    await makeExecutable(root, "usr/bin/zed");
    for (const PATH of [`${root}/sbin`, `${root}/usr/bin`]) {
      const lookup = { env: { HOME: `${root}/home`, PATH }, systemRoot: root };
      assert.notInclude(await resolveAvailableEditors("linux", lookup.env, lookup), "zed");
      assert.equal((await zedLaunch(lookup)).command, "zeditor");
    }
  });

  it.skipIf(windowsHost)(
    "prefers the zed.dev install in ~/.local/bin over a PATH zed on Linux",
    async () => {
      const { symlink } = await import("node:fs/promises");
      const root = await makeTempDir();
      await makeExecutable(root, "sbin/zed");
      const cli = await makeExecutable(root, ".local/zed.app/bin/zed");
      await makeExecutable(root, ".local/bin/.keep");
      await symlink(cli, `${root}/.local/bin/zed`);
      const lookup = { env: { HOME: root, PATH: `${root}/sbin` }, systemRoot: `${root}/system` };
      assert.include(await resolveAvailableEditors("linux", lookup.env, lookup), "zed");
      assert.equal((await zedLaunch(lookup)).command, `${root}/.local/bin/zed`);

      // A PATH zed that links into Zed's install tree is the editor.
      const pathLookup = {
        env: { HOME: `${root}/elsewhere`, PATH: `${root}/sbin:${root}/.local/bin` },
        systemRoot: `${root}/system`,
      };
      assert.equal((await zedLaunch(pathLookup)).command, `${root}/.local/bin/zed`);
    },
  );

  it.skipIf(windowsHost)(
    "launches ~/.local/bin/zeditor over a zed earlier on PATH on Linux",
    async () => {
      const root = await makeTempDir();
      await makeExecutable(root, "bin/zed");
      const zeditor = await makeExecutable(root, ".local/bin/zeditor");
      const lookup = { env: { HOME: root, PATH: `${root}/bin` }, systemRoot: `${root}/system` };
      assert.include(await resolveAvailableEditors("linux", lookup.env, lookup), "zed");
      assert.equal((await zedLaunch(lookup)).command, zeditor);
    },
  );
});

const rejecting: LinuxProbeRunner = () => Promise.reject(new Error("boom"));

describe("Linux file manager", () => {
  const makeRecorder = (result: Awaited<ReturnType<LinuxProbeRunner>>) => {
    const calls: Array<{
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly timeoutMs: number;
    }> = [];
    const runProbe: LinuxProbeRunner = async (command, args, { timeoutMs }) => {
      calls.push({ command, args, timeoutMs });
      return result;
    };
    return { calls, runProbe };
  };
  const pathWith = async (names: ReadonlyArray<string>) => {
    const root = await makeTempDir();
    for (const name of names) await makeExecutable(root, `bin/${name}`);
    return `${root}/bin`;
  };

  describe("reveal", () => {
    const revealInput = { cwd: "/ws/a.ts:3", editor: "file-manager", reveal: true } as const;

    it.skipIf(windowsHost)("selects the item over D-Bus with an escaped file URL", async () => {
      const { calls, runProbe } = makeRecorder({ exitCode: 0, stdout: "" });
      const PATH = await pathWith(["gdbus"]);
      assert.isTrue(await tryRevealLinuxItem(`/ws/a"b\\c d'e.ts`, { env: { PATH }, runProbe }));
      assert.equal(calls[0]?.command, "gdbus");
      assert.equal(calls[0]?.timeoutMs, 2_000);
      assert.deepEqual(calls[0]?.args, [
        "call",
        "--session",
        "--dest",
        "org.freedesktop.FileManager1",
        "--object-path",
        "/org/freedesktop/FileManager1",
        "--method",
        "org.freedesktop.FileManager1.ShowItems",
        `["file:///ws/a%22b%5Cc%20d'e.ts"]`,
        "",
      ]);
    });

    it.skipIf(windowsHost)("falls back when D-Bus cannot select the item", async () => {
      const PATH = await pathWith(["gdbus"]);
      const env = { PATH };
      const failed = makeRecorder({ exitCode: 1, stdout: "" });
      assert.isFalse(await tryRevealLinuxItem("/ws/a.ts", { env, runProbe: failed.runProbe }));
      const timedOut = makeRecorder({ exitCode: null, stdout: "" });
      assert.isFalse(await tryRevealLinuxItem("/ws/a.ts", { env, runProbe: timedOut.runProbe }));
      assert.isFalse(await tryRevealLinuxItem("/ws/a.ts", { env, runProbe: rejecting }));

      const noGdbus = makeRecorder({ exitCode: 0, stdout: "" });
      assert.isFalse(
        await tryRevealLinuxItem("/ws/a.ts", { env: { PATH: "" }, runProbe: noGdbus.runProbe }),
      );
      assert.lengthOf(noGdbus.calls, 0);
      const relative = makeRecorder({ exitCode: 0, stdout: "" });
      assert.isFalse(await tryRevealLinuxItem("a.ts", { env, runProbe: relative.runProbe }));
      assert.lengthOf(relative.calls, 0);
    });

    it.skipIf(windowsHost)("skips xdg-open once the item is selected", async () => {
      const { calls, runProbe } = makeRecorder({ exitCode: 0, stdout: "" });
      const env = { PATH: await pathWith(["gdbus"]) };
      // xdg-open is not installed, so reaching it would fail.
      await Effect.runPromise(launchEditor(revealInput, { platform: "linux", env, runProbe }));
      assert.include(calls[0]?.args.at(-2) ?? "", "file:///ws/a.ts");
    });

    it.skipIf(windowsHost)("expands ~/ before asking the file manager", async () => {
      const { calls, runProbe } = makeRecorder({ exitCode: 0, stdout: "" });
      const env = { PATH: await pathWith(["gdbus"]) };
      await Effect.runPromise(
        launchEditor(
          { ...revealInput, cwd: "~/a.ts:3" },
          { platform: "linux", env, homeDir: "/home/me", runProbe },
        ),
      );
      assert.equal(calls[0]?.args.at(-2), `["file:///home/me/a.ts"]`);
    });

    it.skipIf(windowsHost)("opens the parent when the item could not be selected", async () => {
      const { runProbe } = makeRecorder({ exitCode: 1, stdout: "" });
      const options = { platform: "linux", runProbe } as const;
      const missing = await Effect.runPromise(
        launchEditor(revealInput, {
          ...options,
          env: { PATH: await pathWith(["gdbus"]) },
        }).pipe(Effect.result),
      );
      assert.equal(missing._tag, "Failure");
      if (missing._tag === "Failure") {
        assert.include(missing.failure.message, "xdg-open");
      }
      const opened = await Effect.runPromise(
        launchEditor(revealInput, {
          ...options,
          env: { PATH: await pathWith(["gdbus", "xdg-open"]) },
        }).pipe(Effect.result),
      );
      assert.equal(opened._tag, "Success");
    });

    it.skipIf(windowsHost)("uses D-Bus only for Linux file manager reveals", async () => {
      const { calls, runProbe } = makeRecorder({ exitCode: 0, stdout: "" });
      const env = { PATH: await pathWith(["gdbus", "xdg-open", "open"]) };
      for (const [input, platform] of [
        [{ cwd: "/ws", editor: "file-manager" }, "linux"],
        [revealInput, "darwin"],
      ] as const) {
        await Effect.runPromise(launchEditor(input, { platform, env, runProbe }));
      }
      assert.lengthOf(calls, 0);
    });
  });

  describe("discovery", () => {
    const fileManagerListed = async (
      env: NodeJS.ProcessEnv,
      runProbe: LinuxProbeRunner,
    ): Promise<boolean> =>
      (
        await resolveAvailableEditors("linux", env, {
          systemRoot: "/nonexistent-piedpiper-system-root",
          runProbe,
        })
      ).includes("file-manager");

    it.skipIf(windowsHost)(
      "needs a display, xdg-open, xdg-mime and a directory handler",
      async () => {
        const PATH = await pathWith(["xdg-open", "xdg-mime"]);
        const handler = makeRecorder({ exitCode: 0, stdout: "org.gnome.Nautilus.desktop\n" });
        assert.isTrue(await fileManagerListed({ PATH, DISPLAY: ":0" }, handler.runProbe));
        assert.deepEqual(handler.calls[0]?.args, ["query", "default", "inode/directory"]);
        assert.equal(handler.calls[0]?.timeoutMs, 2_000);
        assert.isTrue(
          await fileManagerListed({ PATH, WAYLAND_DISPLAY: "wayland-0" }, handler.runProbe),
        );

        const probes = handler.calls.length;
        assert.isFalse(await fileManagerListed({ PATH, DISPLAY: " " }, handler.runProbe));
        assert.isFalse(await fileManagerListed({ PATH }, handler.runProbe));
        assert.isFalse(
          await fileManagerListed(
            { PATH: await pathWith(["xdg-mime"]), DISPLAY: ":0" },
            handler.runProbe,
          ),
        );
        assert.isFalse(
          await fileManagerListed(
            { PATH: await pathWith(["xdg-open"]), DISPLAY: ":0" },
            handler.runProbe,
          ),
        );
        assert.equal(handler.calls.length, probes);

        const env = { PATH, DISPLAY: ":0" };
        assert.isFalse(
          await fileManagerListed(env, makeRecorder({ exitCode: 0, stdout: " \n" }).runProbe),
        );
        assert.isFalse(
          await fileManagerListed(env, makeRecorder({ exitCode: 1, stdout: "x.desktop" }).runProbe),
        );
        assert.isFalse(
          await fileManagerListed(env, makeRecorder({ exitCode: null, stdout: "" }).runProbe),
        );
        assert.isFalse(await fileManagerListed(env, rejecting));
      },
    );

    it.skipIf(windowsHost)("lists Files on WSL whenever xdg-open is on PATH", async () => {
      const PATH = await pathWith(["xdg-open"]);
      const probe = makeRecorder({ exitCode: 0, stdout: "" });
      for (const env of [
        { PATH, WSL_DISTRO_NAME: "Ubuntu" },
        { PATH, WSL_INTEROP: "/run/WSL/1_interop" },
        { PATH, WSL_DISTRO_NAME: "Ubuntu", DISPLAY: ":0" },
      ]) {
        assert.isTrue(await fileManagerListed(env, probe.runProbe));
      }
      assert.equal(probe.calls.length, 0);

      assert.isFalse(
        await fileManagerListed(
          { PATH: await pathWith([]), WSL_DISTRO_NAME: "Ubuntu" },
          probe.runProbe,
        ),
      );
      // A blank marker is not WSL, so the desktop checks still apply.
      assert.isFalse(await fileManagerListed({ PATH, WSL_DISTRO_NAME: " " }, probe.runProbe));
    });
  });

  describe("runLinuxProbe", () => {
    const env = { PATH: process.env.PATH ?? "" };

    it("returns the exit code and stdout", async () => {
      const result = await runLinuxProbe(
        process.execPath,
        ["-e", "process.stdout.write('hello'); process.exit(3)"],
        { env, timeoutMs: 30_000 },
      );
      assert.deepEqual(result, { exitCode: 3, stdout: "hello" });
    });

    it("reports a hung helper as a null exit code", async () => {
      const result = await runLinuxProbe(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        env,
        timeoutMs: 50,
      });
      assert.equal(result.exitCode, null);
    });

    it("reports a missing helper as a null exit code", async () => {
      const result = await runLinuxProbe(`piedpiper-no-such-command-${Date.now()}`, [], {
        env,
        timeoutMs: 30_000,
      });
      assert.equal(result.exitCode, null);
    });
  });
});

describe("isCommandAvailable directory listings", () => {
  it.skipIf(windowsHost)(
    "skips names missing from a cached listing and probes unreadable directories",
    async () => {
      const { chmod, mkdtemp, writeFile } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const dir = await mkdtemp(join(tmpdir(), "piedpiper-listing-"));
      await writeFile(join(dir, "code"), "#!/bin/sh\n");
      await chmod(join(dir, "code"), 0o755);
      const env = { PATH: dir };

      const stale: DirectoryListings = new Map([[dir, Promise.resolve(new Set<string>())]]);
      assert.isFalse(await isCommandAvailable("code", { platform: "linux", env, listings: stale }));

      const unreadable: DirectoryListings = new Map([[dir, Promise.resolve(null)]]);
      assert.isTrue(
        await isCommandAvailable("code", { platform: "linux", env, listings: unreadable }),
      );

      const listings: DirectoryListings = new Map();
      assert.isTrue(await isCommandAvailable("code", { platform: "linux", env, listings }));
      assert.isFalse(await isCommandAvailable("cursor", { platform: "linux", env, listings }));
      assert.deepEqual([...((await listings.get(dir)) ?? [])], ["code"]);
    },
  );

  it("matches win32 names case-insensitively against the listing", async () => {
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "piedpiper-listing-win-"));
    // Probes use the exact candidate casing, so the fixture must match one on case-sensitive hosts.
    await writeFile(join(dir, "code.CMD"), "@echo off\r\n");
    const listings: DirectoryListings = new Map();
    assert.isTrue(
      await isCommandAvailable("CODE", {
        platform: "win32",
        env: { PATH: dir, PATHEXT: ".CMD" },
        listings,
      }),
    );
    assert.deepEqual([...((await listings.get(dir)) ?? [])], ["code.cmd"]);
  });

  it("reads each PATH directory once, ignoring repeats and win32 case", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "piedpiper-listing-dedupe-"));
    class CountingListings extends Map<string, Promise<ReadonlySet<string> | null>> {
      lookups = 0;
      override get(key: string) {
        this.lookups += 1;
        return super.get(key);
      }
    }

    const posix = new CountingListings();
    assert.isFalse(
      await isCommandAvailable("missing-cmd", {
        platform: "linux",
        env: { PATH: `${dir}:${dir}: ${dir} ` },
        listings: posix,
      }),
    );
    assert.equal(posix.lookups, 1);

    const win32 = new CountingListings();
    assert.isFalse(
      await isCommandAvailable("missing-cmd", {
        platform: "win32",
        env: { PATH: `${dir};${dir.toUpperCase()};${dir}\\`, PATHEXT: ".CMD" },
        listings: win32,
      }),
    );
    assert.equal(win32.lookups, 1);
  });
});

describe("editorSpawnOptions", () => {
  const env = { PATH: "C:\\Windows" };
  it("passes the Explorer reveal argument verbatim when no shell is used", () => {
    const launch = {
      command: "explorer",
      args: ['/select,"C:\\ws\\a b.ts"'],
      windowsVerbatimArguments: true,
    };
    const spawnCommand = resolveEditorSpawnCommand(launch, {
      platform: "win32",
      env,
      isFile: (filePath) => filePath.toLowerCase().endsWith("explorer.exe"),
    });
    assert.equal(spawnCommand?.shell, false);
    assert.include(editorSpawnOptions(launch, spawnCommand!, env), {
      windowsVerbatimArguments: true,
      shell: false,
      detached: true,
    });
  });

  it("keeps the PowerShell reveal attached and hidden, and others detached", () => {
    const attached = editorSpawnOptions(
      { command: "powershell.exe", args: [], detached: false },
      { command: "powershell.exe", args: [], shell: false },
      env,
    );
    assert.include(attached, { detached: false, windowsHide: true, stdio: "ignore" });
    const detached = editorSpawnOptions(
      { command: "explorer", args: [] },
      { command: "explorer", args: [], shell: false },
      env,
    );
    assert.equal(detached.detached, true);
    assert.notProperty(detached, "windowsHide");
  });

  it("leaves verbatim arguments off for shell launches and ordinary launches", () => {
    const verbatim = { command: "x.cmd", args: ["a"], windowsVerbatimArguments: true };
    const shellOptions = editorSpawnOptions(verbatim, { command: "x", args: [], shell: true }, env);
    assert.notProperty(shellOptions, "windowsVerbatimArguments");
    const plain = editorSpawnOptions(
      { command: "code", args: ["/ws"] },
      { command: "code", args: ["/ws"], shell: false },
      env,
    );
    assert.notProperty(plain, "windowsVerbatimArguments");
  });
});
