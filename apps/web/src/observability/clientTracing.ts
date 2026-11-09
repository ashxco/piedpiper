import { Effect, Exit, Layer, ManagedRuntime, Scope, Tracer } from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { OtlpSerialization, OtlpTracer } from "effect/unstable/observability";

import { APP_VERSION } from "../branding";
import { isElectron } from "../env";
import { resolveServerUrl } from "../lib/utils";
import { resolveAuthToken } from "../rpc/authToken";

const OTLP_TRACES_PATH = "/api/observability/v1/traces";
const DEFAULT_EXPORT_INTERVAL_MS = 1_000;

// The exporter's own requests must not create spans or carry trace headers.
const exporterLayer = Layer.mergeAll(
  FetchHttpClient.layer,
  OtlpSerialization.layerJson,
  Layer.succeed(HttpClient.TracerDisabledWhen, () => true),
);

let activeDelegate: Tracer.Tracer | null = null;
let disposeActiveExporter: (() => Promise<void>) | null = null;

function resolveTracesUrl(): string {
  const url = new URL(
    resolveServerUrl({
      protocol: window.location.protocol === "https:" ? "https" : "http",
      pathname: OTLP_TRACES_PATH,
    }),
  );
  // The desktop bridge URL carries the token; on this route it only goes in the header.
  url.search = "";
  return url.toString();
}

export interface ClientTracingConfig {
  readonly exportIntervalMs?: number;
}

/**
 * Starts exporting client spans to the server's local trace file. Safe to call repeatedly: it
 * does nothing once an exporter runs. Tracing is optional, so a failure leaves spans unexported
 * and the next call tries again; export failures stay quiet because the exporter backs off.
 */
export function configureClientTracing(config: ClientTracingConfig = {}): void {
  if (activeDelegate !== null) return;

  const runtime = ManagedRuntime.make(exporterLayer);
  try {
    const authToken = resolveAuthToken();
    const scope = runtime.runSync(Scope.make());
    // Synchronous so that the first RPC of the page already has an exporter behind it.
    activeDelegate = runtime.runSync(
      Scope.provide(scope)(
        OtlpTracer.make({
          url: resolveTracesUrl(),
          exportInterval: `${config.exportIntervalMs ?? DEFAULT_EXPORT_INTERVAL_MS} millis`,
          ...(authToken ? { headers: { authorization: `Bearer ${authToken}` } } : {}),
          resource: {
            serviceName: "piedpiper-web",
            serviceVersion: APP_VERSION,
            attributes: {
              "service.runtime": "piedpiper-web",
              "service.mode": isElectron ? "electron" : "browser",
            },
          },
        }),
      ),
    );
    disposeActiveExporter = () =>
      runtime
        .runPromise(Scope.close(scope, Exit.void))
        .catch(() => undefined)
        .finally(() => runtime.dispose());
  } catch {
    activeDelegate = null;
    void runtime.dispose();
  }
}

const delegatingTracer = Tracer.make({
  span(options) {
    return activeDelegate?.span(options) ?? new Tracer.NativeSpan(options);
  },
});

/**
 * Sends a runtime's spans to the client exporter. The tracer is installed once and looks up the
 * exporter per span, so several runtimes share one exporter and pick up one configured later.
 */
export const ClientTracingLive = Layer.effect(
  Tracer.Tracer,
  Effect.sync(() => {
    configureClientTracing();
    return delegatingTracer;
  }),
);

export async function __resetClientTracingForTests(): Promise<void> {
  const dispose = disposeActiveExporter;
  activeDelegate = null;
  disposeActiveExporter = null;
  await dispose?.();
}
