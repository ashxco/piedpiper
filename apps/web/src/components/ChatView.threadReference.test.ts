import type { KeybindingShortcut, ResolvedKeybindingsConfig } from "@piedpiper/contracts";
import { describe, expect, it } from "vitest";

import { resolveShortcutCommand } from "../keybindings";
import { resolveThreadReferenceCopyTarget } from "./ChatView.threadReference";

const PR = {
  number: 42,
  title: "Fix it",
  url: "https://github.com/acme/repo/pull/42",
  baseBranch: "main",
  headBranch: "feature/x",
  state: "open",
} as const;

describe("resolveThreadReferenceCopyTarget", () => {
  const base = { threadId: "thread-1", threadBranch: "feature/x" };

  it("copies the PR link while the checkout is on the thread's branch", () => {
    expect(
      resolveThreadReferenceCopyTarget({ ...base, status: { branch: "feature/x", pr: PR } }),
    ).toEqual({
      value: PR.url,
      successTitle: "PR link copied",
      failureTitle: "Failed to copy PR link",
    });
  });

  it.each([
    ["the checkout is on another branch", base, { branch: "main", pr: PR }],
    ["the branch has no PR", base, { branch: "feature/x", pr: null }],
    ["the thread has no branch", { ...base, threadBranch: null }, { branch: "feature/x", pr: PR }],
    ["git status is still loading", base, undefined],
    ["the thread has no git status", base, null],
  ])("copies the thread ID when %s", (_label, input, status) => {
    expect(resolveThreadReferenceCopyTarget({ ...input, status })).toEqual({
      value: "thread-1",
      successTitle: "Thread ID copied",
      failureTitle: "Failed to copy thread ID",
    });
  });
});

describe("thread.copyReference shortcut", () => {
  const shortcut: KeybindingShortcut = {
    key: "c",
    metaKey: false,
    ctrlKey: false,
    shiftKey: true,
    altKey: false,
    modKey: true,
  };
  const keybindings: ResolvedKeybindingsConfig = [
    {
      command: "thread.copyReference",
      shortcut,
      whenAst: { type: "not", node: { type: "identifier", name: "terminalFocus" } },
    },
  ];
  const macEvent = { key: "c", metaKey: true, ctrlKey: false, shiftKey: true, altKey: false };
  const linuxEvent = { key: "C", metaKey: false, ctrlKey: true, shiftKey: true, altKey: false };

  it("matches mod+shift+c per platform", () => {
    expect(
      resolveShortcutCommand(macEvent, keybindings, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
    ).toBe("thread.copyReference");
    expect(
      resolveShortcutCommand(linuxEvent, keybindings, {
        platform: "Linux",
        context: { terminalFocus: false },
      }),
    ).toBe("thread.copyReference");
  });

  it("stays out of the way while the terminal has focus", () => {
    expect(
      resolveShortcutCommand(linuxEvent, keybindings, {
        platform: "Linux",
        context: { terminalFocus: true },
      }),
    ).toBeNull();
  });
});
