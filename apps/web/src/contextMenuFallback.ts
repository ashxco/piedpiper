import type { ContextMenuItem } from "@piedpiper/contracts";

/**
 * Imperative DOM-based context menu for non-Electron environments.
 * Shows a positioned dropdown and returns a promise that resolves
 * with the clicked item id, or null if dismissed.
 */
export function showContextMenuFallback<T extends string>(
  items: readonly ContextMenuItem<T>[],
  position?: { x: number; y: number },
): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;z-index:9999";
    overlay.dataset.contextMenuOverlay = "";

    const menu = document.createElement("div");
    // ChatView's type-to-focus treats an open [role="menu"] as a floating layer.
    menu.setAttribute("role", "menu");
    menu.className =
      "fixed z-[10000] min-w-[140px] rounded-md border border-border bg-popover py-1 shadow-xl animate-in fade-in zoom-in-95";

    const x = position?.x ?? 0;
    const y = position?.y ?? 0;
    menu.style.top = `${y}px`;
    menu.style.left = `${x}px`;
    // The right-click/ctrl-click that opened the menu must not also pick an item or dismiss it.
    let canDismissFromPointer = false;

    const enabledButtons: HTMLButtonElement[] = [];

    function cleanup(result: T | null) {
      document.removeEventListener("keydown", onKeyDown);
      overlay.remove();
      menu.remove();
      if (previouslyFocused?.isConnected && typeof previouslyFocused.focus === "function") {
        previouslyFocused.focus();
      }
      resolve(result);
    }

    function focusButton(index: number) {
      if (enabledButtons.length === 0) return;
      const wrapped = (index + enabledButtons.length) % enabledButtons.length;
      enabledButtons[wrapped]?.focus();
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        cleanup(null);
        return;
      }
      const current = enabledButtons.indexOf(document.activeElement as HTMLButtonElement);
      if (e.key === "ArrowDown") {
        e.preventDefault();
        focusButton(current + 1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        focusButton(current < 0 ? enabledButtons.length - 1 : current - 1);
      } else if (e.key === "Home") {
        e.preventDefault();
        focusButton(0);
      } else if (e.key === "End") {
        e.preventDefault();
        focusButton(enabledButtons.length - 1);
      }
    }

    overlay.addEventListener("mousedown", () => {
      if (canDismissFromPointer) cleanup(null);
    });
    document.addEventListener("keydown", onKeyDown);

    for (const item of items) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.setAttribute("role", "menuitem");
      btn.textContent = item.label;
      const isDestructiveAction = item.destructive === true || item.id === "delete";
      const isDisabled = item.disabled === true;
      btn.disabled = isDisabled;
      btn.className = isDisabled
        ? "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] text-muted-foreground/60 cursor-not-allowed"
        : isDestructiveAction
          ? "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] text-destructive hover:bg-accent cursor-default"
          : "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] text-popover-foreground hover:bg-accent cursor-default";
      if (!isDisabled) {
        btn.addEventListener("click", () => {
          if (canDismissFromPointer) cleanup(item.id);
        });
        enabledButtons.push(btn);
      }
      menu.appendChild(btn);
    }

    document.body.appendChild(overlay);
    document.body.appendChild(menu);
    focusButton(0);

    // Adjust if menu overflows viewport
    requestAnimationFrame(() => {
      canDismissFromPointer = true;
      const rect = menu.getBoundingClientRect();
      if (rect.right > window.innerWidth) {
        menu.style.left = `${window.innerWidth - rect.width - 4}px`;
      }
      if (rect.bottom > window.innerHeight) {
        menu.style.top = `${window.innerHeight - rect.height - 4}px`;
      }
    });
  });
}
