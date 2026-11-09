import type { ModelCapabilities, ServerProviderModel } from "@piedpiper/contracts";

import { normalizeCodexServiceTierId } from "./codexModelList";

/** ChatGPT plan slug from `account/read`; Codex keeps adding new ones, so any string is accepted. */
export type CodexPlanType =
  | "free"
  | "go"
  | "plus"
  | "pro"
  | "prolite"
  | "promax"
  | "team"
  | "business"
  | "enterprise"
  | "edu"
  | "unknown"
  | (string & {});

export interface CodexAccountSnapshot {
  readonly type: "apiKey" | "chatgpt" | "unknown";
  readonly planType: CodexPlanType | null;
  readonly sparkEnabled: boolean;
  /** Models reported by `model/list`, when the installed CLI supports it. */
  readonly listedModels?: ReadonlyArray<ServerProviderModel>;
  /** `service_tier` from the user's Codex config (no project layers), when `config/read` reports one. */
  readonly configuredServiceTier?: string;
  /** Answer to `account/rateLimits/read`; only ChatGPT accounts are asked. */
  readonly rateLimits?: CodexRateLimitsRead;
}

export type CodexRateLimitsRead =
  | { readonly readAt: string; readonly response: unknown }
  | { readonly readAt: string; readonly failure: string };

export const CODEX_DEFAULT_MODEL = "gpt-5.3-codex";
export const CODEX_SPARK_MODEL = "gpt-5.3-codex-spark";

/** ChatGPT plans known to lack Spark; slugs Codex adds later are not hidden or rerouted. */
const CODEX_PLANS_WITHOUT_SPARK: ReadonlySet<string> = new Set([
  "unknown",
  "free",
  "go",
  "plus",
  "team",
  "business",
  "self_serve_business_usage_based",
  "enterprise",
  "ent26",
  "enterprise_cbp_automation",
  "enterprise_cbp_usage_based",
  "edu",
  "edu_plus",
]);

/** Every Pro tier (pro, prolite, promax, ...) and any plan not known to lack it includes Spark. */
export function codexPlanHasSpark(planType: string | null | undefined): boolean {
  if (typeof planType !== "string" || planType.length === 0) return false;
  return planType.startsWith("pro") || !CODEX_PLANS_WITHOUT_SPARK.has(planType);
}

const CODEX_PLAN_LABELS: Readonly<Record<string, string>> = {
  free: "ChatGPT Free Subscription",
  go: "ChatGPT Go Subscription",
  plus: "ChatGPT Plus Subscription",
  pro: "ChatGPT Pro 200 Subscription",
  prolite: "ChatGPT Pro 100 Subscription",
  promax: "ChatGPT Pro 500 Subscription",
  self_serve_business_prolite: "ChatGPT Business Premium Subscription",
  team: "ChatGPT Business Subscription",
  self_serve_business_usage_based: "ChatGPT Business Subscription",
  business: "ChatGPT Business Subscription",
  ent26: "ChatGPT Enterprise Subscription",
  enterprise_cbp_automation: "ChatGPT Enterprise Subscription",
  enterprise_cbp_usage_based: "ChatGPT Enterprise Subscription",
  enterprise: "ChatGPT Enterprise Subscription",
  edu: "ChatGPT Edu Subscription",
  edu_plus: "ChatGPT Edu Subscription",
  edu_pro: "ChatGPT Edu Subscription",
};

/** Display label for a ChatGPT plan slug, or undefined for slugs Pied Piper does not know. */
export function codexPlanLabel(planType: string | null | undefined): string | undefined {
  return planType && Object.hasOwn(CODEX_PLAN_LABELS, planType)
    ? CODEX_PLAN_LABELS[planType]
    : undefined;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function readCodexAccountSnapshot(response: unknown): CodexAccountSnapshot {
  const record = asObject(response);
  const account = asObject(record?.account) ?? record;
  const accountType = asString(account?.type);

  if (accountType === "apiKey") {
    return {
      type: "apiKey",
      planType: null,
      sparkEnabled: false,
    };
  }

  if (accountType === "chatgpt") {
    const planType: CodexPlanType = asString(account?.planType) || "unknown";
    return {
      type: "chatgpt",
      planType,
      sparkEnabled: codexPlanHasSpark(planType),
    };
  }

  return {
    type: "unknown",
    planType: null,
    sparkEnabled: false,
  };
}

/**
 * `account/read` takes the plan from the cached login token, which goes stale after a plan change;
 * the usage read asks the backend. Only used when Pied Piper can label it. Spark keeps the token's
 * plan, because it must agree with `resolveCodexModelForAccount`.
 */
function codexUsagePlanType(account: CodexAccountSnapshot): string | undefined {
  const read = account.rateLimits;
  if (!read || !("response" in read)) return undefined;
  const response = asObject(read.response);
  const bucket =
    asObject(asObject(response?.rateLimitsByLimitId)?.codex) ?? asObject(response?.rateLimits);
  const planType = asString(bucket?.planType);
  return codexPlanLabel(planType) ? planType : undefined;
}

export function codexAuthSubType(account: CodexAccountSnapshot | undefined): string | undefined {
  if (account?.type === "apiKey") {
    return "apiKey";
  }

  if (account?.type !== "chatgpt") {
    return undefined;
  }

  const usagePlanType = codexUsagePlanType(account);
  if (usagePlanType) {
    return usagePlanType;
  }
  return account.planType && account.planType !== "unknown" ? account.planType : "chatgpt";
}

export function codexAuthSubLabel(account: CodexAccountSnapshot | undefined): string | undefined {
  const subType = codexAuthSubType(account);
  if (subType === "apiKey") {
    return "OpenAI API Key";
  }
  if (subType === undefined) {
    return undefined;
  }
  return codexPlanLabel(subType) ?? "ChatGPT Subscription";
}

export function adjustCodexModelsForAccount(
  baseModels: ReadonlyArray<ServerProviderModel>,
  account: CodexAccountSnapshot | undefined,
): ReadonlyArray<ServerProviderModel> {
  // Must agree with resolveCodexModelForAccount, which only sees the account/read snapshot.
  if (account?.sparkEnabled !== false) {
    return baseModels;
  }

  return baseModels.filter((model) => model.isCustom || model.slug !== CODEX_SPARK_MODEL);
}

/** Moves `isDefault` to the configured tier; returns the same array when nothing matches. */
function withConfiguredDefaultTier(
  options: ModelCapabilities["serviceTierOptions"],
  configured: string,
): ModelCapabilities["serviceTierOptions"] {
  if (!options?.some((option) => option.value === configured)) return options;
  return options.map(({ isDefault: _isDefault, ...option }) =>
    option.value === configured ? { ...option, isDefault: true } : option,
  );
}

/**
 * A `service_tier` in the user's Codex config already applies to turns, so the picker's tier
 * defaults to it: a fast tier turns the Fast toggle on, and any listed tier becomes the default.
 */
export function applyConfiguredCodexServiceTier(
  models: ReadonlyArray<ServerProviderModel>,
  serviceTier: string | undefined,
): ReadonlyArray<ServerProviderModel> {
  if (!serviceTier) return models;
  const configured = normalizeCodexServiceTierId(serviceTier);
  let changed = false;
  const next = models.map((model) => {
    const baseCapabilities = model.capabilities;
    if (!baseCapabilities) return model;
    const fastModeDefault = configured === "fast" && baseCapabilities.supportsFastMode;
    const serviceTierOptions = withConfiguredDefaultTier(
      baseCapabilities.serviceTierOptions,
      configured,
    );
    if (!fastModeDefault && serviceTierOptions === baseCapabilities.serviceTierOptions) {
      return model;
    }
    changed = true;
    const withFastDefault = fastModeDefault
      ? { ...baseCapabilities, fastModeDefault: true }
      : baseCapabilities;
    return {
      ...model,
      capabilities: serviceTierOptions
        ? { ...withFastDefault, serviceTierOptions }
        : withFastDefault,
    };
  });
  return changed ? next : models;
}

export function resolveCodexModelForAccount(
  model: string | undefined,
  account: CodexAccountSnapshot,
): string | undefined {
  if (model !== CODEX_SPARK_MODEL || account.sparkEnabled) {
    return model;
  }

  return CODEX_DEFAULT_MODEL;
}
