# AI Coding Helper

A lightweight web app that helps you chat about a codebase, request file reads, and apply changes. Designed to stay stable under long conversations, large repositories, and streaming model outputs.

## Key design decisions (read this first)

### Single backend entrypoint
This app must always run from:

- `config/server.js`

We intentionally lock the entrypoint so production cannot accidentally start a different server file.

### Single UI source of truth
Static UI must always be served from:

- `config/public/`

Root `/public` is intentionally not used.

### Persistent state lives in DATA_DIR
Runtime state is stored on disk at `DATA_DIR` (models config, secrets, chat history, etc). In Railway, this should be backed by a volume.

## Project structure

- `config/server.js`  
  Main server, API routes, file preload logic, history trimming, and model routing.

- `config/providers/`  
  Provider implementations and streaming logic (OpenAI, Anthropic, Google).

- `config/public/`  
  Front end UI (index and admin). Code blocks are collapsed by default to keep the browser responsive.

- `config/config/models.json`  
  Default model configuration template that is used to initialize runtime config when `DATA_DIR/models.json` does not exist.

- `data/`  
  Local runtime folder for development only. In production you should use a volume and set `DATA_DIR` accordingly. This folder should not be committed.

## Model configuration

### Runtime model config precedence
The app uses:

1. `DATA_DIR/models.json` (runtime, persistent, highest priority)
2. `config/config/models.json` (defaults template used only to initialize)

Important: If you change defaults in the repo, production may still use the persisted `DATA_DIR/models.json`. Use the Admin "Reset models to defaults" button to repopulate runtime config from defaults.

### Default roles
- Fast model: quick, cheaper responses
- Full model: primary, highest quality
- Fallback model: used when the primary model fails
- LongContext model: auto-used when the input is too large for the normal budget

## Context safety features

### No partial truncation of code
The server never slices a file and injects `...` into the middle of code.

Instead it uses all or omit:
- include the entire file content, or
- omit it with a clear note if it would exceed the context budget

### History trimming
Long conversations can cause stalls or context overflow. The server trims the message history sent to the model based on a token budget, while still persisting the full conversation to disk.

### Long context auto switch
If the request is too large for the standard context budget, the app can automatically switch to the LongContext model (for example Gemini 3 Pro) rather than sending a broken, incomplete prompt.

## OpenAI Responses API and reasoning effort

When the active model is GPT-5.x, OpenAI calls use the Responses API and stream output. Reasoning effort is supported and defaults to medium, with automatic escalation to high when the request appears complex (many files, architecture changes, deep debugging, etc).

## Environment variables

### Required
- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `GOOGLE_API_KEY`
- `GITHUB_TOKEN` (if using GitHub apply features)

### Recommended for production
- `PORT` (Railway typically sets this)
- `DATA_DIR` (example: `/app/data` when using a Railway volume)
- `STATIC_DIR` (set to `config/public` for clarity)

### Optional tuning
- `CONTEXT_BUDGET_TOKENS` (default 140000)
- `LONG_CONTEXT_BUDGET_TOKENS` (example 500000)
- `HISTORY_BUDGET_TOKENS` (example 50000)
- `MAX_FILE_EMIT_CHARS` (example 250000)

If you do not set these, sensible defaults are used.

## Running locally

1. Install dependencies
   - `npm install`

2. Start
   - `npm start`

3. Open
   - `http://localhost:PORT` (PORT defaults to 3000 if not set, depending on your server config)

For local persistence, you can either:
- set `DATA_DIR=./data`
- or rely on the default data directory behavior of the app

## Railway deployment

### Start command
Use:
- `npm start`

This is intentionally locked to run `node config/server.js`.

### Volume and persistence
Mount a Railway volume to:
- `/app/data`

Then set:
- `DATA_DIR=/app/data`

This ensures your admin password, models config, and chat history persist across deploys.

### Static UI
Set:
- `STATIC_DIR=config/public`

This removes ambiguity about which UI is being served.

## Git hygiene

### Do not commit runtime data
Add to `.gitignore`:
- `data/`
- `**/secrets.json`
- `.env` and `.env.*` (except `.env.example`)

If you previously committed data files, remove them from tracking:
- `git rm -r --cached data`

## Troubleshooting

### I changed models in the repo but production did not change
Production uses the persisted runtime config in `DATA_DIR/models.json`.
Go to Admin and click "Reset models to defaults".

### The UI feels slow or freezes
Large code blocks can be expensive to render. Code blocks are collapsed by default. If you still see slowdowns, confirm you are running the latest UI from `config/public` and that `STATIC_DIR=config/public` is set.

### Context too long errors
Reduce `CONTEXT_BUDGET_TOKENS` to leave more headroom for the model output, or ensure LongContext routing is enabled and configured.

## Security notes
- Never commit API keys or secrets.
- Ensure `DATA_DIR` is on a private volume in production.
- Treat `DATA_DIR/secrets.json` as sensitive.
