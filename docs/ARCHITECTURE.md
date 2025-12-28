# Architecture

## High-level

This app is a single Node and Express server that serves a static UI and exposes a small API for:

- Chat (streamed)
- GitHub repo browsing (list repos, list files, read file contents)
- Applying patch blocks (server-side)
- Admin configuration (models, API keys, stats reset)

## Important design choices

- **`config/` is the authoritative app folder.**
  - `server.js` at repo root is a thin entrypoint that runs `config/server.js`.
  - Static files are served from `config/public/`.
- **Persistent state lives in `DATA_DIR`** (default `.../data`, recommended `/app/data` in Railway):
  - `models.json` (runtime model selection)
  - `secrets.json` (admin password and API keys if not set in env)
  - `stats.json` and chat history files

## Request flow

1. Browser loads UI from `/` (served from `config/public/`).
2. UI sends a streamed request to `/api/chat`.
3. The server:
   - Loads config from `DATA_DIR/models.json`
   - Selects a model (Fast, Full, Fallback)
   - Calls `config/providers/router.js` to pick the provider
   - Streams tokens back to the UI using Server-Sent Events (SSE)

## Provider layer

Provider streaming is implemented in `config/providers/index.js`.

- OpenAI: prefers the Responses API when available, falls back to Chat Completions.
- Anthropic: uses `@anthropic-ai/sdk` streaming.
- Google: uses `@google/generative-ai`.

Token usage is captured when the provider returns it, then written to `DATA_DIR/stats.json`.

## Model config files

- `config/config/models.json` is the bundled defaults (committed to Git).
- `DATA_DIR/models.json` is the runtime config (created on first boot).

The Admin action "Reset models" copies the bundled defaults into `DATA_DIR/models.json`.

## Static directory override

`STATIC_DIR` (optional) overrides where the server serves static assets from.

This is mainly used to ensure the server always serves the correct UI folder in production.
