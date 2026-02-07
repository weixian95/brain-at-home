# Brain At Home
Expose a self-hosted Ollama chat endpoint to clients on the same private Tailscale network, with lightweight
chat memory.

## Features
- Local Ollama API gateway with chat memory.
- Tailnet access via Tailscale.
- Optional web agent (Brave Search + local Ollama) with fallback to local.
- NDJSON streaming with stage events.

## Tailscale setup
1. Install Tailscale and log in.
2. On the host running BrainAtHome, enable serve:
   - `npm run start:tailnet`
3. From another device on the same tailnet, call the API:
   - `http://<your-host>.tailnet.ts.net:3000/api/chat`

## Start server
- `npm run start` (API)
- `npm run start:tailnet` (API + Tailscale proxy)
- `npm run start:agent` (web agent)
- `npm run start:tailnet:agent` (API + agent + Tailscale)

Health check: `curl http://127.0.0.1:3000/health`

## Stop server
```
npm run stop:tailnet
```

## Web Agent
Uses Brave Search to gather sources and a local Ollama model to synthesize cited answers. If it fails, the
API falls back to local inference.

### How it works:
1. Client sets `use_web=true` to route to the web agent (or `false` for local).
2. Agent searches Brave and fetches top pages.
3. Agent extracts text (static HTML by default; optional dynamic via Playwright).
4. Agent synthesizes a cited response.

### Streaming:
- With `stream: true`, NDJSON stage events are emitted.
- Routing emits `routing` and `routing_decision` based on the client toggle.
- Local inference emits `digest_prompt` and `analysis` before model tokens.
- Web agent emits `digest_prompt`, `search_started`, `search_summary`, `fetch_started`, `fetch_complete`,
  `sources`, `analysis`, `final_answer`, and `error`.
- On failure, `fallback_local` then `final_answer`.

## API
- `GET /health`
- `POST /api/chat` (required: `user_id`, `chat_id`, `prompt`, `message_id`; optional `model_id`, `stream`, `use_web`)
- `GET /api/tags` or `/api/models`
- `GET /api/chats?user_id=...`
- `GET /api/chats/:chat_id?user_id=...`
- `GET /api/chats/:chat_id/messages?user_id=...&offset=0&limit=50`
- `DELETE /api/chats/:chat_id?user_id=...`

Example request:
```json
{
  "user_id": "user-123",
  "chat_id": "chat-001",
  "model_id": "llama3",
  "prompt": "What did I ask you last time?",
  "message_id": "9f7ad4c7-09e9-4e28-9e49-2c5c53f2d4e2",
  "client_ts": 1730775930123,
  "stream": false,
  "use_web": true
}
```

Response includes `sources` when the web agent is used:
```json
{
  "chat_id": "chat-001",
  "answer": "Answer with citations...",
  "sources": [
    { "title": "Example", "url": "https://example.com" }
  ]
}
```
