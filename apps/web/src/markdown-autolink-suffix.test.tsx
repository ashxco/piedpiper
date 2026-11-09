import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { describe, expect, it } from "vitest";

import { remarkKeepAutolinkSuffixes } from "./markdown-autolink-suffix";

interface Node {
  type: string;
  url?: string;
  value?: string;
  identifier?: string;
  children?: Node[];
}

function shape(node: Node): string {
  if (node.type === "text") return node.value ?? "";
  if (node.type === "inlineCode") return `\`${node.value}\``;
  if (node.type === "code") return `\`\`\`${node.value}\`\`\``;
  const children = (node.children ?? []).map(shape).join("");
  if (node.type === "link") return `[${children}](${node.url})`;
  if (node.type === "linkReference") return `[${children}][${node.identifier}]`;
  if (node.type === "emphasis") return `*${children}*`;
  if (node.type === "strong") return `**${children}**`;
  if (node.type === "delete") return `~~${children}~~`;
  return children;
}

function parseTree(markdown: string): Node {
  let tree: Node | undefined;
  renderToStaticMarkup(
    <ReactMarkdown
      remarkPlugins={[
        remarkGfm,
        remarkKeepAutolinkSuffixes,
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

function parse(markdown: string): string {
  return shape(parseTree(markdown));
}

const link = (url: string) => `[${url}](${/^www\./i.test(url) ? `http://${url}` : url})`;

describe("remarkKeepAutolinkSuffixes", () => {
  it("keeps trailing underscores and tildes in bare URLs before any punctuation", () => {
    for (const url of [
      "https://x.com/dimasike_",
      "http://example.com/name__",
      "HTTPS://example.com/name_",
      "https://example.com/a_(b)_",
      "https://example.com/?name=value_",
      "https://example.com/#section_",
      "https://example.com/a_?name=value_#section_",
      "https://example.com/name~",
      "https://example.com/name~~",
      "https://example.com/name_~",
      "https://example.com/name~_",
      "https://example.com/name__~~_",
      "https://example.com/?name=value~",
      "https://example.com/#section~",
      "www.example.com/name_",
      "www.example.com/name~_",
      "WWW.example.com/name~~",
      "https://example.com/name-",
      "https://example.com/name/",
      "https://example.com/name%5F",
      "https://example.com/name%7E",
    ]) {
      for (const punctuation of ["", ".", ",", "!", "?", ":", ";", ")", "]", '"']) {
        const markdown = `See ${url}${punctuation} next`;
        expect(parse(markdown), markdown).toBe(`See ${link(url)}${punctuation} next`);
      }
    }
  });

  it.each([
    ["*https://x.com/dimasike_*", `*${link("https://x.com/dimasike_")}*`],
    ["**https://x.com/dimasike_**", `**${link("https://x.com/dimasike_")}**`],
    ["_https://x.com/dimasike_", `*${link("https://x.com/dimasike")}*`],
    ["__https://x.com/dimasike__", `**${link("https://x.com/dimasike")}**`],
    ["~~https://example.com/name_~~", `~~${link("https://example.com/name_")}~~`],
    ["~~https://example.com/name~~", `~~${link("https://example.com/name")}~~`],
    ["~https://example.com/name~", `~~${link("https://example.com/name")}~~`],
    ["*https://example.com/name~*", `*${link("https://example.com/name~")}*`],
    ["_https://example.com/name~_", `*${link("https://example.com/name~")}*`],
    ["[test](https://example.com/name~)", "[test](https://example.com/name~)"],
    ["[https://x.com/a](https://x.com/a)~_", `${link("https://x.com/a")}~_`],
    ["<https://x.com/a>~_", `${link("https://x.com/a")}~_`],
    ["[test][ref]~_\n\n[ref]: https://x.com/a~_", "[test][ref]~_"],
    ["`https://example.com/name~_`", "`https://example.com/name~_`"],
    ["```\nhttps://example.com/name~_\n```", "```https://example.com/name~_```"],
    ["https\\://example.com/name~_", link("https://example.com/name~_")],
    ["https://example.com/name. _~", `${link("https://example.com/name")}. _~`],
    ["Mail person@example.com_", "Mail person@example.com_"],
    ["Mail person@example.com ~_", "Mail [person@example.com](mailto:person@example.com) ~_"],
    ["[test](https://x.com/dimasike_)", "[test](https://x.com/dimasike_)"],
    ["[https://x.com/a](https://x.com/a)_", `${link("https://x.com/a")}_`],
    ["<https://x.com/a>_", `${link("https://x.com/a")}_`],
    ["[test][ref]_\n\n[ref]: https://x.com/a_", "[test][ref]_"],
    ["`https://x.com/dimasike_`", "`https://x.com/dimasike_`"],
    ["```\nhttps://x.com/dimasike_\n```", "```https://x.com/dimasike_```"],
    ["https://x.com/a. _", `${link("https://x.com/a")}. _`],
    ["https\\://x.com/dimasike_", link("https://x.com/dimasike_")],
    ["https://x.com/a\\_", link("https://x.com/a\\_")],
    ["https://x.com/a&#95;", `${link("https://x.com/a&#95")};`],
    [
      "https://x.com/a_ https://x.com/b_",
      `${link("https://x.com/a_")} ${link("https://x.com/b_")}`,
    ],
  ])("leaves explicit links and other syntax alone: %s", (markdown, expected) => {
    expect(parse(markdown)).toBe(expected);
  });

  it.each(["https://x.com/dimasike_", "www.example.com/name~_"])(
    "moves the link and next-text boundary past the suffix: %s",
    (url) => {
      const boundary = { line: 1, column: url.length + 1, offset: url.length };
      expect(parseTree(`${url}, next`)).toMatchObject({
        children: [
          {
            children: [
              {
                type: "link",
                url: /^www\./i.test(url) ? `http://${url}` : url,
                position: { end: boundary },
                children: [{ type: "text", value: url, position: { end: boundary } }],
              },
              { type: "text", value: ", next", position: { start: boundary } },
            ],
          },
        ],
      });
    },
  );

  it("renders the kept suffix in the link href and label", () => {
    const html = renderToStaticMarkup(
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkKeepAutolinkSuffixes]}>
        {"See https://x.com/dimasike_."}
      </ReactMarkdown>,
    );
    expect(html).toContain('<a href="https://x.com/dimasike_">https://x.com/dimasike_</a>.');
  });
});
