import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";

import { assert, it } from "@effect/vitest";
import { Effect, Logger } from "effect";
import { OtlpSerialization } from "effect/unstable/observability";

import { DEFAULT_OTLP_EXPORT_OPTIONS_BY_SIGNAL } from "./config.ts";
import { makeServerLoggerLayer, otlpSerializationLayer } from "./otlpExport.ts";

const baseConfig = {
  otlpLogsUrl: undefined,
  otlpExportOptions: DEFAULT_OTLP_EXPORT_OPTIONS_BY_SIGNAL,
  otlpExportIntervalMs: 60_000,
  otlpServiceName: "piedpiper-server",
  mode: "web",
} as const;

const currentLoggers = (layer: ReturnType<typeof makeServerLoggerLayer>) =>
  Effect.gen(function* () {
    return yield* Logger.CurrentLoggers;
  }).pipe(Effect.provide(layer), Effect.scoped);

it.effect("keeps span-event logging when no OTLP logs URL is set", () =>
  Effect.gen(function* () {
    const consoleLogger = Logger.make(() => undefined);
    const loggers = yield* currentLoggers(makeServerLoggerLayer(baseConfig, consoleLogger));
    assert.deepStrictEqual([...loggers], [consoleLogger, Logger.tracerLogger]);
  }),
);

it.effect("swaps span-event logging for the OTLP logger when a logs URL is set", () =>
  Effect.gen(function* () {
    const consoleLogger = Logger.make(() => undefined);
    const loggers = yield* currentLoggers(
      makeServerLoggerLayer(
        { ...baseConfig, otlpLogsUrl: "http://127.0.0.1:1/v1/logs" },
        consoleLogger,
      ),
    );
    assert.equal(loggers.size, 2);
    assert.isTrue(loggers.has(consoleLogger));
    assert.isFalse(loggers.has(Logger.tracerLogger));
  }),
);

it("picks the serialization layer for each protocol", () => {
  assert.strictEqual(otlpSerializationLayer("http/protobuf"), OtlpSerialization.layerProtobuf);
  assert.strictEqual(otlpSerializationLayer("http/json"), OtlpSerialization.layerJson);
});

interface CollectedRequest {
  readonly url: string | undefined;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
}

/** A local collector that records every request; closed when the scope ends. */
const fakeCollector = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<{
        readonly port: number;
        readonly requests: CollectedRequest[];
        close: () => void;
      }>((resolve) => {
        const requests: CollectedRequest[] = [];
        const server = createServer((request, response) => {
          const chunks: Buffer[] = [];
          request.on("data", (chunk: Buffer) => chunks.push(chunk));
          request.on("end", () => {
            requests.push({
              url: request.url,
              headers: request.headers,
              body: Buffer.concat(chunks),
            });
            response.writeHead(200, { "content-type": "application/json" }).end("{}");
          });
        });
        server.listen(0, "127.0.0.1", () =>
          resolve({
            port: (server.address() as AddressInfo).port,
            requests,
            close: () => server.close(),
          }),
        );
      }),
  ),
  (collector) => Effect.sync(() => collector.close()),
);

const exportOneLog = (port: number, protocol: "http/json" | "http/protobuf") =>
  Effect.logInfo("hello collector").pipe(
    Effect.provide(
      makeServerLoggerLayer(
        {
          ...baseConfig,
          otlpLogsUrl: `http://127.0.0.1:${port}/v1/logs`,
          otlpExportOptions: {
            ...DEFAULT_OTLP_EXPORT_OPTIONS_BY_SIGNAL,
            logs: { protocol, headers: { "x-api-key": "test-key" } },
          },
        },
        Logger.make(() => undefined),
      ),
    ),
  );

it.live("exports log records to the collector with the configured headers", () =>
  Effect.gen(function* () {
    const collector = yield* fakeCollector;
    yield* exportOneLog(collector.port, "http/json");

    assert.equal(collector.requests.length, 1);
    const [request] = collector.requests;
    assert.equal(request?.url, "/v1/logs");
    assert.equal(request?.headers["x-api-key"], "test-key");
    assert.include(String(request?.headers["content-type"]), "json");
    const body = JSON.parse(request!.body.toString("utf8"));
    const resourceLogs = body.resourceLogs[0];
    const serviceName = resourceLogs.resource.attributes.find(
      (attribute: { key: string }) => attribute.key === "service.name",
    );
    assert.equal(serviceName?.value.stringValue, "piedpiper-server");
    assert.equal(resourceLogs.scopeLogs[0].logRecords[0].body.stringValue, "hello collector");
  }).pipe(Effect.scoped),
);

it.live("exports log records as protobuf when that protocol is configured", () =>
  Effect.gen(function* () {
    const collector = yield* fakeCollector;
    yield* exportOneLog(collector.port, "http/protobuf");

    assert.equal(collector.requests.length, 1);
    const [request] = collector.requests;
    assert.equal(request?.headers["content-type"], "application/x-protobuf");
    assert.include(request!.body.toString("latin1"), "hello collector");
  }).pipe(Effect.scoped),
);
