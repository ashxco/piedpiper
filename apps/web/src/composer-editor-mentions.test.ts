import { describe, expect, it } from "vitest";

import {
  selectionTouchesMentionBoundary,
  serializeComposerMentionPath,
  splitPromptIntoComposerSegments,
} from "./composer-editor-mentions";
import { INLINE_TERMINAL_CONTEXT_PLACEHOLDER } from "./lib/terminalContext";

describe("splitPromptIntoComposerSegments", () => {
  it("splits mention tokens followed by whitespace into mention segments", () => {
    expect(splitPromptIntoComposerSegments("Inspect @AGENTS.md please")).toEqual([
      { type: "text", text: "Inspect " },
      { type: "mention", path: "AGENTS.md", tokenLength: 10 },
      { type: "text", text: " please" },
    ]);
  });

  it("does not convert an incomplete trailing mention token", () => {
    expect(splitPromptIntoComposerSegments("Inspect @AGENTS.md")).toEqual([
      { type: "text", text: "Inspect @AGENTS.md" },
    ]);
  });

  it("keeps newlines around mention tokens", () => {
    expect(splitPromptIntoComposerSegments("one\n@src/index.ts \ntwo")).toEqual([
      { type: "text", text: "one\n" },
      { type: "mention", path: "src/index.ts", tokenLength: 13 },
      { type: "text", text: " \ntwo" },
    ]);
  });

  it("keeps inline terminal context placeholders at their prompt positions", () => {
    expect(
      splitPromptIntoComposerSegments(
        `Inspect ${INLINE_TERMINAL_CONTEXT_PLACEHOLDER}@AGENTS.md please`,
      ),
    ).toEqual([
      { type: "text", text: "Inspect " },
      { type: "terminal-context", context: null },
      { type: "mention", path: "AGENTS.md", tokenLength: 10 },
      { type: "text", text: " please" },
    ]);
  });
});

describe("quoted mention paths", () => {
  it("serializes paths with whitespace or quotes and keeps simple paths bare", () => {
    expect(serializeComposerMentionPath("src/index.ts")).toBe("src/index.ts");
    expect(serializeComposerMentionPath("docs/My Notes.md")).toBe('"docs/My Notes.md"');
    expect(serializeComposerMentionPath('docs/My "File".md')).toBe('"docs/My \\"File\\".md"');
  });

  it("splits quoted mention tokens containing whitespace", () => {
    expect(splitPromptIntoComposerSegments('Inspect @"docs/My Notes.md" please')).toEqual([
      { type: "text", text: "Inspect " },
      { type: "mention", path: "docs/My Notes.md", tokenLength: 19 },
      { type: "text", text: " please" },
    ]);
  });

  it("round-trips escaped quotes and backslashes", () => {
    for (const path of ['docs/My "File".md', "dir\\with space\\a.ts", "a b\\"]) {
      expect(
        splitPromptIntoComposerSegments(`Inspect @${serializeComposerMentionPath(path)} please`),
      ).toEqual([
        { type: "text", text: "Inspect " },
        { type: "mention", path, tokenLength: serializeComposerMentionPath(path).length + 1 },
        { type: "text", text: " please" },
      ]);
    }
  });
});

describe("mention paths starting with @", () => {
  it("round-trips a quoted path that begins with @", () => {
    const path = "@types/global.d.ts";
    const token = `@${serializeComposerMentionPath(path)}`;
    expect(token).toBe('@"@types/global.d.ts"');
    expect(splitPromptIntoComposerSegments(`Inspect ${token} please`)).toEqual([
      { type: "text", text: "Inspect " },
      { type: "mention", path, tokenLength: token.length },
      { type: "text", text: " please" },
    ]);
  });

  it("records the raw token length for a needlessly quoted simple path", () => {
    expect(splitPromptIntoComposerSegments('Inspect @"src/a.ts" please')).toEqual([
      { type: "text", text: "Inspect " },
      { type: "mention", path: "src/a.ts", tokenLength: 11 },
      { type: "text", text: " please" },
    ]);
  });
});

describe("decorator-shaped tokens", () => {
  it.each([
    "@Injectable()",
    "@pytest.fixture()",
    "@namespace.foo(bar)",
    "@écrire(option)",
    "@écrire(option)",
  ])("keeps unquoted decorator call %s as plain text", (reference) => {
    const prompt = `${reference}\nclass Example {}`;
    expect(splitPromptIntoComposerSegments(prompt)).toEqual([{ type: "text", text: prompt }]);
  });

  it("keeps an explicitly quoted decorator-shaped path as a mention", () => {
    expect(splitPromptIntoComposerSegments('@"foo(bar)" ')).toEqual([
      { type: "mention", path: "foo(bar)", tokenLength: 11 },
      { type: "text", text: " " },
    ]);
  });

  it("keeps bare file mentions before whitespace-separated parentheses", () => {
    expect(splitPromptIntoComposerSegments("Inspect @README.md (notes)")).toEqual([
      { type: "text", text: "Inspect " },
      { type: "mention", path: "README.md", tokenLength: 10 },
      { type: "text", text: " (notes)" },
    ]);
  });

  it("quotes decorator-shaped paths so they round-trip as mentions", () => {
    const serialized = serializeComposerMentionPath("foo(bar)");
    expect(serialized).toBe('"foo(bar)"');
    expect(splitPromptIntoComposerSegments(`@${serialized} `)[0]).toEqual({
      type: "mention",
      path: "foo(bar)",
      tokenLength: serialized.length + 1,
    });
    expect(serializeComposerMentionPath("src/foo(bar).ts")).toBe("src/foo(bar).ts");
  });
});

describe("selectionTouchesMentionBoundary", () => {
  it("returns true when selection includes the whitespace after a mention", () => {
    const prompt = "hi @package.json there";
    expect(selectionTouchesMentionBoundary(prompt, "hi @package.json".length, prompt.length)).toBe(
      true,
    );
  });

  it("returns true when selection includes the whitespace before a mention", () => {
    expect(
      selectionTouchesMentionBoundary(
        "hi there @package.json later",
        "hi there".length,
        "hi there ".length,
      ),
    ).toBe(true);
  });

  it("returns false when selection starts after the mention boundary whitespace", () => {
    const prompt = "hi @package.json there";
    expect(selectionTouchesMentionBoundary(prompt, "hi @package.json ".length, prompt.length)).toBe(
      false,
    );
    expect(selectionTouchesMentionBoundary(prompt, 0, "hi".length)).toBe(false);
  });

  it("measures quoted mentions by their raw token length", () => {
    const prompt = 'see @"my file.md" now';
    expect(
      selectionTouchesMentionBoundary(prompt, 'see @"my file.md" '.length, prompt.length),
    ).toBe(false);
    expect(selectionTouchesMentionBoundary(prompt, 'see @"my file.md"'.length, prompt.length)).toBe(
      true,
    );
  });

  it("returns true for whitespace after a mention following a terminal placeholder", () => {
    const prompt = `${INLINE_TERMINAL_CONTEXT_PLACEHOLDER}@AGENTS.md there`;
    expect(
      selectionTouchesMentionBoundary(
        prompt,
        `${INLINE_TERMINAL_CONTEXT_PLACEHOLDER}@AGENTS.md`.length,
        prompt.length,
      ),
    ).toBe(true);
  });

  it("ignores decorator-style tokens that are not mentions", () => {
    const prompt = "use @Injectable() here";
    expect(selectionTouchesMentionBoundary(prompt, "use @Injectable()".length, prompt.length)).toBe(
      false,
    );
  });
});
