import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ConfigProvider, Effect, Fiber, FileSystem, Layer } from "effect";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/unstable/http";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { vi } from "vitest";

import { ServerConfig } from "../../config.ts";
import { getTelemetryIdentifier } from "../Identify.ts";
import { AnalyticsService } from "../Services/AnalyticsService.ts";
import {
  AnalyticsServiceLayerLive,
  MAX_BATCH_RETRY_MS,
  RETRY_MAX_DELAY_MS,
  retryDelayMs,
} from "./AnalyticsService.ts";

// A home with no ~/.codex/auth.json or ~/.claude.json, so the identity lookup reaches the id file.
vi.mock("node:os", async (importOriginal) => {
  const os = await importOriginal<typeof import("node:os")>();
  return { ...os, homedir: () => `${os.tmpdir()}/piedpiper-telemetry-no-home-${process.pid}` };
});

type FakeOutcome = "ok" | "fail" | "hang" | "reject";

/** Fake PostHog endpoint: records each attempt's events and answers per `outcome.current`. */
const makeFakeTelemetry = (
  env: Readonly<Record<string, unknown>> = {
    PIEDPIPER_TELEMETRY_ENABLED: true,
    PIEDPIPER_POSTHOG_KEY: "phc_test_key",
    PIEDPIPER_POSTHOG_HOST: "http://telemetry.test",
  },
) => {
  const outcome = { current: "ok" as FakeOutcome };
  const attempts: Array<ReadonlyArray<string>> = [];
  const uuids: Array<ReadonlyArray<string>> = [];
  const client = HttpClient.make((request) =>
    Effect.gen(function* () {
      const body = request.body._tag === "Uint8Array" ? request.body.body : new Uint8Array();
      const parsed = JSON.parse(new TextDecoder().decode(body)) as {
        batch: ReadonlyArray<{ event: string; uuid: string }>;
      };
      attempts.push(parsed.batch.map((entry) => entry.event));
      uuids.push(parsed.batch.map((entry) => entry.uuid));
      if (outcome.current === "hang") {
        return yield* Effect.never;
      }
      if (outcome.current === "reject") {
        return HttpClientResponse.fromWeb(request, new Response(null, { status: 400 }));
      }
      if (outcome.current === "fail") {
        return yield* new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, description: "unreachable" }),
        });
      }
      return HttpClientResponse.fromWeb(request, new Response("{}", { status: 200 }));
    }),
  );
  const layer = AnalyticsServiceLayerLive.pipe(
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "piedpiper-telemetry-clock-" }),
    ),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
  );
  return { outcome, attempts, uuids, layer };
};

interface RecordedBatchRequest {
  readonly path: string;
  readonly body: {
    readonly batch?: ReadonlyArray<{
      readonly event?: string;
      readonly properties?: {
        readonly index?: number;
        readonly clientType?: string;
      };
    }>;
  } | null;
}

interface RecordedBatchBody {
  readonly batch: ReadonlyArray<{
    readonly event?: string;
    readonly properties?: {
      readonly index?: number;
      readonly clientType?: string;
    };
  }>;
}

it.layer(NodeServices.layer)("AnalyticsService test", (it) => {
  it.effect("flush drains all buffered events across multiple batches", () =>
    Effect.gen(function* () {
      const capturedRequests: Array<RecordedBatchRequest> = [];
      const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
        prefix: "piedpiper-telemetry-base-",
      });

      const telemetryLayer = AnalyticsServiceLayerLive.pipe(Layer.provideMerge(serverConfigLayer));
      const configLayer = ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          PIEDPIPER_TELEMETRY_ENABLED: true,
          PIEDPIPER_POSTHOG_KEY: "phc_test_key",
          PIEDPIPER_POSTHOG_HOST: "",
          PIEDPIPER_TELEMETRY_FLUSH_BATCH_SIZE: 20,
        }),
      );
      const batchServerLayer = HttpServer.serve(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          if (request.method !== "POST") {
            return HttpServerResponse.empty({ status: 404 });
          }

          const payload = yield* request.json.pipe(
            Effect.map((body) => body as RecordedBatchRequest["body"]),
            Effect.catch(() => Effect.succeed(null)),
          );

          capturedRequests.push({ path: request.url, body: payload });

          return HttpServerResponse.jsonUnsafe({});
        }),
      );
      const runtimeLayer = telemetryLayer.pipe(
        Layer.provide(configLayer),
        Layer.provideMerge(NodeHttpServer.layerTest),
      );

      yield* Effect.gen(function* () {
        yield* Layer.launch(batchServerLayer).pipe(Effect.forkScoped);
        const telemetryIdentifier = yield* getTelemetryIdentifier;
        assert.equal(telemetryIdentifier !== null, true);
        const analytics = yield* AnalyticsService;

        for (let index = 0; index < 45; index += 1) {
          yield* analytics.record("test.flush.drain", { index });
        }

        yield* analytics.flush;
      }).pipe(Effect.provide(runtimeLayer));

      const batchRequests = capturedRequests.filter(
        (request): request is RecordedBatchRequest & { readonly body: RecordedBatchBody } =>
          Array.isArray(request.body?.batch),
      );
      assert.equal(batchRequests.length, 3);
      assert.equal(
        batchRequests.every((request) => request.path === "/batch/" || request.path === "/batch"),
        true,
      );
      const deliveredIndexes = batchRequests.flatMap((request) =>
        request.body.batch
          .filter((event) => event.event === "test.flush.drain")
          .map((event) => event.properties?.index)
          .filter((index): index is number => typeof index === "number"),
      );

      const sorted = deliveredIndexes.toSorted((a, b) => a - b);
      assert.equal(sorted.length, 45);
      assert.deepEqual(
        sorted,
        Array.from({ length: 45 }, (_, index) => index),
      );
      assert.equal(
        batchRequests.every((request) =>
          request.body.batch.every((event) => event.properties?.clientType === "cli-web-client"),
        ),
        true,
      );
    }),
  );

  const inactiveEnvs: ReadonlyArray<readonly [string, Readonly<Record<string, unknown>>]> = [
    ["no key is set", {}],
    ["the key is blank", { PIEDPIPER_POSTHOG_KEY: "  " }],
    [
      "telemetry is turned off",
      { PIEDPIPER_POSTHOG_KEY: "phc_test_key", PIEDPIPER_TELEMETRY_ENABLED: false },
    ],
  ];
  for (const [label, env] of inactiveEnvs) {
    it.effect(`sends nothing and writes no id file when ${label}`, () => {
      const telemetry = makeFakeTelemetry(env);
      return Effect.gen(function* () {
        const analytics = yield* AnalyticsService;
        const { anonymousIdPath } = yield* ServerConfig;
        const fileSystem = yield* FileSystem.FileSystem;
        yield* analytics.record("ignored");
        yield* analytics.flush;
        yield* TestClock.adjust("1 minute");
        assert.deepStrictEqual(telemetry.attempts, []);
        assert.isFalse(yield* fileSystem.exists(anonymousIdPath));
      }).pipe(Effect.provide(telemetry.layer));
    });
  }

  it.effect("writes the id file when a key is set", () => {
    const telemetry = makeFakeTelemetry();
    return Effect.gen(function* () {
      const { anonymousIdPath } = yield* ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      assert.isTrue(yield* fileSystem.exists(anonymousIdPath));
    }).pipe(Effect.provide(telemetry.layer));
  });

  it("backs off exponentially with jitter up to a cap", () => {
    assert.equal(retryDelayMs(1, 0), 1_000);
    assert.equal(retryDelayMs(1, 0.999_999), 2_000);
    assert.equal(retryDelayMs(3, 0), 4_000);
    assert.equal(retryDelayMs(30, 0.999_999), RETRY_MAX_DELAY_MS);
  });

  it.effect("waits out a backoff before retrying a failed batch, then delivers it", () => {
    const fake = makeFakeTelemetry();
    return Effect.gen(function* () {
      const analytics = yield* AnalyticsService;
      fake.outcome.current = "fail";
      yield* analytics.record("a");
      yield* analytics.flush;
      assert.equal(fake.attempts.length, 1);

      for (let second = 0; second < 10; second += 1) {
        yield* TestClock.adjust("1 second");
      }
      // Delays of ~1-2s, 2-4s, 4-8s: never once a second.
      assert.isAtMost(fake.attempts.length, 4);

      fake.outcome.current = "ok";
      yield* TestClock.adjust(`${RETRY_MAX_DELAY_MS} millis`);
      assert.deepEqual(fake.attempts.at(-1), ["a"]);
      const attemptsAfterDelivery = fake.attempts.length;
      yield* TestClock.adjust("5 seconds");
      assert.equal(fake.attempts.length, attemptsAfterDelivery);
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("times out a hung send and releases the flush lock", () => {
    const fake = makeFakeTelemetry();
    return Effect.gen(function* () {
      const analytics = yield* AnalyticsService;
      fake.outcome.current = "hang";
      yield* analytics.record("a");
      const hung = yield* Effect.forkChild(analytics.flush);
      yield* TestClock.adjust("10 seconds");
      yield* Fiber.join(hung);

      fake.outcome.current = "ok";
      yield* TestClock.adjust(`${RETRY_MAX_DELAY_MS} millis`);
      assert.deepEqual(fake.attempts.at(-1), ["a"]);
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("drops a batch that keeps failing past the retry window", () => {
    const fake = makeFakeTelemetry();
    return Effect.gen(function* () {
      const analytics = yield* AnalyticsService;
      fake.outcome.current = "fail";
      yield* analytics.record("stale");
      yield* analytics.flush;
      yield* TestClock.adjust(`${MAX_BATCH_RETRY_MS + RETRY_MAX_DELAY_MS * 2} millis`);
      const staleAttempts = fake.attempts.length;
      assert.isAbove(staleAttempts, 1);

      fake.outcome.current = "ok";
      yield* analytics.record("fresh");
      yield* TestClock.adjust(`${RETRY_MAX_DELAY_MS} millis`);
      const laterAttempts = fake.attempts.slice(staleAttempts);
      assert.deepEqual(laterAttempts, [["fresh"]]);
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("drops a batch the endpoint rejects without sending it again", () => {
    const fake = makeFakeTelemetry();
    return Effect.gen(function* () {
      const analytics = yield* AnalyticsService;
      fake.outcome.current = "reject";
      yield* analytics.record("bad");
      yield* analytics.flush;
      yield* TestClock.adjust(`${RETRY_MAX_DELAY_MS * 2} millis`);
      assert.deepEqual(fake.attempts, [["bad"]]);
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("resends a failed batch with the same event uuids", () => {
    const fake = makeFakeTelemetry();
    return Effect.gen(function* () {
      const analytics = yield* AnalyticsService;
      fake.outcome.current = "fail";
      yield* analytics.record("a");
      yield* analytics.record("b");
      yield* analytics.flush;

      fake.outcome.current = "ok";
      yield* TestClock.adjust(`${RETRY_MAX_DELAY_MS} millis`);
      assert.equal(fake.uuids.length, 2);
      const [first, retried] = fake.uuids;
      assert.equal(new Set(first).size, 2);
      assert.isTrue(first?.every((uuid) => typeof uuid === "string" && uuid.length > 0));
      assert.deepEqual(retried, first);
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("does not hold shutdown longer than the shutdown flush timeout", () => {
    const fake = makeFakeTelemetry();
    return Effect.gen(function* () {
      fake.outcome.current = "hang";
      const running = yield* Effect.forkChild(
        Effect.gen(function* () {
          const analytics = yield* AnalyticsService;
          yield* analytics.record("a");
        }).pipe(Effect.provide(fake.layer)),
      );
      // Layer build does real file IO, so wait (in live time) for the shutdown flush to start.
      while (fake.attempts.length === 0) {
        yield* TestClock.withLive(Effect.sleep("5 millis"));
      }
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(running);
      assert.equal(fake.attempts.length, 1);
    });
  });
});
