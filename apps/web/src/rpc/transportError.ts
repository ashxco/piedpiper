const TRANSPORT_ERROR_PATTERNS = [
  /\bSocketCloseError\b/i,
  /\bSocketOpenError\b/i,
  /\bSocketReadError\b/i,
  /\bSocketWriteError\b/i,
  /\bping timeout\b/i,
] as const;

export const TRANSPORT_CONNECTION_LOST_MESSAGE =
  "The connection to the server was lost, so your last action may not have gone through.";

export function isTransportConnectionErrorMessage(message: string | null | undefined): boolean {
  if (typeof message !== "string") return false;
  return TRANSPORT_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

/** Replaces raw socket errors with a readable message; other errors and null pass through. */
export function normalizeThreadActionError(message: string | null): string | null {
  return isTransportConnectionErrorMessage(message) ? TRANSPORT_CONNECTION_LOST_MESSAGE : message;
}

/** Toast title for a thread error: only the normalized transport message avoids blaming the provider. */
export function threadErrorToastTitle(message: string): string {
  return message === TRANSPORT_CONNECTION_LOST_MESSAGE ? "Connection lost" : "Provider error";
}
