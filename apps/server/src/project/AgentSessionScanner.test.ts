import { execFileSync } from "node:child_process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { AgentSessionScanResult, DEFAULT_SERVER_SETTINGS } from "@piedpiper/contracts";
import { Effect, FileSystem, Path, Schema } from "effect";

import {
  type AgentSessionScanOptions,
  isBareGitConfig,
  resolveAgentSessionHomes,
  scanAgentSessions,
} from "./AgentSessionScanner.ts";

const SECRET = "SECRET-TRANSCRIPT-CONTENT";

const setup = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const realRoot = yield* fileSystem.realPath(
    yield* fileSystem.makeTempDirectoryScoped({ prefix: "piedpiper-agent-sessions-" }),
  );
  const homeDir = path.join(realRoot, "home");
  const claudeHome = path.join(homeDir, ".claude");
  const codexHome = path.join(homeDir, ".codex");
  yield* fileSystem.makeDirectory(homeDir, { recursive: true });

  const write = Effect.fn("write")(function* (filePath: string, contents: string) {
    yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
    yield* fileSystem.writeFileString(filePath, contents);
  });
  const project = Effect.fn("project")(function* (name: string) {
    const directory = path.join(realRoot, "code", name);
    yield* fileSystem.makeDirectory(directory, { recursive: true });
    return directory;
  });
  const gitRepo = Effect.fn("gitRepo")(function* (name: string) {
    const directory = yield* project(name);
    yield* fileSystem.makeDirectory(path.join(directory, ".git"));
    return directory;
  });
  const claudeRecord = (cwd: string, extra: object = {}) =>
    JSON.stringify({ type: "user", cwd, message: { content: SECRET }, ...extra });
  let sessionIndex = 0;
  const claudeSession = Effect.fn("claudeSession")(function* (cwd: string, lines?: string[]) {
    sessionIndex += 1;
    yield* write(
      path.join(claudeHome, "projects", "encoded", `session-${sessionIndex}.jsonl`),
      `${(lines ?? [claudeRecord(cwd)]).join("\n")}\n`,
    );
  });
  const codexSession = Effect.fn("codexSession")(function* (cwd: string, source: unknown = "cli") {
    sessionIndex += 1;
    yield* write(
      path.join(codexHome, "sessions", "2026", "11", "01", `rollout-${sessionIndex}.jsonl`),
      `${JSON.stringify({ type: "session_meta", payload: { cwd, source } })}\n`,
    );
  });
  const scan = (overrides: Partial<AgentSessionScanOptions> = {}) =>
    scanAgentSessions({
      homeDir,
      claudeHome,
      codexHome,
      baseDir: path.join(realRoot, "base"),
      worktreesDir: path.join(realRoot, "base", "worktrees"),
      knownWorkspaceRoots: [],
      tempDirs: [path.join(realRoot, "tmp")],
      ...overrides,
    });

  return {
    realRoot,
    homeDir,
    claudeHome,
    codexHome,
    write,
    project,
    gitRepo,
    claudeRecord,
    claudeSession,
    codexSession,
    scan,
  };
});

it.layer(NodeServices.layer)("scanAgentSessions", (it) => {
  describe("transcripts", () => {
    it.effect("merges sessions per folder across sources and leaks no transcript content", () =>
      Effect.gen(function* () {
        const { gitRepo, claudeSession, codexSession, scan } = yield* setup;
        const repo = yield* gitRepo("app");
        yield* claudeSession(repo);
        yield* claudeSession(repo);
        yield* codexSession(repo);

        const result = yield* scan();

        expect(result.truncated).toBe(false);
        expect(result.candidates).toHaveLength(1);
        expect(result.candidates[0]).toMatchObject({
          path: repo,
          title: "app",
          sources: ["claudeAgent", "codex"],
          threadCount: 3,
          isGitRepository: true,
        });
        expect(result.candidates[0]?.lastActiveAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(JSON.stringify(result)).not.toContain(SECRET);
      }).pipe(Effect.scoped),
    );

    it.effect("skips Claude sidechain records and agent transcripts", () =>
      Effect.gen(function* () {
        const { gitRepo, write, claudeHome, claudeRecord, claudeSession, scan } = yield* setup;
        const main = yield* gitRepo("main");
        const sidechainOnly = yield* gitRepo("sidechain");
        yield* claudeSession(main, [
          claudeRecord(sidechainOnly, { isSidechain: true }),
          claudeRecord(main),
        ]);
        yield* write(
          `${claudeHome}/projects/encoded/agent-1.jsonl`,
          `${claudeRecord(sidechainOnly)}\n`,
        );
        yield* write(
          `${claudeHome}/projects/encoded/session-x/subagents/agent-2.jsonl`,
          `${claudeRecord(sidechainOnly)}\n`,
        );

        const result = yield* scan();

        expect(result.candidates.map((candidate) => candidate.path)).toEqual([main]);
      }).pipe(Effect.scoped),
    );

    it.effect("skips Codex subagent sessions, even when later records name a cwd", () =>
      Effect.gen(function* () {
        const { gitRepo, write, codexHome, codexSession, scan } = yield* setup;
        const repo = yield* gitRepo("app");
        yield* codexSession(repo, { subagent: { review: true } });
        yield* write(
          `${codexHome}/sessions/2026/11/02/rollout-sub.jsonl`,
          [
            JSON.stringify({ type: "session_meta", payload: { source: { subAgent: "x" } } }),
            JSON.stringify({ type: "turn_context", payload: { cwd: repo } }),
          ].join("\n"),
        );

        expect((yield* scan()).candidates).toEqual([]);
      }).pipe(Effect.scoped),
    );

    it.effect("reads a final record that has no trailing newline and ignores bad lines", () =>
      Effect.gen(function* () {
        const { gitRepo, write, claudeHome, claudeRecord, scan } = yield* setup;
        const repo = yield* gitRepo("app");
        yield* write(
          `${claudeHome}/projects/encoded/session.jsonl`,
          `not json\n{"type":"summary"}\n${claudeRecord(repo)}`,
        );

        expect((yield* scan()).candidates.map((candidate) => candidate.path)).toEqual([repo]);
      }).pipe(Effect.scoped),
    );

    it.effect("skips a provider with no home", () =>
      Effect.gen(function* () {
        const { gitRepo, claudeSession, scan } = yield* setup;
        yield* claudeSession(yield* gitRepo("app"));

        expect((yield* scan({ claudeHome: null })).candidates).toEqual([]);
      }).pipe(Effect.scoped),
    );

    it.effect("tolerates missing homes", () =>
      Effect.gen(function* () {
        const { scan } = yield* setup;

        expect(yield* scan()).toEqual({ candidates: [], truncated: false });
      }).pipe(Effect.scoped),
    );
  });

  describe("caps", () => {
    it.effect("flags truncation past the transcript cap", () =>
      Effect.gen(function* () {
        const { gitRepo, claudeSession, scan } = yield* setup;
        const repo = yield* gitRepo("app");
        yield* claudeSession(repo);
        yield* claudeSession(repo);
        yield* claudeSession(repo);

        const result = yield* scan({ maxTranscriptsPerSource: 2 });

        expect(result.truncated).toBe(true);
        expect(result.candidates[0]?.threadCount).toBe(2);
      }).pipe(Effect.scoped),
    );

    it.effect("stops at the byte cap instead of reading a huge first record", () =>
      Effect.gen(function* () {
        const { gitRepo, write, claudeHome, claudeRecord, scan } = yield* setup;
        const repo = yield* gitRepo("app");
        yield* write(
          `${claudeHome}/projects/encoded/session.jsonl`,
          `${JSON.stringify({ blob: "x".repeat(1024 * 1024 + 1) })}\n${claudeRecord(repo)}\n`,
        );

        const result = yield* scan();

        expect(result.truncated).toBe(true);
        expect(result.candidates).toEqual([]);
      }).pipe(Effect.scoped),
    );

    it.effect("stops at the per-transcript record cap", () =>
      Effect.gen(function* () {
        const { gitRepo, claudeSession, claudeRecord, scan } = yield* setup;
        const repo = yield* gitRepo("app");
        yield* claudeSession(repo, [
          ...Array.from({ length: 1000 }, () => '{"type":"summary"}'),
          claudeRecord(repo),
        ]);

        const result = yield* scan();

        expect(result.truncated).toBe(true);
        expect(result.candidates).toEqual([]);
      }).pipe(Effect.scoped),
    );
  });

  describe("folder filters", () => {
    it.effect("drops home, its parents, temp, Downloads, app folders and missing folders", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const { realRoot, homeDir, claudeSession, scan } = yield* setup;
        const excluded = [
          homeDir,
          realRoot,
          `${realRoot}/tmp/scratch`,
          `${homeDir}/Downloads/thing`,
          `${homeDir}/Documents/Codex/2026-11-01/slug`,
          `${realRoot}/base/worktrees/app/wt`,
          `${realRoot}/base/other`,
        ];
        for (const directory of excluded) {
          yield* fileSystem.makeDirectory(directory, { recursive: true });
          yield* claudeSession(directory);
        }
        yield* claudeSession(`${realRoot}/code/gone`);
        yield* claudeSession("relative/path");

        expect((yield* scan()).candidates).toEqual([]);
      }).pipe(Effect.scoped),
    );

    it.effect("does not treat a sibling that shares a prefix as excluded", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const { homeDir, claudeSession, scan } = yield* setup;
        const sibling = `${homeDir}/Downloads-archive`;
        yield* fileSystem.makeDirectory(sibling);
        yield* claudeSession(sibling);

        expect((yield* scan()).candidates.map((candidate) => candidate.path)).toEqual([sibling]);
      }).pipe(Effect.scoped),
    );

    it.effect("sees through a symlink to an excluded folder and merges symlinked duplicates", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const { realRoot, homeDir, gitRepo, claudeSession, scan } = yield* setup;
        const download = `${homeDir}/Downloads/thing`;
        yield* fileSystem.makeDirectory(download, { recursive: true });
        yield* fileSystem.symlink(download, `${realRoot}/code-link-to-download`);
        yield* claudeSession(`${realRoot}/code-link-to-download`);

        const repo = yield* gitRepo("app");
        yield* fileSystem.symlink(repo, `${realRoot}/code-link`);
        yield* claudeSession(repo);
        yield* claudeSession(`${realRoot}/code-link`);

        const result = yield* scan();

        expect(result.candidates).toHaveLength(1);
        expect(result.candidates[0]?.threadCount).toBe(2);
      }).pipe(Effect.scoped),
    );

    it.effect("excludes a temp folder reached under its real path", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const { realRoot, claudeSession, scan } = yield* setup;
        const realTemp = `${realRoot}/private-tmp`;
        yield* fileSystem.makeDirectory(`${realTemp}/scratch`, { recursive: true });
        yield* fileSystem.symlink(realTemp, `${realRoot}/tmp-link`);
        yield* claudeSession(`${realTemp}/scratch`);

        expect((yield* scan({ tempDirs: [`${realRoot}/tmp-link`] })).candidates).toEqual([]);
      }).pipe(Effect.scoped),
    );

    it.effect("excludes a symlinked home folder and its Downloads under their real paths", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const { realRoot, homeDir, claudeSession, scan } = yield* setup;
        yield* fileSystem.symlink(homeDir, `${realRoot}/home-link`);
        const work = `${homeDir}/work`;
        yield* fileSystem.makeDirectory(work);
        yield* fileSystem.makeDirectory(`${homeDir}/Downloads/thing`, { recursive: true });
        yield* claudeSession(homeDir);
        yield* claudeSession(`${homeDir}/Downloads/thing`);
        yield* claudeSession(work);

        const result = yield* scan({ homeDir: `${realRoot}/home-link` });

        expect(result.candidates.map((candidate) => candidate.path)).toEqual([work]);
      }).pipe(Effect.scoped),
    );

    it.effect("keeps a contract-safe result when a folder name has edge spaces", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const { realRoot, claudeSession, scan } = yield* setup;
        const leading = `${realRoot}/code/ leading`;
        const trailing = `${realRoot}/code/trailing `;
        yield* fileSystem.makeDirectory(leading, { recursive: true });
        yield* fileSystem.makeDirectory(trailing, { recursive: true });
        yield* fileSystem.makeDirectory(`${realRoot}/code/trailing`);
        yield* claudeSession(leading);
        yield* claudeSession(trailing);
        yield* claudeSession(`${trailing}/`);

        const result = yield* scan();

        // The trailing folder cannot be added, and trimming it would name a different folder.
        expect(result.candidates.map((candidate) => [candidate.path, candidate.title])).toEqual([
          [leading, "leading"],
        ]);
        expect(() => Schema.encodeUnknownSync(AgentSessionScanResult)(result)).not.toThrow();
      }).pipe(Effect.scoped),
    );

    it.effect("omits folders that are already projects, also through a symlink", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const { realRoot, gitRepo, claudeSession, scan } = yield* setup;
        const repo = yield* gitRepo("app");
        yield* fileSystem.symlink(repo, `${realRoot}/code-link`);
        yield* claudeSession(`${realRoot}/code-link`);

        expect((yield* scan({ knownWorkspaceRoots: [repo] })).candidates).toEqual([]);
      }).pipe(Effect.scoped),
    );
  });

  describe("git", () => {
    const makeLinkedWorktree = Effect.fn("makeLinkedWorktree")(function* (
      directory: string,
      gitDir: string,
      config: string | null,
    ) {
      const fileSystem = yield* FileSystem.FileSystem;
      const adminDir = `${gitDir}/worktrees/wt`;
      yield* fileSystem.makeDirectory(adminDir, { recursive: true });
      yield* fileSystem.writeFileString(`${adminDir}/commondir`, "../..\n");
      if (config !== null) yield* fileSystem.writeFileString(`${gitDir}/config`, config);
      yield* fileSystem.writeFileString(`${directory}/.git`, `gitdir: ${adminDir}\n`);
    });

    it.effect("reports a plain folder as not a repository", () =>
      Effect.gen(function* () {
        const { project, claudeSession, scan } = yield* setup;
        yield* claudeSession(yield* project("plain"));

        expect((yield* scan()).candidates[0]?.isGitRepository).toBe(false);
      }).pipe(Effect.scoped),
    );

    it.effect("filters a linked worktree of a normal repository", () =>
      Effect.gen(function* () {
        const { realRoot, project, claudeSession, scan } = yield* setup;
        const directory = yield* project("wt");
        yield* makeLinkedWorktree(directory, `${realRoot}/main/.git`, "[core]\n\tbare = false\n");
        yield* claudeSession(directory);

        expect((yield* scan()).candidates).toEqual([]);
      }).pipe(Effect.scoped),
    );

    it.effect("filters a subfolder of a linked worktree", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const { realRoot, project, claudeSession, scan } = yield* setup;
        const directory = yield* project("wt");
        yield* makeLinkedWorktree(directory, `${realRoot}/main/.git`, "[core]\n\tbare = false\n");
        yield* fileSystem.makeDirectory(`${directory}/packages/app`, { recursive: true });
        yield* claudeSession(`${directory}/packages/app`);

        expect((yield* scan()).candidates).toEqual([]);
      }).pipe(Effect.scoped),
    );

    it.effect("reports a subfolder of a repository as a repository", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const { gitRepo, claudeSession, scan } = yield* setup;
        const nested = `${yield* gitRepo("app")}/packages/app`;
        yield* fileSystem.makeDirectory(nested, { recursive: true });
        yield* claudeSession(nested);

        expect((yield* scan()).candidates[0]).toMatchObject({
          path: nested,
          title: "app",
          isGitRepository: true,
        });
      }).pipe(Effect.scoped),
    );

    it.effect("does not count a git repository in the home folder or too far up", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const { homeDir, gitRepo, claudeSession, scan } = yield* setup;
        yield* fileSystem.makeDirectory(`${homeDir}/.git`);
        const inHome = `${homeDir}/work/app`;
        yield* fileSystem.makeDirectory(inHome, { recursive: true });
        yield* claudeSession(inHome);
        const deep = `${yield* gitRepo("deep")}/1/2/3/4/5/6/7/8/9`;
        yield* fileSystem.makeDirectory(deep, { recursive: true });
        yield* claudeSession(deep);

        const result = yield* scan();

        expect(result.candidates.map((candidate) => candidate.isGitRepository)).toEqual([
          false,
          false,
        ]);
      }).pipe(Effect.scoped),
    );

    it.effect("offers a linked worktree of a bare repository", () =>
      Effect.gen(function* () {
        const { realRoot, project, claudeSession, scan } = yield* setup;
        const directory = yield* project("wt");
        yield* makeLinkedWorktree(directory, `${realRoot}/bare.git`, "[core]\n\tbare = true\n");
        yield* claudeSession(directory);

        expect((yield* scan()).candidates[0]?.isGitRepository).toBe(true);
      }).pipe(Effect.scoped),
    );

    it.effect("treats a submodule's gitdir pointer as a repository", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const { realRoot, project, claudeSession, scan } = yield* setup;
        const directory = yield* project("sub");
        yield* fileSystem.writeFileString(
          `${directory}/.git`,
          `gitdir: ${realRoot}/main/.git/modules/sub\n`,
        );
        yield* claudeSession(directory);

        expect((yield* scan()).candidates[0]?.isGitRepository).toBe(true);
      }).pipe(Effect.scoped),
    );

    it.effect("treats an unreadable pointer as not a repository", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const { project, claudeSession, scan } = yield* setup;
        const directory = yield* project("broken");
        yield* fileSystem.writeFileString(`${directory}/.git`, "garbage\n");
        yield* claudeSession(directory);

        expect((yield* scan()).candidates[0]?.isGitRepository).toBe(false);
      }).pipe(Effect.scoped),
    );

    it.effect.skipIf(process.platform === "win32")(
      "does not hang on a git config that blocks when opened",
      () =>
        Effect.gen(function* () {
          const { realRoot, project, claudeSession, scan } = yield* setup;
          const directory = yield* project("blocked");
          yield* makeLinkedWorktree(directory, `${realRoot}/fifo/.git`, null);
          execFileSync("mkfifo", [`${realRoot}/fifo/.git/config`]);
          yield* claudeSession(directory);

          // Unreadable means it cannot be shown to be bare, so it stays filtered as a worktree.
          expect((yield* scan()).candidates).toEqual([]);
        }).pipe(Effect.scoped),
      15_000,
    );
  });
});

describe("scanAgentSessions on a folder that does not answer", () => {
  const withHangingStat = <A, E, R>(
    isDead: (filePath: string) => boolean,
    effect: Effect.Effect<A, E, R>,
  ) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      return yield* effect.pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fileSystem,
          stat: (filePath) => (isDead(filePath) ? Effect.never : fileSystem.stat(filePath)),
        }),
      );
    });

  it.live("rules the folder out and finishes the scan", () =>
    Effect.gen(function* () {
      const { gitRepo, project, claudeSession, scan } = yield* setup;
      const repo = yield* gitRepo("app");
      const dead = yield* project("dead");
      yield* claudeSession(repo);
      yield* claudeSession(dead);

      const result = yield* withHangingStat(
        (filePath) => filePath === dead,
        scan({ folderProbeTimeoutMs: 50 }),
      );

      expect(result.truncated).toBe(true);
      expect(result.candidates.map((candidate) => candidate.path)).toEqual([repo]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("stops probing after repeated timeouts instead of pinning every pool thread", () =>
    Effect.gen(function* () {
      const { project, claudeSession, scan } = yield* setup;
      const dead = ["a", "b", "c", "d"];
      for (const name of dead) yield* claudeSession(yield* project(name));
      const probed = new Set<string>();

      const result = yield* withHangingStat(
        (filePath) => {
          const isDead = dead.some((name) => filePath.endsWith(`/code/${name}`));
          if (isDead) probed.add(filePath);
          return isDead;
        },
        scan({ folderProbeTimeoutMs: 50 }),
      );

      expect(probed.size).toBe(2);
      expect(result).toEqual({ candidates: [], truncated: true });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("drops a folder whose git folder does not answer", () =>
    Effect.gen(function* () {
      const { project, claudeSession, scan } = yield* setup;
      const directory = yield* project("slow");
      yield* claudeSession(directory);

      const result = yield* withHangingStat(
        (filePath) => filePath === `${directory}/.git`,
        scan({ folderProbeTimeoutMs: 50 }),
      );

      expect(result).toEqual({ candidates: [], truncated: true });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("finishes when a known project does not answer, and still matches it by path", () =>
    Effect.gen(function* () {
      const { project, claudeSession, scan } = yield* setup;
      const directory = yield* project("known");
      yield* claudeSession(directory);
      const knownDead = yield* project("known-dead");

      const result = yield* withHangingStat(
        (filePath) => filePath === knownDead,
        scan({ knownWorkspaceRoots: [knownDead, directory], folderProbeTimeoutMs: 50 }),
      );

      expect(result).toEqual({ candidates: [], truncated: true });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("isBareGitConfig", () => {
  it.each([
    ["[core]\n\tbare = true\n", true],
    ["[core]\n\tbare = false\n", false],
    ["[core]\n\tbare\n", true],
    ['[core]\n\tbare = "yes" ; note\n', true],
    ["[core] bare = 1\n", true],
    ["[core]\n\tbare = true\n\tbare = false\n", false],
    ["[remote]\n\tbare = true\n", false],
    ["[core]\n\tbareword = true\n", false],
    ["", false],
  ])("reads %j as %s", (config, expected) => {
    expect(isBareGitConfig(config)).toBe(expected);
  });
});

describe("resolveAgentSessionHomes", () => {
  const providers = DEFAULT_SERVER_SETTINGS.providers;

  it("defaults to the providers' folders under home", () => {
    expect(resolveAgentSessionHomes(providers, {}, "/home/dev")).toEqual({
      claudeHome: "/home/dev/.claude",
      codexHome: "/home/dev/.codex",
    });
  });

  it("prefers settings over the environment and expands ~", () => {
    expect(
      resolveAgentSessionHomes(
        {
          ...providers,
          claudeAgent: { ...providers.claudeAgent, homePath: "~/work-claude" },
        },
        { CLAUDE_CONFIG_DIR: "/env/claude", CODEX_HOME: "/env/codex" },
        "/home/dev",
      ),
    ).toEqual({ claudeHome: "/home/dev/work-claude", codexHome: "/env/codex" });
  });

  it("skips disabled providers", () => {
    expect(
      resolveAgentSessionHomes(
        { ...providers, codex: { ...providers.codex, enabled: false } },
        {},
        "/home/dev",
      ).codexHome,
    ).toBeNull();
  });
});
