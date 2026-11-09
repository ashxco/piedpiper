import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, Fiber, FileSystem, Layer, Path } from "effect";
import { TestClock } from "effect/testing";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect, it as vitestIt } from "vitest";

import { ServerConfig } from "../../config.ts";
import { TextGeneration } from "../Services/TextGeneration.ts";
import { sanitizeThreadTitle } from "../Utils.ts";
import {
  ClaudeTextGenerationLive,
  claudeManagedMcpConfigPath,
  claudeMcpIsolationArgs,
} from "./ClaudeTextGeneration.ts";
import { ServerSettingsService } from "../../serverSettings.ts";

const ClaudeTextGenerationTestLayer = ClaudeTextGenerationLive.pipe(
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), {
      prefix: "piedpiper-claude-text-generation-test-",
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

function makeFakeClaudeBinary(dir: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const binDir = path.join(dir, "bin");
    const claudePath = path.join(binDir, "claude");
    yield* fs.makeDirectory(binDir, { recursive: true });

    yield* fs.writeFileString(
      claudePath,
      [
        "#!/bin/sh",
        'args="$*"',
        'if [ -n "$FAKE_CLAUDE_TEXTGEN_ENV_CAPTURE" ]; then',
        '  printf "%s\\n%s\\n" "$CLAUDE_CONFIG_DIR" "$HOME" > "$FAKE_CLAUDE_TEXTGEN_ENV_CAPTURE"',
        "fi",
        'stdin_content="$(cat)"',
        'if [ -n "$FAKE_CLAUDE_TEXTGEN_HANG_MARKER" ]; then',
        "  trap '' TERM",
        '  : > "$FAKE_CLAUDE_TEXTGEN_HANG_MARKER"',
        "  sleep 600",
        "  exit 0",
        "fi",
        'case " $* " in *" --no-session-persistence "*)',
        '  if [ "$FAKE_CLAUDE_TEXTGEN_REJECTS_NO_SESSION_PERSISTENCE" = 1 ]; then',
        '    printf "%s\\n" "error: unknown option \'--no-session-persistence\'" >&2; exit 1',
        "  fi;;",
        "*)",
        '  if [ "$FAKE_CLAUDE_TEXTGEN_REJECTS_NO_SESSION_PERSISTENCE" != 1 ]; then',
        '    printf "%s\\n" "text generation must not save a resumable session" >&2; exit 16',
        "  fi;;",
        "esac",
        'tools_empty=0; settings_json=""; permission_mode=""; prev=""',
        'for arg in "$@"; do',
        '  if [ "$prev" = "--tools" ] && [ -z "$arg" ]; then tools_empty=1; fi',
        '  if [ "$prev" = "--permission-mode" ]; then permission_mode="$arg"; fi',
        '  if [ "$prev" = "--settings" ]; then settings_json="$arg"; fi',
        '  if [ "$arg" = "--dangerously-skip-permissions" ]; then',
        '    printf "%s\\n" "text generation must not bypass permissions" >&2; exit 7',
        "  fi",
        '  prev="$arg"',
        "done",
        'if [ "$permission_mode" != "dontAsk" ]; then',
        '  printf "%s\\n" "text generation must deny permission prompts" >&2; exit 12',
        "fi",
        'if [ "$tools_empty" != 1 ]; then',
        '  printf "%s\\n" "text generation must receive an explicit empty tool set" >&2; exit 6',
        "fi",
        'case " $* " in *" --disable-slash-commands "*) ;; *)',
        '  printf "%s\\n" "text generation must disable skills" >&2; exit 8;;',
        "esac",
        // A managed-mcp.json on this machine already isolates MCP servers, and the CLI refuses the flag.
        `if [ ! -e '${claudeManagedMcpConfigPath(process.platform)}' ]; then`,
        '  case " $* " in *" --strict-mcp-config "*) ;; *)',
        '    printf "%s\\n" "text generation must not load configured MCP servers" >&2; exit 9;;',
        "  esac",
        "fi",
        'case "$settings_json" in *\'"disableAllHooks":true\'*) ;; *)',
        '  printf "%s\\n" "text generation must disable hooks" >&2; exit 10;;',
        "esac",
        'if [ -n "$CLAUDE_CODE_SESSION_ID" ] || [ -n "$PIEDPIPER_TEXTGEN_ENV_PROBE" ] || [ -z "$PATH" ]; then',
        '  printf "%s\\n" "text generation leaked the host session env" >&2; exit 13',
        "fi",
        'if [ -n "$FAKE_CLAUDE_TEXTGEN_CWD_MUST_NOT_BE" ]; then',
        '  if [ "$(pwd -P)" = "$(cd "$FAKE_CLAUDE_TEXTGEN_CWD_MUST_NOT_BE" && pwd -P)" ]; then',
        '    printf "%s\\n" "text generation ran in the project directory" >&2; exit 11',
        "  fi",
        "fi",
        'if [ -n "$FAKE_CLAUDE_TEXTGEN_ARGS_MUST_CONTAIN" ]; then',
        '  printf "%s" "$args" | grep -F -- "$FAKE_CLAUDE_TEXTGEN_ARGS_MUST_CONTAIN" >/dev/null || {',
        '    printf "%s\\n" "args missing expected content" >&2',
        "    exit 2",
        "  }",
        "fi",
        'if [ -n "$FAKE_CLAUDE_TEXTGEN_ARGS_MUST_NOT_CONTAIN" ]; then',
        '  if printf "%s" "$args" | grep -F -- "$FAKE_CLAUDE_TEXTGEN_ARGS_MUST_NOT_CONTAIN" >/dev/null; then',
        '    printf "%s\\n" "args contained forbidden content" >&2',
        "    exit 3",
        "  fi",
        "fi",
        'if [ -n "$FAKE_CLAUDE_TEXTGEN_STDIN_MUST_CONTAIN" ]; then',
        '  printf "%s" "$stdin_content" | grep -F -- "$FAKE_CLAUDE_TEXTGEN_STDIN_MUST_CONTAIN" >/dev/null || {',
        '    printf "%s\\n" "stdin missing expected content" >&2',
        "    exit 4",
        "  }",
        "fi",
        'if [ -n "$FAKE_CLAUDE_TEXTGEN_STDERR" ]; then',
        '  printf "%s\\n" "$FAKE_CLAUDE_TEXTGEN_STDERR" >&2',
        "fi",
        'printf "%s" "$FAKE_CLAUDE_TEXTGEN_OUTPUT"',
        'exit "${FAKE_CLAUDE_TEXTGEN_EXIT_CODE:-0}"',
        "",
      ].join("\n"),
    );
    yield* fs.chmod(claudePath, 0o755);
    return binDir;
  });
}

function withFakeClaudeEnv<A, E, R>(
  input: {
    output: string;
    exitCode?: number;
    stderr?: string;
    argsMustContain?: string;
    argsMustNotContain?: string;
    stdinMustContain?: string;
    cwdMustNotBe?: string;
    rejectsNoSessionPersistence?: boolean;
    hangMarker?: string;
  },
  effect: Effect.Effect<A, E, R>,
) {
  return Effect.acquireUseRelease(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "piedpiper-claude-text-" });
      const binDir = yield* makeFakeClaudeBinary(tempDir);
      const previousPath = process.env.PATH;
      const previousOutput = process.env.FAKE_CLAUDE_TEXTGEN_OUTPUT;
      const previousExitCode = process.env.FAKE_CLAUDE_TEXTGEN_EXIT_CODE;
      const previousStderr = process.env.FAKE_CLAUDE_TEXTGEN_STDERR;
      const previousArgsMustContain = process.env.FAKE_CLAUDE_TEXTGEN_ARGS_MUST_CONTAIN;
      const previousArgsMustNotContain = process.env.FAKE_CLAUDE_TEXTGEN_ARGS_MUST_NOT_CONTAIN;
      const previousStdinMustContain = process.env.FAKE_CLAUDE_TEXTGEN_STDIN_MUST_CONTAIN;
      const previousCwdMustNotBe = process.env.FAKE_CLAUDE_TEXTGEN_CWD_MUST_NOT_BE;
      const previousRejectsNoSessionPersistence =
        process.env.FAKE_CLAUDE_TEXTGEN_REJECTS_NO_SESSION_PERSISTENCE;
      const previousHangMarker = process.env.FAKE_CLAUDE_TEXTGEN_HANG_MARKER;

      yield* Effect.sync(() => {
        process.env.PATH = `${binDir}:${previousPath ?? ""}`;
        process.env.FAKE_CLAUDE_TEXTGEN_OUTPUT = input.output;

        if (input.exitCode !== undefined) {
          process.env.FAKE_CLAUDE_TEXTGEN_EXIT_CODE = String(input.exitCode);
        } else {
          delete process.env.FAKE_CLAUDE_TEXTGEN_EXIT_CODE;
        }

        if (input.stderr !== undefined) {
          process.env.FAKE_CLAUDE_TEXTGEN_STDERR = input.stderr;
        } else {
          delete process.env.FAKE_CLAUDE_TEXTGEN_STDERR;
        }

        if (input.argsMustContain !== undefined) {
          process.env.FAKE_CLAUDE_TEXTGEN_ARGS_MUST_CONTAIN = input.argsMustContain;
        } else {
          delete process.env.FAKE_CLAUDE_TEXTGEN_ARGS_MUST_CONTAIN;
        }

        if (input.argsMustNotContain !== undefined) {
          process.env.FAKE_CLAUDE_TEXTGEN_ARGS_MUST_NOT_CONTAIN = input.argsMustNotContain;
        } else {
          delete process.env.FAKE_CLAUDE_TEXTGEN_ARGS_MUST_NOT_CONTAIN;
        }

        if (input.stdinMustContain !== undefined) {
          process.env.FAKE_CLAUDE_TEXTGEN_STDIN_MUST_CONTAIN = input.stdinMustContain;
        } else {
          delete process.env.FAKE_CLAUDE_TEXTGEN_STDIN_MUST_CONTAIN;
        }

        if (input.cwdMustNotBe !== undefined) {
          process.env.FAKE_CLAUDE_TEXTGEN_CWD_MUST_NOT_BE = input.cwdMustNotBe;
        } else {
          delete process.env.FAKE_CLAUDE_TEXTGEN_CWD_MUST_NOT_BE;
        }

        if (input.rejectsNoSessionPersistence) {
          process.env.FAKE_CLAUDE_TEXTGEN_REJECTS_NO_SESSION_PERSISTENCE = "1";
        } else {
          delete process.env.FAKE_CLAUDE_TEXTGEN_REJECTS_NO_SESSION_PERSISTENCE;
        }

        if (input.hangMarker !== undefined) {
          process.env.FAKE_CLAUDE_TEXTGEN_HANG_MARKER = input.hangMarker;
        } else {
          delete process.env.FAKE_CLAUDE_TEXTGEN_HANG_MARKER;
        }
      });

      return {
        previousPath,
        previousOutput,
        previousExitCode,
        previousStderr,
        previousArgsMustContain,
        previousArgsMustNotContain,
        previousStdinMustContain,
        previousCwdMustNotBe,
        previousRejectsNoSessionPersistence,
        previousHangMarker,
      };
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        process.env.PATH = previous.previousPath;

        if (previous.previousOutput === undefined) {
          delete process.env.FAKE_CLAUDE_TEXTGEN_OUTPUT;
        } else {
          process.env.FAKE_CLAUDE_TEXTGEN_OUTPUT = previous.previousOutput;
        }

        if (previous.previousExitCode === undefined) {
          delete process.env.FAKE_CLAUDE_TEXTGEN_EXIT_CODE;
        } else {
          process.env.FAKE_CLAUDE_TEXTGEN_EXIT_CODE = previous.previousExitCode;
        }

        if (previous.previousStderr === undefined) {
          delete process.env.FAKE_CLAUDE_TEXTGEN_STDERR;
        } else {
          process.env.FAKE_CLAUDE_TEXTGEN_STDERR = previous.previousStderr;
        }

        if (previous.previousArgsMustContain === undefined) {
          delete process.env.FAKE_CLAUDE_TEXTGEN_ARGS_MUST_CONTAIN;
        } else {
          process.env.FAKE_CLAUDE_TEXTGEN_ARGS_MUST_CONTAIN = previous.previousArgsMustContain;
        }

        if (previous.previousArgsMustNotContain === undefined) {
          delete process.env.FAKE_CLAUDE_TEXTGEN_ARGS_MUST_NOT_CONTAIN;
        } else {
          process.env.FAKE_CLAUDE_TEXTGEN_ARGS_MUST_NOT_CONTAIN =
            previous.previousArgsMustNotContain;
        }

        if (previous.previousStdinMustContain === undefined) {
          delete process.env.FAKE_CLAUDE_TEXTGEN_STDIN_MUST_CONTAIN;
        } else {
          process.env.FAKE_CLAUDE_TEXTGEN_STDIN_MUST_CONTAIN = previous.previousStdinMustContain;
        }

        if (previous.previousCwdMustNotBe === undefined) {
          delete process.env.FAKE_CLAUDE_TEXTGEN_CWD_MUST_NOT_BE;
        } else {
          process.env.FAKE_CLAUDE_TEXTGEN_CWD_MUST_NOT_BE = previous.previousCwdMustNotBe;
        }

        if (previous.previousRejectsNoSessionPersistence === undefined) {
          delete process.env.FAKE_CLAUDE_TEXTGEN_REJECTS_NO_SESSION_PERSISTENCE;
        } else {
          process.env.FAKE_CLAUDE_TEXTGEN_REJECTS_NO_SESSION_PERSISTENCE =
            previous.previousRejectsNoSessionPersistence;
        }

        if (previous.previousHangMarker === undefined) {
          delete process.env.FAKE_CLAUDE_TEXTGEN_HANG_MARKER;
        } else {
          process.env.FAKE_CLAUDE_TEXTGEN_HANG_MARKER = previous.previousHangMarker;
        }
      }),
  );
}

it.layer(ClaudeTextGenerationTestLayer)("ClaudeTextGenerationLive", (it) => {
  it.effect("keeps the launching Claude Code session's and Pied Piper's env out of the CLI", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const previous = {
          session: process.env.CLAUDE_CODE_SESSION_ID,
          probe: process.env.PIEDPIPER_TEXTGEN_ENV_PROBE,
        };
        process.env.CLAUDE_CODE_SESSION_ID = "outer-session";
        process.env.PIEDPIPER_TEXTGEN_ENV_PROBE = "1";
        return previous;
      }),
      () =>
        withFakeClaudeEnv(
          {
            output: JSON.stringify({ structured_output: { subject: "Add env change", body: "" } }),
          },
          Effect.gen(function* () {
            const textGeneration = yield* TextGeneration;
            const generated = yield* textGeneration.generateCommitMessage({
              cwd: process.cwd(),
              branch: "feature/env",
              stagedSummary: "M README.md",
              stagedPatch: "diff --git a/README.md b/README.md",
              modelSelection: { provider: "claudeAgent", model: "claude-haiku-4-5" },
            });
            expect(generated.subject).toBe("Add env change");
          }),
        ),
      (previous) =>
        Effect.sync(() => {
          if (previous.session === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
          else process.env.CLAUDE_CODE_SESSION_ID = previous.session;
          if (previous.probe === undefined) delete process.env.PIEDPIPER_TEXTGEN_ENV_PROBE;
          else process.env.PIEDPIPER_TEXTGEN_ENV_PROBE = previous.probe;
        }),
    ),
  );

  it.effect("points the CLI at the configured Claude home and leaves HOME alone", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const serverSettings = yield* ServerSettingsService;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "piedpiper-claude-home-" });
      const capture = path.join(dir, "env.txt");
      const homePath = path.join(dir, "second-account");
      const generate = withFakeClaudeEnv(
        { output: JSON.stringify({ structured_output: { subject: "Add home", body: "" } }) },
        Effect.gen(function* () {
          const textGeneration = yield* TextGeneration;
          yield* textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/home",
            stagedSummary: "M README.md",
            stagedPatch: "diff --git a/README.md b/README.md",
            modelSelection: { provider: "claudeAgent", model: "claude-haiku-4-5" },
          });
        }),
      );
      yield* Effect.acquireUseRelease(
        Effect.gen(function* () {
          process.env.FAKE_CLAUDE_TEXTGEN_ENV_CAPTURE = capture;
          yield* serverSettings.updateSettings({ providers: { claudeAgent: { homePath } } });
        }),
        () => generate,
        () =>
          serverSettings.updateSettings({ providers: { claudeAgent: { homePath: "" } } }).pipe(
            Effect.tap(() => Effect.sync(() => delete process.env.FAKE_CLAUDE_TEXTGEN_ENV_CAPTURE)),
            Effect.orDie,
          ),
      );
      const [configDir, home] = (yield* fs.readFileString(capture)).split("\n");
      expect(configDir).toBe(homePath);
      expect(home).toBe(process.env.HOME ?? "");
    }).pipe(Effect.scoped),
  );

  it.effect("forwards Claude thinking settings for Haiku without passing effort", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({
          structured_output: {
            subject: "Add important change",
            body: "",
          },
        }),
        argsMustContain: '--settings {"disableAllHooks":true,"alwaysThinkingEnabled":false}',
        argsMustNotContain: "--effort",
      },
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;

        const generated = yield* textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/claude-effect",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: {
            provider: "claudeAgent",
            model: "claude-haiku-4-5",
            options: {
              thinking: false,
              effort: "high",
            },
          },
        });

        expect(generated.subject).toBe("Add important change");
      }),
    ),
  );

  it.effect("forwards Claude fast mode and supported effort", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({
          structured_output: {
            title: "Improve orchestration flow",
            body: "Body",
          },
        }),
        argsMustContain: '--effort max --settings {"disableAllHooks":true,"fastMode":true}',
      },
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;

        const generated = yield* textGeneration.generatePrContent({
          cwd: process.cwd(),
          baseBranch: "main",
          headBranch: "feature/claude-effect",
          commitSummary: "Improve orchestration",
          diffSummary: "1 file changed",
          diffPatch: "diff --git a/README.md b/README.md",
          modelSelection: {
            provider: "claudeAgent",
            model: "claude-opus-4-6",
            options: {
              effort: "max",
              fastMode: true,
            },
          },
        });

        expect(generated.title).toBe("Improve orchestration flow");
      }),
    ),
  );

  it.effect(
    "generates thread titles outside the project with tools, skills, and hooks disabled",
    () =>
      withFakeClaudeEnv(
        {
          output: JSON.stringify({
            structured_output: {
              title:
                '  "Reconnect failures after restart because the session state does not recover"  ',
            },
          }),
          cwdMustNotBe: process.cwd(),
          stdinMustContain: "/call-script",
        },
        Effect.gen(function* () {
          const textGeneration = yield* TextGeneration;

          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "/call-script",
            modelSelection: {
              provider: "claudeAgent",
              model: "claude-sonnet-4-6",
            },
          });

          expect(generated.title).toBe(
            sanitizeThreadTitle(
              '"Reconnect failures after restart because the session state does not recover"',
            ),
          );
          // Title runs reuse one private directory instead of a fresh temp dir per thread.
          const { stateDir } = yield* ServerConfig;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          expect(yield* fs.exists(path.join(stateDir, "claude-title-generation"))).toBe(true);
        }),
      ),
  );

  it.effect("passes thread title instructions into the title prompt", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({ structured_output: { title: "Settings sync crash" } }),
        stdinMustContain: "Name the subsystem first.",
      },
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;
        const generated = yield* textGeneration.generateThreadTitle({
          cwd: process.cwd(),
          message: "Fix the crash in settings sync",
          additionalInstructions: "Name the subsystem first.",
          modelSelection: { provider: "claudeAgent", model: "claude-sonnet-4-6" },
        });
        expect(generated.title).toBe("Settings sync crash");
      }),
    ),
  );

  it.effect("passes linked context into the title prompt", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({ structured_output: { title: "Fix login" } }),
        stdinMustContain: "https://github.com/acme/app/pull/8: unavailable",
      },
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;
        const generated = yield* textGeneration.generateThreadTitle({
          cwd: process.cwd(),
          message: "Take over https://github.com/acme/app/pull/8",
          linkedContext: "https://github.com/acme/app/pull/8: unavailable",
          modelSelection: { provider: "claudeAgent", model: "claude-sonnet-4-6" },
        });
        expect(generated.title).toBe("Fix login");
      }),
    ),
  );

  it.effect("generates branch names from skill prompts without executable capabilities", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({ structured_output: { branch: "call-script" } }),
        stdinMustContain: "/call-script",
      },
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;

        const generated = yield* textGeneration.generateBranchName({
          cwd: process.cwd(),
          message: "/call-script",
          modelSelection: {
            provider: "claudeAgent",
            model: "claude-sonnet-4-6",
          },
        });

        expect(generated.branch).toBe("call-script");
      }),
    ),
  );

  it.effect("keeps the model's casing and sends the instructions in custom branch naming", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({ structured_output: { branch: "PROJ-1/Add_Search" } }),
        stdinMustContain: "Start with the JIRA key.",
      },
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;

        const generated = yield* textGeneration.generateBranchName({
          cwd: process.cwd(),
          message: "Add search",
          naming: { mode: "custom", prefix: "", instructions: "Start with the JIRA key." },
          modelSelection: {
            provider: "claudeAgent",
            model: "claude-sonnet-4-6",
          },
        });

        expect(generated.branch).toBe("PROJ-1/Add_Search");
      }),
    ),
  );

  it.effect("lowercases the model's branch outside custom naming", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({ structured_output: { branch: "Feat/Add Search" } }),
        stdinMustContain: "Include a semantic prefix",
      },
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;

        const generated = yield* textGeneration.generateBranchName({
          cwd: process.cwd(),
          message: "Add search",
          naming: { mode: "semantic", prefix: "team", instructions: "" },
          modelSelection: {
            provider: "claudeAgent",
            model: "claude-sonnet-4-6",
          },
        });

        expect(generated.branch).toBe("feat/add-search");
      }),
    ),
  );

  it.effect("falls back when Claude thread title normalization becomes whitespace-only", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({
          structured_output: {
            title: '  """   """  ',
          },
        }),
      },
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;

        const generated = yield* textGeneration.generateThreadTitle({
          cwd: process.cwd(),
          message: "Name this thread.",
          modelSelection: {
            provider: "claudeAgent",
            model: "claude-sonnet-4-6",
          },
        });

        expect(generated.title).toBe("New thread");
      }),
    ),
  );

  it.effect("retries without --no-session-persistence when the Claude CLI rejects it", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({ structured_output: { title: "Reconnect failures" } }),
        rejectsNoSessionPersistence: true,
      },
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;
        const generated = yield* textGeneration.generateThreadTitle({
          cwd: process.cwd(),
          message: "Investigate reconnect failures",
          modelSelection: { provider: "claudeAgent", model: "claude-sonnet-4-6" },
        });

        expect(generated.title).toBe("Reconnect failures");
      }),
    ),
  );

  const apiError = "API Error: 400 Model blocked by guardrail: 4 endpoints excluded";
  const wrapperNotice = "Using the credential from the global credential file.";
  const structuredOutputError = "Failed to provide valid structured output after 5 attempts";
  const structuredOutputFailure = {
    type: "result",
    subtype: "error_max_structured_output_retries",
    is_error: true,
    errors: [structuredOutputError],
  };
  for (const [name, output, stderr, expected] of [
    [
      "the stdout error over a stderr notice",
      JSON.stringify({ type: "result", is_error: true, result: apiError }),
      wrapperNotice,
      apiError,
    ],
    [
      "the verbose stdout error over a stderr notice",
      JSON.stringify([
        { type: "system", subtype: "init" },
        { type: "result", is_error: true, result: apiError },
        { type: "result", is_error: true, result: " " },
      ]),
      wrapperNotice,
      apiError,
    ],
    [
      "the errors list of a result with no result text",
      JSON.stringify(structuredOutputFailure),
      undefined,
      structuredOutputError,
    ],
    [
      "the errors list without CLI telemetry",
      JSON.stringify({
        ...structuredOutputFailure,
        subtype: "error_during_execution",
        errors: ["[ede_diagnostic] result_type=user last_content_type=n/a", apiError],
      }),
      wrapperNotice,
      apiError,
    ],
    ["stderr when stdout has no error", "not json", wrapperNotice, wrapperNotice],
  ] as const) {
    it.effect(`reports ${name} when the Claude CLI fails`, () =>
      withFakeClaudeEnv(
        { output, exitCode: 1, ...(stderr ? { stderr } : {}) },
        Effect.gen(function* () {
          const textGeneration = yield* TextGeneration;
          const error = yield* Effect.flip(
            textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "Name this thread",
              modelSelection: { provider: "claudeAgent", model: "claude-sonnet-4-6" },
            }),
          );

          expect(error.detail).toBe(`Claude CLI command failed: ${expected}`);
        }),
      ),
    );
  }

  for (const verbose of [false, true]) {
    it.effect(`unwraps a JSON title in ${verbose ? "verbose" : "normal"} Claude output`, () => {
      const result = {
        type: "result",
        structured_output: { title: '{"title": "Refresh ev-stg APP ASG instances"}' },
      };
      return withFakeClaudeEnv(
        { output: JSON.stringify(verbose ? [result] : result) },
        Effect.gen(function* () {
          const textGeneration = yield* TextGeneration;
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Refresh ev-stg APP ASG instances",
            modelSelection: { provider: "claudeAgent", model: "claude-sonnet-4-6" },
          });

          expect(generated.title).toBe("Refresh ev-stg APP ASG instances");
        }),
      );
    });
  }

  it.effect("reads the final result message from verbose Claude output", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify([
          { type: "system", subtype: "init" },
          { type: "assistant", message: { content: [] } },
          { type: "rate_limit_event" },
          {
            type: "result",
            subtype: "success",
            result: '{"subject":"Add verbose parsing","body":""}',
            structured_output: { subject: "Add verbose parsing", body: "" },
          },
        ]),
      },
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;
        const generated = yield* textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: null,
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: { provider: "claudeAgent", model: "claude-sonnet-4-6" },
        });

        expect(generated.subject).toBe("Add verbose parsing");
      }),
    ),
  );

  for (const [name, output] of [
    ["empty message array", []],
    ["missing result", [{ type: "assistant", structured_output: { title: "Not a result" } }]],
    ["invalid title", [{ type: "result", structured_output: { title: 42 } }]],
    [
      "final result without structured output",
      [
        { type: "result", structured_output: { title: "Earlier result" } },
        { type: "result", subtype: "error_max_structured_output_retries" },
      ],
    ],
  ] as const) {
    it.effect(`rejects verbose Claude output with ${name}`, () =>
      withFakeClaudeEnv(
        { output: JSON.stringify(output) },
        Effect.gen(function* () {
          const textGeneration = yield* TextGeneration;
          const error = yield* Effect.flip(
            textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "Name this thread",
              modelSelection: { provider: "claudeAgent", model: "claude-sonnet-4-6" },
            }),
          );

          expect(error._tag).toBe("TextGenerationError");
        }),
      ),
    );
  }

  it.effect("force-kills a Claude CLI that ignores SIGTERM after the request times out", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const markerDir = yield* fs.makeTempDirectoryScoped({ prefix: "piedpiper-claude-hang-" });
      const marker = path.join(markerDir, "started");
      const realSleep = Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 25)));

      yield* withFakeClaudeEnv(
        { output: "", hangMarker: marker },
        Effect.gen(function* () {
          const textGeneration = yield* TextGeneration;
          const fiber = yield* textGeneration
            .generateBranchName({
              cwd: process.cwd(),
              message: "Hang forever",
              modelSelection: { provider: "claudeAgent", model: "claude-sonnet-4-6" },
            })
            .pipe(Effect.flip, Effect.forkScoped);

          for (let i = 0; i < 400 && !(yield* fs.exists(marker)); i++) {
            yield* realSleep;
          }
          yield* TestClock.adjust("180 seconds");
          // The SIGKILL grace timer runs on the test clock; keep advancing until the run settles.
          for (let i = 0; i < 200 && fiber.pollUnsafe() === undefined; i++) {
            yield* TestClock.adjust("1 second");
            yield* realSleep;
          }

          expect(fiber.pollUnsafe()).toBeDefined();
          const error = yield* Fiber.join(fiber);
          expect(error.detail).toContain("timed out");
        }),
      );
    }),
  );
});

describe("sanitizeThreadTitle JSON unwrap", () => {
  vitestIt.each([
    '{"title": "Refresh ev-stg APP ASG instances"}',
    '{\n  "title": "Refresh ev-stg APP ASG instances"\n}',
  ])("unwraps a JSON title: %s", (raw) => {
    expect(sanitizeThreadTitle(raw)).toBe("Refresh ev-stg APP ASG instances");
  });

  vitestIt.each([
    "Rolling ES Refresh ev-stg",
    "Fix {title} interpolation",
    '{"title": 42}',
    '{"subject": "Fix parsing"}',
    '{"title": "unfinished}',
  ])("preserves text that is not a JSON title: %s", (raw) => {
    expect(sanitizeThreadTitle(raw)).toBe(raw);
  });

  vitestIt("truncates an unwrapped long title without leaving JSON behind", () => {
    const title = "Investigate intermittent websocket reconnect failures in staging";
    expect(sanitizeThreadTitle(JSON.stringify({ title }))).toBe(
      `${title.slice(0, 47).trimEnd()}...`,
    );
  });
});

describe("claudeMcpIsolationArgs", () => {
  vitestIt("drops strict MCP mode, and only that, next to a managed-mcp.json", () => {
    expect(claudeMcpIsolationArgs(false)).toEqual(["--strict-mcp-config"]);
    expect(claudeMcpIsolationArgs(true)).toEqual([]);
  });

  vitestIt("checks the managed-mcp.json paths Claude Code reads", () => {
    expect(claudeManagedMcpConfigPath("darwin")).toBe(
      "/Library/Application Support/ClaudeCode/managed-mcp.json",
    );
    expect(claudeManagedMcpConfigPath("win32")).toBe(
      "C:\\Program Files\\ClaudeCode\\managed-mcp.json",
    );
    expect(claudeManagedMcpConfigPath("linux")).toBe("/etc/claude-code/managed-mcp.json");
  });
});

const ThrowingSpawnerLayer = ClaudeTextGenerationLive.pipe(
  Layer.provide(
    Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make(() => Effect.die(new Error("spawn EBADF"))),
    ),
  ),
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "piedpiper-claude-text-spawn-defect-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(ThrowingSpawnerLayer)("ClaudeTextGenerationLive spawn defects", (it) => {
  it.effect("turns a synchronous spawn throw into a TextGenerationError", () =>
    Effect.gen(function* () {
      const textGeneration = yield* TextGeneration;
      const error = yield* textGeneration
        .generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/spawn",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: { provider: "claudeAgent", model: "claude-haiku-4-5" },
        })
        .pipe(Effect.flip);
      expect(error._tag).toBe("TextGenerationError");
      expect(error.message).toContain("spawn EBADF");
    }),
  );
});
