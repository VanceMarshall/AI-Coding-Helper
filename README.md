# AI Coding Helper

A lightweight web app for chatting about a GitHub repo, reading files on-demand, and iterating on changes with AI models.

## Non-negotiable invariants

- **Backend entrypoint:** `config/server.js`
- **Frontend static files:** `config/public/`
- **Persistent runtime state:** `DATA_DIR` (recommended: mount a Railway volume and set `DATA_DIR=/app/data`)

These choices are intentional to prevent “two codepaths” confusion and to keep production behavior stable.

## Model configuration

The app uses two layers:

1. **Runtime config (persistent):** `${DATA_DIR}/models.json`
2. **Defaults template (repo):** `config/config/models.json`

If runtime config exists, it wins. To apply new repo defaults in production, use **Admin → Reset models to defaults**.

## Context safety

This app avoids “random … truncation” inside code by using **all-or-omit** rules for preloaded files:

- A file is either included in full, or omitted with a note if it would exceed `CONTEXT_BUDGET_TOKENS`.

The chat route also supports **auto file loading**: if the assistant requests `[READ_FILE: path]`, the server loads the file and automatically continues the same answer (so you don't get stuck seeing only file loads).

## Applying changes safely (Replit Agent style)

When you click **Create PR** on a code block, the app does **not** commit to your default branch.

Instead it:

1. Creates a new branch from the repo's default branch
2. Commits the file change to that branch
3. Opens a **Draft Pull Request**
4. Returns the PR link (the UI opens it automatically)

This makes it hard to accidentally break production. You review the PR on GitHub and click **Merge** when you're ready.

## Environment variables

### Required
- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `GOOGLE_API_KEY`
- `GITHUB_TOKEN` (if using repo read features)

### Recommended (Railway)
- `DATA_DIR=/app/data` (volume mounted)
- `STATIC_DIR=config/public`

### Optional tuning
- `CONTEXT_BUDGET_TOKENS` (default 140000)
- `AUTO_FILE_PASSES` (default 2)
- `MAX_REQUESTED_FILES_PER_PASS` (default 8)

## Running locally

```bash
npm install
npm start
```

Then open `http://localhost:3000` (or whatever `PORT` is set to).
