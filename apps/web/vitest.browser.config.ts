import { fileURLToPath } from "node:url";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig, mergeConfig } from "vitest/config";

import viteConfig from "./vite.config";

const srcPath = fileURLToPath(new URL("./src", import.meta.url));

export default mergeConfig(
  viteConfig,
  defineConfig({
    resolve: {
      alias: {
        "~": srcPath,
      },
    },
    server: {
      // The app dev server pins its port; concurrent browser-test runs take the next free one.
      strictPort: false,
    },
    test: {
      include: ["src/components/**/*.browser.tsx"],
      setupFiles: ["./test/browserSetup.ts"],
      browser: {
        enabled: true,
        provider: playwright(),
        instances: [{ browser: "chromium" }],
        headless: true,
        api: {
          strictPort: false,
        },
        commands: {
          // Playwright's mouse outlives each test; test/browserSetup.ts parks it off the page.
          resetPointer: async ({ page }) => {
            await page.mouse.move(-1, -1);
          },
        },
      },
      testTimeout: 30_000,
      hookTimeout: 30_000,
    },
  }),
);
