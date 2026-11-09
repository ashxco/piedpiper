import "../../index.css";

import { TurnId } from "@piedpiper/contracts";
import { createRef } from "react";
import { page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ChatPlanPanel, type ChatPlanPanelHandle } from "./ChatPlanPanel";

const activePlan = {
  createdAt: "2026-01-01T00:00:00.000Z",
  turnId: TurnId.makeUnsafe("turn-plan"),
  steps: [{ step: "Write the sheet test", status: "inProgress" as const }],
};

async function mountPanel() {
  const ref = createRef<ChatPlanPanelHandle>();
  const onOpenChange = vi.fn();
  const screen = await render(
    <div className="flex h-dvh">
      <div className="flex-1" />
      <ChatPlanPanel
        ref={ref}
        threadId="thread-plan"
        activePlan={activePlan}
        activeProposedPlan={null}
        markdownCwd={undefined}
        workspaceRoot={undefined}
        timestampFormat="locale"
        onOpenChange={onOpenChange}
      />
    </div>,
  );
  return { ref, onOpenChange, screen };
}

describe("ChatPlanPanel", () => {
  afterEach(async () => {
    await page.viewport(1400, 900);
    document.body.innerHTML = "";
  });

  it("renders inline on wide windows", async () => {
    await page.viewport(1400, 900);
    const { ref, screen } = await mountPanel();
    ref.current?.open();
    await expect.element(screen.getByText("Write the sheet test")).toBeVisible();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    screen.unmount();
  });

  it("renders as a sheet on narrow windows and closes through handleClose", async () => {
    await page.viewport(900, 800);
    const { ref, onOpenChange, screen } = await mountPanel();
    ref.current?.open({ evenAsSheet: true });
    await expect.element(page.getByRole("dialog", { name: "Plan" })).toBeVisible();
    await expect.element(page.getByText("Write the sheet test")).toBeVisible();
    onOpenChange.mockClear();
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    screen.unmount();
  });

  it("does not open the sheet automatically on narrow windows", async () => {
    await page.viewport(900, 800);
    const { ref, onOpenChange, screen } = await mountPanel();
    onOpenChange.mockClear();
    ref.current?.open();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(onOpenChange).not.toHaveBeenCalledWith(true);
    ref.current?.toggle(null, null);
    await expect.element(page.getByRole("dialog", { name: "Plan" })).toBeVisible();
    screen.unmount();
  });
});
