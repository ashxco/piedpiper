import type {
  OtlpEndpointCheckInput,
  OtlpEndpointCheckResult,
  OtlpSignal,
} from "@piedpiper/contracts";
import { Clock, Effect, Option } from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { OtlpSerialization } from "effect/unstable/observability";

import type { ServerConfigShape } from "../config.ts";
import { otlpSerializationLayer } from "../otlpExport.ts";

const CHECK_TIMEOUT_MS = 5_000;

export type OtlpEndpointCheckConfig = Pick<
  ServerConfigShape,
  "otlpTracesUrl" | "otlpMetricsUrl" | "otlpLogsUrl" | "otlpExportOptions"
>;

const runningUrl = (config: OtlpEndpointCheckConfig, signal: OtlpSignal) => {
  switch (signal) {
    case "traces":
      return config.otlpTracesUrl;
    case "metrics":
      return config.otlpMetricsUrl;
    case "logs":
      return config.otlpLogsUrl;
  }
};

const emptyExport = (signal: OtlpSignal) =>
  Effect.map(OtlpSerialization.OtlpSerialization.asEffect(), (serialization) => {
    switch (signal) {
      case "traces":
        return serialization.traces({ resourceSpans: [] });
      case "metrics":
        return serialization.metrics({ resourceMetrics: [] });
      case "logs":
        return serialization.logs({ resourceLogs: [] });
    }
  });

const isHttpUrl = (url: string): boolean => {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
};

/**
 * Posts an empty export for the signal to `url` with the signal's running protocol. Receivers
 * accept it without storing anything. Export headers go only to the signal's exact running URL,
 * because they can hold API keys, and a redirect is reported rather than followed.
 */
export const checkOtlpEndpoint = Effect.fn("diagnostics.checkOtlpEndpoint")(function* (
  { signal, url }: OtlpEndpointCheckInput,
  config: OtlpEndpointCheckConfig,
  options?: { readonly timeoutMs?: number },
) {
  if (!isHttpUrl(url)) {
    return { _tag: "Unreachable", timedOut: false } satisfies OtlpEndpointCheckResult;
  }
  const exportOptions = config.otlpExportOptions[signal];
  const headers = url === runningUrl(config, signal) ? exportOptions.headers : undefined;
  const body = yield* emptyExport(signal).pipe(
    Effect.provide(otlpSerializationLayer(exportOptions.protocol)),
  );
  const startedAt = yield* Clock.currentTimeMillis;
  const client = HttpClient.withScope(yield* HttpClient.HttpClient);
  // Only the status matters, and closing the scope aborts a body the receiver holds open.
  // Tracing stays off because request spans record the URL and custom headers.
  const response = yield* client.post(url, { body, ...(headers ? { headers } : {}) }).pipe(
    Effect.map(({ status }) => status),
    Effect.scoped,
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
    Effect.withTracerEnabled(false),
    Effect.provideService(HttpClient.TracerPropagationEnabled, false),
    Effect.timeoutOption(`${options?.timeoutMs ?? CHECK_TIMEOUT_MS} millis`),
    Effect.option,
  );
  if (Option.isNone(response)) {
    return { _tag: "Unreachable", timedOut: false } satisfies OtlpEndpointCheckResult;
  }
  if (Option.isNone(response.value)) {
    return { _tag: "Unreachable", timedOut: true } satisfies OtlpEndpointCheckResult;
  }
  const status = response.value.value;
  if (status < 200 || status >= 300) {
    return { _tag: "Rejected", status } satisfies OtlpEndpointCheckResult;
  }
  const finishedAt = yield* Clock.currentTimeMillis;
  return { _tag: "Accepted", latencyMs: finishedAt - startedAt } satisfies OtlpEndpointCheckResult;
}, Effect.provide(FetchHttpClient.layer));
