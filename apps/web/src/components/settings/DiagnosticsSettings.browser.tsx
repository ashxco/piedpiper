import "../../index.css";

import {
  DEFAULT_SERVER_SETTINGS,
  type NativeApi,
  type ServerConfig,
  type ServerProcessDiagnosticsResult,
  type ServerTraceDiagnosticsResult,
} from "@piedpiper/contracts";
import { page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { __resetNativeApiForTests } from "../../nativeApi";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { resetServerStateForTests, setServerConfigSnapshot } from "../../rpc/serverState";
import { DiagnosticsSettingsPanel } from "./DiagnosticsSettings";
import { SETTINGS_SEARCH_ENTRIES } from "./settingsSearch";

const READ_AT = "2026-05-05T10:00:00.000Z";

const traces: ServerTraceDiagnosticsResult = {
  traceFilePath: "/logs/server.trace.ndjson",
  scannedFilePaths: ["/logs/server.trace.ndjson"],
  readAt: READ_AT,
  recordCount: 1234,
  parseErrorCount: 0,
  firstSpanAt: READ_AT,
  lastSpanAt: READ_AT,
  failureCount: 2,
  interruptionCount: 0,
  slowSpanThresholdMs: 1000,
  slowSpanCount: 1,
  logLevelCounts: {},
  topSpansByCount: [
    {
      name: "ws.rpc.getConfig",
      count: 40,
      failureCount: 0,
      totalDurationMs: 400,
      averageDurationMs: 10,
      maxDurationMs: 20,
    },
  ],
  slowestSpans: [],
  commonFailures: [
    {
      name: "git.status",
      cause: "Not a repository",
      count: 2,
      lastSeenAt: READ_AT,
      traceId: "t",
      spanId: "s",
    },
  ],
  latestFailures: [],
  latestWarningAndErrorLogs: [],
  partialFailure: false,
  error: null,
};

const processes: ServerProcessDiagnosticsResult = {
  serverPid: 100,
  readAt: READ_AT,
  processCount: 1,
  totalRssBytes: 2048,
  totalCpuPercent: 1.5,
  processes: [
    {
      pid: 101,
      ppid: 100,
      status: "S",
      cpuPercent: 1.5,
      rssBytes: 2048,
      elapsed: "00:10",
      command: "codex app-server",
      depth: 0,
    },
  ],
  supportsInterrupt: true,
  truncated: false,
  error: null,
};

const config: ServerConfig = {
  cwd: "/repo",
  keybindingsConfigPath: "/repo/keybindings.json",
  keybindings: [],
  issues: [],
  providers: [],
  availableEditors: [],
  observability: {
    logsDirectoryPath: "/logs",
    localTracingEnabled: true,
    otlpTracesEnabled: false,
    otlpMetricsEnabled: false,
  },
  settings: {
    ...DEFAULT_SERVER_SETTINGS,
    observability: {
      ...DEFAULT_SERVER_SETTINGS.observability,
      otlpTracesUrl: "http://collector:4318/v1/traces",
    },
  },
};

function mountApi() {
  const api = {
    getTraceDiagnostics: vi.fn(async () => traces),
    getProcessDiagnostics: vi.fn(async () => processes),
    signalProcess: vi.fn(
      async (input: { pid: number; signal: string }): Promise<unknown> => ({
        ...input,
        signaled: true,
        message: null,
      }),
    ),
    checkOtlpEndpoint: vi.fn(async () => ({ _tag: "Rejected", status: 401 })),
    updateSettings: vi.fn(async () => config.settings),
    confirm: vi.fn(async () => true),
  };
  window.nativeApi = {
    server: {
      getTraceDiagnostics: api.getTraceDiagnostics,
      getProcessDiagnostics: api.getProcessDiagnostics,
      signalProcess: api.signalProcess,
      checkOtlpEndpoint: api.checkOtlpEndpoint,
      updateSettings: api.updateSettings,
    },
    dialogs: { confirm: api.confirm },
  } as unknown as NativeApi;
  return api;
}

const renderPanel = () =>
  render(
    <AppAtomRegistryProvider>
      <DiagnosticsSettingsPanel />
    </AppAtomRegistryProvider>,
  );

describe("DiagnosticsSettingsPanel", () => {
  beforeEach(() => {
    resetServerStateForTests();
    __resetNativeApiForTests();
    localStorage.clear();
    document.body.innerHTML = "";
    setServerConfigSnapshot(config);
  });

  afterEach(() => {
    resetServerStateForTests();
    __resetNativeApiForTests();
    document.body.innerHTML = "";
  });

  it("shows the trace summary and the process list", async () => {
    mountApi();
    await renderPanel();

    await expect.element(page.getByText("1,234", { exact: true })).toBeInTheDocument();
    await expect.element(page.getByText("ws.rpc.getConfig")).toBeInTheDocument();
    await expect.element(page.getByText("Not a repository")).toBeInTheDocument();
    await expect.element(page.getByText("codex app-server")).toBeInTheDocument();
  });

  it("has every section the settings search jumps to", async () => {
    mountApi();
    await renderPanel();
    await expect.element(page.getByText("Child processes")).toBeInTheDocument();

    for (const entry of SETTINGS_SEARCH_ENTRIES) {
      if (entry.to !== "/settings/diagnostics") continue;
      expect(document.getElementById(entry.anchor!), entry.id).not.toBeNull();
    }
  });

  it("keeps a table's growing column visible on a narrow pane", async () => {
    mountApi();
    const screen = await renderPanel();
    await expect.element(page.getByText("codex app-server")).toBeInTheDocument();
    screen.container.style.width = "320px";

    const cell = page.getByText("codex app-server").element();
    expect(cell.getBoundingClientRect().width).toBeGreaterThan(100);
  });

  it("lists the newest failure and expands its full cause", async () => {
    const cause = `Failed at step one\n${"x".repeat(400)}`;
    const api = mountApi();
    api.getTraceDiagnostics.mockResolvedValue({
      ...traces,
      latestFailures: [
        {
          name: "git.push",
          cause,
          durationMs: 25,
          endedAt: READ_AT,
          traceId: "trace-abc",
          spanId: "span-1",
        },
      ],
    });
    await renderPanel();

    await expect.element(page.getByText("git.push")).toBeInTheDocument();
    await page.getByRole("button", { name: "Show full failure cause" }).first().click();
    await expect.element(page.getByText(/Failed at step one/)).toHaveClass(/whitespace-pre-wrap/);
    await page.getByRole("button", { name: "Collapse failure cause" }).click();
    await expect
      .element(page.getByRole("button", { name: "Collapse failure cause" }))
      .not.toBeInTheDocument();
  });

  it("copies a trace ID from a row", async () => {
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const api = mountApi();
    api.getTraceDiagnostics.mockResolvedValue({
      ...traces,
      slowestSpans: [
        {
          name: "git.status",
          durationMs: 30,
          endedAt: READ_AT,
          traceId: "trace-abc",
          spanId: "span-2",
        },
      ],
    });
    await renderPanel();

    await page.getByRole("button", { name: "Copy trace ID trace-abc" }).click();
    expect(writeText).toHaveBeenCalledWith("trace-abc");
    writeText.mockRestore();
  });

  it("says logs are elsewhere when they are exported to an endpoint", async () => {
    setServerConfigSnapshot({
      ...config,
      observability: { ...config.observability, otlpLogsEnabled: true },
    });
    mountApi();
    await renderPanel();

    await expect
      .element(page.getByText(/Logs are exported to the OTLP endpoint/))
      .toBeInTheDocument();
    await expect.element(page.getByText("No warning or error logs found.")).not.toBeInTheDocument();
  });

  it("shows n/a where the platform does not report CPU", async () => {
    const api = mountApi();
    api.getProcessDiagnostics.mockResolvedValue({
      ...processes,
      totalCpuPercent: null,
      processes: [{ ...processes.processes[0]!, cpuPercent: null }],
    });
    await renderPanel();

    await expect.element(page.getByText("codex app-server")).toBeInTheDocument();
    await expect.element(page.getByText("0.0%")).not.toBeInTheDocument();
    expect(page.getByText("n/a", { exact: true }).elements().length).toBeGreaterThanOrEqual(2);
  });

  it("shows a server read error and recovers on refresh", async () => {
    const api = mountApi();
    api.getTraceDiagnostics.mockRejectedValueOnce(new Error("Read failed"));
    await renderPanel();

    await expect.element(page.getByText("Read failed")).toBeInTheDocument();
    await page.getByRole("button", { name: "Refresh traces" }).click();
    await expect.element(page.getByText("1,234", { exact: true })).toBeInTheDocument();
    await expect.element(page.getByText("Read failed")).not.toBeInTheDocument();
  });

  it("interrupts without asking and confirms before a kill", async () => {
    const api = mountApi();
    await renderPanel();

    await page.getByRole("button", { name: "Interrupt process 101" }).click();
    await vi.waitFor(() =>
      expect(api.signalProcess).toHaveBeenCalledWith({
        pid: 101,
        signal: "SIGINT",
        expectedCommand: "codex app-server",
      }),
    );
    expect(api.confirm).not.toHaveBeenCalled();

    api.confirm.mockResolvedValueOnce(false);
    await page.getByRole("button", { name: "Force kill process 101" }).click();
    await vi.waitFor(() => expect(api.confirm).toHaveBeenCalledTimes(1));
    expect(api.signalProcess).toHaveBeenCalledTimes(1);

    await page.getByRole("button", { name: "Force kill process 101" }).click();
    await vi.waitFor(() =>
      expect(api.signalProcess).toHaveBeenLastCalledWith({
        pid: 101,
        signal: "SIGKILL",
        expectedCommand: "codex app-server",
      }),
    );
  });

  it("shows why a signal was refused", async () => {
    const api = mountApi();
    api.signalProcess.mockResolvedValueOnce({
      pid: 101,
      signal: "SIGINT",
      signaled: false,
      message: "Process 101 is not a live descendant of the server.",
    });
    await renderPanel();

    await page.getByRole("button", { name: "Interrupt process 101" }).click();
    await expect
      .element(page.getByText("Process 101 is not a live descendant of the server."))
      .toBeInTheDocument();
  });

  it("tests an endpoint and says a saved change needs a restart", async () => {
    const api = mountApi();
    await renderPanel();

    await expect
      .element(page.getByText(/Saved value is not in use. Running: Off/))
      .toBeInTheDocument();
    await expect.element(page.getByText("Not checked")).toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Test logs endpoint" })).toBeDisabled();

    await page.getByRole("button", { name: "Test traces endpoint" }).click();
    expect(api.checkOtlpEndpoint).toHaveBeenCalledWith({
      signal: "traces",
      url: "http://collector:4318/v1/traces",
    });
    await expect.element(page.getByText("Rejected, HTTP 401")).toBeInTheDocument();
  });

  it("tests the typed URL without saving it", async () => {
    const api = mountApi();
    await renderPanel();

    const typed = "http://candidate:4318/v1/traces";
    await page.getByRole("textbox", { name: "Traces endpoint" }).fill(`  ${typed} `);
    await page.getByRole("button", { name: "Test traces endpoint" }).click();
    expect(api.checkOtlpEndpoint).toHaveBeenCalledWith({ signal: "traces", url: typed });
    await expect.element(page.getByText("Rejected, HTTP 401")).toBeInTheDocument();
    expect(api.updateSettings).not.toHaveBeenCalled();

    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByText("Not checked")).toBeInTheDocument();
    await page.getByRole("button", { name: "Test traces endpoint" }).click();
    expect(api.checkOtlpEndpoint).toHaveBeenLastCalledWith({
      signal: "traces",
      url: "http://collector:4318/v1/traces",
    });
  });

  it("disables Test while the typed URL is not http", async () => {
    mountApi();
    await renderPanel();

    await page.getByRole("textbox", { name: "Traces endpoint" }).fill("ftp://collector");
    await expect.element(page.getByRole("button", { name: "Test traces endpoint" })).toBeDisabled();
  });

  it("keeps a failed check apart from an unreachable endpoint and allows a retry", async () => {
    const api = mountApi();
    api.checkOtlpEndpoint.mockRejectedValueOnce(new Error("Connection lost"));
    await renderPanel();

    const test = page.getByRole("button", { name: "Test traces endpoint" });
    await test.click();
    await expect.element(page.getByText("Check failed: Connection lost")).toBeInTheDocument();
    await expect.element(test).toBeEnabled();
    await test.click();
    await expect.element(page.getByText("Rejected, HTTP 401")).toBeInTheDocument();
  });

  it("saves one endpoint and refuses a URL that is not http", async () => {
    const api = mountApi();
    await renderPanel();

    const input = page.getByRole("textbox", { name: "Metrics endpoint" });
    await input.fill("ftp://collector");
    await userEvent.keyboard("{Enter}");
    await expect.element(page.getByText(/Enter an http/)).toBeInTheDocument();
    expect(api.updateSettings).not.toHaveBeenCalled();

    await input.fill("http://collector:4318/v1/metrics");
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() =>
      expect(api.updateSettings).toHaveBeenCalledWith({
        observability: { otlpMetricsUrl: "http://collector:4318/v1/metrics" },
      }),
    );
  });
});
