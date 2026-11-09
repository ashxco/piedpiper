import { Effect, Result } from "effect";
import { describe, expect, it, vi } from "vitest";

import { spawnBunPtyProcess } from "./BunPTY";
import { isRetryableShellSpawnError } from "./ShellResolver";

describe("spawnBunPtyProcess", () => {
  it("turns a throwing Bun.spawn into a retryable PtySpawnError", () => {
    const spawn = vi.fn(() => {
      throw new Error('Executable not found in $PATH: "/missing/shell"');
    }) as unknown as typeof Bun.spawn;

    const result = Effect.runSync(
      Effect.result(
        spawnBunPtyProcess(
          { shell: "/missing/shell", cwd: "/tmp", cols: 80, rows: 24, env: {} },
          spawn,
        ),
      ),
    );

    expect(Result.isFailure(result)).toBe(true);
    if (!Result.isFailure(result)) return;
    expect(result.failure._tag).toBe("PtySpawnError");
    expect(result.failure.adapter).toBe("bun-pty");
    expect(isRetryableShellSpawnError(result.failure)).toBe(true);
  });
});
