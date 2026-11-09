import "../../index.css";

import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { userEvent } from "vitest/browser";

import { SidebarCloneProjectForm } from "./SidebarCloneProjectForm";

const inputs = () => ({
  url: document.querySelector<HTMLInputElement>('input[aria-label="Repository URL"]')!,
  destination: document.querySelector<HTMLInputElement>('input[aria-label="Clone destination"]')!,
  clone: [...document.querySelectorAll("button")].find((button) =>
    button.textContent?.startsWith("Clon"),
  ) as HTMLButtonElement,
});

const cancelButton = () =>
  [...document.querySelectorAll("button")].find((button) => button.textContent === "Cancel clone");

describe("SidebarCloneProjectForm", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("proposes a destination from the URL and clones it", async () => {
    const onClone = vi.fn();
    await render(
      <SidebarCloneProjectForm
        defaultParentDirectory="/code"
        isCloning={false}
        onCancel={() => {}}
        onClone={onClone}
        onClose={() => {}}
      />,
    );
    expect(inputs().clone.disabled).toBe(true);

    await userEvent.fill(inputs().url, "https://github.com/acme/repo.git");
    await vi.waitFor(() => expect(inputs().destination.value).toBe("/code/repo"));
    expect(inputs().clone.disabled).toBe(false);

    await userEvent.click(inputs().clone);
    expect(onClone).toHaveBeenCalledWith({
      url: "https://github.com/acme/repo.git",
      destinationPath: "/code/repo",
    });
  });

  it("stops following the URL once the destination is typed", async () => {
    await render(
      <SidebarCloneProjectForm
        defaultParentDirectory="/code"
        isCloning={false}
        onCancel={() => {}}
        onClone={() => {}}
        onClose={() => {}}
      />,
    );
    await userEvent.fill(inputs().destination, "/elsewhere/mine");
    await userEvent.fill(inputs().url, "https://github.com/acme/repo.git");
    await vi.waitFor(() => expect(inputs().url.value).toContain("acme"));
    expect(inputs().destination.value).toBe("/elsewhere/mine");
  });

  it("keeps Clone off for anything git would not read as a remote, and while cloning", async () => {
    const view = await render(
      <SidebarCloneProjectForm
        defaultParentDirectory="/code"
        isCloning={false}
        onCancel={() => {}}
        onClone={() => {}}
        onClose={() => {}}
      />,
    );
    await userEvent.fill(inputs().url, "--upload-pack=evil");
    await userEvent.fill(inputs().destination, "/code/x");
    expect(inputs().clone.disabled).toBe(true);

    await userEvent.fill(inputs().url, "https://github.com/acme/repo.git");
    await vi.waitFor(() => expect(inputs().clone.disabled).toBe(false));

    await view.rerender(
      <SidebarCloneProjectForm
        defaultParentDirectory="/code"
        isCloning
        onCancel={() => {}}
        onClone={() => {}}
        onClose={() => {}}
      />,
    );
    expect(inputs().clone.disabled).toBe(true);
    expect(inputs().clone.textContent).toBe("Cloning...");
  });

  it("offers Cancel only while cloning", async () => {
    const onCancel = vi.fn();
    const form = (isCloning: boolean) => (
      <SidebarCloneProjectForm
        defaultParentDirectory="/code"
        isCloning={isCloning}
        onCancel={onCancel}
        onClone={() => {}}
        onClose={() => {}}
      />
    );
    const view = await render(form(false));
    expect(cancelButton()).toBeUndefined();

    await view.rerender(form(true));
    await userEvent.click(cancelButton()!);
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
