import {
  access as fsAccess,
  lstat as fsLstat,
  mkdir as fsMkdir,
  readdir as fsReaddir,
  readFile as fsReadFile,
  realpath as fsRealpath,
  rm as fsRm,
  stat as fsStat,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { Effect, Layer, Option, Queue, Ref, Schema, Stream } from "effect";
import {
  type GitActionProgressEvent,
  GitCommandError,
  type GitManagerServiceError,
  OrchestrationDispatchCommandError,
  type OrchestrationEvent,
  OrchestrationGetFullThreadDiffError,
  OrchestrationGetSnapshotError,
  OrchestrationGetTurnDiffError,
  ORCHESTRATION_WS_METHODS,
  ProjectSearchEntriesError,
  ProjectCreateDirectoryError,
  ProjectWriteFileError,
  ProviderItemId,
  SkillsSearchError,
  SkillDetailError,
  SkillUninstallError,
  type MergedSkill,
  OrchestrationReplayEventsError,
  type TerminalEvent,
  type ToolInputPreviewEvent,
  WS_METHODS,
  WsRpcGroup,
} from "@piedpiper/contracts";
import { clamp } from "effect/Number";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";

import { CheckpointDiffQuery } from "./checkpointing/Services/CheckpointDiffQuery";
import { ServerConfig } from "./config";
import { GitCore } from "./git/Services/GitCore";
import { GitHubCli } from "./git/Services/GitHubCli";
import { GitManager } from "./git/Services/GitManager";
import { gitGitHubCreateRepoEffect } from "./githubRepoCreate";
import { Keybindings } from "./keybindings";
import { Open, resolveAvailableEditors } from "./open";
import { normalizeDispatchCommand } from "./orchestration/Normalizer";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery";
import {
  observeRpcEffect,
  observeRpcStream,
  observeRpcStreamEffect,
} from "./observability/RpcInstrumentation";
import { ProviderRegistry } from "./provider/Services/ProviderRegistry";
import { ProviderService } from "./provider/Services/ProviderService";
import { ServerLifecycleEvents } from "./serverLifecycleEvents";
import { ServerRuntimeStartup } from "./serverRuntimeStartup";
import { ServerSettingsService } from "./serverSettings";
import { TerminalManager } from "./terminal/Services/Manager";
import { WorkspaceEntries } from "./workspace/Services/WorkspaceEntries";
import { WorkspaceFileSystem } from "./workspace/Services/WorkspaceFileSystem";
import { WorkspacePathOutsideRootError } from "./workspace/Services/WorkspacePaths";

// ---------------------------------------------------------------------------
// Skills helpers
// ---------------------------------------------------------------------------

function parseSkillFrontmatter(content: string): {
  name: string;
  description: string;
  version?: string | undefined;
  allowedTools?: string[] | undefined;
} {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return { name: "", description: "" };
  const yaml = match[1]!;
  const name = yaml.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? "";
  // Handle both single-line and multi-line (|) descriptions
  let description = "";
  const descSingle = yaml.match(/^description:\s*(?!\|)(.+)$/m);
  if (descSingle) {
    description = descSingle[1]!.trim();
  } else {
    const descBlock = yaml.match(/^description:\s*\|\s*\n([\s\S]*?)(?=\n\S|\n*$)/m);
    if (descBlock) {
      description = descBlock[1]!
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .join(" ");
    }
  }
  const version = yaml.match(/^version:\s*(.+)$/m)?.[1]?.trim();
  const toolsMatch = yaml.match(/^allowed-tools:\s*\n((?:\s+-\s+.+\n?)*)/m);
  const allowedTools = toolsMatch
    ? toolsMatch[1]!
        .split("\n")
        .map((l) => l.replace(/^\s*-\s*/, "").trim())
        .filter(Boolean)
    : undefined;
  return { name, description, version, allowedTools };
}

interface LocalSkill {
  id: string;
  name: string;
  description: string;
  localPath: string;
  localSource: "global" | "project";
  version?: string | undefined;
  allowedTools?: string[] | undefined;
}

type SkillFrontmatter = ReturnType<typeof parseSkillFrontmatter>;

interface SkillFileEntry {
  realPath: string;
  mtimeMs: number;
  raw: string;
  parsed: SkillFrontmatter;
}

// Cache parsed SKILL.md files keyed by canonical (realpath) path. Each entry
// records the mtime of the canonical file so we can invalidate when the file
// changes on disk. Without this, every WS skill list/detail call re-reads and
// re-parses every SKILL.md, blocking the Effect runtime on synchronous fs.
const skillFileCache = new Map<string, SkillFileEntry>();

async function readSkillFileCached(absolutePath: string): Promise<SkillFileEntry | null> {
  let realPath: string;
  let mtimeMs: number;
  try {
    realPath = await fsRealpath(absolutePath);
    mtimeMs = (await fsStat(realPath)).mtimeMs;
  } catch {
    return null;
  }

  const cached = skillFileCache.get(realPath);
  if (cached && cached.mtimeMs === mtimeMs) {
    return cached;
  }

  let raw: string;
  try {
    raw = await fsReadFile(realPath, "utf8");
  } catch {
    return null;
  }

  const entry: SkillFileEntry = {
    realPath,
    mtimeMs,
    raw,
    parsed: parseSkillFrontmatter(raw),
  };
  skillFileCache.set(realPath, entry);
  return entry;
}

async function scanSkillsDir(root: string, source: "global" | "project"): Promise<LocalSkill[]> {
  try {
    await fsAccess(root);
  } catch {
    return [];
  }
  const results: LocalSkill[] = [];
  const seenPaths = new Set<string>();

  let entries: string[];
  try {
    entries = await fsReaddir(root);
  } catch {
    return [];
  }

  for (const entry of entries) {
    const entryPath = join(root, entry);
    let stat;
    try {
      stat = await fsLstat(entryPath);
    } catch {
      continue;
    }

    // Skip symlinks — we'll pick up the canonical version from group dirs
    if (stat.isSymbolicLink()) continue;
    if (!stat.isDirectory()) continue;

    const skillMdPath = join(entryPath, "SKILL.md");
    const file = await readSkillFileCached(skillMdPath);
    if (file) {
      if (seenPaths.has(file.realPath)) continue;
      seenPaths.add(file.realPath);
      const fm = file.parsed;
      results.push({
        id: fm.name || entry,
        name: fm.name || entry,
        description: fm.description,
        localPath: entryPath,
        localSource: source,
        version: fm.version,
        allowedTools: fm.allowedTools,
      });
    } else {
      // Group directory — recurse one level
      let subEntries: string[];
      try {
        subEntries = await fsReaddir(entryPath);
      } catch {
        continue;
      }
      for (const sub of subEntries) {
        const subPath = join(entryPath, sub);
        const subSkillMd = join(subPath, "SKILL.md");
        const subFile = await readSkillFileCached(subSkillMd);
        if (!subFile) continue;
        if (seenPaths.has(subFile.realPath)) continue;
        seenPaths.add(subFile.realPath);
        const fm = subFile.parsed;
        results.push({
          id: fm.name || sub,
          name: fm.name || sub,
          description: fm.description,
          localPath: subPath,
          localSource: source,
          version: fm.version,
          allowedTools: fm.allowedTools,
        });
      }
    }
  }
  return results;
}

function localSkillsToMerged(local: LocalSkill[]): MergedSkill[] {
  return local.map((skill) => ({
    id: skill.id,
    name: skill.name,
    description: skill.description,
    installed: true,
    localSource: skill.localSource,
    localPath: skill.localPath,
  }));
}

const WsRpcLayer = WsRpcGroup.toLayer(
  Effect.gen(function* () {
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const orchestrationEngine = yield* OrchestrationEngineService;
    const checkpointDiffQuery = yield* CheckpointDiffQuery;
    const keybindings = yield* Keybindings;
    const open = yield* Open;
    const gitManager = yield* GitManager;
    const git = yield* GitCore;
    const gitHubCli = yield* GitHubCli;
    const terminalManager = yield* TerminalManager;
    const providerRegistry = yield* ProviderRegistry;
    const providerService = yield* ProviderService;
    const config = yield* ServerConfig;
    const lifecycleEvents = yield* ServerLifecycleEvents;
    const serverSettings = yield* ServerSettingsService;
    const startup = yield* ServerRuntimeStartup;
    const workspaceEntries = yield* WorkspaceEntries;
    const workspaceFileSystem = yield* WorkspaceFileSystem;

    const loadServerConfig = Effect.gen(function* () {
      const keybindingsConfig = yield* keybindings.loadConfigState;
      const providers = yield* providerRegistry.getProviders;
      const settings = yield* serverSettings.getSettings;
      const availableEditors = yield* Effect.tryPromise(() => resolveAvailableEditors()).pipe(
        Effect.catch(() =>
          Effect.succeed([] as ReadonlyArray<import("@piedpiper/contracts").EditorId>),
        ),
      );

      return {
        cwd: config.cwd,
        keybindingsConfigPath: config.keybindingsConfigPath,
        keybindings: keybindingsConfig.keybindings,
        issues: keybindingsConfig.issues,
        providers,
        availableEditors,
        observability: {
          logsDirectoryPath: config.logsDir,
          localTracingEnabled: true,
          ...(config.otlpTracesUrl !== undefined ? { otlpTracesUrl: config.otlpTracesUrl } : {}),
          otlpTracesEnabled: config.otlpTracesUrl !== undefined,
          ...(config.otlpMetricsUrl !== undefined ? { otlpMetricsUrl: config.otlpMetricsUrl } : {}),
          otlpMetricsEnabled: config.otlpMetricsUrl !== undefined,
        },
        settings,
      };
    });

    /**
     * Validate that an absolute path falls within a known project workspace root
     * or one of the server's advisor directories. Prevents arbitrary filesystem
     * access through the directory RPC handlers.
     */
    const validatePathWithinWorkspaces = (inputPath: string) =>
      Effect.gen(function* () {
        const resolved = resolvePath(inputPath);
        // Collect allowed root directories from server config
        const allowedRoots: string[] = [
          config.advisorsWorkspaceDir,
          config.advisorToolsDir,
          config.advisorSkillsDir,
        ];
        // Add all active project workspace roots from the projection read model
        const snapshot = yield* projectionSnapshotQuery
          .getSnapshot()
          .pipe(Effect.orElseSucceed(() => ({ projects: [] as { workspaceRoot: string }[] })));
        for (const project of snapshot.projects) {
          if (project.workspaceRoot) {
            allowedRoots.push(resolvePath(project.workspaceRoot));
          }
        }
        // The resolved path must exactly equal or be a child of an allowed root
        const isAllowed = allowedRoots.some(
          (root) => resolved === root || resolved.startsWith(root + "/"),
        );
        return isAllowed;
      });

    return WsRpcGroup.of({
      [ORCHESTRATION_WS_METHODS.getSnapshot]: (_input) =>
        observeRpcEffect(
          ORCHESTRATION_WS_METHODS.getSnapshot,
          projectionSnapshotQuery.getSnapshot().pipe(
            Effect.mapError(
              (cause) =>
                new OrchestrationGetSnapshotError({
                  message: "Failed to load orchestration snapshot",
                  cause,
                }),
            ),
          ),
          { "rpc.aggregate": "orchestration" },
        ),
      [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command) =>
        observeRpcEffect(
          ORCHESTRATION_WS_METHODS.dispatchCommand,
          Effect.gen(function* () {
            const normalizedCommand = yield* normalizeDispatchCommand(command);
            const result = yield* startup.enqueueCommand(
              orchestrationEngine.dispatch(normalizedCommand),
            );
            if (normalizedCommand.type === "thread.archive") {
              yield* terminalManager.close({ threadId: normalizedCommand.threadId }).pipe(
                Effect.catch((error) =>
                  Effect.logWarning("failed to close thread terminals after archive", {
                    threadId: normalizedCommand.threadId,
                    error: error.message,
                  }),
                ),
              );
            }
            return result;
          }).pipe(
            Effect.mapError((cause) => {
              if (Schema.is(OrchestrationDispatchCommandError)(cause)) {
                return cause;
              }
              const detail =
                cause instanceof Error ? cause.message : typeof cause === "string" ? cause : null;
              return new OrchestrationDispatchCommandError({
                message: detail ?? "Failed to dispatch orchestration command",
                cause,
              });
            }),
          ),
          { "rpc.aggregate": "orchestration" },
        ),
      [ORCHESTRATION_WS_METHODS.getTurnDiff]: (input) =>
        observeRpcEffect(
          ORCHESTRATION_WS_METHODS.getTurnDiff,
          checkpointDiffQuery.getTurnDiff(input).pipe(
            Effect.mapError(
              (cause) =>
                new OrchestrationGetTurnDiffError({
                  message: "Failed to load turn diff",
                  cause,
                }),
            ),
          ),
          { "rpc.aggregate": "orchestration" },
        ),
      [ORCHESTRATION_WS_METHODS.getFullThreadDiff]: (input) =>
        observeRpcEffect(
          ORCHESTRATION_WS_METHODS.getFullThreadDiff,
          checkpointDiffQuery.getFullThreadDiff(input).pipe(
            Effect.mapError(
              (cause) =>
                new OrchestrationGetFullThreadDiffError({
                  message: "Failed to load full thread diff",
                  cause,
                }),
            ),
          ),
          { "rpc.aggregate": "orchestration" },
        ),
      [ORCHESTRATION_WS_METHODS.replayEvents]: (input) =>
        observeRpcEffect(
          ORCHESTRATION_WS_METHODS.replayEvents,
          Stream.runCollect(
            orchestrationEngine.readEvents(
              clamp(input.fromSequenceExclusive, { maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
            ),
          ).pipe(
            Effect.map((events) => Array.from(events)),
            Effect.mapError(
              (cause) =>
                new OrchestrationReplayEventsError({
                  message: "Failed to replay orchestration events",
                  cause,
                }),
            ),
          ),
          { "rpc.aggregate": "orchestration" },
        ),
      [WS_METHODS.subscribeOrchestrationDomainEvents]: (_input) =>
        observeRpcStreamEffect(
          WS_METHODS.subscribeOrchestrationDomainEvents,
          Effect.gen(function* () {
            const snapshot = yield* orchestrationEngine.getReadModel();
            const fromSequenceExclusive = snapshot.snapshotSequence;
            const replayEvents: Array<OrchestrationEvent> = yield* Stream.runCollect(
              orchestrationEngine.readEvents(fromSequenceExclusive),
            ).pipe(
              Effect.map((events) => Array.from(events)),
              Effect.catch(() => Effect.succeed([] as Array<OrchestrationEvent>)),
            );
            const replayStream = Stream.fromIterable(replayEvents);
            const source = Stream.merge(replayStream, orchestrationEngine.streamDomainEvents);
            type SequenceState = {
              readonly nextSequence: number;
              readonly pendingBySequence: Map<number, OrchestrationEvent>;
            };
            const state = yield* Ref.make<SequenceState>({
              nextSequence: fromSequenceExclusive + 1,
              pendingBySequence: new Map<number, OrchestrationEvent>(),
            });

            return source.pipe(
              Stream.mapEffect((event) =>
                Ref.modify(
                  state,
                  ({
                    nextSequence,
                    pendingBySequence,
                  }): [Array<OrchestrationEvent>, SequenceState] => {
                    if (event.sequence < nextSequence || pendingBySequence.has(event.sequence)) {
                      return [[], { nextSequence, pendingBySequence }];
                    }

                    const updatedPending = new Map(pendingBySequence);
                    updatedPending.set(event.sequence, event);

                    // Safety valve: flush if too many events buffered out of order
                    if (updatedPending.size > 1000) {
                      const all = [...updatedPending.values()].toSorted(
                        (a, b) => a.sequence - b.sequence,
                      );
                      const lastSeq = all.at(-1)?.sequence ?? nextSequence;
                      return [all, { nextSequence: lastSeq + 1, pendingBySequence: new Map() }];
                    }

                    const emit: Array<OrchestrationEvent> = [];
                    let expected = nextSequence;
                    for (;;) {
                      const expectedEvent = updatedPending.get(expected);
                      if (!expectedEvent) {
                        break;
                      }
                      emit.push(expectedEvent);
                      updatedPending.delete(expected);
                      expected += 1;
                    }

                    return [emit, { nextSequence: expected, pendingBySequence: updatedPending }];
                  },
                ),
              ),
              Stream.flatMap((events) => Stream.fromIterable(events)),
            );
          }),
          { "rpc.aggregate": "orchestration" },
        ),
      [WS_METHODS.serverGetConfig]: (_input) =>
        observeRpcEffect(WS_METHODS.serverGetConfig, loadServerConfig, {
          "rpc.aggregate": "server",
        }),
      [WS_METHODS.serverRefreshProviders]: (_input) =>
        observeRpcEffect(
          WS_METHODS.serverRefreshProviders,
          providerRegistry.refresh().pipe(Effect.map((providers) => ({ providers }))),
          { "rpc.aggregate": "server" },
        ),
      [WS_METHODS.serverUpsertKeybinding]: (rule) =>
        observeRpcEffect(
          WS_METHODS.serverUpsertKeybinding,
          Effect.gen(function* () {
            const keybindingsConfig = yield* keybindings.upsertKeybindingRule(rule);
            return { keybindings: keybindingsConfig, issues: [] };
          }),
          { "rpc.aggregate": "server" },
        ),
      [WS_METHODS.serverGetSettings]: (_input) =>
        observeRpcEffect(WS_METHODS.serverGetSettings, serverSettings.getSettings, {
          "rpc.aggregate": "server",
        }),
      [WS_METHODS.serverUpdateSettings]: ({ patch }) =>
        observeRpcEffect(WS_METHODS.serverUpdateSettings, serverSettings.updateSettings(patch), {
          "rpc.aggregate": "server",
        }),
      [WS_METHODS.projectsSearchEntries]: (input) =>
        observeRpcEffect(
          WS_METHODS.projectsSearchEntries,
          workspaceEntries.search(input).pipe(
            Effect.mapError(
              (cause) =>
                new ProjectSearchEntriesError({
                  message: `Failed to search workspace entries: ${cause.detail}`,
                  cause,
                }),
            ),
          ),
          { "rpc.aggregate": "workspace" },
        ),
      [WS_METHODS.projectsWriteFile]: (input) =>
        observeRpcEffect(
          WS_METHODS.projectsWriteFile,
          workspaceFileSystem.writeFile(input).pipe(
            Effect.mapError((cause) => {
              const message = Schema.is(WorkspacePathOutsideRootError)(cause)
                ? "Workspace file path must stay within the project root."
                : "Failed to write workspace file";
              return new ProjectWriteFileError({
                message,
                cause,
              });
            }),
          ),
          { "rpc.aggregate": "workspace" },
        ),
      [WS_METHODS.projectsCheckDirectoryExists]: (input) =>
        observeRpcEffect(
          WS_METHODS.projectsCheckDirectoryExists,
          Effect.gen(function* () {
            const allowed = yield* validatePathWithinWorkspaces(input.path);
            if (!allowed) return { exists: false };
            const exists = yield* Effect.tryPromise(() =>
              fsAccess(input.path).then(() => true),
            ).pipe(Effect.catch(() => Effect.succeed(false)));
            return { exists };
          }),
          { "rpc.aggregate": "workspace" },
        ),
      [WS_METHODS.projectsCreateDirectory]: (input) =>
        observeRpcEffect(
          WS_METHODS.projectsCreateDirectory,
          Effect.gen(function* () {
            const allowed = yield* validatePathWithinWorkspaces(input.path);
            if (!allowed) {
              return yield* new ProjectCreateDirectoryError({
                message: `Path is not within a known project workspace: ${input.path}`,
              });
            }
            return yield* Effect.tryPromise({
              try: async () => {
                await fsMkdir(input.path, { recursive: true });
                return { path: input.path };
              },
              catch: (cause) =>
                new ProjectCreateDirectoryError({
                  message: `Failed to create directory: ${input.path}`,
                  cause,
                }),
            });
          }),
          { "rpc.aggregate": "workspace" },
        ),
      [WS_METHODS.skillsSearch]: (input) =>
        observeRpcEffect(
          WS_METHODS.skillsSearch,
          Effect.tryPromise({
            try: async () => {
              const globalRoot = join(homedir(), ".claude", "skills");
              const localSkills = await scanSkillsDir(globalRoot, "global");
              let merged = localSkillsToMerged(localSkills);

              if (input.query) {
                const q = input.query.toLowerCase();
                merged = merged.filter(
                  (s) =>
                    s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
                );
              }

              const page = input.page ?? 1;
              const pageSize = input.pageSize ?? 200;
              const total = merged.length;
              const start = (page - 1) * pageSize;
              const paged = merged.slice(start, start + pageSize);

              return { skills: paged, total, page, pageSize };
            },
            catch: (cause) =>
              new SkillsSearchError({
                message: "Failed to search skills",
                cause,
              }),
          }),
          { "rpc.aggregate": "skills" },
        ),
      [WS_METHODS.skillsGetDetail]: (input) =>
        observeRpcEffect(
          WS_METHODS.skillsGetDetail,
          Effect.tryPromise({
            try: async () => {
              let name = input.id;
              let description = "";
              let localContent: string | undefined;
              let version: string | undefined;
              let allowedTools: string[] | undefined;

              if (input.localPath) {
                const skillMdPath = join(input.localPath, "SKILL.md");
                const file = await readSkillFileCached(skillMdPath);
                if (file) {
                  const fm = file.parsed;
                  name = fm.name || name;
                  description = fm.description || description;
                  version = fm.version;
                  allowedTools = fm.allowedTools;
                  localContent = file.raw
                    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n*/, "")
                    .replace(/<!--[\s\S]*?-->/g, "")
                    .trim();
                }
              }

              return {
                name,
                description,
                ...(localContent !== undefined ? { localContent } : {}),
                ...(version !== undefined ? { version } : {}),
                ...(allowedTools !== undefined ? { allowedTools } : {}),
              };
            },
            catch: (cause) =>
              new SkillDetailError({
                message: "Failed to load skill detail",
                cause,
              }),
          }),
          { "rpc.aggregate": "skills" },
        ),
      [WS_METHODS.skillsUninstall]: (input) =>
        observeRpcEffect(
          WS_METHODS.skillsUninstall,
          Effect.tryPromise({
            try: async () => {
              const skillPath = input.skillPath;
              // Validate path is under ~/.claude/skills/
              const globalRoot = join(homedir(), ".claude", "skills");
              const resolved = await fsRealpath(skillPath);
              if (!resolved.startsWith(globalRoot)) {
                throw new Error("Cannot uninstall skills outside of ~/.claude/skills/");
              }
              // Delete the resolved path (not the original) to prevent TOCTOU
              // symlink-swap attacks.
              await fsRm(resolved, { recursive: true, force: true });
              // Also remove the original symlink/entry if it still exists
              try {
                await fsRm(skillPath, { recursive: true, force: true });
              } catch {}
              return { removed: true };
            },
            catch: (cause) =>
              new SkillUninstallError({
                message: `Failed to uninstall skill: ${String(cause instanceof Error ? cause.message : cause)}`,
                cause,
              }),
          }),
          { "rpc.aggregate": "skills" },
        ),
      [WS_METHODS.shellOpenInEditor]: (input) =>
        observeRpcEffect(WS_METHODS.shellOpenInEditor, open.openInEditor(input), {
          "rpc.aggregate": "workspace",
        }),
      [WS_METHODS.gitStatus]: (input) =>
        observeRpcEffect(WS_METHODS.gitStatus, gitManager.status(input), {
          "rpc.aggregate": "git",
        }),
      [WS_METHODS.gitPull]: (input) =>
        observeRpcEffect(WS_METHODS.gitPull, git.pullCurrentBranch(input.cwd), {
          "rpc.aggregate": "git",
        }),
      [WS_METHODS.gitRunStackedAction]: (input) =>
        observeRpcStream(
          WS_METHODS.gitRunStackedAction,
          Stream.callback<GitActionProgressEvent, GitManagerServiceError>((queue) =>
            gitManager
              .runStackedAction(input, {
                actionId: input.actionId,
                progressReporter: {
                  publish: (event) => Queue.offer(queue, event).pipe(Effect.asVoid),
                },
              })
              .pipe(
                Effect.matchCauseEffect({
                  onFailure: (cause) => Queue.failCause(queue, cause),
                  onSuccess: () => Queue.end(queue).pipe(Effect.asVoid),
                }),
              ),
          ),
          { "rpc.aggregate": "git" },
        ),
      [WS_METHODS.gitResolvePullRequest]: (input) =>
        observeRpcEffect(WS_METHODS.gitResolvePullRequest, gitManager.resolvePullRequest(input), {
          "rpc.aggregate": "git",
        }),
      [WS_METHODS.gitPreparePullRequestThread]: (input) =>
        observeRpcEffect(
          WS_METHODS.gitPreparePullRequestThread,
          gitManager.preparePullRequestThread(input),
          { "rpc.aggregate": "git" },
        ),
      [WS_METHODS.gitListBranches]: (input) =>
        observeRpcEffect(WS_METHODS.gitListBranches, git.listBranches(input), {
          "rpc.aggregate": "git",
        }),
      [WS_METHODS.gitCreateWorktree]: (input) =>
        observeRpcEffect(WS_METHODS.gitCreateWorktree, git.createWorktree(input), {
          "rpc.aggregate": "git",
        }),
      [WS_METHODS.gitRemoveWorktree]: (input) =>
        observeRpcEffect(WS_METHODS.gitRemoveWorktree, git.removeWorktree(input), {
          "rpc.aggregate": "git",
        }),
      [WS_METHODS.gitCreateBranch]: (input) =>
        observeRpcEffect(WS_METHODS.gitCreateBranch, git.createBranch(input), {
          "rpc.aggregate": "git",
        }),
      [WS_METHODS.gitCheckout]: (input) =>
        observeRpcEffect(WS_METHODS.gitCheckout, Effect.scoped(git.checkoutBranch(input)), {
          "rpc.aggregate": "git",
        }),
      [WS_METHODS.gitInit]: (input) =>
        observeRpcEffect(WS_METHODS.gitInit, git.initRepo(input), { "rpc.aggregate": "git" }),
      [WS_METHODS.gitAddRemote]: (input) =>
        observeRpcEffect(
          WS_METHODS.gitAddRemote,
          git
            .ensureRemote({
              cwd: input.cwd,
              url: input.url,
              preferredName: input.name ?? "origin",
            })
            .pipe(Effect.map((remoteName) => ({ remoteName }))),
          { "rpc.aggregate": "git" },
        ),
      [WS_METHODS.gitGitHubCliStatus]: (input) =>
        observeRpcEffect(
          WS_METHODS.gitGitHubCliStatus,
          gitHubCli.execute({ cwd: input.cwd, args: ["auth", "status"] }).pipe(
            Effect.map((result) => ({
              installed: true,
              authenticated: result.code === 0,
            })),
            Effect.catch(() => Effect.succeed({ installed: false, authenticated: false })),
          ),
          { "rpc.aggregate": "git" },
        ),
      [WS_METHODS.gitGitHubCreateRepo]: (input) =>
        observeRpcEffect(
          WS_METHODS.gitGitHubCreateRepo,
          gitGitHubCreateRepoEffect(input, { git, gitHubCli }, GitCommandError),
          { "rpc.aggregate": "git" },
        ),
      [WS_METHODS.terminalOpen]: (input) =>
        observeRpcEffect(WS_METHODS.terminalOpen, terminalManager.open(input), {
          "rpc.aggregate": "terminal",
        }),
      [WS_METHODS.terminalWrite]: (input) =>
        observeRpcEffect(WS_METHODS.terminalWrite, terminalManager.write(input), {
          "rpc.aggregate": "terminal",
        }),
      [WS_METHODS.terminalResize]: (input) =>
        observeRpcEffect(WS_METHODS.terminalResize, terminalManager.resize(input), {
          "rpc.aggregate": "terminal",
        }),
      [WS_METHODS.terminalClear]: (input) =>
        observeRpcEffect(WS_METHODS.terminalClear, terminalManager.clear(input), {
          "rpc.aggregate": "terminal",
        }),
      [WS_METHODS.terminalRestart]: (input) =>
        observeRpcEffect(WS_METHODS.terminalRestart, terminalManager.restart(input), {
          "rpc.aggregate": "terminal",
        }),
      [WS_METHODS.terminalClose]: (input) =>
        observeRpcEffect(WS_METHODS.terminalClose, terminalManager.close(input), {
          "rpc.aggregate": "terminal",
        }),
      [WS_METHODS.subscribeTerminalEvents]: (_input) =>
        observeRpcStream(
          WS_METHODS.subscribeTerminalEvents,
          Stream.callback<TerminalEvent>((queue) =>
            Effect.acquireRelease(
              terminalManager.subscribe((event) => Queue.offer(queue, event)),
              (unsubscribe) => Effect.sync(unsubscribe),
            ),
          ),
          { "rpc.aggregate": "terminal" },
        ),
      [WS_METHODS.subscribeServerConfig]: (_input) =>
        observeRpcStreamEffect(
          WS_METHODS.subscribeServerConfig,
          Effect.gen(function* () {
            const keybindingsUpdates = keybindings.streamChanges.pipe(
              Stream.map((event) => ({
                version: 1 as const,
                type: "keybindingsUpdated" as const,
                payload: {
                  issues: event.issues,
                },
              })),
            );
            const providerStatuses = providerRegistry.streamChanges.pipe(
              Stream.map((providers) => ({
                version: 1 as const,
                type: "providerStatuses" as const,
                payload: { providers },
              })),
            );
            const settingsUpdates = serverSettings.streamChanges.pipe(
              Stream.map((settings) => ({
                version: 1 as const,
                type: "settingsUpdated" as const,
                payload: { settings },
              })),
            );

            return Stream.concat(
              Stream.make({
                version: 1 as const,
                type: "snapshot" as const,
                config: yield* loadServerConfig,
              }),
              Stream.merge(keybindingsUpdates, Stream.merge(providerStatuses, settingsUpdates)),
            );
          }),
          { "rpc.aggregate": "server" },
        ),
      [WS_METHODS.subscribeServerLifecycle]: (_input) =>
        observeRpcStreamEffect(
          WS_METHODS.subscribeServerLifecycle,
          Effect.gen(function* () {
            const snapshot = yield* lifecycleEvents.snapshot;
            const snapshotEvents = Array.from(snapshot.events).toSorted(
              (left, right) => left.sequence - right.sequence,
            );
            const liveEvents = lifecycleEvents.stream.pipe(
              Stream.filter((event) => event.sequence > snapshot.sequence),
            );
            return Stream.concat(Stream.fromIterable(snapshotEvents), liveEvents);
          }),
          { "rpc.aggregate": "server" },
        ),
      [WS_METHODS.subscribeToolInputPreview]: (input) =>
        observeRpcStreamEffect(
          WS_METHODS.subscribeToolInputPreview,
          Effect.gen(function* () {
            // Acquire the dedicated preview pubsub subscription synchronously
            // BEFORE returning the stream so we don't drop deltas published in
            // the gap between subscription dispatch and the stream's first
            // pull. The subscription is scoped to the outer Effect, which the
            // RPC framework keeps alive for the duration of the stream
            // consumption.
            const subscription = yield* providerService.subscribeToolInputPreview();
            return Stream.fromSubscription(subscription).pipe(
              Stream.filter((event): event is typeof event & { readonly type: "content.delta" } => {
                if (!event.itemId) return false;
                if (event.threadId !== input.threadId) return false;
                if (event.type !== "content.delta") return false;
                if (event.payload.streamKind !== "tool_input_text") return false;
                return true;
              }),
              Stream.map((event): ToolInputPreviewEvent => {
                const meta =
                  event.payload.streamKind === "tool_input_text"
                    ? event.payload.toolMeta
                    : undefined;
                const previewEvent: ToolInputPreviewEvent = {
                  threadId: event.threadId,
                  itemId: ProviderItemId.makeUnsafe(event.itemId!),
                  toolName: meta?.toolName ?? "unknown",
                  fieldName: meta?.fieldName ?? "unknown",
                  delta: event.payload.delta,
                };
                if (meta?.filePath !== undefined) {
                  Object.assign(previewEvent, { filePath: meta.filePath });
                }
                if (meta?.oldString !== undefined) {
                  Object.assign(previewEvent, { oldString: meta.oldString });
                }
                return previewEvent;
              }),
            );
          }),
          { "rpc.aggregate": "provider" },
        ),
    });
  }),
);

export const websocketRpcRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const rpcWebSocketHttpEffect = yield* RpcServer.toHttpEffectWebsocket(WsRpcGroup, {
      spanPrefix: "ws.rpc",
      spanAttributes: {
        "rpc.transport": "websocket",
        "rpc.system": "effect-rpc",
      },
    }).pipe(Effect.provide(Layer.mergeAll(WsRpcLayer, RpcSerialization.layerJson)));
    return HttpRouter.add(
      "GET",
      "/ws",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const config = yield* ServerConfig;
        if (config.authToken) {
          const url = HttpServerRequest.toURL(request);
          if (Option.isNone(url)) {
            return HttpServerResponse.text("Invalid WebSocket URL", { status: 400 });
          }
          const token = url.value.searchParams.get("token");
          if (token !== config.authToken) {
            return HttpServerResponse.text("Unauthorized WebSocket connection", { status: 401 });
          }
        }
        return yield* rpcWebSocketHttpEffect;
      }),
    );
  }),
);
