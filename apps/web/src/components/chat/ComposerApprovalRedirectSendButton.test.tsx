import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ComposerApprovalRedirectSendButton } from "./ComposerApprovalRedirectSendButton";

describe("ComposerApprovalRedirectSendButton", () => {
  it("renders a submit button only when the draft has sendable content", () => {
    expect(
      renderToStaticMarkup(
        <ComposerApprovalRedirectSendButton hasSendableContent={false} disabled={false} />,
      ),
    ).toBe("");
    const markup = renderToStaticMarkup(
      <ComposerApprovalRedirectSendButton hasSendableContent disabled={false} />,
    );
    expect(markup).toContain('type="submit"');
    expect(markup).toContain("Decline &amp; send");
  });

  it("disables while the approval is being answered", () => {
    expect(
      renderToStaticMarkup(<ComposerApprovalRedirectSendButton hasSendableContent disabled />),
    ).toContain("disabled");
  });
});
