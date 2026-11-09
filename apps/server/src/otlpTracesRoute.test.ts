// @effect-diagnostics nodeBuiltinImport:off -- the trace file is read back after the layer closes.
import * as NodeFS from "node:fs";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, type LogLevel } from "effect";
import { FetchHttpClient, HttpBody, HttpClient, HttpRouter } from "effect/unstable/http";

import { ServerConfig } from "./config.ts";
import { otlpTracesRouteLayer } from "./http.ts";
import { ObservabilityLive } from "./observability/Layers/Observability.ts";

const payload = JSON.stringify({
  resourceSpans: [
    {
      scopeSpans: [
        {
          scope: { name: "piedpiper-web" },
          spans: [
            {
              traceId: "browser-trace",
              spanId: "browser-span",
              name: "RpcClient.server.getConfig",
              startTimeUnixNano: "1000000000",
              endTimeUnixNano: "2000000000",
            },
          ],
        },
      ],
    },
  ],
});

/** The real route on the real ObservabilityLive; the file is flushed when the layer closes. */
const postThroughRealObservability = Effect.fn("postThroughRealObservability")(function* (
  traceMinLevel: LogLevel.LogLevel,
) {
  const fs = yield* FileSystem.FileSystem;
  const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "piedpiper-otlp-route-" });
  const configLayer = Layer.effect(
    ServerConfig,
    Effect.map(ServerConfig.asEffect(), (config) => ({
      ...config,
      traceMinLevel,
    })),
  ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)));
  const tracePath = yield* Effect.map(
    ServerConfig.asEffect(),
    (config) => config.serverTracePath,
  ).pipe(Effect.provide(configLayer));

  const status = yield* Effect.scoped(
    Effect.gen(function* () {
      yield* Layer.build(
        HttpRouter.serve(otlpTracesRouteLayer, {
          disableListenLog: true,
          disableLogger: true,
        }).pipe(
          Layer.provide(ObservabilityLive),
          Layer.provide(FetchHttpClient.layer),
          Layer.provide(configLayer),
        ),
      );
      const response = yield* HttpClient.post("/api/observability/v1/traces", {
        body: HttpBody.text(payload, "application/json"),
      });
      return response.status;
    }),
  );
  const contents = NodeFS.existsSync(tracePath) ? NodeFS.readFileSync(tracePath, "utf8") : "";
  return { status, contents };
});

it.layer(NodeServices.layer)("browser trace route with ObservabilityLive", (it) => {
  it.effect("writes a posted span to the server trace file", () =>
    Effect.gen(function* () {
      const { status, contents } = yield* postThroughRealObservability("Info");
      assert.equal(status, 204);
      assert.include(contents, "browser-span");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("writes nothing when PIEDPIPER_TRACE_MIN_LEVEL silences tracing", () =>
    Effect.gen(function* () {
      const { status, contents } = yield* postThroughRealObservability("None");
      assert.equal(status, 204);
      assert.notInclude(contents, "browser-span");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );
});
