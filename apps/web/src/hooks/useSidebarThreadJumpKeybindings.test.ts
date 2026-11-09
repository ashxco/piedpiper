import type { ThreadId } from "@piedpiper/contracts";
import { describe, expect, it, vi } from "vitest";

import { announce } from "../lib/announce";
import { navigateAndAnnounce, threadSwitchAnnouncement } from "./useSidebarThreadJumpKeybindings";

vi.mock("../lib/announce", () => ({ announce: vi.fn() }));

describe("threadSwitchAnnouncement", () => {
  it("names the thread a shortcut switched to", () => {
    expect(threadSwitchAnnouncement("  Fix login  ")).toBe("Switched to Fix login");
  });

  it("falls back to a generic message for an untitled or unknown thread", () => {
    expect(threadSwitchAnnouncement("")).toBe("Switched thread");
    expect(threadSwitchAnnouncement(undefined)).toBe("Switched thread");
  });
});

describe("navigateAndAnnounce", () => {
  it("announces a switch to another thread", () => {
    vi.mocked(announce).mockClear();
    const navigateToThread = vi.fn();
    navigateAndAnnounce(navigateToThread, "thread-2" as ThreadId, "thread-1" as ThreadId);
    expect(navigateToThread).toHaveBeenCalledWith("thread-2");
    expect(announce).toHaveBeenCalledWith("Switched thread", "thread-switch");
  });

  it("stays silent when the target is already the open thread", () => {
    vi.mocked(announce).mockClear();
    const navigateToThread = vi.fn();
    navigateAndAnnounce(navigateToThread, "thread-1" as ThreadId, "thread-1" as ThreadId);
    expect(navigateToThread).toHaveBeenCalledWith("thread-1");
    expect(announce).not.toHaveBeenCalled();
  });
});
