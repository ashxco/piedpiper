import {
  type LucideIcon,
  Plus,
  Square,
  SquareSplitHorizontal,
  SquareSplitVertical,
  TerminalSquare,
  Trash2,
  XIcon,
} from "lucide-react";
import { type ThreadId } from "@piedpiper/contracts";
import {
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { type TerminalContextSelection } from "~/lib/terminalContext";
import { useServerKeybindings } from "../rpc/serverState";
import {
  DEFAULT_THREAD_TERMINAL_HEIGHT,
  DEFAULT_THREAD_TERMINAL_ID,
  MAX_TERMINALS_PER_GROUP,
} from "../types";
import { terminalNumberLabelById } from "~/lib/terminalNumbering";
import { workspaceAreaProps } from "../lib/workspaceFocus";
import { readNativeApi } from "~/nativeApi";
import { useSettings } from "~/hooks/useSettings";
import { type ThreadTerminalLayoutGroup } from "../terminalStateStore";
import { confirmTerminalCloseIfRunning } from "../terminalCloseConfirmation";
import { useTerminalCommandLabels } from "~/terminalTabStateStore";
import { createTerminalViewport } from "./terminalViewport";

const MIN_DRAWER_HEIGHT = 180;
const MAX_DRAWER_HEIGHT_RATIO = 0.75;
// Below MIN_DRAWER_HEIGHT only when the column has no more room; a terminal stays usable here.
const MIN_FITTED_DRAWER_HEIGHT = 120;
export function resolveTerminalDrawerMaxHeight(input: {
  viewportHeight: number;
  chatColumnHeight?: number;
  headerHeight?: number;
  composerHeight?: number;
}): number {
  const windowCap = Math.max(
    MIN_DRAWER_HEIGHT,
    Math.floor(input.viewportHeight * MAX_DRAWER_HEIGHT_RATIO),
  );
  if (input.chatColumnHeight === undefined) return windowCap;
  const freeHeight =
    input.chatColumnHeight - (input.headerHeight ?? 0) - (input.composerHeight ?? 0);
  return Math.min(windowCap, Math.max(MIN_FITTED_DRAWER_HEIGHT, freeHeight));
}

function findChatColumn(drawer: HTMLElement | null): HTMLElement | null {
  return drawer?.closest<HTMLElement>("[data-chat-column]") ?? null;
}

function maxDrawerHeight(drawer: HTMLElement | null): number {
  if (typeof window === "undefined") return DEFAULT_THREAD_TERMINAL_HEIGHT;
  const viewportHeight = window.innerHeight;
  const column = findChatColumn(drawer);
  if (!column) return resolveTerminalDrawerMaxHeight({ viewportHeight });
  return resolveTerminalDrawerMaxHeight({
    viewportHeight,
    chatColumnHeight: column.clientHeight,
    headerHeight: column.querySelector<HTMLElement>("[data-chat-header]")?.offsetHeight ?? 0,
    composerHeight:
      column.querySelector<HTMLElement>("[data-chat-composer-root]")?.offsetHeight ?? 0,
  });
}

// The user's stored drawer height; never capped by the current window size.
export function normalizePreferredDrawerHeight(height: number): number {
  const safeHeight = Number.isFinite(height) ? height : DEFAULT_THREAD_TERMINAL_HEIGHT;
  return Math.max(Math.round(safeHeight), MIN_DRAWER_HEIGHT);
}

export function resolveRenderedDrawerHeight(preferredHeight: number, maxHeight: number): number {
  return Math.min(normalizePreferredDrawerHeight(preferredHeight), maxHeight);
}

function clampDrawerHeight(height: number, drawer: HTMLElement | null): number {
  return resolveRenderedDrawerHeight(height, maxDrawerHeight(drawer));
}

export function terminalGroupHeader(group: ThreadTerminalLayoutGroup): {
  label: string;
  Icon: LucideIcon;
  count: number;
} {
  const count = group.terminalIds.length;
  if (count <= 1) return { label: "Single", Icon: Square, count };
  return group.splitDirection === "vertical"
    ? { label: "Stacked", Icon: SquareSplitVertical, count }
    : { label: "Side by side", Icon: SquareSplitHorizontal, count };
}

// The visible header can repeat ("Single 1" twice), so the name also says which terminals it holds.
export function terminalGroupHeaderAccessibleName(
  header: { label: string; count: number },
  terminalLabels: ReadonlyArray<string>,
): string {
  const noun = header.count === 1 ? "terminal" : "terminals";
  return `${header.label} group, ${header.count} ${noun}: ${terminalLabels.join(", ")}`;
}

interface TerminalViewportProps {
  threadId: ThreadId;
  terminalId: string;
  terminalLabel: string;
  cwd: string;
  runtimeEnv?: Record<string, string>;
  onSessionExited: () => void;
  onAddTerminalContext: (selection: TerminalContextSelection) => void;
  focusRequestId: number;
  autoFocus: boolean;
  resizeEpoch: number;
  drawerHeight: number;
  // Non-null during a drawer drag, which refits once on release.
  drawerDragRef: { readonly current: unknown };
}

function TerminalViewport({
  threadId,
  terminalId,
  terminalLabel,
  cwd,
  runtimeEnv,
  onSessionExited,
  onAddTerminalContext,
  focusRequestId,
  autoFocus,
  resizeEpoch,
  drawerHeight,
  drawerDragRef,
}: TerminalViewportProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<ReturnType<typeof createTerminalViewport> | null>(null);
  const keybindings = useServerKeybindings();
  const readKeybindings = useEffectEvent(() => keybindings);
  const onExit = useEffectEvent(() => onSessionExited());
  const onContext = useEffectEvent((selection: TerminalContextSelection) =>
    onAddTerminalContext(selection),
  );
  const readTerminalLabel = useEffectEvent(() => terminalLabel);
  const readAutoFocus = useEffectEvent(() => autoFocus);
  const isDrawerDragging = useEffectEvent(() => drawerDragRef.current !== null);
  const terminalFontSize = useSettings((settings) => settings.fontSizeTerminal);
  const terminalFontFamily = useSettings((settings) => settings.fontFamilyTerminal);
  const readTerminalFont = useEffectEvent(() => ({
    fontSize: terminalFontSize,
    fontFamily: terminalFontFamily,
  }));

  useEffect(() => {
    const mount = containerRef.current;
    const api = readNativeApi();
    if (!mount || !api) return;
    const viewport = createTerminalViewport(
      mount,
      api,
      {
        threadId,
        terminalId,
        cwd,
        runtimeEnv,
        readKeybindings,
        readTerminalLabel,
        readAutoFocus,
        isDrawerDragging,
        onSessionExited: onExit,
        onAddTerminalContext: onContext,
      },
      readTerminalFont(),
    );
    viewportRef.current = viewport;
    return () => {
      viewportRef.current = null;
      viewport.dispose();
    };
  }, [cwd, runtimeEnv, terminalId, threadId]);

  useEffect(() => {
    if (!autoFocus) return;
    const frame = window.requestAnimationFrame(() => viewportRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [autoFocus, focusRequestId]);

  useEffect(() => {
    viewportRef.current?.setFont({ fontSize: terminalFontSize, fontFamily: terminalFontFamily });
  }, [terminalFontFamily, terminalFontSize, terminalId, threadId]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => viewportRef.current?.fit());
    return () => window.cancelAnimationFrame(frame);
  }, [drawerHeight, resizeEpoch, terminalId, threadId]);
  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      className="relative h-full w-full overflow-hidden rounded-[4px] outline-none"
    />
  );
}

interface ThreadTerminalDrawerProps {
  threadId: ThreadId;
  cwd: string;
  runtimeEnv?: Record<string, string>;
  visible?: boolean;
  height: number;
  terminalIds: string[];
  activeTerminalId: string;
  terminalGroups: ThreadTerminalLayoutGroup[];
  activeTerminalGroupId: string;
  focusRequestId: number;
  onSplitTerminal: () => void;
  onSplitTerminalVertical: () => void;
  onNewTerminal: () => void;
  splitShortcutLabel?: string | undefined;
  splitVerticalShortcutLabel?: string | undefined;
  newShortcutLabel?: string | undefined;
  closeShortcutLabel?: string | undefined;
  onActiveTerminalChange: (terminalId: string) => void;
  onCloseTerminal: (terminalId: string) => void;
  onHeightChange: (height: number) => void;
  onAddTerminalContext: (selection: TerminalContextSelection) => void;
}

interface TerminalActionButtonProps {
  label: string;
  className: string;
  onClick: () => void;
  children: ReactNode;
}

function TerminalActionButton({ label, className, onClick, children }: TerminalActionButtonProps) {
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        render={<button type="button" className={className} onClick={onClick} aria-label={label} />}
      >
        {children}
      </PopoverTrigger>
      <PopoverPopup
        tooltipStyle
        side="bottom"
        sideOffset={6}
        align="center"
        className="pointer-events-none select-none"
      >
        {label}
      </PopoverPopup>
    </Popover>
  );
}

export default function ThreadTerminalDrawer({
  threadId,
  cwd,
  runtimeEnv,
  visible = true,
  height,
  terminalIds,
  activeTerminalId,
  terminalGroups,
  activeTerminalGroupId,
  focusRequestId,
  onSplitTerminal,
  onSplitTerminalVertical,
  onNewTerminal,
  splitShortcutLabel,
  splitVerticalShortcutLabel,
  newShortcutLabel,
  closeShortcutLabel,
  onActiveTerminalChange,
  onCloseTerminal,
  onHeightChange,
  onAddTerminalContext,
}: ThreadTerminalDrawerProps) {
  // The stored height is the user's preference; the window size only caps what renders.
  const [preferredDrawerHeight, setPreferredDrawerHeight] = useState(() =>
    normalizePreferredDrawerHeight(height),
  );
  const [drawerMaxHeight, setDrawerMaxHeight] = useState(() => maxDrawerHeight(null));
  const drawerHeight = resolveRenderedDrawerHeight(preferredDrawerHeight, drawerMaxHeight);
  const [resizeEpoch, setResizeEpoch] = useState(0);
  const drawerHeightRef = useRef(drawerHeight);
  const preferredDrawerHeightRef = useRef(preferredDrawerHeight);
  const lastSyncedHeightRef = useRef(normalizePreferredDrawerHeight(height));
  const onHeightChangeRef = useRef(onHeightChange);
  const resizeStateRef = useRef<{
    pointerId: number;
    startY: number;
    startHeight: number;
    startPreferredHeight: number;
  } | null>(null);
  const didResizeDuringDragRef = useRef(false);
  const drawerElementRef = useRef<HTMLElement>(null);

  const normalizedTerminalIds = useMemo(() => {
    const cleaned = [...new Set(terminalIds.map((id) => id.trim()).filter((id) => id.length > 0))];
    return cleaned.length > 0 ? cleaned : [DEFAULT_THREAD_TERMINAL_ID];
  }, [terminalIds]);

  const resolvedActiveTerminalId = normalizedTerminalIds.includes(activeTerminalId)
    ? activeTerminalId
    : (normalizedTerminalIds[0] ?? DEFAULT_THREAD_TERMINAL_ID);

  const resolvedTerminalGroups = useMemo(() => {
    const validTerminalIdSet = new Set(normalizedTerminalIds);
    const assignedTerminalIds = new Set<string>();
    const usedGroupIds = new Set<string>();
    const nextGroups: ThreadTerminalLayoutGroup[] = [];

    const assignUniqueGroupId = (groupId: string): string => {
      if (!usedGroupIds.has(groupId)) {
        usedGroupIds.add(groupId);
        return groupId;
      }
      let suffix = 2;
      while (usedGroupIds.has(`${groupId}-${suffix}`)) {
        suffix += 1;
      }
      const uniqueGroupId = `${groupId}-${suffix}`;
      usedGroupIds.add(uniqueGroupId);
      return uniqueGroupId;
    };

    for (const terminalGroup of terminalGroups) {
      const nextTerminalIds = [
        ...new Set(terminalGroup.terminalIds.map((id) => id.trim()).filter((id) => id.length > 0)),
      ].filter((terminalId) => {
        if (!validTerminalIdSet.has(terminalId)) return false;
        if (assignedTerminalIds.has(terminalId)) return false;
        return true;
      });
      if (nextTerminalIds.length === 0) continue;

      for (const terminalId of nextTerminalIds) {
        assignedTerminalIds.add(terminalId);
      }

      const baseGroupId =
        terminalGroup.id.trim().length > 0
          ? terminalGroup.id.trim()
          : `group-${nextTerminalIds[0] ?? DEFAULT_THREAD_TERMINAL_ID}`;
      nextGroups.push({
        id: assignUniqueGroupId(baseGroupId),
        terminalIds: nextTerminalIds,
        ...(terminalGroup.splitDirection === "vertical"
          ? { splitDirection: "vertical" as const }
          : {}),
      });
    }

    for (const terminalId of normalizedTerminalIds) {
      if (assignedTerminalIds.has(terminalId)) continue;
      nextGroups.push({
        id: assignUniqueGroupId(`group-${terminalId}`),
        terminalIds: [terminalId],
      });
    }

    if (nextGroups.length > 0) {
      return nextGroups;
    }

    return [
      {
        id: `group-${resolvedActiveTerminalId}`,
        terminalIds: [resolvedActiveTerminalId],
      },
    ];
  }, [normalizedTerminalIds, resolvedActiveTerminalId, terminalGroups]);

  const resolvedActiveGroupIndex = useMemo(() => {
    const indexById = resolvedTerminalGroups.findIndex(
      (terminalGroup) => terminalGroup.id === activeTerminalGroupId,
    );
    if (indexById >= 0) return indexById;
    const indexByTerminal = resolvedTerminalGroups.findIndex((terminalGroup) =>
      terminalGroup.terminalIds.includes(resolvedActiveTerminalId),
    );
    return indexByTerminal >= 0 ? indexByTerminal : 0;
  }, [activeTerminalGroupId, resolvedActiveTerminalId, resolvedTerminalGroups]);

  const visibleTerminalIds = resolvedTerminalGroups[resolvedActiveGroupIndex]?.terminalIds ?? [
    resolvedActiveTerminalId,
  ];
  const hasTerminalSidebar = normalizedTerminalIds.length > 1;
  const isSplitView = visibleTerminalIds.length > 1;
  const isStackedSplit =
    resolvedTerminalGroups[resolvedActiveGroupIndex]?.splitDirection === "vertical";
  const showGroupHeaders =
    resolvedTerminalGroups.length > 1 ||
    resolvedTerminalGroups.some((terminalGroup) => terminalGroup.terminalIds.length > 1);
  const hasReachedSplitLimit = visibleTerminalIds.length >= MAX_TERMINALS_PER_GROUP;
  const terminalLabelById = useMemo(
    () => terminalNumberLabelById(normalizedTerminalIds),
    [normalizedTerminalIds],
  );
  const commandLabels = useTerminalCommandLabels(threadId);
  const splitTerminalActionLabel = hasReachedSplitLimit
    ? `Split Terminal Side by Side (max ${MAX_TERMINALS_PER_GROUP} per group)`
    : splitShortcutLabel
      ? `Split Terminal Side by Side (${splitShortcutLabel})`
      : "Split Terminal Side by Side";
  const splitTerminalVerticalActionLabel = hasReachedSplitLimit
    ? `Stack Terminal Below (max ${MAX_TERMINALS_PER_GROUP} per group)`
    : splitVerticalShortcutLabel
      ? `Stack Terminal Below (${splitVerticalShortcutLabel})`
      : "Stack Terminal Below";
  const newTerminalActionLabel = newShortcutLabel
    ? `New Terminal (${newShortcutLabel})`
    : "New Terminal";
  const closeTerminalActionLabel = closeShortcutLabel
    ? `Close Terminal (${closeShortcutLabel})`
    : "Close Terminal";
  const onSplitTerminalAction = useCallback(() => {
    if (hasReachedSplitLimit) return;
    onSplitTerminal();
  }, [hasReachedSplitLimit, onSplitTerminal]);
  const onSplitTerminalVerticalAction = useCallback(() => {
    if (hasReachedSplitLimit) return;
    onSplitTerminalVertical();
  }, [hasReachedSplitLimit, onSplitTerminalVertical]);
  const onNewTerminalAction = useCallback(() => {
    onNewTerminal();
  }, [onNewTerminal]);
  // User-initiated closes confirm when a process is running; ids are captured before awaiting.
  const requestCloseTerminal = (terminalId: string) => {
    void confirmTerminalCloseIfRunning({
      threadId,
      terminalId,
      terminalLabel: terminalLabelById.get(terminalId) ?? "Terminal",
    }).then((confirmed) => {
      if (confirmed) onCloseTerminal(terminalId);
    });
  };

  useEffect(() => {
    onHeightChangeRef.current = onHeightChange;
  }, [onHeightChange]);

  // A re-render mid-drag (window resize, new height prop) must not snap the drawer off the pointer.
  useLayoutEffect(() => {
    if (resizeStateRef.current) {
      const drawerElement = drawerElementRef.current;
      if (drawerElement) drawerElement.style.height = `${drawerHeightRef.current}px`;
      return;
    }
    drawerHeightRef.current = drawerHeight;
  }, [drawerHeight]);

  useEffect(() => {
    preferredDrawerHeightRef.current = preferredDrawerHeight;
  }, [preferredDrawerHeight]);

  const syncHeight = useCallback((nextHeight: number) => {
    const preferredHeight = normalizePreferredDrawerHeight(nextHeight);
    if (lastSyncedHeightRef.current === preferredHeight) return;
    lastSyncedHeightRef.current = preferredHeight;
    onHeightChangeRef.current(preferredHeight);
  }, []);

  useEffect(() => {
    const preferredHeight = normalizePreferredDrawerHeight(height);
    setPreferredDrawerHeight(preferredHeight);
    preferredDrawerHeightRef.current = preferredHeight;
    drawerHeightRef.current = resolveRenderedDrawerHeight(
      preferredHeight,
      maxDrawerHeight(drawerElementRef.current),
    );
    lastSyncedHeightRef.current = preferredHeight;
  }, [height, threadId]);

  const handleResizePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    didResizeDuringDragRef.current = false;
    resizeStateRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: drawerHeightRef.current,
      startPreferredHeight: preferredDrawerHeightRef.current,
    };
  }, []);

  const handleResizePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const resizeState = resizeStateRef.current;
    if (!resizeState || resizeState.pointerId !== event.pointerId) return;
    event.preventDefault();
    const clampedHeight = clampDrawerHeight(
      resizeState.startHeight + (resizeState.startY - event.clientY),
      drawerElementRef.current,
    );
    if (clampedHeight === drawerHeightRef.current) {
      return;
    }
    didResizeDuringDragRef.current = true;
    drawerHeightRef.current = clampedHeight;
    preferredDrawerHeightRef.current = clampedHeight;
    // Move the element directly; state, persistence and the xterm refit commit once on release.
    const drawerElement = drawerElementRef.current;
    if (drawerElement) drawerElement.style.height = `${clampedHeight}px`;
  }, []);

  const handleResizePointerEnd = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const resizeState = resizeStateRef.current;
      if (!resizeState || resizeState.pointerId !== event.pointerId) return;
      resizeStateRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      if (!didResizeDuringDragRef.current) {
        return;
      }
      const drawerElement = drawerElementRef.current;
      // A drag that ends where it started keeps the (possibly window-capped) stored preference.
      if (drawerHeightRef.current === resizeState.startHeight) {
        preferredDrawerHeightRef.current = resizeState.startPreferredHeight;
        if (drawerElement) drawerElement.style.height = `${resizeState.startHeight}px`;
        return;
      }
      const preferredHeight = preferredDrawerHeightRef.current;
      const maxHeight = maxDrawerHeight(drawerElement);
      // React skips the style write when the rendered height is unchanged, so set it explicitly too.
      if (drawerElement) {
        drawerElement.style.height = `${resolveRenderedDrawerHeight(preferredHeight, maxHeight)}px`;
      }
      setDrawerMaxHeight(maxHeight);
      setPreferredDrawerHeight(preferredHeight);
      syncHeight(preferredHeight);
      setResizeEpoch((value) => value + 1);
    },
    [syncHeight],
  );

  useEffect(() => {
    if (!visible) {
      return;
    }

    // Only the rendered cap follows the window; the stored preference is not rewritten.
    const onWindowResize = () => {
      setDrawerMaxHeight(maxDrawerHeight(drawerElementRef.current));
      setResizeEpoch((value) => value + 1);
    };
    window.addEventListener("resize", onWindowResize);
    return () => {
      window.removeEventListener("resize", onWindowResize);
    };
  }, [visible]);

  useEffect(() => {
    if (!visible) {
      return;
    }
    setResizeEpoch((value) => value + 1);
  }, [visible]);

  // Before paint, so a tall drawer never covers the composer; width-only changes recompute the same cap.
  useLayoutEffect(() => {
    if (!visible) {
      return;
    }
    const drawerElement = drawerElementRef.current;
    const updateMaxHeight = () => setDrawerMaxHeight(maxDrawerHeight(drawerElement));
    updateMaxHeight();
    const column = findChatColumn(drawerElement);
    if (!column || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(updateMaxHeight);
    observer.observe(column);
    for (const element of column.querySelectorAll(
      "[data-chat-header], [data-chat-composer-root]",
    )) {
      observer.observe(element);
    }
    return () => {
      observer.disconnect();
    };
  }, [visible]);

  useEffect(() => {
    return () => {
      syncHeight(preferredDrawerHeightRef.current);
    };
  }, [syncHeight]);

  return (
    <aside
      {...workspaceAreaProps("terminal", 4, "Terminal")}
      ref={drawerElementRef}
      className="thread-terminal-drawer relative flex min-w-0 shrink-0 flex-col overflow-hidden border-t border-border/80 bg-background"
      style={{ height: `${drawerHeight}px` }}
    >
      <div
        className="absolute inset-x-0 top-0 z-20 h-1.5 cursor-row-resize"
        onPointerDown={handleResizePointerDown}
        onPointerMove={handleResizePointerMove}
        onPointerUp={handleResizePointerEnd}
        onPointerCancel={handleResizePointerEnd}
        onLostPointerCapture={handleResizePointerEnd}
      />

      {!hasTerminalSidebar && (
        <div className="pointer-events-none absolute right-2 top-2 z-20">
          <div className="pointer-events-auto inline-flex items-center overflow-hidden rounded-md border border-border/80 bg-background/70">
            <TerminalActionButton
              className={`p-1 text-foreground/90 transition-colors ${
                hasReachedSplitLimit
                  ? "cursor-not-allowed opacity-64 hover:bg-transparent"
                  : "hover:bg-accent"
              }`}
              onClick={onSplitTerminalAction}
              label={splitTerminalActionLabel}
            >
              <SquareSplitHorizontal className="size-3.25" />
            </TerminalActionButton>
            <div className="h-4 w-px bg-border/80" />
            <TerminalActionButton
              className={`p-1 text-foreground/90 transition-colors ${
                hasReachedSplitLimit
                  ? "cursor-not-allowed opacity-64 hover:bg-transparent"
                  : "hover:bg-accent"
              }`}
              onClick={onSplitTerminalVerticalAction}
              label={splitTerminalVerticalActionLabel}
            >
              <SquareSplitVertical className="size-3.25" />
            </TerminalActionButton>
            <div className="h-4 w-px bg-border/80" />
            <TerminalActionButton
              className="p-1 text-foreground/90 transition-colors hover:bg-accent"
              onClick={onNewTerminalAction}
              label={newTerminalActionLabel}
            >
              <Plus className="size-3.25" />
            </TerminalActionButton>
            <div className="h-4 w-px bg-border/80" />
            <TerminalActionButton
              className="p-1 text-foreground/90 transition-colors hover:bg-accent"
              onClick={() => requestCloseTerminal(resolvedActiveTerminalId)}
              label={closeTerminalActionLabel}
            >
              <Trash2 className="size-3.25" />
            </TerminalActionButton>
          </div>
        </div>
      )}

      <div className="min-h-0 w-full flex-1">
        <div className={`flex h-full min-h-0 ${hasTerminalSidebar ? "gap-1.5" : ""}`}>
          <div className="min-w-0 flex-1">
            {isSplitView ? (
              <div
                className="grid h-full w-full min-w-0 gap-0 overflow-hidden"
                style={
                  isStackedSplit
                    ? { gridTemplateRows: `repeat(${visibleTerminalIds.length}, minmax(0, 1fr))` }
                    : {
                        gridTemplateColumns: `repeat(${visibleTerminalIds.length}, minmax(0, 1fr))`,
                      }
                }
              >
                {visibleTerminalIds.map((terminalId) => (
                  <div
                    key={terminalId}
                    className={`min-h-0 min-w-0 ${
                      isStackedSplit ? "border-t first:border-t-0" : "border-l first:border-l-0"
                    } ${
                      terminalId === resolvedActiveTerminalId ? "border-border" : "border-border/70"
                    }`}
                    onMouseDown={() => {
                      if (terminalId !== resolvedActiveTerminalId) {
                        onActiveTerminalChange(terminalId);
                      }
                    }}
                  >
                    <div className="h-full p-1">
                      <TerminalViewport
                        threadId={threadId}
                        terminalId={terminalId}
                        terminalLabel={terminalLabelById.get(terminalId) ?? "Terminal"}
                        cwd={cwd}
                        {...(runtimeEnv ? { runtimeEnv } : {})}
                        onSessionExited={() => onCloseTerminal(terminalId)}
                        onAddTerminalContext={onAddTerminalContext}
                        focusRequestId={focusRequestId}
                        autoFocus={terminalId === resolvedActiveTerminalId}
                        resizeEpoch={resizeEpoch}
                        drawerHeight={drawerHeight}
                        drawerDragRef={resizeStateRef}
                      />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="h-full p-1">
                <TerminalViewport
                  key={resolvedActiveTerminalId}
                  threadId={threadId}
                  terminalId={resolvedActiveTerminalId}
                  terminalLabel={terminalLabelById.get(resolvedActiveTerminalId) ?? "Terminal"}
                  cwd={cwd}
                  {...(runtimeEnv ? { runtimeEnv } : {})}
                  onSessionExited={() => onCloseTerminal(resolvedActiveTerminalId)}
                  onAddTerminalContext={onAddTerminalContext}
                  focusRequestId={focusRequestId}
                  autoFocus
                  resizeEpoch={resizeEpoch}
                  drawerHeight={drawerHeight}
                  drawerDragRef={resizeStateRef}
                />
              </div>
            )}
          </div>

          {hasTerminalSidebar && (
            <aside className="flex w-36 min-w-36 flex-col border border-border/70 bg-muted/10">
              <div className="flex h-[22px] items-stretch justify-end border-b border-border/70">
                <div className="inline-flex h-full items-stretch">
                  <TerminalActionButton
                    className={`inline-flex h-full items-center px-1 text-foreground/90 transition-colors ${
                      hasReachedSplitLimit
                        ? "cursor-not-allowed opacity-64 hover:bg-transparent"
                        : "hover:bg-accent/70"
                    }`}
                    onClick={onSplitTerminalAction}
                    label={splitTerminalActionLabel}
                  >
                    <SquareSplitHorizontal className="size-3.25" />
                  </TerminalActionButton>
                  <TerminalActionButton
                    className={`inline-flex h-full items-center border-l border-border/70 px-1 text-foreground/90 transition-colors ${
                      hasReachedSplitLimit
                        ? "cursor-not-allowed opacity-64 hover:bg-transparent"
                        : "hover:bg-accent/70"
                    }`}
                    onClick={onSplitTerminalVerticalAction}
                    label={splitTerminalVerticalActionLabel}
                  >
                    <SquareSplitVertical className="size-3.25" />
                  </TerminalActionButton>
                  <TerminalActionButton
                    className="inline-flex h-full items-center border-l border-border/70 px-1 text-foreground/90 transition-colors hover:bg-accent/70"
                    onClick={onNewTerminalAction}
                    label={newTerminalActionLabel}
                  >
                    <Plus className="size-3.25" />
                  </TerminalActionButton>
                  <TerminalActionButton
                    className="inline-flex h-full items-center border-l border-border/70 px-1 text-foreground/90 transition-colors hover:bg-accent/70"
                    onClick={() => requestCloseTerminal(resolvedActiveTerminalId)}
                    label={closeTerminalActionLabel}
                  >
                    <Trash2 className="size-3.25" />
                  </TerminalActionButton>
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto px-1 py-1">
                {resolvedTerminalGroups.map((terminalGroup) => {
                  const isGroupActive =
                    terminalGroup.terminalIds.includes(resolvedActiveTerminalId);
                  const groupActiveTerminalId = isGroupActive
                    ? resolvedActiveTerminalId
                    : (terminalGroup.terminalIds[0] ?? resolvedActiveTerminalId);
                  const groupHeader = terminalGroupHeader(terminalGroup);

                  return (
                    <div key={terminalGroup.id} className="pb-0.5">
                      {showGroupHeaders && (
                        <button
                          type="button"
                          aria-label={terminalGroupHeaderAccessibleName(
                            groupHeader,
                            terminalGroup.terminalIds.map(
                              (terminalId) => terminalLabelById.get(terminalId) ?? "Terminal",
                            ),
                          )}
                          className={`flex w-full items-center gap-1 rounded px-1 py-0.5 text-[10px] ${
                            isGroupActive
                              ? "bg-accent/70 text-foreground"
                              : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                          }`}
                          onClick={() => onActiveTerminalChange(groupActiveTerminalId)}
                        >
                          <groupHeader.Icon className="size-3 shrink-0" />
                          <span className="min-w-0 flex-1 truncate text-left">
                            {groupHeader.label}
                          </span>
                          <span className="tabular-nums text-muted-foreground/70">
                            {groupHeader.count}
                          </span>
                        </button>
                      )}

                      <div
                        className={showGroupHeaders ? "ml-1 border-l border-border/60 pl-1.5" : ""}
                      >
                        {terminalGroup.terminalIds.map((terminalId) => {
                          const isActive = terminalId === resolvedActiveTerminalId;
                          const closeTerminalLabel = `Close ${
                            terminalLabelById.get(terminalId) ?? "terminal"
                          }${isActive && closeShortcutLabel ? ` (${closeShortcutLabel})` : ""}`;
                          return (
                            <div
                              key={terminalId}
                              className={`group flex items-center gap-1 rounded px-1 py-0.5 text-[11px] ${
                                isActive
                                  ? "bg-accent text-foreground"
                                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                              }`}
                            >
                              {showGroupHeaders && (
                                <span className="text-[10px] text-muted-foreground/80">└</span>
                              )}
                              <button
                                type="button"
                                className="flex min-w-0 flex-1 items-center gap-1 text-left"
                                onClick={() => onActiveTerminalChange(terminalId)}
                                {...(commandLabels[terminalId]
                                  ? {
                                      "aria-label": `${terminalLabelById.get(terminalId) ?? "Terminal"}: ${commandLabels[terminalId]}`,
                                      title: `${terminalLabelById.get(terminalId) ?? "Terminal"}: ${commandLabels[terminalId]}`,
                                    }
                                  : {})}
                              >
                                <TerminalSquare className="size-3 shrink-0" />
                                <span className="truncate">
                                  {commandLabels[terminalId] ??
                                    terminalLabelById.get(terminalId) ??
                                    "Terminal"}
                                </span>
                              </button>
                              {normalizedTerminalIds.length > 1 && (
                                <Popover>
                                  <PopoverTrigger
                                    openOnHover
                                    render={
                                      <button
                                        type="button"
                                        className="inline-flex size-3.5 items-center justify-center rounded text-xs font-medium leading-none text-muted-foreground opacity-0 transition hover:bg-accent hover:text-foreground group-hover:opacity-100"
                                        onClick={() => requestCloseTerminal(terminalId)}
                                        aria-label={closeTerminalLabel}
                                      />
                                    }
                                  >
                                    <XIcon className="size-2.5" />
                                  </PopoverTrigger>
                                  <PopoverPopup
                                    tooltipStyle
                                    side="bottom"
                                    sideOffset={6}
                                    align="center"
                                    className="pointer-events-none select-none"
                                  >
                                    {closeTerminalLabel}
                                  </PopoverPopup>
                                </Popover>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </aside>
          )}
        </div>
      </div>
    </aside>
  );
}
