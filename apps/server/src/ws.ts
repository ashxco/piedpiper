import { access as fsAccess, mkdir as fsMkdir } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { Cause, Effect, FileSystem, Layer, Option, Path, Queue, Ref, Schema, Stream } from "effect";
import {
  AgentSessionScanError,
  type GitActionProgressEvent,
  type GitCloneRepositoryEvent,
  GitCommandError,
  type GitCreateWorktreeProgressEvent,
  type GitManagerServiceError,
  OrchestrationDispatchCommandError,
  type OrchestrationEvent,
  OrchestrationGetFullThreadDiffError,
  OrchestrationGetSnapshotError,
  OrchestrationGetTurnDiffError,
  OrchestrationGetTurnDiffFileContentsError,
  ORCHESTRATION_WS_METHODS,
  ProjectBrowseDirectoriesError,
  ProjectSearchEntriesError,
  ProjectCreateDirectoryError,
  ProjectWriteFileError,
  ProviderItemId,
  OrchestrationReplayEventsError,
  type TerminalMetadataStreamEvent,
  type ToolInputPreviewEvent,
  WS_METHODS,
  WsRpcGroup,
} from "@piedpiper/contracts";
import { clamp } from "effect/Number";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";

import { CheckpointDiffQuery } from "./checkpointing/Services/CheckpointDiffQuery";
import { makeTurnDiffFileContentsReader } from "./checkpointing/turnDiffFileContents";
import {
  capEventCheckpointFilesForWire,
  capReadModelCheckpointFilesForWire,
} from "./checkpointing/wireCheckpointFiles";
import { ServerConfig } from "./config";
import { cloneGitRepository } from "./git/gitClone";
import { readGitCommitHistory } from "./git/gitCommitHistory";
import { syncWorktreeBranches } from "./git/syncWorktreeBranches";
import { resolveGitHubCliStatus } from "./git/gitHubCliStatus";
import { GitCore } from "./git/Services/GitCore";
import { GitHubCli } from "./git/Services/GitHubCli";
import { GitManager } from "./git/Services/GitManager";
import { gitGitHubCreateRepoEffect } from "./githubRepoCreate";
import { rejectRequestOrigin, validateAuthToken } from "./http";
import { checkOtlpEndpoint } from "./diagnostics/OtlpEndpointCheck";
import { makeProcessDiagnostics } from "./diagnostics/ProcessDiagnostics";
import { readTraceDiagnostics } from "./diagnostics/TraceDiagnostics";
import { Keybindings } from "./keybindings";
import {
  isNetworkPath,
  isPathInsideAnyRoot,
  Open,
  OpenError,
  makeCachedEditorDiscovery,
  resolveAvailableEditorsForConfig,
} from "./open";
import { resolveUserHomeDir } from "./os-jank";
import {
  subscribeBounded,
  subscribeBoundedResumable,
} from "./orchestration/BoundedLiveSubscription";
import { isPrunedReplayError } from "./orchestration/Layers/OrchestrationEventMaintenance";
import { normalizeDispatchCommand } from "./orchestration/Normalizer";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery";
import * as EventLoopMonitor from "./observability/EventLoopMonitor";
import {
  observeRpcEffect,
  observeRpcStream,
  observeRpcStreamEffect,
} from "./observability/RpcInstrumentation";
import { resolveAgentSessionHomes, scanAgentSessions } from "./project/AgentSessionScanner";
import { ProjectConfigFileLoader } from "./project/Services/ProjectConfigFileLoader";
import { userFacingDatabaseErrorMessage } from "./persistence/Errors";
import { ClaudeSlashCommands } from "./provider/Services/ClaudeSlashCommands";
import { ProviderRegistry } from "./provider/Services/ProviderRegistry";
import { ProviderService } from "./provider/Services/ProviderService";
import { ServerLifecycleEvents } from "./serverLifecycleEvents";
import { ServerRuntimeStartup } from "./serverRuntimeStartup";
import { ServerSettingsService } from "./serverSettings";
import { awaitEditorDiscovery, makeServerConfigUpdateStream } from "./serverConfigStream";
import { TerminalManager } from "./terminal/Services/Manager";
import { WorkspaceEntries } from "./workspace/Services/WorkspaceEntries";
import { browseDirectories } from "./workspace/browseDirectories";
import { statPathKind } from "./workspace/statPathKind";
import {
  WorkspaceFileSystem,
  WorkspaceFileSystemError,
} from "./workspace/Services/WorkspaceFileSystem";
import { WorkspacePathOutsideRootError } from "./workspace/Services/WorkspacePaths";
import { wsDefectReporterLayer } from "./wsDefectReporter";
import { withOutputWindow } from "./wsOutputWindow";
import { terminalOutputStream } from "./wsTerminalOutputStream";

/**
 * Starts consuming a lazily-subscribed (PubSub-backed) stream immediately and
 * buffers its elements, so items published before the returned stream is first
 * pulled are not lost. The consumer fiber lives in the caller's scope.
 */
const subscribeEagerly = <A, E>(stream: Stream.Stream<A, E>) =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<A, E | Cause.Done>();
    // startImmediately runs the fiber up to its first suspension, i.e. past PubSub.subscribe.
    yield* Stream.runIntoQueue(stream, queue).pipe(Effect.forkScoped({ startImmediately: true }));
    return Stream.fromQueue(queue);
  });

const WsRpcLayer = WsRpcGroup.toLayer(
  Effect.gen(function* () {
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const orchestrationEngine = yield* OrchestrationEngineService;
    const checkpointDiffQuery = yield* CheckpointDiffQuery;
    const keybindings = yield* Keybindings;
    const open = yield* Open;
    const gitManager = yield* GitManager;
    const git = yield* GitCore;
    const fileSystemService = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const gitHubCli = yield* GitHubCli;
    const terminalManager = yield* TerminalManager;
    const connectedClients = (yield* RpcServer.Protocol).clientIds;
    const detachDisconnectedTerminalClient = (clientId: number) =>
      connectedClients.pipe(
        Effect.flatMap((clients) =>
          clients.has(clientId) ? Effect.void : terminalManager.detachClient(clientId),
        ),
      );
    const providerRegistry = yield* ProviderRegistry;
    const providerService = yield* ProviderService;
    const claudeSlashCommands = yield* ClaudeSlashCommands;
    const config = yield* ServerConfig;
    const lifecycleEvents = yield* ServerLifecycleEvents;
    const serverSettings = yield* ServerSettingsService;
    const startup = yield* ServerRuntimeStartup;
    const workspaceEntries = yield* WorkspaceEntries;
    const workspaceFileSystem = yield* WorkspaceFileSystem;
    const projectConfigFileLoader = yield* ProjectConfigFileLoader;
    const eventLoopMonitor = yield* EventLoopMonitor.EventLoopMonitor;
    const processDiagnostics = makeProcessDiagnostics();
    const readTurnDiffFileContents = makeTurnDiffFileContentsReader({
      git,
      projectionSnapshotQuery,
    });

    const discoverAvailableEditors = makeCachedEditorDiscovery();
    // Warm the cache so the first config snapshot rarely hits the discovery timeout.
    discoverAvailableEditors().catch(() => {});

    const loadServerConfig = Effect.gen(function* () {
      const keybindingsConfig = yield* keybindings.loadConfigState;
      const providers = yield* providerRegistry.getProviders;
      const settings = yield* serverSettings.getSettings;
      const availableEditors = yield* resolveAvailableEditorsForConfig(discoverAvailableEditors);
      const lastEventLoopStall = yield* eventLoopMonitor.latestNoticeableStall;

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
          ...(config.otlpLogsUrl !== undefined ? { otlpLogsUrl: config.otlpLogsUrl } : {}),
          otlpLogsEnabled: config.otlpLogsUrl !== undefined,
        },
        settings,
        ...(lastEventLoopStall === undefined ? {} : { lastEventLoopStall }),
      };
    });

    /**
     * Validate that an absolute path falls within a known project workspace root.
     * Prevents arbitrary filesystem
     * access through the directory RPC handlers.
     */
    const findContainingWorkspaceRoot = (inputPath: string) =>
      Effect.gen(function* () {
        const resolved = resolvePath(inputPath);
        // In-memory read model: avoids hydrating the full projection snapshot per call.
        const readModel = yield* orchestrationEngine.getReadModel();
        for (const project of readModel.projects.values()) {
          if (project.deletedAt !== null || !project.workspaceRoot) continue;
          const root = resolvePath(project.workspaceRoot);
          // The resolved path must exactly equal or be a child of an allowed root
          if (resolved === root || resolved.startsWith(root + "/")) return root;
        }
        return null;
      });
    const validatePathWithinWorkspaces = (inputPath: string) =>
      findContainingWorkspaceRoot(inputPath).pipe(Effect.map((root) => root !== null));

    return WsRpcGroup.of({
      [ORCHESTRATION_WS_METHODS.getSnapshot]: (_input) =>
        observeRpcEffect(
          ORCHESTRATION_WS_METHODS.getSnapshot,
          projectionSnapshotQuery.getSnapshot().pipe(
            Effect.map(capReadModelCheckpointFilesForWire),
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
            // Resolved before dispatch so the project's threads are known regardless of projection timing.
            const deletedProjectThreadIds =
              normalizedCommand.type === "project.delete"
                ? yield* orchestrationEngine
                    .getReadModel()
                    .pipe(
                      Effect.map((readModel) =>
                        [...readModel.threads.values()]
                          .filter(
                            (thread) =>
                              thread.projectId === normalizedCommand.projectId &&
                              thread.deletedAt === null,
                          )
                          .map((thread) => thread.id),
                      ),
                    )
                : [];
            const result = yield* startup.enqueueCommand(
              orchestrationEngine.dispatch(normalizedCommand),
            );
            const deletedThreadIds =
              normalizedCommand.type === "thread.delete"
                ? [normalizedCommand.threadId]
                : deletedProjectThreadIds;
            yield* Effect.forEach(
              deletedThreadIds,
              (threadId) =>
                terminalManager.close({ threadId, deleteHistory: true }).pipe(
                  Effect.catch((error) =>
                    Effect.logWarning("failed to close thread terminals after delete", {
                      threadId,
                      error: error.message,
                    }),
                  ),
                ),
              { discard: true },
            );
            if (normalizedCommand.type === "thread.archive") {
              // The provider session itself is stopped by ProviderSessionReaper on `thread.archived`.
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
                userFacingDatabaseErrorMessage(cause) ??
                (cause instanceof Error ? cause.message : typeof cause === "string" ? cause : null);
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
      [ORCHESTRATION_WS_METHODS.getTurnDiffFileContents]: (input) =>
        observeRpcEffect(
          ORCHESTRATION_WS_METHODS.getTurnDiffFileContents,
          readTurnDiffFileContents(input).pipe(
            Effect.mapError(
              (cause) =>
                new OrchestrationGetTurnDiffFileContentsError({
                  message: "Failed to load file contents",
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
              clamp(input.fromSequenceExclusive, {
                maximum: Number.MAX_SAFE_INTEGER,
                minimum: 0,
              }),
            ),
          ).pipe(
            Effect.map((events) => Array.from(events, capEventCheckpointFilesForWire)),
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
        observeRpcStream(
          WS_METHODS.subscribeOrchestrationDomainEvents,
          Stream.unwrap(
            Effect.gen(function* () {
              // Subscribe before reading the snapshot so events published meanwhile are buffered.
              // On overflow the stream re-subscribes and replays from the last delivered sequence.
              const startLive = yield* subscribeBoundedResumable({
                subscribe: orchestrationEngine.subscribeDomainEvents(),
                sequenceOf: (event: OrchestrationEvent) => event.sequence,
                // This RPC has no error schema; the client resubscribes on a defect, and __root
                // then recovers from a snapshot once its own replay is refused.
                replayAfter: (after) =>
                  orchestrationEngine
                    .readEvents(after)
                    .pipe(
                      Stream.catch((error) =>
                        isPrunedReplayError(error) ? Stream.die(error) : Stream.empty,
                      ),
                    ),
              });
              const snapshot = yield* orchestrationEngine.getReadModel();
              const fromSequenceExclusive = snapshot.snapshotSequence;
              const source = startLive(fromSequenceExclusive);
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
                Stream.map(capEventCheckpointFilesForWire),
              );
            }),
          ),
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
            yield* keybindings.upsertKeybindingRule(rule);
            return yield* keybindings.getSnapshot;
          }),
          { "rpc.aggregate": "server" },
        ),
      [WS_METHODS.serverRemoveKeybinding]: (rule) =>
        observeRpcEffect(
          WS_METHODS.serverRemoveKeybinding,
          Effect.gen(function* () {
            yield* keybindings.removeKeybindingRule(rule);
            return yield* keybindings.getSnapshot;
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
      [WS_METHODS.serverGetTraceDiagnostics]: (_input) =>
        observeRpcEffect(
          WS_METHODS.serverGetTraceDiagnostics,
          readTraceDiagnostics({
            traceFilePath: config.serverTracePath,
            maxFiles: config.traceMaxFiles,
          }).pipe(Effect.provideService(FileSystem.FileSystem, fileSystemService)),
          { "rpc.aggregate": "server" },
        ),
      [WS_METHODS.serverGetProcessDiagnostics]: (_input) =>
        observeRpcEffect(WS_METHODS.serverGetProcessDiagnostics, processDiagnostics.read, {
          "rpc.aggregate": "server",
        }),
      [WS_METHODS.serverSignalProcess]: (input) =>
        observeRpcEffect(WS_METHODS.serverSignalProcess, processDiagnostics.signal(input), {
          "rpc.aggregate": "server",
        }),
      // Endpoint URLs can carry API keys, so neither the URL nor the input joins the trace.
      [WS_METHODS.serverCheckOtlpEndpoint]: (input) =>
        observeRpcEffect(WS_METHODS.serverCheckOtlpEndpoint, checkOtlpEndpoint(input, config), {
          "rpc.aggregate": "server",
        }),
      [WS_METHODS.providerListSlashCommands]: (input) =>
        observeRpcEffect(
          WS_METHODS.providerListSlashCommands,
          input.provider === "claudeAgent"
            ? claudeSlashCommands.list(input.cwd)
            : Effect.succeed({ commands: [], pending: false }),
          { "rpc.aggregate": "server" },
        ),
      [WS_METHODS.projectsScanAgentSessions]: (_input) =>
        observeRpcEffect(
          WS_METHODS.projectsScanAgentSessions,
          Effect.gen(function* () {
            const { providers } = yield* serverSettings.getSettings;
            const readModel = yield* orchestrationEngine.getReadModel();
            const homeDir = resolveUserHomeDir();
            return yield* scanAgentSessions({
              homeDir,
              ...resolveAgentSessionHomes(providers, process.env, homeDir),
              baseDir: config.baseDir,
              worktreesDir: config.worktreesDir,
              knownWorkspaceRoots: Array.from(readModel.projects.values())
                // Archived roots stay out, so re-adding one can unarchive it through project.create.
                .filter((project) => project.deletedAt === null && project.archivedAt == null)
                .map((project) => project.workspaceRoot),
            });
          }).pipe(
            Effect.mapError(
              (cause) =>
                new AgentSessionScanError({
                  message: "Failed to scan for agent sessions",
                  cause,
                }),
            ),
          ),
          { "rpc.aggregate": "workspace" },
        ),
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
                : Schema.is(WorkspaceFileSystemError)(cause) &&
                    cause.operation === "workspaceFileSystem.realpathTarget"
                  ? "Workspace file path points through a symlink that cannot be resolved."
                  : "Failed to write workspace file";
              return new ProjectWriteFileError({
                message,
                cause,
              });
            }),
          ),
          { "rpc.aggregate": "workspace" },
        ),
      [WS_METHODS.projectsReadConfigFile]: (input) =>
        observeRpcEffect(
          WS_METHODS.projectsReadConfigFile,
          Effect.gen(function* () {
            // Only known workspaces, so callers cannot read piedpiper.json from arbitrary directories.
            const matchedRoot = yield* findContainingWorkspaceRoot(input.cwd);
            if (matchedRoot === null) return { config: null };
            // Contain symlinks to the registered root, so cwd=<root>/link -> /anywhere is refused.
            const loaded = yield* projectConfigFileLoader.load(input.cwd, {
              containmentRoot: matchedRoot,
            });
            return { config: Option.getOrNull(loaded) };
          }),
          { "rpc.aggregate": "workspace" },
        ),
      [WS_METHODS.projectsStatPath]: (input) =>
        observeRpcEffect(WS_METHODS.projectsStatPath, statPathKind(input.path), {
          "rpc.aggregate": "workspace",
        }),
      // No workspace-root check: browsing outside known roots is how a new project gets found.
      [WS_METHODS.projectsBrowseDirectories]: (input) =>
        observeRpcEffect(
          WS_METHODS.projectsBrowseDirectories,
          browseDirectories(input.partialPath).pipe(
            Effect.provideService(Path.Path, pathService),
            Effect.mapError(
              (failure) =>
                new ProjectBrowseDirectoriesError({
                  message: failure.message,
                  ...(failure.cause !== undefined ? { cause: failure.cause } : {}),
                }),
            ),
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
      [WS_METHODS.shellOpenInEditor]: (input) =>
        observeRpcEffect(
          WS_METHODS.shellOpenInEditor,
          Effect.gen(function* () {
            if (isNetworkPath(input.cwd)) {
              const readModel = yield* orchestrationEngine.getReadModel();
              const roots: Array<string> = [];
              for (const project of readModel.projects.values()) {
                if (project.deletedAt === null) roots.push(project.workspaceRoot);
              }
              for (const thread of readModel.threads.values()) {
                if (thread.deletedAt === null && thread.worktreePath) {
                  roots.push(thread.worktreePath);
                }
              }
              if (!isPathInsideAnyRoot(input.cwd, roots)) {
                return yield* new OpenError({
                  message: "Refusing to open a network path outside the project.",
                });
              }
            }
            return yield* open.openInEditor(input);
          }),
          { "rpc.aggregate": "workspace" },
        ),
      [WS_METHODS.gitStatus]: (input) =>
        observeRpcEffect(
          WS_METHODS.gitStatus,
          gitManager.status(input).pipe(
            Effect.tap((status) =>
              syncWorktreeBranches(git, orchestrationEngine, status).pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("Could not synchronize worktree branches", {
                    cause: Cause.pretty(cause),
                  }),
                ),
              ),
            ),
          ),
          {
            "rpc.aggregate": "git",
          },
        ),
      [WS_METHODS.gitDiffPreview]: (input) =>
        observeRpcEffect(WS_METHODS.gitDiffPreview, git.diffPreview(input), {
          "rpc.aggregate": "git",
        }),
      [WS_METHODS.gitListCommits]: (input) =>
        observeRpcEffect(WS_METHODS.gitListCommits, readGitCommitHistory(git, input), {
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
      [WS_METHODS.gitCreateWorktreeWithProgress]: (input) =>
        observeRpcStream(
          WS_METHODS.gitCreateWorktreeWithProgress,
          Stream.callback<GitCreateWorktreeProgressEvent, GitCommandError>((queue) =>
            git
              .createWorktree(input, {
                onCheckoutProgress: (progress) =>
                  Queue.offer(queue, { kind: "checkout_progress", ...progress }).pipe(
                    Effect.asVoid,
                  ),
              })
              .pipe(
                Effect.flatMap((result) => Queue.offer(queue, { kind: "finished", result })),
                Effect.matchCauseEffect({
                  onFailure: (cause) => Queue.failCause(queue, cause),
                  onSuccess: () => Queue.end(queue).pipe(Effect.asVoid),
                }),
              ),
          ),
          { "rpc.aggregate": "git" },
        ),
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
      [WS_METHODS.gitCloneRepository]: (input) =>
        observeRpcStream(
          WS_METHODS.gitCloneRepository,
          Stream.callback<GitCloneRepositoryEvent, GitCommandError>((queue) =>
            cloneGitRepository(input, {
              git,
              onEvent: (event) => Queue.offer(queue, event).pipe(Effect.asVoid),
            }).pipe(
              Effect.provideService(FileSystem.FileSystem, fileSystemService),
              Effect.provideService(Path.Path, pathService),
              Effect.matchCauseEffect({
                onFailure: (cause) => Queue.failCause(queue, cause),
                onSuccess: () => Queue.end(queue).pipe(Effect.asVoid),
              }),
            ),
          ),
          { "rpc.aggregate": "git" },
        ),
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
        observeRpcEffect(WS_METHODS.gitGitHubCliStatus, resolveGitHubCliStatus(input.cwd), {
          "rpc.aggregate": "git",
        }),
      [WS_METHODS.gitGitHubCreateRepo]: (input) =>
        observeRpcEffect(
          WS_METHODS.gitGitHubCreateRepo,
          gitGitHubCreateRepoEffect(input, { git, gitHubCli }, GitCommandError),
          { "rpc.aggregate": "git" },
        ),
      [WS_METHODS.terminalOpen]: (input, { clientId }) =>
        observeRpcEffect(
          WS_METHODS.terminalOpen,
          terminalManager
            .open(input, clientId)
            .pipe(Effect.ensuring(detachDisconnectedTerminalClient(clientId))),
          {
            "rpc.aggregate": "terminal",
          },
        ),
      [WS_METHODS.terminalWrite]: (input) =>
        observeRpcEffect(WS_METHODS.terminalWrite, terminalManager.write(input), {
          "rpc.aggregate": "terminal",
        }),
      [WS_METHODS.terminalResize]: (input, { clientId }) =>
        observeRpcEffect(
          WS_METHODS.terminalResize,
          terminalManager
            .resize(input, clientId)
            .pipe(Effect.ensuring(detachDisconnectedTerminalClient(clientId))),
          {
            "rpc.aggregate": "terminal",
          },
        ),
      [WS_METHODS.terminalDetach]: (input, { clientId }) => terminalManager.detach(input, clientId),
      [WS_METHODS.terminalClear]: (input) =>
        observeRpcEffect(WS_METHODS.terminalClear, terminalManager.clear(input), {
          "rpc.aggregate": "terminal",
        }),
      [WS_METHODS.terminalRestart]: (input, { clientId }) =>
        observeRpcEffect(
          WS_METHODS.terminalRestart,
          terminalManager
            .restart(input, clientId)
            .pipe(Effect.ensuring(detachDisconnectedTerminalClient(clientId))),
          {
            "rpc.aggregate": "terminal",
          },
        ),
      [WS_METHODS.terminalClose]: (input) =>
        observeRpcEffect(WS_METHODS.terminalClose, terminalManager.close(input), {
          "rpc.aggregate": "terminal",
        }),
      [WS_METHODS.subscribeTerminalEvents]: (_input, { clientId }) =>
        observeRpcStream(
          WS_METHODS.subscribeTerminalEvents,
          terminalOutputStream(terminalManager.subscribe).pipe(
            Stream.ensuring(detachDisconnectedTerminalClient(clientId)),
          ),
          { "rpc.aggregate": "terminal" },
        ),
      [WS_METHODS.subscribeTerminalMetadata]: (_input) =>
        observeRpcStream(
          WS_METHODS.subscribeTerminalMetadata,
          Stream.callback<TerminalMetadataStreamEvent>((queue) =>
            Effect.acquireRelease(
              terminalManager.subscribeMetadata((event) =>
                Queue.offer(queue, event).pipe(Effect.asVoid),
              ),
              (unsubscribe) => Effect.sync(unsubscribe),
            ),
          ),
          { "rpc.aggregate": "terminal" },
        ),
      [WS_METHODS.subscribeServerConfig]: (_input) =>
        observeRpcStreamEffect(
          WS_METHODS.subscribeServerConfig,
          Effect.gen(function* () {
            // Subscribe before loading the snapshot so changes published meanwhile are kept.
            const keybindingsChanges = yield* subscribeEagerly(keybindings.streamChanges);
            const providerChanges = yield* subscribeEagerly(providerRegistry.streamChanges);
            const settingsChanges = yield* subscribeEagerly(serverSettings.streamChanges);
            const snapshotConfig = yield* loadServerConfig;
            return makeServerConfigUpdateStream({
              snapshotConfig,
              keybindingsChanges,
              providerChanges,
              settingsChanges,
              // A scan that outlasted the snapshot timeout still reaches the client when it ends.
              lateAvailableEditors: awaitEditorDiscovery(discoverAvailableEditors),
            });
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
            // Overflow can leave a gap in the live preview text until tool.completed replaces it with the static preview.
            const previewEvents = yield* subscribeBounded(
              providerService.subscribeToolInputPreview(),
            );
            return previewEvents.pipe(
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

// A handler defect must fail only its own request: RpcServer's default sends a socket-level
// Defect frame, and the client then fails every pending request and subscription on the socket.
const WS_RPC_SERVER_OPTIONS = {
  spanPrefix: "ws.rpc",
  spanAttributes: {
    "rpc.transport": "websocket",
    "rpc.system": "effect-rpc",
  },
  disableFatalDefects: true,
} as const;

export const websocketRpcRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const { protocol, httpEffect: rpcWebSocketHttpEffect } =
      yield* RpcServer.makeProtocolWithHttpEffectWebsocket.pipe(
        Effect.provide(RpcSerialization.layerJson),
      );
    const terminalManager = yield* TerminalManager;
    const disconnects = yield* Queue.unbounded<number>();
    // RPC cancellation may need to release a terminal lock before its cleanup can finish.
    yield* Queue.take(protocol.disconnects).pipe(
      Effect.tap((clientId) =>
        terminalManager.detachClient(clientId).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Failed to detach terminal client", cause),
          ),
          Effect.forkScoped,
        ),
      ),
      Effect.flatMap((clientId) => Queue.offer(disconnects, clientId)),
      Effect.forever,
      Effect.forkScoped,
    );
    yield* RpcServer.make(WsRpcGroup, WS_RPC_SERVER_OPTIONS).pipe(
      Effect.provideService(RpcServer.Protocol, withOutputWindow({ ...protocol, disconnects })),
      Effect.provide(
        Layer.mergeAll(
          WsRpcLayer.pipe(
            Layer.provide(wsDefectReporterLayer),
            Layer.provide(Layer.succeed(RpcServer.Protocol, protocol)),
          ),
          RpcSerialization.layerJson,
        ),
      ),
      Effect.forkScoped,
    );
    return HttpRouter.add(
      "GET",
      "/ws",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const config = yield* ServerConfig;
        if (rejectRequestOrigin(request, config) !== undefined) {
          return HttpServerResponse.text("Forbidden WebSocket origin", { status: 403 });
        }
        if (config.authToken) {
          const url = HttpServerRequest.toURL(request);
          if (Option.isNone(url)) {
            return HttpServerResponse.text("Invalid WebSocket URL", { status: 400 });
          }
          if (!validateAuthToken(request, config)) {
            return HttpServerResponse.text("Unauthorized WebSocket connection", { status: 401 });
          }
        }
        return yield* rpcWebSocketHttpEffect;
      }),
    );
  }),
);
