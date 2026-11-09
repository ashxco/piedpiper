import { WS_METHODS } from "@piedpiper/contracts";
import * as Effect from "effect/Effect";
import type { RpcServer } from "effect/unstable/rpc";

const MAX_PENDING_OUTPUT_CHUNKS = 8;
const MAX_PENDING_OUTPUT_BYTES = 64 * 1024;

const isFull = (sizes: ReadonlyArray<number>) =>
  sizes.length >= MAX_PENDING_OUTPUT_CHUNKS ||
  sizes.reduce((total, size) => total + size, 0) >= MAX_PENDING_OUTPUT_BYTES;

// Terminal output is many small chunks, so its window also caps bytes. The other streams
// window by count only: sizing a large orchestration snapshot would serialize it twice.
const BYTE_WINDOWED_STREAMS: ReadonlySet<string> = new Set([WS_METHODS.subscribeTerminalEvents]);
const COUNT_WINDOWED_STREAMS: ReadonlySet<string> = new Set([
  WS_METHODS.subscribeServerConfig,
  WS_METHODS.subscribeOrchestrationDomainEvents,
]);

export interface OutputWindow {
  readonly bytes: boolean;
  readonly sizes: number[];
}

type Protocol = RpcServer.Protocol["Service"];
type Receive = Parameters<Protocol["run"]>[0];

/**
 * Wraps an RPC server protocol so selected streams may run several chunks ahead of client
 * acks. Chunks are acknowledged on the server side until the window fills, after which the
 * stream waits for real client acks again, so backpressure is kept on slow connections.
 */
export function withOutputWindow(
  protocol: Protocol,
  // RpcServer drops a disconnected client before its streams exit, so their Exit never
  // reaches send; departed clients are pruned whenever a window opens instead.
  clients: Map<number, Map<string, OutputWindow>> = new Map(),
): Protocol {
  let receive: Receive | undefined;
  const windowFor = (clientId: number, requestId: string) => clients.get(clientId)?.get(requestId);
  const openWindow = Effect.fnUntraced(function* (
    clientId: number,
    requestId: string,
    bytes: boolean,
  ) {
    const connected = yield* protocol.clientIds;
    for (const id of clients.keys()) if (!connected.has(id)) clients.delete(id);
    let windows = clients.get(clientId);
    if (!windows) clients.set(clientId, (windows = new Map()));
    if (!windows.has(requestId)) windows.set(requestId, { bytes, sizes: [] });
  });

  return {
    ...protocol,
    run: (write) => {
      receive = write;
      return protocol.run((clientId, message) =>
        Effect.suspend(() => {
          if (message._tag === "Request") {
            const bytes = BYTE_WINDOWED_STREAMS.has(message.tag);
            if (bytes || COUNT_WINDOWED_STREAMS.has(message.tag)) {
              return openWindow(clientId, String(message.id), bytes).pipe(
                Effect.andThen(write(clientId, message)),
              );
            }
          } else if (message._tag === "Ack") {
            const window = windowFor(clientId, String(message.requestId));
            if (window) {
              const wasFull = isFull(window.sizes);
              window.sizes.shift();
              // Only a client ack that reopens a full window is forwarded; the rest were pre-acked.
              if (!wasFull || isFull(window.sizes)) return Effect.void;
            }
          }
          return write(clientId, message);
        }),
      );
    },
    send: (clientId, response, transferables) =>
      Effect.suspend(() => {
        const send = protocol.send(clientId, response, transferables);
        if (response._tag === "Exit") {
          clients.get(clientId)?.delete(String(response.requestId));
        } else if (response._tag === "Chunk") {
          const window = windowFor(clientId, String(response.requestId));
          if (window && receive) {
            const write = receive;
            window.sizes.push(window.bytes ? Buffer.byteLength(JSON.stringify(response)) : 0);
            if (!isFull(window.sizes)) {
              return send.pipe(
                Effect.andThen(() =>
                  write(clientId, { _tag: "Ack", requestId: response.requestId }),
                ),
              );
            }
          }
        }
        return send;
      }),
  };
}
