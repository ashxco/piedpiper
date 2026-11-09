import { Schema } from "effect";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

import { AgentSessionScanError, AgentSessionScanResult } from "./agentSessions";
import { ProviderItemId, ThreadId } from "./baseSchemas";
import { OpenError, OpenInEditorInput } from "./editor";
import {
  GitActionProgressEvent,
  GitAddRemoteInput,
  GitAddRemoteResult,
  GitCheckoutInput,
  GitCommandError,
  GitCreateBranchInput,
  GitCreateWorktreeInput,
  GitCreateWorktreeProgressEvent,
  GitCreateWorktreeResult,
  GitListCommitsInput,
  GitListCommitsResult,
  GitDiffPreviewInput,
  GitDiffPreviewResult,
  GitGitHubCliStatus,
  GitGitHubCliStatusInput,
  GitGitHubCreateRepoInput,
  GitGitHubCreateRepoResult,
  GitInitInput,
  GitListBranchesInput,
  GitListBranchesResult,
  GitManagerServiceError,
  GitPreparePullRequestThreadInput,
  GitPreparePullRequestThreadResult,
  GitPullInput,
  GitPullRequestRefInput,
  GitPullResult,
  GitRemoveWorktreeInput,
  GitResolvePullRequestResult,
  GitRunStackedActionInput,
  GitStatusInput,
  GitStatusResult,
} from "./git";
import { GitCloneRepositoryEvent, GitCloneRepositoryInput } from "./gitClone";
import { KeybindingsConfigError } from "./keybindings";
import {
  ClientOrchestrationCommand,
  OrchestrationEvent,
  ORCHESTRATION_WS_METHODS,
  OrchestrationDispatchCommandError,
  OrchestrationGetFullThreadDiffError,
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetSnapshotError,
  OrchestrationGetSnapshotInput,
  OrchestrationGetTurnDiffError,
  OrchestrationGetTurnDiffFileContentsError,
  OrchestrationGetTurnDiffFileContentsInput,
  OrchestrationGetTurnDiffInput,
  OrchestrationReplayEventsError,
  OrchestrationReplayEventsInput,
  OrchestrationRpcSchemas,
} from "./orchestration";
import {
  ProjectCheckDirectoryExistsInput,
  ProjectCheckDirectoryExistsResult,
  ProjectSearchEntriesError,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
  ProjectCreateDirectoryError,
  ProjectCreateDirectoryInput,
  ProjectCreateDirectoryResult,
  ProjectReadConfigFileInput,
  ProjectReadConfigFileResult,
  ProjectStatPathInput,
  ProjectStatPathResult,
  ProjectWriteFileError,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "./project";
import {
  ProjectBrowseDirectoriesError,
  ProjectBrowseDirectoriesInput,
  ProjectBrowseDirectoriesResult,
} from "./projectBrowse";
import {
  TerminalClearInput,
  TerminalCloseInput,
  TerminalError,
  TerminalEventStreamItem,
  TerminalMetadataStreamEvent,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalDetachInput,
  TerminalRestartInput,
  TerminalSessionSnapshot,
  TerminalWriteInput,
} from "./terminal";
import {
  ProviderListSlashCommandsInput,
  ProviderListSlashCommandsResult,
  ServerConfigStreamEvent,
  ServerConfig,
  ServerLifecycleStreamEvent,
  ServerProviderUpdatedPayload,
  ServerRemoveKeybindingInput,
  ServerRemoveKeybindingResult,
  ServerUpsertKeybindingInput,
  ServerUpsertKeybindingResult,
} from "./server";
import {
  OtlpEndpointCheckInput,
  OtlpEndpointCheckResult,
  ServerProcessDiagnosticsResult,
  ServerSignalProcessInput,
  ServerSignalProcessResult,
  ServerTraceDiagnosticsResult,
} from "./serverDiagnostics";
import { ServerSettings, ServerSettingsError, ServerSettingsPatch } from "./settings";

export const WS_METHODS = {
  // Project registry methods
  projectsList: "projects.list",
  projectsAdd: "projects.add",
  projectsRemove: "projects.remove",
  projectsSearchEntries: "projects.searchEntries",
  projectsWriteFile: "projects.writeFile",
  projectsReadConfigFile: "projects.readConfigFile",
  projectsCheckDirectoryExists: "projects.checkDirectoryExists",
  projectsStatPath: "projects.statPath",
  projectsCreateDirectory: "projects.createDirectory",
  projectsBrowseDirectories: "projects.browseDirectories",
  projectsScanAgentSessions: "projects.scanAgentSessions",

  // Shell methods
  shellOpenInEditor: "shell.openInEditor",

  // Git methods
  gitPull: "git.pull",
  gitStatus: "git.status",
  gitDiffPreview: "git.diffPreview",
  gitListCommits: "git.listCommits",
  gitRunStackedAction: "git.runStackedAction",
  gitListBranches: "git.listBranches",
  gitCreateWorktree: "git.createWorktree",
  gitCreateWorktreeWithProgress: "git.createWorktreeWithProgress",
  gitRemoveWorktree: "git.removeWorktree",
  gitCreateBranch: "git.createBranch",
  gitCheckout: "git.checkout",
  gitInit: "git.init",
  gitCloneRepository: "git.cloneRepository",
  gitAddRemote: "git.addRemote",
  gitGitHubCliStatus: "git.gitHubCliStatus",
  gitGitHubCreateRepo: "git.gitHubCreateRepo",
  gitResolvePullRequest: "git.resolvePullRequest",
  gitPreparePullRequestThread: "git.preparePullRequestThread",

  // Terminal methods
  terminalOpen: "terminal.open",
  terminalWrite: "terminal.write",
  terminalResize: "terminal.resize",
  terminalDetach: "terminal.detach",
  terminalClear: "terminal.clear",
  terminalRestart: "terminal.restart",
  terminalClose: "terminal.close",

  // Server meta
  serverGetConfig: "server.getConfig",
  serverRefreshProviders: "server.refreshProviders",
  serverUpsertKeybinding: "server.upsertKeybinding",
  serverRemoveKeybinding: "server.removeKeybinding",
  serverGetSettings: "server.getSettings",
  serverUpdateSettings: "server.updateSettings",
  serverGetTraceDiagnostics: "server.getTraceDiagnostics",
  serverGetProcessDiagnostics: "server.getProcessDiagnostics",
  serverSignalProcess: "server.signalProcess",
  serverCheckOtlpEndpoint: "server.checkOtlpEndpoint",
  providerListSlashCommands: "provider.listSlashCommands",

  // Streaming subscriptions
  subscribeOrchestrationDomainEvents: "subscribeOrchestrationDomainEvents",
  subscribeTerminalEvents: "subscribeTerminalEvents",
  subscribeTerminalMetadata: "subscribeTerminalMetadata",
  subscribeServerConfig: "subscribeServerConfig",
  subscribeServerLifecycle: "subscribeServerLifecycle",
  subscribeToolInputPreview: "subscribeToolInputPreview",
} as const;

/**
 * Live tool-input preview event. Emitted as the model streams in the
 * partial JSON for a tool call so the frontend can render the value
 * being typed character-by-character. Lives outside the durable
 * orchestration event store — preview state is transient and dies
 * with the turn.
 */
export const ToolInputPreviewEvent = Schema.Struct({
  threadId: ThreadId,
  itemId: ProviderItemId,
  toolName: Schema.String,
  fieldName: Schema.String,
  filePath: Schema.optional(Schema.String),
  // For Edit-style tools — the value of `old_string` captured from the
  // partial JSON, used to render the removed lines as a real diff. Always
  // sent on every preview event so the frontend can pick it up regardless
  // of which delta exposes it for the first time.
  oldString: Schema.optional(Schema.String),
  delta: Schema.String,
});
export type ToolInputPreviewEvent = typeof ToolInputPreviewEvent.Type;

const ToolInputPreviewSubscriptionInput = Schema.Struct({
  threadId: ThreadId,
});

const WsServerUpsertKeybindingRpc = Rpc.make(WS_METHODS.serverUpsertKeybinding, {
  payload: ServerUpsertKeybindingInput,
  success: ServerUpsertKeybindingResult,
  error: KeybindingsConfigError,
});

const WsServerRemoveKeybindingRpc = Rpc.make(WS_METHODS.serverRemoveKeybinding, {
  payload: ServerRemoveKeybindingInput,
  success: ServerRemoveKeybindingResult,
  error: KeybindingsConfigError,
});

const WsServerGetConfigRpc = Rpc.make(WS_METHODS.serverGetConfig, {
  payload: Schema.Struct({}),
  success: ServerConfig,
  error: Schema.Union([KeybindingsConfigError, ServerSettingsError]),
});

const WsServerRefreshProvidersRpc = Rpc.make(WS_METHODS.serverRefreshProviders, {
  payload: Schema.Struct({}),
  success: ServerProviderUpdatedPayload,
});

const WsServerGetSettingsRpc = Rpc.make(WS_METHODS.serverGetSettings, {
  payload: Schema.Struct({}),
  success: ServerSettings,
  error: ServerSettingsError,
});

const WsServerUpdateSettingsRpc = Rpc.make(WS_METHODS.serverUpdateSettings, {
  payload: Schema.Struct({ patch: ServerSettingsPatch }),
  success: ServerSettings,
  error: ServerSettingsError,
});

const WsServerGetTraceDiagnosticsRpc = Rpc.make(WS_METHODS.serverGetTraceDiagnostics, {
  payload: Schema.Struct({}),
  success: ServerTraceDiagnosticsResult,
});

const WsServerGetProcessDiagnosticsRpc = Rpc.make(WS_METHODS.serverGetProcessDiagnostics, {
  payload: Schema.Struct({}),
  success: ServerProcessDiagnosticsResult,
});

const WsServerSignalProcessRpc = Rpc.make(WS_METHODS.serverSignalProcess, {
  payload: ServerSignalProcessInput,
  success: ServerSignalProcessResult,
});

const WsServerCheckOtlpEndpointRpc = Rpc.make(WS_METHODS.serverCheckOtlpEndpoint, {
  payload: OtlpEndpointCheckInput,
  success: OtlpEndpointCheckResult,
});

const WsProviderListSlashCommandsRpc = Rpc.make(WS_METHODS.providerListSlashCommands, {
  payload: ProviderListSlashCommandsInput,
  success: ProviderListSlashCommandsResult,
});

const WsProjectsSearchEntriesRpc = Rpc.make(WS_METHODS.projectsSearchEntries, {
  payload: ProjectSearchEntriesInput,
  success: ProjectSearchEntriesResult,
  error: ProjectSearchEntriesError,
});

const WsProjectsWriteFileRpc = Rpc.make(WS_METHODS.projectsWriteFile, {
  payload: ProjectWriteFileInput,
  success: ProjectWriteFileResult,
  error: ProjectWriteFileError,
});

const WsProjectsReadConfigFileRpc = Rpc.make(WS_METHODS.projectsReadConfigFile, {
  payload: ProjectReadConfigFileInput,
  success: ProjectReadConfigFileResult,
});

const WsProjectsCheckDirectoryExistsRpc = Rpc.make(WS_METHODS.projectsCheckDirectoryExists, {
  payload: ProjectCheckDirectoryExistsInput,
  success: ProjectCheckDirectoryExistsResult,
});

const WsProjectsStatPathRpc = Rpc.make(WS_METHODS.projectsStatPath, {
  payload: ProjectStatPathInput,
  success: ProjectStatPathResult,
});

const WsProjectsCreateDirectoryRpc = Rpc.make(WS_METHODS.projectsCreateDirectory, {
  payload: ProjectCreateDirectoryInput,
  success: ProjectCreateDirectoryResult,
  error: ProjectCreateDirectoryError,
});

const WsProjectsBrowseDirectoriesRpc = Rpc.make(WS_METHODS.projectsBrowseDirectories, {
  payload: ProjectBrowseDirectoriesInput,
  success: ProjectBrowseDirectoriesResult,
  error: ProjectBrowseDirectoriesError,
});

const WsProjectsScanAgentSessionsRpc = Rpc.make(WS_METHODS.projectsScanAgentSessions, {
  payload: Schema.Struct({}),
  success: AgentSessionScanResult,
  error: AgentSessionScanError,
});

const WsShellOpenInEditorRpc = Rpc.make(WS_METHODS.shellOpenInEditor, {
  payload: OpenInEditorInput,
  error: OpenError,
});

const WsGitStatusRpc = Rpc.make(WS_METHODS.gitStatus, {
  payload: GitStatusInput,
  success: GitStatusResult,
  error: GitManagerServiceError,
});

const WsGitListCommitsRpc = Rpc.make(WS_METHODS.gitListCommits, {
  payload: GitListCommitsInput,
  success: GitListCommitsResult,
  error: GitCommandError,
});

const WsGitDiffPreviewRpc = Rpc.make(WS_METHODS.gitDiffPreview, {
  payload: GitDiffPreviewInput,
  success: GitDiffPreviewResult,
  error: GitCommandError,
});

const WsGitPullRpc = Rpc.make(WS_METHODS.gitPull, {
  payload: GitPullInput,
  success: GitPullResult,
  error: GitCommandError,
});

const WsGitRunStackedActionRpc = Rpc.make(WS_METHODS.gitRunStackedAction, {
  payload: GitRunStackedActionInput,
  success: GitActionProgressEvent,
  error: GitManagerServiceError,
  stream: true,
});

const WsGitResolvePullRequestRpc = Rpc.make(WS_METHODS.gitResolvePullRequest, {
  payload: GitPullRequestRefInput,
  success: GitResolvePullRequestResult,
  error: GitManagerServiceError,
});

const WsGitPreparePullRequestThreadRpc = Rpc.make(WS_METHODS.gitPreparePullRequestThread, {
  payload: GitPreparePullRequestThreadInput,
  success: GitPreparePullRequestThreadResult,
  error: GitManagerServiceError,
});

const WsGitListBranchesRpc = Rpc.make(WS_METHODS.gitListBranches, {
  payload: GitListBranchesInput,
  success: GitListBranchesResult,
  error: GitCommandError,
});

const WsGitCreateWorktreeRpc = Rpc.make(WS_METHODS.gitCreateWorktree, {
  payload: GitCreateWorktreeInput,
  success: GitCreateWorktreeResult,
  error: GitCommandError,
});

const WsGitCreateWorktreeWithProgressRpc = Rpc.make(WS_METHODS.gitCreateWorktreeWithProgress, {
  payload: GitCreateWorktreeInput,
  success: GitCreateWorktreeProgressEvent,
  error: GitCommandError,
  stream: true,
});

const WsGitRemoveWorktreeRpc = Rpc.make(WS_METHODS.gitRemoveWorktree, {
  payload: GitRemoveWorktreeInput,
  error: GitCommandError,
});

const WsGitCreateBranchRpc = Rpc.make(WS_METHODS.gitCreateBranch, {
  payload: GitCreateBranchInput,
  error: GitCommandError,
});

const WsGitCheckoutRpc = Rpc.make(WS_METHODS.gitCheckout, {
  payload: GitCheckoutInput,
  error: GitCommandError,
});

const WsGitInitRpc = Rpc.make(WS_METHODS.gitInit, {
  payload: GitInitInput,
  error: GitCommandError,
});

const WsGitCloneRepositoryRpc = Rpc.make(WS_METHODS.gitCloneRepository, {
  payload: GitCloneRepositoryInput,
  success: GitCloneRepositoryEvent,
  error: GitCommandError,
  stream: true,
});

const WsGitAddRemoteRpc = Rpc.make(WS_METHODS.gitAddRemote, {
  payload: GitAddRemoteInput,
  success: GitAddRemoteResult,
  error: GitCommandError,
});

const WsGitGitHubCliStatusRpc = Rpc.make(WS_METHODS.gitGitHubCliStatus, {
  payload: GitGitHubCliStatusInput,
  success: GitGitHubCliStatus,
});

const WsGitGitHubCreateRepoRpc = Rpc.make(WS_METHODS.gitGitHubCreateRepo, {
  payload: GitGitHubCreateRepoInput,
  success: GitGitHubCreateRepoResult,
  error: GitCommandError,
});

const WsTerminalOpenRpc = Rpc.make(WS_METHODS.terminalOpen, {
  payload: TerminalOpenInput,
  success: TerminalSessionSnapshot,
  error: TerminalError,
});

const WsTerminalWriteRpc = Rpc.make(WS_METHODS.terminalWrite, {
  payload: TerminalWriteInput,
  error: TerminalError,
});

const WsTerminalDetachRpc = Rpc.make(WS_METHODS.terminalDetach, {
  payload: TerminalDetachInput,
  success: Schema.Void,
  error: TerminalError,
});

const WsTerminalResizeRpc = Rpc.make(WS_METHODS.terminalResize, {
  payload: TerminalResizeInput,
  error: TerminalError,
});

const WsTerminalClearRpc = Rpc.make(WS_METHODS.terminalClear, {
  payload: TerminalClearInput,
  error: TerminalError,
});

const WsTerminalRestartRpc = Rpc.make(WS_METHODS.terminalRestart, {
  payload: TerminalRestartInput,
  success: TerminalSessionSnapshot,
  error: TerminalError,
});

const WsTerminalCloseRpc = Rpc.make(WS_METHODS.terminalClose, {
  payload: TerminalCloseInput,
  error: TerminalError,
});

const WsOrchestrationGetSnapshotRpc = Rpc.make(ORCHESTRATION_WS_METHODS.getSnapshot, {
  payload: OrchestrationGetSnapshotInput,
  success: OrchestrationRpcSchemas.getSnapshot.output,
  error: OrchestrationGetSnapshotError,
});

const WsOrchestrationDispatchCommandRpc = Rpc.make(ORCHESTRATION_WS_METHODS.dispatchCommand, {
  payload: ClientOrchestrationCommand,
  success: OrchestrationRpcSchemas.dispatchCommand.output,
  error: OrchestrationDispatchCommandError,
});

const WsOrchestrationGetTurnDiffRpc = Rpc.make(ORCHESTRATION_WS_METHODS.getTurnDiff, {
  payload: OrchestrationGetTurnDiffInput,
  success: OrchestrationRpcSchemas.getTurnDiff.output,
  error: OrchestrationGetTurnDiffError,
});

const WsOrchestrationGetFullThreadDiffRpc = Rpc.make(ORCHESTRATION_WS_METHODS.getFullThreadDiff, {
  payload: OrchestrationGetFullThreadDiffInput,
  success: OrchestrationRpcSchemas.getFullThreadDiff.output,
  error: OrchestrationGetFullThreadDiffError,
});

const WsOrchestrationGetTurnDiffFileContentsRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.getTurnDiffFileContents,
  {
    payload: OrchestrationGetTurnDiffFileContentsInput,
    success: OrchestrationRpcSchemas.getTurnDiffFileContents.output,
    error: OrchestrationGetTurnDiffFileContentsError,
  },
);

const WsOrchestrationReplayEventsRpc = Rpc.make(ORCHESTRATION_WS_METHODS.replayEvents, {
  payload: OrchestrationReplayEventsInput,
  success: OrchestrationRpcSchemas.replayEvents.output,
  error: OrchestrationReplayEventsError,
});

const WsSubscribeOrchestrationDomainEventsRpc = Rpc.make(
  WS_METHODS.subscribeOrchestrationDomainEvents,
  {
    payload: Schema.Struct({}),
    success: OrchestrationEvent,
    stream: true,
  },
);

const WsSubscribeTerminalEventsRpc = Rpc.make(WS_METHODS.subscribeTerminalEvents, {
  payload: Schema.Struct({}),
  success: TerminalEventStreamItem,
  stream: true,
});

const WsSubscribeTerminalMetadataRpc = Rpc.make(WS_METHODS.subscribeTerminalMetadata, {
  payload: Schema.Struct({}),
  success: TerminalMetadataStreamEvent,
  stream: true,
});

const WsSubscribeServerConfigRpc = Rpc.make(WS_METHODS.subscribeServerConfig, {
  payload: Schema.Struct({}),
  success: ServerConfigStreamEvent,
  error: Schema.Union([KeybindingsConfigError, ServerSettingsError]),
  stream: true,
});

const WsSubscribeServerLifecycleRpc = Rpc.make(WS_METHODS.subscribeServerLifecycle, {
  payload: Schema.Struct({}),
  success: ServerLifecycleStreamEvent,
  stream: true,
});

const WsSubscribeToolInputPreviewRpc = Rpc.make(WS_METHODS.subscribeToolInputPreview, {
  payload: ToolInputPreviewSubscriptionInput,
  success: ToolInputPreviewEvent,
  stream: true,
});

export const WsRpcGroup = RpcGroup.make(
  WsServerGetConfigRpc,
  WsServerRefreshProvidersRpc,
  WsServerUpsertKeybindingRpc,
  WsServerRemoveKeybindingRpc,
  WsServerGetSettingsRpc,
  WsServerUpdateSettingsRpc,
  WsServerGetTraceDiagnosticsRpc,
  WsServerGetProcessDiagnosticsRpc,
  WsServerSignalProcessRpc,
  WsServerCheckOtlpEndpointRpc,
  WsProviderListSlashCommandsRpc,
  WsProjectsSearchEntriesRpc,
  WsProjectsWriteFileRpc,
  WsProjectsReadConfigFileRpc,
  WsProjectsCheckDirectoryExistsRpc,
  WsProjectsCreateDirectoryRpc,
  WsProjectsStatPathRpc,
  WsProjectsBrowseDirectoriesRpc,
  WsProjectsScanAgentSessionsRpc,
  WsShellOpenInEditorRpc,
  WsGitStatusRpc,
  WsGitDiffPreviewRpc,
  WsGitListCommitsRpc,
  WsGitPullRpc,
  WsGitRunStackedActionRpc,
  WsGitResolvePullRequestRpc,
  WsGitPreparePullRequestThreadRpc,
  WsGitListBranchesRpc,
  WsGitCreateWorktreeRpc,
  WsGitCreateWorktreeWithProgressRpc,
  WsGitRemoveWorktreeRpc,
  WsGitCreateBranchRpc,
  WsGitCheckoutRpc,
  WsGitInitRpc,
  WsGitCloneRepositoryRpc,
  WsGitAddRemoteRpc,
  WsGitGitHubCliStatusRpc,
  WsGitGitHubCreateRepoRpc,
  WsTerminalOpenRpc,
  WsTerminalWriteRpc,
  WsTerminalResizeRpc,
  WsTerminalDetachRpc,
  WsTerminalClearRpc,
  WsTerminalRestartRpc,
  WsTerminalCloseRpc,
  WsSubscribeOrchestrationDomainEventsRpc,
  WsSubscribeTerminalEventsRpc,
  WsSubscribeTerminalMetadataRpc,
  WsSubscribeServerConfigRpc,
  WsSubscribeServerLifecycleRpc,
  WsSubscribeToolInputPreviewRpc,
  WsOrchestrationGetSnapshotRpc,
  WsOrchestrationDispatchCommandRpc,
  WsOrchestrationGetTurnDiffRpc,
  WsOrchestrationGetFullThreadDiffRpc,
  WsOrchestrationGetTurnDiffFileContentsRpc,
  WsOrchestrationReplayEventsRpc,
);
