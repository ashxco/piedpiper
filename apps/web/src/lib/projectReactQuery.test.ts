import type { NativeApi } from "@piedpiper/contracts";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as nativeApi from "../nativeApi";
import { projectConfigFileQueryOptions, projectQueryKeys } from "./projectReactQuery";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("projectConfigFileQueryOptions", () => {
  it("reads the config file for the project cwd", async () => {
    const readConfigFile = vi.fn().mockResolvedValue({ config: { scripts: [] } });
    vi.spyOn(nativeApi, "ensureNativeApi").mockReturnValue({
      projects: { readConfigFile },
    } as unknown as NativeApi);

    const options = projectConfigFileQueryOptions({ cwd: "/repo" });
    expect(options.queryKey).toEqual(projectQueryKeys.configFile("/repo"));
    expect(options.enabled).toBe(true);

    await expect(new QueryClient().fetchQuery(options)).resolves.toEqual({
      config: { scripts: [] },
    });
    expect(readConfigFile).toHaveBeenCalledWith({ cwd: "/repo" });
  });

  it("is disabled without a cwd or when the caller disables it", () => {
    expect(projectConfigFileQueryOptions({ cwd: null }).enabled).toBe(false);
    expect(projectConfigFileQueryOptions({ cwd: "/repo", enabled: false }).enabled).toBe(false);
  });
});
