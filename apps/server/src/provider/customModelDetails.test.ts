import { describe, expect, it } from "vitest";

import { applyCustomModelDetails, customModelDetailsBySlug } from "./customModelDetails";
import { EMPTY_MODEL_CAPABILITIES } from "./providerSnapshot";

const capabilities = { ...EMPTY_MODEL_CAPABILITIES, supportsFastMode: true };

describe("customModelDetailsBySlug", () => {
  it("skips bare slugs and keys entries by the normalized slug", () => {
    const details = customModelDetailsBySlug("claudeAgent", [
      { slug: "bare" },
      { slug: "opus", name: "My Opus" },
    ]);
    expect([...details.keys()]).toEqual(["claude-opus-5-5"]);
  });
});

describe("applyCustomModelDetails", () => {
  const model = (slug: string, isCustom: boolean) => ({
    slug,
    name: slug,
    isCustom,
    capabilities: EMPTY_MODEL_CAPABILITIES,
  });

  it("applies name and capabilities to custom models only", () => {
    const details = customModelDetailsBySlug("codex", [
      { slug: "custom-a", name: "Named", capabilities },
      { slug: "builtin", name: "Ignored" },
    ]);
    expect(
      applyCustomModelDetails([model("custom-a", true), model("builtin", false)], details),
    ).toEqual([
      { slug: "custom-a", name: "Named", isCustom: true, capabilities },
      model("builtin", false),
    ]);
  });

  it("keeps what the model had for a field the entry leaves out", () => {
    const details = customModelDetailsBySlug("codex", [{ slug: "named-only", name: "Named" }]);
    expect(applyCustomModelDetails([model("named-only", true)], details)[0]?.capabilities).toBe(
      EMPTY_MODEL_CAPABILITIES,
    );
  });
});
