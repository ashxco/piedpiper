import { Effect, Layer, References, Tracer } from "effect";
import { OtlpMetrics, OtlpTracer } from "effect/unstable/observability";

import { otlpResource, ServerConfig } from "../../config.ts";
import { otlpSerializationLayer } from "../../otlpExport.ts";
import { ServerLoggerLive } from "../../serverLogger.ts";
import { makeLocalFileTracer } from "../LocalFileTracer.ts";
import { browserTraceCollectorLayer } from "../Services/BrowserTraceCollector.ts";
import { makeTraceSink } from "../TraceSink.ts";

export const ObservabilityLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;

    const traceReferencesLayer = Layer.mergeAll(
      Layer.succeed(Tracer.MinimumTraceLevel, config.traceMinLevel),
      Layer.succeed(References.TracerTimingEnabled, config.traceTimingEnabled),
    );

    const tracerLayer = Layer.unwrap(
      Effect.gen(function* () {
        const sink = yield* makeTraceSink({
          filePath: config.serverTracePath,
          maxBytes: config.traceMaxBytes,
          maxFiles: config.traceMaxFiles,
          batchWindowMs: config.traceBatchWindowMs,
        });

        const delegate =
          config.otlpTracesUrl === undefined
            ? undefined
            : yield* OtlpTracer.make({
                url: config.otlpTracesUrl,
                exportInterval: `${config.otlpExportIntervalMs} millis`,
                ...(config.otlpExportOptions.traces.headers
                  ? { headers: config.otlpExportOptions.traces.headers }
                  : {}),
                resource: otlpResource(config),
              });

        const tracer = yield* makeLocalFileTracer({
          filePath: config.serverTracePath,
          maxBytes: config.traceMaxBytes,
          maxFiles: config.traceMaxFiles,
          batchWindowMs: config.traceBatchWindowMs,
          sink,
          ...(delegate ? { delegate } : {}),
        });

        return Layer.mergeAll(
          Layer.succeed(Tracer.Tracer, tracer),
          browserTraceCollectorLayer(sink),
        );
      }),
    ).pipe(Layer.provideMerge(otlpSerializationLayer(config.otlpExportOptions.traces.protocol)));

    const metricsLayer =
      config.otlpMetricsUrl === undefined
        ? Layer.empty
        : OtlpMetrics.layer({
            url: config.otlpMetricsUrl,
            exportInterval: `${config.otlpExportIntervalMs} millis`,
            ...(config.otlpExportOptions.metrics.headers
              ? { headers: config.otlpExportOptions.metrics.headers }
              : {}),
            resource: otlpResource(config),
          }).pipe(
            Layer.provideMerge(otlpSerializationLayer(config.otlpExportOptions.metrics.protocol)),
          );

    return Layer.mergeAll(ServerLoggerLive, traceReferencesLayer, tracerLayer, metricsLayer);
  }),
);
