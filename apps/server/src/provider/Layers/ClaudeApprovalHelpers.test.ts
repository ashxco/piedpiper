import { describe, expect, it } from "vitest";
import {
  claudeMcpElicitationAcceptance,
  claudeMcpElicitationDetail,
  claudeApprovalPresentation,
  effectiveClaudeApprovalDecision,
} from "./ClaudeApprovalHelpers.ts";

const request = (requestedSchema?: Record<string, unknown>, mode?: "form" | "url") => ({
  serverName: "deploy",
  message: "Deploy to production?",
  ...(mode ? { mode } : {}),
  ...(requestedSchema ? { requestedSchema } : {}),
});

describe("claudeMcpElicitationAcceptance", () => {
  it("fills a consent form without trusting schema defaults", () => {
    expect(
      claudeMcpElicitationAcceptance(
        request({
          type: "object",
          properties: {
            decision: { type: "string", enum: ["approve", "deny"] },
            persist: { type: "boolean", title: "Always allow", default: true },
            scope: { type: "string", default: "all-repos" },
          },
          required: ["decision"],
        }),
      ),
    ).toEqual({ action: "accept", content: { decision: "approve", persist: false } });
  });

  it("picks the one-time choice however the server spells it, never a broader grant", () => {
    const choose = (options: ReadonlyArray<string>) =>
      claudeMcpElicitationAcceptance(
        request({
          type: "object",
          properties: { decision: { type: "string", enum: options } },
          required: ["decision"],
        }),
      )?.content?.decision;
    expect(choose(["allow_all", "allow_once"])).toBe("allow_once");
    expect(choose(["allow_and_remember", "allow_this_time"])).toBe("allow_this_time");
    expect(choose(["Allow once only", "deny"])).toBe("Allow once only");
    expect(choose(["approve_all_tools", "deny"])).toBeUndefined();
    expect(
      claudeMcpElicitationAcceptance(
        request({
          type: "object",
          properties: {
            decision: { oneOf: [{ const: "allow_all_repos" }, { const: "approve" }] },
          },
          required: ["decision"],
        }),
      ),
    ).toEqual({ action: "accept", content: { decision: "approve" } });
  });

  it("declines what the approval card cannot answer", () => {
    expect(claudeMcpElicitationAcceptance(request(undefined, "url"))).toBeUndefined();
    expect(claudeMcpElicitationAcceptance(request())).toBeUndefined();
    expect(
      claudeMcpElicitationAcceptance(
        request({
          type: "object",
          properties: { reason: { type: "string" } },
          required: ["reason"],
        }),
      ),
    ).toBeUndefined();
  });

  it("labels the card with the server's display name", () => {
    expect(claudeMcpElicitationDetail({ ...request(), displayName: "Deployer" })).toBe(
      "Deployer: Deploy to production?",
    );
    expect(claudeMcpElicitationDetail(request())).toBe("deploy: Deploy to production?");
  });
});

describe("claudeApprovalPresentation", () => {
  it("strips terminal escapes from the reason and flags a forbidden standing grant", () => {
    expect(
      claudeApprovalPresentation({
        detail: "Bash: rm -rf build",
        callbackOptions: {
          decisionReason: "  \u001b[33mMatched ask rule Bash(rm:*)\u001b[39m ",
          suppressAlwaysAllowRule: true,
        },
      }),
    ).toEqual({ reason: "Matched ask rule Bash(rm:*)", noStandingGrant: true });
  });

  it("omits an empty reason or one that repeats the detail", () => {
    expect(
      claudeApprovalPresentation({ detail: "Bash: ls", callbackOptions: { decisionReason: "  " } }),
    ).toEqual({});
    expect(
      claudeApprovalPresentation({
        detail: "Bash: ls",
        callbackOptions: { decisionReason: "Bash: ls", suppressAlwaysAllowRule: false },
      }),
    ).toEqual({});
  });
});

describe("effectiveClaudeApprovalDecision", () => {
  it("downgrades a session grant only when Claude forbids a standing grant", () => {
    expect(effectiveClaudeApprovalDecision("acceptForSession", true)).toBe("accept");
    expect(effectiveClaudeApprovalDecision("acceptForSession", undefined)).toBe("acceptForSession");
    expect(effectiveClaudeApprovalDecision("decline", true)).toBe("decline");
  });
});
