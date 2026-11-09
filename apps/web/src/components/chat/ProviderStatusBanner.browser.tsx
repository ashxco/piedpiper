import "../../index.css";

import type { ServerProvider } from "@piedpiper/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const { refreshProvidersSpy } = vi.hoisted(() => ({
  refreshProvidersSpy: vi.fn<() => Promise<unknown>>(),
}));

vi.mock("~/nativeApi", () => ({
  ensureNativeApi: () => ({ server: { refreshProviders: refreshProvidersSpy } }),
}));

import { ProviderStatusBanner } from "./ProviderStatusBanner";

const STATUS: ServerProvider = {
  provider: "claudeAgent",
  enabled: true,
  installed: false,
  version: null,
  status: "error",
  auth: { status: "unknown" },
  checkedAt: "2026-03-04T12:00:00.000Z",
  message: "Claude CLI is not installed.",
  models: [],
} as unknown as ServerProvider;

describe("ProviderStatusBanner", () => {
  afterEach(() => {
    refreshProvidersSpy.mockReset();
  });

  it("re-probes providers from the Refresh button and shows progress", async () => {
    let finishRefresh: (() => void) | undefined;
    refreshProvidersSpy.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishRefresh = () => resolve({ providers: [] });
        }),
    );
    const screen = await render(<ProviderStatusBanner status={STATUS} />);

    await screen.getByRole("button", { name: /Refresh .* provider status/ }).click();
    await expect.element(screen.getByText("Refreshing...")).toBeInTheDocument();
    expect(refreshProvidersSpy).toHaveBeenCalledTimes(1);

    finishRefresh?.();
    await expect.element(screen.getByText("Refresh", { exact: true })).toBeInTheDocument();
  });

  it("recovers when the refresh fails", async () => {
    refreshProvidersSpy.mockRejectedValue(new Error("offline"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const screen = await render(<ProviderStatusBanner status={STATUS} />);

    await screen.getByRole("button", { name: /Refresh .* provider status/ }).click();
    await expect.element(screen.getByText("Refresh", { exact: true })).toBeInTheDocument();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
