import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { type ContextWindowSnapshot } from "~/lib/contextWindow";

import {
  ContextWindowCompactAction,
  ContextWindowMeter,
  ContextWindowUsageBar,
} from "./ContextWindowMeter";

function snapshot(usedPercentage: number | null, maxTokens: number | null): ContextWindowSnapshot {
  return {
    usedTokens: 1_000,
    totalProcessedTokens: null,
    maxTokens,
    remainingTokens: null,
    usedPercentage,
    remainingPercentage: null,
    inputTokens: null,
    cachedInputTokens: null,
    outputTokens: null,
    reasoningOutputTokens: null,
    lastUsedTokens: null,
    lastInputTokens: null,
    lastCachedInputTokens: null,
    lastOutputTokens: null,
    lastReasoningOutputTokens: null,
    toolUses: null,
    durationMs: null,
    compactsAutomatically: false,
    updatedAt: "2026-01-01T00:00:00Z",
  } as ContextWindowSnapshot;
}

describe("ContextWindowMeter", () => {
  it("stays neutral at exactly 90%", () => {
    const markup = renderToStaticMarkup(<ContextWindowMeter usage={snapshot(90, 1_000)} />);
    expect(markup).not.toContain("text-destructive");
    expect(markup).toContain("text-foreground/50");
  });

  it("turns the ring and number red above 90%", () => {
    const markup = renderToStaticMarkup(<ContextWindowMeter usage={snapshot(90.1, 1_000)} />);
    expect(markup.match(/text-destructive/g)).toHaveLength(2);
    expect(markup).toContain(">90<");
    expect(markup).toContain("motion-reduce:transition-none");
  });

  it("clamps the number in the ring above 100%", () => {
    const markup = renderToStaticMarkup(<ContextWindowMeter usage={snapshot(140, 1_000)} />);
    expect(markup).toContain(">100<");
  });
});

describe("ContextWindowCompactAction", () => {
  it("renders nothing without a handler", () => {
    expect(renderToStaticMarkup(<ContextWindowCompactAction disabledReason="Busy" />)).toBe("");
  });

  it("offers an enabled button with no reason", () => {
    for (const disabledReason of [undefined, null]) {
      const markup = renderToStaticMarkup(
        <ContextWindowCompactAction onCompact={vi.fn()} disabledReason={disabledReason} />,
      );
      expect(markup).toContain(">Compact<");
      expect(markup).not.toContain(' disabled=""');
    }
  });

  it("disables the button and shows why", () => {
    const markup = renderToStaticMarkup(
      <ContextWindowCompactAction
        onCompact={vi.fn()}
        disabledReason="Send or clear your draft before compacting"
      />,
    );
    expect(markup).toContain(' disabled=""');
    expect(markup).toContain("Send or clear your draft before compacting");
  });
});

describe("ContextWindowUsageBar", () => {
  it("reports the rounded percentage and keeps the neutral fill at 90%", () => {
    const markup = renderToStaticMarkup(<ContextWindowUsageBar usage={snapshot(90, 1_000)} />);
    expect(markup).toContain('role="progressbar"');
    expect(markup).toContain('aria-valuenow="90"');
    expect(markup).toContain("width:90%");
    expect(markup).not.toContain("bg-destructive");
  });

  it("uses the destructive fill above 90%", () => {
    const markup = renderToStaticMarkup(<ContextWindowUsageBar usage={snapshot(90.1, 1_000)} />);
    expect(markup).toContain("bg-destructive");
  });

  it("clamps above 100%", () => {
    const markup = renderToStaticMarkup(<ContextWindowUsageBar usage={snapshot(140, 1_000)} />);
    expect(markup).toContain('aria-valuenow="100"');
    expect(markup).toContain("width:100%");
  });

  it.each([
    ["no window size", snapshot(null, null)],
    ["a zero window size", snapshot(null, 0)],
  ])("renders nothing with %s", (_name, usage) => {
    expect(renderToStaticMarkup(<ContextWindowUsageBar usage={usage} />)).toBe("");
  });
});
