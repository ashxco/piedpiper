import * as OS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, Fiber, FileSystem, Layer, Path, Result, Sink, Stream } from "effect";
import { TestClock } from "effect/testing";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect } from "vitest";

import { ServerConfig } from "../../config.ts";
import { CodexTextGenerationLive, resolveCodexTextGenerationModel } from "./CodexTextGeneration.ts";
import type { CodexAccountSnapshot } from "../../provider/codexAccount.ts";
import {
  checkCodexProviderStatus,
  getCodexModelCapabilities,
} from "../../provider/Layers/CodexProvider.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import type { CustomModelEntry, ServerProvider, ServerProviderModel } from "@piedpiper/contracts";
import { TextGenerationError } from "@piedpiper/contracts";
import { TextGeneration } from "../Services/TextGeneration.ts";
import { ServerSettingsService } from "../../serverSettings.ts";

const DEFAULT_TEST_MODEL_SELECTION = {
  provider: "codex" as const,
  model: "gpt-5.4-mini",
};

const CodexTextGenerationTestLayer = CodexTextGenerationLive.pipe(
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), {
      prefix: "piedpiper-codex-text-generation-test-",
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

function makeFakeCodexBinary(
  dir: string,
  input: {
    output: string;
    exitCode?: number;
    stderr?: string;
    requireImage?: boolean;
    requireFastServiceTier?: boolean;
    requireReasoningEffort?: string;
    forbidReasoningEffort?: boolean;
    stdinMustContain?: string;
    stdinMustNotContain?: string;
    requireCodexHome?: string;
    homePath?: string;
    hangMarker?: string;
    /** What `codex mcp list --json` prints; a number exits with that code instead. */
    mcpServers?: ReadonlyArray<{ name: string; enabled: boolean }> | number;
    /** `codex mcp list` exits 11 unless its arguments contain this. */
    mcpListRequireArgs?: string;
    /** `codex mcp list` exits 12 when its arguments contain this. */
    mcpListForbidArgs?: string;
    requireArgs?: string;
    forbidArgs?: string;
  },
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const binDir = path.join(dir, "bin");
    const codexPath = path.join(binDir, "codex");
    yield* fs.makeDirectory(binDir, { recursive: true });

    yield* fs.writeFileString(
      codexPath,
      [
        "#!/bin/sh",
        'all_args=" $* "',
        'case "$all_args" in',
        '  *" mcp list --json "*)',
        ...(input.mcpListRequireArgs !== undefined
          ? [
              `    case "$all_args" in *${JSON.stringify(input.mcpListRequireArgs)}*) ;; *) exit 11 ;; esac`,
            ]
          : []),
        ...(input.mcpListForbidArgs !== undefined
          ? [
              `    case "$all_args" in *${JSON.stringify(input.mcpListForbidArgs)}*) exit 12 ;; esac`,
            ]
          : []),
        ...(typeof input.mcpServers === "number"
          ? [`    exit ${input.mcpServers}`]
          : [
              `    printf "%s" ${JSON.stringify(JSON.stringify(input.mcpServers ?? []))}`,
              "    exit 0",
            ]),
        "    ;;",
        "esac",
        ...(input.requireArgs !== undefined
          ? [
              `case "$all_args" in *${JSON.stringify(input.requireArgs)}*) ;; *)`,
              '  printf "%s\\n" "missing expected args: $all_args" >&2',
              "  exit 9",
              ";; esac",
            ]
          : []),
        ...(input.forbidArgs !== undefined
          ? [
              `case "$all_args" in *${JSON.stringify(input.forbidArgs)}*)`,
              '  printf "%s\\n" "forbidden args: $all_args" >&2',
              "  exit 10",
              ";; esac",
            ]
          : []),
        'output_path=""',
        'seen_image="0"',
        'seen_fast_service_tier="0"',
        'seen_reasoning_effort=""',
        "while [ $# -gt 0 ]; do",
        '  if [ "$1" = "--image" ]; then',
        "    shift",
        '    if [ -n "$1" ]; then',
        '      seen_image="1"',
        "    fi",
        "    shift",
        "    continue",
        "  fi",
        '  if [ "$1" = "--config" ]; then',
        "    shift",
        '    if [ "$1" = "service_tier=\\"fast\\"" ]; then',
        '      seen_fast_service_tier="1"',
        "    fi",
        '    case "$1" in',
        "      model_reasoning_effort=*)",
        '        seen_reasoning_effort="$1"',
        "        ;;",
        "    esac",
        "    shift",
        "    continue",
        "  fi",
        '  if [ "$1" = "--output-last-message" ]; then',
        "    shift",
        '    output_path="$1"',
        "    shift",
        "    continue",
        "  fi",
        "  shift",
        "done",
        'stdin_content="$(cat)"',
        ...(input.hangMarker !== undefined
          ? [
              "trap '' TERM",
              `printf "%s" "$$" > ${JSON.stringify(input.hangMarker)}`,
              "exec sleep 600",
            ]
          : []),
        ...(input.requireImage
          ? [
              'if [ "$seen_image" != "1" ]; then',
              '  printf "%s\\n" "missing --image input" >&2',
              `  exit 2`,
              "fi",
            ]
          : []),
        ...(input.requireFastServiceTier
          ? [
              'if [ "$seen_fast_service_tier" != "1" ]; then',
              '  printf "%s\\n" "missing fast service tier config" >&2',
              `  exit 5`,
              "fi",
            ]
          : []),
        ...(input.requireReasoningEffort !== undefined
          ? [
              `if [ "$seen_reasoning_effort" != "model_reasoning_effort=\\"${input.requireReasoningEffort}\\"" ]; then`,
              '  printf "%s\\n" "unexpected reasoning effort config: $seen_reasoning_effort" >&2',
              `  exit 6`,
              "fi",
            ]
          : []),
        ...(input.forbidReasoningEffort
          ? [
              'if [ -n "$seen_reasoning_effort" ]; then',
              '  printf "%s\\n" "reasoning effort config should be omitted: $seen_reasoning_effort" >&2',
              `  exit 7`,
              "fi",
            ]
          : []),
        ...(input.stdinMustContain !== undefined
          ? [
              `if ! printf "%s" "$stdin_content" | grep -F -- ${JSON.stringify(input.stdinMustContain)} >/dev/null; then`,
              '  printf "%s\\n" "stdin missing expected content" >&2',
              `  exit 3`,
              "fi",
            ]
          : []),
        ...(input.stdinMustNotContain !== undefined
          ? [
              `if printf "%s" "$stdin_content" | grep -F -- ${JSON.stringify(input.stdinMustNotContain)} >/dev/null; then`,
              '  printf "%s\\n" "stdin contained forbidden content" >&2',
              `  exit 4`,
              "fi",
            ]
          : []),
        ...(input.requireCodexHome !== undefined
          ? [
              `if [ "$CODEX_HOME" != ${JSON.stringify(input.requireCodexHome)} ]; then`,
              '  printf "%s\\n" "unexpected CODEX_HOME: $CODEX_HOME" >&2',
              `  exit 8`,
              "fi",
            ]
          : []),
        ...(input.stderr !== undefined
          ? [`printf "%s\\n" ${JSON.stringify(input.stderr)} >&2`]
          : []),
        'if [ -n "$output_path" ]; then',
        "  cat > \"$output_path\" <<'__PIEDPIPER_FAKE_CODEX_OUTPUT__'",
        input.output,
        "__PIEDPIPER_FAKE_CODEX_OUTPUT__",
        "fi",
        `exit ${input.exitCode ?? 0}`,
        "",
      ].join("\n"),
    );
    yield* fs.chmod(codexPath, 0o755);
    return codexPath;
  });
}

function withFakeCodexEnv<A, E, R>(
  input: {
    output: string;
    exitCode?: number;
    stderr?: string;
    requireImage?: boolean;
    requireFastServiceTier?: boolean;
    requireReasoningEffort?: string;
    forbidReasoningEffort?: boolean;
    stdinMustContain?: string;
    stdinMustNotContain?: string;
    requireCodexHome?: string;
    homePath?: string;
    hangMarker?: string;
    mcpServers?: ReadonlyArray<{ name: string; enabled: boolean }> | number;
    mcpListRequireArgs?: string;
    mcpListForbidArgs?: string;
    requireArgs?: string;
    forbidArgs?: string;
    launchArgs?: string;
  },
  effect: Effect.Effect<A, E, R>,
) {
  return Effect.acquireUseRelease(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "piedpiper-codex-text-" });
      const codexPath = yield* makeFakeCodexBinary(tempDir, input);
      const serverSettings = yield* ServerSettingsService;
      const previousSettings = yield* serverSettings.getSettings;
      yield* serverSettings.updateSettings({
        providers: {
          codex: {
            binaryPath: codexPath,
            ...(input.homePath !== undefined ? { homePath: input.homePath } : {}),
            ...(input.launchArgs !== undefined ? { launchArgs: input.launchArgs } : {}),
          },
        },
      });
      return {
        serverSettings,
        previousBinaryPath: previousSettings.providers.codex.binaryPath,
        previousHomePath: previousSettings.providers.codex.homePath,
        previousLaunchArgs: previousSettings.providers.codex.launchArgs,
      };
    }),
    () => effect,
    ({ serverSettings, previousBinaryPath, previousHomePath, previousLaunchArgs }) =>
      serverSettings
        .updateSettings({
          providers: {
            codex: {
              binaryPath: previousBinaryPath,
              homePath: previousHomePath,
              launchArgs: previousLaunchArgs,
            },
          },
        })
        .pipe(Effect.asVoid),
  );
}

it.layer(CodexTextGenerationTestLayer)("CodexTextGenerationLive", (it) => {
  it.effect("generates and sanitizes commit messages without branch by default", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          subject:
            "  Add important change to the system with too much detail and a trailing period.\nsecondary line",
          body: "\n- added migration\n- updated tests\n",
        }),
        stdinMustNotContain: "branch must be a short semantic git branch fragment",
      },
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;

        const generated = yield* textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/codex-effect",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        });

        expect(generated.subject.length).toBeLessThanOrEqual(72);
        expect(generated.subject.endsWith(".")).toBe(false);
        expect(generated.body).toBe("- added migration\n- updated tests");
        expect(generated.branch).toBeUndefined();
      }),
    ),
  );

  it.effect(
    "forwards codex fast mode and non-default reasoning effort into codex exec config",
    () =>
      withFakeCodexEnv(
        {
          output: JSON.stringify({
            subject: "Add important change",
            body: "",
          }),
          requireFastServiceTier: true,
          requireReasoningEffort: "xhigh",
          stdinMustNotContain: "branch must be a short semantic git branch fragment",
        },
        Effect.gen(function* () {
          const textGeneration = yield* TextGeneration;

          yield* textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/codex-effect",
            stagedSummary: "M README.md",
            stagedPatch: "diff --git a/README.md b/README.md",
            modelSelection: {
              provider: "codex",
              model: "gpt-5.4",
              options: {
                reasoningEffort: "xhigh",
                fastMode: true,
              },
            },
          });
        }),
      ),
  );

  it.effect("defaults git text generation codex effort to low", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          subject: "Add important change",
          body: "",
        }),
        requireReasoningEffort: "low",
      },
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;

        yield* textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/codex-effect",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        });
      }),
    ),
  );

  it.effect("generates commit message with branch when includeBranch is true", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          subject: "Add important change",
          body: "",
          branch: "fix/important-system-change",
        }),
        stdinMustContain: "branch must be a short semantic git branch fragment",
      },
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;

        const generated = yield* textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/codex-effect",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          includeBranch: true,
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        });

        expect(generated.subject).toBe("Add important change");
        expect(generated.branch).toBe("feature/fix/important-system-change");
      }),
    ),
  );

  it.effect("generates PR content and trims markdown body", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          title: "  Improve orchestration flow\nwith ignored suffix",
          body: "\n## Summary\n- improve flow\n\n## Testing\n- bun test\n\n",
        }),
      },
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;

        const generated = yield* textGeneration.generatePrContent({
          cwd: process.cwd(),
          baseBranch: "main",
          headBranch: "feature/codex-effect",
          commitSummary: "feat: improve orchestration flow",
          diffSummary: "2 files changed",
          diffPatch: "diff --git a/a.ts b/a.ts",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        });

        expect(generated.title).toBe("Improve orchestration flow");
        expect(generated.body.startsWith("## Summary")).toBe(true);
        expect(generated.body.endsWith("\n\n")).toBe(false);
      }),
    ),
  );

  it.effect("generates branch names and normalizes branch fragments", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          branch: "  Feat/Session  ",
        }),
        stdinMustNotContain: "Image attachments supplied to the model",
      },
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;

        const generated = yield* textGeneration.generateBranchName({
          cwd: process.cwd(),
          message: "Please update session handling.",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        });

        expect(generated.branch).toBe("feat/session");
      }),
    ),
  );

  it.effect("keeps the model's casing and sends the instructions in custom branch naming", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({ branch: "PROJ-1/Add_Search" }),
        stdinMustContain: "Start with the JIRA key.",
      },
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;

        const generated = yield* textGeneration.generateBranchName({
          cwd: process.cwd(),
          message: "Add search",
          naming: { mode: "custom", prefix: "", instructions: "Start with the JIRA key." },
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        });

        expect(generated.branch).toBe("PROJ-1/Add_Search");
      }),
    ),
  );

  it.effect("generates thread titles and trims them for sidebar use", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          title:
            '  "Investigate websocket reconnect regressions after worktree restore"  \nignored line',
        }),
      },
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;

        const generated = yield* textGeneration.generateThreadTitle({
          cwd: process.cwd(),
          message: "Please investigate websocket reconnect regressions after a worktree restore.",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        });

        expect(generated.title).toBe("Investigate websocket reconnect regressions aft...");
      }),
    ),
  );

  it.effect("passes linked context into the title prompt", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({ title: "Fix login" }),
        stdinMustContain: "https://github.com/acme/app/pull/8: unavailable",
      },
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;

        const generated = yield* textGeneration.generateThreadTitle({
          cwd: process.cwd(),
          message: "Take over https://github.com/acme/app/pull/8",
          linkedContext: "https://github.com/acme/app/pull/8: unavailable",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        });

        expect(generated.title).toBe("Fix login");
      }),
    ),
  );

  it.effect("falls back when thread title normalization becomes whitespace-only", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          title: '  """   """  ',
        }),
      },
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;

        const generated = yield* textGeneration.generateThreadTitle({
          cwd: process.cwd(),
          message: "Name this thread.",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        });

        expect(generated.title).toBe("New thread");
      }),
    ),
  );

  it.effect("trims whitespace exposed after quote removal in thread titles", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          title: `  "' hello world '"  `,
        }),
      },
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;

        const generated = yield* textGeneration.generateThreadTitle({
          cwd: process.cwd(),
          message: "Name this thread.",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        });

        expect(generated.title).toBe("hello world");
      }),
    ),
  );

  it.effect("omits attachment metadata section when no attachments are provided", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          branch: "fix/session-timeout",
        }),
        stdinMustNotContain: "Attachment metadata:",
      },
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;

        const generated = yield* textGeneration.generateBranchName({
          cwd: process.cwd(),
          message: "Fix timeout behavior.",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        });

        expect(generated.branch).toBe("fix/session-timeout");
      }),
    ),
  );

  it.effect("passes image attachments through as codex image inputs", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          branch: "fix/ui-regression",
        }),
        requireImage: true,
        stdinMustContain: "Attachment metadata:",
      },
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { attachmentsDir } = yield* ServerConfig;
        const attachmentId = `thread-branch-image-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        const attachmentPath = path.join(attachmentsDir, `${attachmentId}.png`);
        yield* fs.makeDirectory(attachmentsDir, { recursive: true });
        yield* fs.writeFile(attachmentPath, Buffer.from("hello"));

        const textGeneration = yield* TextGeneration;
        const generated = yield* textGeneration.generateBranchName({
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          cwd: process.cwd(),
          message: "Fix layout bug from screenshot.",
          attachments: [
            {
              type: "image",
              id: attachmentId,
              name: "bug.png",
              mimeType: "image/png",
              sizeBytes: 5,
            },
          ],
        });

        expect(generated.branch).toBe("fix/ui-regression");
      }),
    ),
  );

  it.effect("resolves persisted attachment ids to files for codex image inputs", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          branch: "fix/ui-regression",
        }),
        requireImage: true,
      },
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { attachmentsDir } = yield* ServerConfig;
        const attachmentId = `thread-1-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        const imagePath = path.join(attachmentsDir, `${attachmentId}.png`);
        yield* fs.makeDirectory(attachmentsDir, { recursive: true });
        yield* fs.writeFile(imagePath, Buffer.from("hello"));

        const textGeneration = yield* TextGeneration;
        const generated = yield* textGeneration
          .generateBranchName({
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
            cwd: process.cwd(),
            message: "Fix layout bug from screenshot.",
            attachments: [
              {
                type: "image",
                id: attachmentId,
                name: "bug.png",
                mimeType: "image/png",
                sizeBytes: 5,
              },
            ],
          })
          .pipe(
            Effect.tap(() =>
              fs.stat(imagePath).pipe(
                Effect.map((fileInfo) => {
                  expect(fileInfo.type).toBe("File");
                }),
              ),
            ),
            Effect.ensuring(fs.remove(imagePath).pipe(Effect.catch(() => Effect.void))),
          );

        expect(generated.branch).toBe("fix/ui-regression");
      }),
    ),
  );

  it.effect("ignores missing attachment ids for codex image inputs", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          branch: "fix/ui-regression",
        }),
        requireImage: true,
      },
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { attachmentsDir } = yield* ServerConfig;
        const missingAttachmentId = `thread-missing-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        const missingPath = path.join(attachmentsDir, `${missingAttachmentId}.png`);
        yield* fs.remove(missingPath).pipe(Effect.catch(() => Effect.void));

        const textGeneration = yield* TextGeneration;
        const result = yield* textGeneration
          .generateBranchName({
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
            cwd: process.cwd(),
            message: "Fix layout bug from screenshot.",
            attachments: [
              {
                type: "image",
                id: missingAttachmentId,
                name: "outside.png",
                mimeType: "image/png",
                sizeBytes: 5,
              },
            ],
          })
          .pipe(Effect.result);

        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure).toBeInstanceOf(TextGenerationError);
          expect(result.failure.message).toContain("missing --image input");
        }
      }),
    ),
  );

  it.effect(
    "fails with typed TextGenerationError when codex returns wrong branch payload shape",
    () =>
      withFakeCodexEnv(
        {
          output: JSON.stringify({
            title: "This is not a branch payload",
          }),
        },
        Effect.gen(function* () {
          const textGeneration = yield* TextGeneration;

          const result = yield* textGeneration
            .generateBranchName({
              cwd: process.cwd(),
              message: "Fix websocket reconnect flake",
              modelSelection: DEFAULT_TEST_MODEL_SELECTION,
            })
            .pipe(Effect.result);

          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(result.failure).toBeInstanceOf(TextGenerationError);
            expect(result.failure.message).toContain("Codex returned invalid structured output");
          }
        }),
      ),
  );

  it.effect("expands a leading ~ in the configured codex home path", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({ subject: "Use expanded codex home", body: "" }),
        homePath: "~/.codex-piedpiper-test",
        requireCodexHome: NodePath.join(OS.homedir(), ".codex-piedpiper-test"),
      },
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;

        const generated = yield* textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/codex-home",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        });

        expect(generated.subject).toBe("Use expanded codex home");
      }),
    ),
  );

  it.effect("generates thread titles with the user's MCP servers and plugins off", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({ title: "Remove default shapes" }),
        mcpServers: [
          { name: "augmenter", enabled: true },
          { name: "my.server", enabled: true },
          { name: "already-off", enabled: false },
        ],
        requireArgs:
          'exec --config features.plugins=false --config features.apps=false --config mcp_servers={"augmenter"={enabled=false},"my.server"={enabled=false}} --ephemeral',
      },
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;
        const result = yield* textGeneration.generateThreadTitle({
          cwd: process.cwd(),
          message: "Use the Augmenter MCP when you start.",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        });
        expect(result.title).toBe("Remove default shapes");
      }),
    ),
  );

  it.effect("forwards only the exec-safe Codex launch arguments", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({ branch: "launch-args" }),
        launchArgs: '--enable foo --listen off --config model="gpt 5"',
        requireArgs: "exec --enable foo --config model=gpt 5 --config features.plugins=false",
        forbidArgs: "--listen",
      },
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;
        const result = yield* textGeneration.generateBranchName({
          cwd: process.cwd(),
          message: "Forward launch args",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        });
        expect(result.branch).toBe("launch-args");
      }),
    ),
  );

  it.effect("lists MCP servers with the launch arguments exec runs with", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({ branch: "launch-mcp" }),
        launchArgs: "--strict-config --config mcp_servers.extra.enabled=true",
        mcpServers: [{ name: "extra", enabled: true }],
        mcpListRequireArgs:
          "--config mcp_servers.extra.enabled=true --config features.plugins=false --config features.apps=false mcp list --json",
        mcpListForbidArgs: "--strict-config",
        requireArgs:
          'exec --strict-config --config mcp_servers.extra.enabled=true --config features.plugins=false --config features.apps=false --config mcp_servers={"extra"={enabled=false}} --ephemeral',
      },
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;
        const result = yield* textGeneration.generateBranchName({
          cwd: process.cwd(),
          message: "Launch args turn on an MCP server",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        });
        expect(result.branch).toBe("launch-mcp");
      }),
    ),
  );

  it.effect("keeps plugins and apps off over launch args that turn them on", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({ branch: "plugins-off" }),
        launchArgs: "--config features.plugins=true --config features.apps=true",
        requireArgs:
          "exec --config features.plugins=true --config features.apps=true --config features.plugins=false --config features.apps=false --ephemeral",
      },
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;
        const result = yield* textGeneration.generateBranchName({
          cwd: process.cwd(),
          message: "Keep plugins off",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        });
        expect(result.branch).toBe("plugins-off");
      }),
    ),
  );

  it.effect("still generates when codex cannot list its MCP servers", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({ branch: "remove-default-shapes" }),
        mcpServers: 2,
        requireArgs: "--config features.plugins=false --config features.apps=false --ephemeral",
        forbidArgs: "mcp_servers=",
      },
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;
        const result = yield* textGeneration.generateBranchName({
          cwd: process.cwd(),
          message: "Remove default shapes from characters",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        });
        expect(result.branch).toBe("remove-default-shapes");
      }),
    ),
  );

  it.effect("returns typed TextGenerationError when codex exits non-zero", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({ subject: "ignored", body: "" }),
        exitCode: 1,
        stderr: "codex execution failed",
      },
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;

        const result = yield* textGeneration
          .generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/codex-error",
            stagedSummary: "M README.md",
            stagedPatch: "diff --git a/README.md b/README.md",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          })
          .pipe(Effect.result);

        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure).toBeInstanceOf(TextGenerationError);
          expect(result.failure.message).toContain(
            "Codex CLI command failed: codex execution failed",
          );
        }
      }),
    ),
  );
  it.effect("kills a stalled codex exec that ignores SIGTERM when the request times out", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const markerDir = yield* fs.makeTempDirectoryScoped({ prefix: "piedpiper-codex-hang-" });
      const marker = path.join(markerDir, "pid");
      const realSleep = Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 25)));
      const isAlive = (pid: number) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };

      yield* withFakeCodexEnv(
        { output: "", hangMarker: marker },
        Effect.gen(function* () {
          const textGeneration = yield* TextGeneration;
          const fiber = yield* textGeneration
            .generateThreadTitle({
              cwd: process.cwd(),
              message: "Hang forever",
              modelSelection: DEFAULT_TEST_MODEL_SELECTION,
            })
            .pipe(Effect.flip, Effect.forkScoped);

          let pid = Number.NaN;
          for (let i = 0; i < 400 && !Number.isInteger(pid); i++) {
            yield* realSleep;
            if (yield* fs.exists(marker)) {
              pid = Number.parseInt(yield* fs.readFileString(marker), 10);
            }
          }
          expect(Number.isInteger(pid)).toBe(true);
          expect(isAlive(pid)).toBe(true);

          yield* TestClock.adjust("180 seconds");
          // The SIGKILL grace timer runs on the test clock; keep advancing until the run settles.
          for (let i = 0; i < 200 && fiber.pollUnsafe() === undefined; i++) {
            yield* TestClock.adjust("1 second");
            yield* realSleep;
          }

          expect(fiber.pollUnsafe()).toBeDefined();
          const error = yield* Fiber.join(fiber);
          expect(error.detail).toContain("timed out");
          for (let i = 0; i < 200 && isAlive(pid); i++) {
            yield* realSleep;
          }
          expect(isAlive(pid)).toBe(false);
        }),
      );
    }),
  );
});

const listedModel = (slug: string, isCustom = false): ServerProviderModel => ({
  slug,
  name: slug,
  isCustom,
  capabilities: null,
});

const ACCOUNT_LISTED_MODELS = [listedModel("gpt-6-astra"), listedModel("gpt-6.1-sol")];

const CodexTextGenerationWithAccountLayer = CodexTextGenerationLive.pipe(
  Layer.provideMerge(
    Layer.succeed(ProviderRegistry, {
      getProviders: Effect.succeed([
        { provider: "codex", models: ACCOUNT_LISTED_MODELS } as unknown as ServerProvider,
      ]),
      refresh: () => Effect.succeed([]),
      streamChanges: Stream.empty,
    }),
  ),
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), {
      prefix: "piedpiper-codex-text-generation-test-",
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(CodexTextGenerationWithAccountLayer)("CodexTextGenerationLive account models", (it) => {
  it.effect("falls back to the account default model and drops the selection's options", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({ title: "Fix login" }),
        requireArgs: "--model gpt-6-astra",
        requireReasoningEffort: "low",
        forbidArgs: "service_tier",
      },
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;
        const generated = yield* textGeneration.generateThreadTitle({
          cwd: process.cwd(),
          message: "Fix the login flow",
          modelSelection: {
            provider: "codex",
            model: "gpt-6-luna",
            options: { reasoningEffort: "xhigh", fastMode: true },
          },
        });
        expect(generated.title).toBe("Fix login");
      }),
    ),
  );

  it.effect("sends no service tier for Fast off without a configured fast default", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({ title: "Fix login" }),
        forbidArgs: "service_tier",
      },
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;
        yield* textGeneration.generateThreadTitle({
          cwd: process.cwd(),
          message: "Fix the login flow",
          modelSelection: {
            provider: "codex",
            model: "gpt-6.1-sol",
            options: { fastMode: false },
          },
        });
      }),
    ),
  );

  it.effect("drops the selection's service tier along with a fallback model", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({ title: "Fix login" }),
        requireArgs: "--model gpt-6-astra",
        forbidArgs: "service_tier",
      },
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;
        yield* textGeneration.generateThreadTitle({
          cwd: process.cwd(),
          message: "Fix the login flow",
          modelSelection: {
            provider: "codex",
            model: "other-family-model",
            options: { serviceTier: "ultrafast" },
          },
        });
      }),
    ),
  );

  it.effect("keeps a listed model and its options", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({ title: "Fix login" }),
        requireArgs: "--model gpt-6.1-sol",
        requireReasoningEffort: "high",
      },
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;
        yield* textGeneration.generateThreadTitle({
          cwd: process.cwd(),
          message: "Fix the login flow",
          modelSelection: {
            provider: "codex",
            model: "gpt-6.1-sol",
            options: { reasoningEffort: "high" },
          },
        });
      }),
    ),
  );
});

const CUSTOM_MODEL_CAPABILITIES = {
  reasoningEffortLevels: [],
  supportsFastMode: false,
  supportsThinkingToggle: false,
  contextWindowOptions: [],
  promptInjectedEffortLevels: [],
};

// Answers the provider probe without a process, since registering details is what these tests need.
const providerProbeSpawner = Layer.succeed(
  ChildProcessSpawner.ChildProcessSpawner,
  ChildProcessSpawner.make(() =>
    Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout: Stream.make(new TextEncoder().encode("codex-cli 1.0.0\n")),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    ),
  ),
);

const noCodexAccount = () => Effect.sync((): CodexAccountSnapshot | undefined => undefined);

const registerCustomModelDetails = (customModelDetails: ReadonlyArray<CustomModelEntry>) =>
  checkCodexProviderStatus(noCodexAccount).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        providerProbeSpawner,
        ServerSettingsService.layerTest({
          providers: {
            codex: {
              customModels: customModelDetails.map((entry) => entry.slug),
              customModelDetails,
            },
          },
        }),
      ),
    ),
  );

it.layer(CodexTextGenerationTestLayer)("CodexTextGenerationLive custom models", (it) => {
  it.effect("honours a custom model's own capabilities", () =>
    Effect.acquireUseRelease(
      registerCustomModelDetails([
        { slug: "my-gateway-model", capabilities: CUSTOM_MODEL_CAPABILITIES },
      ]),
      () =>
        withFakeCodexEnv(
          {
            output: JSON.stringify({ title: "Fix login" }),
            requireArgs: "--model my-gateway-model",
            forbidArgs: "service_tier",
          },
          Effect.gen(function* () {
            expect(getCodexModelCapabilities("my-gateway-model")).toEqual(
              CUSTOM_MODEL_CAPABILITIES,
            );
            const textGeneration = yield* TextGeneration;
            yield* textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "Fix the login flow",
              modelSelection: {
                provider: "codex",
                model: "my-gateway-model",
                options: { fastMode: true },
              },
            });
          }),
        ),
      () => registerCustomModelDetails([]),
    ),
  );
});

const CodexTextGenerationWithFastDefaultLayer = CodexTextGenerationLive.pipe(
  Layer.provideMerge(
    Layer.succeed(ProviderRegistry, {
      getProviders: Effect.succeed([
        {
          provider: "codex",
          models: [
            {
              ...listedModel("gpt-6.1-sol"),
              capabilities: { fastModeDefault: true },
            },
          ],
        } as unknown as ServerProvider,
      ]),
      refresh: () => Effect.succeed([]),
      streamChanges: Stream.empty,
    }),
  ),
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), {
      prefix: "piedpiper-codex-text-generation-test-",
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(CodexTextGenerationWithFastDefaultLayer)(
  "CodexTextGenerationLive configured fast default",
  (it) => {
    it.effect("sends the selected service tier", () =>
      withFakeCodexEnv(
        {
          output: JSON.stringify({ title: "Fix login" }),
          requireArgs: 'service_tier="ultrafast"',
        },
        Effect.gen(function* () {
          const textGeneration = yield* TextGeneration;
          yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Fix the login flow",
            modelSelection: {
              provider: "codex",
              model: "gpt-6.1-sol",
              options: { serviceTier: "ultrafast" },
            },
          });
        }),
      ),
    );

    it.effect("overrides a config-level fast tier when Standard is selected", () =>
      withFakeCodexEnv(
        {
          output: JSON.stringify({ title: "Fix login" }),
          requireArgs: 'service_tier="default"',
        },
        Effect.gen(function* () {
          const textGeneration = yield* TextGeneration;
          yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Fix the login flow",
            modelSelection: {
              provider: "codex",
              model: "gpt-6.1-sol",
              options: { serviceTier: null },
            },
          });
        }),
      ),
    );

    it.effect("overrides a config-level fast tier when Fast is explicitly off", () =>
      withFakeCodexEnv(
        {
          output: JSON.stringify({ title: "Fix login" }),
          requireArgs: 'service_tier="default"',
        },
        Effect.gen(function* () {
          const textGeneration = yield* TextGeneration;
          yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Fix the login flow",
            modelSelection: {
              provider: "codex",
              model: "gpt-6.1-sol",
              options: { fastMode: false },
            },
          });
        }),
      ),
    );
  },
);

describe("resolveCodexTextGenerationModel", () => {
  const builtInSlugs = ["gpt-6-astra", "gpt-6-luna", "gpt-5.3-codex-spark"];

  it("keeps the requested slug when the snapshot holds only the built-in list", () => {
    expect(
      resolveCodexTextGenerationModel({
        requestedModel: "gpt-6-luna",
        snapshotModels: [listedModel("gpt-6-astra"), listedModel("gpt-6-luna")],
        builtInSlugs,
        customModels: [],
      }),
    ).toEqual({ model: "gpt-6-luna", fellBack: false });
  });

  it("keeps a configured custom model as requested", () => {
    expect(
      resolveCodexTextGenerationModel({
        requestedModel: "my-custom",
        snapshotModels: ACCOUNT_LISTED_MODELS,
        builtInSlugs,
        customModels: ["my-custom"],
      }),
    ).toEqual({ model: "my-custom", fellBack: false });
  });

  it("prefers a listed model of the same family", () => {
    expect(
      resolveCodexTextGenerationModel({
        requestedModel: "gpt-6-luna",
        snapshotModels: [listedModel("gpt-6-astra"), listedModel("openai.gpt-6-luna")],
        builtInSlugs,
        customModels: [],
      }),
    ).toEqual({ model: "openai.gpt-6-luna", fellBack: false });
  });

  it("falls back to the first listed model", () => {
    expect(
      resolveCodexTextGenerationModel({
        requestedModel: "gpt-6-luna",
        snapshotModels: [listedModel("custom-x", true), ...ACCOUNT_LISTED_MODELS],
        builtInSlugs,
        customModels: [],
      }),
    ).toEqual({ model: "gpt-6-astra", fellBack: true });
  });

  it("keeps the requested slug without a snapshot", () => {
    expect(
      resolveCodexTextGenerationModel({
        requestedModel: "gpt-6-luna",
        snapshotModels: [],
        builtInSlugs,
        customModels: [],
      }),
    ).toEqual({ model: "gpt-6-luna", fellBack: false });
  });
});

const ThrowingSpawnerLayer = CodexTextGenerationLive.pipe(
  Layer.provide(
    Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make(() => Effect.die(new Error("spawn EBADF"))),
    ),
  ),
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "piedpiper-codex-text-spawn-defect-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(ThrowingSpawnerLayer)("CodexTextGenerationLive spawn defects", (it) => {
  it.effect("turns a synchronous spawn throw into a TextGenerationError", () =>
    Effect.gen(function* () {
      const textGeneration = yield* TextGeneration;
      const error = yield* textGeneration
        .generateBranchName({
          cwd: process.cwd(),
          message: "Spawn throws",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        })
        .pipe(Effect.flip);
      expect(error).toBeInstanceOf(TextGenerationError);
      expect(error.message).toContain("spawn EBADF");
    }),
  );
});
