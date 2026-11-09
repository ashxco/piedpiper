import type { ServerProvider } from "@piedpiper/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  createProviderStatusNoticeTracker,
  providerStatusNoticeKey,
} from "./ChatView.providerStatusNotice";

function status(overrides: Partial<ServerProvider> = {}): ServerProvider {
  return {
    provider: "claudeAgent",
    enabled: true,
    installed: true,
    version: null,
    status: "error",
    auth: { status: "unauthenticated" },
    checkedAt: "2026-03-04T12:00:00.000Z",
    message: "Not signed in.",
    models: [],
    ...overrides,
  } as ServerProvider;
}

function setup() {
  const tracker = createProviderStatusNoticeTracker();
  let nextId = 0;
  const show = vi.fn(() => `toast-${++nextId}`);
  const close = vi.fn();
  return { sync: (value: ServerProvider | null) => tracker.sync(value, show, close), show, close };
}

describe("providerStatusNoticeKey", () => {
  it("is null for ready and disabled providers", () => {
    expect(providerStatusNoticeKey(status({ status: "ready" }))).toBeNull();
    expect(providerStatusNoticeKey(status({ status: "disabled" }))).toBeNull();
  });

  it("changes with status, auth status and message", () => {
    const base = providerStatusNoticeKey(status());
    expect(providerStatusNoticeKey(status({ status: "warning" }))).not.toBe(base);
    expect(providerStatusNoticeKey(status({ auth: { status: "unknown" } }))).not.toBe(base);
    expect(providerStatusNoticeKey(status({ message: "Other." }))).not.toBe(base);
  });
});

describe("createProviderStatusNoticeTracker", () => {
  it("shows each distinct status once, even after it was dismissed", () => {
    const { sync, show } = setup();
    sync(status());
    sync(status());
    sync({ ...status() });
    expect(show).toHaveBeenCalledTimes(1);
  });

  it("replaces the notice when the message changes", () => {
    const { sync, show, close } = setup();
    sync(status());
    sync(status({ message: "Token expired." }));
    expect(show).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledWith("toast-1");
  });

  it("clears the dismissal once the provider is ready", () => {
    const { sync, show, close } = setup();
    sync(status());
    sync(status({ status: "ready" }));
    expect(close).toHaveBeenCalledWith("toast-1");
    sync(status());
    expect(show).toHaveBeenCalledTimes(2);
  });

  it("keeps each provider's dismissal when switching between providers", () => {
    const { sync, show, close } = setup();
    const codex = status({ provider: "codex", message: "Codex is down." });
    sync(status());
    sync(status({ provider: "codex", status: "ready" }));
    expect(close).toHaveBeenCalledWith("toast-1");
    sync(status());
    sync(codex);
    sync(status());
    sync(codex);
    expect(show).toHaveBeenCalledTimes(2);
  });

  it("closes another provider's visible notice without re-showing it", () => {
    const { sync, show, close } = setup();
    const codex = status({ provider: "codex", message: "Codex is down." });
    sync(status());
    sync(codex);
    expect(close).toHaveBeenCalledWith("toast-1");
    sync(status());
    expect(close).toHaveBeenCalledWith("toast-2");
    expect(show).toHaveBeenCalledTimes(2);
  });

  it("clears only the provider that became ready", () => {
    const { sync, show } = setup();
    const codex = status({ provider: "codex", message: "Codex is down." });
    sync(status());
    sync(codex);
    sync(status({ provider: "codex", status: "ready" }));
    sync(status());
    sync(codex);
    expect(show).toHaveBeenCalledTimes(3);
  });

  it("ignores statuses that have not loaded", () => {
    const { sync, show, close } = setup();
    sync(status());
    sync(null);
    sync(status());
    expect(show).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
  });
});
