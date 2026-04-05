import { describe, expect, it } from "vitest";

import { ToolInputStreamExtractor, toolInputStreamField } from "./ClaudeAdapterHelpers.ts";

describe("toolInputStreamField", () => {
  it("maps Write/Create-style tool names to 'content'", () => {
    expect(toolInputStreamField("Write")).toBe("content");
    expect(toolInputStreamField("create_file")).toBe("content");
    expect(toolInputStreamField("WRITE")).toBe("content");
  });

  it("maps Edit/Replace-style tool names to 'new_string'", () => {
    expect(toolInputStreamField("Edit")).toBe("new_string");
    expect(toolInputStreamField("str_replace")).toBe("new_string");
    expect(toolInputStreamField("apply_patch")).toBe("new_string");
    expect(toolInputStreamField("StrReplace")).toBe("new_string");
  });

  it("maps Bash/Shell-style tool names to 'command'", () => {
    expect(toolInputStreamField("Bash")).toBe("command");
    expect(toolInputStreamField("shell_exec")).toBe("command");
    expect(toolInputStreamField("run_command")).toBe("command");
    expect(toolInputStreamField("Terminal")).toBe("command");
  });

  it("returns undefined for unknown tools", () => {
    expect(toolInputStreamField("Read")).toBeUndefined();
    expect(toolInputStreamField("Glob")).toBeUndefined();
    expect(toolInputStreamField("WebFetch")).toBeUndefined();
  });
});

describe("ToolInputStreamExtractor", () => {
  it("returns the full delta when called once with a complete buffer", () => {
    const extractor = new ToolInputStreamExtractor("content");
    const result = extractor.update('{"content":"hello world"}');
    expect(result).toBe("hello world");
    expect(extractor.done).toBe(true);
    expect(extractor.filePath).toBeUndefined();
  });

  it("accumulates incremental deltas across multiple update calls", () => {
    const extractor = new ToolInputStreamExtractor("content");
    let collected = "";
    const buffers = [
      '{"con',
      '{"content',
      '{"content":"hel',
      '{"content":"hello',
      '{"content":"hello wor',
      '{"content":"hello world',
      '{"content":"hello world"',
      '{"content":"hello world"}',
    ];
    for (const buf of buffers) {
      const delta = extractor.update(buf);
      if (delta !== null) {
        collected += delta;
      }
    }
    expect(collected).toBe("hello world");
    expect(extractor.done).toBe(true);
  });

  it("decodes single-character escapes", () => {
    const extractor = new ToolInputStreamExtractor("content");
    const result = extractor.update('{"content":"line1\\nline2\\ttab\\\\back\\"quote"}');
    expect(result).toBe('line1\nline2\ttab\\back"quote');
    expect(extractor.done).toBe(true);
  });

  it("decodes \\uXXXX escapes", () => {
    const extractor = new ToolInputStreamExtractor("content");
    const result = extractor.update('{"content":"caf\\u00e9"}');
    expect(result).toBe("café");
    expect(extractor.done).toBe(true);
  });

  it("pauses on chunk boundary inside a \\uXXXX escape", () => {
    const extractor = new ToolInputStreamExtractor("content");

    const first = extractor.update('{"content":"\\u00');
    // We may get nothing yet, or only literal characters before the escape.
    expect(first === null || first === "").toBe(true);
    expect(extractor.done).toBe(false);

    const second = extractor.update('{"content":"\\u00e9"}');
    // The second call must complete the escape and emit the decoded char
    // (plus consume the closing quote).
    expect(second).toBe("é");
    expect(extractor.done).toBe(true);
  });

  it("does not consume a trailing backslash at the buffer boundary", () => {
    const extractor = new ToolInputStreamExtractor("content");

    const first = extractor.update('{"content":"hello\\');
    expect(first).toBe("hello");
    expect(extractor.done).toBe(false);

    const second = extractor.update('{"content":"hello\\nworld"}');
    expect(second).toBe("\nworld");
    expect(extractor.done).toBe(true);
  });

  it("emits malformed \\uXXXX escapes verbatim", () => {
    const extractor = new ToolInputStreamExtractor("content");
    const result = extractor.update('{"content":"\\uZZZZ"}');
    expect(result).toBe("\\uZZZZ");
    expect(extractor.done).toBe(true);
  });

  it("captures filePath when 'path' precedes the target field", () => {
    const extractor = new ToolInputStreamExtractor("content");
    const result = extractor.update('{"path":"file.ts","content":"x"}');
    expect(result).toBe("x");
    expect(extractor.filePath).toBe("file.ts");
    expect(extractor.done).toBe(true);
  });

  it("waits for path value to be complete before populating filePath", () => {
    const extractor = new ToolInputStreamExtractor("content");

    // Path is incomplete (no closing quote) and target field is not present.
    const first = extractor.update('{"path":"file.ts');
    expect(first).toBeNull();
    expect(extractor.filePath).toBeUndefined();
    expect(extractor.done).toBe(false);

    const second = extractor.update('{"path":"file.ts","content":"x"}');
    expect(second).toBe("x");
    expect(extractor.filePath).toBe("file.ts");
    expect(extractor.done).toBe(true);
  });

  it("flips done after consuming the closing quote", () => {
    const extractor = new ToolInputStreamExtractor("command");
    expect(extractor.done).toBe(false);
    const result = extractor.update('{"command":"ls -la"}');
    expect(result).toBe("ls -la");
    expect(extractor.done).toBe(true);
    // Subsequent updates should be no-ops.
    expect(extractor.update('{"command":"ls -la"}')).toBeNull();
  });

  it("returns null and does not crash when target field is absent", () => {
    const extractor = new ToolInputStreamExtractor("content");
    expect(extractor.update('{"other":"value"}')).toBeNull();
    expect(extractor.done).toBe(false);
    expect(extractor.filePath).toBeUndefined();
  });

  it("leaves filePath undefined when no 'path' key is present", () => {
    const extractor = new ToolInputStreamExtractor("content");
    const result = extractor.update('{"content":"x"}');
    expect(result).toBe("x");
    expect(extractor.filePath).toBeUndefined();
    expect(extractor.done).toBe(true);
  });

  it("decodes escapes inside the path value", () => {
    const extractor = new ToolInputStreamExtractor("content");
    const result = extractor.update('{"path":"a\\nb","content":"y"}');
    expect(result).toBe("y");
    expect(extractor.filePath).toBe("a\nb");
    expect(extractor.done).toBe(true);
  });

  it("handles streaming append after the value start has been located", () => {
    const extractor = new ToolInputStreamExtractor("new_string");

    const a = extractor.update('{"old_string":"foo","new_string":"bar');
    expect(a).toBe("bar");

    const b = extractor.update('{"old_string":"foo","new_string":"bar baz');
    expect(b).toBe(" baz");

    const c = extractor.update('{"old_string":"foo","new_string":"bar baz"}');
    expect(c).toBeNull();
    expect(extractor.done).toBe(true);
  });

  it("handles a path value that contains an escaped quote", () => {
    const extractor = new ToolInputStreamExtractor("content");
    const result = extractor.update('{"path":"a\\"b","content":"x"}');
    expect(result).toBe("x");
    expect(extractor.filePath).toBe('a"b');
    expect(extractor.done).toBe(true);
  });
});
