import { type ContextMenuItem, type NativeApi } from "@piedpiper/contracts";

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

  const api: NativeApi = {
    dialogs: {
      pickFolder: async () => {
        if (!window.desktopBridge) return null;
        return window.desktopBridge.pickFolder();
      },
      confirm: async (message) => {
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
      close: (input) => rpcClient.terminal.close(input),
      onEvent: (callback) => rpcClient.terminal.onEvent(callback),
    },
    projects: {
      searchEntries: rpcClient.projects.searchEntries,
      writeFile: rpcClient.projects.writeFile,
    },
    shell: {
      openInEditor: (cwd, editor) => rpcClient.shell.openInEditor({ cwd, editor }),
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
      listBranches: rpcClient.git.listBranches,
      createWorktree: rpcClient.git.createWorktree,
      removeWorktree: rpcClient.git.removeWorktree,
      createBranch: rpcClient.git.createBranch,
      checkout: rpcClient.git.checkout,
      init: rpcClient.git.init,
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
      upsertKeybinding: rpcClient.server.upsertKeybinding,
      getSettings: rpcClient.server.getSettings,
      updateSettings: rpcClient.server.updateSettings,
    },
    orchestration: {
      getSnapshot: rpcClient.orchestration.getSnapshot,
      dispatchCommand: rpcClient.orchestration.dispatchCommand,
      getTurnDiff: rpcClient.orchestration.getTurnDiff,
      getFullThreadDiff: rpcClient.orchestration.getFullThreadDiff,
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
