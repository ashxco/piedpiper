import type { Logger, VerifyUpdateCodeSignature } from "electron-updater";

export interface SignatureVerifyingUpdater {
  verifyUpdateCodeSignature?: VerifyUpdateCodeSignature | undefined;
  logger: Logger | null;
}

export const SKIPPED_SIGNATURE_RETRY_MESSAGE =
  "Signature validation was skipped after a timed-out check.";

const signatureChecksWithRetry = new WeakSet<VerifyUpdateCodeSignature>();

function isTimedOutExecError(error: unknown): boolean {
  // execFile marks the error `killed` when electron-updater's 20 s PowerShell timeout fires.
  return (
    typeof error === "object" &&
    error !== null &&
    "killed" in error &&
    (error as { killed?: unknown }).killed === true
  );
}

/**
 * Wrap the Windows (NSIS) installer signature check so a timed-out PowerShell
 * Authenticode check is retried once. Idempotent; a no-op on updaters without
 * a signature hook (macOS, Linux).
 */
export function installSignatureCheckRetry(updater: SignatureVerifyingUpdater): void {
  const verify = updater.verifyUpdateCodeSignature;
  if (verify === undefined || signatureChecksWithRetry.has(verify)) return;

  const verifyWithRetry: VerifyUpdateCodeSignature = async (publisherNames, path) => {
    try {
      return await verify(publisherNames, path);
    } catch (error) {
      if (!isTimedOutExecError(error)) throw error;
    }

    const logger = updater.logger;
    let skipped = false;
    updater.logger = {
      info: (message) => logger?.info(message),
      warn: (message) => {
        // A failed capability probe makes electron-updater warn and resolve null without checking.
        skipped ||= String(message).includes("Ignoring signature validation");
        logger?.warn(message);
      },
      error: (message) => logger?.error(message),
      debug: (message) => logger?.debug?.(message),
    };
    try {
      const result = await verify(publisherNames, path);
      return skipped ? SKIPPED_SIGNATURE_RETRY_MESSAGE : result;
    } finally {
      updater.logger = logger;
    }
  };
  signatureChecksWithRetry.add(verifyWithRetry);
  updater.verifyUpdateCodeSignature = verifyWithRetry;
}
