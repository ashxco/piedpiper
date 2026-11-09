# Observability

Pied Piper has one server-side observability model:

- pretty logs go to stdout for humans
- completed spans go to a local NDJSON trace file
- traces and metrics can also be exported over OTLP to a real backend like Grafana LGTM

The local trace file is the persisted source of truth. There is no separate persisted server log file anymore.

## Where To Find Things

### Logs

Logs are human-facing only:

- destination: stdout
- format: `Logger.consolePretty()`
- persistence: none

If you want a log message to show up in the trace file, emit it inside an active span with `Effect.log...`. `Logger.tracerLogger` will attach it as a span event.

### Traces

Completed spans are written as NDJSON records to `serverTracePath` (by default, `~/.piedpiper/userdata/logs/server.trace.ndjson`).

Important fields in each record:

- `name`: span name
- `traceId`, `spanId`, `parentSpanId`: correlation
- `durationMs`: elapsed time
- `attributes`: structured context
- `events`: embedded logs and custom events
- `exit`: `Success`, `Failure`, or `Interrupted`

The schema lives in `apps/server/src/observability/TraceRecord.ts`.

The local file clamps attribute strings to 500 characters (`db.query.text` to 200), while OTLP keeps the full values. Records are flushed in batches, so a crash can lose up to one flush window of trace records.

Browser RPC client spans are posted to `POST /api/observability/v1/traces` (Bearer auth) and written to the same trace file, and to the OTLP collector when `PIEDPIPER_OTLP_TRACES_URL` is set. They carry extra `resourceAttributes` and `scope` fields; select them with `.resourceAttributes["service.name"] == "piedpiper-web"`. Their record type lives in `apps/server/src/observability/OtlpTraceRecord.ts`.

#### Summarize the trace file

```bash
piedpiper trace summary --since 30m --limit 40
```

This reads the trace file and its rotated backups directly, so it works while the server is stalled or stopped. It prints counts, per-minute rate, latency percentiles and exits per span name.

It reads `PIEDPIPER_TRACE_FILE` if set, otherwise `<home>/userdata/logs/server.trace.ndjson` for `--base-dir` or `PIEDPIPER_HOME`, plus `PIEDPIPER_TRACE_MAX_FILES` backups. For a dev run or a copied file, set `PIEDPIPER_TRACE_FILE`.

### Metrics

Metrics are not written to a local file.

- local persistence: none
- remote export: OTLP only, when configured
- current definitions: `apps/server/src/observability/Metrics.ts`

If OTLP is not configured, metrics still exist in-process, but you will not have a local artifact to inspect.

### Related Artifacts

Provider event NDJSON files still exist for provider runtime streams. Those are separate from the main server trace file.

## Run The Server In Instrumented Mode

There are two useful modes:

- local-only: stdout + local `server.trace.ndjson`
- full local observability: stdout + local trace file + OTLP export to Grafana/Tempo/Prometheus

The local trace file is always on. OTLP export is opt-in.

### Option 1: Local Traces Only

You do not need any extra env vars. Just run the app normally and inspect `server.trace.ndjson`.

Examples:

```bash
npx piedpiper
```

```bash
bun dev
```

```bash
bun dev:desktop
```

### Option 2: Run With A Local LGTM Stack

#### 1. Start Grafana LGTM

```bash
docker run --name lgtm \
  -p 3000:3000 \
  -p 4317:4317 \
  -p 4318:4318 \
  --rm -ti \
  grafana/otel-lgtm
```

Then open `http://localhost:3000`.

Default Grafana login:

- username: `admin`
- password: `admin`

#### 2. Export OTLP env vars

```bash
export PIEDPIPER_OTLP_TRACES_URL=http://localhost:4318/v1/traces
export PIEDPIPER_OTLP_METRICS_URL=http://localhost:4318/v1/metrics
export PIEDPIPER_OTLP_SERVICE_NAME=piedpiper-local
```

Optional:

```bash
export PIEDPIPER_TRACE_MIN_LEVEL=Info
export PIEDPIPER_TRACE_TIMING_ENABLED=true
```

#### 3. Launch the app from that same shell

CLI:

```bash
npx piedpiper
```

Monorepo web/server dev:

```bash
bun dev
```

Monorepo desktop dev:

```bash
bun dev:desktop
```

Packaged desktop app:

Launch the actual app executable from the same shell so the desktop app and embedded backend inherit `PIEDPIPER_OTLP_*`.

macOS app bundle example:

```bash
PIEDPIPER_OTLP_TRACES_URL=http://localhost:4318/v1/traces \
PIEDPIPER_OTLP_METRICS_URL=http://localhost:4318/v1/metrics \
PIEDPIPER_OTLP_SERVICE_NAME=piedpiper-desktop \
"/Applications/PiedPiper.app/Contents/MacOS/PiedPiper"
```

Direct binary example:

```bash
PIEDPIPER_OTLP_TRACES_URL=http://localhost:4318/v1/traces \
PIEDPIPER_OTLP_METRICS_URL=http://localhost:4318/v1/metrics \
PIEDPIPER_OTLP_SERVICE_NAME=piedpiper-desktop \
./path/to/your/desktop-app-binary
```

Do not rely on launching from Finder, Spotlight, the dock, or the Start menu after setting shell env vars. Those launches usually will not pick them up.

#### 4. Fully restart after changing env

The backend reads observability config at process start. If you change OTLP env vars, stop the app completely and start it again.

### Option 3: Set Endpoints In Settings

Settings > Diagnostics > OTLP endpoints edits the traces, metrics and logs URLs. An empty value turns that export off. Endpoints are read at startup, so a saved change applies after a restart.

Precedence per signal (`resolveOtlpSignal` in `packages/shared/src/otelEnvironment.ts`):

1. If `OTEL_SDK_DISABLED` is set, nothing is exported.
2. `PIEDPIPER_OTLP_*_URL`.
3. `OTEL_*`. An OTEL exporter set to `none` turns the signal off.
4. The desktop bootstrap value.
5. The saved setting.

So "Saved value is not in use" can remain after a restart while an environment variable overrides the setting.

Test posts an empty export from the server to the URL in the field, saved or not, with a 5 second timeout. Redirects are reported as rejected, not followed. Export headers go only to the signal's exact running URL, so a new authenticated endpoint can show "Rejected, HTTP 401" until it is saved and the server restarted.

## How To Use Traces And Metrics To Debug The Server

### Start With The Local Trace File

The trace file is the fastest way to inspect raw span data.

Tail it:

```bash
tail -f "$PIEDPIPER_HOME/userdata/logs/server.trace.ndjson"
```

In monorepo dev, use:

```bash
tail -f ./dev/logs/server.trace.ndjson
```

Show failed spans:

```bash
jq -c 'select(.exit._tag != "Success") | {
  name,
  durationMs,
  exit,
  attributes
}' "$PIEDPIPER_HOME/userdata/logs/server.trace.ndjson"
```

Show slow spans:

```bash
jq -c 'select(.durationMs > 1000) | {
  name,
  durationMs,
  traceId,
  spanId
}' "$PIEDPIPER_HOME/userdata/logs/server.trace.ndjson"
```

Inspect embedded log events:

```bash
jq -c 'select(any(.events[]?; .attributes["effect.logLevel"] != null)) | {
  name,
  durationMs,
  events: [
    .events[]
    | select(.attributes["effect.logLevel"] != null)
    | {
        message: .name,
        level: .attributes["effect.logLevel"]
      }
  ]
}' "$PIEDPIPER_HOME/userdata/logs/server.trace.ndjson"
```

Follow one trace:

```bash
jq -r 'select(.traceId == "TRACE_ID_HERE") | [
  .name,
  .spanId,
  (.parentSpanId // "-"),
  .durationMs
] | @tsv' "$PIEDPIPER_HOME/userdata/logs/server.trace.ndjson"
```

Filter orchestration commands:

```bash
jq -c 'select(.attributes["orchestration.command_type"] != null) | {
  name,
  durationMs,
  commandType: .attributes["orchestration.command_type"],
  aggregateKind: .attributes["orchestration.aggregate_kind"]
}' "$PIEDPIPER_HOME/userdata/logs/server.trace.ndjson"
```

Filter git activity:

```bash
jq -c 'select(.attributes["git.operation"] != null) | {
  name,
  durationMs,
  operation: .attributes["git.operation"],
  cwd: .attributes["git.cwd"],
  hookEvents: [
    .events[]
    | select(.name == "git.hook.started" or .name == "git.hook.finished")
  ]
}' "$PIEDPIPER_HOME/userdata/logs/server.trace.ndjson"
```

### Use Tempo When You Need A Real Trace Viewer

Tempo is better than raw NDJSON when you want to:

- search across many traces
- inspect parent/child relationships visually
- compare many slow traces
- drill into one failing request without hand-joining by `traceId`

Recommended flow in Grafana:

1. Open `Explore`.
2. Pick the `Tempo` data source.
3. Set the time range to something recent like `Last 15 minutes`.
4. Start broad. Do not begin with a very narrow query.
5. Look for spans from your configured service name, then narrow by span name or attributes.

Good first searches:

- service name such as `piedpiper-local`, `piedpiper-dev`, or `piedpiper-desktop`
- span names like `sql.execute`, `git.runCommand`, `provider.sendTurn`
- orchestration spans with attributes like `orchestration.command_type`

Once you know traces are arriving, narrower TraceQL queries like `name = "sql.execute"` become useful.

### Use Metrics To See Systemic Problems

Traces are best for one request. Metrics are best for trends.

Good metric families to watch:

- `piedpiper_rpc_request_duration`
- `piedpiper_orchestration_command_duration`
- `piedpiper_orchestration_command_ack_duration`
- `piedpiper_provider_turn_duration`
- `piedpiper_git_command_duration`
- `piedpiper_db_query_duration`

Counters tell you volume and failure rate:

- `piedpiper_rpc_requests_total`
- `piedpiper_orchestration_commands_total`
- `piedpiper_provider_turns_total`
- `piedpiper_git_commands_total`
- `piedpiper_db_queries_total`

Use metrics when the question is:

- "is this always slow?"
- "did this get worse after a change?"
- "which command type is failing most often?"

Use traces when the question is:

- "what happened in this specific request?"
- "which child span caused this one slow interaction?"
- "what logs were emitted inside the failing flow?"

### What The New Ack Metric Means

`piedpiper_orchestration_command_ack_duration` measures:

- start: command dispatch enters the orchestration engine
- end: the first committed domain event for that command is published by the server

That is a server-side acknowledgment metric. It does not measure:

- websocket transit to the browser
- client receipt
- React render time

If you need those later, add client-side instrumentation or a dedicated server fanout metric.

## Common Workflows

### "Why did this request fail?"

1. Start with the local NDJSON file.
2. Find spans where `exit._tag != "Success"`.
3. Group by `traceId`.
4. Inspect sibling spans and span events.
5. If needed, move to Tempo for the full trace tree.

### "Why is the UI feeling slow?"

1. Search for slow top-level spans in the trace file or Tempo.
2. Check child spans for sqlite, git, provider, or terminal work.
3. Look at the matching duration metrics to see whether the slowness is systemic.

### "Did this command take too long to acknowledge?"

1. Check `piedpiper_orchestration_command_ack_duration` by `commandType`.
2. If it is high, inspect the corresponding orchestration trace.
3. Look at child spans for projection, sqlite, provider, or git work.

### "Are git hooks causing latency?"

1. Filter `git.operation` spans.
2. Inspect `git.hook.started` and `git.hook.finished` events.
3. Compare hook timing to the enclosing git span duration.

### "Did the event loop stall?"

The server samples event-loop health every 30 s and discards the first sample, which covers startup work. When the loop was blocked for more than 2 s, it records a warn-level root span `server.eventLoop.stall` in the local trace file (no OTLP needed).

1. Filter spans named `server.eventLoop.stall`.
2. Read its attributes: `delayMaxMs`, `utilization`, `cpuUserMs`, `cpuSystemMs`, `majorPageFaults`, `minorPageFaults`, `involuntaryContextSwitches` and `rssMb`.

A stall of 5 s or more seen in the last 5 minutes is also reported to clients as `lastEventLoopStall` in the server config, sampled again on each connect. The web app shows one warning toast per `detectedAt`.

### "Where is memory going?"

1. Run `kill -USR2 <server pid>`. The server writes a V8 heap snapshot named `server-<pid>-<timestamp>.heapsnapshot` into the logs directory (`logsDir`).
2. Open it in Chrome DevTools > Memory.

Writing the snapshot blocks the event loop while it runs. Snapshots are large and can contain secrets (tokens, prompts, file contents), so do not share them casually. The SIGUSR2 handler does nothing on Windows.

### "Why do I have spans locally but nothing in Grafana?"

Usually one of these is true:

- `PIEDPIPER_OTLP_TRACES_URL` was not set
- the app was launched from a different environment than the one where you exported the vars
- the app was not fully restarted after changing env
- Grafana is looking at the wrong time range or service name

If the local NDJSON file is updating, local tracing is working. The problem is almost always OTLP export configuration or process startup.

## How To Think About Adding Tracing To Future Code

### Prefer Boundaries Over Tiny Helpers

Good span boundaries:

- RPC methods
- orchestration command handling
- provider adapter calls
- external process calls
- persistence writes
- queue handoffs

Avoid tracing every tiny helper. Most helpers should inherit the active span rather than create a new one.

### Reuse `Effect.fn(...)` Where It Already Exists

The codebase already uses `Effect.fn("name")` heavily. That should usually be your first tracing boundary.

For ad hoc work:

```ts
import { Effect } from "effect";

const runThing = Effect.gen(function* () {
  yield* Effect.annotateCurrentSpan({
    "thing.id": "abc123",
    "thing.kind": "example",
  });

  yield* Effect.logInfo("starting thing");
  return yield* doWork();
}).pipe(Effect.withSpan("thing.run"));
```

### Put High-Cardinality Detail On Spans

Use span annotations for IDs, paths, and other detailed context:

```ts
yield *
  Effect.annotateCurrentSpan({
    "provider.thread_id": input.threadId,
    "provider.request_id": input.requestId,
    "git.cwd": input.cwd,
  });
```

### Keep Metric Labels Low Cardinality

Good metric labels:

- operation kind
- method name
- provider kind
- aggregate kind
- outcome

Bad metric labels:

- raw thread IDs
- command IDs
- file paths
- cwd
- full prompts
- full model strings when a normalized family label would do

Detailed context belongs on spans, not metrics.

### Use Logs As Span Events

Logs inside a span become part of the trace story:

```ts
yield * Effect.logInfo("starting provider turn");
yield * Effect.logDebug("waiting for approval response");
```

Those messages show up as span events because `Logger.tracerLogger` is installed.

### Use The Pipeable Metrics API

`withMetrics(...)` is the default way to attach a counter and timer to an effect:

```ts
import { someCounter, someDuration, withMetrics } from "../observability/Metrics.ts";

const program = doWork().pipe(
  withMetrics({
    counter: someCounter,
    timer: someDuration,
    attributes: {
      operation: "work",
    },
  }),
);
```

## Detailed API Reference

### Runtime Wiring

The server observability layer is assembled in `apps/server/src/observability/Layers/Observability.ts`.

It provides:

- pretty stdout logger
- `Logger.tracerLogger`
- local NDJSON tracer
- optional OTLP trace exporter
- optional OTLP metrics exporter
- Effect trace-level and timing refs

### Env Vars

Local trace file:

- `PIEDPIPER_TRACE_FILE`: override trace file path
- `PIEDPIPER_TRACE_MAX_BYTES`: per-file rotation size, default `10485760`
- `PIEDPIPER_TRACE_MAX_FILES`: rotated file count, default `10`
- `PIEDPIPER_TRACE_BATCH_WINDOW_MS`: flush window, default `1000`. A batch also flushes at 256 records.
- `PIEDPIPER_TRACE_MIN_LEVEL`: minimum trace level, default `Info`
- `PIEDPIPER_TRACE_TIMING_ENABLED`: enable timing metadata, default `true`

OTLP export (these can also be set in Settings; see [Option 3](#option-3-set-endpoints-in-settings)):

- `PIEDPIPER_OTLP_TRACES_URL`: OTLP trace endpoint
- `PIEDPIPER_OTLP_METRICS_URL`: OTLP metric endpoint
- `PIEDPIPER_OTLP_EXPORT_INTERVAL_MS`: export interval, default `10000`
- `PIEDPIPER_OTLP_SERVICE_NAME`: service name, default `piedpiper-server`

If the OTLP URLs are unset, local tracing still works and metrics stay in-process only.

Every OTLP resource carries `service.instance.id`, random per server process; a value in `OTEL_RESOURCE_ATTRIBUTES` replaces it. The server also reports `process.runtime.name`, `process.runtime.version` and `process.runtime.description`.

Product analytics:

- `PIEDPIPER_POSTHOG_KEY`: PostHog project key, default empty. Analytics are a no-op with no network traffic unless this is set
- `PIEDPIPER_POSTHOG_HOST`: PostHog host, default `https://us.i.posthog.com`
- `PIEDPIPER_TELEMETRY_ENABLED`: when a key is set, set this to `false` in the server environment to opt out, default `true` for packaged and direct server runs. `scripts/dev-runner.ts` forces it to `false` unless it is already set in the environment

`turbo.json` lets these variables through strict mode, so exporting them also reaches runs started through turbo. Events are tagged with a hashed identifier rather than a raw account id.

On macOS and Linux the desktop app also reads `PIEDPIPER_TELEMETRY_ENABLED` from your login shell profile (for example `~/.zshrc`), so exporting it there and restarting the app also covers launches from Finder or the Dock. On Windows, set it as a user environment variable. The desktop app does not read `PIEDPIPER_POSTHOG_KEY` from the login shell, so a key exported in `~/.zshrc` does not reach launches from Finder or the Dock, and packaged builds have analytics off.

### What Is Instrumented Today

Current high-value span and metric boundaries include:

- Effect RPC websocket request spans from `effect/rpc`
- RPC request metrics in `apps/server/src/observability/RpcInstrumentation.ts`
- startup phases
- orchestration command processing
- orchestration command acknowledgment latency
- provider session and turn operations
- git command execution and git hook events
- terminal session lifecycle
- sqlite query execution

### Current Constraints

- logs outside spans are not persisted
- metrics are not snapshotted locally
- the old `serverLogPath` still exists in config for compatibility, but the trace file is the persisted artifact that matters
