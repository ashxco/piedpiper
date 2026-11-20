import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { makeMiseMaintenanceResolver } from "./miseMaintenance.ts";

function fixture(
  options: {
    requested?: string;
    command?: string;
    active?: boolean;
    wrapper?: string;
    listedTool?: string;
    installed?: boolean;
    /** The name the mise config requests the tool by, such as `npm:<pkg>`. */
    configuredAs?: string;
  } = {},
) {
  const root = "/custom-mise/installs/claude/1.0.0";
  const calls: string[] = [];
  const resolve = makeMiseMaintenanceResolver({
    findMise: () => "/bin/mise",
    readWrapper: async () => options.wrapper ?? "",
    realPath: async (path) => path.replace("/latest/", "/1.0.0/"),
    probe: async (_path, args) => {
      calls.push(args.join(" "));
      if (args[0] === "which") return `${root}/bin/claude`;
      if (args[0] === "ls")
        return JSON.stringify({
          [args.length === 3
            ? (options.configuredAs ?? "claude")
            : (options.listedTool ?? "claude")]:
            options.installed === false
              ? []
              : [
                  {
                    install_path: root,
                    requested_version: options.requested ?? "latest",
                    active: options.active ?? true,
                  },
                ],
        });
      return "2.0.0";
    },
  });
  const commandPath = options.command ?? "/custom-mise/installs/claude/latest/bin/claude";
  return {
    calls,
    run: () =>
      Effect.runPromise(
        resolve({
          commandPath,
          realCommandPath: commandPath.includes("shims") ? "/bin/mise" : `${root}/bin/claude`,
          tool: "claude",
        }),
      ),
  };
}

describe("mise provider maintenance", () => {
  it("verifies custom-directory latest installs and caches mise's available version", async () => {
    const f = fixture();
    expect(await f.run()).toEqual({
      misePath: "/bin/mise",
      tool: "claude",
      canUpgrade: true,
      latestVersion: "2.0.0",
    });
    await f.run();
    expect(f.calls.filter((call) => call === "latest claude")).toHaveLength(1);
  });
  it("upgrades a tool configured by its backend name by that name", async () => {
    const f = fixture({ configuredAs: "npm:@anthropic-ai/claude-code" });
    expect(await f.run()).toMatchObject({
      tool: "npm:@anthropic-ai/claude-code",
      canUpgrade: true,
    });
    expect(f.calls).toContain("ls --json --installed claude");
    expect(f.calls).toContain("ls --json --installed");
  });
  it("supports named shims but preserves pins, version paths, inactive installs and wrappers", async () => {
    expect((await fixture({ command: "/custom-mise/shims/claude" }).run())?.canUpgrade).toBe(true);
    for (const options of [
      { requested: "1.0.0" },
      { command: "/custom-mise/installs/claude/1.0.0/bin/claude" },
      { active: false },
      { wrapper: "#!/bin/sh\nexec mise x claude@latest -- claude" },
    ]) {
      const f = fixture(options);
      expect((await f.run())?.canUpgrade).toBe(false);
      expect(f.calls).not.toContain("latest claude");
    }
  });
  it("never attributes another tool's listing or npm globals under mise's Node to this provider", async () => {
    expect(await fixture({ listedTool: "node" }).run()).toBeNull();
    const resolve = makeMiseMaintenanceResolver({
      findMise: () => "/bin/mise",
      readWrapper: async () => "",
      realPath: async (p) => p,
      probe: async (_p, args) =>
        args[0] === "which" ? "/mise/installs/node/22/lib/node_modules/codex/bin.js" : "{}",
    });
    expect(
      await Effect.runPromise(
        resolve({
          tool: "codex",
          commandPath: "/mise/installs/node/22/bin/codex",
          realCommandPath: "/mise/installs/node/22/lib/node_modules/codex/bin.js",
        }),
      ),
    ).toBeNull();
  });
});
