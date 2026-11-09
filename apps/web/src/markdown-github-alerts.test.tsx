import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { describe, expect, it } from "vitest";

import {
  GITHUB_ALERT_KINDS,
  isGithubAlertKind,
  isGithubAlertMarkerLine,
  remarkGithubAlerts,
} from "./markdown-github-alerts";

const html = (markdown: string) =>
  renderToStaticMarkup(
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkGithubAlerts]}>{markdown}</ReactMarkdown>,
  );

describe("remarkGithubAlerts", () => {
  it("keeps content that follows a marker-only paragraph", () => {
    const output = html("> [!WARNING]\n>\n> ### A heading\n>\n> And a paragraph.");
    expect(output).toContain('data-alert="warning"');
    expect(output).not.toContain("[!WARNING]");
    expect(output).toContain("A heading");
    expect(output).toContain("And a paragraph.");
  });

  it("tags a quote whose next line opens with an inline node", () => {
    const output = html("> [!NOTE]\n> **Medium Risk** Changes routing.");
    expect(output).toContain('data-alert="note"');
    expect(output).not.toContain("[!NOTE]");
    expect(output).toContain("<strong>Medium Risk</strong>");
  });

  it.each(["> [!NOTE] an ordinary quote", "> [!NOTE]**bold**", "[!NOTE]", "> [!OTHER]\n> body"])(
    "leaves %j alone",
    (markdown) => {
      expect(html(markdown)).not.toContain("data-alert");
    },
  );

  it.each([
    ["two spaces", "> [!NOTE]  \n> body"],
    ["a backslash", "> [!NOTE]\\\n> body"],
  ])("recognizes a marker ended by a hard break with %s", (_name, markdown) => {
    const output = html(markdown);
    expect(output).toContain('data-alert="note"');
    expect(output).not.toContain("[!NOTE]");
    expect(output).not.toContain("<br");
    expect(output).toContain("body");
  });

  it("accepts a lowercase marker", () => {
    expect(html("> [!tip]\n> body")).toContain('data-alert="tip"');
  });

  it.each(GITHUB_ALERT_KINDS)("recognizes %s", (kind) => {
    expect(html(`> [!${kind.toUpperCase()}]\n> body`)).toContain(`data-alert="${kind}"`);
  });

  it("tags a marker with no body yet, as a streamed alert starts", () => {
    expect(html("> [!CAUTION]")).toContain('data-alert="caution"');
  });
});

describe("isGithubAlertKind", () => {
  it.each(GITHUB_ALERT_KINDS)("accepts %s", (kind) => {
    expect(isGithubAlertKind(kind)).toBe(true);
  });

  it.each(["constructor", "toString", "__proto__", "NOTE", "", undefined])("rejects %j", (kind) => {
    expect(isGithubAlertKind(kind)).toBe(false);
  });
});

describe("isGithubAlertMarkerLine", () => {
  it.each(["> [!NOTE]", ">[!tip]", "> > [!WARNING]  ", "> [!NOTE]\\", "   > [!CAUTION]"])(
    "accepts %j",
    (line) => {
      expect(isGithubAlertMarkerLine(line)).toBe(true);
    },
  );

  it.each(["[!NOTE]", "> [!NOTE] text", "> [!OTHER]", "> text"])("rejects %j", (line) => {
    expect(isGithubAlertMarkerLine(line)).toBe(false);
  });
});
