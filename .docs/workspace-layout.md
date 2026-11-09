# Workspace layout

- `/apps/server`: Node.js WebSocket server. Hosts the provider adapters (Claude as primary, Codex also wired), serves the built web app, and opens the browser on start.
- `/apps/web`: React + Vite UI. Session control, conversation, and provider event rendering. Connects to the server via WebSocket. Uses TanStack Router for file-based route splitting.
- `/apps/desktop`: Electron shell. Spawns a desktop-scoped `piedpiper` backend process and loads the shared web app.
- `/packages/contracts`: Shared effect/Schema schemas and TypeScript contracts for provider events, WebSocket protocol, and model/session types.
- `/packages/shared`: Shared runtime utilities consumed by both server and web. Uses explicit subpath exports (e.g. `@piedpiper/shared/git`, `@piedpiper/shared/DrainableWorker`) — no barrel index.
