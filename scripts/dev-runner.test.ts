import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer, Logger } from "effect";
import { NetService } from "@piedpiper/shared/Net";

import {
  REPO_ROOT,
  createDevRunnerEnv,
  expandHomeDir,
  formatDevAccessUrl,
  resolveTurboCommand,
  resolveDevAuthToken,
  findFirstAvailableOffset,
  isBrowserAllowedPort,
  nextBrowserSafeOffset,
  resolveModePortOffsets,
  resolveDevPiedpiperHome,
  resolveOffset,
  runDevRunnerWithInput,
} from "./dev-runner.ts";

it.layer(NodeServices.layer)("dev-runner", (it) => {
  describe("resolveOffset", () => {
    it.effect("uses explicit PIEDPIPER_PORT_OFFSET when provided", () =>
      Effect.sync(() => {
        const result = resolveOffset({ portOffset: 12, devInstance: undefined });
        assert.deepStrictEqual(result, {
          offset: 12,
          source: "PIEDPIPER_PORT_OFFSET=12",
        });
      }),
    );

    it.effect("hashes non-numeric instance values", () =>
      Effect.sync(() => {
        const result = resolveOffset({ portOffset: undefined, devInstance: "feature-branch" });
        assert.ok(result.offset >= 1);
        assert.ok(result.offset <= 3000);
      }),
    );

    it.effect("derives a stable offset from the worktree path", () =>
      Effect.sync(() => {
        const first = resolveOffset({
          portOffset: undefined,
          devInstance: undefined,
          worktreePath: "/work/piedpiper-a",
        });
        const again = resolveOffset({
          portOffset: undefined,
          devInstance: undefined,
          worktreePath: "/work/piedpiper-a",
        });
        const sibling = resolveOffset({
          portOffset: undefined,
          devInstance: undefined,
          worktreePath: "/work/piedpiper-b",
        });

        assert.deepStrictEqual(first, again);
        assert.equal(first.source, "worktree /work/piedpiper-a");
        assert.ok(first.offset >= 1);
        assert.ok(first.offset <= 3000);
        assert.notEqual(first.offset, sibling.offset);
      }),
    );

    it.effect("lets explicit offsets and dev instances outrank the worktree path", () =>
      Effect.sync(() => {
        const worktreePath = "/work/piedpiper-a";

        assert.equal(
          resolveOffset({ portOffset: 12, devInstance: "7", worktreePath }).source,
          "PIEDPIPER_PORT_OFFSET=12",
        );
        assert.equal(
          resolveOffset({ portOffset: undefined, devInstance: "7", worktreePath }).source,
          "numeric PIEDPIPER_DEV_INSTANCE=7",
        );
        assert.equal(
          resolveOffset({ portOffset: undefined, devInstance: "feature", worktreePath }).source,
          "hashed PIEDPIPER_DEV_INSTANCE=feature",
        );
        assert.equal(
          resolveOffset({ portOffset: undefined, devInstance: "  ", worktreePath }).source,
          `worktree ${worktreePath}`,
        );
      }),
    );

    it.effect("keeps the default ports without a worktree or for a blank path", () =>
      Effect.sync(() => {
        for (const worktreePath of [undefined, "", "   "]) {
          assert.deepStrictEqual(
            resolveOffset({ portOffset: undefined, devInstance: undefined, worktreePath }),
            { offset: 0, source: "default ports" },
          );
        }
      }),
    );

    it("moves a blocked offset to the next one both ports can use", () => {
      assert.equal(isBrowserAllowedPort(3773 + 1287), false);
      assert.equal(nextBrowserSafeOffset(1287), 1289);

      for (let offset = 1; offset <= 3000; offset += 1) {
        const safe = nextBrowserSafeOffset(offset);
        assert.ok(safe >= offset && safe <= 3000);
        assert.ok(isBrowserAllowedPort(3773 + safe) && isBrowserAllowedPort(5733 + safe));
        if (isBrowserAllowedPort(3773 + offset) && isBrowserAllowedPort(5733 + offset)) {
          assert.equal(safe, offset);
        }
      }
    });

    it("never hashes a worktree or dev instance onto a browser-blocked port", () => {
      for (let index = 0; index < 5000; index += 1) {
        for (const input of [
          { devInstance: undefined, worktreePath: `/work/piedpiper-${index}` },
          { devInstance: `feature-${index}` },
        ]) {
          const { offset } = resolveOffset({ portOffset: undefined, ...input });
          assert.ok(isBrowserAllowedPort(3773 + offset) && isBrowserAllowedPort(5733 + offset));
        }
      }
    });

    it.effect("throws for negative port offset", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          Effect.try({
            try: () => resolveOffset({ portOffset: -1, devInstance: undefined }),
            catch: (cause) => String(cause),
          }),
        );

        assert.ok(error.includes("Invalid PIEDPIPER_PORT_OFFSET"));
      }),
    );
  });

  describe("createDevRunnerEnv", () => {
    it.effect("defaults PIEDPIPER_HOME to ~/.piedpiper when not provided", () =>
      Effect.gen(function* () {
        const env = yield* createDevRunnerEnv({
          mode: "dev",
          baseEnv: {},
          serverOffset: 0,
          webOffset: 0,
          piedpiperHome: undefined,
          authToken: undefined,
          noBrowser: undefined,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: undefined,
          port: undefined,
          devUrl: undefined,
        });

        assert.equal(env.PIEDPIPER_HOME, resolve(homedir(), ".piedpiper"));
      }),
    );

    it.effect("turns product analytics off unless the developer opts in", () =>
      Effect.gen(function* () {
        const envFor = (mode: "dev" | "dev:server" | "dev:web" | "dev:desktop", baseEnv: object) =>
          createDevRunnerEnv({
            mode,
            baseEnv: baseEnv as NodeJS.ProcessEnv,
            serverOffset: 0,
            webOffset: 0,
            piedpiperHome: undefined,
            authToken: undefined,
            noBrowser: undefined,
            autoBootstrapProjectFromCwd: undefined,
            logWebSocketEvents: undefined,
            host: undefined,
            port: undefined,
            devUrl: undefined,
          });

        for (const mode of ["dev", "dev:server", "dev:web", "dev:desktop"] as const) {
          const byDefault = yield* envFor(mode, {});
          const optedIn = yield* envFor(mode, { PIEDPIPER_TELEMETRY_ENABLED: "true" });
          const optedOut = yield* envFor(mode, { PIEDPIPER_TELEMETRY_ENABLED: "false" });
          const blank = yield* envFor(mode, { PIEDPIPER_TELEMETRY_ENABLED: "  " });

          assert.equal(byDefault.PIEDPIPER_TELEMETRY_ENABLED, "false");
          assert.equal(optedIn.PIEDPIPER_TELEMETRY_ENABLED, "true");
          assert.equal(optedOut.PIEDPIPER_TELEMETRY_ENABLED, "false");
          assert.equal(blank.PIEDPIPER_TELEMETRY_ENABLED, "false");
        }
      }),
    );

    it("passes the analytics key to dev and start tasks but never to test runs", () => {
      const turbo = JSON.parse(readFileSync(join(REPO_ROOT, "turbo.json"), "utf8")) as {
        readonly globalEnv: ReadonlyArray<string>;
        readonly globalPassThroughEnv: ReadonlyArray<string>;
        readonly tasks: Record<string, { readonly passThroughEnv?: ReadonlyArray<string> }>;
      };
      const analyticsVariables = ["PIEDPIPER_POSTHOG_KEY", "PIEDPIPER_POSTHOG_HOST"];

      assert.include(turbo.globalEnv, "PIEDPIPER_TELEMETRY_ENABLED");
      for (const variable of analyticsVariables) {
        assert.notInclude(turbo.globalEnv, variable);
        assert.notInclude(turbo.globalPassThroughEnv, variable);
        assert.include(turbo.tasks.dev?.passThroughEnv ?? [], variable);
        assert.include(turbo.tasks.start?.passThroughEnv ?? [], variable);
        assert.notInclude(turbo.tasks.test?.passThroughEnv ?? [], variable);
      }
    });

    it.effect("supports explicit typed overrides", () =>
      Effect.gen(function* () {
        const env = yield* createDevRunnerEnv({
          mode: "dev:server",
          baseEnv: {},
          serverOffset: 0,
          webOffset: 0,
          piedpiperHome: "/tmp/custom-piedpiper",
          authToken: "secret",
          noBrowser: true,
          autoBootstrapProjectFromCwd: false,
          logWebSocketEvents: true,
          host: "0.0.0.0",
          port: 4222,
          devUrl: new URL("http://localhost:7331"),
        });

        assert.equal(env.PIEDPIPER_HOME, resolve("/tmp/custom-piedpiper"));
        assert.equal(env.PIEDPIPER_PORT, "4222");
        assert.equal(env.VITE_WS_URL, "ws://localhost:4222");
        assert.equal(env.PIEDPIPER_NO_BROWSER, "1");
        assert.equal(env.PIEDPIPER_AUTO_BOOTSTRAP_PROJECT_FROM_CWD, "0");
        assert.equal(env.PIEDPIPER_LOG_WS_EVENTS, "1");
        assert.equal(env.PIEDPIPER_HOST, "0.0.0.0");
        assert.equal(env.VITE_DEV_SERVER_URL, "http://localhost:7331/");
      }),
    );

    it.effect("does not force websocket logging on in dev mode when unset", () =>
      Effect.gen(function* () {
        const env = yield* createDevRunnerEnv({
          mode: "dev",
          baseEnv: {
            PIEDPIPER_LOG_WS_EVENTS: "keep-me-out",
          },
          serverOffset: 0,
          webOffset: 0,
          piedpiperHome: undefined,
          authToken: undefined,
          noBrowser: undefined,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: undefined,
          port: undefined,
          devUrl: undefined,
        });

        assert.equal(env.PIEDPIPER_MODE, "web");
        assert.equal(env.PIEDPIPER_LOG_WS_EVENTS, undefined);
      }),
    );

    it.effect("forwards explicit websocket logging false without coercing it away", () =>
      Effect.gen(function* () {
        const env = yield* createDevRunnerEnv({
          mode: "dev",
          baseEnv: {},
          serverOffset: 0,
          webOffset: 0,
          piedpiperHome: undefined,
          authToken: undefined,
          noBrowser: undefined,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: false,
          host: undefined,
          port: undefined,
          devUrl: undefined,
        });

        assert.equal(env.PIEDPIPER_LOG_WS_EVENTS, "0");
      }),
    );

    it.effect("expands a home-relative piedpiper home", () =>
      Effect.gen(function* () {
        const homeFor = (piedpiperHome: string) =>
          createDevRunnerEnv({
            mode: "dev",
            baseEnv: {},
            serverOffset: 0,
            webOffset: 0,
            piedpiperHome,
            authToken: undefined,
            noBrowser: undefined,
            autoBootstrapProjectFromCwd: undefined,
            logWebSocketEvents: undefined,
            host: undefined,
            port: undefined,
            devUrl: undefined,
          }).pipe(Effect.map((env) => env.PIEDPIPER_HOME));

        assert.equal(yield* homeFor("~/pp-dev"), resolve(homedir(), "pp-dev"));
        assert.equal(yield* homeFor("~"), homedir());
        assert.equal(yield* homeFor("  ~/pp-dev  "), resolve(homedir(), "pp-dev"));
        assert.equal(yield* homeFor("~someone/pp-dev"), resolve("~someone/pp-dev"));
        assert.equal(yield* homeFor("relative/pp-dev"), resolve("relative/pp-dev"));

        assert.equal(
          expandHomeDir("~\\pp-dev", "/home/dev", (...s) => s.join("/")),
          "/home/dev/pp-dev",
        );
        assert.equal(
          expandHomeDir("/tmp/pp-dev", "/home/dev", (...s) => s.join("/")),
          undefined,
        );
      }),
    );

    it.effect("uses custom piedpiper home when provided", () =>
      Effect.gen(function* () {
        const env = yield* createDevRunnerEnv({
          mode: "dev",
          baseEnv: {},
          serverOffset: 0,
          webOffset: 0,
          piedpiperHome: "/tmp/my-piedpiper",
          authToken: undefined,
          noBrowser: undefined,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: undefined,
          port: undefined,
          devUrl: undefined,
        });

        assert.equal(env.PIEDPIPER_HOME, resolve("/tmp/my-piedpiper"));
      }),
    );

    it.effect("forwards the auth token to both the server and the Vite dev server", () =>
      Effect.gen(function* () {
        const env = yield* createDevRunnerEnv({
          mode: "dev",
          baseEnv: {},
          serverOffset: 0,
          webOffset: 0,
          piedpiperHome: undefined,
          authToken: "shared-token",
          noBrowser: undefined,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: undefined,
          port: undefined,
          devUrl: undefined,
        });

        assert.equal(env.PIEDPIPER_AUTH_TOKEN, "shared-token");
        assert.equal(env.VITE_PIEDPIPER_AUTH_TOKEN, "shared-token");
      }),
    );

    it.effect("drops a stale VITE_PIEDPIPER_AUTH_TOKEN for dev:desktop", () =>
      Effect.gen(function* () {
        const env = yield* createDevRunnerEnv({
          mode: "dev:desktop",
          baseEnv: { VITE_PIEDPIPER_AUTH_TOKEN: "stale" },
          serverOffset: 0,
          webOffset: 0,
          piedpiperHome: undefined,
          authToken: "fresh-token",
          noBrowser: undefined,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: undefined,
          port: undefined,
          devUrl: undefined,
        });

        assert.equal(env.VITE_PIEDPIPER_AUTH_TOKEN, undefined);
      }),
    );

    it.effect("does not export backend bootstrap env for dev:desktop", () =>
      Effect.gen(function* () {
        const env = yield* createDevRunnerEnv({
          mode: "dev:desktop",
          baseEnv: {
            PIEDPIPER_PORT: "3773",
            PIEDPIPER_AUTH_TOKEN: "stale-token",
            PIEDPIPER_MODE: "web",
            PIEDPIPER_NO_BROWSER: "0",
            PIEDPIPER_HOST: "0.0.0.0",
            VITE_WS_URL: "ws://localhost:3773",
          },
          serverOffset: 0,
          webOffset: 0,
          piedpiperHome: "/tmp/my-piedpiper",
          authToken: "fresh-token",
          noBrowser: true,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: "127.0.0.1",
          port: 4222,
          devUrl: undefined,
        });

        assert.equal(env.PIEDPIPER_HOME, resolve("/tmp/my-piedpiper"));
        assert.equal(env.PORT, "5733");
        assert.equal(env.ELECTRON_RENDERER_PORT, "5733");
        assert.equal(env.VITE_DEV_SERVER_URL, "http://localhost:5733");
        assert.equal(env.PIEDPIPER_PORT, undefined);
        assert.equal(env.PIEDPIPER_AUTH_TOKEN, undefined);
        assert.equal(env.PIEDPIPER_MODE, undefined);
        assert.equal(env.PIEDPIPER_NO_BROWSER, undefined);
        assert.equal(env.PIEDPIPER_HOST, undefined);
        assert.equal(env.VITE_WS_URL, undefined);
      }),
    );
  });

  describe("resolveTurboCommand", () => {
    it.effect("prefers the repo-local turbo binary when it exists", () =>
      Effect.sync(() => {
        const localTurbo = resolve("/repo", "node_modules", ".bin", "turbo");
        assert.equal(
          resolveTurboCommand({
            repoRoot: "/repo",
            platform: "darwin",
            exists: (p) => p === localTurbo,
          }),
          localTurbo,
        );
        assert.equal(
          resolveTurboCommand({ repoRoot: "/repo", platform: "linux", exists: () => false }),
          "turbo",
        );
        // Windows keeps PATH resolution so shell mode can find the .cmd shim.
        assert.equal(
          resolveTurboCommand({ repoRoot: "/repo", platform: "win32", exists: () => true }),
          "turbo",
        );
      }),
    );

    it.effect("resolves the real repo root to its installed turbo binary", () =>
      Effect.sync(() => {
        assert.isTrue(existsSync(join(REPO_ROOT, "package.json")));
        assert.isTrue(existsSync(join(REPO_ROOT, "turbo.json")));
        assert.equal(
          resolveTurboCommand({ repoRoot: REPO_ROOT, platform: "darwin", exists: existsSync }),
          resolve(REPO_ROOT, "node_modules", ".bin", "turbo"),
        );
      }),
    );
  });

  describe("findFirstAvailableOffset", () => {
    it.effect("returns the starting offset when required ports are available", () =>
      Effect.gen(function* () {
        const offset = yield* findFirstAvailableOffset({
          startOffset: 0,
          requireServerPort: true,
          requireWebPort: true,
          checkPortAvailability: () => Effect.succeed(true),
        });

        assert.equal(offset, 0);
      }),
    );

    it.effect("advances until all required ports are available", () =>
      Effect.gen(function* () {
        const taken = new Set([3773, 5733, 3774, 5734]);
        const offset = yield* findFirstAvailableOffset({
          startOffset: 0,
          requireServerPort: true,
          requireWebPort: true,
          checkPortAvailability: (port) => Effect.succeed(!taken.has(port)),
        });

        assert.equal(offset, 2);
      }),
    );

    it.effect("allows offsets where only non-required ports exceed max", () =>
      Effect.gen(function* () {
        const offset = yield* findFirstAvailableOffset({
          startOffset: 59_803,
          requireServerPort: true,
          requireWebPort: false,
          checkPortAvailability: () => Effect.succeed(true),
        });

        assert.equal(offset, 59_803);
      }),
    );

    it.effect("skips browser-blocked web ports before probing availability", () =>
      Effect.gen(function* () {
        const probed: Array<number> = [];
        const offset = yield* findFirstAvailableOffset({
          // 5733 + 833 = 6566, which browsers block.
          startOffset: 833,
          requireServerPort: true,
          requireWebPort: true,
          checkPortAvailability: (port) => {
            probed.push(port);
            return Effect.succeed(true);
          },
        });

        assert.equal(offset, 834);
        assert.deepStrictEqual(probed, [4607, 6567]);
      }),
    );

    it.effect("skips browser-blocked server ports when the web app connects to them", () =>
      Effect.gen(function* () {
        const offset = yield* findFirstAvailableOffset({
          // 3773 + 2227 = 6000, which browsers block for WebSockets too.
          startOffset: 2227,
          requireServerPort: true,
          requireWebPort: true,
          checkPortAvailability: () => Effect.succeed(true),
        });

        assert.equal(offset, 2228);
      }),
    );

    it.effect(
      "does not reject a server-only offset because its server port is browser-blocked",
      () =>
        Effect.gen(function* () {
          const offset = yield* findFirstAvailableOffset({
            startOffset: 2227,
            requireServerPort: true,
            requireWebPort: false,
            checkPortAvailability: () => Effect.succeed(true),
          });

          assert.equal(offset, 2227);
        }),
    );

    it.effect("does not reject a server-only offset because its unused web port is blocked", () =>
      Effect.gen(function* () {
        const offset = yield* findFirstAvailableOffset({
          startOffset: 833,
          requireServerPort: true,
          requireWebPort: false,
          checkPortAvailability: () => Effect.succeed(true),
        });

        assert.equal(offset, 833);
      }),
    );
  });

  describe("isBrowserAllowedPort", () => {
    it.each([6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697])(
      "rejects Fetch-blocked port %s",
      (port) => {
        assert.equal(isBrowserAllowedPort(port), false);
      },
    );

    it.each([5733, 5900, 6567, 6670, 8733])("allows browser-safe port %s", (port) => {
      assert.equal(isBrowserAllowedPort(port), true);
    });
  });

  describe("resolveModePortOffsets", () => {
    it.effect("uses a shared fallback offset for dev mode", () =>
      Effect.gen(function* () {
        const taken = new Set([3773, 5733]);
        const offsets = yield* resolveModePortOffsets({
          mode: "dev",
          startOffset: 0,
          hasExplicitServerPort: false,
          hasExplicitDevUrl: false,
          checkPortAvailability: (port) => Effect.succeed(!taken.has(port)),
        });

        assert.deepStrictEqual(offsets, { serverOffset: 1, webOffset: 1 });
      }),
    );

    it.effect("keeps server offset stable for dev:web and only shifts web offset", () =>
      Effect.gen(function* () {
        const taken = new Set([5733]);
        const offsets = yield* resolveModePortOffsets({
          mode: "dev:web",
          startOffset: 0,
          hasExplicitServerPort: false,
          hasExplicitDevUrl: false,
          checkPortAvailability: (port) => Effect.succeed(!taken.has(port)),
        });

        assert.deepStrictEqual(offsets, { serverOffset: 0, webOffset: 1 });
      }),
    );

    it.effect("shifts only server offset for dev:server", () =>
      Effect.gen(function* () {
        const taken = new Set([3773]);
        const offsets = yield* resolveModePortOffsets({
          mode: "dev:server",
          startOffset: 0,
          hasExplicitServerPort: false,
          hasExplicitDevUrl: false,
          checkPortAvailability: (port) => Effect.succeed(!taken.has(port)),
        });

        assert.deepStrictEqual(offsets, { serverOffset: 1, webOffset: 1 });
      }),
    );

    it.effect("respects explicit dev-url override for dev:web", () =>
      Effect.gen(function* () {
        const offsets = yield* resolveModePortOffsets({
          mode: "dev:web",
          startOffset: 0,
          hasExplicitServerPort: false,
          hasExplicitDevUrl: true,
          checkPortAvailability: () => Effect.succeed(false),
        });

        assert.deepStrictEqual(offsets, { serverOffset: 0, webOffset: 0 });
      }),
    );

    it.effect("respects explicit server port override for dev:server", () =>
      Effect.gen(function* () {
        const offsets = yield* resolveModePortOffsets({
          mode: "dev:server",
          startOffset: 0,
          hasExplicitServerPort: true,
          hasExplicitDevUrl: false,
          checkPortAvailability: () => Effect.succeed(false),
        });

        assert.deepStrictEqual(offsets, { serverOffset: 0, webOffset: 0 });
      }),
    );
  });

  describe("resolveDevAuthToken", () => {
    it("mints a token for modes that start the server and honours an explicit one", () => {
      assert.equal(
        resolveDevAuthToken("dev", undefined, () => "minted"),
        "minted",
      );
      assert.equal(
        resolveDevAuthToken("dev:server", undefined, () => "minted"),
        "minted",
      );
      assert.equal(
        resolveDevAuthToken("dev", "explicit", () => "minted"),
        "explicit",
      );
      assert.equal(
        resolveDevAuthToken("dev:web", undefined, () => "minted"),
        undefined,
      );
      assert.equal(
        resolveDevAuthToken("dev:web", "explicit", () => "minted"),
        "explicit",
      );
      assert.equal(
        resolveDevAuthToken("dev:desktop", "explicit", () => "minted"),
        undefined,
      );
    });

    it("prints a browser URL that carries the token", () => {
      assert.equal(
        formatDevAccessUrl({
          mode: "dev",
          authToken: "t",
          serverPort: 3773,
          webPort: 5733,
          devUrl: undefined,
        }),
        "http://localhost:5733/?token=t",
      );
      assert.equal(
        formatDevAccessUrl({
          mode: "dev:server",
          authToken: "t",
          serverPort: 3774,
          webPort: 5733,
          devUrl: undefined,
        }),
        "http://127.0.0.1:3774/?token=t",
      );
      assert.equal(
        formatDevAccessUrl({
          mode: "dev:web",
          authToken: "t",
          serverPort: 3773,
          webPort: 5733,
          devUrl: undefined,
        }),
        undefined,
      );
    });
  });

  describe("resolveDevPiedpiperHome", () => {
    const makeWorktree = Effect.acquireRelease(
      Effect.sync(() => {
        const root = realpathSync(mkdtempSync(join(tmpdir(), "piedpiper-devrunner-")));
        writeFileSync(join(root, ".git"), "gitdir: /elsewhere/.git/worktrees/x\n");
        mkdirSync(join(root, "apps", "web"), { recursive: true });
        return root;
      }),
      (root) => Effect.sync(() => rmSync(root, { recursive: true, force: true })),
    );

    it.effect("prefers an explicit --home-dir over the worktree default", () =>
      Effect.gen(function* () {
        const root = yield* makeWorktree;
        const home = yield* resolveDevPiedpiperHome({
          explicitHome: "/tmp/explicit-home",
          cwd: root,
          ambientHome: "/home/user/.piedpiper",
        });
        assert.equal(home, "/tmp/explicit-home");
      }).pipe(Effect.scoped),
    );

    it.effect("uses the worktree .piedpiper over an ambient PIEDPIPER_HOME or blank flag", () =>
      Effect.gen(function* () {
        const root = yield* makeWorktree;
        const home = yield* resolveDevPiedpiperHome({
          explicitHome: "   ",
          cwd: join(root, "apps", "web"),
          ambientHome: "/home/user/.piedpiper",
        });
        assert.equal(home, join(root, ".piedpiper"));
        assert.isFalse(existsSync(join(root, ".piedpiper")));
      }).pipe(Effect.scoped),
    );

    it.effect("falls back to an ambient PIEDPIPER_HOME outside a worktree", () =>
      Effect.gen(function* () {
        const cwd = realpathSync(mkdtempSync(join(tmpdir(), "piedpiper-devrunner-plain-")));
        const ambient = yield* resolveDevPiedpiperHome({
          explicitHome: undefined,
          cwd,
          ambientHome: "/home/user/.piedpiper",
        });
        const implicit = yield* resolveDevPiedpiperHome({
          explicitHome: undefined,
          cwd,
          ambientHome: undefined,
        });
        rmSync(cwd, { recursive: true, force: true });
        assert.equal(ambient, "/home/user/.piedpiper");
        assert.isUndefined(implicit);
      }),
    );

    it.effect("hands the worktree home to the dev env over an ambient PIEDPIPER_HOME", () =>
      Effect.gen(function* () {
        const root = yield* makeWorktree;
        const messages: Array<string> = [];
        const captureLogger = Logger.make(({ message }) => {
          messages.push(Array.isArray(message) ? message.join(" ") : String(message));
        });
        const run = (piedpiperHome: string | undefined) =>
          runDevRunnerWithInput({
            mode: "dev:server",
            piedpiperHome,
            authToken: undefined,
            noBrowser: undefined,
            autoBootstrapProjectFromCwd: undefined,
            logWebSocketEvents: undefined,
            host: undefined,
            port: 4999,
            devUrl: undefined,
            dryRun: true,
            turboArgs: [],
            cwd: join(root, "apps", "web"),
            ambientHome: "/home/user/.piedpiper",
          }).pipe(Effect.provide([Logger.layer([captureLogger]), NetService.layer]));

        yield* run(undefined);
        yield* run("/tmp/explicit-home");
        const baseDirs = messages.flatMap((line) => line.match(/baseDir=(\S+)/)?.[1] ?? []);
        assert.deepStrictEqual(baseDirs, [join(root, ".piedpiper"), "/tmp/explicit-home"]);
      }).pipe(Effect.scoped),
    );

    it.effect("reports worktree-derived ports on a dry run", () =>
      Effect.gen(function* () {
        const root = yield* makeWorktree;
        const messages: Array<string> = [];
        const captureLogger = Logger.make(({ message }) => {
          messages.push(Array.isArray(message) ? message.join(" ") : String(message));
        });

        const { offset } = resolveOffset({
          portOffset: undefined,
          devInstance: undefined,
          worktreePath: root,
        });
        // Every port reads as free, so the hashed offset is what reaches the reported ports.
        const allPortsFree = Layer.succeed(NetService, {
          canListenOnHost: () => Effect.succeed(true),
          isPortAvailableOnLoopback: () => Effect.succeed(true),
          reserveLoopbackPort: () => Effect.succeed(0),
          findAvailablePort: (preferred) => Effect.succeed(preferred),
        });

        yield* runDevRunnerWithInput({
          mode: "dev",
          piedpiperHome: undefined,
          authToken: undefined,
          noBrowser: undefined,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: undefined,
          port: undefined,
          devUrl: undefined,
          dryRun: true,
          turboArgs: [],
          cwd: join(root, "apps", "web"),
          ambientHome: undefined,
        }).pipe(
          Effect.provide([
            Logger.layer([captureLogger]),
            allPortsFree,
            ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
          ]),
        );

        const summary = messages.find((line) => line.includes(`source=worktree ${root}`));
        assert.include(summary ?? "", `serverPort=${3773 + offset} webPort=${5733 + offset} `);
      }).pipe(Effect.scoped),
    );
  });
});
