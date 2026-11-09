import { describe, expect, it } from "vitest";

import {
  isTransportConnectionErrorMessage,
  normalizeThreadActionError,
  threadErrorToastTitle,
  TRANSPORT_CONNECTION_LOST_MESSAGE,
} from "./transportError";

describe("isTransportConnectionErrorMessage", () => {
  it.each([
    "SocketCloseError: 1006",
    'SocketOpenError: timeout waiting for "open"',
    "SocketReadError: An error occurred during Read",
    "SocketWriteError: An error occurred during Write",
    "Request failed: ping timeout",
  ])("detects %s", (message) => {
    expect(isTransportConnectionErrorMessage(message)).toBe(true);
  });

  it.each(["Turn failed", "", null, undefined, "MySocketCloseErrorHandler threw"])(
    "ignores %s",
    (message) => {
      expect(isTransportConnectionErrorMessage(message)).toBe(false);
    },
  );
});

describe("normalizeThreadActionError", () => {
  it("replaces every transport failure with one fixed message", () => {
    expect(normalizeThreadActionError("SocketCloseError: 1006")).toBe(
      TRANSPORT_CONNECTION_LOST_MESSAGE,
    );
    expect(normalizeThreadActionError("SocketOpenError: Timeout")).toBe(
      TRANSPORT_CONNECTION_LOST_MESSAGE,
    );
    expect(TRANSPORT_CONNECTION_LOST_MESSAGE).toContain("may not have gone through");
  });

  it("passes other errors through", () => {
    expect(normalizeThreadActionError("Select a base branch before sending.")).toBe(
      "Select a base branch before sending.",
    );
  });

  it("keeps null so a new action still clears the error", () => {
    expect(normalizeThreadActionError(null)).toBeNull();
  });
});

describe("threadErrorToastTitle", () => {
  it("names the connection only for the normalized message", () => {
    expect(threadErrorToastTitle(TRANSPORT_CONNECTION_LOST_MESSAGE)).toBe("Connection lost");
    expect(threadErrorToastTitle("Turn failed")).toBe("Provider error");
    // session.lastError is a provider's own report, so its raw text keeps the provider title.
    expect(threadErrorToastTitle("SocketCloseError: 1006")).toBe("Provider error");
  });
});
