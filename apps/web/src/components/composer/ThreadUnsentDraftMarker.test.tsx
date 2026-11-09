import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ThreadUnsentDraftMarker } from "./ThreadUnsentDraftMarker";

describe("ThreadUnsentDraftMarker", () => {
  it("renders an accessible unsent-draft marker", () => {
    const markup = renderToStaticMarkup(<ThreadUnsentDraftMarker />);
    expect(markup).toContain('aria-label="Unsent draft"');
    expect(markup).toContain('data-testid="thread-unsent-draft-marker"');
  });
});
