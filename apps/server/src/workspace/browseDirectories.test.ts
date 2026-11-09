import fsPromises from "node:fs/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, expect, it, vi } from "@effect/vitest";
import { Effect, Fiber, FileSystem, Path } from "effect";
import { TestClock } from "effect/testing";

import { browseDirectories } from "./browseDirectories.ts";

const noop = (): void => undefined;

const makeTree = (directories: ReadonlyArray<string>, files: ReadonlyArray<string> = []) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "piedpiper-browse-" });
    yield* Effect.forEach(directories, (name) =>
      fileSystem.makeDirectory(path.join(root, name), { recursive: true }),
    );
    yield* Effect.forEach(files, (name) => fileSystem.writeFileString(path.join(root, name), ""));
    return root;
  });

const names = (result: { readonly entries: ReadonlyArray<{ readonly name: string }> }) =>
  result.entries.map((entry) => entry.name);

const failureMessage = (partialPath: string) =>
  browseDirectories(partialPath).pipe(
    Effect.flip,
    Effect.map((failure) => failure.message),
  );

it.layer(NodeServices.layer)("browseDirectories", (it) => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.effect("matches directories by prefix, ignoring case and excluding files", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const root = yield* makeTree(["alpha", "Alpine", "beta"], ["alphabet.txt"]);

      expect(yield* browseDirectories(path.join(root, "al"))).toEqual({
        entries: [
          { name: "alpha", fullPath: path.join(root, "alpha") },
          { name: "Alpine", fullPath: path.join(root, "Alpine") },
        ],
      });
    }),
  );

  it.effect("shows dot directories only for a whole directory or a dot prefix", () =>
    Effect.gen(function* () {
      const root = yield* makeTree([".config", "config", "child/.nested"]);

      expect(names(yield* browseDirectories(`${root}/`))).toEqual([".config", "child", "config"]);
      expect(names(yield* browseDirectories(`${root}/.`))).toEqual([".config"]);
      expect(names(yield* browseDirectories(`${root}/.c`))).toEqual([".config"]);
      expect(names(yield* browseDirectories(`${root}/c`))).toEqual(["child", "config"]);
      expect(names(yield* browseDirectories(`${root}/child/.`))).toEqual([".nested"]);
    }),
  );

  it.effect("expands the home directory", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const homeDir = yield* makeTree(["code", "docs/inner"]);

      const home = yield* browseDirectories("~", { homeDir });
      expect(names(home)).toEqual(["code", "docs"]);
      expect(home.entries[0]?.fullPath).toBe(path.join(homeDir, "code"));
      expect(names(yield* browseDirectories("~/", { homeDir }))).toEqual(["code", "docs"]);
      expect(names(yield* browseDirectories("~/do", { homeDir }))).toEqual(["docs"]);
      expect(names(yield* browseDirectories("~/docs/", { homeDir }))).toEqual(["inner"]);
      expect(names(yield* browseDirectories("~/.", { homeDir }))).toEqual([]);
    }),
  );

  it.effect("caps the listing after sorting", () =>
    Effect.gen(function* () {
      const root = yield* makeTree(
        Array.from({ length: 105 }, (_, index) => `dir-${String(index).padStart(3, "0")}`),
      );

      const listed = names(yield* browseDirectories(`${root}/`));
      expect(listed).toHaveLength(100);
      expect(listed[0]).toBe("dir-000");
      expect(listed.at(-1)).toBe("dir-099");
    }),
  );

  it.effect("has no suggestions for a folder that is missing or not a folder", () =>
    Effect.gen(function* () {
      const root = yield* makeTree([], ["file.txt"]);

      expect(yield* browseDirectories(`${root}/missing/pro`)).toEqual({ entries: [] });
      expect(yield* browseDirectories(`${root}/file.txt/`)).toEqual({ entries: [] });
    }),
  );

  it.effect("has no suggestions when the OS denies access", () =>
    Effect.gen(function* () {
      const root = yield* makeTree(["alpha"]);
      const denied = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      vi.spyOn(fsPromises, "readdir").mockRejectedValueOnce(denied);

      expect(yield* browseDirectories(`${root}/`)).toEqual({ entries: [] });
    }),
  );

  it.effect("fails with a typed error on any other read failure", () =>
    Effect.gen(function* () {
      const root = yield* makeTree([]);
      const broken = Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
      vi.spyOn(fsPromises, "readdir").mockRejectedValueOnce(broken);

      const failure = yield* browseDirectories(`${root}/`).pipe(Effect.flip);
      expect(failure._tag).toBe("BrowseDirectoriesFailure");
      expect(failure.message).toBe(`Unable to browse '${root}'.`);
      expect(failure.cause).toBe(broken);
    }),
  );

  it.effect("fails with a typed error when the read does not settle in time", () =>
    Effect.gen(function* () {
      let settle: () => void = noop;
      vi.spyOn(fsPromises, "readdir").mockReturnValueOnce(
        new Promise<never[]>((resolve) => {
          settle = () => resolve([]);
        }) as never,
      );
      const fiber = yield* browseDirectories("/net/sleeping-host/").pipe(
        Effect.flip,
        Effect.forkChild({ startImmediately: true }),
      );
      yield* TestClock.adjust("4 seconds");

      expect((yield* Fiber.join(fiber)).message).toBe("Timed out browsing '/net/sleeping-host'.");
      // Reads are shared across calls until they settle, so this one must not outlive the test.
      settle();
      yield* Effect.promise(() => new Promise((resolve) => setImmediate(resolve)));
    }),
  );

  it.effect("refuses relative and network paths without reading anything", () =>
    Effect.gen(function* () {
      const readdir = vi.spyOn(fsPromises, "readdir");
      const relative = "Only absolute paths and paths starting with ~ can be browsed.";

      expect(yield* failureMessage("./src")).toBe(relative);
      expect(yield* failureMessage("code/app")).toBe(relative);
      expect(yield* failureMessage("~other/code")).toBe(relative);
      expect(yield* failureMessage("\\\\server\\share\\")).toBe("Network paths can't be browsed.");
      expect(yield* failureMessage("//server/share/")).toBe("Network paths can't be browsed.");
      expect(readdir).not.toHaveBeenCalled();
    }),
  );

  it.effect("shares a hung read per directory and refuses more once two are hung", () =>
    Effect.gen(function* () {
      const letFibersRun = Effect.promise(() => new Promise((resolve) => setImmediate(resolve)));
      const releases: Array<() => void> = [];
      const readdir = vi.spyOn(fsPromises, "readdir").mockImplementation(
        () =>
          new Promise<never[]>((resolve) => {
            releases.push(() => resolve([]));
          }) as never,
      );
      const browse = (partialPath: string) =>
        browseDirectories(partialPath).pipe(
          Effect.map(() => "listed"),
          Effect.catch((failure) => Effect.succeed(failure.message)),
          Effect.forkChild,
        );

      const first = yield* browse("/net/one/a");
      const second = yield* browse("/net/one/b");
      yield* letFibersRun;
      expect(readdir).toHaveBeenCalledTimes(1);

      yield* TestClock.adjust("4 seconds");
      expect(yield* Fiber.join(first)).toBe("Timed out browsing '/net/one'.");
      expect(yield* Fiber.join(second)).toBe("Timed out browsing '/net/one'.");

      // The worker is still busy, so a timeout keeps the entry.
      const third = yield* browse("/net/one/c");
      yield* letFibersRun;
      expect(readdir).toHaveBeenCalledTimes(1);
      yield* TestClock.adjust("4 seconds");
      yield* Fiber.join(third);

      const other = yield* browse("/net/two/a");
      yield* letFibersRun;
      expect(readdir).toHaveBeenCalledTimes(2);
      expect(yield* failureMessage("/net/three/a")).toBe("Too many folders are still being read.");
      expect(readdir).toHaveBeenCalledTimes(2);

      for (const release of releases) release();
      yield* letFibersRun;
      expect(yield* Fiber.join(other)).toBe("listed");
      const fresh = yield* browse("/net/one/d");
      yield* letFibersRun;
      expect(readdir).toHaveBeenCalledTimes(3);
      for (const release of releases) release();
      yield* letFibersRun;
      yield* Fiber.join(fresh);
    }),
  );
});
