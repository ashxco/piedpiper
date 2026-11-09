import type { OtlpProtocol } from "@piedpiper/shared/otelEnvironment";
import { Layer, Logger } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { OtlpLogger, OtlpSerialization } from "effect/unstable/observability";

import { otlpResource, type ServerConfigShape } from "./config";

/** The wire format layer for one signal's configured protocol. */
export const otlpSerializationLayer = (protocol: OtlpProtocol) =>
  protocol === "http/protobuf" ? OtlpSerialization.layerProtobuf : OtlpSerialization.layerJson;

/**
 * The server's logger set. With an OTLP logs URL, log records go to the collector stamped with
 * trace and span ids. That covers every in-span message too, so `Logger.tracerLogger` (which only
 * copies in-span messages onto spans as events) is left out to avoid exporting them twice.
 */
export const makeServerLoggerLayer = (
  config: Pick<
    ServerConfigShape,
    "otlpLogsUrl" | "otlpExportOptions" | "otlpExportIntervalMs" | "otlpServiceName" | "mode"
  >,
  consoleLogger: Logger.Logger<unknown, void>,
): Layer.Layer<never> => {
  if (config.otlpLogsUrl === undefined) {
    return Logger.layer([consoleLogger, Logger.tracerLogger], { mergeWithExisting: false });
  }
  const options = config.otlpExportOptions.logs;
  return Logger.layer(
    [
      consoleLogger,
      OtlpLogger.make({
        url: config.otlpLogsUrl,
        exportInterval: `${config.otlpExportIntervalMs} millis`,
        ...(options.headers ? { headers: options.headers } : {}),
        resource: otlpResource(config),
      }),
    ],
    { mergeWithExisting: false },
  ).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(otlpSerializationLayer(options.protocol)),
  );
};
