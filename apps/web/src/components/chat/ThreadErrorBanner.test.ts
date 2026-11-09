import { describe, expect, it } from "vitest";

import {
  clearThreadErrorDismissalsForThread,
  dismissThreadErrorForSession,
  getThreadErrorDisplayMessage,
  isThreadErrorDismissedForSession,
  parseStructuredThreadErrorMessage,
  undismissThreadErrorForSession,
} from "./ThreadErrorBanner";

describe("parseStructuredThreadErrorMessage", () => {
  it("extracts error.message from a JSON payload", () => {
    expect(
      parseStructuredThreadErrorMessage(
        '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      ),
    ).toBe("Overloaded");
  });

  it("keeps a leading prefix such as the API status", () => {
    const raw =
      'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';
    expect(parseStructuredThreadErrorMessage(raw)).toBe("API Error: 529 Overloaded");
    expect(getThreadErrorDisplayMessage(raw)).toBe("API Error: 529 Overloaded");
  });

  it("returns null for plain or malformed errors", () => {
    expect(parseStructuredThreadErrorMessage("Provider crashed")).toBeNull();
    expect(parseStructuredThreadErrorMessage("Bad {json")).toBeNull();
    expect(parseStructuredThreadErrorMessage('{"error":"flat"}')).toBeNull();
    expect(parseStructuredThreadErrorMessage('{"error":{"message":"  "}}')).toBeNull();
    expect(getThreadErrorDisplayMessage("Provider crashed")).toBe("Provider crashed");
  });
});

describe("thread error dismissal mask", () => {
  it("masks the dismissed error on that thread only", () => {
    dismissThreadErrorForSession("thread-a", "Aborted");
    expect(isThreadErrorDismissedForSession("thread-a", "Aborted")).toBe(true);
    expect(isThreadErrorDismissedForSession("thread-a", "Provider crashed")).toBe(false);
    expect(isThreadErrorDismissedForSession("thread-b", "Aborted")).toBe(false);
  });

  it("forgets a thread's dismissals without touching other threads", () => {
    dismissThreadErrorForSession("thread-c", "Aborted");
    dismissThreadErrorForSession("thread-d", "Aborted");
    clearThreadErrorDismissalsForThread("thread-c");
    expect(isThreadErrorDismissedForSession("thread-c", "Aborted")).toBe(false);
    expect(isThreadErrorDismissedForSession("thread-d", "Aborted")).toBe(true);
  });

  it("unmasks one error so a repeated local error shows again", () => {
    dismissThreadErrorForSession("thread-e", "Aborted");
    dismissThreadErrorForSession("thread-e", "Provider crashed");
    undismissThreadErrorForSession("thread-e", "Aborted");
    expect(isThreadErrorDismissedForSession("thread-e", "Aborted")).toBe(false);
    expect(isThreadErrorDismissedForSession("thread-e", "Provider crashed")).toBe(true);
  });
});
