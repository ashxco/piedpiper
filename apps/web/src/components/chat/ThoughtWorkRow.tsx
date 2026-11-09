import { BrainIcon, ChevronRightIcon } from "lucide-react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";

import { type WorkLogEntry } from "../../session-logic";
import { workGroupConsumesUpwardScroll } from "./MessagesTimeline.logic";
import { ShimmerText } from "./ShimmerText";
import {
  isAtThoughtLiveEdge,
  thoughtPreviewLine,
  thoughtWorkRowIsStreaming,
} from "./ThoughtWorkRow.logic";

/** A thinking block: a one-line preview that opens into a capped, end-following scroller. */
export function ThoughtWorkRow(props: {
  text: string;
  streaming: boolean;
  expanded: boolean;
  onToggle: () => void;
  timestamp?: ReactNode;
}) {
  const { text, streaming, expanded, onToggle, timestamp } = props;
  const label = streaming ? "Thinking" : "Thought";
  // Every streamed chunk re-renders this, and an open row shows the text instead.
  const preview = expanded ? "" : thoughtPreviewLine(text);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const atLiveEdgeRef = useRef(true);
  // ChatView reads an upward wheel or touch as leaving the bottom, but this scroll stays in here.
  const keepUpwardScrollInside = (event: {
    target: EventTarget;
    currentTarget: HTMLDivElement;
    stopPropagation: () => void;
  }) => {
    if (
      event.target instanceof Element &&
      workGroupConsumesUpwardScroll(event.target, event.currentTarget)
    ) {
      event.stopPropagation();
    }
  };
  // No deps: every streamed chunk re-renders this, and pinning before paint avoids a visible jump.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (streaming && atLiveEdgeRef.current && scroller) {
      scroller.scrollTop = scroller.scrollHeight;
    }
  });

  return (
    <div className="rounded-lg px-1 py-1">
      <div className="group/timeline-row relative flex items-center gap-2">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          aria-expanded={expanded}
          onClick={onToggle}
        >
          <span className="flex size-5 shrink-0 items-center justify-center text-foreground/80">
            <BrainIcon className="size-3" />
          </span>
          <span className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden text-sm">
            {streaming ? (
              <ShimmerText className="shrink-0">{label}</ShimmerText>
            ) : (
              <span className="shrink-0 text-muted-foreground/70">{label}</span>
            )}
            {!expanded && preview.length > 0 && (
              <span className="truncate text-muted-foreground/50">{preview}</span>
            )}
          </span>
          <ChevronRightIcon
            className={cn(
              "size-3 shrink-0 text-muted-foreground/50 transition-transform duration-150",
              expanded && "rotate-90",
            )}
          />
        </button>
        {timestamp}
      </div>
      {expanded && (
        <div
          ref={scrollerRef}
          onScroll={(event) => {
            atLiveEdgeRef.current = isAtThoughtLiveEdge(event.currentTarget);
          }}
          onTouchMove={keepUpwardScrollInside}
          onWheel={(event) => {
            if (event.deltaY < 0) keepUpwardScrollInside(event);
          }}
          className="mt-1 ml-7 max-h-48 overflow-y-auto text-sm whitespace-pre-wrap break-words text-muted-foreground/70"
        >
          {text}
        </div>
      )}
    </div>
  );
}

/** The row for one thinking work entry; collapsed until the reader opens it. */
export function ThoughtWorkEntryRow(props: {
  workEntry: Pick<WorkLogEntry, "label" | "detail">;
  turnRunning: boolean;
  timestamp?: ReactNode;
  /** Survives a virtualizer remount, which would otherwise close the row. */
  defaultExpanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(props.defaultExpanded ?? false);
  return (
    <ThoughtWorkRow
      text={props.workEntry.detail ?? ""}
      streaming={thoughtWorkRowIsStreaming(props.workEntry, props.turnRunning)}
      expanded={expanded}
      onToggle={() => {
        const next = !expanded;
        setExpanded(next);
        props.onExpandedChange?.(next);
      }}
      timestamp={props.timestamp}
    />
  );
}
