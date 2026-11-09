import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { ProviderListSlashCommandsResult, ServerProvider } from "./server";

const provider = {
  provider: "claudeAgent",
  enabled: true,
  installed: true,
  version: "2.1.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-01-01T00:00:00.000Z",
  models: [],
} as const;

describe("ServerProvider", () => {
  const roundTrip = (value: unknown) =>
    Schema.encodeSync(ServerProvider)(Schema.decodeUnknownSync(ServerProvider)(value));

  it("keeps models that need a newer CLI through encoding", () => {
    const updateRequiredModels = [
      { slug: "claude-opus-5-5", name: "Claude Opus 5.5", minVersion: "2.1.280" },
    ];
    expect(roundTrip({ ...provider, updateRequiredModels }).updateRequiredModels).toEqual(
      updateRequiredModels,
    );
  });

  it("keeps usage limits through encoding", () => {
    const usageLimits = {
      checkedAt: "2026-01-01T00:00:00.000Z",
      windows: [
        {
          id: "weekly",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 42,
          resetsAt: "2026-01-02T00:00:00.000Z",
          windowDurationMins: 10080,
        },
      ],
      unavailable: { reason: "probeFailed", message: "Timed out" },
    };
    expect(roundTrip({ ...provider, usageLimits }).usageLimits).toEqual(usageLimits);
  });

  it("keeps the version advisory through encoding", () => {
    const versionAdvisory = {
      status: "behind_latest",
      currentVersion: "2.1.0",
      latestVersion: "2.2.0",
      updateCommand: "claude update",
    };
    expect(roundTrip({ ...provider, versionAdvisory }).versionAdvisory).toEqual(versionAdvisory);
  });

  it("still decodes a provider from an older server without the optional fields", () => {
    const decoded = Schema.decodeUnknownSync(ServerProvider)(provider);
    expect(decoded.updateRequiredModels).toBeUndefined();
    expect(decoded.usageLimits).toBeUndefined();
    expect(decoded.versionAdvisory).toBeUndefined();
  });

  it("rejects an unknown usage window kind", () => {
    expect(() =>
      Schema.decodeUnknownSync(ServerProvider)({
        ...provider,
        usageLimits: {
          checkedAt: provider.checkedAt,
          windows: [{ id: "x", kind: "yearly", label: "Yearly", usedPercent: 1 }],
        },
      }),
    ).toThrow();
  });
});

describe("ProviderListSlashCommandsResult", () => {
  it("decodes commands with optional details", () => {
    const result = { commands: [{ name: "compact" }, { name: "review" }], pending: true };
    expect(Schema.decodeUnknownSync(ProviderListSlashCommandsResult)(result)).toEqual(result);
  });
});
