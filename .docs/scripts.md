# Scripts

- `bun run dev` — Starts contracts, server, and web in `turbo watch` mode.
- `bun run dev:server` — Starts just the WebSocket server (uses Bun TypeScript execution).
- `bun run dev:web` — Starts just the Vite dev server for the web app.
- Dev data defaults to `PIEDPIPER_HOME` (or `~/.piedpiper`). Inside a linked git worktree, it defaults to `<worktree>/.piedpiper` (gitignored), which takes precedence over an ambient `PIEDPIPER_HOME`, so each worktree starts with an empty dev database. Pass `--home-dir <dir>` to override both.
- Override server CLI-equivalent flags from root dev commands with `--`, for example:
  `bun run dev -- --home-dir ~/.piedpiper-2`
- `bun run start` — Runs the production server (serves built web app as static files).
- `bun run build` — Builds contracts, web app, and server through Turbo.
- `bun run typecheck` — Strict TypeScript checks for all packages.
- `bun run test` — Runs workspace tests.
- `bun run dist:desktop:artifact -- --platform <mac|linux|win> --target <target> --arch <arch>` — Builds a desktop artifact for a specific platform/target/arch.
- `bun run dist:desktop:dmg` — Builds a shareable macOS `.dmg` into `./release`.
- `bun run dist:desktop:dmg:x64` — Builds an Intel macOS `.dmg`.
- `bun run dist:desktop:linux` — Builds a Linux AppImage into `./release`.
- `bun run dist:desktop:win` — Builds a Windows NSIS installer into `./release`.

## Desktop `.dmg` packaging notes

- Default build is unsigned/not notarized for local sharing.
- The DMG build uses `assets/macos-icon-1024.png` as the production app icon source.
- Desktop production windows load the bundled UI from `piedpiper://app/index.html` (not a `127.0.0.1` document URL).
- Desktop packaging includes `apps/server/dist` (the `piedpiper` backend) and starts it on loopback with an auth token for WebSocket/API traffic.
- Your tester can still open it on macOS by right-clicking the app and choosing **Open** on first launch.
- To keep staging files for debugging package contents, run: `bun run dist:desktop:dmg -- --keep-stage`
- To allow code-signing/notarization when configured in CI/secrets, add: `--signed`.
- Windows `--signed` uses Azure Trusted Signing and expects:
  `AZURE_TRUSTED_SIGNING_ENDPOINT`, `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`,
  `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME`, and `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME`.
- Azure authentication env vars are also required (for example service principal with secret):
  `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`.

## Running multiple dev instances

Set `PIEDPIPER_DEV_INSTANCE` to any value to deterministically shift all dev ports together.

- Default ports: server `3773`, web `5733`
- Shifted ports: `base + offset` (offset is hashed from `PIEDPIPER_DEV_INSTANCE`)
- Example: `PIEDPIPER_DEV_INSTANCE=branch-a bun run dev:desktop`

If you want full control instead of hashing, set `PIEDPIPER_PORT_OFFSET` to a numeric offset.

Linked worktrees derive a stable preferred offset from their path, after `PIEDPIPER_PORT_OFFSET` and `PIEDPIPER_DEV_INSTANCE`. Main checkouts keep the default ports. Occupied ports can still shift the result, so treat the `[dev-runner]` output as authoritative.

`PIEDPIPER_DEV_INSTANCE` and `PIEDPIPER_PORT_OFFSET` only shift ports; they do not change the data home. A server takes an exclusive lock on its state directory, so a second server on the same data home is refused and exits with code 78. Give it its own data home with `bun scripts/dev-runner.ts dev --home-dir <dir>` (or `dev:server`), or run it from a linked worktree, which gets its own `.piedpiper` home. Only one `dev:desktop` Electron app can run at a time, whatever its data home: dev builds share one Electron user data folder, so a second app focuses the first and quits.

## Project scripts on Windows

Project scripts are typed into the terminal's shell, which on Windows is PowerShell 7 when installed and otherwise cmd. Scripts using cmd-only syntax such as `set FOO=1 && ...` or `%VAR%` need adjusting under PowerShell 7.
