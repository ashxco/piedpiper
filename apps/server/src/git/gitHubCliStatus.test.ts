import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import type { ProcessRunResult } from "../processRunner";
import { parseGitHubCliAuthStatus, resolveGitHubCliStatus } from "./gitHubCliStatus";

const account = (state: string, active: boolean) => ({ state, active, host: "h", login: "l" });
const hosts = (...accounts: ReadonlyArray<ReturnType<typeof account>>) =>
  JSON.stringify({ hosts: { "github.com": accounts } });

function result(overrides: Partial<ProcessRunResult>): ProcessRunResult {
  return {
    stdout: "",
    stderr: "",
    code: 0,
    signal: null,
    timedOut: false,
    ...overrides,
  };
}

function resolveWith(...responses: ReadonlyArray<ProcessRunResult | Error>) {
  const run = vi.fn((_args: ReadonlyArray<string>) => {
    const next = responses[run.mock.calls.length - 1];
    if (!next) throw new Error("unexpected extra gh call");
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  });
  return Effect.runPromise(resolveGitHubCliStatus("/repo", run)).then((status) => ({
    status,
    calls: run.mock.calls.map(([args]) => args.join(" ")),
  }));
}

describe("parseGitHubCliAuthStatus", () => {
  it("is signed in when the active account succeeds, whatever the others report", () => {
    expect(parseGitHubCliAuthStatus(hosts(account("success", true)))).toBe("signed-in");
    expect(parseGitHubCliAuthStatus(hosts(account("error", false), account("success", true)))).toBe(
      "signed-in",
    );
  });

  it("is signed out with no hosts or a failed active account", () => {
    expect(parseGitHubCliAuthStatus(JSON.stringify({ hosts: {} }))).toBe("signed-out");
    expect(parseGitHubCliAuthStatus(hosts(account("error", true), account("success", false)))).toBe(
      "signed-out",
    );
  });

  it("cannot tell when the active account's token check timed out", () => {
    expect(parseGitHubCliAuthStatus(hosts(account("timeout", true)))).toBe("unknown");
  });

  it("returns null for anything that is not the status JSON", () => {
    for (const text of ["", "github.com\n  Logged in", "{}", '{"hosts":[]}']) {
      expect(parseGitHubCliAuthStatus(text)).toBeNull();
    }
  });
});

describe("resolveGitHubCliStatus", () => {
  it("reports a signed-in account without a second call", async () => {
    const { status, calls } = await resolveWith(
      result({ stdout: hosts(account("success", true)) }),
    );
    expect(status).toEqual({ installed: true, authenticated: true });
    expect(calls).toEqual(["auth status --json hosts"]);
  });

  it("reports installed but signed out, including when the JSON comes with a non-zero exit", async () => {
    await expect(resolveWith(result({ stdout: '{"hosts":{}}' }))).resolves.toMatchObject({
      status: { installed: true, authenticated: false },
    });
    await expect(
      resolveWith(result({ stdout: hosts(account("error", true)), code: 1 })),
    ).resolves.toMatchObject({ status: { installed: true, authenticated: false } });
  });

  it.each([
    [0, true],
    [1, false],
  ])("falls back to plain status on a gh without --json (exit %i)", async (code, authenticated) => {
    const { status, calls } = await resolveWith(
      result({ stderr: "unknown flag: --json", code: 1 }),
      result({ code }),
    );
    expect(status).toEqual({ installed: true, authenticated });
    expect(calls).toEqual(["auth status --json hosts", "auth status"]);
  });

  it("reports gh as missing when it cannot be spawned", async () => {
    const { status } = await resolveWith(new Error("Command not found: gh"));
    expect(status).toEqual({ installed: false, authenticated: false });
  });

  it("shows no hint when either call times out or the token check could not finish", async () => {
    const noHint = { installed: false, authenticated: false };
    await expect(resolveWith(result({ timedOut: true, code: null }))).resolves.toMatchObject({
      status: noHint,
    });
    await expect(
      resolveWith(result({ code: 1 }), result({ timedOut: true, code: null })),
    ).resolves.toMatchObject({ status: noHint });
    await expect(
      resolveWith(result({ stdout: hosts(account("timeout", true)) })),
    ).resolves.toMatchObject({ status: noHint });
  });
});
