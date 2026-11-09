import Mime from "@effect/platform-node/Mime";
import { timingSafeEqual } from "node:crypto";
import { resolve as resolvePath } from "node:path";
import { Data, Effect, FileSystem, Layer, LogLevel, Option, Path, ServiceMap } from "effect";
import {
  Headers,
  HttpClient,
  HttpMiddleware,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { OtlpSerialization, type OtlpTracer } from "effect/unstable/observability";
import type { OrchestrationProject } from "@piedpiper/contracts";

import {
  ATTACHMENTS_ROUTE_PREFIX,
  normalizeAttachmentRelativePath,
  resolveAttachmentRelativePath,
} from "./attachmentPaths";
import { resolveAttachmentPathById } from "./attachmentStore";
import { ServerConfig, type ServerConfigShape } from "./config";
import { decodeOtlpTraceRecords } from "./observability/OtlpTraceRecord";
import { BrowserTraceCollector } from "./observability/Services/BrowserTraceCollector";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery";
import { isIcnsPath, readIcnsFaviconPng } from "./project/icns";
import { otlpSerializationLayer } from "./otlpExport";
import { ProjectFaviconResolver } from "./project/Services/ProjectFaviconResolver";
import { WORKSPACE_IMAGE_ROUTE_PATH } from "./workspaceImage/workspaceImageFile";

const PROJECT_FAVICON_CACHE_CONTROL = "public, max-age=3600";
// Registration can change at any time, so "not a project" and lookup failures must not be cached.
const UNCACHED = "no-store";
const PROJECT_FAVICON_ROUTE_PATH = "/api/project-favicon";
const WS_ROUTE_PATH = "/ws";
const OTLP_TRACES_ROUTE_PATH = "/api/observability/v1/traces";
const OTLP_TRACES_MAX_BODY_BYTES = 4 * 1024 * 1024;
const OTLP_TRACES_FORWARD_TIMEOUT = "5 seconds";
/** Scheme used by the Electron renderer in packaged builds (`piedpiper://app`). */
const DESKTOP_ORIGIN_SCHEME = "piedpiper:";
const SVG_CONTENT_SECURITY_POLICY = "sandbox; default-src 'none'; style-src 'unsafe-inline'";
const SENSITIVE_QUERY_PARAM_PATTERN = /token|secret|key|password|auth/i;

export function isWildcardHost(host: string | undefined): boolean {
  if (!host) return false;
  const normalized = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  return normalized === "0.0.0.0" || normalized === "::" || normalized === "";
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (normalized.length === 0) return false;
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "::1" ||
    normalized.startsWith("127.") ||
    normalized.startsWith("::ffff:127.")
  );
}

function normalizeHostname(hostname: string): string {
  return hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
}

/** True when `hostname` names the explicit (non-wildcard) bind host. */
function isExplicitBindHostname(hostname: string, bindHost: string | undefined): boolean {
  if (bindHost === undefined || isWildcardHost(bindHost)) return false;
  const normalizedBindHost = normalizeHostname(bindHost);
  return normalizedBindHost.length > 0 && normalizeHostname(hostname) === normalizedBindHost;
}

function parseHostHeaderHostname(hostHeader: string): string | undefined {
  try {
    return new URL(`http://${hostHeader.trim()}`).hostname;
  } catch {
    return undefined;
  }
}

/**
 * Origins allowed to talk to token-protected routes: loopback web origins, the
 * explicit bind host (for `--host <ip>`), and the desktop renderer scheme.
 * Anything else (including `null`) is rejected so a page on another site cannot
 * drive the server even with a leaked token. A wildcard bind stays loopback-only
 * because its Host header cannot be checked against DNS rebinding.
 */
export function isAllowedOrigin(origin: string, bindHost?: string): boolean {
  const trimmed = origin.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.toLowerCase().startsWith(DESKTOP_ORIGIN_SCHEME)) return true;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return isLoopbackHostname(url.hostname) || isExplicitBindHostname(url.hostname, bindHost);
  } catch {
    return false;
  }
}

/**
 * Host header check against DNS rebinding: the host must be loopback or the
 * configured bind host. A wildcard bind cannot be enumerated, so it is skipped.
 */
export function isAllowedHostHeader(hostHeader: string, bindHost: string | undefined): boolean {
  const hostname = parseHostHeaderHostname(hostHeader);
  if (!hostname) return false;
  if (isLoopbackHostname(hostname)) return true;
  if (bindHost === undefined || isWildcardHost(bindHost)) return true;
  return isExplicitBindHostname(hostname, bindHost);
}

function formatUrlHost(host: string | undefined): string {
  if (!host || isWildcardHost(host)) return "127.0.0.1";
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

/** Browser URL that carries the auth token; only meaningful in web mode. */
export function formatWebAccessUrl(
  config: Pick<ServerConfigShape, "mode" | "host" | "port" | "authToken">,
): string | undefined {
  if (config.mode !== "web" || !config.authToken) return undefined;
  return `http://${formatUrlHost(config.host)}:${config.port}/?token=${encodeURIComponent(config.authToken)}`;
}

export type RequestOriginRejection = "forbidden-origin" | "forbidden-host";

/**
 * Applies the Origin and Host checks to a request regardless of whether an auth
 * token is configured. Returns the reason when the request must be rejected.
 */
export function rejectRequestOrigin(
  request: HttpServerRequest.HttpServerRequest,
  config: Pick<ServerConfigShape, "host">,
): RequestOriginRejection | undefined {
  const origin = Headers.get(request.headers, "origin");
  if (Option.isSome(origin) && !isAllowedOrigin(origin.value, config.host)) {
    return "forbidden-origin";
  }
  const host = Headers.get(request.headers, "host");
  if (Option.isSome(host) && !isAllowedHostHeader(host.value, config.host)) {
    return "forbidden-host";
  }
  return undefined;
}

function constantTimeEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function hasValidBearerToken(
  request: HttpServerRequest.HttpServerRequest,
  authToken: string,
): boolean {
  const authHeader = Headers.get(request.headers, "authorization");
  if (Option.isNone(authHeader)) return false;
  const match = /^Bearer\s+(.+)$/i.exec(authHeader.value);
  return match !== null && constantTimeEquals(match[1]!, authToken);
}

/**
 * Validates the auth token from a request against the server config.
 * Accepts `Authorization: Bearer <token>` or a `?token=<token>` query parameter.
 * Cookies are deliberately ignored: they are not port-scoped, so any other page
 * on the same loopback host could read or replay them. Returns true when no auth
 * token is configured (open mode).
 */
export function validateAuthToken(
  request: HttpServerRequest.HttpServerRequest,
  config: Pick<ServerConfigShape, "authToken">,
): boolean {
  if (!config.authToken) return true;

  if (hasValidBearerToken(request, config.authToken)) return true;

  const url = HttpServerRequest.toURL(request);
  if (Option.isSome(url)) {
    const token = url.value.searchParams.get("token");
    if (token !== null && constantTimeEquals(token, config.authToken)) return true;
  }

  return false;
}

/**
 * Combined guard for token-protected routes: Origin/Host checks first, then the
 * token. Returns a response to send when the request must be rejected.
 */
export function rejectUnauthorizedRequest(
  request: HttpServerRequest.HttpServerRequest,
  config: Pick<ServerConfigShape, "host" | "authToken">,
): HttpServerResponse.HttpServerResponse | undefined {
  const originRejection = rejectRequestOrigin(request, config);
  if (originRejection !== undefined) {
    return HttpServerResponse.text("Forbidden", { status: 403 });
  }
  if (!validateAuthToken(request, config)) {
    return HttpServerResponse.text("Unauthorized", { status: 401 });
  }
  return undefined;
}

/**
 * Headers for user-provided image files. SVG documents are sandboxed so a
 * crafted attachment or project favicon cannot run script on the app origin.
 */
export function imageResponseHeaders(
  filePath: string,
  cacheControl: string,
): Record<string, string> {
  // Keyed on the served MIME type, not the suffix: `.svgz` is also served as image/svg+xml.
  const mime = Mime.getType(filePath);
  const needsSandbox = !mime || mime === "image/svg+xml" || !mime.startsWith("image/");
  return {
    "Cache-Control": cacheControl,
    "X-Content-Type-Options": "nosniff",
    "Content-Disposition": "inline",
    ...(needsSandbox ? { "Content-Security-Policy": SVG_CONTENT_SECURITY_POLICY } : {}),
  };
}

/**
 * Requests whose URL may carry the auth token never reach a trace span: the
 * tracer middleware records `url.full` and `url.query` verbatim.
 */
export function isUntracedRequest(request: Pick<HttpServerRequest.HttpServerRequest, "url">) {
  const queryIndex = request.url.indexOf("?");
  const path = queryIndex === -1 ? request.url : request.url.slice(0, queryIndex);
  if (
    path === WS_ROUTE_PATH ||
    path === PROJECT_FAVICON_ROUTE_PATH ||
    path === WORKSPACE_IMAGE_ROUTE_PATH ||
    path === OTLP_TRACES_ROUTE_PATH ||
    path.startsWith(`${ATTACHMENTS_ROUTE_PREFIX}/`)
  ) {
    return true;
  }
  if (queryIndex === -1) return false;
  for (const name of new URLSearchParams(request.url.slice(queryIndex + 1)).keys()) {
    if (SENSITIVE_QUERY_PARAM_PATTERN.test(name)) return true;
  }
  return false;
}

export const untracedSensitiveRequestsLayer = Layer.succeed(HttpMiddleware.TracerDisabledWhen)(
  isUntracedRequest,
);

/**
 * Keeps the same requests out of the HTTP access logger (`--log-websocket-events`),
 * which otherwise logs `http.url` verbatim, token included.
 */
export const unloggedSensitiveRequestsLayer = HttpRouter.middleware(
  (httpApp) =>
    Effect.withFiber((fiber) =>
      isUntracedRequest(ServiceMap.getUnsafe(fiber.services, HttpServerRequest.HttpServerRequest))
        ? HttpMiddleware.withLoggerDisabled(httpApp)
        : httpApp,
    ),
  { global: true },
);

/** Dev-mode redirect target that keeps the requested path, query (incl. `token`) and hash. */
export function resolveDevRedirectUrl(devUrl: URL, requestUrl: URL): string {
  const target = new URL(devUrl.toString());
  target.pathname = requestUrl.pathname;
  target.search = requestUrl.search;
  target.hash = requestUrl.hash;
  return target.toString();
}

/** Only called once the Origin passed the allow-list, so reflecting it is safe. */
function otlpTracesCorsHeaders(
  request: HttpServerRequest.HttpServerRequest,
): Record<string, string> {
  const origin = Headers.get(request.headers, "origin");
  if (Option.isNone(origin)) return { Vary: "Origin" };
  return {
    Vary: "Origin",
    "Access-Control-Allow-Origin": origin.value,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    // The exporter sets user-agent, and Safari and Firefox preflight it.
    "Access-Control-Allow-Headers": "authorization, content-type, user-agent",
    "Access-Control-Max-Age": "600",
  };
}

/** Node enforces the limit while reading; Bun buffers the whole body first, so check it again after. */
const readBodyWithLimit = (request: HttpServerRequest.HttpServerRequest, maxBytes: number) =>
  request.text.pipe(
    Effect.provideService(HttpServerRequest.MaxBodySize, FileSystem.Size(maxBytes)),
    Effect.map((text) => (Buffer.byteLength(text) > maxBytes ? Option.none() : Option.some(text))),
    Effect.orElseSucceed(() => Option.none<string>()),
  );

function parseJsonOrUndefined(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

class BrowserTraceEncodeError extends Data.TaggedError("BrowserTraceEncodeError")<{
  readonly cause: unknown;
}> {}

/** Re-encodes for the configured protocol. Failures are only logged, never the payload. */
const forwardBrowserTraces = (
  payload: OtlpTracer.TraceData,
  otlpTracesUrl: string,
  options: ServerConfigShape["otlpExportOptions"]["traces"],
) =>
  Effect.gen(function* () {
    const httpClient = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
    const serialization = yield* OtlpSerialization.OtlpSerialization;
    const body = yield* Effect.try({
      try: () => serialization.traces(payload),
      catch: (cause) => new BrowserTraceEncodeError({ cause }),
    });
    yield* httpClient.post(otlpTracesUrl, {
      body,
      ...(options.headers ? { headers: options.headers } : {}),
    });
  }).pipe(
    Effect.provide(otlpSerializationLayer(options.protocol)),
    Effect.timeout(OTLP_TRACES_FORWARD_TIMEOUT),
    Effect.withTracerEnabled(false),
    Effect.catch((error) =>
      Effect.logDebug("browser trace forward failed gracefully", { error: String(error) }),
    ),
  );

export const otlpTracesRouteLayer = Layer.mergeAll(
  HttpRouter.add(
    "OPTIONS",
    OTLP_TRACES_ROUTE_PATH,
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const config = yield* ServerConfig;
      if (rejectRequestOrigin(request, config) !== undefined) {
        return HttpServerResponse.text("Forbidden", { status: 403 });
      }
      return HttpServerResponse.empty({ status: 204, headers: otlpTracesCorsHeaders(request) });
    }),
  ),
  HttpRouter.add(
    "POST",
    OTLP_TRACES_ROUTE_PATH,
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const config = yield* ServerConfig;
      if (rejectRequestOrigin(request, config) !== undefined) {
        return HttpServerResponse.text("Forbidden", { status: 403 });
      }

      const headers = otlpTracesCorsHeaders(request);
      // Header only: the exporter posts every second, so the token stays out of the URL.
      if (config.authToken && !hasValidBearerToken(request, config.authToken)) {
        return HttpServerResponse.text("Unauthorized", { status: 401, headers });
      }

      // Closing the connection stops Node from buffering the rest of an oversized upload.
      const tooLarge = HttpServerResponse.text("Payload Too Large", {
        status: 413,
        headers: { ...headers, Connection: "close" },
      });
      const malformed = HttpServerResponse.text("Bad Request", { status: 400, headers });

      const contentLength = Option.map(Headers.get(request.headers, "content-length"), Number);
      if (Option.isSome(contentLength) && contentLength.value > OTLP_TRACES_MAX_BODY_BYTES) {
        return tooLarge;
      }

      // A failed read is either the limit or a client that already left, so 413 covers both.
      const body = yield* readBodyWithLimit(request, OTLP_TRACES_MAX_BODY_BYTES);
      if (Option.isNone(body)) return tooLarge;

      const payload = parseJsonOrUndefined(body.value);
      const records = decodeOtlpTraceRecords(payload);
      if (Option.isNone(records)) {
        // The exporter drops a rejected batch quietly, so this is the only sign of a format drift.
        yield* Effect.logWarning("browser trace payload rejected", {
          bytes: Buffer.byteLength(body.value),
        });
        return malformed;
      }

      // Browser spans are Info, and PIEDPIPER_TRACE_MIN_LEVEL silences them like server spans.
      if (LogLevel.isGreaterThan(config.traceMinLevel, "Info")) {
        return HttpServerResponse.empty({ status: 204, headers });
      }

      const collector = yield* BrowserTraceCollector;
      yield* collector.record(records.value);

      if (config.otlpTracesUrl !== undefined) {
        yield* forwardBrowserTraces(
          payload as OtlpTracer.TraceData,
          config.otlpTracesUrl,
          config.otlpExportOptions.traces,
        );
      }

      // A failed forward still answers 204: the exporter retries 5xx, which would duplicate file records.
      return HttpServerResponse.empty({ status: 204, headers });
    }),
  ),
);

/**
 * Only called once the Origin passed the allow-list, so reflecting it is safe. Vary is always sent:
 * these responses are cached for a year, and an <img> load must not answer a later CORS fetch.
 */
function attachmentCorsHeaders(
  request: HttpServerRequest.HttpServerRequest,
): Record<string, string> {
  const origin = Headers.get(request.headers, "origin");
  return Option.isSome(origin)
    ? { Vary: "Origin", "Access-Control-Allow-Origin": origin.value }
    : { Vary: "Origin" };
}

export const attachmentsRouteLayer = HttpRouter.add(
  "GET",
  `${ATTACHMENTS_ROUTE_PREFIX}/*`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const config = yield* ServerConfig;
    const rejection = rejectUnauthorizedRequest(request, config);
    if (rejection) return rejection;

    const rawRelativePath = url.value.pathname.slice(ATTACHMENTS_ROUTE_PREFIX.length);
    const normalizedRelativePath = normalizeAttachmentRelativePath(rawRelativePath);
    if (!normalizedRelativePath) {
      return HttpServerResponse.text("Invalid attachment path", { status: 400 });
    }

    const isIdLookup =
      !normalizedRelativePath.includes("/") && !normalizedRelativePath.includes(".");
    const filePath = isIdLookup
      ? yield* Effect.tryPromise(() =>
          resolveAttachmentPathById({
            attachmentsDir: config.attachmentsDir,
            attachmentId: normalizedRelativePath,
          }),
        ).pipe(
          Effect.catch((error) =>
            Effect.logDebug("attachment path resolve failed gracefully", {
              error: String(error),
            }).pipe(Effect.map(() => null)),
          ),
        )
      : resolveAttachmentRelativePath({
          attachmentsDir: config.attachmentsDir,
          relativePath: normalizedRelativePath,
        });
    if (!filePath) {
      return HttpServerResponse.text(isIdLookup ? "Not Found" : "Invalid attachment path", {
        status: isIdLookup ? 404 : 400,
      });
    }

    const fileSystem = yield* FileSystem.FileSystem;
    const fileInfo = yield* fileSystem.stat(filePath).pipe(
      Effect.catch((error) =>
        Effect.logDebug("attachment file stat failed gracefully", {
          error: String(error),
        }).pipe(Effect.map(() => null)),
      ),
    );
    if (!fileInfo || fileInfo.type !== "File") {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }

    return yield* HttpServerResponse.file(filePath, {
      status: 200,
      headers: {
        ...imageResponseHeaders(filePath, "public, max-age=31536000, immutable"),
        ...attachmentCorsHeaders(request),
      },
    }).pipe(
      Effect.catch((error) =>
        Effect.logDebug("attachment file serve failed gracefully", {
          error: String(error),
        }).pipe(
          Effect.map(() => HttpServerResponse.text("Internal Server Error", { status: 500 })),
        ),
      ),
    );
  }),
);

export const projectFaviconRouteLayer = HttpRouter.add(
  "GET",
  PROJECT_FAVICON_ROUTE_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const config = yield* ServerConfig;
    const rejection = rejectUnauthorizedRequest(request, config);
    if (rejection) return rejection;

    const projectCwd = url.value.searchParams.get("cwd");
    if (!projectCwd) {
      return HttpServerResponse.text("Missing cwd parameter", { status: 400 });
    }

    // Only registered project roots may be probed; anything else is indistinguishable from "no icon".
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const resolvedCwd = resolvePath(projectCwd);
    const lookupProject = (workspaceRoot: string) =>
      projectionSnapshotQuery.getActiveProjectByWorkspaceRoot(workspaceRoot);
    const registeredProject = yield* lookupProject(projectCwd).pipe(
      Effect.flatMap((project) =>
        Option.isNone(project) && resolvedCwd !== projectCwd
          ? lookupProject(resolvedCwd)
          : Effect.succeed(project),
      ),
      Effect.map(Option.some),
      Effect.catch((error) =>
        Effect.logDebug("project favicon registration lookup failed", {
          error: String(error),
        }).pipe(Effect.as(Option.none<Option.Option<OrchestrationProject>>())),
      ),
    );
    if (Option.isNone(registeredProject)) {
      return HttpServerResponse.text("Service Unavailable", {
        status: 503,
        headers: { "Cache-Control": UNCACHED },
      });
    }
    if (Option.isNone(registeredProject.value)) {
      return HttpServerResponse.text("No project favicon", {
        status: 404,
        headers: { "Cache-Control": UNCACHED },
      });
    }

    // A chosen icon can change without its URL changing: edited bytes, or a file that was missing.
    const cacheControl = registeredProject.value.value.faviconPath
      ? "no-cache"
      : PROJECT_FAVICON_CACHE_CONTROL;
    const faviconResolver = yield* ProjectFaviconResolver;
    const faviconFilePath = yield* faviconResolver.resolvePath(
      resolvedCwd,
      registeredProject.value.value.faviconPath ?? null,
    );
    if (!faviconFilePath) {
      // Return 404 (not the fallback SVG) so the frontend's <img> onError
      // fires and the React component renders its own lucide FolderIcon
      // with the correct color and open/closed state.
      return HttpServerResponse.text("No project favicon", {
        status: 404,
        headers: {
          "Cache-Control": cacheControl,
        },
      });
    }

    // Browsers cannot draw .icns, so serve its best embedded PNG instead.
    if (isIcnsPath(faviconFilePath)) {
      const png = yield* readIcnsFaviconPng(faviconFilePath);
      if (!png) {
        return HttpServerResponse.text("No project favicon", {
          status: 404,
          headers: { "Cache-Control": cacheControl },
        });
      }
      return HttpServerResponse.uint8Array(png, {
        status: 200,
        contentType: "image/png",
        headers: imageResponseHeaders("AppIcon.png", cacheControl),
      });
    }

    return yield* HttpServerResponse.file(faviconFilePath, {
      status: 200,
      headers: imageResponseHeaders(faviconFilePath, cacheControl),
    }).pipe(
      Effect.catch((error) =>
        Effect.logDebug("favicon file serve failed gracefully", {
          error: String(error),
        }).pipe(
          Effect.map(() => HttpServerResponse.text("Internal Server Error", { status: 500 })),
        ),
      ),
    );
  }),
);

export const staticAndDevRouteLayer = HttpRouter.add(
  "GET",
  "*",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const config = yield* ServerConfig;
    if (config.devUrl) {
      return HttpServerResponse.redirect(resolveDevRedirectUrl(config.devUrl, url.value), {
        status: 302,
      });
    }

    if (!config.staticDir) {
      return HttpServerResponse.text("No static directory configured and no dev URL set.", {
        status: 503,
      });
    }

    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const staticRoot = path.resolve(config.staticDir);
    const staticRequestPath = url.value.pathname === "/" ? "/index.html" : url.value.pathname;
    const rawStaticRelativePath = staticRequestPath.replace(/^[/\\]+/, "");
    const hasRawLeadingParentSegment = rawStaticRelativePath.startsWith("..");
    const staticRelativePath = path.normalize(rawStaticRelativePath).replace(/^[/\\]+/, "");
    const hasPathTraversalSegment = staticRelativePath.startsWith("..");
    if (
      staticRelativePath.length === 0 ||
      hasRawLeadingParentSegment ||
      hasPathTraversalSegment ||
      staticRelativePath.includes("\0")
    ) {
      return HttpServerResponse.text("Invalid static file path", { status: 400 });
    }

    const isWithinStaticRoot = (candidate: string) =>
      candidate === staticRoot ||
      candidate.startsWith(staticRoot.endsWith(path.sep) ? staticRoot : `${staticRoot}${path.sep}`);

    let filePath = path.resolve(staticRoot, staticRelativePath);
    if (!isWithinStaticRoot(filePath)) {
      return HttpServerResponse.text("Invalid static file path", { status: 400 });
    }

    const ext = path.extname(filePath);
    if (!ext) {
      filePath = path.resolve(filePath, "index.html");
      if (!isWithinStaticRoot(filePath)) {
        return HttpServerResponse.text("Invalid static file path", { status: 400 });
      }
    }

    const fileInfo = yield* fileSystem.stat(filePath).pipe(
      Effect.catch((error) =>
        Effect.logDebug("static file stat failed gracefully", {
          error: String(error),
        }).pipe(Effect.map(() => null)),
      ),
    );
    if (!fileInfo || fileInfo.type !== "File") {
      const indexPath = path.resolve(staticRoot, "index.html");
      const indexData = yield* fileSystem.readFile(indexPath).pipe(
        Effect.catch((error) =>
          Effect.logDebug("static index fallback read failed gracefully", {
            error: String(error),
          }).pipe(Effect.map(() => null)),
        ),
      );
      if (!indexData) {
        return HttpServerResponse.text("Not Found", { status: 404 });
      }
      return HttpServerResponse.uint8Array(indexData, {
        status: 200,
        contentType: "text/html; charset=utf-8",
      });
    }

    const contentType = Mime.getType(filePath) ?? "application/octet-stream";
    const data = yield* fileSystem.readFile(filePath).pipe(
      Effect.catch((error) =>
        Effect.logDebug("static file read failed gracefully", {
          error: String(error),
        }).pipe(Effect.map(() => null)),
      ),
    );
    if (!data) {
      return HttpServerResponse.text("Internal Server Error", { status: 500 });
    }

    return HttpServerResponse.uint8Array(data, {
      status: 200,
      contentType,
    });
  }),
);
