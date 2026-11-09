import "../../../index.css";

import { page } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { APP_VERSION } from "../../../branding";
import { toastManager } from "../../ui/toast";
import { AboutVersionTitle } from "./AboutVersionSection";

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

it("copies the app version when the version is clicked", async () => {
  const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
  const addToast = vi.spyOn(toastManager, "add");

  await render(<AboutVersionTitle />);

  await page.getByRole("button", { name: `Copy version ${APP_VERSION}` }).click();

  expect(writeText).toHaveBeenCalledWith(APP_VERSION);
  await vi.waitFor(() =>
    expect(addToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "success", title: "Version copied" }),
    ),
  );
});
