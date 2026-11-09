import { CommandId, type GitStatusResult } from "@piedpiper/contracts";
import { Effect, FileSystem } from "effect";
import type { GitCoreShape } from "./Services/GitCore.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";

/** Reconcile all chats sharing a checkout, including archived chats, after observing its status. */
export const syncWorktreeBranches = Effect.fn("syncWorktreeBranches")(function* (
  git: Pick<GitCoreShape, "execute">,
  engine: Pick<OrchestrationEngineShape, "getReadModel" | "dispatch">,
  status: GitStatusResult,
) {
  const root = status.workingTree.rootPath;
  if (!status.isRepo || !root) return;
  const fileSystem = yield* FileSystem.FileSystem;
  const canonicalRoot = yield* fileSystem.realPath(root);
  const readModel = yield* engine.getReadModel();
  const candidates = [];
  const canonicalPaths = new Map<string, string | null>();
  for (const thread of readModel.threads.values()) {
    if (!thread.worktreePath || thread.deletedAt !== null || thread.branch === status.branch)
      continue;
    let canonicalPath = canonicalPaths.get(thread.worktreePath);
    if (canonicalPath === undefined) {
      canonicalPath = yield* fileSystem
        .realPath(thread.worktreePath)
        .pipe(Effect.orElseSucceed(() => null));
      canonicalPaths.set(thread.worktreePath, canonicalPath);
    }
    if (canonicalPath === canonicalRoot) candidates.push(thread);
  }
  if (candidates.length === 0) return;
  // Status can have come from a cache; never write its branch without checking HEAD again.
  const head = yield* git.execute({
    operation: "GitCore.syncWorktreeBranches",
    cwd: canonicalRoot,
    args: ["symbolic-ref", "--quiet", "--short", "HEAD"],
    allowNonZeroExit: true,
  });
  if (head.code > 1) return;
  const branch = head.code === 0 ? head.stdout.trim() : null;
  if (branch !== status.branch) return;
  for (const thread of candidates) {
    yield* engine.dispatch({
      type: "thread.meta.update",
      commandId: CommandId.makeUnsafe(crypto.randomUUID()),
      threadId: thread.id,
      expectedBranch: thread.branch,
      expectedWorktreePath: thread.worktreePath,
      branch,
    });
  }
});
