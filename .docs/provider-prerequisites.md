# Provider prerequisites

Pied Piper hosts two provider adapters. Set up at least one before running the app.

## Claude (primary)

- Install Claude Code so the `claude` CLI is on your PATH.
- Authenticate Claude before running Pied Piper (`claude auth login`).

## Codex (optional)

- Install Codex CLI so `codex` is on your PATH.
- Authenticate Codex before running Pied Piper (for example via API key or ChatGPT auth supported by Codex).
- Codex sessions are launched via `codex app-server` per session.
