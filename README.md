# AI Coding Helper

AI Coding Helper is a small Node and Express app that lets you chat with AI models about a repository and produce patch-style code changes.

## Run locally

```bash
npm install
npm start
```

The server uses `PORT` (defaults to 8080).

## Configuration and persistence

### Model configuration

The app uses two model configuration files:

- **Bundled defaults:** `config/config/models.json`
- **Runtime config (persisted):** `<DATA_DIR>/models.json`

`DATA_DIR` defaults to `<repo>/data`. In production, mount a persistent volume at `/app/data` so runtime config and histories survive deploys.

### Secrets

API keys and the admin password are stored in `<DATA_DIR>/secrets.json`.

In Railway you can also provide environment variables:

- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `GOOGLE_API_KEY`
- `GITHUB_TOKEN`

Environment variables take precedence over `secrets.json`.

## Deploying to Railway

1. Set Start command to `npm start`.
2. Set the environment variables above (or add keys in the Admin page).
3. Mount a persistent volume to `/app/data`.

## Admin

Open `/admin` to:

- Set or change the admin password
- Manage API keys
- Select default models
- Reset models back to the bundled defaults

## Troubleshooting

- **Reset models returns 500:** verify the bundled defaults exist at `config/config/models.json` and that the mounted volume path is writable.
- **OpenAI error about `max_tokens`:** some models (including GPT-5 family) require `max_completion_tokens` or the Responses API. Update the app to the latest code.
