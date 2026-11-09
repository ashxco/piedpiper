import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { RelativeTime } from "./RelativeTime";

const BASE_TIME_MS = Date.parse("2026-03-04T12:00:00.000Z");

describe("RelativeTime", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps counting without the parent re-rendering", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(BASE_TIME_MS);
    const timestamp = new Date(BASE_TIME_MS).toISOString();
    const screen = await render(
      <span data-testid="label">
        <RelativeTime timestamp={timestamp} />|<RelativeTime timestamp={timestamp} valueOnly />
      </span>,
    );
    const label = screen.getByTestId("label");
    await expect.element(label).toHaveTextContent("just now|just now");

    await vi.advanceTimersByTimeAsync(20_000);
    await expect.element(label).toHaveTextContent("20s ago|20s");

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await expect.element(label).toHaveTextContent("5m ago|5m");
  });

  it("honours a longer just-now window", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(BASE_TIME_MS);
    const timestamp = new Date(BASE_TIME_MS).toISOString();
    const screen = await render(
      <span data-testid="label">
        <RelativeTime timestamp={timestamp} valueOnly justNowMs={60_000} />
      </span>,
    );
    const label = screen.getByTestId("label");
    await expect.element(label).toHaveTextContent("just now");

    await vi.advanceTimersByTimeAsync(30_000);
    await expect.element(label).toHaveTextContent("just now");

    await vi.advanceTimersByTimeAsync(31_000);
    await expect.element(label).toHaveTextContent("1m");
  });

  it("renders nothing for a missing or invalid timestamp", async () => {
    const screen = await render(
      <span data-testid="label">
        [<RelativeTime timestamp={null} />
        <RelativeTime timestamp="not-a-date" />]
      </span>,
    );
    await expect.element(screen.getByTestId("label")).toHaveTextContent("[]");
  });
});
