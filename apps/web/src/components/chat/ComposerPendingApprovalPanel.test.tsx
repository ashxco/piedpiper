import { ApprovalRequestId } from "@piedpiper/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";
import { ComposerPendingApprovalPanel } from "./ComposerPendingApprovalPanel";

describe("ComposerPendingApprovalPanel", () => {
  it("renders a multi-line approval detail in full", () => {
    const detail = "src/a.ts\nsrc/b.ts\nsrc/c.ts";
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalPanel
        approval={{
          requestId: ApprovalRequestId.makeUnsafe("approval-1"),
          requestKind: "file-change",
          createdAt: "2026-03-17T18:42:05.449Z",
          detail,
        }}
        pendingCount={1}
      />,
    );

    expect(markup).toContain('data-approval-detail="complete"');
    expect(markup).toContain(detail);
    expect(markup).toContain("File change");
    expect(markup).not.toMatch(/\btruncate\b/);
    expect(markup).not.toMatch(/line-clamp/);
  });

  it("wraps long unbroken detail and reason tokens inside the panel", () => {
    const detail = "x".repeat(500);
    const reason = `Matches rule ${"y".repeat(300)}`;
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalPanel
        approval={{
          requestId: ApprovalRequestId.makeUnsafe("approval-1"),
          requestKind: "command",
          createdAt: "2026-03-17T18:42:05.449Z",
          detail,
          reason,
        }}
        pendingCount={1}
      />,
    );

    expect(markup).toContain(detail);
    expect(markup).toContain('class="mt-2 min-w-0 max-w-full"');
    expect(markup).toMatch(
      /<pre data-approval-detail="complete" class="[^"]*min-w-0 max-w-full[^"]*\[overflow-wrap:anywhere\]/,
    );
    expect(markup).toMatch(/<p data-approval-reason="true" class="[^"]*\[overflow-wrap:anywhere\]/);
  });

  it("omits the detail block when no detail is provided", () => {
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalPanel
        approval={{
          requestId: ApprovalRequestId.makeUnsafe("approval-1"),
          requestKind: "command",
          createdAt: "2026-03-17T18:42:05.449Z",
        }}
        pendingCount={1}
      />,
    );

    expect(markup).not.toContain("data-approval-detail");
  });

  it("shows the provider's reason under the detail", () => {
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalPanel
        approval={{
          requestId: ApprovalRequestId.makeUnsafe("approval-1"),
          requestKind: "command",
          createdAt: "2026-03-17T18:42:05.449Z",
          detail: "rm -rf build",
          reason: "Matched ask rule Bash(rm:*)",
        }}
        pendingCount={1}
      />,
    );

    expect(markup).toContain('data-approval-reason="true"');
    expect(markup).toContain("Matched ask rule Bash(rm:*)");
    expect(markup.indexOf("rm -rf build")).toBeLessThan(markup.indexOf("Matched ask rule"));
  });
});

describe("ComposerPendingApprovalActions", () => {
  const renderActions = (noStandingGrant?: boolean) =>
    renderToStaticMarkup(
      <ComposerPendingApprovalActions
        requestId={ApprovalRequestId.makeUnsafe("approval-1")}
        isResponding={false}
        {...(noStandingGrant !== undefined ? { noStandingGrant } : {})}
        onRespondToApproval={async () => {}}
      />,
    );

  it("offers a session-wide grant by default", () => {
    expect(renderActions()).toContain("Always allow this session");
  });

  it("hides the session-wide grant when the provider forbids it", () => {
    const markup = renderActions(true);
    expect(markup).not.toContain("Always allow this session");
    expect(markup).toContain("Approve once");
  });
});
