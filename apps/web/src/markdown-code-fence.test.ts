import { describe, expect, it } from "vitest";

import {
  extractFenceTitle,
  extractPreCodeMeta,
  normalizeFenceLanguage,
} from "./markdown-code-fence";

describe("normalizeFenceLanguage", () => {
  it.each([
    ["asm", "asm"],
    ["ASM", "asm"],
    ["assembly", "asm"],
    ["nasm", "asm"],
    ["NASM", "asm"],
    ["s", "asm"],
    ["S", "asm"],
    ["gitignore", "ini"],
    ["typescript", "typescript"],
    ["constructor", "constructor"],
    ["text", "text"],
  ])("maps %s to %s", (language, expected) => {
    expect(normalizeFenceLanguage(language)).toBe(expected);
  });
});

describe("extractFenceTitle", () => {
  it("reads title, file and filename attributes in any quoting", () => {
    expect(extractFenceTitle('title="src/a b.ts"')).toBe("src/a b.ts");
    expect(extractFenceTitle("file='lib/x.py'")).toBe("lib/x.py");
    expect(extractFenceTitle("filename=apps/web/index.css {1,3}")).toBe("apps/web/index.css");
  });

  it("falls back to a bare file-name token", () => {
    expect(extractFenceTitle("src/a.ts")).toBe("src/a.ts");
    expect(extractFenceTitle("{1-3} @scope/pkg/index.d.ts")).toBe("@scope/pkg/index.d.ts");
  });

  it("ignores meta that names no file", () => {
    expect(extractFenceTitle(undefined)).toBeNull();
    expect(extractFenceTitle("showLineNumbers {1,2}")).toBeNull();
    expect(extractFenceTitle("noextension")).toBeNull();
    expect(extractFenceTitle("v2.0.1")).toBeNull();
    expect(extractFenceTitle("3.11")).toBeNull();
    expect(extractFenceTitle("GET example.com")).toBeNull();
    expect(extractFenceTitle("curl 127.0.0.1")).toBeNull();
  });

  it("keeps file names whose extension is not a host suffix", () => {
    expect(extractFenceTitle("v2.0.1 README.md")).toBe("README.md");
    expect(extractFenceTitle("script.pl")).toBe("script.pl");
  });
});

describe("extractPreCodeMeta", () => {
  it("reads the meta from the pre's code child", () => {
    const pre = {
      type: "element",
      tagName: "pre",
      children: [{ type: "element", tagName: "code", data: { meta: '  title="a.ts" ' } }],
    };
    expect(extractPreCodeMeta(pre)).toBe('title="a.ts"');
    expect(
      extractPreCodeMeta({ children: [{ type: "element", tagName: "code" }] }),
    ).toBeUndefined();
    expect(extractPreCodeMeta(undefined)).toBeUndefined();
  });
});
