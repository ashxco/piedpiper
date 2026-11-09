import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ComposerWorktreeProgress } from "./ComposerWorktreeProgress";

const status = () => document.querySelector('[role="status"]');

describe("ComposerWorktreeProgress", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("shows the percentage but keeps it out of the live region", async () => {
    const screen = await render(<ComposerWorktreeProgress progress={null} />);
    expect(status()?.textContent).toBe("Preparing worktree...");
    expect(document.body.textContent).not.toContain("%");
    expect(document.body.textContent).toContain("Preparing...");
    expect(status()?.textContent, "the short name stays out of the live region").not.toContain(
      "Preparing...",
    );

    await screen.rerender(<ComposerWorktreeProgress progress={{ percent: 42 }} />);
    expect(document.body.textContent).toContain("42%");
    expect(document.body.textContent).not.toContain("Preparing...");
    expect(status()?.textContent).toBe("Preparing worktree...");
  });

  it("offers only the actions it has handlers for", async () => {
    await render(<ComposerWorktreeProgress progress={null} />);
    expect(document.querySelector("button")).toBeNull();
  });

  it("calls the Cancel and Work locally handlers", async () => {
    const onCancel = vi.fn();
    const onWorkLocally = vi.fn();
    await render(
      <ComposerWorktreeProgress
        progress={{ percent: 10 }}
        onCancel={onCancel}
        onWorkLocally={onWorkLocally}
      />,
    );
    await page.getByRole("button", { name: "Cancel" }).click();
    await page.getByRole("button", { name: "Work locally" }).click();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onWorkLocally).toHaveBeenCalledTimes(1);
  });
});
