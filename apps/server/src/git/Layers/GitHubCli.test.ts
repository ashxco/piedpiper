import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { afterEach, expect, vi } from "vitest";

vi.mock("../../processRunner", () => ({
  runProcess: vi.fn(),
}));

import { runProcess } from "../../processRunner";
import { GitHubCli } from "../Services/GitHubCli.ts";
import { GitHubCliLive } from "./GitHubCli.ts";

const mockedRunProcess = vi.mocked(runProcess);
const layer = it.layer(GitHubCliLive);

afterEach(() => {
  mockedRunProcess.mockReset();
});

layer("GitHubCliLive", (it) => {
  it.effect("keeps the git started by gh from opening an implicit bare repository", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockResolvedValueOnce({
        stdout: "",
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      });

      const gh = yield* GitHubCli;
      yield* gh.execute({ cwd: "/repo", args: ["auth", "status"] });

      const env = mockedRunProcess.mock.calls[0]?.[2]?.env ?? {};
      const count = Number(env.GIT_CONFIG_COUNT);
      expect(env[`GIT_CONFIG_KEY_${count - 1}`]).toBe("safe.bareRepository");
      expect(env[`GIT_CONFIG_VALUE_${count - 1}`]).toBe("explicit");
      expect(env.PATH).toBe(process.env.PATH);
    }),
  );

  it.effect("parses pull request view output", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 42,
          title: "Add PR thread creation",
          url: "https://github.com/user/repo/pull/42",
          baseRefName: "main",
          headRefName: "feature/pr-threads",
          headRefOid: "abc123",
          state: "OPEN",
          mergedAt: null,
          isDraft: true,
          isCrossRepository: true,
          headRepository: {
            nameWithOwner: "octocat/piedpiper-app",
          },
          headRepositoryOwner: {
            login: "octocat",
          },
        }),
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      });

      const result = yield* Effect.gen(function* () {
        const gh = yield* GitHubCli;
        return yield* gh.getPullRequest({
          cwd: "/repo",
          reference: "#42",
        });
      });

      assert.deepStrictEqual(result, {
        number: 42,
        title: "Add PR thread creation",
        url: "https://github.com/user/repo/pull/42",
        baseRefName: "main",
        headRefName: "feature/pr-threads",
        headRefOid: "abc123",
        state: "open",
        isDraft: true,
        isCrossRepository: true,
        headRepositoryNameWithOwner: "octocat/piedpiper-app",
        headRepositoryOwnerLogin: "octocat",
      });
      expect(mockedRunProcess).toHaveBeenCalledWith(
        "gh",
        [
          "pr",
          "view",
          "#42",
          "--json",
          "number,title,url,baseRefName,headRefName,headRefOid,state,mergedAt,isDraft,isCrossRepository,headRepository,headRepositoryOwner",
        ],
        expect.objectContaining({ cwd: "/repo" }),
      );
    }),
  );

  it.effect("reads repository clone URLs", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockResolvedValueOnce({
        stdout: JSON.stringify({
          nameWithOwner: "octocat/piedpiper-app",
          url: "https://github.com/octocat/piedpiper-app",
          sshUrl: "git@github.com:octocat/piedpiper-app.git",
        }),
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      });

      const result = yield* Effect.gen(function* () {
        const gh = yield* GitHubCli;
        return yield* gh.getRepositoryCloneUrls({
          cwd: "/repo",
          repository: "octocat/piedpiper-app",
        });
      });

      assert.deepStrictEqual(result, {
        nameWithOwner: "octocat/piedpiper-app",
        url: "https://github.com/octocat/piedpiper-app",
        sshUrl: "git@github.com:octocat/piedpiper-app.git",
      });
    }),
  );

  it.effect("qualifies the repository with the host when one is given", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockResolvedValueOnce({
        stdout: JSON.stringify({
          nameWithOwner: "octocat/piedpiper-app",
          url: "https://github.acme.corp/octocat/piedpiper-app",
          sshUrl: "git@github.acme.corp:octocat/piedpiper-app.git",
        }),
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      });

      yield* Effect.gen(function* () {
        const gh = yield* GitHubCli;
        return yield* gh.getRepositoryCloneUrls({
          cwd: "/repo",
          repository: "octocat/piedpiper-app",
          host: "github.acme.corp",
        });
      });

      expect(mockedRunProcess.mock.calls[0]?.[1]).toEqual([
        "repo",
        "view",
        "github.acme.corp/octocat/piedpiper-app",
        "--json",
        "nameWithOwner,url,sshUrl",
      ]);
    }),
  );

  it.effect("surfaces a friendly error when the pull request is not found", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockRejectedValueOnce(
        new Error(
          "GraphQL: Could not resolve to a PullRequest with the number of 4888. (repository.pullRequest)",
        ),
      );

      const error = yield* Effect.gen(function* () {
        const gh = yield* GitHubCli;
        return yield* gh.getPullRequest({
          cwd: "/repo",
          reference: "4888",
        });
      }).pipe(Effect.flip);

      assert.equal(error.message.includes("Pull request not found"), true);
    }),
  );
});
