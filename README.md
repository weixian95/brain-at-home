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
   - `https://<your-host>.tailnet.ts.net:3000/api/chat`

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
Uses Brave Search to gather sources. The API then asks the front-desk model (client-selected `model_id`) to
formulate the final answer using the summarized sources.

### How it works:
1. Client sets `use_web=true` to route to the web agent (or `false` for local).
2. Agent searches Brave and fetches top pages.
3. Agent extracts text (static HTML by default; optional dynamic via Playwright).
4. Agent returns summarized sources (title, url, short summary).
5. API sends the summaries to the front-desk model to produce the final answer.

### Streaming:
- With `stream: true`, NDJSON stage events are emitted.
- Routing emits `routing` and `routing_decision` based on the client toggle.
- Local inference emits `digest_prompt` and `analysis` before model tokens.
- Web agent emits `digest_prompt`, `search_started`, `search_summary`, `fetch_started`, `fetch_complete`,
  `sources`, and `error`.
- The front-desk model then streams the final answer tokens.

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
    { "title": "Example", "url": "https://example.com", "summary": "Short summary..." }
  ]
}
```
