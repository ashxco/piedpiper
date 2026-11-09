import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import { Effect, Schema } from "effect";

export class CheckoutCloneError extends Schema.TaggedErrorClass<CheckoutCloneError>()(
  "CheckoutCloneError",
  {
    source: Schema.String,
    destination: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

/** macOS cp uses clonefile, preserving nanosecond mtimes and copying symlinks without following them. */
export const cloneCheckout = Effect.fn("cloneCheckout")(function* (
  source: string,
  destination: string,
) {
  const failure = (cause: unknown) => new CheckoutCloneError({ source, destination, cause });
  const exists = yield* Effect.tryPromise({
    try: () =>
      lstat(destination).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return false;
          throw error;
        },
      ),
    catch: failure,
  });
  if (exists) return yield* failure("The clone destination already exists.");
  yield* Effect.acquireUseRelease(
    Effect.sync(() => {
      const child = spawn("/bin/cp", ["-cRp", source, destination], { stdio: "ignore" });
      const completed = new Promise<number | Error>((resolve) => {
        child.once("error", resolve);
        child.once("close", (code) => resolve(code ?? -1));
      });
      return { child, completed };
    }),
    ({ completed }) =>
      Effect.promise(() => completed).pipe(
        Effect.flatMap((result) => (result === 0 ? Effect.void : Effect.fail(failure(result)))),
      ),
    ({ child, completed }) =>
      Effect.promise(async () => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await completed;
      }),
  );
});
