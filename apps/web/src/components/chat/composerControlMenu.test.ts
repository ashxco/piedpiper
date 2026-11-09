import { describe, expect, it } from "vitest";

import {
  type ChatComposerOpenMenu,
  createComposerMenuOpenChangeHandlers,
  isComposerMenuTriggerHidden,
  resolveComposerControlMenu,
  resolveComposerOverflowShortcutLabel,
} from "./composerControlMenu";

const base = { footerControlsShown: true, hiddenBlocks: [], hasTraitsPicker: true };

describe("resolveComposerControlMenu", () => {
  it("opens the matching footer menu in the wide layout", () => {
    expect(resolveComposerControlMenu({ ...base, control: "model" })).toBe("model");
    expect(resolveComposerControlMenu({ ...base, control: "effort" })).toBe("effort");
    expect(resolveComposerControlMenu({ ...base, control: "mode" })).toBe("mode");
  });

  it("opens the compact menu for hidden controls but keeps the model picker", () => {
    const compact = { ...base, hiddenBlocks: ["traits", "mode", "access"] as const };
    expect(resolveComposerControlMenu({ ...compact, control: "model" })).toBe("model");
    expect(resolveComposerControlMenu({ ...compact, control: "effort" })).toBe("compact");
    expect(resolveComposerControlMenu({ ...compact, control: "mode" })).toBe("compact");
  });

  it("keeps a visible control's own menu while trailing controls are hidden", () => {
    const partial = { ...base, hiddenBlocks: ["access", "plan"] as const };
    expect(resolveComposerControlMenu({ ...partial, control: "effort" })).toBe("effort");
    expect(resolveComposerControlMenu({ ...partial, control: "mode" })).toBe("compact");
    expect(resolveComposerControlMenu({ ...base, hiddenBlocks: ["plan"], control: "mode" })).toBe(
      "mode",
    );
  });

  it("opens nothing when the control is not shown", () => {
    expect(
      resolveComposerControlMenu({ ...base, control: "effort", hasTraitsPicker: false }),
    ).toBeNull();
    expect(
      resolveComposerControlMenu({ ...base, control: "model", footerControlsShown: false }),
    ).toBeNull();
  });
});

describe("isComposerMenuTriggerHidden", () => {
  it("tracks each menu's own block", () => {
    expect(isComposerMenuTriggerHidden("effort", ["traits"])).toBe(true);
    expect(isComposerMenuTriggerHidden("effort", ["access"])).toBe(false);
    expect(isComposerMenuTriggerHidden("mode", ["access"])).toBe(true);
    expect(isComposerMenuTriggerHidden("mode", ["plan"])).toBe(false);
    expect(isComposerMenuTriggerHidden("model", ["traits", "mode", "access"])).toBe(false);
  });

  it("hides the compact menu only when nothing overflows", () => {
    expect(isComposerMenuTriggerHidden("compact", [])).toBe(true);
    expect(isComposerMenuTriggerHidden("compact", ["plan"])).toBe(false);
  });
});

describe("createComposerMenuOpenChangeHandlers", () => {
  function setup(initial: ChatComposerOpenMenu | null) {
    let state = initial;
    const handlers = createComposerMenuOpenChangeHandlers((update) => {
      state = update(state);
    });
    return { handlers, read: () => state };
  }

  it("opens the menu and only closes it when it is the open one", () => {
    const { handlers, read } = setup(null);
    handlers.effort(true);
    expect(read()).toBe("effort");
    handlers.model(false);
    expect(read()).toBe("effort");
    handlers.model(true);
    expect(read()).toBe("model");
    handlers.model(false);
    expect(read()).toBeNull();
  });

  it("returns one handler per menu", () => {
    const { handlers } = setup(null);
    expect(Object.keys(handlers)).toEqual(["model", "effort", "mode", "compact"]);
  });
});

describe("resolveComposerOverflowShortcutLabel", () => {
  const labels = { effortShortcutLabel: "Mod+E", modeShortcutLabel: "Mod+M" };

  it("names no shortcut when only the plan button is hidden, since none opens this menu", () => {
    expect(resolveComposerOverflowShortcutLabel({ hiddenBlocks: ["plan"], ...labels })).toBeNull();
    expect(
      resolveComposerOverflowShortcutLabel({ hiddenBlocks: ["mode", "plan"], ...labels }),
    ).toBeNull();
  });

  it("names the mode shortcut once access is hidden", () => {
    expect(
      resolveComposerOverflowShortcutLabel({ hiddenBlocks: ["access", "plan"], ...labels }),
    ).toBe("Mod+M");
  });

  it("prefers the effort shortcut once traits is hidden, and falls back without one", () => {
    const hiddenBlocks = ["traits", "mode", "access"] as const;
    expect(resolveComposerOverflowShortcutLabel({ hiddenBlocks, ...labels })).toBe("Mod+E");
    expect(
      resolveComposerOverflowShortcutLabel({
        hiddenBlocks,
        effortShortcutLabel: null,
        modeShortcutLabel: "Mod+M",
      }),
    ).toBe("Mod+M");
  });
});
