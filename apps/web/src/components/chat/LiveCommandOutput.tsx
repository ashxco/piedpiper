import { TerminalIcon } from "lucide-react";
import { useLayoutEffect, useRef } from "react";

import { sanitizeLiveCommandOutput } from "~/lib/liveCommandOutput";
import { type ToolInputStream } from "../../types";

const MAX_OUTPUT_HEIGHT_PX = 180;
const FOLLOW_BOTTOM_THRESHOLD_PX = 16;

/** Plain output of a running command; follows the end unless the reader scrolled up. */
export function LiveCommandOutput(props: {
  readonly stream: ToolInputStream;
  /** Tells parallel panels apart; falls back to a generic title. */
  readonly command?: string | undefined;
}) {
  const text = sanitizeLiveCommandOutput(props.stream.text);
  const scrollRef = useRef<HTMLPreElement | null>(null);
  const followRef = useRef(true);

  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (node && followRef.current) node.scrollTop = node.scrollHeight;
  }, [text]);

  return (
    <div className="overflow-hidden rounded-md border border-border/55 bg-card/55">
      <div className="flex items-center gap-2 border-b border-border/40 bg-card/80 px-2.5 py-1.5">
        <TerminalIcon className="size-3 shrink-0 text-muted-foreground/65" aria-hidden="true" />
        <span
          className="min-w-0 truncate font-mono text-[11px] text-foreground/85"
          title={props.command}
        >
          {props.command ?? "Output"}
        </span>
      </div>
      <pre
        ref={scrollRef}
        onScroll={(event) => {
          const node = event.currentTarget;
          followRef.current =
            node.scrollHeight - node.clientHeight - node.scrollTop <= FOLLOW_BOTTOM_THRESHOLD_PX;
        }}
        className="overflow-y-auto whitespace-pre-wrap wrap-break-word bg-gray-50 px-3 py-2 font-mono text-[11px] leading-relaxed text-foreground/85 dark:bg-[#0d0d0d]"
        style={{ maxHeight: `${MAX_OUTPUT_HEIGHT_PX}px` }}
      >
        {text}
      </pre>
    </div>
  );
}
