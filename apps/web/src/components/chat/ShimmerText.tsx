import { memo, type ReactNode } from "react";

import { cn } from "~/lib/utils";

interface ShimmerTextProps {
  readonly children: ReactNode;
  readonly className?: string;
  readonly active?: boolean;
}

/**
 * Animates a soft highlight band sliding across the text — used to
 * indicate in-progress agent actions ("Working for 12s", "Reading
 * /src/foo.ts", etc.). Reuses the `skeleton` keyframe the `Skeleton`
 * block component uses, with a stepped timing so it repaints ~15 times a
 * second, applied to text via `background-clip: text` so the glyphs shimmer.
 */
export const ShimmerText = memo(function ShimmerText(props: ShimmerTextProps) {
  const { children, className, active = true } = props;
  if (!active) {
    return <span className={className}>{children}</span>;
  }
  return (
    <span
      className={cn(
        "animate-shimmer-text bg-clip-text text-transparent",
        "[background-image:linear-gradient(120deg,var(--color-muted-foreground)_40%,var(--color-foreground)_50%,var(--color-muted-foreground)_60%)]",
        "[background-size:200%_100%]",
        className,
      )}
    >
      {children}
    </span>
  );
});
