import {
  type GitCloneRepositoryEvent,
  type GitCreateWorktreeProgressEvent,
  WS_METHODS,
} from "@piedpiper/contracts";
import { describe, expect, it, vi } from "vitest";

import { createWsRpcClient } from "./wsRpcClient";
import type { WsTransport } from "./wsTransport";

const INPUT = { cwd: "/repo", branch: "main", newBranch: "feature", path: null };
const RESULT = {
  worktree: { path: "/repo/.worktrees/feature", branch: "feature" },
};
const PROGRESS = {
  kind: "checkout_progress",
  percent: 50,
  completed: 5,
  total: 10,
} as const satisfies GitCreateWorktreeProgressEvent;

function clientWithStream(events: ReadonlyArray<GitCreateWorktreeProgressEvent>) {
  const connect = vi.fn();
  const requestStream = vi.fn(
    async (
      open: (client: Record<string, unknown>) => unknown,
      listener: (event: GitCreateWorktreeProgressEvent) => void,
      _options?: { readonly signal?: AbortSignal | undefined },
    ) => {
      open({ [WS_METHODS.gitCreateWorktreeWithProgress]: connect });
      events.forEach(listener);
    },
  );
  const client = createWsRpcClient({ requestStream } as unknown as WsTransport);
  return { client, connect, requestStream };
}

describe("git.createWorktreeWithProgress", () => {
  it("reports checkout progress, passes the signal on and returns the finished result", async () => {
    const { client, connect, requestStream } = clientWithStream([
      PROGRESS,
      { kind: "finished", result: RESULT },
    ]);
    const onProgress = vi.fn();
    const { signal } = new AbortController();

    await expect(
      client.git.createWorktreeWithProgress(INPUT, { onProgress, signal }),
    ).resolves.toBe(RESULT);

    expect(connect).toHaveBeenCalledWith(INPUT);
    expect(onProgress.mock.calls).toEqual([[PROGRESS]]);
    expect(requestStream.mock.calls[0]?.[2]).toEqual({ signal });
  });

  it("fails when the stream ends without a result", async () => {
    const { client } = clientWithStream([PROGRESS]);

    await expect(client.git.createWorktreeWithProgress(INPUT)).rejects.toThrow(
      "without a final result",
    );
  });
});

const CLONE_INPUT = { url: "https://github.com/acme/repo.git", destinationPath: "/code/repo" };
const CLONE_PROGRESS = {
  kind: "progress",
  stage: "receiving",
  percent: 40,
  detail: null,
} as const satisfies GitCloneRepositoryEvent;

function clientWithCloneStream(events: ReadonlyArray<GitCloneRepositoryEvent>) {
  const connect = vi.fn();
  const requestStream = vi.fn(
    async (
      open: (client: Record<string, unknown>) => unknown,
      listener: (event: GitCloneRepositoryEvent) => void,
      _options?: { readonly signal?: AbortSignal | undefined },
    ) => {
      open({ [WS_METHODS.gitCloneRepository]: connect });
      events.forEach(listener);
    },
  );
  const client = createWsRpcClient({ requestStream } as unknown as WsTransport);
  return { client, connect, requestStream };
}

describe("git.cloneRepository", () => {
  it("reports progress, passes the signal on and returns the destination", async () => {
    const { client, connect, requestStream } = clientWithCloneStream([
      CLONE_PROGRESS,
      { kind: "finished", destinationPath: "/code/repo" },
    ]);
    const onProgress = vi.fn();
    const { signal } = new AbortController();

    await expect(client.git.cloneRepository(CLONE_INPUT, { onProgress, signal })).resolves.toEqual({
      destinationPath: "/code/repo",
    });

    expect(connect).toHaveBeenCalledWith(CLONE_INPUT);
    expect(onProgress.mock.calls).toEqual([[CLONE_PROGRESS]]);
    expect(requestStream.mock.calls[0]?.[2]).toEqual({ signal });
  });

  it("fails when the stream ends without a destination", async () => {
    const { client, requestStream } = clientWithCloneStream([CLONE_PROGRESS]);

    await expect(client.git.cloneRepository(CLONE_INPUT)).rejects.toThrow("without a final result");
    expect(requestStream.mock.calls[0]?.[2]).toBeUndefined();
  });
});

describe("projects.browseDirectories", () => {
  it("sends the partial path over the browse RPC", async () => {
    const result = { entries: [] };
    const browse = vi.fn();
    const request = vi.fn(async (open: (client: Record<string, unknown>) => unknown) => {
      open({ [WS_METHODS.projectsBrowseDirectories]: browse });
      return result;
    });
    const client = createWsRpcClient({ request } as unknown as WsTransport);

    await expect(client.projects.browseDirectories({ partialPath: "/code/" })).resolves.toBe(
      result,
    );
    expect(browse).toHaveBeenCalledWith({ partialPath: "/code/" });
  });
});

describe("terminal.onMetadata", () => {
  it("subscribes to the metadata stream and hands back its unsubscribe", () => {
    const connect = vi.fn();
    const unsubscribe = vi.fn();
    const subscribe = vi.fn(
      (open: (client: Record<string, unknown>) => unknown, _listener: unknown) => {
        open({ [WS_METHODS.subscribeTerminalMetadata]: connect });
        return unsubscribe;
      },
    );
    const listener = vi.fn();

    const stop = createWsRpcClient({ subscribe } as unknown as WsTransport).terminal.onMetadata(
      listener,
    );

    expect(connect).toHaveBeenCalledWith({});
    expect(subscribe.mock.calls[0]?.[1]).toBe(listener);
    expect(stop).toBe(unsubscribe);
  });
});

describe("terminal.onEvent", () => {
  it("reports subscribed frames separately from terminal events", () => {
    const frames: Array<(item: unknown) => void> = [];
    const subscribe = vi.fn((_connect: unknown, listener: (item: unknown) => void) => {
      frames.push(listener);
      return () => undefined;
    });
    const client = createWsRpcClient({ subscribe } as unknown as WsTransport);
    const listener = vi.fn();
    const onSubscribed = vi.fn();

    client.terminal.onEvent(listener, { onSubscribed });
    const event = {
      threadId: "thread-1",
      terminalId: "terminal-1",
      createdAt: "2026-02-24T00:00:00.000Z",
      type: "output",
      data: "hello",
    };
    frames[0]?.({ type: "subscribed" });
    frames[0]?.(event);

    expect(onSubscribed).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls).toEqual([[event]]);
  });

  it("drops subscribed frames when no handler was given", () => {
    const frames: Array<(item: unknown) => void> = [];
    const subscribe = vi.fn((_connect: unknown, listener: (item: unknown) => void) => {
      frames.push(listener);
      return () => undefined;
    });
    const listener = vi.fn();

    createWsRpcClient({ subscribe } as unknown as WsTransport).terminal.onEvent(listener);
    frames[0]?.({ type: "subscribed" });

    expect(listener).not.toHaveBeenCalled();
  });
});
