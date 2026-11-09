import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ChatMarkdownImage } from "./ChatMarkdownImage";

const image = (props: Partial<Parameters<typeof ChatMarkdownImage>[0]>) =>
  renderToStaticMarkup(
    <ChatMarkdownImage
      src="https://x.test/a.png"
      alt="A"
      cwd="/repo"
      threadId={undefined}
      {...props}
    />,
  );

// The server render is the state before any image has loaded.
describe("ChatMarkdownImage before it loads", () => {
  it("holds a block for an image on its own line", () => {
    const output = image({});
    expect(output).toContain("animate-pulse");
    expect(output).toContain("h-24 w-48");
  });

  it("holds no block for an image sharing its line", () => {
    const output = image({ standalone: false });
    expect(output).not.toContain("animate-pulse");
    expect(output).not.toContain("h-24");
  });

  it("caps the placeholder like the loaded image", () => {
    const output = image({ height: "100000" });
    expect(output).toContain("max-h-[30rem]");
    expect(output).toContain("height:min(30rem, 100000px)");
  });

  it("belongs to the gallery but cannot open it yet", () => {
    const output = image({});
    expect(output).toContain("data-markdown-image-expandable");
    expect(output).not.toContain('role="button"');
    expect(output).not.toContain("tabindex");
  });
});

describe("ChatMarkdownImage chip", () => {
  it("stays out of thread find, which counts images as no text", () => {
    const output = image({ src: "shot.png" });
    expect(output).toContain("Image unavailable · A");
    expect(output).toContain("data-thread-find-ignore");
  });
});
