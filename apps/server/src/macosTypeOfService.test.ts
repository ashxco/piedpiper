import * as NodeNet from "node:net";

import { describe, expect, it } from "vitest";

import { ignoreMacosTypeOfServiceEinval } from "./macosTypeOfService.ts";

const errnoError = (code: string) =>
  Object.assign(new Error(`setTypeOfService ${code}`), { code, syscall: "setTypeOfService" });

describe("ignoreMacosTypeOfServiceEinval", () => {
  it("swallows only an Error with code EINVAL on macOS", () => {
    let error: unknown = errnoError("EINVAL");
    const prototype = {
      setTypeOfService(this: NodeNet.Socket, _typeOfService: number): NodeNet.Socket {
        throw error;
      },
    };
    ignoreMacosTypeOfServiceEinval("darwin", prototype);

    const socket = new NodeNet.Socket();
    expect(prototype.setTypeOfService.call(socket, 0)).toBe(socket);

    error = errnoError("EPERM");
    expect(() => prototype.setTypeOfService.call(socket, 0)).toThrow(error as Error);

    error = { code: "EINVAL" };
    expect(() => prototype.setTypeOfService.call(socket, 0)).toThrow();
  });

  it("passes through successful calls on macOS", () => {
    const socket = new NodeNet.Socket();
    const calls: Array<number> = [];
    const prototype = {
      setTypeOfService(this: NodeNet.Socket, typeOfService: number): NodeNet.Socket {
        calls.push(typeOfService);
        return this;
      },
    };
    ignoreMacosTypeOfServiceEinval("darwin", prototype);
    expect(prototype.setTypeOfService.call(socket, 16)).toBe(socket);
    expect(calls).toEqual([16]);
  });

  it("changes nothing off macOS or on a runtime without setTypeOfService", () => {
    const error = errnoError("EINVAL");
    const prototype = {
      setTypeOfService() {
        throw error;
      },
    };
    const original = prototype.setTypeOfService;
    ignoreMacosTypeOfServiceEinval("linux", prototype);
    ignoreMacosTypeOfServiceEinval("win32", prototype);
    expect(prototype.setTypeOfService).toBe(original);
    expect(() => prototype.setTypeOfService()).toThrow(error);

    const withoutTypeOfService = {};
    ignoreMacosTypeOfServiceEinval("darwin", withoutTypeOfService);
    expect(withoutTypeOfService).not.toHaveProperty("setTypeOfService");
  });
});
