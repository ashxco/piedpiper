import { WS_METHODS, WsRpcGroup } from "@piedpiper/contracts";
import { Exit, Layer, ManagedRuntime, Scope, Stream } from "effect";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createWsFirstOpenGate, layerFirstOpenWebSocket } from "./wsFirstOpenGate";

type Listener = (event?: unknown) => void;

const sockets: MockWebSocket[] = [];

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(readonly url: string) {
    sockets.push(this);
  }

  addEventListener(type: string, listener: Listener) {
    const set = this.listeners.get(type) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: Listener) {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close(code = 1000, reason = "") {
    this.readyState = MockWebSocket.CLOSED;
    this.emit("close", { code, reason, type: "close" });
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.emit("open", { type: "open" });
  }

  fail() {
    this.emit("error", { type: "error" });
  }

  sentRequests() {
    return this.sent
      .map((message) => JSON.parse(message) as { _tag: string; id?: string; tag?: string })
      .filter((message) => message._tag === "Request");
  }

  private emit(type: string, event: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const originalWebSocket = globalThis.WebSocket;

beforeEach(() => {
  sockets.length = 0;
  globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
});

afterEach(() => {
  vi.useRealTimers();
  globalThis.WebSocket = originalWebSocket;
});

function makeClient() {
  const gate = createWsFirstOpenGate();
  const socketLayer = layerFirstOpenWebSocket("ws://localhost/ws", gate).pipe(
    Layer.provide(Socket.layerWebSocketConstructorGlobal),
  );
  const runtime = ManagedRuntime.make(
    RpcClient.layerProtocolSocket({ retryTransientErrors: false }).pipe(
      Layer.provide(Layer.mergeAll(socketLayer, RpcSerialization.layerJson)),
    ),
  );
  const scope = runtime.runSync(Scope.make());
  const clientPromise = runtime.runPromise(Scope.provide(scope)(RpcClient.make(WsRpcGroup)));
  return {
    gate,
    runtime,
    clientPromise,
    dispose: async () => {
      gate.dispose();
      await runtime.runPromise(Scope.close(scope, Exit.void));
      await runtime.dispose();
    },
  };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

describe("createWsFirstOpenGate", () => {
  it("keeps waiters pending until the first open", async () => {
    const gate = createWsFirstOpenGate();
    const settled = vi.fn();
    void gate.wait().then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();

    gate.markOpen();
    await expect(gate.wait()).resolves.toBeUndefined();
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it("rejects waiters on dispose so nothing hangs", async () => {
    const gate = createWsFirstOpenGate();
    const waiter = gate.wait();
    gate.dispose();
    await expect(waiter).rejects.toThrow("Transport disposed");
    await expect(gate.wait()).rejects.toThrow("Transport disposed");
  });

  it("stays open after dispose once the socket has opened", async () => {
    const gate = createWsFirstOpenGate();
    gate.markOpen();
    gate.dispose();
    await expect(gate.wait()).resolves.toBeUndefined();
  });

  it("does not report an unhandled rejection when nobody is waiting", async () => {
    const onUnhandled = vi.fn();
    process.on("unhandledRejection", onUnhandled);
    createWsFirstOpenGate().dispose();
    await vi.advanceTimersByTimeAsync(1);
    process.off("unhandledRejection", onUnhandled);
    expect(onUnhandled).not.toHaveBeenCalled();
  });
});

describe("first-open gate with retryTransientErrors false", () => {
  it("releases a boot request only once a connect succeeds, after earlier connects failed", async () => {
    const { gate, runtime, clientPromise, dispose } = makeClient();
    const client = await clientPromise;
    await flush();

    // The backend is not listening yet: every connect fails, and nothing may reject.
    const rejected = vi.fn();
    const request = gate
      .wait()
      .then(() =>
        runtime.runPromise(
          client[WS_METHODS.serverUpsertKeybinding]({ command: "terminal.toggle", key: "ctrl+k" }),
        ),
      );
    request.catch(rejected);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      sockets.at(-1)?.fail();
      await vi.advanceTimersByTimeAsync(2_000);
    }
    expect(sockets.length).toBeGreaterThan(1);
    expect(rejected).not.toHaveBeenCalled();
    expect(sockets.flatMap((socket) => socket.sentRequests())).toEqual([]);

    const socket = sockets.at(-1) as MockWebSocket;
    socket.open();
    await vi.advanceTimersByTimeAsync(10);

    expect(rejected).not.toHaveBeenCalled();
    const [sent] = socket.sentRequests();
    expect(sent?.tag).toBe(WS_METHODS.serverUpsertKeybinding);

    await dispose();
    await request.catch(() => undefined);
  });

  it("reconnects without a Pong, rejects in-flight requests and lets a subscription resend", async () => {
    const { runtime, clientPromise, dispose } = makeClient();
    const client = await clientPromise;
    await flush();
    const first = sockets[0] as MockWebSocket;
    first.open();
    await flush();

    const unary = runtime.runPromise(
      client[WS_METHODS.serverUpsertKeybinding]({ command: "terminal.toggle", key: "ctrl+k" }),
    );
    const unaryRejected = vi.fn();
    unary.catch(unaryRejected);
    const stream = runtime.runPromise(
      Stream.runDrain(client[WS_METHODS.subscribeServerLifecycle]({})),
    );
    const streamRejected = vi.fn();
    stream.catch(streamRejected);
    await vi.advanceTimersByTimeAsync(10);
    expect(first.sentRequests()).toHaveLength(2);

    // No Pong: the first tick pings, the second finds no reply and drops the socket.
    await vi.advanceTimersByTimeAsync(10_100);
    expect(unaryRejected).toHaveBeenCalledTimes(1);
    expect(streamRejected).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(sockets).toHaveLength(2);
    const second = sockets[1] as MockWebSocket;
    second.open();
    await flush();

    const resubscribed = runtime.runPromise(
      Stream.runDrain(client[WS_METHODS.subscribeServerLifecycle]({})),
    );
    resubscribed.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(10);
    expect(second.sentRequests().map((message) => message.tag)).toEqual([
      WS_METHODS.subscribeServerLifecycle,
    ]);

    await dispose();
  });

  it("never reports open while the socket is only connecting", async () => {
    const { gate, clientPromise, dispose } = makeClient();
    await clientPromise;
    const opened = vi.fn();
    void gate.wait().then(opened, () => undefined);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(opened).not.toHaveBeenCalled();

    (sockets.at(-1) as MockWebSocket).open();
    await flush();
    expect(opened).toHaveBeenCalledTimes(1);
    await dispose();
  });
});
