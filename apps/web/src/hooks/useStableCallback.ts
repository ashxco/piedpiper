import { useInsertionEffect, useRef, useState } from "react";

/**
 * Returns a function with a stable identity that always calls the latest `fn`.
 * Only call it from event handlers and effects: during render it would see the
 * previous commit's `fn`. The ref is never touched during render, so callers stay
 * compatible with the React Compiler, and the forwarder is created once so it keeps
 * no render scope alive.
 */
export function useStableCallback<Args extends ReadonlyArray<unknown>, Result>(
  fn: (...args: Args) => Result,
): (...args: Args) => Result {
  const latest = useRef(fn);
  // Insertion effects run before every layout effect and ref callback in the commit, children's included.
  useInsertionEffect(() => {
    latest.current = fn;
  });
  const [stable] = useState(
    () =>
      (...args: Args) =>
        latest.current(...args),
  );
  return stable;
}
