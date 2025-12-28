# Architecture

## Overview

The app is a single Node server (`config/server.js`) that:

- Serves the UI from `config/public`
- Streams model output back to the browser using SSE
- Loads repo files from GitHub as context
- Persists conversations and runtime config under `DATA_DIR`

## Key runtime paths

- **Entrypoint:** `config/server.js`
- **Providers:** `config/providers/*`
- **UI:** `config/public/*`
- **Default model config (template):** `config/config/models.json`
- **Runtime state:** `${DATA_DIR}/models.json`, `${DATA_DIR}/secrets.json`, `${DATA_DIR}/conversations.json`, etc.

## Chat request flow

1. Browser calls `POST /api/chat`
2. Server:
   - Determines repo + file list (if available)
   - Auto-loads a small set of key files into `fileContents`
   - Builds a system prompt that embeds full files under a token budget (all-or-omit)
   - Streams completion chunks as SSE to the browser
3. If the assistant requests files via:
   - `[READ_FILE: path/to/file]`
   the server:
   - Loads those files into `fileContents`
   - Rebuilds the system prompt with the new context
   - Automatically runs another completion pass and continues streaming
   - This repeats up to `AUTO_FILE_PASSES` times (default: 2)

This prevents the “assistant only asks for files and never answers” failure mode.

## Context budgeting

- `CONTEXT_BUDGET_TOKENS` controls how much context is embedded in the system prompt.
- Files are never partially truncated; if adding a file would exceed the budget, it is omitted and listed.

## Persistence

Set `DATA_DIR` to a mounted volume in production so:
- Admin password does not reset
- Runtime model selection persists
- Conversation history persists

## Applying changes (Pull Requests)

The UI renders code blocks with a **Create PR** button. This calls `POST /api/apply-change`.

`/api/apply-change`:

1. Detects the repo's default branch
2. Creates a unique branch (e.g. `ai-change/<timestamp>-<rand>`) from the default branch HEAD
3. Commits the updated file to that branch
4. Opens a **Draft Pull Request** back to the default branch
5. Returns the PR URL to the UI (which opens it automatically)

This is intentionally safer than committing directly to the default branch.
