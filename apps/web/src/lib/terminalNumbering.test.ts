import { describe, expect, it } from "vitest";

import { nextTerminalId, terminalNumberById, terminalNumberLabelById } from "./terminalNumbering";

const OLD_A = "terminal-0a7f6d6c-6a41-4b4e-9c34-111111111111";
const OLD_B = "terminal-0a7f6d6c-6a41-4b4e-9c34-222222222222";

describe("nextTerminalId", () => {
  it("takes the lowest free number, counting default as 1", () => {
    expect(nextTerminalId([])).toBe("term-1");
    expect(nextTerminalId(["default"])).toBe("term-2");
    expect(nextTerminalId(["default", "term-2", "term-3"])).toBe("term-4");
    expect(nextTerminalId(["default", "term-3"])).toBe("term-2");
    expect(nextTerminalId(["term-2", "term-3"])).toBe("term-1");
  });

  it("does not reuse a number still closing on the server", () => {
    expect(nextTerminalId(["default"], ["term-2"])).toBe("term-3");
    expect(nextTerminalId(["term-2"], ["default"])).toBe("term-3");
    expect(nextTerminalId(["default"], [OLD_A])).toBe("term-2");
  });

  it("skips the numbers old ids are shown under", () => {
    expect(nextTerminalId(["default", OLD_A])).toBe("term-3");
    expect(nextTerminalId([OLD_A, "term-3"])).toBe("term-2");
  });
});

describe("terminalNumberById", () => {
  it("keeps numbers when an earlier terminal closes", () => {
    const before = terminalNumberById(["default", "term-2", "term-3"]);
    const after = terminalNumberById(["default", "term-3"]);
    expect(before.get("term-3")).toBe(3);
    expect(after.get("term-3")).toBe(3);
  });

  it("numbers old ids by position around stable numbers", () => {
    expect(Object.fromEntries(terminalNumberById(["default", OLD_A, "term-2", OLD_B]))).toEqual({
      default: 1,
      [OLD_A]: 3,
      "term-2": 2,
      [OLD_B]: 4,
    });
  });

  it("never shows a number twice when default and term-1 coexist", () => {
    const numbers = terminalNumberById(["default", "term-1"]);
    expect(numbers.get("default")).toBe(1);
    expect(numbers.get("term-1")).toBe(2);
  });

  it("treats term-0 and other lookalikes as old ids", () => {
    expect([...terminalNumberById(["term-0", "term-02", "term-x"]).values()]).toEqual([1, 2, 3]);
  });
});

describe("terminalNumberLabelById", () => {
  it("builds stable Terminal N labels", () => {
    expect(terminalNumberLabelById(["default", "term-3"]).get("term-3")).toBe("Terminal 3");
  });
});
