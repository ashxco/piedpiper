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

const PlanSidebar = lazy(() => import("../PlanSidebar"));

export interface ChatPlanPanelHandle {
  open: () => void;
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
    const planSidebarDismissedForTurnRef = useRef<string | null>(null);
    const planSidebarOpenOnNextThreadRef = useRef(false);
    const onOpenChangeRef = useRef(onOpenChange);
    onOpenChangeRef.current = onOpenChange;

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
        open: () => {
          planSidebarDismissedForTurnRef.current = null;
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
        setOpen(true);
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

    if (!planSidebarOpen) return null;

    return (
      <Suspense fallback={null}>
        <PlanSidebar
          activePlan={activePlan}
          activeProposedPlan={activeProposedPlan}
          markdownCwd={markdownCwd}
          workspaceRoot={workspaceRoot}
          timestampFormat={timestampFormat}
          onClose={handleClose}
        />
      </Suspense>
    );
  },
);
