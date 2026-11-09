import { useRelativeTimeState } from "../hooks/useRelativeTimeState";
import { formatRelativeTimeParts } from "../timestampFormat";

/**
 * A "5m ago" label that keeps counting. Formatting inline in render does not:
 * the React Compiler caches the result on the timestamp alone.
 * `valueOnly` drops the "ago" suffix ("5m") for compact rows; `justNowMs` sets how long it reads "just now".
 */
export function RelativeTime(props: {
  timestamp: string | null | undefined;
  valueOnly?: boolean;
  justNowMs?: number;
}) {
  const relative = useRelativeTimeState(props.timestamp, props.justNowMs);
  if (relative.status !== "relative") return null;
  return props.valueOnly ? relative.value : formatRelativeTimeParts(relative);
}
