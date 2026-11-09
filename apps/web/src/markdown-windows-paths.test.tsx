import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { describe, expect, it } from "vitest";

import { remarkKeepWindowsPaths } from "./markdown-windows-paths";

interface Node {
  type: string;
  url?: string;
  value?: string;
  children?: Node[];
}

function parse(markdown: string): Node {
  let tree: Node | undefined;
  renderToStaticMarkup(
    <ReactMarkdown
      remarkPlugins={[
        remarkGfm,
        remarkKeepWindowsPaths,
        () => (root: Node) => {
          tree = structuredClone(root);
        },
      ]}
    >
      {markdown}
    </ReactMarkdown>,
  );
  return tree!;
}

function collect(node: Node, type: string, out: Node[] = []): Node[] {
  if (node.type === type) out.push(node);
  for (const child of node.children ?? []) collect(child, type, out);
  return out;
}

function text(node: Node): string {
  if (node.type === "text") return node.value ?? "";
  if (node.type === "inlineCode") return `<code>${node.value}</code>`;
  return (node.children ?? []).map(text).join("");
}

describe("remarkKeepWindowsPaths", () => {
  it("keeps backslashes before punctuation in Windows link and definition destinations", () => {
    const tree = parse(
      [
        String.raw`[settings](C:\Users\me\.claude\settings.json)`,
        String.raw`[build](C:\Users\me\_build\out.txt "Title")`,
        "[ref][shot]",
        String.raw`[shot]: \\wsl.localhost\Ubuntu\.t3\ref.png`,
        String.raw`[site](https://example.com/a\.b)`,
        "[amp](C:/Users/me/a&amp;b.md)",
      ].join("\n\n"),
    );
    expect(collect(tree, "link").map((link) => link.url)).toEqual([
      String.raw`C:\Users\me\.claude\settings.json`,
      String.raw`C:\Users\me\_build\out.txt`,
      "https://example.com/a.b",
      "C:/Users/me/a&b.md",
    ]);
    expect(collect(tree, "definition").map((definition) => definition.url)).toEqual([
      String.raw`\\wsl.localhost\Ubuntu\.t3\ref.png`,
    ]);
  });

  it("keeps escapes inside drive paths in prose until the path ends at whitespace", () => {
    expect(
      text(
        parse(String.raw`Saved to C:\Users\me\.t3\_build and (C:\.scratch) and C:/work\.config.`),
      ),
    ).toBe(String.raw`Saved to C:\Users\me\.t3\_build and (C:\.scratch) and C:/work\.config.`);
    expect(text(parse(String.raw`Escaped C:\\Users\\me`))).toBe(String.raw`Escaped C:\\Users\\me`);
    expect(text(parse(String.raw`See C:\x and \*this\* and Note:\*that\*.`))).toBe(
      String.raw`See C:\x and *this* and Note:*that*.`,
    );
    expect(text(parse(String.raw`${"`"}C:\me\.t3${"`"} and C:\me\.t3`))).toBe(
      String.raw`<code>C:\me\.t3</code> and C:\me\.t3`,
    );
  });
});
