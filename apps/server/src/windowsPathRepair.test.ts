import { describe, expect, it, vi } from "vitest";

import { repairWindowsPath } from "./windowsPathRepair";

describe("repairWindowsPath", () => {
  it("does nothing outside Windows", async () => {
    const resolveEnvironment = vi.fn(async () => ({ PATH: "C:\\new" }));
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };

    await expect(repairWindowsPath({ env, platform: "darwin", resolveEnvironment })).resolves.toBe(
      false,
    );
    expect(resolveEnvironment).not.toHaveBeenCalled();
    expect(env.PATH).toBe("/usr/bin");
  });

  it("applies the resolved PATH and drops other PATH key spellings", async () => {
    const env: NodeJS.ProcessEnv = { Path: "C:\\Windows" };
    const changed = await repairWindowsPath({
      env,
      platform: "win32",
      resolveEnvironment: async () => ({
        PATH: "C:\\Windows;C:\\Users\\me\\AppData\\Roaming\\npm",
        FNM_DIR: "C:\\fnm",
      }),
    });

    expect(changed).toBe(true);
    expect(env).toEqual({
      PATH: "C:\\Windows;C:\\Users\\me\\AppData\\Roaming\\npm",
      FNM_DIR: "C:\\fnm",
    });
  });

  it("keeps the inherited PATH and logs when resolution fails", async () => {
    const env: NodeJS.ProcessEnv = { PATH: "C:\\Windows" };
    const logWarning = vi.fn();
    const changed = await repairWindowsPath({
      env,
      platform: "win32",
      logWarning,
      resolveEnvironment: async () => {
        throw new Error("boom");
      },
    });

    expect(changed).toBe(false);
    expect(env.PATH).toBe("C:\\Windows");
    expect(logWarning).toHaveBeenCalledOnce();
  });

  it("merges the registry PATH from the PowerShell probe into a single PATH key", async () => {
    const env: NodeJS.ProcessEnv = { Path: "C:\\Windows\\System32" };
    const runProbe = vi.fn(async () =>
      [
        "__PIEDPIPER_ENV_PATH_START__",
        "C:\\Windows\\System32;C:\\Program Files\\nodejs",
        "__PIEDPIPER_ENV_PATH_END__",
      ].join("\r\n"),
    );

    await repairWindowsPath({
      env,
      platform: "win32",
      resolverOptions: { runProbe, commandAvailable: () => true },
    });

    expect(runProbe).toHaveBeenCalledTimes(1);
    expect(Object.keys(env).filter((key) => key.toUpperCase() === "PATH")).toEqual(["PATH"]);
    expect(env.PATH).toBe("C:\\Windows\\System32;C:\\Program Files\\nodejs");
  });
});
