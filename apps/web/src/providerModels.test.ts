import type { ProviderKind, ServerProvider } from "@piedpiper/contracts";
import { describe, expect, it } from "vitest";

import { resolveDefaultProvider, resolveSelectableProvider } from "./providerModels";

function provider(kind: ProviderKind, overrides: Partial<ServerProvider> = {}): ServerProvider {
  return {
    provider: kind,
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [],
    ...overrides,
  };
}

const notInstalled = {
  installed: false,
  version: null,
  status: "error",
  auth: { status: "unknown" },
} satisfies Partial<ServerProvider>;

const pending = {
  installed: false,
  version: null,
  status: "warning",
  auth: { status: "unknown" },
} satisfies Partial<ServerProvider>;

describe("resolveDefaultProvider", () => {
  it("keeps Claude while the provider list is empty or still being checked", () => {
    expect(resolveDefaultProvider([])).toBe("claudeAgent");
    expect(resolveDefaultProvider([provider("codex"), provider("claudeAgent", pending)])).toBe(
      "claudeAgent",
    );
  });

  it("prefers Claude when it is ready", () => {
    expect(resolveDefaultProvider([provider("codex"), provider("claudeAgent")])).toBe(
      "claudeAgent",
    );
  });

  it("stays on an installed Claude whose auth probe only warns, even when Codex is ready", () => {
    expect(
      resolveDefaultProvider([
        provider("codex"),
        provider("claudeAgent", { status: "warning", auth: { status: "unknown" } }),
      ]),
    ).toBe("claudeAgent");
  });

  it("skips an installed provider that is erroring", () => {
    expect(
      resolveDefaultProvider([
        provider("codex"),
        provider("claudeAgent", { status: "error", auth: { status: "unauthenticated" } }),
      ]),
    ).toBe("codex");
  });

  it("falls back to a ready provider when the Claude CLI is not installed", () => {
    expect(resolveDefaultProvider([provider("codex"), provider("claudeAgent", notInstalled)])).toBe(
      "codex",
    );
  });

  it("falls back to a non-error provider when none is ready", () => {
    expect(
      resolveDefaultProvider([
        provider("codex", { status: "warning", auth: { status: "unknown" } }),
        provider("claudeAgent", notInstalled),
      ]),
    ).toBe("codex");
  });

  it("ignores disabled providers", () => {
    expect(
      resolveDefaultProvider([
        provider("codex", { enabled: false, status: "disabled" }),
        provider("claudeAgent", notInstalled),
      ]),
    ).toBe("claudeAgent");
  });
});

describe("resolveSelectableProvider", () => {
  const providers = [provider("codex"), provider("claudeAgent", notInstalled)];

  it("uses the default provider when no preference is given", () => {
    expect(resolveSelectableProvider(providers, null)).toBe("codex");
    expect(resolveSelectableProvider(providers, undefined)).toBe("codex");
  });

  it("keeps an explicit choice of an enabled provider", () => {
    expect(resolveSelectableProvider(providers, "claudeAgent")).toBe("claudeAgent");
  });
});
