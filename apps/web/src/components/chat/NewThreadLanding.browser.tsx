import "../../index.css";

import { ProjectId } from "@piedpiper/contracts";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";

import { NewThreadLanding } from "./NewThreadLanding";

const active = { id: ProjectId.makeUnsafe("active"), name: "Active Project", cwd: "/repo/active" };
const archived = {
  id: ProjectId.makeUnsafe("archived"),
  name: "Archived Project",
  cwd: "/repo/archived",
  archivedAt: "2026-02-01T00:00:00.000Z",
};

describe("NewThreadLanding", () => {
  it("never lists an archived project in the switcher", async () => {
    await render(
      <NewThreadLanding
        activeProject={active}
        allProjects={[active, archived]}
        onSwitchProject={vi.fn()}
        onAddProject={vi.fn()}
      />,
    );

    await userEvent.click(page.getByRole("button", { name: "Active Project" }));
    await expect.element(page.getByPlaceholder("Search projects")).toBeVisible();
    expect(document.body.textContent).not.toContain("Archived Project");

    await userEvent.fill(page.getByPlaceholder("Search projects"), "Archived");
    expect(document.body.textContent).not.toContain("Archived Project");
  });

  it("still shows an archived project that is already the active one", async () => {
    await render(
      <NewThreadLanding
        activeProject={archived}
        allProjects={[active, archived]}
        onSwitchProject={vi.fn()}
        onAddProject={vi.fn()}
      />,
    );

    await expect.element(page.getByRole("button", { name: "Archived Project" })).toBeVisible();
  });
});
