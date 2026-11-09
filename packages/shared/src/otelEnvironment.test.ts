import { describe, expect, it } from "vitest";

import {
  parseOtelEnvironment,
  parseOtlpHeaders,
  parseOtlpProtocol,
  resolveOtlpSignal,
} from "./otelEnvironment";

describe("parseOtlpHeaders", () => {
  it("reads percent-encoded key=value pairs", () => {
    expect(parseOtlpHeaders("x-api-key=abc%20123, x-team = core ,")).toEqual({
      "x-api-key": "abc 123",
      "x-team": "core",
    });
  });

  it("rejects malformed entries", () => {
    expect(parseOtlpHeaders("novalue")).toBeUndefined();
    expect(parseOtlpHeaders("bad key=1")).toBeUndefined();
    expect(parseOtlpHeaders("k=%E0%A4%A")).toBeUndefined();
  });
});

describe("parseOtlpProtocol", () => {
  it("accepts short and spec spellings in any case", () => {
    expect(parseOtlpProtocol("JSON")).toBe("http/json");
    expect(parseOtlpProtocol("http/protobuf")).toBe("http/protobuf");
    expect(parseOtlpProtocol("grpc")).toBeUndefined();
  });
});

describe("parseOtelEnvironment", () => {
  it("defaults to JSON without headers and no OTEL endpoints", () => {
    const environment = parseOtelEnvironment({});
    expect(environment.disabled).toBe(false);
    expect(environment.warnings).toEqual([]);
    expect(environment.piedpiper.traces).toEqual({ protocol: "http/json", headers: undefined });
    expect(environment.otel.metrics).toEqual({ _tag: "unset" });
  });

  it("applies Pied Piper headers and protocol, with per-signal headers winning", () => {
    const environment = parseOtelEnvironment({
      PIEDPIPER_OTLP_HEADERS: "authorization=Bearer%20shared",
      PIEDPIPER_OTLP_METRICS_HEADERS: "authorization=Bearer%20metrics",
      PIEDPIPER_OTLP_PROTOCOL: "protobuf",
    });
    expect(environment.piedpiper.traces).toEqual({
      protocol: "http/protobuf",
      headers: { authorization: "Bearer shared" },
    });
    expect(environment.piedpiper.metrics.headers).toEqual({ authorization: "Bearer metrics" });
  });

  it("ignores malformed Pied Piper values with a warning that hides the value", () => {
    const environment = parseOtelEnvironment({
      PIEDPIPER_OTLP_HEADERS: "secret-token-without-key",
      PIEDPIPER_OTLP_PROTOCOL: "grpc",
    });
    expect(environment.piedpiper.logs).toEqual({ protocol: "http/json", headers: undefined });
    expect(environment.warnings).toHaveLength(2);
    expect(environment.warnings.join("\n")).not.toContain("secret-token");
  });

  it("derives signal URLs from the generic OTEL endpoint and lets signal endpoints win", () => {
    const environment = parseOtelEnvironment({
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example/otlp?key=1",
      OTEL_EXPORTER_OTLP_HEADERS: "x-api-key=generic",
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "https://metrics.example/ingest",
      OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: "http/json",
    });
    expect(environment.otel.traces).toEqual({
      _tag: "export",
      url: "https://collector.example/otlp/v1/traces?key=1",
      options: { protocol: "http/protobuf", headers: { "x-api-key": "generic" } },
    });
    expect(environment.otel.metrics).toEqual({
      _tag: "export",
      url: "https://metrics.example/ingest",
      options: { protocol: "http/json", headers: { "x-api-key": "generic" } },
    });
  });

  it("turns a signal off for a malformed OTEL value or an exporter of none", () => {
    const environment = parseOtelEnvironment({
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example",
      OTEL_EXPORTER_OTLP_TRACES_HEADERS: "broken",
      OTEL_METRICS_EXPORTER: "none",
      OTEL_LOGS_EXPORTER: "console",
    });
    expect(environment.otel.traces).toEqual({ _tag: "off" });
    expect(environment.otel.metrics).toEqual({ _tag: "off" });
    expect(environment.otel.logs._tag).toBe("unset");
    expect(environment.warnings.some((warning) => warning.includes("console"))).toBe(true);
  });

  it("exports logs to the generic endpoint only when OTEL_LOGS_EXPORTER asks for otlp", () => {
    const generic = { OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318" };
    expect(parseOtelEnvironment(generic).otel.logs).toEqual({ _tag: "unset" });
    expect(parseOtelEnvironment({ ...generic, OTEL_LOGS_EXPORTER: "otlp" }).otel.logs).toEqual({
      _tag: "export",
      url: "http://localhost:4318/v1/logs",
      options: { protocol: "http/protobuf", headers: undefined },
    });
    expect(
      parseOtelEnvironment({
        ...generic,
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://logs.example/v1/logs",
      }).otel.logs._tag,
    ).toBe("export");
  });

  it("honors the kill switch, with the Pied Piper switch read first", () => {
    expect(parseOtelEnvironment({ OTEL_SDK_DISABLED: "TRUE" }).disabled).toBe(true);
    expect(
      parseOtelEnvironment({ OTEL_SDK_DISABLED: "true", PIEDPIPER_OTEL_SDK_DISABLED: "no" })
        .disabled,
    ).toBe(false);
    const loose = parseOtelEnvironment({ OTEL_SDK_DISABLED: "1" });
    expect(loose.disabled).toBe(false);
    expect(loose.warnings).toHaveLength(1);
  });
});

describe("resolveOtlpSignal", () => {
  const environment = parseOtelEnvironment({
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://otel.example/v1/traces",
    OTEL_METRICS_EXPORTER: "none",
    PIEDPIPER_OTLP_HEADERS: "x-key=pp",
  });

  it("prefers the Pied Piper variable, then OTEL, then fallbacks", () => {
    expect(resolveOtlpSignal(environment, "traces", "http://pp/v1/traces")).toEqual({
      url: "http://pp/v1/traces",
      options: { protocol: "http/json", headers: { "x-key": "pp" } },
    });
    expect(resolveOtlpSignal(environment, "traces", undefined, "http://bootstrap")?.url).toBe(
      "https://otel.example/v1/traces",
    );
    expect(
      resolveOtlpSignal(environment, "logs", " ", undefined, "http://settings/v1/logs"),
    ).toEqual({
      url: "http://settings/v1/logs",
      options: { protocol: "http/json", headers: { "x-key": "pp" } },
    });
  });

  it("exports nothing for a signal OTEL turned off or when disabled", () => {
    expect(
      resolveOtlpSignal(environment, "metrics", undefined, "http://bootstrap"),
    ).toBeUndefined();
    const disabled = parseOtelEnvironment({ OTEL_SDK_DISABLED: "true" });
    expect(resolveOtlpSignal(disabled, "traces", "http://pp/v1/traces")).toBeUndefined();
  });
});
