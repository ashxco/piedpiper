/**
 * otelEnvironment: reads the OTLP export variables (Pied Piper's own and the standard
 * OpenTelemetry ones) so the server and the desktop main process agree on what is exported,
 * where, in which wire format and with which headers.
 *
 * Every malformed value is ignored with a warning instead of failing startup. Warnings never
 * echo header values or endpoints, because those can carry API keys.
 *
 * @module otelEnvironment
 */

export type OtlpProtocol = "http/json" | "http/protobuf";
export type OtlpSignalName = "traces" | "metrics" | "logs";
export const OTLP_SIGNAL_NAMES: ReadonlyArray<OtlpSignalName> = ["traces", "metrics", "logs"];

/** How one signal is sent once its endpoint is known. */
export interface OtlpExportOptions {
  readonly protocol: OtlpProtocol;
  readonly headers: Readonly<Record<string, string>> | undefined;
}

/** Pied Piper's historical wire format, kept as the default for its own variables. */
export const DEFAULT_OTLP_EXPORT_OPTIONS: OtlpExportOptions = {
  protocol: "http/json",
  headers: undefined,
};

/**
 * What the OTEL_* variables say about one signal. `off` means they turned it off
 * (`OTEL_<SIGNAL>_EXPORTER=none`) or named it with a value that does not read, so it is exported
 * nowhere rather than to a collector it was not meant for.
 */
export type OtelSignal =
  | { readonly _tag: "unset" }
  | { readonly _tag: "off" }
  | { readonly _tag: "export"; readonly url: string; readonly options: OtlpExportOptions };

export interface OtelEnvironment {
  /** The kill switch: no OTLP export at all, whatever endpoint is configured. */
  readonly disabled: boolean;
  /** Messages for the caller to log once at startup. */
  readonly warnings: ReadonlyArray<string>;
  /** Export options for endpoints named by PIEDPIPER_* variables, bootstrap or settings. */
  readonly piedpiper: Readonly<Record<OtlpSignalName, OtlpExportOptions>>;
  /** Endpoints named by the standard OTEL_EXPORTER_OTLP_* variables. */
  readonly otel: Readonly<Record<OtlpSignalName, OtelSignal>>;
}

/** Every variable `parseOtelEnvironment` reads, for callers that read them through a ConfigProvider. */
export const OTEL_ENVIRONMENT_VARIABLE_NAMES: ReadonlyArray<string> = [
  "PIEDPIPER_OTEL_SDK_DISABLED",
  "OTEL_SDK_DISABLED",
  "PIEDPIPER_OTLP_HEADERS",
  "PIEDPIPER_OTLP_PROTOCOL",
  ...OTLP_SIGNAL_NAMES.flatMap((signal) => {
    const upper = signal.toUpperCase();
    return [
      `PIEDPIPER_OTLP_${upper}_HEADERS`,
      `OTEL_${upper}_EXPORTER`,
      `OTEL_EXPORTER_OTLP_${upper}_ENDPOINT`,
      `OTEL_EXPORTER_OTLP_${upper}_PROTOCOL`,
      `OTEL_EXPORTER_OTLP_${upper}_HEADERS`,
    ];
  }),
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_PROTOCOL",
  "OTEL_EXPORTER_OTLP_HEADERS",
];

export type OtelEnvironmentVariables = Readonly<Record<string, string | undefined>>;

interface Setting<A> {
  readonly value: A | undefined;
  readonly warning?: string;
}

const UNSET: Setting<never> = { value: undefined };

const blankAsUnset = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
};

const read = <A>(
  env: OtelEnvironmentVariables,
  name: string,
  parse: (raw: string) => A | undefined,
  warning: string,
): Setting<A> => {
  const raw = blankAsUnset(env[name]);
  if (raw === undefined) return UNSET;
  const value = parse(raw);
  return value === undefined ? { value: undefined, warning } : { value };
};

/** Parses `key=value,key2=value2` with percent-encoded values; undefined when malformed. */
export function parseOtlpHeaders(raw: string): Readonly<Record<string, string>> | undefined {
  const headers: Record<string, string> = {};
  for (const entry of raw.split(",")) {
    if (entry.trim() === "") continue;
    const separator = entry.indexOf("=");
    if (separator <= 0) return undefined;
    const key = entry.slice(0, separator).trim();
    // RFC 7230 token characters; anything else would be rejected by fetch at export time.
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key)) return undefined;
    try {
      headers[key] = decodeURIComponent(entry.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

/** Accepts the spec's `http/json` / `http/protobuf` and the short `json` / `protobuf`. */
export function parseOtlpProtocol(raw: string): OtlpProtocol | undefined {
  switch (raw.trim().toLowerCase()) {
    case "json":
    case "http/json":
      return "http/json";
    case "protobuf":
    case "http/protobuf":
      return "http/protobuf";
    default:
      return undefined;
  }
}

const parseHttpUrl = (raw: string): URL | undefined => {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
};

const NOT_EXPORTED = "so the signals it configures are not exported";

const readHeaders = (env: OtelEnvironmentVariables, name: string, consequence: string) =>
  read(
    env,
    name,
    parseOtlpHeaders,
    `${name} is not a list of key=value pairs with percent-encoded values, ${consequence}`,
  );

const readProtocol = (env: OtelEnvironmentVariables, name: string, consequence: string) =>
  read(env, name, parseOtlpProtocol, `${name} is not http/json or http/protobuf, ${consequence}`);

const readFlag = (
  env: OtelEnvironmentVariables,
  name: string,
  truthy: ReadonlyArray<string>,
  falsy: ReadonlyArray<string>,
  invalid: string,
): Setting<boolean> =>
  read(
    env,
    name,
    (raw) => {
      const value = raw.toLowerCase();
      return truthy.includes(value) ? true : falsy.includes(value) ? false : undefined;
    },
    invalid,
  );

/** `OTEL_<SIGNAL>_EXPORTER`: a list whose default is `otlp`; only `none` turns the signal off. */
const readExporter = (env: OtelEnvironmentVariables, name: string): Setting<"otlp" | "none"> => {
  const entries = (env[name] ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== "");
  const ignored = [...new Set(entries.filter((entry) => entry !== "otlp" && entry !== "none"))];
  const value = entries.includes("otlp") ? "otlp" : entries.includes("none") ? "none" : undefined;
  return ignored.length === 0
    ? { value }
    : {
        value,
        warning: `${name} names ${ignored.join(", ")}, which Pied Piper does not export to, so ${ignored.length === 1 ? "it was" : "they were"} ignored`,
      };
};

const isClaimed = (setting: Setting<unknown>) =>
  setting.value !== undefined || setting.warning !== undefined;

/** Appends the signal's path to the generic endpoint, keeping any query string. */
const withSignalPath = (signal: OtlpSignalName, base: URL) => {
  const url = new URL(base);
  url.pathname += `${url.pathname.endsWith("/") ? "" : "/"}v1/${signal}`;
  return url;
};

const resolveOtelSignal = (
  env: OtelEnvironmentVariables,
  signal: OtlpSignalName,
  warnings: Set<string>,
): OtelSignal => {
  const report = (...settings: ReadonlyArray<Setting<unknown>>) => {
    for (const setting of settings) if (setting.warning) warnings.add(setting.warning);
  };
  const upper = signal.toUpperCase();
  const exporter = readExporter(env, `OTEL_${upper}_EXPORTER`);
  report(exporter);
  if (exporter.value === "none") return { _tag: "off" };

  const ownPrefix = `OTEL_EXPORTER_OTLP_${upper}_`;
  const genericPrefix = "OTEL_EXPORTER_OTLP_";
  const endpointOf = (name: string) =>
    read(env, name, parseHttpUrl, `${name} is not an http or https URL, ${NOT_EXPORTED}`);
  const ownEndpoint = endpointOf(`${ownPrefix}ENDPOINT`);
  // Log export replaces span-event logging, so a generic (often traces-only) collector does not
  // enable it unless OTEL_LOGS_EXPORTER=otlp asks for it.
  if (signal === "logs" && !isClaimed(ownEndpoint) && exporter.value !== "otlp") {
    return { _tag: "unset" };
  }
  const endpoint = isClaimed(ownEndpoint) ? ownEndpoint : endpointOf(`${genericPrefix}ENDPOINT`);
  report(endpoint);
  if (endpoint.value === undefined) {
    return endpoint.warning === undefined ? { _tag: "unset" } : { _tag: "off" };
  }

  const ownProtocol = readProtocol(env, `${ownPrefix}PROTOCOL`, NOT_EXPORTED);
  const protocol = isClaimed(ownProtocol)
    ? ownProtocol
    : readProtocol(env, `${genericPrefix}PROTOCOL`, NOT_EXPORTED);
  const ownHeaders = readHeaders(env, `${ownPrefix}HEADERS`, NOT_EXPORTED);
  const headers = isClaimed(ownHeaders)
    ? ownHeaders
    : readHeaders(env, `${genericPrefix}HEADERS`, NOT_EXPORTED);
  report(protocol, headers);
  if (protocol.warning !== undefined || headers.warning !== undefined) return { _tag: "off" };

  const url = isClaimed(ownEndpoint) ? endpoint.value : withSignalPath(signal, endpoint.value);
  return {
    _tag: "export",
    url: url.toString(),
    // The specification's default wire format.
    options: { protocol: protocol.value ?? "http/protobuf", headers: headers.value },
  };
};

const PIEDPIPER_TRUE = ["true", "yes", "on", "1", "y"];
const PIEDPIPER_FALSE = ["false", "no", "off", "0", "n"];

export function parseOtelEnvironment(env: OtelEnvironmentVariables): OtelEnvironment {
  const warnings = new Set<string>();
  const ownSwitch = readFlag(
    env,
    "PIEDPIPER_OTEL_SDK_DISABLED",
    PIEDPIPER_TRUE,
    PIEDPIPER_FALSE,
    "PIEDPIPER_OTEL_SDK_DISABLED is not a yes or a no and was ignored",
  );
  // The specification recognizes only the case-insensitive string "true" as true.
  const specSwitch = readFlag(
    env,
    "OTEL_SDK_DISABLED",
    ["true"],
    ["false"],
    "OTEL_SDK_DISABLED was read as false; only the string true turns export off",
  );
  for (const setting of [ownSwitch, specSwitch]) {
    if (setting.warning) warnings.add(setting.warning);
  }
  const disabled = ownSwitch.value ?? specSwitch.value ?? false;

  const ignoredOwn = "so it was ignored";
  const sharedHeaders = readHeaders(env, "PIEDPIPER_OTLP_HEADERS", ignoredOwn);
  const sharedProtocol = readProtocol(env, "PIEDPIPER_OTLP_PROTOCOL", ignoredOwn);
  const piedpiperOptions = (signal: OtlpSignalName): OtlpExportOptions => {
    const upper = signal.toUpperCase();
    const ownHeaders = readHeaders(env, `PIEDPIPER_OTLP_${upper}_HEADERS`, ignoredOwn);
    const headers = isClaimed(ownHeaders) ? ownHeaders : sharedHeaders;
    if (headers.warning) warnings.add(headers.warning);
    if (sharedProtocol.warning) warnings.add(sharedProtocol.warning);
    return {
      protocol: sharedProtocol.value ?? DEFAULT_OTLP_EXPORT_OPTIONS.protocol,
      headers: headers.value,
    };
  };

  const unset: OtelSignal = { _tag: "unset" };
  const otel = disabled
    ? { traces: unset, metrics: unset, logs: unset }
    : {
        traces: resolveOtelSignal(env, "traces", warnings),
        metrics: resolveOtelSignal(env, "metrics", warnings),
        logs: resolveOtelSignal(env, "logs", warnings),
      };
  if (disabled) {
    warnings.add(
      ownSwitch.value
        ? "PIEDPIPER_OTEL_SDK_DISABLED is set, so no telemetry is exported over OTLP"
        : "OTEL_SDK_DISABLED is set, so no telemetry is exported over OTLP; set PIEDPIPER_OTEL_SDK_DISABLED=false to export anyway",
    );
  }

  const piedpiper = {
    traces: piedpiperOptions("traces"),
    metrics: piedpiperOptions("metrics"),
    logs: piedpiperOptions("logs"),
  };
  return { disabled, warnings: [...warnings], piedpiper, otel };
}

export interface ResolvedOtlpSignal {
  readonly url: string;
  readonly options: OtlpExportOptions;
}

/**
 * Where one signal exports and how. The PIEDPIPER_OTLP_<SIGNAL>_URL variable wins with Pied Piper's
 * own headers and protocol, then a standard OTEL endpoint with its own headers and protocol, then
 * the first of `fallbackUrls` (bootstrap, persisted settings) with Pied Piper's options.
 */
export function resolveOtlpSignal(
  environment: OtelEnvironment,
  signal: OtlpSignalName,
  piedpiperUrl: string | undefined,
  ...fallbackUrls: ReadonlyArray<string | undefined>
): ResolvedOtlpSignal | undefined {
  if (environment.disabled) return undefined;
  const options = environment.piedpiper[signal];
  const ownUrl = blankAsUnset(piedpiperUrl);
  if (ownUrl !== undefined) return { url: ownUrl, options };
  const otel = environment.otel[signal];
  switch (otel._tag) {
    case "export":
      return { url: otel.url, options: otel.options };
    case "off":
      return undefined;
    case "unset": {
      const url = fallbackUrls.map(blankAsUnset).find((candidate) => candidate !== undefined);
      return url === undefined ? undefined : { url, options };
    }
  }
}
