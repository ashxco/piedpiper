import { Effect, Layer } from "effect";
import { RpcClient, type RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";

import {
  acknowledgeRpcRequest,
  clearAllTrackedRpcRequests,
  trackRpcRequestSent,
} from "./requestLatencyState";
import {
  recordWsConnectionAttempt,
  recordWsConnectionLost,
  recordWsConnectionOpened,
} from "./wsConnectionState";

/** Reports each socket's lifecycle to the connection state. */
export const layerTrackingWebSocketConstructor: Layer.Layer<Socket.WebSocketConstructor> =
  Layer.succeed(Socket.WebSocketConstructor)((url, protocols) => {
    const attempt = recordWsConnectionAttempt();
    clearAllTrackedRpcRequests();
    const socket = new globalThis.WebSocket(url, protocols);
    const onLost = () => {
      if (recordWsConnectionLost(attempt)) clearAllTrackedRpcRequests();
    };
    socket.addEventListener("open", () => recordWsConnectionOpened(attempt), { once: true });
    socket.addEventListener("error", onLost, { once: true });
    socket.addEventListener("close", onLost, { once: true });
    return socket;
  });

/** Times each request from send until its first answer, so a stuck one can be reported. */
export function trackRpcProtocol(
  protocol: RpcClient.Protocol["Service"],
): RpcClient.Protocol["Service"] {
  return {
    ...protocol,
    run: (writeResponse) =>
      protocol.run((response) => {
        if (response._tag === "Chunk" || response._tag === "Exit") {
          acknowledgeRpcRequest(response.requestId);
        } else if (response._tag === "ClientProtocolError" || response._tag === "Defect") {
          clearAllTrackedRpcRequests();
        }
        return writeResponse(response);
      }),
    send: (request, transferables) => {
      if (request._tag === "Interrupt") {
        acknowledgeRpcRequest(request.requestId);
      }
      if (request._tag !== "Request") {
        return protocol.send(request, transferables);
      }
      trackRpcRequestSent(request.id, request.tag);
      // A send refused during an outage fails its caller at once, so nothing is left waiting.
      return protocol
        .send(request, transferables)
        .pipe(Effect.onError(() => Effect.sync(() => acknowledgeRpcRequest(request.id))));
    },
  };
}

export function layerTrackedProtocolSocket(options?: {
  readonly retryTransientErrors?: boolean | undefined;
}): Layer.Layer<RpcClient.Protocol, never, Socket.Socket | RpcSerialization.RpcSerialization> {
  return Layer.effect(RpcClient.Protocol)(
    Effect.map(RpcClient.makeProtocolSocket(options), trackRpcProtocol),
  );
}
