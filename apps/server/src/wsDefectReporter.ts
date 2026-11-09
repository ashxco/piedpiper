import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as ErrorReporter from "effect/ErrorReporter";

/**
 * Logs defects of WebSocket RPC handlers. RpcServer reports every failed
 * handler exit; typed failures are expected responses, so only dies are logged.
 */
const reporter: ErrorReporter.ErrorReporter = {
  [ErrorReporter.TypeId]: ErrorReporter.TypeId,
  report: ({ cause, fiber }) => {
    for (const reason of cause.reasons) {
      if (reason._tag !== "Die" || ErrorReporter.isIgnored(reason.defect)) continue;
      // Reporters run synchronously in the failing fiber; forking keeps its loggers and cannot throw back.
      Effect.runForkWith(fiber.services)(
        Effect.logError("Unhandled websocket RPC defect", Cause.fromReasons([reason])),
      );
    }
  },
};

export const wsDefectReporterLayer = ErrorReporter.layer([reporter]);
