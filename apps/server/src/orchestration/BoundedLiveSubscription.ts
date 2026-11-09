import { Cause, Effect, Exit, PubSub, Queue, Scope, Stream } from "effect";

export const LIVE_STREAM_MAX_ITEMS = 1_000;
const LIVE_STREAM_MAX_SERIALIZED_BYTES = 8 * 1024 * 1024;

export interface LiveStreamLimits {
  readonly maxItems?: number;
  readonly maxSerializedBytes?: number;
}

interface RetainedItem<A> {
  readonly value: A;
  readonly serializedBytes: number;
}

// Published events are shared by every subscription, so each one is measured once.
const serializedSizes = new WeakMap<object, number>();

function serializedSize(value: unknown): number {
  if (typeof value !== "object" || value === null) {
    return Buffer.byteLength(String(value));
  }
  const cached = serializedSizes.get(value);
  if (cached !== undefined) {
    return cached;
  }
  let bytes = 0;
  try {
    bytes = Buffer.byteLength(JSON.stringify(value) ?? "");
  } catch {
    bytes = 0;
  }
  serializedSizes.set(value, bytes);
  return bytes;
}

/**
 * Acquires a PubSub subscription and drains it into a bounded per-consumer buffer.
 *
 * The returned stream yields the subscription's items in order. Items count against the
 * budget from the moment they are taken off the subscription until the consumer pulls the
 * following batch (an RPC stream pulls again only after the client ACKs the previous one).
 * When the budget is exceeded the subscription is released at once, buffered items are
 * dropped, and the stream ends on its next pull so the client can re-subscribe and replay
 * the gap.
 *
 * The subscription is established before this effect returns, so callers can acquire it
 * ahead of reading a snapshot without missing events.
 */
export const subscribeBounded = <A>(
  subscribe: Effect.Effect<PubSub.Subscription<A>, never, Scope.Scope>,
  limits?: LiveStreamLimits,
): Effect.Effect<Stream.Stream<A>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const maxItems = limits?.maxItems ?? LIVE_STREAM_MAX_ITEMS;
    const maxSerializedBytes = limits?.maxSerializedBytes ?? LIVE_STREAM_MAX_SERIALIZED_BYTES;
    const sourceScope = yield* Scope.fork(yield* Effect.scope);
    const subscription = yield* subscribe.pipe(Scope.provide(sourceScope));
    const buffer = yield* Queue.unbounded<RetainedItem<A>, Cause.Done>();

    let retainedItems = 0;
    let retainedSerializedBytes = 0;
    let inFlight: ReadonlyArray<RetainedItem<A>> = [];

    const release = (items: ReadonlyArray<RetainedItem<A>>) => {
      for (const item of items) {
        retainedItems -= 1;
        retainedSerializedBytes -= item.serializedBytes;
      }
    };

    const overflow = (nextItems: number, nextSerializedBytes: number) =>
      Effect.gen(function* () {
        yield* Effect.logWarning("live event buffer is full; ending the subscription stream", {
          retainedItems,
          retainedSerializedBytes,
          nextItems,
          nextSerializedBytes,
          maxItems,
          maxSerializedBytes,
        });
        release(yield* Queue.clear(buffer));
        yield* Queue.end(buffer);
        yield* Scope.close(sourceScope, Exit.void);
      });

    const drain: Effect.Effect<void> = Effect.gen(function* () {
      for (;;) {
        const values = yield* PubSub.takeAll(subscription);
        const accepted: Array<RetainedItem<A>> = [];
        for (const value of values) {
          const item = { value, serializedBytes: serializedSize(value) };
          const nextItems = retainedItems + 1;
          const nextSerializedBytes = retainedSerializedBytes + item.serializedBytes;
          // A lone oversized item is still delivered; otherwise the client would loop on it.
          if (
            retainedItems > 0 &&
            (nextItems > maxItems || nextSerializedBytes > maxSerializedBytes)
          ) {
            yield* Queue.offerAll(buffer, accepted);
            return yield* overflow(nextItems, nextSerializedBytes);
          }
          retainedItems = nextItems;
          retainedSerializedBytes = nextSerializedBytes;
          accepted.push(item);
        }
        yield* Queue.offerAll(buffer, accepted);
      }
    });
    yield* Effect.forkScoped(drain);

    const pull = Effect.suspend(() => {
      release(inFlight);
      inFlight = [];
      return Queue.takeAll(buffer).pipe(
        Effect.map((items) => {
          inFlight = items;
          return items.map((item) => item.value) as unknown as readonly [A, ...A[]];
        }),
      );
    });

    return Stream.fromPull(Effect.succeed(pull));
  });

export interface ResumableLiveStreamOptions<A, E> {
  readonly subscribe: Effect.Effect<PubSub.Subscription<A>, never, Scope.Scope>;
  readonly sequenceOf: (item: A) => number;
  /** Items with a sequence greater than the argument, read from durable storage. */
  readonly replayAfter: (sequenceExclusive: number) => Stream.Stream<A, E>;
  readonly limits?: LiveStreamLimits;
}

/**
 * Like `subscribeBounded`, but an overflow does not leave a gap: the stream re-subscribes,
 * replays everything after the last item it delivered, and carries on live.
 *
 * The first subscription is established before this effect returns; call the returned function
 * with the sequence the caller has already covered (e.g. a snapshot's) to start the stream.
 * Items at or below the last delivered sequence are dropped, so replay and live never duplicate.
 */
export const subscribeBoundedResumable = <A, E>(
  options: ResumableLiveStreamOptions<A, E>,
): Effect.Effect<(fromSequenceExclusive: number) => Stream.Stream<A, E>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const firstLive = yield* subscribeBounded(options.subscribe, options.limits);
    return (fromSequenceExclusive: number) => {
      let lastSequence = fromSequenceExclusive;
      const segment = (live: Stream.Stream<A>): Stream.Stream<A, E> =>
        Stream.concat(
          Stream.suspend(() => options.replayAfter(lastSequence)),
          live,
        ).pipe(
          Stream.filter((item) => options.sequenceOf(item) > lastSequence),
          Stream.tap((item) =>
            Effect.sync(() => {
              lastSequence = options.sequenceOf(item);
            }),
          ),
        );
      // The live stream only ends on overflow; each new segment subscribes before it replays.
      return Stream.concat(
        segment(firstLive),
        Stream.flatMap(
          Stream.iterate(0, (attempt) => attempt + 1),
          () =>
            Stream.unwrap(Effect.map(subscribeBounded(options.subscribe, options.limits), segment)),
        ),
      );
    };
  });
