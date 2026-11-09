import {
  Suspense,
  forwardRef,
  lazy,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import type { TimestampFormat } from "@piedpiper/contracts/settings";
import type { ActivePlanState, LatestProposedPlanState } from "../../session-logic";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { Sheet, SheetPopup } from "../ui/sheet";

const PlanSidebar = lazy(() => import("../PlanSidebar"));

/** Below this width the inline 340px plan sidebar squeezes the composer, so it becomes a sheet. */
const PLAN_SIDEBAR_SHEET_MEDIA_QUERY = "(max-width: 1180px)";

export interface ChatPlanPanelOpenOptions {
  /** Open even as a sheet; only for explicit user actions, since the sheet covers the chat. */
  evenAsSheet?: boolean;
}

export interface ChatPlanPanelHandle {
  /** Programmatic open; skipped on narrow windows unless `evenAsSheet` is set. */
  open: (options?: ChatPlanPanelOpenOptions) => void;
  close: () => void;
  toggle: (activePlanTurnId: string | null, sidebarPlanTurnId: string | null) => void;
  /** Signal that the sidebar should open on the next thread-change reset. */
  setOpenOnNextThread: () => void;
}

export interface ChatPlanPanelProps {
  /** Thread id — resets open state on change. */
  threadId: string | null;
  activePlan: ActivePlanState | null;
  activeProposedPlan: LatestProposedPlanState | null;
  markdownCwd: string | undefined;
  workspaceRoot: string | undefined;
  timestampFormat: TimestampFormat;
  /** Fires whenever the internal open state changes. */
  onOpenChange: (open: boolean) => void;
}

/**
 * Self-contained plan sidebar panel.
 *
 * Owns `planSidebarOpen` and the dismissed-for-turn tracking. ChatView
 * receives open-state changes via `onOpenChange` for composer footer rendering,
 * and sends imperative commands through the `ChatPlanPanelHandle` ref.
 */
export const ChatPlanPanel = forwardRef<ChatPlanPanelHandle, ChatPlanPanelProps>(
  function ChatPlanPanel(
    {
      threadId,
      activePlan,
      activeProposedPlan,
      markdownCwd,
      workspaceRoot,
      timestampFormat,
      onOpenChange,
    },
    ref,
  ) {
    const [planSidebarOpen, setPlanSidebarOpen] = useState(false);
    const useSheet = useMediaQuery(PLAN_SIDEBAR_SHEET_MEDIA_QUERY);
    const planSidebarDismissedForTurnRef = useRef<string | null>(null);
    const planSidebarOpenOnNextThreadRef = useRef(false);
    const onOpenChangeRef = useRef(onOpenChange);
    onOpenChangeRef.current = onOpenChange;
    const useSheetRef = useRef(useSheet);
    useSheetRef.current = useSheet;

    const setOpen = useCallback((next: boolean) => {
      setPlanSidebarOpen((prev) => {
        if (prev === next) return prev;
        onOpenChangeRef.current(next);
        return next;
      });
    }, []);

    useImperativeHandle(
      ref,
      () => ({
        open: (options) => {
          planSidebarDismissedForTurnRef.current = null;
          if (useSheetRef.current && !options?.evenAsSheet) return;
          setOpen(true);
        },
        close: () => setOpen(false),
        toggle: (activePlanTurnId, sidebarPlanTurnId) => {
          setPlanSidebarOpen((prev) => {
            const next = !prev;
            if (prev) {
              // Closing — record the turn as dismissed.
              const turnKey = activePlanTurnId ?? sidebarPlanTurnId ?? null;
              if (turnKey) {
                planSidebarDismissedForTurnRef.current = turnKey;
              }
            } else {
              planSidebarDismissedForTurnRef.current = null;
            }
            onOpenChangeRef.current(next);
            return next;
          });
        },
        setOpenOnNextThread: () => {
          planSidebarOpenOnNextThreadRef.current = true;
        },
      }),
      [setOpen],
    );

    // Reset on thread change.
    useEffect(() => {
      if (planSidebarOpenOnNextThreadRef.current) {
        planSidebarOpenOnNextThreadRef.current = false;
        // An automatic open would put a modal sheet over the new thread on narrow windows.
        setOpen(!useSheetRef.current);
      } else {
        setOpen(false);
      }
      planSidebarDismissedForTurnRef.current = null;
    }, [threadId, setOpen]);

    const handleClose = useCallback(() => {
      setOpen(false);
      const turnKey = activePlan?.turnId ?? activeProposedPlan?.turnId ?? null;
      if (turnKey) {
        planSidebarDismissedForTurnRef.current = turnKey;
      }
    }, [activePlan?.turnId, activeProposedPlan?.turnId, setOpen]);

    const renderPlanSidebar = (mode: "sheet" | "sidebar") => (
      <Suspense fallback={null}>
        <PlanSidebar
          activePlan={activePlan}
          activeProposedPlan={activeProposedPlan}
          markdownCwd={markdownCwd}
          workspaceRoot={workspaceRoot}
          threadId={threadId ?? undefined}
          timestampFormat={timestampFormat}
          mode={mode}
          onClose={handleClose}
        />
      </Suspense>
    );

    if (useSheet) {
      return (
        <Sheet
          open={planSidebarOpen}
          onOpenChange={(open) => {
            if (!open) handleClose();
          }}
        >
          <SheetPopup
            side="right"
            aria-label="Plan"
            showCloseButton={false}
            className="w-[min(88vw,400px)] max-w-[400px] p-0"
            style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
          >
            {planSidebarOpen ? renderPlanSidebar("sheet") : null}
          </SheetPopup>
        </Sheet>
      );
    }

    if (!planSidebarOpen) return null;

    return renderPlanSidebar("sidebar");
  },
);
