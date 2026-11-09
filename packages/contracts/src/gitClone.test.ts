import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { GitCloneRepositoryEvent, GitCloneRepositoryInput } from "./gitClone";

describe("GitCloneRepositoryInput", () => {
  it("trims its fields and refuses empty ones", () => {
    const decode = Schema.decodeUnknownSync(GitCloneRepositoryInput);
    expect(decode({ url: " https://x.dev/a/b ", destinationPath: " /code/b " })).toEqual({
      url: "https://x.dev/a/b",
      destinationPath: "/code/b",
    });
    expect(() => decode({ url: "  ", destinationPath: "/code/b" })).toThrow();
    expect(() => decode({ url: "https://x.dev/a/b", destinationPath: "" })).toThrow();
  });
});

describe("GitCloneRepositoryEvent", () => {
  it("decodes progress and finished events", () => {
    const decode = Schema.decodeUnknownSync(GitCloneRepositoryEvent);
    expect(
      decode({ kind: "progress", stage: "receiving", percent: 42, detail: "1 MiB" }),
    ).toMatchObject({ stage: "receiving", percent: 42 });
    expect(decode({ kind: "finished", destinationPath: "/code/b" })).toMatchObject({
      destinationPath: "/code/b",
    });
    expect(() => decode({ kind: "progress", stage: "other", percent: 1, detail: null })).toThrow();
  });
});
