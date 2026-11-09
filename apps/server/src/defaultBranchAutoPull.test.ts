import { DEFAULT_SERVER_SETTINGS } from "@piedpiper/contracts/settings";
import { GitCommandError } from "@piedpiper/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, Option } from "effect";

import {
  DefaultBranchAutoPull,
  autoPullProjectsAtStartup,
  autoPullSkipReason,
  autoPullWorkspaceRoots,
  fastForwardCleanDefaultBranch,
  makeDefaultBranchAutoPull,
} from "./defaultBranchAutoPull.ts";
import { GitCore, type GitCoreShape, type GitStatusDetails } from "./git/Services/GitCore.ts";
import { ServerConfig } from "./config.ts";
import { GitCoreLive } from "./git/Layers/GitCore.ts";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerSettingsService } from "./serverSettings.ts";

const baseStatus: GitStatusDetails = {
  isRepo: true,
  hasOriginRemote: true,
  isDefaultBranch: true,
  branch: "main",
  upstreamRef: "origin/main",
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  hasUpstream: true,
  aheadCount: 0,
  behindCount: 2,
};

const statusFor = (cwd: string): GitStatusDetails => ({
  ...baseStatus,
  isDefaultBranch: cwd !== "/feature",
  hasWorkingTreeChanges: cwd === "/dirty",
  aheadCount: cwd === "/ahead" ? 1 : 0,
  behindCount: cwd === "/current" ? 0 : 2,
});

interface GitCall {
  readonly cwd: string;
  readonly args: ReadonlyArray<string>;
  readonly env?: NodeJS.ProcessEnv;
}

const makeGit = (
  pulled: string[],
  options?: {
    failPull?: boolean;
    exitCode?: number;
    calls?: GitCall[];
    statusFor?: (cwd: string) => GitStatusDetails;
  },
) => {
  const heads = new Map<string, number>();
  return {
    statusDetails: (cwd: string) => Effect.succeed((options?.statusFor ?? statusFor)(cwd)),
    execute: (input: { cwd: string; args: ReadonlyArray<string>; env?: NodeJS.ProcessEnv }) =>
      Effect.suspend(() => {
        const { cwd, args } = input;
        if (args[0] === "rev-parse") {
          return Effect.succeed({ code: 0, stdout: `sha-${heads.get(cwd) ?? 0}\n`, stderr: "" });
        }
        options?.calls?.push({ cwd, args, ...(input.env ? { env: input.env } : {}) });
        if (options?.failPull) {
          return Effect.fail(
            new GitCommandError({
              operation: "pull",
              command: args.join(" "),
              cwd,
              detail: "network down",
            }),
          );
        }
        if (options?.exitCode !== undefined && options.exitCode !== 0) {
          return Effect.succeed({ code: options.exitCode, stdout: "", stderr: "fatal: no" });
        }
        pulled.push(cwd);
        heads.set(cwd, (heads.get(cwd) ?? 0) + 1);
        return Effect.succeed({ code: 0, stdout: "", stderr: "" });
      }),
  } as unknown as GitCoreShape;
};

const settingsWith = (autoPullDefaultBranch: boolean) =>
  ({
    getSettings: Effect.succeed({ ...DEFAULT_SERVER_SETTINGS, autoPullDefaultBranch }),
  }) as never;

const snapshotsWithProjects = (roots: ReadonlyArray<string>, counter?: { snapshots: number }) =>
  ({
    getActiveProjectByWorkspaceRoot: (cwd: string) =>
      Effect.succeed(roots.includes(cwd) ? Option.some({ workspaceRoot: cwd }) : Option.none()),
    getSnapshot: () =>
      Effect.sync(() => {
        if (counter) counter.snapshots += 1;
        return { projects: roots.map((workspaceRoot) => ({ workspaceRoot, deletedAt: null })) };
      }),
  }) as never;

it("only treats a clean, behind default branch with an upstream as pullable", () => {
  assert.equal(autoPullSkipReason(baseStatus), null);
  assert.equal(autoPullSkipReason({ ...baseStatus, isRepo: false }), "not-a-repository");
  assert.equal(
    autoPullSkipReason({ ...baseStatus, isDefaultBranch: false }),
    "not-on-default-branch",
  );
  assert.equal(autoPullSkipReason({ ...baseStatus, branch: null }), "not-on-default-branch");
  assert.equal(autoPullSkipReason({ ...baseStatus, hasUpstream: false }), "no-upstream");
  assert.equal(
    autoPullSkipReason({ ...baseStatus, hasWorkingTreeChanges: true }),
    "working-tree-changes",
  );
  assert.equal(autoPullSkipReason({ ...baseStatus, aheadCount: 1 }), "local-commits");
  assert.equal(autoPullSkipReason({ ...baseStatus, behindCount: 0 }), "up-to-date");
});

it.effect("startup pass pulls only clean, behind default-branch checkouts", () =>
  Effect.gen(function* () {
    const pulled: string[] = [];
    yield* autoPullWorkspaceRoots([
      "/clean",
      "/clean",
      "/current",
      "/dirty",
      "/ahead",
      "/feature",
    ]).pipe(Effect.provideService(GitCore, makeGit(pulled)));
    assert.deepStrictEqual(pulled, ["/clean"]);
  }),
);

it.effect("startup pass swallows pull failures", () =>
  Effect.gen(function* () {
    const pulled: string[] = [];
    yield* autoPullWorkspaceRoots(["/clean"]).pipe(
      Effect.provideService(GitCore, makeGit(pulled, { failPull: true })),
    );
    assert.deepStrictEqual(pulled, []);
  }),
);

it.effect("status hook pulls project roots only while the setting is on", () =>
  Effect.gen(function* () {
    const pulled: string[] = [];
    const run = (enabled: boolean, cwd: string) =>
      Effect.gen(function* () {
        const autoPull = yield* makeDefaultBranchAutoPull;
        return yield* autoPull.maybePull(cwd, statusFor(cwd));
      }).pipe(
        Effect.provideService(GitCore, makeGit(pulled)),
        Effect.provideService(ProjectionSnapshotQuery, snapshotsWithProjects(["/clean"])),
        Effect.provideService(ServerSettingsService, settingsWith(enabled)),
      );

    assert.equal(yield* run(false, "/clean"), false);
    assert.equal(yield* run(true, "/worktree"), false);
    assert.equal(yield* run(true, "/clean"), true);
    assert.deepStrictEqual(pulled, ["/clean"]);
  }),
);

it.effect("keepsRefsFresh holds only while the setting is on and cwd is a project root", () =>
  Effect.gen(function* () {
    const run = (enabled: boolean, cwd: string) =>
      Effect.gen(function* () {
        const autoPull = yield* makeDefaultBranchAutoPull;
        return yield* autoPull.keepsRefsFresh(cwd);
      }).pipe(
        Effect.provideService(GitCore, makeGit([])),
        Effect.provideService(ProjectionSnapshotQuery, snapshotsWithProjects(["/clean"])),
        Effect.provideService(ServerSettingsService, settingsWith(enabled)),
      );

    assert.equal(yield* run(false, "/clean"), false);
    assert.equal(yield* run(true, "/worktree"), false);
    assert.equal(yield* run(true, "/clean"), true);
  }),
);

it.effect("keepsRefsFresh reports false when the project lookup fails", () =>
  Effect.gen(function* () {
    const autoPull = yield* makeDefaultBranchAutoPull.pipe(
      Effect.provideService(GitCore, makeGit([])),
      Effect.provideService(ProjectionSnapshotQuery, {
        getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
        getSnapshot: () => Effect.die(new Error("snapshot unavailable")),
      } as never),
    );
    const fresh = yield* autoPull
      .keepsRefsFresh("/clean")
      .pipe(Effect.provideService(ServerSettingsService, settingsWith(true)));
    assert.equal(fresh, false);
  }),
);

it.effect("the default service never asks passive polls to fetch", () =>
  Effect.gen(function* () {
    const autoPull = yield* DefaultBranchAutoPull;
    assert.equal(yield* autoPull.keepsRefsFresh("/clean"), false);
  }),
);

it.effect("startup pass skips archived projects", () =>
  Effect.gen(function* () {
    const pulled: string[] = [];
    yield* autoPullProjectsAtStartup.pipe(
      Effect.provideService(GitCore, makeGit(pulled)),
      Effect.provideService(ProjectionSnapshotQuery, {
        getSnapshot: () =>
          Effect.succeed({
            projects: [
              { workspaceRoot: "/clean", deletedAt: null, archivedAt: null },
              { workspaceRoot: "/archived", deletedAt: null, archivedAt: "2026-01-01T00:00:00Z" },
            ],
          }),
      } as never),
      Effect.provideService(ServerSettingsService, settingsWith(true)),
    );
    assert.deepStrictEqual(pulled, ["/clean"]);
  }),
);

it.effect("status hook skips an archived project, by exact and by canonical root", () =>
  Effect.gen(function* () {
    const pulled: string[] = [];
    const archivedAt = "2026-01-01T00:00:00Z";
    const autoPull = yield* makeDefaultBranchAutoPull.pipe(
      Effect.provideService(GitCore, makeGit(pulled)),
      Effect.provideService(ProjectionSnapshotQuery, {
        getActiveProjectByWorkspaceRoot: (cwd: string) =>
          Effect.succeed(
            cwd === "/archived" ? Option.some({ workspaceRoot: cwd, archivedAt }) : Option.none(),
          ),
        getSnapshot: () =>
          Effect.succeed({
            projects: [{ workspaceRoot: "/archived", deletedAt: null, archivedAt }],
          }),
      } as never),
    );
    const moved = yield* autoPull
      .maybePull("/archived", statusFor("/archived"))
      .pipe(Effect.provideService(ServerSettingsService, settingsWith(true)));
    assert.equal(moved, false);
    assert.deepStrictEqual(pulled, []);
  }),
);

it.effect("status hook backs off after a failed pull", () =>
  Effect.gen(function* () {
    const calls: GitCall[] = [];
    const autoPull = yield* makeDefaultBranchAutoPull.pipe(
      Effect.provideService(GitCore, makeGit([], { failPull: true, calls })),
      Effect.provideService(ProjectionSnapshotQuery, snapshotsWithProjects(["/clean"])),
    );
    const check = autoPull
      .maybePull("/clean", statusFor("/clean"))
      .pipe(Effect.provideService(ServerSettingsService, settingsWith(true)));

    assert.equal(yield* check, false);
    assert.equal(yield* check, false);
    assert.equal(calls.length, 1);
  }),
);

it.effect("status hook backs off when git exits non-zero without moving HEAD", () =>
  Effect.gen(function* () {
    const calls: GitCall[] = [];
    const autoPull = yield* makeDefaultBranchAutoPull.pipe(
      Effect.provideService(GitCore, makeGit([], { exitCode: 128, calls })),
      Effect.provideService(ProjectionSnapshotQuery, snapshotsWithProjects(["/clean"])),
    );
    const check = autoPull
      .maybePull("/clean", statusFor("/clean"))
      .pipe(Effect.provideService(ServerSettingsService, settingsWith(true)));

    assert.equal(yield* check, false);
    assert.equal(yield* check, false);
    assert.equal(calls.length, 1);
  }),
);

it.effect("status hook does not back off when a fresh status shows new edits", () =>
  Effect.gen(function* () {
    const calls: GitCall[] = [];
    const pulled: string[] = [];
    let editing = true;
    const git = makeGit(pulled, {
      calls,
      statusFor: (cwd) => ({ ...statusFor(cwd), hasWorkingTreeChanges: editing }),
    });
    const autoPull = yield* makeDefaultBranchAutoPull.pipe(
      Effect.provideService(GitCore, git),
      Effect.provideService(ProjectionSnapshotQuery, snapshotsWithProjects(["/clean"])),
    );
    const check = autoPull
      .maybePull("/clean", statusFor("/clean"))
      .pipe(Effect.provideService(ServerSettingsService, settingsWith(true)));

    assert.equal(yield* check, false);
    editing = false;
    assert.equal(yield* check, true);
    assert.deepStrictEqual(pulled, ["/clean"]);
  }),
);

it.effect("status hook fast-forwards locally and never prompts for credentials", () =>
  Effect.gen(function* () {
    const calls: GitCall[] = [];
    const autoPull = yield* makeDefaultBranchAutoPull.pipe(
      Effect.provideService(GitCore, makeGit([], { calls })),
      Effect.provideService(ProjectionSnapshotQuery, snapshotsWithProjects(["/clean"])),
    );
    assert.equal(
      yield* autoPull
        .maybePull("/clean", statusFor("/clean"))
        .pipe(Effect.provideService(ServerSettingsService, settingsWith(true))),
      true,
    );
    assert.deepStrictEqual(calls[0]?.args, ["merge", "--ff-only", "@{upstream}"]);
    assert.equal(calls[0]?.env?.GIT_TERMINAL_PROMPT, "0");
    assert.equal(calls[0]?.env?.GCM_INTERACTIVE, "never");
  }),
);

it.effect("startup pass pulls over the network without credential prompts", () =>
  Effect.gen(function* () {
    const calls: GitCall[] = [];
    yield* autoPullWorkspaceRoots(["/clean"]).pipe(
      Effect.provideService(GitCore, makeGit([], { calls })),
    );
    assert.deepStrictEqual(calls[0]?.args, ["pull", "--ff-only"]);
    assert.equal(calls[0]?.env?.SSH_ASKPASS, "");
    assert.equal(calls[0]?.env?.GIT_ASKPASS, "");
  }),
);

it.effect("status hook matches a project stored under a symlinked root", () =>
  Effect.gen(function* () {
    const fs = yield* Effect.promise(() => import("node:fs/promises"));
    const os = yield* Effect.promise(() => import("node:os"));
    const nodePath = yield* Effect.promise(() => import("node:path"));
    const base = yield* Effect.promise(() =>
      fs.mkdtemp(nodePath.join(os.tmpdir(), "piedpiper-autopull-")),
    );
    const realRoot = nodePath.join(base, "real");
    const linkedRoot = nodePath.join(base, "linked");
    yield* Effect.promise(() => fs.mkdir(realRoot));
    yield* Effect.promise(() => fs.symlink(realRoot, linkedRoot));
    const canonical = yield* Effect.promise(() => fs.realpath(realRoot));
    const pulled: string[] = [];
    const counter = { snapshots: 0 };
    const autoPull = yield* makeDefaultBranchAutoPull.pipe(
      Effect.provideService(GitCore, makeGit(pulled)),
      Effect.provideService(ProjectionSnapshotQuery, snapshotsWithProjects([linkedRoot], counter)),
    );
    const check = (cwd: string) =>
      autoPull
        .maybePull(cwd, statusFor(cwd))
        .pipe(Effect.provideService(ServerSettingsService, settingsWith(true)));

    assert.equal(yield* check(canonical), true);
    assert.equal(yield* check("/elsewhere"), false);
    assert.deepStrictEqual(pulled, [canonical]);
    // The canonical roots are cached, so a second miss does not reload the snapshot.
    assert.equal(counter.snapshots, 1);
    yield* Effect.promise(() => fs.rm(base, { recursive: true, force: true }));
  }),
);

it.effect("concurrent status reads share one project-root load", () =>
  Effect.gen(function* () {
    const counter = { snapshots: 0 };
    const autoPull = yield* makeDefaultBranchAutoPull.pipe(
      Effect.provideService(GitCore, makeGit([])),
      Effect.provideService(ProjectionSnapshotQuery, snapshotsWithProjects(["/clean"], counter)),
    );

    const results = yield* Effect.all(
      ["/wt-a", "/wt-b", "/wt-c", "/wt-d"].map((cwd) => autoPull.keepsRefsFresh(cwd)),
      { concurrency: "unbounded" },
    ).pipe(Effect.provideService(ServerSettingsService, settingsWith(true)));

    assert.deepStrictEqual(results, [false, false, false, false]);
    assert.equal(counter.snapshots, 1);
  }),
);

it.effect("local mode fast-forwards a real checkout to its fetched upstream", () =>
  Effect.gen(function* () {
    const fs = yield* Effect.promise(() => import("node:fs/promises"));
    const os = yield* Effect.promise(() => import("node:os"));
    const nodePath = yield* Effect.promise(() => import("node:path"));
    const { spawnSync } = yield* Effect.promise(() => import("node:child_process"));
    const base = yield* Effect.promise(() =>
      fs.mkdtemp(nodePath.join(os.tmpdir(), "piedpiper-autopull-git-")),
    );
    const git = (cwd: string, ...args: string[]) => {
      const result = spawnSync("git", args, { cwd, encoding: "utf8" });
      if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
      return result.stdout.trim();
    };
    const remote = nodePath.join(base, "remote.git");
    const local = nodePath.join(base, "local");
    const other = nodePath.join(base, "other");
    git(base, "init", "--bare", "-b", "main", remote);
    git(base, "clone", remote, other);
    git(other, "config", "user.email", "test@example.com");
    git(other, "config", "user.name", "Test");
    git(other, "config", "commit.gpgsign", "false");
    yield* Effect.promise(() => fs.writeFile(nodePath.join(other, "a.txt"), "one\n"));
    git(other, "add", ".");
    git(other, "commit", "-m", "one");
    git(other, "push", "origin", "main");
    git(base, "clone", remote, local);
    yield* Effect.promise(() => fs.writeFile(nodePath.join(other, "a.txt"), "two\n"));
    git(other, "commit", "-am", "two");
    git(other, "push", "origin", "main");
    git(local, "fetch", "origin");

    const realGit = yield* GitCore.asEffect().pipe(
      Effect.provide(
        GitCoreLive.pipe(
          Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "piedpiper-autopull-" })),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    );
    const outcome = yield* fastForwardCleanDefaultBranch(local, {
      knownStatus: baseStatus,
      mode: "local",
    }).pipe(
      Effect.provideService(GitCore, {
        ...realGit,
        statusDetails: () => Effect.succeed({ ...baseStatus, behindCount: 1 }),
      }),
    );
    assert.equal(outcome, "pulled");
    assert.equal(git(local, "rev-parse", "HEAD"), git(other, "rev-parse", "HEAD"));
    yield* Effect.promise(() => fs.rm(base, { recursive: true, force: true }));
  }).pipe(Effect.scoped),
);
