import {
  ADVISORS_PROJECT_ID,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  type ModelSelection,
  ProjectId,
  ThreadId,
} from "@piedpiper/contracts";
import {
  Data,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Queue,
  Ref,
  Scope,
  ServiceMap,
} from "effect";

import { ServerConfig } from "./config";
import { Keybindings } from "./keybindings";
import { Open } from "./open";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery";
import { OrchestrationReactor } from "./orchestration/Services/OrchestrationReactor";
import { ServerLifecycleEvents } from "./serverLifecycleEvents";
import { ServerSettingsService } from "./serverSettings";
import { AnalyticsService } from "./telemetry/Services/AnalyticsService";

const isWildcardHost = (host: string | undefined): boolean =>
  host === "0.0.0.0" || host === "::" || host === "[::]";

const formatHostForUrl = (host: string): string =>
  host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;

export class ServerRuntimeStartupError extends Data.TaggedError("ServerRuntimeStartupError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface ServerRuntimeStartupShape {
  readonly awaitCommandReady: Effect.Effect<void, ServerRuntimeStartupError>;
  readonly markHttpListening: Effect.Effect<void>;
  readonly enqueueCommand: <A, E>(
    effect: Effect.Effect<A, E>,
  ) => Effect.Effect<A, E | ServerRuntimeStartupError>;
}

export class ServerRuntimeStartup extends ServiceMap.Service<
  ServerRuntimeStartup,
  ServerRuntimeStartupShape
>()("piedpiper/serverRuntimeStartup") {}

interface QueuedCommand {
  readonly run: Effect.Effect<void, never>;
}

type CommandReadinessState = "pending" | "ready" | ServerRuntimeStartupError;

interface CommandGate {
  readonly awaitCommandReady: Effect.Effect<void, ServerRuntimeStartupError>;
  readonly signalCommandReady: Effect.Effect<void>;
  readonly failCommandReady: (error: ServerRuntimeStartupError) => Effect.Effect<void>;
  readonly enqueueCommand: <A, E>(
    effect: Effect.Effect<A, E>,
  ) => Effect.Effect<A, E | ServerRuntimeStartupError>;
}

const settleQueuedCommand = <A, E>(deferred: Deferred.Deferred<A, E>, exit: Exit.Exit<A, E>) =>
  Exit.isSuccess(exit)
    ? Deferred.succeed(deferred, exit.value)
    : Deferred.failCause(deferred, exit.cause);

export const makeCommandGate = Effect.gen(function* () {
  const commandReady = yield* Deferred.make<void, ServerRuntimeStartupError>();
  const commandQueue = yield* Queue.unbounded<QueuedCommand>();
  const commandReadinessState = yield* Ref.make<CommandReadinessState>("pending");

  const commandWorker = Effect.forever(
    Queue.take(commandQueue).pipe(Effect.flatMap((command) => command.run)),
  );
  yield* Effect.forkScoped(commandWorker);

  return {
    awaitCommandReady: Deferred.await(commandReady),
    signalCommandReady: Effect.gen(function* () {
      yield* Ref.set(commandReadinessState, "ready");
      yield* Deferred.succeed(commandReady, undefined).pipe(Effect.orDie);
    }),
    failCommandReady: (error) =>
      Effect.gen(function* () {
        yield* Ref.set(commandReadinessState, error);
        yield* Deferred.fail(commandReady, error).pipe(Effect.orDie);
      }),
    enqueueCommand: <A, E>(effect: Effect.Effect<A, E>) =>
      Effect.gen(function* () {
        const readinessState = yield* Ref.get(commandReadinessState);
        if (readinessState === "ready") {
          return yield* effect;
        }
        if (readinessState !== "pending") {
          return yield* readinessState;
        }

        const result = yield* Deferred.make<A, E | ServerRuntimeStartupError>();
        yield* Queue.offer(commandQueue, {
          run: Deferred.await(commandReady).pipe(
            Effect.flatMap(() => effect),
            Effect.exit,
            Effect.flatMap((exit) => settleQueuedCommand(result, exit)),
          ),
        });
        return yield* Deferred.await(result);
      }),
  } satisfies CommandGate;
});

export const recordStartupHeartbeat = Effect.gen(function* () {
  const analytics = yield* AnalyticsService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;

  const { threadCount, projectCount } = yield* projectionSnapshotQuery.getCounts().pipe(
    Effect.catch((cause) =>
      Effect.logWarning("failed to gather startup projection counts for telemetry", {
        cause,
      }).pipe(
        Effect.as({
          threadCount: 0,
          projectCount: 0,
        }),
      ),
    ),
  );

  yield* analytics.record("server.boot.heartbeat", {
    threadCount,
    projectCount,
  });
});

export const launchStartupHeartbeat = recordStartupHeartbeat.pipe(
  Effect.annotateSpans({ "startup.phase": "heartbeat.record" }),
  Effect.withSpan("server.startup.heartbeat.record"),
  Effect.ignoreCause({ log: true }),
  Effect.forkScoped,
  Effect.asVoid,
);

/**
 * Ensures the hidden Advisors workspace project exists. Runs unconditionally on
 * startup so the Advisors page can dispatch `thread.create` against a stable
 * project id without ever asking the user to pick a folder. The workspace dir
 * is created in `ensureServerDirectories`; here we only register the project
 * row in the orchestration read model if it isn't already present.
 */
const bootstrapAdvisorsProject = Effect.gen(function* () {
  const serverConfig = yield* ServerConfig;
  const projectionReadModelQuery = yield* ProjectionSnapshotQuery;
  const orchestrationEngine = yield* OrchestrationEngineService;

  const existingProject = yield* projectionReadModelQuery.getActiveProjectByWorkspaceRoot(
    serverConfig.advisorsWorkspaceDir,
  );
  if (Option.isSome(existingProject)) {
    return;
  }

  const advisorsModelSelection: ModelSelection = {
    provider: "claudeAgent",
    model: "claude-haiku-4-5",
  };

  yield* orchestrationEngine.dispatch({
    type: "project.create",
    commandId: CommandId.makeUnsafe(crypto.randomUUID()),
    projectId: ADVISORS_PROJECT_ID,
    title: "Advisors",
    workspaceRoot: serverConfig.advisorsWorkspaceDir,
    defaultModelSelection: advisorsModelSelection,
    createdAt: new Date().toISOString(),
  });
});

/**
 * Copies the bundled advisor SKILL.md files into `<stateDir>/advisor-skills/`
 * so advisor threads can reference them via the Read tool at session start.
 * Runs on every startup (overwrites existing files) to pick up any skill
 * content updates from new server builds.
 */
const copyAdvisorSkillFiles = Effect.gen(function* () {
  const serverConfig = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  // The bundled skill files sit next to the compiled server entry point
  // at `dist/advisor-skills/` (tsdown copies them via the asset pipeline).
  // In dev mode they're at `src/advisor-skills/` relative to the source.
  const bundledDir = path.resolve(path.join(import.meta.dirname, "advisor-skills"));
  const targetDir = serverConfig.advisorSkillsDir;

  const exists = yield* fs.exists(bundledDir).pipe(Effect.orElseSucceed(() => false));
  if (!exists) {
    yield* Effect.logWarning("advisor skill files not found at bundled path, skipping copy", {
      bundledDir,
    });
    return;
  }

  const entries = yield* fs.readDirectory(bundledDir);
  yield* Effect.forEach(
    entries.filter((entry) => entry.endsWith(".md")),
    (entry) =>
      Effect.gen(function* () {
        const src = path.join(bundledDir, entry);
        const dest = path.join(targetDir, entry);
        const content = yield* fs.readFileString(src);
        yield* fs.writeFileString(dest, content);
      }),
    { concurrency: "unbounded" },
  );

  yield* Effect.logInfo("advisor skill files copied", {
    targetDir,
    fileCount: entries.filter((entry) => entry.endsWith(".md")).length,
  });
});

const migrateAdvisorDataDir = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  if (!home) return;
  const oldDir = path.join(home, ".gstack");
  const newDir = path.join(home, ".piedpiper", "advisors");
  const oldExists = yield* fs.exists(oldDir).pipe(Effect.orElseSucceed(() => false));
  const newExists = yield* fs.exists(newDir).pipe(Effect.orElseSucceed(() => false));
  if (oldExists && !newExists) {
    yield* fs.makeDirectory(path.dirname(newDir), { recursive: true });
    yield* fs.copy(oldDir, newDir);
    yield* Effect.logInfo("migrated advisor data from ~/.gstack to ~/.piedpiper/advisors");
  }
});

/**
 * Writes a PROJECTS.md file to the advisors workspace directory listing all
 * user projects and their paths. Called on startup and whenever projects change
 * so advisor agents can discover available workspaces.
 */
export const writeAdvisorProjectsManifest = Effect.gen(function* () {
  const serverConfig = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const readModel = yield* orchestrationEngine.getReadModel();

  const projects = [...readModel.projects.values()].filter(
    (p) => p.id !== ADVISORS_PROJECT_ID && p.deletedAt === null,
  );

  const lines = [
    "# Projects",
    "",
    "Available project workspaces:",
    "",
    ...projects.map((p) => `- **${p.title}** — \`${p.workspaceRoot}\``),
    ...(projects.length === 0 ? ["_No projects added yet._"] : []),
    "",
  ];

  const filePath = path.join(serverConfig.advisorsWorkspaceDir, "PROJECTS.md");
  yield* fs.writeFileString(filePath, lines.join("\n"));
});

const copyAdvisorToolScripts = Effect.gen(function* () {
  const serverConfig = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const bundledDir = path.resolve(path.join(import.meta.dirname, "advisor-tools"));
  const targetDir = serverConfig.advisorToolsDir;

  const exists = yield* fs.exists(bundledDir).pipe(Effect.orElseSucceed(() => false));
  if (!exists) {
    yield* Effect.logWarning("advisor tool scripts not found at bundled path, skipping copy", {
      bundledDir,
    });
    return;
  }

  const entries = yield* fs.readDirectory(bundledDir);
  const toolFiles = entries.filter((entry) => entry.startsWith("pp-"));
  yield* Effect.forEach(
    toolFiles,
    (entry) =>
      Effect.gen(function* () {
        const src = path.join(bundledDir, entry);
        const dest = path.join(targetDir, entry);
        const content = yield* fs.readFileString(src);
        yield* fs.writeFileString(dest, content);
        yield* fs.chmod(dest, 0o755);
      }),
    { concurrency: "unbounded" },
  );

  yield* Effect.logInfo("advisor tool scripts copied", {
    targetDir,
    fileCount: toolFiles.length,
  });
});

const autoBootstrapWelcome = Effect.gen(function* () {
  const serverConfig = yield* ServerConfig;
  const projectionReadModelQuery = yield* ProjectionSnapshotQuery;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const path = yield* Path.Path;

  let bootstrapProjectId: ProjectId | undefined;
  let bootstrapThreadId: ThreadId | undefined;

  if (serverConfig.autoBootstrapProjectFromCwd) {
    yield* Effect.gen(function* () {
      const existingProject = yield* projectionReadModelQuery.getActiveProjectByWorkspaceRoot(
        serverConfig.cwd,
      );
      let nextProjectId: ProjectId;
      let nextProjectDefaultModelSelection: ModelSelection;

      if (Option.isNone(existingProject)) {
        const createdAt = new Date().toISOString();
        nextProjectId = ProjectId.makeUnsafe(crypto.randomUUID());
        const bootstrapProjectTitle = path.basename(serverConfig.cwd) || "project";
        nextProjectDefaultModelSelection = {
          provider: "claudeAgent",
          model: "claude-opus-4-6",
        };
        yield* orchestrationEngine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe(crypto.randomUUID()),
          projectId: nextProjectId,
          title: bootstrapProjectTitle,
          workspaceRoot: serverConfig.cwd,
          defaultModelSelection: nextProjectDefaultModelSelection,
          createdAt,
        });
      } else {
        nextProjectId = existingProject.value.id;
        nextProjectDefaultModelSelection = existingProject.value.defaultModelSelection ?? {
          provider: "claudeAgent",
          model: "claude-opus-4-6",
        };
      }

      const existingThreadId =
        yield* projectionReadModelQuery.getFirstActiveThreadIdByProjectId(nextProjectId);
      if (Option.isNone(existingThreadId)) {
        const createdAt = new Date().toISOString();
        const createdThreadId = ThreadId.makeUnsafe(crypto.randomUUID());
        yield* orchestrationEngine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe(crypto.randomUUID()),
          threadId: createdThreadId,
          projectId: nextProjectId,
          title: "New thread",
          modelSelection: nextProjectDefaultModelSelection,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt,
        });
        bootstrapProjectId = nextProjectId;
        bootstrapThreadId = createdThreadId;
      } else {
        bootstrapProjectId = nextProjectId;
        bootstrapThreadId = existingThreadId.value;
      }
    });
  }

  const segments = serverConfig.cwd.split(/[/\\]/).filter(Boolean);
  const projectName = segments[segments.length - 1] ?? "project";

  return {
    cwd: serverConfig.cwd,
    projectName,
    ...(bootstrapProjectId ? { bootstrapProjectId } : {}),
    ...(bootstrapThreadId ? { bootstrapThreadId } : {}),
  } as const;
});

const maybeOpenBrowser = Effect.gen(function* () {
  const serverConfig = yield* ServerConfig;
  if (serverConfig.noBrowser) {
    return;
  }
  const { openBrowser } = yield* Open;
  const localUrl = `http://localhost:${serverConfig.port}`;
  const bindUrl =
    serverConfig.host && !isWildcardHost(serverConfig.host)
      ? `http://${formatHostForUrl(serverConfig.host)}:${serverConfig.port}`
      : localUrl;
  const target = serverConfig.devUrl?.toString() ?? bindUrl;

  yield* openBrowser(target).pipe(
    Effect.catch(() =>
      Effect.logInfo("browser auto-open unavailable", {
        hint: `Open ${target} in your browser.`,
      }),
    ),
  );
});

const runStartupPhase = <A, E, R>(phase: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.annotateSpans({ "startup.phase": phase }),
    Effect.withSpan(`server.startup.${phase}`),
  );

const makeServerRuntimeStartup = Effect.gen(function* () {
  const serverConfig = yield* ServerConfig;
  const keybindings = yield* Keybindings;
  const orchestrationReactor = yield* OrchestrationReactor;
  const lifecycleEvents = yield* ServerLifecycleEvents;
  const serverSettings = yield* ServerSettingsService;

  const commandGate = yield* makeCommandGate;
  const httpListening = yield* Deferred.make<void>();
  const reactorScope = yield* Scope.make("sequential");

  yield* Effect.addFinalizer(() => Scope.close(reactorScope, Exit.void));

  const startup = Effect.gen(function* () {
    yield* Effect.logDebug("startup phase: starting keybindings runtime");
    yield* runStartupPhase(
      "keybindings.start",
      keybindings.start.pipe(
        Effect.catch((error) =>
          Effect.logWarning("failed to start keybindings runtime", {
            path: error.configPath,
            detail: error.detail,
            cause: error.cause,
          }),
        ),
        Effect.forkScoped,
      ),
    );

    yield* Effect.logDebug("startup phase: starting server settings runtime");
    yield* runStartupPhase(
      "settings.start",
      serverSettings.start.pipe(
        Effect.catch((error) =>
          Effect.logWarning("failed to start server settings runtime", {
            path: error.settingsPath,
            detail: error.detail,
            cause: error.cause,
          }),
        ),
        Effect.forkScoped,
      ),
    );

    yield* Effect.logDebug("startup phase: starting orchestration reactors");
    yield* runStartupPhase(
      "reactors.start",
      orchestrationReactor.start().pipe(Scope.provide(reactorScope)),
    );

    yield* Effect.logDebug("startup phase: bootstrapping advisors workspace");
    yield* runStartupPhase("advisors.bootstrap", bootstrapAdvisorsProject);

    yield* Effect.logDebug("startup phase: copying advisor skill files");
    yield* runStartupPhase(
      "advisor.skills",
      copyAdvisorSkillFiles.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to copy advisor skill files", {
            cause: cause.toString(),
          }),
        ),
      ),
    );

    yield* runStartupPhase(
      "advisor.migrate",
      migrateAdvisorDataDir.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to migrate advisor data directory", {
            cause: cause.toString(),
          }),
        ),
      ),
    );

    yield* Effect.logDebug("startup phase: copying advisor tool scripts");
    yield* runStartupPhase(
      "advisor.tools",
      copyAdvisorToolScripts.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to copy advisor tool scripts", {
            cause: cause.toString(),
          }),
        ),
      ),
    );

    yield* runStartupPhase(
      "advisor.projects-manifest",
      writeAdvisorProjectsManifest.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to write advisor projects manifest", {
            cause: cause.toString(),
          }),
        ),
      ),
    );

    yield* Effect.logDebug("startup phase: preparing welcome payload");
    const welcome = yield* runStartupPhase("welcome.prepare", autoBootstrapWelcome);
    yield* Effect.logDebug("startup phase: publishing welcome event", {
      cwd: welcome.cwd,
      projectName: welcome.projectName,
      bootstrapProjectId: welcome.bootstrapProjectId,
      bootstrapThreadId: welcome.bootstrapThreadId,
    });
    yield* runStartupPhase(
      "welcome.publish",
      lifecycleEvents.publish({
        version: 1,
        type: "welcome",
        payload: welcome,
      }),
    );
  }).pipe(
    Effect.annotateSpans({
      "server.mode": serverConfig.mode,
      "server.port": serverConfig.port,
      "server.host": serverConfig.host ?? "default",
    }),
    Effect.withSpan("server.startup", { kind: "server", root: true }),
  );

  yield* Effect.forkScoped(
    Effect.gen(function* () {
      const startupExit = yield* Effect.exit(startup);
      if (Exit.isFailure(startupExit)) {
        const error = new ServerRuntimeStartupError({
          message: "Server runtime startup failed before command readiness.",
          cause: startupExit.cause,
        });
        yield* Effect.logError("server runtime startup failed", { cause: startupExit.cause });
        yield* commandGate.failCommandReady(error);
        return;
      }

      yield* Effect.logDebug("Accepting commands");
      yield* commandGate.signalCommandReady;
      yield* Effect.logDebug("startup phase: waiting for http listener");
      yield* runStartupPhase("http.wait", Deferred.await(httpListening));
      yield* Effect.logDebug("startup phase: publishing ready event");
      yield* runStartupPhase(
        "ready.publish",
        lifecycleEvents.publish({
          version: 1,
          type: "ready",
          payload: { at: new Date().toISOString() },
        }),
      );

      yield* Effect.logDebug("startup phase: recording startup heartbeat");
      yield* launchStartupHeartbeat;
      yield* Effect.logDebug("startup phase: browser open check");
      yield* runStartupPhase("browser.open", maybeOpenBrowser);
      yield* Effect.logDebug("startup phase: complete");
    }),
  );

  return {
    awaitCommandReady: commandGate.awaitCommandReady,
    markHttpListening: Deferred.succeed(httpListening, undefined),
    enqueueCommand: commandGate.enqueueCommand,
  } satisfies ServerRuntimeStartupShape;
});

export const ServerRuntimeStartupLive = Layer.effect(
  ServerRuntimeStartup,
  makeServerRuntimeStartup,
);
