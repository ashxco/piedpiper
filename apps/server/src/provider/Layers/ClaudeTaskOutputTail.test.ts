import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, FileSystem, Path, Queue } from "effect";

import {
  CLAUDE_TASK_OUTPUT_MAX_READ_BYTES,
  claudeTaskOutputRoot,
  tailClaudeTaskOutput,
} from "./ClaudeTaskOutputTail.ts";

const SESSION_ID = "0c91bb28-9e89-4889-bd22-3de9880233d3";
const TASK_ID = "bk6xreeye";

const makeTaskFile = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "claude-task-output-" });
  const tasks = path.join(root, "-private-tmp-project", SESSION_ID, "tasks");
  return { root, tasks, file: path.join(tasks, `${TASK_ID}.output`) };
});

// Polling waits on real filesystem I/O, so these use the live clock.
describe("tailClaudeTaskOutput", () => {
  it.live("follows a file that appears late, across split characters", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const { root, tasks, file } = yield* makeTaskFile;
        const chunks = yield* Queue.unbounded<string>();
        yield* tailClaudeTaskOutput({
          root,
          sessionId: SESSION_ID,
          taskId: TASK_ID,
          stop: yield* Deferred.make<void>(),
          onChunk: (chunk) => Queue.offer(chunks, chunk).pipe(Effect.asVoid),
        }).pipe(Effect.forkScoped);

        yield* fileSystem.makeDirectory(tasks, { recursive: true });
        // Splits the two-byte é across writes.
        const encoded = new TextEncoder().encode("café 1\n");
        yield* fileSystem.writeFile(file, encoded.subarray(0, 4));
        assert.equal(yield* Queue.take(chunks), "caf");

        yield* fileSystem.writeFile(file, encoded);
        assert.equal(yield* Queue.take(chunks), "é 1\n");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("drops a split character when the file is truncated and rewritten", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const { root, tasks, file } = yield* makeTaskFile;
        yield* fileSystem.makeDirectory(tasks, { recursive: true });
        yield* fileSystem.writeFile(file, new TextEncoder().encode("café").subarray(0, 4));
        const chunks = yield* Queue.unbounded<string>();
        const stop = yield* Deferred.make<void>();
        yield* tailClaudeTaskOutput({
          root,
          sessionId: SESSION_ID,
          taskId: TASK_ID,
          stop,
          onChunk: (chunk) => Queue.offer(chunks, chunk).pipe(Effect.asVoid),
        }).pipe(Effect.forkScoped);
        assert.equal(yield* Queue.take(chunks), "caf");

        yield* fileSystem.writeFileString(file, "ok\n");
        yield* Deferred.succeed(stop, undefined);
        assert.equal(yield* Queue.take(chunks), "ok\n");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("skips ahead of a fast writer without a replacement character", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const { root, tasks, file } = yield* makeTaskFile;
        yield* fileSystem.makeDirectory(tasks, { recursive: true });
        yield* fileSystem.writeFileString(file, "start\n");
        const chunks = yield* Queue.unbounded<string>();
        yield* tailClaudeTaskOutput({
          root,
          sessionId: SESSION_ID,
          taskId: TASK_ID,
          stop: yield* Deferred.make<void>(),
          onChunk: (chunk) => Queue.offer(chunks, chunk).pipe(Effect.asVoid),
        }).pipe(Effect.forkScoped);
        assert.equal(yield* Queue.take(chunks), "start\n");

        // Three-byte characters, so the skip offset can land inside one.
        yield* fileSystem.writeFileString(file, `start\n${"€".repeat(300_000)}end\n`);
        const flooded = yield* Queue.take(chunks);
        assert.isAtMost(
          new TextEncoder().encode(flooded).length,
          CLAUDE_TASK_OUTPUT_MAX_READ_BYTES + 1,
        );
        assert.isTrue(flooded.startsWith("\n€"));
        assert.isFalse(flooded.includes("�"));
        assert.isTrue(flooded.endsWith("€end\n"));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("reads what was written last when the tool result stops it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const { root, tasks, file } = yield* makeTaskFile;
        yield* fileSystem.makeDirectory(tasks, { recursive: true });
        yield* fileSystem.writeFileString(file, "one\n");
        const chunks: Array<string> = [];
        const stop = yield* Deferred.make<void>();
        const first = yield* Deferred.make<void>();
        const fiber = yield* tailClaudeTaskOutput({
          root,
          sessionId: SESSION_ID,
          taskId: TASK_ID,
          stop,
          onChunk: (chunk) =>
            Effect.sync(() => chunks.push(chunk)).pipe(
              Effect.andThen(Deferred.succeed(first, undefined)),
              Effect.asVoid,
            ),
        }).pipe(Effect.forkScoped);
        yield* Deferred.await(first);
        yield* fileSystem.writeFileString(file, "one\ntwo\n");
        yield* Deferred.succeed(stop, undefined);
        yield* Fiber.join(fiber);
        assert.deepEqual(chunks, ["one\n", "two\n"]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("ends without output when stopped before the file exists", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { root } = yield* makeTaskFile;
        const chunks: Array<string> = [];
        const stop = yield* Deferred.make<void>();
        const fiber = yield* tailClaudeTaskOutput({
          root,
          sessionId: SESSION_ID,
          taskId: TASK_ID,
          stop,
          onChunk: (chunk) => Effect.sync(() => void chunks.push(chunk)),
        }).pipe(Effect.forkScoped);
        yield* Deferred.succeed(stop, undefined);
        yield* Fiber.join(fiber);
        assert.deepEqual(chunks, []);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("claudeTaskOutputRoot", () => {
  const root = (
    environment: Record<string, string>,
    platform: NodeJS.Platform,
    cwd?: string,
  ): string | undefined => claudeTaskOutputRoot({ environment, cwd, platform, uid: 501 });

  it("uses the temp dir Claude Code resolves on each platform", () => {
    assert.equal(root({ TMPDIR: "/var/folders/x/T/" }, "linux"), "/var/folders/x/T/claude-501");
    assert.equal(root({ TMP: "/tmp/user/1000" }, "linux"), "/tmp/user/1000/claude-501");
    assert.equal(root({}, "linux"), "/tmp/claude-501");
    assert.equal(root({ TMPDIR: "/var/folders/x/T/" }, "darwin"), "/tmp/claude-501");
  });

  it("honours CLAUDE_CODE_TMPDIR on every platform", () => {
    const environment = { CLAUDE_CODE_TMPDIR: "/srv/claude", TMPDIR: "/var/folders/x/T/" };
    assert.equal(root(environment, "linux"), "/srv/claude/claude-501");
    assert.equal(root(environment, "darwin"), "/srv/claude/claude-501");
  });

  it("resolves relative values against the CLI's working directory", () => {
    assert.equal(root({ TMPDIR: "tmp" }, "linux", "/work/project"), "/work/project/tmp/claude-501");
    assert.equal(
      root({ CLAUDE_CODE_TMPDIR: "../claude" }, "darwin", "/work/project"),
      "/work/claude/claude-501",
    );
  });

  it("has no root on Windows or without a uid", () => {
    assert.equal(root({}, "win32"), undefined);
    assert.equal(
      claudeTaskOutputRoot({ environment: {}, cwd: undefined, platform: "linux", uid: undefined }),
      undefined,
    );
  });
});
