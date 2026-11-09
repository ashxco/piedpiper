import { describe, expect, it } from "vitest";

import {
  markdownProseDirection,
  questionSetDirection,
  rehypeTextDirection,
  textDirection,
} from "./markdown-text-direction";

describe("textDirection", () => {
  it.each([
    ["Arabic", "اكتب دالة تجمع الأرقام", "rtl"],
    ["Hebrew", "תקן את הבאג", "rtl"],
    ["English", "fix the failing test", "ltr"],
    [
      "Arabic that opens with an English term",
      "StrictMode: يعيد الـ render مرتين في التطوير",
      "rtl",
    ],
    ["English quoting one Arabic word", "translate the label مرحبا for the login screen", "ltr"],
    [
      "tied sentences use the whole-text word majority",
      "Done. تم إصلاح المشكلة في الملف الرئيسي",
      "rtl",
    ],
    ["a tie, by its first word", "React مكتبة", "ltr"],
    ["a tie that opens in Arabic", "مكتبة React", "rtl"],
    ["Arabic around numbers and punctuation", "عدّل السطر 42، ثم شغّل الاختبارات (3)", "rtl"],
    [
      "mostly Arabic sentences beside one long English one",
      "هذا مثال على paragraph يحتوي على نص عربي و English words معًا. Arabic text should flow right-to-left while English words like JavaScript, React, and API should remain left-to-right within the same line. الأرقام 1234567890 ورموز مثل @username و #hashtag و 100$ تظهر في الاتجاه الصحيح. هذه جملة لاختبار RTL rendering في المتصفح أو المحرر.",
      "rtl",
    ],
    [
      "mostly English sentences beside one Arabic one",
      "Run the migration first. ثم شغّل الاختبارات كلها. Then deploy to staging.",
      "ltr",
    ],
    [
      "Arabic with inline abbreviations",
      "هذه جملة عربية تتحدث عن e.g. React i.e. TypeScript JavaScript",
      "rtl",
    ],
    [
      "an abbreviation at a sentence boundary",
      "This long English sentence describes the technology sector in the U.S. هذه جملة عربية. وهذه جملة عربية أخرى.",
      "rtl",
    ],
  ])("reads %s", (_, text, direction) => {
    expect(textDirection(text)).toBe(direction);
  });

  it("leaves text without letters to its surroundings", () => {
    expect(textDirection("42 — 7 ✓")).toBeUndefined();
  });
});

describe("markdownProseDirection", () => {
  it.each([
    [
      "Hebrew around a code block",
      "תתקן את זה:\n```ts\nexport function useCheckout(props: CheckoutProps) {\n  return props.items.length;\n}\n```\nותריץ שוב",
      "rtl",
    ],
    ["Hebrew around inline code", "לערוך את `apps/web/src/chat.tsx` או להשאיר `useMemo`?", "rtl"],
    ["Hebrew around double-backtick code", "תבדוק ``const a = `b c d e` + f`` עכשיו", "rtl"],
    [
      "Hebrew after a four-backtick fence",
      "````md\none two three four five six\n````\nשלום עולם, זה עובד",
      "rtl",
    ],
    [
      "Hebrew after a tilde fence",
      "~~~\nnpm run build --filter web --force\n~~~\nזה נכשל אצלי",
      "rtl",
    ],
    [
      "Hebrew before an unclosed fence",
      "שלום, הנה השגיאה:\n```\nError: cannot find module react dom client",
      "rtl",
    ],
    ["Hebrew around a URL", "ראה https://example.com/pulls/24050 לפני", "rtl"],
    ["English around inline code", "Should I edit `useMemo` or keep it?", "ltr"],
    ["English quoting one Hebrew word", "Please check the שלום label before the release", "ltr"],
  ])("reads %s", (_, markdown, direction) => {
    expect(markdownProseDirection(markdown)).toBe(direction);
  });

  it("leaves markdown without prose letters to its surroundings", () => {
    expect(markdownProseDirection("```\nconst a = 1;\n```")).toBeUndefined();
  });
});

describe("questionSetDirection", () => {
  it("reads a mostly Hebrew set right to left, even with an English option", () => {
    expect(
      questionSetDirection([
        {
          header: "גישה",
          question: "איך לבצע את המיגרציה?",
          options: [
            { label: "React Server Components בכל המסכים של האפליקציה", description: "מסך אחד" },
            { label: "Keep it on React 18", description: "English only" },
          ],
        },
      ]),
    ).toBe("rtl");
  });

  it("keeps one direction for a set when a single question is Hebrew", () => {
    expect(
      questionSetDirection([
        {
          header: "Migration",
          question: "How should we move to React Server Components?",
          options: [
            { label: "Screen by screen", description: "Lower risk, each step tested alone." },
            { label: "Server Actions for all forms first", description: "Then the rest." },
          ],
        },
        { header: "גרסה", question: "בחר גרסה", options: [{ label: "גרסה 3 (חדשה!)" }] },
      ]),
    ).toBe("ltr");
  });

  it("does not pair a lone backtick with one in another field", () => {
    expect(
      questionSetDirection([
        {
          header: "`שלום",
          question: "איזו גרסה לבחור עכשיו?",
          options: [{ label: "גרסה ישנה`" }],
        },
      ]),
    ).toBe("rtl");
  });

  it("has no direction for a set without letters", () => {
    expect(questionSetDirection([{ header: "1", question: "2?", options: [] }])).toBeUndefined();
  });
});

const text = (value: string) => ({ type: "text", value });
const element = (tagName: string, children: object[]) => ({
  type: "element",
  tagName,
  properties: {} as Record<string, unknown>,
  children,
});

function directed(...blocks: ReturnType<typeof element>[]) {
  rehypeTextDirection()({ type: "root", children: blocks });
  return blocks;
}

describe("rehypeTextDirection", () => {
  it("marks only right-to-left top-level blocks", () => {
    const [arabic, english] = directed(
      element("p", [text("مرحبا بالعالم")]),
      element("p", [text("hello world")]),
    );
    expect(arabic!.properties.dir).toBe("rtl");
    expect(english!.properties.dir).toBeUndefined();
  });

  it("counts adjacent list items apart", () => {
    const [list] = directed(
      element("ul", [element("li", [text("مرحبا")]), element("li", [text("hello world")])]),
    );
    expect(list!.properties.dir).toBeUndefined();
  });

  it("gives each list item its own vote, so a long English item cannot outvote the Arabic ones", () => {
    const [list] = directed(
      element("ul", [
        element("li", [text("الخطوة الأولى")]),
        element("li", [text("Run the migration script on every staging database first")]),
        element("li", [text("الخطوة الأخيرة")]),
      ]),
    );
    expect(list!.properties.dir).toBe("rtl");
  });

  it("gives each table cell its own vote too", () => {
    const row = (...cells: string[]) =>
      element(
        "tr",
        cells.map((cell) => element("td", [text(cell)])),
      );
    const [arabicTable, englishTable] = directed(
      element("table", [
        row("الاسم", "الوصف"),
        row("الخطوة", "Run the migration script on every staging database first"),
        row("الأخيرة", "تم"),
      ]),
      element("table", [row("Name", "Description"), row("Step", "الخطوة")]),
    );
    expect(arabicTable!.properties.dir).toBe("rtl");
    expect(englishTable!.properties.dir).toBeUndefined();
  });

  it("leaves inline code out of the count and isolates it", () => {
    const code = element("code", [text("useEffect useLayoutEffect React")]);
    const [paragraph] = directed(element("p", [text("استخدم "), code, text(" هنا")]));
    expect(paragraph!.properties.dir).toBe("rtl");
    expect(code.properties.dir).toBe("ltr");
  });

  it("keeps code blocks left to right inside a right-to-left quote", () => {
    const code = element("code", [text("// احسب المجموع هنا")]);
    const pre = element("pre", [code]);
    const [quote] = directed(element("blockquote", [element("p", [text("مثال على ذلك")]), pre]));
    expect(quote!.properties.dir).toBe("rtl");
    expect(pre.properties.dir).toBe("ltr");
  });

  it("leaves code in left-to-right blocks unmarked", () => {
    const code = element("code", [text("x")]);
    directed(element("p", [text("use the "), code, text(" flag")]));
    expect(code.properties.dir).toBeUndefined();
  });
});
