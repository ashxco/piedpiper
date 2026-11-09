import remarkParse from "remark-parse";
import { unified } from "unified";
import { describe, expect, it } from "vitest";

import {
  codexFileCitationMarkdown,
  remarkCodexDirectives,
  renderCodexInlineDirectivesAsMarkdown,
  resolveCodexFileCitationLink,
} from "./codexMarkdownDirectives";

interface TestNode {
  readonly type: string;
  readonly value?: string;
  readonly url?: string;
  readonly position?: {
    readonly start: { readonly offset?: number };
    readonly end: { readonly offset?: number };
  };
  readonly data?: { readonly hName?: string };
  readonly children?: readonly TestNode[];
}

const FILE_CITATION = ':codex-file-citation{path="outputs/report.xlsx" purpose="output"}';
const FOLLOW_UP =
  ':codex-followup[Prepare print version]{prompt="Prepare the document for printing."}';

function parse(markdown: string): TestNode {
  const processor = unified().use(remarkParse).use(remarkCodexDirectives);
  return processor.runSync(processor.parse(markdown), { value: markdown }) as TestNode;
}

function parseOrdinaryMarkdown(markdown: string): TestNode {
  return unified().use(remarkParse).parse(markdown) as TestNode;
}

describe("remarkCodexDirectives", () => {
  it("renders a file citation as a link without changing its source position", () => {
    const markdown = `Created ${FILE_CITATION}.`;
    const link = parse(markdown).children?.[0]?.children?.[1];

    expect(link).toMatchObject({
      type: "link",
      url: "outputs/report.xlsx",
      children: [{ type: "text", value: "report.xlsx" }],
      position: {
        start: { offset: markdown.indexOf(FILE_CITATION) },
        end: { offset: markdown.indexOf(FILE_CITATION) + FILE_CITATION.length },
      },
    });
  });

  it("renders a follow-up as a span holding only its label", () => {
    const followUp = parse(`- ${FOLLOW_UP}`).children?.[0]?.children?.[0]?.children?.[0]
      ?.children?.[0];
    expect(followUp).toMatchObject({
      type: "textDirective",
      data: { hName: "span" },
      children: [{ type: "text", value: "Prepare print version" }],
    });
  });

  it.each([
    "Meeting at 10:30",
    ":::note\ncontent\n:::",
    "::artifact-template{display_name=x}",
    ':codex-file-citation-extra{path="outputs/report.xlsx"}',
    ':codex-followup-extra[Label]{prompt="Prompt"}',
    ':other-directive[x]{y="z"}',
  ])("does not change unrelated colon syntax: %s", (markdown) => {
    expect(parse(markdown)).toEqual(parseOrdinaryMarkdown(markdown));
  });

  it.each([
    ':codex-file-citation{purpose="output"}',
    ":codex-followup[Prepare print version]",
    ':codex-followup[ ]{prompt="Prepare the document for printing."}',
  ])("keeps malformed supported directives literal: %s", (markdown) => {
    expect(parse(markdown)).toEqual(parseOrdinaryMarkdown(markdown));
  });
});

describe("renderCodexInlineDirectivesAsMarkdown", () => {
  it("rewrites citations as links and follow-ups as their label", () => {
    expect(
      renderCodexInlineDirectivesAsMarkdown(
        `Created ${FILE_CITATION}.\n\n- ${FOLLOW_UP}\n- :codex-followup[Review **document**]{prompt="Review it."}`,
      ),
    ).toBe(
      "Created [report.xlsx](<outputs/report.xlsx>).\n\n- Prepare print version\n- Review **document**",
    );
  });

  it.each([
    `\\${FILE_CITATION}`,
    `\`${FILE_CITATION}\``,
    `[See ${FILE_CITATION}](https://example.com)`,
    "No directives here: 10:30",
  ])("leaves excluded citation syntax alone: %s", (markdown) => {
    expect(renderCodexInlineDirectivesAsMarkdown(markdown)).toBe(markdown);
  });

  it("keeps backslashes and the cited line in the rewritten link", () => {
    const markdown = renderCodexInlineDirectivesAsMarkdown(
      ':codex-file-citation{path="C:\\Users\\test\\[draft]\\report.md" line_range_start="7"}',
    );
    const link = parseOrdinaryMarkdown(markdown).children?.[0]?.children?.[0];
    expect(link?.type).toBe("link");
    expect(decodeURIComponent(link?.url ?? "")).toBe("C:\\Users\\test\\[draft]\\report.md#L7");
  });
});

describe("resolveCodexFileCitationLink", () => {
  it("carries the first cited line into the href and labels with the file name", () => {
    expect(resolveCodexFileCitationLink({ path: "src/main.ts", line_range_start: "42" })).toEqual({
      path: "src/main.ts",
      href: "src/main.ts#L42",
      label: "main.ts",
      lineRangeStart: 42,
    });
    expect(resolveCodexFileCitationLink({ purpose: "output" })).toBeNull();
    expect(
      resolveCodexFileCitationLink({ path: "src/main.ts", line_range_start: "nope" })?.href,
    ).toBe("src/main.ts");
  });

  it("escapes URL and Markdown syntax", () => {
    expect(
      resolveCodexFileCitationLink({ path: "reports/100% #1? draft.md", line_range_start: "7" })
        ?.href,
    ).toBe("reports/100%25 %231%3F draft.md#L7");
    const citation = resolveCodexFileCitationLink({ path: "reports/*draft*_[copy]`<&.txt" });
    expect(citation && codexFileCitationMarkdown(citation)).toBe(
      "[\\*draft\\*\\_\\[copy\\]\\`\\<\\&.txt](<reports/*draft*_[copy]`%3C&.txt>)",
    );
  });
});
