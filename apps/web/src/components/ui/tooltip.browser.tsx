import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { Tooltip, TooltipPopup, TooltipScrollDismissArea, TooltipTrigger } from "./tooltip";

const OPEN_DELAY_MS = 40;

function openPopup() {
  return document.querySelector('[data-slot="tooltip-popup"][data-open]');
}

function TimelineTooltip() {
  return (
    <Tooltip>
      <TooltipTrigger delay={OPEN_DELAY_MS}>message link</TooltipTrigger>
      <TooltipPopup>https://example.com</TooltipPopup>
    </Tooltip>
  );
}

function hover(trigger: HTMLElement) {
  trigger.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" }));
  trigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  trigger.dispatchEvent(new MouseEvent("mouseenter"));
  trigger.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, movementX: 5, movementY: 5 }));
}

function wheel(element: HTMLElement) {
  element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 100 }));
}

function scroll(element: HTMLElement) {
  element.dispatchEvent(new Event("scroll"));
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function renderInArea() {
  const screen = await render(
    <TooltipScrollDismissArea data-testid="area">
      <div data-testid="scrollable">
        <TimelineTooltip />
      </div>
    </TooltipScrollDismissArea>,
  );
  return {
    screen,
    trigger: screen.container.querySelector<HTMLButtonElement>("button")!,
    scrollable: screen.container.querySelector<HTMLElement>('[data-testid="scrollable"]')!,
    area: screen.container.querySelector<HTMLElement>('[data-testid="area"]')!,
  };
}

describe("TooltipScrollDismissArea", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("closes a hovered tooltip when the user scrolls", async () => {
    const { screen, trigger, scrollable } = await renderInArea();
    hover(trigger);
    await vi.waitFor(() => expect(openPopup()).not.toBeNull());

    wheel(scrollable);
    scroll(scrollable);
    await vi.waitFor(() => expect(openPopup()).toBeNull());
    await screen.unmount();
  });

  it("cancels a delayed hover open when the user scrolls first", async () => {
    const { screen, trigger, scrollable } = await renderInArea();
    hover(trigger);
    wheel(scrollable);
    scroll(scrollable);

    await wait(OPEN_DELAY_MS * 3);
    expect(openPopup()).toBeNull();
    await screen.unmount();
  });

  it("opens again after the pointer really moves on the trigger", async () => {
    const { screen, trigger, scrollable } = await renderInArea();
    hover(trigger);
    await vi.waitFor(() => expect(openPopup()).not.toBeNull());
    wheel(scrollable);
    scroll(scrollable);
    await vi.waitFor(() => expect(openPopup()).toBeNull());

    hover(trigger);
    await vi.waitFor(() => expect(openPopup()).not.toBeNull());
    await screen.unmount();
  });

  it("closes when the area itself is the scroller, as in the chat timeline", async () => {
    const { screen, trigger, area } = await renderInArea();
    hover(trigger);
    await vi.waitFor(() => expect(openPopup()).not.toBeNull());

    wheel(area);
    scroll(area);
    await vi.waitFor(() => expect(openPopup()).toBeNull());
    await screen.unmount();
  });

  it.each([
    ["keyboard", new KeyboardEvent("keydown", { bubbles: true, key: "PageDown" })],
    ["touch", new Event("touchmove", { bubbles: true })],
  ])("closes when the scroll follows %s input", async (_name, input) => {
    const { screen, trigger, scrollable } = await renderInArea();
    hover(trigger);
    await vi.waitFor(() => expect(openPopup()).not.toBeNull());

    scrollable.dispatchEvent(input);
    scroll(scrollable);
    await vi.waitFor(() => expect(openPopup()).toBeNull());
    await screen.unmount();
  });

  it("keeps a tooltip open while its trigger has keyboard focus", async () => {
    const { screen, trigger, scrollable } = await renderInArea();
    await userEvent.tab();
    expect(trigger.matches(":focus-visible")).toBe(true);
    hover(trigger);
    await vi.waitFor(() => expect(openPopup()).not.toBeNull());

    wheel(scrollable);
    scroll(scrollable);
    await wait(OPEN_DELAY_MS * 2);
    expect(openPopup()).not.toBeNull();
    expect(document.activeElement).toBe(trigger);
    await screen.unmount();
  });

  it("closes a re-hovered tooltip whose trigger only has focus from a click", async () => {
    const { screen, trigger, scrollable } = await renderInArea();
    await userEvent.click(trigger);
    expect(document.activeElement).toBe(trigger);
    expect(trigger.matches(":focus-visible")).toBe(false);
    await userEvent.unhover(trigger);
    await vi.waitFor(() => expect(openPopup()).toBeNull());

    await userEvent.hover(trigger);
    await vi.waitFor(() => expect(openPopup()).not.toBeNull());
    wheel(scrollable);
    scroll(scrollable);
    await vi.waitFor(() => expect(openPopup()).toBeNull());
    await screen.unmount();
  });

  it("cancels a delayed hover open on a trigger that has focus from a click", async () => {
    const { screen, trigger, scrollable } = await renderInArea();
    await userEvent.click(trigger);
    await userEvent.unhover(trigger);
    await vi.waitFor(() => expect(openPopup()).toBeNull());

    hover(trigger);
    wheel(scrollable);
    scroll(scrollable);
    await wait(OPEN_DELAY_MS * 3);
    expect(openPopup()).toBeNull();
    await screen.unmount();
  });

  it("ignores a wheel event that does not scroll", async () => {
    const { screen, trigger, scrollable } = await renderInArea();
    hover(trigger);
    await vi.waitFor(() => expect(openPopup()).not.toBeNull());

    wheel(scrollable);
    await wait(OPEN_DELAY_MS * 2);
    expect(openPopup()).not.toBeNull();
    await screen.unmount();
  });

  it("ignores scrolling with no user input behind it", async () => {
    const { screen, trigger, scrollable } = await renderInArea();
    hover(trigger);
    await vi.waitFor(() => expect(openPopup()).not.toBeNull());

    scroll(scrollable);
    await wait(OPEN_DELAY_MS * 2);
    expect(openPopup()).not.toBeNull();
    await screen.unmount();
  });

  it("leaves tooltips outside the area alone", async () => {
    const screen = await render(
      <>
        <TooltipScrollDismissArea>
          <div data-testid="scrollable" />
        </TooltipScrollDismissArea>
        <TimelineTooltip />
      </>,
    );
    const trigger = screen.container.querySelector<HTMLButtonElement>("button")!;
    const scrollable = screen.container.querySelector<HTMLElement>('[data-testid="scrollable"]')!;
    hover(trigger);
    await vi.waitFor(() => expect(openPopup()).not.toBeNull());

    wheel(scrollable);
    scroll(scrollable);
    await wait(OPEN_DELAY_MS * 2);
    expect(openPopup()).not.toBeNull();
    await screen.unmount();
  });
});
