import {
  KeybindingCommand,
  KeybindingRule,
  KeybindingsConfig,
  MAX_KEYBINDINGS_COUNT,
} from "@piedpiper/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { assertFailure } from "@effect/vitest/utils";
import { Effect, FileSystem, Layer, Logger, Path, Ref, Schema, Stream } from "effect";
import { ServerConfig } from "./config";

import {
  DEFAULT_KEYBINDINGS,
  Keybindings,
  KeybindingsLive,
  ResolvedKeybindingFromConfig,
  THREAD_JUMP_DEFAULT_WHEN,
  compileResolvedKeybindingRule,
  compileResolvedKeybindingsConfig,
  migrateLegacyThreadJumpDefaults,
  parseKeybindingShortcut,
} from "./keybindings";
import { KeybindingsConfigError } from "@piedpiper/contracts";

const KeybindingsConfigJson = Schema.fromJsonString(KeybindingsConfig);
const scriptRules = (count: number): KeybindingRule[] =>
  Array.from({ length: count }, (_, index) => ({
    key: `mod+alt+${index}`,
    command: `script.s${index}.run`,
  }));
const makeKeybindingsLayer = () => {
  return KeybindingsLive.pipe(
    Layer.provideMerge(
      Layer.fresh(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "piedpiper-keybindings-test-",
        }),
      ),
    ),
  );
};

const toDetailResult = <A, R>(effect: Effect.Effect<A, KeybindingsConfigError, R>) =>
  effect.pipe(
    Effect.mapError((error) => error.detail),
    Effect.result,
  );

const writeKeybindingsConfig = (configPath: string, rules: readonly KeybindingRule[]) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const encoded = yield* Schema.encodeEffect(KeybindingsConfigJson)(rules);
    yield* fileSystem.makeDirectory(path.dirname(configPath), { recursive: true });
    yield* fileSystem.writeFileString(configPath, encoded);
  });

const readKeybindingsConfig = (configPath: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const rawConfig = yield* fileSystem.readFileString(configPath);
    return yield* Schema.decodeUnknownEffect(KeybindingsConfigJson)(rawConfig);
  });

it.layer(NodeServices.layer)("keybindings", (it) => {
  it.effect("parses shortcuts including plus key", () =>
    Effect.sync(() => {
      assert.deepEqual(parseKeybindingShortcut("mod+j"), {
        key: "j",
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        modKey: true,
      });
      assert.deepEqual(parseKeybindingShortcut("mod++"), {
        key: "+",
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        modKey: true,
      });
    }),
  );

  it.effect("compiles valid rule with parsed when AST", () =>
    Effect.sync(() => {
      const compiled = compileResolvedKeybindingRule({
        key: "mod+d",
        command: "terminal.split",
        when: "terminalOpen && !terminalFocus",
      });

      assert.deepEqual(compiled, {
        command: "terminal.split",
        shortcut: {
          key: "d",
          metaKey: false,
          ctrlKey: false,
          shiftKey: false,
          altKey: false,
          modKey: true,
        },
        whenAst: {
          type: "and",
          left: { type: "identifier", name: "terminalOpen" },
          right: {
            type: "not",
            node: { type: "identifier", name: "terminalFocus" },
          },
        },
      });
    }),
  );

  it.effect("encodes resolved plus-key shortcuts", () =>
    Effect.gen(function* () {
      const encoded = yield* Schema.encodeEffect(ResolvedKeybindingFromConfig)({
        command: "terminal.toggle",
        shortcut: {
          key: "+",
          metaKey: false,
          ctrlKey: false,
          shiftKey: false,
          altKey: false,
          modKey: true,
        },
      });

      assert.equal(encoded.key, "mod++");
      assert.equal(encoded.command, "terminal.toggle");
    }),
  );

  it.effect("rejects invalid rules", () =>
    Effect.sync(() => {
      assert.isNull(
        compileResolvedKeybindingRule({
          key: "mod+shift+d+o",
          command: "terminal.new",
        }),
      );

      assert.isNull(
        compileResolvedKeybindingRule({
          key: "mod+d",
          command: "terminal.split",
          when: "terminalFocus && (",
        }),
      );

      assert.isNull(
        compileResolvedKeybindingRule({
          key: "mod+d",
          command: "terminal.split",
          when: `${"!".repeat(300)}terminalFocus`,
        }),
      );
    }),
  );

  it.effect("bootstraps default keybindings when config file is missing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath } = yield* ServerConfig;
      assert.isFalse(yield* fs.exists(keybindingsConfigPath));

      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        yield* keybindings.syncDefaultKeybindingsOnStartup;
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.deepEqual(persisted, DEFAULT_KEYBINDINGS);
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("ships configurable thread navigation defaults", () =>
    Effect.sync(() => {
      const defaultsByCommand = new Map(
        DEFAULT_KEYBINDINGS.map((binding) => [binding.command, binding.key] as const),
      );

      assert.equal(defaultsByCommand.get("thread.previous"), "mod+shift+[");
      assert.equal(defaultsByCommand.get("thread.next"), "mod+shift+]");
      assert.equal(defaultsByCommand.get("thread.jump.1"), "mod+1");
      assert.equal(defaultsByCommand.get("thread.jump.9"), "mod+9");
    }),
  );

  it.effect("ships defaults for the ported shortcut commands", () =>
    Effect.sync(() => {
      const rulesFor = (command: string) =>
        DEFAULT_KEYBINDINGS.filter((binding) => binding.command === command).map((binding) => ({
          key: binding.key,
          when: binding.when,
        }));

      assert.deepEqual(rulesFor("sidebar.toggle"), [{ key: "mod+b", when: "!terminalFocus" }]);
      assert.deepEqual(rulesFor("navigation.back"), [{ key: "mod+[", when: "!terminalFocus" }]);
      assert.deepEqual(rulesFor("navigation.forward"), [{ key: "mod+]", when: "!terminalFocus" }]);
      assert.deepEqual(rulesFor("diff.close"), [{ key: "mod+w", when: "!terminalFocus" }]);
      assert.deepEqual(rulesFor("modelPicker.toggle"), [
        { key: "mod+shift+m", when: "!terminalFocus" },
      ]);
      assert.deepEqual(rulesFor("composer.effort"), [
        { key: "mod+shift+e", when: "!terminalFocus" },
      ]);
      assert.deepEqual(rulesFor("composer.mode"), [{ key: "mod+shift+a", when: "!terminalFocus" }]);
      // Nothing handles these yet, so they ship without defaults (users can still bind them).
      assert.deepEqual(rulesFor("composer.workspace"), []);
      assert.deepEqual(rulesFor("composer.branch"), []);
      assert.deepEqual(rulesFor("composer.sendBackground"), [
        { key: "mod+enter", when: "composerFocus && draftThreadRoute" },
        { key: "mod+alt+enter", when: "composerFocus && draftThreadRoute" },
      ]);
      assert.deepEqual(rulesFor("composer.sendAndNewThread"), [
        { key: "mod+alt+enter", when: "composerFocus && !draftThreadRoute" },
      ]);
      assert.deepEqual(rulesFor("thread.stop"), [{ key: "mod+.", when: "!terminalFocus" }]);
      assert.deepEqual(rulesFor("thread.undo"), [
        { key: "mod+z", when: "!terminalFocus && !editableFocus" },
      ]);
    }),
  );

  it.effect("ships defaults for the upstream shortcut commands", () =>
    Effect.sync(() => {
      const expected: ReadonlyArray<{
        readonly command: KeybindingRule["command"];
        readonly rules: ReadonlyArray<{ readonly key: string; readonly when?: string }>;
      }> = [
        { command: "chat.find", rules: [{ key: "mod+f", when: "!terminalFocus" }] },
        { command: "workspace.focusNext", rules: [{ key: "f6" }, { key: "mod+f6" }] },
        {
          command: "workspace.focusPrevious",
          rules: [{ key: "shift+f6" }, { key: "mod+shift+f6" }],
        },
        { command: "commandPalette.toggle", rules: [{ key: "mod+k", when: "!terminalFocus" }] },
        { command: "filePicker.toggle", rules: [{ key: "mod+p", when: "!terminalFocus" }] },
        {
          command: "thread.copyReference",
          rules: [{ key: "mod+shift+c", when: "!terminalFocus" }],
        },
        { command: "thread.pin", rules: [{ key: "mod+shift+p", when: "!terminalFocus" }] },
        {
          command: "terminal.splitVertical",
          rules: [{ key: "mod+shift+d", when: "terminalFocus" }],
        },
      ];

      for (const { command, rules } of expected) {
        assert.deepEqual(
          DEFAULT_KEYBINDINGS.filter((binding) => binding.command === command).map(
            ({ key, when }) => (when === undefined ? { key } : { key, when }),
          ),
          rules,
          command,
        );
        // Each chord belongs to this command alone, whatever the context.
        for (const { key } of rules) {
          assert.deepEqual(
            DEFAULT_KEYBINDINGS.filter((binding) => binding.key === key).map(
              (binding) => binding.command,
            ),
            [command],
            key,
          );
        }
      }
    }),
  );

  it.effect("parses function-key default shortcuts", () =>
    Effect.sync(() => {
      assert.deepEqual(parseKeybindingShortcut("f6"), {
        key: "f6",
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        modKey: false,
      });
      assert.deepEqual(parseKeybindingShortcut("mod+shift+f6"), {
        key: "f6",
        metaKey: false,
        ctrlKey: false,
        shiftKey: true,
        altKey: false,
        modKey: true,
      });
    }),
  );

  it.effect("limits default thread jumps to the desktop app", () =>
    Effect.sync(() => {
      const jumps = DEFAULT_KEYBINDINGS.filter((binding) =>
        binding.command.startsWith("thread.jump."),
      );
      assert.equal(jumps.length, 9);
      for (const jump of jumps) {
        assert.equal(jump.when, THREAD_JUMP_DEFAULT_WHEN);
      }
      assert.equal(THREAD_JUMP_DEFAULT_WHEN, "!isWeb");
    }),
  );

  it.effect("compiles every default rule and has no shortcut/context collisions", () =>
    Effect.sync(() => {
      const compiled = compileResolvedKeybindingsConfig(DEFAULT_KEYBINDINGS);
      assert.equal(compiled.length, DEFAULT_KEYBINDINGS.length);

      const seen = new Map<string, string>();
      for (const rule of DEFAULT_KEYBINDINGS) {
        const shortcut = parseKeybindingShortcut(rule.key);
        assert.isNotNull(shortcut, `default key ${rule.key} should parse`);
        const identity = JSON.stringify([shortcut, rule.when ?? null]);
        const previous = seen.get(identity);
        assert.isUndefined(
          previous,
          `${rule.command} reuses ${rule.key} (${rule.when ?? "always"}) from ${previous}`,
        );
        seen.set(identity, rule.command);
      }
    }),
  );

  it.effect("migrates only exact legacy thread jump rules", () =>
    Effect.sync(() => {
      const legacy: KeybindingRule[] = [
        { key: "mod+1", command: "thread.jump.1" },
        { key: "mod+shift+2", command: "thread.jump.2" },
        { key: "mod+3", command: "thread.jump.3", when: "!terminalFocus" },
        { key: "mod+4", command: "thread.jump.5" },
        { key: "mod+j", command: "terminal.toggle" },
      ];
      const result = migrateLegacyThreadJumpDefaults(legacy);
      assert.isTrue(result.changed);
      assert.deepEqual(result.config, [
        { key: "mod+1", command: "thread.jump.1", when: "!isWeb" },
        { key: "mod+shift+2", command: "thread.jump.2" },
        { key: "mod+3", command: "thread.jump.3", when: "!terminalFocus" },
        { key: "mod+4", command: "thread.jump.5" },
        { key: "mod+j", command: "terminal.toggle" },
      ]);

      const untouched = migrateLegacyThreadJumpDefaults(result.config);
      assert.isFalse(untouched.changed);
      assert.strictEqual(untouched.config, result.config);
    }),
  );

  it.effect("rewrites legacy thread jump defaults on startup", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig;
      yield* writeKeybindingsConfig(
        keybindingsConfigPath,
        DEFAULT_KEYBINDINGS.map((rule) =>
          rule.command.startsWith("thread.jump.") ? { key: rule.key, command: rule.command } : rule,
        ),
      );

      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        yield* keybindings.syncDefaultKeybindingsOnStartup;
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.deepEqual(persisted, DEFAULT_KEYBINDINGS);
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("uses defaults in runtime when config is malformed without overriding file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath } = yield* ServerConfig;
      yield* fs.writeFileString(keybindingsConfigPath, "{ not-json");

      const configState = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        return yield* keybindings.loadConfigState;
      });

      assert.deepEqual(
        configState.keybindings,
        compileResolvedKeybindingsConfig(DEFAULT_KEYBINDINGS),
      );
      assert.deepEqual(configState.issues, [
        {
          kind: "keybindings.malformed-config",
          message: configState.issues[0]?.message ?? "",
        },
      ]);
      assert.equal(yield* fs.readFileString(keybindingsConfigPath), "{ not-json");
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("ignores invalid entries in runtime and reports them as issues", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath } = yield* ServerConfig;
      yield* fs.writeFileString(
        keybindingsConfigPath,
        JSON.stringify([
          { key: "mod+j", command: "terminal.toggle" },
          { key: "mod+shift+d+o", command: "terminal.new" },
          { key: "mod+x", command: "invalid.command" },
        ]),
      );

      const configState = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        return yield* keybindings.loadConfigState;
      });

      assert.isTrue(configState.keybindings.some((entry) => entry.command === "terminal.toggle"));
      assert.isFalse(
        configState.keybindings.some((entry) => String(entry.command) === "invalid.command"),
      );
      assert.deepEqual(configState.issues, [
        {
          kind: "keybindings.invalid-entry",
          index: 1,
          message: configState.issues[0]?.message ?? "",
        },
        {
          kind: "keybindings.invalid-entry",
          index: 2,
          message: configState.issues[1]?.message ?? "",
        },
      ]);
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect(
    "upserts missing default keybindings on startup without overriding existing command rules",
    () =>
      Effect.gen(function* () {
        const { keybindingsConfigPath } = yield* ServerConfig;
        yield* writeKeybindingsConfig(keybindingsConfigPath, [
          { key: "mod+shift+t", command: "terminal.toggle" },
          { key: "mod+shift+r", command: "script.run-tests.run" },
        ]);

        yield* Effect.gen(function* () {
          const keybindings = yield* Keybindings;
          yield* keybindings.syncDefaultKeybindingsOnStartup;
        });

        const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
        const byCommand = new Map(persisted.map((entry) => [entry.command, entry]));

        const persistedToggle = byCommand.get("terminal.toggle");
        assert.isNotNull(persistedToggle);
        assert.equal(persistedToggle?.key, "mod+shift+t");
        assert.isFalse(
          persisted.some((entry) => entry.command === "terminal.toggle" && entry.key === "mod+j"),
        );

        for (const defaultRule of DEFAULT_KEYBINDINGS) {
          assert.isTrue(byCommand.has(defaultRule.command), `expected ${defaultRule.command}`);
        }
        assert.isTrue(byCommand.has("script.run-tests.run"));
      }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("skips conflicting default keybindings on startup and logs a detailed warning", () => {
    const messages: string[] = [];
    const logger = Logger.make(({ message }) => {
      messages.push(String(message));
    });

    return Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+j", command: "script.custom-action.run" },
      ]);

      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        yield* keybindings.syncDefaultKeybindingsOnStartup;
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.isFalse(persisted.some((entry) => entry.command === "terminal.toggle"));
      assert.isTrue(persisted.some((entry) => entry.command === "script.custom-action.run"));

      assert.isTrue(
        messages.some((message) =>
          message.includes("skipping default keybinding due to shortcut conflict"),
        ),
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          makeKeybindingsLayer(),
          Logger.layer([logger], { mergeWithExisting: false }),
        ),
      ),
    );
  });

  it.effect("upserts custom keybindings to configured path", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+j", command: "terminal.toggle" },
      ]);

      const resolved = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        return yield* keybindings.upsertKeybindingRule({
          key: "mod+shift+r",
          command: "script.run-tests.run",
        });
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      const persistedView = persisted.map(({ key, command }) => ({ key, command }));

      assert.deepEqual(persistedView, [
        { key: "mod+j", command: "terminal.toggle" },
        { key: "mod+shift+r", command: "script.run-tests.run" },
      ]);
      assert.isTrue(resolved.some((entry) => entry.command === "script.run-tests.run"));
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("adds a second binding for a command without touching the first", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+n", command: "chat.new", when: "!terminalFocus" },
        { key: "mod+shift+o", command: "chat.new", when: "!terminalFocus" },
      ]);
      const keybindings = yield* Keybindings;
      yield* keybindings.upsertKeybindingRule({ key: "mod+shift+y", command: "chat.new" });
      // Saving an identical rule again does not duplicate it.
      yield* keybindings.upsertKeybindingRule({ key: "mod+shift+y", command: "chat.new" });

      assert.deepEqual(yield* readKeybindingsConfig(keybindingsConfigPath), [
        { key: "mod+n", command: "chat.new", when: "!terminalFocus" },
        { key: "mod+shift+o", command: "chat.new", when: "!terminalFocus" },
        { key: "mod+shift+y", command: "chat.new" },
      ]);
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("replaces only the targeted rule when editing one of a command's bindings", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+n", command: "chat.new", when: "!terminalFocus" },
        { key: "mod+shift+o", command: "chat.new", when: "!terminalFocus" },
      ]);
      const keybindings = yield* Keybindings;
      yield* keybindings.upsertKeybindingRule({
        key: "mod+shift+y",
        command: "chat.new",
        when: "!terminalFocus",
        replace: { key: "mod+n", command: "chat.new", when: "!terminalFocus" },
      });

      assert.deepEqual(yield* readKeybindingsConfig(keybindingsConfigPath), [
        { key: "mod+shift+o", command: "chat.new", when: "!terminalFocus" },
        { key: "mod+shift+y", command: "chat.new", when: "!terminalFocus" },
      ]);
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("does not duplicate a rule when an edit lands on another binding of the command", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+n", command: "chat.new" },
        { key: "mod+shift+y", command: "chat.new" },
      ]);
      const keybindings = yield* Keybindings;
      yield* keybindings.upsertKeybindingRule({
        key: "mod+n",
        command: "chat.new",
        replace: { key: "mod+shift+y", command: "chat.new" },
      });

      assert.deepEqual(yield* readKeybindingsConfig(keybindingsConfigPath), [
        { key: "mod+n", command: "chat.new" },
      ]);
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("matches replace and remove targets against hand-written spellings", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "cmd+shift+k", command: "chat.new", when: "terminalOpen&&!terminalFocus" },
        { key: "control+option+j", command: "terminal.toggle", when: "(terminalOpen)" },
      ]);
      const keybindings = yield* Keybindings;
      yield* keybindings.upsertKeybindingRule({
        key: "mod+y",
        command: "chat.new",
        replace: {
          key: "meta+shift+k",
          command: "chat.new",
          when: "terminalOpen && !terminalFocus",
        },
      });
      yield* keybindings.removeKeybindingRule({
        key: "ctrl+alt+j",
        command: "terminal.toggle",
        when: "terminalOpen",
      });

      assert.deepEqual(yield* readKeybindingsConfig(keybindingsConfigPath), [
        { key: "mod+y", command: "chat.new" },
      ]);
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("removes one rule and restores a command's defaults with its last rule", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+shift+t", command: "terminal.toggle" },
        { key: "mod+shift+u", command: "terminal.toggle" },
      ]);
      const keybindings = yield* Keybindings;

      const afterFirst = yield* keybindings.removeKeybindingRule({
        key: "mod+shift+t",
        command: "terminal.toggle",
      });
      assert.deepEqual(yield* readKeybindingsConfig(keybindingsConfigPath), [
        { key: "mod+shift+u", command: "terminal.toggle" },
      ]);
      assert.deepEqual(afterFirst.filter((entry) => entry.command === "terminal.toggle").length, 1);

      const afterLast = yield* keybindings.removeKeybindingRule({
        key: "mod+shift+u",
        command: "terminal.toggle",
      });
      assert.deepEqual(
        afterLast
          .filter((entry) => entry.command === "terminal.toggle")
          .map((entry) => entry.shortcut.key),
        ["j"],
      );
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("keeps entries it cannot decode when removing a keybinding", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath } = yield* ServerConfig;
      const futureCommand = { key: "mod+shift+k", command: "command.from-a-newer-build" };
      yield* fs.writeFileString(
        keybindingsConfigPath,
        JSON.stringify([{ key: "mod+r", command: "script.run-tests.run" }, futureCommand]),
      );
      const keybindings = yield* Keybindings;
      yield* keybindings.removeKeybindingRule({ key: "mod+r", command: "script.run-tests.run" });

      assert.deepEqual(JSON.parse(yield* fs.readFileString(keybindingsConfigPath)), [
        futureCommand,
      ]);
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("puts backfilled defaults before persisted rules so custom rules keep priority", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig;
      const custom: KeybindingRule = { key: "mod+shift+a", command: "script.format.run" };
      yield* writeKeybindingsConfig(keybindingsConfigPath, [custom]);

      yield* (yield* Keybindings).syncDefaultKeybindingsOnStartup;

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.deepEqual(persisted.at(-1), custom);
      assert.deepEqual(persisted.slice(0, -1), DEFAULT_KEYBINDINGS);
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("leaves a full config intact and logs the defaults it skipped", () => {
    const messages: string[] = [];
    const logger = Logger.make(({ message }) => {
      messages.push(String(message));
    });
    return Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig;
      const custom = scriptRules(MAX_KEYBINDINGS_COUNT);
      yield* writeKeybindingsConfig(keybindingsConfigPath, custom);

      yield* (yield* Keybindings).syncDefaultKeybindingsOnStartup;

      assert.deepEqual(yield* readKeybindingsConfig(keybindingsConfigPath), custom);
      assert.isTrue(
        messages.some((message) => message.includes("skipping default keybinding backfill")),
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          makeKeybindingsLayer(),
          Logger.layer([logger], { mergeWithExisting: false }),
        ),
      ),
    );
  });

  it.effect("adds only the defaults that fit near the cap", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig;
      const custom = scriptRules(MAX_KEYBINDINGS_COUNT - 2);
      yield* writeKeybindingsConfig(keybindingsConfigPath, custom);

      yield* (yield* Keybindings).syncDefaultKeybindingsOnStartup;

      assert.deepEqual(yield* readKeybindingsConfig(keybindingsConfigPath), [
        ...DEFAULT_KEYBINDINGS.filter(
          (rule) => rule.command === "sidebar.toggle" || rule.command === "navigation.back",
        ),
        ...custom,
      ]);
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("never splits a command's defaults at the cap, so a later start adds them all", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig;
      const keybindings = yield* Keybindings;
      const custom = scriptRules(MAX_KEYBINDINGS_COUNT - 2);
      yield* writeKeybindingsConfig(keybindingsConfigPath, custom);

      yield* keybindings.syncDefaultKeybindingsOnStartup;
      const commandsAfterCap = (yield* readKeybindingsConfig(keybindingsConfigPath)).map(
        (rule) => rule.command,
      );
      assert.isFalse(commandsAfterCap.includes("workspace.focusNext"));

      yield* writeKeybindingsConfig(keybindingsConfigPath, custom.slice(0, 10));
      yield* keybindings.syncDefaultKeybindingsOnStartup;
      const focusNextKeys = (yield* readKeybindingsConfig(keybindingsConfigPath))
        .filter((rule) => rule.command === "workspace.focusNext")
        .map((rule) => rule.key);
      assert.deepEqual(focusNextKeys, ["f6", "mod+f6"]);
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("keeps a command's other defaults when one is replaced and none are on disk", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig;
      const keybindings = yield* Keybindings;
      yield* writeKeybindingsConfig(keybindingsConfigPath, scriptRules(1));

      yield* keybindings.upsertKeybindingRule({
        key: "mod+alt+f6",
        command: "workspace.focusNext",
        replace: { key: "f6", command: "workspace.focusNext" },
      });

      const focusNextKeys = (yield* readKeybindingsConfig(keybindingsConfigPath))
        .filter((rule) => rule.command === "workspace.focusNext")
        .map((rule) => rule.key);
      assert.deepEqual(focusNextKeys, ["mod+f6", "mod+alt+f6"]);
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("keeps a command's defaults when a binding is added beside them", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig;
      const keybindings = yield* Keybindings;
      yield* writeKeybindingsConfig(keybindingsConfigPath, scriptRules(1));

      yield* keybindings.upsertKeybindingRule({ key: "mod+alt+n", command: "chat.new" });

      const chatNewKeys = (yield* readKeybindingsConfig(keybindingsConfigPath))
        .filter((rule) => rule.command === "chat.new")
        .map((rule) => rule.key);
      assert.deepEqual(chatNewKeys, ["mod+n", "mod+shift+o", "mod+alt+n"]);
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("still saves the thread jump migration when no default fits", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig;
      const custom = scriptRules(MAX_KEYBINDINGS_COUNT - 1);
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+1", command: "thread.jump.1" },
        ...custom,
      ]);

      yield* (yield* Keybindings).syncDefaultKeybindingsOnStartup;

      assert.deepEqual(yield* readKeybindingsConfig(keybindingsConfigPath), [
        { key: "mod+1", command: "thread.jump.1", when: THREAD_JUMP_DEFAULT_WHEN },
        ...custom,
      ]);
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("refuses to overwrite malformed keybindings config", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath } = yield* ServerConfig;
      yield* fs.writeFileString(keybindingsConfigPath, "{ not-json");

      const result = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        return yield* keybindings.upsertKeybindingRule({
          key: "mod+shift+r",
          command: "script.run-tests.run",
        });
      }).pipe(toDetailResult);
      assertFailure(result, "expected JSON array");

      const persistedRaw = yield* fs.readFileString(keybindingsConfigPath);
      assert.equal(persistedRaw, "{ not-json");
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("retries a failed config read instead of keeping the failure", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath } = yield* ServerConfig;
      // A directory where the file should be makes the read itself fail.
      yield* fs.makeDirectory(keybindingsConfigPath, { recursive: true });

      const keybindings = yield* Keybindings;
      const failed = yield* toDetailResult(keybindings.loadConfigState);
      assertFailure(failed, "failed to read keybindings config");

      yield* fs.remove(keybindingsConfigPath, { recursive: true });
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+j", command: "terminal.toggle" },
      ]);

      const configState = yield* keybindings.loadConfigState;
      assert.deepEqual(configState.issues, []);
      assert.isTrue(configState.keybindings.some((entry) => entry.command === "terminal.toggle"));
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("reports non-array config parse errors without duplicate prefix", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath } = yield* ServerConfig;
      yield* fs.writeFileString(
        keybindingsConfigPath,
        '{"key":"mod+j","command":"terminal.toggle"}',
      );

      const firstResult = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        return yield* keybindings.upsertKeybindingRule({
          key: "mod+shift+r",
          command: "script.run-tests.run",
        });
      }).pipe(toDetailResult);
      assertFailure(firstResult, "expected JSON array");

      const secondResult = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        return yield* keybindings.upsertKeybindingRule({
          key: "mod+shift+r",
          command: "script.run-tests.run",
        });
      }).pipe(toDetailResult);
      assertFailure(secondResult, "expected JSON array");
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("fails when config directory is not writable", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath } = yield* ServerConfig;
      const { dirname } = yield* Path.Path;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+j", command: "terminal.toggle" },
      ]);
      yield* fs.chmod(dirname(keybindingsConfigPath), 0o500);

      const result = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        return yield* keybindings.upsertKeybindingRule({
          key: "mod+shift+r",
          command: "script.run-tests.run",
        });
      }).pipe(toDetailResult);
      assertFailure(result, "failed to write keybindings config");

      yield* fs.chmod(dirname(keybindingsConfigPath), 0o700);

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      const persistedView = persisted.map(({ key, command }) => ({ key, command }));
      assert.deepEqual(persistedView, [{ key: "mod+j", command: "terminal.toggle" }]);
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("caches loaded resolved config across repeated reads", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+j", command: "terminal.toggle" },
      ]);

      const [first, second] = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        const firstLoad = (yield* keybindings.loadConfigState).keybindings;
        const secondLoad = (yield* keybindings.loadConfigState).keybindings;
        return [firstLoad, secondLoad] as const;
      });

      assert.deepEqual(first, second);
      assert.isTrue(second.some((entry) => entry.command === "terminal.toggle"));
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("updates cached resolved config after upsert", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+j", command: "terminal.toggle" },
      ]);

      const loadedAfterUpsert = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        yield* keybindings.loadConfigState;
        yield* keybindings.upsertKeybindingRule({
          key: "mod+shift+r",
          command: "script.run-tests.run",
        });
        return (yield* keybindings.loadConfigState).keybindings;
      });

      assert.isTrue(loadedAfterUpsert.some((entry) => entry.command === "script.run-tests.run"));
      assert.isTrue(loadedAfterUpsert.some((entry) => entry.command === "terminal.toggle"));
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("serializes concurrent upserts to avoid lost updates", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, []);

      const commands = Array.from(
        { length: 20 },
        (_, index): KeybindingCommand => `script.concurrent-${index}.run`,
      );
      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        yield* Effect.all(
          commands.map((command, index) =>
            keybindings.upsertKeybindingRule({
              key: `mod+${String.fromCharCode(97 + index)}`,
              command,
            }),
          ),
          { concurrency: "unbounded", discard: true },
        );
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      const persistedCommands = new Set(persisted.map((entry) => entry.command));
      for (const command of commands) {
        assert.isTrue(persistedCommands.has(command), `expected persisted command ${command}`);
      }
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );
  it.effect("keeps entries it cannot decode when upserting another keybinding", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath } = yield* ServerConfig;
      const futureCommand = { key: "mod+shift+k", command: "command.from-a-newer-build" };
      const badShortcut = { key: "mod+shift+d+o", command: "terminal.new" };
      yield* fs.writeFileString(
        keybindingsConfigPath,
        JSON.stringify([
          { key: "mod+r", command: "script.run-tests.run" },
          futureCommand,
          badShortcut,
        ]),
      );
      const keybindings = yield* Keybindings;

      yield* keybindings.upsertKeybindingRule({
        key: "mod+shift+r",
        command: "script.run-tests.run",
      });

      assert.deepEqual(JSON.parse(yield* fs.readFileString(keybindingsConfigPath)), [
        { key: "mod+r", command: "script.run-tests.run" },
        futureCommand,
        badShortcut,
        { key: "mod+shift+r", command: "script.run-tests.run" },
      ]);
      const { issues } = yield* keybindings.loadConfigState;
      assert.deepEqual(
        issues.map((issue) => (issue.kind === "keybindings.invalid-entry" ? issue.index : null)),
        [1, 2],
      );
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("upserts through a symlinked config file without replacing the link", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { keybindingsConfigPath } = yield* ServerConfig;
      const dotfiles = yield* fs.makeTempDirectoryScoped({
        prefix: "piedpiper-keybindings-dotfiles-",
      });
      const linkedConfigPath = path.join(dotfiles, "keybindings.json");
      yield* writeKeybindingsConfig(linkedConfigPath, [
        { key: "mod+j", command: "terminal.toggle" },
      ]);
      yield* fs.makeDirectory(path.dirname(keybindingsConfigPath), { recursive: true });
      yield* fs.remove(keybindingsConfigPath, { force: true });
      yield* fs.symlink(linkedConfigPath, keybindingsConfigPath);

      const keybindings = yield* Keybindings;
      yield* keybindings.upsertKeybindingRule({
        key: "mod+shift+r",
        command: "script.run-tests.run",
      });

      assert.equal(yield* fs.readLink(keybindingsConfigPath), linkedConfigPath);
      const persisted = yield* readKeybindingsConfig(linkedConfigPath);
      assert.deepEqual(
        persisted.map(({ key, command }) => ({ key, command })),
        [
          { key: "mod+j", command: "terminal.toggle" },
          { key: "mod+shift+r", command: "script.run-tests.run" },
        ],
      );
    }).pipe(Effect.scoped, Effect.provide(makeKeybindingsLayer())),
  );
});

it.live("emits one change for a save despite the watcher seeing the same write", () =>
  Effect.gen(function* () {
    const { keybindingsConfigPath } = yield* ServerConfig;
    yield* writeKeybindingsConfig(keybindingsConfigPath, DEFAULT_KEYBINDINGS);
    const keybindings = yield* Keybindings;
    yield* keybindings.start;

    const events = yield* Ref.make(0);
    yield* keybindings.streamChanges.pipe(
      Stream.runForEach(() => Ref.update(events, (count) => count + 1)),
      Effect.forkScoped,
    );
    yield* Effect.sleep("50 millis");
    yield* keybindings.upsertKeybindingRule({ key: "mod+shift+y", command: "chat.new" });
    yield* Effect.sleep("400 millis");
    assert.equal(yield* Ref.get(events), 1);

    // A hand edit still reports its change.
    yield* writeKeybindingsConfig(keybindingsConfigPath, [
      { key: "mod+shift+u", command: "chat.new" },
    ]);
    yield* Effect.sleep("400 millis");
    assert.equal(yield* Ref.get(events), 2);
  }).pipe(
    Effect.scoped,
    Effect.provide(makeKeybindingsLayer().pipe(Layer.provideMerge(NodeServices.layer))),
  ),
);
