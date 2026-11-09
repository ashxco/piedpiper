import { describe, expect, it } from "vitest";

import { normalizeProviderModelOptions } from "./composerModelNormalization";

describe("normalizeProviderModelOptions", () => {
  it.each(["ultra", "max", "xhigh", "low"])("keeps the Codex reasoning effort %s", (effort) => {
    expect(normalizeProviderModelOptions({ codex: { reasoningEffort: effort } }, "codex")).toEqual({
      codex: { reasoningEffort: effort },
    });
  });

  it.each(["ultrafast", null])("carries the Codex service tier %s", (serviceTier) => {
    expect(normalizeProviderModelOptions({ codex: { serviceTier } }, "codex")).toEqual({
      codex: { serviceTier },
    });
  });

  it("drops a blank Codex service tier", () => {
    expect(normalizeProviderModelOptions({ codex: { serviceTier: "  " } }, "codex")).toBeNull();
  });

  it("drops an unknown Codex reasoning effort", () => {
    expect(
      normalizeProviderModelOptions({ codex: { reasoningEffort: "turbo" } }, "codex"),
    ).toBeNull();
  });

  it.each([true, false])("carries the Claude ultracode choice %s", (ultracode) => {
    expect(normalizeProviderModelOptions({ claudeAgent: { effort: "high", ultracode } })).toEqual({
      claudeAgent: { effort: "high", ultracode },
    });
    expect(normalizeProviderModelOptions({ claudeAgent: { ultracode } })).toEqual({
      claudeAgent: { ultracode },
    });
  });

  it("drops a non-boolean Claude ultracode value", () => {
    expect(normalizeProviderModelOptions({ claudeAgent: { ultracode: "on" } })).toBeNull();
  });
});
