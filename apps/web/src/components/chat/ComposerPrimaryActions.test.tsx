import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ComposerPrimaryActions } from "./ComposerPrimaryActions";
import { STOP_UNRESPONSIVE_AFTER_MS } from "./composerThreadStop";

function renderActions(input: {
  isRunning: boolean;
  withPendingQuestion: boolean;
  stopRequestedAtMs?: number;
  forceStopRequestedAtMs?: number;
  compact?: boolean;
}) {
  return renderToStaticMarkup(
    <ComposerPrimaryActions
      compact={input.compact ?? false}
      pendingAction={
        input.withPendingQuestion
          ? {
              questionIndex: 1,
              isLastQuestion: false,
              canAdvance: true,
              isResponding: false,
              isComplete: false,
            }
          : null
      }
      isRunning={input.isRunning}
      showPlanFollowUpPrompt={false}
      promptHasText={false}
      isSendBusy={false}
      isConnecting={false}
      isPreparingWorktree={false}
      onPreviousPendingQuestion={() => {}}
      onInterrupt={() => {}}
      onImplementPlanInNewThread={() => {}}
      {...(input.stopRequestedAtMs === undefined
        ? {}
        : { stopRequestedAtMs: input.stopRequestedAtMs, onForceStop: () => {} })}
      {...(input.forceStopRequestedAtMs === undefined
        ? {}
        : { forceStopRequestedAtMs: input.forceStopRequestedAtMs })}
    />,
  );
}

const count = (markup: string) => markup.split("Agent not responding to Stop").length - 1;

const statusText = (markup: string) => /role="status"[^>]*>([^<]*)</.exec(markup)?.[1];

describe("ComposerPrimaryActions", () => {
  it("shows Stop beside the question navigation while the turn is running", () => {
    const markup = renderActions({ isRunning: true, withPendingQuestion: true });
    expect(markup).toContain('aria-label="Stop generation"');
    expect(markup.indexOf("Stop generation")).toBeLessThan(markup.indexOf("Previous"));
    expect(markup).toContain("Next");
  });

  it("hides Stop on a pending question when the turn is not running", () => {
    const markup = renderActions({ isRunning: false, withPendingQuestion: true });
    expect(markup).not.toContain("Stop generation");
    expect(markup).toContain("Previous");
  });

  it("shows Stop in place of Send while running without a question", () => {
    const markup = renderActions({ isRunning: true, withPendingQuestion: false });
    expect(markup).toContain("Stop generation");
    expect(markup).not.toContain("Send message");
  });

  it("replaces Stop with a disabled Stopping button and elapsed time once requested", () => {
    const markup = renderActions({
      isRunning: true,
      withPendingQuestion: false,
      stopRequestedAtMs: Date.now() - 5_000,
    });
    expect(markup).not.toContain("Stop generation");
    expect(markup).toMatch(/<button[^>]*disabled[^>]*>Stopping/);
    expect(markup).toMatch(/[5-9]s</);
    expect(markup).not.toContain("Force stop");
    expect(markup).not.toContain("Agent not responding");
  });

  it("offers Force stop only after the threshold, without promising a process kill", () => {
    const markup = renderActions({
      isRunning: true,
      withPendingQuestion: false,
      stopRequestedAtMs: Date.now() - STOP_UNRESPONSIVE_AFTER_MS,
    });
    expect(markup).toContain("Agent not responding to Stop");
    expect(markup).toContain("Force stop");
    expect(markup).not.toMatch(/\bkill/i);
    expect(markup).toContain("Stopping");
  });

  it("marks Stopping aria-disabled rather than disabled, so the button can keep focus", () => {
    const markup = renderActions({
      isRunning: true,
      withPendingQuestion: false,
      stopRequestedAtMs: Date.now(),
    });
    expect(markup).toContain('aria-disabled="true"');
    expect(markup).not.toMatch(/\sdisabled(=""|\s|>)/);
  });

  it("keeps a status region mounted before Stop is pressed, and fills it after", () => {
    expect(statusText(renderActions({ isRunning: true, withPendingQuestion: false }))).toBe("");
    expect(
      statusText(
        renderActions({
          isRunning: true,
          withPendingQuestion: false,
          stopRequestedAtMs: Date.now(),
        }),
      ),
    ).toBe("Stopping");
    expect(
      statusText(
        renderActions({
          isRunning: true,
          withPendingQuestion: false,
          compact: true,
          stopRequestedAtMs: Date.now() - STOP_UNRESPONSIVE_AFTER_MS,
        }),
      ),
    ).toBe("Agent not responding to Stop");
  });

  it("shows the not-responding text only outside compact", () => {
    const stopRequestedAtMs = Date.now() - STOP_UNRESPONSIVE_AFTER_MS;
    expect(
      count(renderActions({ isRunning: true, withPendingQuestion: false, stopRequestedAtMs })),
    ).toBe(2);
    expect(
      count(
        renderActions({
          isRunning: true,
          withPendingQuestion: false,
          stopRequestedAtMs,
          compact: true,
        }),
      ),
    ).toBe(1);
  });

  it("shows Force stopping while a dispatched Force stop is in flight", () => {
    const markup = renderActions({
      isRunning: true,
      withPendingQuestion: false,
      stopRequestedAtMs: Date.now() - STOP_UNRESPONSIVE_AFTER_MS,
      forceStopRequestedAtMs: Date.now(),
    });
    expect(markup).toContain("Force stopping...");
    expect(markup).not.toContain("Force stop<");
    expect(markup).toMatch(/aria-disabled="true"[^>]*>Force stopping/);
  });

  it("offers Force stop again once that wait passes", () => {
    const markup = renderActions({
      isRunning: true,
      withPendingQuestion: false,
      stopRequestedAtMs: Date.now() - 2 * STOP_UNRESPONSIVE_AFTER_MS,
      forceStopRequestedAtMs: Date.now() - STOP_UNRESPONSIVE_AFTER_MS,
    });
    expect(markup).toContain("Force stop");
    expect(markup).not.toContain("Force stopping");
  });

  it("keeps the stopping state beside question navigation", () => {
    const markup = renderActions({
      isRunning: true,
      withPendingQuestion: true,
      stopRequestedAtMs: Date.now(),
      compact: true,
    });
    expect(markup).toContain("Stopping");
    expect(markup).not.toContain("Stop generation");
    expect(markup).toContain("Next");
  });

  it("ignores a stop request once the turn is not running", () => {
    const markup = renderActions({
      isRunning: false,
      withPendingQuestion: false,
      stopRequestedAtMs: Date.now() - STOP_UNRESPONSIVE_AFTER_MS,
    });
    expect(markup).not.toContain("Stopping");
    expect(markup).toContain("Send message");
  });
});
