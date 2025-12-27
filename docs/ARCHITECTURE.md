# Architecture

This project is intentionally structured so there is **one authoritative backend** and **one authoritative UI directory**, to avoid the "two copies of code" problem.

## High-level flow

1. The platform runs `npm start`.
2. `server.js` (repo root) is a **thin entrypoint** that imports/starts `config/server.js`.
3. `config/server.js`:
   * Serves the web UI from `config/public/`.
   * Exposes API routes under `/api/*`.
   * Streams provider outputs back to the UI.
4. Provider logic lives in `config/providers/index.js`.
5. Runtime config lives in `config/config/...`.
6. Persistent data (chat history, admin changes, etc.) lives in `data/`.

## Authoritative directories

### Backend

* **Authoritative backend:** `config/server.js`
* **Entrypoint:** `server.js`

Why: it keeps deployments predictable and avoids accidentally editing a shadow copy of the backend.

### Frontend

* **Authoritative static UI:** `config/public/`

Why: any legacy `/public` directory (if present in older versions) should not be used by the runtime server.

### Model configuration

* **Authoritative model config:** `config/config/models.json`

The admin panel reads and writes model selections based on this config (and on the persisted admin overrides under `data/`).

## Provider architecture

All LLM calls are routed through:

* `config/providers/index.js`

That module:

* Initializes provider SDKs (OpenAI, Anthropic) and stores provider availability.
* Exposes a single streaming generator: `streamCompletion(...)`.

### OpenAI

* GPT-5-family models are routed through the **Responses API**.
* If a fallback to Chat Completions is ever needed, the code uses `max_completion_tokens` (not `max_tokens`) for compatibility with newer reasoning models.

### Anthropic

* Uses the Anthropic streaming SDK.

### Google

* Uses the Google Gemini REST API streaming path currently implemented in this repo.

## Persistence

* Persistent directory: `data/`
* Railway recommendation: mount a volume at `/app/data`.

Anything stored here should be treated as runtime state (safe to delete if you want a clean reset, but you will lose stored chats/admin overrides).

## Deployment invariants ("bulletproof" rules)

1. Only run `node config/server.js` (via `npm start`).
2. Only serve UI from `config/public/`.
3. Only read the active model list from `config/config/models.json`.
4. Only persist runtime state under `data/`.

If you keep those 4 invariants true, you won't end up with split-brain behavior between two folders.
