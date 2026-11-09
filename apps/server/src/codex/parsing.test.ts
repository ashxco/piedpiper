import { describe, expect, it } from "vitest";

import {
  createCodexStdoutLineLimiter,
  formatCodexExitMessage,
  isCodexUnsupportedMethodError,
  mapCodexRuntimeMode,
} from "./parsing";

describe("mapCodexRuntimeMode", () => {
  it("maps each mode when the CLI supports approvalsReviewer", () => {
    const options = { supportsApprovalsReviewer: true };
    expect(mapCodexRuntimeMode("approval-required", options)).toEqual({
      approvalPolicy: "untrusted",
      sandbox: "read-only",
      approvalsReviewer: "user",
    });
    expect(mapCodexRuntimeMode("auto", options)).toEqual({
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      approvalsReviewer: "auto_review",
    });
    expect(mapCodexRuntimeMode("full-access", options)).toEqual({
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      approvalsReviewer: "user",
    });
  });

  it("omits the reviewer and degrades auto to supervised on older CLIs", () => {
    expect(mapCodexRuntimeMode("approval-required")).toEqual({
      approvalPolicy: "untrusted",
      sandbox: "read-only",
    });
    expect(mapCodexRuntimeMode("auto")).toEqual({
      approvalPolicy: "untrusted",
      sandbox: "read-only",
    });
    expect(mapCodexRuntimeMode("full-access", { supportsApprovalsReviewer: false })).toEqual({
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
  });
});

describe("isCodexUnsupportedMethodError", () => {
  it("matches how the app-server rejects a method it does not have", () => {
    expect(isCodexUnsupportedMethodError(new Error("unknown variant `thread/rollback`"))).toBe(
      true,
    );
    expect(isCodexUnsupportedMethodError(new Error("Method not found"))).toBe(true);
    expect(isCodexUnsupportedMethodError(new Error("turn not found: t1"))).toBe(false);
    expect(isCodexUnsupportedMethodError("unknown variant")).toBe(false);
  });
});

describe("createCodexStdoutLineLimiter", () => {
  const feed = (maxBytes: number, chunks: ReadonlyArray<string>) => {
    let overflows = 0;
    const limiter = createCodexStdoutLineLimiter(() => {
      overflows += 1;
    }, maxBytes);
    for (const chunk of chunks) limiter(Buffer.from(chunk));
    return overflows;
  };

  it("allows a line of exactly the limit, not counting its LF", () => {
    expect(feed(4, ["abcd\n"])).toBe(0);
    expect(feed(4, ["abcde\n"])).toBe(1);
  });

  it("adds up a line split across chunks", () => {
    expect(feed(4, ["ab", "cd", "\n"])).toBe(0);
    expect(feed(4, ["ab", "cd", "e"])).toBe(1);
  });

  it("starts over after each newline", () => {
    expect(feed(4, ["abcd\nabcd\nab", "cd\n"])).toBe(0);
    expect(feed(4, ["ab\ncd\nabcd", "e"])).toBe(1);
  });

  it("catches a long line in the middle of a chunk", () => {
    expect(feed(4, ["ab\nabcdefg\nab\n"])).toBe(1);
  });

  it("counts bytes rather than characters", () => {
    expect(feed(4, ["\u00e9\u00e9"])).toBe(0);
    expect(feed(4, ["\u00e9\u00e9\u00e9"])).toBe(1);
  });

  it("reports an overflow once", () => {
    expect(feed(1, ["abc", "def\n", "ghi"])).toBe(1);
  });
});

describe("formatCodexExitMessage", () => {
  it("masks a secret in the stderr it quotes", () => {
    const message = formatCodexExitMessage(1, null, "failed: refresh_token=abc123secret\n");
    expect(message).not.toContain("abc123secret");
    expect(message).toContain("codex app-server exited (code=1, signal=null)");
  });
});
