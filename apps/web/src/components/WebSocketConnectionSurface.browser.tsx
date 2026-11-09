import "../index.css";

import { WS_METHODS } from "@piedpiper/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useParams: (options: { select: (params: Record<string, string>) => unknown }) =>
    options.select({}),
}));

import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import {
  acknowledgeRpcRequest,
  clearAllTrackedRpcRequests,
  getSlowRpcRequests,
  LONG_RUNNING_RPC_THRESHOLD_MS,
  SLOW_RPC_THRESHOLD_MS,
  trackRpcRequestSent,
} from "../rpc/requestLatencyState";
import {
  recordWsConnectionAttempt,
  recordWsConnectionLost,
  recordWsConnectionOpened,
  resetWsConnectionStateForTests,
  WS_DISCONNECT_BANNER_GRACE_MS,
} from "../rpc/wsConnectionState";
import { ToastProvider, toastManager } from "./ui/toast";
import {
  SlowRpcRequestToastCoordinator,
  WebSocketConnectionBanner,
} from "./WebSocketConnectionSurface";

const BANNER_TEXT = /Lost connection/;

function renderSurface() {
  return render(
    <AppAtomRegistryProvider>
      <WebSocketConnectionBanner />
      <SlowRpcRequestToastCoordinator />
    </AppAtomRegistryProvider>,
  );
}

function connect(): number {
  const attempt = recordWsConnectionAttempt();
  recordWsConnectionOpened(attempt);
  return attempt;
}

describe("WebSocketConnectionBanner", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    resetWsConnectionStateForTests();
    clearAllTrackedRpcRequests();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetWsConnectionStateForTests();
    clearAllTrackedRpcRequests();
  });

  it("stays hidden until the first connect", async () => {
    const { unmount } = await renderSurface();

    recordWsConnectionLost(recordWsConnectionAttempt());
    await vi.advanceTimersByTimeAsync(WS_DISCONNECT_BANNER_GRACE_MS * 2);

    await expect.element(page.getByText(BANNER_TEXT)).not.toBeInTheDocument();
    await unmount();
  });

  it("appears after the grace period and leaves on reconnect", async () => {
    const attempt = connect();
    const { unmount } = await renderSurface();

    recordWsConnectionLost(attempt);
    await vi.advanceTimersByTimeAsync(WS_DISCONNECT_BANNER_GRACE_MS - 1);
    await expect.element(page.getByText(BANNER_TEXT)).not.toBeInTheDocument();

    // A retry inside one outage must not restart the wait.
    recordWsConnectionAttempt();
    await vi.advanceTimersByTimeAsync(1);
    await expect.element(page.getByText(BANNER_TEXT)).toBeVisible();

    connect();
    await expect.element(page.getByText(BANNER_TEXT)).not.toBeInTheDocument();
    await unmount();
  });

  it("does not appear for a drop that recovers inside the grace period", async () => {
    const attempt = connect();
    const { unmount } = await renderSurface();

    recordWsConnectionLost(attempt);
    await vi.advanceTimersByTimeAsync(WS_DISCONNECT_BANNER_GRACE_MS - 1);
    connect();
    await vi.advanceTimersByTimeAsync(WS_DISCONNECT_BANNER_GRACE_MS);

    await expect.element(page.getByText(BANNER_TEXT)).not.toBeInTheDocument();
    await unmount();
  });
});

describe("SlowRpcRequestToastCoordinator", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    resetWsConnectionStateForTests();
    clearAllTrackedRpcRequests();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    resetWsConnectionStateForTests();
    clearAllTrackedRpcRequests();
  });

  it("keeps one toast for several slow requests and closes it when they finish", async () => {
    const add = vi.spyOn(toastManager, "add").mockReturnValue("slow-toast");
    const update = vi.spyOn(toastManager, "update").mockImplementation(() => undefined);
    const close = vi.spyOn(toastManager, "close").mockImplementation(() => undefined);
    connect();
    const { unmount } = await renderSurface();

    trackRpcRequestSent("1", WS_METHODS.serverGetConfig);
    await vi.advanceTimersByTimeAsync(SLOW_RPC_THRESHOLD_MS);
    await vi.waitFor(() => expect(add).toHaveBeenCalledTimes(1));
    expect(add.mock.calls[0]?.[0]).toMatchObject({ title: "Some requests are slow" });

    trackRpcRequestSent("2", WS_METHODS.projectsList);
    await vi.advanceTimersByTimeAsync(SLOW_RPC_THRESHOLD_MS);
    await vi.waitFor(() =>
      expect(update).toHaveBeenCalledWith(
        "slow-toast",
        expect.objectContaining({ description: "2 requests have been waiting for over 15s." }),
      ),
    );
    expect(add).toHaveBeenCalledTimes(1);

    acknowledgeRpcRequest("1");
    acknowledgeRpcRequest("2");
    await vi.waitFor(() => expect(close).toHaveBeenCalledWith("slow-toast"));
    await unmount();
  });

  it("respects a dismissal until another request gets stuck", async () => {
    connect();
    const { unmount } = await render(
      <AppAtomRegistryProvider>
        <ToastProvider>
          <SlowRpcRequestToastCoordinator />
        </ToastProvider>
      </AppAtomRegistryProvider>,
    );
    const title = page.getByText("Some requests are slow");

    trackRpcRequestSent("1", WS_METHODS.serverGetConfig);
    trackRpcRequestSent("2", WS_METHODS.serverGetConfig);
    await vi.advanceTimersByTimeAsync(SLOW_RPC_THRESHOLD_MS);
    await expect.element(title).toBeVisible();

    // Base UI hides the button from the accessibility tree until the toast is hovered.
    document.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click();
    await expect.element(title).not.toBeInTheDocument();

    acknowledgeRpcRequest("2");
    await vi.advanceTimersByTimeAsync(0);
    await expect.element(title).not.toBeInTheDocument();

    trackRpcRequestSent("3", WS_METHODS.projectsList);
    await vi.advanceTimersByTimeAsync(SLOW_RPC_THRESHOLD_MS);
    await expect.element(title).toBeVisible();
    await expect.element(page.getByText("2 requests have been waiting")).toBeVisible();

    acknowledgeRpcRequest("1");
    acknowledgeRpcRequest("3");
    await expect.element(title).not.toBeInTheDocument();
    await unmount();
  });

  it("stays away while disconnected", async () => {
    const add = vi.spyOn(toastManager, "add").mockReturnValue("slow-toast");
    const attempt = connect();
    const { unmount } = await renderSurface();

    trackRpcRequestSent("1", WS_METHODS.gitPull);
    recordWsConnectionLost(attempt);
    await vi.advanceTimersByTimeAsync(LONG_RUNNING_RPC_THRESHOLD_MS);
    trackRpcRequestSent("2", WS_METHODS.serverGetConfig);
    await vi.advanceTimersByTimeAsync(SLOW_RPC_THRESHOLD_MS);

    expect(getSlowRpcRequests()).toHaveLength(2);
    expect(add).not.toHaveBeenCalled();
    await unmount();
  });
});
