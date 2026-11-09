import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

import { ServerConfig } from "../../config.ts";
import { decodeOtlpTraceRecords } from "../OtlpTraceRecord.ts";
import { BrowserTraceCollector } from "../Services/BrowserTraceCollector.ts";
import { ObservabilityLive } from "./Observability.ts";

const browserRecords = Option.getOrThrow(
  decodeOtlpTraceRecords({
    resourceSpans: [
      {
        resource: { attributes: [] },
        scopeSpans: [
          {
            scope: { name: "piedpiper-web" },
            spans: [
              {
                traceId: "browser-trace",
                spanId: "browser-span",
                name: "RpcClient.server.getConfig",
                startTimeUnixNano: "1000000000",
                endTimeUnixNano: "1500000000",
              },
            ],
          },
        ],
      },
    ],
  }),
);

describe("ObservabilityLive", () => {
  it.effect("writes server and browser spans to the same trace file", () =>
    Effect.gen(function* () {
      const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "piedpiper-observability-"));
      const testLayer = ObservabilityLive.pipe(
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
        Layer.provide(FetchHttpClient.layer),
      );

      try {
        // The layer closes here, and its finalizer flushes the shared sink.
        const tracePath = yield* Effect.gen(function* () {
          const config = yield* ServerConfig;
          const collector = yield* BrowserTraceCollector;
          yield* collector.record(browserRecords);
          yield* Effect.void.pipe(Effect.withSpan("server-span"));
          return config.serverTracePath;
        }).pipe(Effect.provide(testLayer));

        const names = fs
          .readFileSync(tracePath, "utf8")
          .trim()
          .split("\n")
          .map((line) => (JSON.parse(line) as { readonly name: string }).name);
        assert.include(names, "server-span");
        assert.include(names, "RpcClient.server.getConfig");
      } finally {
        fs.rmSync(baseDir, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
