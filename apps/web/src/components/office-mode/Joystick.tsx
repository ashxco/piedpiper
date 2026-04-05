import { MoveIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

const JOYSTICK_RADIUS = 28;
const KNOB_RADIUS = 14;
const MAX_PAN_SPEED = 12;

/**
 * Floating circular joystick that pans the office tile container.
 *
 * The user drags the inner knob away from center; the displacement is
 * mapped to a continuous scroll velocity (px/frame) applied via rAF.
 * Releasing the knob snaps it back and stops the scroll.
 */
export function Joystick({
  containerRef,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>;
}) {
  const baseRef = useRef<HTMLDivElement>(null);
  const [knobOffset, setKnobOffset] = useState({ x: 0, y: 0 });
  const draggingRef = useRef(false);
  const rafRef = useRef(0);
  const velocityRef = useRef({ dx: 0, dy: 0 });

  // Animation loop — runs while knob is displaced
  useEffect(() => {
    const tick = () => {
      const el = containerRef.current;
      const { dx, dy } = velocityRef.current;
      if (el && (dx !== 0 || dy !== 0)) {
        el.scrollLeft += dx;
        el.scrollTop += dy;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [containerRef]);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    const base = baseRef.current;
    if (!base) return;
    base.setPointerCapture(e.pointerId);
    draggingRef.current = true;
  }, []);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!draggingRef.current || !baseRef.current) return;
    const rect = baseRef.current.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    let dx = e.clientX - cx;
    let dy = e.clientY - cy;

    // Clamp to circle
    const dist = Math.sqrt(dx * dx + dy * dy);
    const maxDist = JOYSTICK_RADIUS - KNOB_RADIUS / 2;
    if (dist > maxDist) {
      dx = (dx / dist) * maxDist;
      dy = (dy / dist) * maxDist;
    }

    setKnobOffset({ x: dx, y: dy });

    // Map displacement to scroll velocity
    const normX = dx / maxDist;
    const normY = dy / maxDist;
    velocityRef.current = {
      dx: normX * MAX_PAN_SPEED,
      dy: normY * MAX_PAN_SPEED,
    };
  }, []);

  const handlePointerUp = useCallback(() => {
    draggingRef.current = false;
    setKnobOffset({ x: 0, y: 0 });
    velocityRef.current = { dx: 0, dy: 0 };
  }, []);

  return (
    <div
      ref={baseRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerUp}
      style={{
        position: "absolute",
        bottom: 20,
        right: 20,
        zIndex: 999999,
        width: JOYSTICK_RADIUS * 2,
        height: JOYSTICK_RADIUS * 2,
        borderRadius: "50%",
        backgroundColor: "rgba(0,0,0,0.3)",
        border: "1px solid rgba(255,255,255,0.15)",
        backdropFilter: "blur(8px)",
        cursor: "grab",
        touchAction: "none",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          width: KNOB_RADIUS * 2,
          height: KNOB_RADIUS * 2,
          borderRadius: "50%",
          backgroundColor: "rgba(255,255,255,0.5)",
          border: "1px solid rgba(255,255,255,0.3)",
          transform: `translate(${knobOffset.x}px, ${knobOffset.y}px)`,
          transition: draggingRef.current ? "none" : "transform 0.15s ease-out",
          pointerEvents: "none",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <MoveIcon size={14} color="rgba(0,0,0,0.5)" />
      </div>
    </div>
  );
}
