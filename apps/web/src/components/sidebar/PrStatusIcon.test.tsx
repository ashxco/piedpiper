import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { prStatusIndicator } from "../../lib/openPullRequestLink";
import { PrStatusIcon } from "./PrStatusIcon";

const PR = {
  number: 42,
  title: "Add compression",
  url: "https://github.com/pied/piper/pull/42",
  baseBranch: "main",
  headBranch: "feature",
  state: "open",
} as const;

function iconFor(pr: Parameters<typeof prStatusIndicator>[0]): string {
  const indicator = prStatusIndicator(pr);
  if (!indicator) throw new Error("expected a PR status");
  return renderToStaticMarkup(<PrStatusIcon label={indicator.label} className="size-3" />);
}

describe("PrStatusIcon", () => {
  it.each([
    ["open", "lucide-git-pull-request "],
    ["merged", "lucide-git-merge"],
    ["closed", "lucide-git-pull-request-closed"],
  ] as const)("gives a %s PR its own icon", (state, iconClass) => {
    expect(`${iconFor({ ...PR, state })} `).toContain(iconClass);
  });

  it("gives an open draft PR the draft icon", () => {
    expect(iconFor({ ...PR, isDraft: true })).toContain("lucide-git-pull-request-draft");
  });

  it("follows the final state once a draft PR is merged or closed", () => {
    expect(iconFor({ ...PR, state: "merged", isDraft: true })).toContain("lucide-git-merge");
    expect(iconFor({ ...PR, state: "closed", isDraft: true })).toContain(
      "lucide-git-pull-request-closed",
    );
  });

  it("is decorative and keeps the caller's size", () => {
    const markup = iconFor(PR);
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain("size-3");
  });
});
