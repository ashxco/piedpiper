import { describe, expect, it } from "vitest";

import {
  CODEX_DEFAULT_MODEL,
  CODEX_SPARK_MODEL,
  adjustCodexModelsForAccount,
  applyConfiguredCodexServiceTier,
  codexAuthSubLabel,
  codexAuthSubType,
  codexPlanHasSpark,
  readCodexAccountSnapshot,
  resolveCodexModelForAccount,
} from "./codexAccount";

const chatgpt = (planType: unknown) =>
  readCodexAccountSnapshot({ account: { type: "chatgpt", planType } });

describe("codex ChatGPT plans", () => {
  it("labels current ChatGPT plan slugs", () => {
    expect(codexAuthSubLabel(chatgpt("pro"))).toBe("ChatGPT Pro 200 Subscription");
    expect(codexAuthSubLabel(chatgpt("prolite"))).toBe("ChatGPT Pro 100 Subscription");
    expect(codexAuthSubLabel(chatgpt("promax"))).toBe("ChatGPT Pro 500 Subscription");
    expect(codexAuthSubLabel(chatgpt("self_serve_business_prolite"))).toBe(
      "ChatGPT Business Premium Subscription",
    );
    expect(codexAuthSubLabel(chatgpt("team"))).toBe("ChatGPT Business Subscription");
    expect(codexAuthSubLabel(chatgpt("enterprise_cbp_usage_based"))).toBe(
      "ChatGPT Enterprise Subscription",
    );
    expect(codexAuthSubLabel(chatgpt("edu_plus"))).toBe("ChatGPT Edu Subscription");
  });

  it("falls back to a generic label for unknown or missing plans", () => {
    expect(codexAuthSubLabel(chatgpt("some_future_plan"))).toBe("ChatGPT Subscription");
    expect(codexAuthSubLabel(chatgpt(null))).toBe("ChatGPT Subscription");
    expect(codexAuthSubLabel(chatgpt(42))).toBe("ChatGPT Subscription");
    expect(codexAuthSubLabel(readCodexAccountSnapshot({ account: { type: "apiKey" } }))).toBe(
      "OpenAI API Key",
    );
    expect(codexAuthSubLabel(readCodexAccountSnapshot({}))).toBeUndefined();
  });

  it("enables Spark for every Pro tier", () => {
    expect(codexPlanHasSpark("pro")).toBe(true);
    expect(codexPlanHasSpark("prolite")).toBe(true);
    expect(codexPlanHasSpark("promax")).toBe(true);
    expect(codexPlanHasSpark("plus")).toBe(false);
    expect(codexPlanHasSpark(null)).toBe(false);
    expect(resolveCodexModelForAccount(CODEX_SPARK_MODEL, chatgpt("promax"))).toBe(
      CODEX_SPARK_MODEL,
    );
    expect(resolveCodexModelForAccount(CODEX_SPARK_MODEL, chatgpt("plus"))).toBe(
      CODEX_DEFAULT_MODEL,
    );
  });

  it("keeps Spark for plan slugs not known to lack it, in the picker and at runtime", () => {
    const spark = { slug: CODEX_SPARK_MODEL, name: "Spark", isCustom: false };
    const base = { slug: CODEX_DEFAULT_MODEL, name: "Default", isCustom: false };
    const models = [base, spark] as never;
    for (const plan of ["some_future_plan", "self_serve_business_prolite", "edu_pro"]) {
      const account = chatgpt(plan);
      expect(adjustCodexModelsForAccount(models, account)).toEqual([base, spark]);
      expect(resolveCodexModelForAccount(CODEX_SPARK_MODEL, account)).toBe(CODEX_SPARK_MODEL);
    }
    for (const plan of ["plus", "team", "enterprise_cbp_usage_based", null]) {
      const account = chatgpt(plan);
      expect(adjustCodexModelsForAccount(models, account)).toEqual([base]);
      expect(resolveCodexModelForAccount(CODEX_SPARK_MODEL, account)).toBe(CODEX_DEFAULT_MODEL);
    }
  });

  it("hides Spark in the picker whenever the runtime would reroute it", () => {
    const spark = { slug: CODEX_SPARK_MODEL, name: "Spark", isCustom: false };
    const base = { slug: CODEX_DEFAULT_MODEL, name: "Default", isCustom: false };
    const plus = { ...chatgpt("plus"), listedModels: [base, spark] as never };
    expect(adjustCodexModelsForAccount([base, spark] as never, plus)).toEqual([base]);
    expect(resolveCodexModelForAccount(CODEX_SPARK_MODEL, plus)).toBe(CODEX_DEFAULT_MODEL);
  });
});

const usagePlan = (planType: unknown) => ({ rateLimits: { planType } });

describe("codex plan badge after a plan change", () => {
  const withUsage = (tokenPlan: string, response: unknown) => ({
    ...chatgpt(tokenPlan),
    rateLimits: { readAt: "2026-02-10T00:00:00.000Z", response },
  });

  it("prefers the plan from the usage read over the login token", () => {
    const account = withUsage("pro", usagePlan("plus"));
    expect(codexAuthSubLabel(account)).toBe("ChatGPT Plus Subscription");
    expect(codexAuthSubType(account)).toBe("plus");
  });

  it("reads the codex bucket first", () => {
    const account = withUsage("pro", {
      rateLimits: { planType: "pro" },
      rateLimitsByLimitId: { codex: { planType: "go" } },
    });
    expect(codexAuthSubLabel(account)).toBe("ChatGPT Go Subscription");
  });

  it.each([["unknown"], ["brand_new_plan"], [null], [undefined]])(
    "keeps the token's plan when the usage read says %s",
    (planType) => {
      expect(codexAuthSubLabel(withUsage("pro", usagePlan(planType)))).toBe(
        "ChatGPT Pro 200 Subscription",
      );
    },
  );

  it("keeps the token's plan when the usage read failed", () => {
    const account = {
      ...chatgpt("pro"),
      rateLimits: { readAt: "2026-02-10T00:00:00.000Z", failure: "Codex could not read usage." },
    };
    expect(codexAuthSubLabel(account)).toBe("ChatGPT Pro 200 Subscription");
  });

  it("leaves an API key account alone", () => {
    const account = {
      ...readCodexAccountSnapshot({ account: { type: "apiKey" } }),
      rateLimits: { readAt: "2026-02-10T00:00:00.000Z", response: usagePlan("plus") },
    };
    expect(codexAuthSubLabel(account)).toBe("OpenAI API Key");
  });

  it("does not change Spark, which follows the token like the runtime does", () => {
    const account = withUsage("pro", usagePlan("plus"));
    expect(account.sparkEnabled).toBe(true);
    expect(resolveCodexModelForAccount(CODEX_SPARK_MODEL, account)).toBe(CODEX_SPARK_MODEL);
    expect(
      adjustCodexModelsForAccount(
        [{ slug: CODEX_SPARK_MODEL, name: "Spark", isCustom: false, capabilities: null }],
        account,
      ),
    ).toHaveLength(1);
  });
});

describe("applyConfiguredCodexServiceTier", () => {
  const capabilities = {
    reasoningEffortLevels: [],
    supportsFastMode: true,
    supportsThinkingToggle: false,
    contextWindowOptions: [],
    promptInjectedEffortLevels: [],
  };
  const fast = { slug: "gpt-fast", name: "Fast", isCustom: false, capabilities };
  const slow = {
    slug: "gpt-slow",
    name: "Slow",
    isCustom: false,
    capabilities: { ...capabilities, supportsFastMode: false },
  };

  it("defaults Fast on for models that support it when the config sets service_tier fast", () => {
    const [fastModel, slowModel] = applyConfiguredCodexServiceTier([fast, slow], "fast");
    expect(fastModel?.capabilities).toMatchObject({ fastModeDefault: true });
    expect(slowModel).toBe(slow);
  });

  it("leaves models unchanged without a fast config tier", () => {
    const models = [fast, slow];
    expect(applyConfiguredCodexServiceTier(models, undefined)).toBe(models);
    expect(applyConfiguredCodexServiceTier(models, "flex")).toBe(models);
  });

  it("moves the default tier to the configured one", () => {
    const tiered = {
      ...fast,
      capabilities: {
        ...capabilities,
        serviceTierOptions: [
          { value: "default", label: "Standard", isDefault: true },
          { value: "fast", label: "Fast" },
          { value: "ultrafast", label: "Ultrafast" },
        ],
      },
    };

    const [ultrafast] = applyConfiguredCodexServiceTier([tiered], "ultrafast");
    expect(ultrafast?.capabilities?.serviceTierOptions).toEqual([
      { value: "default", label: "Standard" },
      { value: "fast", label: "Fast" },
      { value: "ultrafast", label: "Ultrafast", isDefault: true },
    ]);
    expect(ultrafast?.capabilities).not.toHaveProperty("fastModeDefault");

    const [priority] = applyConfiguredCodexServiceTier([tiered], "priority");
    expect(priority?.capabilities).toMatchObject({ fastModeDefault: true });
    expect(
      priority?.capabilities?.serviceTierOptions?.find((option) => option.isDefault)?.value,
    ).toBe("fast");

    const models = [tiered];
    expect(applyConfiguredCodexServiceTier(models, "flex")).toBe(models);
  });
});
