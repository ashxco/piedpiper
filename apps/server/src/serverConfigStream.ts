import type {
  EditorId,
  ServerConfig,
  ServerConfigStreamEvent,
  ServerProviders,
  ServerSettings,
} from "@piedpiper/contracts";
import { Duration, Effect, Option, Stream } from "effect";

import type { KeybindingsChangeEvent } from "./keybindings";

type ConfigChange =
  | { readonly _tag: "keybindings"; readonly event: KeybindingsChangeEvent }
  | { readonly _tag: "providers"; readonly providers: ServerProviders }
  | { readonly _tag: "settings"; readonly settings: ServerSettings }
  | { readonly _tag: "editors"; readonly availableEditors: ReadonlyArray<EditorId> };

const sameEditors = (left: ReadonlyArray<EditorId>, right: ReadonlyArray<EditorId>) =>
  left.length === right.length && left.every((editor, index) => editor === right[index]);

/**
 * The subscribeServerConfig stream: the initial snapshot, then live updates. `lateAvailableEditors`
 * waits for an editor scan that outlasted the snapshot's timeout; when it resolves to a different
 * list, a fresh snapshot is sent. Updates are folded into the current config so that late snapshot
 * never undoes a change that arrived while the scan was running.
 */
export function makeServerConfigUpdateStream<E>(input: {
  readonly snapshotConfig: ServerConfig;
  readonly keybindingsChanges: Stream.Stream<KeybindingsChangeEvent, E>;
  readonly providerChanges: Stream.Stream<ServerProviders, E>;
  readonly settingsChanges: Stream.Stream<ServerSettings, E>;
  readonly lateAvailableEditors: Effect.Effect<Option.Option<ReadonlyArray<EditorId>>>;
  readonly providerDebounce?: Duration.Input;
}): Stream.Stream<ServerConfigStreamEvent, E> {
  const changes: Stream.Stream<ConfigChange, E> = Stream.mergeAll(
    [
      input.keybindingsChanges.pipe(
        Stream.map((event): ConfigChange => ({ _tag: "keybindings", event })),
      ),
      input.providerChanges.pipe(
        // Merge the per-provider updates from background startup checks into one push.
        Stream.debounce(input.providerDebounce ?? Duration.millis(200)),
        Stream.map((providers): ConfigChange => ({ _tag: "providers", providers })),
      ),
      input.settingsChanges.pipe(
        Stream.map((settings): ConfigChange => ({ _tag: "settings", settings })),
      ),
      Stream.fromEffect(input.lateAvailableEditors).pipe(
        Stream.flatMap((editors) =>
          Option.isSome(editors)
            ? Stream.succeed<ConfigChange>({ _tag: "editors", availableEditors: editors.value })
            : Stream.empty,
        ),
      ),
    ],
    { concurrency: "unbounded" },
  );

  const updates = changes.pipe(
    Stream.mapAccum(
      () => input.snapshotConfig,
      (config, change): readonly [ServerConfig, ReadonlyArray<ServerConfigStreamEvent>] => {
        switch (change._tag) {
          case "keybindings":
            return [
              { ...config, keybindings: change.event.keybindings, issues: change.event.issues },
              [
                {
                  version: 1,
                  type: "keybindingsUpdated",
                  payload: { keybindings: change.event.keybindings, issues: change.event.issues },
                },
              ],
            ];
          case "providers":
            return [
              { ...config, providers: change.providers },
              [{ version: 1, type: "providerStatuses", payload: { providers: change.providers } }],
            ];
          case "settings":
            return [
              { ...config, settings: change.settings },
              [{ version: 1, type: "settingsUpdated", payload: { settings: change.settings } }],
            ];
          case "editors": {
            if (sameEditors(config.availableEditors, change.availableEditors)) {
              return [config, []];
            }
            const next = { ...config, availableEditors: change.availableEditors };
            return [next, [{ version: 1, type: "snapshot", config: next }]];
          }
        }
      },
    ),
  );

  return Stream.concat(
    Stream.succeed<ServerConfigStreamEvent>({
      version: 1,
      type: "snapshot",
      config: input.snapshotConfig,
    }),
    updates,
  );
}

/** Awaits the shared (untimed) editor scan; a failed scan yields nothing rather than an empty list. */
export const awaitEditorDiscovery = (
  discover: () => Promise<ReadonlyArray<EditorId>>,
): Effect.Effect<Option.Option<ReadonlyArray<EditorId>>> =>
  Effect.tryPromise(discover).pipe(
    Effect.map(Option.some),
    Effect.catch(() => Effect.succeed(Option.none())),
  );
