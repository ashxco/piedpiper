import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ServerProvider as ServerProviderSchema,
  type ServerProvider,
  type ServerSettings,
} from "@piedpiper/contracts";
import { Deferred, Effect, Layer, PubSub, Ref, Schema, Stream } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { describe } from "vitest";

import { ServerSettingsService } from "../serverSettings";
import { isPendingProviderSnapshot, makeManagedServerProvider } from "./makeManagedServerProvider";
import {
  CLAUDE_CLI_MAINTENANCE,
  CODEX_CLI_MAINTENANCE,
  classifyProviderInstall,
  deriveProviderVersionAdvisory,
  fetchNpmLatestVersion,
  makeCachedLatestVersionLookup,
  makeProviderWithVersionAdvisory,
  parseNpmLatestVersion,
  quoteCommandExecutable,
  npmGlobalPrefixFromCommandPath,
  resolveCommandPathOnHost,
  type ProviderInstallKind,
} from "./providerMaintenance";
import type { ServerProviderShape } from "./Services/ServerProvider";

const baseSnapshot: ServerProvider = {
  provider: "claudeAgent",
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-01-01T00:00:00.000Z",
  models: [],
};

const NATIVE_REAL_PATH = "/Users/me/.local/share/claude/versions/1.0.0";
const NATIVE_COMMAND_PATH = "/Users/me/.local/bin/claude";

describe("deriveProviderVersionAdvisory", () => {
  const derive = (currentVersion: string, latestVersion: string | null) =>
    deriveProviderVersionAdvisory({ currentVersion, latestVersion, updateCommand: null }).status;

  it("reports a CLI behind the latest release", () => {
    assert.equal(derive("1.0.0", "1.0.1"), "behind_latest");
    assert.equal(derive("1.9.0", "1.10.0"), "behind_latest");
  });

  it("reports a CLI on or ahead of the latest release as current", () => {
    assert.equal(derive("1.0.1", "1.0.1"), "current");
    assert.equal(derive("2.0.0-beta.1", "1.9.0"), "current");
  });

  it("is unknown after a failed lookup or for a version it cannot compare", () => {
    assert.equal(derive("1.0.0", null), "unknown");
    assert.equal(derive("nightly", "1.0.0"), "unknown");
  });
});

describe("parseNpmLatestVersion", () => {
  it("reads the version of a registry document", () => {
    assert.equal(parseNpmLatestVersion({ version: "2.1.0" }), "2.1.0");
  });

  it("rejects malformed documents", () => {
    for (const payload of [null, "2.1.0", {}, { version: 2 }, { version: "latest" }]) {
      assert.equal(parseNpmLatestVersion(payload), null);
    }
  });
});

const fetchReturning = (response: Response) => (async () => response) as unknown as typeof fetch;

describe("fetchNpmLatestVersion", () => {
  it.effect("escapes the package scope in the registry URL", () =>
    Effect.gen(function* () {
      const urls: Array<string> = [];
      const version = yield* fetchNpmLatestVersion("@anthropic-ai/claude-code", {
        fetch: (async (url: string) => {
          urls.push(url);
          return Response.json({ version: "2.1.0" });
        }) as unknown as typeof fetch,
      });
      assert.equal(version, "2.1.0");
      assert.deepEqual(urls, ["https://registry.npmjs.org/%40anthropic-ai%2Fclaude-code/latest"]);
    }),
  );

  it.effect("treats HTTP errors, bad JSON and network failures as unknown", () =>
    Effect.gen(function* () {
      const results = yield* Effect.all([
        fetchNpmLatestVersion("pkg", {
          fetch: fetchReturning(new Response("nope", { status: 503 })),
        }),
        fetchNpmLatestVersion("pkg", { fetch: fetchReturning(new Response("<html>")) }),
        fetchNpmLatestVersion("pkg", {
          fetch: (async () => {
            throw new Error("offline");
          }) as unknown as typeof fetch,
        }),
      ]);
      assert.deepEqual(results, [null, null, null]);
    }),
  );

  it.live("gives up on a registry that never answers", () =>
    Effect.gen(function* () {
      const version = yield* fetchNpmLatestVersion("pkg", {
        timeoutMs: 5,
        fetch: ((_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          })) as unknown as typeof fetch,
      });
      assert.equal(version, null);
    }),
  );
});

describe("makeCachedLatestVersionLookup", () => {
  it.effect("answers from the cache for an hour, per package, including failures", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const lookup = makeCachedLatestVersionLookup((packageName) =>
        Effect.sync(() => {
          calls.push(packageName);
          return packageName === "down" ? null : "1.0.0";
        }),
      );

      yield* lookup("up");
      yield* lookup("up");
      yield* lookup("down");
      assert.equal(yield* lookup("down"), null);
      assert.deepEqual(calls, ["up", "down"]);

      yield* TestClock.adjust("61 minutes");
      yield* lookup("up");
      assert.deepEqual(calls, ["up", "down", "up"]);
    }),
  );

  it.effect("looks a package up again once invalidated, as an explicit refresh does", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const lookup = makeCachedLatestVersionLookup((packageName) =>
        Effect.sync(() => {
          calls.push(packageName);
          return null;
        }),
      );
      yield* lookup("down");
      yield* lookup("other");
      lookup.invalidate("down");
      yield* lookup("down");
      yield* lookup("other");
      assert.deepEqual(calls, ["down", "other", "down"]);
    }),
  );
});

const CLAUDE_PACKAGE = "@anthropic-ai/claude-code";
const CODEX_PACKAGE = "@openai/codex";

describe("classifyProviderInstall", () => {
  const cases: ReadonlyArray<readonly [string | null, string, ProviderInstallKind]> = [
    [NATIVE_REAL_PATH, CLAUDE_PACKAGE, "native"],
    ["/Users/me/.local/bin/claude", CLAUDE_PACKAGE, "native"],
    ["C:\\Users\\me\\.local\\bin\\claude.exe", CLAUDE_PACKAGE, "native"],
    ["/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js", CLAUDE_PACKAGE, "npmGlobal"],
    ["/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js", CODEX_PACKAGE, "npmGlobal"],
    [
      "/Users/me/.nvm/versions/node/v22/lib/node_modules/@openai/codex/bin/codex.js",
      CODEX_PACKAGE,
      "npmGlobal",
    ],
    ["C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd", CLAUDE_PACKAGE, "npmGlobal"],
    [
      "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js",
      CODEX_PACKAGE,
      "npmGlobal",
    ],
    [
      "/Users/me/Library/pnpm/global/5/.pnpm/pkg@1/node_modules/@anthropic-ai/claude-code/cli.js",
      CLAUDE_PACKAGE,
      "pnpmGlobal",
    ],
    [
      "/Users/me/.local/share/pnpm/global/5/node_modules/@openai/codex/bin.js",
      CODEX_PACKAGE,
      "pnpmGlobal",
    ],
    ["/opt/homebrew/Caskroom/claude-code/1.0.0/claude", CLAUDE_PACKAGE, "homebrew"],
    ["/usr/local/Cellar/codex/1.0.0/bin/codex", CODEX_PACKAGE, "homebrew"],
    [
      "/Users/me/.local/share/mise/installs/node/22/lib/node_modules/@openai/codex/bin.js",
      CODEX_PACKAGE,
      "npmGlobal",
    ],
    [
      "/nix/store/abc-claude-code-1/lib/node_modules/@anthropic-ai/claude-code/cli.js",
      CLAUDE_PACKAGE,
      "unattributed",
    ],
    ["/Users/me/.codex/packages/standalone/releases/1/codex", CODEX_PACKAGE, "standalone"],
    [
      "/usr/local/lib/node_modules/wrapper/node_modules/@openai/codex/bin.js",
      CODEX_PACKAGE,
      "unattributed",
    ],
    ["/usr/local/lib/node_modules/other-tool/bin/codex", CODEX_PACKAGE, "unattributed"],
    [
      "/Users/me/project/node_modules/@anthropic-ai/claude-code/cli.js",
      CLAUDE_PACKAGE,
      "unattributed",
    ],
    ["/usr/local/bin/claude", CLAUDE_PACKAGE, "unattributed"],
    [null, CLAUDE_PACKAGE, "unattributed"],
  ];

  it("attributes each install to its owner", () => {
    for (const [path, packageName, expected] of cases) {
      assert.equal(classifyProviderInstall(path, packageName), expected, String(path));
    }
  });
});

describe("npmGlobalPrefixFromCommandPath", () => {
  it("finds the prefix that owns a global package", () => {
    assert.equal(
      npmGlobalPrefixFromCommandPath(
        "/Users/Me/.nvm/versions/node/v22/lib/node_modules/@openai/codex/bin/codex.js",
        CODEX_PACKAGE,
      ),
      "/Users/Me/.nvm/versions/node/v22",
    );
    assert.equal(
      npmGlobalPrefixFromCommandPath("/lib/node_modules/@openai/codex/bin.js", CODEX_PACKAGE),
      "/",
    );
    assert.equal(
      npmGlobalPrefixFromCommandPath(
        "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin.js",
        CODEX_PACKAGE,
      ),
      "C:/Users/me/AppData/Roaming/npm",
    );
  });

  it("has none for a nested or foreign package", () => {
    assert.equal(
      npmGlobalPrefixFromCommandPath(
        "/usr/local/lib/node_modules/wrapper/node_modules/@openai/codex/bin.js",
        CODEX_PACKAGE,
      ),
      null,
    );
    assert.equal(
      npmGlobalPrefixFromCommandPath("/usr/local/lib/node_modules/other/bin.js", CODEX_PACKAGE),
      null,
    );
  });
});

describe("update commands", () => {
  it("offers claude update where Claude can update itself", () => {
    const command = (install: ProviderInstallKind) =>
      CLAUDE_CLI_MAINTENANCE.resolveUpdateCommand(install, "claude", "darwin");
    assert.equal(command("native"), "claude update");
    assert.equal(command("npmGlobal"), "claude update");
    assert.equal(command("pnpmGlobal"), "claude update");
    assert.equal(command("homebrew"), null);
    assert.equal(command("mise"), null);
    assert.equal(command("unattributed"), null);
  });

  it("offers the owning package manager for Codex", () => {
    const command = (install: ProviderInstallKind) =>
      CODEX_CLI_MAINTENANCE.resolveUpdateCommand(install, "codex", "darwin");
    assert.equal(command("npmGlobal"), "npm install -g @openai/codex@latest");
    assert.equal(command("pnpmGlobal"), "pnpm add -g @openai/codex@latest");
    assert.equal(command("standalone"), "codex update");
    assert.equal(command("native"), null);
    assert.equal(command("homebrew"), null);
    assert.equal(command("mise"), null);
    assert.equal(command("unattributed"), null);
  });

  it("installs a global Codex under the prefix that owns the binary", () => {
    const command = (realCommandPath: string) =>
      CODEX_CLI_MAINTENANCE.resolveUpdateCommand("npmGlobal", "codex", "darwin", {
        realCommandPath,
      });
    assert.equal(
      command("/Users/me/.nvm/versions/node/v22/lib/node_modules/@openai/codex/bin/codex.js"),
      "npm install -g --prefix /Users/me/.nvm/versions/node/v22 @openai/codex@latest",
    );
    assert.equal(
      command("/Apps/My Node/lib/node_modules/@openai/codex/bin/codex.js"),
      "npm install -g --prefix '/Apps/My Node' @openai/codex@latest",
    );
  });

  it("points the standalone Codex updater at a configured home", () => {
    assert.equal(
      CODEX_CLI_MAINTENANCE.resolveUpdateCommand("standalone", "/bin/codex", "darwin", {
        homePath: "/Users/me/my codex",
      }),
      "CODEX_HOME='/Users/me/my codex' /bin/codex update",
    );
    assert.equal(
      CODEX_CLI_MAINTENANCE.resolveUpdateCommand("standalone", "C:\\codex.exe", "win32", {
        homePath: "C:\\codex home",
      }),
      "$env:CODEX_HOME='C:\\codex home'; C:\\codex.exe update",
    );
  });

  it("quotes a configured path only when it needs it", () => {
    assert.equal(
      quoteCommandExecutable("/usr/local/bin/claude", "darwin"),
      "/usr/local/bin/claude",
    );
    assert.equal(
      CLAUDE_CLI_MAINTENANCE.resolveUpdateCommand("native", "/Apps/My Tools/claude", "darwin"),
      "'/Apps/My Tools/claude' update",
    );
    assert.equal(quoteCommandExecutable("/it's/claude", "linux"), "'/it'\\''s/claude'");
    assert.equal(
      quoteCommandExecutable("C:\\Program Files\\claude.exe", "win32"),
      "& 'C:\\Program Files\\claude.exe'",
    );
  });
});

describe("resolveCommandPathOnHost", () => {
  it("keeps an explicit path and returns null for a command not on PATH", () => {
    assert.equal(resolveCommandPathOnHost("/opt/claude", "darwin", {}), "/opt/claude");
    assert.equal(resolveCommandPathOnHost("claude", "darwin", { PATH: "" }), null);
  });
});

describe("the ServerProvider contract", () => {
  it("decodes a snapshot saved before advisories existed", () => {
    const decoded = Schema.decodeUnknownSync(ServerProviderSchema)(baseSnapshot);
    assert.equal(decoded.versionAdvisory, undefined);
  });
});

/** A settings service whose changes reach subscribers, unlike `layerTest`. */
const makeLiveSettings = Effect.gen(function* () {
  const settingsRef = yield* Ref.make<ServerSettings>(DEFAULT_SERVER_SETTINGS);
  const changes = yield* PubSub.unbounded<ServerSettings>();
  return {
    setChecksEnabled: (enableProviderUpdateChecks: boolean) =>
      Ref.updateAndGet(settingsRef, (settings) => ({
        ...settings,
        enableProviderUpdateChecks,
      })).pipe(Effect.flatMap((settings) => PubSub.publish(changes, settings))),
    layer: Layer.succeed(ServerSettingsService, {
      start: Effect.void,
      ready: Effect.void,
      getSettings: Ref.get(settingsRef),
      updateSettings: () => Ref.get(settingsRef),
      get streamChanges() {
        return Stream.fromPubSub(changes);
      },
    }),
  };
});

const settle = Effect.gen(function* () {
  for (let tick = 0; tick < 20; tick += 1) yield* Effect.yieldNow;
});

const makeHarness = Effect.fn("makeHarness")(function* (initial: ServerProvider = baseSnapshot) {
  const base = yield* PubSub.unbounded<ServerProvider>();
  const current = yield* Ref.make(initial);
  const provider: ServerProviderShape & { readonly marker: string } = {
    marker: "kept",
    getSnapshot: Ref.get(current),
    refresh: Ref.get(current),
    get streamChanges() {
      return Stream.fromPubSub(base);
    },
  };
  return {
    provider,
    publishBase: (snapshot: ServerProvider) =>
      Ref.set(current, snapshot).pipe(Effect.andThen(PubSub.publish(base, snapshot))),
  };
});

const collectChanges = Effect.fn("collectChanges")(function* (stream: ServerProviderShape) {
  const seen = yield* Ref.make<ReadonlyArray<ServerProvider>>([]);
  yield* Stream.runForEach(stream.streamChanges, (snapshot) =>
    Ref.update(seen, (all) => [...all, snapshot]),
  ).pipe(Effect.forkScoped);
  yield* settle;
  return seen;
});

describe("makeProviderWithVersionAdvisory", () => {
  const readCommandPaths = () =>
    Effect.succeed({ commandPath: NATIVE_COMMAND_PATH, realCommandPath: NATIVE_REAL_PATH });

  it.effect("publishes the snapshot first, then again once the lookup finishes", () =>
    Effect.gen(function* () {
      const settings = yield* makeLiveSettings;
      const { provider, publishBase } = yield* makeHarness({ ...baseSnapshot, version: null });
      const release = yield* Deferred.make<void>();
      const decorated = yield* makeProviderWithVersionAdvisory(provider, CLAUDE_CLI_MAINTENANCE, {
        lookupLatestVersion: () => Deferred.await(release).pipe(Effect.as("2.0.0")),
        readCommandPaths,
      }).pipe(Effect.provide(settings.layer));
      const seen = yield* collectChanges(decorated);

      yield* publishBase(baseSnapshot);
      yield* settle;
      const beforeLookup = yield* Ref.get(seen);
      assert.equal(beforeLookup.length, 1);
      assert.equal(beforeLookup[0]!.versionAdvisory, undefined);

      yield* Deferred.succeed(release, undefined);
      yield* settle;
      const afterLookup = yield* Ref.get(seen);
      assert.equal(afterLookup.length, 2);
      assert.deepEqual(afterLookup[1]!.versionAdvisory, {
        status: "behind_latest",
        currentVersion: "1.0.0",
        latestVersion: "2.0.0",
        updateCommand: `${NATIVE_COMMAND_PATH} update`,
      });
      assert.equal((yield* decorated.getSnapshot).versionAdvisory?.latestVersion, "2.0.0");
      assert.equal(decorated.marker, "kept");
    }).pipe(Effect.scoped),
  );

  it.effect("does not compare a Homebrew install with npm, and asks npm nothing", () =>
    Effect.gen(function* () {
      const settings = yield* makeLiveSettings;
      const { provider, publishBase } = yield* makeHarness(baseSnapshot);
      let lookups = 0;
      let miseProbes = 0;
      const decorated = yield* makeProviderWithVersionAdvisory(provider, CLAUDE_CLI_MAINTENANCE, {
        resolveMiseMaintenance: Object.assign(
          () =>
            Effect.sync(() => {
              miseProbes += 1;
              return null;
            }),
          { invalidate: () => {} },
        ),
        lookupLatestVersion: () =>
          Effect.sync(() => {
            lookups += 1;
            return "2.0.0";
          }),
        readCommandPaths: () =>
          Effect.succeed({
            commandPath: "/opt/homebrew/bin/claude",
            realCommandPath: "/opt/homebrew/Caskroom/claude-code/1.0.0/claude",
          }),
      }).pipe(Effect.provide(settings.layer));

      yield* publishBase(baseSnapshot);
      yield* settle;
      assert.deepEqual((yield* decorated.getSnapshot).versionAdvisory, {
        status: "unknown",
        currentVersion: "1.0.0",
        latestVersion: null,
        updateCommand: null,
      });
      assert.equal(lookups, 0);
      assert.equal(miseProbes, 0);
    }).pipe(Effect.scoped),
  );

  it.effect("falls back to the configured path when the binary cannot be resolved", () =>
    Effect.gen(function* () {
      const settings = yield* makeLiveSettings;
      const { provider, publishBase } = yield* makeHarness(baseSnapshot);
      const decorated = yield* makeProviderWithVersionAdvisory(provider, CLAUDE_CLI_MAINTENANCE, {
        lookupLatestVersion: () => Effect.succeed("2.0.0"),
        readCommandPaths: () =>
          Effect.succeed({ commandPath: null, realCommandPath: NATIVE_REAL_PATH }),
      }).pipe(Effect.provide(settings.layer));

      yield* publishBase(baseSnapshot);
      yield* settle;
      const advisory = (yield* decorated.getSnapshot).versionAdvisory;
      assert.equal(advisory?.status, "behind_latest");
      assert.equal(advisory?.updateCommand, "claude update");
    }).pipe(Effect.scoped),
  );

  it.effect("does not republish when the advisory is unchanged", () =>
    Effect.gen(function* () {
      const settings = yield* makeLiveSettings;
      const { provider, publishBase } = yield* makeHarness();
      const decorated = yield* makeProviderWithVersionAdvisory(provider, CLAUDE_CLI_MAINTENANCE, {
        lookupLatestVersion: () => Effect.succeed("2.0.0"),
        readCommandPaths,
      }).pipe(Effect.provide(settings.layer));
      yield* settle;
      const seen = yield* collectChanges(decorated);

      yield* publishBase({ ...baseSnapshot, checkedAt: "2026-01-01T00:05:00.000Z" });
      yield* settle;
      assert.equal((yield* Ref.get(seen)).length, 1);
    }).pipe(Effect.scoped),
  );

  it.effect("makes no request when the setting is off, and clears the advisory on the switch", () =>
    Effect.gen(function* () {
      const settings = yield* makeLiveSettings;
      const { provider } = yield* makeHarness();
      const lookups = yield* Ref.make(0);
      const decorated = yield* makeProviderWithVersionAdvisory(provider, CLAUDE_CLI_MAINTENANCE, {
        lookupLatestVersion: () =>
          Ref.update(lookups, (count) => count + 1).pipe(Effect.as("2.0.0")),
        readCommandPaths,
      }).pipe(Effect.provide(settings.layer));
      yield* settle;
      assert.equal(yield* Ref.get(lookups), 1);
      const seen = yield* collectChanges(decorated);

      yield* settings.setChecksEnabled(false);
      yield* settle;
      assert.equal((yield* decorated.getSnapshot).versionAdvisory, undefined);
      assert.equal((yield* Ref.get(seen)).at(-1)!.versionAdvisory, undefined);

      yield* decorated.refresh;
      yield* settle;
      assert.equal(yield* Ref.get(lookups), 1);
    }).pipe(Effect.scoped),
  );

  it.effect("skips a provider that is disabled, missing or has no version", () =>
    Effect.gen(function* () {
      for (const snapshot of [
        { ...baseSnapshot, enabled: false },
        { ...baseSnapshot, installed: false },
        { ...baseSnapshot, version: null },
      ]) {
        const settings = yield* makeLiveSettings;
        const { provider } = yield* makeHarness(snapshot);
        const lookups = yield* Ref.make(0);
        const decorated = yield* makeProviderWithVersionAdvisory(provider, CLAUDE_CLI_MAINTENANCE, {
          lookupLatestVersion: () =>
            Ref.update(lookups, (count) => count + 1).pipe(Effect.as("2.0.0")),
          readCommandPaths,
        }).pipe(Effect.provide(settings.layer));
        yield* settle;
        assert.equal(yield* Ref.get(lookups), 0);
        assert.equal((yield* decorated.getSnapshot).versionAdvisory, undefined);
      }
    }).pipe(Effect.scoped),
  );

  it.effect("drops an advisory for a version the CLI has since moved past", () =>
    Effect.gen(function* () {
      const settings = yield* makeLiveSettings;
      const { provider, publishBase } = yield* makeHarness();
      const decorated = yield* makeProviderWithVersionAdvisory(provider, CLAUDE_CLI_MAINTENANCE, {
        lookupLatestVersion: () => Effect.succeed("2.0.0"),
        readCommandPaths,
      }).pipe(Effect.provide(settings.layer));
      yield* settle;
      const seen = yield* collectChanges(decorated);

      yield* publishBase({ ...baseSnapshot, version: "2.0.0" });
      yield* settle;
      const published = yield* Ref.get(seen);
      assert.equal(published[0]!.versionAdvisory, undefined);
      assert.equal(published[1]!.versionAdvisory?.status, "current");
    }).pipe(Effect.scoped),
  );

  it.effect("keeps a managed provider's pending placeholder recognisable", () =>
    Effect.gen(function* () {
      const settings = yield* makeLiveSettings;
      const decorated = yield* Effect.gen(function* () {
        const managed = yield* makeManagedServerProvider<{ readonly enabled: boolean }>({
          getSettings: Effect.succeed({ enabled: true }),
          streamSettings: Stream.empty,
          haveSettingsChanged: () => false,
          initialSnapshot: () => ({ ...baseSnapshot, version: null }),
          checkProvider: Effect.succeed(baseSnapshot),
        });
        return yield* makeProviderWithVersionAdvisory(managed, CLAUDE_CLI_MAINTENANCE, {
          lookupLatestVersion: () => Effect.succeed("2.0.0"),
          readCommandPaths,
        });
      }).pipe(Effect.provide(settings.layer));
      assert.isTrue(isPendingProviderSnapshot(yield* decorated.getSnapshot));
    }).pipe(Effect.scoped),
  );
});
