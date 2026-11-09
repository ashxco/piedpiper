import type {
  OtlpEndpointCheckInput,
  ServerProcessDiagnosticsEntry,
  ServerProcessSignal,
} from "@piedpiper/contracts";
import { RefreshCwIcon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { persistServerSettingsPatch, useSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { ensureNativeApi } from "../../nativeApi";
import { useServerObservability } from "../../rpc/serverState";
import { formatDayAwareTimestamp, formatTimestamp } from "../../timestampFormat";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import {
  formatDiagnosticsBytes,
  formatDiagnosticsCpu,
  formatDiagnosticsDuration,
  isOtlpEndpointUrl,
  killConfirmationMessage,
  OTLP_ENDPOINT_ROWS,
  otlpEndpointStatus,
  type OtlpEndpointCheck,
  type OtlpEndpointStatus,
  otlpRestartNotice,
  validateOtlpEndpointUrl,
} from "./DiagnosticsSettings.logic";
import {
  SettingResetButton,
  SettingsDraftInput,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./panels/SettingsPrimitives";

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

// Async so a missing native API is a read error, not a throw inside an effect.
const readTraceDiagnostics = async () => ensureNativeApi().server.getTraceDiagnostics();
const readProcessDiagnostics = async () => ensureNativeApi().server.getProcessDiagnostics();

/** Reads once on mount and on each refresh. A failed refresh keeps the last good data. */
function useServerRead<T>(read: () => Promise<T>) {
  const [request, setRequest] = useState(0);
  const [settled, setSettled] = useState<{
    readonly request: number;
    readonly data: T | null;
    readonly error: string | null;
  }>({ request: -1, data: null, error: null });

  useEffect(() => {
    let stale = false;
    read().then(
      (data) => {
        if (!stale) setSettled({ request, data, error: null });
      },
      (cause: unknown) => {
        if (stale) return;
        setSettled((previous) => ({
          request,
          data: previous.data,
          error: errorMessage(cause),
        }));
      },
    );
    return () => {
      stale = true;
    };
  }, [read, request]);

  return {
    data: settled.data,
    error: settled.error,
    loading: settled.request !== request,
    refresh: () => setRequest((value) => value + 1),
  };
}

function RefreshButton({
  loading,
  onClick,
  label,
}: {
  loading: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <Button size="xs" variant="outline" disabled={loading} aria-label={label} onClick={onClick}>
      <RefreshCwIcon className={cn("size-3.5", loading && "animate-spin")} />
      Refresh
    </Button>
  );
}

function DiagnosticsStat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="truncate text-sm font-medium tabular-nums text-foreground">{value}</div>
    </div>
  );
}

function DiagnosticsNotice({
  children,
  tone = "muted",
}: {
  children: ReactNode;
  tone?: "muted" | "error";
}) {
  return (
    <p
      className={cn(
        "border-t border-border px-4 py-3 text-xs first:border-t-0 sm:px-5",
        tone === "error" ? "text-destructive" : "text-muted-foreground",
      )}
    >
      {children}
    </p>
  );
}

function DiagnosticsTable<Row>({
  title,
  columns,
  rows,
  rowKey,
  emptyLabel,
}: {
  title: string;
  columns: ReadonlyArray<{
    readonly header: string;
    readonly align?: "right";
    readonly grow?: boolean;
    /** Tailwind width for a column that needs more than the default. */
    readonly width?: string;
    readonly cell: (row: Row) => ReactNode;
  }>;
  rows: ReadonlyArray<Row>;
  rowKey: (row: Row) => string;
  emptyLabel: string;
}) {
  return (
    <div className="border-t border-border px-4 py-4 first:border-t-0 sm:px-5">
      <h3 className="mb-2 text-sm font-medium text-foreground">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">{emptyLabel}</p>
      ) : (
        <div className="overflow-x-auto">
          {/* Fixed layout gives a grow column only what is left, so it needs room to scroll to. */}
          <table className="w-full min-w-[40rem] table-fixed text-xs">
            <thead className="text-left text-[11px] text-muted-foreground">
              <tr>
                {columns.map((column) => (
                  <th
                    key={column.header}
                    scope="col"
                    className={cn(
                      "pb-1.5 pr-3 font-normal last:pr-0",
                      column.align === "right" && "text-right",
                      column.grow ? "w-auto" : (column.width ?? "w-20"),
                    )}
                  >
                    {column.header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={rowKey(row)} className="border-t border-border/60 align-top">
                  {columns.map((column) => (
                    <td
                      key={column.header}
                      className={cn(
                        "py-1.5 pr-3 tabular-nums text-foreground last:pr-0",
                        column.align === "right" && "text-right",
                      )}
                    >
                      {column.cell(row)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function TruncatedText({ text, mono = false }: { text: string; mono?: boolean }) {
  return (
    <span className={cn("block truncate", mono && "font-mono text-[11px]")} title={text}>
      {text}
    </span>
  );
}

/** One line until clicked, then the whole text, selectable so it can be copied. */
function ExpandableText({ text, label }: { text: string; label: string }) {
  const [expanded, setExpanded] = useState(false);
  if (!expanded) {
    return (
      <button
        type="button"
        aria-label={`Show full ${label}`}
        title={text}
        className="block w-full cursor-pointer truncate text-left hover:underline"
        onClick={() => setExpanded(true)}
      >
        {text}
      </button>
    );
  }
  return (
    <span className="block">
      <span className="block whitespace-pre-wrap break-words">{text}</span>
      <Button
        size="xs"
        variant="ghost"
        className="mt-1"
        aria-label={`Collapse ${label}`}
        onClick={() => setExpanded(false)}
      >
        Show less
      </Button>
    </span>
  );
}

/** A way into `server.trace.ndjson` from a row: the ID is what to search that file for. */
function TraceIdCell({ traceId }: { traceId: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: "Could not copy the trace ID",
        description: error.message,
      });
    },
  });
  return (
    <button
      type="button"
      aria-label={`Copy trace ID ${traceId}`}
      title={traceId}
      className="block w-full cursor-pointer truncate text-left font-mono text-[11px] text-muted-foreground hover:text-foreground"
      onClick={() => copyToClipboard(traceId, undefined)}
    >
      {isCopied ? "Copied" : traceId}
    </button>
  );
}

const TIME_COLUMN_WIDTH = "w-36";
const TRACE_COLUMN_WIDTH = "w-24";

function TraceSummarySection() {
  const { data, error, loading, refresh } = useServerRead(readTraceDiagnostics);
  const timestampFormat = useSettings((settings) => settings.timestampFormat);
  const logExportEnabled = useServerObservability()?.otlpLogsEnabled === true;
  // The summary spans up to 11 rotated files, which can cover days, so times carry the date.
  const formatTime = (iso: string) => formatDayAwareTimestamp(iso, timestampFormat);
  const timeCell = (iso: string) => (
    <span title={formatTimestamp(iso, timestampFormat)}>{formatTime(iso)}</span>
  );

  return (
    <SettingsSection
      id="diagnostics-traces"
      title="Traces"
      headerAction={<RefreshButton loading={loading} onClick={refresh} label="Refresh traces" />}
    >
      {error ? <DiagnosticsNotice tone="error">{error}</DiagnosticsNotice> : null}
      {!data ? (
        error ? null : (
          <DiagnosticsNotice>Reading the local trace files...</DiagnosticsNotice>
        )
      ) : (
        <>
          {data.error ? (
            <DiagnosticsNotice
              tone={data.error.kind === "trace-file-not-found" ? "muted" : "error"}
            >
              {data.error.message}
              {data.partialFailure ? " The summary covers the files that could be read." : ""}
            </DiagnosticsNotice>
          ) : null}
          <div className="grid grid-cols-2 gap-4 border-t border-border px-4 py-4 first:border-t-0 sm:grid-cols-5 sm:px-5">
            <DiagnosticsStat label="Spans" value={data.recordCount.toLocaleString()} />
            <DiagnosticsStat label="Failures" value={data.failureCount.toLocaleString()} />
            <DiagnosticsStat label="Interrupted" value={data.interruptionCount.toLocaleString()} />
            <DiagnosticsStat
              label={`Slower than ${formatDiagnosticsDuration(data.slowSpanThresholdMs)}`}
              value={data.slowSpanCount.toLocaleString()}
            />
            <DiagnosticsStat
              label="Unreadable lines"
              value={data.parseErrorCount.toLocaleString()}
            />
          </div>
          {data.firstSpanAt && data.lastSpanAt ? (
            <DiagnosticsNotice>
              {formatTime(data.firstSpanAt)} to {formatTime(data.lastSpanAt)}, from{" "}
              <span className="break-all font-mono text-[11px]">{data.traceFilePath}</span> and its
              rotated files.
            </DiagnosticsNotice>
          ) : null}
          <DiagnosticsTable
            title="Most frequent spans"
            emptyLabel="No spans found."
            rows={data.topSpansByCount}
            rowKey={(span) => span.name}
            columns={[
              {
                header: "Span",
                grow: true,
                cell: (span) => <TruncatedText text={span.name} mono />,
              },
              { header: "Count", align: "right", cell: (span) => span.count.toLocaleString() },
              {
                header: "Failed",
                align: "right",
                cell: (span) => span.failureCount.toLocaleString(),
              },
              {
                header: "Average",
                align: "right",
                cell: (span) => formatDiagnosticsDuration(span.averageDurationMs),
              },
              {
                header: "Slowest",
                align: "right",
                cell: (span) => formatDiagnosticsDuration(span.maxDurationMs),
              },
            ]}
          />
          <DiagnosticsTable
            title="Slowest spans"
            emptyLabel="No spans found."
            rows={data.slowestSpans}
            rowKey={(span) => span.spanId}
            columns={[
              {
                header: "Span",
                grow: true,
                cell: (span) => <TruncatedText text={span.name} mono />,
              },
              {
                header: "Duration",
                align: "right",
                cell: (span) => formatDiagnosticsDuration(span.durationMs),
              },
              {
                header: "Ended",
                align: "right",
                width: TIME_COLUMN_WIDTH,
                cell: (span) => timeCell(span.endedAt),
              },
              {
                header: "Trace",
                width: TRACE_COLUMN_WIDTH,
                cell: (span) => <TraceIdCell traceId={span.traceId} />,
              },
            ]}
          />
          <DiagnosticsTable
            title="Latest failures"
            emptyLabel="No failed spans found."
            rows={data.latestFailures}
            rowKey={(failure) => `${failure.spanId}:${failure.endedAt}`}
            columns={[
              {
                header: "Span",
                grow: true,
                cell: (failure) => <TruncatedText text={failure.name} mono />,
              },
              {
                header: "Cause",
                grow: true,
                cell: (failure) => <ExpandableText text={failure.cause} label="failure cause" />,
              },
              {
                header: "Duration",
                align: "right",
                cell: (failure) => formatDiagnosticsDuration(failure.durationMs),
              },
              {
                header: "Ended",
                align: "right",
                width: TIME_COLUMN_WIDTH,
                cell: (failure) => timeCell(failure.endedAt),
              },
              {
                header: "Trace",
                width: TRACE_COLUMN_WIDTH,
                cell: (failure) => <TraceIdCell traceId={failure.traceId} />,
              },
            ]}
          />
          <DiagnosticsTable
            title="Common failures"
            emptyLabel="No failed spans found."
            rows={data.commonFailures}
            rowKey={(failure) => `${failure.name}:${failure.cause}`}
            columns={[
              {
                header: "Span",
                grow: true,
                cell: (failure) => <TruncatedText text={failure.name} mono />,
              },
              {
                header: "Cause",
                grow: true,
                cell: (failure) => <ExpandableText text={failure.cause} label="failure cause" />,
              },
              {
                header: "Count",
                align: "right",
                cell: (failure) => failure.count.toLocaleString(),
              },
              {
                header: "Last seen",
                align: "right",
                width: TIME_COLUMN_WIDTH,
                cell: (failure) => timeCell(failure.lastSeenAt),
              },
            ]}
          />
          <DiagnosticsTable
            title="Recent warnings and errors"
            emptyLabel={
              logExportEnabled
                ? "Logs are exported to the OTLP endpoint, so they are not in the local trace file."
                : "No warning or error logs found."
            }
            rows={data.latestWarningAndErrorLogs}
            rowKey={(log) => `${log.spanId}:${log.seenAt}:${log.message}`}
            columns={[
              { header: "Level", cell: (log) => log.level },
              {
                header: "Message",
                grow: true,
                cell: (log) => <ExpandableText text={log.message} label="log message" />,
              },
              {
                header: "Span",
                grow: true,
                cell: (log) => <TruncatedText text={log.spanName} mono />,
              },
              {
                header: "Seen",
                align: "right",
                width: TIME_COLUMN_WIDTH,
                cell: (log) => timeCell(log.seenAt),
              },
              {
                header: "Trace",
                width: TRACE_COLUMN_WIDTH,
                cell: (log) => <TraceIdCell traceId={log.traceId} />,
              },
            ]}
          />
        </>
      )}
    </SettingsSection>
  );
}

const PROCESS_REFRESH_DELAY_MS = 300;

/** Resolves to the message to show, or null when the signal was delivered. */
async function signalProcessEntry(
  entry: ServerProcessDiagnosticsEntry,
  signal: ServerProcessSignal,
): Promise<string | null> {
  try {
    const result = await ensureNativeApi().server.signalProcess({
      pid: entry.pid,
      signal,
      expectedCommand: entry.command,
    });
    return result.signaled ? null : (result.message ?? `Could not signal process ${entry.pid}.`);
  } catch (cause) {
    return errorMessage(cause);
  }
}

function ChildProcessesSection() {
  const { data, error, loading, refresh } = useServerRead(readProcessDiagnostics);
  const [signalingPid, setSignalingPid] = useState<number | null>(null);
  const [signalError, setSignalError] = useState<string | null>(null);

  const sendSignal = async (entry: ServerProcessDiagnosticsEntry, signal: ServerProcessSignal) => {
    if (signal === "SIGKILL") {
      const confirmed = await ensureNativeApi().dialogs.confirm(killConfirmationMessage(entry));
      if (!confirmed) return;
    }
    setSignalingPid(entry.pid);
    setSignalError(null);
    await signalProcessEntry(entry, signal)
      .then(setSignalError)
      .finally(() => {
        setSignalingPid(null);
        // Gives the process a moment to exit, so the refreshed list reflects the signal.
        setTimeout(refresh, PROCESS_REFRESH_DELAY_MS);
      });
  };

  return (
    <SettingsSection
      id="diagnostics-processes"
      title="Child processes"
      headerAction={<RefreshButton loading={loading} onClick={refresh} label="Refresh processes" />}
    >
      {error ? <DiagnosticsNotice tone="error">{error}</DiagnosticsNotice> : null}
      {signalError ? <DiagnosticsNotice tone="error">{signalError}</DiagnosticsNotice> : null}
      {!data ? (
        error ? null : (
          <DiagnosticsNotice>Reading the process list...</DiagnosticsNotice>
        )
      ) : (
        <>
          {data.error ? <DiagnosticsNotice tone="error">{data.error}</DiagnosticsNotice> : null}
          {data.truncated ? (
            <DiagnosticsNotice>
              The list hit a size limit, so some processes are missing.
            </DiagnosticsNotice>
          ) : null}
          <div className="grid grid-cols-2 gap-4 border-t border-border px-4 py-4 first:border-t-0 sm:grid-cols-4 sm:px-5">
            <DiagnosticsStat label="Server PID" value={data.serverPid} />
            <DiagnosticsStat label="Processes" value={data.processCount.toLocaleString()} />
            <DiagnosticsStat label="Memory" value={formatDiagnosticsBytes(data.totalRssBytes)} />
            <DiagnosticsStat label="CPU" value={formatDiagnosticsCpu(data.totalCpuPercent)} />
          </div>
          <DiagnosticsTable
            title="Descendants of the server"
            emptyLabel="The server has no child processes right now."
            rows={data.processes}
            rowKey={(entry) => String(entry.pid)}
            columns={[
              { header: "PID", cell: (entry) => entry.pid },
              {
                header: "Command",
                grow: true,
                cell: (entry) => (
                  <span className="block" style={{ paddingLeft: `${entry.depth * 12}px` }}>
                    <TruncatedText text={entry.command} mono />
                  </span>
                ),
              },
              {
                header: "CPU",
                align: "right",
                cell: (entry) => formatDiagnosticsCpu(entry.cpuPercent),
              },
              {
                header: "Memory",
                align: "right",
                cell: (entry) => formatDiagnosticsBytes(entry.rssBytes),
              },
              { header: "Elapsed", align: "right", cell: (entry) => entry.elapsed || "n/a" },
              {
                header: "Signal",
                align: "right",
                width: "w-28",
                cell: (entry) => (
                  <span className="inline-flex justify-end gap-1">
                    {data.supportsInterrupt ? (
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={signalingPid !== null}
                        aria-label={`Interrupt process ${entry.pid}`}
                        title="Send SIGINT"
                        onClick={() => void sendSignal(entry, "SIGINT")}
                      >
                        Stop
                      </Button>
                    ) : null}
                    <Button
                      size="xs"
                      variant="ghost"
                      className="text-destructive"
                      disabled={signalingPid !== null}
                      aria-label={`Force kill process ${entry.pid}`}
                      title="Send SIGKILL"
                      onClick={() => void sendSignal(entry, "SIGKILL")}
                    >
                      Kill
                    </Button>
                  </span>
                ),
              },
            ]}
          />
        </>
      )}
    </SettingsSection>
  );
}

const checkOtlpEndpoint = async (input: OtlpEndpointCheckInput) =>
  ensureNativeApi().server.checkOtlpEndpoint(input);

const STATUS_DOT_CLASS: Record<OtlpEndpointStatus["tone"], string> = {
  muted: "bg-muted-foreground/40",
  pending: "bg-warning",
  success: "bg-success",
  error: "bg-destructive",
};

function OtlpEndpointRow({
  endpoint: { key, label, signal },
  url,
  runningUrl,
}: {
  endpoint: (typeof OTLP_ENDPOINT_ROWS)[number];
  url: string;
  runningUrl: string | undefined;
}) {
  const [check, setCheck] = useState<OtlpEndpointCheck>();
  // Mirrors the input's own draft, so Test acts on what is typed, saved or not.
  const [draft, setDraft] = useState(url);
  const [syncedUrl, setSyncedUrl] = useState(url);
  if (syncedUrl !== url) {
    setSyncedUrl(url);
    setDraft(url);
  }
  const candidate = draft.trim();

  const saveEndpoint = (next: string) => {
    void persistServerSettingsPatch({ observability: { [key]: next } });
  };

  const checkEndpoint = async () => {
    const target = candidate;
    setCheck({ url: target, result: null });
    const result = await checkOtlpEndpoint({ signal, url: target }).catch(
      (cause: unknown) => ({ _tag: "CheckFailed", message: errorMessage(cause) }) as const,
    );
    // A newer check of the field replaces this one.
    setCheck((previous) => (previous?.url === target ? { url: target, result } : previous));
  };

  const status = otlpEndpointStatus(candidate, check);
  const restartNotice = otlpRestartNotice(url, runningUrl);
  return (
    <SettingsRow
      title={`${label} endpoint`}
      description={`Where ${label.toLowerCase()} are exported. Leave empty to turn this export off.`}
      resetAction={
        url !== "" ? (
          <SettingResetButton label={`${label} endpoint`} onClick={() => saveEndpoint("")} />
        ) : null
      }
      status={
        <>
          <span className="flex items-center gap-1.5">
            <span
              aria-hidden
              className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT_CLASS[status.tone])}
            />
            <span className="min-w-0 break-words">{status.label}</span>
          </span>
          {restartNotice ? <span className="mt-1 block break-all">{restartNotice}</span> : null}
        </>
      }
      control={
        <>
          <SettingsDraftInput
            className="sm:w-72"
            ariaLabel={`${label} endpoint`}
            placeholder={`http://localhost:4318/v1/${signal}`}
            value={url}
            validate={validateOtlpEndpointUrl}
            onDraftChange={setDraft}
            onCommit={saveEndpoint}
          />
          <Button
            size="xs"
            variant="outline"
            aria-label={`Test ${label.toLowerCase()} endpoint`}
            disabled={
              !isOtlpEndpointUrl(candidate) || (check?.url === candidate && check.result === null)
            }
            // Keeps focus in the field, so testing a typed URL does not also save it.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => void checkEndpoint()}
          >
            Test
          </Button>
        </>
      }
    />
  );
}

function OtlpEndpointsSection() {
  const saved = useSettings((settings) => settings.observability);
  const running = useServerObservability();

  return (
    <SettingsSection id="diagnostics-otlp" title="OTLP endpoints">
      <DiagnosticsNotice>
        Send traces, metrics and logs to an OTLP HTTP receiver. Endpoints are read at startup, and
        environment variables override them. Test posts an empty export from the server to the URL
        in the field. Authentication headers are only sent to the running endpoint, so a new
        authenticated endpoint can be tested after a restart.
      </DiagnosticsNotice>
      {OTLP_ENDPOINT_ROWS.map((endpoint) => (
        <OtlpEndpointRow
          key={endpoint.key}
          endpoint={endpoint}
          url={saved[endpoint.key]}
          runningUrl={running?.[endpoint.key]}
        />
      ))}
    </SettingsSection>
  );
}

export function DiagnosticsSettingsPanel() {
  return (
    <SettingsPageContainer>
      {/* First because search scrolls to it once, and the tables grow when their reads land. */}
      <OtlpEndpointsSection />
      <TraceSummarySection />
      <ChildProcessesSection />
    </SettingsPageContainer>
  );
}
