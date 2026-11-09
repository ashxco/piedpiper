import type { AnimationEvent } from "react";

export const STATUS_PULSE_ANIMATION_NAME = "status-pulse";

/** Pin a newly started status pulse to the document clock so every row pulses in phase. */
export function synchronizeStatusPulse(event: AnimationEvent<Element>): void {
  if (event.animationName !== STATUS_PULSE_ANIMATION_NAME) return;
  for (const animation of event.currentTarget.getAnimations()) {
    if ("animationName" in animation && animation.animationName === STATUS_PULSE_ANIMATION_NAME) {
      animation.startTime = 0;
    }
  }
}
