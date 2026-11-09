import { WS_METHODS } from "@piedpiper/contracts";
import { Effect, Exit, Fiber, Layer, ManagedRuntime, Scope } from "effect";
import { type RpcClient, RpcClientError, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeWsRpcProtocolClient } from "./protocol";
import {
  clearAllTrackedRpcRequests,
  getSlowRpcRequests,
  SLOW_RPC_THRESHOLD_MS,
  trackRpcRequestSent,
} from "./requestLatencyState";
import { getWsConnectionStatus, resetWsConnectionStateForTests } from "./wsConnectionState";
import {
  layerTrackedProtocolSocket,
  layerTrackingWebSocketConstructor,
  trackRpcProtocol,
} from "./wsTrackedProtocol";

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
  /** Off simulates a stalled server, whose close handshake also never finishes. */
  responsive = true;
  private readonly listeners = new Map<WsEventType, Set<WsListener>>();

  constructor(readonly url: string) {
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
    if (this.responsive && data.includes('"Ping"')) {
      this.serverMessage([{ _tag: "Pong" }]);
    }
  }

  close(code = 1000, reason = "") {
    if (this.responsive) this.finishClose(code, reason);
  }

  finishClose(code = 1000, reason = "") {
    if (this.readyState === MockWebSocket.CLOSED) return;
    this.readyState = MockWebSocket.CLOSED;
    this.emit("close", { code, reason, type: "close" });
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.emit("open", { type: "open" });
  }

  serverMessage(message: unknown) {
    this.emit("message", { data: JSON.stringify(message), type: "message" });
  }

  private emit(type: WsEventType, event: WsEvent) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

const originalWebSocket = globalThis.WebSocket;

function latestSocket(): MockWebSocket {
  const socket = sockets.at(-1);
  if (!socket) throw new Error("Expected a websocket");
  return socket;
}

function sentRequests(socket: MockWebSocket): Array<{ _tag: string; id: string; tag: string }> {
  return socket.sent
    .flatMap((message) => JSON.parse(message) as unknown)
    .filter(
      (message): message is { _tag: string; id: string; tag: string } =>
        (message as { _tag?: string })._tag === "Request",
    );
}

function makeClient() {
  const socketLayer = Socket.layerWebSocket("ws://localhost:3020/ws").pipe(
    Layer.provide(layerTrackingWebSocketConstructor),
  );
  const runtime = ManagedRuntime.make(
    layerTrackedProtocolSocket({ retryTransientErrors: false }).pipe(
      Layer.provide(Layer.mergeAll(socketLayer, RpcSerialization.layerJson)),
    ),
  );
  const scope = runtime.runSync(Scope.make());
  const clientPromise = runtime.runPromise(Scope.provide(scope)(makeWsRpcProtocolClient));
  return {
    clientPromise,
    runtime,
    dispose: async () => {
      await runtime.runPromise(Scope.close(scope, Exit.void));
      await runtime.dispose();
    },
  };
}

async function flush() {
  await vi.advanceTimersByTimeAsync(0);
}

describe("tracked websocket protocol", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sockets.length = 0;
    resetWsConnectionStateForTests();
    clearAllTrackedRpcRequests();
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  });

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
    vi.useRealTimers();
  });

  it("reports a drop when a connected socket closes, and recovery on the next open", async () => {
    const { dispose, clientPromise } = makeClient();
    await clientPromise;
    await flush();
    expect(getWsConnectionStatus().phase).toBe("connecting");

    latestSocket().open();
    await flush();
    expect(getWsConnectionStatus()).toMatchObject({ phase: "connected", hasConnected: true });

    const first = latestSocket();
    first.close(1006, "gone");
    await flush();
    expect(getWsConnectionStatus()).toMatchObject({ phase: "disconnected" });
    expect(getWsConnectionStatus().disconnectedAtMs).not.toBeNull();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(latestSocket()).not.toBe(first);
    latestSocket().open();
    await flush();
    expect(getWsConnectionStatus()).toMatchObject({ phase: "connected", disconnectedAtMs: null });

    await dispose();
  });

  it("records no drop when the first connection fails", async () => {
    const { dispose, clientPromise } = makeClient();
    await clientPromise;
    await flush();

    latestSocket().close(1006);
    await flush();

    expect(getWsConnectionStatus()).toMatchObject({
      hasConnected: false,
      disconnectedAtMs: null,
    });
    await dispose();
  });

  it("times a request until it is answered", async () => {
    const { dispose, clientPromise, runtime } = makeClient();
    const client = await clientPromise;
    await flush();
    latestSocket().open();
    await flush();

    void runtime.runPromise(Effect.exit(client[WS_METHODS.serverGetConfig]({})));
    await flush();
    const request = sentRequests(latestSocket())[0];
    if (!request) throw new Error("Expected a request on the socket");
    expect(request.tag).toBe(WS_METHODS.serverGetConfig);

    await vi.advanceTimersByTimeAsync(SLOW_RPC_THRESHOLD_MS);
    expect(getSlowRpcRequests()).toMatchObject([{ requestId: request.id }]);

    latestSocket().serverMessage([
      {
        _tag: "Exit",
        requestId: request.id,
        exit: { _tag: "Failure", cause: [{ _tag: "Die", defect: "nope" }] },
      },
    ]);
    await flush();
    expect(getSlowRpcRequests()).toEqual([]);

    await dispose();
  });

  it("stops timing a request interrupted on a live socket", async () => {
    const { dispose, clientPromise, runtime } = makeClient();
    const client = await clientPromise;
    await flush();
    latestSocket().open();
    await flush();

    const fiber = runtime.runFork(client[WS_METHODS.serverGetConfig]({}));
    await flush();
    expect(sentRequests(latestSocket())).toHaveLength(1);

    await runtime.runPromise(Fiber.interrupt(fiber));
    await vi.advanceTimersByTimeAsync(SLOW_RPC_THRESHOLD_MS);

    expect(getWsConnectionStatus().phase).toBe("connected");
    expect(getSlowRpcRequests()).toEqual([]);
    await dispose();
  });

  it("leaves nothing slow for a request sent during an outage", async () => {
    const { dispose, clientPromise, runtime } = makeClient();
    const client = await clientPromise;
    await flush();
    latestSocket().open();
    await flush();
    latestSocket().close(1006);
    await flush();

    const exit = await runtime.runPromise(Effect.exit(client[WS_METHODS.serverGetConfig]({})));
    expect(Exit.isFailure(exit)).toBe(true);
    await vi.advanceTimersByTimeAsync(SLOW_RPC_THRESHOLD_MS);

    expect(getSlowRpcRequests()).toEqual([]);
    await dispose();
  });

  // Direct, because a reconnect attempt clears all tracking and would hide a missed cleanup.
  it("stops timing a request whose send is refused", async () => {
    const refused = new RpcClientError.RpcClientError({
      reason: new RpcClientError.RpcClientDefect({ message: "refused", cause: undefined }),
    });
    const protocol = trackRpcProtocol({
      run: () => Effect.never,
      send: () => Effect.fail(refused),
      supportsAck: true,
      supportsTransferables: false,
    } as unknown as RpcClient.Protocol["Service"]);

    await Effect.runPromise(
      Effect.exit(
        protocol.send({
          _tag: "Request",
          id: "refused",
          tag: WS_METHODS.serverGetConfig,
          payload: {},
          headers: [],
        } as never),
      ),
    );
    await vi.advanceTimersByTimeAsync(SLOW_RPC_THRESHOLD_MS);

    expect(getSlowRpcRequests()).toEqual([]);
  });

  it("forgets stuck requests when the socket closes", async () => {
    const { dispose, clientPromise } = makeClient();
    await clientPromise;
    await flush();
    latestSocket().open();
    await flush();
    trackRpcRequestSent("stuck", WS_METHODS.serverGetConfig);
    await vi.advanceTimersByTimeAsync(SLOW_RPC_THRESHOLD_MS);
    expect(getSlowRpcRequests()).toHaveLength(1);

    latestSocket().close(1006);
    await flush();

    expect(getSlowRpcRequests()).toEqual([]);
    await dispose();
  });

  it("ignores a late close from a replaced socket", async () => {
    const { dispose, clientPromise } = makeClient();
    await clientPromise;
    await flush();
    latestSocket().open();
    await flush();
    const stalled = latestSocket();
    stalled.responsive = false;

    await vi.advanceTimersByTimeAsync(11_000);
    expect(latestSocket()).not.toBe(stalled);
    expect(getWsConnectionStatus().disconnectedAtMs).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1_000);
    latestSocket().open();
    await flush();
    trackRpcRequestSent("fresh", WS_METHODS.serverGetConfig);

    stalled.finishClose(1006);
    await flush();

    expect(getWsConnectionStatus().phase).toBe("connected");
    await vi.advanceTimersByTimeAsync(SLOW_RPC_THRESHOLD_MS);
    expect(getSlowRpcRequests()).toMatchObject([{ requestId: "fresh" }]);
    await dispose();
  });
});
