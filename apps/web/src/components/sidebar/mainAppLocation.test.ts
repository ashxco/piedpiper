import { beforeEach, describe, expect, it } from "vitest";

import {
  rememberMainAppLocation,
  resetMainAppLocationForTests,
  resolveMainAppHref,
  resolveMainAppReturnSteps,
} from "./mainAppLocation";

describe("mainAppLocation", () => {
  beforeEach(() => {
    resetMainAppLocationForTests();
  });

  it("falls back to the root when settings was opened directly", () => {
    rememberMainAppLocation({ pathname: "/settings/general", href: "/settings/general" });
    expect(resolveMainAppHref()).toBe("/");
  });

  it("returns the last main-app page however many settings tabs were visited", () => {
    rememberMainAppLocation({ pathname: "/thread-1", href: "/thread-1?diff=1" });
    rememberMainAppLocation({ pathname: "/settings/general", href: "/settings/general" });
    rememberMainAppLocation({ pathname: "/settings/archived", href: "/settings/archived" });
    rememberMainAppLocation({ pathname: "/settings", href: "/settings" });
    expect(resolveMainAppHref()).toBe("/thread-1?diff=1");
  });

  it("treats the virtual office as a main-app page", () => {
    rememberMainAppLocation({ pathname: "/thread-1", href: "/thread-1" });
    rememberMainAppLocation({ pathname: "/virtual-office", href: "/virtual-office" });
    rememberMainAppLocation({ pathname: "/settings/general", href: "/settings/general" });
    expect(resolveMainAppHref()).toBe("/virtual-office");
  });

  it("steps back past the main-app entry so closing Settings leaves no forward stop", () => {
    rememberMainAppLocation({ pathname: "/thread-2", href: "/thread-2", historyIndex: 2 });
    rememberMainAppLocation({ pathname: "/settings/general", href: "/settings/general" });
    // From two settings entries above the thread, go back three, then push the thread again.
    expect(resolveMainAppReturnSteps(4)).toBe(3);
  });

  it("pushes when there is no earlier entry to reuse", () => {
    expect(resolveMainAppReturnSteps(3)).toBeNull();
    rememberMainAppLocation({ pathname: "/thread-1", href: "/thread-1", historyIndex: 0 });
    expect(resolveMainAppReturnSteps(2)).toBeNull();
    rememberMainAppLocation({ pathname: "/thread-1", href: "/thread-1", historyIndex: 5 });
    // History moved back below the remembered entry.
    expect(resolveMainAppReturnSteps(4)).toBeNull();
  });
});
