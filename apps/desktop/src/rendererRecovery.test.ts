import { describe, expect, it } from "vitest";

import { createRendererRecoveryPolicy, isRecoverableRendererExit } from "./rendererRecovery";

describe("isRecoverableRendererExit", () => {
  it("recovers from crashes, OOM, abnormal exits and kills only", () => {
    expect(isRecoverableRendererExit("crashed")).toBe(true);
    expect(isRecoverableRendererExit("oom")).toBe(true);
    expect(isRecoverableRendererExit("abnormal-exit")).toBe(true);
    expect(isRecoverableRendererExit("killed")).toBe(true);
    expect(isRecoverableRendererExit("clean-exit")).toBe(false);
    expect(isRecoverableRendererExit("launch-failed")).toBe(false);
    expect(isRecoverableRendererExit("integrity-failure")).toBe(false);
  });
});

describe("createRendererRecoveryPolicy", () => {
  const options = { maxAttempts: 3, windowMs: 60_000, reloadDelayMs: 500 };

  it("reloads quickly three times per rolling minute, then backs off instead of giving up", () => {
    const policy = createRendererRecoveryPolicy(options);
    expect(policy.reloadDelayMs("oom", 0)).toBe(500);
    expect(policy.reloadDelayMs("crashed", 1_000)).toBe(500);
    expect(policy.reloadDelayMs("abnormal-exit", 2_000)).toBe(500);
    // The fourth reload waits until the first (at 500) leaves the window.
    expect(policy.reloadDelayMs("oom", 3_000)).toBe(57_500);
    // The fifth waits for the second (at 1_500) to leave the window.
    expect(policy.reloadDelayMs("oom", 60_600)).toBe(900);
  });

  it("returns to fast reloads once earlier attempts age out", () => {
    const policy = createRendererRecoveryPolicy(options);
    policy.reloadDelayMs("oom", 0);
    policy.reloadDelayMs("oom", 10_000);
    policy.reloadDelayMs("oom", 20_000);
    expect(policy.reloadDelayMs("oom", 200_000)).toBe(500);
  });

  it("never reloads after a non-recoverable exit and does not count it", () => {
    const policy = createRendererRecoveryPolicy({ ...options, maxAttempts: 1 });
    expect(policy.reloadDelayMs("clean-exit", 0)).toBeNull();
    expect(policy.reloadDelayMs("launch-failed", 0)).toBeNull();
    expect(policy.reloadDelayMs("crashed", 0)).toBe(500);
  });
});
