import type {
  OtlpEndpointCheckResult,
  OtlpSignal,
  ServerProcessDiagnosticsEntry,
} from "@piedpiper/contracts";

export const OTLP_ENDPOINT_ROWS = [
  { key: "otlpTracesUrl", label: "Traces", signal: "traces" },
  { key: "otlpMetricsUrl", label: "Metrics", signal: "metrics" },
  { key: "otlpLogsUrl", label: "Logs", signal: "logs" },
] as const satisfies ReadonlyArray<{
  readonly key: string;
  readonly label: string;
  readonly signal: OtlpSignal;
}>;

export type OtlpEndpointKey = (typeof OTLP_ENDPOINT_ROWS)[number]["key"];

/** The check itself did not complete, so this says nothing about the endpoint. */
export interface OtlpEndpointCheckFailure {
  readonly _tag: "CheckFailed";
  readonly message: string;
}

/** The latest check of an endpoint; it describes the field only while `url` is still its value. */
export interface OtlpEndpointCheck {
  readonly url: string;
  /** Null while the check is running. */
  readonly result: OtlpEndpointCheckResult | OtlpEndpointCheckFailure | null;
}

export const isOtlpEndpointUrl = (url: string): boolean => /^https?:\/\/\S+$/i.test(url);

/** An empty endpoint turns the export off. */
export const validateOtlpEndpointUrl = (url: string): string | null =>
  url === "" || isOtlpEndpointUrl(url)
    ? null
    : "Enter an http:// or https:// URL, or leave empty to turn this export off.";

export interface OtlpEndpointStatus {
  readonly label: string;
  readonly tone: "muted" | "pending" | "success" | "error";
}

export function otlpEndpointStatus(
  url: string,
  check: OtlpEndpointCheck | undefined,
): OtlpEndpointStatus {
  if (url === "") return { label: "Off", tone: "muted" };
  if (check?.url !== url) return { label: "Not checked", tone: "muted" };
  const { result } = check;
  if (result === null) return { label: "Checking...", tone: "pending" };
  switch (result._tag) {
    case "Accepted":
      return { label: `Connected, ${Math.round(result.latencyMs)} ms`, tone: "success" };
    case "Rejected":
      return { label: `Rejected, HTTP ${result.status}`, tone: "error" };
    case "Unreachable":
      return { label: result.timedOut ? "Timed out" : "Unreachable", tone: "error" };
    case "CheckFailed":
      return { label: `Check failed: ${result.message}`, tone: "error" };
  }
}

/** Export endpoints are read at startup, and the environment can outrank a saved one. */
export function otlpRestartNotice(saved: string, running: string | undefined): string | null {
  const runningUrl = running ?? "";
  if (saved === runningUrl) return null;
  return `Saved value is not in use. Running: ${runningUrl === "" ? "Off" : runningUrl}. Restart to apply unless an environment variable overrides it.`;
}

export function formatDiagnosticsBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export function formatDiagnosticsDuration(durationMs: number): string {
  if (durationMs < 1) return "<1 ms";
  if (durationMs < 1_000) return `${Math.round(durationMs)} ms`;
  if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(1)} s`;
  return `${(durationMs / 60_000).toFixed(1)} min`;
}

/** Null means the platform does not report CPU, not that nothing is using any. */
export function formatDiagnosticsCpu(cpuPercent: number | null): string {
  return cpuPercent === null ? "n/a" : `${cpuPercent.toFixed(1)}%`;
}

export function killConfirmationMessage(
  entry: Pick<ServerProcessDiagnosticsEntry, "pid" | "command">,
): string {
  const command = entry.command.length > 200 ? `${entry.command.slice(0, 200)}...` : entry.command;
  return [`Force kill process ${entry.pid}?`, command, "It gets no chance to clean up."].join("\n");
}
