import type * as NodeHttp from "node:http";
import type * as NodeStream from "node:stream";

const rejectRequest = (_request: NodeHttp.IncomingMessage, response: NodeHttp.ServerResponse) => {
  response.writeHead(503, { "retry-after": "1", connection: "close" }).end();
};
const rejectUpgrade = (_request: NodeHttp.IncomingMessage, socket: NodeStream.Duplex) => {
  socket.on("error", () => {});
  socket.end(
    "HTTP/1.1 503 Service Unavailable\r\nRetry-After: 1\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
  );
};

/**
 * NodeHttpServer starts listening before serve() attaches its handlers, and
 * runtime services finish building in between, so early requests (including
 * renderer WebSocket upgrades) would otherwise hang. Answer them with a
 * temporary 503 + Retry-After until the serving handlers are installed.
 */
export function rejectRequestsUntilServing<T extends NodeHttp.Server>(server: T): T {
  server.on("request", rejectRequest);
  server.on("upgrade", rejectUpgrade);
  // Node emits newListener before adding the handler, so the handoff is synchronous.
  server.on("newListener", function onNewListener(event: string | symbol) {
    if (event === "request") server.off("request", rejectRequest);
    if (event === "upgrade") server.off("upgrade", rejectUpgrade);
    if (
      !server.listeners("request").includes(rejectRequest) &&
      !server.listeners("upgrade").includes(rejectUpgrade)
    ) {
      server.off("newListener", onNewListener);
    }
  });
  return server;
}
