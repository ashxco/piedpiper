import * as NodeUtil from "node:util";

import { assert, describe, it } from "@effect/vitest";
import { Cause, Console, Effect, Logger, Redactable } from "effect";

import { makeConsolePrettyLogger, prettyCauseFields } from "./serverLogger.ts";

const printThroughConsole = (fields: object) =>
  Effect.gen(function* () {
    const printed: Array<string> = [];
    const testConsole = {
      ...globalThis.console,
      log: (...args: ReadonlyArray<unknown>) => {
        printed.push(NodeUtil.format(...args));
      },
    } satisfies Console.Console;
    yield* Effect.logWarning("startup failed", fields).pipe(
      Effect.provide(Logger.layer([makeConsolePrettyLogger()], { mergeWithExisting: false })),
      Effect.provideService(Console.Console, testConsole),
    );
    return printed.join("\n");
  });

describe("serverLogger consolePretty", () => {
  it.effect("prints a cause passed as a log field instead of collapsing it", () =>
    Effect.gen(function* () {
      const output = yield* printThroughConsole({
        threadId: "thread-1",
        cause: Cause.fail(new Error("gh: HTTP 502 from api.github.com")),
      });

      assert.include(output, "threadId: 'thread-1'");
      assert.include(output, "gh: HTTP 502 from api.github.com");
      assert.notInclude(output, "[Object]");
    }),
  );

  it("leaves getters uncalled while pretty-printing cause fields", () => {
    const result = prettyCauseFields({
      cause: Cause.fail(new Error("upstream refused")),
      get detail(): string {
        throw new Error("getter must not run");
      },
    }) as { cause: unknown };
    assert.strictEqual(typeof result.cause, "string");
    assert.include(result.cause as string, "upstream refused");
  });

  it("leaves values with their own redaction hook and non-plain objects untouched", () => {
    const redactable = {
      cause: Cause.fail(new Error("x")),
      [Redactable.symbolRedactable]() {
        return { cause: "redacted" };
      },
    };
    assert.strictEqual(prettyCauseFields(redactable), redactable);
    const error = new Error("plain");
    assert.strictEqual(prettyCauseFields(error), error);
    const noCause = { a: 1 };
    assert.strictEqual(prettyCauseFields(noCause), noCause);
  });
});
