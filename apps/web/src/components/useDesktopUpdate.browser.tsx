import type { DesktopBridge, DesktopUpdateState } from "@piedpiper/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { toastManager } from "../components/ui/toast";
import { desktopUpdateQueryKeys, useDesktopUpdateState } from "../lib/desktopUpdateReactQuery";
import { useDesktopUpdate } from "../hooks/useDesktopUpdate";

const mocks = vi.hoisted(() => ({ confirm: vi.fn(async () => true) }));
vi.mock("~/hooks/useSettings", () => ({ useSettings: () => true }));
vi.mock("~/nativeApi", () => ({ readNativeApi: () => ({ dialogs: mocks }) }));

const downloaded: DesktopUpdateState = {
  enabled: true,
  status: "downloaded",
  currentVersion: "1.0.0",
  hostArch: "arm64",
  appArch: "x64",
  runningUnderArm64Translation: true,
  availableVersion: "1.1.0",
  downloadedVersion: "1.1.0",
  downloadPercent: 100,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
};

const originalBridge = window.desktopBridge;
afterEach(() => {
  if (originalBridge) window.desktopBridge = originalBridge;
  else delete window.desktopBridge;
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

function setup(getUpdateState = async () => downloaded) {
  const listeners = new Set<(state: DesktopUpdateState) => void>();
  const push = (state: DesktopUpdateState) => listeners.forEach((listener) => listener(state));
  const bridge = {
    getUpdateState,
    onUpdateState: (listener: (state: DesktopUpdateState) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    installUpdate: vi.fn(),
  };
  window.desktopBridge = bridge as unknown as DesktopBridge;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let update: ReturnType<typeof useDesktopUpdate>;
  function Harness() {
    update = useDesktopUpdate();
    // Settings can observe the same cache alongside the sidebar.
    useDesktopUpdateState();
    return null;
  }
  return {
    bridge,
    client,
    push,
    current: () => update,
    tree: (
      <QueryClientProvider client={client}>
        <Harness />
      </QueryClientProvider>
    ),
  };
}

it("reports an ARM install failure once across observers and caches the action result", async () => {
  const test = setup();
  const addToast = vi.spyOn(toastManager, "add");
  const failed: DesktopUpdateState = {
    ...downloaded,
    status: "error",
    errorContext: "install",
    message: "Install failed",
    canRetry: true,
  };
  test.bridge.installUpdate.mockImplementation(async () => {
    test.push(failed);
    return { accepted: true, completed: false, state: failed };
  });
  await render(test.tree);
  await vi.waitFor(() => expect(test.current().action).toBe("install"));
  await test.current().handleAction();
  await vi.waitFor(() => expect(addToast).toHaveBeenCalledTimes(1));
  expect(addToast).toHaveBeenCalledWith(
    expect.objectContaining({ title: "Could not install update" }),
  );
  expect(mocks.confirm).toHaveBeenCalled();
  expect(test.client.getQueryData(desktopUpdateQueryKeys.state())).toEqual(failed);
});

it("keeps pushed state when an older initial snapshot resolves later", async () => {
  let resolve!: (state: DesktopUpdateState) => void;
  const test = setup(
    () =>
      new Promise<DesktopUpdateState>((done) => {
        resolve = done;
      }),
  );
  await render(test.tree);
  await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
  test.push(downloaded);
  resolve({ ...downloaded, status: "idle", downloadedVersion: null });
  await vi.waitFor(() => expect(test.current().state?.status).toBe("downloaded"));
  expect(test.client.getQueryData(desktopUpdateQueryKeys.state())).toEqual(downloaded);
});

it("reports late install failures only once across observers", async () => {
  const test = setup();
  const addToast = vi.spyOn(toastManager, "add");
  await render(test.tree);
  await vi.waitFor(() => expect(test.current().action).toBe("install"));
  const failed: DesktopUpdateState = { ...downloaded, status: "error", errorContext: "install" };
  test.push(failed);
  test.push(failed);
  expect(addToast).toHaveBeenCalledTimes(1);
});
