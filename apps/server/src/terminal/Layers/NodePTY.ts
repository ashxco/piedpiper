import { createRequire } from "node:module";

import { Effect, FileSystem, Layer, Path } from "effect";
import {
  PtyAdapter,
  PtyAdapterShape,
  PtyExitEvent,
  PtyProcess,
  PtySpawnError,
  PtySpawnInput,
} from "../Services/PTY";

let didEnsureSpawnHelperExecutable = false;

const resolveNodePtySpawnHelperPath = Effect.gen(function* () {
  const requireForNodePty = createRequire(import.meta.url);
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;

  const packageJsonPath = requireForNodePty.resolve("node-pty/package.json");
  const packageDir = path.dirname(packageJsonPath);
  const candidates = [
    path.join(packageDir, "build", "Release", "spawn-helper"),
    path.join(packageDir, "build", "Debug", "spawn-helper"),
    path.join(packageDir, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
  ];

  for (const candidate of candidates) {
    if (yield* fs.exists(candidate)) {
      return candidate;
    }
  }
  return null;
}).pipe(Effect.orElseSucceed(() => null));

export const ensureNodePtySpawnHelperExecutable = Effect.fn(function* (explicitPath?: string) {
  const fs = yield* FileSystem.FileSystem;
  if (process.platform === "win32") return;
  if (!explicitPath && didEnsureSpawnHelperExecutable) return;

  const helperPath = explicitPath ?? (yield* resolveNodePtySpawnHelperPath);
  if (!helperPath) return;
  if (!explicitPath) {
    didEnsureSpawnHelperExecutable = true;
  }

  if (!(yield* fs.exists(helperPath))) {
    return;
  }

  // Best-effort: avoid FileSystem.stat in packaged mode where some fs metadata can be missing.
  yield* fs.chmod(helperPath, 0o755).pipe(Effect.orElseSucceed(() => undefined));
});

/**
 * node-pty writes `name` into TERM only on Unix; ConPTY leaves the env untouched, so Windows
 * children would otherwise see a missing TERM.
 */
export function nodePtySpawnTerminalOptions(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = globalThis.process.platform,
): { env: NodeJS.ProcessEnv; name: string } {
  const name = "xterm-256color";
  if (platform !== "win32") return { env, name };
  const termKey = Object.keys(env).find((key) => key.toUpperCase() === "TERM") ?? "TERM";
  return { env: env[termKey] ? env : { ...env, [termKey]: name }, name };
}

export class NodePtyProcess implements PtyProcess {
  constructor(
    private readonly process: import("node-pty").IPty,
    private readonly platform: NodeJS.Platform = globalThis.process.platform,
  ) {}

  get pid(): number {
    return this.process.pid;
  }

  write(data: string): void {
    this.process.write(data);
  }

  resize(cols: number, rows: number): void {
    this.process.resize(cols, rows);
  }

  kill(signal?: string): void {
    // node-pty's Windows kill() throws on any signal; it always terminates the whole process tree.
    this.process.kill(this.platform === "win32" ? undefined : signal);
  }

  onData(callback: (data: string) => void): () => void {
    const disposable = this.process.onData(callback);
    return () => {
      disposable.dispose();
    };
  }

  onExit(callback: (event: PtyExitEvent) => void): () => void {
    const disposable = this.process.onExit((event) => {
      callback({
        exitCode: event.exitCode,
        signal: event.signal ?? null,
      });
    });
    return () => {
      disposable.dispose();
    };
  }
}

export const spawnNodePtyProcess = (
  spawn: typeof import("node-pty").spawn,
  input: PtySpawnInput,
): Effect.Effect<PtyProcess, PtySpawnError> =>
  Effect.try({
    try: () =>
      new NodePtyProcess(
        spawn(input.shell, input.args ?? [], {
          cwd: input.cwd,
          cols: input.cols,
          rows: input.rows,
          ...nodePtySpawnTerminalOptions(input.env),
        }),
      ),
    catch: (cause) =>
      new PtySpawnError({
        adapter: "node-pty",
        message: cause instanceof Error ? cause.message : "Failed to spawn PTY process",
        cause,
      }),
  });

export const layer = Layer.effect(
  PtyAdapter,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const nodePty = yield* Effect.promise(() => import("node-pty"));

    const ensureNodePtySpawnHelperExecutableCached = yield* Effect.cached(
      ensureNodePtySpawnHelperExecutable().pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.orElseSucceed(() => undefined),
      ),
    );

    return {
      spawn: Effect.fn(function* (input) {
        yield* ensureNodePtySpawnHelperExecutableCached;
        return yield* spawnNodePtyProcess(nodePty.spawn, input);
      }),
    } satisfies PtyAdapterShape;
  }),
);
