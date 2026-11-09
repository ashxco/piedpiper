import "../../index.css";

import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ThreadErrorBanner } from "./ThreadErrorBanner";

const RAW_ERROR =
  'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';

describe("ThreadErrorBanner", () => {
  it("shows the readable message and keeps the raw payload behind a toggle", async () => {
    const screen = await render(<ThreadErrorBanner error={RAW_ERROR} />);

    await expect.element(screen.getByText("API Error: 529 Overloaded")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("overloaded_error");

    await screen.getByRole("button", { name: "Show full error" }).click();
    await expect.element(screen.getByText(RAW_ERROR)).toBeInTheDocument();

    await screen.getByRole("button", { name: "Hide full error" }).click();
    expect(document.body.textContent).not.toContain("overloaded_error");
  });

  it("copies the raw payload of a structured error", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.spyOn(navigator, "clipboard", "get").mockReturnValue({
      writeText,
    } as unknown as Clipboard);
    const screen = await render(<ThreadErrorBanner error={RAW_ERROR} />);

    await screen.getByRole("button", { name: "Copy error" }).click();

    expect(writeText).toHaveBeenCalledWith(RAW_ERROR);
    await expect.element(screen.getByText("Copied")).toBeInTheDocument();
    vi.restoreAllMocks();
  });

  it("renders plain errors as-is without a toggle", async () => {
    const screen = await render(<ThreadErrorBanner error="Provider crashed" />);

    await expect.element(screen.getByText("Provider crashed")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("Show full error");
  });
});
