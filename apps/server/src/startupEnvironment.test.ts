import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { prepareStartupEnvironment, type StartupEnvironmentDeps } from "./startupEnvironment";

const makeDeps = (platform: NodeJS.Platform) => {
  const deps = {
    platform,
    fixPath: vi.fn(),
    hydrateHome: vi.fn(),
    repairWindowsPath: vi.fn(async () => false),
  } satisfies StartupEnvironmentDeps;
  return deps;
};

describe("prepareStartupEnvironment", () => {
  it("probes the login shell when the environment was not prepared", async () => {
    const deps = makeDeps("darwin");
    await Effect.runPromise(prepareStartupEnvironment(false, deps));
    expect(deps.fixPath).toHaveBeenCalledOnce();
    expect(deps.hydrateHome).not.toHaveBeenCalled();
    expect(deps.repairWindowsPath).toHaveBeenCalledOnce();
  });

  it("skips the login-shell probe when the desktop prepared the environment", async () => {
    const deps = makeDeps("linux");
    deps.hydrateHome.mockImplementation(() => {
      throw new Error("no user");
    });
    await Effect.runPromise(prepareStartupEnvironment(true, deps));
    expect(deps.fixPath).not.toHaveBeenCalled();
    expect(deps.hydrateHome).toHaveBeenCalledOnce();
    expect(deps.repairWindowsPath).toHaveBeenCalledOnce();
  });

  it("still repairs the Windows PATH when the environment was prepared", async () => {
    const deps = makeDeps("win32");
    await Effect.runPromise(prepareStartupEnvironment(true, deps));
    expect(deps.fixPath).not.toHaveBeenCalled();
    expect(deps.hydrateHome).not.toHaveBeenCalled();
    expect(deps.repairWindowsPath).toHaveBeenCalledOnce();
  });
});
