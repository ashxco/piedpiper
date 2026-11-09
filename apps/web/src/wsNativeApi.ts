import { type ContextMenuItem, type NativeApi } from "@piedpiper/contracts";

import { requestConfirmDialog } from "./confirmDialog";
import { showContextMenuFallback } from "./contextMenuFallback";
import { resetServerStateForTests } from "./rpc/serverState";
import { __resetWsRpcClientForTests, getWsRpcClient } from "./wsRpcClient";

let instance: { api: NativeApi } | null = null;

export function __resetWsNativeApiForTests() {
  instance = null;
  __resetWsRpcClientForTests();
  resetServerStateForTests();
}

export function createWsNativeApi(): NativeApi {
  if (instance) {
    return instance.api;
  }

  const rpcClient = getWsRpcClient();
  const pickProjectFavicon = window.desktopBridge?.pickProjectFavicon;

  const api: NativeApi = {
    dialogs: {
      pickFolder: async () => {
        if (!window.desktopBridge) return null;
        return window.desktopBridge.pickFolder();
      },
      // Stays absent outside the desktop shell: Sidebar hides its menu item on that basis.
      ...(pickProjectFavicon ? { pickProjectFavicon } : {}),
      confirm: async (message) => {
        const themed = requestConfirmDialog(message);
        if (themed) return themed;
        if (window.desktopBridge) {
          return window.desktopBridge.confirm(message);
        }
        return window.confirm(message);
      },
    },
    terminal: {
      // NativeApi declares terminal inputs as Schema `.Encoded` types (e.g.
      // optional `terminalId`), while the RPC client accepts the `.Type` form
      // (required `terminalId` after `withDecodingDefault`). The shapes are
      // compatible at runtime — the RPC serialization layer re-encodes values.
      // @ts-expect-error — `.Encoded` vs `.Type` mismatch on terminalId default
      open: (input) => rpcClient.terminal.open(input),
      // @ts-expect-error — `.Encoded` vs `.Type` mismatch on terminalId default
      write: (input) => rpcClient.terminal.write(input),
      // @ts-expect-error — `.Encoded` vs `.Type` mismatch on terminalId default
      resize: (input) => rpcClient.terminal.resize(input),
      // @ts-expect-error — `.Encoded` vs `.Type` mismatch on terminalId default
      clear: (input) => rpcClient.terminal.clear(input),
      // @ts-expect-error — `.Encoded` vs `.Type` mismatch on terminalId default
      restart: (input) => rpcClient.terminal.restart(input),
      // @ts-expect-error — `.Encoded` vs `.Type` mismatch on terminalId default
      detach: (input) => rpcClient.terminal.detach(input),
      close: (input) => rpcClient.terminal.close(input),
      onEvent: (callback, options?: { readonly onSubscribed?: () => void }) =>
        rpcClient.terminal.onEvent(callback, options),
      onMetadata: (callback) => rpcClient.terminal.onMetadata(callback),
    },
    projects: {
      searchEntries: rpcClient.projects.searchEntries,
      writeFile: rpcClient.projects.writeFile,
      readConfigFile: rpcClient.projects.readConfigFile,
      scanAgentSessions: rpcClient.projects.scanAgentSessions,
    },
    shell: {
      openInEditor: (cwd, editor, options?: { readonly reveal?: boolean }) =>
        rpcClient.shell.openInEditor({ cwd, editor, ...(options?.reveal ? { reveal: true } : {}) }),
      openExternal: async (url) => {
        if (window.desktopBridge) {
          const opened = await window.desktopBridge.openExternal(url);
          if (!opened) {
            throw new Error("Unable to open link.");
          }
          return;
        }

        window.open(url, "_blank", "noopener,noreferrer");
      },
    },
    git: {
      pull: rpcClient.git.pull,
      status: rpcClient.git.status,
      diffPreview: rpcClient.git.diffPreview,
      listCommits: rpcClient.git.listCommits,
      listBranches: rpcClient.git.listBranches,
      createWorktree: rpcClient.git.createWorktree,
      createWorktreeWithProgress: rpcClient.git.createWorktreeWithProgress,
      removeWorktree: rpcClient.git.removeWorktree,
      createBranch: rpcClient.git.createBranch,
      checkout: rpcClient.git.checkout,
      init: rpcClient.git.init,
      cloneRepository: rpcClient.git.cloneRepository,
      addRemote: rpcClient.git.addRemote,
      gitHubCliStatus: rpcClient.git.gitHubCliStatus,
      gitHubCreateRepo: rpcClient.git.gitHubCreateRepo,
      resolvePullRequest: rpcClient.git.resolvePullRequest,
      preparePullRequestThread: rpcClient.git.preparePullRequestThread,
    },
    contextMenu: {
      show: async <T extends string>(
        items: readonly ContextMenuItem<T>[],
        position?: { x: number; y: number },
      ): Promise<T | null> => {
        if (window.desktopBridge) {
          return window.desktopBridge.showContextMenu(items, position) as Promise<T | null>;
        }
        return showContextMenuFallback(items, position);
      },
    },
    server: {
      getConfig: rpcClient.server.getConfig,
      refreshProviders: rpcClient.server.refreshProviders,
      listProviderSlashCommands: rpcClient.server.listProviderSlashCommands,
      upsertKeybinding: rpcClient.server.upsertKeybinding,
      removeKeybinding: rpcClient.server.removeKeybinding,
      getSettings: rpcClient.server.getSettings,
      updateSettings: rpcClient.server.updateSettings,
      getTraceDiagnostics: rpcClient.server.getTraceDiagnostics,
      getProcessDiagnostics: rpcClient.server.getProcessDiagnostics,
      signalProcess: rpcClient.server.signalProcess,
      checkOtlpEndpoint: rpcClient.server.checkOtlpEndpoint,
    },
    orchestration: {
      getSnapshot: rpcClient.orchestration.getSnapshot,
      dispatchCommand: rpcClient.orchestration.dispatchCommand,
      getTurnDiff: rpcClient.orchestration.getTurnDiff,
      getFullThreadDiff: rpcClient.orchestration.getFullThreadDiff,
      getTurnDiffFileContents: rpcClient.orchestration.getTurnDiffFileContents,
      replayEvents: (fromSequenceExclusive) =>
        rpcClient.orchestration
          .replayEvents({ fromSequenceExclusive })
          .then((events) => [...events]),
      onDomainEvent: (callback) => rpcClient.orchestration.onDomainEvent(callback),
    },
  };

  instance = { api };
  return api;
}
