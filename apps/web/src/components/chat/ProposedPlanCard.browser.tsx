import "../../index.css";

import { page } from "vitest/browser";
import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { ProposedPlanCard } from "./ProposedPlanCard";
import { revealThreadFindMatch } from "./threadFindHighlights";

const PLAN = [
  "# Long plan",
  ...Array.from({ length: 40 }, (_, line) => `- step ${line}`),
  "- needle past the cutoff",
].join("\n");

describe("ProposedPlanCard thread find", () => {
  it("opens a collapsed plan for a match past its preview", async () => {
    const screen = await render(
      <div data-scroller style={{ height: 300, overflowY: "auto" }}>
        <div data-root>
          <div data-timeline-row-id="plan" data-thread-find-text>
            <ProposedPlanCard planMarkdown={PLAN} cwd={undefined} workspaceRoot={undefined} />
          </div>
        </div>
      </div>,
    );
    try {
      const container = screen.container as HTMLElement;
      expect(container.querySelector("[data-thread-find-fold]")).toBeNull();

      await page.getByRole("button", { name: "Collapse plan" }).click();
      await expect.poll(() => container.querySelector("[data-thread-find-fold]")).not.toBeNull();
      expect(container.textContent).not.toContain("needle");

      const stop = revealThreadFindMatch({
        container: container.querySelector<HTMLElement>("[data-root]")!,
        scrollContainer: container.querySelector<HTMLElement>("[data-scroller]")!,
        position: { rowId: "plan", occurrence: 0 },
        foldedQuery: "needle",
        scrollRowIntoWindow: () => {},
      });
      try {
        await expect.poll(() => container.querySelector("[data-thread-find-fold]")).toBeNull();
        await expect.poll(() => container.textContent).toContain("needle past the cutoff");
        await expect.element(page.getByRole("button", { name: "Collapse plan" })).toBeVisible();
      } finally {
        stop();
      }
    } finally {
      await screen.unmount();
    }
  });

  it("marks no fold on a plan too short to collapse", async () => {
    const screen = await render(
      <ProposedPlanCard
        planMarkdown={"# Short\n\n- one"}
        cwd={undefined}
        workspaceRoot={undefined}
      />,
    );
    try {
      expect((screen.container as HTMLElement).querySelector("[data-thread-find-fold]")).toBeNull();
    } finally {
      await screen.unmount();
    }
  });
});
