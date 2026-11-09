import { type ProviderKind, type ServerProvider } from "@piedpiper/contracts";
import { useRef } from "react";
import { page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import "../../index.css";

import {
  ComposerMenuFocusContext,
  type ComposerMenuFocusTarget,
} from "../ChatView.composerMenuFocus";
import { ProviderModelPicker } from "./ProviderModelPicker";
import { getCustomModelOptionsByProvider } from "../../modelSelection";
import { DEFAULT_UNIFIED_SETTINGS } from "@piedpiper/contracts/settings";

function effort(value: string, isDefault = false) {
  return {
    value,
    label: value,
    ...(isDefault ? { isDefault: true } : {}),
  };
}

const TEST_PROVIDERS: ReadonlyArray<ServerProvider> = [
  {
    provider: "codex",
    enabled: true,
    installed: true,
    version: "0.116.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: new Date().toISOString(),
    models: [
      {
        slug: "gpt-5-codex",
        name: "GPT-5 Codex",
        isCustom: false,
        capabilities: {
          reasoningEffortLevels: [effort("low"), effort("medium", true), effort("high")],
          supportsFastMode: true,
          supportsThinkingToggle: false,
          contextWindowOptions: [],
          promptInjectedEffortLevels: [],
        },
      },
      {
        slug: "gpt-5.3-codex",
        name: "GPT-5.3 Codex",
        isCustom: false,
        capabilities: {
          reasoningEffortLevels: [effort("low"), effort("medium", true), effort("high")],
          supportsFastMode: true,
          supportsThinkingToggle: false,
          contextWindowOptions: [],
          promptInjectedEffortLevels: [],
        },
      },
    ],
  },
  {
    provider: "claudeAgent",
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: new Date().toISOString(),
    models: [
      {
        slug: "claude-opus-4-6",
        name: "Claude Opus 4.6",
        isCustom: false,
        capabilities: {
          reasoningEffortLevels: [
            effort("low"),
            effort("medium", true),
            effort("high"),
            effort("max"),
          ],
          supportsFastMode: false,
          supportsThinkingToggle: true,
          contextWindowOptions: [],
          promptInjectedEffortLevels: [],
        },
      },
      {
        slug: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        isCustom: false,
        capabilities: {
          reasoningEffortLevels: [
            effort("low"),
            effort("medium", true),
            effort("high"),
            effort("max"),
          ],
          supportsFastMode: false,
          supportsThinkingToggle: true,
          contextWindowOptions: [],
          promptInjectedEffortLevels: [],
        },
      },
      {
        slug: "claude-haiku-4-5",
        name: "Claude Haiku 4.5",
        isCustom: false,
        capabilities: {
          reasoningEffortLevels: [effort("low"), effort("medium", true), effort("high")],
          supportsFastMode: false,
          supportsThinkingToggle: true,
          contextWindowOptions: [],
          promptInjectedEffortLevels: [],
        },
      },
    ],
  },
];

function buildCodexProvider(models: ServerProvider["models"]): ServerProvider {
  return {
    provider: "codex",
    enabled: true,
    installed: true,
    version: "0.116.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: new Date().toISOString(),
    models,
  };
}

async function mountPicker(props: {
  provider: ProviderKind;
  model: string;
  lockedProvider: ProviderKind | null;
  providers?: ReadonlyArray<ServerProvider>;
  triggerVariant?: "ghost" | "outline";
  selectedModels?: ReadonlyArray<{ provider: ProviderKind; model: string }>;
  multiSelect?: boolean;
}) {
  const host = document.createElement("div");
  document.body.append(host);
  const onProviderModelChange = vi.fn();
  const onToggleModel = vi.fn();
  const providers = props.providers ?? TEST_PROVIDERS;
  const modelOptionsByProvider = getCustomModelOptionsByProvider(
    DEFAULT_UNIFIED_SETTINGS,
    providers,
    props.provider,
    props.model,
  );
  const screen = await render(
    <ProviderModelPicker
      provider={props.provider}
      model={props.model}
      lockedProvider={props.lockedProvider}
      providers={providers}
      modelOptionsByProvider={modelOptionsByProvider}
      triggerVariant={props.triggerVariant}
      onProviderModelChange={onProviderModelChange}
      selectedModels={props.selectedModels}
      onToggleModel={props.multiSelect ? onToggleModel : undefined}
    />,
    { container: host },
  );

  return {
    onProviderModelChange,
    onToggleModel,
    cleanup: async () => {
      await screen.unmount();
      host.remove();
    },
  };
}

const CLIENT_SETTINGS_KEY = "piedpiper:client-settings:v1";

function writeClientSettings(settings: Record<string, unknown>) {
  localStorage.setItem(CLIENT_SETTINGS_KEY, JSON.stringify(settings));
}

function readClientSettings(): Record<string, unknown> {
  return JSON.parse(localStorage.getItem(CLIENT_SETTINGS_KEY) ?? "{}");
}

function trigger() {
  const element = document.querySelector<HTMLElement>('[data-chat-provider-model-picker="true"]');
  if (!element) throw new Error("Expected the picker trigger to be mounted.");
  return element;
}

function searchInput() {
  return document.querySelector<HTMLInputElement>('input[aria-label="Search models"]');
}

function options() {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'));
}

function optionNames() {
  return options().map((option) => option.textContent?.trim());
}

function findOption(name: string) {
  const option = options().find((candidate) => candidate.textContent?.includes(name));
  if (!option) throw new Error(`Missing option ${name}`);
  return option;
}

function clickOption(name: string, init: MouseEventInit = {}) {
  findOption(name).dispatchEvent(
    new MouseEvent("click", { bubbles: true, cancelable: true, ...init }),
  );
}

async function openPicker() {
  trigger().click();
  await vi.waitFor(() => {
    expect(searchInput()).not.toBeNull();
    expect(
      options().length + document.querySelectorAll("[data-slot=combobox-empty]").length,
    ).toBeGreaterThan(0);
  });
  await vi.waitFor(() => expect(document.activeElement).toBe(searchInput()));
}

async function typeSearch(query: string) {
  await userEvent.fill(searchInput()!, query);
}

const highlightedOption = () => {
  const option = document.querySelector('[role="option"][data-highlighted]');
  if (!option) throw new Error("Expected a highlighted option.");
  return option;
};

const releaseOn = (element: Element) =>
  element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));

const highlightedName = () =>
  document.querySelector('[role="option"][data-highlighted]')?.textContent?.trim();

describe("ProviderModelPicker", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    localStorage.removeItem(CLIENT_SETTINGS_KEY);
  });

  it("lists every enabled provider's models, grouped by provider, with search focused", async () => {
    const mounted = await mountPicker({
      provider: "claudeAgent",
      model: "claude-opus-4-6",
      lockedProvider: null,
    });

    try {
      await openPicker();
      const codexGroup = document.querySelector('[data-model-picker-section="codex"]');
      expect(codexGroup?.textContent).toContain("Codex");
      expect(codexGroup?.textContent).toContain("GPT-5 Codex");
      expect(optionNames()).toEqual([
        "Claude Opus 4.6",
        "Claude Sonnet 4.6",
        "Claude Haiku 4.5",
        "GPT-5 Codex",
        "GPT-5.3 Codex",
      ]);

      const triggerBox = trigger().getBoundingClientRect();
      const popupBox = document
        .querySelector('[data-slot="combobox-popup"]')!
        .getBoundingClientRect();
      expect(Math.abs(popupBox.left - triggerBox.left)).toBeLessThanOrEqual(8);
      expect(Math.abs(popupBox.top - triggerBox.bottom)).toBeLessThanOrEqual(16);
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows only the locked provider's models", async () => {
    const mounted = await mountPicker({
      provider: "claudeAgent",
      model: "claude-opus-4-6",
      lockedProvider: "claudeAgent",
    });

    try {
      await openPicker();
      expect(optionNames()).toEqual(["Claude Opus 4.6", "Claude Sonnet 4.6", "Claude Haiku 4.5"]);
      expect(document.querySelector('[data-model-picker-section="codex"]')).toBeNull();

      await typeSearch("codex");
      await vi.waitFor(() => expect(options()).toHaveLength(0));
      expect(document.body.textContent).toContain("No models found.");
    } finally {
      await mounted.cleanup();
    }
  });

  it("only shows codex spark when the server reports it for the account", async () => {
    const codexModel = (slug: string, name: string) => ({
      slug,
      name,
      isCustom: false,
      capabilities: {
        reasoningEffortLevels: [effort("low"), effort("medium", true), effort("high")],
        supportsFastMode: true,
        supportsThinkingToggle: false,
        contextWindowOptions: [],
        promptInjectedEffortLevels: [],
      },
    });
    const hidden = await mountPicker({
      provider: "claudeAgent",
      model: "claude-opus-4-6",
      lockedProvider: null,
      providers: [
        buildCodexProvider([codexModel("gpt-5.3-codex", "GPT-5.3 Codex")]),
        TEST_PROVIDERS[1]!,
      ],
    });

    try {
      await openPicker();
      expect(optionNames()).toContain("GPT-5.3 Codex");
      expect(optionNames()).not.toContain("GPT-5.3 Codex Spark");
    } finally {
      await hidden.cleanup();
    }

    const visible = await mountPicker({
      provider: "claudeAgent",
      model: "claude-opus-4-6",
      lockedProvider: null,
      providers: [
        buildCodexProvider([
          codexModel("gpt-5.3-codex", "GPT-5.3 Codex"),
          codexModel("gpt-5.3-codex-spark", "GPT-5.3 Codex Spark"),
        ]),
        TEST_PROVIDERS[1]!,
      ],
    });

    try {
      await openPicker();
      expect(optionNames()).toContain("GPT-5.3 Codex Spark");
    } finally {
      await visible.cleanup();
    }
  });

  function providersWithLegacyHaiku(): ReadonlyArray<ServerProvider> {
    const claudeProvider = TEST_PROVIDERS[1]!;
    return [
      TEST_PROVIDERS[0]!,
      {
        ...claudeProvider,
        models: claudeProvider.models.map((model) =>
          model.slug === "claude-haiku-4-5" ? Object.assign({}, model, { isLegacy: true }) : model,
        ),
      },
    ];
  }

  it("collapses legacy models, keeps them searchable and expands in place", async () => {
    const mounted = await mountPicker({
      provider: "claudeAgent",
      model: "claude-opus-4-6",
      lockedProvider: "claudeAgent",
      providers: providersWithLegacyHaiku(),
    });

    try {
      await openPicker();
      expect(optionNames()).not.toContain("Claude Haiku 4.5");
      clickOption("Legacy models");
      await vi.waitFor(() => expect(optionNames()).toContain("Claude Haiku 4.5"));
      expect(searchInput()).not.toBeNull();
      expect(mounted.onProviderModelChange).not.toHaveBeenCalled();
      clickOption("Legacy models");
      await vi.waitFor(() => expect(optionNames()).not.toContain("Claude Haiku 4.5"));

      await typeSearch("haiku");
      await vi.waitFor(() => expect(optionNames()).toEqual(["Claude Haiku 4.5"]));
      clickOption("Claude Haiku 4.5");
      expect(mounted.onProviderModelChange).toHaveBeenCalledWith("claudeAgent", "claude-haiku-4-5");
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps a selected legacy model outside the collapsed section", async () => {
    const mounted = await mountPicker({
      provider: "claudeAgent",
      model: "claude-haiku-4-5",
      lockedProvider: "claudeAgent",
      providers: providersWithLegacyHaiku(),
    });

    try {
      // A legacy selection still resolves its name on the trigger.
      expect(trigger().textContent).toContain("Claude Haiku 4.5");
      await openPicker();
      expect(optionNames()).toContain("Claude Haiku 4.5");
      expect(findOption("Claude Haiku 4.5").getAttribute("aria-selected")).toBe("true");
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens from the controlled open prop", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const onOpenChange = vi.fn();
    const screen = await render(
      <ProviderModelPicker
        provider="claudeAgent"
        model="claude-opus-4-6"
        lockedProvider="claudeAgent"
        providers={TEST_PROVIDERS}
        modelOptionsByProvider={getCustomModelOptionsByProvider(
          DEFAULT_UNIFIED_SETTINGS,
          TEST_PROVIDERS,
          "claudeAgent",
          "claude-opus-4-6",
        )}
        open
        onOpenChange={onOpenChange}
        onProviderModelChange={vi.fn()}
      />,
      { container: host },
    );

    try {
      await vi.waitFor(() => {
        expect(document.body.textContent ?? "").toContain("Claude Sonnet 4.6");
      });
      clickOption("Claude Sonnet 4.6");
      expect(onOpenChange).toHaveBeenCalledWith(false);
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("dispatches the canonical slug when a model is selected and closes", async () => {
    const mounted = await mountPicker({
      provider: "claudeAgent",
      model: "claude-opus-4-6",
      lockedProvider: "claudeAgent",
    });

    try {
      await openPicker();
      clickOption("Claude Sonnet 4.6");

      expect(mounted.onProviderModelChange).toHaveBeenCalledWith(
        "claudeAgent",
        "claude-sonnet-4-6",
      );
      await vi.waitFor(() => expect(searchInput()).toBeNull());
    } finally {
      await mounted.cleanup();
    }
  });

  it("selects with the keyboard from the search box", async () => {
    const mounted = await mountPicker({
      provider: "claudeAgent",
      model: "claude-opus-4-6",
      lockedProvider: null,
    });

    try {
      await openPicker();
      await typeSearch("sonnet");
      await vi.waitFor(() => expect(optionNames()).toEqual(["Claude Sonnet 4.6"]));
      await userEvent.keyboard("{Enter}");
      await vi.waitFor(() => {
        expect(mounted.onProviderModelChange).toHaveBeenCalledWith(
          "claudeAgent",
          "claude-sonnet-4-6",
        );
      });

      await openPicker();
      await typeSearch("gpt");
      await vi.waitFor(() => expect(optionNames()).toHaveLength(2));
      await userEvent.keyboard("{ArrowDown}{Enter}");
      await vi.waitFor(() => {
        expect(mounted.onProviderModelChange).toHaveBeenLastCalledWith("codex", "gpt-5.3-codex");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  describe("keyboard from the search box", () => {
    const pickerClosed = () => expect(searchInput()).toBeNull();

    it("selects the next row with ArrowDown and Enter, without a query", async () => {
      const mounted = await mountPicker({
        provider: "claudeAgent",
        model: "claude-opus-4-6",
        lockedProvider: "claudeAgent",
      });
      try {
        await openPicker();
        await vi.waitFor(() => expect(highlightedName()).toContain("Claude Opus 4.6"));
        await userEvent.keyboard("{ArrowDown}");
        await vi.waitFor(() => expect(highlightedName()).toContain("Claude Sonnet 4.6"));
        await userEvent.keyboard("{Enter}");
        await vi.waitFor(() => {
          expect(mounted.onProviderModelChange).toHaveBeenCalledWith(
            "claudeAgent",
            "claude-sonnet-4-6",
          );
          pickerClosed();
        });
      } finally {
        await mounted.cleanup();
      }
    });

    it("selects the highlighted selected row with Enter right after opening", async () => {
      const mounted = await mountPicker({
        provider: "claudeAgent",
        model: "claude-sonnet-4-6",
        lockedProvider: "claudeAgent",
      });
      try {
        await openPicker();
        await vi.waitFor(() => expect(highlightedName()).toContain("Claude Sonnet 4.6"));
        await userEvent.keyboard("{Enter}");
        await vi.waitFor(() => {
          expect(mounted.onProviderModelChange).toHaveBeenCalledWith(
            "claudeAgent",
            "claude-sonnet-4-6",
          );
          pickerClosed();
        });
      } finally {
        await mounted.cleanup();
      }
    });

    it("selects a searched row that stayed at its index", async () => {
      const mounted = await mountPicker({
        provider: "claudeAgent",
        model: "claude-sonnet-4-6",
        lockedProvider: "claudeAgent",
      });
      try {
        await openPicker();
        await typeSearch("opus");
        await vi.waitFor(() => expect(optionNames()).toEqual(["Claude Opus 4.6"]));
        await userEvent.keyboard("{Enter}");
        await vi.waitFor(() => {
          expect(mounted.onProviderModelChange).toHaveBeenCalledWith(
            "claudeAgent",
            "claude-opus-4-6",
          );
        });
      } finally {
        await mounted.cleanup();
      }
    });

    it("expands and collapses an expander with Enter, keeping the popup open", async () => {
      const mounted = await mountPicker({
        provider: "claudeAgent",
        model: "claude-opus-4-6",
        lockedProvider: "claudeAgent",
        providers: providersWithLegacyHaiku(),
      });
      try {
        await openPicker();
        await userEvent.keyboard("{ArrowUp}");
        await vi.waitFor(() => expect(highlightedName()).toContain("Legacy models"));
        await userEvent.keyboard("{Enter}");
        await vi.waitFor(() => {
          expect(findOption("Legacy models").getAttribute("aria-expanded")).toBe("true");
        });
        expect(findOption("Claude Haiku 4.5")).toBeTruthy();
        await userEvent.keyboard("{Enter}");
        await vi.waitFor(() => {
          expect(findOption("Legacy models").getAttribute("aria-expanded")).toBe("false");
        });
        expect(searchInput()).not.toBeNull();
        expect(mounted.onProviderModelChange).not.toHaveBeenCalled();
      } finally {
        await mounted.cleanup();
      }
    });

    it("selects the only favorite with Enter in the Favorites view", async () => {
      writeClientSettings({ favorites: [{ provider: "claudeAgent", model: "claude-haiku-4-5" }] });
      const mounted = await mountPicker({
        provider: "claudeAgent",
        model: "claude-opus-4-6",
        lockedProvider: "claudeAgent",
      });
      try {
        await openPicker();
        document.querySelector<HTMLElement>('[aria-label="Show favorites only"]')!.click();
        await vi.waitFor(() => expect(optionNames()).toEqual(["Claude Haiku 4.5"]));
        await userEvent.keyboard("{ArrowDown}");
        await vi.waitFor(() => expect(highlightedName()).toContain("Claude Haiku 4.5"));
        await userEvent.keyboard("{Enter}");
        await vi.waitFor(() => {
          expect(mounted.onProviderModelChange).toHaveBeenCalledWith(
            "claudeAgent",
            "claude-haiku-4-5",
          );
          pickerClosed();
        });
      } finally {
        await mounted.cleanup();
      }
    });

    it("opens on the selected row when a favorite comes first", async () => {
      writeClientSettings({ favorites: [{ provider: "codex", model: "gpt-5-codex" }] });
      const mounted = await mountPicker({
        provider: "claudeAgent",
        model: "claude-sonnet-4-6",
        lockedProvider: null,
      });
      try {
        await openPicker();
        await vi.waitFor(() => expect(highlightedName()).toContain("Claude Sonnet 4.6"));
      } finally {
        await mounted.cleanup();
      }
    });

    // Two, because one collapsed model and its expander would leave later indexes unchanged.
    function providersWithTwoLegacyClaudeModels(): ReadonlyArray<ServerProvider> {
      const claudeProvider = TEST_PROVIDERS[1]!;
      return [
        TEST_PROVIDERS[0]!,
        {
          ...claudeProvider,
          models: claudeProvider.models.map((model) =>
            model.slug === "claude-opus-4-6" ? model : Object.assign({}, model, { isLegacy: true }),
          ),
        },
      ];
    }

    it("opens on the selected row while legacy models are collapsed", async () => {
      const mounted = await mountPicker({
        provider: "codex",
        model: "gpt-5.3-codex",
        lockedProvider: null,
        providers: providersWithTwoLegacyClaudeModels(),
      });
      try {
        await openPicker();
        await vi.waitFor(() => expect(highlightedName()).toContain("GPT-5.3 Codex"));
      } finally {
        await mounted.cleanup();
      }
    });

    it("scrolls the highlighted row into view in a long list", async () => {
      const models = TEST_PROVIDERS[0]!.models;
      const mounted = await mountPicker({
        provider: "codex",
        model: "model-0",
        lockedProvider: "codex",
        providers: [
          buildCodexProvider(
            Array.from({ length: 31 }, (_, index) => ({
              ...models[0]!,
              slug: `model-${index}`,
              name: `Model ${index}`,
            })),
          ),
        ],
      });
      try {
        await openPicker();
        await vi.waitFor(() => expect(highlightedName()).toContain("Model 0"));
        await userEvent.keyboard("{ArrowDown>20/}");
        await vi.waitFor(() => {
          expect(highlightedName()).toContain("Model 20");
          const row = highlightedOption().getBoundingClientRect();
          const popup = highlightedOption()
            .closest('[data-slot="combobox-popup"]')!
            .getBoundingClientRect();
          expect(row.top).toBeGreaterThanOrEqual(popup.top - 1);
          expect(row.bottom).toBeLessThanOrEqual(popup.bottom + 1);
        });
      } finally {
        await mounted.cleanup();
      }
    });
  });

  it("closes on Escape and clears the search for next time", async () => {
    const mounted = await mountPicker({
      provider: "claudeAgent",
      model: "claude-opus-4-6",
      lockedProvider: "claudeAgent",
    });

    try {
      await openPicker();
      await typeSearch("sonnet");
      await userEvent.keyboard("{Escape}");
      await vi.waitFor(() => expect(searchInput()).toBeNull());
      await openPicker();
      expect(searchInput()?.value).toBe("");
      expect(options().length).toBe(3);
    } finally {
      await mounted.cleanup();
    }
  });

  it("stars without selecting or closing, and hoists favorites to the top", async () => {
    const mounted = await mountPicker({
      provider: "claudeAgent",
      model: "claude-opus-4-6",
      lockedProvider: null,
    });

    try {
      await openPicker();
      findOption("GPT-5.3 Codex")
        .querySelector<HTMLElement>('[aria-label="Add to favorites"]')!
        .click();

      await vi.waitFor(() => {
        expect(optionNames()[0]).toBe("GPT-5.3 Codex");
      });
      expect(mounted.onProviderModelChange).not.toHaveBeenCalled();
      expect(searchInput()).not.toBeNull();
      expect(document.activeElement).toBe(searchInput());
      expect(readClientSettings().favorites).toEqual([
        { provider: "codex", model: "gpt-5.3-codex" },
      ]);
      expect(optionNames().filter((name) => name === "GPT-5.3 Codex")).toHaveLength(1);
      expect(
        document.querySelector('[data-model-picker-section="favorites"]')?.textContent,
      ).toContain("Favorites");

      findOption("GPT-5.3 Codex")
        .querySelector<HTMLElement>('[aria-label="Remove from favorites"]')!
        .click();
      await vi.waitFor(() => {
        expect(document.querySelector('[data-model-picker-section="favorites"]')).toBeNull();
      });
      expect(readClientSettings().favorites).toEqual([]);
    } finally {
      await mounted.cleanup();
    }
  });

  it("filters to favorites in the Favorites view and ignores stale ones", async () => {
    writeClientSettings({
      favorites: [
        { provider: "claudeAgent", model: "claude-haiku-4-5" },
        { provider: "claudeAgent", model: "claude-removed" },
        { provider: "codex", model: "gpt-5-codex" },
      ],
    });
    const mounted = await mountPicker({
      provider: "claudeAgent",
      model: "claude-opus-4-6",
      lockedProvider: "claudeAgent",
    });

    try {
      await openPicker();
      document.querySelector<HTMLElement>('[aria-label="Show favorites only"]')!.click();
      await vi.waitFor(() => expect(optionNames()).toEqual(["Claude Haiku 4.5"]));
      expect(document.body.textContent).not.toContain("claude-removed");
      expect(document.body.textContent).not.toContain("GPT-5 Codex");
    } finally {
      await mounted.cleanup();
    }
  });

  it("explains an empty Favorites view", async () => {
    const mounted = await mountPicker({
      provider: "claudeAgent",
      model: "claude-opus-4-6",
      lockedProvider: "claudeAgent",
    });

    try {
      await openPicker();
      document.querySelector<HTMLElement>('[aria-label="Show favorites only"]')!.click();
      await vi.waitFor(() => {
        expect(document.body.textContent).toContain("Star a model to see it here.");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("hides a model behind an expander, keeps it searchable and can show it again", async () => {
    const mounted = await mountPicker({
      provider: "claudeAgent",
      model: "claude-opus-4-6",
      lockedProvider: "claudeAgent",
    });

    try {
      await openPicker();
      expect(
        findOption("Claude Opus 4.6").querySelector('[aria-label="Hide from the model list"]'),
      ).toBeNull();
      findOption("Claude Sonnet 4.6")
        .querySelector<HTMLElement>('[aria-label="Hide from the model list"]')!
        .click();
      await vi.waitFor(() => expect(optionNames()).not.toContain("Claude Sonnet 4.6"));
      expect(mounted.onProviderModelChange).not.toHaveBeenCalled();
      expect(readClientSettings().hiddenModels).toEqual([
        { provider: "claudeAgent", model: "claude-sonnet-4-6" },
      ]);

      await typeSearch("sonnet");
      await vi.waitFor(() => expect(optionNames()).toEqual(["Claude Sonnet 4.6"]));
      await typeSearch("");

      clickOption("Hidden models");
      await vi.waitFor(() => expect(optionNames()).toContain("Claude Sonnet 4.6"));
      findOption("Claude Sonnet 4.6")
        .querySelector<HTMLElement>('[aria-label="Show in the model list"]')!
        .click();
      await vi.waitFor(() => {
        expect(optionNames().join()).not.toContain("Hidden models");
      });
      expect(readClientSettings().hiddenModels).toEqual([]);
    } finally {
      await mounted.cleanup();
    }
  });

  it("offers no hide control on custom models", async () => {
    const mounted = await mountPicker({
      provider: "codex",
      model: "gpt-5-codex",
      lockedProvider: "codex",
      providers: [
        buildCodexProvider([
          {
            slug: "my-model",
            name: "My Model",
            isCustom: true,
            capabilities: TEST_PROVIDERS[0]!.models[0]!.capabilities,
          },
          TEST_PROVIDERS[0]!.models[0]!,
        ]),
        TEST_PROVIDERS[1]!,
      ],
    });

    try {
      await openPicker();
      expect(
        findOption("My Model").querySelector('[aria-label="Hide from the model list"]'),
      ).toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows disabled providers as non-selectable entries", async () => {
    const disabledProviders = TEST_PROVIDERS.slice();
    const claudeIndex = disabledProviders.findIndex(
      (provider) => provider.provider === "claudeAgent",
    );
    if (claudeIndex >= 0) {
      const claudeProvider = disabledProviders[claudeIndex]!;
      disabledProviders[claudeIndex] = {
        ...claudeProvider,
        enabled: false,
        status: "disabled",
      };
    }
    const mounted = await mountPicker({
      provider: "codex",
      model: "gpt-5-codex",
      lockedProvider: null,
      providers: disabledProviders,
    });

    try {
      await openPicker();
      const text = document.body.textContent ?? "";
      expect(text).toContain("Claude");
      expect(text).toContain("Disabled");
      expect(text).not.toContain("Claude Sonnet 4.6");
      expect(optionNames()).toEqual(["GPT-5 Codex", "GPT-5.3 Codex"]);

      await typeSearch("sonnet");
      await vi.waitFor(() => expect(options()).toHaveLength(0));
    } finally {
      await mounted.cleanup();
    }
  });

  it("accepts outline trigger styling", async () => {
    const mounted = await mountPicker({
      provider: "codex",
      model: "gpt-5-codex",
      lockedProvider: null,
      triggerVariant: "outline",
    });

    try {
      expect(trigger().className).toContain("border-input");
      expect(trigger().className).toContain("bg-popover");
    } finally {
      await mounted.cleanup();
    }
  });

  it("does not open while disabled", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <ProviderModelPicker
        provider="claudeAgent"
        model="claude-opus-4-6"
        lockedProvider={null}
        providers={TEST_PROVIDERS}
        modelOptionsByProvider={getCustomModelOptionsByProvider(
          DEFAULT_UNIFIED_SETTINGS,
          TEST_PROVIDERS,
          "claudeAgent",
          "claude-opus-4-6",
        )}
        disabled
        onProviderModelChange={vi.fn()}
      />,
      { container: host },
    );

    try {
      trigger().click();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(searchInput()).toBeNull();
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("shows no multi-select affordance without onToggleModel", async () => {
    const mounted = await mountPicker({
      provider: "codex",
      model: "gpt-5-codex",
      lockedProvider: "codex",
    });

    try {
      await openPicker();
      expect(document.body.textContent ?? "").not.toContain("Shift-click");
      clickOption("GPT-5.3 Codex", { shiftKey: true });
      await vi.waitFor(() => {
        expect(mounted.onProviderModelChange).toHaveBeenCalledWith("codex", "gpt-5.3-codex");
      });
      expect(mounted.onToggleModel).not.toHaveBeenCalled();
    } finally {
      await mounted.cleanup();
    }
  });

  it("toggles on Shift-click from a single model and stays open", async () => {
    const mounted = await mountPicker({
      provider: "codex",
      model: "gpt-5-codex",
      lockedProvider: "codex",
      multiSelect: true,
    });

    try {
      await openPicker();
      expect(document.body.textContent ?? "").toContain("Shift-click");
      clickOption("GPT-5.3 Codex", { shiftKey: true });
      await vi.waitFor(() => {
        expect(mounted.onToggleModel).toHaveBeenCalledWith("codex", "gpt-5.3-codex");
      });
      expect(mounted.onProviderModelChange).not.toHaveBeenCalled();
      expect(options().length).toBeGreaterThan(0);
    } finally {
      await mounted.cleanup();
    }
  });

  it("marks every selected model and summarizes the trigger while several are selected", async () => {
    const mounted = await mountPicker({
      provider: "codex",
      model: "gpt-5-codex",
      lockedProvider: "codex",
      multiSelect: true,
      selectedModels: [
        { provider: "codex", model: "gpt-5-codex" },
        { provider: "codex", model: "gpt-5.3-codex" },
      ],
    });

    try {
      expect(trigger().textContent).toContain("GPT-5 Codex, GPT-5.3 Codex");
      await openPicker();
      expect(document.querySelectorAll('[role="option"][aria-selected="true"]')).toHaveLength(2);

      clickOption("GPT-5 Codex", { shiftKey: true });
      await vi.waitFor(() => {
        expect(mounted.onToggleModel).toHaveBeenCalledWith("codex", "gpt-5-codex");
      });
      expect(mounted.onProviderModelChange).not.toHaveBeenCalled();
    } finally {
      await mounted.cleanup();
    }
  });

  it("returns to one model on a plain click while several are selected", async () => {
    const mounted = await mountPicker({
      provider: "codex",
      model: "gpt-5-codex",
      lockedProvider: "codex",
      multiSelect: true,
      selectedModels: [
        { provider: "codex", model: "gpt-5-codex" },
        { provider: "codex", model: "gpt-5.3-codex" },
      ],
    });

    try {
      await openPicker();
      clickOption("GPT-5.3 Codex");
      await vi.waitFor(() => {
        expect(mounted.onProviderModelChange).toHaveBeenCalledWith("codex", "gpt-5.3-codex");
      });
      expect(mounted.onToggleModel).not.toHaveBeenCalled();
    } finally {
      await mounted.cleanup();
    }
  });

  it("toggles the highlighted model on Shift+Enter", async () => {
    const mounted = await mountPicker({
      provider: "codex",
      model: "gpt-5-codex",
      lockedProvider: "codex",
      multiSelect: true,
    });

    try {
      await openPicker();
      await typeSearch("5.3");
      await vi.waitFor(() => expect(optionNames()).toEqual(["GPT-5.3 Codex"]));
      await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
      await vi.waitFor(() => {
        expect(mounted.onToggleModel).toHaveBeenCalledWith("codex", "gpt-5.3-codex");
      });
      expect(mounted.onProviderModelChange).not.toHaveBeenCalled();
      expect(searchInput()).not.toBeNull();
    } finally {
      await mounted.cleanup();
    }
  });

  describe("row actions from the search box", () => {
    it("stars and unstars the highlighted model with Alt+F, without selecting", async () => {
      const mounted = await mountPicker({
        provider: "claudeAgent",
        model: "claude-opus-4-6",
        lockedProvider: "claudeAgent",
      });

      try {
        await openPicker();
        await typeSearch("sonnet");
        await vi.waitFor(() => expect(highlightedName()).toBe("Claude Sonnet 4.6"));

        await userEvent.keyboard("{Alt>}f{/Alt}");
        await vi.waitFor(() => {
          expect(readClientSettings().favorites).toEqual([
            { provider: "claudeAgent", model: "claude-sonnet-4-6" },
          ]);
        });
        expect(searchInput()?.value).toBe("sonnet");
        expect(document.activeElement).toBe(searchInput());
        expect(mounted.onProviderModelChange).not.toHaveBeenCalled();

        await userEvent.keyboard("{Alt>}f{/Alt}");
        await vi.waitFor(() => expect(readClientSettings().favorites).toEqual([]));
      } finally {
        await mounted.cleanup();
      }
    });

    it("hides and restores the highlighted model with Alt+H", async () => {
      const mounted = await mountPicker({
        provider: "claudeAgent",
        model: "claude-opus-4-6",
        lockedProvider: "claudeAgent",
      });

      try {
        await openPicker();
        await typeSearch("sonnet");
        await vi.waitFor(() => expect(highlightedName()).toBe("Claude Sonnet 4.6"));

        await userEvent.keyboard("{Alt>}h{/Alt}");
        await vi.waitFor(() => {
          expect(readClientSettings().hiddenModels).toEqual([
            { provider: "claudeAgent", model: "claude-sonnet-4-6" },
          ]);
        });
        await userEvent.keyboard("{Alt>}h{/Alt}");
        await vi.waitFor(() => expect(readClientSettings().hiddenModels).toEqual([]));
        expect(mounted.onProviderModelChange).not.toHaveBeenCalled();
      } finally {
        await mounted.cleanup();
      }
    });

    it("will not hide the selected model", async () => {
      const mounted = await mountPicker({
        provider: "claudeAgent",
        model: "claude-opus-4-6",
        lockedProvider: "claudeAgent",
      });

      try {
        await openPicker();
        await typeSearch("opus");
        await vi.waitFor(() => expect(highlightedName()).toBe("Claude Opus 4.6"));

        await userEvent.keyboard("{Alt>}h{/Alt}");
        await userEvent.keyboard("{Alt>}f{/Alt}");
        await vi.waitFor(() => expect(readClientSettings().favorites).toHaveLength(1));
        expect(readClientSettings().hiddenModels ?? []).toEqual([]);
      } finally {
        await mounted.cleanup();
      }
    });

    it("advertises the shortcuts", async () => {
      const mounted = await mountPicker({
        provider: "claudeAgent",
        model: "claude-opus-4-6",
        lockedProvider: "claudeAgent",
      });

      try {
        await openPicker();
        expect(searchInput()?.getAttribute("aria-keyshortcuts")).toBe("Alt+F Alt+H");
        expect(document.body.textContent).toContain("F stars the highlighted model");
      } finally {
        await mounted.cleanup();
      }
    });
  });

  describe("a press released on a row from elsewhere", () => {
    it("selects that model and closes", async () => {
      const mounted = await mountPicker({
        provider: "claudeAgent",
        model: "claude-opus-4-6",
        lockedProvider: "claudeAgent",
      });

      try {
        await openPicker();
        await typeSearch("sonnet");
        await vi.waitFor(() =>
          expect(highlightedOption().textContent).toContain("Claude Sonnet 4.6"),
        );
        releaseOn(highlightedOption());
        await vi.waitFor(() => {
          expect(mounted.onProviderModelChange).toHaveBeenCalledWith(
            "claudeAgent",
            "claude-sonnet-4-6",
          );
        });
        expect(mounted.onProviderModelChange).toHaveBeenCalledTimes(1);
        await vi.waitFor(() => expect(searchInput()).toBeNull());
      } finally {
        await mounted.cleanup();
      }
    });

    it("returns to that one model while several are selected", async () => {
      const mounted = await mountPicker({
        provider: "claudeAgent",
        model: "claude-opus-4-6",
        lockedProvider: null,
        multiSelect: true,
        selectedModels: [
          { provider: "claudeAgent", model: "claude-opus-4-6" },
          { provider: "codex", model: "gpt-5-codex" },
        ],
      });

      try {
        await openPicker();
        await typeSearch("sonnet");
        await vi.waitFor(() =>
          expect(highlightedOption().textContent).toContain("Claude Sonnet 4.6"),
        );
        releaseOn(highlightedOption());
        await vi.waitFor(() => {
          expect(mounted.onProviderModelChange).toHaveBeenCalledWith(
            "claudeAgent",
            "claude-sonnet-4-6",
          );
        });
        expect(mounted.onToggleModel).not.toHaveBeenCalled();
      } finally {
        await mounted.cleanup();
      }
    });

    it("does not select twice for an ordinary click, whose press began on the row", async () => {
      const mounted = await mountPicker({
        provider: "claudeAgent",
        model: "claude-opus-4-6",
        lockedProvider: "claudeAgent",
      });

      try {
        await openPicker();
        await page.getByRole("option", { name: "Claude Sonnet 4.6" }).click();
        await vi.waitFor(() => expect(searchInput()).toBeNull());
        expect(mounted.onProviderModelChange).toHaveBeenCalledTimes(1);
      } finally {
        await mounted.cleanup();
      }
    });

    it("leaves the popup open on an expander", async () => {
      const mounted = await mountPicker({
        provider: "claudeAgent",
        model: "claude-opus-4-6",
        lockedProvider: "claudeAgent",
        providers: providersWithLegacyHaiku(),
      });

      try {
        await openPicker();
        await userEvent.keyboard("{ArrowUp}");
        const expander = findOption("Legacy models");
        await vi.waitFor(() => expect(expander.hasAttribute("data-highlighted")).toBe(true));
        releaseOn(expander);
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(searchInput()).not.toBeNull();
        expect(mounted.onProviderModelChange).not.toHaveBeenCalled();
      } finally {
        await mounted.cleanup();
      }
    });
  });

  it("returns focus to the prompt on Escape inside the composer", async () => {
    function InComposer() {
      const editorRef = useRef<HTMLTextAreaElement>(null);
      const targetRef = useRef<ComposerMenuFocusTarget>({
        focusAtEnd: () => editorRef.current?.focus(),
      });
      return (
        <ComposerMenuFocusContext value={targetRef}>
          <textarea aria-label="editor" ref={editorRef} />
          <ProviderModelPicker
            provider="codex"
            model="gpt-5-codex"
            lockedProvider={null}
            providers={TEST_PROVIDERS}
            modelOptionsByProvider={getCustomModelOptionsByProvider(
              DEFAULT_UNIFIED_SETTINGS,
              TEST_PROVIDERS,
              "codex",
              "gpt-5-codex",
            )}
            onProviderModelChange={vi.fn()}
          />
        </ComposerMenuFocusContext>
      );
    }
    const screen = await render(<InComposer />);
    try {
      await openPicker();
      await userEvent.keyboard("{Escape}");
      await vi.waitFor(() => {
        expect(document.activeElement?.getAttribute("aria-label")).toBe("editor");
      });
    } finally {
      await screen.unmount();
    }
  });

  it("explains Claude models the installed CLI is too old to run", async () => {
    const providers: ReadonlyArray<ServerProvider> = TEST_PROVIDERS.map((provider) =>
      provider.provider === "claudeAgent"
        ? (Object.assign({}, provider, {
            updateRequiredModels: [
              { slug: "claude-opus-5-5", name: "Claude Opus 5.5", minVersion: "2.1.280" },
            ],
          }) as ServerProvider)
        : provider,
    );
    const mounted = await mountPicker({
      provider: "claudeAgent",
      model: "claude-opus-4-6",
      lockedProvider: null,
      providers,
    });

    try {
      await openPicker();
      await expect
        .element(page.getByText("Update Claude Code to v2.1.280 to use Claude Opus 5.5."))
        .toBeVisible();
      expect(optionNames()).not.toContain("Claude Opus 5.5");
    } finally {
      await mounted.cleanup();
    }
  });

  it("leaves the Claude update note out of a thread locked to Codex", async () => {
    const providers: ReadonlyArray<ServerProvider> = TEST_PROVIDERS.map((provider) =>
      provider.provider === "claudeAgent"
        ? (Object.assign({}, provider, {
            updateRequiredModels: [
              { slug: "claude-opus-5-5", name: "Claude Opus 5.5", minVersion: "2.1.280" },
            ],
          }) as ServerProvider)
        : provider,
    );
    const mounted = await mountPicker({
      provider: "codex",
      model: "gpt-5-codex",
      lockedProvider: "codex",
      providers,
    });

    try {
      await openPicker();
      await vi.waitFor(() => expect(optionNames()).toContain("GPT-5 Codex"));
      expect(document.body.textContent).not.toContain("Update Claude Code");

      await page.getByPlaceholder("Search models...").fill("opus");
      await vi.waitFor(() => expect(optionNames()).not.toContain("GPT-5 Codex"));
      expect(document.body.textContent).not.toContain("Update Claude Code");
    } finally {
      await mounted.cleanup();
    }
  });
});
