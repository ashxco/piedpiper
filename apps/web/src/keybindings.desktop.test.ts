import type { ResolvedKeybindingsConfig } from "@piedpiper/contracts";
import { assert, describe, it, vi } from "vitest";

vi.mock("./env", () => ({ isElectron: true }));

import { resolveShortcutCommand, shouldShowThreadJumpHints } from "./keybindings";

const jumpBindings: ResolvedKeybindingsConfig = [
  {
    command: "thread.jump.1",
    shortcut: {
      key: "1",
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      modKey: true,
    },
    whenAst: { type: "not", node: { type: "identifier", name: "isWeb" } },
  },
];

const ctrl1 = { key: "1", metaKey: false, ctrlKey: true, shiftKey: false, altKey: false };

describe("keybindings in the desktop app", () => {
  it("defaults isWeb to false and isDesktop to true without an explicit context", () => {
    assert.strictEqual(
      resolveShortcutCommand(ctrl1, jumpBindings, { platform: "Linux" }),
      "thread.jump.1",
    );
    assert.isTrue(shouldShowThreadJumpHints(ctrl1, jumpBindings, { platform: "Linux" }));
  });
});
