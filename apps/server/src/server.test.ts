import { request as httpRequest } from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CheckpointRef,
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  EventId,
  GitCommandError,
  KeybindingRule,
  OpenError,
  TerminalNotRunningError,
  type OrchestrationEvent,
  type TerminalEvent,
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  ResolvedKeybindingRule,
  ThreadId,
  TurnId,
  ServerSettingsError,
  WS_METHODS,
  WsRpcGroup,
  EditorId,
} from "@piedpiper/contracts";
import { assert, describe, it } from "@effect/vitest";
import { assertFailure, assertInclude, assertTrue } from "@effect/vitest/utils";
import {
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Logger,
  Option,
  Path,
  PubSub,
  References,
  Stream,
  Tracer,
} from "effect";
import * as Latch from "effect/Latch";
import {
  HttpBody,
  HttpClient,
  HttpClientResponse,
  HttpRouter,
  HttpServer,
} from "effect/unstable/http";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";

import type { ServerConfigShape } from "./config.ts";
import {
  DEFAULT_OTLP_EXPORT_OPTIONS_BY_SIGNAL,
  deriveServerPaths,
  ServerConfig,
} from "./config.ts";
import { EventLoopMonitor, type EventLoopMonitorShape } from "./observability/EventLoopMonitor.ts";
import type { OtlpTraceRecord } from "./observability/OtlpTraceRecord.ts";
import { BrowserTraceCollector } from "./observability/Services/BrowserTraceCollector.ts";
import { makeRoutesLayer } from "./server.ts";
import { untracedSensitiveRequestsLayer } from "./http.ts";
import { resolveAttachmentRelativePath } from "./attachmentPaths.ts";
import { MAX_WIRE_CHECKPOINT_FILES } from "./checkpointing/wireCheckpointFiles.ts";
import {
  CheckpointDiffQuery,
  type CheckpointDiffQueryShape,
} from "./checkpointing/Services/CheckpointDiffQuery.ts";
import { GitCore, type GitCoreShape } from "./git/Services/GitCore.ts";
import { GitHubCli, type GitHubCliShape } from "./git/Services/GitHubCli.ts";
import { GitManager, type GitManagerShape } from "./git/Services/GitManager.ts";
import { Keybindings, type KeybindingsShape } from "./keybindings.ts";
import { Open, type OpenShape } from "./open.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "./orchestration/Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import { PersistenceSqlError, toPersistenceSqlError } from "./persistence/Errors.ts";
import {
  ClaudeSlashCommands,
  type ClaudeSlashCommandsShape,
} from "./provider/Services/ClaudeSlashCommands.ts";
import {
  ProviderRegistry,
  type ProviderRegistryShape,
} from "./provider/Services/ProviderRegistry.ts";
import { ProviderService, type ProviderServiceShape } from "./provider/Services/ProviderService.ts";
import { ServerLifecycleEvents, type ServerLifecycleEventsShape } from "./serverLifecycleEvents.ts";
import { ServerRuntimeStartup, type ServerRuntimeStartupShape } from "./serverRuntimeStartup.ts";
import { ServerSettingsService, type ServerSettingsShape } from "./serverSettings.ts";
import { TerminalManager, type TerminalManagerShape } from "./terminal/Services/Manager.ts";
import { ProjectConfigFileLoaderLive } from "./project/Layers/ProjectConfigFileLoader.ts";
import { ProjectFaviconResolverLive } from "./project/Layers/ProjectFaviconResolver.ts";
import { WorkspaceEntriesLive } from "./workspace/Layers/WorkspaceEntries.ts";
import { WorkspaceFileSystemLive } from "./workspace/Layers/WorkspaceFileSystem.ts";
import { WorkspacePathsLive } from "./workspace/Layers/WorkspacePaths.ts";
import { fromContractReadModel } from "./orchestration/ServerReadModel.ts";

const defaultProjectId = ProjectId.makeUnsafe("project-default");
const defaultThreadId = ThreadId.makeUnsafe("thread-default");
const defaultModelSelection = {
  provider: "codex",
  model: "gpt-5-codex",
} as const;

const makeDefaultOrchestrationReadModel = () => {
  const now = new Date().toISOString();
  return {
    snapshotSequence: 0,
    updatedAt: now,
    projects: [
      {
        id: defaultProjectId,
        title: "Default Project",
        workspaceRoot: "/tmp/default-project",
        defaultModelSelection,
        scripts: [],
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
    ],
    threads: [
      {
        id: defaultThreadId,
        projectId: defaultProjectId,
        title: "Default Thread",
        modelSelection: defaultModelSelection,
        interactionMode: "default" as const,
        runtimeMode: "full-access" as const,
        branch: null,
        worktreePath: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        latestTurn: null,
        messages: [],
        session: null,
        activities: [],
        proposedPlans: [],
        checkpoints: [],
        deletedAt: null,
      },
    ],
  };
};

// Answers the favicon route's registration lookup for exactly one workspace root.
const makeRegisteredProjectQuery = (
  workspaceRoot: string,
  lookups: Array<string> = [],
  faviconPath: string | null = null,
): Partial<ProjectionSnapshotQueryShape> => ({
  getActiveProjectByWorkspaceRoot: (root) =>
    Effect.sync(() => {
      lookups.push(root);
      const project = makeDefaultOrchestrationReadModel().projects[0]!;
      return root === workspaceRoot
        ? Option.some({ ...project, workspaceRoot, faviconPath })
        : Option.none();
    }),
  getSnapshot: () => Effect.die("favicon route must not hydrate the full snapshot"),
});

// Captures every log line with its annotations, as the HTTP access logger would emit it.
const makeCapturingLogger = (lines: Array<string>) =>
  Logger.make((options) => {
    lines.push(
      JSON.stringify({
        message: options.message,
        annotations: options.fiber.getRef(References.CurrentLogAnnotations),
      }),
    );
  });

const makeWorkspaceAndProjectServicesLayer = (gitCoreLayer: Layer.Layer<GitCore>) => {
  const workspaceEntriesLayer = WorkspaceEntriesLive.pipe(
    Layer.provide(WorkspacePathsLive),
    Layer.provideMerge(gitCoreLayer),
  );
  return Layer.mergeAll(
    WorkspacePathsLive,
    workspaceEntriesLayer,
    WorkspaceFileSystemLive.pipe(
      Layer.provide(WorkspacePathsLive),
      Layer.provide(workspaceEntriesLayer),
    ),
    ProjectFaviconResolverLive,
    ProjectConfigFileLoaderLive,
  );
};

// Records every span the HTTP tracer middleware opens for a request.
const makeRecordingTracer = (spans: Array<Tracer.NativeSpan>) =>
  Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      spans.push(span);
      return span;
    },
  });

const buildAppUnderTest = (options?: {
  config?: Partial<ServerConfigShape>;
  recordSpans?: Array<Tracer.NativeSpan>;
  /** Enables the HTTP access logger and captures its output. */
  captureHttpLogs?: Array<string>;
  /** Captures spans posted to the browser trace route. */
  captureBrowserTraces?: Array<OtlpTraceRecord>;
  /** Replaces the HTTP client the server uses for outgoing requests. */
  serverHttpClient?: HttpClient.HttpClient;
  layers?: {
    keybindings?: Partial<KeybindingsShape>;
    providerRegistry?: Partial<ProviderRegistryShape>;
    claudeSlashCommands?: Partial<ClaudeSlashCommandsShape>;
    serverSettings?: Partial<ServerSettingsShape>;
    open?: Partial<OpenShape>;
    gitCore?: Partial<GitCoreShape>;
    gitHubCli?: Partial<GitHubCliShape>;
    gitManager?: Partial<GitManagerShape>;
    terminalManager?: Partial<TerminalManagerShape>;
    providerService?: Partial<ProviderServiceShape>;
    orchestrationEngine?: Partial<OrchestrationEngineShape>;
    projectionSnapshotQuery?: Partial<ProjectionSnapshotQueryShape>;
    checkpointDiffQuery?: Partial<CheckpointDiffQueryShape>;
    serverLifecycleEvents?: Partial<ServerLifecycleEventsShape>;
    serverRuntimeStartup?: Partial<ServerRuntimeStartupShape>;
    eventLoopMonitor?: EventLoopMonitorShape;
  };
}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const tempBaseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "piedpiper-router-test-",
    });
    const baseDir = options?.config?.baseDir ?? tempBaseDir;
    const devUrl = options?.config?.devUrl;
    const derivedPaths = yield* deriveServerPaths(baseDir, devUrl);
    const config: ServerConfigShape = {
      logLevel: "Info",
      traceMinLevel: "Info",
      traceTimingEnabled: true,
      traceBatchWindowMs: 1_000,
      traceMaxBytes: 10 * 1024 * 1024,
      traceMaxFiles: 10,
      otlpTracesUrl: undefined,
      otlpMetricsUrl: undefined,
      otlpLogsUrl: undefined,
      otlpExportOptions: DEFAULT_OTLP_EXPORT_OPTIONS_BY_SIGNAL,
      otlpExportIntervalMs: 10_000,
      otlpServiceName: "piedpiper-server",
      mode: "web",
      port: 0,
      host: "127.0.0.1",
      cwd: process.cwd(),
      baseDir,
      ...derivedPaths,
      staticDir: undefined,
      devUrl,
      noBrowser: true,
      authToken: undefined,
      autoBootstrapProjectFromCwd: false,
      logWebSocketEvents: false,
      shellEnvironmentPrepared: false,
      ...options?.config,
    };
    const layerConfig = Layer.succeed(ServerConfig, config);
    const gitCoreLayer = Layer.mock(GitCore)({
      isInsideWorkTree: () => Effect.succeed(false),
      listWorkspaceFiles: () => Effect.succeed({ paths: [], truncated: false }),
      filterIgnoredPaths: (_cwd, relativePaths) => Effect.succeed(relativePaths),
      ...options?.layers?.gitCore,
    });

    const tracingLayer =
      options?.recordSpans !== undefined
        ? Layer.mergeAll(
            untracedSensitiveRequestsLayer,
            Layer.succeed(Tracer.Tracer, makeRecordingTracer(options.recordSpans)),
          )
        : Layer.empty;
    const loggingLayer =
      options?.captureHttpLogs !== undefined
        ? Logger.layer([makeCapturingLogger(options.captureHttpLogs)])
        : Layer.empty;

    const captureBrowserTraces = options?.captureBrowserTraces;
    const browserTraceLayer =
      captureBrowserTraces !== undefined
        ? Layer.succeed(BrowserTraceCollector, {
            record: (records) => Effect.sync(() => void captureBrowserTraces.push(...records)),
          })
        : Layer.empty;
    const serverHttpClientLayer =
      options?.serverHttpClient !== undefined
        ? Layer.succeed(HttpClient.HttpClient, options.serverHttpClient)
        : Layer.empty;

    const appLayer = HttpRouter.serve(makeRoutesLayer, {
      disableListenLog: true,
      disableLogger: options?.captureHttpLogs === undefined,
    }).pipe(
      Layer.provide(tracingLayer),
      Layer.provide(browserTraceLayer),
      Layer.provide(serverHttpClientLayer),
      Layer.provide(loggingLayer),
      Layer.provide(
        Layer.mock(Keybindings)({
          streamChanges: Stream.empty,
          ...options?.layers?.keybindings,
        }),
      ),
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProviderRegistry)({
            getProviders: Effect.succeed([]),
            refresh: () => Effect.succeed([]),
            streamChanges: Stream.empty,
            ...options?.layers?.providerRegistry,
          }),
          Layer.mock(ClaudeSlashCommands)({
            list: () => Effect.succeed({ commands: [], pending: false }),
            ...options?.layers?.claudeSlashCommands,
          }),
          options?.layers?.eventLoopMonitor !== undefined
            ? Layer.succeed(EventLoopMonitor, options.layers.eventLoopMonitor)
            : Layer.empty,
        ),
      ),
      Layer.provide(
        Layer.mock(ProviderService)({
          ...options?.layers?.providerService,
        }),
      ),
      Layer.provide(
        Layer.mock(ServerSettingsService)({
          start: Effect.void,
          ready: Effect.void,
          getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
          updateSettings: () => Effect.succeed(DEFAULT_SERVER_SETTINGS),
          streamChanges: Stream.empty,
          ...options?.layers?.serverSettings,
        }),
      ),
      Layer.provide(
        Layer.mock(Open)({
          ...options?.layers?.open,
        }),
      ),
      Layer.provide(gitCoreLayer),
      Layer.provide(
        Layer.mock(GitHubCli)({
          ...options?.layers?.gitHubCli,
        }),
      ),
      Layer.provide(
        Layer.mock(GitManager)({
          ...options?.layers?.gitManager,
        }),
      ),
      Layer.provide(
        Layer.mock(TerminalManager)({
          detach: () => Effect.void,
          detachClient: () => Effect.void,
          ...options?.layers?.terminalManager,
        }),
      ),
      Layer.provide(
        Layer.mock(OrchestrationEngineService)({
          getReadModel: () =>
            Effect.succeed(fromContractReadModel(makeDefaultOrchestrationReadModel())),
          readEvents: () => Stream.empty,
          dispatch: () => Effect.succeed({ sequence: 0 }),
          streamDomainEvents: Stream.empty,
          subscribeDomainEvents: () =>
            PubSub.unbounded<OrchestrationEvent>().pipe(Effect.flatMap(PubSub.subscribe)),
          ...options?.layers?.orchestrationEngine,
        }),
      ),
      Layer.provide(
        Layer.mock(ProjectionSnapshotQuery)({
          getSnapshot: () => Effect.succeed(makeDefaultOrchestrationReadModel()),
          getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
          ...options?.layers?.projectionSnapshotQuery,
        }),
      ),
      Layer.provide(
        Layer.mock(CheckpointDiffQuery)({
          getTurnDiff: () =>
            Effect.succeed({
              threadId: defaultThreadId,
              fromTurnCount: 0,
              toTurnCount: 0,
              diff: "",
            }),
          getFullThreadDiff: () =>
            Effect.succeed({
              threadId: defaultThreadId,
              fromTurnCount: 0,
              toTurnCount: 0,
              diff: "",
            }),
          ...options?.layers?.checkpointDiffQuery,
        }),
      ),
      Layer.provide(
        Layer.mock(ServerLifecycleEvents)({
          publish: (event) => Effect.succeed({ ...(event as any), sequence: 1 }),
          snapshot: Effect.succeed({ sequence: 0, events: [] }),
          stream: Stream.empty,
          ...options?.layers?.serverLifecycleEvents,
        }),
      ),
      Layer.provide(
        Layer.mock(ServerRuntimeStartup)({
          awaitCommandReady: Effect.void,
          markHttpListening: Effect.void,
          enqueueCommand: (effect) => effect,
          ...options?.layers?.serverRuntimeStartup,
        }),
      ),
      Layer.provide(makeWorkspaceAndProjectServicesLayer(gitCoreLayer)),
      Layer.provide(layerConfig),
    );

    yield* Layer.build(appLayer);
    return config;
  });

const wsRpcProtocolLayer = (wsUrl: string) =>
  RpcClient.layerProtocolSocket().pipe(
    Layer.provide(NodeSocket.layerWebSocket(wsUrl)),
    Layer.provide(RpcSerialization.layerJson),
  );

const makeWsRpcClient = RpcClient.make(WsRpcGroup);
type WsRpcClient =
  typeof makeWsRpcClient extends Effect.Effect<infer Client, any, any> ? Client : never;

const withWsRpcClient = <A, E, R>(
  wsUrl: string,
  f: (client: WsRpcClient) => Effect.Effect<A, E, R>,
) => makeWsRpcClient.pipe(Effect.flatMap(f), Effect.provide(wsRpcProtocolLayer(wsUrl)));

const getHttpServerUrl = (pathname = "") =>
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer;
    const address = server.address as HttpServer.TcpAddress;
    return `http://127.0.0.1:${address.port}${pathname}`;
  });

// Raw request so forbidden fetch headers (Host, Upgrade) reach the server verbatim.
const rawHttpStatus = (url: string, headers: Record<string, string>) =>
  Effect.promise(
    () =>
      new Promise<number>((resolve, reject) => {
        const req = httpRequest(url, { method: "GET", headers }, (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        });
        req.on("upgrade", (res, socket) => {
          socket.destroy();
          resolve(res.statusCode ?? 101);
        });
        req.on("error", reject);
        req.end();
      }),
  );

const getWsServerUrl = (pathname = "") =>
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer;
    const address = server.address as HttpServer.TcpAddress;
    return `ws://127.0.0.1:${address.port}${pathname}`;
  });

it.layer(NodeServices.layer)("server router seam", (it) => {
  it.effect("negotiates compression only with WebSocket clients that offer it", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();
      const url = yield* getWsServerUrl("/ws");
      const connect = (perMessageDeflate: boolean) =>
        Effect.acquireRelease(
          Effect.callback<NodeSocket.NodeWS.WebSocket, Error>((resume) => {
            const socket = new NodeSocket.NodeWS.WebSocket(url, { perMessageDeflate });
            socket.once("open", () => resume(Effect.succeed(socket)));
            socket.once("error", (error) => resume(Effect.fail(error)));
          }),
          (socket) => Effect.sync(() => socket.close()),
        );
      assert.include((yield* connect(true)).extensions, "permessage-deflate");
      assert.notInclude((yield* connect(false)).extensions, "permessage-deflate");
    }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("cancels disconnected RPCs before waiting for terminal cleanup", () =>
    Effect.gen(function* () {
      const started = yield* Latch.make();
      const cancelled = yield* Latch.make();
      yield* buildAppUnderTest({
        layers: {
          terminalManager: {
            open: () =>
              started.open.pipe(Effect.andThen(Effect.never), Effect.ensuring(cancelled.open)),
            // Models cleanup waiting for a lock held by the in-flight open call.
            detachClient: () => cancelled.await,
          },
        },
      });
      const url = yield* getWsServerUrl("/ws");
      const socket = yield* Effect.acquireRelease(
        Effect.callback<NodeSocket.NodeWS.WebSocket, Error>((resume) => {
          const socket = new NodeSocket.NodeWS.WebSocket(url);
          socket.once("open", () => resume(Effect.succeed(socket)));
          socket.once("error", (error) => resume(Effect.fail(error)));
        }),
        (socket) => Effect.sync(() => socket.close()),
      );
      socket.send(
        JSON.stringify({
          _tag: "Request",
          id: "1",
          tag: WS_METHODS.terminalOpen,
          headers: [],
          payload: {
            threadId: "thread-1",
            terminalId: "default",
            cwd: "/tmp/project",
            viewerId: "viewer",
          },
        }),
      );
      yield* started.await.pipe(Effect.timeout("5 seconds"));
      socket.close();
      yield* cancelled.await.pipe(Effect.timeout("5 seconds"));
    }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("serves static index content for GET / when staticDir is configured", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const staticDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "piedpiper-router-static-",
      });
      const indexPath = path.join(staticDir, "index.html");
      yield* fileSystem.writeFileString(indexPath, "<html>router-static-ok</html>");

      yield* buildAppUnderTest({ config: { staticDir } });

      const response = yield* HttpClient.get("/");
      assert.equal(response.status, 200);
      assert.include(yield* response.text, "router-static-ok");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("redirects to dev URL when configured", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        config: { devUrl: new URL("http://127.0.0.1:5173") },
      });

      const url = yield* getHttpServerUrl("/foo/bar");
      const response = yield* Effect.promise(() => fetch(url, { redirect: "manual" }));

      assert.equal(response.status, 302);
      assert.equal(response.headers.get("location"), "http://127.0.0.1:5173/foo/bar");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("serves project favicon requests before the dev URL redirect", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const projectDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "piedpiper-router-project-favicon-",
      });
      yield* fileSystem.writeFileString(
        path.join(projectDir, "favicon.svg"),
        "<svg>router-project-favicon</svg>",
      );

      yield* buildAppUnderTest({
        config: { devUrl: new URL("http://127.0.0.1:5173") },
        layers: {
          projectionSnapshotQuery: makeRegisteredProjectQuery(projectDir),
        },
      });

      const response = yield* HttpClient.get(
        `/api/project-favicon?cwd=${encodeURIComponent(projectDir)}`,
      );

      assert.equal(response.status, 200);
      assert.equal(yield* response.text, "<svg>router-project-favicon</svg>");
      assert.equal(
        response.headers["content-security-policy"],
        "sandbox; default-src 'none'; style-src 'unsafe-inline'",
      );
      assert.equal(response.headers["x-content-type-options"], "nosniff");
      assert.equal(response.headers["content-disposition"], "inline");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("serves a project's chosen favicon from outside its workspace", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const projectDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "piedpiper-router-project-favicon-chosen-",
      });
      const outsideDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "piedpiper-router-project-favicon-outside-",
      });
      const chosen = path.join(outsideDir, "chosen.svg");
      yield* fileSystem.writeFileString(chosen, "<svg>chosen</svg>");
      yield* fileSystem.writeFileString(path.join(projectDir, "favicon.svg"), "<svg>found</svg>");

      yield* buildAppUnderTest({
        layers: { projectionSnapshotQuery: makeRegisteredProjectQuery(projectDir, [], chosen) },
      });

      const response = yield* HttpClient.get(
        `/api/project-favicon?cwd=${encodeURIComponent(projectDir)}`,
      );

      assert.equal(response.status, 200);
      assert.equal(yield* response.text, "<svg>chosen</svg>");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("does not let a chosen favicon be cached, unlike a discovered one", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const projectDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "piedpiper-router-project-favicon-cache-",
      });
      const chosen = path.join(projectDir, "chosen.svg");
      yield* fileSystem.writeFileString(chosen, "<svg>chosen</svg>");
      yield* fileSystem.writeFileString(path.join(projectDir, "favicon.svg"), "<svg>found</svg>");
      const get = HttpClient.get(`/api/project-favicon?cwd=${encodeURIComponent(projectDir)}`);

      yield* buildAppUnderTest({
        layers: { projectionSnapshotQuery: makeRegisteredProjectQuery(projectDir, [], chosen) },
      });
      assert.equal((yield* get).headers["cache-control"], "no-cache");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("keeps a chosen favicon uncached when its file is gone and discovery answers", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const projectDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "piedpiper-router-project-favicon-missing-",
      });
      yield* fileSystem.writeFileString(path.join(projectDir, "favicon.svg"), "<svg>found</svg>");
      const chosen = path.join(projectDir, "gone.svg");

      yield* buildAppUnderTest({
        layers: { projectionSnapshotQuery: makeRegisteredProjectQuery(projectDir, [], chosen) },
      });
      const response = yield* HttpClient.get(
        `/api/project-favicon?cwd=${encodeURIComponent(projectDir)}`,
      );
      assert.equal(response.headers["cache-control"], "no-cache");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("caches a discovered favicon for an hour", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const projectDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "piedpiper-router-project-favicon-discovered-",
      });
      yield* fileSystem.writeFileString(path.join(projectDir, "favicon.svg"), "<svg>found</svg>");

      yield* buildAppUnderTest({
        layers: { projectionSnapshotQuery: makeRegisteredProjectQuery(projectDir) },
      });
      const response = yield* HttpClient.get(
        `/api/project-favicon?cwd=${encodeURIComponent(projectDir)}`,
      );
      assert.equal(response.headers["cache-control"], "public, max-age=3600");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("falls back to discovery when a project's chosen favicon is not an image", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const projectDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "piedpiper-router-project-favicon-non-image-",
      });
      const outsideDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "piedpiper-router-project-favicon-secret-",
      });
      const notAnImage = path.join(outsideDir, "secrets.txt");
      yield* fileSystem.writeFileString(notAnImage, "secret");
      yield* fileSystem.writeFileString(path.join(projectDir, "favicon.svg"), "<svg>found</svg>");

      yield* buildAppUnderTest({
        layers: { projectionSnapshotQuery: makeRegisteredProjectQuery(projectDir, [], notAnImage) },
      });

      const response = yield* HttpClient.get(
        `/api/project-favicon?cwd=${encodeURIComponent(projectDir)}`,
      );

      assert.equal(response.status, 200);
      assert.equal(yield* response.text, "<svg>found</svg>");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("serves the embedded PNG of an .icns project icon as image/png", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const projectDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "piedpiper-router-project-favicon-icns-",
      });
      const png = new Uint8Array(24);
      const pngView = new DataView(png.buffer);
      pngView.setUint32(0, 0x89504e47);
      pngView.setUint32(4, 0x0d0a1a0a);
      pngView.setUint32(12, 0x49484452); // "IHDR"
      pngView.setUint32(16, 128);
      pngView.setUint32(20, 128);
      const icns = new Uint8Array(16 + png.length);
      const icnsView = new DataView(icns.buffer);
      icnsView.setUint32(0, 0x69636e73); // "icns"
      icnsView.setUint32(4, icns.length);
      icnsView.setUint32(8, 0x69633037); // "ic07"
      icnsView.setUint32(12, 8 + png.length);
      icns.set(png, 16);
      yield* fileSystem.makeDirectory(path.join(projectDir, "Resources"), { recursive: true });
      yield* fileSystem.writeFile(path.join(projectDir, "Resources", "AppIcon.icns"), icns);

      yield* buildAppUnderTest({
        layers: { projectionSnapshotQuery: makeRegisteredProjectQuery(projectDir) },
      });

      const response = yield* HttpClient.get(
        `/api/project-favicon?cwd=${encodeURIComponent(projectDir)}`,
      );

      assert.equal(response.status, 200);
      assert.equal(response.headers["content-type"], "image/png");
      assert.isUndefined(response.headers["content-security-policy"]);
      assert.deepEqual(new Uint8Array(yield* response.arrayBuffer), png);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("returns 404 for the project favicon when cwd is not a registered project", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const projectDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "piedpiper-router-project-favicon-unregistered-",
      });
      yield* fileSystem.writeFileString(path.join(projectDir, "favicon.svg"), "<svg>secret</svg>");

      yield* buildAppUnderTest();

      const response = yield* HttpClient.get(
        `/api/project-favicon?cwd=${encodeURIComponent(projectDir)}`,
      );

      assert.equal(response.status, 404);
      assert.equal(response.headers["cache-control"], "no-store");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("answers 503 without caching when the project lookup fails", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        layers: {
          projectionSnapshotQuery: {
            getActiveProjectByWorkspaceRoot: () =>
              Effect.fail(
                new PersistenceSqlError({
                  operation: "ProjectionSnapshotQuery.getActiveProjectByWorkspaceRoot:query",
                  detail: "database is locked",
                }),
              ),
          },
        },
      });

      const response = yield* HttpClient.get("/api/project-favicon?cwd=%2Ftmp%2Fproject");

      assert.equal(response.status, 503);
      assert.equal(response.headers["cache-control"], "no-store");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("looks up the favicon project by its resolved root when the raw cwd misses", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const projectDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "piedpiper-router-project-favicon-trailing-",
      });
      const lookups: Array<string> = [];
      yield* buildAppUnderTest({
        layers: { projectionSnapshotQuery: makeRegisteredProjectQuery(projectDir, lookups) },
      });

      const response = yield* HttpClient.get(
        `/api/project-favicon?cwd=${encodeURIComponent(`${projectDir}/`)}`,
      );

      // Registered but without an icon file: the long-lived "no favicon" cache applies.
      assert.equal(response.status, 404);
      assert.equal(response.headers["cache-control"], "public, max-age=3600");
      assert.deepEqual(lookups, [`${projectDir}/`, projectDir]);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("accepts the explicit non-loopback bind host as an Origin", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({ config: { authToken: "secret-token", host: "100.64.0.5" } });

      const url = yield* getHttpServerUrl("/attachments/some-id?token=secret-token");
      const sameHost = yield* rawHttpStatus(url, {
        host: "100.64.0.5:3773",
        origin: "http://100.64.0.5:3773",
      });
      assert.equal(sameHost, 404);

      const foreign = yield* rawHttpStatus(url, {
        host: "100.64.0.5:3773",
        origin: "https://evil.example",
      });
      assert.equal(foreign, 403);

      const wsSameHost = yield* rawHttpStatus(yield* getHttpServerUrl("/ws?token=secret-token"), {
        host: "100.64.0.5:3773",
        origin: "http://100.64.0.5:3773",
      });
      assert.notEqual(wsSameHost, 403);

      const wsForeign = yield* rawHttpStatus(yield* getHttpServerUrl("/ws?token=secret-token"), {
        host: "100.64.0.5:3773",
        origin: "http://100.64.0.6:3773",
      });
      assert.equal(wsForeign, 403);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  describe("browser trace route", () => {
    const tracesPath = "/api/observability/v1/traces";
    const payload = {
      resourceSpans: [
        {
          resource: {
            attributes: [{ key: "service.name", value: { stringValue: "piedpiper-web" } }],
          },
          scopeSpans: [
            {
              scope: { name: "piedpiper-web" },
              spans: [
                {
                  traceId: "trace-1",
                  spanId: "client-span",
                  name: "RpcClient.server.getConfig",
                  kind: 3,
                  startTimeUnixNano: "1000000000",
                  endTimeUnixNano: "2000000000",
                  attributes: [],
                  events: [],
                  links: [],
                  status: { code: 1 },
                },
              ],
            },
          ],
        },
      ],
    };

    const post = (body: string, headers: Record<string, string> = {}, path = tracesPath) =>
      HttpClient.post(path, {
        body: HttpBody.text(body, "application/json"),
        headers,
      });

    it.effect("requires the bearer token and ignores it in the query string", () =>
      Effect.gen(function* () {
        const records: Array<OtlpTraceRecord> = [];
        yield* buildAppUnderTest({
          config: { authToken: "secret-token" },
          captureBrowserTraces: records,
        });
        const body = JSON.stringify(payload);

        assert.equal((yield* post(body)).status, 401);
        assert.equal((yield* post(body, { authorization: "Bearer wrong" })).status, 401);
        assert.equal((yield* post(body, {}, `${tracesPath}?token=secret-token`)).status, 401);
        assert.deepEqual(records, []);

        const accepted = yield* post(body, { authorization: "Bearer secret-token" });
        assert.equal(accepted.status, 204);
        assert.equal(records.length, 1);
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
    );

    it.effect("follows the minimum trace level, as server spans do", () =>
      Effect.gen(function* () {
        const records: Array<OtlpTraceRecord> = [];
        yield* buildAppUnderTest({
          config: { traceMinLevel: "None" },
          captureBrowserTraces: records,
        });
        assert.equal((yield* post(JSON.stringify(payload))).status, 204);
        assert.deepEqual(records, []);
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
    );

    it.effect("records decoded spans on the collector", () =>
      Effect.gen(function* () {
        const records: Array<OtlpTraceRecord> = [];
        yield* buildAppUnderTest({ captureBrowserTraces: records });

        const response = yield* post(JSON.stringify(payload));

        assert.equal(response.status, 204);
        assert.equal(records[0]?.spanId, "client-span");
        assert.equal(records[0]?.kind, "client");
        assert.equal(records[0]?.durationMs, 1000);
        assert.deepEqual(records[0]?.resourceAttributes, { "service.name": "piedpiper-web" });
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
    );

    it.effect("rejects malformed and oversized bodies without logging them", () =>
      Effect.gen(function* () {
        const records: Array<OtlpTraceRecord> = [];
        const logs: Array<string> = [];
        yield* buildAppUnderTest({ captureBrowserTraces: records, captureHttpLogs: logs });
        const url = yield* getHttpServerUrl();

        assert.equal((yield* post("{not json SENTINEL-BODY")).status, 400);
        assert.equal((yield* post(`{"resourceSpans":"SENTINEL-BODY"}`)).status, 400);
        // Streamed so Content-Length cannot help; the server hangs up mid-upload, so a reset also counts.
        const oversized = yield* HttpClient.post(tracesPath, {
          body: HttpBody.stream(
            Stream.make(new Uint8Array(3 * 1024 * 1024), new Uint8Array(3 * 1024 * 1024)),
            "application/json",
          ),
        }).pipe(
          Effect.map((response) => response.status),
          Effect.orElseSucceed(() => 413),
        );
        assert.equal(oversized, 413);
        // Headers only: the declared size alone must be enough to reject the request.
        const declaredOversized = yield* Effect.promise(
          () =>
            new Promise<number>((resolve, reject) => {
              const req = httpRequest(
                new URL(tracesPath, url),
                { method: "POST", headers: { "content-length": String(8 * 1024 * 1024) } },
                (res) => {
                  res.resume();
                  resolve(res.statusCode ?? 0);
                  req.destroy();
                },
              );
              req.on("error", reject);
              req.flushHeaders();
            }),
        );
        assert.equal(declaredOversized, 413);

        assert.deepEqual(records, []);
        assert.isTrue(logs.join("\n").includes("browser trace payload rejected"));
        assert.isFalse(logs.join("\n").includes("SENTINEL-BODY"));
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
    );

    it.effect("answers CORS preflights for allowed origins only", () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest({ config: { authToken: "secret-token" } });
        const preflight = (origin: string) =>
          HttpClient.options(tracesPath, {
            headers: {
              origin,
              "access-control-request-method": "POST",
              "access-control-request-headers": "authorization,content-type",
            },
          });

        const allowed = yield* preflight("piedpiper://app");
        assert.equal(allowed.status, 204);
        assert.equal(allowed.headers["access-control-allow-origin"], "piedpiper://app");
        assert.include(allowed.headers["access-control-allow-headers"], "authorization");
        assert.include(allowed.headers["access-control-allow-methods"], "POST");

        const denied = yield* preflight("https://evil.example");
        assert.equal(denied.status, 403);
        assert.isUndefined(denied.headers["access-control-allow-origin"]);

        const crossSitePost = yield* post(JSON.stringify(payload), {
          origin: "https://evil.example",
          authorization: "Bearer secret-token",
        });
        assert.equal(crossSitePost.status, 403);

        const devOriginPost = yield* post(JSON.stringify(payload), {
          origin: "http://localhost:5733",
          authorization: "Bearer secret-token",
        });
        assert.equal(devOriginPost.status, 204);
        assert.equal(devOriginPost.headers["access-control-allow-origin"], "http://localhost:5733");
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
    );

    it.effect("forwards to the OTLP collector with the configured headers", () =>
      Effect.gen(function* () {
        const forwarded: Array<{ url: string; authorization?: string; body: unknown }> = [];
        const records: Array<OtlpTraceRecord> = [];
        yield* buildAppUnderTest({
          captureBrowserTraces: records,
          config: {
            authToken: "secret-token",
            otlpTracesUrl: "http://collector.test/v1/traces",
            otlpExportOptions: {
              ...DEFAULT_OTLP_EXPORT_OPTIONS_BY_SIGNAL,
              traces: {
                ...DEFAULT_OTLP_EXPORT_OPTIONS_BY_SIGNAL.traces,
                headers: { authorization: "Bearer collector-key" },
              },
            },
          },
          serverHttpClient: HttpClient.make((request) =>
            Effect.sync(() => {
              const body = request.body as HttpBody.Uint8Array;
              const entry = {
                url: request.url,
                body: JSON.parse(new TextDecoder().decode(body.body)),
                ...(request.headers.authorization
                  ? { authorization: request.headers.authorization }
                  : {}),
              };
              forwarded.push(entry);
              return HttpClientResponse.fromWeb(request, new Response(null, { status: 200 }));
            }),
          ),
        });

        const response = yield* post(JSON.stringify(payload), {
          authorization: "Bearer secret-token",
        });

        assert.equal(response.status, 204);
        assert.equal(records.length, 1);
        assert.equal(forwarded.length, 1);
        assert.equal(forwarded[0]?.url, "http://collector.test/v1/traces");
        assert.equal(forwarded[0]?.authorization, "Bearer collector-key");
        assert.deepEqual(forwarded[0]?.body, payload);
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
    );

    it.effect("keeps local records and answers 204 when the forward fails", () =>
      Effect.gen(function* () {
        const records: Array<OtlpTraceRecord> = [];
        yield* buildAppUnderTest({
          captureBrowserTraces: records,
          config: { otlpTracesUrl: "http://collector.test/v1/traces" },
          serverHttpClient: HttpClient.make((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(request, new Response(null, { status: 503 })),
            ),
          ),
        });

        const response = yield* post(JSON.stringify(payload));

        assert.equal(response.status, 204);
        assert.equal(records.length, 1);
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
    );
  });

  it.effect("rejects token-protected routes from a non-loopback Origin or Host", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({ config: { authToken: "secret-token" } });

      const badOrigin = yield* HttpClient.get("/api/project-favicon?cwd=/tmp&token=secret-token", {
        headers: { origin: "https://evil.example" },
      });
      assert.equal(badOrigin.status, 403);

      const nullOrigin = yield* HttpClient.get("/api/project-favicon?cwd=/tmp&token=secret-token", {
        headers: { origin: "null" },
      });
      assert.equal(nullOrigin.status, 403);

      const rebound = yield* rawHttpStatus(
        yield* getHttpServerUrl("/attachments/some-id?token=secret-token"),
        { host: "attacker.example:3773" },
      );
      assert.equal(rebound, 403);

      const loopbackOrigin = yield* HttpClient.get("/attachments/some-id?token=secret-token", {
        headers: { origin: "http://localhost:5733" },
      });
      assert.equal(loopbackOrigin.status, 404);

      const desktopOrigin = yield* HttpClient.get("/attachments/some-id?token=secret-token", {
        headers: { origin: "piedpiper://app" },
      });
      assert.equal(desktopOrigin.status, 404);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("never accepts the auth token from a cookie", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({ config: { authToken: "secret-token" } });

      const missing = yield* HttpClient.get("/attachments/some-id");
      assert.equal(missing.status, 401);

      const withCookie = yield* HttpClient.get("/attachments/some-id", {
        headers: { cookie: "piedpiper_token=secret-token" },
      });
      assert.equal(withCookie.status, 401);

      // Another loopback port is same-site, so a cookie would ride along on its /ws upgrade.
      const wsWithCookie = yield* rawHttpStatus(yield* getHttpServerUrl("/ws"), {
        origin: "http://localhost:5999",
        cookie: "piedpiper_token=secret-token",
      });
      assert.equal(wsWithCookie, 401);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("keeps tokenized routes out of HTTP trace spans", () =>
    Effect.gen(function* () {
      const spans: Array<Tracer.NativeSpan> = [];
      yield* buildAppUnderTest({
        config: { authToken: "secret-token", devUrl: new URL("http://127.0.0.1:5173") },
        recordSpans: spans,
      });

      yield* HttpClient.get("/attachments/some-id?token=secret-token");
      yield* HttpClient.get("/api/project-favicon?cwd=%2Ftmp&token=secret-token");
      // Raw requests: the dev redirect must not be followed to a dev server that is not running.
      yield* rawHttpStatus(yield* getHttpServerUrl("/?token=secret-token"), {});
      yield* rawHttpStatus(yield* getHttpServerUrl("/healthz-like-plain-path"), {});

      const httpSpans = spans.filter((span) => span.kind === "server");
      assert.equal(httpSpans.length, 1);
      assert.equal(httpSpans[0]?.attributes.get("url.path"), "/healthz-like-plain-path");
      for (const span of spans) {
        for (const value of span.attributes.values()) {
          assertTrue(!String(value).includes("secret-token"), `token leaked into ${span.name}`);
        }
      }
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("keeps tokenized routes out of the HTTP access log", () =>
    Effect.gen(function* () {
      const lines: Array<string> = [];
      yield* buildAppUnderTest({
        config: { authToken: "secret-token", devUrl: new URL("http://127.0.0.1:5173") },
        captureHttpLogs: lines,
      });

      yield* HttpClient.get("/attachments/some-id?token=secret-token");
      yield* HttpClient.get("/api/project-favicon?cwd=%2Ftmp&token=secret-token");
      // Raw requests: the dev redirect must not be followed to a dev server that is not running.
      yield* rawHttpStatus(yield* getHttpServerUrl("/?token=secret-token"), {});
      yield* rawHttpStatus(yield* getHttpServerUrl("/ws?token=secret-token"), {});
      yield* rawHttpStatus(yield* getHttpServerUrl("/plain-path"), {});

      assertTrue(
        lines.some((line) => line.includes("/plain-path")),
        "access logger should still log ordinary requests",
      );
      for (const line of lines) {
        assertTrue(!line.includes("secret-token"), `token leaked into log line ${line}`);
      }
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("keeps the token on the dev URL redirect", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        config: { devUrl: new URL("http://127.0.0.1:5173"), authToken: "secret-token" },
      });

      const url = yield* getHttpServerUrl("/?token=secret-token");
      const response = yield* Effect.promise(() => fetch(url, { redirect: "manual" }));

      assert.equal(response.status, 302);
      assert.equal(response.headers.get("location"), "http://127.0.0.1:5173/?token=secret-token");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("returns 404 for the project favicon when no icon exists", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const projectDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "piedpiper-router-project-favicon-fallback-",
      });

      yield* buildAppUnderTest({
        config: { devUrl: new URL("http://127.0.0.1:5173") },
        layers: { projectionSnapshotQuery: makeRegisteredProjectQuery(projectDir) },
      });

      const response = yield* HttpClient.get(
        `/api/project-favicon?cwd=${encodeURIComponent(projectDir)}`,
      );

      assert.equal(response.status, 404);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("serves attachment files from state dir", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const attachmentId = "thread-11111111-1111-4111-8111-111111111111";

      const config = yield* buildAppUnderTest();
      const attachmentPath = resolveAttachmentRelativePath({
        attachmentsDir: config.attachmentsDir,
        relativePath: `${attachmentId}.bin`,
      });
      assert.isNotNull(attachmentPath, "Attachment path should be resolvable");

      yield* fileSystem.makeDirectory(path.dirname(attachmentPath), { recursive: true });
      yield* fileSystem.writeFileString(attachmentPath, "attachment-ok");

      const response = yield* HttpClient.get(`/attachments/${attachmentId}`);
      assert.equal(response.status, 200);
      assert.equal(yield* response.text, "attachment-ok");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("allows permitted cross-origin pages to read attachment files", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const attachmentId = "thread-11111111-1111-4111-8111-111111111111";

      const config = yield* buildAppUnderTest();
      const attachmentPath = resolveAttachmentRelativePath({
        attachmentsDir: config.attachmentsDir,
        relativePath: `${attachmentId}.png`,
      });
      assert.isNotNull(attachmentPath, "Attachment path should be resolvable");
      yield* fileSystem.makeDirectory(path.dirname(attachmentPath), { recursive: true });
      yield* fileSystem.writeFileString(attachmentPath, "attachment-ok");

      const withOrigin = yield* HttpClient.get(`/attachments/${attachmentId}`, {
        headers: { origin: "piedpiper://app" },
      });
      assert.equal(withOrigin.status, 200);
      assert.equal(withOrigin.headers["access-control-allow-origin"], "piedpiper://app");
      assert.equal(withOrigin.headers.vary, "Origin");

      const noOrigin = yield* HttpClient.get(`/attachments/${attachmentId}`);
      assert.equal(noOrigin.status, 200);
      assert.isUndefined(noOrigin.headers["access-control-allow-origin"]);
      // The browser cache must not answer a CORS fetch with this response.
      assert.equal(noOrigin.headers.vary, "Origin");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("mounts the workspace image route behind the auth token", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({ config: { authToken: "secret-token" } });

      const response = yield* HttpClient.get("/api/workspace-image?threadId=t&path=%2Fa.png");
      assert.equal(response.status, 401);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("serves attachment files for URL-encoded paths", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const config = yield* buildAppUnderTest();
      const attachmentPath = resolveAttachmentRelativePath({
        attachmentsDir: config.attachmentsDir,
        relativePath: "thread%20folder/message%20folder/file%20name.png",
      });
      assert.isNotNull(attachmentPath, "Attachment path should be resolvable");

      yield* fileSystem.makeDirectory(path.dirname(attachmentPath), { recursive: true });
      yield* fileSystem.writeFileString(attachmentPath, "attachment-encoded-ok");

      const response = yield* HttpClient.get(
        "/attachments/thread%20folder/message%20folder/file%20name.png",
      );
      assert.equal(response.status, 200);
      assert.equal(yield* response.text, "attachment-encoded-ok");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("returns 404 for missing attachment id lookups", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const response = yield* HttpClient.get(
        "/attachments/missing-11111111-1111-4111-8111-111111111111",
      );
      assert.equal(response.status, 404);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc server.upsertKeybinding", () =>
    Effect.gen(function* () {
      const rule: KeybindingRule = {
        command: "terminal.toggle",
        key: "ctrl+k",
      };
      const resolved: ResolvedKeybindingRule = {
        command: "terminal.toggle",
        shortcut: {
          key: "k",
          metaKey: false,
          ctrlKey: true,
          shiftKey: false,
          altKey: false,
          modKey: true,
        },
      };

      const issue = {
        kind: "keybindings.invalid-entry" as const,
        message: "unknown command",
        index: 0,
      };
      yield* buildAppUnderTest({
        layers: {
          keybindings: {
            upsertKeybindingRule: () => Effect.succeed([resolved]),
            getSnapshot: Effect.succeed({ keybindings: [resolved], issues: [issue] }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[WS_METHODS.serverUpsertKeybinding](rule)),
      );

      // Issues for undecodable entries kept on disk come back instead of a hardcoded [].
      assert.deepEqual(response.issues, [issue]);
      assert.deepEqual(response.keybindings, [resolved]);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("forwards the replaced rule on websocket rpc server.upsertKeybinding", () =>
    Effect.gen(function* () {
      const received: Array<unknown> = [];
      yield* buildAppUnderTest({
        layers: {
          keybindings: {
            upsertKeybindingRule: (input) =>
              Effect.sync(() => {
                received.push(input);
                return [];
              }),
            getSnapshot: Effect.succeed({ keybindings: [], issues: [] }),
          },
        },
      });

      const input = {
        command: "chat.new",
        key: "mod+shift+o",
        replace: { command: "chat.new", key: "mod+shift+n" },
      } as const;
      const wsUrl = yield* getWsServerUrl("/ws");
      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[WS_METHODS.serverUpsertKeybinding](input)),
      );

      assert.deepEqual(received, [input]);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc server.removeKeybinding", () =>
    Effect.gen(function* () {
      const rule: KeybindingRule = { command: "terminal.toggle", key: "ctrl+k" };
      const resolved: ResolvedKeybindingRule = {
        command: "terminal.toggle",
        shortcut: {
          key: "j",
          metaKey: false,
          ctrlKey: true,
          shiftKey: false,
          altKey: false,
          modKey: true,
        },
      };
      const removed: Array<KeybindingRule> = [];
      const issue = {
        kind: "keybindings.invalid-entry" as const,
        message: "unknown command",
        index: 0,
      };
      yield* buildAppUnderTest({
        layers: {
          keybindings: {
            removeKeybindingRule: (input) =>
              Effect.sync(() => {
                removed.push(input);
                return [];
              }),
            getSnapshot: Effect.succeed({ keybindings: [resolved], issues: [issue] }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[WS_METHODS.serverRemoveKeybinding](rule)),
      );

      assert.deepEqual(removed, [rule]);
      assert.deepEqual(response, { keybindings: [resolved], issues: [issue] });
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc server diagnostics methods", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const wsUrl = yield* getWsServerUrl("/ws");
      const { processes, signal, traces, otlp } = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.all({
            processes: client[WS_METHODS.serverGetProcessDiagnostics]({}),
            signal: client[WS_METHODS.serverSignalProcess]({
              pid: process.pid,
              signal: "SIGKILL",
            }),
            traces: client[WS_METHODS.serverGetTraceDiagnostics]({}),
            otlp: client[WS_METHODS.serverCheckOtlpEndpoint]({
              signal: "traces",
              url: "http://127.0.0.1:1/v1/traces",
            }),
          }),
        ),
      );

      assert.equal(processes.serverPid, process.pid);
      assert.equal(signal.signaled, false);
      assert.isAbove(traces.scannedFilePaths.length, 0);
      assert.deepEqual(otlp, { _tag: "Unreachable", timedOut: false });
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects websocket rpc handshake when auth token is missing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceDir = yield* fs.makeTempDirectoryScoped({
        prefix: "piedpiper-ws-auth-required-",
      });
      yield* fs.writeFileString(
        path.join(workspaceDir, "needle-file.ts"),
        "export const needle = 1;",
      );

      yield* buildAppUnderTest({
        config: {
          authToken: "secret-token",
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.projectsSearchEntries]({
            cwd: workspaceDir,
            query: "needle",
            limit: 10,
          }),
        ).pipe(Effect.result),
      );

      assertTrue(result._tag === "Failure");
      assertInclude(String(result.failure), "SocketOpenError");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects websocket rpc handshake from a non-loopback Origin even with a token", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({ config: { authToken: "secret-token" } });

      const url = yield* getHttpServerUrl("/ws?token=secret-token");
      const upgradeHeaders = {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      };
      const foreignOrigin = yield* rawHttpStatus(url, {
        ...upgradeHeaders,
        origin: "https://evil.example",
      });
      assert.equal(foreignOrigin, 403);

      const reboundHost = yield* rawHttpStatus(url, {
        ...upgradeHeaders,
        host: "attacker.example:3773",
      });
      assert.equal(reboundHost, 403);

      const loopbackOrigin = yield* rawHttpStatus(url, {
        ...upgradeHeaders,
        origin: "http://localhost:5733",
      });
      assert.equal(loopbackOrigin, 101);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("accepts websocket rpc handshake when auth token is provided", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceDir = yield* fs.makeTempDirectoryScoped({
        prefix: "piedpiper-ws-auth-ok-",
      });
      yield* fs.writeFileString(
        path.join(workspaceDir, "needle-file.ts"),
        "export const needle = 1;",
      );

      yield* buildAppUnderTest({
        config: {
          authToken: "secret-token",
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws?token=secret-token");
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.projectsSearchEntries]({
            cwd: workspaceDir,
            query: "needle",
            limit: 10,
          }),
        ),
      );

      assert.isAtLeast(response.entries.length, 1);
      assert.equal(response.truncated, false);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc projects.searchEntries excludes gitignored files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceDir = yield* fs.makeTempDirectoryScoped({
        prefix: "piedpiper-ws-search-gitignored-",
      });
      yield* fs.writeFileString(path.join(workspaceDir, ".gitignore"), ".venv/\n");
      yield* fs.makeDirectory(path.join(workspaceDir, ".venv", "lib"), { recursive: true });
      yield* fs.writeFileString(
        path.join(workspaceDir, ".venv", "lib", "ignored-search-target.ts"),
        "export const ignored = true;",
      );
      yield* fs.makeDirectory(path.join(workspaceDir, "src"), { recursive: true });
      yield* fs.writeFileString(
        path.join(workspaceDir, "src", "tracked.ts"),
        "export const ok = 1;",
      );

      yield* buildAppUnderTest({
        layers: {
          gitCore: {
            isInsideWorkTree: () => Effect.succeed(true),
            listWorkspaceFiles: () =>
              Effect.succeed({ paths: ["src/tracked.ts"], truncated: false }),
            filterIgnoredPaths: (_cwd, relativePaths) =>
              Effect.succeed(
                relativePaths.filter((relativePath) => !relativePath.startsWith(".venv/")),
              ),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const search = (query: string) =>
        Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.projectsSearchEntries]({ cwd: workspaceDir, query, limit: 10 }),
          ),
        );

      const ignored = yield* search("ignored-search-target");
      assert.equal(ignored.entries.length, 0);
      assert.equal(ignored.truncated, false);

      const tracked = yield* search("tracked");
      assert.deepEqual(
        tracked.entries.map((entry) => entry.path),
        ["src/tracked.ts"],
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc subscribeServerConfig streams snapshot then update", () =>
    Effect.gen(function* () {
      const providers = [] as const;
      const changeEvent = {
        keybindings: [],
        issues: [],
      } as const;

      yield* buildAppUnderTest({
        config: {
          otlpTracesUrl: "http://localhost:4318/v1/traces",
          otlpMetricsUrl: "http://localhost:4318/v1/metrics",
        },
        layers: {
          keybindings: {
            loadConfigState: Effect.succeed({
              keybindings: [],
              issues: [],
            }),
            streamChanges: Stream.succeed(changeEvent),
          },
          providerRegistry: {
            getProviders: Effect.succeed(providers),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const events = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.subscribeServerConfig]({}).pipe(Stream.take(2), Stream.runCollect),
        ),
      );

      const [first, second] = Array.from(events);
      assert.equal(first?.type, "snapshot");
      if (first?.type === "snapshot") {
        assert.equal(first.version, 1);
        assert.deepEqual(first.config.keybindings, []);
        assert.deepEqual(first.config.issues, []);
        assert.deepEqual(first.config.providers, providers);
        assert.equal(first.config.observability.logsDirectoryPath.endsWith("/logs"), true);
        assert.equal(first.config.observability.localTracingEnabled, true);
        assert.equal(first.config.observability.otlpTracesUrl, "http://localhost:4318/v1/traces");
        assert.equal(first.config.observability.otlpTracesEnabled, true);
        assert.equal(first.config.observability.otlpMetricsUrl, "http://localhost:4318/v1/metrics");
        assert.equal(first.config.observability.otlpMetricsEnabled, true);
        assert.deepEqual(first.config.settings, DEFAULT_SERVER_SETTINGS);
      }
      assert.deepEqual(second, {
        version: 1,
        type: "keybindingsUpdated",
        payload: { keybindings: [], issues: [] },
      });
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc subscribeServerConfig emits provider status updates", () =>
    Effect.gen(function* () {
      const providers = [] as const;

      yield* buildAppUnderTest({
        layers: {
          keybindings: {
            loadConfigState: Effect.succeed({
              keybindings: [],
              issues: [],
            }),
            streamChanges: Stream.empty,
          },
          providerRegistry: {
            getProviders: Effect.succeed([]),
            streamChanges: Stream.succeed(providers),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const events = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.subscribeServerConfig]({}).pipe(Stream.take(2), Stream.runCollect),
        ),
      );

      const [first, second] = Array.from(events);
      assert.equal(first?.type, "snapshot");
      assert.deepEqual(second, {
        version: 1,
        type: "providerStatuses",
        payload: { providers },
      });
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "routes websocket rpc subscribeServerConfig keeps changes published during the snapshot",
    () =>
      Effect.gen(function* () {
        const keybindingChanges = yield* PubSub.unbounded<{
          keybindings: never[];
          issues: never[];
        }>();
        const settingsChanges = yield* PubSub.unbounded<typeof DEFAULT_SERVER_SETTINGS>();

        yield* buildAppUnderTest({
          layers: {
            keybindings: {
              // Simulates a keybinding edit landing while the snapshot is loading.
              loadConfigState: PubSub.publish(keybindingChanges, {
                keybindings: [],
                issues: [],
              }).pipe(Effect.as({ keybindings: [], issues: [] })),
              streamChanges: Stream.fromPubSub(keybindingChanges),
            },
            serverSettings: {
              getSettings: PubSub.publish(settingsChanges, DEFAULT_SERVER_SETTINGS).pipe(
                Effect.as(DEFAULT_SERVER_SETTINGS),
              ),
              streamChanges: Stream.fromPubSub(settingsChanges),
            },
          },
        });

        const wsUrl = yield* getWsServerUrl("/ws");
        const events = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.subscribeServerConfig]({}).pipe(Stream.take(3), Stream.runCollect),
          ),
        ).pipe(Effect.timeout("5 seconds"));

        const types = Array.from(events).map((event) => event.type);
        assert.equal(types[0], "snapshot");
        assert.deepEqual(types.slice(1).toSorted(), ["keybindingsUpdated", "settingsUpdated"]);
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "routes websocket rpc projects.checkDirectoryExists against the in-memory read model",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "piedpiper-dir-check-",
        });
        const deletedRoot = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "piedpiper-dir-check-deleted-",
        });
        const base = makeDefaultOrchestrationReadModel();
        const project = base.projects[0]!;
        const readModel = {
          ...base,
          projects: [
            { ...project, workspaceRoot },
            {
              ...project,
              id: ProjectId.makeUnsafe("project-deleted"),
              workspaceRoot: deletedRoot,
              deletedAt: new Date().toISOString(),
            },
          ],
        };

        yield* buildAppUnderTest({
          layers: {
            orchestrationEngine: {
              getReadModel: () => Effect.succeed(fromContractReadModel(readModel)),
            },
            projectionSnapshotQuery: {
              getSnapshot: () => Effect.die("directory checks must not hydrate the snapshot"),
            },
          },
        });

        const wsUrl = yield* getWsServerUrl("/ws");
        const [inside, deleted, outside] = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            Effect.all([
              client[WS_METHODS.projectsCheckDirectoryExists]({ path: workspaceRoot }),
              client[WS_METHODS.projectsCheckDirectoryExists]({ path: deletedRoot }),
              client[WS_METHODS.projectsCheckDirectoryExists]({ path: process.cwd() }),
            ]),
          ),
        );

        assert.deepEqual(inside, { exists: true });
        assert.deepEqual(deleted, { exists: false });
        assert.deepEqual(outside, { exists: false });
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc projects.readConfigFile only for known workspaces", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "piedpiper-read-config-",
      });
      const outsideRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "piedpiper-read-config-outside-",
      });
      const configJson = JSON.stringify({ scripts: [{ name: "Test", command: "bun test" }] });
      yield* fileSystem.writeFileString(path.join(workspaceRoot, "piedpiper.json"), configJson);
      yield* fileSystem.writeFileString(path.join(outsideRoot, "piedpiper.json"), configJson);
      const base = makeDefaultOrchestrationReadModel();
      const readModel = {
        ...base,
        projects: [{ ...base.projects[0]!, workspaceRoot }],
      };

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            getReadModel: () => Effect.succeed(fromContractReadModel(readModel)),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const [inside, outside] = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.all([
            client[WS_METHODS.projectsReadConfigFile]({ cwd: workspaceRoot }),
            client[WS_METHODS.projectsReadConfigFile]({ cwd: outsideRoot }),
          ]),
        ),
      );

      assert.deepEqual(inside, { config: { scripts: [{ name: "Test", command: "bun test" }] } });
      assert.deepEqual(outside, { config: null });
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc projects.statPath to the path kind", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "piedpiper-stat-path-" });
      const filePath = path.join(dir, "notes.md");
      yield* fileSystem.writeFileString(filePath, "# notes");

      yield* buildAppUnderTest();

      const wsUrl = yield* getWsServerUrl("/ws");
      const [file, directory, missing, relative] = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.all([
            client[WS_METHODS.projectsStatPath]({ path: `${filePath}:3:1` }),
            client[WS_METHODS.projectsStatPath]({ path: dir }),
            client[WS_METHODS.projectsStatPath]({ path: path.join(dir, "absent.md") }),
            client[WS_METHODS.projectsStatPath]({ path: "notes.md" }),
          ]),
        ),
      );

      assert.deepEqual(file, { kind: "file" });
      assert.deepEqual(directory, { kind: "directory" });
      assert.deepEqual(missing, { kind: "missing" });
      assert.deepEqual(relative, { kind: "missing" });
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "routes websocket rpc projects.browseDirectories past a name with a trailing space",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "piedpiper-browse-space-",
        });
        yield* fileSystem.makeDirectory(path.join(dir, "foo "));
        yield* fileSystem.makeDirectory(path.join(dir, "foo"));

        yield* buildAppUnderTest();

        const wsUrl = yield* getWsServerUrl("/ws");
        const listing = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.projectsBrowseDirectories]({ partialPath: path.join(dir, "fo") }),
          ),
        );

        assert.deepEqual(
          listing.entries.map((entry) => entry.fullPath).toSorted(),
          [path.join(dir, "foo"), path.join(dir, "foo ")].toSorted(),
        );
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc projects.browseDirectories outside known workspaces", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "piedpiper-browse-rpc-" });
      yield* fileSystem.makeDirectory(path.join(dir, "alpha"));
      yield* fileSystem.makeDirectory(path.join(dir, "beta"));

      yield* buildAppUnderTest();

      const wsUrl = yield* getWsServerUrl("/ws");
      const [matched, relative] = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.all([
            client[WS_METHODS.projectsBrowseDirectories]({
              partialPath: path.join(dir, "al"),
            }),
            client[WS_METHODS.projectsBrowseDirectories]({ partialPath: "relative/path" }).pipe(
              Effect.flip,
            ),
          ]),
        ),
      );

      assert.deepEqual(
        matched.entries.map((entry) => entry.name),
        ["alpha"],
      );
      assert.equal(relative._tag, "ProjectBrowseDirectoriesError");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "routes websocket rpc subscribeServerLifecycle replays snapshot and streams updates",
    () =>
      Effect.gen(function* () {
        const lifecycleEvents = [
          {
            version: 1 as const,
            sequence: 1,
            type: "welcome" as const,
            payload: {
              cwd: "/tmp/project",
              projectName: "project",
            },
          },
        ] as const;
        const liveEvents = Stream.make({
          version: 1 as const,
          sequence: 2,
          type: "ready" as const,
          payload: { at: new Date().toISOString() },
        });

        yield* buildAppUnderTest({
          layers: {
            serverLifecycleEvents: {
              snapshot: Effect.succeed({
                sequence: 1,
                events: lifecycleEvents,
              }),
              stream: liveEvents,
            },
          },
        });

        const wsUrl = yield* getWsServerUrl("/ws");
        const events = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.subscribeServerLifecycle]({}).pipe(Stream.take(2), Stream.runCollect),
          ),
        );

        const [first, second] = Array.from(events);
        assert.equal(first?.type, "welcome");
        assert.equal(first?.sequence, 1);
        assert.equal(second?.type, "ready");
        assert.equal(second?.sequence, 2);
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc projects.searchEntries", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceDir = yield* fs.makeTempDirectoryScoped({
        prefix: "piedpiper-ws-project-search-",
      });
      yield* fs.writeFileString(
        path.join(workspaceDir, "needle-file.ts"),
        "export const needle = 1;",
      );

      yield* buildAppUnderTest();

      const wsUrl = yield* getWsServerUrl("/ws");
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.projectsSearchEntries]({
            cwd: workspaceDir,
            query: "needle",
            limit: 10,
          }),
        ),
      );

      assert.isAtLeast(response.entries.length, 1);
      assert.isTrue(response.entries.some((entry) => entry.path === "needle-file.ts"));
      assert.equal(response.truncated, false);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc projects.searchEntries errors", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.projectsSearchEntries]({
            cwd: "/definitely/not/a/real/workspace/path",
            query: "needle",
            limit: 10,
          }),
        ).pipe(Effect.result),
      );

      assertTrue(result._tag === "Failure");
      assertTrue(result.failure._tag === "ProjectSearchEntriesError");
      assertInclude(
        result.failure.message,
        "Workspace root does not exist: /definitely/not/a/real/workspace/path",
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc projects.writeFile", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceDir = yield* fs.makeTempDirectoryScoped({
        prefix: "piedpiper-ws-project-write-",
      });

      yield* buildAppUnderTest();

      const wsUrl = yield* getWsServerUrl("/ws");
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.projectsWriteFile]({
            cwd: workspaceDir,
            relativePath: "nested/created.txt",
            contents: "written-by-rpc",
          }),
        ),
      );

      assert.equal(response.relativePath, "nested/created.txt");
      const persisted = yield* fs.readFileString(path.join(workspaceDir, "nested", "created.txt"));
      assert.equal(persisted, "written-by-rpc");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc projects.writeFile errors", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceDir = yield* fs.makeTempDirectoryScoped({
        prefix: "piedpiper-ws-project-write-",
      });

      yield* buildAppUnderTest();

      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.projectsWriteFile]({
            cwd: workspaceDir,
            relativePath: "../escape.txt",
            contents: "nope",
          }),
        ).pipe(Effect.result),
      );

      assertTrue(result._tag === "Failure");
      assertTrue(result.failure._tag === "ProjectWriteFileError");
      assert.equal(
        result.failure.message,
        "Workspace file path must stay within the project root.",
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc shell.openInEditor", () =>
    Effect.gen(function* () {
      let openedInput: { cwd: string; editor: EditorId } | null = null;
      yield* buildAppUnderTest({
        layers: {
          open: {
            openInEditor: (input) =>
              Effect.sync(() => {
                openedInput = input;
              }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.shellOpenInEditor]({
            cwd: "/tmp/project",
            editor: "cursor",
          }),
        ),
      );

      assert.deepEqual(openedInput, { cwd: "/tmp/project", editor: "cursor" });
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("refuses shell.openInEditor for a network path outside every project", () =>
    Effect.gen(function* () {
      let opened = false;
      yield* buildAppUnderTest({
        layers: {
          open: {
            openInEditor: () =>
              Effect.sync(() => {
                opened = true;
              }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.shellOpenInEditor]({
            cwd: "\\\\attacker\\share\\x.md",
            editor: "cursor",
          }),
        ).pipe(Effect.result),
      );

      assertFailure(
        result,
        new OpenError({ message: "Refusing to open a network path outside the project." }),
      );
      assert.isFalse(opened);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc shell.openInEditor errors", () =>
    Effect.gen(function* () {
      const openError = new OpenError({ message: "Editor command not found: cursor" });
      yield* buildAppUnderTest({
        layers: {
          open: {
            openInEditor: () => Effect.fail(openError),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.shellOpenInEditor]({
            cwd: "/tmp/project",
            editor: "cursor",
          }),
        ).pipe(Effect.result),
      );

      assertFailure(result, openError);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("streams worktree checkout progress and ends with the result", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        layers: {
          gitCore: {
            createWorktree: (_input, options) =>
              Effect.gen(function* () {
                yield* (
                  options?.onCheckoutProgress?.({ percent: 10, completed: 1, total: 10 }) ??
                    Effect.void
                );
                yield* (
                  options?.onCheckoutProgress?.({ percent: 100, completed: 10, total: 10 }) ??
                    Effect.void
                );
                return { worktree: { path: "/tmp/wt", branch: "feature/demo" } };
              }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const events = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.gitCreateWorktreeWithProgress]({
            cwd: "/tmp/repo",
            branch: "main",
            path: null,
          }).pipe(
            Stream.runCollect,
            Effect.map((collected) => Array.from(collected)),
          ),
        ),
      );

      assert.deepEqual(events, [
        { kind: "checkout_progress", percent: 10, completed: 1, total: 10 },
        { kind: "checkout_progress", percent: 100, completed: 10, total: 10 },
        { kind: "finished", result: { worktree: { path: "/tmp/wt", branch: "feature/demo" } } },
      ]);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("surfaces a failed worktree creation as the stream's error", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        layers: {
          gitCore: {
            createWorktree: () =>
              Effect.fail(
                new GitCommandError({
                  operation: "createWorktree",
                  command: "git worktree add",
                  cwd: "/tmp/repo",
                  detail: "already exists",
                }),
              ),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.gitCreateWorktreeWithProgress]({
            cwd: "/tmp/repo",
            branch: "main",
            path: null,
          }).pipe(Stream.runDrain, Effect.result),
        ),
      );

      assertTrue(result._tag === "Failure" && result.failure._tag === "GitCommandError");
      assert.equal(result.failure.detail, "already exists");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("interrupts worktree creation when the client abandons the stream", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();
      yield* buildAppUnderTest({
        layers: {
          gitCore: {
            createWorktree: () =>
              Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
              ),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.gen(function* () {
            const fiber = yield* client[WS_METHODS.gitCreateWorktreeWithProgress]({
              cwd: "/tmp/repo",
              branch: "main",
              path: null,
            }).pipe(Stream.runDrain, Effect.forkScoped);
            yield* Deferred.await(started);
            yield* Fiber.interrupt(fiber);
            // Still connected here, so only the stream's own interrupt can reach the handler.
            yield* Deferred.await(interrupted);
          }),
        ),
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("streams clone progress and finishes with the absolute destination", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parent = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "piedpiper-ws-clone-",
      });
      const destinationPath = path.join(parent, "repo");
      const executed: Array<ReadonlyArray<string>> = [];
      yield* buildAppUnderTest({
        layers: {
          gitCore: {
            execute: (input) =>
              Effect.gen(function* () {
                executed.push(input.args);
                yield* (
                  input.progress?.onStderrLine?.("Receiving objects:  50% (5/10)") ?? Effect.void
                );
                return {
                  code: 0,
                  stdout: "",
                  stderr: "",
                  stdoutTruncated: false,
                  stderrTruncated: false,
                };
              }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const events = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.gitCloneRepository]({
            url: "https://example.com/acme/repo.git",
            destinationPath,
          }).pipe(
            Stream.runCollect,
            Effect.map((collected) => Array.from(collected)),
          ),
        ),
      );

      assert.deepEqual(executed, [
        ["clone", "--progress", "--", "https://example.com/acme/repo.git", "repo"],
      ]);
      assert.deepEqual(events, [
        { kind: "progress", stage: "connecting", percent: null, detail: null },
        { kind: "progress", stage: "receiving", percent: 50, detail: null },
        { kind: "finished", destinationPath },
      ]);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("removes the partial clone when the client cancels over the websocket", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parent = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "piedpiper-ws-clone-cancel-",
      });
      const destinationPath = path.join(parent, "repo");
      const realDelay = (ms: number) =>
        Effect.promise(() => new Promise((resolve) => setTimeout(resolve, ms)));
      let commandInterrupted = false;
      const commandStarted = yield* Deferred.make<void>();
      yield* buildAppUnderTest({
        layers: {
          gitCore: {
            execute: () =>
              Effect.gen(function* () {
                yield* fileSystem
                  .makeDirectory(path.join(destinationPath, ".git"), { recursive: true })
                  .pipe(Effect.orDie);
                yield* Deferred.succeed(commandStarted, undefined);
                return yield* Effect.never;
              }).pipe(
                Effect.onInterrupt(() =>
                  Effect.sync(() => {
                    commandInterrupted = true;
                  }),
                ),
              ),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.gen(function* () {
            const fiber = yield* client[WS_METHODS.gitCloneRepository]({
              url: "https://example.com/acme/repo.git",
              destinationPath,
            }).pipe(Stream.runDrain, Effect.forkScoped);
            yield* Deferred.await(commandStarted);
            // Lets the server fiber park on the command before the client interrupts it.
            yield* realDelay(50);
            yield* Fiber.interrupt(fiber);
            for (let attempt = 0; attempt < 100; attempt += 1) {
              if (!(yield* fileSystem.exists(destinationPath))) break;
              yield* realDelay(20);
            }
          }),
        ),
      );

      assertTrue(commandInterrupted);
      assertTrue(!(yield* fileSystem.exists(destinationPath)));
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("removes the partial clone when the client's socket drops without a cancel", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parent = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "piedpiper-ws-clone-drop-",
      });
      const destinationPath = path.join(parent, "repo");
      const realDelay = (ms: number) =>
        Effect.promise(() => new Promise((resolve) => setTimeout(resolve, ms)));
      let commandInterrupted = false;
      const commandStarted = yield* Deferred.make<void>();
      yield* buildAppUnderTest({
        layers: {
          gitCore: {
            execute: () =>
              Effect.gen(function* () {
                yield* fileSystem
                  .makeDirectory(path.join(destinationPath, ".git"), { recursive: true })
                  .pipe(Effect.orDie);
                yield* Deferred.succeed(commandStarted, undefined);
                return yield* Effect.never;
              }).pipe(
                Effect.onInterrupt(() =>
                  Effect.sync(() => {
                    commandInterrupted = true;
                  }),
                ),
              ),
          },
        },
      });

      // A raw socket: closing an RpcClient would send an Interrupt first, a dropped tab sends none.
      const wsUrl = yield* getWsServerUrl("/ws");
      const socket = new WebSocket(wsUrl);
      yield* Effect.promise(
        () =>
          new Promise<void>((resolve, reject) => {
            socket.addEventListener("open", () => resolve());
            socket.addEventListener("error", () => reject(new Error("socket failed to open")));
          }),
      );
      socket.send(
        JSON.stringify({
          _tag: "Request",
          id: "1",
          tag: WS_METHODS.gitCloneRepository,
          payload: { url: "https://example.com/acme/repo.git", destinationPath },
          headers: [],
        }),
      );
      yield* Deferred.await(commandStarted);
      yield* realDelay(50);
      socket.close();

      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (commandInterrupted && !(yield* fileSystem.exists(destinationPath))) break;
        yield* realDelay(20);
      }

      assertTrue(commandInterrupted);
      assertTrue(!(yield* fileSystem.exists(destinationPath)));
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("refuses to clone into a folder that already has contents", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const destinationPath = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "piedpiper-ws-clone-occupied-",
      });
      yield* fileSystem.writeFileString(path.join(destinationPath, "keep.txt"), "keep");
      yield* buildAppUnderTest();

      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.gitCloneRepository]({
            url: "https://example.com/acme/repo.git",
            destinationPath,
          }).pipe(Stream.runDrain, Effect.result),
        ),
      );

      assertTrue(result._tag === "Failure" && result.failure._tag === "GitCommandError");
      assertInclude(result.failure.detail, "not empty");
      assertTrue(yield* fileSystem.exists(path.join(destinationPath, "keep.txt")));
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc git methods", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        layers: {
          gitManager: {
            status: () =>
              Effect.succeed({
                isRepo: true,
                hasOriginRemote: true,
                isDefaultBranch: true,
                branch: "main",
                hasWorkingTreeChanges: false,
                workingTree: { files: [], insertions: 0, deletions: 0 },
                hasUpstream: true,
                aheadCount: 0,
                behindCount: 0,
                pr: null,
              }),
            runStackedAction: (input, options) =>
              Effect.gen(function* () {
                const result = {
                  action: "commit" as const,
                  branch: { status: "skipped_not_requested" as const },
                  commit: {
                    status: "created" as const,
                    commitSha: "abc123",
                    subject: "feat: demo",
                  },
                  push: { status: "skipped_not_requested" as const },
                  pr: { status: "skipped_not_requested" as const },
                  toast: {
                    title: "Committed abc123",
                    description: "feat: demo",
                    cta: {
                      kind: "run_action" as const,
                      label: "Push",
                      action: {
                        kind: "push" as const,
                      },
                    },
                  },
                };

                yield* (
                  options?.progressReporter?.publish({
                    actionId: options.actionId ?? input.actionId,
                    cwd: input.cwd,
                    action: input.action,
                    kind: "phase_started",
                    phase: "commit",
                    label: "Committing...",
                  }) ?? Effect.void
                );

                yield* (
                  options?.progressReporter?.publish({
                    actionId: options.actionId ?? input.actionId,
                    cwd: input.cwd,
                    action: input.action,
                    kind: "action_finished",
                    result,
                  }) ?? Effect.void
                );

                return result;
              }),
            resolvePullRequest: () =>
              Effect.succeed({
                pullRequest: {
                  number: 1,
                  title: "Demo PR",
                  url: "https://example.com/pr/1",
                  baseBranch: "main",
                  headBranch: "feature/demo",
                  state: "open",
                },
              }),
            preparePullRequestThread: () =>
              Effect.succeed({
                pullRequest: {
                  number: 1,
                  title: "Demo PR",
                  url: "https://example.com/pr/1",
                  baseBranch: "main",
                  headBranch: "feature/demo",
                  state: "open",
                },
                branch: "feature/demo",
                worktreePath: null,
              }),
          },
          gitCore: {
            pullCurrentBranch: () =>
              Effect.succeed({
                status: "pulled",
                branch: "main",
                upstreamBranch: "origin/main",
              }),
            listBranches: () =>
              Effect.succeed({
                branches: [
                  {
                    name: "main",
                    current: true,
                    isDefault: true,
                    worktreePath: null,
                  },
                ],
                isRepo: true,
                hasOriginRemote: true,
                nextCursor: null,
                totalCount: 1,
              }),
            createWorktree: () =>
              Effect.succeed({
                worktree: { path: "/tmp/wt", branch: "feature/demo" },
              }),
            removeWorktree: () => Effect.void,
            createBranch: () => Effect.void,
            checkoutBranch: () => Effect.void,
            initRepo: () => Effect.void,
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");

      const status = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[WS_METHODS.gitStatus]({ cwd: "/tmp/repo" })),
      );
      assert.equal(status.branch, "main");

      const pull = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[WS_METHODS.gitPull]({ cwd: "/tmp/repo" })),
      );
      assert.equal(pull.status, "pulled");

      const stackedEvents = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.gitRunStackedAction]({
            actionId: "action-1",
            cwd: "/tmp/repo",
            action: "commit",
          }).pipe(
            Stream.runCollect,
            Effect.map((events) => Array.from(events)),
          ),
        ),
      );
      const lastStackedEvent = stackedEvents.at(-1);
      assert.equal(lastStackedEvent?.kind, "action_finished");
      if (lastStackedEvent?.kind === "action_finished") {
        assert.equal(lastStackedEvent.result.action, "commit");
      }

      const resolvedPr = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.gitResolvePullRequest]({
            cwd: "/tmp/repo",
            reference: "1",
          }),
        ),
      );
      assert.equal(resolvedPr.pullRequest.number, 1);

      const prepared = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.gitPreparePullRequestThread]({
            cwd: "/tmp/repo",
            reference: "1",
            mode: "local",
          }),
        ),
      );
      assert.equal(prepared.branch, "feature/demo");

      const branches = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.gitListBranches]({ cwd: "/tmp/repo" }),
        ),
      );
      assert.equal(branches.branches[0]?.name, "main");

      const worktree = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.gitCreateWorktree]({
            cwd: "/tmp/repo",
            branch: "main",
            path: null,
          }),
        ),
      );
      assert.equal(worktree.worktree.branch, "feature/demo");

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.gitRemoveWorktree]({
            cwd: "/tmp/repo",
            path: "/tmp/wt",
          }),
        ),
      );

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.gitCreateBranch]({
            cwd: "/tmp/repo",
            branch: "feature/new",
          }),
        ),
      );

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.gitCheckout]({
            cwd: "/tmp/repo",
            branch: "main",
          }),
        ),
      );

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.gitInit]({
            cwd: "/tmp/repo",
          }),
        ),
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc git.pull errors", () =>
    Effect.gen(function* () {
      const gitError = new GitCommandError({
        operation: "pull",
        command: "git pull --ff-only",
        cwd: "/tmp/repo",
        detail: "upstream missing",
      });
      yield* buildAppUnderTest({
        layers: {
          gitCore: {
            pullCurrentBranch: () => Effect.fail(gitError),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[WS_METHODS.gitPull]({ cwd: "/tmp/repo" })).pipe(
          Effect.result,
        ),
      );

      assertFailure(result, gitError);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc orchestration methods", () =>
    Effect.gen(function* () {
      const now = new Date().toISOString();
      const snapshot = {
        snapshotSequence: 1,
        updatedAt: now,
        projects: [
          {
            id: ProjectId.makeUnsafe("project-a"),
            title: "Project A",
            workspaceRoot: "/tmp/project-a",
            defaultModelSelection,
            scripts: [],
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
          },
        ],
        threads: [
          {
            id: ThreadId.makeUnsafe("thread-1"),
            projectId: ProjectId.makeUnsafe("project-a"),
            title: "Thread A",
            modelSelection: defaultModelSelection,
            interactionMode: "default" as const,
            runtimeMode: "full-access" as const,
            branch: null,
            worktreePath: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            latestTurn: null,
            messages: [],
            session: null,
            activities: [],
            proposedPlans: [],
            checkpoints: [],
            deletedAt: null,
          },
        ],
      };

      yield* buildAppUnderTest({
        layers: {
          projectionSnapshotQuery: {
            getSnapshot: () => Effect.succeed(snapshot),
          },
          orchestrationEngine: {
            dispatch: () => Effect.succeed({ sequence: 7 }),
            readEvents: () => Stream.empty,
          },
          checkpointDiffQuery: {
            getTurnDiff: () =>
              Effect.succeed({
                threadId: ThreadId.makeUnsafe("thread-1"),
                fromTurnCount: 0,
                toTurnCount: 1,
                diff: "turn-diff",
              }),
            getFullThreadDiff: () =>
              Effect.succeed({
                threadId: ThreadId.makeUnsafe("thread-1"),
                fromTurnCount: 0,
                toTurnCount: 1,
                diff: "full-diff",
              }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const snapshotResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[ORCHESTRATION_WS_METHODS.getSnapshot]({})),
      );
      assert.equal(snapshotResult.snapshotSequence, 1);

      const dispatchResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.session.stop",
            commandId: CommandId.makeUnsafe("cmd-1"),
            threadId: ThreadId.makeUnsafe("thread-1"),
            createdAt: now,
          }),
        ),
      );
      assert.equal(dispatchResult.sequence, 7);

      const turnDiffResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.getTurnDiff]({
            threadId: ThreadId.makeUnsafe("thread-1"),
            fromTurnCount: 0,
            toTurnCount: 1,
          }),
        ),
      );
      assert.equal(turnDiffResult.diff, "turn-diff");

      const fullDiffResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.getFullThreadDiff]({
            threadId: ThreadId.makeUnsafe("thread-1"),
            toTurnCount: 1,
          }),
        ),
      );
      assert.equal(fullDiffResult.diff, "full-diff");

      const replayResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.replayEvents]({
            fromSequenceExclusive: 0,
          }),
        ),
      );
      assert.deepEqual(replayResult, []);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("caps checkpoint file lists on every client path, not in the read model", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.makeUnsafe("thread-huge-turn");
      const now = new Date().toISOString();
      const turnFields = {
        turnId: TurnId.makeUnsafe("turn-huge"),
        checkpointTurnCount: 1,
        checkpointRef: CheckpointRef.makeUnsafe("refs/piedpiper/checkpoints/huge/turn/1"),
        status: "ready" as const,
        files: Array.from({ length: MAX_WIRE_CHECKPOINT_FILES + 1 }, (_, index) => ({
          path: `src/file-${index}.ts`,
          kind: "modified",
          additions: 1,
          deletions: 0,
        })),
        assistantMessageId: null,
        completedAt: now,
      };
      const base = makeDefaultOrchestrationReadModel();
      const readModel = {
        ...base,
        snapshotSequence: 1,
        threads: [{ ...base.threads[0]!, id: threadId, checkpoints: [turnFields] }],
      };
      const engineReadModel = fromContractReadModel(readModel);
      const event: OrchestrationEvent = {
        sequence: 2,
        eventId: EventId.makeUnsafe("event-huge-turn"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.turn-diff-completed",
        payload: { threadId, ...turnFields },
      };

      yield* buildAppUnderTest({
        layers: {
          projectionSnapshotQuery: { getSnapshot: () => Effect.succeed(readModel) },
          orchestrationEngine: {
            getReadModel: () => Effect.succeed(engineReadModel),
            readEvents: () => Stream.make(event),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const assertCapped = (carrier: {
        readonly files: ReadonlyArray<unknown>;
        readonly filesTotal?: number | undefined;
        readonly additionsTotal?: number | undefined;
      }) => {
        assert.equal(carrier.files.length, MAX_WIRE_CHECKPOINT_FILES);
        assert.equal(carrier.filesTotal, MAX_WIRE_CHECKPOINT_FILES + 1);
        assert.equal(carrier.additionsTotal, MAX_WIRE_CHECKPOINT_FILES + 1);
      };

      const snapshot = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[ORCHESTRATION_WS_METHODS.getSnapshot]({})),
      );
      assertCapped(snapshot.threads[0]!.checkpoints[0]!);

      const replayed = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.replayEvents]({ fromSequenceExclusive: 0 }),
        ),
      );
      const replayedEvent = replayed[0];
      assertTrue(replayedEvent?.type === "thread.turn-diff-completed");
      assertCapped(replayedEvent.payload);

      const live = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.subscribeOrchestrationDomainEvents]({}).pipe(
            Stream.take(1),
            Stream.runCollect,
          ),
        ),
      );
      const liveEvent = Array.from(live)[0];
      assertTrue(liveEvent?.type === "thread.turn-diff-completed");
      assertCapped(liveEvent.payload);

      assert.equal(readModel.threads[0]!.checkpoints[0]!.files.length, 201);
      const engineThread = Array.from(engineReadModel.threads.values())[0]!;
      assert.equal(engineThread.checkpoints[0]!.files.length, 201);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc getTurnDiffFileContents through the thread's checkpoints", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.makeUnsafe("thread-contents");
      const checkpointRef = CheckpointRef.makeUnsafe("refs/piedpiper/checkpoints/contents/turn/1");
      const gitCalls: Array<{ cwd: string; args: ReadonlyArray<string> }> = [];

      yield* buildAppUnderTest({
        layers: {
          gitCore: {
            execute: (input) =>
              Effect.sync(() => {
                gitCalls.push({ cwd: input.cwd, args: input.args });
                const isOldSide = input.args.at(-1)?.startsWith(`${checkpointRef}:`) !== true;
                return {
                  code: 0,
                  stdout: input.args[0] === "cat-file" ? (isOldSide ? "before" : "after") : "",
                  stderr: "",
                  stdoutTruncated: false,
                  stderrTruncated: false,
                };
              }),
          },
          projectionSnapshotQuery: {
            getThreadCheckpointContext: (requested) =>
              Effect.succeed(
                requested === threadId
                  ? Option.some({
                      threadId,
                      projectId: defaultProjectId,
                      workspaceRoot: "/tmp/contents-project",
                      worktreePath: null,
                      checkpoints: [
                        {
                          turnId: TurnId.makeUnsafe("turn-1"),
                          checkpointTurnCount: 1,
                          checkpointRef,
                          status: "ready" as const,
                          files: [],
                          assistantMessageId: null,
                          completedAt: new Date().toISOString(),
                        },
                      ],
                    })
                  : Option.none(),
              ),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.getTurnDiffFileContents]({
            threadId,
            fromTurnCount: 0,
            toTurnCount: 1,
            path: "src/index.ts",
          }),
        ),
      );
      assert.deepEqual(result, {
        threadId,
        fromTurnCount: 0,
        toTurnCount: 1,
        path: "src/index.ts",
        oldContents: "before",
        newContents: "after",
        unavailableReason: null,
      });
      assertTrue(gitCalls.every((call) => call.cwd === "/tmp/contents-project"));

      const failure = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.getTurnDiffFileContents]({
            threadId: ThreadId.makeUnsafe("thread-unknown"),
            fromTurnCount: 0,
            toTurnCount: 1,
            path: "src/index.ts",
          }),
        ).pipe(Effect.result),
      );
      assertTrue(failure._tag === "Failure");
      assertTrue(failure.failure._tag === "OrchestrationGetTurnDiffFileContentsError");
      assertInclude(failure.failure.message, "Failed to load file contents");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc gitDiffPreview to GitCore", () =>
    Effect.gen(function* () {
      const inputs: Array<unknown> = [];
      const preview = {
        diff: "diff --git a/a.ts b/a.ts\n",
        baseRef: null,
        truncated: false,
        untrackedIncomplete: false,
      };

      yield* buildAppUnderTest({
        layers: {
          gitCore: {
            diffPreview: (input) =>
              Effect.sync(() => {
                inputs.push(input);
                return preview;
              }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const input = { cwd: "/tmp/repo", scope: "uncommitted", ignoreWhitespace: true } as const;
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[WS_METHODS.gitDiffPreview](input)),
      );

      assert.deepEqual(result, preview);
      assert.deepEqual(inputs, [input]);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  // A fake gh on PATH, since the status check spawns the real binary.
  it.effect.skipIf(process.platform === "win32")(
    "reports a signed-out gh as installed over websocket rpc",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const binDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "piedpiper-router-fake-gh-",
        });
        const fakeGh = path.join(binDir, "gh");
        const authStatus = JSON.stringify({
          hosts: { "github.com": [{ state: "failed", active: true }] },
        });
        yield* fileSystem.writeFileString(fakeGh, `#!/bin/sh\necho '${authStatus}'\nexit 1\n`);
        yield* fileSystem.chmod(fakeGh, 0o755);
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            const previous = process.env.PATH;
            process.env.PATH = `${binDir}:${previous ?? ""}`;
            return previous;
          }),
          (previous) => Effect.sync(() => void (process.env.PATH = previous)),
        );

        yield* buildAppUnderTest();

        const wsUrl = yield* getWsServerUrl("/ws");
        const status = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.gitGitHubCliStatus]({ cwd: binDir }),
          ),
        );

        assert.deepEqual(status, { installed: true, authenticated: false });
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("includes the latest noticeable event loop stall in the server config", () =>
    Effect.gen(function* () {
      const stall = {
        detectedAt: "2026-11-08T10:00:00.000Z",
        durationMs: 6200,
        loadAverage: 3.5,
        cpuCount: 8,
      };
      yield* buildAppUnderTest({
        layers: {
          keybindings: { loadConfigState: Effect.succeed({ keybindings: [], issues: [] }) },
          eventLoopMonitor: { latestNoticeableStall: Effect.succeed(stall) },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const config = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[WS_METHODS.serverGetConfig]({})),
      );
      assert.deepEqual(config.lastEventLoopStall, stall);

      const events = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.subscribeServerConfig]({}).pipe(Stream.take(1), Stream.runCollect),
        ),
      );
      const snapshot = Array.from(events)[0];
      assertTrue(snapshot?.type === "snapshot");
      assert.deepEqual(snapshot.config.lastEventLoopStall, stall);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("omits the event loop stall from the server config when there was none", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        layers: {
          keybindings: { loadConfigState: Effect.succeed({ keybindings: [], issues: [] }) },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const config = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[WS_METHODS.serverGetConfig]({})),
      );
      assert.equal("lastEventLoopStall" in config, false);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("closes thread terminals after a successful archive command", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.makeUnsafe("thread-archive");
      const closeInputs: Array<Parameters<TerminalManagerShape["close"]>[0]> = [];
      const stopInputs: Array<Parameters<ProviderServiceShape["stopSession"]>[0]> = [];

      yield* buildAppUnderTest({
        layers: {
          terminalManager: {
            close: (input) =>
              Effect.sync(() => {
                closeInputs.push(input);
              }),
          },
          providerService: {
            stopSession: (input) =>
              Effect.sync(() => {
                stopInputs.push(input);
              }),
          },
          orchestrationEngine: {
            dispatch: () => Effect.succeed({ sequence: 8 }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const dispatchResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.archive",
            commandId: CommandId.makeUnsafe("cmd-thread-archive"),
            threadId,
          }),
        ),
      );

      assert.equal(dispatchResult.sequence, 8);
      assert.deepEqual(closeInputs, [{ threadId }]);
      // ProviderSessionReaper owns the stop on `thread.archived`; the RPC must not race it.
      assert.deepEqual(stopInputs, []);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("closes terminals and deletes their history after thread and project deletes", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.makeUnsafe("thread-delete");
      const closeInputs: Array<Parameters<TerminalManagerShape["close"]>[0]> = [];

      yield* buildAppUnderTest({
        layers: {
          terminalManager: {
            close: (input) =>
              Effect.sync(() => {
                closeInputs.push(input);
              }),
          },
          orchestrationEngine: {
            dispatch: () => Effect.succeed({ sequence: 9 }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.gen(function* () {
            yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
              type: "thread.delete",
              commandId: CommandId.makeUnsafe("cmd-thread-delete"),
              threadId,
            });
            yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
              type: "project.delete",
              commandId: CommandId.makeUnsafe("cmd-project-delete"),
              projectId: defaultProjectId,
            });
          }),
        ),
      );

      assert.deepEqual(closeInputs, [
        { threadId, deleteHistory: true },
        { threadId: defaultThreadId, deleteHistory: true },
      ]);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "routes websocket rpc subscribeOrchestrationDomainEvents with replay/live overlap resilience",
    () =>
      Effect.gen(function* () {
        const now = new Date().toISOString();
        const threadId = ThreadId.makeUnsafe("thread-1");
        let replayCursor: number | null = null;
        const makeEvent = (sequence: number): OrchestrationEvent =>
          ({
            sequence,
            eventId: `event-${sequence}`,
            aggregateKind: "thread",
            aggregateId: threadId,
            occurredAt: now,
            commandId: null,
            causationEventId: null,
            correlationId: null,
            metadata: {},
            type: "thread.reverted",
            payload: {
              threadId,
              turnCount: sequence,
            },
          }) as OrchestrationEvent;

        const domainEvents = yield* PubSub.unbounded<OrchestrationEvent>();
        yield* buildAppUnderTest({
          layers: {
            orchestrationEngine: {
              getReadModel: () =>
                Effect.succeed(
                  fromContractReadModel({
                    ...makeDefaultOrchestrationReadModel(),
                    snapshotSequence: 1,
                  }),
                ),
              readEvents: (fromSequenceExclusive) => {
                replayCursor = fromSequenceExclusive;
                return Stream.make(makeEvent(2), makeEvent(3));
              },
              subscribeDomainEvents: () =>
                PubSub.subscribe(domainEvents).pipe(
                  Effect.tap(() => PubSub.publishAll(domainEvents, [makeEvent(3), makeEvent(4)])),
                ),
            },
          },
        });

        const wsUrl = yield* getWsServerUrl("/ws");
        const events = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.subscribeOrchestrationDomainEvents]({}).pipe(
              Stream.take(3),
              Stream.runCollect,
            ),
          ),
        );

        assert.equal(replayCursor, 1);
        assert.deepEqual(
          Array.from(events).map((event) => event.sequence),
          [2, 3, 4],
        );
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  describe("subscribeOrchestrationDomainEvents replay failures", () => {
    const failedReplay = (readFailure: PersistenceSqlError) =>
      Effect.gen(function* () {
        const domainEvents = yield* PubSub.unbounded<OrchestrationEvent>();
        const threadId = ThreadId.makeUnsafe("thread-replay");
        const liveEvent = {
          sequence: 2,
          eventId: "event-2",
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: new Date().toISOString(),
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "thread.reverted",
          payload: { threadId, turnCount: 2 },
        } as OrchestrationEvent;
        yield* buildAppUnderTest({
          layers: {
            orchestrationEngine: {
              getReadModel: () =>
                Effect.succeed(
                  fromContractReadModel({
                    ...makeDefaultOrchestrationReadModel(),
                    snapshotSequence: 1,
                  }),
                ),
              readEvents: () => Stream.fail(readFailure),
              subscribeDomainEvents: () =>
                PubSub.subscribe(domainEvents).pipe(
                  Effect.tap(() => PubSub.publish(domainEvents, liveEvent)),
                ),
            },
          },
        });
        const wsUrl = yield* getWsServerUrl("/ws");
        return yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.subscribeOrchestrationDomainEvents]({}).pipe(
              Stream.take(1),
              Stream.runCollect,
            ),
          ),
        ).pipe(Effect.exit);
      }).pipe(Effect.provide(NodeHttpServer.layerTest));

    it.effect("dies on a replay below the prune boundary, so the client resubscribes", () =>
      Effect.gen(function* () {
        const exit = yield* failedReplay(
          new PersistenceSqlError({
            operation: "OrchestrationEventMaintenance.ensureReplayableFrom",
            detail: "Events before the requested sequence were pruned.",
          }),
        );
        assertTrue(Exit.isFailure(exit));
      }),
    );

    it.effect("falls through to live on any other read failure", () =>
      Effect.gen(function* () {
        const exit = yield* failedReplay(
          new PersistenceSqlError({ operation: "other.read", detail: "disk error" }),
        );
        assertTrue(Exit.isSuccess(exit));
        if (Exit.isSuccess(exit)) {
          assert.deepEqual(
            Array.from(exit.value).map((event) => event.sequence),
            [2],
          );
        }
      }),
    );
  });

  it.effect(
    "routes websocket rpc subscribeOrchestrationDomainEvents buffers events published while snapshot loads",
    () =>
      Effect.gen(function* () {
        const now = new Date().toISOString();
        const threadId = ThreadId.makeUnsafe("thread-1");
        const makeEvent = (sequence: number): OrchestrationEvent =>
          ({
            sequence,
            eventId: `event-${sequence}`,
            aggregateKind: "thread",
            aggregateId: threadId,
            occurredAt: now,
            commandId: null,
            causationEventId: null,
            correlationId: null,
            metadata: {},
            type: "thread.reverted",
            payload: {
              threadId,
              turnCount: sequence,
            },
          }) as OrchestrationEvent;
        const domainEvents = yield* PubSub.unbounded<OrchestrationEvent>();

        yield* buildAppUnderTest({
          layers: {
            orchestrationEngine: {
              // Events 2 and 3 are committed after the snapshot and replay reads have started.
              getReadModel: () =>
                PubSub.publish(domainEvents, makeEvent(2)).pipe(
                  Effect.as(
                    fromContractReadModel({
                      ...makeDefaultOrchestrationReadModel(),
                      snapshotSequence: 1,
                    }),
                  ),
                ),
              readEvents: () =>
                Stream.fromEffect(PubSub.publish(domainEvents, makeEvent(3))).pipe(Stream.drain),
              subscribeDomainEvents: () => PubSub.subscribe(domainEvents),
            },
          },
        });

        const wsUrl = yield* getWsServerUrl("/ws");
        const events = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.subscribeOrchestrationDomainEvents]({}).pipe(
              Stream.take(2),
              Stream.runCollect,
            ),
          ),
        );

        assert.deepEqual(
          Array.from(events).map((event) => event.sequence),
          [2, 3],
        );
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "routes websocket rpc subscribeOrchestrationDomainEvents resumes contiguously after a live overflow",
    () =>
      Effect.gen(function* () {
        const now = new Date().toISOString();
        const threadId = ThreadId.makeUnsafe("thread-1");
        const makeEvent = (sequence: number): OrchestrationEvent =>
          ({
            sequence,
            eventId: `event-${sequence}`,
            aggregateKind: "thread",
            aggregateId: threadId,
            occurredAt: now,
            commandId: null,
            causationEventId: null,
            correlationId: null,
            metadata: {},
            type: "thread.reverted",
            payload: {
              threadId,
              turnCount: sequence,
            },
          }) as OrchestrationEvent;
        const domainEvents = yield* PubSub.unbounded<OrchestrationEvent>();
        // The durable event log that replay reads from.
        const store: Array<OrchestrationEvent> = [];
        const commit = (events: ReadonlyArray<OrchestrationEvent>) =>
          Effect.suspend(() => {
            store.push(...events);
            return PubSub.publishAll(domainEvents, events);
          });
        let subscribeCount = 0;
        // More than LIVE_STREAM_MAX_ITEMS events, published in one burst before the client pulls them.
        const burstSize = 1_200;
        const lastSequence = 2 + burstSize;

        yield* buildAppUnderTest({
          layers: {
            orchestrationEngine: {
              // Event 2 is committed between the subscribe and the snapshot read.
              getReadModel: () =>
                commit([makeEvent(2)]).pipe(
                  Effect.as(
                    fromContractReadModel({
                      ...makeDefaultOrchestrationReadModel(),
                      snapshotSequence: 1,
                    }),
                  ),
                ),
              readEvents: (fromSequenceExclusive) =>
                Stream.suspend(() =>
                  Stream.fromIterable(
                    store.filter((event) => event.sequence > fromSequenceExclusive),
                  ),
                ),
              subscribeDomainEvents: () =>
                PubSub.subscribe(domainEvents).pipe(
                  Effect.tap(() =>
                    Effect.sync(() => {
                      subscribeCount += 1;
                    }),
                  ),
                ),
            },
          },
        });

        const burst = Array.from({ length: burstSize }, (_, index) => makeEvent(3 + index));
        const wsUrl = yield* getWsServerUrl("/ws");
        const events = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.subscribeOrchestrationDomainEvents]({}).pipe(
              Stream.tap((event) => (event.sequence === 2 ? commit(burst) : Effect.void)),
              Stream.take(lastSequence - 1),
              Stream.runCollect,
            ),
          ),
        );

        const sequences = Array.from(events).map((event) => event.sequence);
        assert.deepEqual(
          sequences,
          Array.from({ length: lastSequence - 1 }, (_, index) => index + 2),
        );
        assert.equal(sequences.filter((sequence) => sequence === 2).length, 1);
        // The burst overflowed the first live subscription, so the stream re-subscribed.
        assertTrue(subscribeCount >= 2);
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("a dying websocket rpc handler fails alone and is logged", () =>
    Effect.gen(function* () {
      const logLines: Array<string> = [];
      const subscribed = yield* Deferred.make<(event: TerminalEvent) => Effect.Effect<void>>();
      yield* buildAppUnderTest({
        captureHttpLogs: logLines,
        layers: {
          terminalManager: {
            subscribe: (listener) =>
              Deferred.succeed(subscribed, listener).pipe(Effect.as(() => undefined)),
            write: () => Effect.die(new Error("handler bug")),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const received = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.gen(function* () {
            const firstEvents = yield* client[WS_METHODS.subscribeTerminalEvents]({}).pipe(
              Stream.take(2),
              Stream.runCollect,
              Effect.forkChild,
            );
            const listener = yield* Deferred.await(subscribed);

            const writeExit = yield* Effect.exit(
              client[WS_METHODS.terminalWrite]({
                threadId: "thread-1",
                terminalId: "default",
                data: "x",
              }),
            );
            assertTrue(Exit.hasDies(writeExit));

            yield* listener({
              threadId: "thread-1",
              terminalId: "default",
              createdAt: new Date().toISOString(),
              type: "output",
              data: "still alive",
            });
            const [frame, event] = yield* Fiber.join(firstEvents).pipe(Effect.timeout("5 seconds"));
            assert.equal(frame!.type, "subscribed");
            return event!;
          }),
        ),
      );

      assert.equal(received.type === "output" ? received.data : null, "still alive");
      assertTrue(logLines.some((line) => line.includes("Unhandled websocket RPC defect")));
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("streams terminal metadata over websocket rpc and unsubscribes on close", () =>
    Effect.gen(function* () {
      const unsubscribed = yield* Latch.make();
      const detached = yield* Latch.make();
      let detachCount = 0;
      const terminal = {
        threadId: "thread-1",
        terminalId: "default",
        status: "running",
        hasRunningSubprocess: false,
      } as const;
      yield* buildAppUnderTest({
        layers: {
          terminalManager: {
            detachClient: () =>
              Effect.sync(() => {
                detachCount += 1;
                detached.openUnsafe();
              }),
            subscribeMetadata: (listener) =>
              listener({ type: "snapshot", terminals: [] }).pipe(
                Effect.andThen(listener({ type: "upsert", terminal })),
                Effect.as(() => {
                  unsubscribed.openUnsafe();
                }),
              ),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const events = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.gen(function* () {
            const events = yield* client[WS_METHODS.subscribeTerminalMetadata]({}).pipe(
              Stream.take(2),
              Stream.runCollect,
            );
            yield* unsubscribed.await.pipe(Effect.timeout("5 seconds"));
            assert.equal(
              detachCount,
              0,
              "ending a subscription must not detach a connected client",
            );
            return events;
          }),
        ),
      );

      assert.deepEqual(Array.from(events), [
        { type: "snapshot", terminals: [] },
        { type: "upsert", terminal },
      ]);
      yield* detached.await.pipe(Effect.timeout("5 seconds"));
      assert.equal(detachCount, 1, "physical disconnect is observed after the subscription ended");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc orchestration.getSnapshot errors", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        layers: {
          projectionSnapshotQuery: {
            getSnapshot: () =>
              Effect.fail(
                new PersistenceSqlError({
                  operation: "ProjectionSnapshotQuery.getSnapshot",
                  detail: "projection unavailable",
                }),
              ),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[ORCHESTRATION_WS_METHODS.getSnapshot]({})).pipe(
          Effect.result,
        ),
      );

      assertTrue(result._tag === "Failure");
      assertTrue(result.failure._tag === "OrchestrationGetSnapshotError");
      assertInclude(result.failure.message, "Failed to load orchestration snapshot");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("gives recovery steps, not driver text, when a dispatch hits a database error", () =>
    Effect.gen(function* () {
      const driverError = Object.assign(new Error("driver-private-text"), { errcode: 13 });
      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            dispatch: () => Effect.fail(toPersistenceSqlError("op:append")(driverError)),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.session.stop",
            commandId: CommandId.makeUnsafe("cmd-database-error"),
            threadId: ThreadId.makeUnsafe("thread-1"),
            createdAt: new Date().toISOString(),
          }),
        ).pipe(Effect.result),
      );

      assertTrue(result._tag === "Failure");
      assertTrue(result.failure._tag === "OrchestrationDispatchCommandError");
      assertInclude(result.failure.message, "SQLITE_FULL");
      assert.notInclude(result.failure.message, "driver-private-text");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc projects.scanAgentSessions using provider settings", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const claudeHome = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "piedpiper-scan-claude-",
      });
      const { providers } = DEFAULT_SERVER_SETTINGS;
      yield* buildAppUnderTest({
        layers: {
          serverSettings: {
            getSettings: Effect.succeed({
              ...DEFAULT_SERVER_SETTINGS,
              providers: {
                ...providers,
                claudeAgent: { ...providers.claudeAgent, homePath: claudeHome },
                codex: { ...providers.codex, enabled: false },
              },
            }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[WS_METHODS.projectsScanAgentSessions]({})),
      );
      assert.deepEqual(result, { candidates: [], truncated: false });
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("returns projects.scanAgentSessions candidates without transcript content", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const claudeHome = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "piedpiper-scan-claude-",
      });
      // The scanner skips the system temp folder, so this project lives under the test's cwd.
      const repoDir = yield* fileSystem.makeTempDirectoryScoped({
        directory: process.cwd(),
        prefix: ".piedpiper-scan-repo-",
      });
      yield* fileSystem.makeDirectory(path.join(repoDir, ".git"));
      const transcriptDir = path.join(claudeHome, "projects", "x");
      yield* fileSystem.makeDirectory(transcriptDir, { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(transcriptDir, "s.jsonl"),
        `${JSON.stringify({ cwd: repoDir, message: { content: "transcript-secret" } })}\n`,
      );
      const { providers } = DEFAULT_SERVER_SETTINGS;
      yield* buildAppUnderTest({
        layers: {
          serverSettings: {
            getSettings: Effect.succeed({
              ...DEFAULT_SERVER_SETTINGS,
              providers: {
                ...providers,
                claudeAgent: { ...providers.claudeAgent, homePath: claudeHome },
                codex: { ...providers.codex, enabled: false },
              },
            }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[WS_METHODS.projectsScanAgentSessions]({})),
      );
      assert.equal(result.truncated, false);
      assert.equal(result.candidates.length, 1);
      const candidate = result.candidates[0];
      assert.equal(candidate?.path, repoDir);
      assert.deepEqual(candidate?.sources, ["claudeAgent"]);
      assert.equal(candidate?.threadCount, 1);
      assert.equal(candidate?.isGitRepository, true);
      assertTrue(!JSON.stringify(result).includes("transcript-secret"));
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc provider.listSlashCommands to Claude only", () =>
    Effect.gen(function* () {
      const listedCwds: Array<string> = [];
      yield* buildAppUnderTest({
        layers: {
          claudeSlashCommands: {
            list: (cwd) =>
              Effect.sync(() => {
                listedCwds.push(cwd);
                return {
                  commands: [{ name: "compact", argumentHint: "<instructions>" }],
                  pending: false,
                };
              }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const [claude, codex] = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.all([
            client[WS_METHODS.providerListSlashCommands]({
              provider: "claudeAgent",
              cwd: "/repo/a",
            }),
            client[WS_METHODS.providerListSlashCommands]({ provider: "codex", cwd: "/repo/a" }),
          ]),
        ),
      );
      assert.deepEqual(claude, {
        commands: [{ name: "compact", argumentHint: "<instructions>" }],
        pending: false,
      });
      assert.deepEqual(codex, { commands: [], pending: false });
      assert.deepEqual(listedCwds, ["/repo/a"]);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("reports a failed projects.scanAgentSessions as a scan error", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        layers: {
          serverSettings: {
            getSettings: Effect.fail(
              new ServerSettingsError({ settingsPath: "/tmp/settings.json", detail: "unreadable" }),
            ),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[WS_METHODS.projectsScanAgentSessions]({})).pipe(
          Effect.result,
        ),
      );
      assertTrue(result._tag === "Failure");
      assertTrue(result.failure._tag === "AgentSessionScanError");
      assertInclude(result.failure.message, "Failed to scan");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc terminal methods", () =>
    Effect.gen(function* () {
      const snapshot = {
        threadId: "thread-1",
        terminalId: "default",
        cwd: "/tmp/project",
        status: "running" as const,
        pid: 1234,
        history: "",
        exitCode: null,
        exitSignal: null,
        updatedAt: new Date().toISOString(),
      };

      yield* buildAppUnderTest({
        layers: {
          terminalManager: {
            open: () => Effect.succeed(snapshot),
            write: () => Effect.void,
            resize: () => Effect.void,
            clear: () => Effect.void,
            restart: () => Effect.succeed(snapshot),
            close: () => Effect.void,
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");

      const opened = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.terminalOpen]({
            threadId: "thread-1",
            terminalId: "default",
            cwd: "/tmp/project",
          }),
        ),
      );
      assert.equal(opened.terminalId, "default");

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.terminalWrite]({
            threadId: "thread-1",
            terminalId: "default",
            data: "echo hi\n",
          }),
        ),
      );

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.terminalResize]({
            threadId: "thread-1",
            terminalId: "default",
            cols: 120,
            rows: 40,
          }),
        ),
      );

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.terminalClear]({
            threadId: "thread-1",
            terminalId: "default",
          }),
        ),
      );

      const restarted = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.terminalRestart]({
            threadId: "thread-1",
            terminalId: "default",
            cwd: "/tmp/project",
            cols: 120,
            rows: 40,
          }),
        ),
      );
      assert.equal(restarted.terminalId, "default");

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.terminalClose]({
            threadId: "thread-1",
            terminalId: "default",
          }),
        ),
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc terminal.write errors", () =>
    Effect.gen(function* () {
      const terminalError = new TerminalNotRunningError({
        threadId: "thread-1",
        terminalId: "default",
      });
      yield* buildAppUnderTest({
        layers: {
          terminalManager: {
            write: () => Effect.fail(terminalError),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.terminalWrite]({
            threadId: "thread-1",
            terminalId: "default",
            data: "echo fail\n",
          }),
        ).pipe(Effect.result),
      );

      assertFailure(result, terminalError);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );
});
