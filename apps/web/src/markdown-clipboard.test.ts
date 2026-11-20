import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  serializeCodeBlockToMarkdown,
  serializeRenderedMarkdownFragment,
  serializeTableElementToCsv,
  serializeTableElementToMarkdown,
} from "./markdown-clipboard";

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

class FakeText {
  readonly nodeType = TEXT_NODE;
  readonly childNodes: ReadonlyArray<never> = [];
  parent: FakeElement | null = null;

  constructor(readonly textContent: string) {}
}

class FakeElement {
  readonly nodeType = ELEMENT_NODE;
  checked = false;
  className = "";
  parent: FakeElement | null = null;
  readonly childNodes: Array<FakeElement | FakeText> = [];
  readonly classList = {
    contains: (name: string) => this.classNames.includes(name),
  };

  constructor(
    readonly tagName: string,
    private readonly classNames: ReadonlyArray<string> = [],
    private readonly attributes: Readonly<Record<string, string>> = {},
  ) {
    this.className = classNames.join(" ");
  }

  get localName(): string {
    return this.tagName.toLowerCase();
  }

  get textContent(): string {
    return this.childNodes.map((child) => child.textContent).join("");
  }

  get children(): ReadonlyArray<FakeElement> {
    return this.childNodes.filter((child): child is FakeElement => child instanceof FakeElement);
  }

  append(...children: Array<FakeElement | FakeText>): this {
    for (const child of children) child.parent = this;
    this.childNodes.push(...children);
    return this;
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  hasAttribute(name: string): boolean {
    return Object.hasOwn(this.attributes, name);
  }

  /** Supports the `[attr]` lookups the serializer makes. */
  closest(selector: string): FakeElement | null {
    const attribute = /^\[([\w-]+)\]$/.exec(selector)?.[1];
    if (!attribute) return null;
    return this.hasAttribute(attribute) ? this : (this.parent?.closest(selector) ?? null);
  }

  querySelector(selector: string): FakeElement | null {
    if (selector.includes(", ")) {
      for (const part of selector.split(", ")) {
        const match = this.querySelector(part);
        if (match) return match;
      }
      return null;
    }
    const childOnly = selector.startsWith(":scope > ");
    const [target, ...rest] = (childOnly ? selector.slice(":scope > ".length) : selector).split(
      " > ",
    );
    const matches = (element: FakeElement): boolean => {
      if (target === 'input[type="checkbox"]') {
        return element.tagName === "INPUT" && element.getAttribute("type") === "checkbox";
      }
      return element.tagName === target?.toUpperCase();
    };
    const search = (parent: FakeElement): FakeElement | null => {
      for (const child of parent.childNodes) {
        if (!(child instanceof FakeElement)) continue;
        if (matches(child)) {
          if (rest.length === 0) return child;
          const nested = child.querySelector(`:scope > ${rest.join(" > ")}`);
          if (nested) return nested;
        }
        if (!childOnly) {
          const nested = search(child);
          if (nested) return nested;
        }
      }
      return null;
    };
    return search(this);
  }

  /** Supports the `:scope > a > b` child paths the table serializer queries. */
  querySelectorAll(selector: string): FakeElement[] {
    return selector.split(", ").flatMap((part) =>
      part
        .replace(/^:scope > /, "")
        .split(" > ")
        .reduce<FakeElement[]>(
          (level, tag) =>
            level.flatMap((element) =>
              element.children.filter((child) => child.tagName === tag.toUpperCase()),
            ),
          [this],
        ),
    );
  }
}

function asNode(element: FakeElement): Node {
  return element as unknown as Node;
}

function shikiCodeLine(text: string): FakeElement {
  const token = new FakeElement("SPAN").append(new FakeText(text));
  return new FakeElement("SPAN", ["line"]).append(token);
}

function renderedCodeBlock(lines: ReadonlyArray<string>, language?: string): FakeElement {
  const code = new FakeElement("CODE");
  lines.forEach((line, index) => {
    if (index > 0) code.append(new FakeText("\n"));
    code.append(shikiCodeLine(line));
  });
  return new FakeElement(
    "DIV",
    ["chat-markdown-codeblock"],
    language ? { "data-language": language } : {},
  ).append(
    new FakeElement("BUTTON").append(new FakeText("Copy")),
    new FakeElement("DIV", ["chat-markdown-shiki"]).append(new FakeElement("PRE").append(code)),
  );
}

function renderedTable(...rows: Array<Array<FakeElement | FakeText>>): FakeElement {
  const row = (tag: string, cells: Array<FakeElement | FakeText>) =>
    new FakeElement("TR").append(...cells.map((cell) => new FakeElement(tag).append(cell)));
  const [head = [], ...body] = rows;
  return new FakeElement("TABLE").append(
    new FakeElement("THEAD").append(row("TH", head)),
    new FakeElement("TBODY").append(...body.map((cells) => row("TD", cells))),
  );
}

beforeEach(() => {
  vi.stubGlobal("Node", { TEXT_NODE, ELEMENT_NODE });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("serializeRenderedMarkdownFragment", () => {
  it("keeps headings, emphasis, links and ordered list numbers", () => {
    const container = new FakeElement("DIV").append(
      new FakeElement("H2").append(new FakeText("Plan")),
      new FakeElement("P").append(
        new FakeText("See "),
        new FakeElement("A", [], { href: "https://example.com" }).append(new FakeText("docs")),
        new FakeText(" and "),
        new FakeElement("STRONG").append(new FakeText("bold")),
        new FakeText(" "),
        new FakeElement("CODE").append(new FakeText("a`b")),
      ),
      new FakeElement("OL", [], { start: "3" }).append(
        new FakeElement("LI").append(new FakeText("third")),
        new FakeElement("LI").append(new FakeText("fourth")),
      ),
    );

    expect(serializeRenderedMarkdownFragment(asNode(container))).toBe(
      "## Plan\n\nSee [docs](https://example.com) and **bold** ``a`b``\n\n3. third\n4. fourth",
    );
  });

  it.each([
    ["backtick edges", "`value`", "`` `value` ``"],
    ["space edges", "  value  ", "`   value   `"],
    ["one space edge", " value", "` value`"],
    ["only spaces", "   ", "`   `"],
  ])("copies inline code that parses back unchanged: %s", (_, value, expected) => {
    const container = new FakeElement("DIV").append(
      new FakeElement("P").append(
        new FakeText("Use "),
        new FakeElement("CODE").append(new FakeText(value)),
        new FakeText(" here."),
      ),
    );
    expect(serializeRenderedMarkdownFragment(asNode(container))).toBe(`Use ${expected} here.`);
  });

  it("copies email links with their address and drops in-app destinations", () => {
    const container = new FakeElement("DIV").append(
      new FakeElement("P").append(
        new FakeText("Write to "),
        new FakeElement("A", [], { href: "mailto:support@example.com" }).append(
          new FakeText("support@example.com"),
        ),
        new FakeText(", "),
        new FakeElement("A", [], { href: "mailto:support@example.com?subject=Help" }).append(
          new FakeText("Support"),
        ),
        new FakeText(", "),
        new FakeElement("A", [], { href: "mailto:support@example.com?subject=Help)" }).append(
          new FakeText("Support"),
        ),
        new FakeText(" or "),
        new FakeElement("A", [], { href: "/environment-one/thread-one" }).append(
          new FakeText("the thread"),
        ),
        new FakeText("."),
      ),
    );
    expect(serializeRenderedMarkdownFragment(asNode(container))).toBe(
      "Write to support@example.com, [Support](mailto:support@example.com?subject=Help), [Support](mailto:support@example.com?subject=Help\\)) or the thread.",
    );
  });

  it.each([
    "support@example.com?subject=Help",
    "foo",
    "support@example.internal1",
    "support@example.com_",
    "support@example.com-",
  ])("keeps the destination when the email label is not a bare address: %s", (label) => {
    const anchor = new FakeElement("A", [], { href: `mailto:${label}` }).append(
      new FakeText(label),
    );
    expect(serializeRenderedMarkdownFragment(asNode(new FakeElement("DIV").append(anchor)))).toBe(
      `[${label}](mailto:${label})`,
    );
  });

  it("copies a code block with prose as shown, without fences, and skips its buttons", () => {
    const container = new FakeElement("DIV").append(
      new FakeElement("P").append(new FakeText("Run:")),
      renderedCodeBlock(["bun run test", "bun run lint"], "sh"),
    );

    expect(serializeRenderedMarkdownFragment(asNode(container))).toBe(
      "Run:\n\nbun run test\nbun run lint",
    );
  });

  it("fences a code block with its language when asked, as a quote into the composer is", () => {
    const container = new FakeElement("DIV").append(
      new FakeElement("P").append(new FakeText("Run:")),
      renderedCodeBlock(["bun run test", "", "", "bun run lint  "], "sh"),
    );

    expect(serializeRenderedMarkdownFragment(asNode(container), { fenceCode: true })).toBe(
      "Run:\n\n```sh\nbun run test\n\n\nbun run lint  \n```",
    );
  });

  it("copies a command and the prose after it as shown, without code fences", () => {
    const container = new FakeElement("DIV").append(
      renderedCodeBlock(["printf 'hello\\n'"]),
      new FakeElement("P").append(new FakeText("T")),
    );

    expect(serializeRenderedMarkdownFragment(asNode(container))).toBe("printf 'hello\\n'\n\nT");
  });

  it("keeps a diagram's source exactly as written when copied with prose", () => {
    const source = 'flowchart TD\n  A["first   \n\n\nlast"]';
    const container = new FakeElement("DIV").append(
      new FakeElement("DIV", [], {
        "data-markdown-diagram-source": source,
        "data-markdown-copy": serializeCodeBlockToMarkdown(source, "mermaid"),
      }),
      new FakeElement("P").append(new FakeText("After")),
    );

    expect(serializeRenderedMarkdownFragment(asNode(container))).toBe(
      `\`\`\`mermaid\n${source}\n\`\`\`\n\nAfter`,
    );
  });

  it("uses the Markdown a rendered widget declares", () => {
    const container = new FakeElement("DIV").append(
      new FakeText("Edit "),
      new FakeElement("BUTTON", [], { "data-markdown-copy": "[a.ts](/repo/src/a.ts)" }).append(
        new FakeText("a.ts"),
      ),
    );

    expect(serializeRenderedMarkdownFragment(asNode(container))).toBe(
      "Edit [a.ts](/repo/src/a.ts)",
    );
  });

  it("keeps task list markers and nesting", () => {
    const checked = new FakeElement("INPUT", [], { type: "checkbox" });
    checked.checked = true;
    const container = new FakeElement("DIV").append(
      new FakeElement("UL").append(
        new FakeElement("LI").append(
          checked,
          new FakeText(" done\n"),
          new FakeElement("UL").append(
            new FakeElement("LI").append(
              new FakeElement("INPUT", [], { type: "checkbox" }),
              new FakeText(" todo"),
            ),
          ),
        ),
      ),
    );

    expect(serializeRenderedMarkdownFragment(asNode(container))).toBe("- [x] done\n  - [ ] todo");
  });

  it("keeps a multi-line code selection plain instead of inline-wrapping it", () => {
    const code = new FakeElement("CODE").append(new FakeText("first line\nsecond line"));
    const container = new FakeElement("DIV").append(code);

    expect(serializeRenderedMarkdownFragment(asNode(container))).toBe("first line\nsecond line");
  });

  it("keeps blank lines inside a code block in a list item, quote, or longer fence", () => {
    const code = ["import os", "", "", "def main():"];
    const list = new FakeElement("OL").append(
      new FakeElement("LI").append(new FakeText("Create it:\n"), renderedCodeBlock(code)),
    );
    const quote = new FakeElement("BLOCKQUOTE").append(
      new FakeElement("P").append(new FakeText("Note:")),
      renderedCodeBlock(code),
    );
    const nestedFence = new FakeElement("DIV").append(
      new FakeElement("P").append(new FakeText("Example:")),
      renderedCodeBlock(["```js", "a()", "", "", "b()  ", "```"]),
    );

    expect(serializeRenderedMarkdownFragment(asNode(nestedFence))).toBe(
      "Example:\n\n```js\na()\n\n\nb()  \n```",
    );
    expect(serializeRenderedMarkdownFragment(asNode(new FakeElement("DIV").append(list)))).toBe(
      "1. Create it:\n   import os\n\n\n   def main():",
    );
    expect(serializeRenderedMarkdownFragment(asNode(new FakeElement("DIV").append(quote)))).toBe(
      "> Note:\n>\n> import os\n>\n>\n> def main():",
    );
  });

  it("keeps a bare list item that sits alongside the code block", () => {
    const container = new FakeElement("DIV").append(
      new FakeElement("UL").append(new FakeElement("LI")),
      renderedCodeBlock(["bun test"]),
    );

    expect(serializeRenderedMarkdownFragment(asNode(container))).toBe("-\n\nbun test");
  });

  it("omits fences when a selection past the last line drags in the whole code block", () => {
    const container = new FakeElement("DIV").append(
      renderedCodeBlock(["printf '%s' 'TOKEN' | gh secret set API_TOKEN"], "sh"),
      new FakeText("\n"),
      new FakeElement("P").append(new FakeText("")),
    );

    expect(serializeRenderedMarkdownFragment(asNode(container))).toBe(
      "printf '%s' 'TOKEN' | gh secret set API_TOKEN",
    );
  });
});

describe("serializeCodeBlockToMarkdown", () => {
  it("picks a fence longer than any backtick run in the code", () => {
    expect(serializeCodeBlockToMarkdown("```\nx\n```\n", "md")).toBe(
      "````md\n```\nx\n```\n````\n\n",
    );
  });
});

describe("copying rendered Markdown tables", () => {
  it("copies code and diagrams in cells without markers or unescaped pipes", () => {
    const code = new FakeElement("PRE").append(
      new FakeElement("CODE").append(new FakeText("a  b")),
    );
    const diagram = new FakeElement("DIV", [], {
      "data-markdown-diagram-source": "A -->|hi| B",
      "data-markdown-copy": serializeCodeBlockToMarkdown("A -->|hi| B", "mermaid"),
    });
    expect(
      serializeTableElementToMarkdown(
        asNode(
          renderedTable([new FakeText("Command"), new FakeText("Diagram")], [code, diagram]),
        ) as Element,
      ),
    ).toBe("| Command | Diagram |\n| --- | --- |\n| a  b | ```mermaid A -->\\|hi\\| B ``` |");
  });

  it("escapes pipes in cells and keeps links and inline code", () => {
    const table = renderedTable(
      [new FakeText("Name"), new FakeText("Note")],
      [new FakeText("a | b"), new FakeElement("CODE").append(new FakeText("c|d"))],
      [
        new FakeElement("A", [], { href: "https://example.com/?q=a|b" }).append(
          new FakeText("link"),
        ),
        new FakeText("e"),
      ],
    );

    expect(serializeTableElementToMarkdown(table as unknown as Element)).toBe(
      [
        "| Name | Note |",
        "| --- | --- |",
        "| a \\| b | `c\\|d` |",
        "| [link](https://example.com/?q=a\\|b) | e |",
      ].join("\n"),
    );
  });

  it("serializes CSV with quoting for commas, quotes and collapsed whitespace", () => {
    const table = renderedTable(
      [new FakeText("File"), new FakeText("Result")],
      [new FakeText("a, b.ts"), new FakeText('said "ok"\n  twice')],
    );

    expect(serializeTableElementToCsv(table as unknown as Element)).toBe(
      'File,Result\n"a, b.ts","said ""ok"" twice"',
    );
  });
});
