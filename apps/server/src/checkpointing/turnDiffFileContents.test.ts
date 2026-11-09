import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CheckpointRef,
  type OrchestrationGetTurnDiffFileContentsInput,
  ProjectId,
  ThreadId,
  TurnId,
} from "@piedpiper/contracts";
import { Effect, Layer, Option } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ServerConfig } from "../config.ts";
import { GitCoreLive } from "../git/Layers/GitCore.ts";
import { GitCore } from "../git/Services/GitCore.ts";
import {
  isRepositoryRelativePath,
  makeTurnDiffFileContentsReader,
  TURN_DIFF_FILE_CONTENTS_MAX_BYTES,
} from "./turnDiffFileContents.ts";
import { checkpointRefForThreadTurn } from "./Utils.ts";

const threadId = ThreadId.makeUnsafe("thread-contents");
const GitLayer = GitCoreLive.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "piedpiper-turn-contents-" })),
  Layer.provide(NodeServices.layer),
);

let repo: string;

function git(...args: ReadonlyArray<string>) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

function write(filePath: string, contents: string | Uint8Array) {
  const target = path.join(repo, filePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

function checkpoint(turnCount: number) {
  git("add", "-A");
  git("commit", "--allow-empty", "--quiet", "-m", `turn ${turnCount}`);
  git("update-ref", checkpointRefForThreadTurn(threadId, turnCount), "HEAD");
}

function read(
  input: Partial<OrchestrationGetTurnDiffFileContentsInput> & { path: string },
  maxTurnCount = 1,
) {
  const checkpoints = Array.from({ length: maxTurnCount }, (_, index) => ({
    turnId: TurnId.makeUnsafe(`turn-${index + 1}`),
    checkpointTurnCount: index + 1,
    checkpointRef: CheckpointRef.makeUnsafe(checkpointRefForThreadTurn(threadId, index + 1)),
    status: "ready" as const,
    files: [],
    assistantMessageId: null,
    completedAt: "2026-01-01T00:00:00.000Z",
  }));
  return Effect.runPromise(
    Effect.gen(function* () {
      const reader = makeTurnDiffFileContentsReader({
        git: yield* GitCore,
        projectionSnapshotQuery: {
          getThreadCheckpointContext: () =>
            Effect.succeed(
              Option.some({
                threadId,
                projectId: ProjectId.makeUnsafe("project-1"),
                workspaceRoot: repo,
                worktreePath: null,
                checkpoints,
              }),
            ),
        },
      });
      return yield* reader({ threadId, fromTurnCount: 0, toTurnCount: 1, ...input }).pipe(
        Effect.result,
      );
    }).pipe(Effect.provide(GitLayer)),
  );
}

async function readOk(input: Parameters<typeof read>[0]) {
  const result = await read(input);
  if (result._tag !== "Success") throw new Error(String(result.failure));
  return result.success;
}

describe("isRepositoryRelativePath", () => {
  it("accepts repository paths and rejects anything that could leave the tree root", () => {
    expect(isRepositoryRelativePath("src/a b:c.ts")).toBe(true);
    for (const bad of ["", "/etc/passwd", "../x", "a/../x", "./x", "a//b", "a\0b"]) {
      expect(isRepositoryRelativePath(bad)).toBe(false);
    }
  });
});

describe("makeTurnDiffFileContentsReader", () => {
  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), "piedpiper-turn-contents-"));
    git("init", "--quiet");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("reads both sides of a modified file", async () => {
    write("src/a.ts", "old\n");
    checkpoint(0);
    write("src/a.ts", "new\n");
    checkpoint(1);

    await expect(readOk({ path: "src/a.ts" })).resolves.toMatchObject({
      oldContents: "old\n",
      newContents: "new\n",
      unavailableReason: null,
    });
  });

  it("returns null for the missing side of a new or deleted file", async () => {
    write("gone.ts", "gone\n");
    checkpoint(0);
    rmSync(path.join(repo, "gone.ts"));
    write("added.ts", "added\n");
    checkpoint(1);

    await expect(readOk({ path: "added.ts" })).resolves.toMatchObject({
      oldContents: null,
      newContents: "added\n",
    });
    await expect(readOk({ path: "gone.ts" })).resolves.toMatchObject({
      oldContents: "gone\n",
      newContents: null,
    });
  });

  it("reads the old side of a renamed file from its previous path", async () => {
    write("before.ts", "same\n");
    checkpoint(0);
    git("mv", "before.ts", "after.ts");
    write("after.ts", "same\nmore\n");
    checkpoint(1);

    await expect(readOk({ path: "after.ts", previousPath: "before.ts" })).resolves.toMatchObject({
      oldContents: "same\n",
      newContents: "same\nmore\n",
    });
  });

  it("reads non-ASCII paths and contents", async () => {
    const name = "docs/caf\u00e9 \u65e5\u672c\u8a9e.md";
    write(name, "avant \u00e9\n");
    checkpoint(0);
    write(name, "apr\u00e8s \u65e5\u672c\u8a9e\n");
    checkpoint(1);

    await expect(readOk({ path: name })).resolves.toMatchObject({
      oldContents: "avant \u00e9\n",
      newContents: "apr\u00e8s \u65e5\u672c\u8a9e\n",
    });
  });

  it("reads the old side of a rename between non-ASCII names", async () => {
    const oldName = "caf\u00e9.md";
    const newName = "\u0441\u0432\u043e\u0434\u043a\u0430.md";
    write(oldName, "same\n");
    checkpoint(0);
    git("mv", oldName, newName);
    checkpoint(1);

    await expect(readOk({ path: newName, previousPath: oldName })).resolves.toMatchObject({
      oldContents: "same\n",
      newContents: "same\n",
    });
  });

  it("reports a binary file without returning its contents", async () => {
    write("image.bin", "text\n");
    checkpoint(0);
    write("image.bin", new Uint8Array([1, 0, 2]));
    checkpoint(1);

    await expect(readOk({ path: "image.bin" })).resolves.toMatchObject({
      oldContents: null,
      newContents: null,
      unavailableReason: "binary",
    });
  });

  it("applies the size cap to each side, allowing a file exactly at the cap", async () => {
    write("at-cap.txt", "x");
    write("over-cap.txt", "x");
    checkpoint(0);
    write("at-cap.txt", "x".repeat(TURN_DIFF_FILE_CONTENTS_MAX_BYTES));
    write("over-cap.txt", "x".repeat(TURN_DIFF_FILE_CONTENTS_MAX_BYTES + 1));
    checkpoint(1);

    const atCap = await readOk({ path: "at-cap.txt" });
    expect(atCap.unavailableReason).toBeNull();
    expect(atCap.newContents).toHaveLength(TURN_DIFF_FILE_CONTENTS_MAX_BYTES);
    await expect(readOk({ path: "over-cap.txt" })).resolves.toMatchObject({
      oldContents: null,
      newContents: null,
      unavailableReason: "too-large",
    });
  });

  it("fails on a turn with no checkpoint rather than reporting an empty file", async () => {
    write("a.ts", "a\n");
    checkpoint(0);
    checkpoint(1);

    const beyondTurns = await read({ path: "a.ts", toTurnCount: 5 });
    expect(beyondTurns).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "CheckpointUnavailableError", turnCount: 5 },
    });

    git("update-ref", "-d", checkpointRefForThreadTurn(threadId, 1));
    const deletedRef = await read({ path: "a.ts" });
    expect(deletedRef).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "CheckpointUnavailableError", turnCount: 1 },
    });
  });

  it("rejects a path outside the repository before running git", async () => {
    const result = await read({ path: "../secret" });
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "CheckpointInvariantError" },
    });
  });
});
