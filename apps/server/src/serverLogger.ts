import { Cause, Effect, Logger, Redactable, References, Layer } from "effect";

import { ServerConfig } from "./config";
import { makeServerLoggerLayer } from "./otlpExport";

/**
 * `Logger.consolePretty` prints message objects with `util.inspect`, which
 * collapses a `Cause` passed as a field (`{ cause }`) to `{ failures: [ [Object] ] }`.
 * Render those fields with `Cause.pretty` instead.
 */
export const makeConsolePrettyLogger = (): Logger.Logger<unknown, void> => {
  const pretty = Logger.consolePretty();
  return Logger.make((options) =>
    pretty.log({
      ...options,
      message: Array.isArray(options.message)
        ? options.message.map(prettyCauseFields)
        : prettyCauseFields(options.message),
    }),
  );
};

export function prettyCauseFields(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  // A message with its own redaction hook already decides how it prints.
  if (Redactable.isRedactable(value)) return value;
  // Copy descriptors (not entries) so getters never run and symbol keys survive.
  const descriptors = Object.getOwnPropertyDescriptors(value);
  let changed = false;
  for (const descriptor of Object.values(descriptors)) {
    if ("value" in descriptor && Cause.isCause(descriptor.value)) {
      descriptor.value = Cause.pretty(descriptor.value);
      changed = true;
    }
  }
  return changed ? Object.create(prototype as object | null, descriptors) : value;
}

export const ServerLoggerLive = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const minimumLogLevelLayer = Layer.succeed(References.MinimumLogLevel, config.logLevel);
  const loggerLayer = makeServerLoggerLayer(config, makeConsolePrettyLogger());

  return Layer.mergeAll(loggerLayer, minimumLogLevelLayer);
}).pipe(Layer.unwrap);
