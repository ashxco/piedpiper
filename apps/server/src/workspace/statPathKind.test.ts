import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, FileSystem, Path } from "effect";
import { TestClock } from "effect/testing";

import { statPathKind, toStatablePath } from "./statPathKind.ts";

it.layer(NodeServices.layer)("statPathKind", (it) => {
  it.effect("reports files, directories and missing paths", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "piedpiper-stat-path-" });
      const filePath = path.join(dir, "main.ts");
      yield* fileSystem.writeFileString(filePath, "export {};\n");

      expect(yield* statPathKind(filePath)).toEqual({ kind: "file" });
      expect(yield* statPathKind(`${filePath}:12:3`)).toEqual({ kind: "file" });
      expect(yield* statPathKind(dir)).toEqual({ kind: "directory" });
      expect(yield* statPathKind(path.join(dir, "and/or"))).toEqual({ kind: "missing" });
    }),
  );

  it.effect("never stats relative, network or oversized paths", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const statted: Array<string> = [];
      const result = yield* Effect.forEach(
        ["feature/foo", "\\\\server\\share\\a.ts", "//server/share/a.ts", `/${"a".repeat(600)}`],
        (input) => statPathKind(input),
      ).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fileSystem,
          stat: (target) => {
            statted.push(target);
            return fileSystem.stat(target);
          },
        }),
      );

      expect(result.every((entry) => entry.kind === "missing")).toBe(true);
      expect(statted).toEqual([]);
    }),
  );

  it.effect("reports unknown when the stat does not settle in time", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const fiber = yield* statPathKind("/net/sleeping-host/a.ts").pipe(
        Effect.provideService(FileSystem.FileSystem, { ...fileSystem, stat: () => Effect.never }),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* TestClock.adjust("3 seconds");

      expect(yield* Fiber.join(fiber)).toEqual({ kind: "unknown" });
    }),
  );
});

describe("toStatablePath", () => {
  it.effect("strips line and column suffixes and keeps absolute local paths", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      expect(toStatablePath(" /repo/src/a.ts:10:2 ", path)).toBe("/repo/src/a.ts");
      expect(toStatablePath("/repo/src/a.ts:10", path)).toBe("/repo/src/a.ts");
      expect(toStatablePath("/repo/a\0b", path)).toBeNull();
      expect(toStatablePath("~/a.ts", path)).toBeNull();
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
