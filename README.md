# Brain At Home
Expose a self-hosted Ollama chat endpoint to clients on the same private Tailscale network, with lightweight
memory, optional web search, and streaming status updates.

## Features
- Local Ollama API gateway with chat memory + latest 3 user prompts.
- Tailnet access via Tailscale.
- Optional web agent (Brave Search + local Ollama).
- NDJSON streaming with stage events.
- Title/topic generation for chat UI updates.

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

## How It Works
Brain At Home is optimized for a single 16GB VRAM GPU. The main answer stays on one model, while small
models handle low‑priority tasks.

### Model roles
- **Main answer:** `model_id` (client-selected)
- **Info‑seeking classifier:** `INFO_SEEKING_MODEL_ID` (small model)
- **Title / topic:** `TITLE_MODEL_ID`, `TOPIC_MODEL_ID` (small model)
- **Brave query generation:** `model_id`
- **Memory updates:** `model_id`

### Step‑by‑step flow (every request)
1. **Receive prompt** with `use_web`, `model_id`, and message metadata.
2. **Classify info‑seeking** (LLM classifier).
3. **Decide web usage**
   - If `use_web=false`: always local.
   - If `use_web=true` and prompt is non‑info: fall back to local.
   - If `use_web=true` and info‑seeking: use web agent.
4. **Build the main prompt**
   - Memory summary/facts + latest 3 user prompts.
5. **Answer**
   - **Local path:** main model answers immediately.
   - **Web path:** generate Brave query → fetch up to 5 sources → main model answers with sources.
6. **Respond to client**
   - Stream tokens (if `stream=true`) or return JSON.
7. **Background tasks**
   - Title (once per chat), topic (every chat), memory update (if threshold).
   - Optional polish pass on long answers.

## API
All clients connected to the server share the same chat history.
- `GET /health`
- `POST /api/chat` (required: `chat_id`, `prompt`, `message_id`; optional `model_id`, `stream`, `use_web`)
- `GET /api/tags` or `/api/models`
- `GET /api/chats`
- `GET /api/chats/:chat_id`
- `GET /api/chats/:chat_id/messages?offset=0&limit=50`
- `DELETE /api/chats/:chat_id`

Example request:
```json
{
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
