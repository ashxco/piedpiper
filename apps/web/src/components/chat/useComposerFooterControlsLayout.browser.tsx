import "../../index.css";

import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { cn } from "~/lib/utils";
import { COMPOSER_ICON_ONLY_LABEL_CLASS_NAME } from "../composerFooterLayout";
import { Button } from "../ui/button";
import {
  measureComposerFooterControls,
  useComposerFooterControlsLayout,
} from "./useComposerFooterControlsLayout";

const BLOCKS = ["Effort level", "Agent", "Supervised"];

function Footer(props: { actionsWidth: number; attachButton?: boolean }) {
  const { layout, footerRef, leadingRef, actionsRef } = useComposerFooterControlsLayout("key");
  return (
    <div
      ref={footerRef}
      data-testid="footer"
      data-icon-only={layout.iconOnlyCount}
      data-hidden={layout.hiddenCount}
      className="flex min-w-0 flex-nowrap items-center justify-between gap-2 px-2"
    >
      <div
        ref={leadingRef}
        data-testid="leading"
        className="relative -m-1 flex min-w-0 flex-1 items-center gap-1 overflow-hidden p-1"
      >
        {props.attachButton ? (
          <div data-composer-attach-button className="flex shrink-0 items-center">
            <Button size="icon-xs" aria-label="Attach images">
              <svg aria-hidden="true" />
            </Button>
          </div>
        ) : null}
        <Button
          size="xs"
          data-chat-provider-model-picker="true"
          className="min-w-0 max-w-48 shrink justify-start overflow-hidden"
        >
          <span data-chat-provider-model-picker-label="true" className="min-w-0 flex-1 truncate">
            Claude Opus 4.6 with a long name
          </span>
        </Button>
        {BLOCKS.map((label, index) => {
          const hidden = index >= BLOCKS.length - layout.hiddenCount;
          const iconOnly = index >= BLOCKS.length - layout.iconOnlyCount;
          return (
            <div
              key={label}
              data-composer-footer-block={label}
              inert={hidden || undefined}
              className={cn(
                "flex w-max shrink-0 items-center",
                hidden && "pointer-events-none invisible absolute start-0 top-0",
              )}
            >
              <Button size="xs">
                <svg aria-hidden="true" />
                <span
                  data-composer-control-label
                  className={cn(iconOnly && COMPOSER_ICON_ONLY_LABEL_CLASS_NAME)}
                >
                  {label}
                </span>
              </Button>
            </div>
          );
        })}
        <div
          data-composer-footer-overflow
          className={cn(
            "w-max shrink-0",
            layout.hiddenCount === 0 && "pointer-events-none invisible absolute start-0 top-0",
          )}
        >
          <Button size="xs">...</Button>
        </div>
      </div>
      <div ref={actionsRef} data-testid="actions" className="shrink-0">
        <div style={{ width: props.actionsWidth, height: 24 }} />
      </div>
    </div>
  );
}

function byTestId(id: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  if (!element) throw new Error(`Missing ${id}`);
  return element;
}

async function mountFooter(width: number, actionsWidth = 64, attachButton = false) {
  const host = document.createElement("div");
  host.style.width = `${width}px`;
  document.body.append(host);
  const screen = await render(<Footer actionsWidth={actionsWidth} attachButton={attachButton} />, {
    container: host,
  });
  return {
    host,
    screen,
    async [Symbol.asyncDispose]() {
      await screen.unmount();
      host.remove();
    },
  };
}

function expectNoOverlap() {
  const leading = byTestId("leading");
  const actionsLeft = byTestId("actions").getBoundingClientRect().left;
  const visibleControls = Array.from(leading.querySelectorAll<HTMLElement>("button")).filter(
    (button) => getComputedStyle(button).visibility !== "hidden",
  );
  expect(visibleControls.length).toBeGreaterThan(0);
  for (const control of visibleControls) {
    expect(control.getBoundingClientRect().right).toBeLessThanOrEqual(actionsLeft);
  }
  // Against the visible controls, not scrollWidth: an icon-only label's invisible absolute text can
  // run past the edge without painting anything.
  const leadingRight = leading.getBoundingClientRect().left + leading.clientWidth;
  for (const control of visibleControls) {
    expect(control.getBoundingClientRect().right).toBeLessThanOrEqual(leadingRight);
  }
}

describe("useComposerFooterControlsLayout", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("counts the attach button and one gap in the fixed width", async () => {
    await using _ = await mountFooter(900, 64, true);
    const leading = byTestId("leading");
    const measurement = measureComposerFooterControls({
      footer: byTestId("footer"),
      leading,
      actions: byTestId("actions"),
    });
    const width = (selector: string) =>
      leading.querySelector<HTMLElement>(selector)!.getBoundingClientRect().width;
    const attachWidth = width("[data-composer-attach-button]");
    expect(attachWidth).toBeGreaterThan(0);
    expect(measurement?.gap).toBe(4);
    expect(measurement?.fixedWidth).toBeCloseTo(
      width('[data-chat-provider-model-picker="true"]') + attachWidth + 4,
    );
  });

  it("collapses before the attach button pushes controls under the actions", async () => {
    await using _ = await mountFooter(560, 320, true);
    await vi.waitFor(() => {
      expect(Number(byTestId("footer").dataset.iconOnly)).toBeGreaterThan(0);
    });
    expectNoOverlap();
  });

  it("keeps every label while the controls fit", async () => {
    await using _ = await mountFooter(900);
    await vi.waitFor(() => {
      expect(byTestId("footer").dataset.iconOnly).toBe("0");
      expect(byTestId("footer").dataset.hidden).toBe("0");
    });
    expectNoOverlap();
  });

  it("does not overlap the actions in a 560px composer, whatever the actions take", async () => {
    await using _ = await mountFooter(560, 320);
    await vi.waitFor(() => {
      expect(Number(byTestId("footer").dataset.iconOnly)).toBeGreaterThan(0);
    });
    expectNoOverlap();
  });

  it("collapses further as it narrows and restores as it widens", async () => {
    await using mounted = await mountFooter(900, 64, true);
    const counts: Array<[number, number]> = [];
    for (const width of [420, 340, 240, 900]) {
      mounted.host.style.width = `${width}px`;
      await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 50)));
      const { iconOnly, hidden } = byTestId("footer").dataset;
      counts.push([Number(iconOnly), Number(hidden)]);
      expectNoOverlap();
    }
    const steps = counts.map(([iconOnly, hidden]) => iconOnly + hidden);
    expect(steps[1]).toBeGreaterThanOrEqual(steps[0]!);
    expect(steps[2]).toBeGreaterThan(steps[0]!);
    expect(steps[3]).toBe(0);
  });

  it("measures the same natural widths from either layout, so it settles", async () => {
    await using mounted = await mountFooter(900);
    const widest = byTestId("leading").querySelector<HTMLElement>(
      "[data-composer-footer-block='Supervised']",
    )!;
    const naturalWidth = widest.getBoundingClientRect().width;
    mounted.host.style.width = "240px";
    await vi.waitFor(() => {
      expect(Number(byTestId("footer").dataset.hidden)).toBeGreaterThan(0);
    });
    mounted.host.style.width = "900px";
    await vi.waitFor(() => {
      expect(byTestId("footer").dataset.iconOnly).toBe("0");
    });
    expect(Math.abs(widest.getBoundingClientRect().width - naturalWidth)).toBeLessThan(0.5);
  });
});
