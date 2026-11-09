import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { OtlpEndpointCheckInput } from "@piedpiper/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Schema, Tracer } from "effect";

import { DEFAULT_OTLP_EXPORT_OPTIONS_BY_SIGNAL } from "../config.ts";
import { checkOtlpEndpoint, type OtlpEndpointCheckConfig } from "./OtlpEndpointCheck.ts";

interface Received {
  readonly path: string | undefined;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

const noRunningEndpoints: OtlpEndpointCheckConfig = {
  otlpTracesUrl: undefined,
  otlpMetricsUrl: undefined,
  otlpLogsUrl: undefined,
  otlpExportOptions: DEFAULT_OTLP_EXPORT_OPTIONS_BY_SIGNAL,
};

const withHeaders = (signal: "traces" | "metrics" | "logs") => ({
  ...DEFAULT_OTLP_EXPORT_OPTIONS_BY_SIGNAL,
  [signal]: { protocol: "http/json", headers: { "x-api-key": "secret" } },
});

/** A receiver answering each request with `respond`, recording what it was sent. */
const receiver = (respond: (path: string | undefined) => { status: number; location?: string }) =>
  Effect.acquireRelease(
    Effect.callback<{ server: Server; url: string; received: Received[] }>((resume) => {
      const received: Received[] = [];
      const server = createServer((request, response) => {
        let body = "";
        request.on("data", (chunk) => (body += String(chunk)));
        request.on("end", () => {
          received.push({ path: request.url, headers: request.headers, body });
          const { status, location } = respond(request.url);
          response.writeHead(status, location ? { location } : {}).end();
        });
      });
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as AddressInfo;
        resume(Effect.succeed({ server, url: `http://127.0.0.1:${port}`, received }));
      });
    }),
    ({ server }) =>
      Effect.callback<void>((resume) => {
        server.closeAllConnections();
        server.close(() => resume(Effect.void));
      }),
  );

describe("checkOtlpEndpoint", () => {
  it.effect("posts an empty export for each signal", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { url, received } = yield* receiver(() => ({ status: 200 }));
        for (const signal of ["traces", "metrics", "logs"] as const) {
          const result = yield* checkOtlpEndpoint(
            { signal, url: `${url}/v1/${signal}` },
            noRunningEndpoints,
          );
          assert.strictEqual(result._tag, "Accepted");
        }
        assert.deepStrictEqual(
          received.map(({ path, body }) => [path, body]),
          [
            ["/v1/traces", `{"resourceSpans":[]}`],
            ["/v1/metrics", `{"resourceMetrics":[]}`],
            ["/v1/logs", `{"resourceLogs":[]}`],
          ],
        );
      }),
    ),
  );

  it.effect("sends the export headers only to the signal's exact running URL", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { url, received } = yield* receiver(() => ({ status: 200 }));
        const running = `${url}/v1/traces`;
        const config: OtlpEndpointCheckConfig = {
          ...noRunningEndpoints,
          otlpTracesUrl: running,
          otlpExportOptions: withHeaders("traces"),
        };

        yield* checkOtlpEndpoint({ signal: "traces", url: running }, config);
        yield* checkOtlpEndpoint({ signal: "traces", url: `${running}/other` }, config);
        yield* checkOtlpEndpoint({ signal: "traces", url: `${running}?tenant=other` }, config);
        yield* checkOtlpEndpoint({ signal: "logs", url: running }, config);

        assert.deepStrictEqual(
          received.map(({ headers }) => headers["x-api-key"]),
          ["secret", undefined, undefined, undefined],
        );
      }),
    ),
  );

  it.effect("sends no headers when the signal has no running endpoint", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { url, received } = yield* receiver(() => ({ status: 200 }));
        yield* checkOtlpEndpoint(
          { signal: "logs", url: `${url}/v1/logs` },
          { ...noRunningEndpoints, otlpExportOptions: withHeaders("logs") },
        );
        assert.isUndefined(received[0]?.headers["x-api-key"]);
      }),
    ),
  );

  it.effect("reports a redirect as rejected and does not forward the headers", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { url, received } = yield* receiver((path) =>
          path === "/v1/traces" ? { status: 307, location: "/other" } : { status: 200 },
        );
        const running = `${url}/v1/traces`;
        const result = yield* checkOtlpEndpoint(
          { signal: "traces", url: running },
          {
            ...noRunningEndpoints,
            otlpTracesUrl: running,
            otlpExportOptions: withHeaders("traces"),
          },
        );
        assert.deepStrictEqual(result, { _tag: "Rejected", status: 307 });
        assert.deepStrictEqual(
          received.map(({ path }) => path),
          ["/v1/traces"],
        );
      }),
    ),
  );

  it.effect("reports the status a receiver rejects the export with", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { url } = yield* receiver(() => ({ status: 401 }));
        const result = yield* checkOtlpEndpoint(
          { signal: "metrics", url: `${url}/v1/metrics` },
          noRunningEndpoints,
        );
        assert.deepStrictEqual(result, { _tag: "Rejected", status: 401 });
      }),
    ),
  );

  it.effect("reports an endpoint that refuses the connection", () =>
    Effect.gen(function* () {
      const result = yield* checkOtlpEndpoint(
        { signal: "logs", url: "http://127.0.0.1:1/v1/logs" },
        noRunningEndpoints,
      );
      assert.deepStrictEqual(result, { _tag: "Unreachable", timedOut: false });
    }),
  );

  it.live("reports an endpoint that never answers as timed out", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { server, url } = yield* Effect.acquireRelease(
          Effect.callback<{ server: Server; url: string }>((resume) => {
            const silent = createServer(() => {});
            silent.listen(0, "127.0.0.1", () => {
              const { port } = silent.address() as AddressInfo;
              resume(Effect.succeed({ server: silent, url: `http://127.0.0.1:${port}` }));
            });
          }),
          ({ server }) =>
            Effect.callback<void>((resume) => {
              server.closeAllConnections();
              server.close(() => resume(Effect.void));
            }),
        );
        assert.isTrue(server.listening);
        const result = yield* checkOtlpEndpoint(
          { signal: "traces", url: `${url}/v1/traces` },
          noRunningEndpoints,
          { timeoutMs: 50 },
        );
        assert.deepStrictEqual(result, { _tag: "Unreachable", timedOut: true });
      }),
    ),
  );

  it.live("releases the request once the status is known", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const released = yield* Deferred.make<void>();
        const { url } = yield* Effect.acquireRelease(
          Effect.callback<{ server: Server; url: string }>((resume) => {
            const holding = createServer((_request, response) => {
              // Headers go out, but the body stays open until the client hangs up.
              response.on("close", () => Deferred.doneUnsafe(released, Effect.void));
              response.writeHead(200);
              response.flushHeaders();
            });
            holding.listen(0, "127.0.0.1", () => {
              const { port } = holding.address() as AddressInfo;
              resume(Effect.succeed({ server: holding, url: `http://127.0.0.1:${port}` }));
            });
          }),
          ({ server }) =>
            Effect.callback<void>((resume) => {
              server.closeAllConnections();
              server.close(() => resume(Effect.void));
            }),
        );
        const result = yield* checkOtlpEndpoint(
          { signal: "traces", url: `${url}/v1/traces` },
          noRunningEndpoints,
          { timeoutMs: 2_000 },
        );
        assert.strictEqual(result._tag, "Accepted");
        yield* Deferred.await(released).pipe(Effect.timeout("1 second"));
      }),
    ),
  );

  it.effect("keeps the URL and headers out of spans", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { url, received } = yield* receiver(() => ({ status: 200 }));
        const running = `${url}/v1/logs?api_key=query-secret`;
        const recorded: unknown[] = [];
        const tracer = Tracer.make({
          span: (options) => {
            const span = new Tracer.NativeSpan(options);
            const end = span.end.bind(span);
            span.end = (endTime, exit) => {
              end(endTime, exit);
              recorded.push({ name: span.name, attributes: Object.fromEntries(span.attributes) });
            };
            return span;
          },
        });
        yield* checkOtlpEndpoint(
          { signal: "logs", url: running },
          { ...noRunningEndpoints, otlpLogsUrl: running, otlpExportOptions: withHeaders("logs") },
        ).pipe(Effect.withTracer(tracer));

        assert.strictEqual(received[0]?.headers["x-api-key"], "secret");
        assert.isUndefined(received[0]?.headers.traceparent);
        assert.isAbove(recorded.length, 0);
        assert.notInclude(JSON.stringify(recorded), "secret");
      }),
    ),
  );

  it.effect("contacts nothing for a URL that is not http or https", () =>
    Effect.gen(function* () {
      const result = yield* checkOtlpEndpoint(
        { signal: "logs", url: "file:///etc/passwd" },
        noRunningEndpoints,
      );
      assert.deepStrictEqual(result, { _tag: "Unreachable", timedOut: false });
    }),
  );

  it("rejects other schemes in the RPC input", () => {
    const decode = Schema.decodeUnknownOption(OtlpEndpointCheckInput);
    assert.strictEqual(decode({ signal: "logs", url: "data:text/plain,hi" })._tag, "None");
    assert.strictEqual(decode({ signal: "logs", url: "file:///etc/passwd" })._tag, "None");
    assert.strictEqual(decode({ signal: "logs", url: "HTTPS://collector/v1/logs" })._tag, "Some");
  });
});
