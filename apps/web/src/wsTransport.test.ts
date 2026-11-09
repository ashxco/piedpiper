import { WS_METHODS } from "@piedpiper/contracts";
import { Effect, Stream } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetClientTracingForTests,
  configureClientTracing,
} from "./observability/clientTracing";
import {
  MAX_SUBSCRIPTION_RETRY_DELAY_MS,
  SUBSCRIPTION_HEALTHY_RUN_MS,
  subscriptionRetryDelayMs,
  WsTransport,
} from "./wsTransport";
import { createWsFirstOpenGate } from "./rpc/wsFirstOpenGate";

type WsEventType = "open" | "message" | "close" | "error";
type WsEvent = { code?: number; data?: unknown; reason?: string; type?: string };
type WsListener = (event?: WsEvent) => void;

const sockets: MockWebSocket[] = [];

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  readonly sent: string[] = [];
  readonly url: string;
  private readonly listeners = new Map<WsEventType, Set<WsListener>>();

  constructor(url: string) {
    this.url = url;
    sockets.push(this);
  }

  addEventListener(type: WsEventType, listener: WsListener) {
    const listeners = this.listeners.get(type) ?? new Set<WsListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: WsEventType, listener: WsListener) {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close(code = 1000, reason = "") {
    this.readyState = MockWebSocket.CLOSED;
    this.emit("close", { code, reason, type: "close" });
  }

  fail() {
    this.emit("error", { type: "error" });
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.emit("open", { type: "open" });
  }

  serverMessage(data: unknown) {
    this.emit("message", { data, type: "message" });
  }

  private emit(type: WsEventType, event?: WsEvent) {
    const listeners = this.listeners.get(type);
    if (!listeners) return;
    for (const listener of listeners) {
      listener(event);
    }
  }
}

const originalWebSocket = globalThis.WebSocket;

const fetchMock = vi.fn<typeof globalThis.fetch>();
// Effect caches the global fetch on first use, so the stub stays in place across tests.
globalThis.fetch = (...args) => fetchMock(...args);

function getSocket(): MockWebSocket {
  const socket = sockets.at(-1);
  if (!socket) {
    throw new Error("Expected a websocket instance");
  }
  return socket;
}

async function waitFor(assertion: () => void, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() - startedAt >= timeoutMs) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

beforeEach(() => {
  sockets.length = 0;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => new Response(null, { status: 204 }));

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: {
        origin: "http://localhost:3020",
        hostname: "localhost",
        port: "3020",
        protocol: "http:",
      },
      desktopBridge: undefined,
    },
  });

  globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
});

afterEach(async () => {
  vi.useRealTimers();
  await __resetClientTracingForTests();
  globalThis.WebSocket = originalWebSocket;
  vi.restoreAllMocks();
});

function useFakeClock() {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
}

// Subscriptions start only after the first open, so these tests get past the gate first.
async function openFirstSocket() {
  await vi.advanceTimersByTimeAsync(0);
  getSocket().open();
  await vi.advanceTimersByTimeAsync(0);
}

const socketClosed = () => Stream.fail(new Error("SocketCloseError: 1006"));

describe("WsTransport", () => {
  it("normalizes root websocket urls to /ws and preserves query params", async () => {
    const transport = new WsTransport("ws://localhost:3020/?token=secret-token");

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    expect(getSocket().url).toBe("ws://localhost:3020/ws?token=secret-token");
    await transport.dispose();
  });

  it("uses wss when falling back to an https page origin", async () => {
    Object.assign(window.location, {
      origin: "https://app.example.com",
      hostname: "app.example.com",
      port: "",
      protocol: "https:",
    });

    const transport = new WsTransport();

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    expect(getSocket().url).toBe("wss://app.example.com/ws");
    await transport.dispose();
  });

  it("sends unary RPC requests and resolves successful exits", async () => {
    const transport = new WsTransport("ws://localhost:3020");

    const requestPromise = transport.request((client) =>
      client[WS_METHODS.serverUpsertKeybinding]({
        command: "terminal.toggle",
        key: "ctrl+k",
      }),
    );

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    const socket = getSocket();
    socket.open();

    await waitFor(() => {
      expect(socket.sent).toHaveLength(1);
    });

    const requestMessage = JSON.parse(socket.sent[0] ?? "{}") as {
      _tag: string;
      id: string;
      payload: unknown;
      tag: string;
    };
    expect(requestMessage).toMatchObject({
      _tag: "Request",
      tag: WS_METHODS.serverUpsertKeybinding,
      payload: {
        command: "terminal.toggle",
        key: "ctrl+k",
      },
    });

    socket.serverMessage(
      JSON.stringify({
        _tag: "Exit",
        requestId: requestMessage.id,
        exit: {
          _tag: "Success",
          value: {
            keybindings: [],
            issues: [],
          },
        },
      }),
    );

    await expect(requestPromise).resolves.toEqual({
      keybindings: [],
      issues: [],
    });

    await transport.dispose();
  });

  it("exports the RPC client spans of its requests to the server's trace route", async () => {
    configureClientTracing({ exportIntervalMs: 10 });
    const transport = new WsTransport("ws://localhost:3020");

    const requestPromise = transport.request((client) =>
      client[WS_METHODS.serverUpsertKeybinding]({ command: "terminal.toggle", key: "ctrl+k" }),
    );
    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });
    const socket = getSocket();
    socket.open();
    await waitFor(() => {
      expect(socket.sent).toHaveLength(1);
    });
    const { id } = JSON.parse(socket.sent[0] ?? "{}") as { id: string };
    socket.serverMessage(
      JSON.stringify({
        _tag: "Exit",
        requestId: id,
        exit: { _tag: "Success", value: { keybindings: [], issues: [] } },
      }),
    );
    await requestPromise;

    await waitFor(() => {
      const exported = fetchMock.mock.calls.filter(([, init]) =>
        new TextDecoder()
          .decode(init?.body as Uint8Array)
          .includes(WS_METHODS.serverUpsertKeybinding),
      );
      expect(exported.map(([input]) => String(input))).toContain(
        "http://localhost:3020/api/observability/v1/traces",
      );
    });
    await transport.dispose();
  });

  it("delivers stream chunks to subscribers", async () => {
    const transport = new WsTransport("ws://localhost:3020");
    const listener = vi.fn();

    const unsubscribe = transport.subscribe(
      (client) => client[WS_METHODS.subscribeServerLifecycle]({}),
      listener,
    );
    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    const socket = getSocket();
    socket.open();

    await waitFor(() => {
      expect(socket.sent).toHaveLength(1);
    });

    const requestMessage = JSON.parse(socket.sent[0] ?? "{}") as { id: string; tag: string };
    expect(requestMessage.tag).toBe(WS_METHODS.subscribeServerLifecycle);

    const welcomeEvent = {
      version: 1,
      sequence: 1,
      type: "welcome",
      payload: {
        cwd: "/tmp/workspace",
        projectName: "workspace",
      },
    };

    socket.serverMessage(
      JSON.stringify({
        _tag: "Chunk",
        requestId: requestMessage.id,
        values: [welcomeEvent],
      }),
    );

    await waitFor(() => {
      expect(listener).toHaveBeenCalledWith(welcomeEvent);
    });

    unsubscribe();
    await transport.dispose();
  });

  it("re-subscribes stream listeners after the stream exits", async () => {
    const transport = new WsTransport("ws://localhost:3020");
    const listener = vi.fn();

    const unsubscribe = transport.subscribe(
      (client) => client[WS_METHODS.subscribeServerLifecycle]({}),
      listener,
    );
    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    const socket = getSocket();
    socket.open();

    await waitFor(() => {
      expect(socket.sent).toHaveLength(1);
    });

    const firstRequest = JSON.parse(socket.sent[0] ?? "{}") as { id: string };
    socket.serverMessage(
      JSON.stringify({
        _tag: "Chunk",
        requestId: firstRequest.id,
        values: [
          {
            version: 1,
            sequence: 1,
            type: "welcome",
            payload: {
              cwd: "/tmp/one",
              projectName: "one",
            },
          },
        ],
      }),
    );
    socket.serverMessage(
      JSON.stringify({
        _tag: "Exit",
        requestId: firstRequest.id,
        exit: {
          _tag: "Success",
          value: null,
        },
      }),
    );

    await waitFor(() => {
      const nextRequest = socket.sent
        .map((message) => JSON.parse(message) as { _tag?: string; id?: string })
        .find((message) => message._tag === "Request" && message.id !== firstRequest.id);
      expect(nextRequest).toBeDefined();
    });

    const secondRequest = socket.sent
      .map((message) => JSON.parse(message) as { _tag?: string; id?: string; tag?: string })
      .find(
        (message): message is { _tag: "Request"; id: string; tag: string } =>
          message._tag === "Request" && message.id !== firstRequest.id,
      );
    if (!secondRequest) {
      throw new Error("Expected a resubscribe request");
    }
    expect(secondRequest.tag).toBe(WS_METHODS.subscribeServerLifecycle);
    expect(secondRequest.id).not.toBe(firstRequest.id);

    const secondEvent = {
      version: 1,
      sequence: 2,
      type: "welcome",
      payload: {
        cwd: "/tmp/two",
        projectName: "two",
      },
    };
    socket.serverMessage(
      JSON.stringify({
        _tag: "Chunk",
        requestId: secondRequest.id,
        values: [secondEvent],
      }),
    );

    await waitFor(() => {
      expect(listener).toHaveBeenLastCalledWith(secondEvent);
    });

    unsubscribe();
    await transport.dispose();
  });

  it("re-subscribes after a stream defect instead of stopping", async () => {
    const transport = new WsTransport("ws://localhost:3020");
    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });
    getSocket().open();
    const listener = vi.fn();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let attempts = 0;

    const unsubscribe = transport.subscribe(
      () => {
        attempts += 1;
        return attempts === 1
          ? Stream.die(new Error("handler invariant failed"))
          : Stream.concat(Stream.make(attempts), Stream.never);
      },
      listener,
      { retryDelay: 1 },
    );

    await waitFor(() => {
      expect(listener).toHaveBeenCalledWith(2);
    });
    expect(attempts).toBe(2);
    expect(consoleError).toHaveBeenCalledTimes(1);

    unsubscribe();
    await transport.dispose();
  });

  it("waits for the first open instead of failing while the backend is not up", async () => {
    useFakeClock();
    const transport = new WsTransport("ws://localhost:3020");
    const rejected = vi.fn();
    let subscribeAttempts = 0;
    const unsubscribe = transport.subscribe((client) => {
      subscribeAttempts += 1;
      return client[WS_METHODS.subscribeServerLifecycle]({});
    }, vi.fn());
    transport
      .request((client) =>
        client[WS_METHODS.serverUpsertKeybinding]({ command: "terminal.toggle", key: "ctrl+k" }),
      )
      .catch(rejected);

    // Connects keep failing: nothing rejects and nothing is sent.
    await vi.advanceTimersByTimeAsync(0);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      getSocket().fail();
      await vi.advanceTimersByTimeAsync(2_000);
    }
    expect(sockets.length).toBeGreaterThan(1);
    expect(rejected).not.toHaveBeenCalled();
    expect(subscribeAttempts).toBe(0);

    const socket = getSocket();
    socket.open();
    await vi.advanceTimersByTimeAsync(10);
    const sentTags = socket.sent.map((message) => (JSON.parse(message) as { tag?: string }).tag);
    expect(sentTags).toContain(WS_METHODS.serverUpsertKeybinding);
    expect(sentTags).toContain(WS_METHODS.subscribeServerLifecycle);
    expect(rejected).not.toHaveBeenCalled();

    unsubscribe();
    await transport.dispose();
  });

  it("rejects a request still waiting for the first open when disposed", async () => {
    const transport = new WsTransport("ws://localhost:3020");
    const request = transport.request((client) =>
      client[WS_METHODS.serverUpsertKeybinding]({ command: "terminal.toggle", key: "ctrl+k" }),
    );
    const stream = transport.requestStream(
      (client) => client[WS_METHODS.subscribeServerLifecycle]({}),
      vi.fn(),
    );

    await transport.dispose();

    await expect(request).rejects.toThrow("Transport disposed");
    await expect(stream).rejects.toThrow("Transport disposed");
  });

  it("recovers a live subscription and rejects an in-flight request when Pongs stop", async () => {
    useFakeClock();
    const transport = new WsTransport("ws://localhost:3020");
    await openFirstSocket();
    const first = getSocket();

    const unsubscribe = transport.subscribe(
      (client) => client[WS_METHODS.subscribeServerLifecycle]({}),
      vi.fn(),
    );
    const request = transport.request((client) =>
      client[WS_METHODS.serverUpsertKeybinding]({ command: "terminal.toggle", key: "ctrl+k" }),
    );
    const rejected = vi.fn();
    request.catch(rejected);
    await vi.advanceTimersByTimeAsync(10);

    // First tick pings, second finds no Pong: the socket is dropped and a new one connects.
    await vi.advanceTimersByTimeAsync(11_000);
    expect(rejected).toHaveBeenCalledTimes(1);
    expect(sockets).toHaveLength(2);
    expect(getSocket()).not.toBe(first);

    const second = getSocket();
    second.open();
    await vi.advanceTimersByTimeAsync(6_000);
    const resent = second.sent
      .map((message) => JSON.parse(message) as { _tag?: string; tag?: string })
      .filter((message) => message._tag === "Request");
    expect(resent.map((message) => message.tag)).toContain(WS_METHODS.subscribeServerLifecycle);

    unsubscribe();
    await transport.dispose();
  });

  it("doubles the subscription retry delay up to the cap", () => {
    expect([0, 1, 2, 3].map((failures) => subscriptionRetryDelayMs(250, failures))).toEqual([
      250, 500, 1_000, 2_000,
    ]);
    expect(subscriptionRetryDelayMs(250, 10)).toBe(MAX_SUBSCRIPTION_RETRY_DELAY_MS);
  });

  it("backs off between retries while a subscription keeps failing", async () => {
    useFakeClock();
    const transport = new WsTransport("ws://localhost:3020");
    await openFirstSocket();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let attempts = 0;

    const unsubscribe = transport.subscribe(
      () => {
        attempts += 1;
        return socketClosed();
      },
      vi.fn(),
      { retryDelay: 20 },
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(19);
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts).toBe(2);
    await vi.advanceTimersByTimeAsync(39);
    expect(attempts).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts).toBe(3);
    await vi.advanceTimersByTimeAsync(80);
    expect(attempts).toBe(4);
    expect(warnSpy).toHaveBeenCalledTimes(1);

    unsubscribe();
    await transport.dispose();
  });

  it("keeps backing off when every attempt replays a snapshot and then fails", async () => {
    useFakeClock();
    const transport = new WsTransport("ws://localhost:3020");
    await openFirstSocket();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const listener = vi.fn();
    let attempts = 0;

    const unsubscribe = transport.subscribe(
      () => {
        attempts += 1;
        return Stream.concat(Stream.make("snapshot"), socketClosed());
      },
      listener,
      { retryDelay: 20 },
    );

    await vi.advanceTimersByTimeAsync(20);
    expect(attempts).toBe(2);
    await vi.advanceTimersByTimeAsync(20);
    expect(attempts).toBe(2);
    await vi.advanceTimersByTimeAsync(20);
    expect(attempts).toBe(3);
    expect(listener).toHaveBeenCalledTimes(3);
    expect(warnSpy).toHaveBeenCalledTimes(1);

    unsubscribe();
    await transport.dispose();
  });

  it("resets the retry delay after a subscription stays up", async () => {
    useFakeClock();
    const transport = new WsTransport("ws://localhost:3020");
    await openFirstSocket();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let attempts = 0;

    const unsubscribe = transport.subscribe(
      () => {
        attempts += 1;
        if (attempts !== 3) {
          return socketClosed();
        }
        return Stream.concat(
          Stream.make(attempts),
          Stream.fromEffect(Effect.sleep(SUBSCRIPTION_HEALTHY_RUN_MS)).pipe(
            Stream.flatMap(() => socketClosed()),
          ),
        );
      },
      vi.fn(),
      { retryDelay: 20 },
    );

    // Attempts 1 and 2 fail fast; attempt 3 starts after 20 + 40 ms and stays up.
    await vi.advanceTimersByTimeAsync(60);
    expect(attempts).toBe(3);
    await vi.advanceTimersByTimeAsync(SUBSCRIPTION_HEALTHY_RUN_MS);
    expect(attempts).toBe(3);
    // The healthy run resets the backoff, so attempt 4 waits only the base delay.
    await vi.advanceTimersByTimeAsync(20);
    expect(attempts).toBe(4);
    expect(warnSpy).toHaveBeenCalledTimes(2);

    unsubscribe();
    await transport.dispose();
  });

  it("reports a repeating defect once even while other subscriptions deliver values", async () => {
    useFakeClock();
    const transport = new WsTransport("ws://localhost:3020");
    await openFirstSocket();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let dyingAttempts = 0;

    const unsubscribeDying = transport.subscribe(
      () => {
        dyingAttempts += 1;
        return Stream.die(new Error("handler invariant failed"));
      },
      vi.fn(),
      { retryDelay: 20 },
    );
    const unsubscribeHealthy = transport.subscribe(
      () => Stream.make(1).pipe(Stream.concat(Stream.fromEffect(Effect.sleep(10))), Stream.forever),
      vi.fn(),
    );

    await vi.advanceTimersByTimeAsync(2_000);
    expect(dyingAttempts).toBeGreaterThan(4);
    expect(errorSpy).toHaveBeenCalledTimes(1);

    unsubscribeDying();
    unsubscribeHealthy();
    await transport.dispose();
  });

  it("streams finite request events without re-subscribing", async () => {
    const transport = new WsTransport("ws://localhost:3020");
    const listener = vi.fn();

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });
    const socket = getSocket();
    socket.open();

    const requestPromise = transport.requestStream(
      (client) =>
        client[WS_METHODS.gitRunStackedAction]({
          actionId: "action-1",
          cwd: "/repo",
          action: "commit",
        }),
      listener,
    );

    await waitFor(() => {
      expect(socket.sent).toHaveLength(1);
    });

    const requestMessage = JSON.parse(socket.sent[0] ?? "{}") as { id: string };
    const progressEvent = {
      actionId: "action-1",
      cwd: "/repo",
      action: "commit",
      kind: "phase_started",
      phase: "commit",
      label: "Committing...",
    } as const;

    socket.serverMessage(
      JSON.stringify({
        _tag: "Chunk",
        requestId: requestMessage.id,
        values: [progressEvent],
      }),
    );
    socket.serverMessage(
      JSON.stringify({
        _tag: "Exit",
        requestId: requestMessage.id,
        exit: {
          _tag: "Success",
          value: null,
        },
      }),
    );

    await expect(requestPromise).resolves.toBeUndefined();
    expect(listener).toHaveBeenCalledWith(progressEvent);
    expect(
      socket.sent.filter((message) => {
        const parsed = JSON.parse(message) as { _tag?: string; tag?: string };
        return parsed._tag === "Request" && parsed.tag === WS_METHODS.gitRunStackedAction;
      }),
    ).toHaveLength(1);
    await transport.dispose();
  });

  it("interrupts the RPC and ends the stream when its signal aborts", async () => {
    const transport = new WsTransport("ws://localhost:3020");
    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });
    const socket = getSocket();
    socket.open();

    const controller = new AbortController();
    const requestPromise = transport.requestStream(
      (client) =>
        client[WS_METHODS.gitRunStackedAction]({
          actionId: "action-1",
          cwd: "/repo",
          action: "commit",
        }),
      vi.fn(),
      { signal: controller.signal },
    );
    await waitFor(() => {
      expect(socket.sent).toHaveLength(1);
    });
    const { id } = JSON.parse(socket.sent[0] ?? "{}") as { id: string };

    controller.abort();

    await expect(requestPromise).rejects.toBeDefined();
    await waitFor(() => {
      const sent = socket.sent.map((message) => JSON.parse(message) as Record<string, unknown>);
      expect(sent).toContainEqual(expect.objectContaining({ _tag: "Interrupt", requestId: id }));
    });
    await transport.dispose();
  });

  it("closes the client scope on the transport runtime before disposing the runtime", async () => {
    const callOrder: string[] = [];
    let resolveClose!: () => void;
    const closePromise = new Promise<void>((resolve) => {
      resolveClose = resolve;
    });

    const runtime = {
      runPromise: vi.fn(async () => {
        callOrder.push("close:start");
        await closePromise;
        callOrder.push("close:done");
        return undefined;
      }),
      dispose: vi.fn(async () => {
        callOrder.push("runtime:dispose");
      }),
    };
    const transport = {
      disposed: false,
      clientScope: {} as never,
      firstOpen: createWsFirstOpenGate(),
      runtime,
    } as unknown as WsTransport;

    WsTransport.prototype.dispose.call(transport);

    expect(runtime.runPromise).toHaveBeenCalledTimes(1);
    expect(runtime.dispose).not.toHaveBeenCalled();
    expect((transport as unknown as { disposed: boolean }).disposed).toBe(true);

    resolveClose();

    await waitFor(() => {
      expect(runtime.dispose).toHaveBeenCalledTimes(1);
    });

    expect(callOrder).toEqual(["close:start", "close:done", "runtime:dispose"]);
  });

  it("logs a transport disconnect once per outage across subscriptions and retries", async () => {
    useFakeClock();
    const transport = new WsTransport("ws://localhost:3020");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    let attempts = 0;
    const recoveringListener = vi.fn();
    const unsubscribeA = transport.subscribe(
      () => {
        attempts += 1;
        // The fifth attempt reconnects, stays up, and then drops again: a new outage.
        return attempts === 5
          ? Stream.concat(
              Stream.make("ok"),
              Stream.fromEffect(Effect.sleep(SUBSCRIPTION_HEALTHY_RUN_MS)).pipe(
                Stream.flatMap(() => socketClosed()),
              ),
            )
          : socketClosed();
      },
      recoveringListener,
      { retryDelay: 10 },
    );
    const unsubscribeB = transport.subscribe(socketClosed, vi.fn(), { retryDelay: 10 });

    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(1);
    getSocket().open();

    await vi.advanceTimersByTimeAsync(SUBSCRIPTION_HEALTHY_RUN_MS + 2_000);
    expect(recoveringListener).toHaveBeenCalledWith("ok");
    expect(attempts).toBeGreaterThan(6);

    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledWith("WebSocket RPC subscription disconnected", {
      error: "SocketCloseError: 1006",
    });

    unsubscribeA();
    unsubscribeB();
    await transport.dispose();
  });
});
