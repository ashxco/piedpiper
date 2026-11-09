import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveLinuxSandboxArgs } from "./electron-launcher.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(__dirname, "..");
const electronBin = createRequire(import.meta.url)("electron");
const mainJs = resolve(desktopDir, "dist-electron/boot.js");

// Both lines are logged by apps/web/src/lib/bootError.ts and pinned by its test.
const READY_LINE = "Pied Piper booted.";
const FAILED_LINE = "Pied Piper failed to start.";
const MIN_OBSERVE_MS = 8_000;
const SETTLE_MS = 2_000;
const MAX_WAIT_MS = 30_000;

const fatalPatterns = [
  "Cannot find module",
  "MODULE_NOT_FOUND",
  "Refused to execute",
  "Uncaught Error",
  "Uncaught TypeError",
  "Uncaught ReferenceError",
  "SUID sandbox helper binary",
  FAILED_LINE,
];

console.log("\nLaunching Electron smoke test...");

const startedAt = Date.now();
const child = spawn(electronBin, [...resolveLinuxSandboxArgs(electronBin), mainJs], {
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    VITE_DEV_SERVER_URL: "",
    ELECTRON_ENABLE_LOGGING: "1",
  },
});

let output = "";
let killedByScript = false;
let passTimer = null;
const stop = () => {
  killedByScript = true;
  child.kill();
};
const findFailures = () => fatalPatterns.filter((pattern) => output.includes(pattern));
const onOutput = (chunk) => {
  output += chunk.toString();
  if (findFailures().length > 0) {
    stop();
    return;
  }
  // A chunk-failure reload can show the error card right after boot, so passing needs a settle window.
  if (passTimer === null && output.includes(READY_LINE)) {
    const now = Date.now();
    passTimer = setTimeout(stop, Math.max(startedAt + MIN_OBSERVE_MS - now, SETTLE_MS));
  }
};
child.stdout.on("data", onOutput);
child.stderr.on("data", onOutput);

const maxWaitTimer = setTimeout(stop, MAX_WAIT_MS);

child.on("exit", (code, signal) => {
  clearTimeout(passTimer);
  clearTimeout(maxWaitTimer);

  const exitStatus = `exit code ${code}, signal ${signal}`;
  const failures = findFailures();

  if (failures.length > 0) {
    console.error("\nDesktop smoke test failed:");
    for (const failure of failures) {
      console.error(` - ${failure}`);
    }
    console.error("\nFull output:\n" + output);
    process.exit(1);
  }

  if (!output.includes(READY_LINE)) {
    console.error("\nFull output:\n" + output);
    console.error(
      `\nThe renderer never reported boot within ${Math.round((Date.now() - startedAt) / 1000)} s (${exitStatus}). Possible causes: a stale web build (rebuild first), another Pied Piper instance holding the single-instance lock, or a crash.`,
    );
    process.exit(1);
  }

  if (!killedByScript) {
    console.error("\nFull output:\n" + output);
    console.error(`\nThe app exited on its own during the observation window (${exitStatus}).`);
    process.exit(1);
  }

  console.log("Desktop smoke test passed.");
  process.exit(0);
});
