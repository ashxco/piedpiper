import { COARSE_JUST_NOW_MS } from "../../timestampFormat";
import { RelativeTime } from "../RelativeTime";

/** Compact "5m" label for sidebar rows: reads "just now" for the first minute, then counts. */
export function SidebarRelativeTime(props: { timestamp: string | null | undefined }) {
  return <RelativeTime timestamp={props.timestamp} valueOnly justNowMs={COARSE_JUST_NOW_MS} />;
}
