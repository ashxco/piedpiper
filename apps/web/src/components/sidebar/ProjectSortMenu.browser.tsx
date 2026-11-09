import "../../index.css";

import { describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { ProjectSortMenu } from "./ProjectSortMenu";

describe("ProjectSortMenu", () => {
  it("names the icon-only trigger through the tooltip render merge", async () => {
    const screen = await render(
      <ProjectSortMenu
        projectSortOrder="updated_at"
        threadSortOrder="updated_at"
        onProjectSortOrderChange={() => undefined}
        onThreadSortOrderChange={() => undefined}
      />,
    );

    await expect
      .element(page.getByRole("button", { name: "Sort projects and threads" }))
      .toBeInTheDocument();

    await screen.unmount();
  });
});
