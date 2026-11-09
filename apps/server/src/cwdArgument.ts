/**
 * The `piedpiper [path]` positional. It is checked and made canonical while the CLI resolves its
 * config, and a new folder is only created once the server has taken ownership of its state.
 */
import { Effect, FileSystem, Option, Path, type PlatformError } from "effect";
import { CliError } from "effect/unstable/cli";

import { expandHomePath } from "./os-jank";

const invalidCwdArgument = (value: string, expected: string) =>
  new CliError.ShowHelp({
    commandPath: ["piedpiper"],
    errors: [new CliError.InvalidValue({ option: "cwd", value, expected, kind: "argument" })],
  });

/** A path-shaped argument may name a new folder; a bare word must already be one, not a typo. */
const isExplicitCwdPath = (value: string): boolean =>
  value === "." ||
  value === ".." ||
  value === "~" ||
  /[/\\]/.test(value) ||
  (process.platform === "win32" && /^[a-z]:/i.test(value));

const describeFailure = (error: PlatformError.PlatformError): string => {
  const { reason } = error;
  const code = (reason.cause as { readonly code?: unknown } | undefined)?.code;
  return typeof code === "string" ? code : reason._tag;
};

/** Resolves the positional folder without creating anything; a missing one is checked to be creatable. */
export const resolveCwdArgument = Effect.fn("resolveCwdArgument")(function* (
  argument: Option.Option<string>,
) {
  if (Option.isNone(argument)) return process.cwd();
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const value = argument.value.trim();
  if (value.length === 0) {
    return yield* invalidCwdArgument(argument.value, "a folder path.");
  }

  const statOrMissing = (target: string) =>
    fs.stat(target).pipe(
      Effect.map((info) => Option.some(info.type)),
      Effect.catchTag("PlatformError", (error) =>
        error.reason._tag === "NotFound"
          ? Effect.succeedNone
          : Effect.fail(
              invalidCwdArgument(
                value,
                `a folder that can be opened, but ${target} failed with ${describeFailure(error)}.`,
              ),
            ),
      ),
    );
  // Matches process.cwd(), which is physical: one folder must not become two projects by spelling.
  const canonical = (target: string) =>
    fs.realPath(target).pipe(Effect.orElseSucceed(() => target));

  const cwd = path.resolve(yield* expandHomePath(value));
  const type = yield* statOrMissing(cwd);
  if (Option.isSome(type)) {
    if (type.value === "Directory") return yield* canonical(cwd);
    return yield* invalidCwdArgument(value, "a folder, but this is a file.");
  }
  if (!isExplicitCwdPath(value)) {
    return yield* invalidCwdArgument(
      value,
      'an existing folder. Run "piedpiper --help" for commands, or use a path such as "piedpiper ./my-project" for a new folder.',
    );
  }

  // The nearest existing ancestor decides whether the folder can be created.
  let ancestor = path.dirname(cwd);
  while (true) {
    const ancestorType = yield* statOrMissing(ancestor);
    if (Option.isSome(ancestorType)) {
      if (ancestorType.value !== "Directory") {
        return yield* invalidCwdArgument(
          value,
          `a folder that can be created, but ${ancestor} is a file.`,
        );
      }
      const writable = yield* fs.access(ancestor, { writable: true }).pipe(Effect.result);
      if (writable._tag === "Failure") {
        return yield* invalidCwdArgument(
          value,
          `a folder that can be created, but ${ancestor} is not writable.`,
        );
      }
      return path.join(yield* canonical(ancestor), path.relative(ancestor, cwd));
    }
    const parent = path.dirname(ancestor);
    if (parent === ancestor) return cwd;
    ancestor = parent;
  }
});

/** The checks above can miss a dangling symlink or a filesystem that changed since, so this reports too. */
export const createCwdFolder = Effect.fn("createCwdFolder")(function* (cwd: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs
    .makeDirectory(cwd, { recursive: true })
    .pipe(
      Effect.catchTag("PlatformError", (error) =>
        Effect.fail(
          invalidCwdArgument(cwd, `a folder that can be created (${describeFailure(error)}).`),
        ),
      ),
    );
});
