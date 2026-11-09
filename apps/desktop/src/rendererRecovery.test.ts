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
  it("allows at most three reloads per rolling minute", () => {
    const policy = createRendererRecoveryPolicy({ maxAttempts: 3, windowMs: 60_000 });
    expect(policy.shouldRecover("oom", 0)).toBe(true);
    expect(policy.shouldRecover("crashed", 1_000)).toBe(true);
    expect(policy.shouldRecover("abnormal-exit", 2_000)).toBe(true);
    expect(policy.shouldRecover("oom", 3_000)).toBe(false);
    expect(policy.shouldRecover("oom", 59_999)).toBe(false);
  });

  it("frees attempts as they age out of the window", () => {
    const policy = createRendererRecoveryPolicy({ maxAttempts: 3, windowMs: 60_000 });
    policy.shouldRecover("oom", 0);
    policy.shouldRecover("oom", 10_000);
    policy.shouldRecover("oom", 20_000);
    expect(policy.shouldRecover("oom", 30_000)).toBe(false);
    expect(policy.shouldRecover("oom", 60_000)).toBe(true);
    expect(policy.shouldRecover("oom", 60_001)).toBe(false);
    expect(policy.shouldRecover("oom", 70_000)).toBe(true);
  });

  it("does not count non-recoverable exits against the budget", () => {
    const policy = createRendererRecoveryPolicy({ maxAttempts: 1, windowMs: 60_000 });
    expect(policy.shouldRecover("clean-exit", 0)).toBe(false);
    expect(policy.shouldRecover("launch-failed", 0)).toBe(false);
    expect(policy.shouldRecover("crashed", 0)).toBe(true);
  });
});
