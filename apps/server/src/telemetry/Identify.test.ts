import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, PlatformError } from "effect";

import { ServerConfig } from "../config";
import { upsertAnonymousId } from "./Identify";

const TestLayer = Layer.fresh(
  ServerConfig.layerTest(process.cwd(), { prefix: "piedpiper-identify-test-" }),
).pipe(Layer.provideMerge(NodeServices.layer));

it.layer(TestLayer)("telemetry anonymous id", (it) => {
  it.effect("persists the generated id and reuses it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { anonymousIdPath } = yield* ServerConfig;
      yield* fs.remove(anonymousIdPath, { force: true });

      const first = yield* upsertAnonymousId;
      const second = yield* upsertAnonymousId;
      assert.strictEqual(second, first);
      assert.strictEqual(yield* fs.readFileString(anonymousIdPath), first);
    }),
  );

  it.effect("replaces an empty (torn) id file instead of hashing it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { anonymousIdPath } = yield* ServerConfig;
      yield* fs.writeFileString(anonymousIdPath, "  \n");

      const id = yield* upsertAnonymousId;
      assert.isAbove(id.trim().length, 0);
      assert.strictEqual(yield* fs.readFileString(anonymousIdPath), id);
    }),
  );

  it.effect("leaves no torn id behind when the write fails midway", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { anonymousIdPath } = yield* ServerConfig;
      yield* fs.remove(anonymousIdPath, { force: true });
      const tornWrites = FileSystem.FileSystem.of({
        ...fs,
        writeFileString: (filePath, data, options) =>
          fs.writeFileString(filePath, data.slice(0, Math.floor(data.length / 2)), options).pipe(
            Effect.andThen(
              Effect.fail(
                PlatformError.systemError({
                  _tag: "WriteZero",
                  module: "FileSystem",
                  method: "writeFileString",
                  pathOrDescriptor: filePath,
                }),
              ),
            ),
          ),
      });

      const result = yield* Effect.result(
        upsertAnonymousId.pipe(Effect.provideService(FileSystem.FileSystem, tornWrites)),
      );
      assert.strictEqual(result._tag, "Failure");
      assert.isFalse(yield* fs.exists(anonymousIdPath));
    }),
  );
});
