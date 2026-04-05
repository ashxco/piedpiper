import { memo, useEffect, useRef, useState, type ReactNode } from "react";

import { SPINNERS, type SpinnerDef } from "./unicodeSpinnerFrames";

interface UnicodeSpinnerProps {
  /** Tailwind class(es) applied to lit pixels (e.g. "bg-sky-500 dark:bg-sky-300/80"). */
  colorClass: string;
  /** Side length of each pixel, in px. */
  pixel?: number;
  /** Gap between pixels, in px. */
  gap?: number;
}

const MIN_SWITCH_MS = 5000;
const MAX_SWITCH_MS = 10000;

function shuffledSpinners(): SpinnerDef[] {
  const arr = SPINNERS.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
  return arr;
}

function pickSwitchDelay(): number {
  return MIN_SWITCH_MS + Math.random() * (MAX_SWITCH_MS - MIN_SWITCH_MS);
}

function pickInitial(): { queue: SpinnerDef[]; current: SpinnerDef } {
  const queue = shuffledSpinners();
  const current = queue.pop()!;
  return { queue, current };
}

/**
 * Renders a 4x4 pixel-art spinner that cycles through all 12 spinner designs
 * from {@link SPINNERS} in random order, swapping to a new design every
 * 5–10 seconds (uniform random). The intra-spinner frame rate is each
 * spinner's own `interval`.
 */
export const UnicodeSpinner = memo(function UnicodeSpinner({
  colorClass,
  pixel = 2,
  gap = 1,
}: UnicodeSpinnerProps) {
  const queueRef = useRef<SpinnerDef[] | null>(null);
  const currentRef = useRef<SpinnerDef | null>(null);
  const frameIdxRef = useRef(0);
  const lastFrameAtRef = useRef(0);
  const nextSwitchAtRef = useRef(0);
  const [, forceRender] = useState(0);

  if (queueRef.current === null || currentRef.current === null) {
    const initial = pickInitial();
    queueRef.current = initial.queue;
    currentRef.current = initial.current;
    frameIdxRef.current = 0;
  }

  useEffect(() => {
    const now0 = performance.now();
    lastFrameAtRef.current = now0;
    nextSwitchAtRef.current = now0 + pickSwitchDelay();

    let raf = 0;
    const loop = (now: number) => {
      const current = currentRef.current;
      if (current) {
        let changed = false;

        if (now - lastFrameAtRef.current >= current.interval) {
          lastFrameAtRef.current = now;
          frameIdxRef.current = (frameIdxRef.current + 1) % current.frames.length;
          changed = true;
        }

        if (now >= nextSwitchAtRef.current) {
          let queue = queueRef.current ?? [];
          if (queue.length === 0) {
            queue = shuffledSpinners();
            // Avoid an immediate back-to-back repeat across a reshuffle.
            if (queue.length > 1 && queue[queue.length - 1]?.name === current.name) {
              const last = queue.pop()!;
              queue.unshift(last);
            }
          }
          const next = queue.pop()!;
          queueRef.current = queue;
          currentRef.current = next;
          frameIdxRef.current = 0;
          lastFrameAtRef.current = now;
          nextSwitchAtRef.current = now + pickSwitchDelay();
          changed = true;
        }

        if (changed) forceRender((t) => t + 1);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const current = currentRef.current!;
  const mask = current.frames[frameIdxRef.current] ?? 0;
  const total = pixel * 4 + gap * 3;

  const cells: ReactNode[] = [];
  for (let i = 0; i < 16; i++) {
    const on = (mask & (1 << i)) !== 0;
    cells.push(<span key={i} className={on ? colorClass : ""} style={{ display: "block" }} />);
  }

  return (
    <span
      aria-hidden="true"
      className="inline-grid shrink-0"
      style={{
        width: `${total}px`,
        height: `${total}px`,
        gridTemplateColumns: `repeat(4, ${pixel}px)`,
        gridTemplateRows: `repeat(4, ${pixel}px)`,
        gap: `${gap}px`,
      }}
    >
      {cells}
    </span>
  );
});

// ---------------------------------------------------------------------------
// Braille Unicode strip — 5 animations from the reference HTML, tiled wide.
// ---------------------------------------------------------------------------

interface BrailleStripAnim {
  name: string;
  /** Each frame is a string of braille characters (one "tile"). */
  frames: string[];
  /** ms per frame. */
  interval: number;
}

const STRIP_ANIMS: BrailleStripAnim[] = [
  {
    name: "rain",
    interval: 100,
    frames: [
      "\u2809\u2821\u2812\u2882\u280C\u2824\u2850\u28C0",
      "\u280A\u2881\u2822\u280A\u2814\u2884\u2860\u2848",
      "\u280C\u280A\u2882\u2814\u2824\u2848\u28C0\u2811",
      "\u2850\u2814\u280C\u2860\u28C0\u2811\u2809\u2822",
      "\u2811\u2824\u2814\u28C0\u2848\u2821\u2811\u2882",
      "\u2812\u28C0\u2824\u2809\u2850\u2882\u2821\u280C",
      "\u2824\u2809\u28C0\u2812\u2821\u280C\u2882\u2850",
      "\u2860\u2811\u2848\u2822\u2881\u2814\u280A\u2860",
      "\u2821\u2822\u2850\u2884\u2809\u2860\u2812\u2881",
      "\u2882\u2884\u2821\u2848\u2812\u2881\u2824\u280A",
      "\u2884\u280C\u2881\u2850\u2822\u2809\u2884\u2812",
      "\u28C0\u2850\u2809\u2821\u2882\u2812\u280C\u2824",
    ],
  },
  {
    name: "pulse",
    interval: 200,
    frames: [
      "\u2800\u2800\u2830\u2806\u2800\u2800",
      "\u2800\u2800\u28B6\u286D\u2800\u2800",
      "\u2800\u2830\u28FF\u28FF\u2806\u2800",
      "\u2830\u28BE\u28C9\u28C9\u2877\u2806",
      "\u28CF\u2800\u2800\u2800\u2800\u28F9",
      "\u2841\u2800\u2800\u2800\u2800\u2888",
    ],
  },
  {
    name: "sparkle",
    interval: 150,
    frames: [
      "\u2808\u2820\u2802\u2821\u2810\u2840\u280C\u2880",
      "\u2880\u2802\u2884\u2808\u2881\u2820\u2802\u2802",
      "\u2804\u2848\u2810\u2840\u2804\u280A\u2800\u2821",
      "\u2850\u2880\u2801\u2822\u2808\u2880\u2820\u2810",
      "\u2820\u2801\u2860\u2810\u2802\u2801\u2840\u280C",
      "\u2802\u2884\u2808\u2804\u2840\u2811\u2810\u2880",
    ],
  },
  {
    name: "helix",
    interval: 256,
    frames: [
      "\u28C9\u2836\u28C9\u2871\u288E\u28C9\u2836\u28C9",
      "\u2871\u288E\u28C9\u2836\u28C9\u2871\u288E\u28C9",
      "\u2836\u28C9\u2871\u288E\u28C9\u2836\u28C9\u2871",
      "\u288E\u28C9\u2836\u28C9\u2871\u288E\u28C9\u2836",
      "\u28C9\u2871\u288E\u28C9\u2836\u28C9\u2871\u288E",
    ],
  },
  {
    name: "checkerboard",
    interval: 250,
    frames: [
      "\u2895\u286A\u288A\u2814\u2895\u286A",
      "\u286A\u288A\u2814\u2895\u286A\u288A",
      "\u288A\u2814\u2895\u286A\u288A\u2814",
      "\u2814\u2895\u286A\u288A\u2814\u2895",
    ],
  },
];

const STRIP_SWITCH_MS = 10_000;
const STRIP_COLORS = ["#ffffff", "#b0ffb0", "#b0e8ff", "#ffb0b0"];

function pickRandomStripAnim(exclude?: string): BrailleStripAnim {
  const candidates = exclude ? STRIP_ANIMS.filter((a) => a.name !== exclude) : STRIP_ANIMS;
  return candidates[Math.floor(Math.random() * candidates.length)] ?? STRIP_ANIMS[0]!;
}

interface UnicodeSpinnerStripProps {
  className?: string;
}

/**
 * A wide braille Unicode character strip. Tiles a braille animation pattern
 * across the full width with phase offsets per tile. Switches between 5
 * animations (rain, pulse, sparkle, helix, checkerboard) every 10 seconds.
 */
export const UnicodeSpinnerStrip = memo(function UnicodeSpinnerStrip({
  className,
}: UnicodeSpinnerStripProps) {
  const animRef = useRef<BrailleStripAnim>(pickRandomStripAnim());
  const frameIdxRef = useRef(0);
  const lastFrameAtRef = useRef(0);
  const nextSwitchAtRef = useRef(0);
  const colorIdxRef = useRef(0);
  const [, forceRender] = useState(0);

  useEffect(() => {
    const now0 = performance.now();
    lastFrameAtRef.current = now0;
    nextSwitchAtRef.current = now0 + STRIP_SWITCH_MS;

    let raf = 0;
    const loop = (now: number) => {
      const anim = animRef.current;
      let changed = false;

      if (now - lastFrameAtRef.current >= anim.interval) {
        lastFrameAtRef.current = now;
        frameIdxRef.current = (frameIdxRef.current + 1) % anim.frames.length;
        changed = true;
      }

      if (now >= nextSwitchAtRef.current) {
        const next = pickRandomStripAnim(anim.name);
        animRef.current = next;
        frameIdxRef.current = 0;
        lastFrameAtRef.current = now;
        nextSwitchAtRef.current = now + STRIP_SWITCH_MS;
        colorIdxRef.current = (colorIdxRef.current + 1) % STRIP_COLORS.length;
        changed = true;
      }

      if (changed) forceRender((t) => t + 1);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const anim = animRef.current;
  const strip = anim.frames[frameIdxRef.current] ?? "";
  const color = STRIP_COLORS[colorIdxRef.current] ?? STRIP_COLORS[0];

  return (
    <span
      aria-hidden="true"
      className={className}
      style={{ letterSpacing: "2px", color, transition: "color 2s ease" }}
    >
      {strip}
    </span>
  );
});
