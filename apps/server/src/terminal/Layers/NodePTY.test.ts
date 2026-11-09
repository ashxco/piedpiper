import { FileSystem, Path, Effect, Result } from "effect";
import { assert, it } from "@effect/vitest";
import { describe, vi } from "vitest";

import {
  ensureNodePtySpawnHelperExecutable,
  NodePtyProcess,
  nodePtySpawnTerminalOptions,
  spawnNodePtyProcess,
} from "./NodePTY";
import { isRetryableShellSpawnError } from "./ShellResolver";
import * as NodeServices from "@effect/platform-node/NodeServices";

it.layer(NodeServices.layer)("ensureNodePtySpawnHelperExecutable", (it) => {
  it.effect("adds executable bits when helper exists but is not executable", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return;

      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "pty-helper-test-" });
      const helperPath = path.join(dir, "spawn-helper");
      yield* fs.writeFileString(helperPath, "#!/bin/sh\nexit 0\n");
      yield* fs.chmod(helperPath, 0o644);

      yield* ensureNodePtySpawnHelperExecutable(helperPath);

      const mode = (yield* fs.stat(helperPath)).mode & 0o777;
      assert.equal(mode & 0o111, 0o111);
    }),
  );

  it.effect("keeps executable helper as executable", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return;

      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "pty-helper-test-" });
      const helperPath = path.join(dir, "spawn-helper");
      yield* fs.writeFileString(helperPath, "#!/bin/sh\nexit 0\n");
      yield* fs.chmod(helperPath, 0o755);

      yield* ensureNodePtySpawnHelperExecutable(helperPath);

      const mode = (yield* fs.stat(helperPath)).mode & 0o777;
      assert.equal(mode & 0o111, 0o111);
    }),
  );
});

describe("NodePtyProcess.kill", () => {
  for (const platform of ["win32", "linux", "darwin"] as const) {
    it(`terminates through node-pty using ${platform} semantics`, () => {
      const kill = vi.fn((signal?: string) => {
        if (platform === "win32" && signal) {
          throw new Error("Signals not supported on windows.");
        }
      });
      const process = new NodePtyProcess({ kill } as unknown as import("node-pty").IPty, platform);

      process.kill("SIGTERM");
      process.kill("SIGKILL");
      process.kill();

      assert.deepEqual(
        kill.mock.calls,
        platform === "win32"
          ? [[undefined], [undefined], [undefined]]
          : [["SIGTERM"], ["SIGKILL"], [undefined]],
      );
    });
  }
});

describe("spawnNodePtyProcess", () => {
  const input = { shell: "/missing/shell", cwd: "/tmp", cols: 80, rows: 24, env: {} };

  it("turns a throwing node-pty spawn into a retryable PtySpawnError", () => {
    const spawn = vi.fn(() => {
      throw new Error("File not found: /missing/shell");
    }) as unknown as typeof import("node-pty").spawn;

    const result = Effect.runSync(Effect.result(spawnNodePtyProcess(spawn, input)));

    assert.isTrue(Result.isFailure(result));
    if (!Result.isFailure(result)) return;
    assert.equal(result.failure._tag, "PtySpawnError");
    assert.equal(result.failure.adapter, "node-pty");
    assert.equal(result.failure.message, "File not found: /missing/shell");
    assert.isTrue(isRetryableShellSpawnError(result.failure));
  });

  it("wraps a successful spawn", () => {
    const spawn = vi.fn(() => ({ pid: 42 })) as unknown as typeof import("node-pty").spawn;

    const process = Effect.runSync(spawnNodePtyProcess(spawn, input));

    assert.equal(process.pid, 42);
  });
});

describe("nodePtySpawnTerminalOptions", () => {
  it("advertises a 256-colour TERM on every platform", () => {
    assert.deepEqual(nodePtySpawnTerminalOptions({ PATH: "/bin" }, "linux"), {
      env: { PATH: "/bin" },
      name: "xterm-256color",
    });
    assert.deepEqual(nodePtySpawnTerminalOptions({}, "win32"), {
      env: { TERM: "xterm-256color" },
      name: "xterm-256color",
    });
  });

  it("keeps a caller-provided TERM on win32 and fills an empty one in place", () => {
    assert.deepEqual(nodePtySpawnTerminalOptions({ TERM: "xterm-direct" }, "win32").env, {
      TERM: "xterm-direct",
    });
    assert.deepEqual(nodePtySpawnTerminalOptions({ Term: "" }, "win32").env, {
      Term: "xterm-256color",
    });
  });
});
