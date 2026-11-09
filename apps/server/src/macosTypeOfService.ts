import * as NodeNet from "node:net";

// @types/node does not declare setTypeOfService yet.
type TypeOfServiceSocket = {
  setTypeOfService?: (this: NodeNet.Socket, typeOfService: number) => NodeNet.Socket;
};

/**
 * Node's bundled undici calls `socket.setTypeOfService` from a socket callback
 * without catching. On macOS it throws EINVAL after a peer reset, which would
 * exit the server over an optional QoS hint, so swallow exactly that error.
 */
export function ignoreMacosTypeOfServiceEinval(
  platform: NodeJS.Platform = process.platform,
  socketPrototype: TypeOfServiceSocket = NodeNet.Socket.prototype as TypeOfServiceSocket,
): void {
  if (platform !== "darwin") return;
  const setTypeOfService = socketPrototype.setTypeOfService;
  if (typeof setTypeOfService !== "function") return;
  socketPrototype.setTypeOfService = function (...args) {
    try {
      return setTypeOfService.apply(this, args);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EINVAL") return this;
      throw error;
    }
  };
}
