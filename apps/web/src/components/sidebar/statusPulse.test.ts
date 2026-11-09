import type { AnimationEvent } from "react";
import { describe, expect, it } from "vitest";

import { synchronizeStatusPulse } from "./statusPulse";

function animationEvent(animationName: string, animations: Animation[]) {
  return {
    animationName,
    currentTarget: { getAnimations: () => animations },
  } as unknown as AnimationEvent<Element>;
}

describe("synchronizeStatusPulse", () => {
  it("pins only the status pulse to the document clock", () => {
    const pulse = { animationName: "status-pulse", startTime: 975 } as unknown as Animation;
    const otherCss = { animationName: "status-ping", startTime: 125 } as unknown as Animation;
    const otherAnimation = { startTime: 250 } as Animation;

    synchronizeStatusPulse(animationEvent("status-pulse", [pulse, otherCss, otherAnimation]));

    expect([pulse.startTime, otherCss.startTime, otherAnimation.startTime]).toEqual([0, 125, 250]);
  });

  it("ignores animation starts for other animations", () => {
    const pulse = { animationName: "status-pulse", startTime: 975 } as unknown as Animation;

    synchronizeStatusPulse(animationEvent("status-ping", [pulse]));

    expect(pulse.startTime).toBe(975);
  });
});
