import { describe, expect, it } from "vitest";

import { pendingUserInputQuestionSummary } from "./composerPendingUserInputSummary";

describe("pendingUserInputQuestionSummary", () => {
  it("strips code, emphasis and link syntax but keeps the link text", () => {
    expect(
      pendingUserInputQuestionSummary(
        "Use `pnpm` per [the docs](https://pnpm.io/install) for **all** packages?",
      ),
    ).toBe("Use pnpm per the docs for all packages?");
  });

  it("collapses multi-line markdown onto one line", () => {
    expect(pendingUserInputQuestionSummary("## Pick one\n\n- edit `src/app.ts`\n- skip")).toBe(
      "Pick one edit src/app.ts skip",
    );
  });

  it("leaves plain questions unchanged", () => {
    expect(pendingUserInputQuestionSummary("Which branch should I use?")).toBe(
      "Which branch should I use?",
    );
  });
});
