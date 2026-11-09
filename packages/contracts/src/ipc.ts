import type { AgentSessionScanResult } from "./agentSessions";
import type {
  GitAddRemoteInput,
  GitAddRemoteResult,
  GitCheckoutInput,
  GitCreateBranchInput,
  GitGitHubCliStatus,
  GitGitHubCliStatusInput,
  GitGitHubCreateRepoInput,
  GitGitHubCreateRepoResult,
  GitPreparePullRequestThreadInput,
  GitPreparePullRequestThreadResult,
  GitPullRequestRefInput,
  GitCreateWorktreeInput,
  GitCreateWorktreeProgressEvent,
  GitCreateWorktreeResult,
  GitInitInput,
  GitListBranchesInput,
  GitListBranchesResult,
  GitPullInput,
  GitPullResult,
  GitRemoveWorktreeInput,
  GitResolvePullRequestResult,
  GitListCommitsInput,
  GitListCommitsResult,
  GitDiffPreviewInput,
  GitDiffPreviewResult,
  GitStatusInput,
  GitStatusResult,
} from "./git";
import type { GitCloneRepositoryEvent, GitCloneRepositoryInput } from "./gitClone";
import type {
  ProjectReadConfigFileInput,
  ProjectReadConfigFileResult,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "./project";
import type {
  ProviderListSlashCommandsInput,
  ProviderListSlashCommandsResult,
  ServerConfig,
  ServerProviderUpdatedPayload,
  ServerRemoveKeybindingInput,
  ServerRemoveKeybindingResult,
  ServerUpsertKeybindingResult,
} from "./server";
import type {
  TerminalClearInput,
  TerminalCloseInput,
  TerminalEvent,
  TerminalMetadataStreamEvent,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalDetachInput,
  TerminalRestartInput,
  TerminalSessionSnapshot,
  TerminalWriteInput,
} from "./terminal";
import type { ServerUpsertKeybindingInput } from "./server";
import type {
  OtlpEndpointCheckInput,
  OtlpEndpointCheckResult,
  ServerProcessDiagnosticsResult,
  ServerSignalProcessInput,
  ServerSignalProcessResult,
  ServerTraceDiagnosticsResult,
} from "./serverDiagnostics";
import type {
  ClientOrchestrationCommand,
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetFullThreadDiffResult,
  OrchestrationGetTurnDiffFileContentsInput,
  OrchestrationGetTurnDiffFileContentsResult,
  OrchestrationGetTurnDiffInput,
  OrchestrationGetTurnDiffResult,
  OrchestrationEvent,
  OrchestrationReadModel,
} from "./orchestration";
import { EditorId } from "./editor";
import { ServerSettings, ServerSettingsPatch } from "./settings";
import type { QuitConfirmationMode } from "./settings";

export interface ContextMenuItem<T extends string = string> {
  id: T;
  label: string;
  destructive?: boolean;
  disabled?: boolean;
}

export type DesktopUpdateStatus =
  | "disabled"
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "downloaded"
  | "error";

export type DesktopRuntimeArch = "arm64" | "x64" | "other";
export type DesktopTheme = "light" | "dark" | "system";

export interface DesktopRuntimeInfo {
  hostArch: DesktopRuntimeArch;
  appArch: DesktopRuntimeArch;
  runningUnderArm64Translation: boolean;
}

export interface DesktopUpdateState {
  enabled: boolean;
  status: DesktopUpdateStatus;
  currentVersion: string;
  hostArch: DesktopRuntimeArch;
  appArch: DesktopRuntimeArch;
  runningUnderArm64Translation: boolean;
  availableVersion: string | null;
  downloadedVersion: string | null;
  downloadPercent: number | null;
  checkedAt: string | null;
  message: string | null;
  errorContext: "check" | "download" | "install" | null;
  canRetry: boolean;
  /** Version the last install failed to apply, when the app came back on the version it installed from. */
  notAppliedVersion?: string;
}

export interface DesktopUpdateActionResult {
  accepted: boolean;
  completed: boolean;
  state: DesktopUpdateState;
}

export interface DesktopUpdateCheckResult {
  checked: boolean;
  state: DesktopUpdateState;
}

export type QuitShortcutHintEvent =
  | { readonly state: "down"; readonly mode: Exclude<QuitConfirmationMode, "direct"> }
  | { readonly state: "up" };

export interface DesktopBridge {
  getWsUrl: () => string | null;
  getPathForFile: (file: File) => string;
  pickFolder: () => Promise<string | null>;
  /** Image file picker for a project icon. Optional while older desktop shells host a newer client. */
  pickProjectFavicon?: (initialPath?: string) => Promise<string | null>;
  /** The OS locale as a BCP-47 tag; a packaged app pins navigator.language and Intl to en-US. Optional while older desktop shells host a newer client. */
  getSystemLocale?: () => string | null;
  confirm: (message: string) => Promise<boolean>;
  setTheme: (theme: DesktopTheme) => Promise<void>;
  showContextMenu: <T extends string>(
    items: readonly ContextMenuItem<T>[],
    position?: { x: number; y: number },
  ) => Promise<T | null>;
  openExternal: (url: string) => Promise<boolean>;
  onMenuAction: (listener: (action: string) => void) => () => void;
  getUpdateState: () => Promise<DesktopUpdateState>;
  checkForUpdate: () => Promise<DesktopUpdateCheckResult>;
  downloadUpdate: () => Promise<DesktopUpdateActionResult>;
  installUpdate: () => Promise<DesktopUpdateActionResult>;
  onUpdateState: (listener: (state: DesktopUpdateState) => void) => () => void;
  /** Whether this window is in native fullscreen (macOS hides the traffic lights then). */
  getWindowFullscreenState?: () => boolean;
  onWindowFullscreenStateChange?: (listener: (fullscreen: boolean) => void) => () => void;
  /** Pushes the confirmQuit client setting to the main process's Cmd/Ctrl+Q guard. */
  setQuitConfirmationMode?: (mode: QuitConfirmationMode) => void;
  onQuitShortcut?: (listener: (event: QuitShortcutHintEvent) => void) => () => void;
  /** Sets the dock/taskbar badge to the number of threads needing attention; 0 clears it. */
  setBadgeCount?: (count: number) => Promise<void>;
  /** Raises this window when minimized or hidden. Optional while older desktop shells host a newer client. */
  revealWindow?: () => Promise<void>;
}

export interface NativeApi {
  dialogs: {
    pickFolder: () => Promise<string | null>;
    /** Absent outside the desktop shell. */
    pickProjectFavicon?: (initialPath?: string) => Promise<string | null>;
    confirm: (message: string) => Promise<boolean>;
  };
  terminal: {
    open: (input: typeof TerminalOpenInput.Encoded) => Promise<TerminalSessionSnapshot>;
    write: (input: typeof TerminalWriteInput.Encoded) => Promise<void>;
    resize: (input: typeof TerminalResizeInput.Encoded) => Promise<void>;
    detach?: (input: typeof TerminalDetachInput.Encoded) => Promise<void>;
    clear: (input: typeof TerminalClearInput.Encoded) => Promise<void>;
    restart: (input: typeof TerminalRestartInput.Encoded) => Promise<TerminalSessionSnapshot>;
    close: (input: typeof TerminalCloseInput.Encoded) => Promise<void>;
    onEvent: (
      callback: (event: TerminalEvent) => void,
      options?: { onSubscribed?: () => void },
    ) => () => void;
    onMetadata: (callback: (event: TerminalMetadataStreamEvent) => void) => () => void;
  };
  projects: {
    searchEntries: (input: ProjectSearchEntriesInput) => Promise<ProjectSearchEntriesResult>;
    writeFile: (input: ProjectWriteFileInput) => Promise<ProjectWriteFileResult>;
    readConfigFile: (input: ProjectReadConfigFileInput) => Promise<ProjectReadConfigFileResult>;
    scanAgentSessions: () => Promise<AgentSessionScanResult>;
  };
  shell: {
    openInEditor: (
      cwd: string,
      editor: EditorId,
      options?: { readonly reveal?: boolean },
    ) => Promise<void>;
    openExternal: (url: string) => Promise<void>;
  };
  git: {
    // Existing branch/worktree API
    listBranches: (input: GitListBranchesInput) => Promise<GitListBranchesResult>;
    createWorktree: (input: GitCreateWorktreeInput) => Promise<GitCreateWorktreeResult>;
    /** Absent on a host that cannot stream it; callers fall back to createWorktree. */
    createWorktreeWithProgress?: (
      input: GitCreateWorktreeInput,
      options: {
        readonly onProgress?:
          | ((
              progress: Extract<GitCreateWorktreeProgressEvent, { kind: "checkout_progress" }>,
            ) => void)
          | undefined;
        readonly signal?: AbortSignal | undefined;
      },
    ) => Promise<GitCreateWorktreeResult>;
    removeWorktree: (input: GitRemoveWorktreeInput) => Promise<void>;
    createBranch: (input: GitCreateBranchInput) => Promise<void>;
    checkout: (input: GitCheckoutInput) => Promise<void>;
    init: (input: GitInitInput) => Promise<void>;
    /** Absent on a host that cannot stream it, which hides the clone entry point. */
    cloneRepository?: (
      input: GitCloneRepositoryInput,
      options?: {
        readonly onProgress?: (
          progress: Extract<GitCloneRepositoryEvent, { kind: "progress" }>,
        ) => void;
        readonly signal?: AbortSignal;
      },
    ) => Promise<{ readonly destinationPath: string }>;
    addRemote: (input: GitAddRemoteInput) => Promise<GitAddRemoteResult>;
    gitHubCliStatus: (input: GitGitHubCliStatusInput) => Promise<GitGitHubCliStatus>;
    gitHubCreateRepo: (input: GitGitHubCreateRepoInput) => Promise<GitGitHubCreateRepoResult>;
    resolvePullRequest: (input: GitPullRequestRefInput) => Promise<GitResolvePullRequestResult>;
    preparePullRequestThread: (
      input: GitPreparePullRequestThreadInput,
    ) => Promise<GitPreparePullRequestThreadResult>;
    // Stacked action API
    pull: (input: GitPullInput) => Promise<GitPullResult>;
    status: (input: GitStatusInput) => Promise<GitStatusResult>;
    diffPreview: (input: GitDiffPreviewInput) => Promise<GitDiffPreviewResult>;
    listCommits: (input: GitListCommitsInput) => Promise<GitListCommitsResult>;
  };
  contextMenu: {
    show: <T extends string>(
      items: readonly ContextMenuItem<T>[],
      position?: { x: number; y: number },
    ) => Promise<T | null>;
  };
  server: {
    getConfig: () => Promise<ServerConfig>;
    refreshProviders: () => Promise<ServerProviderUpdatedPayload>;
    upsertKeybinding: (input: ServerUpsertKeybindingInput) => Promise<ServerUpsertKeybindingResult>;
    removeKeybinding: (input: ServerRemoveKeybindingInput) => Promise<ServerRemoveKeybindingResult>;
    getSettings: () => Promise<ServerSettings>;
    updateSettings: (patch: ServerSettingsPatch) => Promise<ServerSettings>;
    getTraceDiagnostics: () => Promise<ServerTraceDiagnosticsResult>;
    getProcessDiagnostics: () => Promise<ServerProcessDiagnosticsResult>;
    signalProcess: (input: ServerSignalProcessInput) => Promise<ServerSignalProcessResult>;
    checkOtlpEndpoint: (input: OtlpEndpointCheckInput) => Promise<OtlpEndpointCheckResult>;
    listProviderSlashCommands: (
      input: ProviderListSlashCommandsInput,
    ) => Promise<ProviderListSlashCommandsResult>;
  };
  orchestration: {
    getSnapshot: () => Promise<OrchestrationReadModel>;
    dispatchCommand: (command: ClientOrchestrationCommand) => Promise<{ sequence: number }>;
    getTurnDiff: (input: OrchestrationGetTurnDiffInput) => Promise<OrchestrationGetTurnDiffResult>;
    getFullThreadDiff: (
      input: OrchestrationGetFullThreadDiffInput,
    ) => Promise<OrchestrationGetFullThreadDiffResult>;
    getTurnDiffFileContents: (
      input: OrchestrationGetTurnDiffFileContentsInput,
    ) => Promise<OrchestrationGetTurnDiffFileContentsResult>;
    replayEvents: (fromSequenceExclusive: number) => Promise<OrchestrationEvent[]>;
    onDomainEvent: (callback: (event: OrchestrationEvent) => void) => () => void;
  };
}
