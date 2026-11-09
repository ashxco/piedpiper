import { ThreadId } from "@piedpiper/contracts";
import { Effect, Option, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { ServerConfig } from "../config";
import { imageResponseHeaders, rejectUnauthorizedRequest } from "../http";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery";
import { resolveWorkspaceImageFile, WORKSPACE_IMAGE_ROUTE_PATH } from "./workspaceImageFile";

// Files in a workspace change, and so does which thread may read them.
const UNCACHED = "no-store";

const notFound = () =>
  HttpServerResponse.text("Not Found", { status: 404, headers: { "Cache-Control": UNCACHED } });

/** Serves an image file from a thread's worktree or project, found from the thread on the server. */
export const workspaceImageRouteLayer = HttpRouter.add(
  "GET",
  WORKSPACE_IMAGE_ROUTE_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const config = yield* ServerConfig;
    const rejection = rejectUnauthorizedRequest(request, config);
    if (rejection) return rejection;

    const threadId = url.value.searchParams.get("threadId");
    const path = url.value.searchParams.get("path");
    if (!threadId || !path || !Schema.is(ThreadId)(threadId)) {
      return HttpServerResponse.text("Missing threadId or path", { status: 400 });
    }

    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const context = yield* projectionSnapshotQuery
      .getThreadWorkspaceContext(threadId)
      .pipe(
        Effect.catch((error) =>
          Effect.logDebug("workspace image thread lookup failed", { error: String(error) }).pipe(
            Effect.as(Option.none()),
          ),
        ),
      );
    if (Option.isNone(context)) return notFound();

    const { worktreePath, workspaceRoot } = context.value;
    const roots = worktreePath ? [worktreePath, workspaceRoot] : [workspaceRoot];
    const filePath = yield* resolveWorkspaceImageFile({ path, roots });
    if (filePath === null) return notFound();

    return yield* HttpServerResponse.file(filePath, {
      status: 200,
      headers: imageResponseHeaders(filePath, UNCACHED),
    }).pipe(
      Effect.catch((error) =>
        Effect.logDebug("workspace image serve failed", { error: String(error) }).pipe(
          Effect.as(HttpServerResponse.text("Internal Server Error", { status: 500 })),
        ),
      ),
    );
  }),
);
