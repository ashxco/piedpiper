import { Effect, Layer, ServiceMap } from "effect";

import type { OtlpTraceRecord } from "../OtlpTraceRecord.ts";
import type { TraceSink } from "../TraceSink.ts";

export interface BrowserTraceCollectorShape {
  readonly record: (records: ReadonlyArray<OtlpTraceRecord>) => Effect.Effect<void>;
}

/** Receives decoded browser spans. Without a trace sink layer the records are dropped. */
export const BrowserTraceCollector = ServiceMap.Reference<BrowserTraceCollectorShape>(
  "piedpiper/observability/Services/BrowserTraceCollector",
  { defaultValue: () => ({ record: () => Effect.void }) },
);

/** Writes browser spans through the sink the server tracer uses, so rotation stays in one place. */
export const browserTraceCollectorLayer = (sink: Pick<TraceSink, "push">) =>
  Layer.succeed(BrowserTraceCollector, {
    record: (records) =>
      Effect.sync(() => {
        for (const record of records) sink.push(record);
      }),
  });
