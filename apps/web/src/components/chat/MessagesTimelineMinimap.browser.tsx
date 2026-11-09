import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { type TimelineMinimapItem } from "./MessagesTimeline.minimap.logic";
import { MessagesTimelineMinimap } from "./MessagesTimelineMinimap";

const ITEMS: TimelineMinimapItem[] = [
  { id: "u1", rowIndex: 0, userText: "First prompt", assistantText: "**Bold** reply" },
  { id: "u2", rowIndex: 2, userText: "Second prompt", assistantText: null },
  { id: "u3", rowIndex: 4, userText: "Third prompt", assistantText: null },
];

function Harness(props: {
  width: number;
  contentWidth?: number | string;
  onSelect: (item: TimelineMinimapItem) => void;
  onLeaveBottom?: () => void;
  /** Moves every row up by this much, as scrolling would. */
  boundsOffset?: number;
}) {
  const [scrollContainer, setScrollContainer] = useState<HTMLDivElement | null>(null);
  const [contentElement, setContentElement] = useState<HTMLDivElement | null>(null);
  return (
    <div className="relative" style={{ width: props.width, height: 400 }}>
      <div ref={setScrollContainer} style={{ height: 400, overflowY: "auto" }}>
        <div
          ref={setContentElement}
          style={{ height: 2000, width: props.contentWidth ?? 768, margin: "0 auto" }}
        />
      </div>
      <MessagesTimelineMinimap
        scrollContainer={scrollContainer}
        contentElement={contentElement}
        items={ITEMS}
        resolveItemBounds={(item) => ({
          top:
            (scrollContainer?.getBoundingClientRect().top ?? 0) +
            item.rowIndex * 150 -
            (props.boundsOffset ?? 0),
          height: 40,
        })}
        onSelect={props.onSelect}
        onLeaveBottom={props.onLeaveBottom}
      />
    </div>
  );
}

const ticks = () => [...document.querySelectorAll<HTMLElement>("[data-minimap-tick]")];
const minimapScroller = (element: Element) =>
  element.closest("[data-testid=timeline-minimap]")!.previousElementSibling as HTMLDivElement;

describe("MessagesTimelineMinimap", () => {
  it("renders nothing when the side gutter is too narrow", async () => {
    const screen = await render(<Harness width={700} onSelect={() => {}} />);
    await expect.poll(() => document.querySelector("[data-testid=timeline-minimap]")).toBeNull();
    await screen.unmount();
  });

  it("renders nothing when a wide content column fills the gutter", async () => {
    const screen = await render(<Harness width={1000} contentWidth="100%" onSelect={() => {}} />);
    await expect.poll(() => document.querySelector("[data-testid=timeline-minimap]")).toBeNull();
    await screen.unmount();
  });

  it("selects the focused item with the keyboard", async () => {
    const onSelect = vi.fn();
    const screen = await render(<Harness width={1000} onSelect={onSelect} />);
    const button = screen.getByRole("button", { name: /Jump to message/ });
    await expect.element(button).toBeInTheDocument();

    button.element().focus();
    await expect.element(button).toHaveAccessibleName("Jump to message: First prompt");
    await userEvent.keyboard("{ArrowDown}");
    await expect.element(button).toHaveAccessibleName("Jump to message: Second prompt");
    await userEvent.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledWith(ITEMS[1]);
    await userEvent.keyboard("{End}{Enter}");
    expect(onSelect).toHaveBeenLastCalledWith(ITEMS[2]);
    await screen.unmount();
  });

  it("glides the timeline for a wheel notch over the rail and reports leaving the bottom", async () => {
    const onLeaveBottom = vi.fn();
    const screen = await render(
      <Harness width={1000} onSelect={() => {}} onLeaveBottom={onLeaveBottom} />,
    );
    const rail = screen.getByRole("button", { name: /Jump to message/ });
    await expect.element(rail).toBeInTheDocument();
    const scroller = minimapScroller(rail.element());
    scroller.scrollTop = scroller.scrollHeight;
    await expect.poll(() => scroller.scrollTop).toBeGreaterThan(0);
    const bottom = scroller.scrollTop;

    rail.element().dispatchEvent(
      new WheelEvent("wheel", {
        bubbles: true,
        deltaY: -100,
        wheelDeltaY: 120,
      } as WheelEventInit),
    );

    expect(onLeaveBottom).toHaveBeenCalledTimes(1);
    expect(scroller.scrollTop).toBe(bottom);
    await expect.poll(() => scroller.scrollTop).toBe(bottom - 100);
    await screen.unmount();
  });

  it("starts keyboard focus at the turn in view", async () => {
    const onSelect = vi.fn();
    const screen = await render(<Harness width={1000} onSelect={onSelect} boundsOffset={300} />);
    await expect.poll(() => ticks()[1]?.dataset.inView).toBe("true");
    const button = screen.getByRole("button", { name: /Jump to message/ });
    button.element().focus();
    await expect.element(button).toHaveAccessibleName("Jump to message: Second prompt");
    await screen.unmount();
  });

  it("tabs through the previous button, the rail and the next button in the order they are drawn", async () => {
    const screen = await render(<Harness width={1000} onSelect={() => {}} />);
    await expect.poll(() => ticks().length).toBe(3);
    const labels = [
      ...document.querySelectorAll<HTMLButtonElement>("[data-testid=timeline-minimap] button"),
    ].map((button) => button.getAttribute("aria-label")?.split(":")[0]);
    expect(labels).toEqual(["Previous turn", "Jump to message", "Next turn"]);
    await screen.unmount();
  });

  it("passes the wheel to the timeline from a disabled turn button", async () => {
    const screen = await render(<Harness width={1000} onSelect={() => {}} />);
    const previous = screen.getByRole("button", { name: "Previous turn" });
    await expect.element(previous).toHaveAttribute("aria-disabled", "true");
    const scroller = minimapScroller(previous.element());
    previous.element().dispatchEvent(
      new WheelEvent("wheel", {
        bubbles: true,
        deltaY: 100,
        wheelDeltaY: -120,
      } as WheelEventInit),
    );
    await expect.poll(() => scroller.scrollTop).toBe(100);
    await screen.unmount();
  });

  it("keeps focus on a turn button that reaches an end, and ignores it there", async () => {
    const onSelect = vi.fn();
    const screen = await render(<Harness width={1000} onSelect={onSelect} boundsOffset={600} />);
    const next = screen.getByRole("button", { name: "Next turn" });
    await expect.element(next).toHaveAttribute("aria-disabled", "true");
    const element = next.element() as HTMLButtonElement;
    element.focus();
    expect(document.activeElement).toBe(element);
    element.click();
    expect(onSelect).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(element);
    await screen.unmount();
  });

  it("has no next turn once the timeline cannot scroll further", async () => {
    const onSelect = vi.fn();
    const screen = await render(<Harness width={1000} onSelect={onSelect} />);
    const next = screen.getByRole("button", { name: "Next turn" });
    await expect.element(next).not.toHaveAttribute("aria-disabled");
    const scroller = minimapScroller(next.element());
    scroller.scrollTop = scroller.scrollHeight;
    await expect.element(next).toHaveAttribute("aria-disabled", "true");
    (next.element() as HTMLElement).click();
    expect(onSelect).not.toHaveBeenCalled();
    await screen.unmount();
  });

  it("selects the neighbouring turn and disables the ends", async () => {
    const onSelect = vi.fn();
    const screen = await render(<Harness width={1000} onSelect={onSelect} />);
    await expect.poll(() => ticks()[0]?.dataset.inView).toBe("true");
    const previous = screen.getByRole("button", { name: "Previous turn" });
    const next = screen.getByRole("button", { name: "Next turn" });
    await expect.element(next).not.toHaveAttribute("aria-disabled");
    await expect.element(previous).toHaveAttribute("aria-disabled", "true");

    (next.element() as HTMLElement).click();
    expect(onSelect).toHaveBeenCalledWith(ITEMS[1]);
    await screen.unmount();
  });

  it("keeps focus where it is when pressing a turn button", async () => {
    const screen = await render(<Harness width={1000} onSelect={() => {}} />);
    const next = screen.getByRole("button", { name: "Next turn" });
    await expect.element(next).not.toHaveAttribute("aria-disabled");
    const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    next.element().dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    await screen.unmount();
  });

  it("highlights visible ticks, previews as plain text and selects the hovered item", async () => {
    const onSelect = vi.fn();
    const screen = await render(<Harness width={1000} onSelect={onSelect} />);
    const button = screen.getByRole("button", { name: /Jump to message/ });
    await expect.element(button).toBeInTheDocument();

    await expect
      .poll(() => ticks().map((tick) => tick.dataset.inView))
      .toEqual(["true", "true", "false"]);

    const rect = button.element().getBoundingClientRect();
    button
      .element()
      .dispatchEvent(
        new MouseEvent("mousemove", { bubbles: true, clientX: rect.left + 4, clientY: rect.top }),
      );
    await expect
      .poll(() => document.querySelector("[data-minimap-preview]")?.textContent)
      .toBe("First promptBold reply");

    button.element().dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        detail: 1,
        clientX: rect.left + 4,
        clientY: rect.bottom,
      }),
    );
    expect(onSelect).toHaveBeenCalledWith(ITEMS[2]);
    await screen.unmount();
  });
});
