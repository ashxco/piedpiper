import type { ProviderListSlashCommandsResult } from "@piedpiper/contracts";
import { queryOptions } from "@tanstack/react-query";

import type { ComposerProviderCommand } from "~/lib/composerProviderCommands";
import { ensureNativeApi } from "~/nativeApi";

const PROVIDER_COMMANDS_STALE_TIME_MS = 2 * 60 * 1000;
const PENDING_PROVIDER_COMMANDS_REFETCH_MS = 30 * 1000;

/** Local names win a clash, so the menu never lists a second `/model`. */
export const LOCAL_COMPOSER_SLASH_COMMAND_NAMES = ["model", "plan", "default", "usage-limits"];

/** Codex reports no commands, but the server handles `/goal` natively, so the menu offers it here. */
export const CODEX_COMPOSER_PROVIDER_COMMANDS: ReadonlyArray<ComposerProviderCommand> = [
  {
    name: "goal",
    description: "Set a goal for Codex to keep working toward",
    argumentHint: "Objective, or pause, resume, clear",
  },
];

function selectComposerProviderCommands(
  result: ProviderListSlashCommandsResult,
): ReadonlyArray<ComposerProviderCommand> {
  return result.commands.map(({ name, description, argumentHint }) => ({
    name,
    ...(description === undefined ? {} : { description }),
    ...(argumentHint === undefined ? {} : { argumentHint }),
  }));
}

/** Commands Claude reports for a workspace; rechecked while discovery is still pending. */
export function claudeSlashCommandsQueryOptions(input: {
  cwd: string | null;
  enabled: boolean;
  binaryPath?: string | undefined;
  homePath?: string | undefined;
}) {
  return queryOptions({
    // Like the server's cache, so another binary or account does not show the old commands.
    queryKey: [
      "provider-slash-commands",
      "claudeAgent",
      input.cwd,
      input.binaryPath,
      input.homePath,
      input.enabled,
    ] as const,
    queryFn: () => {
      if (!input.cwd) {
        throw new Error("Claude commands need a workspace.");
      }
      return ensureNativeApi().server.listProviderSlashCommands({
        provider: "claudeAgent",
        cwd: input.cwd,
      });
    },
    enabled: input.enabled && input.cwd !== null,
    staleTime: PROVIDER_COMMANDS_STALE_TIME_MS,
    select: selectComposerProviderCommands,
    // A failed lookup settles with no commands, and typed commands still send.
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.pending === true ? PENDING_PROVIDER_COMMANDS_REFETCH_MS : false,
  });
}
