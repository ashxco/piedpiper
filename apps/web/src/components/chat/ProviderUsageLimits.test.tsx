import type { ServerProvider } from "@piedpiper/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ProviderUsageLimitsPanel } from "./ProviderUsageLimits";

const provider = (overrides: Record<string, unknown>) =>
  ({
    provider: "codex",
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [],
    ...overrides,
  }) as unknown as ServerProvider;

describe("ProviderUsageLimitsPanel", () => {
  it("shows bars for each enabled provider, without needing a turn", () => {
    const markup = renderToStaticMarkup(
      <ProviderUsageLimitsPanel
        onClose={vi.fn()}
        providers={[
          provider({
            usageLimits: {
              checkedAt: "2026-01-01T00:00:00.000Z",
              windows: [{ id: "primary", label: "Session", usedPercent: 40 }],
            },
          }),
          provider({ provider: "claudeAgent", enabled: false }),
        ]}
      />,
    );

    expect(markup).toContain("Codex");
    expect(markup).toContain("40% used");
    expect(markup).toContain('aria-valuenow="40"');
    expect(markup).not.toContain("Claude");
  });

  it("says why a provider has no bars", () => {
    const markup = renderToStaticMarkup(
      <ProviderUsageLimitsPanel
        onClose={vi.fn()}
        providers={[
          provider({
            usageLimits: {
              checkedAt: "2026-01-01T00:00:00.000Z",
              windows: [],
              unavailable: { reason: "unsupported" },
            },
          }),
        ]}
      />,
    );

    expect(markup).toContain("This account has no subscription limits to show.");
    expect(markup).not.toContain("progressbar");
  });

  it("asks a signed-out provider to sign in", () => {
    const markup = renderToStaticMarkup(
      <ProviderUsageLimitsPanel
        onClose={vi.fn()}
        providers={[provider({ auth: { status: "unauthenticated" } })]}
      />,
    );

    expect(markup).toContain("Sign in to see usage limits.");
    expect(markup).not.toContain("No usage data yet.");
  });
});
