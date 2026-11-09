import type { Logger, VerifyUpdateCodeSignature } from "electron-updater";
import { describe, expect, it, vi } from "vitest";

import {
  installSignatureCheckRetry,
  SKIPPED_SIGNATURE_RETRY_MESSAGE,
  type SignatureVerifyingUpdater,
} from "./updateSignatureRetry";

const publisherNames = ["Pied Piper Inc"];
const installerPath = "C:\\updater\\pending\\temp-Pied-Piper-x64.exe";
const timedOut = () => Object.assign(new Error("Command failed: powershell.exe"), { killed: true });

function makeUpdater(verify: VerifyUpdateCodeSignature | undefined) {
  const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const updater: SignatureVerifyingUpdater = { verifyUpdateCodeSignature: verify, logger };
  return { updater, logger };
}

describe("installSignatureCheckRetry", () => {
  it("is a no-op when the updater has no signature hook", () => {
    const { updater } = makeUpdater(undefined);
    installSignatureCheckRetry(updater);
    expect(updater.verifyUpdateCodeSignature).toBeUndefined();
  });

  it("retries a timed-out check once with the same arguments", async () => {
    const verify = vi
      .fn<VerifyUpdateCodeSignature>()
      .mockRejectedValueOnce(timedOut())
      .mockResolvedValueOnce(null);
    const { updater, logger } = makeUpdater(verify);
    installSignatureCheckRetry(updater);

    await expect(updater.verifyUpdateCodeSignature!(publisherNames, installerPath)).resolves.toBe(
      null,
    );
    expect(verify.mock.calls).toEqual([
      [publisherNames, installerPath],
      [publisherNames, installerPath],
    ]);
    expect(updater.logger).toBe(logger);
  });

  it("does not retry invalid signatures or non-timeout errors", async () => {
    const invalid = vi.fn<VerifyUpdateCodeSignature>(() => Promise.resolve("Invalid publisher"));
    const a = makeUpdater(invalid);
    installSignatureCheckRetry(a.updater);
    await expect(a.updater.verifyUpdateCodeSignature!(publisherNames, installerPath)).resolves.toBe(
      "Invalid publisher",
    );
    expect(invalid).toHaveBeenCalledTimes(1);

    const failing = vi.fn<VerifyUpdateCodeSignature>(() =>
      Promise.reject(new Error("Cannot execute PowerShell")),
    );
    const b = makeUpdater(failing);
    installSignatureCheckRetry(b.updater);
    await expect(
      b.updater.verifyUpdateCodeSignature!(publisherNames, installerPath),
    ).rejects.toThrow("Cannot execute PowerShell");
    expect(failing).toHaveBeenCalledTimes(1);
  });

  it("fails after two timeouts and does not stack retries when installed twice", async () => {
    const verify = vi.fn<VerifyUpdateCodeSignature>(() => Promise.reject(timedOut()));
    const { updater } = makeUpdater(verify);
    installSignatureCheckRetry(updater);
    installSignatureCheckRetry(updater);

    for (let attempt = 1; attempt <= 2; attempt++) {
      await expect(
        updater.verifyUpdateCodeSignature!(publisherNames, installerPath),
      ).rejects.toThrow("powershell.exe");
      expect(verify).toHaveBeenCalledTimes(attempt * 2);
    }
  });

  it("rejects a retry that silently skipped validation", async () => {
    let updater!: SignatureVerifyingUpdater;
    const verify = vi
      .fn<VerifyUpdateCodeSignature>()
      .mockRejectedValueOnce(timedOut())
      .mockImplementationOnce(async () => {
        updater.logger?.warn(
          "Cannot execute ConvertTo-Json: spawnSync powershell.exe ETIMEDOUT. Ignoring signature validation due to unsupported powershell version.",
        );
        return null;
      });
    const made = makeUpdater(verify);
    updater = made.updater;
    installSignatureCheckRetry(updater);

    await expect(updater.verifyUpdateCodeSignature!(publisherNames, installerPath)).resolves.toBe(
      SKIPPED_SIGNATURE_RETRY_MESSAGE,
    );
    expect(made.logger.warn).toHaveBeenCalledTimes(1);
    expect(updater.logger).toBe(made.logger);
  });
});
