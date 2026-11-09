import { Effect, FileSystem, Option, Result } from "effect";
import type * as PlatformError from "effect/PlatformError";

/**
 * Windows refuses to rename over a file another process holds open without delete
 * sharing, such as a virus scanner or the search indexer. The same codes also mean a
 * denial that never clears, so retries need a bound.
 */
export const isWindowsRenameLock = (error: PlatformError.PlatformError): boolean => {
  if (error.reason._tag === "Busy") return true;
  const code = (error.reason.cause as NodeJS.ErrnoException | undefined)?.code;
  return code === "EBUSY" || code === "EPERM" || code === "EACCES";
};

// About 2 seconds in total: settings and keybinding saves hold their write lock while retrying.
export const LOCKED_RENAME_RETRIES = 20;
const LOCKED_RENAME_RETRY_DELAY = "100 millis";

/**
 * Rename `tempPath` over `targetPath`. On Windows a rename that fails because the target is
 * briefly held open is retried for about two seconds, unless the target is read-only or
 * another process replaced it in the meantime (so a newer save is never overwritten).
 */
export const renameReplacingWithRetry = Effect.fn("renameReplacingWithRetry")(function* (
  tempPath: string,
  targetPath: string,
  options?: { readonly platform?: NodeJS.Platform },
) {
  const fs = yield* FileSystem.FileSystem;
  if ((options?.platform ?? process.platform) !== "win32") {
    return yield* fs.rename(tempPath, targetPath);
  }

  const targetVersion = fs.stat(targetPath).pipe(
    Effect.map((info) => ({
      id: `${Option.getOrUndefined(info.ino)}:${info.size}:${Option.getOrUndefined(info.mtime)?.getTime()}`,
      readOnly: (info.mode & 0o200) === 0,
    })),
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.succeed({ id: "missing", readOnly: false }),
    ),
    Effect.option,
  );
  const before = yield* targetVersion;
  const firstAttempt = yield* Effect.result(fs.rename(tempPath, targetPath));
  if (Result.isSuccess(firstAttempt)) return;
  const lockError = firstAttempt.failure;
  if (!isWindowsRenameLock(lockError) || Option.isNone(before) || before.value.readOnly) {
    return yield* lockError;
  }
  for (let retry = 0; retry < LOCKED_RENAME_RETRIES; retry += 1) {
    yield* Effect.sleep(LOCKED_RENAME_RETRY_DELAY);
    const current = yield* targetVersion;
    if (Option.isNone(current) || current.value.id !== before.value.id) break;
    const attempt = yield* Effect.result(fs.rename(tempPath, targetPath));
    if (Result.isSuccess(attempt)) return;
    if (!isWindowsRenameLock(attempt.failure)) return yield* attempt.failure;
  }
  return yield* lockError;
});
