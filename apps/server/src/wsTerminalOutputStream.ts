import type {
  TerminalEvent,
  TerminalEventStreamItem,
  TerminalSubscribedFrame,
} from "@piedpiper/contracts";
import type * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Stream from "effect/Stream";

export const MAX_QUEUED_TERMINAL_OUTPUT_BYTES = 8 * 1024 * 1024;
export const MAX_TERMINAL_OUTPUT_BATCH_BYTES = 64 * 1024;
// Charge an envelope so tiny events cannot bypass the byte budget.
const EVENT_OVERHEAD_BYTES = 128;
const SUBSCRIBED_FRAME: TerminalSubscribedFrame = { type: "subscribed" };

type Listener = (event: TerminalEvent) => Effect.Effect<void>;
type Subscribe<E> = (listener: Listener) => Effect.Effect<() => void, E>;

const queuedSize = (event: TerminalEvent) =>
  EVENT_OVERHEAD_BYTES +
  (event.type === "output"
    ? Buffer.byteLength(event.data)
    : "snapshot" in event
      ? Buffer.byteLength(event.snapshot.history)
      : 0);

/**
 * Bridges a terminal event listener into a stream with a byte-charged pending
 * buffer. Each subscription starts with one `subscribed` frame, sent once the
 * listener is registered, so a client knows to resync anything it missed. When a slow client lets more than `maxQueuedBytes` pile up, the
 * listener is removed and the stream completes so the client re-subscribes
 * instead of the server buffering PTY output without bound. Pulls are batched
 * up to `MAX_TERMINAL_OUTPUT_BATCH_BYTES` so a backlog is not sent as one frame.
 */
export function terminalOutputStream<E>(
  subscribe: Subscribe<E>,
  maxQueuedBytes = MAX_QUEUED_TERMINAL_OUTPUT_BYTES,
): Stream.Stream<TerminalEventStreamItem, E> {
  return Stream.unwrap(
    Effect.gen(function* () {
      const ready = yield* Latch.make();
      let pending: Array<TerminalEvent | undefined> = [];
      let sizes: number[] = [];
      let head = 0;
      let queued = 0;
      let overflowed = false;
      let frameSent = false;
      let released = false;
      let unsubscribe: (() => void) | null = null;
      const release = () => {
        released = true;
        unsubscribe?.();
        unsubscribe = null;
        pending = [];
        sizes = [];
        head = 0;
        queued = 0;
      };
      yield* Effect.addFinalizer(() => Effect.sync(release));

      const listener: Listener = (event) =>
        Effect.sync(() => {
          if (released) return;
          const size = queuedSize(event);
          pending.push(event);
          sizes.push(size);
          queued += size;
          // A single oversized event (e.g. a snapshot) is still delivered on its own.
          if (queued - sizes[head]! > maxQueuedBytes) {
            release();
            overflowed = true;
          }
          ready.openUnsafe();
        });

      const take = () => {
        const event = pending[head]!;
        pending[head] = undefined;
        head += 1;
        return event;
      };
      const takeBatch = (): Arr.NonEmptyReadonlyArray<TerminalEvent> => {
        let bytes = sizes[head]!;
        const batch: [TerminalEvent, ...TerminalEvent[]] = [take()];
        while (head < pending.length && bytes + sizes[head]! <= MAX_TERMINAL_OUTPUT_BATCH_BYTES) {
          bytes += sizes[head]!;
          batch.push(take());
        }
        queued -= bytes;
        if (head * 2 >= pending.length) {
          pending = pending.slice(head);
          sizes = sizes.slice(head);
          head = 0;
        }
        return batch;
      };

      const pull: Effect.Effect<
        Arr.NonEmptyReadonlyArray<TerminalEventStreamItem>,
        Cause.Done
      > = Effect.suspend(() => {
        // Held outside the byte budget, and sent even after an overflow so no resync is lost.
        if (!frameSent) {
          frameSent = true;
          return Effect.succeed<Arr.NonEmptyReadonlyArray<TerminalEventStreamItem>>([
            SUBSCRIBED_FRAME,
          ]);
        }
        if (head < pending.length) return Effect.succeed(takeBatch());
        if (overflowed) return Cause.done();
        ready.closeUnsafe();
        return ready.await.pipe(Effect.andThen(pull));
      });

      // Uninterruptible so an interrupt cannot land between registering and recording the handle.
      yield* subscribe(listener).pipe(
        Effect.tap((stop) =>
          Effect.sync(() => {
            // The listener may already have overflowed (or been released) during acquisition.
            if (released) stop();
            else unsubscribe = stop;
          }),
        ),
        Effect.onError(() => Effect.sync(release)),
        Effect.uninterruptible,
      );
      return Stream.fromPull(Effect.succeed(pull));
    }),
  );
}
