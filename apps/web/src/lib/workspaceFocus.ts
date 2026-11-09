const AREA_SELECTOR = "[data-workspace-area]";
const FOCUS_BOUNDARY_SELECTOR =
  '[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open], [data-slot$="-popup"]:not([data-slot="tooltip-popup"]):not([role="tooltip"])';
const FOCUSABLE_SELECTOR =
  'button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [contenteditable="true"], [tabindex]';
const XTERM_INPUT_SELECTOR = ".xterm-helper-textarea";
const PREFERRED_SELECTOR = `[data-sidebar-row][aria-current="page"], ${XTERM_INPUT_SELECTOR}, [contenteditable="true"]`;
const CONVERSATION_AREA = "conversation";

/** Props that make an element one stop in the F6 cycle; `order` sets its place in the cycle. */
export function workspaceAreaProps(name: string, order: number, label: string) {
  return {
    "data-workspace-area": name,
    "data-workspace-order": order,
    "aria-label": label,
    role: "region",
    tabIndex: -1,
  } as const;
}

function workspaceArea(element: Element): HTMLElement | null {
  return element.closest<HTMLElement>(AREA_SELECTOR);
}

function isWorkspaceElementVisible(element: HTMLElement): boolean {
  if (
    !element.isConnected ||
    element.closest(
      '[hidden], [inert], [data-closed], [aria-hidden="true"], [data-slot="sidebar"][data-state="collapsed"]',
    )
  )
    return false;
  const style = getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden") return false;
  // xterm keeps its input zero-sized and off-screen, so the terminal stands in for it.
  const sized = element.matches(XTERM_INPUT_SELECTOR)
    ? (element.closest(".xterm") ?? element)
    : element;
  return Array.from(sized.getClientRects()).some((rect) => rect.width > 0 && rect.height > 0);
}

function scrollingAncestors(target: HTMLElement) {
  const scrollers: HTMLElement[] = [];
  for (let element = target.parentElement; element; element = element.parentElement) {
    const { overflowY } = getComputedStyle(element);
    if (
      (overflowY === "auto" || overflowY === "scroll") &&
      element.scrollHeight > element.clientHeight
    )
      scrollers.push(element);
  }
  return scrollers;
}

function isInScrollView(target: HTMLElement) {
  const rect = target.getBoundingClientRect();
  return scrollingAncestors(target).every((scroller) => {
    const box = scroller.getBoundingClientRect();
    return rect.bottom > box.top && rect.top < box.bottom;
  });
}

// scrollIntoView would also scroll overflow-hidden layout containers out of place.
function revealInScrollers(target: HTMLElement) {
  for (const scroller of scrollingAncestors(target)) {
    const box = scroller.getBoundingClientRect();
    const rect = target.getBoundingClientRect();
    if (rect.top < box.top) scroller.scrollTop -= box.top - rect.top;
    else if (rect.bottom > box.bottom) scroller.scrollTop += rect.bottom - box.bottom;
  }
}

/** Keeps area focus local, like VS Code's layout service focusPart/visible-neighbour actions. */
export function createWorkspaceFocusController(doc: Document) {
  const lastFocused = new Map<string, HTMLElement>();
  let lastArea: string | undefined;
  const remember = (event: FocusEvent) => {
    if (!(event.target instanceof HTMLElement)) return;
    const name = workspaceArea(event.target)?.dataset.workspaceArea;
    if (!name) return;
    lastArea = name;
    // A click on empty space focuses the area itself, which must not replace the preferred control.
    if (event.target.dataset.workspaceArea === name) {
      lastFocused.delete(name);
      return;
    }
    lastFocused.set(name, event.target);
  };
  doc.addEventListener("focusin", remember);

  const focusArea = (area: HTMLElement) => {
    const isConversation = area.dataset.workspaceArea === CONVERSATION_AREA;
    const belongs = (element: HTMLElement) =>
      workspaceArea(element) === area &&
      isWorkspaceElementVisible(element) &&
      !element.matches(":disabled");
    const previous = lastFocused.get(area.dataset.workspaceArea!);
    const preferred = Array.from(area.querySelectorAll<HTMLElement>(PREFERRED_SELECTOR)).find(
      belongs,
    );
    const fallback = Array.from(area.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).find(
      (element) => element.tabIndex >= 0 && belongs(element),
    );
    // Moving the timeline to an old control would stop it following a running turn,
    // so the conversation reuses a control only while it is still in view.
    const targets = [
      previous && belongs(previous) && (!isConversation || isInScrollView(previous))
        ? previous
        : undefined,
      preferred,
      isConversation ? undefined : fallback,
      area,
    ];
    for (const target of targets) {
      if (!target) continue;
      target.focus({ preventScroll: true });
      if (doc.activeElement === target || target.contains(doc.activeElement)) {
        if (target !== area && !isConversation) revealInScrollers(target);
        return true;
      }
    }
    return false;
  };

  const move = (direction: 1 | -1) => {
    // Inline listboxes belong to their area; portalled menus and listboxes are their own boundary.
    const activePopup = doc.activeElement?.closest<HTMLElement>('[role="menu"], [role="listbox"]');
    const boundaries = Array.from(doc.querySelectorAll<HTMLElement>(FOCUS_BOUNDARY_SELECTOR));
    if (activePopup && !activePopup.closest(AREA_SELECTOR)) boundaries.push(activePopup);
    // A modal keeps focus wherever it is; any other popup only while it holds focus,
    // so hover popups and notifications never swallow the key.
    if (
      boundaries.some(
        (boundary) =>
          (boundary.matches('[aria-modal="true"]') || boundary.contains(doc.activeElement)) &&
          isWorkspaceElementVisible(boundary),
      )
    )
      return false;
    const areas = Array.from(doc.querySelectorAll<HTMLElement>(AREA_SELECTOR))
      .filter(isWorkspaceElementVisible)
      .toSorted(
        (left, right) => Number(left.dataset.workspaceOrder) - Number(right.dataset.workspaceOrder),
      );
    if (areas.length === 0) return false;
    const active = doc.activeElement;
    const currentName = (active ? workspaceArea(active) : null)?.dataset.workspaceArea ?? lastArea;
    const current = areas.findIndex((area) => area.dataset.workspaceArea === currentName);
    const index =
      current === -1
        ? direction === 1
          ? 0
          : areas.length - 1
        : (current + direction + areas.length) % areas.length;
    return focusArea(areas[index]!);
  };

  return {
    move,
    dispose: () => doc.removeEventListener("focusin", remember),
  };
}

let controller: ReturnType<typeof createWorkspaceFocusController> | undefined;

/** Starts remembering each area's last focused control; returns the cleanup. */
export function startWorkspaceFocus(): () => void {
  const active = createWorkspaceFocusController(document);
  controller = active;
  return () => {
    active.dispose();
    if (controller === active) controller = undefined;
  };
}

/** Moves to the next or previous visible area; false when a dialog keeps focus or nothing can take it. */
export function moveWorkspaceFocus(direction: 1 | -1): boolean {
  return controller?.move(direction) ?? false;
}
