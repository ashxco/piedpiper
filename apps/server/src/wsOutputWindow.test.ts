import { WS_METHODS } from "@piedpiper/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Queue, Ref, Schema, Stream } from "effect";
import { TestClock } from "effect/testing";
import { Rpc, RpcGroup, RpcSerialization, RpcServer } from "effect/unstable/rpc";
import type { RpcMessage } from "effect/unstable/rpc";

import { type OutputWindow, withOutputWindow } from "./wsOutputWindow.ts";

type Receive = Parameters<RpcServer.Protocol["Service"]["run"]>[0];

const makeHarness = Effect.fnUntraced(function* (
  tag: string,
  clientIds: Ref.Ref<Set<number>>,
  windows: Map<number, Map<string, OutputWindow>> = new Map(),
) {
  const group = RpcGroup.make(Rpc.make(tag, { success: Schema.String, stream: true }));
  const output = yield* Queue.unbounded<string>();
  const responses = yield* Queue.unbounded<RpcMessage.FromServerEncoded>();
  const receive = yield* Deferred.make<Receive>();
  const protocol = yield* RpcServer.Protocol.make((write) =>
    Effect.gen(function* () {
      yield* Deferred.succeed(receive, write);
      return {
        disconnects: yield* Queue.unbounded<number>(),
        send: (_clientId: number, response: RpcMessage.FromServerEncoded) =>
          Queue.offer(responses, response),
        end: () => Effect.void,
        clientIds: Ref.get(clientIds),
        initialMessage: Effect.succeedNone,
        supportsAck: true,
        supportsTransferables: false,
        supportsSpanPropagation: false,
      };
    }),
  );
  yield* RpcServer.make(group).pipe(
    Effect.provide(group.toLayerHandler(tag, () => Stream.fromQueue(output))),
    Effect.provideService(RpcServer.Protocol, withOutputWindow(protocol, windows)),
    Effect.forkScoped,
  );
  const write = yield* Deferred.await(receive);
  return { output, responses, write };
});

describe("withOutputWindow", () => {
  it.effect.each([
    { tag: WS_METHODS.subscribeTerminalEvents, size: 1, limit: 8 },
    { tag: WS_METHODS.subscribeTerminalEvents, size: 64 * 1024, limit: 1 },
    { tag: WS_METHODS.subscribeServerConfig, size: 1, limit: 8 },
    { tag: WS_METHODS.subscribeOrchestrationDomainEvents, size: 64 * 1024, limit: 8 },
    { tag: WS_METHODS.terminalWrite, size: 1, limit: 1 },
  ])("limits $tag with $size-byte values to $limit pending chunks", ({ tag, size, limit }) =>
    Effect.gen(function* () {
      const { output, responses, write } = yield* makeHarness(tag, yield* Ref.make(new Set([0])));
      yield* write(0, { _tag: "Request", id: "1", tag, payload: null, headers: [] });

      for (let index = 0; index < limit; index++) {
        const value = String(index).repeat(size);
        yield* Queue.offer(output, value);
        yield* TestClock.adjust(0);
        assert.equal(yield* Queue.size(responses), 1);
        assert.deepEqual(yield* Queue.take(responses), {
          _tag: "Chunk",
          requestId: "1",
          values: [value],
        });
      }
      // The window is full: the next chunk waits for a real client ack.
      yield* Queue.offer(output, "i".repeat(size));
      yield* TestClock.adjust(0);
      assert.equal(yield* Queue.size(responses), 0);
      yield* write(0, { _tag: "Ack", requestId: "1" });
      const resumed = yield* Queue.take(responses);
      assert.equal(resumed._tag, "Chunk");
      if (resumed._tag === "Chunk") assert.deepEqual(resumed.values, ["i".repeat(size)]);

      yield* write(0, { _tag: "Interrupt", requestId: "1" });
      assert.equal((yield* Queue.take(responses))._tag, "Exit");
    }).pipe(Effect.provide(RpcSerialization.layerJson), Effect.scoped),
  );

  it.effect("prunes windows of disconnected clients when a new window opens", () =>
    Effect.gen(function* () {
      const tag = WS_METHODS.subscribeTerminalEvents;
      const clientIds = yield* Ref.make(new Set([0]));
      const windows = new Map<number, Map<string, OutputWindow>>();
      const { write } = yield* makeHarness(tag, clientIds, windows);
      yield* write(0, { _tag: "Request", id: "1", tag, payload: null, headers: [] });
      yield* TestClock.adjust(0);
      assert.deepEqual([...windows.keys()], [0]);

      // Client 0 leaves without its stream's Exit reaching send.
      yield* Ref.set(clientIds, new Set([1]));
      yield* write(1, { _tag: "Request", id: "1", tag, payload: null, headers: [] });
      yield* TestClock.adjust(0);
      assert.deepEqual([...windows.keys()], [1]);
    }).pipe(Effect.provide(RpcSerialization.layerJson), Effect.scoped),
  );
});
