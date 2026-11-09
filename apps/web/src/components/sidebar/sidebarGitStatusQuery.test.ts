import type { GitStatusResult } from "@piedpiper/contracts";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const status = vi.fn<(input: { cwd: string; refreshUpstream?: boolean }) => Promise<unknown>>();

vi.mock("../../nativeApi", () => ({
  ensureNativeApi: () => ({ git: { status } }),
}));

vi.mock("../../wsRpcClient", () => ({
  getWsRpcClient: vi.fn(),
}));

import {
  gitQueryKeys,
  gitStatusQueryOptions,
  invalidateGitQueries,
  invalidateGitStatusQuery,
} from "../../lib/gitReactQuery";
import { sidebarGitStatusQueryOptions } from "./sidebarGitStatusQuery";

const CWD = "/repo";
const passiveResult = { branch: "feature", pr: { number: 7 } } as unknown as GitStatusResult;

describe("sidebarGitStatusQueryOptions", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient();
    status.mockReset();
    status.mockResolvedValue(passiveResult);
  });

  it("asks the server not to refresh the upstream, under a passive key", async () => {
    const data = await queryClient.fetchQuery(sidebarGitStatusQueryOptions(CWD));
    expect(status).toHaveBeenCalledExactlyOnceWith({ cwd: CWD, refreshUpstream: false });
    expect(sidebarGitStatusQueryOptions(CWD).queryKey).toEqual(["git", "status", CWD, "passive"]);
    expect(data).toBe(passiveResult);
  });

  it("is disabled without a cwd", () => {
    expect(sidebarGitStatusQueryOptions(null).enabled).toBe(false);
  });

  it("seeds an empty active query as immediately stale, so a later reader still fetches", async () => {
    await queryClient.fetchQuery(sidebarGitStatusQueryOptions(CWD));

    const activeKey = gitQueryKeys.status(CWD);
    expect(queryClient.getQueryData(activeKey)).toBe(passiveResult);
    expect(queryClient.getQueryState(activeKey)?.dataUpdatedAt).toBe(0);

    const activeResult = { branch: "feature", pr: null } as unknown as GitStatusResult;
    status.mockResolvedValue(activeResult);
    const observer = new QueryObserver(queryClient, gitStatusQueryOptions(CWD));
    expect(observer.getCurrentResult().data).toBe(passiveResult);
    expect(observer.getCurrentResult().isStale).toBe(true);
    const unsubscribe = observer.subscribe(() => {});
    await vi.waitFor(() => expect(status).toHaveBeenLastCalledWith({ cwd: CWD }));
    await vi.waitFor(() => expect(queryClient.getQueryData(activeKey)).toEqual(activeResult));
    unsubscribe();
  });

  it("keeps a seed following later polls until a real active read replaces it", async () => {
    await queryClient.fetchQuery(sidebarGitStatusQueryOptions(CWD));

    const moved = { branch: "main", pr: null } as unknown as GitStatusResult;
    status.mockResolvedValue(moved);
    await queryClient.fetchQuery({ ...sidebarGitStatusQueryOptions(CWD), staleTime: 0 });

    const activeKey = gitQueryKeys.status(CWD);
    expect(queryClient.getQueryData(activeKey)).toEqual(moved);
    expect(queryClient.getQueryState(activeKey)?.dataUpdatedAt).toBe(0);
  });

  it("does not overwrite data the active query already has", async () => {
    const activeResult = { branch: "main", pr: null } as unknown as GitStatusResult;
    queryClient.setQueryData(gitQueryKeys.status(CWD), activeResult);

    await queryClient.fetchQuery(sidebarGitStatusQueryOptions(CWD));

    expect(queryClient.getQueryData(gitQueryKeys.status(CWD))).toBe(activeResult);
  });

  it("is invalidated along with the cwd's active status", async () => {
    await queryClient.fetchQuery(sidebarGitStatusQueryOptions(CWD));
    const passiveKey = sidebarGitStatusQueryOptions(CWD).queryKey;

    await invalidateGitStatusQuery(queryClient, CWD);
    expect(queryClient.getQueryState(passiveKey)?.isInvalidated).toBe(true);

    await queryClient.fetchQuery(sidebarGitStatusQueryOptions(CWD));
    expect(queryClient.getQueryState(passiveKey)?.isInvalidated).toBe(false);
    await invalidateGitQueries(queryClient, { cwd: CWD });
    expect(queryClient.getQueryState(passiveKey)?.isInvalidated).toBe(true);
  });
});
