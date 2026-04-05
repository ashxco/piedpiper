import Mime from "@effect/platform-node/Mime";
import { Effect, FileSystem, Option, Path } from "effect";
import { Headers, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import {
  ATTACHMENTS_ROUTE_PREFIX,
  normalizeAttachmentRelativePath,
  resolveAttachmentRelativePath,
} from "./attachmentPaths";
import { resolveAttachmentPathById } from "./attachmentStore";
import { ServerConfig, type ServerConfigShape } from "./config";
import { ProjectFaviconResolver } from "./project/Services/ProjectFaviconResolver";

const PROJECT_FAVICON_CACHE_CONTROL = "public, max-age=3600";

/**
 * Validates the auth token from a request against the server config.
 * Checks the `Authorization: Bearer <token>` header first, then falls back
 * to a `?token=<token>` query parameter. Returns true if the token matches
 * or if no auth token is configured (open mode).
 */
function validateAuthToken(
  request: HttpServerRequest.HttpServerRequest,
  config: ServerConfigShape,
): boolean {
  if (!config.authToken) return true;

  const authHeader = Headers.get(request.headers, "authorization");
  if (Option.isSome(authHeader)) {
    const match = /^Bearer\s+(.+)$/i.exec(authHeader.value);
    if (match && match[1] === config.authToken) return true;
  }

  const url = HttpServerRequest.toURL(request);
  if (Option.isSome(url)) {
    const token = url.value.searchParams.get("token");
    if (token === config.authToken) return true;
  }

  return false;
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
    if (!validateAuthToken(request, config)) {
      return HttpServerResponse.text("Unauthorized", { status: 401 });
    }

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
        "Cache-Control": "public, max-age=31536000, immutable",
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
  "/api/project-favicon",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const config = yield* ServerConfig;
    if (!validateAuthToken(request, config)) {
      return HttpServerResponse.text("Unauthorized", { status: 401 });
    }

    const projectCwd = url.value.searchParams.get("cwd");
    if (!projectCwd) {
      return HttpServerResponse.text("Missing cwd parameter", { status: 400 });
    }

    const faviconResolver = yield* ProjectFaviconResolver;
    const faviconFilePath = yield* faviconResolver.resolvePath(projectCwd);
    if (!faviconFilePath) {
      // Return 404 (not the fallback SVG) so the frontend's <img> onError
      // fires and the React component renders its own lucide FolderIcon
      // with the correct color and open/closed state.
      return HttpServerResponse.text("No project favicon", {
        status: 404,
        headers: {
          "Cache-Control": PROJECT_FAVICON_CACHE_CONTROL,
        },
      });
    }

    return yield* HttpServerResponse.file(faviconFilePath, {
      status: 200,
      headers: {
        "Cache-Control": PROJECT_FAVICON_CACHE_CONTROL,
      },
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
      return HttpServerResponse.redirect(config.devUrl.href, { status: 302 });
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
