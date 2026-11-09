import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { assert, describe, it, vi } from "vitest";

import {
  DEV_ROOT_FLAG,
  buildDevRootArgument,
  buildDevRootCleanupPattern,
  desktopDir,
  isLinuxSandboxHelperConfigured,
  resolveAppBundleId,
  resolveLinuxSandboxArgs,
  resolveRuntimeDir,
  setPlistBool,
} from "./electron-launcher.mjs";

describe("electron launcher helpers", () => {
  it("uses a .dev bundle id for development launches only", () => {
    assert.equal(resolveAppBundleId(false), "com.piedpiper.app");
    assert.equal(resolveAppBundleId(true), "com.piedpiper.app.dev");
  });

  for (const desktopDir of [
    "/tmp/pp-feature.one/apps/desktop",
    "/tmp/Pied Piper/pp (two)+?^${four}|back\\slash*/apps/desktop",
  ]) {
    it(`cleanup pattern matches only the literal root argument: ${desktopDir}`, () => {
      const pattern = buildDevRootCleanupPattern(desktopDir);
      const flag = buildDevRootArgument(desktopDir);
      const commandLines = {
        exact: `electron ${flag} dist-electron/main.js`,
        first: `${flag} dist-electron/main.js`,
        last: `electron ${flag}`,
        differentChar: `electron ${flag.replace(".one", "Xone").replace("(two)", "Xtwo")} main.js`,
        longerPath: `electron ${flag}-two main.js`,
        prefixed: `electron prefix${flag} main.js`,
        otherRoot: `electron --piedpiper-dev-root=/other${desktopDir} main.js`,
      };
      const regex = new RegExp(pattern);
      assert.isTrue(regex.test(commandLines.exact));
      assert.isTrue(regex.test(commandLines.first));
      assert.isTrue(regex.test(commandLines.last));
      assert.isFalse(regex.test(commandLines.differentChar));
      assert.isFalse(regex.test(commandLines.longerPath));
      assert.isFalse(regex.test(commandLines.prefixed));
      assert.isFalse(regex.test(commandLines.otherRoot));
    });
  }

  it("accepts only a root-owned setuid chrome-sandbox", () => {
    const regularFileBits = 0o100000;
    const configured = (uid, mode) =>
      isLinuxSandboxHelperConfigured({ uid, mode: regularFileBits | mode });
    assert.isTrue(configured(0, 0o4755));
    assert.isFalse(configured(1000, 0o4755));
    assert.isFalse(configured(0, 0o0755));
    assert.isFalse(configured(0, 0o4775));
    assert.isFalse(configured(0, 0o4711));
  });

  it("adds no sandbox flag off Linux, whatever the helper looks like", () => {
    assert.deepEqual(resolveLinuxSandboxArgs("/nowhere/electron", "darwin"), []);
    assert.deepEqual(resolveLinuxSandboxArgs("/nowhere/electron", "win32"), []);
  });

  it("disables the sandbox on Linux when the helper is missing or unconfigured", () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-launcher-sandbox-"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const electronPath = join(dir, "electron");
      assert.deepEqual(resolveLinuxSandboxArgs(electronPath, "linux"), ["--no-sandbox"]);
      writeFileSync(join(dir, "chrome-sandbox"), "");
      assert.deepEqual(resolveLinuxSandboxArgs(electronPath, "linux"), ["--no-sandbox"]);
      assert.equal(warn.mock.calls.length, 1);
    } finally {
      warn.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps dev and release runtime bundles in separate directories", () => {
    const dev = resolveRuntimeDir(true);
    const release = resolveRuntimeDir(false);
    assert.notEqual(dev, release);
    assert.equal(dirname(dev), dirname(release));
    assert.equal(dirname(dev), join(desktopDir, ".electron-runtime"));
  });

  it.runIf(process.platform === "darwin")("inserts and replaces boolean plist keys", () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-launcher-plist-"));
    try {
      const plistPath = join(dir, "Info.plist");
      writeFileSync(
        plistPath,
        '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict></dict></plist>\n',
      );
      setPlistBool(plistPath, "NSAutoFillRequiresTextContentTypeForOneTimeCodeOnMac", false);
      setPlistBool(plistPath, "NSAutoFillRequiresTextContentTypeForOneTimeCodeOnMac", true);
      const xml = readFileSync(plistPath, "utf8");
      assert.match(
        xml,
        /<key>NSAutoFillRequiresTextContentTypeForOneTimeCodeOnMac<\/key>\s*<true\/>/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const desktopDir of [
    "/tmp/pp-feature.one/apps/desktop",
    "/tmp/Pied Piper/pp (two)+?^${four}|back\\slash*/apps/desktop",
  ]) {
    it.skipIf(process.platform === "win32")(
      `native pgrep matches only exact-argument processes: ${desktopDir}`,
      async () => {
        const pattern = buildDevRootCleanupPattern(desktopDir);
        const flag = buildDevRootArgument(desktopDir);
        const argvCases = [
          [flag],
          [flag, "dist-electron/main.js"],
          [flag.replace(".one", "Xone").replace("(two)", "Xtwo")],
          [`${flag}-two`],
          [`prefix${flag}`],
          [`${DEV_ROOT_FLAG}=/other${desktopDir}`],
        ];
        const children = [];
        try {
          for (const args of argvCases) {
            const child = spawn(
              process.execPath,
              ["-e", "process.send('ready'); setInterval(() => {}, 1000)", "--", ...args],
              { stdio: ["ignore", "ignore", "inherit", "ipc"] },
            );
            children.push(child);
            await Promise.race([
              once(child, "message"),
              once(child, "exit").then(() => {
                throw new Error("Fixture exited before readiness");
              }),
            ]);
          }
          // Query with pgrep only; never run the signal-sending pkill in tests.
          const result = spawnSync("pgrep", ["-P", String(process.pid), "-f", "--", pattern], {
            encoding: "utf8",
          });
          assert.equal(result.status, 0, result.stderr);
          const matches = result.stdout.trim().split(/\s+/).map(Number);
          assert.sameMembers(
            matches,
            children.slice(0, 2).map((child) => child.pid),
          );
        } finally {
          await Promise.all(
            children.map(async (child) => {
              if (child.exitCode !== null || child.signalCode !== null) return;
              const exited = once(child, "exit");
              child.kill("SIGTERM");
              await exited;
            }),
          );
        }
      },
    );
  }
});
