import { Effect, Layer } from "effect";
import * as Socket from "effect/unstable/socket/Socket";

/**
 * Holds requests until the transport's socket has opened once. With `retryTransientErrors: false`
 * a failed connect fails requests at once, and the desktop renderer boots before its backend listens.
 * After the first open, requests fail fast during an outage, as they do when a socket closes.
 */
export interface WsFirstOpenGate {
  readonly wait: () => Promise<void>;
  readonly markOpen: () => void;
  /** Rejects everyone still waiting, and any later waiter, so dispose cannot leave a request hanging. */
  readonly dispose: () => void;
}

export function createWsFirstOpenGate(): WsFirstOpenGate {
  let settled = false;
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  // Nothing may be waiting when dispose rejects; that must not surface as an unhandled rejection.
  promise.catch(() => undefined);
  return {
    wait: () => promise,
    markOpen: () => {
      settled = true;
      resolve();
    },
    dispose: () => {
      if (settled) return;
      settled = true;
      reject(new Error("Transport disposed"));
    },
  };
}

/**
 * Reports through `onOpen` rather than the socket's open event: the RPC protocol clears its stored
 * connect error in its own `onOpen`, so a request released any earlier would fail with that error.
 */
function reportFirstOpen(socket: Socket.Socket, gate: WsFirstOpenGate): Socket.Socket {
  const report = Effect.sync(gate.markOpen);
  const withReport = (onOpen: Effect.Effect<void> | undefined) => ({
    onOpen: onOpen ? Effect.andThen(onOpen, report) : report,
  });
  return Socket.Socket.of({
    ...socket,
    run: (handler, options) => socket.run(handler, withReport(options?.onOpen)),
    runRaw: (handler, options) => socket.runRaw(handler, withReport(options?.onOpen)),
  });
}

export function layerFirstOpenWebSocket(
  url: string,
  gate: WsFirstOpenGate,
): Layer.Layer<Socket.Socket, never, Socket.WebSocketConstructor> {
  return Layer.effect(Socket.Socket)(
    Effect.map(Socket.makeWebSocket(url), (socket) => reportFirstOpen(socket, gate)),
  );
}
