import "../../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { userEvent } from "vitest/browser";

import { SidebarProjectPathInput } from "./SidebarProjectPathInput";

const { browseDirectories } = vi.hoisted(() => ({ browseDirectories: vi.fn() }));

vi.mock("~/wsRpcClient", () => ({
  getWsRpcClient: () => ({ projects: { browseDirectories } }),
}));

const LISTINGS: Record<string, readonly string[]> = {
  "/code/": ["alpha", "alpine", "beta"],
  "/code/al": ["alpha", "alpine"],
  "/code/alpha/": ["src"],
  "/code/alpine/": [],
};

function Harness(props: { onSubmit: (value: string) => void; onCancel?: () => void }) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  return (
    <SidebarProjectPathInput
      value={value}
      hasError={false}
      canSubmit={value.length > 0}
      isAdding={false}
      inputRef={inputRef}
      onValueChange={setValue}
      onSubmit={() => props.onSubmit(value)}
      onCancel={props.onCancel ?? (() => {})}
    />
  );
}

async function mount(props: Parameters<typeof Harness>[0]) {
  const queryClient = new QueryClient();
  await render(
    <QueryClientProvider client={queryClient}>
      <Harness {...props} />
    </QueryClientProvider>,
  );
  return document.querySelector<HTMLInputElement>('input[aria-label="Project folder path"]')!;
}

const optionNames = () =>
  [...document.querySelectorAll('[role="option"] span:first-child')].map((el) => el.textContent);

const waitForOptions = (names: readonly string[]) =>
  vi.waitFor(() => expect(optionNames()).toEqual(names));

describe("SidebarProjectPathInput", () => {
  beforeEach(() => {
    browseDirectories.mockReset();
    browseDirectories.mockImplementation(async (input: { partialPath: string }) => {
      const directory = input.partialPath.slice(0, input.partialPath.lastIndexOf("/") + 1);
      return {
        entries: (LISTINGS[input.partialPath] ?? []).map((name) => ({
          name,
          fullPath: `${directory}${name}`,
        })),
      };
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("accepts the top suggestion with Tab, then submits what the box shows with Enter", async () => {
    const onSubmit = vi.fn();
    const input = await mount({ onSubmit });

    await userEvent.fill(input, "/code/al");
    await waitForOptions(["alpha", "alpine"]);

    await userEvent.keyboard("{Tab}");
    await vi.waitFor(() => expect(input.value).toBe("/code/alpha/"));
    expect(document.activeElement).toBe(input);
    await waitForOptions(["src"]);

    await userEvent.keyboard("{Enter}");
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith("/code/alpha/");
  });

  it("debounces typing and lists nothing for a relative path", async () => {
    const input = await mount({ onSubmit: () => {} });

    await userEvent.fill(input, "code");
    await userEvent.fill(input, "./code");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(browseDirectories).not.toHaveBeenCalled();

    await userEvent.fill(input, "/cod");
    await userEvent.fill(input, "/code/");
    await waitForOptions(["alpha", "alpine", "beta"]);
    expect(browseDirectories).toHaveBeenCalledExactlyOnceWith({ partialPath: "/code/" });
  });

  it("only asks for the folder it was told to open, never a suggested child", async () => {
    const input = await mount({ onSubmit: () => {} });

    await userEvent.fill(input, "/code/");
    await waitForOptions(["alpha", "alpine", "beta"]);
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(browseDirectories).toHaveBeenCalledExactlyOnceWith({ partialPath: "/code/" });
  });

  it("lets arrow keys choose a row that Tab or Enter then accepts", async () => {
    const onSubmit = vi.fn();
    const input = await mount({ onSubmit });

    await userEvent.fill(input, "/code/");
    await waitForOptions(["alpha", "alpine", "beta"]);

    await userEvent.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    await vi.waitFor(() => expect(input.value).toBe("/code/alpine/"));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("accepts a clicked row and keeps focus in the box", async () => {
    const input = await mount({ onSubmit: () => {} });

    await userEvent.fill(input, "/code/");
    await waitForOptions(["alpha", "alpine", "beta"]);

    await userEvent.click(document.querySelectorAll<HTMLElement>('[role="option"]')[2]!);
    await vi.waitFor(() => expect(input.value).toBe("/code/beta/"));
    expect(document.activeElement).toBe(input);
  });

  it("closes the list on the first Escape and cancels on the second", async () => {
    const onCancel = vi.fn();
    const input = await mount({ onSubmit: () => {}, onCancel });

    await userEvent.fill(input, "/code/");
    await waitForOptions(["alpha", "alpine", "beta"]);

    await userEvent.keyboard("{Escape}");
    await waitForOptions([]);
    expect(onCancel).not.toHaveBeenCalled();

    await userEvent.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("keeps the Escape that only closes the list away from global handlers", async () => {
    const seenByWindow = vi.fn();
    window.addEventListener("keydown", seenByWindow);
    try {
      const onCancel = vi.fn();
      const input = await mount({ onSubmit: () => {}, onCancel });

      await userEvent.fill(input, "/code/");
      await waitForOptions(["alpha", "alpine", "beta"]);
      seenByWindow.mockClear();

      await userEvent.keyboard("{Escape}");
      await waitForOptions([]);
      expect(seenByWindow).not.toHaveBeenCalled();

      await userEvent.keyboard("{Escape}");
      expect(onCancel).toHaveBeenCalledOnce();
      expect(seenByWindow).toHaveBeenCalledOnce();
    } finally {
      window.removeEventListener("keydown", seenByWindow);
    }
  });

  it("leaves Tab alone with nothing to accept, and stays quiet when browsing fails", async () => {
    browseDirectories.mockRejectedValue(new Error("Unable to browse"));
    const input = await mount({ onSubmit: () => {} });

    await userEvent.fill(input, "/code/");
    await vi.waitFor(() => expect(browseDirectories).toHaveBeenCalled());
    await waitForOptions([]);

    await userEvent.keyboard("{Tab}");
    expect(input.value).toBe("/code/");
    expect(document.activeElement).not.toBe(input);
  });
});
