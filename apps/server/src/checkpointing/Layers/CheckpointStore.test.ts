import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Layer, PlatformError, Scope } from "effect";
import { describe, expect } from "vitest";

import { checkpointRefForThreadTurn } from "../Utils.ts";
import {
  CHECKPOINT_PATCH_MAX_OUTPUT_BYTES,
  CHECKPOINT_PATCH_TRUNCATED_MARKER,
  checkpointDurableWriteArgs,
  checkpointLongPathsArgs,
  CheckpointStoreLive,
  checkpointWriteArgsWithoutFullFsync,
  isTransientCheckpointGitFailure,
  rawAdditionsToIndexInfo,
  shouldRetryCheckpointWriteWithoutFullFsync,
} from "./CheckpointStore.ts";
import { parseTurnDiffFilesFromNumstat } from "../Diffs.ts";
import type { CheckpointStoreError } from "../Errors.ts";
import { CheckpointStore, type CheckpointStoreShape } from "../Services/CheckpointStore.ts";
import { GitCoreLive } from "../../git/Layers/GitCore.ts";
import { GitCore, type ExecuteGitInput, type GitCoreShape } from "../../git/Services/GitCore.ts";
import { GitCommandError } from "@piedpiper/contracts";
import { ServerConfig } from "../../config.ts";
import { CheckpointRef, ThreadId } from "@piedpiper/contracts";

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "piedpiper-checkpoint-store-test-",
});
const GitCoreTestLayer = GitCoreLive.pipe(
  Layer.provide(ServerConfigLayer),
  Layer.provide(NodeServices.layer),
);
const CheckpointStoreTestLayer = CheckpointStoreLive.pipe(
  Layer.provide(GitCoreTestLayer),
  Layer.provide(NodeServices.layer),
);
const TestLayer = Layer.mergeAll(NodeServices.layer, GitCoreTestLayer, CheckpointStoreTestLayer);

function makeTmpDir(
  prefix = "checkpoint-store-test-",
): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem | Scope.Scope> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.makeTempDirectoryScoped({ prefix });
  });
}

function writeTextFile(
  filePath: string,
  contents: string,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.writeFileString(filePath, contents);
  });
}

function git(
  cwd: string,
  args: ReadonlyArray<string>,
  options: { readonly committedAt?: string; readonly allowNonZeroExit?: boolean } = {},
): Effect.Effect<string, GitCommandError, GitCore> {
  return Effect.gen(function* () {
    const gitCore = yield* GitCore;
    const result = yield* gitCore.execute({
      operation: "CheckpointStore.test.git",
      cwd,
      args,
      timeoutMs: 10_000,
      ...(options.committedAt === undefined
        ? {}
        : { env: { GIT_COMMITTER_DATE: options.committedAt } }),
      ...(options.allowNonZeroExit === undefined
        ? {}
        : { allowNonZeroExit: options.allowNonZeroExit }),
    });
    return result.stdout.trim();
  });
}

function initRepoWithCommit(
  cwd: string,
): Effect.Effect<
  void,
  GitCommandError | PlatformError.PlatformError,
  GitCore | FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    const core = yield* GitCore;
    yield* core.initRepo({ cwd });
    yield* git(cwd, ["config", "user.email", "test@test.com"]);
    yield* git(cwd, ["config", "user.name", "Test"]);
    yield* writeTextFile(path.join(cwd, "README.md"), "# test\n");
    yield* git(cwd, ["add", "."]);
    yield* git(cwd, ["commit", "-m", "initial commit"]);
  });
}

function buildLargeText(lineCount = 20_000): string {
  return Array.from({ length: lineCount }, (_, index) => `line ${String(index).padStart(5, "0")}`)
    .join("\n")
    .concat("\n");
}

describe("CheckpointStoreLive durable writes", () => {
  const runStore = (
    respond: (input: ExecuteGitInput) => { code: number; stdout?: string; stderr?: string },
    run: (store: CheckpointStoreShape) => Effect.Effect<unknown, CheckpointStoreError>,
  ) => {
    const calls: Array<ReadonlyArray<string>> = [];
    const execute: GitCoreShape["execute"] = (input) =>
      Effect.gen(function* () {
        calls.push(input.args);
        const response = respond(input);
        const result = {
          code: response.code,
          stdout: response.stdout ?? "",
          stderr: response.stderr ?? "",
          stdoutTruncated: false,
          stderrTruncated: false,
        };
        if (result.code !== 0 && !input.allowNonZeroExit) {
          return yield* new GitCommandError({
            operation: input.operation,
            command: `git ${input.args.join(" ")}`,
            cwd: input.cwd,
            detail: result.stderr,
          });
        }
        return result;
      });
    const layer = CheckpointStoreLive.pipe(
      Layer.provide(Layer.succeed(GitCore, { execute } as unknown as GitCoreShape)),
      Layer.provide(NodeServices.layer),
    );
    return Effect.gen(function* () {
      const store = yield* CheckpointStore;
      const exit = yield* run(store).pipe(Effect.exit);
      return { calls, exit };
    }).pipe(Effect.provide(layer), Effect.runPromise);
  };
  const checkpointRef = CheckpointRef.makeUnsafe("refs/piedpiper/checkpoints/t/turn/1");
  const runCapture = (
    respond: (input: ExecuteGitInput) => { code: number; stdout?: string; stderr?: string },
  ) => runStore(respond, (store) => store.captureCheckpoint({ cwd: "/repo", checkpointRef }));

  const okResponse = (input: ExecuteGitInput) => ({
    code: 0,
    stdout: input.args.includes("write-tree")
      ? "tree0000\n"
      : input.args.includes("commit-tree")
        ? "commit0000\n"
        : input.args.includes("HEAD^{commit}")
          ? "head0000\n"
          : "",
  });

  it("retries a capture command that loses a race with another git process", async () => {
    let readTreeFailures = 0;
    let addFailures = 0;
    const { calls, exit } = await runCapture((input) => {
      if (input.args.includes("read-tree") && readTreeFailures < 1) {
        readTreeFailures++;
        return {
          code: 128,
          stderr:
            "fatal: Unable to create '/repo/.git/index.lock': File exists.\n\nAnother git process seems to be running.",
        };
      }
      if (input.args.includes("add") && addFailures < 2) {
        addFailures++;
        return { code: 128, stderr: 'error: open("tmp/build.log"): No such file or directory' };
      }
      return okResponse(input);
    });
    expect(exit._tag).toBe("Success");
    expect(calls.filter((args) => args.includes("read-tree"))).toHaveLength(2);
    expect(calls.filter((args) => args.includes("add"))).toHaveLength(3);
  });

  it("gives up on a transient failure after two retries", async () => {
    const { calls, exit } = await runCapture((input) =>
      input.args.includes("update-ref")
        ? {
            code: 128,
            stderr:
              "fatal: cannot lock ref 'refs/x': Unable to create '/repo/.git/refs/x.lock': File exists.",
          }
        : okResponse(input),
    );
    expect(exit._tag).toBe("Failure");
    expect(calls.filter((args) => args.includes("update-ref"))).toHaveLength(3);
  });

  it("records HEAD as the checkpoint parent with its branch", async () => {
    const { calls, exit } = await runCapture((input) =>
      input.args.includes("symbolic-ref")
        ? { code: 0, stdout: "refs/heads/main\n" }
        : okResponse(input),
    );
    expect(exit._tag).toBe("Success");
    const commitTree = calls.find((args) => args.includes("commit-tree")) ?? [];
    expect(commitTree.slice(commitTree.indexOf("commit-tree"))).toEqual([
      "commit-tree",
      "tree0000",
      "-p",
      "head0000",
      "-m",
      "piedpiper checkpoint ref=refs/piedpiper/checkpoints/t/turn/1 head=refs/heads/main",
    ]);
  });

  it("forces core.longpaths for staging only on Windows", async () => {
    expect(checkpointLongPathsArgs("win32")).toEqual(["-c", "core.longpaths=true"]);
    expect(checkpointLongPathsArgs("darwin")).toEqual([]);
    expect(checkpointLongPathsArgs("linux")).toEqual([]);
    const { calls } = await runCapture(okResponse);
    const add = calls.find((args) => args.includes("add")) ?? [];
    expect(add.includes("core.longpaths=true")).toBe(process.platform === "win32");
  });

  it("forces core.longpaths on every restore write only on Windows", async () => {
    let cleans = 0;
    // Restore recreates the workspace directory, so it needs a real one.
    const cwd = mkdtempSync(path.join(tmpdir(), "checkpoint-restore-longpaths-"));
    const { calls, exit } = await runStore(
      (input) => {
        if (input.args.includes("rev-parse")) return { code: 0, stdout: "commit0000\n" };
        // One removal forces the follow-up dry-run clean.
        if (input.args.includes("-fd")) {
          cleans++;
          return { code: 0, stdout: cleans <= 4 ? "Removing x\n" : "" };
        }
        return { code: 0 };
      },
      (store) => store.restoreCheckpoint({ cwd, checkpointRef }),
    ).finally(() => rmSync(cwd, { recursive: true, force: true }));
    expect(exit._tag).toBe("Success");
    const writes = calls.filter((args) =>
      ["restore", "reset", "clean"].some((command) => args.includes(command)),
    );
    expect(
      writes.map((args) => args.find((arg) => ["restore", "reset", "-fd", "-dn"].includes(arg))),
    ).toEqual(["restore", "-fd", "-fd", "-fd", "-fd", "-dn", "reset"]);
    for (const args of writes) {
      expect(args.includes("core.longpaths=true")).toBe(process.platform === "win32");
    }
  });

  it("recognises only lock contention and files deleted mid-scan as transient", () => {
    expect(
      isTransientCheckpointGitFailure(
        "fatal: Unable to create '/repo/.git/index.lock': File exists.",
      ),
    ).toBe(true);
    expect(
      isTransientCheckpointGitFailure(
        "error: unable to stat 'dist/a.js': No such file or directory",
      ),
    ).toBe(true);
    expect(
      isTransientCheckpointGitFailure('error: lstat("tmp/x"): No such file or directory'),
    ).toBe(true);
    expect(isTransientCheckpointGitFailure("fatal: disk full")).toBe(false);
    expect(isTransientCheckpointGitFailure("fatal: not a git repository")).toBe(false);
  });

  it("flushes objects and refs before publishing a checkpoint", async () => {
    const { calls, exit } = await runCapture(okResponse);
    expect(exit._tag).toBe("Success");
    const writeCommands = ["add", "write-tree", "commit-tree", "update-ref"];
    const writes = calls.filter((args) => writeCommands.some((command) => args.includes(command)));
    expect(writes).toHaveLength(4);
    for (const args of writes) {
      const command = args.findIndex((arg) => writeCommands.includes(arg));
      for (const setting of ["core.fsync=objects,reference", "core.fsyncMethod=fsync"]) {
        const index = args.indexOf(setting);
        expect(args[index - 1]).toBe("-c");
        expect(index).toBeLessThan(command);
      }
      expect(args.filter((arg) => arg.startsWith("core.fsyncMethod="))).toEqual(
        checkpointDurableWriteArgs(process.platform).filter((arg) =>
          arg.startsWith("core.fsyncMethod="),
        ),
      );
    }
    // The scratch index must never rewrite or expire the real index's shared split index.
    for (const args of calls.filter((a) => a.includes("read-tree") || a.includes("add"))) {
      expect(args).toContain("core.splitIndex=false");
      expect(args).toContain("splitIndex.sharedIndexExpire=never");
    }
  });

  it("adds batch after fsync only where Git documents it as equally durable", () => {
    const base = ["-c", "core.fsync=objects,reference", "-c", "core.fsyncMethod=fsync"];
    const batched = [...base, "-c", "core.fsyncMethod=batch"];
    expect(checkpointDurableWriteArgs("darwin")).toEqual(batched);
    expect(checkpointDurableWriteArgs("win32")).toEqual(batched);
    expect(checkpointDurableWriteArgs("linux")).toEqual(base);
  });

  it("maps both fsync and batch to writeout-only for the fallback", () => {
    const methods = (platform: NodeJS.Platform) =>
      checkpointWriteArgsWithoutFullFsync([...checkpointDurableWriteArgs(platform), "add"]).filter(
        (arg) => arg.startsWith("core.fsyncMethod="),
      );
    expect(new Set(methods("darwin"))).toEqual(new Set(["core.fsyncMethod=writeout-only"]));
    expect(new Set(methods("linux"))).toEqual(new Set(["core.fsyncMethod=writeout-only"]));
    expect(checkpointWriteArgsWithoutFullFsync(["-c", "core.fsync=objects", "add", "."])).toEqual([
      "-c",
      "core.fsync=objects",
      "add",
      ".",
    ]);
  });

  it.skipIf(process.platform !== "darwin")(
    "retries with writeout-only when a batch flush is unsupported on macOS",
    async () => {
      const { calls, exit } = await runCapture((input) =>
        input.args.includes("add") && input.args.includes("core.fsyncMethod=batch")
          ? {
              code: 128,
              stderr:
                "fatal: fsync error on '.git/objects/tmp_objdir-bulk-fsync-x/bulk_fsync_Ab12': Operation not supported",
            }
          : okResponse(input),
      );
      expect(exit._tag).toBe("Success");
      const adds = calls.filter((args) => args.includes("add"));
      expect(adds).toHaveLength(2);
      expect(adds[1]).toContain("core.fsyncMethod=writeout-only");
      expect(adds[1]).not.toContain("core.fsyncMethod=fsync");
      expect(adds[1]).not.toContain("core.fsyncMethod=batch");
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "goes straight to writeout-only once a cwd has needed the fallback",
    async () => {
      const unsupported = (input: ExecuteGitInput) =>
        input.args.includes("core.fsyncMethod=batch")
          ? {
              code: 128,
              stderr:
                "fatal: fsync error on '.git/objects/tmp_objdir-bulk-fsync-x/bulk_fsync_Ab12': Operation not supported",
            }
          : okResponse(input);
      const capture = (store: CheckpointStoreShape, cwd: string) =>
        store.captureCheckpoint({ cwd, checkpointRef });
      const { calls, exit } = await runStore(unsupported, (store) =>
        Effect.gen(function* () {
          yield* capture(store, "/share/repo");
          yield* capture(store, "/share/repo");
        }),
      );
      expect(exit._tag).toBe("Success");
      const adds = calls.filter((args) => args.includes("add"));
      // First capture: one failed attempt, then the fallback. Second capture: no failed attempt.
      expect(adds).toHaveLength(3);
      expect(adds[2]).toContain("core.fsyncMethod=writeout-only");
      expect(adds[2]).not.toContain("core.fsyncMethod=batch");
      // The first capture's later steps already skip the failing attempt too.
      for (const step of ["write-tree", "commit-tree", "update-ref"]) {
        const attempts = calls.filter((args) => args.includes(step));
        expect(attempts).toHaveLength(2);
        for (const args of attempts) {
          expect(args).toContain("core.fsyncMethod=writeout-only");
        }
      }
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "keeps the durable attempt for other cwds and when the fallback fails",
    async () => {
      const { calls, exit } = await runStore(
        (input) =>
          input.args.includes("add") &&
          (input.cwd === "/share/broken" ||
            (input.cwd === "/share/repo" && input.args.includes("core.fsyncMethod=batch")))
            ? {
                code: 128,
                stderr: "fatal: fsync error on '.git/objects/a5/tmp_obj': Operation not supported",
              }
            : okResponse(input),
        (store) =>
          Effect.gen(function* () {
            yield* store
              .captureCheckpoint({ cwd: "/share/broken", checkpointRef })
              .pipe(Effect.exit);
            yield* store
              .captureCheckpoint({ cwd: "/share/broken", checkpointRef })
              .pipe(Effect.exit);
            yield* store.captureCheckpoint({ cwd: "/share/repo", checkpointRef });
            yield* store.captureCheckpoint({ cwd: "/share/other", checkpointRef });
          }),
      );
      expect(exit._tag).toBe("Success");
      const adds = calls.filter((args) => args.includes("add"));
      // broken: both captures retry because the fallback never succeeded; repo: 2; other: 1.
      expect(adds).toHaveLength(7);
      expect(adds[6]).toContain("core.fsyncMethod=batch");
    },
  );

  it("does not retry unrelated write failures", async () => {
    const { calls, exit } = await runCapture((input) =>
      input.args.includes("add") ? { code: 128, stderr: "fatal: disk full" } : okResponse(input),
    );
    expect(exit._tag).toBe("Failure");
    expect(calls.filter((args) => args.includes("add"))).toHaveLength(1);
  });

  it("only falls back for unsupported fsync errors on macOS", () => {
    const fsyncError = "fatal: fsync error on '.git/objects/a5/tmp_obj': Operation not supported";
    const lockError =
      "fatal: update_ref failed for ref 'refs/x': cannot update ref 'refs/x': couldn't write '/Volumes/share/.git/refs/x.lock'";
    const batchError =
      "fatal: fsync error on '.git/objects/tmp_objdir-bulk-fsync-x/bulk_fsync_Ab12': Operation not supported";
    expect(shouldRetryCheckpointWriteWithoutFullFsync("darwin", fsyncError)).toBe(true);
    expect(shouldRetryCheckpointWriteWithoutFullFsync("darwin", batchError)).toBe(true);
    expect(shouldRetryCheckpointWriteWithoutFullFsync("darwin", lockError)).toBe(true);
    expect(shouldRetryCheckpointWriteWithoutFullFsync("linux", fsyncError)).toBe(false);
    expect(
      shouldRetryCheckpointWriteWithoutFullFsync("darwin", "fatal: Operation not supported"),
    ).toBe(false);
    expect(
      shouldRetryCheckpointWriteWithoutFullFsync("darwin", `${lockError}: Input/output error`),
    ).toBe(false);
  });
});

it.layer(TestLayer)("CheckpointStoreLive", (it) => {
  describe("diffCheckpoints", () => {
    it.effect("returns full oversized checkpoint diffs without truncation", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore;
        const threadId = ThreadId.makeUnsafe("thread-checkpoint-store");
        const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 0);
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);

        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: fromCheckpointRef,
        });
        yield* writeTextFile(path.join(tmp, "README.md"), buildLargeText());
        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: toCheckpointRef,
        });

        const diff = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
        });

        expect(diff).toContain("diff --git");
        expect(diff).not.toContain("[truncated]");
        expect(diff).toContain("+line 19999");
      }),
    );

    it.effect.skipIf(process.platform === "win32")(
      "ignores repo-configured external diff drivers",
      () =>
        Effect.gen(function* () {
          const tmp = yield* makeTmpDir();
          yield* initRepoWithCommit(tmp);
          const fileSystem = yield* FileSystem.FileSystem;
          const helperDir = yield* makeTmpDir("checkpoint-ext-diff-");
          const externalDiffPath = path.join(helperDir, "external-diff.sh");
          yield* writeTextFile(externalDiffPath, '#!/bin/sh\nprintf "EXTERNAL-DIFF-RAN\\n"\n');
          yield* fileSystem.chmod(externalDiffPath, 0o755);
          const textconvMarker = path.join(helperDir, "textconv-ran");
          const textconvPath = path.join(helperDir, "textconv.sh");
          yield* writeTextFile(
            textconvPath,
            `#!/bin/sh\n: > "${textconvMarker}"\nprintf "converted\\n"\n`,
          );
          yield* fileSystem.chmod(textconvPath, 0o755);
          yield* git(tmp, ["config", "diff.external", externalDiffPath]);
          yield* git(tmp, ["config", "diff.probe.textconv", textconvPath]);
          yield* git(tmp, ["config", "color.ui", "always"]);
          yield* writeTextFile(path.join(tmp, ".gitattributes"), "*.doc diff=probe\n");
          const checkpointStore = yield* CheckpointStore;
          const threadId = ThreadId.makeUnsafe("thread-checkpoint-ext-diff");
          const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 0);
          const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);

          yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: fromCheckpointRef });
          yield* writeTextFile(path.join(tmp, "README.md"), "# test\nchanged\n");
          yield* writeTextFile(path.join(tmp, "notes.doc"), "source line\n");
          yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: toCheckpointRef });

          const diff = yield* checkpointStore.diffCheckpoints({
            cwd: tmp,
            fromCheckpointRef,
            toCheckpointRef,
          });

          expect(diff).toContain("+changed");
          expect(diff).toContain("+source line");
          expect(diff).not.toContain("EXTERNAL-DIFF-RAN");
          expect(diff).not.toContain("converted");
          expect(diff).not.toContain("\u001b[");
          expect(yield* fileSystem.exists(textconvMarker)).toBe(false);
        }),
    );
  });

  describe("diffCheckpoints user config", () => {
    it.effect("ignores diff config that changes patch shape or hides files", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const fileSystem = yield* FileSystem.FileSystem;
        yield* fileSystem.makeDirectory(path.join(tmp, "sub"));
        yield* writeTextFile(path.join(tmp, "sub", "inner.txt"), "one\n\nthree\n");
        yield* git(tmp, ["add", "."]);
        yield* git(tmp, ["commit", "-m", "add sub"]);
        const embedded = path.join(tmp, "mod");
        yield* fileSystem.makeDirectory(embedded);
        yield* initRepoWithCommit(embedded);
        yield* git(tmp, ["config", "diff.noprefix", "true"]);
        yield* git(tmp, ["config", "diff.mnemonicPrefix", "true"]);
        yield* git(tmp, ["config", "diff.suppressBlankEmpty", "true"]);
        yield* git(tmp, ["config", "diff.submodule", "log"]);
        yield* git(tmp, ["config", "diff.relative", "true"]);
        const checkpointStore = yield* CheckpointStore;
        const threadId = ThreadId.makeUnsafe("thread-checkpoint-diff-config");
        const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 0);
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
        const subdir = path.join(tmp, "sub");

        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: fromCheckpointRef });
        yield* writeTextFile(path.join(tmp, "README.md"), "# test\nchanged\n");
        yield* writeTextFile(path.join(subdir, "inner.txt"), "one\n\nthree changed\n");
        yield* git(embedded, ["commit", "--allow-empty", "-m", "moved"]);
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: toCheckpointRef });

        const diff = yield* checkpointStore.diffCheckpoints({
          cwd: subdir,
          fromCheckpointRef,
          toCheckpointRef,
        });
        expect(diff).toContain("diff --git a/README.md b/README.md");
        expect(diff).toContain("--- a/sub/inner.txt");
        expect(diff).toContain("+++ b/sub/inner.txt");
        // A blank context line keeps its leading space instead of becoming an empty line.
        expect(diff).toContain("\n \n");
        // diff.submodule=log would print a commit log instead of a parseable gitlink hunk.
        expect(diff).toContain("diff --git a/mod b/mod");
        expect(diff).toContain("+Subproject commit ");

        const numstat = yield* checkpointStore.diffCheckpoints({
          cwd: subdir,
          fromCheckpointRef,
          toCheckpointRef,
          format: "numstat",
        });
        expect(numstat.split("\0").filter((record) => record.length > 0)).toEqual([
          "1\t0\tREADME.md",
          "1\t1\tmod",
          "1\t1\tsub/inner.txt",
        ]);
      }),
    );
  });

  describe("diffCheckpoints numstat", () => {
    it.effect("summarizes turns whose patch would exceed the output cap", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore;
        const threadId = ThreadId.makeUnsafe("thread-checkpoint-numstat");
        const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 0);
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);

        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: fromCheckpointRef });
        yield* writeTextFile(path.join(tmp, "big.lock"), buildLargeText(150_000));
        yield* writeTextFile(path.join(tmp, "README.md"), "# renamed\n");
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: toCheckpointRef });

        const numstat = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
          format: "numstat",
        });
        expect(numstat.split("\0").filter((record) => record.length > 0)).toEqual([
          "1\t1\tREADME.md",
          "150000\t0\tbig.lock",
        ]);
      }),
    );
  });

  describe("diffCheckpoints non-ASCII paths", () => {
    const composed = "caf\u00e9 \u65e5\u672c\u8a9e.md";

    const captureAround = (
      tmp: string,
      threadName: string,
      change: Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem>,
    ) =>
      Effect.gen(function* () {
        const checkpointStore = yield* CheckpointStore;
        const threadId = ThreadId.makeUnsafe(threadName);
        const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 0);
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: fromCheckpointRef });
        yield* change;
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: toCheckpointRef });
        return { checkpointStore, comparison: { cwd: tmp, fromCheckpointRef, toCheckpointRef } };
      });

    it.effect("keeps the names literal in patches and numstat, ignoring core.quotePath", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* git(tmp, ["config", "core.quotePath", "true"]);
        const { checkpointStore, comparison } = yield* captureAround(
          tmp,
          "thread-checkpoint-non-ascii",
          Effect.gen(function* () {
            yield* writeTextFile(path.join(tmp, composed), "hello\n");
            yield* writeTextFile(path.join(tmp, "plain.md"), "plain\n");
          }),
        );

        const patch = yield* checkpointStore.diffCheckpoints(comparison);
        expect(patch).toContain(`diff --git a/${composed} b/${composed}`);
        expect(patch).not.toContain("\\303");

        const numstat = yield* checkpointStore.diffCheckpoints({
          ...comparison,
          format: "numstat",
        });
        expect(parseTurnDiffFilesFromNumstat(numstat)).toEqual([
          { path: composed, additions: 1, deletions: 0 },
          { path: "plain.md", additions: 1, deletions: 0 },
        ]);

        const filtered = yield* checkpointStore.diffCheckpoints({
          ...comparison,
          filePaths: [composed],
        });
        expect(filtered).toContain(`b/${composed}`);
        expect(filtered).not.toContain("plain.md");
      }),
    );

    it.effect("reports a rename between two non-ASCII names under the new name", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const body = Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n");
        yield* writeTextFile(path.join(tmp, composed), `${body}\n`);
        const renamed = "\u0441\u0432\u043e\u0434\u043a\u0430.md";
        const { checkpointStore, comparison } = yield* captureAround(
          tmp,
          "thread-checkpoint-non-ascii-rename",
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem;
            yield* fileSystem.rename(path.join(tmp, composed), path.join(tmp, renamed));
          }),
        );

        const numstat = yield* checkpointStore.diffCheckpoints({
          ...comparison,
          format: "numstat",
        });
        expect(parseTurnDiffFilesFromNumstat(numstat)).toEqual([
          { path: renamed, previousPath: composed, additions: 0, deletions: 0 },
        ]);
      }),
    );

    it.effect("restores a turn that added and changed non-ASCII files", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const fileSystem = yield* FileSystem.FileSystem;
        const added = "\u65b0\u3057\u3044.txt";
        yield* writeTextFile(path.join(tmp, composed), "before\n");
        const { checkpointStore, comparison } = yield* captureAround(
          tmp,
          "thread-checkpoint-non-ascii-restore",
          Effect.gen(function* () {
            yield* writeTextFile(path.join(tmp, composed), "after\n");
            yield* writeTextFile(path.join(tmp, added), "new\n");
          }),
        );

        const restored = yield* checkpointStore.restoreCheckpoint({
          cwd: tmp,
          checkpointRef: comparison.fromCheckpointRef,
        });

        expect(restored).toBe(true);
        expect(yield* fileSystem.readFileString(path.join(tmp, composed))).toBe("before\n");
        expect(yield* fileSystem.exists(path.join(tmp, added))).toBe(false);
      }),
    );
  });

  describe("diffCheckpoints ignoreWhitespace", () => {
    it.effect("hides indentation-only changes from the patch but not from numstat", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore;
        const threadId = ThreadId.makeUnsafe("thread-checkpoint-whitespace");
        const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 0);
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);

        yield* writeTextFile(path.join(tmp, "code.ts"), "if (a) {\nreturn 1;\n}\n");
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: fromCheckpointRef });
        yield* writeTextFile(path.join(tmp, "code.ts"), "if (a) {\n    return 1;\n}\n");
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: toCheckpointRef });

        const comparison = { cwd: tmp, fromCheckpointRef, toCheckpointRef };
        const hidden = yield* checkpointStore.diffCheckpoints({
          ...comparison,
          ignoreWhitespace: true,
        });
        const shown = yield* checkpointStore.diffCheckpoints(comparison);
        const numstat = yield* checkpointStore.diffCheckpoints({
          ...comparison,
          format: "numstat",
          ignoreWhitespace: true,
        });

        expect(hidden).toBe("");
        expect(shown).toContain("+    return 1;");
        expect(parseTurnDiffFilesFromNumstat(numstat)).toEqual([
          { path: "code.ts", additions: 1, deletions: 1 },
        ]);
      }),
    );
  });

  describe("captureCheckpoint", () => {
    it.effect("keeps the shared index a split index still uses", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* git(tmp, ["config", "core.splitIndex", "true"]);
        yield* git(tmp, ["config", "splitIndex.sharedIndexExpire", "now"]);
        yield* git(tmp, ["update-index", "--split-index"]);
        yield* writeTextFile(path.join(tmp, "untracked.txt"), "new\n");
        const checkpointStore = yield* CheckpointStore;
        const checkpointRef = checkpointRefForThreadTurn(
          ThreadId.makeUnsafe("thread-checkpoint-split-index"),
          0,
        );

        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef });

        expect(yield* git(tmp, ["show", `${checkpointRef}:untracked.txt`])).toBe("new");
        // The real index points at a sharedindex.* file; reading it fails if capture expired it.
        expect(yield* git(tmp, ["ls-files", "--cached"])).toBe("README.md");
      }),
    );

    it.effect.skipIf(process.platform === "win32")(
      "never runs a repo-configured fsmonitor hook while staging",
      () =>
        Effect.gen(function* () {
          const tmp = yield* makeTmpDir();
          yield* initRepoWithCommit(tmp);
          const fileSystem = yield* FileSystem.FileSystem;
          const helperDir = yield* makeTmpDir("checkpoint-fsmonitor-");
          const markerPath = path.join(helperDir, "fsmonitor-ran");
          const hookPath = path.join(helperDir, "fsmonitor.sh");
          yield* writeTextFile(hookPath, `#!/bin/sh\n: > "${markerPath}"\nprintf "/"\n`);
          yield* fileSystem.chmod(hookPath, 0o755);
          yield* git(tmp, ["config", "core.fsmonitor", hookPath]);
          const checkpointStore = yield* CheckpointStore;
          const checkpointRef = checkpointRefForThreadTurn(
            ThreadId.makeUnsafe("thread-checkpoint-fsmonitor"),
            0,
          );

          yield* writeTextFile(path.join(tmp, "new.txt"), "new\n");
          yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef });

          expect(yield* checkpointStore.hasCheckpointRef({ cwd: tmp, checkpointRef })).toBe(true);
          expect(yield* fileSystem.exists(markerPath)).toBe(false);

          // Restoring rewrites the real index too, so it must not run the hook either.
          yield* writeTextFile(path.join(tmp, "new.txt"), "edited\n");
          yield* writeTextFile(path.join(tmp, "extra.txt"), "extra\n");
          expect(yield* checkpointStore.restoreCheckpoint({ cwd: tmp, checkpointRef })).toBe(true);
          expect(yield* fileSystem.readFileString(path.join(tmp, "new.txt"))).toBe("new\n");
          expect(yield* fileSystem.exists(path.join(tmp, "extra.txt"))).toBe(false);
          expect(yield* fileSystem.exists(markerPath)).toBe(false);
        }),
    );
  });

  describe("captureCheckpoint staging edge cases", () => {
    it.effect("keeps LF files that core.safecrlf would refuse to stage", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* writeTextFile(path.join(tmp, ".gitattributes"), "*.txt text eol=crlf\n");
        yield* git(tmp, ["config", "core.safecrlf", "true"]);
        yield* writeTextFile(path.join(tmp, "untracked.txt"), "new\n");
        const checkpointStore = yield* CheckpointStore;
        const checkpointRef = checkpointRefForThreadTurn(
          ThreadId.makeUnsafe("thread-checkpoint-safecrlf"),
          0,
        );

        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef });

        expect(yield* git(tmp, ["show", `${checkpointRef}:untracked.txt`])).toBe("new");
      }),
    );

    it.effect("skips a nested repository that has no commit yet", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const fileSystem = yield* FileSystem.FileSystem;
        const nested = path.join(tmp, "nested");
        yield* fileSystem.makeDirectory(nested);
        yield* git(nested, ["init"]);
        yield* writeTextFile(path.join(nested, "inner.txt"), "inner\n");
        yield* writeTextFile(path.join(tmp, "outer.txt"), "outer\n");
        const checkpointStore = yield* CheckpointStore;
        const checkpointRef = checkpointRefForThreadTurn(
          ThreadId.makeUnsafe("thread-checkpoint-nested-unborn"),
          0,
        );

        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef });

        expect(yield* git(tmp, ["show", `${checkpointRef}:outer.txt`])).toBe("outer");
        expect(yield* git(tmp, ["ls-tree", "--name-only", checkpointRef, "--", "nested"])).toBe("");
      }),
    );

    it.effect("reports a workspace its repository ignores as unsupported", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const fileSystem = yield* FileSystem.FileSystem;
        yield* writeTextFile(
          path.join(tmp, ".gitignore"),
          "*\n!.gitignore\n!README.md\n!keep/\n!keep/**\n",
        );
        const ignoredCwd = path.join(tmp, "ignored");
        const keepCwd = path.join(tmp, "keep");
        yield* fileSystem.makeDirectory(ignoredCwd);
        yield* fileSystem.makeDirectory(keepCwd);
        yield* writeTextFile(path.join(ignoredCwd, "secret.txt"), "private\n");
        yield* writeTextFile(path.join(keepCwd, "new.txt"), "new\n");
        const checkpointStore = yield* CheckpointStore;
        const threadId = ThreadId.makeUnsafe("thread-checkpoint-ignored");
        const ignoredRef = checkpointRefForThreadTurn(threadId, 0);
        const keepRef = checkpointRefForThreadTurn(threadId, 1);

        const ignored = yield* checkpointStore
          .captureCheckpoint({ cwd: ignoredCwd, checkpointRef: ignoredRef })
          .pipe(Effect.flip);
        yield* checkpointStore.captureCheckpoint({ cwd: keepCwd, checkpointRef: keepRef });

        expect(ignored._tag).toBe("CheckpointUnsupportedError");
        expect(
          yield* checkpointStore.hasCheckpointRef({ cwd: tmp, checkpointRef: ignoredRef }),
        ).toBe(false);
        expect(yield* git(tmp, ["show", `${keepRef}:keep/new.txt`])).toBe("new");
        // The repository root still captures normally under a bare `*` rule.
        const rootRef = checkpointRefForThreadTurn(threadId, 2);
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: rootRef });
        expect(yield* git(tmp, ["show", `${rootRef}:keep/new.txt`])).toBe("new");
      }),
    );

    it.effect.each([
      { name: "committed", committed: ["committed.txt"], staged: [] as Array<string> },
      { name: "staged", committed: [] as Array<string>, staged: ["staged.txt"] },
      { name: "committed and staged", committed: ["committed.txt"], staged: ["staged.txt"] },
    ])("keeps $name edits in a workspace ignored later", ({ committed, staged }) =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const fileSystem = yield* FileSystem.FileSystem;
        const cwd = path.join(tmp, "sub");
        yield* fileSystem.makeDirectory(cwd);
        for (const name of committed) {
          yield* writeTextFile(path.join(cwd, name), `${name}\n`);
          yield* git(tmp, ["add", `sub/${name}`]);
        }
        if (committed.length > 0) yield* git(tmp, ["commit", "-m", "track project"]);
        for (const name of staged) {
          yield* writeTextFile(path.join(cwd, name), `${name}\n`);
          yield* git(tmp, ["add", `sub/${name}`]);
        }
        yield* writeTextFile(path.join(tmp, ".gitignore"), "sub/\n");
        for (const name of [...committed, ...staged]) {
          yield* writeTextFile(path.join(cwd, name), `${name} working\n`);
        }
        yield* writeTextFile(path.join(cwd, "secret.txt"), "private\n");
        const indexBefore = yield* fileSystem.readFile(path.join(tmp, ".git", "index"));
        const checkpointStore = yield* CheckpointStore;
        const checkpointRef = checkpointRefForThreadTurn(
          ThreadId.makeUnsafe("thread-checkpoint-ignored-later"),
          0,
        );

        yield* checkpointStore.captureCheckpoint({ cwd, checkpointRef });

        const expected = [...committed, ...staged].toSorted();
        expect(yield* git(tmp, ["ls-tree", "-r", "--name-only", checkpointRef, "--", "sub"])).toBe(
          expected.map((name) => `sub/${name}`).join("\n"),
        );
        for (const name of expected) {
          expect(yield* git(tmp, ["show", `${checkpointRef}:sub/${name}`])).toBe(`${name} working`);
        }
        expect(yield* fileSystem.readFile(path.join(tmp, ".git", "index"))).toEqual(indexBefore);
      }),
    );

    it.effect("still fails with the staging error when a clean filter rejects a file", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const fileSystem = yield* FileSystem.FileSystem;
        yield* git(tmp, ["config", "filter.reject.clean", "false"]);
        yield* git(tmp, ["config", "filter.reject.required", "true"]);
        yield* writeTextFile(path.join(tmp, ".gitattributes"), "rejected.txt filter=reject\n");
        yield* writeTextFile(path.join(tmp, "rejected.txt"), "rejected\n");
        const indexBefore = yield* fileSystem.readFile(path.join(tmp, ".git", "index"));
        const checkpointStore = yield* CheckpointStore;
        const checkpointRef = checkpointRefForThreadTurn(
          ThreadId.makeUnsafe("thread-checkpoint-filter-reject"),
          0,
        );

        const error = yield* checkpointStore
          .captureCheckpoint({ cwd: tmp, checkpointRef })
          .pipe(Effect.flip);

        expect(error._tag).toBe("GitCommandError");
        expect(yield* fileSystem.readFile(path.join(tmp, ".git", "index"))).toEqual(indexBefore);
        expect(yield* checkpointStore.hasCheckpointRef({ cwd: tmp, checkpointRef })).toBe(false);
      }),
    );

    it.effect.skipIf(process.platform === "win32")(
      "never runs a repo-configured fsmonitor hook on the staging fallbacks",
      () =>
        Effect.gen(function* () {
          const tmp = yield* makeTmpDir();
          yield* initRepoWithCommit(tmp);
          const fileSystem = yield* FileSystem.FileSystem;
          const helperDir = yield* makeTmpDir("checkpoint-fsmonitor-fallback-");
          const markerPath = path.join(helperDir, "fsmonitor-ran");
          const hookPath = path.join(helperDir, "fsmonitor.sh");
          yield* writeTextFile(hookPath, `#!/bin/sh\n: > "${markerPath}"\nprintf "/"\n`);
          yield* fileSystem.chmod(hookPath, 0o755);
          // A commit-less nested repository drives the untracked-listing recovery path.
          const nested = path.join(tmp, "nested");
          yield* fileSystem.makeDirectory(nested);
          yield* git(nested, ["init"]);
          yield* writeTextFile(path.join(nested, "inner.txt"), "inner\n");
          // A staged addition in an ignored workspace drives the index-info seeding path.
          const ignoredCwd = path.join(tmp, "ignored");
          yield* fileSystem.makeDirectory(ignoredCwd);
          yield* writeTextFile(path.join(ignoredCwd, "staged.txt"), "staged\n");
          yield* git(tmp, ["add", "ignored/staged.txt"]);
          yield* writeTextFile(path.join(tmp, ".gitignore"), "ignored/\n");
          yield* git(tmp, ["config", "core.fsmonitor", hookPath]);
          const checkpointStore = yield* CheckpointStore;
          const threadId = ThreadId.makeUnsafe("thread-checkpoint-fsmonitor-fallback");
          const rootRef = checkpointRefForThreadTurn(threadId, 0);
          const ignoredRef = checkpointRefForThreadTurn(threadId, 1);

          yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: rootRef });
          yield* checkpointStore.captureCheckpoint({ cwd: ignoredCwd, checkpointRef: ignoredRef });

          expect(yield* git(tmp, ["ls-tree", "--name-only", rootRef, "--", "nested"])).toBe("");
          expect(yield* git(tmp, ["show", `${ignoredRef}:ignored/staged.txt`])).toBe("staged");
          expect(yield* fileSystem.exists(markerPath)).toBe(false);
        }),
    );

    it("converts raw staged additions into index-info records", () => {
      const raw =
        ":000000 100644 0000000000000000000000000000000000000000 " +
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa A\0sub/a b.txt\0" +
        ":000000 120000 0000000000000000000000000000000000000000 " +
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb A\0sub/link\0";
      expect(rawAdditionsToIndexInfo(raw)).toBe(
        "100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\tsub/a b.txt\0" +
          "120000 bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\tsub/link\0",
      );
      expect(rawAdditionsToIndexInfo("")).toBe("");
    });
  });

  describe("restoreCheckpoint", () => {
    it.effect("leaves restored files unstaged before the first commit", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        const core = yield* GitCore;
        yield* core.initRepo({ cwd: tmp });
        yield* writeTextFile(path.join(tmp, "a.txt"), "a\n");
        const checkpointStore = yield* CheckpointStore;
        const checkpointRef = checkpointRefForThreadTurn(
          ThreadId.makeUnsafe("thread-checkpoint-unborn-restore"),
          0,
        );
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef });
        yield* writeTextFile(path.join(tmp, "a.txt"), "changed\n");

        expect(yield* checkpointStore.restoreCheckpoint({ cwd: tmp, checkpointRef })).toBe(true);

        const fileSystem = yield* FileSystem.FileSystem;
        expect(yield* fileSystem.readFileString(path.join(tmp, "a.txt"))).toBe("a\n");
        expect(yield* git(tmp, ["ls-files", "--cached"])).toBe("");
      }),
    );

    it.effect(
      "leaves only unrelated staged files outside a nested workspace before the first commit",
      () =>
        Effect.gen(function* () {
          const tmp = yield* makeTmpDir();
          const core = yield* GitCore;
          yield* core.initRepo({ cwd: tmp });
          const fileSystem = yield* FileSystem.FileSystem;
          const cwd = path.join(tmp, "sub");
          yield* fileSystem.makeDirectory(cwd);
          yield* writeTextFile(path.join(cwd, "a.txt"), "a\n");
          const checkpointStore = yield* CheckpointStore;
          const checkpointRef = checkpointRefForThreadTurn(
            ThreadId.makeUnsafe("thread-checkpoint-unborn-nested-restore"),
            0,
          );
          yield* checkpointStore.captureCheckpoint({ cwd, checkpointRef });
          yield* writeTextFile(path.join(tmp, "outside.txt"), "outside\n");
          yield* git(tmp, ["add", "outside.txt"]);
          yield* writeTextFile(path.join(cwd, "a.txt"), "changed\n");
          yield* writeTextFile(path.join(cwd, "added.txt"), "added\n");
          yield* git(tmp, ["add", "sub/added.txt"]);

          expect(yield* checkpointStore.restoreCheckpoint({ cwd, checkpointRef })).toBe(true);

          expect(yield* fileSystem.readFileString(path.join(cwd, "a.txt"))).toBe("a\n");
          expect(yield* fileSystem.exists(path.join(cwd, "added.txt"))).toBe(false);
          expect(yield* git(tmp, ["ls-files", "--cached"])).toBe("outside.txt");
        }),
    );

    it.effect("fails with a reset index when nested .gitignore files hide too deep", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const fileSystem = yield* FileSystem.FileSystem;
        const checkpointStore = yield* CheckpointStore;
        const checkpointRef = checkpointRefForThreadTurn(
          ThreadId.makeUnsafe("thread-checkpoint-gitignore-chain"),
          0,
        );
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef });
        yield* writeTextFile(path.join(tmp, "README.md"), "# later\n");
        let deepest = tmp;
        for (let depth = 0; depth < 4; depth++) {
          yield* writeTextFile(path.join(deepest, ".gitignore"), "d/.gitignore\n");
          deepest = path.join(deepest, "d");
          yield* fileSystem.makeDirectory(deepest);
        }
        yield* writeTextFile(path.join(deepest, ".gitignore"), "hidden.txt\n");
        yield* writeTextFile(path.join(deepest, "hidden.txt"), "remove\n");

        const error = yield* checkpointStore
          .restoreCheckpoint({ cwd: tmp, checkpointRef })
          .pipe(Effect.flip);

        expect(error._tag).toBe("GitCommandError");
        expect(error.message).toContain("untracked files remain");
        expect(yield* fileSystem.readFileString(path.join(tmp, "README.md"))).toBe("# test\n");
        expect(yield* git(tmp, ["diff", "--cached", "--name-only", "--", "."])).toBe("");
      }),
    );

    it.effect("removes files that a turn-created .gitignore was hiding", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const fileSystem = yield* FileSystem.FileSystem;
        const checkpointStore = yield* CheckpointStore;
        const checkpointRef = checkpointRefForThreadTurn(
          ThreadId.makeUnsafe("thread-checkpoint-gitignore-restore"),
          0,
        );
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef });
        yield* writeTextFile(path.join(tmp, ".gitignore"), "dist/\n");
        yield* fileSystem.makeDirectory(path.join(tmp, "dist"));
        yield* writeTextFile(path.join(tmp, "dist", "bundle.js"), "built\n");

        expect(yield* checkpointStore.restoreCheckpoint({ cwd: tmp, checkpointRef })).toBe(true);

        expect(yield* fileSystem.exists(path.join(tmp, ".gitignore"))).toBe(false);
        expect(yield* fileSystem.exists(path.join(tmp, "dist"))).toBe(false);
        expect(yield* git(tmp, ["status", "--porcelain"])).toBe("");
      }),
    );

    it.effect("keeps a nested workspace that restoring empties and resets its index", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const fileSystem = yield* FileSystem.FileSystem;
        const cwd = path.join(tmp, "sub");
        yield* fileSystem.makeDirectory(cwd);
        const checkpointStore = yield* CheckpointStore;
        const checkpointRef = checkpointRefForThreadTurn(
          ThreadId.makeUnsafe("thread-checkpoint-nested-restore"),
          0,
        );
        yield* checkpointStore.captureCheckpoint({ cwd, checkpointRef });
        yield* writeTextFile(path.join(cwd, "new.txt"), "new\n");
        yield* git(tmp, ["add", "sub/new.txt"]);

        expect(yield* checkpointStore.restoreCheckpoint({ cwd, checkpointRef })).toBe(true);

        expect(yield* fileSystem.exists(cwd)).toBe(true);
        expect(yield* fileSystem.readDirectory(cwd)).toEqual([]);
        expect(yield* git(tmp, ["status", "--porcelain"])).toBe("");
      }),
    );
  });

  describe("diffCheckpoints truncation", () => {
    it.effect("truncates an oversized patch with a marker instead of failing", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore;
        const threadId = ThreadId.makeUnsafe("thread-checkpoint-truncated-diff");
        const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 0);
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: fromCheckpointRef });
        yield* writeTextFile(path.join(tmp, "big.lock"), buildLargeText(1_000_000));
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: toCheckpointRef });

        const diff = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
        });

        expect(diff.startsWith("diff --git a/big.lock b/big.lock")).toBe(true);
        expect(diff.endsWith(CHECKPOINT_PATCH_TRUNCATED_MARKER)).toBe(true);
        expect(Buffer.byteLength(diff)).toBeLessThanOrEqual(
          CHECKPOINT_PATCH_MAX_OUTPUT_BYTES + Buffer.byteLength(CHECKPOINT_PATCH_TRUNCATED_MARKER),
        );
      }),
    );
  });

  describe("diffCheckpoints refs and paths", () => {
    it.effect("names the side whose checkpoint ref is missing", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore;
        const threadId = ThreadId.makeUnsafe("thread-checkpoint-missing-side");
        const present = checkpointRefForThreadTurn(threadId, 0);
        const missing = checkpointRefForThreadTurn(threadId, 1);
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: present });

        const toError = yield* checkpointStore
          .diffCheckpoints({ cwd: tmp, fromCheckpointRef: present, toCheckpointRef: missing })
          .pipe(Effect.flip);
        const fromError = yield* checkpointStore
          .diffCheckpoints({ cwd: tmp, fromCheckpointRef: missing, toCheckpointRef: present })
          .pipe(Effect.flip);

        expect(toError).toMatchObject({ _tag: "CheckpointRefUnavailableError", side: "to" });
        expect(fromError).toMatchObject({ _tag: "CheckpointRefUnavailableError", side: "from" });
      }),
    );

    it.effect("reads repository paths from a subdirectory workspace under diff.relative", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        yield* git(tmp, ["config", "diff.relative", "true"]);
        const fileSystem = yield* FileSystem.FileSystem;
        const cwd = path.join(tmp, "app");
        yield* fileSystem.makeDirectory(cwd);
        const checkpointStore = yield* CheckpointStore;
        const threadId = ThreadId.makeUnsafe("thread-checkpoint-file-paths");
        const refs = {
          cwd,
          fromCheckpointRef: checkpointRefForThreadTurn(threadId, 0),
          toCheckpointRef: checkpointRefForThreadTurn(threadId, 1),
        };
        yield* checkpointStore.captureCheckpoint({ cwd, checkpointRef: refs.fromCheckpointRef });
        yield* writeTextFile(path.join(cwd, "kept.txt"), "kept\n");
        yield* git(cwd, ["add", "kept.txt"]);
        yield* git(cwd, ["commit", "-m", "kept"]);
        yield* writeTextFile(path.join(tmp, "README.md"), "# hidden\n");
        yield* checkpointStore.captureCheckpoint({ cwd, checkpointRef: refs.toCheckpointRef });

        const patch = yield* checkpointStore.diffCheckpoints({
          ...refs,
          filePaths: ["app/kept.txt"],
        });
        expect(patch).toContain("+++ b/app/kept.txt");
        expect(patch).toContain("+kept");
        expect(patch).not.toContain("hidden");
        expect(yield* checkpointStore.diffCheckpoints({ ...refs, filePaths: [] })).toBe("");
        expect(yield* checkpointStore.listAuthoredPaths(refs)).toEqual(new Set(["app/kept.txt"]));
      }),
    );

    it.effect("returns a patch cut at an explicit byte limit without the marker", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore;
        const threadId = ThreadId.makeUnsafe("thread-checkpoint-explicit-limit");
        const refs = {
          cwd: tmp,
          fromCheckpointRef: checkpointRefForThreadTurn(threadId, 0),
          toCheckpointRef: checkpointRefForThreadTurn(threadId, 1),
        };
        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: refs.fromCheckpointRef,
        });
        yield* writeTextFile(path.join(tmp, "README.md"), buildLargeText(1_000));
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: refs.toCheckpointRef });

        const patch = yield* checkpointStore.diffCheckpoints({ ...refs, maxOutputBytes: 100 });
        expect(Buffer.byteLength(patch)).toBe(100);
        expect(patch).not.toContain(CHECKPOINT_PATCH_TRUNCATED_MARKER);
        const cut = yield* checkpointStore.diffCheckpointPatch({ ...refs, maxOutputBytes: 100 });
        expect(cut).toEqual({ patch, truncated: true });
      }),
    );

    it.effect("reports truncation from git's raw byte count, not the decoded text", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const fileSystem = yield* FileSystem.FileSystem;
        const checkpointStore = yield* CheckpointStore;
        const threadId = ThreadId.makeUnsafe("thread-checkpoint-latin1-limit");
        const refs = {
          cwd: tmp,
          fromCheckpointRef: checkpointRefForThreadTurn(threadId, 0),
          toCheckpointRef: checkpointRefForThreadTurn(threadId, 1),
        };
        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: refs.fromCheckpointRef,
        });
        // Latin-1 "é" bytes are invalid UTF-8; each decodes to a 3-byte U+FFFD.
        yield* fileSystem.writeFile(
          path.join(tmp, "latin1.txt"),
          new Uint8Array([...Array.from({ length: 1_000 }, () => 0xe9), 0x0a]),
        );
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: refs.toCheckpointRef });

        const result = yield* checkpointStore.diffCheckpointPatch({
          ...refs,
          maxOutputBytes: 2_000,
        });
        expect(result.truncated).toBe(false);
        expect(Buffer.byteLength(result.patch)).toBeGreaterThan(2_000);
        expect(result.patch).toContain("+++ b/latin1.txt");
      }),
    );
  });

  describe("listAuthoredPaths", () => {
    const refsFor = (cwd: string, name: string, from: number) => {
      const threadId = ThreadId.makeUnsafe(name);
      return {
        cwd,
        fromCheckpointRef: checkpointRefForThreadTurn(threadId, from),
        toCheckpointRef: checkpointRefForThreadTurn(threadId, from + 1),
      };
    };

    it.effect("leaves out paths that only a merged upstream changed", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore;
        const refs = refsFor(tmp, "thread-authored-merge", 0);
        const commitBeforeTurn = (file: string, contents: string) =>
          Effect.gen(function* () {
            yield* writeTextFile(path.join(tmp, file), contents);
            yield* git(tmp, ["add", "."]);
            yield* git(tmp, ["commit", "-m", file], { committedAt: "2020-01-01T00:00:00Z" });
          });

        yield* git(tmp, ["checkout", "-b", "upstream"]);
        yield* commitBeforeTurn("upstream.txt", "upstream\n");
        yield* commitBeforeTurn("shared.txt", "upstream\n");
        yield* git(tmp, ["checkout", "-"]);
        yield* commitBeforeTurn("shared.txt", "ours\n");
        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: refs.fromCheckpointRef,
        });

        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: refs.toCheckpointRef });
        expect(yield* checkpointStore.listAuthoredPaths(refs)).toBeNull();

        // The turn merges upstream, fixes the conflict by taking upstream, and edits one more file.
        yield* git(tmp, ["merge", "upstream", "--no-edit"], { allowNonZeroExit: true });
        yield* writeTextFile(path.join(tmp, "shared.txt"), "upstream\n");
        yield* git(tmp, ["commit", "-am", "merge upstream"]);
        yield* writeTextFile(path.join(tmp, "README.md"), "# edited\n");
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: refs.toCheckpointRef });

        const numstat = yield* checkpointStore.diffCheckpoints({ ...refs, format: "numstat" });
        expect(parseTurnDiffFilesFromNumstat(numstat).map((file) => file.path)).toEqual([
          "README.md",
          "shared.txt",
          "upstream.txt",
        ]);
        expect(yield* checkpointStore.listAuthoredPaths(refs)).toEqual(
          new Set(["README.md", "shared.txt"]),
        );
      }),
    );

    it.effect("leaves out paths that only a rebase onto upstream brought in", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore;
        const refs = refsFor(tmp, "thread-authored-rebase", 0);
        const commitBeforeTurn = (file: string) =>
          Effect.gen(function* () {
            yield* writeTextFile(path.join(tmp, file), `${file}\n`);
            yield* git(tmp, ["add", "."]);
            yield* git(tmp, ["commit", "-m", file], { committedAt: "2020-01-01T00:00:00Z" });
          });

        yield* git(tmp, ["checkout", "-b", "upstream"]);
        yield* commitBeforeTurn("upstream.txt");
        yield* git(tmp, ["checkout", "-"]);
        yield* commitBeforeTurn("feature.txt");
        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: refs.fromCheckpointRef,
        });
        yield* git(tmp, ["rebase", "upstream"]);
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: refs.toCheckpointRef });

        expect(yield* checkpointStore.listAuthoredPaths(refs)).toEqual(new Set(["feature.txt"]));
      }),
    );

    it.effect("counts discarded commits unless the turn switched to another branch", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore;
        const switchRefs = refsFor(tmp, "thread-authored-switch", 0);
        const discardRefs = refsFor(tmp, "thread-authored-switch", 2);
        const renameRefs = refsFor(tmp, "thread-authored-switch", 4);
        const capture = (checkpointRef: CheckpointRef) =>
          checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef });
        const commitBeforeTurn = (contents: string) =>
          Effect.gen(function* () {
            yield* writeTextFile(path.join(tmp, "x.txt"), contents);
            yield* git(tmp, ["add", "."]);
            yield* git(tmp, ["commit", "-m", contents], { committedAt: "2020-01-01T00:00:00Z" });
          });

        yield* commitBeforeTurn("base\n");
        yield* git(tmp, ["branch", "b"]);
        yield* git(tmp, ["checkout", "-b", "a"]);
        yield* commitBeforeTurn("a\n");

        yield* capture(switchRefs.fromCheckpointRef);
        yield* git(tmp, ["checkout", "b"]);
        yield* capture(switchRefs.toCheckpointRef);
        expect(yield* checkpointStore.listAuthoredPaths(switchRefs)).toEqual(new Set());

        // A reset still counts even while another branch keeps the discarded commit.
        yield* git(tmp, ["checkout", "a"]);
        yield* capture(discardRefs.fromCheckpointRef);
        yield* git(tmp, ["branch", "backup"]);
        yield* git(tmp, ["reset", "--hard", "HEAD~1"]);
        yield* capture(discardRefs.toCheckpointRef);
        expect(yield* checkpointStore.listAuthoredPaths(discardRefs)).toEqual(new Set(["x.txt"]));

        // A renamed branch no longer holds the commits, so this is a reset, not a switch.
        yield* git(tmp, ["reset", "--hard", "backup"]);
        yield* capture(renameRefs.fromCheckpointRef);
        yield* git(tmp, ["branch", "-m", "renamed"]);
        yield* git(tmp, ["reset", "--hard", "HEAD~1"]);
        yield* capture(renameRefs.toCheckpointRef);
        expect(yield* checkpointStore.listAuthoredPaths(renameRefs)).toEqual(new Set(["x.txt"]));
      }),
    );

    it.effect("returns null for a checkpoint captured before parents were recorded", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore;
        const refs = refsFor(tmp, "thread-authored-legacy", 0);
        const tree = yield* git(tmp, ["rev-parse", "HEAD^{tree}"]);
        const legacy = yield* git(tmp, ["commit-tree", tree, "-m", "legacy checkpoint"]);
        yield* git(tmp, ["update-ref", refs.fromCheckpointRef, legacy]);
        yield* writeTextFile(path.join(tmp, "new.txt"), "new\n");
        yield* git(tmp, ["add", "new.txt"]);
        yield* git(tmp, ["commit", "-m", "new"]);
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: refs.toCheckpointRef });

        expect(yield* checkpointStore.listAuthoredPaths(refs)).toBeNull();
      }),
    );

    it.effect.skipIf(process.platform === "win32")(
      "keeps paths from signed commits under log.showSignature",
      () =>
        Effect.gen(function* () {
          const tmp = yield* makeTmpDir();
          yield* initRepoWithCommit(tmp);
          const signingKey = path.join(yield* makeTmpDir("checkpoint-signing-key-"), "key");
          execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", signingKey]);
          yield* git(tmp, ["config", "gpg.format", "ssh"]);
          yield* git(tmp, ["config", "user.signingkey", `${signingKey}.pub`]);
          yield* git(tmp, ["config", "log.showSignature", "true"]);
          const checkpointStore = yield* CheckpointStore;
          const refs = refsFor(tmp, "thread-authored-signed", 0);
          yield* checkpointStore.captureCheckpoint({
            cwd: tmp,
            checkpointRef: refs.fromCheckpointRef,
          });
          yield* writeTextFile(path.join(tmp, "kept.txt"), "kept\n");
          yield* git(tmp, ["add", "kept.txt"]);
          yield* git(tmp, ["commit", "-S", "-m", "kept"]);
          yield* checkpointStore.captureCheckpoint({
            cwd: tmp,
            checkpointRef: refs.toCheckpointRef,
          });

          expect(yield* checkpointStore.listAuthoredPaths(refs)).toEqual(new Set(["kept.txt"]));
        }),
    );
  });

  describe("captureCheckpoint index reuse", () => {
    const stageThenEdit = (tmp: string) =>
      Effect.gen(function* () {
        yield* writeTextFile(path.join(tmp, "README.md"), "staged\n");
        yield* git(tmp, ["add", "."]);
        yield* writeTextFile(path.join(tmp, "README.md"), "unstaged\n");
      });

    it.effect.skipIf(process.platform === "win32")(
      "does not rerun clean filters for unchanged indexed files",
      () =>
        Effect.gen(function* () {
          const tmp = yield* makeTmpDir();
          yield* initRepoWithCommit(tmp);
          const fileSystem = yield* FileSystem.FileSystem;
          const helperDir = yield* makeTmpDir("checkpoint-clean-filter-");
          const runsPath = path.join(helperDir, "runs");
          const filterPath = path.join(helperDir, "filter.sh");
          yield* writeTextFile(filterPath, `#!/bin/sh\necho read >> "${runsPath}"\ncat\n`);
          yield* fileSystem.chmod(filterPath, 0o755);
          yield* git(tmp, ["config", "filter.probe.clean", filterPath]);
          yield* writeTextFile(path.join(tmp, ".gitattributes"), "stable.txt filter=probe\n");
          yield* writeTextFile(path.join(tmp, "stable.txt"), "unchanged\n");
          yield* fileSystem.utimes(path.join(tmp, "stable.txt"), 1_700_000_000, 1_700_000_000);
          yield* git(tmp, ["add", "."]);
          yield* git(tmp, ["commit", "-m", "record stable file"]);
          yield* writeTextFile(runsPath, "");
          yield* stageThenEdit(tmp);
          const indexPath = path.join(tmp, ".git", "index");
          const originalIndex = yield* fileSystem.readFile(indexPath);
          const checkpointRef = checkpointRefForThreadTurn(
            ThreadId.makeUnsafe("thread-checkpoint-clean-filter"),
            0,
          );

          yield* (yield* CheckpointStore).captureCheckpoint({ cwd: tmp, checkpointRef });

          expect(yield* fileSystem.readFileString(runsPath)).toBe("");
          expect(yield* git(tmp, ["show", `${checkpointRef}:README.md`])).toBe("unstaged");
          expect(yield* git(tmp, ["show", `${checkpointRef}:stable.txt`])).toBe("unchanged");
          expect(yield* fileSystem.readFile(indexPath)).toEqual(originalIndex);
        }),
    );

    it.effect.each([1_700_000_000, 1_700_000_000.9999])(
      "keeps same-size edits with racy index timestamps (%s)",
      (timestamp) =>
        Effect.gen(function* () {
          const tmp = yield* makeTmpDir();
          yield* initRepoWithCommit(tmp);
          const fileSystem = yield* FileSystem.FileSystem;
          const filePath = path.join(tmp, "file.txt");
          const indexPath = path.join(tmp, ".git", "index");
          yield* git(tmp, ["config", "core.trustctime", "false"]);
          yield* writeTextFile(filePath, "before\n");
          yield* fileSystem.utimes(filePath, timestamp, timestamp);
          yield* git(tmp, ["add", "file.txt"]);
          yield* git(tmp, ["commit", "-m", "record racy file"]);
          yield* fileSystem.utimes(indexPath, timestamp, timestamp);
          const originalIndex = yield* fileSystem.readFile(indexPath);
          yield* writeTextFile(filePath, "after!\n");
          yield* fileSystem.utimes(filePath, timestamp, timestamp);
          const checkpointRef = checkpointRefForThreadTurn(
            ThreadId.makeUnsafe("thread-checkpoint-racy"),
            0,
          );

          yield* (yield* CheckpointStore).captureCheckpoint({ cwd: tmp, checkpointRef });

          expect(yield* git(tmp, ["show", `${checkpointRef}:file.txt`])).toBe("after!");
          expect(yield* fileSystem.readFile(indexPath)).toEqual(originalIndex);
        }),
    );

    it.effect.each(["assume-unchanged", "skip-worktree"])(
      "still captures edits hidden by %s entries",
      (flag) =>
        Effect.gen(function* () {
          const tmp = yield* makeTmpDir();
          yield* initRepoWithCommit(tmp);
          yield* git(tmp, ["update-index", `--${flag}`, "README.md"]);
          yield* writeTextFile(path.join(tmp, "README.md"), "hidden edit\n");
          const checkpointRef = checkpointRefForThreadTurn(
            ThreadId.makeUnsafe(`thread-checkpoint-${flag}`),
            0,
          );

          yield* (yield* CheckpointStore).captureCheckpoint({ cwd: tmp, checkpointRef });

          expect(yield* git(tmp, ["show", `${checkpointRef}:README.md`])).toBe("hidden edit");
        }),
    );

    it.effect.each(["missing", "invalid"])("falls back when the real index is %s", (state) =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const fileSystem = yield* FileSystem.FileSystem;
        yield* stageThenEdit(tmp);
        const indexPath = path.join(tmp, ".git", "index");
        if (state === "missing") {
          yield* fileSystem.remove(indexPath);
        } else {
          yield* writeTextFile(indexPath, "invalid index");
        }
        const checkpointRef = checkpointRefForThreadTurn(
          ThreadId.makeUnsafe(`thread-checkpoint-index-${state}`),
          0,
        );

        yield* (yield* CheckpointStore).captureCheckpoint({ cwd: tmp, checkpointRef });

        expect(yield* git(tmp, ["show", `${checkpointRef}:README.md`])).toBe("unstaged");
        if (state === "missing") {
          expect(yield* fileSystem.exists(indexPath)).toBe(false);
        } else {
          expect(yield* fileSystem.readFileString(indexPath)).toBe("invalid index");
        }
      }),
    );

    it.effect("captures deletions and additions across two turns from a reused index", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const fileSystem = yield* FileSystem.FileSystem;
        yield* writeTextFile(path.join(tmp, "deleted.txt"), "original\n");
        yield* git(tmp, ["add", "."]);
        yield* git(tmp, ["commit", "-m", "add deleted.txt"]);
        yield* writeTextFile(path.join(tmp, "staged-new.txt"), "staged then deleted\n");
        yield* git(tmp, ["add", "."]);
        yield* fileSystem.remove(path.join(tmp, "deleted.txt"));
        yield* fileSystem.remove(path.join(tmp, "staged-new.txt"));
        yield* writeTextFile(path.join(tmp, "new.txt"), "first\n");
        const checkpointStore = yield* CheckpointStore;
        const threadId = ThreadId.makeUnsafe("thread-checkpoint-two-turns");
        const first = checkpointRefForThreadTurn(threadId, 1);
        const second = checkpointRefForThreadTurn(threadId, 2);

        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: first });
        expect(yield* git(tmp, ["ls-tree", "-r", "--name-only", first])).toBe("README.md\nnew.txt");

        yield* writeTextFile(path.join(tmp, "README.md"), "# second\n");
        yield* fileSystem.remove(path.join(tmp, "new.txt"));
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: second });
        expect(yield* git(tmp, ["diff", "--name-only", first, second])).toBe("README.md\nnew.txt");
      }),
    );
  });
});

describe("captureCheckpoint transient failures", () => {
  // Live clock: the retry waits on real time between attempts.
  it.live("retries publishing the ref while another git process holds its lock", () =>
    Effect.gen(function* () {
      const tmp = yield* makeTmpDir();
      yield* initRepoWithCommit(tmp);
      const fileSystem = yield* FileSystem.FileSystem;
      const checkpointRef = checkpointRefForThreadTurn(
        ThreadId.makeUnsafe("thread-checkpoint-ref-lock"),
        1,
      );
      const lockPath = path.join(tmp, ".git", `${checkpointRef}.lock`);
      const core = yield* GitCore;
      let updateRefCalls = 0;
      const execute: GitCoreShape["execute"] = (input) =>
        Effect.gen(function* () {
          if (!input.args.includes("update-ref")) return yield* core.execute(input);
          updateRefCalls++;
          if (updateRefCalls > 1) return yield* core.execute(input);
          yield* fileSystem
            .makeDirectory(path.dirname(lockPath), { recursive: true })
            .pipe(Effect.orDie);
          yield* fileSystem.writeFileString(lockPath, "").pipe(Effect.orDie);
          const result = yield* core.execute(input);
          yield* fileSystem.remove(lockPath).pipe(Effect.orDie);
          return result;
        });
      // Fresh, so the shared layer memo does not hand back the unwrapped store.
      const layer = Layer.fresh(CheckpointStoreLive).pipe(
        Layer.provide(Layer.succeed(GitCore, { ...core, execute })),
        Layer.provide(NodeServices.layer),
      );
      yield* writeTextFile(path.join(tmp, "new.txt"), "new\n");

      yield* Effect.gen(function* () {
        const store = yield* CheckpointStore;
        yield* store.captureCheckpoint({ cwd: tmp, checkpointRef });
      }).pipe(Effect.provide(layer));

      expect(updateRefCalls).toBe(2);
      expect(yield* git(tmp, ["show", `${checkpointRef}:new.txt`])).toBe("new");
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});
