import { Schema } from "effect";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  COMPOSER_CONTROL_KEYBINDING_COMMANDS,
  COMPOSER_SEND_KEYBINDING_COMMANDS,
  KeybindingsConfig,
  NAVIGATION_KEYBINDING_COMMANDS,
  KeybindingRule,
  KeybindingRuleUpsert,
  ResolvedKeybindingRule,
  ResolvedKeybindingsConfig,
  STATIC_KEYBINDING_COMMANDS,
} from "../src/keybindings";

const decode = <S extends Schema.Top>(
  schema: S,
  input: unknown,
): Effect.Effect<Schema.Schema.Type<S>, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(schema as never)(input) as Effect.Effect<
    Schema.Schema.Type<S>,
    Schema.SchemaError,
    never
  >;

const decodeResolvedRule = Schema.decodeUnknownEffect(ResolvedKeybindingRule as never);

it.effect("parses keybinding rules", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(KeybindingRule, {
      key: "mod+j",
      command: "terminal.toggle",
    });
    assert.strictEqual(parsed.command, "terminal.toggle");

    const parsedClose = yield* decode(KeybindingRule, {
      key: "mod+w",
      command: "terminal.close",
    });
    assert.strictEqual(parsedClose.command, "terminal.close");

    const parsedDiffToggle = yield* decode(KeybindingRule, {
      key: "mod+d",
      command: "diff.toggle",
    });
    assert.strictEqual(parsedDiffToggle.command, "diff.toggle");

    const parsedLocal = yield* decode(KeybindingRule, {
      key: "mod+shift+n",
      command: "chat.newLocal",
    });
    assert.strictEqual(parsedLocal.command, "chat.newLocal");

    const parsedThreadPrevious = yield* decode(KeybindingRule, {
      key: "mod+shift+[",
      command: "thread.previous",
    });
    assert.strictEqual(parsedThreadPrevious.command, "thread.previous");
  }),
);

it.effect("parses the ported shortcut commands", () =>
  Effect.gen(function* () {
    const commands = [
      "sidebar.toggle",
      "navigation.back",
      "navigation.forward",
      "diff.close",
      "modelPicker.toggle",
      "composer.effort",
      "composer.mode",
      "composer.workspace",
      "composer.branch",
      "composer.sendBackground",
      "composer.sendAndNewThread",
      "thread.stop",
      "thread.undo",
    ] as const;
    for (const command of commands) {
      const parsed = yield* decode(KeybindingRule, {
        key: "mod+k",
        command,
        when: "isDesktop",
      });
      assert.strictEqual(parsed.command, command);
    }
    assert.deepEqual(
      [...COMPOSER_CONTROL_KEYBINDING_COMMANDS, ...COMPOSER_SEND_KEYBINDING_COMMANDS],
      commands.slice(4, 11),
    );
    assert.deepEqual(
      [...NAVIGATION_KEYBINDING_COMMANDS],
      ["navigation.back", "navigation.forward"],
    );
  }),
);

it.effect("parses the upstream shortcut commands", () =>
  Effect.gen(function* () {
    const commands = [
      "chat.find",
      "workspace.focusNext",
      "workspace.focusPrevious",
      "commandPalette.toggle",
      "filePicker.toggle",
      "thread.copyReference",
      "thread.pin",
      "terminal.splitVertical",
    ] as const;
    const staticCommands: ReadonlyArray<string> = STATIC_KEYBINDING_COMMANDS;
    for (const command of commands) {
      const parsed = yield* decode(KeybindingRule, { key: "mod+k", command });
      assert.strictEqual(parsed.command, command);
      assert.include(staticCommands, command);
    }
  }),
);

it.effect("lists each static command once", () =>
  Effect.sync(() => {
    assert.strictEqual(new Set(STATIC_KEYBINDING_COMMANDS).size, STATIC_KEYBINDING_COMMANDS.length);
  }),
);

it.effect("rejects invalid command values", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decode(KeybindingRule, {
        key: "mod+j",
        command: "script.Test.run",
      }),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("accepts dynamic script run commands", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(KeybindingRule, {
      key: "mod+r",
      command: "script.setup.run",
    });
    assert.strictEqual(parsed.command, "script.setup.run");
  }),
);

it.effect("parses a rule upsert with and without the rule it replaces", () =>
  Effect.gen(function* () {
    const added = yield* decode(KeybindingRuleUpsert, { key: "mod+j", command: "chat.new" });
    assert.strictEqual(added.replace, undefined);

    const edited = yield* decode(KeybindingRuleUpsert, {
      key: "mod+j",
      command: "chat.new",
      when: "!terminalFocus",
      replace: { key: "mod+n", command: "chat.new", when: "!terminalFocus" },
    });
    assert.strictEqual(edited.replace?.key, "mod+n");
  }),
);

it.effect("parses keybindings array payload", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(KeybindingsConfig, [
      { key: "mod+j", command: "terminal.toggle" },
      { key: "mod+d", command: "terminal.split", when: "terminalFocus" },
    ]);
    assert.lengthOf(parsed, 2);
  }),
);

it.effect("parses resolved keybinding rules", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(ResolvedKeybindingRule, {
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
    assert.strictEqual(parsed.shortcut.key, "d");
  }),
);

it.effect("parses resolved keybindings arrays", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(ResolvedKeybindingsConfig, [
      {
        command: "terminal.toggle",
        shortcut: {
          key: "j",
          metaKey: false,
          ctrlKey: false,
          shiftKey: false,
          altKey: false,
          modKey: true,
        },
      },
      {
        command: "thread.jump.3",
        shortcut: {
          key: "3",
          metaKey: false,
          ctrlKey: false,
          shiftKey: false,
          altKey: false,
          modKey: true,
        },
      },
    ]);
    assert.lengthOf(parsed, 2);
  }),
);

it.effect("drops unknown fields in resolved keybinding rules", () =>
  decodeResolvedRule({
    command: "terminal.toggle",
    shortcut: {
      key: "j",
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      modKey: true,
    },
    key: "mod+j",
  }).pipe(
    Effect.map((parsed) => {
      const view = parsed as Record<string, unknown>;
      assert.strictEqual("key" in view, false);
      assert.strictEqual(view.command, "terminal.toggle");
    }),
  ),
);
