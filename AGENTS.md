# AGENTS.md

## Project Snapshot

Pied Piper is a minimal web GUI for using coding agents. **Claude is the primary provider.** A Codex adapter is also wired into the provider registry and remains supported, but Claude is the day-to-day target and the one to bias new work toward.

The app also ships an **office mode**: a virtual office that shows every agent thread at a desk, with decorative NPC characters and their quote lines.

## Core Priorities

1. Performance first.
2. Reliability first.
3. Behavior must stay predictable under load and during failures (session restarts, reconnects, partial streams).

If a tradeoff is required, choose correctness and robustness over short-term convenience.

## Development

Run the dev environment with `bun scripts/dev-runner.ts <mode>`:

- `bun scripts/dev-runner.ts dev` — web + server (no desktop)
- `bun scripts/dev-runner.ts dev:desktop` — web + desktop (Electron)
- `bun scripts/dev-runner.ts dev:server` — server only
- `bun scripts/dev-runner.ts dev:web` — web only
- In a linked git worktree, `bun scripts/dev-runner.ts` defaults the data home to that worktree's gitignored `.piedpiper` directory, so branch work never shares a dev database, settings or attachments with other checkouts. This deliberately outranks an ambient `PIEDPIPER_HOME`; an explicit `--home-dir` still wins. Trade-off: each new worktree starts with an empty dev database (no projects).
- Linked worktrees also get stable preferred dev ports derived from the worktree path, after `PIEDPIPER_PORT_OFFSET` and `PIEDPIPER_DEV_INSTANCE`. Occupied ports can still shift them, so read the actual ports from the `[dev-runner]` line.
- A server takes an exclusive lock on its state directory (`server-owner.sqlite`), so two dev instances in one checkout conflict, and the second exits with code 78. Give the second one its own data home with `--home-dir`, or use a linked worktree. Do not delete `server-owner.sqlite` while a server is running.
- `bun scripts/dev-runner.ts` sets `PIEDPIPER_TELEMETRY_ENABLED=false` in every mode unless it is already set. To send analytics from a dev run, export `PIEDPIPER_TELEMETRY_ENABLED=true` and `PIEDPIPER_POSTHOG_KEY`.

Use Bun for the dev runner, as the root `dev*` scripts do, so development uses the same runtime consistently.

## Task Completion Requirements

- All of `bun fmt`, `bun lint`, and `bun typecheck` must pass before considering a task complete.
- NEVER run `bun test`. Always use `bun run test` (runs Vitest).
- When you change a file under `apps/server/src/`, run the server tests. When you change `apps/web/src/`, run the web tests. Don't ship structural changes without running the affected workspace's test suite.

## Package Roles

- `apps/server` — Node.js WebSocket server. Hosts the provider adapters (Claude is primary; Codex is also wired), serves the React web app, and manages provider sessions. Effect-based architecture under `Services/` + `Layers/` directories.
- `apps/web` — React/Vite UI. Owns session UX, conversation/event rendering, and client-side state. Connects to the server via WebSocket. Uses TanStack Router for file-based route splitting.
- `apps/desktop` — Electron shell. Spawns a desktop-scoped backend process and loads the shared web app.
- `packages/contracts` — Shared `effect/Schema` schemas and TypeScript contracts for provider events, WebSocket protocol, and model/session types. **Schema-only — no runtime logic.**
- `packages/shared` — Shared runtime utilities consumed by both server and web. Uses explicit subpath exports (e.g. `@piedpiper/shared/git`, `@piedpiper/shared/DrainableWorker`) — **no barrel index**.

## File Organization Standards

### Server (`apps/server/src/`)

The server uses an Effect-based architecture. The standard pattern is:

```
apps/server/src/<domain>/
  Services/<Name>.ts        — service interface (effect/ServiceMap.Service)
  Layers/<Name>.ts          — Live implementation layer
  Layers/<Name>Helpers.ts   — pure helpers extracted from a Layer
  <utility>.ts              — pure utility module (no Effect, no class state)
```

Concrete examples:

- `provider/Layers/ClaudeAdapter.ts` — Effect Layer wiring + lifecycle methods for the primary (Claude) adapter
- `provider/Layers/ClaudeAdapterHelpers.ts` — pure helpers used by the Claude adapter
- `provider/Layers/CodexAdapter.ts` / `CodexAdapterHelpers.ts` — secondary Codex adapter, same shape
- `git/Layers/GitCore.ts` — Effect Layer for git command surface
- `git/Layers/GitParsers.ts` — pure parsers extracted from GitCore
- `terminal/Layers/Manager.ts` — Layer for the terminal manager
- `terminal/Layers/TerminalSanitizer.ts` / `ShellResolver.ts` / `TerminalSessionKeys.ts` — pure helpers
- `orchestration/Layers/ProjectionPipeline.ts` — Layer for the projection pipeline
- `orchestration/Layers/MessageRetention.ts` / `RuntimeNormalizer.ts` — pure helpers
- `orchestration/ServerReadModel.ts` — in-memory read model with `Map<ProjectId, Project>` and `Map<ThreadId, Thread>` for O(1) lookups
- `codex/parsing.ts` / `codex/sessionState.ts` / `codex/protocolHelpers.ts` — pure helpers and types backing `codexAppServerManager.ts` (the procedural codex stdio bridge)

### Web (`apps/web/src/`)

```
apps/web/src/
  components/ChatView.tsx    — main chat container (lives at components root, NOT in chat/)
  components/chat/           — chat-area subcomponents extracted from ChatView
  components/sidebar/        — sidebar subcomponents
  components/settings/panels/— one file per settings panel
  components/office-mode/    — office mode: virtual office, NPC system, character data
  hooks/use<Name>.ts         — reusable hooks scoped to one concern each
  lib/<topic>.ts             — pure helpers (no React, no Zustand)
  routes/<name>.tsx           — TanStack Router route config (validateSearch, loaders)
  routes/<name>.lazy.tsx      — lazy-loaded route components (code splitting)
  storeSelectors.ts          — Zustand selectors (use shallow equality where appropriate)
  store.ts                   — root Zustand store + reducer
```

Concrete examples:

- `lib/composerAttachmentNormalization.ts`, `lib/composerModelNormalization.ts`, `lib/composerDraftPersistence.ts` — pure helpers used by the composer draft store
- `lib/storeDataMapping.ts`, `lib/storeUpdateHelpers.ts` — pure helpers used by the root store
- `lib/npcIdentity.ts`, `lib/npcProminence.ts` — office NPC helpers (character id parsing, picker ordering)
- `hooks/useComposerSession.ts` — bundles related composer derivation `useMemo`s into one hook with an explicit input/output shape
- `hooks/useThreadPlanCatalog.ts`, `hooks/useLocalDispatchState.ts` — derivation hooks pulled out of `ChatView.tsx`
- `hooks/useSidebarProjectDnd.ts`, `hooks/useSidebarThreadJumpKeybindings.ts` — DnD and keybinding logic pulled out of `Sidebar.tsx`
- `components/chat/ChatComposer.tsx` — composer form, drag/drop, command menu, working status bar (extracted from ChatView)
- `components/chat/ChatTerminalSection.tsx` — terminal drawer mount state (extracted from ChatView)
- `components/chat/ChatPlanPanel.tsx` — plan sidebar with imperative handle (extracted from ChatView)
- `components/chat/MissingCwdBanner.tsx` — inline banner for missing project folders
- `components/chat/ToolInputCodePreview.tsx` — streaming tool input preview with diff view and bash syntax highlighting
- `components/office-mode/OfficeMode.tsx` — virtual office with NPC tiles, agent seats, floating card (quote/swap modes)
- `components/office-mode/seatLayout.ts`, `npcCharacters.ts`, `characterLines.ts` — static data modules for the office

### Character images (`apps/web/public/characters/`)

```
characters/
  npcs/              — NPC character images (540×640 PNG, transparent-padded, uniform dimensions)
  base-agents/       — source agent images
  resized-agents/    — resized agent images
```

## Coding Standards

### Maintainability is a core priority

- Before writing new logic, check whether shared logic already exists that you can extend or extract.
- Duplicate logic across files is a code smell. Don't take shortcuts by adding local logic instead of touching a shared module.
- Don't be afraid to change existing code. The codebase is young and refactors are encouraged when they pay off.
- Keep modules narrow. If a file is doing several unrelated things, that is a signal to split.

### When a file gets too large

Use the patterns the codebase already follows:

1. **Extract pure helpers first.** Anything that doesn't read instance state or React closures can become a free function in a sibling module. Examples in the server: `protocolHelpers.ts`, `GitParsers.ts`, `MessageRetention.ts`. Examples in the web app: `lib/storeDataMapping.ts`, `lib/composerAttachmentNormalization.ts`.
2. **Move static data to its own module.** Tier lists, layout constants, and similar data are easier to read and edit when separated from the logic that consumes them. Example: `office-mode/seatLayout.ts`, `office-mode/npcCharacters.ts`.
3. **Pull self-contained subcomponents into their own files.** They should take props, not closures over container state. Examples: `chat/ChatComposer.tsx`, `chat/NewThreadLanding.tsx`, `office-mode/Joystick.tsx`, `sidebar/SidebarProjectItem.tsx`.
4. **Bundle related derivations into a hook.** When several adjacent `useMemo`s share inputs and feed the same consumer cluster, pull them into a hook with an explicit input/output shape. Example: `hooks/useComposerSession.ts`.

### What NOT to do

- **Don't speculatively over-extract.** A useCallback that closes over 30 local variables is not a good extraction candidate — moving it to a hook would just thread 30 params through a worse signature. Wait until the function needs a real change, then refactor as part of the change.
- **Don't duplicate-deduplicate.** Two functions sharing a name don't necessarily share a shape. Read both end-to-end before merging them.
- **Don't add a barrel index to `packages/shared`.** It uses explicit subpath exports on purpose; respect that boundary.
- **Don't put runtime logic in `packages/contracts`.** It is schema-only.

### Effect.fn pattern

For `Effect.gen` wrappers in the server, prefer `Effect.fn("name")(function* ...)` over `() => Effect.gen(function* ...)`. The named-function form gives better trace spans. The adapter Layers (`ClaudeAdapter`, `CodexAdapter`), git layers, ingestion, and projection follow this pattern.

### PubSub subscriptions in the server

When a reactor needs to consume a `PubSub` event stream, **subscribe synchronously** before any events can be published. Use `PubSub.subscribe` inside an `Effect.gen` that returns the subscription, then iterate with `PubSub.take` in a forked fiber. Do **not** use `Stream.fromPubSub` for cases where the publisher and subscriber start in the same scope — `Stream.fromPubSub` subscribes lazily inside the forked fiber and will miss events published in the dispatch gap. The reactors in `orchestration/Layers/CheckpointReactor.ts`, `ProviderCommandReactor.ts`, and `ProviderRuntimeIngestion.ts` show the pattern.

### Frontend store subscriptions

- Subscribe to the **narrowest possible slice** of state. Use the id-list selectors in `storeSelectors.ts` (`useAllThreadIds`, `useAllProjectIds`) instead of subscribing to the full `state.threads` / `state.projects` arrays.
- Use shallow equality (`useShallow`) when selecting object slices.
- Memoize list children when the list can grow large.

## Provider architecture

Provider sessions are owned by Effect-typed adapter Layers and exposed through `provider/Layers/ProviderService.ts`. Both adapters register through `provider/Layers/ProviderAdapterRegistry.ts`.

Claude is the primary provider; Codex coexists. The two adapters share the same shape:

- `apps/server/src/provider/Layers/ClaudeAdapter.ts` — primary adapter, talks to the Claude Code CLI/SDK.
- `apps/server/src/provider/Layers/ClaudeAdapterHelpers.ts` — pure helpers used by the Claude adapter.
- `apps/server/src/provider/Layers/CodexAdapter.ts` — secondary Codex adapter (kept wired so codex sessions still work).
- `apps/server/src/provider/Layers/CodexAdapterHelpers.ts` — pure helpers used by the Codex adapter.

Once a provider runtime emits events, the orchestration pipeline is provider-agnostic:

- `orchestration/Layers/ProviderRuntimeIngestion.ts` translates provider runtime events into orchestration commands.
- `orchestration/Layers/ProviderCommandReactor.ts` dispatches them through `orchestration/Layers/OrchestrationEngine.ts`.
- The WebSocket server in `apps/server/src/ws.ts` (RPC routes via `effect/unstable/rpc` and the `WsRpcGroup` from `@piedpiper/contracts`) pushes the resulting domain events to the browser on the `orchestration.domainEvent` channel.

### Codex bridge (still wired)

Codex uses a procedural `CodexAppServerManager` that owns the JSON-RPC stdio bridge to `codex app-server`. The Effect-typed `CodexAdapter` wraps it. **This split is intentional**: the manager handles low-level protocol; the adapter exposes an Effect-typed contract. Don't merge them.

- `apps/server/src/codexAppServerManager.ts` — class that owns the codex stdio bridge (process lifecycle, JSON-RPC framing, pending request tracking).
- `apps/server/src/codex/parsing.ts` — pure helpers and developer-instructions blobs (ANSI/regex helpers, mode mapping, user input answer normalization).
- `apps/server/src/codex/sessionState.ts` — file-private session state and JSON-RPC envelope types.
- `apps/server/src/codex/protocolHelpers.ts` — pure read/parse/guard helpers, type guards, and the async CLI version check (spawns `codex --version`, enforces a 4 s timeout by killing the process tree, and judges the result in the pure evaluateCodexCliVersionCheck).

Codex App Server docs: https://developers.openai.com/codex/sdk/#app-server

## Reference Repos

- Codex-Monitor (Tauri, feature-complete, strong reference implementation for the codex side): https://github.com/Dimillian/CodexMonitor
- Open-source Codex repo: https://github.com/openai/codex
