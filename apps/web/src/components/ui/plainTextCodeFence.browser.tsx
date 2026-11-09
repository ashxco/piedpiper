import "../../index.css";

import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import ChatMarkdown from "../ChatMarkdown";

function firstTokenColor(block: Element): string {
  const token = block.querySelector<HTMLElement>(".line span") ?? block.querySelector("pre");
  return getComputedStyle(token as Element).color;
}

describe("plain-text code fences", () => {
  it("match the surrounding text color while labeled fences keep theirs", async () => {
    const text = [
      "Surrounding text.",
      "",
      "```",
      "unlabeled fence",
      "```",
      "",
      "```TXT",
      "uppercase label",
      "```",
      "",
      "```ts",
      "const answer = 42;",
      "```",
    ].join("\n");
    const screen = await render(<ChatMarkdown text={text} cwd="/repo" isStreaming={false} />);

    const shikiBlocks = () => [...screen.container.querySelectorAll(".chat-markdown-shiki")];
    await vi.waitFor(() => expect(shikiBlocks()).toHaveLength(3));

    const paragraph = screen.container.querySelector(".chat-markdown p")!;
    const textColor = getComputedStyle(paragraph).color;
    const [unlabeled, uppercase, typescript] = shikiBlocks();
    expect(firstTokenColor(unlabeled!)).toBe(textColor);
    expect(getComputedStyle(unlabeled!.querySelector("pre")!).color).toBe(textColor);
    expect(firstTokenColor(uppercase!)).toBe(textColor);
    expect(firstTokenColor(typescript!)).not.toBe(textColor);

    await screen.unmount();
  });
});
