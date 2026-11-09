import { execFileSync } from "node:child_process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, describe, expect } from "@effect/vitest";
import { Effect, FileSystem, Layer, Logger, Option, Path } from "effect";

import { ProjectConfigFileLoader } from "../Services/ProjectConfigFileLoader.ts";
import {
  makeProjectConfigFileLoader,
  PROJECT_CONFIG_FILE_MAX_BYTES,
  ProjectConfigFileLoaderLive,
} from "./ProjectConfigFileLoader.ts";

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(ProjectConfigFileLoaderLive),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix: "piedpiper-project-config-" });
});

const writeFile = Effect.fn("writeFile")(function* (
  cwd: string,
  relativePath: string,
  contents: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolutePath = path.join(cwd, relativePath);
  yield* fileSystem
    .makeDirectory(path.dirname(absolutePath), { recursive: true })
    .pipe(Effect.orDie);
  yield* fileSystem.writeFileString(absolutePath, contents).pipe(Effect.orDie);
});

it.layer(TestLayer)("ProjectConfigFileLoaderLive", (it) => {
  describe("load", () => {
    it.effect("loads and decodes a valid piedpiper.json, tolerating JSONC", () =>
      Effect.gen(function* () {
        const loader = yield* ProjectConfigFileLoader;
        const cwd = yield* makeTempDir;
        yield* writeFile(
          cwd,
          "piedpiper.json",
          `{
            // shared with the team
            "iconPath": " assets/logo.svg ",
            "scripts": [
              { "name": "Dev", "command": "bun dev" },
              { "name": "Setup", "command": "bun install", "icon": "configure", "runOnWorktreeCreate": true },
            ],
          }`,
        );

        const loaded = yield* loader.load(cwd);

        expect(Option.getOrNull(loaded)).toEqual({
          iconPath: "assets/logo.svg",
          scripts: [
            { name: "Dev", command: "bun dev" },
            {
              name: "Setup",
              command: "bun install",
              icon: "configure",
              runOnWorktreeCreate: true,
            },
          ],
        });
      }),
    );

    it.effect("returns none when the file is missing", () =>
      Effect.gen(function* () {
        const loader = yield* ProjectConfigFileLoader;
        const cwd = yield* makeTempDir;

        expect(Option.isNone(yield* loader.load(cwd))).toBe(true);
      }),
    );

    it.effect("returns none for malformed or schema-invalid files without failing", () =>
      Effect.gen(function* () {
        const loader = yield* ProjectConfigFileLoader;
        const malformed = yield* makeTempDir;
        yield* writeFile(malformed, "piedpiper.json", "{ not json");
        const invalid = yield* makeTempDir;
        yield* writeFile(invalid, "piedpiper.json", '{ "scripts": [{ "name": "Dev" }] }');
        const badIcon = yield* makeTempDir;
        yield* writeFile(
          badIcon,
          "piedpiper.json",
          '{ "scripts": [{ "name": "Dev", "command": "x", "icon": "rocket" }] }',
        );

        expect(Option.isNone(yield* loader.load(malformed))).toBe(true);
        expect(Option.isNone(yield* loader.load(invalid))).toBe(true);
        expect(Option.isNone(yield* loader.load(badIcon))).toBe(true);
      }),
    );

    it.effect("ignores a config file that symlinks out of the workspace", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const loader = yield* ProjectConfigFileLoader;
        const outside = yield* makeTempDir;
        yield* writeFile(outside, "piedpiper.json", '{ "iconPath": "x.svg" }');
        const cwd = yield* makeTempDir;
        yield* fileSystem
          .symlink(path.join(outside, "piedpiper.json"), path.join(cwd, "piedpiper.json"))
          .pipe(Effect.orDie);

        expect(Option.isNone(yield* loader.load(cwd))).toBe(true);
      }),
    );

    it.effect("keeps a symlinked subdirectory inside the given containment root", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const loader = yield* ProjectConfigFileLoader;
        const outside = yield* makeTempDir;
        yield* writeFile(outside, "piedpiper.json", '{ "iconPath": "x.svg" }');
        const root = yield* makeTempDir;
        const linkedDir = path.join(root, "link");
        yield* fileSystem.symlink(outside, linkedDir).pipe(Effect.orDie);

        expect(Option.isNone(yield* loader.load(linkedDir, { containmentRoot: root }))).toBe(true);
        expect(Option.isSome(yield* loader.load(linkedDir))).toBe(true);
      }),
    );

    it.effect("skips oversized files, directories and FIFOs without reading them", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const loader = yield* ProjectConfigFileLoader;
        const oversized = yield* makeTempDir;
        yield* writeFile(
          oversized,
          "piedpiper.json",
          `{ "iconPath": "x.svg", "$schema": "${"a".repeat(PROJECT_CONFIG_FILE_MAX_BYTES)}" }`,
        );
        const directory = yield* makeTempDir;
        yield* fileSystem.makeDirectory(path.join(directory, "piedpiper.json")).pipe(Effect.orDie);

        expect(Option.isNone(yield* loader.load(oversized))).toBe(true);
        expect(Option.isNone(yield* loader.load(directory))).toBe(true);

        if (process.platform !== "win32") {
          const fifo = yield* makeTempDir;
          execFileSync("mkfifo", [path.join(fifo, "piedpiper.json")]);
          expect(Option.isNone(yield* loader.load(fifo))).toBe(true);
        }
      }),
    );

    it.effect("warns about an invalid file once per file version", () => {
      const messages: string[] = [];
      const logger = Logger.make(({ message }) => {
        messages.push(String(message));
      });
      return Effect.gen(function* () {
        const loader = yield* makeProjectConfigFileLoader;
        const cwd = yield* makeTempDir;
        yield* writeFile(cwd, "piedpiper.json", "{ not json");
        const invalidWarnings = () =>
          messages.filter((message) => message.includes("ignoring invalid project config file"));

        yield* loader.load(cwd);
        yield* loader.load(cwd);
        expect(invalidWarnings()).toHaveLength(1);

        yield* writeFile(cwd, "piedpiper.json", "{ still not json at all");
        yield* loader.load(cwd);
        expect(invalidWarnings()).toHaveLength(2);
      }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
    });
  });

  describe("resolveIconPath", () => {
    it.effect("resolves an image inside the workspace", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const loader = yield* ProjectConfigFileLoader;
        const cwd = yield* makeTempDir;
        yield* writeFile(cwd, "assets/logo.svg", "<svg/>");

        expect(yield* loader.resolveIconPath(cwd, "assets/logo.svg")).toBe(
          yield* fileSystem.realPath(path.join(cwd, "assets/logo.svg")),
        );
      }),
    );

    it.effect("returns the checked real path for an in-workspace symlink", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const loader = yield* ProjectConfigFileLoader;
        const cwd = yield* makeTempDir;
        yield* writeFile(cwd, "brand/mark.svg", "<svg/>");
        yield* fileSystem
          .symlink(path.join(cwd, "brand/mark.svg"), path.join(cwd, "icon.svg"))
          .pipe(Effect.orDie);

        expect(yield* loader.resolveIconPath(cwd, "icon.svg")).toBe(
          yield* fileSystem.realPath(path.join(cwd, "brand/mark.svg")),
        );
      }),
    );

    it.effect("rejects escapes, absolute paths, non-images, missing files and directories", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const loader = yield* ProjectConfigFileLoader;
        const outside = yield* makeTempDir;
        yield* writeFile(outside, "logo.svg", "<svg/>");
        const cwd = yield* makeTempDir;
        yield* writeFile(cwd, ".env", "SECRET=1");
        yield* writeFile(cwd, "dir.svg/inner.txt", "x");

        const relativeEscape = path.join("..", path.basename(outside), "logo.svg");
        expect(yield* loader.resolveIconPath(cwd, relativeEscape)).toBeNull();
        expect(yield* loader.resolveIconPath(cwd, path.join(outside, "logo.svg"))).toBeNull();
        expect(yield* loader.resolveIconPath(cwd, ".env")).toBeNull();
        expect(yield* loader.resolveIconPath(cwd, "missing.png")).toBeNull();
        expect(yield* loader.resolveIconPath(cwd, "dir.svg")).toBeNull();
      }),
    );

    it.effect("rejects icons that symlink out of the workspace or to a non-image", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const loader = yield* ProjectConfigFileLoader;
        const outside = yield* makeTempDir;
        yield* writeFile(outside, "logo.svg", "<svg/>");
        const cwd = yield* makeTempDir;
        yield* writeFile(cwd, ".env", "SECRET=1");
        yield* fileSystem
          .symlink(path.join(outside, "logo.svg"), path.join(cwd, "linked.svg"))
          .pipe(Effect.orDie);
        yield* fileSystem
          .symlink(path.join(cwd, ".env"), path.join(cwd, "env.svg"))
          .pipe(Effect.orDie);

        expect(yield* loader.resolveIconPath(cwd, "linked.svg")).toBeNull();
        expect(yield* loader.resolveIconPath(cwd, "env.svg")).toBeNull();
      }),
    );
  });
});
