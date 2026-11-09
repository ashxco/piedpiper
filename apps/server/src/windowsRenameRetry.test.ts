import { assert, it } from "@effect/vitest";
import { Effect, Exit, Fiber, FileSystem, Option } from "effect";
import * as PlatformError from "effect/PlatformError";
import * as TestClock from "effect/testing/TestClock";
import { describe } from "vitest";

import { LOCKED_RENAME_RETRIES, renameReplacingWithRetry } from "./windowsRenameRetry";

const errnoError = (code: string) =>
  PlatformError.systemError({
    _tag: code === "EBUSY" ? "Busy" : code === "EACCES" ? "PermissionDenied" : "Unknown",
    module: "FileSystem",
    method: "rename",
    cause: Object.assign(new Error(code), { code }),
  });

const fileInfo = (input: {
  readonly mtime: number;
  readonly mode?: number;
}): FileSystem.File.Info => ({
  type: "File",
  mtime: Option.some(new Date(input.mtime)),
  atime: Option.none(),
  birthtime: Option.none(),
  dev: 0,
  ino: Option.some(1),
  mode: input.mode ?? 0o644,
  nlink: Option.none(),
  uid: Option.none(),
  gid: Option.none(),
  rdev: Option.none(),
  size: FileSystem.Size(10),
  blksize: Option.none(),
  blocks: Option.none(),
});

const makeFs = (input: {
  readonly failures: ReadonlyArray<string>;
  readonly stat?: (call: number) => FileSystem.File.Info;
}) => {
  const state = { renames: 0, stats: 0 };
  const fs = FileSystem.makeNoop({
    rename: () => {
      const failure = input.failures[state.renames];
      state.renames += 1;
      return failure ? Effect.fail(errnoError(failure)) : Effect.void;
    },
    stat: () =>
      Effect.sync(() => {
        const call = state.stats;
        state.stats += 1;
        return input.stat?.(call) ?? fileInfo({ mtime: 1 });
      }),
  });
  return { fs, state };
};

describe("renameReplacingWithRetry", () => {
  it.effect("retries a locked rename on Windows until it succeeds", () =>
    Effect.gen(function* () {
      const { fs, state } = makeFs({ failures: ["EPERM", "EBUSY", "EPERM"] });
      const fiber = yield* renameReplacingWithRetry("a.tmp", "a", { platform: "win32" }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.forkChild,
      );
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(fiber);
      assert.strictEqual(state.renames, 4);
    }),
  );

  it.effect("does not retry off Windows", () =>
    Effect.gen(function* () {
      const { fs, state } = makeFs({ failures: ["EPERM"] });
      const exit = yield* Effect.exit(
        renameReplacingWithRetry("a.tmp", "a", { platform: "linux" }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
        ),
      );
      assert.isTrue(Exit.isFailure(exit));
      assert.strictEqual(state.renames, 1);
    }),
  );

  it.effect("gives up after about two seconds of a lock that never clears", () =>
    Effect.gen(function* () {
      const { fs, state } = makeFs({ failures: Array(100).fill("EBUSY") });
      const fiber = yield* renameReplacingWithRetry("a.tmp", "a", { platform: "win32" }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.exit,
        Effect.forkChild,
      );
      yield* TestClock.adjust("5 seconds");
      const exit = yield* Fiber.join(fiber);
      assert.isTrue(Exit.isFailure(exit));
      assert.strictEqual(state.renames, LOCKED_RENAME_RETRIES + 1);
    }),
  );

  it.effect("fails at once for a read-only target", () =>
    Effect.gen(function* () {
      const { fs, state } = makeFs({
        failures: ["EPERM"],
        stat: () => fileInfo({ mtime: 1, mode: 0o444 }),
      });
      const exit = yield* Effect.exit(
        renameReplacingWithRetry("a.tmp", "a", { platform: "win32" }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
        ),
      );
      assert.isTrue(Exit.isFailure(exit));
      assert.strictEqual(state.renames, 1);
    }),
  );

  it.effect("stops retrying once another process replaced the target", () =>
    Effect.gen(function* () {
      const { fs, state } = makeFs({
        failures: ["EPERM", "EPERM", "EPERM"],
        stat: (call) => fileInfo({ mtime: call === 0 ? 1 : 2 }),
      });
      const fiber = yield* renameReplacingWithRetry("a.tmp", "a", { platform: "win32" }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.exit,
        Effect.forkChild,
      );
      yield* TestClock.adjust("1 second");
      const exit = yield* Fiber.join(fiber);
      assert.isTrue(Exit.isFailure(exit));
      assert.strictEqual(state.renames, 1);
    }),
  );

  it.effect("does not retry an error that is not a lock", () =>
    Effect.gen(function* () {
      const { fs, state } = makeFs({ failures: ["EXDEV"] });
      const exit = yield* Effect.exit(
        renameReplacingWithRetry("a.tmp", "a", { platform: "win32" }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
        ),
      );
      assert.isTrue(Exit.isFailure(exit));
      assert.strictEqual(state.renames, 1);
    }),
  );
});
