import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// ChatMarkdown reads the theme store, which has no server snapshot under renderToStaticMarkup.
vi.mock("./ChatMarkdown", () => ({ default: () => null }));

import PlanSidebar from "./PlanSidebar";

function renderPlanSidebar(mode: "sheet" | "sidebar") {
  return renderToStaticMarkup(
    <PlanSidebar
      activePlan={null}
      activeProposedPlan={null}
      markdownCwd={undefined}
      workspaceRoot={undefined}
      timestampFormat="locale"
      mode={mode}
      onClose={() => {}}
    />,
  );
}

describe("PlanSidebar workspace area", () => {
  it("is an F6 stop between composer and terminal when inline", () => {
    const markup = renderPlanSidebar("sidebar");
    expect(markup).toContain('data-workspace-area="plan"');
    expect(markup).toContain('data-workspace-order="3"');
    expect(markup).toContain('aria-label="Plan"');
  });

  it("is not an F6 stop inside the sheet overlay", () => {
    expect(renderPlanSidebar("sheet")).not.toContain("data-workspace-area");
  });
});

describe("PlanSidebar native window buttons", () => {
  it("reserves room only in the sheet, which reaches the top of the window", () => {
    expect(renderPlanSidebar("sheet")).toContain("wco:pr-");
    expect(renderPlanSidebar("sidebar")).not.toContain("wco:pr-");
  });
});
