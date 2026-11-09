import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";

import packageJson from "../package.json" with { type: "json" };
import {
  deriveServerPaths,
  ensureServerDirectories,
  otlpResource,
  processRuntimeAttributes,
} from "./config.ts";

describe("otlpResource", () => {
  const config = { otlpServiceName: "piedpiper-server", mode: "web" } as const;

  it("reports the server version and runtime mode", () => {
    const resource = otlpResource(config, "box-1", undefined);
    assert.equal(resource.serviceName, "piedpiper-server");
    assert.equal(resource.serviceVersion, packageJson.version);
    assert.equal(resource.attributes["service.mode"], "web");
  });

  it("names the host, unless OTEL_RESOURCE_ATTRIBUTES already does", () => {
    assert.equal(otlpResource(config, "box-1", undefined).attributes["host.name"], "box-1");
    assert.equal(
      otlpResource(config, "box-1", "deployment.environment=dev,host.name=from%20env").attributes[
        "host.name"
      ],
      "from env",
    );
    assert.equal(otlpResource(config, "box-1", "host.name=").attributes["host.name"], "box-1");
  });

  it("keeps one generated service instance id for the whole process", () => {
    const id = otlpResource(config, "box-1", undefined).attributes["service.instance.id"];
    assert.match(id, /^[0-9a-f-]{36}$/);
    assert.equal(otlpResource(config, "box-2", undefined).attributes["service.instance.id"], id);
    assert.equal(
      otlpResource(config, "box-1", "host.name=other").attributes["service.instance.id"],
      id,
    );
  });

  it("lets OTEL_RESOURCE_ATTRIBUTES name the service instance, unless it is empty", () => {
    const generated = otlpResource(config, "box-1", undefined).attributes["service.instance.id"];
    assert.equal(
      otlpResource(config, "box-1", "service.instance.id=pod-7").attributes["service.instance.id"],
      "pod-7",
    );
    assert.equal(
      otlpResource(config, "box-1", "service.instance.id=").attributes["service.instance.id"],
      generated,
    );
  });

  it("reports the process runtime", () => {
    const { attributes } = otlpResource(config, "box-1", undefined);
    const runtime = processRuntimeAttributes();
    assert.equal(attributes["process.runtime.name"], runtime.name);
    assert.equal(attributes["process.runtime.version"], runtime.version);
    assert.equal(attributes["process.runtime.description"], runtime.description);
  });

  it("names Node, Electron and Bun, whose Node version is only a compatibility number", () => {
    assert.deepEqual(processRuntimeAttributes({ node: "24.3.0" }), {
      name: "nodejs",
      version: "24.3.0",
      description: "Node.js",
    });
    assert.deepEqual(processRuntimeAttributes({ node: "22.0.0", electron: "40.1.0" }), {
      name: "nodejs",
      version: "22.0.0",
      description: "Electron 40.1.0",
    });
    assert.deepEqual(processRuntimeAttributes({ node: "24.3.0", bun: "1.3.9" }), {
      name: "bun",
      version: "1.3.9",
      description: "Bun",
    });
  });

  it("lets OTEL_RESOURCE_ATTRIBUTES set the process runtime", () => {
    const { attributes } = otlpResource(
      config,
      "box-1",
      "process.runtime.name=custom,process.runtime.version=9,process.runtime.description=My%20runtime",
    );
    assert.equal(attributes["process.runtime.name"], "custom");
    assert.equal(attributes["process.runtime.version"], "9");
    assert.equal(attributes["process.runtime.description"], "My runtime");
  });
});

describe("ensureServerDirectories", () => {
  it.effect.skipIf(process.platform === "win32")("restricts the state directory to its owner", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "piedpiper-config-" });
      const paths = yield* deriveServerPaths(baseDir, undefined);
      yield* fs.makeDirectory(paths.stateDir, { recursive: true });
      yield* fs.chmod(paths.stateDir, 0o755);
      yield* ensureServerDirectories(paths);
      const info = yield* fs.stat(paths.stateDir);
      assert.equal(info.mode & 0o777, 0o700);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
