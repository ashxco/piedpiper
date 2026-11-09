import "../../index.css";

import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ComposerCommandMenu, type ComposerCommandItem } from "./ComposerCommandMenu";
import { composerSuggestionOptionId } from "./composerSuggestionA11y";

const ITEMS: ComposerCommandItem[] = [
  {
    id: "path:src/my file.ts",
    type: "path",
    path: "src/my file.ts",
    pathKind: "file",
    label: "my file.ts",
    description: "src",
  },
  {
    id: "path:src/index.ts",
    type: "path",
    path: "src/index.ts",
    pathKind: "file",
    label: "index.ts",
    description: "src",
  },
];

describe("ComposerCommandMenu", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders a labelled listbox whose options carry stable ids", async () => {
    await render(
      <ComposerCommandMenu
        listId="composer-suggestions"
        items={ITEMS}
        resolvedTheme="light"
        isLoading={false}
        triggerKind="path"
        activeItemId="path:src/index.ts"
        onHighlightedItemChange={vi.fn()}
        onSelect={vi.fn()}
      />,
    );

    const list = document.getElementById("composer-suggestions");
    expect(list?.getAttribute("role")).toBe("listbox");
    expect(list?.getAttribute("aria-label")).toBe("Files and folders");

    const activeOption = document.getElementById(
      composerSuggestionOptionId("composer-suggestions", "path:src/index.ts"),
    );
    expect(activeOption?.getAttribute("role")).toBe("option");
    expect(activeOption?.getAttribute("aria-selected")).toBe("true");
    const otherOption = document.getElementById(
      composerSuggestionOptionId("composer-suggestions", "path:src/my file.ts"),
    );
    expect(otherOption?.getAttribute("aria-selected")).toBe("false");
  });

  it("lists a provider command as a plain row and hands it back on select", async () => {
    const onSelect = vi.fn();
    const item: ComposerCommandItem = {
      id: "provider:review",
      type: "provider-command",
      command: { name: "review", description: "Review a pull request" },
      label: "/review",
      description: "Review a pull request",
    };
    await render(
      <ComposerCommandMenu
        listId="composer-suggestions"
        items={[item]}
        resolvedTheme="light"
        isLoading={false}
        triggerKind="slash-command"
        activeItemId={item.id}
        onHighlightedItemChange={vi.fn()}
        onSelect={onSelect}
      />,
    );

    const option = document.getElementById(
      composerSuggestionOptionId("composer-suggestions", item.id),
    );
    expect(option?.textContent).toBe("/reviewReview a pull request");
    expect(option?.querySelector("svg")).not.toBeNull();
    option?.click();
    expect(onSelect).toHaveBeenCalledWith(item);
  });
});
