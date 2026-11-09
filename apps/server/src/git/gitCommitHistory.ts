import { type GitListCommitsInput, type GitListCommitsResult } from "@piedpiper/contracts";
import { Effect } from "effect";
import type { GitCoreShape } from "./Services/GitCore.ts";

export const readGitCommitHistory = Effect.fn("readGitCommitHistory")(function* (
  git: Pick<GitCoreShape, "execute">,
  input: GitListCommitsInput,
) {
  const cursor = input.cursor ?? 0;
  const limit = input.limit ?? 50;
  const head = yield* git.execute({
    operation: "GitCore.listCommits.head",
    cwd: input.cwd,
    args: ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
    allowNonZeroExit: true,
  });
  if (head.code !== 0) return { commits: [], nextCursor: null } satisfies GitListCommitsResult;
  const result = yield* git.execute({
    operation: "GitCore.listCommits",
    cwd: input.cwd,
    args: [
      "log",
      "--no-show-signature",
      "--no-decorate",
      "--no-color",
      "-z",
      "--format=%H%x00%s%x00%an%x00%aI",
      `--skip=${cursor}`,
      `--max-count=${limit + 1}`,
      "HEAD",
      "--",
    ],
    maxOutputBytes: 2 * 1024 * 1024,
  });
  const fields = result.stdout.split("\0");
  const commits: GitListCommitsResult["commits"][number][] = [];
  for (let index = 0; index + 3 < fields.length; index += 4) {
    const [sha, subject, author, authoredAt] = fields.slice(index, index + 4);
    if (sha && subject !== undefined && author !== undefined && authoredAt !== undefined)
      commits.push({ sha, subject, author, authoredAt });
  }
  return {
    commits: commits.slice(0, limit),
    nextCursor: commits.length > limit ? cursor + limit : null,
  } satisfies GitListCommitsResult;
});
