# Quality gates and desktop builds

This checkout has no `.github/workflows` directory. These checks are local commands; no checked-in CI workflow enforces them or publishes a release.

Before committing, run:

```sh
bun run fmt:check
bun run lint
bun run typecheck
bun run test
```

`bun run test` runs the workspace Vitest suites through Turbo. Use it instead of Bun's built-in `bun test` runner. Browser tests run separately with `bun run --cwd apps/web test:browser` and require Playwright Chromium. After desktop changes, also run `bun run build:desktop` and `bun run test:desktop-smoke`.

For local development, the root `dev`, `dev:server`, `dev:web`, and `dev:desktop` commands invoke `scripts/dev-runner.ts` with Bun.

Desktop artifacts are built locally by `scripts/build-desktop-artifact.ts`, exposed through the root `dist:desktop:*` commands. `bun run release:smoke` checks release tooling fixtures. Artifact building is separate from publishing; there is no checked-in tag-triggered release or signing workflow. Consult the build script's flags and environment handling when preparing an artifact.
