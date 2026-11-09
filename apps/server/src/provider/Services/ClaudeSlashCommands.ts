import { ServiceMap, type Effect } from "effect";

import type { ClaudeSlashCommandList } from "../claudeSlashCommands";

export interface ClaudeSlashCommandsShape {
  /** Commands Claude offers in a workspace. Never fails: a failed probe still lists `/compact`. */
  readonly list: (cwd: string) => Effect.Effect<ClaudeSlashCommandList>;
}

export class ClaudeSlashCommands extends ServiceMap.Service<
  ClaudeSlashCommands,
  ClaudeSlashCommandsShape
>()("piedpiper/provider/Services/ClaudeSlashCommands") {}
