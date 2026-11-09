import { beforeEach, describe, expect, it } from "vitest";

import {
  rememberMainAppLocation,
  resetMainAppLocationForTests,
  resolveMainAppHref,
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
});
