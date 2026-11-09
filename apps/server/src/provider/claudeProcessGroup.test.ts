// @effect-diagnostics nodeBuiltinImport:off -- the fake CLI and its leftover child are real processes.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  claudeExitMessageWithStderr,
  claudeProcessGroupSpawnerFor,
  makeClaudeProcessGroupSpawner,
  redactClaudeStderr,
  signalClaudeProcessGroup,
} from "./claudeProcessGroup.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** Writes an executable stand-in for the Claude CLI next to a FIFO the leftover child holds open. */
function fakeClaudeCli(script: string): { readonly cli: string; readonly dir: string } {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pp-claude-cli-"));
  const cli = NodePath.join(dir, "claude");
  NodeFS.writeFileSync(cli, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  NodeChildProcess.execFileSync("mkfifo", [NodePath.join(dir, "alive")]);
  cleanups.push(() => NodeFS.rmSync(dir, { recursive: true, force: true }));
  return { cli, dir };
}

/** The FIFO's reader sees end-of-file once every process holding it open has died. */
function watchAlive(dir: string): {
  readonly started: Promise<void>;
  readonly stopped: Promise<void>;
} {
  const alive = NodeFS.createReadStream(NodePath.join(dir, "alive"));
  const started = new Promise<void>((resolve) => alive.once("open", () => resolve()));
  const stopped = new Promise<void>((resolve) => alive.once("close", () => resolve()));
  alive.resume();
  return { started, stopped };
}

describe("redactClaudeStderr", () => {
  it("masks keys, bearer tokens and secret env assignments", () => {
    expect(
      redactClaudeStderr(
        [
          "using key sk-ant-api03-abcDEF_123",
          "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload",
          "retrying with bearer abcdefghijklmnop",
          'ANTHROPIC_AUTH_TOKEN="hunter2 quoted" GITHUB_TOKEN=ghp_xyz',
          "max_tokens: 5",
        ].join("\n"),
      ),
    ).toBe(
      [
        "using key sk-ant-[redacted]",
        "Authorization: Bearer [redacted]",
        "retrying with bearer [redacted]",
        "ANTHROPIC_AUTH_TOKEN=[redacted] GITHUB_TOKEN=[redacted]",
        "max_tokens: 5",
      ].join("\n"),
    );
  });

  it("masks lowercase and compound credential keys", () => {
    expect(
      redactClaudeStderr(
        'oauth refresh failed: client_secret=client-value refresh_token=refresh-value {"client_secret":"json-value"} clientSecret: camel-value X-Auth-Token: header-value max_tokens=4096',
      ),
    ).toBe(
      'oauth refresh failed: client_secret=[redacted] refresh_token=[redacted] {"client_secret":"[redacted]"} clientSecret: [redacted] X-Auth-Token: [redacted] max_tokens=4096',
    );
    expect(
      redactClaudeStderr(
        [
          "x-api-key: abc123",
          "password=hunter2",
          "credentials='a b'",
          '{"refresh_token":"code \\"value"}',
          '{"authorization":"Basic abc"}',
        ].join("\n"),
      ),
    ).toBe(
      [
        "x-api-key: [redacted]",
        "password=[redacted]",
        "credentials=[redacted]",
        '{"refresh_token":"[redacted]"}',
        '{"authorization":"[redacted]"}',
      ].join("\n"),
    );
  });

  it("masks JSON that was stringified into an error body", () => {
    expect(
      redactClaudeStderr(
        String.raw`body: "{\"refresh_token\":\"abc123\",\"client_secret\":\"s\\\"tail\",\"max_tokens\":5}"`,
      ),
    ).toBe(
      String.raw`body: "{\"refresh_token\":\"[redacted]\",\"client_secret\":\"[redacted]\",\"max_tokens\":5}"`,
    );
  });

  it("masks credential keys with a suffix in any case, leaving token counts alone", () => {
    expect(
      redactClaudeStderr(
        "secret_key=abc aws_secret_access_key=abc password_hash=abc api_key_id: abc token_count=5",
      ),
    ).toBe(
      "secret_key=[redacted] aws_secret_access_key=[redacted] password_hash=[redacted] api_key_id: [redacted] token_count=5",
    );
  });

  it("does not stop a quoted assignment at an escaped quote", () => {
    expect(redactClaudeStderr(String.raw`token="ab\"cd-tail" next=1`)).toBe(
      "token=[redacted] next=1",
    );
    expect(redactClaudeStderr(String.raw`API_KEY_X='ab\'cd-tail' next=1`)).toBe(
      "API_KEY_X=[redacted] next=1",
    );
  });

  it("masks compound authorization keys and keeps the scheme", () => {
    expect(
      redactClaudeStderr(
        [
          '{"proxy-authorization":"Basic abc"}',
          '{"Proxy-Authorization":"abc"}',
          '{"x_authorization":"abc"}',
          "proxy_authorization=abc",
          "x_authorization: abc",
          "Proxy-Authorization: Basic abc",
          'authorization: "Bearer abc def"',
        ].join("\n"),
      ),
    ).toBe(
      [
        '{"proxy-authorization":"[redacted]"}',
        '{"Proxy-Authorization":"[redacted]"}',
        '{"x_authorization":"[redacted]"}',
        "proxy_authorization=[redacted]",
        "x_authorization: [redacted]",
        "Proxy-Authorization: Basic [redacted]",
        "authorization: [redacted]",
      ].join("\n"),
    );
  });

  it("masks values cut off by the CLI's death and bare numbers, within their line", () => {
    expect(
      redactClaudeStderr(
        ['{"password":"unterminated', '{"token": 123456}', 'token="half', "next line"].join("\n"),
      ),
    ).toBe(
      ['{"password":"[redacted]"', '{"token": [redacted]}', "token=[redacted]", "next line"].join(
        "\n",
      ),
    );
  });

  it("keeps suffixed uppercase keys masked and token counts readable", () => {
    expect(
      redactClaudeStderr(
        "GITHUB_TOKEN_V2=abc MAX_TOKENS=5 max_tokens=4096 output_tokens: 7 tokens: 9 tokenizer=x",
      ),
    ).toBe(
      "GITHUB_TOKEN_V2=[redacted] MAX_TOKENS=[redacted] max_tokens=4096 output_tokens: 7 tokens: 9 tokenizer=x",
    );
  });
});

describe("claudeExitMessageWithStderr", () => {
  it("appends the tail only to a bare exited-with-code message", () => {
    expect(claudeExitMessageWithStderr("Claude Code process exited with code 1", "boom")).toBe(
      "Claude Code process exited with code 1. stderr: boom",
    );
    expect(
      claudeExitMessageWithStderr("Claude Code process exited with code 1. stderr: own", "boom"),
    ).toBe("Claude Code process exited with code 1. stderr: own");
    expect(claudeExitMessageWithStderr("Claude runtime stream failed.", "boom")).toBe(
      "Claude runtime stream failed.",
    );
    expect(claudeExitMessageWithStderr("Claude Code process exited with code 1", "  ")).toBe(
      "Claude Code process exited with code 1",
    );
    expect(
      claudeExitMessageWithStderr("exited with code 2", `${"x".repeat(600)}end`).endsWith(
        `stderr: ${"x".repeat(497)}end`,
      ),
    ).toBe(true);
  });
});

describe("claudeProcessGroupSpawnerFor", () => {
  it("leaves spawning to the SDK on Windows", () => {
    expect(claudeProcessGroupSpawnerFor("win32")).toBeUndefined();
    expect(typeof claudeProcessGroupSpawnerFor("darwin")).toBe("function");
  });
});

describe.skipIf(process.platform === "win32")("makeClaudeProcessGroupSpawner", () => {
  it("stops what the CLI left running once the CLI exits", async () => {
    const { cli, dir } = fakeClaudeCli(
      ['dir=$(dirname "$0")', 'sleep 600 > "$dir/alive" &', "cat > /dev/null"].join("\n"),
    );
    const alive = watchAlive(dir);
    const child = makeClaudeProcessGroupSpawner()({
      command: cli,
      args: [],
      cwd: dir,
      env: process.env,
      signal: new AbortController().signal,
    }) as unknown as NodeChildProcess.ChildProcess;
    cleanups.push(() => signalClaudeProcessGroup(child.pid, "SIGKILL"));
    await alive.started;

    child.stdin?.end();
    await alive.stopped;
  });

  it("stops the CLI when the server that started it goes away", async () => {
    const { cli, dir } = fakeClaudeCli(
      ['dir=$(dirname "$0")', 'sleep 600 > "$dir/alive"'].join("\n"),
    );
    const alive = watchAlive(dir);
    const child = makeClaudeProcessGroupSpawner()({
      command: cli,
      args: [],
      cwd: dir,
      env: process.env,
      signal: new AbortController().signal,
    }) as unknown as NodeChildProcess.ChildProcess;
    cleanups.push(() => signalClaudeProcessGroup(child.pid, "SIGKILL"));
    await alive.started;

    // A dying server's descriptors close; the kernel would do this for it.
    for (const pipe of child.stdio) pipe?.destroy();
    await alive.stopped;
  });

  it("reports the stderr tail of an abnormal exit", async () => {
    const { cli, dir } = fakeClaudeCli('echo "boom sk-ant-leaked" >&2\nexit 3');
    const exit = new Promise<{ code: number | null; stderrTail: string }>((resolve) => {
      makeClaudeProcessGroupSpawner({ onAbnormalExit: resolve })({
        command: cli,
        args: [],
        cwd: dir,
        env: process.env,
        signal: new AbortController().signal,
      });
    });
    const result = await exit;
    expect(result.code).toBe(3);
    expect(result.stderrTail).toBe("boom sk-ant-[redacted]");
  });
});
