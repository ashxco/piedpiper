import type * as NodeHttp from "node:http";
import type * as NodeStream from "node:stream";

/**
 * Node surfaces late socket write failures (EPIPE, ECONNRESET,
 * ERR_STREAM_DESTROYED) as "error" events, and an "error" event without a
 * listener becomes an uncaught exception that kills the whole server.
 *
 * Two emitters need coverage: upgrade sockets (Node's http server detaches
 * its own socket error handling once a connection upgrades, including for
 * auth rejections written to the raw socket) and server responses (which
 * have no default error listener). A dead client then only affects its own
 * request; the request fiber is already interrupted via the "close" event.
 *
 * Apply this before rejectRequestsUntilServing so these listeners exist
 * before its newListener handoff is installed.
 */
export function guardHttpResponseWriteErrors<T extends NodeHttp.Server>(
  server: T,
  onError?: (error: unknown) => void,
): T {
  server.on("request", (_request: NodeHttp.IncomingMessage, response: NodeHttp.ServerResponse) => {
    response.on("error", (error) => {
      onError?.(error);
    });
  });
  server.on("upgrade", (_request: NodeHttp.IncomingMessage, socket: NodeStream.Duplex) => {
    socket.on("error", (error) => {
      onError?.(error);
    });
  });
  return server;
}
