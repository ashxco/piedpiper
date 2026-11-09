import {
  type GitActionProgressEvent,
  type GitCloneRepositoryEvent,
  type GitCloneRepositoryInput,
  type GitCreateWorktreeInput,
  type GitCreateWorktreeProgressEvent,
  type GitCreateWorktreeResult,
  type GitRunStackedActionInput,
  type GitRunStackedActionResult,
  type NativeApi,
  ORCHESTRATION_WS_METHODS,
  type ServerSettingsPatch,
  type TerminalEvent,
  type TerminalEventStreamItem,
  type ThreadId,
  type ToolInputPreviewEvent,
  WS_METHODS,
} from "@piedpiper/contracts";
import { Effect, Stream } from "effect";

import { type WsRpcProtocolClient } from "./rpc/protocol";
import { WsTransport } from "./wsTransport";

type RpcTag = keyof WsRpcProtocolClient & string;
type RpcMethod<TTag extends RpcTag> = WsRpcProtocolClient[TTag];
type RpcInput<TTag extends RpcTag> = Parameters<RpcMethod<TTag>>[0];

type RpcUnaryMethod<TTag extends RpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Effect.Effect<infer TSuccess, any, any>
    ? (input: RpcInput<TTag>) => Promise<TSuccess>
    : never;

type RpcUnaryNoArgMethod<TTag extends RpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Effect.Effect<infer TSuccess, any, any>
    ? () => Promise<TSuccess>
    : never;

type RpcStreamMethod<TTag extends RpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Stream.Stream<infer TEvent, any, any>
    ? (listener: (event: TEvent) => void) => () => void
    : never;

interface GitRunStackedActionOptions {
  readonly onProgress?: (event: GitActionProgressEvent) => void;
}

interface GitCreateWorktreeWithProgressOptions {
  readonly onProgress?:
    | ((progress: Extract<GitCreateWorktreeProgressEvent, { kind: "checkout_progress" }>) => void)
    | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface WsRpcClient {
  readonly dispose: () => Promise<void>;
  readonly terminal: {
    readonly open: RpcUnaryMethod<typeof WS_METHODS.terminalOpen>;
    readonly write: RpcUnaryMethod<typeof WS_METHODS.terminalWrite>;
    readonly resize: RpcUnaryMethod<typeof WS_METHODS.terminalResize>;
    readonly detach: RpcUnaryMethod<typeof WS_METHODS.terminalDetach>;
    readonly clear: RpcUnaryMethod<typeof WS_METHODS.terminalClear>;
    readonly restart: RpcUnaryMethod<typeof WS_METHODS.terminalRestart>;
    readonly close: RpcUnaryMethod<typeof WS_METHODS.terminalClose>;
    readonly onEvent: (
      listener: (event: TerminalEvent) => void,
      options?: { readonly onSubscribed?: () => void },
    ) => () => void;
    readonly onMetadata: RpcStreamMethod<typeof WS_METHODS.subscribeTerminalMetadata>;
  };
  readonly projects: {
    readonly searchEntries: RpcUnaryMethod<typeof WS_METHODS.projectsSearchEntries>;
    readonly writeFile: RpcUnaryMethod<typeof WS_METHODS.projectsWriteFile>;
    readonly readConfigFile: RpcUnaryMethod<typeof WS_METHODS.projectsReadConfigFile>;
    readonly checkDirectoryExists: RpcUnaryMethod<typeof WS_METHODS.projectsCheckDirectoryExists>;
    readonly statPath: RpcUnaryMethod<typeof WS_METHODS.projectsStatPath>;
    readonly createDirectory: RpcUnaryMethod<typeof WS_METHODS.projectsCreateDirectory>;
    readonly browseDirectories: RpcUnaryMethod<typeof WS_METHODS.projectsBrowseDirectories>;
    readonly scanAgentSessions: RpcUnaryNoArgMethod<typeof WS_METHODS.projectsScanAgentSessions>;
  };
  readonly shell: {
    readonly openInEditor: (input: {
      readonly cwd: Parameters<NativeApi["shell"]["openInEditor"]>[0];
      readonly editor: Parameters<NativeApi["shell"]["openInEditor"]>[1];
      readonly reveal?: boolean;
    }) => ReturnType<NativeApi["shell"]["openInEditor"]>;
  };
  readonly git: {
    readonly pull: RpcUnaryMethod<typeof WS_METHODS.gitPull>;
    readonly status: RpcUnaryMethod<typeof WS_METHODS.gitStatus>;
    readonly diffPreview: RpcUnaryMethod<typeof WS_METHODS.gitDiffPreview>;
    readonly listCommits: RpcUnaryMethod<typeof WS_METHODS.gitListCommits>;
    readonly runStackedAction: (
      input: GitRunStackedActionInput,
      options?: GitRunStackedActionOptions,
    ) => Promise<GitRunStackedActionResult>;
    readonly listBranches: RpcUnaryMethod<typeof WS_METHODS.gitListBranches>;
    readonly createWorktree: RpcUnaryMethod<typeof WS_METHODS.gitCreateWorktree>;
    readonly createWorktreeWithProgress: (
      input: GitCreateWorktreeInput,
      options?: GitCreateWorktreeWithProgressOptions,
    ) => Promise<GitCreateWorktreeResult>;
    readonly removeWorktree: RpcUnaryMethod<typeof WS_METHODS.gitRemoveWorktree>;
    readonly createBranch: RpcUnaryMethod<typeof WS_METHODS.gitCreateBranch>;
    readonly checkout: RpcUnaryMethod<typeof WS_METHODS.gitCheckout>;
    readonly init: RpcUnaryMethod<typeof WS_METHODS.gitInit>;
    readonly cloneRepository: (
      input: GitCloneRepositoryInput,
      options?: {
        readonly onProgress?: (
          progress: Extract<GitCloneRepositoryEvent, { kind: "progress" }>,
        ) => void;
        readonly signal?: AbortSignal;
      },
    ) => Promise<{ readonly destinationPath: string }>;
    readonly addRemote: RpcUnaryMethod<typeof WS_METHODS.gitAddRemote>;
    readonly gitHubCliStatus: RpcUnaryMethod<typeof WS_METHODS.gitGitHubCliStatus>;
    readonly gitHubCreateRepo: RpcUnaryMethod<typeof WS_METHODS.gitGitHubCreateRepo>;
    readonly resolvePullRequest: RpcUnaryMethod<typeof WS_METHODS.gitResolvePullRequest>;
    readonly preparePullRequestThread: RpcUnaryMethod<
      typeof WS_METHODS.gitPreparePullRequestThread
    >;
  };
  readonly server: {
    readonly getConfig: RpcUnaryNoArgMethod<typeof WS_METHODS.serverGetConfig>;
    readonly refreshProviders: RpcUnaryNoArgMethod<typeof WS_METHODS.serverRefreshProviders>;
    readonly listProviderSlashCommands: RpcUnaryMethod<typeof WS_METHODS.providerListSlashCommands>;
    readonly upsertKeybinding: RpcUnaryMethod<typeof WS_METHODS.serverUpsertKeybinding>;
    readonly removeKeybinding: RpcUnaryMethod<typeof WS_METHODS.serverRemoveKeybinding>;
    readonly getSettings: RpcUnaryNoArgMethod<typeof WS_METHODS.serverGetSettings>;
    readonly updateSettings: (
      patch: ServerSettingsPatch,
    ) => ReturnType<RpcUnaryMethod<typeof WS_METHODS.serverUpdateSettings>>;
    readonly getTraceDiagnostics: RpcUnaryNoArgMethod<typeof WS_METHODS.serverGetTraceDiagnostics>;
    readonly getProcessDiagnostics: RpcUnaryNoArgMethod<
      typeof WS_METHODS.serverGetProcessDiagnostics
    >;
    readonly signalProcess: RpcUnaryMethod<typeof WS_METHODS.serverSignalProcess>;
    readonly checkOtlpEndpoint: RpcUnaryMethod<typeof WS_METHODS.serverCheckOtlpEndpoint>;
    readonly subscribeConfig: RpcStreamMethod<typeof WS_METHODS.subscribeServerConfig>;
    readonly subscribeLifecycle: RpcStreamMethod<typeof WS_METHODS.subscribeServerLifecycle>;
  };
  readonly orchestration: {
    readonly getSnapshot: RpcUnaryNoArgMethod<typeof ORCHESTRATION_WS_METHODS.getSnapshot>;
    readonly dispatchCommand: RpcUnaryMethod<typeof ORCHESTRATION_WS_METHODS.dispatchCommand>;
    readonly getTurnDiff: RpcUnaryMethod<typeof ORCHESTRATION_WS_METHODS.getTurnDiff>;
    readonly getFullThreadDiff: RpcUnaryMethod<typeof ORCHESTRATION_WS_METHODS.getFullThreadDiff>;
    readonly getTurnDiffFileContents: RpcUnaryMethod<
      typeof ORCHESTRATION_WS_METHODS.getTurnDiffFileContents
    >;
    readonly replayEvents: RpcUnaryMethod<typeof ORCHESTRATION_WS_METHODS.replayEvents>;
    readonly onDomainEvent: RpcStreamMethod<typeof WS_METHODS.subscribeOrchestrationDomainEvents>;
    readonly onToolInputPreview: (
      threadId: ThreadId,
      listener: (event: ToolInputPreviewEvent) => void,
    ) => () => void;
  };
}

let sharedWsRpcClient: WsRpcClient | null = null;

export function getWsRpcClient(): WsRpcClient {
  if (sharedWsRpcClient) {
    return sharedWsRpcClient;
  }
  sharedWsRpcClient = createWsRpcClient();
  return sharedWsRpcClient;
}

export async function __resetWsRpcClientForTests() {
  await sharedWsRpcClient?.dispose();
  sharedWsRpcClient = null;
}

export function createWsRpcClient(transport = new WsTransport()): WsRpcClient {
  return {
    dispose: () => transport.dispose(),
    terminal: {
      open: (input) => transport.request((client) => client[WS_METHODS.terminalOpen](input)),
      write: (input) => transport.request((client) => client[WS_METHODS.terminalWrite](input)),
      resize: (input) => transport.request((client) => client[WS_METHODS.terminalResize](input)),
      detach: (input) => transport.request((client) => client[WS_METHODS.terminalDetach](input)),
      clear: (input) => transport.request((client) => client[WS_METHODS.terminalClear](input)),
      restart: (input) => transport.request((client) => client[WS_METHODS.terminalRestart](input)),
      close: (input) => transport.request((client) => client[WS_METHODS.terminalClose](input)),
      onEvent: (listener, options) =>
        transport.subscribe<TerminalEventStreamItem>(
          (client) => client[WS_METHODS.subscribeTerminalEvents]({}),
          (item) => {
            if (item.type === "subscribed") {
              options?.onSubscribed?.();
            } else {
              listener(item);
            }
          },
        ),
      onMetadata: (listener) =>
        transport.subscribe((client) => client[WS_METHODS.subscribeTerminalMetadata]({}), listener),
    },
    projects: {
      searchEntries: (input) =>
        transport.request((client) => client[WS_METHODS.projectsSearchEntries](input)),
      writeFile: (input) =>
        transport.request((client) => client[WS_METHODS.projectsWriteFile](input)),
      readConfigFile: (input) =>
        transport.request((client) => client[WS_METHODS.projectsReadConfigFile](input)),
      checkDirectoryExists: (input) =>
        transport.request((client) => client[WS_METHODS.projectsCheckDirectoryExists](input)),
      statPath: (input) =>
        transport.request((client) => client[WS_METHODS.projectsStatPath](input)),
      createDirectory: (input) =>
        transport.request((client) => client[WS_METHODS.projectsCreateDirectory](input)),
      browseDirectories: (input) =>
        transport.request((client) => client[WS_METHODS.projectsBrowseDirectories](input)),
      scanAgentSessions: () =>
        transport.request((client) => client[WS_METHODS.projectsScanAgentSessions]({})),
    },
    shell: {
      openInEditor: (input) =>
        transport.request((client) => client[WS_METHODS.shellOpenInEditor](input)),
    },
    git: {
      pull: (input) => transport.request((client) => client[WS_METHODS.gitPull](input)),
      status: (input) => transport.request((client) => client[WS_METHODS.gitStatus](input)),
      listCommits: (input) =>
        transport.request((client) => client[WS_METHODS.gitListCommits](input)),
      diffPreview: (input) =>
        transport.request((client) => client[WS_METHODS.gitDiffPreview](input)),
      runStackedAction: async (input, options) => {
        let result: GitRunStackedActionResult | null = null;

        await transport.requestStream(
          (client) => client[WS_METHODS.gitRunStackedAction](input),
          (event) => {
            options?.onProgress?.(event);
            if (event.kind === "action_finished") {
              result = event.result;
            }
          },
        );

        if (result) {
          return result;
        }

        throw new Error("Git action stream completed without a final result.");
      },
      listBranches: (input) =>
        transport.request((client) => client[WS_METHODS.gitListBranches](input)),
      createWorktree: (input) =>
        transport.request((client) => client[WS_METHODS.gitCreateWorktree](input)),
      createWorktreeWithProgress: async (input, options) => {
        let result: GitCreateWorktreeResult | null = null;

        try {
          await transport.requestStream(
            (client) => client[WS_METHODS.gitCreateWorktreeWithProgress](input),
            (event) => {
              if (event.kind === "checkout_progress") {
                options?.onProgress?.(event);
              } else {
                result = event.result;
              }
            },
            { signal: options?.signal },
          );
        } catch (error) {
          // A received `finished` wins over a late abort, or the worktree and its branch are orphaned.
          if (result) return result;
          throw error;
        }

        if (result) {
          return result;
        }

        throw new Error("Worktree creation stream completed without a final result.");
      },
      removeWorktree: (input) =>
        transport.request((client) => client[WS_METHODS.gitRemoveWorktree](input)),
      createBranch: (input) =>
        transport.request((client) => client[WS_METHODS.gitCreateBranch](input)),
      checkout: (input) => transport.request((client) => client[WS_METHODS.gitCheckout](input)),
      init: (input) => transport.request((client) => client[WS_METHODS.gitInit](input)),
      cloneRepository: async (input, options) => {
        let destinationPath: string | null = null;

        await transport.requestStream(
          (client) => client[WS_METHODS.gitCloneRepository](input),
          (event) => {
            if (event.kind === "finished") {
              destinationPath = event.destinationPath;
            } else {
              options?.onProgress?.(event);
            }
          },
          options?.signal ? { signal: options.signal } : undefined,
        );

        if (destinationPath === null) {
          throw new Error("Clone stream completed without a final result.");
        }

        return { destinationPath };
      },
      addRemote: (input) => transport.request((client) => client[WS_METHODS.gitAddRemote](input)),
      gitHubCliStatus: (input) =>
        transport.request((client) => client[WS_METHODS.gitGitHubCliStatus](input)),
      gitHubCreateRepo: (input) =>
        transport.request((client) => client[WS_METHODS.gitGitHubCreateRepo](input)),
      resolvePullRequest: (input) =>
        transport.request((client) => client[WS_METHODS.gitResolvePullRequest](input)),
      preparePullRequestThread: (input) =>
        transport.request((client) => client[WS_METHODS.gitPreparePullRequestThread](input)),
    },
    server: {
      getConfig: () => transport.request((client) => client[WS_METHODS.serverGetConfig]({})),
      refreshProviders: () =>
        transport.request((client) => client[WS_METHODS.serverRefreshProviders]({})),
      listProviderSlashCommands: (input) =>
        transport.request((client) => client[WS_METHODS.providerListSlashCommands](input)),
      upsertKeybinding: (input) =>
        transport.request((client) => client[WS_METHODS.serverUpsertKeybinding](input)),
      removeKeybinding: (input) =>
        transport.request((client) => client[WS_METHODS.serverRemoveKeybinding](input)),
      getSettings: () => transport.request((client) => client[WS_METHODS.serverGetSettings]({})),
      updateSettings: (patch) =>
        transport.request((client) => client[WS_METHODS.serverUpdateSettings]({ patch })),
      getTraceDiagnostics: () =>
        transport.request((client) => client[WS_METHODS.serverGetTraceDiagnostics]({})),
      getProcessDiagnostics: () =>
        transport.request((client) => client[WS_METHODS.serverGetProcessDiagnostics]({})),
      signalProcess: (input) =>
        transport.request((client) => client[WS_METHODS.serverSignalProcess](input)),
      checkOtlpEndpoint: (input) =>
        transport.request((client) => client[WS_METHODS.serverCheckOtlpEndpoint](input)),
      subscribeConfig: (listener) =>
        transport.subscribe((client) => client[WS_METHODS.subscribeServerConfig]({}), listener),
      subscribeLifecycle: (listener) =>
        transport.subscribe((client) => client[WS_METHODS.subscribeServerLifecycle]({}), listener),
    },
    orchestration: {
      getSnapshot: () =>
        transport.request((client) => client[ORCHESTRATION_WS_METHODS.getSnapshot]({})),
      dispatchCommand: (input) =>
        transport.request((client) => client[ORCHESTRATION_WS_METHODS.dispatchCommand](input)),
      getTurnDiff: (input) =>
        transport.request((client) => client[ORCHESTRATION_WS_METHODS.getTurnDiff](input)),
      getFullThreadDiff: (input) =>
        transport.request((client) => client[ORCHESTRATION_WS_METHODS.getFullThreadDiff](input)),
      getTurnDiffFileContents: (input) =>
        transport.request((client) =>
          client[ORCHESTRATION_WS_METHODS.getTurnDiffFileContents](input),
        ),
      replayEvents: (input) =>
        transport
          .request((client) => client[ORCHESTRATION_WS_METHODS.replayEvents](input))
          .then((events) => [...events]),
      onDomainEvent: (listener) =>
        transport.subscribe(
          (client) => client[WS_METHODS.subscribeOrchestrationDomainEvents]({}),
          listener,
        ),
      onToolInputPreview: (threadId, listener) =>
        transport.subscribe(
          (client) => client[WS_METHODS.subscribeToolInputPreview]({ threadId }),
          listener,
        ),
    },
  };
}
