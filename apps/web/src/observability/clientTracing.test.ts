import { WS_METHODS } from "@piedpiper/contracts";
import { Effect, Layer, ManagedRuntime, Scope } from "effect";
import type { RpcClient } from "effect/unstable/rpc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetAuthTokenForTests } from "../rpc/authToken";
import { createWsRpcProtocolLayer, makeWsRpcProtocolClient } from "../rpc/protocol";
import {
  __resetClientTracingForTests,
  ClientTracingLive,
  configureClientTracing,
} from "./clientTracing";

const fetchMock = vi.fn<typeof globalThis.fetch>();
// Effect caches the global fetch on first use, so the stub stays in place across tests.
globalThis.fetch = (...args) => fetchMock(...args);

const originalWindow = globalThis.window;
const originalWebSocket = globalThis.WebSocket;
const TRACES_URL = "http://localhost:3020/api/observability/v1/traces";

function stubWindow(desktopWsUrl?: string) {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: {
        origin: "http://localhost:3020",
        href: "http://localhost:3020/",
        protocol: "http:",
      },
      desktopBridge: desktopWsUrl ? { getWsUrl: () => desktopWsUrl } : undefined,
    },
  });
}

interface ExportedSpan {
  readonly name: string;
  readonly traceId: string;
  readonly spanId: string;
}

interface ExportedRequest {
  readonly url: string;
  readonly authorization: string | null;
  readonly resourceAttributes: ReadonlyArray<{
    readonly key: string;
    readonly value: { readonly stringValue?: string };
  }>;
  readonly spans: ReadonlyArray<ExportedSpan>;
  readonly spanNames: ReadonlyArray<string>;
}

function exportedRequests(): ReadonlyArray<ExportedRequest> {
  return fetchMock.mock.calls.map(([input, init]) => {
    const body = init?.body as Uint8Array;
    const data = JSON.parse(new TextDecoder().decode(body)) as {
      resourceSpans: ReadonlyArray<{
        resource: { attributes: ExportedRequest["resourceAttributes"] };
        scopeSpans: ReadonlyArray<{ spans: ReadonlyArray<ExportedSpan> }>;
      }>;
    };
    const spans = data.resourceSpans.flatMap((resource) =>
      resource.scopeSpans.flatMap((scope) => scope.spans),
    );
    return {
      url: String(input),
      authorization: new Headers(init?.headers).get("authorization"),
      resourceAttributes: data.resourceSpans.flatMap((resource) => resource.resource.attributes),
      spans,
      spanNames: spans.map((span) => span.name),
    };
  });
}

beforeEach(async () => {
  await __resetClientTracingForTests();
  __resetAuthTokenForTests();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => new Response(null, { status: 204 }));
  stubWindow();
});

afterEach(async () => {
  await __resetClientTracingForTests();
  __resetAuthTokenForTests();
  Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  globalThis.WebSocket = originalWebSocket;
});

describe("clientTracing", () => {
  it("exports spans with the token in the header, never in the URL", async () => {
    stubWindow("ws://localhost:3020/?token=secret-token");
    configureClientTracing({ exportIntervalMs: 10 });
    const runtime = ManagedRuntime.make(ClientTracingLive);

    await runtime.runPromise(Effect.void.pipe(Effect.withSpan("client.work")));

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [request] = exportedRequests();
    expect(request?.url).toBe(TRACES_URL);
    expect(request?.authorization).toBe("Bearer secret-token");
    expect(request?.spanNames).toEqual(["client.work"]);
    expect(request?.resourceAttributes).toEqual(
      expect.arrayContaining([
        { key: "service.runtime", value: { stringValue: "piedpiper-web" } },
        { key: "service.mode", value: { stringValue: "browser" } },
      ]),
    );
    await runtime.dispose();
  });

  it("reaches an exporter configured after the runtime was built", async () => {
    // No window yet: configuring fails quietly and the tracer falls back to discarded spans.
    Object.defineProperty(globalThis, "window", { configurable: true, value: undefined });
    const runtime = ManagedRuntime.make(ClientTracingLive);
    await runtime.runPromise(Effect.void.pipe(Effect.withSpan("too.early")));

    stubWindow();
    configureClientTracing({ exportIntervalMs: 10 });
    await runtime.runPromise(Effect.void.pipe(Effect.withSpan("late.work")));

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(exportedRequests().flatMap((request) => request.spanNames)).toEqual(["late.work"]);
    await runtime.dispose();
  });

  it("stays quiet and keeps the runtime working when exports fail", async () => {
    const consoleSpies = [
      vi.spyOn(console, "log"),
      vi.spyOn(console, "warn"),
      vi.spyOn(console, "error"),
    ];
    fetchMock.mockImplementation(async () => {
      throw new TypeError("Failed to fetch");
    });
    configureClientTracing({ exportIntervalMs: 10 });
    const runtime = ManagedRuntime.make(ClientTracingLive);

    await runtime.runPromise(Effect.void.pipe(Effect.withSpan("first")));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await expect(
      runtime.runPromise(Effect.succeed("ok").pipe(Effect.withSpan("second"))),
    ).resolves.toBe("ok");

    for (const spy of consoleSpies) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
    await runtime.dispose();
  });

  it("routes spans from several runtimes to the shared exporter", async () => {
    configureClientTracing({ exportIntervalMs: 10 });
    const first = ManagedRuntime.make(ClientTracingLive);
    const second = ManagedRuntime.make(ClientTracingLive);

    await first.runPromise(Effect.void.pipe(Effect.withSpan("from.first")));
    await second.runPromise(Effect.void.pipe(Effect.withSpan("from.second")));

    await vi.waitFor(() =>
      expect(exportedRequests().flatMap((request) => request.spanNames)).toEqual(
        expect.arrayContaining(["from.first", "from.second"]),
      ),
    );
    expect(exportedRequests().every((request) => request.url === TRACES_URL)).toBe(true);
    await first.dispose();
    await second.dispose();
  });

  it("exports RPC client spans under the ids sent on the socket", async () => {
    const sent: Array<string> = [];
    const listeners = new Map<string, Set<(event?: unknown) => void>>();
    const emit = (type: string, event?: unknown) => {
      for (const listener of listeners.get(type) ?? []) listener(event);
    };
    class FakeWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readyState = FakeWebSocket.CONNECTING;
      addEventListener(type: string, listener: (event?: unknown) => void) {
        listeners.set(type, (listeners.get(type) ?? new Set()).add(listener));
      }
      removeEventListener(type: string, listener: (event?: unknown) => void) {
        listeners.get(type)?.delete(listener);
      }
      send(data: string) {
        sent.push(data);
      }
      close() {
        this.readyState = FakeWebSocket.CLOSED;
      }
    }
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;

    configureClientTracing({ exportIntervalMs: 10 });
    const runtime: ManagedRuntime.ManagedRuntime<RpcClient.Protocol, never> = ManagedRuntime.make(
      Layer.mergeAll(createWsRpcProtocolLayer("ws://localhost:3020"), ClientTracingLive),
    );
    const scope = runtime.runSync(Scope.make());
    const client = await runtime.runPromise(Scope.provide(scope)(makeWsRpcProtocolClient));

    const request = runtime.runPromise(
      client[WS_METHODS.serverUpsertKeybinding]({ command: "terminal.toggle", key: "ctrl+k" }),
    );
    await vi.waitFor(() => expect(listeners.get("open")?.size ?? 0).toBeGreaterThan(0));
    emit("open", { type: "open" });
    await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0));
    const message = JSON.parse(sent[0] ?? "{}") as {
      id: string;
      traceId: string;
      spanId: string;
    };
    expect(message.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(message.spanId).toMatch(/^[0-9a-f]{16}$/);
    emit("message", {
      type: "message",
      data: JSON.stringify({
        _tag: "Exit",
        requestId: message.id,
        exit: { _tag: "Success", value: { keybindings: [], issues: [] } },
      }),
    });
    await request;

    // The server's records point at these ids, so the exported span must carry the same ones.
    await vi.waitFor(() =>
      expect(
        exportedRequests()
          .flatMap((exported) => exported.spans)
          .find((span) => span.name.includes(WS_METHODS.serverUpsertKeybinding)),
      ).toMatchObject({ traceId: message.traceId, spanId: message.spanId }),
    );
    await runtime.dispose();
  });
});
