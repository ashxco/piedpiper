import {
  CommandId,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  type ModelSelection,
  ProjectId,
  ThreadId,
} from "@piedpiper/contracts";
import {
  Cause,
  Data,
  Deferred,
  Effect,
  Exit,
  Layer,
  Option,
  Path,
  Queue,
  Ref,
  Scope,
  ServiceMap,
} from "effect";

import { flushCompileCache } from "./compileCache";
import { ServerConfig } from "./config";
import { autoPullProjectsAtStartup } from "./defaultBranchAutoPull";
import { formatWebAccessUrl } from "./http";
import { Keybindings } from "./keybindings";
import { Open } from "./open";
import { settleOpenTasksCommands } from "./orchestration/Layers/ProviderRuntimeIngestionHelpers";
import { closeOrphanedApprovals } from "./orchestration/orphanedApprovals";
import {
  dispatchRestartContinuations,
  takeRestartContinuations,
} from "./orchestration/restartContinuation";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery";
import { OrchestrationReactor } from "./orchestration/Services/OrchestrationReactor";
import { ProviderService } from "./provider/Services/ProviderService";
import { ProviderSessionDirectory } from "./provider/Services/ProviderSessionDirectory";
import { ServerLifecycleEvents } from "./serverLifecycleEvents";
import { getServerSettingsOrDefault, ServerSettingsService } from "./serverSettings";
import { AnalyticsService } from "./telemetry/Services/AnalyticsService";

const isWildcardHost = (host: string | undefined): boolean =>
  host === "0.0.0.0" || host === "::" || host === "[::]";

const formatHostForUrl = (host: string): string =>
  host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;

const appendAuthTokenToUrl = (url: URL, authToken: string | undefined): string => {
  if (!authToken) return url.toString();
  const target = new URL(url.toString());
  target.searchParams.set("token", authToken);
  return target.toString();
};

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
  Effect.withSpan("server.startup.heartbeat.record", {
    attributes: { "startup.phase": "heartbeat.record" },
  }),
  Effect.ignoreCause({ log: true }),
  Effect.forkScoped,
  Effect.asVoid,
);

/** Advisors were removed; older builds created this project and its chat threads. */
const LEGACY_ADVISORS_PROJECT_ID = ProjectId.makeUnsafe("project-advisors");

const removeLegacyAdvisorsProject = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const readModel = yield* orchestrationEngine.getReadModel();
  const project = readModel.projects.get(LEGACY_ADVISORS_PROJECT_ID);
  if (!project || project.deletedAt !== null) {
    return;
  }

  const threads = [...readModel.threads.values()].filter(
    (thread) => thread.projectId === LEGACY_ADVISORS_PROJECT_ID && thread.deletedAt === null,
  );
  for (const thread of threads) {
    yield* orchestrationEngine.dispatch({
      type: "thread.delete",
      commandId: CommandId.makeUnsafe(crypto.randomUUID()),
      threadId: thread.id,
    });
  }
  yield* orchestrationEngine.dispatch({
    type: "project.delete",
    commandId: CommandId.makeUnsafe(crypto.randomUUID()),
    projectId: LEGACY_ADVISORS_PROJECT_ID,
  });
  yield* Effect.logInfo("removed legacy advisors project", { threadCount: threads.length });
});

export const ORPHANED_PROVIDER_SESSION_ERROR =
  "Provider session did not survive a server restart. Send a new message to continue.";

const logUnlessInterrupted =
  (message: string, annotations: Record<string, unknown> = {}) =>
  <E>(cause: Cause.Cause<E>) =>
    Cause.hasInterrupts(cause)
      ? Effect.failCause(cause)
      : Effect.logWarning(message, { ...annotations, cause });

/**
 * After a crash or kill mid-turn the projection still says `starting`/`running` (or carries an
 * active turn) for sessions that no longer exist. Settle those threads so sends, stop, archive
 * and revert are not blocked forever, and finish any assistant message left streaming.
 */
export const reconcileProviderSessions = Effect.gen(function* () {
  const directory = yield* ProviderSessionDirectory;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;

  const liveThreadIds = new Set(
    (yield* providerService.listSessions()).map((session) => session.threadId),
  );
  const readModel = yield* orchestrationEngine.getReadModel();
  const orphanedThreads = [...readModel.threads.values()].filter(
    (thread) =>
      thread.deletedAt === null &&
      thread.session !== null &&
      (thread.session.status === "starting" ||
        thread.session.status === "running" ||
        thread.session.activeTurnId !== null) &&
      !liveThreadIds.has(thread.id),
  );

  for (const thread of orphanedThreads) {
    const session = thread.session;
    if (session === null) {
      continue;
    }
    yield* Effect.gen(function* () {
      const binding = yield* directory.getBinding(thread.id);
      if (Option.isSome(binding)) {
        yield* directory.upsert({
          ...binding.value,
          status: "stopped",
          runtimePayload: { activeTurnId: null },
        });
      }
    }).pipe(
      Effect.catchCause(
        logUnlessInterrupted("failed to reconcile orphaned provider session binding", {
          threadId: thread.id,
        }),
      ),
    );

    yield* Effect.gen(function* () {
      const reconciledAt = new Date().toISOString();
      yield* orchestrationEngine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe(crypto.randomUUID()),
        threadId: thread.id,
        session: {
          ...session,
          status: "error",
          activeTurnId: null,
          lastError: ORPHANED_PROVIDER_SESSION_ERROR,
          updatedAt: reconciledAt,
        },
        createdAt: reconciledAt,
      });
    }).pipe(
      Effect.retry({ times: 1 }),
      Effect.catchCause(
        logUnlessInterrupted("failed to settle orphaned provider session projection", {
          threadId: thread.id,
        }),
      ),
    );
  }

  // Assistant replies cut off by a crash stay `streaming` forever, even when the session was already settled.
  for (const thread of readModel.threads.values()) {
    if (thread.deletedAt !== null || liveThreadIds.has(thread.id)) {
      continue;
    }
    for (const message of thread.messages) {
      if (message.role !== "assistant" || !message.streaming) {
        continue;
      }
      yield* orchestrationEngine
        .dispatch({
          type: "thread.message.assistant.complete",
          commandId: CommandId.makeUnsafe(crypto.randomUUID()),
          threadId: thread.id,
          messageId: message.id,
          ...(message.turnId !== null ? { turnId: message.turnId } : {}),
          // Stamp with the last streamed chunk so the reply's duration excludes the downtime.
          createdAt: message.updatedAt,
        })
        .pipe(
          Effect.catchCause(
            logUnlessInterrupted("failed to complete orphaned streaming assistant message", {
              threadId: thread.id,
              messageId: message.id,
            }),
          ),
        );
    }
  }

  yield* closeOrphanedApprovals({ threads: readModel.threads.values(), liveThreadIds });

  // A killed server took its Claude processes along, and no session.started may follow to say so.
  for (const thread of readModel.threads.values()) {
    if (
      thread.deletedAt !== null ||
      liveThreadIds.has(thread.id) ||
      thread.session?.providerName !== "claudeAgent"
    ) {
      continue;
    }
    const settledAt = new Date().toISOString();
    yield* Effect.forEach(
      settleOpenTasksCommands({
        threadId: thread.id,
        activities: thread.activities,
        createdAt: settledAt,
        commandId: () => CommandId.makeUnsafe(crypto.randomUUID()),
      }),
      (command) => orchestrationEngine.dispatch(command),
      { discard: true },
    ).pipe(
      Effect.catchCause(
        logUnlessInterrupted("failed to settle orphaned background tasks", {
          threadId: thread.id,
        }),
      ),
    );
  }
}).pipe(Effect.catchCause(logUnlessInterrupted("provider session startup reconciliation failed")));

/** Only the welcome thread gets this; project creation records no default of its own. */
export const getAutoBootstrapThreadModelSelection = (): ModelSelection => ({
  provider: "claudeAgent",
  model: DEFAULT_MODEL_BY_PROVIDER.claudeAgent,
});

export const autoBootstrapWelcome = Effect.gen(function* () {
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
      let nextThreadModelSelection: ModelSelection;

      if (Option.isNone(existingProject)) {
        const createdAt = new Date().toISOString();
        nextProjectId = ProjectId.makeUnsafe(crypto.randomUUID());
        const bootstrapProjectTitle = path.basename(serverConfig.cwd) || "project";
        nextThreadModelSelection = getAutoBootstrapThreadModelSelection();
        yield* orchestrationEngine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe(crypto.randomUUID()),
          projectId: nextProjectId,
          title: bootstrapProjectTitle,
          workspaceRoot: serverConfig.cwd,
          createdAt,
        });
      } else {
        nextProjectId = existingProject.value.id;
        nextThreadModelSelection =
          existingProject.value.defaultModelSelection ?? getAutoBootstrapThreadModelSelection();
        // Launching in an archived folder counts as re-adding it, and this path skips project.create.
        if (existingProject.value.archivedAt) {
          yield* orchestrationEngine.dispatch({
            type: "project.meta.update",
            commandId: CommandId.makeUnsafe(crypto.randomUUID()),
            projectId: nextProjectId,
            archivedAt: null,
          });
        }
      }

      const existingThreadId =
        yield* projectionReadModelQuery.getFirstActiveThreadIdByProjectId(nextProjectId);
      if (Option.isNone(existingThreadId)) {
        const createdAt = new Date().toISOString();
        const createdThreadId = ThreadId.makeUnsafe(crypto.randomUUID());
        const { defaultRuntimeMode } = yield* getServerSettingsOrDefault;
        yield* orchestrationEngine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe(crypto.randomUUID()),
          threadId: createdThreadId,
          projectId: nextProjectId,
          title: "New thread",
          modelSelection: nextThreadModelSelection,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: defaultRuntimeMode,
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
  // Web mode always carries an auth token, so a bare URL would land on a page
  // whose WebSocket is rejected with 401. Open the tokenized URL instead.
  const target = serverConfig.devUrl
    ? appendAuthTokenToUrl(serverConfig.devUrl, serverConfig.authToken)
    : (formatWebAccessUrl(serverConfig) ?? bindUrl);

  yield* openBrowser(target).pipe(
    Effect.catch(() =>
      Effect.logInfo("browser auto-open unavailable", {
        // The target carries the auth token, which must stay out of logs and traces.
        hint: "Open the access URL printed at startup in your browser.",
      }),
    ),
  );
});

const runStartupPhase = <A, E, R>(phase: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    // Span attributes, not annotateSpans: annotations leak onto every fiber forked in the phase.
    Effect.withSpan(`server.startup.${phase}`, { attributes: { "startup.phase": phase } }),
  );

/** The take goes first: reconcile settles the cut turn and closes approvals, which hide what it reads. */
export const settleAndContinueProviderSessions = Effect.gen(function* () {
  const restartContinuations = yield* runStartupPhase(
    "provider-sessions.take-continuations",
    takeRestartContinuations,
  );
  yield* runStartupPhase("provider-sessions.reconcile", reconcileProviderSessions);
  yield* runStartupPhase(
    "provider-sessions.continue",
    dispatchRestartContinuations(restartContinuations),
  );
});

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

    yield* runStartupPhase(
      "advisors.remove-legacy",
      removeLegacyAdvisorsProject.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to remove legacy advisors project", {
            cause: cause.toString(),
          }),
        ),
      ),
    );

    yield* settleAndContinueProviderSessions;

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
    Effect.withSpan("server.startup", {
      kind: "server",
      root: true,
      attributes: {
        "server.mode": serverConfig.mode,
        "server.port": serverConfig.port,
        "server.host": serverConfig.host ?? "default",
      },
    }),
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
      // Forked so a slow fetch or pull never delays startup; it catches and logs its own failures.
      yield* runStartupPhase("projects.auto-pull", autoPullProjectsAtStartup).pipe(
        Effect.forkScoped,
      );
      yield* Effect.logDebug("startup phase: complete");
      yield* Effect.sync(flushCompileCache);
      // Flush again once lazily imported modules have loaded, since Windows force-kills on quit.
      yield* Effect.sleep("30 seconds").pipe(
        Effect.andThen(Effect.sync(flushCompileCache)),
        Effect.forkScoped,
      );
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
