import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { GitCommandError } from "@piedpiper/contracts";
import { Deferred, Effect, Exit, Fiber, Layer } from "effect";
import { afterAll } from "vitest";

import { ServerConfig } from "../config.ts";
import { GitCoreLive } from "./Layers/GitCore.ts";
import { GitCore, type ExecuteGitInput, type GitCoreShape } from "./Services/GitCore.ts";
import {
  cloneGitRepository,
  type GitCloneEvent,
  GIT_CLONE_TIMEOUT_MS,
  normalizeGitCloneUrl,
  parseGitCloneProgressLine,
  redactGitUrlCredentials,
} from "./gitClone.ts";

const roots: Array<string> = [];
const makeRoot = () => {
  const root = mkdtempSync(path.join(tmpdir(), "piedpiper-git-clone-"));
  roots.push(root);
  return root;
};
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const git = (cwd: string, ...args: Array<string>) =>
  execFileSync("git", args, { cwd, stdio: "pipe" }).toString();

const makeBareRepo = (root: string) => {
  const bare = path.join(root, "source.git");
  const work = path.join(root, "source-work");
  git(root, "init", "--bare", bare);
  git(root, "init", work);
  writeFileSync(path.join(work, "README.md"), "hello\n");
  git(work, "add", ".");
  git(work, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-m", "first");
  git(work, "push", bare, "HEAD:refs/heads/main");
  git(bare, "symbolic-ref", "HEAD", "refs/heads/main");
  return bare;
};

const ok = { code: 0, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false };
const fakeGit = (execute: GitCoreShape["execute"]): Pick<GitCoreShape, "execute"> => ({ execute });
const collect = () => {
  const events: Array<GitCloneEvent> = [];
  return { events, onEvent: (event: GitCloneEvent) => Effect.sync(() => void events.push(event)) };
};

const TestLayer = Layer.mergeAll(
  NodeServices.layer,
  GitCoreLive.pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "piedpiper-git-clone-" })),
    Layer.provide(NodeServices.layer),
  ),
);

describe("parseGitCloneProgressLine", () => {
  it("reads stages, percents and transfer detail", () => {
    assert.deepEqual(
      parseGitCloneProgressLine("Receiving objects:  42% (42/100), 12.30 MiB | 5.00 MiB/s"),
      { stage: "receiving", percent: 42, detail: "12.30 MiB | 5.00 MiB/s" },
    );
    assert.deepEqual(parseGitCloneProgressLine("Resolving deltas: 100% (5/5), done."), {
      stage: "resolving",
      percent: 100,
      detail: null,
    });
    assert.deepEqual(parseGitCloneProgressLine("remote: Enumerating objects: 3, done."), {
      stage: "counting",
      percent: null,
      detail: null,
    });
    assert.deepEqual(parseGitCloneProgressLine("Updating files:  78% (2104/2700)"), {
      stage: "checkout",
      percent: 78,
      detail: null,
    });
  });

  it("ignores anything else", () => {
    assert.isNull(parseGitCloneProgressLine("Cloning into 'repo'..."));
    assert.isNull(parseGitCloneProgressLine("fatal: repository not found"));
    assert.isNull(parseGitCloneProgressLine(""));
  });
});

describe("redactGitUrlCredentials", () => {
  it("removes userinfo, including one holding an @", () => {
    assert.equal(
      redactGitUrlCredentials("fatal: could not read https://me:s3cret@x.dev/a/b.git"),
      "fatal: could not read https://x.dev/a/b.git",
    );
    assert.equal(redactGitUrlCredentials("https://a@b:c@x.dev/r"), "https://x.dev/r");
  });

  it("removes query tokens, quoted or not", () => {
    assert.equal(redactGitUrlCredentials("https://x.dev/r?token=abc next"), "https://x.dev/r next");
    assert.equal(
      redactGitUrlCredentials(`fatal: unable to access 'https://x.dev/r?t=a'b@c': 403`),
      "fatal: unable to access 'https://x.dev/r': 403",
    );
  });

  it("leaves scp-style remotes and plain text alone", () => {
    assert.equal(redactGitUrlCredentials("git@x.dev:a/b.git"), "git@x.dev:a/b.git");
    assert.equal(redactGitUrlCredentials("Permission denied"), "Permission denied");
  });
});

describe("normalizeGitCloneUrl", () => {
  it("adds a path before a query on a pathless URL only", () => {
    assert.equal(normalizeGitCloneUrl("https://x.dev?t=a@b"), "https://x.dev/?t=a@b");
    assert.equal(normalizeGitCloneUrl("https://x.dev/r?t=a"), "https://x.dev/r?t=a");
    assert.equal(normalizeGitCloneUrl("/local/repo.git"), "/local/repo.git");
  });
});

it.layer(TestLayer)("cloneGitRepository", (it) => {
  it.effect("clones a local bare repository and finishes with the absolute path", () =>
    Effect.gen(function* () {
      const root = makeRoot();
      const bare = makeBareRepo(root);
      const destinationPath = path.join(root, "cloned");
      const { events, onEvent } = collect();
      yield* cloneGitRepository({ url: bare, destinationPath }, { git: yield* GitCore, onEvent });
      assert.isTrue(existsSync(path.join(destinationPath, "README.md")));
      assert.deepEqual(events[0], {
        kind: "progress",
        stage: "connecting",
        percent: null,
        detail: null,
      });
      assert.deepEqual(events.at(-1), { kind: "finished", destinationPath });
    }),
  );

  it.effect("clones into an existing empty folder", () =>
    Effect.gen(function* () {
      const root = makeRoot();
      const bare = makeBareRepo(root);
      const destinationPath = path.join(root, "empty");
      mkdirSync(destinationPath);
      yield* cloneGitRepository(
        { url: bare, destinationPath },
        { git: yield* GitCore, onEvent: () => Effect.void },
      );
      assert.isTrue(existsSync(path.join(destinationPath, "README.md")));
    }),
  );

  it.effect("treats a dash-prefixed URL as a repository, never as an option", () =>
    Effect.gen(function* () {
      const root = makeRoot();
      const sentinel = path.join(root, "pwned");
      const destinationPath = path.join(root, "cloned");
      const exit = yield* Effect.exit(
        cloneGitRepository(
          { url: `--upload-pack=touch ${sentinel}`, destinationPath },
          { git: yield* GitCore, onEvent: () => Effect.void },
        ),
      );
      assert.isTrue(Exit.isFailure(exit));
      assert.isFalse(existsSync(sentinel));
      assert.isFalse(existsSync(destinationPath));
    }),
  );

  it.effect("passes the URL and folder name after --, with prompts off and a long bound", () =>
    Effect.gen(function* () {
      const root = makeRoot();
      let seen: ExecuteGitInput | undefined;
      yield* cloneGitRepository(
        { url: " https://x.dev/a/b.git ", destinationPath: path.join(root, "b") },
        {
          git: fakeGit((input) =>
            Effect.sync(() => {
              seen = input;
              return ok;
            }),
          ),
          onEvent: () => Effect.void,
        },
      );
      assert.deepEqual(seen?.args, ["clone", "--progress", "--", "https://x.dev/a/b.git", "b"]);
      assert.equal(seen?.cwd, root);
      assert.equal(seen?.env?.GIT_TERMINAL_PROMPT, "0");
      assert.equal(seen?.timeoutMs, GIT_CLONE_TIMEOUT_MS);
    }),
  );

  it.effect("refuses a non-empty destination without running git or touching it", () =>
    Effect.gen(function* () {
      const root = makeRoot();
      const destinationPath = path.join(root, "busy");
      mkdirSync(destinationPath);
      writeFileSync(path.join(destinationPath, "keep.txt"), "mine");
      let ran = false;
      const error = yield* Effect.flip(
        cloneGitRepository(
          { url: "https://x.dev/a/b", destinationPath },
          {
            git: fakeGit(() =>
              Effect.sync(() => {
                ran = true;
                return ok;
              }),
            ),
            onEvent: () => Effect.void,
          },
        ),
      );
      assert.include(error.detail, "not empty");
      assert.isFalse(ran);
      assert.deepEqual(readdirSync(destinationPath), ["keep.txt"]);
    }),
  );

  it.effect("refuses a destination that is a file, or a missing parent", () =>
    Effect.gen(function* () {
      const root = makeRoot();
      const file = path.join(root, "file");
      writeFileSync(file, "mine");
      const git = fakeGit(() => Effect.succeed(ok));
      const onEvent = () => Effect.void;
      const fileError = yield* Effect.flip(
        cloneGitRepository({ url: "u://x/y", destinationPath: file }, { git, onEvent }),
      );
      assert.include(fileError.detail, "not a folder");
      assert.isTrue(existsSync(file));
      const parentError = yield* Effect.flip(
        cloneGitRepository(
          { url: "u://x/y", destinationPath: path.join(root, "no", "repo") },
          { git, onEvent },
        ),
      );
      assert.include(parentError.detail, "does not exist");
    }),
  );

  const partialClone = (destinationPath: string) => {
    mkdirSync(path.join(destinationPath, ".git"), { recursive: true });
    writeFileSync(path.join(destinationPath, "partial.txt"), "x");
  };

  it.effect("removes a partial clone it created when git fails", () =>
    Effect.gen(function* () {
      const root = makeRoot();
      const destinationPath = path.join(root, "made");
      const error = yield* Effect.flip(
        cloneGitRepository(
          { url: "https://x.dev/a/b", destinationPath },
          {
            git: fakeGit(() =>
              Effect.sync(() => {
                partialClone(destinationPath);
                return { ...ok, code: 128, stderr: "fatal: early EOF" };
              }),
            ),
            onEvent: () => Effect.void,
          },
        ),
      );
      assert.include(error.detail, "fatal: early EOF");
      assert.isFalse(existsSync(destinationPath));
    }),
  );

  it.effect("keeps a folder that predates the clone and empties only what it wrote", () =>
    Effect.gen(function* () {
      const root = makeRoot();
      const destinationPath = path.join(root, "empty");
      mkdirSync(destinationPath);
      yield* Effect.exit(
        cloneGitRepository(
          { url: "https://x.dev/a/b", destinationPath },
          {
            git: fakeGit(() =>
              Effect.sync(() => {
                partialClone(destinationPath);
                return { ...ok, code: 128 };
              }),
            ),
            onEvent: () => Effect.void,
          },
        ),
      );
      assert.deepEqual(readdirSync(destinationPath), []);
    }),
  );

  it.effect("leaves files alone when the failed clone wrote no .git", () =>
    Effect.gen(function* () {
      const root = makeRoot();
      const destinationPath = path.join(root, "raced");
      yield* Effect.exit(
        cloneGitRepository(
          { url: "https://x.dev/a/b", destinationPath },
          {
            git: fakeGit(() =>
              Effect.sync(() => {
                mkdirSync(destinationPath);
                writeFileSync(path.join(destinationPath, "someone-elses.txt"), "x");
                return { ...ok, code: 128 };
              }),
            ),
            onEvent: () => Effect.void,
          },
        ),
      );
      assert.deepEqual(readdirSync(destinationPath), ["someone-elses.txt"]);
    }),
  );

  it.effect("removes the partial clone when cancelled", () =>
    Effect.gen(function* () {
      const root = makeRoot();
      const destinationPath = path.join(root, "cancelled");
      const started = yield* Deferred.make<void>();
      const fiber = yield* cloneGitRepository(
        { url: "https://x.dev/a/b", destinationPath },
        {
          git: fakeGit(() =>
            Effect.gen(function* () {
              partialClone(destinationPath);
              yield* Deferred.succeed(started, undefined);
              return yield* Effect.never;
            }),
          ),
          onEvent: () => Effect.void,
        },
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(started);
      // Let the fiber park on the running command, as a cancel from the client would find it.
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 20)));
      yield* Fiber.interrupt(fiber);
      assert.isFalse(existsSync(destinationPath));
    }).pipe(Effect.scoped),
  );

  it.effect("never reports credentials from git's failure or the command", () =>
    Effect.gen(function* () {
      const root = makeRoot();
      const url = "https://me:s3cret@x.dev/a/b.git?token=t0ken";
      const quiet = yield* Effect.flip(
        cloneGitRepository(
          { url, destinationPath: path.join(root, "a") },
          {
            git: fakeGit((input) =>
              Effect.gen(function* () {
                yield* input.progress!.onStderrLine!(`fatal: unable to access '${url}': 403`);
                return { ...ok, code: 128 };
              }),
            ),
            onEvent: () => Effect.void,
          },
        ),
      );
      const thrown = yield* Effect.flip(
        cloneGitRepository(
          { url, destinationPath: path.join(root, "b") },
          {
            git: fakeGit((input) =>
              Effect.fail(
                new GitCommandError({
                  operation: input.operation,
                  command: `git ${input.args.join(" ")}`,
                  cwd: input.cwd,
                  detail: `git ${input.args.join(" ")} timed out.`,
                }),
              ),
            ),
            onEvent: () => Effect.void,
          },
        ),
      );
      for (const error of [quiet, thrown]) {
        assert.notInclude(error.message, "s3cret");
        assert.notInclude(error.message, "t0ken");
        assert.notInclude(error.detail, "s3cret");
      }
      assert.include(quiet.detail, "403");
      assert.include(thrown.detail, "timed out");
    }),
  );

  it.effect("splits bare-CR redraws and sends each new stage or percent once", () =>
    Effect.gen(function* () {
      const root = makeRoot();
      const { events, onEvent } = collect();
      yield* cloneGitRepository(
        { url: "https://x.dev/a/b", destinationPath: path.join(root, "b") },
        {
          git: fakeGit((input) =>
            input.progress!.onStderrLine!(
              "Receiving objects:  1% (1/100), 1 KiB | 1 KiB/s\rReceiving objects:  1% (1/100), 2 KiB | 2 KiB/s\rReceiving objects:  2% (2/100)\r",
            ).pipe(Effect.as(ok)),
          ),
          onEvent,
        },
      );
      assert.deepEqual(
        events.flatMap((event) =>
          event.kind === "progress" ? [`${event.stage}:${event.percent}`] : [],
        ),
        ["connecting:null", "receiving:1", "receiving:2"],
      );
    }),
  );
});
