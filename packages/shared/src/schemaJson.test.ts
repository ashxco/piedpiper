import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { fromLenientJson } from "./schemaJson";

const decodeLenientJson = Schema.decodeUnknownSync(fromLenientJson(Schema.Unknown));

describe("fromLenientJson", () => {
  it.each(["\n", "\r\n", "\r"])(
    "decodes comments and trailing commas with %j line endings",
    (eol) => {
      expect(
        decodeLenientJson(
          `{
        // Comments are valid in settings files.
        "enabled": /* See "https://example.com/config" // still in the block */ true,
        "values": [1, 2,],
      }`.replaceAll("\n", eol),
        ),
      ).toEqual({ enabled: true, values: [1, 2] });
    },
  );

  it("preserves comment markers and commas before brackets inside string values", () => {
    expect(decodeLenientJson('"1/* https://example.com */2"')).toBe("1/* https://example.com */2");
    expect(decodeLenientJson('{"note":"a,]"}')).toEqual({ note: "a,]" });
    expect(decodeLenientJson('{"list":["x,}"]}')).toEqual({ list: ["x,}"] });
    expect(decodeLenientJson('{"url":"https://example.com//x"}')).toEqual({
      url: "https://example.com//x",
    });
    expect(decodeLenientJson('{"values":[1, 2,],}')).toEqual({ values: [1, 2] });
  });

  it("keeps properties after CR-terminated comments in mixed line endings", () => {
    expect(decodeLenientJson('{\n"enabled":true,// comment\r"values":[1,2],\n}')).toEqual({
      enabled: true,
      values: [1, 2],
    });
  });

  it("keeps tokens separated when a block comment sits between them", () => {
    expect(() => decodeLenientJson('{"a":1/**/2}')).toThrow();
  });
});
