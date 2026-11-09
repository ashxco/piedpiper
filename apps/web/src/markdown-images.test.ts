import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { describe, expect, it } from "vitest";

import {
  classifyMarkdownImageSource,
  hastHasImage,
  isPreservedMarkdownImageSource,
  linkedImageCopy,
  MARKDOWN_IMAGE_STANDALONE_PROPERTY,
  markdownImageBoxStyle,
  markdownImageCopy,
  markdownImagePlaceholderStyle,
  rehypeMarkStandaloneImages,
  remarkBreakAroundImageLines,
} from "./markdown-images";

const CWD = "/repo/project";

describe("classifyMarkdownImageSource", () => {
  it.each([
    ["https://x.test/a.png"],
    ["HTTP://x.test/a.png"],
    ["data:image/png;base64,AAAA"],
    ["blob:http://localhost/1"],
  ])("loads %s directly", (src) => {
    expect(classifyMarkdownImageSource(src, CWD)).toEqual({ _tag: "Direct", uri: src });
  });

  it.each([
    ["shot.png", "/repo/project/shot.png"],
    ["./docs/shot.png", "/repo/project/./docs/shot.png"],
    ["docs/My%20Shot.png", "/repo/project/docs/My Shot.png"],
    ["shot.png?raw=1#x", "/repo/project/shot.png"],
    ["/repo/project/a.png", "/repo/project/a.png"],
    ["/elsewhere/a.png", "/elsewhere/a.png"],
    ["file:///repo/project/a%20b.png", "/repo/project/a b.png"],
    ["file://localhost/repo/a.png", "/repo/a.png"],
    ["C:%5Cwork%5Ca.png", "C:\\work\\a.png"],
    ["C:/work/a.png", "C:/work/a.png"],
    ["/C:/work/a.png", "C:/work/a.png"],
    ["file:///C:/work/a.png", "C:/work/a.png"],
  ])("loads %s through the server", (src, path) => {
    expect(classifyMarkdownImageSource(src, CWD)).toEqual({ _tag: "WorkspaceFile", path });
  });

  it("joins a relative path to a Windows cwd", () => {
    expect(classifyMarkdownImageSource("docs/a.png", "C:\\repo")).toEqual({
      _tag: "WorkspaceFile",
      path: "C:\\repo\\docs\\a.png",
    });
  });

  it.each([
    [undefined],
    [null],
    [""],
    ["  "],
    ["#fragment"],
    ["?query"],
    ["javascript:alert(1)"],
    ["data:text/html,x"],
    ["vbscript:x"],
    ["ftp://x.test/a.png"],
    ["~/a.png"],
    ["\\\\server\\share\\a.png"],
    ["%5C%5Cserver%5Cshare%5Ca.png"],
    ["//server/share/a.png"],
    ["/\\server\\share\\a.png"],
    ["file://server/share/a.png"],
    ["file:///%5C%5Cserver/a.png"],
  ])("blocks %s", (src) => {
    expect(classifyMarkdownImageSource(src, CWD)).toEqual({ _tag: "Blocked" });
  });

  it("blocks a relative path with no cwd to anchor it", () => {
    expect(classifyMarkdownImageSource("a.png", undefined)).toEqual({ _tag: "Blocked" });
    expect(classifyMarkdownImageSource("/abs/a.png", undefined)).toEqual({
      _tag: "WorkspaceFile",
      path: "/abs/a.png",
    });
  });
});

describe("isPreservedMarkdownImageSource", () => {
  it.each(["data:image/png;base64,AA", "blob:x", "file:///a.png", "C:%5Ca.png", "\\\\h\\a.png"])(
    "keeps %s for the renderer to classify",
    (src) => expect(isPreservedMarkdownImageSource(src)).toBe(true),
  );

  it.each(["javascript:alert(1)", "data:text/html,x", "vbscript:x"])("leaves %s", (src) =>
    expect(isPreservedMarkdownImageSource(src)).toBe(false),
  );
});

describe("markdownImageCopy", () => {
  it("escapes the alt text", () => {
    expect(markdownImageCopy("a [b]", "x.png")).toBe("![a \\[b\\]](x.png)");
  });
});

const html = (markdown: string) =>
  renderToStaticMarkup(
    createElement(
      ReactMarkdown,
      { remarkPlugins: [remarkGfm, remarkBreakAroundImageLines] },
      markdown,
    ),
  ).replace(/<link [^>]*>/g, "");

const text = (value: string) => ({ type: "text", value });
const wrap = (tagName: string, ...children: object[]) => ({
  type: "element",
  tagName,
  children,
});

describe("linked images", () => {
  const image = {
    type: "element",
    tagName: "img",
    properties: { alt: "Sh[o]t", src: "docs/shot.png" },
  };
  const link = (...children: object[]) =>
    ({ type: "element", tagName: "a", children }) as Parameters<typeof hastHasImage>[0];

  it("finds an image at any depth", () => {
    expect(hastHasImage(link(image))).toBe(true);
    expect(hastHasImage(link({ type: "element", tagName: "strong", children: [image] }))).toBe(
      true,
    );
    expect(hastHasImage(link(text("docs/shot.png")))).toBe(false);
  });

  it("copies the authored image source and escapes the surrounding text", () => {
    expect(linkedImageCopy(link(image), "docs/shot.png")).toBe(
      "[![Sh\\[o\\]t](docs/shot.png)](docs/shot.png)",
    );
    expect(linkedImageCopy(link(text("\n"), image, text(" a [b]\n")), "/a b/c.png")).toBe(
      "[![Sh\\[o\\]t](docs/shot.png) a \\[b\\]](</a b/c.png>)",
    );
  });

  it("keeps the label's inline formatting", () => {
    const smallImage = { ...image, properties: { alt: "x", src: "y.png" } };
    expect(
      linkedImageCopy(link(wrap("strong", text("Bold ")), smallImage, text(" tail")), "a.md"),
    ).toBe("[**Bold** ![x](y.png) tail](a.md)");
    expect(linkedImageCopy(link(wrap("strong", text("Bold "), smallImage)), "a.md")).toBe(
      "[**Bold ![x](y.png)**](a.md)",
    );
    expect(
      linkedImageCopy(link(wrap("em", wrap("del", text("gone"))), text(" "), smallImage), "a.md"),
    ).toBe("[*~~gone~~* ![x](y.png)](a.md)");
  });

  it("copies code in the label verbatim, without label escaping", () => {
    const code = (value: string) => ({ type: "element", tagName: "code", children: [text(value)] });
    const smallImage = { ...image, properties: { alt: "x", src: "y.png" } };
    expect(linkedImageCopy(link(code("a[0]\\b"), text(" "), smallImage), "a.md")).toBe(
      "[`a[0]\\b` ![x](y.png)](a.md)",
    );
    expect(linkedImageCopy(link(code("a`b"), smallImage), "a.md")).toBe(
      "[``a`b``![x](y.png)](a.md)",
    );
  });
});

describe("remarkBreakAroundImageLines", () => {
  it("breaks after a label line", () => {
    expect(html("**Palette**\n![a](a.png)")).toBe(
      '<p><strong>Palette</strong><br/>\n<img src="a.png" alt="a"/></p>',
    );
    expect(html("Label\n![a](a.png)")).toBe('<p>Label<br/>\n<img src="a.png" alt="a"/></p>');
  });

  it("breaks before a caption line", () => {
    expect(html("![a](a.png)\nCaption")).toBe('<p><img src="a.png" alt="a"/><br/>\nCaption</p>');
  });

  it("treats a linked image as an image", () => {
    expect(html("Label\n[![a](a.png)](https://x.test)")).toContain("Label<br/>");
  });

  it("keeps inline badges in their line", () => {
    expect(html("Status ![a](a.png) here")).not.toContain("<br/>");
    expect(html("Label\nmore ![a](a.png)")).not.toContain("<br/>");
  });
});

describe("markdownImageBoxStyle", () => {
  it("leaves an image with no authored size to its natural one", () => {
    expect(markdownImageBoxStyle(undefined, undefined)).toBeUndefined();
  });

  it("folds the height cap into the width when both sides are authored", () => {
    expect(markdownImageBoxStyle(1000, 4000)).toEqual({
      width: 1000,
      height: "auto",
      aspectRatio: "1000 / 4000",
      maxWidth: "min(100%, 30rem, 7.5rem)",
    });
  });

  it("keeps the other side automatic for a single authored side", () => {
    expect(markdownImageBoxStyle(40, undefined)).toEqual({
      width: 40,
      maxWidth: "min(100%, 30rem)",
    });
    expect(markdownImageBoxStyle(undefined, 40)).toEqual({
      width: "auto",
      height: "min(30rem, 40px)",
    });
  });
});

describe("markdownImagePlaceholderStyle", () => {
  it("caps an authored height, however large, and keeps the default width", () => {
    expect(markdownImagePlaceholderStyle(undefined, 100000, null)).toEqual({
      height: "min(30rem, 100000px)",
    });
  });

  it("reserves the box of a size seen before", () => {
    expect(
      markdownImagePlaceholderStyle(undefined, undefined, { width: 1000, height: 2000 }),
    ).toEqual(markdownImageBoxStyle(1000, 2000));
  });

  it("completes one authored side from a size seen before", () => {
    const natural = { width: 200, height: 100 };
    expect(markdownImagePlaceholderStyle(50, undefined, natural)).toEqual(
      markdownImageBoxStyle(50, 25),
    );
    expect(markdownImagePlaceholderStyle(undefined, 50, natural)).toEqual(
      markdownImageBoxStyle(100, 50),
    );
  });
});

describe("rehypeMarkStandaloneImages", () => {
  const standaloneByAlt = (markdown: string) => {
    const seen: Record<string, boolean> = {};
    renderToStaticMarkup(
      createElement(
        ReactMarkdown,
        {
          remarkPlugins: [remarkGfm, remarkBreakAroundImageLines],
          rehypePlugins: [rehypeMarkStandaloneImages],
          components: {
            img({ node, alt }) {
              seen[alt ?? ""] = node?.properties?.[MARKDOWN_IMAGE_STANDALONE_PROPERTY] === true;
              return null;
            },
          },
        },
        markdown,
      ),
    );
    return seen;
  };

  it("marks an image alone in its paragraph, or as the whole of a link", () => {
    expect(standaloneByAlt("![a](a.png)\n\n[![b](b.png)](https://x.test)")).toEqual({
      a: true,
      b: true,
    });
  });

  it("marks an image on its own line beside a label", () => {
    expect(standaloneByAlt("The result:\n![a](a.png)\nMore text.")).toEqual({ a: true });
  });

  it("leaves images that share a line, like a row of badges", () => {
    expect(
      standaloneByAlt(
        "[![a](a.png)](https://x.test) [![b](b.png)](https://y.test)\n\nx ![c](c.png) y",
      ),
    ).toEqual({ a: false, b: false, c: false });
  });

  it("reads inside lists and quotes", () => {
    expect(standaloneByAlt("- ![a](a.png)\n\n> ![b](b.png) text")).toEqual({ a: true, b: false });
  });
});
