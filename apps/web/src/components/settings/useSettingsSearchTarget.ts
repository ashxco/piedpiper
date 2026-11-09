import { useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { getSmoothScrollBehavior } from "../../chat-scroll";

const PULSE_DURATION_MS = 900;
// A target on another tab appears only once that route has rendered.
const MAX_LOOKUP_FRAMES = 120;

/**
 * Scrolls a setting into view, focuses it and pulses it. Calling it again pulses again. Reduced
 * motion only drops the smooth scroll: the pulse is a colour fade and the one visible cue.
 */
export function revealSettingsTarget(target: HTMLElement): void {
  target.scrollIntoView({ behavior: getSmoothScrollBehavior(), block: "center" });
  target.focus({ preventScroll: true });
  // A section's card is opaque and would hide a background on the section itself.
  const surface = target.querySelector<HTMLElement>(":scope > [data-settings-card]") ?? target;
  surface.animate([{ backgroundColor: "var(--accent)", offset: 0 }], {
    duration: PULSE_DURATION_MS,
    iterations: 2,
    easing: "ease-out",
  });
}

/** Reveals the element the URL hash names, then clears the hash so the same result can repeat. */
export function useSettingsSearchTarget(): void {
  const hash = useLocation({ select: (location) => location.hash });
  const pathname = useLocation({ select: (location) => location.pathname });
  const navigate = useNavigate();

  useEffect(() => {
    if (!hash) return;
    let frame = 0;
    let remainingFrames = MAX_LOOKUP_FRAMES;
    const lookUp = () => {
      const target = document.getElementById(hash);
      if (!target && remainingFrames > 0) {
        remainingFrames -= 1;
        frame = requestAnimationFrame(lookUp);
        return;
      }
      if (target) revealSettingsTarget(target);
      void navigate({ to: pathname, hash: "", replace: true, hashScrollIntoView: false });
    };
    lookUp();
    return () => cancelAnimationFrame(frame);
  }, [hash, pathname, navigate]);
}
