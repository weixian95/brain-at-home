# Brain At Home

This project aims to expose self‑hosted AI models to remote machines on the same private Tailscale network.
It adds a lightweight memory layer on top of a local Ollama instance: raw messages are stored, a compact summary
and facts are maintained, and only a recent window is replayed to reduce context size.

## Scripts
- Start tailnet proxy: `npm run start:tailnet`
- Stop tailnet proxy + server: `npm run stop:tailnet`

## Health Check
```bash
curl http://127.0.0.1:3000/health
```

## API (All Endpoints)
### GET `/health`
Basic service + upstream status.

### POST `/api/chat`
Request:
```json
{
  "user_id": "user-123",
  "chat_id": "chat-001",
  "model_id": "llama3",
  "prompt": "What did I ask you last time?",
  "message_id": "9f7ad4c7-09e9-4e28-9e49-2c5c53f2d4e2",
  "client_ts": 1730775930123,
  "stream": false
}
```

Response:
```json
{
  "chat_id": "chat-001",
  "answer": "You asked about your ongoing migration timeline."
}
```

Streaming (set `stream: true`):
- Response type: `application/x-ndjson`
- One JSON object per line (Ollama‑compatible)

Example:
```json
{"message":{"role":"assistant","content":"You "},"done":false}
{"message":{"role":"assistant","content":"asked about your timeline."},"done":false}
{"message":{"role":"assistant","content":""},"done":true}
```

### GET `/api/tags` (or `/api/models`)
Returns available Ollama models.

### GET `/api/chats?user_id=...`
Lists chat summaries (most recent first). Fields include `title`, `summary`, `facts`, `last_updated_ts`, `last_message_ts`, `last_summary_ts`.

### GET `/api/chats/:chat_id?user_id=...`
Chat metadata for a single chat.

### GET `/api/chats/:chat_id/messages?user_id=...&offset=0&limit=50`
Raw messages with optional pagination.

### DELETE `/api/chats/:chat_id?user_id=...`
Deletes a chat and all stored messages.

## Tailscale (Optional)
Use the `start:tailnet` and `stop:tailnet` scripts above.

Remote usage (from another machine on the tailnet):
```bash
curl -s http://your-host.tailnet.ts.net:3000/api/chat \
  -H 'Content-Type: application/json' \
  -d '{
    "user_id": "user-123",
    "chat_id": "chat-001",
    "model_id": "llama3",
    "prompt": "Hello from the tailnet",
    "message_id": "c6e0f2f2-3ebd-4c5b-b7a4-5a5a4c2a7a88",
    "client_ts": 1730775930123,
    "stream": false
  }'
```

## Config (Env Vars)
- `PORT` (default `3000`)
- `BIND_HOST` (default `127.0.0.1`)
- `OLLAMA_URL` (default `http://127.0.0.1:11434`)
- `SYSTEM_PROMPT`
- `DEFAULT_MODEL_ID` (default `llama3`)
- `MEMORY_MODEL_ID` (default `qwen2.5:14b`)
- `TITLE_MODEL_ID` (defaults to `MEMORY_MODEL_ID`)
- `TITLE_MAX_CHARS` (default `60`)
- `RECENT_TURNS` (default `6`)
- `SUMMARY_EVERY_N_TURNS` (default `6`)
- `SUMMARY_TOKEN_BUDGET` (default `400`)
- `FACTS_TOKEN_BUDGET` (default `200`)
- `RECENT_TOKEN_BUDGET` (default `800`)
- `MEMORY_UPDATE_INPUT_TOKENS` (default `1200`)
- `SUMMARY_TOKEN_THRESHOLD` (default `1200`)
- `MAX_BODY_BYTES` (default `2097152`)
- `DATA_DIR` (default `./data`)
- `CHATS_DIR` (default `./data/chats`)

## Storage
Per‑chat JSON files are stored under `data/chats/`.
