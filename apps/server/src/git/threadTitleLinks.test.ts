import { it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect } from "vitest";
import { GitHubCliError } from "@piedpiper/contracts";

import type { GitHubCliShape } from "./Services/GitHubCli.ts";
import {
  extractThreadTitleLinks,
  resolveThreadTitleLinkedContext,
  threadTitleLinkSourceFromMessages,
} from "./threadTitleLinks.ts";

const succeedWith = (stdout: string) =>
  Effect.succeed({ stdout, stderr: "", code: 0, signal: null, timedOut: false });

const reviewCommentBlock = (url: string, filePath = "src/a.ts") =>
  [
    `<review_comment sectionId="uncommitted" sectionTitle="Uncommitted" filePath="${filePath}" startIndex="0" endIndex="0" rangeLabel="line 1">`,
    "Should this change?",
    "```diff",
    `+// see ${url}`,
    "```",
    "</review_comment>",
  ].join("\n");
const TERMINAL_BLOCK =
  "<terminal_context>\n  1 | see https://github.com/acme/app/pull/9\n</terminal_context>";

describe("extractThreadTitleLinks", () => {
  it("accepts pull and issue URL forms and strips surrounding punctuation", () => {
    expect(
      extractThreadTitleLinks("Take over https://github.com/acme/app/pull/12. Thanks").map(
        (link) => link.url,
      ),
    ).toEqual(["https://github.com/acme/app/pull/12"]);
    for (const message of [
      "**https://github.com/acme/app/pull/12**:",
      "[pr](https://github.com/acme/app/pull/12)",
      "<https://github.com/acme/app/pull/12>",
      "`https://github.com/acme/app/pull/12`",
      "https://github.com/acme/app/pull/12/files?w=1#diff",
      "https://www.github.com/acme/app/pull/12,",
    ]) {
      expect(extractThreadTitleLinks(message).map((link) => link.url)).toEqual([
        "https://github.com/acme/app/pull/12",
      ]);
    }
    expect(extractThreadTitleLinks("https://github.com/acme/app/issues/3")).toEqual([
      {
        url: "https://github.com/acme/app/issues/3",
        owner: "acme",
        repository: "app",
        number: "3",
      },
    ]);
  });

  it.each([
    ["a comma", "https://github.com/acme/app/pull/1,https://github.com/acme/app/pull/2"],
    ["a pipe", "https://github.com/acme/app/pull/1|https://github.com/acme/app/pull/2"],
    ["a semicolon", "https://github.com/acme/app/pull/1;https://github.com/acme/app/pull/2"],
  ])("separates links joined by %s", (_label, message) => {
    expect(extractThreadTitleLinks(message).map((link) => link.number)).toEqual(["1", "2"]);
  });

  it("reads the digits of a number segment with text stuck to it", () => {
    expect(
      extractThreadTitleLinks("https://github.com/acme/app/pull/1|label").map((link) => link.url),
    ).toEqual(["https://github.com/acme/app/pull/1"]);
    expect(
      extractThreadTitleLinks("https://github.com/acme/app/pull/1.next").map((link) => link.url),
    ).toEqual(["https://github.com/acme/app/pull/1"]);
    expect(extractThreadTitleLinks("https://github.com/acme/app/pull/1abc")).toEqual([]);
  });

  it("ignores links that appear only in attached terminal output", () => {
    expect(
      extractThreadTitleLinks(
        [
          "why is this failing?",
          "",
          "<terminal_context>",
          "- Terminal 1 lines 1-1:",
          "  1 | see https://github.com/acme/app/pull/9",
          "</terminal_context>",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("keeps a link the user wrote before attached terminal output", () => {
    expect(
      extractThreadTitleLinks(
        [
          "Fix https://github.com/acme/app/pull/1",
          "",
          "<terminal_context>",
          "  1 | see https://github.com/acme/app/pull/9",
          "</terminal_context>",
        ].join("\n"),
      ).map((link) => link.number),
    ).toEqual(["1"]);
  });

  it("ignores links that appear only inside diff comment blocks", () => {
    const blocks = [
      reviewCommentBlock("https://github.com/acme/app/pull/7"),
      reviewCommentBlock("https://github.com/acme/app/pull/8", "src/b.ts"),
    ].join("\n\n");

    expect(extractThreadTitleLinks(blocks)).toEqual([]);
    expect(extractThreadTitleLinks(`Tidy this up\n\n${blocks}`)).toEqual([]);
  });

  it("keeps a link the user wrote ahead of diff comment blocks", () => {
    expect(
      extractThreadTitleLinks(
        `Fix https://github.com/acme/app/pull/1\n\n${reviewCommentBlock("https://github.com/acme/app/pull/7")}`,
      ).map((link) => link.number),
    ).toEqual(["1"]);
  });

  it("removes diff comment blocks that sit ahead of attached terminal output", () => {
    expect(
      extractThreadTitleLinks(
        [
          "Fix https://github.com/acme/app/pull/1",
          reviewCommentBlock("https://github.com/acme/app/pull/7"),
          TERMINAL_BLOCK,
        ].join("\n\n"),
      ).map((link) => link.number),
    ).toEqual(["1"]);
    expect(
      extractThreadTitleLinks(
        [reviewCommentBlock("https://github.com/acme/app/pull/7"), TERMINAL_BLOCK].join("\n\n"),
      ),
    ).toEqual([]);
  });

  it("leaves a prompt that only mentions the tag mid-line alone", () => {
    expect(
      extractThreadTitleLinks(
        "What does <review_comment> do in https://github.com/acme/app/pull/1?",
      ).map((link) => link.number),
    ).toEqual(["1"]);
  });

  it("ignores everything that is not a github.com pull request or issue", () => {
    expect(
      extractThreadTitleLinks(
        [
          "https://github.com/acme/app",
          "https://github.com/acme/app/pulls",
          "https://github.com/acme/app/pull/abc",
          "https://github.com/acme/app/commit/123",
          "https://gitlab.com/acme/app/pull/1",
          "https://github.com.evil.test/acme/app/pull/1",
          "github.com/acme/app/pull/1",
        ].join(" "),
      ),
    ).toEqual([]);
  });

  it("dedupes the same thread and keeps at most two links", () => {
    expect(
      extractThreadTitleLinks(
        [
          "https://github.com/acme/app/pull/1",
          "https://github.com/acme/app/pull/1#discussion",
          "https://github.com/ACME/App/issues/1",
          "https://github.com/acme/app/pull/2",
          "https://github.com/acme/app/pull/3",
        ].join(" "),
      ).map((link) => link.number),
    ).toEqual(["1", "2"]);
  });
});

describe("threadTitleLinkSourceFromMessages", () => {
  it("reads user messages only", () => {
    const source = threadTitleLinkSourceFromMessages([
      { role: "user", text: "Look at https://github.com/acme/app/pull/1" },
      { role: "assistant", text: "Related: https://github.com/acme/app/pull/2" },
      { role: "user", text: "And https://github.com/acme/app/issues/3" },
    ]);
    expect(extractThreadTitleLinks(source).map((link) => link.number)).toEqual(["1", "3"]);
  });
});

describe("threadTitleLinkSourceFromMessages terminal output", () => {
  it("drops terminal output from every user message, not only the last", () => {
    const source = threadTitleLinkSourceFromMessages([
      {
        role: "user",
        text: "Why?\n\n<terminal_context>\n  1 | https://github.com/acme/app/pull/9\n</terminal_context>",
      },
      { role: "user", text: "See https://github.com/acme/app/pull/1" },
    ]);
    expect(extractThreadTitleLinks(source).map((link) => link.number)).toEqual(["1"]);
  });
});

describe("threadTitleLinkSourceFromMessages diff comments", () => {
  it("drops diff comment blocks from every user message", () => {
    const source = threadTitleLinkSourceFromMessages([
      {
        role: "user",
        text: `Why?\n\n${reviewCommentBlock("https://github.com/acme/app/pull/7")}`,
      },
      { role: "user", text: "See https://github.com/acme/app/pull/1" },
    ]);
    expect(extractThreadTitleLinks(source).map((link) => link.number)).toEqual(["1"]);
  });
});

describe("resolveThreadTitleLinkedContext", () => {
  it.effect("looks nothing up for a link found only in a diff comment", () =>
    Effect.gen(function* () {
      const calls: unknown[] = [];
      const result = yield* resolveThreadTitleLinkedContext({
        cwd: "/repo",
        message: `Why?\n\n${reviewCommentBlock("https://github.com/acme/app/pull/7")}`,
        gitHubCli: {
          execute: (input) => {
            calls.push(input);
            return succeedWith("{}");
          },
        },
      });
      expect(result).toBeUndefined();
      expect(calls).toEqual([]);
    }),
  );

  it.effect("looks nothing up for a link found only in terminal output", () =>
    Effect.gen(function* () {
      const calls: unknown[] = [];
      const result = yield* resolveThreadTitleLinkedContext({
        cwd: "/repo",
        message:
          "Why?\n\n<terminal_context>\n  1 | https://github.com/acme/app/pull/9\n</terminal_context>",
        gitHubCli: {
          execute: (input) => {
            calls.push(input);
            return succeedWith("{}");
          },
        },
      });
      expect(result).toBeUndefined();
      expect(calls).toEqual([]);
    }),
  );

  it.effect("skips gh entirely when the message links to nothing", () =>
    Effect.gen(function* () {
      const calls: unknown[] = [];
      const result = yield* resolveThreadTitleLinkedContext({
        cwd: "/repo",
        message: "Fix pairing",
        gitHubCli: {
          execute: (input) => {
            calls.push(input);
            return succeedWith("{}");
          },
        },
      });
      expect(result).toBeUndefined();
      expect(calls).toEqual([]);
    }),
  );

  it.effect("asks gh on github.com and caps titles and bodies", () =>
    Effect.gen(function* () {
      const calls: Array<Parameters<GitHubCliShape["execute"]>[0]> = [];
      const result = yield* resolveThreadTitleLinkedContext({
        cwd: "/repo",
        message: "See https://github.com/acme/app/pull/8",
        gitHubCli: {
          execute: (input) => {
            calls.push(input);
            return succeedWith(
              `${JSON.stringify({ title: "t".repeat(400), body: "b\n".repeat(1_000) })}\n`,
            );
          },
        },
      });
      expect(calls).toEqual([
        {
          cwd: "/repo",
          args: [
            "api",
            "--hostname",
            "github.com",
            "repos/acme/app/issues/8",
            "--jq",
            "{title, body}",
          ],
          timeoutMs: 3_000,
        },
      ]);
      const [url, summary, ...rest] = (result ?? "").split("\n");
      expect(url).toBe("https://github.com/acme/app/pull/8");
      expect(rest).toEqual([]);
      const parsed = JSON.parse(summary ?? "{}") as { title: string; body: string };
      expect(parsed.title).toBe("t".repeat(300));
      expect(parsed.body).toBe("b\n".repeat(600));
    }),
  );

  it.effect("accepts a null body", () =>
    Effect.gen(function* () {
      const result = yield* resolveThreadTitleLinkedContext({
        cwd: "/repo",
        message: "https://github.com/acme/app/issues/8",
        gitHubCli: { execute: () => succeedWith('{"title":"Crash on start","body":null}') },
      });
      expect(result).toBe(
        'https://github.com/acme/app/issues/8\n{"title":"Crash on start","body":""}',
      );
    }),
  );

  it.effect("reports gh failures and invalid output as unavailable, per link", () =>
    Effect.gen(function* () {
      const result = yield* resolveThreadTitleLinkedContext({
        cwd: "/repo",
        message: "https://github.com/acme/app/pull/1 https://github.com/acme/app/pull/2",
        gitHubCli: {
          execute: (input) =>
            input.args.some((arg) => arg.endsWith("/1"))
              ? Effect.fail(new GitHubCliError({ operation: "execute", detail: "not found" }))
              : succeedWith("not json"),
        },
      });
      expect(result).toBe(
        "https://github.com/acme/app/pull/1: unavailable\n\nhttps://github.com/acme/app/pull/2: unavailable",
      );
    }),
  );

  it.effect("gives up on a slow lookup after three seconds", () =>
    Effect.gen(function* () {
      const fiber = yield* resolveThreadTitleLinkedContext({
        cwd: "/repo",
        message: "https://github.com/acme/app/pull/1",
        gitHubCli: { execute: () => Effect.never },
      }).pipe(Effect.forkChild);
      yield* TestClock.adjust("3 seconds");
      expect(yield* Fiber.join(fiber)).toBe("https://github.com/acme/app/pull/1: unavailable");
    }),
  );
});
