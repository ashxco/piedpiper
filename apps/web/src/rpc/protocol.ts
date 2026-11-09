import { WsRpcGroup } from "@piedpiper/contracts";
import { Effect, Layer } from "effect";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";

import { resolveServerUrl } from "../lib/utils";
import { appendAuthToken } from "./authToken";
import { layerFirstOpenWebSocket, type WsFirstOpenGate } from "./wsFirstOpenGate";
import { layerTrackedProtocolSocket, layerTrackingWebSocketConstructor } from "./wsTrackedProtocol";

export const makeWsRpcProtocolClient = RpcClient.make(WsRpcGroup);

type RpcClientFactory = typeof makeWsRpcProtocolClient;
export type WsRpcProtocolClient =
  RpcClientFactory extends Effect.Effect<infer Client, any, any> ? Client : never;

export function createWsRpcProtocolLayer(url?: string, firstOpenGate?: WsFirstOpenGate) {
  const resolvedUrl = appendAuthToken(
    resolveServerUrl({
      url,
      protocol: window.location.protocol === "https:" ? "wss" : "ws",
      pathname: "/ws",
    }),
  );
  const socketLayer = (
    firstOpenGate
      ? layerFirstOpenWebSocket(resolvedUrl, firstOpenGate)
      : Socket.layerWebSocket(resolvedUrl)
  ).pipe(Layer.provide(layerTrackingWebSocketConstructor));

  return layerTrackedProtocolSocket({ retryTransientErrors: false }).pipe(
    Layer.provide(Layer.mergeAll(socketLayer, RpcSerialization.layerJson)),
  );
}
