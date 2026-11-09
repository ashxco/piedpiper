import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import {
  createContext,
  use,
  useEffect,
  useMemo,
  useRef,
  type ComponentProps,
  type RefObject,
} from "react";

import { cn } from "~/lib/utils";
import { appCollisionPadding } from "./tooltipCollisionPadding";

const TooltipProvider = TooltipPrimitive.Provider;

/** Auto-scroll has no user input behind it, so it leaves hover tooltips alone. */
const USER_SCROLL_INPUT_WINDOW_MS = 400;

type TooltipActionsRef = RefObject<TooltipPrimitive.Root.Actions | null>;

interface HoveredTooltip {
  readonly trigger: HTMLElement;
  readonly actionsRef: TooltipActionsRef;
  // A pending hover-open survives `close()` in Base UI, so `Tooltip` cancels it through this flag.
  readonly dismissedRef: RefObject<boolean>;
}

// Module-level because the React Compiler rejects writing to a context value in a component.
function setHovered(hovered: RefObject<HoveredTooltip | null>, value: HoveredTooltip | null) {
  hovered.current = value;
}

function setDismissed(hoverContext: Pick<HoveredTooltip, "dismissedRef">, value: boolean) {
  hoverContext.dismissedRef.current = value;
}

// Keyboard focus only: Chromium leaves focus on a clicked button, which must not pin its tooltip.
function hasKeyboardFocus(trigger: HTMLElement): boolean {
  return trigger.matches(":focus-visible") || trigger.querySelector(":focus-visible") !== null;
}

const TooltipScrollContext = createContext<RefObject<HoveredTooltip | null> | null>(null);
const TooltipHoverContext = createContext<Pick<
  HoveredTooltip,
  "actionsRef" | "dismissedRef"
> | null>(null);

/** Dismisses the hovered descendant tooltip when the user scrolls; takes a plain div's props. */
function TooltipScrollDismissArea({
  onKeyDownCapture,
  onScrollCapture,
  onTouchMoveCapture,
  onWheelCapture,
  ...props
}: ComponentProps<"div">) {
  const hovered = useRef<HoveredTooltip | null>(null);
  const lastUserInputAt = useRef(Number.NEGATIVE_INFINITY);
  const markUserInput = () => {
    lastUserInputAt.current = performance.now();
  };
  return (
    <TooltipScrollContext value={hovered}>
      <div
        {...props}
        onKeyDownCapture={(event) => {
          onKeyDownCapture?.(event);
          markUserInput();
        }}
        onScrollCapture={(event) => {
          onScrollCapture?.(event);
          const tooltip = hovered.current;
          if (
            !tooltip ||
            performance.now() - lastUserInputAt.current > USER_SCROLL_INPUT_WINDOW_MS ||
            hasKeyboardFocus(tooltip.trigger)
          ) {
            return;
          }
          hovered.current = null;
          tooltip.dismissedRef.current = true;
          tooltip.actionsRef.current?.close();
        }}
        onTouchMoveCapture={(event) => {
          onTouchMoveCapture?.(event);
          markUserInput();
        }}
        onWheelCapture={(event) => {
          onWheelCapture?.(event);
          markUserInput();
        }}
      />
    </TooltipScrollContext>
  );
}

function Tooltip<Payload>(props: TooltipPrimitive.Root.Props<Payload>) {
  const hovered = use(TooltipScrollContext);
  const localActionsRef = useRef<TooltipPrimitive.Root.Actions | null>(null);
  const dismissedRef = useRef(false);
  const actionsRef = props.actionsRef ?? localActionsRef;
  const hoverContext = useMemo(() => ({ actionsRef, dismissedRef }), [actionsRef]);
  useEffect(
    () => () => {
      if (hovered?.current?.actionsRef === actionsRef) setHovered(hovered, null);
    },
    [actionsRef, hovered],
  );

  if (!hovered) return <TooltipPrimitive.Root {...props} />;
  return (
    <TooltipHoverContext value={hoverContext}>
      <TooltipPrimitive.Root
        {...props}
        actionsRef={actionsRef}
        onOpenChange={(open, details) => {
          if (open && dismissedRef.current && details.reason === "trigger-hover") {
            details.cancel();
            return;
          }
          props.onOpenChange?.(open, details);
          if (!open && !details.isCanceled && hovered.current?.actionsRef === actionsRef) {
            setHovered(hovered, null);
          }
        }}
      />
    </TooltipHoverContext>
  );
}

function TooltipTrigger(props: TooltipPrimitive.Trigger.Props) {
  const hovered = use(TooltipScrollContext);
  const hoverContext = use(TooltipHoverContext);
  if (!hovered || !hoverContext) {
    return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
  }
  return (
    <TooltipPrimitive.Trigger
      data-slot="tooltip-trigger"
      {...props}
      onMouseEnter={(event) => {
        props.onMouseEnter?.(event);
        setDismissed(hoverContext, false);
        setHovered(hovered, { trigger: event.currentTarget, ...hoverContext });
      }}
      onMouseMove={(event) => {
        props.onMouseMove?.(event);
        // Browsers send zero-movement moves after a scroll; only a real move rearms the tooltip.
        if (event.movementX === 0 && event.movementY === 0) return;
        setDismissed(hoverContext, false);
        setHovered(hovered, { trigger: event.currentTarget, ...hoverContext });
      }}
    />
  );
}

function TooltipPopup({
  className,
  align = "center",
  sideOffset = 4,
  side = "top",
  anchor,
  children,
  ...props
}: TooltipPrimitive.Popup.Props & {
  align?: TooltipPrimitive.Positioner.Props["align"];
  side?: TooltipPrimitive.Positioner.Props["side"];
  sideOffset?: TooltipPrimitive.Positioner.Props["sideOffset"];
  anchor?: TooltipPrimitive.Positioner.Props["anchor"];
}) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner
        align={align}
        anchor={anchor}
        collisionPadding={appCollisionPadding}
        className="z-50 max-w-(--available-width) transition-[top,left,right,bottom,transform] data-instant:transition-none"
        data-slot="tooltip-positioner"
        side={side}
        sideOffset={sideOffset}
      >
        <TooltipPrimitive.Popup
          className={cn(
            "relative flex origin-(--transform-origin) text-balance rounded-md border border-foreground/15 bg-popover text-popover-foreground text-xs shadow-[0_4px_12px_-3px_rgba(0,0,0,0.3),0_1px_3px_rgba(0,0,0,0.2)] transition-[scale,opacity] data-ending-style:scale-98 data-starting-style:scale-98 data-ending-style:opacity-0 data-starting-style:opacity-0 data-instant:duration-0",
            className,
          )}
          data-slot="tooltip-popup"
          {...props}
        >
          <div className="px-2 py-1" data-slot="tooltip-viewport">
            {children}
          </div>
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  );
}

export { TooltipProvider, Tooltip, TooltipTrigger, TooltipPopup, TooltipScrollDismissArea };
