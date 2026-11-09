import { isElectron } from "~/env";
import { isMacPlatform } from "~/lib/utils";

/** Base UI's default collision padding on every side. */
const DEFAULT_COLLISION_PADDING = 5;
/** Height of the macOS desktop title-bar strip that holds the traffic lights. */
const MAC_DESKTOP_TITLEBAR_HEIGHT = 52;

export type CollisionPadding =
  | number
  | { top: number; right: number; bottom: number; left: number };

export function resolveCollisionPadding(input: {
  isElectron: boolean;
  platform: string;
}): CollisionPadding {
  if (!input.isElectron || !isMacPlatform(input.platform)) return DEFAULT_COLLISION_PADDING;
  // A padding object zeroes omitted sides, so every side restates the default.
  return {
    top: DEFAULT_COLLISION_PADDING + MAC_DESKTOP_TITLEBAR_HEIGHT,
    right: DEFAULT_COLLISION_PADDING,
    bottom: DEFAULT_COLLISION_PADDING,
    left: DEFAULT_COLLISION_PADDING,
  };
}

/** Collision padding that keeps floating popups out from under the macOS traffic lights. */
export const appCollisionPadding: CollisionPadding = resolveCollisionPadding({
  isElectron,
  platform: typeof navigator === "undefined" ? "" : navigator.platform,
});
