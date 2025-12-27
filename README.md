# AI Coding Helper

A lightweight web app for chatting with multiple LLM providers (OpenAI, Anthropic, Google) with an admin panel for model selection.

## Quick start

### Local

1. Install dependencies

```bash
npm install
```

2. Set environment variables (examples below)

3. Start the server

```bash
npm start
```

Then open: `http://localhost:3000`

### Railway

* Start command: `npm start`
* Persist data by mounting a Railway volume to `/app/data`.

## Environment variables

### Required (depending on provider)

* `OPENAI_API_KEY` (OpenAI models)
* `ANTHROPIC_API_KEY` (Claude models)
* `GOOGLE_API_KEY` (Gemini models)

### Optional

* `GITHUB_TOKEN` (if you enable GitHub integrations)
* `PORT` (default `3000`)

## Where things live

* **Backend (authoritative):** `config/server.js`
* **Entrypoint:** `server.js` (thin wrapper that runs `config/server.js`)
* **Static UI:** `config/public/`
* **Model config (authoritative):** `config/config/models.json`
* **Persistent app data:** `data/` (recommended to mount as a Railway volume at `/app/data`)

## Admin panel

Open the admin panel in the browser:

* `http://<host>/admin`

Use it to:

* Select default models for Fast, Full, Fallback.
* Reset models to the repo defaults.
* Confirm which provider keys are detected.

## Notes on OpenAI GPT-5 / GPT-5.2

This app uses the **Responses API** for GPT-5-family models (recommended by OpenAI for reasoning models).

If the app ever falls back to Chat Completions for an OpenAI model, it uses `max_completion_tokens` (not `max_tokens`) to stay compatible with newer reasoning models.

## Docs

* Architecture overview: `docs/ARCHITECTURE.md`

## Troubleshooting

### "Unsupported parameter: 'max_tokens'"

This usually means a request was sent to the Chat Completions API using `max_tokens` for a model that requires `max_completion_tokens`. The app is coded to use `max_completion_tokens` and to prefer the Responses API for GPT-5-family models.

### App doesn't persist chat history on Railway

Make sure your Railway volume is mounted to:

* `/app/data`

(That directory is where the app stores its on-disk data.)
