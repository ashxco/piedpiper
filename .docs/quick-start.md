# Quick start

```bash
# Development (with hot reload)
bun run dev

# Desktop development
bun run dev:desktop

# Desktop development on an isolated port set (ports only: it shares the data home, and only one dev desktop app runs at a time)
PIEDPIPER_DEV_INSTANCE=feature-xyz bun run dev:desktop

# Production
bun run build
bun run start

# Build a shareable macOS .dmg (arm64 by default)
bun run dist:desktop:dmg

# Or from any project directory after publishing:
npx piedpiper
```

`npx piedpiper ./my-project` opens that folder and creates it if it is missing. A bare name such as `piedpiper my-project` must already exist, so typos are refused. A folder named like a subcommand needs a path form, for example `piedpiper ./trace`. Quote paths that contain spaces.
