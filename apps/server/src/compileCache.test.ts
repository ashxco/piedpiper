import { describe, expect, it } from "vitest";

import { flushCompileCache } from "./compileCache";

describe("flushCompileCache", () => {
  it("does not throw when the compile cache is not enabled", () => {
    expect(() => flushCompileCache()).not.toThrow();
  });
});
