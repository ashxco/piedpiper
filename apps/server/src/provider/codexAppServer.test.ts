import { EventEmitter } from "node:events";
import readline from "node:readline";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CodexAppServerEarlyExitError,
  probeCodexAccount,
  readConfiguredServiceTier,
} from "./codexAppServer";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: spawnMock };
});

type FakeChild = EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  killed: boolean;
  pid: number;
  kill: () => boolean;
};

/** A fake app-server that answers initialize and account/read, then pages of model/list until `stallAfterPages`. */
function spawnProbeChild(options: {
  readonly stallAfterPages: number;
  readonly serviceTier?: string;
  /** Delays the config/read answer; `null` never answers. */
  readonly configReadDelayMs?: number | null;
  readonly lastPage?: boolean;
  readonly accountType?: string;
  /** The account/rateLimits/read answer; `null` never answers, `"error"` rejects the request. */
  readonly rateLimits?: unknown;
}) {
  const child = new EventEmitter() as FakeChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.pid = 4242;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  let pages = 0;
  readline.createInterface({ input: child.stdin }).on("line", (line) => {
    const message = JSON.parse(line) as { id?: number; method?: string };
    if (message.id === undefined) return;
    const reply = (result: unknown) =>
      child.stdout.write(`${JSON.stringify({ id: message.id, result })}\n`);
    if (message.method === "initialize") return reply({});
    if (message.method === "config/read") {
      if (options.configReadDelayMs === null) return;
      if (options.configReadDelayMs !== undefined) {
        setTimeout(
          () => reply({ config: { service_tier: options.serviceTier } }),
          options.configReadDelayMs,
        );
        return;
      }
      if (options.serviceTier === undefined) {
        return child.stdout.write(
          `${JSON.stringify({ id: message.id, error: { message: "unknown method" } })}\n`,
        );
      }
      return reply({ config: { service_tier: options.serviceTier } });
    }
    if (message.method === "account/read") {
      return reply({ account: { type: options.accountType ?? "chatgpt", planType: "pro" } });
    }
    if (message.method === "account/rateLimits/read") {
      if (options.rateLimits === null) return;
      if (options.rateLimits === "error") {
        return child.stdout.write(
          `${JSON.stringify({ id: message.id, error: { message: "unknown variant" } })}\n`,
        );
      }
      return reply(options.rateLimits ?? { rateLimits: {} });
    }
    if (message.method === "model/list") {
      if (pages >= options.stallAfterPages) return;
      pages += 1;
      reply({
        data: [{ model: `gpt-page-${pages}`, displayName: `Page ${pages}` }],
        nextCursor: options.lastPage ? null : `cursor-${pages}`,
      });
    }
  });
  return child;
}

afterEach(() => {
  spawnMock.mockReset();
});

describe("probeCodexAccount", () => {
  it("keeps the account and collected models when model/list stalls", async () => {
    const child = spawnProbeChild({ stallAfterPages: 1 });
    spawnMock.mockReturnValueOnce(child);

    const snapshot = await probeCodexAccount({ binaryPath: "codex", modelListTimeoutMs: 20 });

    expect(snapshot.type).toBe("chatgpt");
    expect(snapshot.planType).toBe("pro");
    expect(snapshot.listedModels?.map((model) => model.slug)).toEqual(["gpt-page-1"]);
    expect(child.killed).toBe(true);
  });

  it("resolves with the account alone when model/list never answers", async () => {
    spawnMock.mockReturnValueOnce(spawnProbeChild({ stallAfterPages: 0 }));

    const snapshot = await probeCodexAccount({ binaryPath: "codex", modelListTimeoutMs: 20 });

    expect(snapshot).toMatchObject({ type: "chatgpt", planType: "pro" });
    expect(snapshot.listedModels).toBeUndefined();
  });

  it("ends the model/list wait inside the overall probe budget counted from spawn", async () => {
    spawnMock.mockReturnValueOnce(spawnProbeChild({ stallAfterPages: 0 }));
    const startedAt = Date.now();

    const snapshot = await probeCodexAccount({
      binaryPath: "codex",
      modelListTimeoutMs: 60_000,
      probeTimeoutMs: 300,
    });

    expect(snapshot).toMatchObject({ type: "chatgpt", planType: "pro" });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("appends launch arguments to the app-server spawn", async () => {
    spawnMock.mockReturnValueOnce(spawnProbeChild({ stallAfterPages: 0 }));

    await probeCodexAccount({
      binaryPath: "codex",
      launchArgs: `--enable foo --config model="gpt 5"`,
      modelListTimeoutMs: 20,
    });

    const args = spawnMock.mock.calls[0]?.[1] as ReadonlyArray<string>;
    expect(args.slice(-5)).toEqual(["app-server", "--enable", "foo", "--config", "model=gpt 5"]);
  });

  it("reports the stderr reason when app-server exits during the probe", async () => {
    const child = spawnProbeChild({ stallAfterPages: 0 });
    child.stdin = new PassThrough();
    spawnMock.mockReturnValueOnce(child);

    const probe = probeCodexAccount({ binaryPath: "codex", launchArgs: "--bogus" });
    child.stderr.end("error: unexpected argument '--bogus' found\n");
    child.emit("exit", 2, null);

    await expect(probe).rejects.toThrow(
      "codex app-server exited before probe completed (code=2, signal=null): error: unexpected argument '--bogus' found",
    );
    await expect(probe).rejects.toBeInstanceOf(CodexAppServerEarlyExitError);
  });

  it("reports the configured service tier from config/read", async () => {
    const child = spawnProbeChild({ stallAfterPages: 0, serviceTier: "fast" });
    spawnMock.mockReturnValueOnce(child);
    const written: Array<{ method?: string; params?: unknown }> = [];
    readline
      .createInterface({ input: child.stdin })
      .on("line", (line) => written.push(JSON.parse(line)));

    const snapshot = await probeCodexAccount({ binaryPath: "codex", modelListTimeoutMs: 20 });

    expect(snapshot.configuredServiceTier).toBe("fast");
    expect(written.find((message) => message.method === "config/read")?.params).toEqual({
      includeLayers: false,
    });
  });

  it("waits briefly for a config/read answer that arrives after the last model page", async () => {
    spawnMock.mockReturnValueOnce(
      spawnProbeChild({
        stallAfterPages: 1,
        lastPage: true,
        serviceTier: "fast",
        configReadDelayMs: 50,
      }),
    );

    const snapshot = await probeCodexAccount({ binaryPath: "codex", modelListTimeoutMs: 5_000 });

    expect(snapshot.listedModels?.map((model) => model.slug)).toEqual(["gpt-page-1"]);
    expect(snapshot.configuredServiceTier).toBe("fast");
  });

  it("resolves without the tier when config/read never answers", async () => {
    spawnMock.mockReturnValueOnce(
      spawnProbeChild({ stallAfterPages: 1, lastPage: true, configReadDelayMs: null }),
    );
    const startedAt = Date.now();

    const snapshot = await probeCodexAccount({
      binaryPath: "codex",
      modelListTimeoutMs: 5_000,
      configReadGraceMs: 30,
    });

    expect(snapshot.listedModels?.map((model) => model.slug)).toEqual(["gpt-page-1"]);
    expect(snapshot.configuredServiceTier).toBeUndefined();
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("ignores a config/read error from older CLIs", async () => {
    spawnMock.mockReturnValueOnce(spawnProbeChild({ stallAfterPages: 0 }));

    const snapshot = await probeCodexAccount({ binaryPath: "codex", modelListTimeoutMs: 20 });

    expect(snapshot).toMatchObject({ type: "chatgpt", planType: "pro" });
    expect(snapshot.configuredServiceTier).toBeUndefined();
  });
});

describe("probeCodexAccount transport loss", () => {
  it("fails soon after stdout closes while the process keeps running", async () => {
    const child = spawnProbeChild({ stallAfterPages: 0 });
    spawnMock.mockReturnValueOnce(child);

    const startedAt = Date.now();
    const probe = probeCodexAccount({ binaryPath: "codex", modelListTimeoutMs: 60_000 });
    child.stdout.end();
    child.stdout.resume();

    await expect(probe).rejects.toThrow(
      "codex app-server closed its output stream before probe completed.",
    );
    await expect(probe).rejects.toBeInstanceOf(CodexAppServerEarlyExitError);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(child.killed).toBe(true);
  });

  it("prefers the exit reason when the process exits right after closing stdout", async () => {
    const child = spawnProbeChild({ stallAfterPages: 0 });
    spawnMock.mockReturnValueOnce(child);

    const probe = probeCodexAccount({ binaryPath: "codex" });
    child.stdout.end();
    child.stderr.end("boom\n");
    setTimeout(() => child.emit("exit", 1, null), 50);

    await expect(probe).rejects.toThrow(
      "codex app-server exited before probe completed (code=1, signal=null): boom",
    );
  });

  it("fails on an oversized line without quoting it", async () => {
    const child = spawnProbeChild({ stallAfterPages: 0 });
    spawnMock.mockReturnValueOnce(child);

    const probe = probeCodexAccount({ binaryPath: "codex" });
    child.stdout.emit("data", Buffer.alloc(128 * 1024 * 1024 + 1, 0x78));

    const error = await probe.catch((cause: Error) => cause);
    expect((error as Error).message).toBe(
      "codex app-server sent a message over 128 MB during the account probe.",
    );
    expect(child.killed).toBe(true);
  });
});

describe("probeCodexAccount usage limits", () => {
  const rateLimits = { rateLimits: { primary: { usedPercent: 40 } } };

  it("includes the account/rateLimits/read answer", async () => {
    spawnMock.mockReturnValueOnce(
      spawnProbeChild({ stallAfterPages: 1, lastPage: true, serviceTier: "fast", rateLimits }),
    );

    const snapshot = await probeCodexAccount({ binaryPath: "codex" });

    expect(snapshot.rateLimits).toMatchObject({ response: rateLimits });
    expect(snapshot.listedModels?.map((model) => model.slug)).toEqual(["gpt-page-1"]);
  });

  it("keeps the account and models when the usage read never answers", async () => {
    spawnMock.mockReturnValueOnce(
      spawnProbeChild({
        stallAfterPages: 1,
        lastPage: true,
        serviceTier: "fast",
        rateLimits: null,
      }),
    );

    const snapshot = await probeCodexAccount({ binaryPath: "codex", rateLimitsTimeoutMs: 20 });

    expect(snapshot.rateLimits).toMatchObject({
      failure: "Codex did not answer the usage request.",
    });
    expect(snapshot.planType).toBe("pro");
    expect(snapshot.listedModels?.map((model) => model.slug)).toEqual(["gpt-page-1"]);
  });

  it("reports a rejected usage read without failing the probe", async () => {
    spawnMock.mockReturnValueOnce(
      spawnProbeChild({
        stallAfterPages: 1,
        lastPage: true,
        serviceTier: "fast",
        rateLimits: "error",
      }),
    );

    const snapshot = await probeCodexAccount({ binaryPath: "codex" });

    expect(snapshot.rateLimits).toMatchObject({ failure: "Codex could not read usage." });
    expect(snapshot.type).toBe("chatgpt");
  });

  it("waits for a usage answer that arrives after the last model page", async () => {
    const child = spawnProbeChild({
      stallAfterPages: 1,
      lastPage: true,
      serviceTier: "fast",
      rateLimits: null,
    });
    spawnMock.mockReturnValueOnce(child);
    const answer = new Promise<void>((resolve) => {
      child.stdin.on("data", (chunk: Buffer) => {
        for (const line of chunk.toString().split("\n")) {
          if (!line.includes("account/rateLimits/read")) continue;
          const { id } = JSON.parse(line) as { id: number };
          setTimeout(() => {
            child.stdout.write(`${JSON.stringify({ id, result: rateLimits })}\n`);
            resolve();
          }, 30);
        }
      });
    });

    const snapshot = await probeCodexAccount({ binaryPath: "codex" });
    await answer;

    expect(snapshot.rateLimits).toMatchObject({ response: rateLimits });
  });

  it("does not ask an API key account for subscription usage", async () => {
    const child = spawnProbeChild({
      stallAfterPages: 1,
      lastPage: true,
      serviceTier: "fast",
      accountType: "apiKey",
      rateLimits,
    });
    spawnMock.mockReturnValueOnce(child);
    const written: string[] = [];
    child.stdin.on("data", (chunk: Buffer) => written.push(chunk.toString()));

    const snapshot = await probeCodexAccount({ binaryPath: "codex" });

    expect(snapshot.rateLimits).toBeUndefined();
    expect(written.join("")).not.toContain("account/rateLimits/read");
  });
});

describe("readConfiguredServiceTier", () => {
  it("reads a non-empty service_tier string", () => {
    expect(readConfiguredServiceTier({ config: { service_tier: " fast " } })).toBe("fast");
    expect(readConfiguredServiceTier({ config: { service_tier: null } })).toBeUndefined();
    expect(readConfiguredServiceTier({ config: {} })).toBeUndefined();
    expect(readConfiguredServiceTier(undefined)).toBeUndefined();
  });
});
