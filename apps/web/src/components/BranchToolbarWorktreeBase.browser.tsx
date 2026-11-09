import type { GitBranch } from "@piedpiper/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

const { listBranchesSpy, statusSpy } = vi.hoisted(() => ({
  listBranchesSpy: vi.fn(),
  statusSpy: vi.fn(),
}));

vi.mock("~/nativeApi", () => {
  const api = { git: { listBranches: listBranchesSpy, status: statusSpy } };
  return { readNativeApi: () => api, ensureNativeApi: () => api };
});
vi.mock("~/wsRpcClient", () => ({ getWsRpcClient: vi.fn() }));

import { useWorktreeBaseBranch } from "./BranchToolbarWorktreeBase";

const noop = (): void => undefined;

function Probe({ enabled }: { enabled: boolean }) {
  const { baseBranch, isResolving } = useWorktreeBaseBranch({ cwd: "/repo", enabled });
  return <output>{`${baseBranch ?? "none"}|${isResolving ? "resolving" : "settled"}`}</output>;
}

async function renderProbe(enabled = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Probe enabled={enabled} />
    </QueryClientProvider>,
  );
}

function listResult(defaultBranch: string | null) {
  const branches: GitBranch[] = ["develop", "main"].map((name) => ({
    name,
    current: name === "develop",
    isDefault: name === defaultBranch,
    worktreePath: null,
  }));
  return { branches, isRepo: true, hasOriginRemote: true, nextCursor: null, totalCount: 2 };
}

afterEach(() => {
  listBranchesSpy.mockReset();
  statusSpy.mockReset();
});

describe("useWorktreeBaseBranch", () => {
  it("is resolving until the list answers, then gives the default branch", async () => {
    let answerList: (value: unknown) => void = noop;
    listBranchesSpy.mockReturnValue(new Promise((resolve) => (answerList = resolve)));
    statusSpy.mockResolvedValue({ branch: "develop", workingTree: {} });
    await renderProbe();

    await expect.element(page.getByText("none|resolving")).toBeInTheDocument();
    answerList(listResult("main"));
    await expect.element(page.getByText("main|settled")).toBeInTheDocument();
  });

  it("falls back to the checked-out branch when no default is known", async () => {
    listBranchesSpy.mockResolvedValue(listResult(null));
    statusSpy.mockResolvedValue({ branch: "develop", workingTree: {} });
    await renderProbe();

    await expect.element(page.getByText("develop|settled")).toBeInTheDocument();
  });

  it("falls back to the checked-out branch when the list fails", async () => {
    listBranchesSpy.mockRejectedValue(new Error("boom"));
    statusSpy.mockResolvedValue({ branch: "develop", workingTree: {} });
    await renderProbe();

    await expect.element(page.getByText("develop|settled")).toBeInTheDocument();
  });

  it("settles with no branch rather than blocking sends when git knows none", async () => {
    listBranchesSpy.mockRejectedValue(new Error("not a repo"));
    statusSpy.mockRejectedValue(new Error("not a repo"));
    await renderProbe();

    await expect.element(page.getByText("none|settled")).toBeInTheDocument();
  });

  it("asks git nothing while disabled", async () => {
    await renderProbe(false);

    await expect.element(page.getByText("none|settled")).toBeInTheDocument();
    expect(listBranchesSpy).not.toHaveBeenCalled();
    expect(statusSpy).not.toHaveBeenCalled();
  });
});
