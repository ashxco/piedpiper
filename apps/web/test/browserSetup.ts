import { beforeEach } from "vitest";
import { commands } from "vitest/browser";

declare module "vitest/browser" {
  interface BrowserCommands {
    /** Defined in vitest.browser.config.ts. Moves Playwright's mouse off the page. */
    resetPointer: () => Promise<void>;
  }
}

// Whatever the next test mounts under the mouse's last position would start hovered.
// Before each test, not after: a timed-out test keeps running and can move the mouse later.
beforeEach(async () => {
  await commands.resetPointer();
});
