import * as NodeServices from "@effect/platform-node/NodeServices";
import { NetService } from "@piedpiper/shared/Net";
import { assert, describe, it, vi } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as CliError from "effect/unstable/cli/CliError";
import { Command } from "effect/unstable/cli";

import { cli } from "./cli.ts";

const CliRuntimeLayer = Layer.mergeAll(NodeServices.layer, NetService.layer);

const invalidValueFrom = (error: unknown) => {
  if (!CliError.isCliError(error) || error._tag !== "ShowHelp") {
    throw new Error(`Expected ShowHelp, got ${String(error)}`);
  }
  const [parseError] = error.errors as ReadonlyArray<CliError.CliError>;
  if (parseError?._tag !== "InvalidValue") {
    throw new Error(`Expected InvalidValue, got ${String(parseError)}`);
  }
  return parseError;
};

it.layer(NodeServices.layer)("cli log-level parsing", (it) => {
  it.effect("accepts the built-in lowercase log-level flag values", () =>
    Command.runWith(cli, { version: "0.0.0" })(["--log-level", "debug", "--version"]).pipe(
      Effect.provide(CliRuntimeLayer),
    ),
  );

  it.effect("rejects invalid log-level casing before launching the server", () =>
    Effect.gen(function* () {
      const error = yield* Command.runWith(cli, { version: "0.0.0" })([
        "--log-level",
        "Debug",
      ]).pipe(Effect.provide(CliRuntimeLayer), Effect.flip);

      if (!CliError.isCliError(error)) {
        assert.fail(`Expected CliError, got ${String(error)}`);
      }
      if (error._tag !== "InvalidValue") {
        assert.fail(`Expected InvalidValue, got ${error._tag}`);
      }
      assert.equal(error.option, "log-level");
      assert.equal(error.value, "Debug");
    }),
  );

  it.effect("accepts --bootstrap-fd at the root next to the trace subcommand", () =>
    Effect.gen(function* () {
      const error = yield* Command.runWith(cli, { version: "0.0.0" })([
        "--bootstrap-fd",
        "not-a-number",
      ]).pipe(Effect.provide(CliRuntimeLayer), Effect.flip);

      assert.equal(invalidValueFrom(error).option, "bootstrap-fd");
    }),
  );

  it.effect("refuses a second positional, such as an unquoted path with a space", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "piedpiper-cli-" });
      const error = yield* Command.runWith(cli, { version: "0.0.0" })([
        `${root}/My`,
        "Project",
        "--base-dir",
        `${root}/home`,
      ]).pipe(Effect.provide(CliRuntimeLayer), Effect.flip);

      assert.equal(invalidValueFrom(error).option, "cwd");
      assert.isFalse(yield* fs.exists(`${root}/My`));
    }).pipe(Effect.scoped),
  );

  it.effect("sends an unknown bare word to the cwd guard with root flags still parsed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = `${yield* fs.makeTempDirectoryScoped({ prefix: "piedpiper-cli-" })}/home`;
      const error = yield* Command.runWith(cli, { version: "0.0.0" })([
        "conenct",
        "--bootstrap-fd",
        "3",
        "--base-dir",
        baseDir,
      ]).pipe(Effect.provide(CliRuntimeLayer), Effect.flip);

      const parseError = invalidValueFrom(error);
      assert.equal(parseError.option, "cwd");
      assert.equal(parseError.value, "conenct");
      assert.isFalse(yield* fs.exists(baseDir));
    }).pipe(Effect.scoped),
  );
});

const span = (name: string, durationMs: number, endMs: number) =>
  JSON.stringify({
    type: "effect-span",
    name,
    durationMs,
    endTimeUnixNano: String(BigInt(endMs) * 1_000_000n),
    exit: { _tag: "Success" },
  });

describe("piedpiper trace summary", () => {
  const runSummary = (args: ReadonlyArray<string>, env: Record<string, string> = {}) =>
    Effect.gen(function* () {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const lines: Array<string> = [];
      yield* Command.runWith(cli, { version: "0.0.0" })(["trace", "summary", ...args]).pipe(
        Effect.provide(
          Layer.mergeAll(CliRuntimeLayer, ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            lines.push(...log.mock.calls.map((call) => String(call[0])));
            log.mockRestore();
          }),
        ),
      );
      return lines.join("\n");
    });

  it.live("reads the trace file and its rotated backups under --base-dir", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "piedpiper-trace-" });
      const logsDir = `${baseDir}/userdata/logs`;
      yield* fs.makeDirectory(logsDir, { recursive: true });
      const tracePath = `${logsDir}/server.trace.ndjson`;
      const now = Date.now();
      yield* fs.writeFileString(`${tracePath}.1`, `${span("older", 3, now - 3_600_000)}\n`);
      yield* fs.writeFileString(tracePath, `${span("recent", 2_500, now)}\n{not json\n`);

      const all = yield* runSummary(["--base-dir", baseDir]);
      assert.include(all, "2 spans ended");
      assert.include(all, "older");
      assert.include(all, "recent");
      assert.include(all, "2.5s");
      assert.include(all, "Skipped 1 lines");

      const windowed = yield* runSummary(["--base-dir", baseDir, "--since", "30m", "--limit", "1"]);
      assert.include(windowed, "1 spans ended");
      assert.notInclude(windowed, "older");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("reports an empty result without creating the home directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "piedpiper-trace-" });
      const baseDir = `${root}/home`;
      const output = yield* runSummary([], { PIEDPIPER_HOME: baseDir });
      assert.include(output, "No spans found");
      assert.isFalse(yield* fs.exists(baseDir));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("prefers PIEDPIPER_TRACE_FILE", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tracePath = yield* fs.makeTempFileScoped({ suffix: ".ndjson" });
      yield* fs.writeFileString(tracePath, `${span("from-env", 1, Date.now())}\n`);
      assert.include(
        yield* runSummary([], { PIEDPIPER_TRACE_FILE: tracePath, PIEDPIPER_TRACE_MAX_FILES: "2" }),
        "from-env",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("names a file it cannot read and still summarizes the others", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "piedpiper-trace-" });
      const tracePath = `${root}/server.trace.ndjson`;
      // A directory fails on read with something other than NotFound.
      yield* fs.makeDirectory(tracePath);
      yield* fs.writeFileString(`${tracePath}.1`, span("from-backup", 1, Date.now()));
      const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const messages: Array<string> = [];
      const output = yield* runSummary([], {
        PIEDPIPER_TRACE_FILE: tracePath,
        PIEDPIPER_TRACE_MAX_FILES: "1",
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            messages.push(...errors.mock.calls.map((call) => String(call[0])));
            errors.mockRestore();
          }),
        ),
      );
      assert.include(output, "from-backup");
      assert.include(output, "1 spans ended");
      assert.include(messages.join("\n"), `Could not read ${tracePath}`);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("counts a last line that has no trailing newline", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tracePath = yield* fs.makeTempFileScoped({ suffix: ".ndjson" });
      const now = Date.now();
      yield* fs.writeFileString(tracePath, `${span("first", 1, now)}\n${span("last", 1, now)}`);
      assert.include(yield* runSummary([], { PIEDPIPER_TRACE_FILE: tracePath }), "2 spans ended");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("rejects a malformed --since window", () =>
    Effect.gen(function* () {
      const error = yield* runSummary(["--since", "soon"]).pipe(Effect.flip);
      assert.equal(invalidValueFrom(error).option, "since");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
